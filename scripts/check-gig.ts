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

const drills: [string, () => [boolean, string]][] = [
  [
    "the leader double-taps Next: one change, one at",
    () => {
      const once = ok(act(gig(), "terry", 1000, { kind: "goTo", key: "b" }));
      const twice = act(once, "terry", 1080, { kind: "goTo", key: "b" });
      return [refused(twice) === "same-target" && once.rev === 1 && once.current.at === 1150, `second tap ${refused(twice)}, at ${once.current.at}`];
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
      const mikeTaps = refused(act(onMike.state!, "mike", 41_000, { kind: "goTo", key: "c" }));
      const pass =
        ann.epoch === 1 && mike.epoch === 1 && onMike.result === "applied" && onMike.state!.leader === "ann" &&
        onAnn.result === "lost-tie" && joeAnnFirst.state!.leader === "ann" && joeMikeFirst.state!.leader === "ann" && mikeTaps === "not-allowed";
      return [pass, `mike's phone ${onMike.result}, ann's phone ${onAnn.result}, mike then taps: ${mikeTaps}`];
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
      const terryTaps = refused(act(terrysPhone.state!, "terry", 41_000, { kind: "goTo", key: "c" }));
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
      const pass = stopped.click.at === 5650 && at(stopped, 5649).beat !== null && at(stopped, 5649).scroll !== null &&
        at(stopped, 5650).beat === null && at(stopped, 5650).scroll === null && after.song.key === before.song.key;
      return [pass, `stop lands at ${stopped.click.at} (beats every 500 ms from 150)`];
    },
  ],
  [
    "the band's scroll setting is off: charts don't scroll with the leader, the click and page turns still mirror",
    () => {
      const off = gig({ scrollAlong: false });
      const running = ok(act(off, "terry", 0, countIn));
      const scroll = refused(act(running, "terry", 3000, { kind: "scrollStart", version: "v-band", rate: 1, fromProgress: 0 }));
      const turned = ok(act(running, "terry", 3000, { kind: "section", index: 2 }));
      const p = at(turned, 6000);
      return [p.beat !== null && p.scroll === null && scroll === "scroll-off" && p.section === 2, `beat ${JSON.stringify(p.beat)}, scroll ${p.scroll}, scrollStart ${scroll}`];
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
      return [p.song.key === "c" && p.song.index === 0 && added === "changes-songs" && dropped === "changes-songs" && swapped === "changes-songs", `${JSON.stringify(p.song)}, ${added}, ${dropped}, ${swapped}`];
    },
  ],
  [
    "a page turn with the click running lands one beat before the bar line",
    () => {
      const s = ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 3000, { kind: "section", index: 1 }));
      const p = at(s, 3650);
      return [s.section.at === 3650 && at(s, 3649).section === null && p.section === 1 && JSON.stringify(p.beat) === '{"bar":0,"beat":3}', `flip at ${s.section.at} on ${JSON.stringify(p.beat)}`];
    },
  ],
  [
    "next song with the click running lands on the bar line and stops click and scroll",
    () => {
      const s = ok(act(ok(act(gig(), "terry", 0, countIn)), "terry", 3000, { kind: "goTo", key: "b" }));
      const p = at(s, 4150);
      return [s.current.at === 4150 && at(s, 4149).beat !== null && p.song.key === "b" && p.beat === null && p.scroll === null, `lands at ${s.current.at}`];
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
        counting.scroll === null && downbeat.scroll?.planSec === 0 && JSON.stringify(downbeat.beat) === '{"bar":0,"beat":0}' && later.scroll?.planSec === 1;
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
