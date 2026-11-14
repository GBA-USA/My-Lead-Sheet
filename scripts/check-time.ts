import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { BandMs, Clock, Grid, LinkRoute, LocalMs } from "../src/band-time.ts";

type Time = typeof import("../src/band-time.ts");

const bundled = await build({
  entryPoints: [new URL("../src/band-time.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const file = join(mkdtempSync(join(tmpdir(), "check-time-")), "band-time.mjs");
writeFileSync(file, bundled.outputFiles[0].text);
const T = (await import(pathToFileURL(file).href)) as Time;

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
}

const band = (ms: number) => ms as BandMs;
const local = (ms: number) => ms as LocalMs;

let seed = 20261114;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const normal = (mean: number, sd: number) => mean + sd * Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
const expo = (mean: number) => -mean * Math.log(rand() || 1e-12);

/** The route models in sync-budget.mjs, with the leader+route clock p95 and p99 one-way delay it prints. */
const MODEL: Record<LinkRoute, { base: number; bias: number; jitter: number; spike: number; spikeMean: number; clockP95: number; p99: number }> = {
  wifi: { base: 3, bias: 0.5, jitter: 1.5, spike: 0.03, spikeMean: 60, clockP95: 0.6, p99: 72 },
  internet: { base: 30, bias: 4, jitter: 10, spike: 0.03, spikeMean: 100, clockP95: 4.3, p99: 160 },
  relay: { base: 36, bias: 4, jitter: 11, spike: 0.03, spikeMean: 100, clockP95: 4.3, p99: 156 },
  server: { base: 46, bias: 5, jitter: 15, spike: 0.04, spikeMean: 120, clockP95: 5.5, p99: 230 },
};
const CLICK_MAX: Record<LinkRoute, number> = { wifi: 10, internet: 18, relay: 18, server: 20 };
const ROUTE_NAMES = Object.keys(MODEL) as LinkRoute[];

const oneWay = (route: LinkRoute, sign: number, bias: number) => {
  const m = MODEL[route];
  return m.base + (sign * bias) / 2 + expo(m.jitter) + (rand() < m.spike ? expo(m.spikeMean) : 0);
};

interface Phone {
  route: LinkRoute;
  skew: number;
  base: number;
  bias: number;
  clock: Clock;
}
const newPhone = (route: LinkRoute): Phone => ({
  route,
  skew: (rand() * 2 - 1) * 50e-6,
  base: 1e12 + rand() * 1e9,
  bias: normal(0, MODEL[route].bias),
  clock: T.newClock(),
});
const localOf = (phone: Phone, tau: number) => local(phone.base + tau * (1 + phone.skew));
const truth = (tau: number) => band(tau);

function track(phone: Phone, from: number, to: number, leader: (tau: number) => BandMs, onTick?: (tau: number) => void, tickMs = 50) {
  let send = from;
  let burst = T.BURST.pings;
  const inFlight: { arrives: number; ping: { t0: LocalMs; t1: LocalMs; band: BandMs } }[] = [];
  for (let tau = from; tau < to; tau += tickMs) {
    while (send <= tau) {
      const up = oneWay(phone.route, 1, phone.bias);
      const down = oneWay(phone.route, -1, phone.bias);
      const arrives = send + up + down;
      inFlight.push({ arrives, ping: { t0: localOf(phone, send), band: leader(send + up), t1: localOf(phone, arrives) } });
      send += burst-- > 0 ? T.BURST.everyMs : T.ROUTES[phone.route].pingEveryMs;
    }
    inFlight.sort((a, b) => a.arrives - b.arrives);
    while (inFlight.length && inFlight[0].arrives <= tau) phone.clock = T.addPing(phone.clock, inFlight.shift()!.ping, null);
    onTick?.(tau);
  }
}

const errorAt = (phone: Phone, tau: number, leader = truth) => T.bandNow(phone.clock, localOf(phone, tau))! - leader(tau);
const p95 = (values: number[]) => values.map(Math.abs).sort((a, b) => a - b)[Math.floor(values.length * 0.95)];
const maxAbs = (values: number[]) => Math.max(...values.map(Math.abs));

const FLOAT_NOISE_MS = 1e-3;

function slewWatch(phone: Phone, tau0: number) {
  const course = T.adoptLead(phone.clock, localOf(phone, tau0))!;
  let last: { tau: number; moved: number } | null = null;
  let excess = 0;
  let rate = 0;
  return {
    tick(tau: number) {
      const at = localOf(phone, tau);
      const moved = T.bandNow(phone.clock, at)! - T.bandAt(course, at);
      if (last) {
        const step = Math.abs(moved - last.moved);
        excess = Math.max(excess, step - 0.001 * (tau - last.tau) * (1 + 1e-4));
        rate = Math.max(rate, step / (tau - last.tau));
      }
      last = { tau, moved };
    },
    get ok() {
      return excess <= FLOAT_NOISE_MS;
    },
    get rate() {
      return rate * 1000;
    },
  };
}

const MIN = 60_000;

for (const route of ROUTE_NAMES) {
  const errors: number[] = [];
  for (let trial = 0; trial < 1500; trial += 1) {
    const phone = newPhone(route);
    const end = 5 * MIN + rand() * 5 * MIN;
    track(phone, 0, end, truth, undefined, 1000);
    errors.push(errorAt(phone, end + rand() * T.ROUTES[route].pingEveryMs));
  }
  const limit = MODEL[route].clockP95 * 1.1;
  check(p95(errors) <= limit, `${route}: estimate error p95 ${p95(errors).toFixed(2)} ms within modeled ${MODEL[route].clockP95} ms (+10%), max ${maxAbs(errors).toFixed(1)} ms`);
}

for (const [from, to] of [["wifi", "internet"], ["wifi", "server"], ["internet", "relay"], ["relay", "server"], ["server", "wifi"]] as [LinkRoute, LinkRoute][]) {
  let slewOk = true;
  let worst = 0;
  for (let trial = 0; trial < 100; trial += 1) {
    const phone = newPhone(from);
    track(phone, 0, 5 * MIN, truth, undefined, 1000);
    const watch = slewWatch(phone, 5 * MIN);
    phone.clock = T.rebase(phone.clock);
    phone.route = to;
    phone.bias = normal(0, MODEL[to].bias);
    track(phone, 5 * MIN, 7 * MIN, truth, (tau) => watch.tick(tau));
    slewOk &&= watch.ok;
    worst = Math.max(worst, watch.rate);
  }
  check(slewOk, `${from} -> ${to}: the switch moves band time at most ${worst.toFixed(3)} ms per second (slew allows 1, plus float noise)`);
}

for (const route of ROUTE_NAMES) {
  const steps: number[] = [];
  let slewOk = true;
  let worstSlew = 0;
  for (let trial = 0; trial < 200; trial += 1) {
    const newLeader = newPhone(route);
    const follower = newPhone(route);
    track(newLeader, 0, 5 * MIN, truth, undefined, 1000);
    track(follower, 0, 5 * MIN, truth, undefined, 1000);
    const handoff = 5 * MIN;
    const line = T.adoptLead(newLeader.clock, localOf(newLeader, handoff))!;
    const bandTime = (tau: number) => T.bandAt(line, localOf(newLeader, tau));
    const oldEstimate = follower.clock;
    const watch = slewWatch(follower, handoff);
    follower.clock = T.rebase(follower.clock);
    track(follower, handoff, handoff + MIN, bandTime, (tau) => watch.tick(tau));
    const at = localOf(follower, handoff + MIN);
    steps.push(T.bandNow(follower.clock, at)! - T.bandNow(oldEstimate, at)!);
    slewOk &&= watch.ok;
    worstSlew = Math.max(worstSlew, watch.rate);
    const leaderJump = T.bandAt(line, localOf(newLeader, handoff)) - T.bandNow(newLeader.clock, localOf(newLeader, handoff))!;
    if (Math.abs(leaderJump) > 1e-6) check(false, `${route}: the new leader's own band time jumped ${leaderJump} ms at the handoff`);
  }
  check(maxAbs(steps) < CLICK_MAX[route], `${route}: handoff step max ${maxAbs(steps).toFixed(1)} ms (p95 ${p95(steps).toFixed(1)}) under the click max ${CLICK_MAX[route]} ms`);
  check(slewOk, `${route}: across the handoff band time slews at most ${worstSlew.toFixed(3)} ms per second (slew allows 1, plus float noise)`);
}

{
  const gaps: number[] = [];
  for (let trial = 0; trial < 400; trial += 1) {
    const a = newPhone("wifi");
    const b = newPhone("wifi");
    track(a, 0, 10 * MIN, truth, undefined, 1000);
    track(b, 0, 10 * MIN, truth, undefined, 1000);
    const end = 20 * MIN;
    gaps.push(T.bandNow(a.clock, localOf(a, end))! - T.bandNow(b.clock, localOf(b, end))!);
  }
  check(maxAbs(gaps) <= 2, `two Wi-Fi link phones 10 minutes offline stay within 2 ms of each other (max ${maxAbs(gaps).toFixed(2)} ms, p95 ${p95(gaps).toFixed(2)} ms, 400 pairs)`);
}

{
  const grid: Grid = { bpm: 120, beatsPerBar: 4, startAt: band(1e12 + 1000), firstBar: -1 };
  const phone = newPhone("wifi");
  phone.bias = 0;
  track(phone, 1e12, 1e12 + 2 * MIN, truth, undefined, 1000);
  const jumped = (tau: number) => band(tau + 80);
  phone.clock = T.rebase(phone.clock);
  let next = 1e12 + 2 * MIN;
  for (let i = 0; i < 8; i += 1, next += 100) {
    const ping = { t0: localOf(phone, next), band: jumped(next + 3), t1: localOf(phone, next + 6) };
    phone.clock = T.addPing(phone.clock, ping, grid);
  }
  const quietAt = localOf(phone, next - 94);
  check(T.confidence(phone.clock, quietAt) === "syncing", "an 80 ms correction quiets the click until it lands");
  let stepBand: number | null = null;
  let prev = T.bandNow(phone.clock, quietAt)!;
  for (let tau = next - 94; tau < next + 3000; tau += 0.25) {
    const now = T.bandNow(phone.clock, localOf(phone, tau))!;
    if (now - prev > 40) {
      stepBand = prev;
      break;
    }
    prev = now;
  }
  const bar = 2000;
  const offBar = stepBand === null ? Infinity : Math.abs(((stepBand - grid.startAt + bar / 2) % bar) - bar / 2);
  check(offBar <= 0.5, `the 80 ms correction steps on a bar line (${offBar.toFixed(2)} ms from it)`);
  check(T.confidence(phone.clock, localOf(phone, next + 3000)) === "synced", "after the bar line the click plays again");
}

{
  let clock = T.newClock();
  const ping = (at: number, rtt: number, err: number) => ({ t0: local(at - rtt / 2), t1: local(at + rtt / 2), band: band(at + 5000 + err) });
  for (let i = 0; i < 7; i += 1) clock = T.addPing(clock, ping(i * 100, 10, 0), null);
  check(T.confidence(clock, local(700)) === "syncing", "under 8 pings the phone says Syncing");
  clock = T.addPing(clock, ping(700, 10, 0), null);
  check(T.confidence(clock, local(800)) === "synced", "8 steady pings make it Synced");
  const states: string[] = [];
  for (let s = 1; s <= 14; s += 1) {
    clock = T.addPing(clock, ping(800 + s * 1000, 4, s % 2 ? 6 : -6), null);
    states.push(T.confidence(clock, local(800 + s * 1000 + 10)));
  }
  check(states.slice(0, 11).every((s) => s === "synced"), `a spread over 8 ms for under 10 s keeps it Synced (${states.slice(0, 11).join(",")})`);
  check(states.slice(11).every((s) => s === "out-of-sync"), `a spread over 8 ms from 2.8 s to 12.8 s says Out of sync (${states.slice(11).join(",")})`);
}

{
  const lead = ROUTE_NAMES.map((route) => T.leadMs([MODEL[route].p99]));
  check(JSON.stringify(lead) === JSON.stringify([150, 190, 190, 260]), `lead per slowest route matches sync-budget.out (${lead.join(", ")} ms)`);
  check(T.leadMs([MODEL.wifi.p99, MODEL.internet.p99, MODEL.server.p99]) === 260, "a mixed lineup's lead comes from its slowest route");
  check(T.leadMs([]) === 150 && T.leadMs([900]) === 400, "lead stays between 150 and 400 ms");
}

{
  const grid: Grid = { bpm: 120, beatsPerBar: 4, startAt: band(10_000), firstBar: -1 };
  const lead = 150;
  const cases: [string, Parameters<Time["snap"]>[0], number, Grid | null, number][] = [
    ["next song, click stopped: now + lead", "song", 0, null, 150],
    ["next song, click running: the next bar line", "song", 12_345, grid, 14_000],
    ["next song exactly on a bar line lands on it", "song", 13_850, grid, 14_000],
    ["page turn, click stopped: now + lead", "section", 5_000, null, 5_150],
    ["page turn, click running: one beat before the next bar line", "section", 12_345, grid, 13_500],
    ["page turn too close to beat 4 waits a bar, still one beat early", "section", 13_400, grid, 15_500],
    ["count in, click stopped: the grid starts at now + lead", "countIn", 700, null, 850],
    ["count in, click running: the next bar line", "countIn", 12_345, grid, 14_000],
    ["tempo change: the next bar line", "tempo", 12_345, grid, 14_000],
    ["start scroll during the count-in: the downbeat after it", "scroll", 10_800, grid, 12_000],
    ["start scroll mid-song: the next bar line", "scroll", 12_345, grid, 14_000],
    ["stop: the next beat", "stop", 12_345, grid, 12_500],
    ["stop exactly on a beat lands on it", "stop", 12_350, grid, 12_500],
  ];
  for (const [name, rule, now, g, expected] of cases) {
    const got = T.snap(rule, band(now + lead), g);
    check(Math.abs(got - expected) < 1e-6, `snap: ${name} (${got}, want ${expected})`);
  }
  const at = (t: number) => T.beatAt(grid, band(t));
  check(at(9_999) === null, "before the grid starts there is no beat");
  check(JSON.stringify(at(10_000)) === '{"bar":-1,"beat":0}', "the count-in is bar -1");
  check(JSON.stringify(at(12_000)) === '{"bar":0,"beat":0}' && JSON.stringify(at(13_999)) === '{"bar":0,"beat":3}', "bar 0 beat 0 is the downbeat after the count-in");
  const faster: Grid = { ...grid, bpm: 100, startAt: band(14_000), firstBar: T.beatAt(grid, band(14_000))!.bar };
  check(JSON.stringify(T.beatAt(faster, band(14_600))) === '{"bar":1,"beat":1}', "after a tempo change the bars keep counting and the beat is 600 ms");
}

{
  const frame = 1000 / 60;
  let wrong = 0;
  for (let phase = 0; phase < frame; phase += 0.37) {
    const at = band(1000);
    const displays = Array.from({ length: 100 }, (_, k) => band(phase + k * frame));
    const chosen = displays.find((d) => T.flipNow(at, d, frame))!;
    const best = Math.min(...displays.map((d) => Math.abs(d - at)));
    if (Math.abs(Math.abs(chosen - at) - best) > 1e-9) wrong += 1;
  }
  check(wrong === 0, "a flip goes in the frame whose display time is closest to at");
  check(T.flipNow(band(1000), band(1200), frame), "a change that arrives late flips in the next frame");
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("check:time passed");
