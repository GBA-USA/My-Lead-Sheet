import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { BandMs } from "../src/band-time.ts";
import type { GigState, Op, Outcome } from "../src/gig-state.ts";

type Gig = typeof import("../src/gig-state.ts");

const bundled = await build({
  entryPoints: [new URL("../src/gig-state.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const file = join(mkdtempSync(join(tmpdir(), "check-gig-")), "gig-state.mjs");
writeFileSync(file, bundled.outputFiles[0].text);
const G = (await import(pathToFileURL(file).href)) as Gig;

const band = (ms: number) => ms as BandMs;
const LEAD = 150;
type Body = Op extends infer O ? (O extends Op ? Omit<O, "opId" | "epoch"> : never) : never;

let opCount = 0;
function act(state: GigState, by: string, now: number, body: Body, epoch = state.epoch): Outcome {
  opCount += 1;
  return G.reduce(state, { ...body, opId: `op${opCount}`, epoch } as Op, { by, now: band(now), lead: LEAD });
}
function ok(outcome: Outcome): GigState {
  if (!outcome.ok) throw new Error(`refused: ${outcome.refused}`);
  return outcome.state;
}
const refused = (outcome: Outcome) => (outcome.ok ? "accepted" : outcome.refused);
const at = (state: GigState, t: number) => G.position(state, band(t));

function gig(overrides: Partial<Parameters<Gig["startGig"]>[0]> = {}) {
  return G.startGig({
    gigId: "elks-fri",
    order: ["a", "b", "c", "d"],
    leader: "terry",
    admin: "ann",
    backup: "mike",
    lineup: ["terry", "ann", "mike", "joe"],
    route: "auto",
    scrollAlong: true,
    now: band(0),
    ...overrides,
  });
}
const countIn = { kind: "countIn", bpm: 120, beatsPerBar: 4, bars: 1, version: "v-band", rate: 1 } as const;

function onsets(state: GigState, from: number, to: number) {
  const out: { t: number; bar: number; beat: number; planSec: number | null }[] = [];
  let prev = JSON.stringify(at(state, from - 10).beat);
  for (let t = from; t <= to; t += 10) {
    const p = at(state, t);
    const key = JSON.stringify(p.beat);
    if (p.beat && key !== prev) out.push({ t, ...p.beat, planSec: p.scroll?.planSec ?? null });
    prev = key;
  }
  return out;
}
const gaps = (values: number[]) => values.slice(1).map((v, i) => Math.round((v - values[i]) * 1e6) / 1e6);
const shownAt = (state: GigState, t: number) => {
  const p = at(state, t);
  return JSON.stringify({ ...p, scroll: p.scroll && { ...p.scroll, planSec: Math.round(p.scroll.planSec * 1e6) / 1e6 } });
};
const sameUntil = (a: GigState, b: GigState, from: number, to: number) => {
  for (let t = from; t < to; t += 10) if (shownAt(a, t) !== shownAt(b, t)) return t;
  return null;
};

const drills: [string, () => [boolean, string]][] = [
  [
    "the leader double-taps Next: one change, one at",
    () => {
      const once = ok(act(gig(), "terry", 1000, { kind: "goTo", key: "b" }));
      const twice = act(once, "terry", 1080, { kind: "goTo", key: "b" });
      const lands = at(once, 1149).song.key === "a" && at(once, 1150).song.key === "b";
      return [refused(twice) === "same-target" && once.rev === 1 && lands, `second tap ${refused(twice)}, b shows from 1150: ${lands}`];
    },
  ],
  [
    "the same change on the Wi-Fi link and through the room is applied once",
    () => {
      const s0 = gig();
      const s1 = ok(act(s0, "terry", 1000, { kind: "goTo", key: "b" }));
      const s2 = ok(act(s1, "terry", 2000, { kind: "section", index: 1 }));
      const phone = G.receive(null, s0).state;
      const wifi = G.receive(phone, s1);
      const room = G.receive(wifi.state, s1);
      const next = G.receive(room.state, s2);
      const lateRoom = G.receive(next.state, s1);
      const results = [wifi.result, room.result, next.result, lateRoom.result].join(",");
      return [results === "applied,duplicate,applied,old" && lateRoom.state === s2, results];
    },
  ],
  [
    "two people take the lead offline at once: the admin wins and the backup steps down",
    () => {
      const base = ok(act(gig(), "terry", 1000, { kind: "goTo", key: "b" }));
      const ann = ok(act(base, "ann", 40_000, { kind: "takeOver" }));
      const mike = ok(act(base, "mike", 40_000, { kind: "takeOver" }));
      const onMike = G.receive(mike, ann);
      const onAnn = G.receive(ann, mike);
      const joeAnnFirst = G.receive(G.receive(base, ann).state, mike);
      const joeMikeFirst = G.receive(G.receive(base, mike).state, ann);
      const mikeTaps = refused(act(onMike.state, "mike", 41_000, { kind: "goTo", key: "c" }));
      const pass =
        ann.epoch === 1 && mike.epoch === 1 && onMike.result === "applied" && onMike.state.leader === "ann" &&
        onAnn.result === "lost-tie" && joeAnnFirst.state.leader === "ann" && joeMikeFirst.state.leader === "ann" && mikeTaps === "not-allowed";
      return [pass, `mike's phone ${onMike.result}, ann's phone ${onAnn.result}, mike then taps: ${mikeTaps}`];
    },
  ],
  [
    "mike misses the backup move to joe and both take over; joe names a new backup: every phone ends on joe's state, whatever order it hears them",
    () => {
      const base = gig();
      const moved = ok(act(base, "terry", 1000, { kind: "setBackup", userId: "joe" }));
      const joeTakes = ok(act(moved, "joe", 40_000, { kind: "takeOver" }));
      const mikeTakes = ok(act(base, "mike", 40_000, { kind: "takeOver" }));
      const joeNames = ok(act(joeTakes, "joe", 41_000, { kind: "setBackup", userId: "terry" }));
      const sent = { joeTakes, mikeTakes, joeNames };
      const orders = (names: string[]): string[][] => (names.length ? names.flatMap((n) => orders(names.filter((m) => m !== n)).map((rest) => [n, ...rest])) : [[]]);
      const ends = orders(Object.keys(sent)).map((order) => order.reduce<GigState | null>((phone, name) => G.receive(phone, sent[name as keyof typeof sent]).state, null)!);
      const finals = new Set(ends.map((s) => JSON.stringify(s)));
      const pass = finals.size === 1 && ends[0] === joeNames && joeTakes.backup === null && mikeTakes.backup === null;
      return [pass, `${finals.size} final state(s): ${ends.map((s) => `${s.leader}@rev${s.rev}`).join(" ")}; backup after joe takes over ${joeTakes.backup}`];
    },
  ],
  [
    "the old leader comes back after a take-over: it sees the higher epoch, steps down, and its taps are refused",
    () => {
      const base = gig();
      let terry = base;
      for (const key of ["b", "c", "d", "a"]) terry = ok(act(terry, "terry", 2000, { kind: "goTo", key }));
      const mike = ok(act(base, "mike", 40_000, { kind: "takeOver" }));
      const follower = G.receive(mike, terry);
      const terrysPhone = G.receive(terry, mike);
      const terryTaps = refused(act(terrysPhone.state, "terry", 41_000, { kind: "goTo", key: "c" }));
      const oldOpAtMike = refused(act(mike, "mike", 41_000, { kind: "goTo", key: "c" }, 0));
      const pass = terry.rev > mike.rev && follower.result === "old-epoch" && terrysPhone.result === "applied" && terryTaps === "not-allowed" && oldOpAtMike === "stale-epoch";
      return [pass, `follower ${follower.result}, terry's phone ${terrysPhone.result}, terry taps ${terryTaps}, epoch-0 op ${oldOpAtMike}`];
    },
  ],
  [
    "a member who isn't the backup can't take the lead; with no backup only the admin can",
    () => {
      const joe = refused(act(gig(), "joe", 40_000, { kind: "takeOver" }));
      const noBackup = gig({ backup: null });
      const mike = refused(act(noBackup, "mike", 40_000, { kind: "takeOver" }));
      const ann = refused(act(noBackup, "ann", 40_000, { kind: "takeOver" }));
      return [joe === "not-allowed" && mike === "not-allowed" && ann === "accepted", `joe ${joe}, mike with no backup ${mike}, admin ${ann}`];
    },
  ],
  [
    "the leader changes the backup mid-gig: the new backup can take over and the old one can't",
    () => {
      const changed = ok(act(gig(), "terry", 5000, { kind: "setBackup", userId: "joe" }));
      const joe = refused(act(changed, "joe", 40_000, { kind: "takeOver" }));
      const mike = refused(act(changed, "mike", 40_000, { kind: "takeOver" }));
      const byMember = refused(act(gig(), "joe", 5000, { kind: "setBackup", userId: "joe" }));
      const byAdmin = refused(act(gig(), "ann", 5000, { kind: "setBackup", userId: "joe" }));
      const pass = joe === "accepted" && mike === "not-allowed" && byMember === "not-allowed" && byAdmin === "accepted";
      return [pass, `joe ${joe}, mike ${mike}, set by a member ${byMember}, by the admin ${byAdmin}`];
    },
  ],
  [
    "the leader stops the song: click, dot and scroll stop on every phone on the next beat",
    () => {
      const running = ok(act(gig(), "terry", 0, countIn));
      const stopped = ok(act(running, "terry", 5100, { kind: "stop" }));
      const before = at(stopped, 5649);
      const after = at(stopped, 5650);
      const pass = at(stopped, 5649).beat !== null && at(stopped, 5649).scroll !== null &&
        at(stopped, 5650).beat === null && at(stopped, 5650).scroll === null && after.song.key === before.song.key;
      return [pass, `at 5649 ${JSON.stringify(before.beat)}, at 5650 ${JSON.stringify(after.beat)} (beats every 500 ms from 150)`];
    },
  ],
  [
    "the band's scroll setting is off: charts don't scroll with the leader, the click and page turns still mirror",
    () => {
      const off = gig({ scrollAlong: false });
      const running = ok(act(off, "terry", 0, countIn));
      const scroll = refused(act(running, "terry", 3000, { kind: "scrollStart", version: "v-band", rate: 1, fromSec: 0 }));
      const turned = ok(act(running, "terry", 3000, { kind: "section", index: 2 }));
      const p = at(turned, 6000);
      return [p.beat !== null && p.scroll === null && scroll === "scroll-off" && p.section === 2, `beat ${JSON.stringify(p.beat)}, scroll ${p.scroll}, scrollStart ${scroll}`];
    },
  ],
  [
    "two tempo taps in one bar (150 then 100): the click ends at 100 and the scroll keeps 0.5 plan s per beat",
    () => {
      const running = ok(act(gig(), "terry", 0, countIn));
      const s = ok(act(ok(act(running, "terry", 3000, { kind: "tempo", bpm: 150 })), "terry", 3010, { kind: "tempo", bpm: 100 }));
      const beats = onsets(s, 2150, 10_150);
      const ms = gaps(beats.map((o) => o.t));
      const plan = gaps(beats.map((o) => o.planSec ?? NaN));
      const pass = beats.length > 8 && ms.slice(-4).every((d) => d === 600) && plan.every((d) => d === 0.5) && Math.abs((at(s, 10_150).scroll?.planSec ?? 0) - 7) < 1e-9;
      return [pass, `beat ms ${ms.join(",")}; plan s per beat ${[...new Set(plan)].join(",")}; plan s at 10150 ${at(s, 10_150).scroll?.planSec}`];
    },
  ],
  [
    "tempo 150 then straight back to 120 in one bar: the second tap is taken and the band stays at 120",
    () => {
      const running = ok(act(gig(), "terry", 0, countIn));
      const back = act(ok(act(running, "terry", 3000, { kind: "tempo", bpm: 150 })), "terry", 3010, { kind: "tempo", bpm: 120 });
      if (!back.ok) return [false, `second tap ${back.refused}`];
      const ms = gaps(onsets(back.state, 2150, 10_150).map((o) => o.t));
      return [ms.every((d) => d === 500) && sameUntil(back.state, running, 0, 10_150) === null, `beat ms ${[...new Set(ms)].join(",")}`];
    },
  ],
  [
    "a tempo tap inside the lead window of a pending tempo: bar 1 keeps even beats and nothing before the new change moves",
    () => {
      const first = ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 4000, { kind: "tempo", bpm: 150 }));
      const second = ok(act(first, "terry", 4050, { kind: "tempo", bpm: 100 }));
      const bar1 = onsets(second, 4150, 9000).filter((o) => o.bar === 1);
      const lengths = new Set(gaps([...bar1.map((o) => o.t), onsets(second, 4150, 9000).find((o) => o.bar === 2)!.t]));
      const moved = sameUntil(second, first, 4050, 5750);
      return [lengths.size === 1 && [400, 500].includes([...lengths][0]) && moved === null, `bar 1 beat ms ${[...lengths].join(",")}; first difference at ${moved}`];
    },
  ],
  [
    "Stop, then a count-in inside the Stop's lead window: no click on the stopped beat",
    () => {
      const stopped = ok(act(ok(act(gig(), "terry", 0, { ...countIn, bars: 2 })), "terry", 2000, { kind: "stop" }));
      const again = ok(act(stopped, "terry", 2040, countIn));
      const quiet = [2150, 2160, 2180].map((t) => at(again, t).beat);
      return [quiet.every((b) => b === null) && JSON.stringify(at(again, 2190).beat) === '{"bar":-1,"beat":0}', `beats at 2150,2160,2180: ${JSON.stringify(quiet)}; at 2190 ${JSON.stringify(at(again, 2190).beat)}`];
    },
  ],
  [
    "Start scroll tapped between a Stop and the count-in after it waits for the downbeat after the count-in",
    () => {
      const restarting = ok(act(ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 600, { kind: "stop" })), "terry", 640, countIn));
      const s = ok(act(restarting, "terry", 1240, { kind: "scrollStart", version: "v-band", rate: 1, fromSec: 0 }));
      const early = [1390, 2150, 3150, 4149].filter((t) => at(s, t).scroll !== null);
      const down = at(s, 4150);
      const pass = early.length === 0 && down.scroll?.planSec === 0 && JSON.stringify(down.beat) === '{"bar":0,"beat":0}';
      return [pass, `scroll moving at ${early.join(",") || "none"} before 4150; at 4150 plan s ${down.scroll?.planSec} on ${JSON.stringify(down.beat)}`];
    },
  ],
  [
    "Next tapped between a Stop and the count-in after it turns the song at now + lead and the count-in never sounds",
    () => {
      const restarting = ok(act(ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 600, { kind: "stop" })), "terry", 640, countIn));
      const s = ok(act(restarting, "terry", 1240, { kind: "goTo", key: "b" }));
      const sounding = [];
      for (let t = 1150; t <= 8150; t += 10) if (at(s, t).beat || at(s, t).scroll) sounding.push(t);
      const turns = at(s, 1389).song.key === "a" && at(s, 1390).song.key === "b";
      return [turns && sounding.length === 0, `song at 1389 ${at(s, 1389).song.key}, at 1390 ${at(s, 1390).song.key}; click or scroll at ${sounding.slice(0, 3).join(",") || "none"}`];
    },
  ],
  [
    "a page turn tapped between a Stop and the count-in after it lands at now + lead and the count-in still starts on its bar line",
    () => {
      const restarting = ok(act(ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 600, { kind: "stop" })), "terry", 640, countIn));
      const s = ok(act(restarting, "terry", 1240, { kind: "section", index: 2 }));
      const turns = at(s, 1389).section === null && at(s, 1390).section === 2;
      const pass = turns && at(s, 2140).beat === null && JSON.stringify(at(s, 2150).beat) === '{"bar":-1,"beat":0}' && at(s, 4150).scroll?.planSec === 0;
      return [pass, `section at 1389 ${at(s, 1389).section}, at 1390 ${at(s, 1390).section}; count-in at 2150 ${JSON.stringify(at(s, 2150).beat)}; plan s at 4150 ${at(s, 4150).scroll?.planSec}`];
    },
  ],
  [
    "a count-in at 100 tapped between a Stop and the count-in after it starts at now + lead and replaces the waiting one",
    () => {
      const restarting = ok(act(ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 600, { kind: "stop" })), "terry", 640, countIn));
      const s = ok(act(restarting, "terry", 1240, { ...countIn, bpm: 100 }));
      const times = onsets(s, 1150, 3790).map((o) => o.t);
      const down = at(s, 3790);
      const pass = times.join(",") === "1390,1990,2590,3190,3790" && at(s, 3780).scroll === null && JSON.stringify(down.beat) === '{"bar":0,"beat":0}' && down.scroll?.planSec === 0;
      return [pass, `beats at ${times.join(",")}; at 3790 ${JSON.stringify(down.beat)} plan s ${down.scroll?.planSec}`];
    },
  ],
  [
    "Stop tapped between a Stop and the count-in after it cancels the count-in",
    () => {
      const restarting = ok(act(ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 600, { kind: "stop" })), "terry", 640, countIn));
      const s = ok(act(restarting, "terry", 1240, { kind: "stop" }));
      const sounding = [];
      for (let t = 1150; t <= 8150; t += 10) if (at(s, t).beat || at(s, t).scroll) sounding.push(t);
      return [sounding.length === 0, `click or scroll at ${sounding.slice(0, 3).join(",") || "none"} after 1150`];
    },
  ],
  [
    "tempo 150 tapped between a Stop and the count-in after it: the count-in starts on its bar line at 150 and the scroll on its downbeat",
    () => {
      const restarting = ok(act(ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 600, { kind: "stop" })), "terry", 640, countIn));
      const s = ok(act(restarting, "terry", 1240, { kind: "tempo", bpm: 150 }));
      const quiet = [1390, 2140].every((t) => at(s, t).beat === null && at(s, t).scroll === null);
      const ms = gaps(onsets(s, 2150, 6150).map((o) => o.t));
      const down = at(s, 3750);
      const pass = quiet && JSON.stringify(at(s, 2150).beat) === '{"bar":-1,"beat":0}' && ms.every((d) => d === 400) && at(s, 3740).scroll === null &&
        JSON.stringify(down.beat) === '{"bar":0,"beat":0}' && down.scroll?.planSec === 0;
      return [pass, `count-in at 2150 ${JSON.stringify(at(s, 2150).beat)}; beat ms ${[...new Set(ms)].join(",")}; at 3750 ${JSON.stringify(down.beat)} plan s ${down.scroll?.planSec}`];
    },
  ],
  [
    "Start scroll from 30 s, then tempo 150, both before the downbeat: the scroll starts at 30 s on the downbeat, mid count-in or in the gap after a Stop",
    () => {
      const from30 = { kind: "scrollStart", version: "v-band", rate: 1, fromSec: 30 } as const;
      const counting = ok(act(ok(act(gig(), "terry", 0, { ...countIn, bars: 2 })), "terry", 1000, from30));
      const restarting = ok(act(ok(act(ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 600, { kind: "stop" })), "terry", 640, countIn)), "terry", 1240, from30));
      const starts = [ok(act(counting, "terry", 1100, { kind: "tempo", bpm: 150 })), ok(act(restarting, "terry", 1300, { kind: "tempo", bpm: 150 }))].map((s) => {
        let t = 0;
        while (t < 20_000 && !at(s, t).scroll) t += 10;
        return { t, beat: JSON.stringify(at(s, t).beat), planSec: at(s, t).scroll?.planSec };
      });
      const pass = starts.every((p) => p.t === 3750 && p.beat === '{"bar":0,"beat":0}' && p.planSec === 30);
      return [pass, starts.map((p) => `starts at ${p.t} on ${p.beat}, plan s ${p.planSec}`).join("; ")];
    },
  ],
  [
    "two tempo taps during a 2-bar count-in: the scroll starts on bar 0 beat 0",
    () => {
      const counting = ok(act(gig(), "terry", 0, { ...countIn, bars: 2 }));
      const s = ok(act(ok(act(counting, "terry", 600, { kind: "tempo", bpm: 150 })), "terry", 640, { kind: "tempo", bpm: 100 }));
      let start = 0;
      while (start < 20_000 && !at(s, start).scroll) start += 10;
      const p = at(s, start);
      return [JSON.stringify(p.beat) === '{"bar":0,"beat":0}' && p.scroll?.planSec === 0, `scroll starts at ${start} on ${JSON.stringify(p.beat)}, plan s ${p.scroll?.planSec}`];
    },
  ],
  [
    "the band talks for 5 minutes between songs: nothing moves on any phone",
    () => {
      const song = ok(act(ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 60_000, { kind: "stop" })), "terry", 61_000, { kind: "goTo", key: "b" }));
      const first = JSON.stringify(at(song, 62_000));
      let moved = 0;
      for (let t = 62_000; t <= 62_000 + 5 * 60_000; t += 250) if (JSON.stringify(at(song, t)) !== first) moved += 1;
      return [moved === 0 && at(song, 62_000).beat === null, `${moved} frames moved, showing ${first}`];
    },
  ],
];

const rules: [string, () => [boolean, string]][] = [
  [
    "goTo by key lands on that song's place in the order",
    () => {
      const s = ok(act(gig(), "terry", 0, { kind: "goTo", key: "c" }));
      const unknown = refused(act(s, "terry", 1000, { kind: "goTo", key: "zz" }));
      return [JSON.stringify(at(s, 150).song) === '{"key":"c","index":2}' && at(s, 149).song.key === "a" && unknown === "unknown-song", unknown];
    },
  ],
  [
    "a reorder keeps the current song; one that adds or drops songs is refused",
    () => {
      const s = ok(act(gig(), "terry", 0, { kind: "goTo", key: "c" }));
      const moved = ok(act(s, "terry", 1000, { kind: "reorder", order: ["c", "a", "d", "b"] }));
      const added = refused(act(s, "terry", 1000, { kind: "reorder", order: ["c", "a", "d", "b", "e"] }));
      const dropped = refused(act(s, "terry", 1000, { kind: "reorder", order: ["c", "a", "d"] }));
      const swapped = refused(act(s, "terry", 1000, { kind: "reorder", order: ["c", "a", "d", "d"] }));
      const p = at(moved, 2000);
      const waiting = at(moved, 1100).song;
      return [p.song.key === "c" && p.song.index === 0 && waiting.index === 2 && added === "changes-songs" && dropped === "changes-songs" && swapped === "changes-songs", `${JSON.stringify(waiting)} then ${JSON.stringify(p.song)}, ${added}, ${dropped}, ${swapped}`];
    },
  ],
  [
    "a page turn with the click running lands one beat before the bar line",
    () => {
      const s = ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 3000, { kind: "section", index: 1 }));
      const p = at(s, 3650);
      return [at(s, 3649).section === null && p.section === 1 && JSON.stringify(p.beat) === '{"bar":0,"beat":3}', `flip at 3650 on ${JSON.stringify(p.beat)}`];
    },
  ],
  [
    "next song with the click running lands on the bar line and stops click and scroll",
    () => {
      const s = ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 3000, { kind: "goTo", key: "b" }));
      const p = at(s, 4150);
      return [at(s, 4149).song.key === "a" && at(s, 4149).beat !== null && p.song.key === "b" && p.beat === null && p.scroll === null, `at 4149 ${at(s, 4149).song.key}, at 4150 ${p.song.key}`];
    },
  ],
  [
    "click and scroll run only while the leader's song runs, from the count-in",
    () => {
      const s = ok(act(gig(), "terry", 0, countIn));
      const quiet = at(s, 100);
      const counting = at(s, 150);
      const downbeat = at(s, 2150);
      const later = at(s, 3150);
      const pass = quiet.beat === null && quiet.scroll === null && JSON.stringify(counting.beat) === '{"bar":-1,"beat":0}' &&
        counting.scroll === null && downbeat.scroll?.planSec === 0 && downbeat.scroll.version === "v-band" && JSON.stringify(downbeat.beat) === '{"bar":0,"beat":0}' && later.scroll?.planSec === 1;
      return [pass, `count-in ${JSON.stringify(counting.beat)}, scroll ${JSON.stringify(later.scroll)}`];
    },
  ],
  [
    "a tempo change starts a new grid at the next bar line and the bars keep counting",
    () => {
      const s = ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 3000, { kind: "tempo", bpm: 100 }));
      const notRunning = refused(act(gig(), "terry", 0, { kind: "tempo", bpm: 100 }));
      return [JSON.stringify(at(s, 4150 + 600).beat) === '{"bar":1,"beat":1}' && notRunning === "not-running", `${JSON.stringify(at(s, 4750).beat)}, ${notRunning}`];
    },
  ],
  [
    "a tempo change keeps the scroll with the music",
    () => {
      const s = ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 3000, { kind: "tempo", bpm: 150 }));
      const atChange = at(s, 4150).scroll?.planSec;
      const second = at(s, 5150).scroll?.planSec;
      const twoBars = ok(act(ok(act(gig(), "terry", 0, { ...countIn, bars: 2 })), "terry", 500, { kind: "tempo", bpm: 150 }));
      const early = [at(twoBars, 3749).scroll, at(twoBars, 3750).scroll?.planSec, at(twoBars, 4750).scroll?.planSec];
      const pass = atChange === 2 && second === 3.25 && early[0] === null && early[1] === 0 && early[2] === 1.25;
      return [pass, `plan seconds ${atChange} at the change, ${second} one second later; during the count-in the scroll moves to the new bar 0 (${JSON.stringify(early)})`];
    },
  ],
  [
    "undo before at cancels the change and nobody flips; after at it is too late",
    () => {
      const s = gig();
      const go = act(s, "terry", 1000, { kind: "goTo", key: "d" });
      const opId = `op${opCount}`;
      const undone = ok(act(ok(go), "terry", 1100, { kind: "undo", target: opId }));
      const late = refused(act(ok(go), "terry", 1200, { kind: "undo", target: opId }));
      let flipped = 0;
      for (let t = 1000; t < 5000; t += 10) if (at(undone, t).song.key !== "a") flipped += 1;
      return [flipped === 0 && late === "too-late", `${flipped} frames flipped, undo after at: ${late}`];
    },
  ],
  [
    "only the current leader's ops are applied, and a repeat opId changes nothing",
    () => {
      const s = gig();
      const joe = refused(act(s, "joe", 1000, { kind: "goTo", key: "b" }));
      const op: Op = { opId: "same", epoch: 0, kind: "goTo", key: "b" };
      const once = ok(G.reduce(s, op, { by: "terry", now: band(1000), lead: LEAD }));
      const again = G.reduce(once, { ...op, kind: "goTo", key: "c" }, { by: "terry", now: band(1000), lead: LEAD });
      return [joe === "not-allowed" && refused(again) === "repeat", `joe ${joe}, repeat ${refused(again)}`];
    },
  ],
  [
    "a state from another gig never replaces tonight's, whatever its epoch",
    () => {
      const tonight = gig();
      const lastWeek = ok(act(gig({ gigId: "elks-last-week" }), "ann", 40_000, { kind: "takeOver" }));
      const heard = G.receive(tonight, lastWeek);
      return [heard.result === "other-gig" && heard.state === tonight, heard.result];
    },
  ],
  [
    "a handoff raises the epoch only when accepted, within 30 s",
    () => {
      const offered = ok(act(gig(), "terry", 1000, { kind: "handOff", to: "mike" }));
      const accepted = ok(act(offered, "mike", 20_000, { kind: "accept" }));
      const late = refused(act(offered, "mike", 31_000, { kind: "accept" }));
      const other = refused(act(offered, "joe", 20_000, { kind: "accept" }));
      const pass = offered.epoch === 0 && offered.leader === "terry" && accepted.epoch === 1 && accepted.leader === "mike" && late === "offer-expired" && other === "not-allowed";
      return [pass, `accepted epoch ${accepted.epoch}, late ${late}, someone else ${other}`];
    },
  ],
  [
    "a gig with no change for 8 hours ends itself",
    () => {
      const s = gig();
      const hours = 8 * 3_600_000;
      return [!at(s, hours - 1).ended && at(s, hours).ended && refused(act(s, "terry", hours, { kind: "goTo", key: "b" })) === "ended", ""];
    },
  ],
];

let failures = 0;
for (const [name, run] of [...drills, ...rules]) {
  let result: [boolean, string];
  try {
    result = run();
  } catch (error) {
    result = [false, String(error)];
  }
  if (!result[0]) failures += 1;
  console.log(`${result[0] ? "ok  " : "FAIL"} ${name}${result[1] ? ` (${result[1]})` : ""}`);
}
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("check:gig passed");
