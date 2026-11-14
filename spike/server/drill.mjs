import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    changes: { type: "string", default: "200" },
    "every-ms": { type: "string", default: "500" },
    "kill-s": { type: "string", default: "60" },
    "ping-ms": { type: "string", default: "1000" },
    follower: { type: "string" },
    room: { type: "string" },
  },
});
const base = positionals[0];
if (!base) {
  console.error("usage: node spike/server/drill.mjs <url> [--changes 200] [--every-ms 500] [--kill-s 60] [--ping-ms 1000]");
  process.exit(2);
}

const FOLLOWERS = 4;
const BAND_OFFSET_MS = 12_345.678;
const SPREAD_TARGET_MS = 8;
const REJOIN_TARGET_MS = 2000;
const GB_PER_DO = 0.125;
const FREE_REQUESTS_PER_DAY = 100_000;
const FREE_GB_S_PER_DAY = 13_000;
const WS_MESSAGES_PER_REQUEST = 20;
const GIG = { hours: 3, changes: 190, followers: 4, pingEveryS: 5, burst: 16 };

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pingMs = Number(opt["ping-ms"]);

function socketUrl(room, role, id) {
  const url = new URL(`/room/${room}`, base);
  url.protocol = url.protocol.replace("http", "ws");
  url.searchParams.set("role", role);
  url.searchParams.set("id", id);
  return url.href;
}

function follower(room, id) {
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const opened = now();
  const ws = new WebSocket(socketUrl(room, "follower", id));
  const samples = [];
  let shown = 0;
  ws.onmessage = ({ data }) => {
    const t = now();
    const msg = JSON.parse(data);
    if (msg.k === "state") {
      if (msg.snapshot) emit({ e: "join", rev: msg.rev, ms: t - opened });
      else emit({ e: "state", rev: msg.rev, lat: t - msg.sentAt });
      if (msg.rev < shown) emit({ e: "backward", rev: msg.rev, shown });
      shown = Math.max(shown, msg.rev);
    } else if (msg.k === "pong") {
      samples.push({ rtt: t - msg.t0, off: msg.band - (msg.t0 + t) / 2 });
      if (samples.length > 32) samples.shift();
      if (samples.length < 8) return;
      const best = samples
        .toSorted((a, b) => a.rtt - b.rtt)
        .slice(0, 8)
        .map((s) => s.off)
        .sort((a, b) => a - b);
      emit({ e: "clock", rtt: t - msg.t0, spread: best[7] - best[0], err: (best[3] + best[4]) / 2 - BAND_OFFSET_MS });
    }
  };
  const ping = () => ws.send(JSON.stringify({ k: "ping", t0: now() }));
  ws.onopen = async () => {
    for (let i = 0; i < GIG.burst; i++) {
      ping();
      await sleep(100);
    }
    emit({ e: "ready" });
    setInterval(ping, pingMs);
  };
  ws.onerror = () => process.exit(1);
  ws.onclose = () => process.exit(0);
}

function pct(values, p) {
  if (!values.length) return NaN;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const ms = (v) => Math.round(v * 100) / 100;

async function drill() {
  const changes = Number(opt.changes);
  const everyMs = Number(opt["every-ms"]);
  const killS = Number(opt["kill-s"]);
  const killAtRev = Math.max(1, Math.floor(changes / 4));
  const room = `drill-${Date.now().toString(36)}`;
  const script = fileURLToPath(import.meta.url);
  const runs = [];
  const failures = [];
  const deadline = setTimeout(() => {
    console.error("drill timed out");
    for (const run of runs) run.child.kill("SIGKILL");
    process.exit(1);
  }, changes * everyMs + killS * 1000 + 60_000);

  const leader = new WebSocket(socketUrl(room, "leader", "leader"));
  await new Promise((resolve, reject) => {
    leader.onopen = resolve;
    leader.onerror = () => reject(new Error(`leader could not connect to ${base}`));
  });
  let leaderSent = 0;
  let refused = 0;
  let sentRev = 0;
  const send = (msg) => {
    leaderSent++;
    leader.send(JSON.stringify(msg));
  };
  leader.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.k === "ping") send({ k: "pong", to: msg.from, t0: msg.t0, band: now() + BAND_OFFSET_MS });
    else if (msg.k === "refused") refused++;
  };

  function spawnFollower(id) {
    const child = spawn(process.execPath, [script, base, "--follower", id, "--room", room, "--ping-ms", String(pingMs)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const run = { id, child, spawnedAtRev: sentRev, states: [], clock: [], backward: 0, join: null };
    run.joinedPromise = new Promise((resolve) => (run.joined = resolve));
    run.ready = new Promise((resolve) => {
      createInterface({ input: child.stdout }).on("line", (line) => {
        const event = JSON.parse(line);
        if (event.e === "ready") resolve();
        else if (event.e === "state") run.states.push(event);
        else if (event.e === "clock") run.clock.push(event);
        else if (event.e === "backward") run.backward++;
        else if (event.e === "join") {
          run.join = event;
          run.joined();
        }
      });
    });
    runs.push(run);
    return run;
  }

  const followers = Array.from({ length: FOLLOWERS }, (_, i) => spawnFollower(`f${i + 1}`));
  await Promise.all(followers.map((run) => run.ready));

  const victim = followers[FOLLOWERS - 1];
  let rejoin = null;
  const order = Array.from({ length: 20 }, (_, i) => `song-${i}`);
  for (let rev = 1; rev <= changes; rev++) {
    sentRev = rev;
    send({ k: "state", rev, sentAt: now(), body: { order, current: order[rev % order.length], notes: "x".repeat(1000) } });
    if (rev === killAtRev) {
      victim.child.kill("SIGKILL");
      rejoin = sleep(killS * 1000).then(() => spawnFollower(victim.id));
    }
    await sleep(everyMs);
  }
  const rejoined = await rejoin;
  await Promise.race([rejoined.joinedPromise, sleep(REJOIN_TARGET_MS * 3)]);
  await sleep(1500);
  const stats = await (await fetch(new URL(`/room/${room}/stats`, base))).json();
  for (const run of runs) run.child.kill("SIGTERM");
  leader.close();
  clearTimeout(deadline);

  const expect = (ok, label) => {
    if (!ok) failures.push(label);
  };
  for (const run of followers.slice(0, -1)) {
    const revs = run.states.map((s) => s.rev);
    expect(revs.length === changes && revs.every((r, i) => r === i + 1), `${run.id} saw every rev 1..${changes} in order`);
  }
  for (const run of runs) expect(run.backward === 0, `${run.id} never saw rev go backward`);
  expect(rejoined.join !== null, "rejoined follower got a snapshot");
  expect(rejoined.join?.rev >= rejoined.spawnedAtRev, `rejoin snapshot rev ${rejoined.join?.rev} >= leader rev ${rejoined.spawnedAtRev}`);
  expect(rejoined.join?.ms <= REJOIN_TARGET_MS, `rejoin got latest rev in ${ms(rejoined.join?.ms)} ms <= ${REJOIN_TARGET_MS}`);
  expect(Math.max(rejoined.join?.rev ?? 0, ...rejoined.states.map((s) => s.rev)) === changes, `rejoined follower ends on rev ${changes}`);
  expect(refused === 0, "room refused no leader change");
  expect(stats.leader === leaderSent, `room counted ${stats.leader} leader messages, leader sent ${leaderSent}`);
  expect(stats.upgrades === 1 + FOLLOWERS + 1, `room counted ${stats.upgrades} socket upgrades, expected ${FOLLOWERS + 2}`);

  const lat = runs.flatMap((run) => run.states.map((s) => s.lat));
  const clock = runs.flatMap((run) => run.clock);
  const spreadP95 = pct(clock.map((c) => c.spread), 95);
  expect(spreadP95 <= SPREAD_TARGET_MS, `relayed-ping spread p95 ${ms(spreadP95)} ms <= ${SPREAD_TARGET_MS}`);

  const inbound = stats.leader + stats.follower;
  const inboundPerPing = inbound > changes && stats.follower ? (inbound - changes) / stats.follower : 2;
  const pingsPerGig = GIG.followers * ((GIG.hours * 3600) / GIG.pingEveryS + GIG.burst);
  const gigRequests = 1 + GIG.followers + (GIG.changes + pingsPerGig * inboundPerPing) / WS_MESSAGES_PER_REQUEST;
  const gigGbS = GIG.hours * 3600 * GB_PER_DO;
  const drillRequests = stats.upgrades + inbound / WS_MESSAGES_PER_REQUEST;
  const drillGbS = (stats.awakeMs / 1000) * GB_PER_DO;

  const report = {
    url: base,
    room,
    params: { followers: FOLLOWERS, changes, everyMs, killS, pingMs, killAtRev },
    tapToFollowerMs: { n: lat.length, p50: ms(pct(lat, 50)), p95: ms(pct(lat, 95)), p99: ms(pct(lat, 99)), max: ms(Math.max(...lat)) },
    relayedPingMs: {
      samples: clock.length,
      rttP50: ms(pct(clock.map((c) => c.rtt), 50)),
      rttP95: ms(pct(clock.map((c) => c.rtt), 95)),
      spreadP95: ms(spreadP95),
      offsetErrorP95: ms(pct(clock.map((c) => Math.abs(c.err)), 95)),
    },
    rejoin: { killedForS: killS, snapshotRev: rejoined.join?.rev, leaderRevAtRejoin: rejoined.spawnedAtRev, ms: ms(rejoined.join?.ms) },
    roomCounts: { upgrades: stats.upgrades, leaderMessages: stats.leader, followerMessages: stats.follower, awakeS: ms(stats.awakeMs / 1000) },
    costThisDrill: { doRequests: ms(drillRequests), gbS: ms(drillGbS) },
    costPerGig: {
      assumes: `${GIG.hours} h, ${GIG.changes} changes, ${GIG.followers} server followers pinging every ${GIG.pingEveryS} s, ${ms(inboundPerPing)} inbound messages per ping, ${WS_MESSAGES_PER_REQUEST} messages per billed request, room never idle ${GIG.pingEveryS} s`,
      doRequests: Math.round(gigRequests),
      requestsPctOfFreeDay: ms((gigRequests / FREE_REQUESTS_PER_DAY) * 100),
      gbS: gigGbS,
      gbSPctOfFreeDay: ms((gigGbS / FREE_GB_S_PER_DAY) * 100),
    },
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  console.log(failures.length ? `FAIL ${failures.length}: ${failures.join("; ")}` : "PASS");
  process.exit(failures.length ? 1 : 0);
}

if (opt.follower) follower(opt.room, opt.follower);
else await drill();
