/**
 * U-SCROLL-SYNC: auto-scroll paced from the song itself, the line being sung at the middle of the sheet, and live
 * − / + speed. Pure model checks with no browser: the app's modules are bundled with esbuild and driven with a fake
 * scroller, fake frames and a chart laid out by hand. Paths go through fileURLToPath so this runs on Windows and Linux.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { LibraryFile, Song } from "../src/types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const seed = JSON.parse(readFileSync(join(ROOT, "data", "library.json"), "utf8")) as LibraryFile;
const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8");

type Timing = typeof import("../src/scroll-timing.ts");
type App = Timing & {
  SongControls: typeof import("../src/controls.tsx").SongControls;
  renderToStaticMarkup: typeof import("react-dom/server").renderToStaticMarkup;
  createElement: typeof import("react").createElement;
};

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  },
});

async function loadApp(): Promise<App> {
  const entry = `
    export * from "./src/scroll-timing.ts";
    export { SongControls } from "./src/controls.tsx";
    export { renderToStaticMarkup } from "react-dom/server";
    export { createElement } from "react";
  `;
  const result = await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    loader: { ".css": "empty" },
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: "silent",
  });
  const file = join(mkdtempSync(join(tmpdir(), "check-scroll-sync-")), "app.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  return import(`${pathToFileURL(file).href}?${Math.random()}`);
}

let failures = 0;
function test(name: string, run: () => void) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
  }
}
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

let now = 0;
let frames: ((time: number) => void)[] = [];
Object.defineProperty(globalThis, "performance", { value: { now: () => now }, configurable: true });
Object.assign(globalThis, {
  requestAnimationFrame: (run: (time: number) => void) => frames.push(run),
  cancelAnimationFrame: () => void (frames = []),
});
function play(seconds: number, each?: () => void) {
  const end = now + seconds * 1000;
  while (now < end - 1e-6 && frames.length) {
    now += 1000 / 60;
    const due = frames;
    frames = [];
    for (const run of due) run(now);
    each?.();
  }
}

/** One song line as the test lays it out: the box its rows fill, in px down the scroller. */
interface LineBox {
  section: number;
  line: number;
  top: number;
  bottom: number;
}

const ROW = { heading: 34, pair: 52, chordsOnly: 26, bars: 28, lyric: 28, note: 44 };
const TOKEN = /[^\s|]+/g;

/**
 * Lays a song's chart out the way the sheet draws it on a phone `columns` characters wide: a heading per section, a
 * chord+lyric line wraps into one `.pair` per `columns` characters (each holding the chords that start in it), a bar
 * line into `.bars` rows the same way, a lyric-only line is one `.lyric-only`, a note one `.chart-note`.
 */
function layOut(song: Song, chartTop: number, columns = 35) {
  let y = chartTop;
  const boxes: LineBox[] = [];
  const laid = song.body.map((section, s) => {
    const heading = { top: y, height: ROW.heading };
    y += ROW.heading;
    const rows: { kind: "pair" | "bars" | "lyric-only" | "chart-note"; chords: number; top: number; height: number }[] = [];
    section.lines.forEach((line, l) => {
      const first = rows.length;
      const wrap = (kind: "pair" | "bars", text: string, width: number, height: number) => {
        const starts = [...text.matchAll(TOKEN)].map((token) => token.index);
        for (let from = 0; from < Math.max(1, width); from += columns) {
          rows.push({ kind, chords: starts.filter((at) => at >= from && at < from + columns).length, top: y, height });
          y += height;
        }
      };
      if (line.chords !== undefined) wrap("pair", line.chords, Math.max(line.chords.length, line.lyrics?.length ?? 0), line.lyrics === undefined ? ROW.chordsOnly : ROW.pair);
      else if (line.lyrics !== undefined) {
        rows.push({ kind: "lyric-only", chords: 0, top: y, height: ROW.lyric });
        y += ROW.lyric;
      }
      if (line.bars !== undefined) wrap("bars", line.bars, line.bars.length, ROW.bars);
      if (line.note !== undefined) {
        rows.push({ kind: "chart-note", chords: 0, top: y, height: ROW.note });
        y += ROW.note;
      }
      if (rows.length > first) boxes.push({ section: s, line: l, top: rows[first].top, bottom: y });
    });
    return { heading, rows };
  });
  return { laid, boxes, chartTop, chartBottom: y };
}

class Sheet {
  scrollTop = 0;
  clientHeight: number;
  scrollHeight: number;
  constructor(clientHeight: number, scrollHeight: number) {
    this.clientHeight = clientHeight;
    this.scrollHeight = scrollHeight;
  }
  addEventListener() {}
  removeEventListener() {}
}

/** Runs the app's scroll over a laid-out chart and records where the reading line is, in chart px, every frame. */
function perform(app: App, motion: ReturnType<Timing["scrollMotion"]>, song: Song, clientHeight: number, lines?: () => number[]) {
  const chart = layOut(song, 1200);
  const sheet = new Sheet(clientHeight, chart.chartBottom + clientHeight);
  const ref = { current: motion };
  const clock = { current: 0 };
  const stops: string[] = [];
  const section = () => ({ start: chart.chartTop, end: chart.chartBottom - clientHeight, laid: () => chart.laid, ...(lines ? { lines } : {}) });
  const started = now;
  const seen: { t: number; top: number; clock: number }[] = [];
  const cancel = app.runScroll(sheet, ref, section, clock, (reason) => {
    stops.push(reason);
    cancel();
  });
  const run = (seconds: number) => play(seconds, () => seen.push({ t: (now - started) / 1000, top: sheet.scrollTop, clock: clock.current }));
  return { chart, sheet, ref, clock, stops, seen, run, cancel };
}

/** When the reading line (the sheet's middle) first reaches `y`, in seconds since Scroll On. */
function crossing(seen: { t: number; top: number }[], clientHeight: number, y: number): number {
  return seen.find((frame) => frame.top + clientHeight / 2 >= y)?.t ?? Infinity;
}

const app = await loadApp();
const fireAway = { ...seed.songs.find((song) => song.title === "Fire Away")!, ref: "local/1" } as Song;

/**
 * Fire Away as it is played, read off the chart: the intro is two lines of four bars, and it is "the same pattern as
 * the verse start", so every sung line is four bars of 3/4. The last chorus is sung twice, and the outro is the
 * four chorus bars "| F#m | E | A | D E |" once.
 */
const FIRE_AWAY = {
  bpm: 116,
  beatsPerBar: 3,
  bars: [[4, 4], [4, 4], [4, 4], [4, 4, 4, 4], [4, 4], [4, 4], [4, 4, 4, 4], [4]],
  plays: [1, 1, 1, 1, 1, 1, 2, 1],
};
const beat = 60 / FIRE_AWAY.bpm;

/** Each line's start and length in seconds, from bars × beats per bar × 60 / BPM, summed in play order. */
function expectedLines(spec: { bpm: number; beatsPerBar: number; bars: number[][]; plays: number[] }) {
  const bar = (spec.beatsPerBar * 60) / spec.bpm;
  let at = 0;
  return spec.bars.flatMap((section, s) =>
    section.map((bars, line) => {
      const length = bars * bar * spec.plays[s];
      const each = { section: s, line, start: at, length, mid: at + length / 2 };
      at += length;
      return each;
    }),
  );
}

test("a known song layout reaches screen center at the expected beat times within one beat", () => {
  assert(fireAway.tempo === 116 && fireAway.timeSignature.startsWith("3/4"), "Fire Away is 116 BPM in 3/4");
  const expected = expectedLines(FIRE_AWAY);
  assert(expected.length === fireAway.body.flatMap((section) => section.lines).length, "the expected plan covers every chart line");
  const clientHeight = 700;
  const run = perform(app, app.scrollMotion(fireAway, null, null, 116, 100), fireAway, clientHeight);
  run.run(expected.at(-1)!.start + expected.at(-1)!.length + 5);
  const wrong: string[] = [];
  for (const line of expected) {
    const box = run.chart.boxes.find((each) => each.section === line.section && each.line === line.line)!;
    const at = crossing(run.seen, clientHeight, (box.top + box.bottom) / 2);
    const heading = fireAway.body[line.section].heading.split(/\s+[(—]/)[0];
    if (Math.abs(at - line.mid) > beat) wrong.push(`${heading} line ${line.line + 1} centered at ${at.toFixed(2)} s, want ${line.mid.toFixed(2)} s`);
  }
  assert(wrong.length === 0, `every Fire Away line is centered within one beat (${beat.toFixed(3)} s) of its time: ${wrong.join("; ")}`);
  const outro = expected.at(-1)!;
  assert(Math.abs(outro.start - 88 * 3 * beat) < 1e-9, "the outro starts 88 bars in, after the doubled last chorus");
  assert(run.stops.length === 1 && run.stops[0] === "end", `the scroll ends by itself once the song is sung (${run.stops.join(",")})`);

  const mixed: Song = {
    ...fireAway,
    title: "Mixed bars",
    tempo: 90,
    timeSignature: "4/4",
    officialRuntimeSec: null,
    body: [
      { heading: "INTRO", lines: [{ bars: "| C | G |" }, { bars: "| Am | F | C | G | Am | F |" }, { bars: "| C |" }] },
      { heading: "VERSE", lines: [{ chords: "C            G", lyrics: "Short line here" }, { note: "Sing this one softly" }, { chords: "Am", lyrics: "Another line" }] },
      { heading: "TAG", lines: [{ bars: "| F | G | C | C | F | G | C | C |" }] },
    ],
  };
  const mixedLines = expectedLines({ bpm: 90, beatsPerBar: 4, bars: [[2, 6, 1], [2, 0, 2], [8]], plays: [1, 1, 1] });
  const mixedRun = perform(app, app.scrollMotion(mixed, null, null, 90, 100), mixed, clientHeight);
  mixedRun.run(mixedLines.at(-1)!.start + mixedLines.at(-1)!.length + 5);
  const off: string[] = [];
  for (const line of mixedLines.filter((each) => each.length > 0)) {
    const box = mixedRun.chart.boxes.find((each) => each.section === line.section && each.line === line.line)!;
    const at = crossing(mixedRun.seen, clientHeight, (box.top + box.bottom) / 2);
    if (Math.abs(at - line.mid) > 60 / 90) off.push(`${mixed.body[line.section].heading} line ${line.line + 1} at ${at.toFixed(2)} s, want ${line.mid.toFixed(2)} s`);
  }
  assert(off.length === 0, `lines of 1, 2, 6 and 8 bars in one chart each get their own length, not a section average: ${off.join("; ")}`);
});

test("the pace comes from the song alone; there is no album or radio-edit choice", () => {
  const clientHeight = 700;
  const centers = (runtime: number | null) => {
    const song = { ...fireAway, officialRuntimeSec: runtime };
    const run = perform(app, app.scrollMotion(song, null, null, 116, 100), song, clientHeight);
    run.run(60);
    run.cancel();
    return run.chart.boxes.slice(0, 8).map((box) => crossing(run.seen, clientHeight, (box.top + box.bottom) / 2).toFixed(3));
  };
  const album = centers(244);
  assert(album.every((at) => at !== "Infinity"), `the first eight lines reach the middle in the first minute (${album.join(", ")})`);
  assert(JSON.stringify(centers(180)) === JSON.stringify(album), "a shorter recorded length does not change when a line is centered");
  assert(JSON.stringify(centers(null)) === JSON.stringify(album), "a song with a BPM and no recorded length still gets the song's own pace");
  const picker = /album|radio/i;
  const names = Object.keys(app).filter((name) => picker.test(name));
  assert(names.length === 0, `scroll-timing exports no album or radio-edit choice (${names.join(", ")})`);
  const html = app.renderToStaticMarkup(app.createElement(app.SongControls, controlsProps(true)));
  assert(!picker.test(html), "the song controls offer no album or radio-edit choice");
});

test("the current lyric+chord line is at the vertical midpoint, with lines ahead below and lines just played above", () => {
  const expected = expectedLines(FIRE_AWAY);
  for (const clientHeight of [520, 700, 940]) {
    const run = perform(app, app.scrollMotion(fireAway, null, null, 116, 100), fireAway, clientHeight);
    run.run(expected[9].mid + 1);
    run.cancel();
    const wrong: string[] = [];
    for (const line of expected.slice(0, 10)) {
      const i = run.chart.boxes.findIndex((each) => each.section === line.section && each.line === line.line);
      const box = run.chart.boxes[i];
      const frame = run.seen.reduce((best, each) => (Math.abs(each.t - line.mid) < Math.abs(best.t - line.mid) ? each : best));
      const reading = frame.top + clientHeight / 2;
      const center = (box.top + box.bottom) / 2;
      if (Math.abs(center - reading) > 2) wrong.push(`line ${i + 1}'s center is ${(center - frame.top).toFixed(1)} px down a ${clientHeight} px sheet`);
      if (i > 0 && run.chart.boxes[i - 1].bottom > reading) wrong.push(`line ${i} (just played) is not above the middle`);
      if (run.chart.boxes[i + 1] && run.chart.boxes[i + 1].top < reading) wrong.push(`line ${i + 2} (ahead) is not below the middle`);
    }
    assert(wrong.length === 0, `at ${clientHeight} px the line being sung sits at ${clientHeight / 2} px: ${wrong.join("; ")}`);
  }
});

test("plus and minus change the pace in small steps during playback without a jump", () => {
  assert(typeof app.stepSpeed === "function", "scroll-timing exports stepSpeed");
  assert(typeof app.atSpeed === "function", "scroll-timing exports atSpeed");
  const up = app.stepSpeed(1, 1);
  const down = app.stepSpeed(1, -1);
  assert(Math.abs(up - 1.05) < 1e-9 && Math.abs(down - 0.95) < 1e-9, `one tap is 5% (+ ${up}, − ${down})`);
  let fast = 1;
  let slow = 1;
  for (let i = 0; i < 40; i += 1) {
    fast = app.stepSpeed(fast, 1);
    slow = app.stepSpeed(slow, -1);
  }
  assert(Math.abs(fast - 1.5) < 1e-9 && Math.abs(slow - 0.5) < 1e-9, `the speed stays between 50% and 150% (${slow} to ${fast})`);
  let walk = 1;
  for (let i = 0; i < 7; i += 1) walk = app.stepSpeed(walk, 1);
  for (let i = 0; i < 7; i += 1) walk = app.stepSpeed(walk, -1);
  assert(walk === 1, `seven taps up and seven down land back on 100% exactly (${walk})`);

  const clientHeight = 700;
  const base = app.scrollMotion(fireAway, null, null, 116, 100);
  const run = perform(app, base, fireAway, clientHeight);
  run.run(40);
  const steps = (from: number) => run.seen.slice(from + 1).map((frame, i) => frame.top - run.seen[from + i].top);
  const before = run.seen.length;
  const clockBefore = run.clock.current;
  run.ref.current = app.atSpeed(base, up);
  run.run(20);
  const around = steps(before - 30).slice(0, 60);
  const typical = around.slice(0, 25).reduce((sum, step) => sum + step, 0) / 25;
  const worst = Math.max(...around.map((step) => Math.abs(step)));
  assert(worst < Math.max(2, typical * 3), `the sheet moves on smoothly through the tap (largest frame step ${worst.toFixed(2)} px, typical ${typical.toFixed(2)} px)`);
  const moved = run.clock.current - clockBefore;
  assert(Math.abs(moved - 20 * 1.05) < 0.05, `after + the song's clock runs 5% faster (${moved.toFixed(3)} s of song in 20 s)`);
  const mark = run.seen.length;
  const clockMid = run.clock.current;
  run.ref.current = app.atSpeed(base, app.stepSpeed(app.stepSpeed(up, -1), -1));
  run.run(20);
  const back = steps(mark - 30).slice(0, 60);
  assert(Math.max(...back.map((step) => Math.abs(step))) < Math.max(2, typical * 3), "two taps of − also move on without a jump");
  assert(Math.abs(run.clock.current - clockMid - 20 * 0.95) < 0.05, `and slow the song's clock to 95% (${(run.clock.current - clockMid).toFixed(3)} s in 20 s)`);
  assert(run.stops.length === 0, "speed taps never stop the scroll");
  run.cancel();

  const paced = app.scrollMotion({ ...fireAway, tempo: null }, null, null, null, 100);
  const sped = app.atSpeed(paced, 1.1);
  assert(paced.kind === "pace" && sped.kind === "pace" && Math.abs(sped.pxPerSec - paced.pxPerSec * 1.1) < 1e-9, "a song with no BPM speeds its page scroll by the same factor");
});

function controlsProps(scrolling: boolean) {
  const none = () => {};
  return {
    keyLabel: "A major",
    onTransposeDown: none,
    onTransposeUp: none,
    onOriginalKey: none,
    notation: "notes" as const,
    onNotation: none,
    scrolling,
    onToggleScroll: none,
    onScrollSheet: none,
    onMetronome: none,
  };
}

/** The declarations of every rule whose selector list names `selector` exactly, outside @media blocks too. */
function rules(selector: string): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((each) => each.trim());
    if (selectors.includes(selector)) found.push(match[2]);
  }
  return found;
}
const px = (declarations: string[], property: string) =>
  declarations.map((each) => each.match(new RegExp(`(?:^|;|\\s)${property}:\\s*(\\d+)px`))?.[1]).filter(Boolean).map(Number);

test("the speed buttons are at least 48 px and reachable while scrolling", () => {
  const on = app.renderToStaticMarkup(app.createElement(app.SongControls, controlsProps(true)));
  const off = app.renderToStaticMarkup(app.createElement(app.SongControls, controlsProps(false)));
  const group = on.match(/<div class="scroll-speed"[^>]*>([\s\S]*?)<\/div>/);
  assert(group, "Scroll: On shows the speed group");
  assert(!off.includes("scroll-speed"), "Scroll: Off hides it, so the bar at rest is unchanged");
  assert(/^Scroll: On$/.test(on.match(/<button[^>]*class="scroll-pill is-on"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/button>/)?.[1]?.trim() ?? ""), "the Scroll pill still reads Scroll: On");
  const buttons = [...group[1].matchAll(/<button([^>]*)>/g)].map((each) => each[1]);
  const slower = buttons.find((each) => /aria-label="Scroll slower"/.test(each));
  const faster = buttons.find((each) => /aria-label="Scroll faster"/.test(each));
  assert(slower && faster, `the group has Scroll slower and Scroll faster buttons (${buttons.length} buttons)`);
  const classOf = (attrs: string) => attrs.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? [];
  for (const attrs of [slower, faster]) {
    const sizes = classOf(attrs).flatMap((name) => {
      const found = rules(`.${name}`);
      return [...px(found, "width"), ...px(found, "min-width")].concat(px(found, "height"), px(found, "min-height"));
    });
    const widths = classOf(attrs).flatMap((name) => [...px(rules(`.${name}`), "width"), ...px(rules(`.${name}`), "min-width")]);
    const heights = classOf(attrs).flatMap((name) => [...px(rules(`.${name}`), "height"), ...px(rules(`.${name}`), "min-height")]);
    assert(sizes.length > 0 && Math.max(...widths) >= 48 && Math.max(...heights) >= 48, `${attrs.match(/aria-label="([^"]*)"/)?.[1]} is at least 48 × 48 px (widths ${widths.join("/")}, heights ${heights.join("/")})`);
  }
  const groupRules = rules(".scroll-speed");
  assert(groupRules.some((each) => /position:\s*fixed/.test(each)), "the group is fixed on screen, so it stays in reach while the sheet scrolls under it");
  const hidden = [...css.matchAll(/([^{}]+)\{([^{}]*display:\s*none[^{}]*)\}/g)].filter((match) => /scroll-speed/.test(match[1]));
  assert(hidden.length === 0, `no rule hides the group, folded bar included (${hidden.map((match) => match[1].trim()).join(" | ")})`);
});

test("a learned song (Learn timings) keeps following its learned marks", () => {
  const clientHeight = 700;
  const sectionsAt = [3, 15, 27, 39, 64, 76, 88, 120];
  const learned = {
    name: "V1",
    bpm: 116,
    marks: [{ at: 0, progress: 0 }, { at: 150, progress: 1 }],
    learned: { beatsPerBar: 3, downbeat: 3 * beat, beats: [], sections: fireAway.body.map((section, i) => ({ heading: section.heading, at: sectionsAt[i] })), vocals: [] },
  };
  const motion = app.scrollMotion(fireAway, learned, null, 116, 100);
  assert(motion.kind === "learned", `a learned version plays by its headings (${motion.kind})`);
  const chart = layOut(fireAway, 1200);
  const headings = chart.laid.map((section) => section.heading.top);
  const run = perform(app, motion, fireAway, clientHeight, () => [...headings, chart.chartBottom].map((top) => top - app.READING_LINE));
  run.run(152);
  const wrong: string[] = [];
  sectionsAt.forEach((at, i) => {
    const frame = run.seen.find((each) => each.clock >= at)!;
    const line = headings[i] - frame.top;
    if (Math.abs(line - app.READING_LINE) > 1.5) wrong.push(`${fireAway.body[i].heading.split(/\s+[(—]/)[0]} at ${line.toFixed(1)} px`);
  });
  assert(wrong.length === 0, `each heading lands on the learned reading line (${app.READING_LINE} px) at its learned time, not the computed pace: ${wrong.join("; ")}`);

  const taught = { name: "V2", bpm: 116, marks: [{ at: 0, progress: 0 }, { at: 60, progress: 0.3 }, { at: 90, progress: 0.3 }, { at: 150, progress: 1 }], tempo: [{ at: 0, bpm: 116 }, { at: 90, bpm: 120 }] };
  const timed = app.scrollMotion(fireAway, taught, null, 116, 100);
  const held = perform(app, timed, fireAway, clientHeight);
  held.run(75);
  const { start, end } = { start: held.chart.chartTop, end: held.chart.chartBottom - clientHeight };
  const want = start + (end - start) * 0.3;
  assert(Math.abs(held.sheet.scrollTop - want) < 1, `a taught version with a tempo map holds where its marks hold (${held.sheet.scrollTop.toFixed(1)} px, want ${want.toFixed(1)} px)`);
  held.cancel();
});

if (failures) {
  console.error(`${failures} scroll-sync check(s) failed`);
  process.exit(1);
}
console.log("scroll-sync: all checks passed");
