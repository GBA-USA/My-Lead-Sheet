import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { LibraryFile, Song } from "../src/types.ts";

type App = typeof import("../src/scroll-timing.ts") &
  typeof import("../src/storage.ts") &
  typeof import("../src/song-data-editor.tsx") & { scrollPixelsPerSecond: typeof import("../src/music.ts").scrollPixelsPerSecond };

const seed = JSON.parse(readFileSync(new URL("../data/library.json", import.meta.url), "utf8")) as LibraryFile;

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${message}`);
  }
}
const near = (a: number, b: number, tolerance = 0.5) => Math.abs(a - b) <= tolerance;

async function loadApp(seedFile: LibraryFile): Promise<App> {
  const entry = `
    export * from "./src/scroll-timing.ts";
    export * from "./src/storage.ts";
    export * from "./src/song-data-editor.tsx";
    export { scrollPixelsPerSecond } from "./src/music.ts";
  `;
  const result = await build({
    stdin: { contents: entry, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    loader: { ".css": "empty" },
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: "silent",
    plugins: [
      {
        name: "seed",
        setup(b) {
          b.onLoad({ filter: /library\.json$/ }, () => ({ contents: JSON.stringify(seedFile), loader: "json" }));
        },
      },
    ],
  });
  const file = join(mkdtempSync(join(tmpdir(), "check-scroll-")), "app.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  return import(`${pathToFileURL(file).href}?${Math.random()}`);
}

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  },
});

let now = 0;
let frames: ((time: number) => void)[] = [];
Object.defineProperty(globalThis, "performance", { value: { now: () => now }, configurable: true });
Object.assign(globalThis, {
  requestAnimationFrame: (run: (time: number) => void) => frames.push(run),
  cancelAnimationFrame: () => {
    frames = [];
  },
});
function play(seconds: number) {
  const end = now + seconds * 1000;
  while (now < end - 1e-6 && frames.length) {
    now += 1000 / 60;
    const due = frames;
    frames = [];
    for (const run of due) run(now);
  }
}

/** A #sheet-scroll stand-in: 800px tall, chord section from 1000px to 4000px, page 5000px. */
class Sheet {
  scrollHeight = 5000;
  clientHeight = 800;
  top = 0;
  listeners = new Map<string, () => void>();
  get scrollTop() {
    return this.top;
  }
  set scrollTop(value: number) {
    this.top = Math.min(this.scrollHeight - this.clientHeight, Math.max(0, value));
    this.listeners.get("scroll")?.();
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
  removeEventListener(type: string) {
    this.listeners.delete(type);
  }
}
const SECTION = { start: 1000, end: 4000 - 800 };
const DISTANCE = SECTION.end - SECTION.start;

function scroller(app: App, start: Parameters<App["runScroll"]>[1]["current"], at = 0) {
  const sheet = new Sheet();
  sheet.top = at;
  const motion = { current: start };
  const clock = { current: 0 };
  const stops: { reason: string; at: number }[] = [];
  const cancel = app.runScroll(sheet, motion, () => SECTION, clock, (reason) => {
    stops.push({ reason, at: now / 1000 });
    cancel();
  });
  const startedAt = now / 1000;
  return { sheet, motion, clock, stops, startedAt, elapsed: () => now / 1000 - startedAt };
}

const app = await loadApp(seed);
const song = (id: number) => app.withSongData(seed.songs.find((item) => item.id === id) as Song, {});
const chain = song(10);
const take = song(5);
const half = song(13);

check(chain.officialRuntimeSec === 197 && chain.tempo === 78, "Chain Breaker has a 3:17 runtime at 78 BPM");

{
  const run = scroller(app, app.scrollMotion(chain, null, null, 78, 100));
  play(0.02);
  check(near(run.sheet.scrollTop, SECTION.start, 1), `even pace starts at the top of the chord section (at ${run.sheet.scrollTop})`);
  play(0.9);
  check(near(run.sheet.scrollTop, SECTION.start, 1), `even pace holds still for its first second (at ${run.sheet.scrollTop})`);
  play(9.1);
  const speed = DISTANCE / 196;
  check(near(run.sheet.scrollTop, SECTION.start + speed * (run.elapsed() - 1)), `after the 1 s hold, even pace is section / (runtime - 1 s) px/s (${run.sheet.scrollTop.toFixed(1)} after ${run.elapsed().toFixed(2)}s)`);

  const before = run.sheet.scrollTop;
  run.motion.current = app.scrollMotion(chain, null, null, 117, 100);
  play(1);
  check(near(run.sheet.scrollTop - before, speed * 1.5), `117 BPM on a 78 BPM song moves 1.5x at once (${(run.sheet.scrollTop - before).toFixed(2)}px in 1s, want ${(speed * 1.5).toFixed(2)})`);

  const mid = run.sheet.scrollTop;
  run.motion.current = app.scrollMotion(chain, null, null, 78, 50);
  play(1);
  check(near(run.sheet.scrollTop - mid, speed * 0.5), "Scroll 50% halves the pace");
  check(chain.tempo === 78 && app.loadSongData(10).tempo === undefined, "the percent trim leaves the song's BPM alone");
}

{
  const run = scroller(app, app.scrollMotion(chain, null, null, 78, 100));
  play(200);
  check(run.stops.length === 1 && run.stops[0].reason === "end", "even pace stops itself at the end of the chord section");
  check(near(run.stops[0].at - run.startedAt, 197, 0.1), `even pace reaches the end in the song's 197s (${(run.stops[0].at - run.startedAt).toFixed(2)}s)`);
  check(run.sheet.scrollTop === SECTION.end, "the end leaves the last chord line at the bottom of the view");
}

{
  const run = scroller(app, app.scrollMotion(chain, null, null, 78, 100), SECTION.start + DISTANCE / 2);
  play(1);
  check(near(run.clock.current, 197 / 2 + 1, 0.05), `Scroll On mid-chart resumes from that spot (clock ${run.clock.current.toFixed(2)})`);
  run.sheet.listeners.get("pointerdown")?.();
  check(run.stops.length === 1 && run.stops[0].reason === "user", "grabbing the sheet still pauses");
}

{
  const run = scroller(app, app.scrollMotion(chain, null, null, 78, 100), 1500);
  play(1);
  run.sheet.scrollTop = 200;
  check(run.stops.length === 1 && run.stops[0].reason === "user", "a manual scroll still pauses");
}

for (const missing of [take, half]) {
  const motion = app.scrollMotion(missing, null, null, null, 100);
  check(motion.kind === "pace" && motion.pxPerSec === app.scrollPixelsPerSecond(null, 100), `${missing.title} has no BPM, so it keeps the old 90 BPM page speed`);
  const run = scroller(app, motion, 100);
  play(2);
  check(near(run.sheet.scrollTop, 100 + 22.5 * run.elapsed()), `${missing.title} scrolls the whole page at 22.5px/s as before (${run.sheet.scrollTop.toFixed(1)})`);
  const bottom = scroller(app, motion, 4200);
  play(0.02);
  check(bottom.sheet.scrollTop < 10, "starting at the bottom of the page still restarts at the top");
}
const noRuntime = { ...chain, officialRuntimeSec: null };
check(app.scrollMotion(noRuntime, null, null, 78, 100).kind === "pace", "a song with a BPM but no runtime keeps the old page speed");

let saved: ReturnType<App["finishTake"]>;
{
  const even = app.evenPlan(chain)!;
  let recording = app.startTake(even, 78);
  const motionFor = () => app.scrollMotion(chain, null, recording, 78, 100);
  const run = scroller(app, motionFor(), 2500);
  play(0.02);
  check(near(run.sheet.scrollTop, SECTION.start, 1), "teaching always starts from the top of the chord section");
  play(30);
  const holdAt = run.clock.current;
  recording = app.toggleHold(recording, holdAt);
  run.motion.current = motionFor();
  const heldPosition = run.sheet.scrollTop;
  play(8);
  check(near(run.sheet.scrollTop, heldPosition, 0.05), "Hold stops the scroll while teaching");
  recording = app.toggleHold(recording, run.clock.current);
  run.motion.current = motionFor();
  play(1);
  check(run.sheet.scrollTop > heldPosition + 5, "Continue moves it again");
  play(300);
  check(run.stops[0]?.reason === "end", "the take ends at the end of the chord section");
  check(near(run.stops[0].at - run.startedAt, 197 + 8, 0.2), `the take lasts the song plus the 8s hold (${(run.stops[0].at - run.startedAt).toFixed(2)}s)`);
  saved = app.finishTake(recording, run.clock.current);
  check(saved.bpm === 78 && saved.marks.length === 4, "the take saves its BPM and four marks");
  check(saved.marks.every((mark) => mark.progress >= 0 && mark.progress <= 1), "marks are fractions of the chord section, not pixels");
  check(near(saved.marks[1].at, 30, 0.05) && near(saved.marks[2].at - saved.marks[1].at, 8, 0.05), "marks are seconds at the taught BPM");
}

{
  const version = { name: "V1", ...saved };
  const holdStart = saved.marks[1].at;
  const holdEnd = saved.marks[2].at;
  const run = scroller(app, app.scrollMotion(chain, version, null, 78, 100));
  play(holdStart + 1);
  const held = run.sheet.scrollTop;
  play(holdEnd - holdStart - 2);
  check(near(run.sheet.scrollTop, held, 0.05), "playback holds where the player tapped Hold");
  play(2);
  check(run.sheet.scrollTop > held + 5, "playback continues where the player tapped Continue");
  play(300);
  check(near(run.stops[0].at - run.startedAt, saved.marks[3].at, 0.1), "playback reaches the end when the take did");

  const fast = scroller(app, app.scrollMotion(chain, version, null, 156, 100));
  play(holdStart / 2 + 0.5);
  const fastHeld = fast.sheet.scrollTop;
  play((holdEnd - holdStart) / 2 - 1);
  check(near(fast.sheet.scrollTop, fastHeld, 0.05), "at double BPM the hold starts at half the time");
  play(1);
  check(fast.sheet.scrollTop > fastHeld + 5, "at double BPM the hold ends at half the time");
  play(300);
  check(near(fast.stops[0].at - fast.startedAt, saved.marks[3].at / 2, 0.1), `taught timing stretches by taughtBpm/currentBpm (${(fast.stops[0].at - fast.startedAt).toFixed(2)}s)`);

  const marks = [{ at: 0, progress: 0 }, { at: 10, progress: 0.5 }, { at: 20, progress: 0.5 }, { at: 30, progress: 1 }];
  for (const offset of [-0.6, 0, 0.6]) {
    const spot = SECTION.start + DISTANCE / 2 + offset;
    const resume = scroller(app, app.scrollMotion(chain, { name: "Hold", bpm: 78, marks }, null, 78, 100), spot);
    play(0.5);
    check(resume.sheet.scrollTop > spot + 5, `Scroll On ${offset}px from a held spot moves on rather than waiting out the hold`);
  }
  const top = scroller(app, app.scrollMotion(chain, { name: "Intro", bpm: 78, marks: [{ at: 0, progress: 0 }, { at: 15, progress: 0 }, { at: 30, progress: 1 }] }, null, 78, 100), SECTION.start + 0.4);
  play(1);
  check(near(top.sheet.scrollTop, SECTION.start, 0.01), "Scroll On at the top still plays a held intro");
}

{
  check(app.nextVersionName([]) === "V1", "the first version is V1");
  const v1 = { name: "V1", ...saved };
  check(app.nextVersionName([v1]) === "V2", "the next is V2");
  check(app.nextVersionName([v1, { ...v1, name: "V3" }]) === "V4", "a rename to V3 is skipped");
  app.saveScrollVersions(10, { versions: [v1, { ...v1, name: "V2" }], selected: 1 });
  const loaded = app.loadScrollVersions(10);
  check(loaded.versions.length === 2 && loaded.selected === 1, "versions and the chosen one survive a reload");
  app.saveScrollVersions(10, { versions: loaded.versions.map((v, i) => (i === 0 ? { ...v, name: "Slow intro" } : v)), selected: 0 });
  check(app.loadScrollVersions(10).versions[0].name === "Slow intro", "a version can be renamed");
  app.saveScrollVersions(10, { ...app.loadScrollVersions(10), selected: null });
  const reset = app.loadScrollVersions(10);
  check(reset.selected === null && reset.versions.length === 2, "reset goes back to the even pace and keeps the versions");
  check(app.scrollMotion(chain, null, null, 78, 100).startAt(0.5) === 197 / 2, "after reset the song plays the even pace");
  check(app.loadScrollVersions(11).versions.length === 0, "versions are per song");
  store.set("leadSheetsScrollVersions.10", JSON.stringify({ versions: [{ name: "bad", bpm: 78, marks: [{ at: 0, progress: 0 }] }, v1], selected: 7 }));
  const repaired = app.loadScrollVersions(10);
  check(repaired.versions.length === 1 && repaired.selected === null, "a broken saved version is dropped instead of breaking the song");
}

{
  check(app.parseRuntime("4:04") === 244 && app.parseRuntime("404") === null && app.parseRuntime("4:60") === null, "length reads m:ss");
  check(app.formatRuntime(197) === "3:17", "length shows as m:ss");
  const data = app.songDataFromForm(half, { runtime: "3:53", bpm: "96", timeSignature: "4/4" });
  check(JSON.stringify(data) === JSON.stringify({ tempo: 96 }), `only changed fields are saved (${JSON.stringify(data)})`);
  check(app.songDataFromForm(half, { runtime: "", bpm: "", timeSignature: "" })?.tempo === undefined, "blank fields keep the library's values");
  check(app.songDataFromForm(half, { runtime: "3:5", bpm: "", timeSignature: "" }) === null, "an unreadable length can't be saved");
  check(app.songDataFromForm(half, { runtime: "", bpm: "999", timeSignature: "" }) === null, "a BPM outside the metronome range can't be saved");

  app.saveSongData(13, data!);
  app.saveSongData(10, { officialRuntimeSec: 200, timeSignature: "6/8" });
  const updatedSeed = JSON.parse(JSON.stringify(seed)) as LibraryFile;
  const seedChain = updatedSeed.songs.find((item) => item.id === 10)!;
  seedChain.officialRuntimeSec = 190;
  seedChain.feel = "Updated feel";
  const reloaded = await loadApp(updatedSeed);
  const library = reloaded.loadLibrary();
  const edited = (id: number) => reloaded.withSongData(library.songs.find((item) => item.id === id)!, reloaded.loadSongData(id));
  check(edited(13).tempo === 96, "an entered BPM survives a reload");
  check(edited(10).officialRuntimeSec === 200 && edited(10).timeSignature === "6/8", "entered values beat a seed update");
  check(edited(10).feel === "Updated feel" && edited(10).tempo === 78, "fields not entered still follow the seed");
  check(reloaded.scrollMotion(edited(13), null, null, null, 100).kind === "timed", "No Half Steppin' scrolls timed once its BPM is entered");
  check(reloaded.evenPlan(edited(13))!.bpm === 96, "the entered BPM is the scroll's base BPM");
  reloaded.saveSongData(10, {});
  check(store.get("leadSheetsSongData.10") === undefined, "Use original removes the entry");
  check(reloaded.withSongData(library.songs.find((item) => item.id === 10)!, reloaded.loadSongData(10)).officialRuntimeSec === 190, "Use original goes back to the seed value");
}

{
  store.clear();
  const old = JSON.parse(JSON.stringify(seed)) as LibraryFile & { songs: Partial<Song>[] };
  for (const item of old.songs) delete item.officialRuntimeSec;
  (await loadApp(old as LibraryFile)).loadLibrary();
  const stored = JSON.parse(store.get("leadSheetsLibrary")!);
  stored.songs.push({ ...stored.songs[0], id: 99, title: "My own song" });
  store.set("leadSheetsLibrary", JSON.stringify(stored));
  const library = app.loadLibrary();
  check(library.songs.find((item) => item.id === 10)?.officialRuntimeSec === 197, "a library saved before runtimes picks them up from the seed");
  const own = library.songs.find((item) => item.id === 99);
  check(own != null && app.withSongData(own, {}).officialRuntimeSec === null, "a song saved without a runtime still loads, with no runtime");
}

if (failures) {
  console.error(`${failures} scroll check(s) failed`);
  process.exit(1);
}
console.log("scroll ok: even pace over the runtime, BPM and percent scale it at once, teach holds and continues, BPM stretch, versions, entered song data, old behavior kept for missing data");
