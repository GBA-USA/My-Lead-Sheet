import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { LibraryFile, Song } from "../src/types.ts";
import type { Motion, Section } from "../src/scroll-timing.ts";

const root = new URL("..", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const seed = JSON.parse(read("data/library.json")) as LibraryFile;

let failures = 0;
const failed = new Set<string>();
function check(ok: boolean, message: string) {
  if (ok) return;
  failures += 1;
  const kind = message.replace(/ \([^()]*\)$/, "").replace(/: .*$/, "");
  if (!failed.has(kind)) console.error(`FAIL ${message}`);
  failed.add(kind);
}
const near = (a: number, b: number, tolerance = 0.5) => Math.abs(a - b) <= tolerance;

const viewport = read("index.html").match(/<meta name="viewport" content="([^"]*)"/)?.[1] ?? "";
check(/user-scalable=no/.test(viewport) && /maximum-scale=1\b/.test(viewport), `the viewport meta turns off page zoom for Android Chrome (${viewport})`);
check(/addEventListener\("gesturestart", \(event\) => event\.preventDefault\(\)\)/.test(read("index.html")), "iOS Safari's pinch gesture is cancelled, since it ignores user-scalable=no");
check(/html\s*\{[^}]*touch-action:\s*pan-x pan-y/.test(read("src/styles.css")), "the page root allows panning only, so pinch and double-tap zoom are off");
check(!/\.chart\s*\{[^}]*overflow-x/.test(read("src/styles.css")), "the chart no longer scrolls sideways");

async function bundle(contents: string): Promise<Record<string, unknown>> {
  const result = await build({
    stdin: { contents, resolveDir: root.pathname, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    loader: { ".css": "empty" },
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: "silent",
  });
  const file = join(mkdtempSync(join(tmpdir(), "check-fit-")), "app.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const fitModule = existsSync(new URL("src/chart-fit.ts", root));
const app = (await bundle(`
  export * from "./src/music.ts";
  export * from "./src/scroll-timing.ts";
  export * from "./src/hooks.ts";
  export { TEXT_SCALES } from "./src/storage.ts";
  ${fitModule ? 'export * from "./src/chart-fit.ts";' : ""}
`)) as typeof import("../src/music.ts") &
  typeof import("../src/scroll-timing.ts") &
  typeof import("../src/hooks.ts") &
  Partial<typeof import("../src/chart-fit.ts")> & { TEXT_SCALES: readonly number[] };

check(fitModule, "there is a chart layout that wraps long rows (src/chart-fit.ts)");

/** IBM Plex Mono is 600 units wide on a 1000-unit em, which is what the canvas measures in Chrome. */
const advance = (size: number) => size * 0.6;
/** The sheet's text width: 10px margins and 16px padding on a phone, 16px and 28px from 768px. */
const chartWidth = (window: number) => (window >= 768 ? window - 2 * 16 - 2 * 28 : window - 2 * 10 - 2 * 16);
const wrap = app.wrapAligned ?? ((chords: string, lyrics?: string) => [{ chords, lyrics }]);
const font = app.fitChartFont ?? ((_width: number, _longest: number, scale: number) => 13 * scale);
const columnsFor = app.chartColumns ?? ((width: number, size: number) => Math.floor((width - 1) / advance(size)));
const filled = (line: string | undefined, column: number) => line !== undefined && column < line.length && line[column] !== " ";

/** Lays the pieces back over the source columns: each must match both lines at one offset, in order, covering every character. */
function aligned(chords: string, lyrics: string | undefined, pieces: { chords: string; lyrics?: string }[]) {
  const width = Math.max(chords.length, lyrics?.length ?? 0);
  const covered = new Set<number>();
  const starts: number[] = [];
  let from = 0;
  for (const piece of pieces) {
    while (from < width && !filled(chords, from) && !filled(lyrics, from)) from += 1;
    starts.push(from);
    const span = Math.max(piece.chords.length, piece.lyrics?.length ?? 0);
    const same = (line: string | undefined, part: string | undefined) =>
      (line === undefined) === (part === undefined) && (line ?? "").slice(from, from + span).trimEnd() === (part ?? "").trimEnd();
    if (!same(chords, piece.chords) || !same(lyrics, piece.lyrics)) return { ok: false, starts };
    for (let column = from; column < from + span; column += 1) covered.add(column);
    from += span;
  }
  for (let column = 0; column < width; column += 1) {
    if ((filled(chords, column) || filled(lyrics, column)) && !covered.has(column)) return { ok: false, starts };
  }
  return { ok: true, starts };
}

const splits = (line: string | undefined, column: number) => filled(line, column - 1) && filled(line, column);
let rows = 0;
let wrapped = 0;
let wordSplits = 0;
for (const song of seed.songs) {
  const views = [
    ...Array.from({ length: 12 }, (_, semitones) => ({ semitones: semitones - 5, notation: "notes" as const })),
    { semitones: 0, notation: "nashville" as const },
  ];
  for (const { semitones, notation } of views) {
    const lines = song.body.flatMap((section) => section.lines);
    const shown = (text: string) => app.displayChordLine(text, song as Song, semitones, notation);
    const longest = Math.max(1, ...lines.flatMap((line) => [line.chords ? shown(line.chords).length : 0, line.chords && line.lyrics ? line.lyrics.length : 0, line.bars ? shown(line.bars).length : 0]));
    for (const window of [320, 390, 768]) {
      for (const scale of app.TEXT_SCALES) {
        const width = chartWidth(window);
        const size = font(width, longest, scale, advance);
        const columns = columnsFor(width, size, advance);
        const where = `${song.title} ${notation} ${semitones >= 0 ? "+" : ""}${semitones} @${window}px x${scale}`;
        for (const [chords, lyrics] of lines.flatMap((line) => [
          ...(line.chords !== undefined ? [[shown(line.chords), line.lyrics] as const] : []),
          ...(line.bars !== undefined ? [[shown(line.bars), undefined] as const] : []),
        ])) {
          rows += 1;
          const pieces = wrap(chords, lyrics, columns);
          const widest = Math.max(...pieces.map((piece) => Math.max(piece.chords.length, piece.lyrics?.length ?? 0)));
          check(widest * advance(size) <= width, `a row never paints past the chart: ${where} (${widest} columns of ${columns}: "${chords.trim().slice(0, 24)}")`);
          if (Math.max(chords.length, lyrics?.length ?? 0) <= columns) {
            check(pieces.length === 1 && pieces[0].chords === chords && pieces[0].lyrics === lyrics, `a row that fits stays exactly as it was: ${where}`);
            continue;
          }
          wrapped += 1;
          const { ok, starts } = aligned(chords, lyrics, pieces);
          check(ok, `wrapped chords stay over the same lyric columns: ${where} ("${chords.trim().slice(0, 24)}")`);
          for (let k = 1; k < starts.length; k += 1) {
            const cut = starts[k];
            check(!splits(chords, cut), `a wrap never cuts a chord name: ${where} (column ${cut})`);
            if (!splits(lyrics, cut)) continue;
            wordSplits += 1;
            const reach = Array.from({ length: columns }, (_, i) => starts[k - 1] + 1 + i);
            check(!reach.some((c) => !splits(chords, c) && !splits(lyrics, c)), `a wrap breaks at a lyric space when one is in reach: ${where} (column ${cut})`);
          }
        }
      }
    }
  }
}
console.log(`wrap: ${rows} chord rows across 15 songs x 13 notations x 3 widths x ${app.TEXT_SCALES.length} scales, ${wrapped} wrapped, ${wordSplits} lyric words split for want of a space`);

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

/** #sheet-scroll and #chord-section as the browser lays them out: the chart sits `chartTop` into the page. */
class Page {
  clientHeight = 700;
  chartTop = 1200;
  chartHeight = 2600;
  after = 400;
  top = 0;
  listeners: { type: string; run: (event: { stopImmediatePropagation(): void }) => void }[] = [];
  get scrollHeight() {
    return this.chartTop + this.chartHeight + this.after;
  }
  get scrollTop() {
    return this.top;
  }
  set scrollTop(value: number) {
    this.top = Math.min(this.scrollHeight - this.clientHeight, Math.max(0, value));
    this.fire("scroll");
  }
  getBoundingClientRect() {
    return { top: 0 };
  }
  chart = () => ({ getBoundingClientRect: () => ({ top: this.chartTop - this.top }), offsetHeight: this.chartHeight });
  addEventListener(type: string, run: (event: { stopImmediatePropagation(): void }) => void) {
    this.listeners.push({ type, run });
  }
  removeEventListener(type: string, run: unknown) {
    this.listeners = this.listeners.filter((item) => item.type !== type || item.run !== run);
  }
  fire(type: string) {
    let stopped = false;
    const event = { stopImmediatePropagation: () => void (stopped = true) };
    for (const item of [...this.listeners]) if (item.type === type && !stopped) item.run(event);
  }
  /** A text size or window change: the browser re-lays out and clamps the scroll before the next frame. */
  relayout(change: Partial<Pick<Page, "chartTop" | "chartHeight" | "clientHeight">>) {
    Object.assign(this, change);
    const max = this.scrollHeight - this.clientHeight;
    if (this.top > max) this.scrollTop = max;
  }
  get progress() {
    return (this.top - this.chartTop) / (this.chartHeight - this.clientHeight);
  }
}

/** The base hook, for a run on a tree without `scrollChart`. */
const drive =
  app.scrollChart ??
  ((el: Page, chart: Page["chart"], motion: { current: Motion }, clock: { current: number }, onStop: (reason: "user" | "end") => void) =>
    app.runScroll(el, motion, (): Section => {
      const found = chart();
      const start = found.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      return { start, end: start + found.offsetHeight - el.clientHeight };
    }, clock, onStop));
check(app.scrollChart !== undefined, "useAutoScroll runs through scrollChart, which tells a re-layout from the player scrolling");

function scroll(motion: Motion, at = 0) {
  const page = new Page();
  page.top = at;
  const ref = { current: motion };
  const stops: { reason: string; at: number }[] = [];
  const startedAt = now / 1000;
  const cancel = (drive as (...args: unknown[]) => () => void)(page, page.chart, ref, { current: 0 }, (reason: string) => {
    stops.push({ reason, at: now / 1000 - startedAt });
    cancel();
  });
  return { page, ref, stops, elapsed: () => now / 1000 - startedAt };
}

/** Seconds until the chart first moves off its top, after Scroll On lands there. */
function holdOf(run: ReturnType<typeof scroll>) {
  play(0.02);
  const landed = near(run.page.top, run.page.chartTop, 0.5);
  while (run.stops.length === 0 && run.page.progress < 1e-6 && run.elapsed() < 5) play(1 / 60);
  return { landed, held: run.elapsed() - 1 / 60 };
}

const chain = { ...(seed.songs.find((song) => song.id === 10) as Song) };
check(chain.officialRuntimeSec === 197 && chain.tempo === 78, "Chain Breaker is 197 s at 78 BPM");
const timing: string[] = [];
for (const [bpm, percent] of [[78, 100], [117, 100], [78, 50], [78, 150]]) {
  const rate = (bpm / 78) * (percent / 100);
  const run = scroll(app.scrollMotion(chain, null, null, bpm, percent));
  const { landed, held } = holdOf(run);
  check(landed, `Scroll On still jumps to the top of the chord section at ${bpm} BPM ${percent}%`);
  check(near(held, 2 / rate, 0.04), `the chart holds still for 2 s of song time before moving at ${bpm} BPM ${percent}% (${held.toFixed(2)} s, want ${(2 / rate).toFixed(2)})`);
  play(197 / rate + 2);
  const end = run.stops[0];
  check(end?.reason === "end" && near(end.at, 197 / rate, 0.05), `the chord section still ends at runtime / rate at ${bpm} BPM ${percent}% (${end?.at.toFixed(2)} s, want ${(197 / rate).toFixed(2)})`);
  timing.push(`${bpm} BPM ${percent}%: hold ${held.toFixed(2)} s, end ${end?.at.toFixed(2)} s (want ${(197 / rate).toFixed(2)})`);
}
console.log(`hold: ${timing.join("; ")}`);

for (const [name, change, at] of [
  ["A+ (chart grows)", { chartHeight: 4200, chartTop: 1500 }, 0.4],
  ["A- (chart shrinks, scroll clamped)", { chartHeight: 1300, chartTop: 600 }, 0.7],
  ["rotation (shorter view, narrower lines)", { clientHeight: 360, chartHeight: 1700, chartTop: 800 }, 0.85],
] as const) {
  const run = scroll(app.scrollMotion(chain, null, null, 78, 100));
  play(197 * at);
  const before = run.page.progress;
  run.page.relayout(change);
  check(run.stops.length === 0, `${name} mid-scroll does not stop the scroll`);
  play(1 / 60);
  const after = run.page.progress;
  check(after >= before - 1e-4 && after - before < 0.002, `${name} keeps the same progress, with no jump back or skip (${before.toFixed(4)} then ${after.toFixed(4)})`);
  play(197);
  check(run.stops[0]?.reason === "end" && near(run.stops[0].at, 197, 0.05), `${name} still ends at the 197 s runtime (${run.stops[0]?.reason} at ${run.stops[0]?.at.toFixed(2)} s)`);
  check(near(run.page.top, run.page.chartTop + run.page.chartHeight - run.page.clientHeight, 1), `${name} ends with the last chord line at the bottom of the view`);
}

{
  const run = scroll(app.scrollMotion(chain, null, null, 78, 100));
  play(20);
  run.page.scrollTop = run.page.top - 300;
  check(run.stops[0]?.reason === "user", "a manual scroll with no layout change still pauses");
}
{
  const page = new Page();
  const run = scroll(app.scrollMotion(chain, null, null, 78, 100), page.chartTop + (page.chartHeight - page.clientHeight) / 2);
  const start = run.page.top;
  play(0.5);
  check(run.page.top > start + 2, "resuming mid-sheet moves on at once, with no second hold");
}
{
  const even = app.evenPlan(chain)!;
  const take = app.startTake(even, 78);
  const run = scroll(app.scrollMotion(chain, null, take, 78, 100));
  play(0.5);
  check(run.page.progress > 0, "a live teach take moves at once, so its marks match what the player saw");
}
{
  const version = { name: "V1", bpm: 78, marks: [{ at: 0, progress: 0 }, { at: 30, progress: 0.4 }, { at: 40, progress: 0.4 }, { at: 120, progress: 1 }] };
  const run = scroll(app.scrollMotion(chain, version, null, 78, 100));
  const { held } = holdOf(run);
  check(held < 0.05, `a taught version keeps its own timing, with no extra hold at the top (${held.toFixed(2)} s)`);
  play(30 - run.elapsed() + 0.5);
  const stop = run.page.top;
  play(9);
  check(near(run.page.top, stop, 0.01), "a taught version still holds exactly where it was taught to");
  play(130);
  check(run.stops[0]?.reason === "end" && near(run.stops[0].at, 120, 0.05), `a taught version still ends when it was taught to (${run.stops[0]?.at.toFixed(2)} s)`);
}

if (failures) {
  console.error(`${failures} fit check(s) failed`);
  process.exit(1);
}
console.log("fit ok: no page zoom, rows wrap with chords over their syllables at every width and scale, the scroll re-measures through text size and window changes, 2 s hold at the top inside the runtime");
