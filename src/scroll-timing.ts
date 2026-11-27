import type { Band } from "./learn-result";
import { scrollPixelsPerSecond } from "./music";
import type { ChartLine, ChartSection, Song } from "./types";

/** `at` seconds into the song (at the plan's BPM), the chord section is `progress` (0 to 1) of the way through. */
export interface Mark {
  at: number;
  progress: number;
}

/** From `at` seconds on a plan's clock, the song plays at `bpm`. */
export interface Tempo {
  at: number;
  bpm: number;
}

/**
 * How the chord section moves: straight lines between marks, so two marks at one progress are a hold.
 * The clock's seconds are at `bpm`. `tempo`, when present, starts at 0 and is what the metronome plays from each spot.
 */
export interface ScrollPlan {
  bpm: number;
  marks: Mark[];
  tempo?: Tempo[];
}

export interface Span {
  start: number;
  end: number;
}

/** One kept heard chord: null for not sure, in the band it was heard in, or "set" by the player with the chord heard in `was`. */
export interface HeardCell {
  chord: string | null;
  band: Band | "set";
  was?: string | null;
}

/**
 * What Learn this song heard, in seconds on the version's clock. The clock's first bar is the count-in,
 * so `downbeat` (bar 1) is one bar of the opening tempo after 0.
 */
export interface Learned {
  beatsPerBar: number;
  downbeat: number;
  beats: number[];
  /** One per chart section, in order. The first starts at the first note. `heard` is the bars the player kept. */
  sections: { heading: string; at: number; heard?: HeardCell[] }[];
  /** Each time a section starts, by its index in `sections`, in play order, for a recording that repeats a section the chart lists once. */
  plays?: { section: number; at: number }[];
  /** When each lyric line starts: its section's index, and its index among that section's chart lines. */
  lines?: { section: number; line: number; at: number }[];
  /** Seconds into the recording at 0 on the version's clock. */
  offset?: number;
  /** Vocal regions the player kept from the suggestions. */
  vocals: Span[];
}

export interface ScrollVersion extends ScrollPlan {
  name: string;
  learned?: Learned;
}

/** Teach mode: the even pace, stopped while held, with a mark at every Hold and Continue tap. */
export interface Take {
  bpm: number;
  /** Progress per second of the take's clock while moving. */
  slope: number;
  marks: Mark[];
  holding: boolean;
  tempo: Tempo[];
}

/** How far below the top of the sheet a learned section's heading sits as its music starts: about two lines. */
export const READING_LINE = 40;

/** Where the song's own pace holds the line being sung, as a share of the sheet's height: the middle. */
export const SUNG_READING = 0.5;

/** A chart line's place in the song, in seconds at the song's BPM, and the chords its rows show, to find them on the sheet. */
interface SungLine {
  at: number;
  length: number;
  pairChords?: number;
  lyricOnly: boolean;
  barChords?: number;
  note: boolean;
}

interface SungSection {
  at: number;
  length: number;
  lines: SungLine[];
}

/** The pace the song itself sets, from its BPM, time signature and bars. `rate` runs its clock like a plan's. */
export interface Sung {
  sections: SungSection[];
  rate: number;
}

/**
 * What the scroll loop follows. `sung`, when the sheet's rows can be measured, wins over the even plan or page speed
 * it rides on: those remain for a song without a BPM, and for a sheet with no chart rows to measure.
 */
export type Motion =
  | { kind: "pace"; pxPerSec: number; sung?: Sung }
  | {
      kind: "timed";
      progressAt: (clock: number) => number;
      startAt: (progress: number, slack: number) => number;
      rate: number;
      /** False when the clock itself is meaningful, as with a live take or a tempo map, so `runScroll` never re-times it. */
      holdOpening: boolean;
      sung?: Sung;
      /** A Learn take: its clock is the player's own playing, so the live speed leaves it alone. */
      take?: true;
    }
  | {
      /** Each heading reaches the reading line as its section starts, and the chart's end as the song ends. */
      kind: "learned";
      /** When each section starts, then when the song ends. */
      arrivals: number[];
      rate: number;
    };

/** Top to bottom of the chord section over the song's official length, at its preset BPM. */
export function evenPlan(song: Song): ScrollPlan | null {
  const { officialRuntimeSec: runtime, tempo } = song;
  if (runtime == null || runtime <= 0 || tempo == null || tempo <= 0) return null;
  return { bpm: tempo, marks: [{ at: 0, progress: 0 }, { at: runtime, progress: 1 }] };
}

const CHORD = /[^\s|]+/g;

/** The chord symbols in a chord or bar line, as written or as the sheet shows them: transposing keeps the count. */
export function chordCount(text: string): number {
  return text.match(CHORD)?.length ?? 0;
}

/**
 * "| A | E | F#m  D | A |" is 4 bars; a bar line with no bar marks is a bar per chord. A cell that opens with "(" is a
 * direction, not a bar: "| F#m | D2 | A5 | (x3) then | Esus |" plays the three bars before its "(x3)" three times.
 */
function barCount(text: string): number {
  if (!text.includes("|")) return chordCount(text);
  let counted = 0;
  let run = 0;
  for (const cell of text.split("|").map((each) => each.trim()).filter(Boolean)) {
    if (cell.startsWith("(")) {
      counted += run * plays(cell);
      run = 0;
    } else run += 1;
  }
  return counted + run;
}

/**
 * The beats in a bar: a leading "N/M" that stands for the whole song, alone or before an aside as "3/4 — waltz".
 * "7/4 on the verse riff" names one part of the song, so its bars count 4 like a song with no time signature.
 */
function beatsPerBar(timeSignature: string): number {
  const meter = timeSignature.match(/^\s*(\d+)\s*\/\s*\d+\s*(?:$|[—–(,;:-])/);
  return Number(meter?.[1]) || 4;
}

/** A sung line lasts the 1, 2 or 4 bars nearest this long: 4 bars of 3/4 at 116, 2 bars of 4/4 at 102. */
const PHRASE_SECONDS = 6;

/**
 * A bar line is its bars and a note the bars it writes out, both counted. A sung line is guessed: its phrase, or two
 * chords a bar if longer.
 */
function lineBars(line: ChartLine, phrase: number): { bars: number; guessed: boolean } {
  if (line.bars !== undefined) return { bars: barCount(line.bars), guessed: false };
  if (line.chords !== undefined || line.lyrics !== undefined) return { bars: Math.max(phrase, Math.ceil(chordCount(line.chords ?? "") / 2)), guessed: true };
  const written = line.note?.match(/\|.*\|/)?.[0];
  return { bars: written ? barCount(written) : 0, guessed: false };
}

const PLAYS: [RegExp, number][] = [
  [/\btwice\b/i, 2],
  [/\bthree times\b/i, 3],
  [/\bfour times\b/i, 4],
];

/** How many times a section is played: "repeat twice", "three times", "(x2)". */
function plays(heading: string): number {
  const times = heading.match(/\bx\s?(\d)\b|\b(\d)x\b/i);
  if (times) return Number(times[1] ?? times[2]);
  return PLAYS.find(([words]) => words.test(heading))?.[1] ?? 1;
}

/**
 * When each chart line plays, from bars × beats per bar × 60 / BPM summed in play order, so a late section does not
 * drift. A section played twice gives each of its lines twice the time. A section that writes no sung line and says
 * it repeats, as "CHORUS — repeat" over "| Fmaj7 | C | G | (chorus chords, full chorus)", or counts no bars at all,
 * lasts as long as the section it plays again times its plays. Null without a BPM.
 * When that runs past the song's recording, the sung lines it guessed shrink, all by one share, so the song ends with
 * its recording; the bars it counted keep their length. A song that ends within its recording keeps its guess.
 */
export function songPace(song: Song): { bpm: number; sections: SungSection[] } | null {
  const { tempo, officialRuntimeSec: recorded } = song;
  if (tempo == null || tempo <= 0) return null;
  const bar = (beatsPerBar(song.timeSignature) * 60) / tempo;
  const phrase = [1, 2, 4].reduce((best, n) => (Math.abs(n * bar - PHRASE_SECONDS) < Math.abs(best * bar - PHRASE_SECONDS) ? n : best));
  const ends = (sections: SungSection[]) => sections.reduce((end, section) => end + section.length, 0);
  const guessed = placeLines(song, bar, phrase, 1);
  const total = ends(guessed);
  if (recorded == null || total <= recorded) return { bpm: tempo, sections: guessed };
  // Every length is the counted bars plus the guess times its share, so the share that ends on the recording is exact.
  const counted = ends(placeLines(song, bar, phrase, 0));
  return { bpm: tempo, sections: counted < recorded ? placeLines(song, bar, phrase, (recorded - counted) / (total - counted)) : guessed };
}

/** A section already placed: what later headings and notes call it, and how long it plays once. */
interface Heard {
  name: string[];
  once: number;
}

const words = (text: string) => text.toUpperCase().match(/[\w-]+/g) ?? [];

const REPEAT = /\b(?:repeat|again)\b/i;

/**
 * The section a stand-in plays again: the last under its heading's first word, else the last its words name, as
 * "FINAL CHORUS" with the note "Chorus 1 again".
 */
function repeated(section: ChartSection, name: string[], heard: Heard[]): Heard | undefined {
  const said = words([section.heading, ...section.lines.flatMap((line) => [line.bars ?? "", line.note ?? ""])].join(" "));
  const names = (each: Heard) => each.name.length > 0 && said.some((_, i) => each.name.every((word, j) => said[i + j] === word));
  return heard.filter((each) => each.name[0] === name[0]).at(-1) ?? heard.filter(names).at(-1);
}

/**
 * Each chart line's place in play order, with the guessed sung lines at `share` of their guess. A stand-in's own
 * lines share its time by their bars, so its bar line holds on the sheet while the band plays the repeat.
 */
function placeLines(song: Song, bar: number, phrase: number, share: number): SungSection[] {
  const heard: Heard[] = [];
  let at = 0;
  return song.body.map((section) => {
    const times = plays(section.heading);
    const name = words(section.heading.split(/\s[(—–]/)[0]);
    const own = section.lines.map((line) => {
      const { bars, guessed } = lineBars(line, phrase);
      return bars * (guessed ? share : 1) * bar * times;
    });
    const counted = own.reduce((sum, each) => sum + each, 0);
    const sung = section.lines.some((line) => line.chords !== undefined || line.lyrics !== undefined);
    const again = !sung && (counted === 0 || REPEAT.test(section.heading)) ? repeated(section, name, heard) : undefined;
    const stretch = again && counted > 0 ? (again.once * times) / counted : 1;
    const start = at;
    const lines = section.lines.map((line, i) => {
      const placed = {
        at,
        length: own[i] * stretch,
        ...(line.chords !== undefined ? { pairChords: chordCount(line.chords) } : {}),
        lyricOnly: line.chords === undefined && line.lyrics !== undefined,
        ...(line.bars !== undefined ? { barChords: chordCount(line.bars) } : {}),
        note: line.note !== undefined,
      };
      at += placed.length;
      return placed;
    });
    if (again) at = start + again.once * times;
    if (again || sung || counted > 0) heard.push({ name, once: (at - start) / times });
    return { at: start, length: at - start, lines };
  });
}

/** How fast a plan's clock runs: faster with the metronome, slower or faster with the scroll percent. */
export function clockRate(planBpm: number, bpm: number, percent: number): number {
  return (bpm / planBpm) * (percent / 100);
}

export function progressAt(marks: Mark[], at: number): number {
  if (at <= marks[0].at) return marks[0].progress;
  for (let i = 1; i < marks.length; i += 1) {
    const from = marks[i - 1];
    const to = marks[i];
    if (at < to.at) return from.progress + ((to.progress - from.progress) * (at - from.at)) / (to.at - from.at);
  }
  return marks[marks.length - 1].progress;
}

/**
 * Where to resume: the top restarts the song, and a held spot resumes at the end of its hold.
 * Within `slack` of a mark counts as on it, since the browser rounds scrollTop.
 */
export function timeAt(marks: Mark[], progress: number, slack = 0): number {
  if (progress <= slack) return 0;
  for (let i = marks.length - 1; i > 0; i -= 1) {
    const from = marks[i - 1];
    const to = marks[i];
    if (progress >= to.progress - slack) return to.at;
    if (progress > from.progress) return from.at + ((to.at - from.at) * (progress - from.progress)) / (to.progress - from.progress);
  }
  return marks[0].at;
}

export function startTake(even: ScrollPlan, bpm: number): Take {
  const runtime = even.marks[even.marks.length - 1].at;
  return { bpm, slope: bpm / even.bpm / runtime, marks: [{ at: 0, progress: 0 }], holding: false, tempo: [{ at: 0, bpm }] };
}

export function takeProgress(take: Take, at: number): number {
  const last = take.marks[take.marks.length - 1];
  if (take.holding) return last.progress;
  return Math.min(1, last.progress + take.slope * Math.max(0, at - last.at));
}

export function toggleHold(take: Take, at: number): Take {
  const mark = { at, progress: takeProgress(take, at) };
  return { ...take, marks: [...take.marks, mark], holding: !take.holding };
}

export function finishTake(take: Take, at: number): ScrollPlan {
  return withTempo({ bpm: take.bpm, marks: [...take.marks, { at, progress: 1 }] }, take.tempo);
}

/** Metronome taps within this many seconds of the last change, like a run of + taps, are one change. */
const SAME_CHANGE = 2;

/** The metronome moved to `bpm` at `at` on the take's clock. */
export function changeTempo(take: Take, at: number, bpm: number): Take {
  const last = take.tempo[take.tempo.length - 1];
  if (bpm === last.bpm) return take;
  const tempo = at - last.at < SAME_CHANGE ? [...take.tempo.slice(0, -1), { at: last.at, bpm }] : [...take.tempo, { at, bpm }];
  return { ...take, tempo };
}

/** `plan` with `tempo` as its map, leaving repeats out, and no map at all when the song stays at the plan's BPM. */
export function withTempo<P extends ScrollPlan>(plan: P, tempo: Tempo[]): P {
  const map = tempo.filter((change, i) => i === 0 || change.bpm !== tempo[i - 1].bpm);
  const { tempo: _old, ...rest } = plan;
  return (map.length === 1 && map[0].bpm === plan.bpm ? rest : { ...rest, tempo: map }) as P;
}

export function tempoAt(tempo: Tempo[], at: number): Tempo {
  return tempo.filter((change) => change.at <= at).at(-1) ?? tempo[0];
}

/** Seconds into the song as heard at 100%, for a spot on the plan's clock. */
export function heardAt(tempo: Tempo[], planBpm: number, at: number): number {
  return tempo.reduce((heard, change, i) => {
    const end = Math.min(at, tempo[i + 1]?.at ?? Infinity);
    return end > change.at ? heard + ((end - change.at) * planBpm) / change.bpm : heard;
  }, 0);
}

/** The spot on the plan's clock heard `heard` seconds into the song at 100%. */
export function clockAt(tempo: Tempo[], planBpm: number, heard: number): number {
  const change = tempo.filter((each) => heardAt(tempo, planBpm, each.at) <= heard).at(-1) ?? tempo[0];
  return change.at + ((heard - heardAt(tempo, planBpm, change.at)) * change.bpm) / planBpm;
}

/**
 * A take while teaching, else the chosen version (taught, learned or the band's), else the song's own pace, riding on
 * the even pace or the old fixed page speed. `bpm` is the metronome's current speed; null leaves the plan at its own BPM.
 */
export function scrollMotion(song: Song, version: ScrollVersion | null, take: Take | null, bpm: number | null, percent: number): Motion {
  if (take) {
    const rate = clockRate(take.bpm, bpm ?? take.bpm, percent);
    return { kind: "timed", rate, progressAt: (at) => takeProgress(take, at), startAt: () => 0, holdOpening: false, take: true };
  }
  const pace = version ? null : songPace(song);
  const sung = pace ? { sung: { sections: pace.sections, rate: clockRate(pace.bpm, bpm ?? pace.bpm, percent) } } : {};
  const plan = version ?? evenPlan(song);
  if (!plan) return { kind: "pace", pxPerSec: scrollPixelsPerSecond(song.tempo, percent), ...sung };
  const rate = clockRate(plan.bpm, bpm ?? plan.bpm, percent);
  if (version?.learned) {
    const end = plan.marks[plan.marks.length - 1].at;
    return { kind: "learned", rate, arrivals: [...version.learned.sections.map((section) => section.at), end] };
  }
  return {
    kind: "timed",
    rate,
    progressAt: (at) => progressAt(plan.marks, at),
    startAt: (progress, slack) => timeAt(plan.marks, progress, slack),
    holdOpening: !plan.tempo,
    ...sung,
  };
}

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 1.5;
const STEPS_PER_UNIT = 20;

/** One tap of the live − or +: 5% of the song's pace, kept between 50% and 150%, on exact twentieths so taps undo. */
export function stepSpeed(speed: number, step: 1 | -1): number {
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, (Math.round(speed * STEPS_PER_UNIT) + step) / STEPS_PER_UNIT));
}

/**
 * `motion` at `speed` times its pace. The scroll's clock adds up the rate frame by frame, so a change never jumps the
 * sheet. A take keeps its own clock, so the marks it records are on the song's time.
 */
export function atSpeed(motion: Motion, speed: number): Motion {
  if (speed === 1 || (motion.kind === "timed" && motion.take)) return motion;
  if (motion.kind === "learned") return { ...motion, rate: motion.rate * speed };
  const sung = motion.sung ? { sung: { ...motion.sung, rate: motion.sung.rate * speed } } : {};
  if (motion.kind === "pace") return { ...motion, pxPerSec: motion.pxPerSec * speed, ...sung };
  return { ...motion, rate: motion.rate * speed, ...sung };
}

/** V1, V2, V3 … skipping a name already taken by a rename. */
export function nextVersionName(versions: { name: string }[]): string {
  const names = new Set(versions.map((version) => version.name));
  let n = versions.length + 1;
  while (names.has(`V${n}`)) n += 1;
  return `V${n}`;
}

interface Box {
  top: number;
  height: number;
}

/** A row the sheet draws (a `.pair`, `.bars`, `.lyric-only` or `.chart-note`), in px down the scroller, with its chord count. */
export interface LaidRow extends Box {
  kind: string;
  chords: number;
}

/** A chart section as laid out: its heading, then its rows in order. */
export interface LaidSection {
  heading: Box;
  rows: LaidRow[];
}

export interface Section {
  start: number;
  end: number;
  /** The scroll positions that put each heading, then the chart's end, on the reading line. */
  lines?: () => number[];
  /** The chart's sections as laid out this frame, for the song's own pace. */
  laid?: () => LaidSection[];
}

/** Where a timed motion goes in the sheet as laid out this frame, and how fast its clock runs. */
interface Track extends Section {
  progressAt: (clock: number) => number;
  startAt: (progress: number, slack: number) => number;
}

interface Path extends Track {
  rate: number;
  sung?: true;
}

/**
 * Finds each line's rows the way the sheet draws a line: chord rows until they hold the line's chords (and any
 * lyric-only tail of its wrap), a lyric-only row, bar rows likewise, then its note. Null for a line the sheet hides,
 * as lyrics in Chords only.
 */
function lineBoxes(lines: SungLine[], rows: LaidRow[]): ({ top: number; bottom: number } | null)[] {
  let next = 0;
  const take = (kind: string, chords: number | undefined) => {
    if (chords === undefined) return;
    let seen = 0;
    while (rows[next]?.kind === kind && (seen < chords || rows[next].chords === 0)) seen += rows[next++].chords;
  };
  return lines.map((line) => {
    const from = next;
    take("pair", line.pairChords);
    if (line.lyricOnly && rows[next]?.kind === "lyric-only") next += 1;
    take("bars", line.barChords);
    if (line.note && rows[next]?.kind === "chart-note") next += 1;
    if (next === from) return null;
    const last = rows[next - 1];
    return { top: rows[from].top, bottom: last.top + last.height };
  });
}

/**
 * The chart y that should be on the reading line at each moment: a line's top as it starts the song, each line's
 * middle halfway through it, the last line's bottom as the song ends. A section with no line on the sheet, as a
 * "CHORUS — repeat" heading, holds on its heading for its time.
 */
function sungPoints(sections: SungSection[], laid: LaidSection[]): { at: number; y: number }[] {
  type Placed = { line: { at: number; length: number }; box: { top: number; bottom: number } };
  const placed = sections.flatMap((section, i): Placed[] => {
    const shown = laid[i];
    if (!shown) return [];
    const boxes = lineBoxes(section.lines, shown.rows);
    const lines = section.lines.flatMap((line, j): Placed[] => {
      const box = boxes[j];
      return box && line.length > 0 ? [{ line, box }] : [];
    });
    const heading = { top: shown.heading.top, bottom: shown.heading.top + shown.heading.height };
    return lines.length ? lines : section.length > 0 ? [{ line: section, box: heading }] : [];
  });
  if (placed.length === 0) return [];
  const first = placed[0];
  const last = placed[placed.length - 1];
  return [
    { at: 0, y: first.box.top },
    ...placed.map(({ line, box }) => ({ at: line.at + line.length / 2, y: (box.top + box.bottom) / 2 })),
    { at: last.line.at + last.line.length, y: last.box.bottom },
  ];
}

/**
 * The sheet puts each point's y on the reading line at its time, in straight lines between. A chart whose first line
 * starts above the reading line moves at once: its sung line starts where the chart puts it and eases down to the
 * reading line while the sheet moves at half the song's pace.
 */
function sungTrack(points: { at: number; y: number }[], reading: number, clamp: (at: number) => number): Track {
  const top = points[0].y;
  const line = (y: number) => (top < reading ? Math.min(reading, (top + y) / 2) : reading);
  const lines = points.map((point) => clamp(point.y - line(point.y)));
  const start = lines[0];
  const end = lines[lines.length - 1];
  const songEnd = points[points.length - 1].at;
  const marks = points.map((point, i) => ({ at: point.at, progress: end > start ? (lines[i] - start) / (end - start) : point.at / songEnd }));
  return { start, end, progressAt: (at) => progressAt(marks, at), startAt: (fraction, slack) => timeAt(marks, fraction, slack) };
}

/**
 * The sheet reaches each of `lines` at its arrival, in straight lines between. Sections and headings pair up in
 * order; when one list is longer, its extras are skipped, and the chart's end still comes with the song's end.
 */
function learnedTrack(arrivals: number[], lines: number[]): Track {
  const start = lines[0];
  const end = lines[lines.length - 1];
  const progress = (line: number) => (line - start) / (end - start || 1);
  const marks = [
    { at: 0, progress: 0 },
    ...arrivals.slice(0, Math.min(arrivals.length, lines.length) - 1).map((at, i) => ({ at, progress: progress(lines[i]) })),
    { at: arrivals[arrivals.length - 1], progress: 1 },
  ];
  return { start, end, progressAt: (at) => progressAt(marks, at), startAt: (fraction, slack) => timeAt(marks, fraction, slack) };
}

/** Milliseconds on the clock that drives a scroll or a click, for a `performance.now()` reading: band time in a gig. */
export type TimeSource = (perfMs: number) => number;

/** The solo clock: frame times, with a frame longer than 50 ms, as after a hidden tab, counted as 50 ms. */
function frameClock(): TimeSource {
  let last = performance.now();
  let total = 0;
  return (perfMs) => {
    total += Math.min(50, perfMs - last);
    last = perfMs;
    return total;
  };
}

interface Scroller {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * Drives `el` until `onStop`. Grabbing or a manual scroll stops with "user"; reaching the end stops with "end".
 * `motion` and `section` are read every frame, so a BPM, percent or text size change applies at once.
 * The timed clock is written to `clock` for teach taps. It moves with `time`, so in a gig every frame lands where
 * band time puts it however late the frame is.
 * The song's own pace holds the line being sung on the sheet's middle, so lines ahead are below it and lines just
 * played above; a chart that starts higher eases its sung line down to the middle. The even pace started from the
 * top of the chord section holds there for its first 2 seconds, so the first chords can be read, and plays the rest a
 * touch faster to still end on time. A taught version keeps its own timing, and a resume or a live take does not hold.
 * `onProgress` hears how far through its path each timed frame is.
 */
export function runScroll(
  el: Scroller,
  motion: { current: Motion },
  section: () => Section | null,
  clock: { current: number },
  onStop: (reason: "user" | "end") => void,
  time: TimeSource = frameClock(),
  onProgress?: (progress: number) => void,
): () => void {
  const limit = () => Math.max(0, el.scrollHeight - el.clientHeight);
  /** Null for the page speed. */
  const track = (current: Motion): Path | null => {
    const max = limit();
    const clamp = (at: number) => Math.min(max, Math.max(0, at));
    const found = section();
    const sung = current.kind === "learned" ? undefined : current.sung;
    const points = sung ? sungPoints(sung.sections, found?.laid?.() ?? []) : [];
    if (sung && points.length) return { ...sungTrack(points, el.clientHeight * SUNG_READING, clamp), rate: sung.rate, sung: true };
    if (current.kind === "pace") return null;
    const box = found ?? { start: 0, end: max };
    if (current.kind === "learned") return { ...learnedTrack(current.arrivals, (box.lines?.() ?? [box.start, box.end]).map(clamp)), rate: current.rate };
    const start = clamp(box.start);
    return { start, end: Math.max(start, clamp(box.end)), progressAt: current.progressAt, startAt: current.startAt, rate: current.rate };
  };

  // scrollTop is integer on some browsers, and 78 BPM is only ~19px/s,
  // so a per-frame bump of a fraction of a pixel would be rounded away.
  let position = el.scrollTop;
  const initial = motion.current;
  const first = track(initial);
  if (first) {
    const { start, end } = first;
    const progress = end > start ? (position - start) / (end - start) : 0;
    clock.current = progress < 0 || position >= end - 2 ? 0 : first.startAt(progress, 2 / (end - start));
  } else if (position >= limit() - 2) {
    position = 0;
    el.scrollTop = 0;
  }
  const length = first ? first.startAt(1, 0) : 0;
  const even =
    !first?.sung &&
    initial.kind === "timed" &&
    initial.holdOpening &&
    length > 2 &&
    [0.25, 0.5, 0.75].every((f) => Math.abs(initial.progressAt(length * f) - f) < 1e-6);
  const hold = even && clock.current === 0 ? 2 : 0;
  const planTime = (at: number) => (hold ? (Math.max(0, at - hold) * length) / (length - hold) : at);
  let expected = position;
  let armed = false;
  let frame = 0;
  let last = time(performance.now());

  const stop = () => onStop("user");
  const onScroll = () => {
    if (!armed) return;
    if (Math.abs(el.scrollTop - expected) < 2) return;
    stop();
  };

  el.addEventListener("pointerdown", stop);
  el.addEventListener("wheel", stop, { passive: true });
  el.addEventListener("scroll", onScroll, { passive: true });

  const place = (next: number) => {
    position = next;
    expected = next;
    el.scrollTop = next;
  };

  const tick = (frameMs: number) => {
    const now = time(frameMs);
    const dt = (now - last) / 1000;
    last = now;
    const current = motion.current;
    const path = track(current);
    if (path) {
      clock.current += dt * path.rate;
      const progress = path.progressAt(planTime(clock.current));
      place(path.start + (path.end - path.start) * progress);
      onProgress?.(progress);
      if (progress >= 1) return onStop("end");
    } else if (current.kind === "pace") {
      const max = limit();
      place(Math.min(max, position + current.pxPerSec * dt));
      if (position >= max - 0.5) {
        place(max);
        return onStop("end");
      }
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  armed = true;

  return () => {
    cancelAnimationFrame(frame);
    el.removeEventListener("pointerdown", stop);
    el.removeEventListener("wheel", stop);
    el.removeEventListener("scroll", onScroll);
  };
}
