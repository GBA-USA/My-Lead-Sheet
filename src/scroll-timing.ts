import { scrollPixelsPerSecond } from "./music";
import type { Song } from "./types";

/** `at` seconds into the song (at the plan's BPM), the chord section is `progress` (0 to 1) of the way through. */
export interface Mark {
  at: number;
  progress: number;
}

/** How the chord section moves: straight lines between marks, so two marks at one progress are a hold. */
export interface ScrollPlan {
  bpm: number;
  marks: Mark[];
}

export interface Span {
  start: number;
  end: number;
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
  sections: { heading: string; at: number; heard?: (string | null)[] }[];
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
}

/** How far below the top of the sheet a learned section's heading sits as its music starts: about two lines. */
export const READING_LINE = 40;

/** What the scroll loop follows. Songs without a runtime and tempo keep the fixed page speed. */
export type Motion =
  | { kind: "pace"; pxPerSec: number }
  | {
      kind: "timed";
      progressAt: (clock: number) => number;
      startAt: (progress: number, slack: number) => number;
      rate: number;
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
  return { bpm, slope: bpm / even.bpm / runtime, marks: [{ at: 0, progress: 0 }], holding: false };
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
  return { bpm: take.bpm, marks: [...take.marks, { at, progress: 1 }] };
}

/**
 * A take while teaching, else the chosen version, else the even pace, else the old fixed page speed.
 * `bpm` is the metronome's current speed; null leaves the plan at its own BPM.
 */
export function scrollMotion(song: Song, version: ScrollVersion | null, take: Take | null, bpm: number | null, percent: number): Motion {
  if (take) {
    const rate = clockRate(take.bpm, bpm ?? take.bpm, percent);
    return { kind: "timed", rate, progressAt: (at) => takeProgress(take, at), startAt: () => 0 };
  }
  const plan = version ?? evenPlan(song);
  if (!plan) return { kind: "pace", pxPerSec: scrollPixelsPerSecond(song.tempo, percent) };
  const rate = clockRate(plan.bpm, bpm ?? plan.bpm, percent);
  if (version?.learned) {
    const end = plan.marks[plan.marks.length - 1].at;
    return { kind: "learned", rate, arrivals: [...version.learned.sections.map((section) => section.at), end] };
  }
  return { kind: "timed", rate, progressAt: (at) => progressAt(plan.marks, at), startAt: (progress, slack) => timeAt(plan.marks, progress, slack) };
}

/** V1, V2, V3 … skipping a name already taken by a rename. */
export function nextVersionName(versions: ScrollVersion[]): string {
  const names = new Set(versions.map((version) => version.name));
  let n = versions.length + 1;
  while (names.has(`V${n}`)) n += 1;
  return `V${n}`;
}

export interface Section {
  start: number;
  end: number;
  /** The scroll positions that put each heading, then the chart's end, on the reading line. */
  lines?: () => number[];
}

/** Where a timed motion goes in the sheet as laid out this frame. */
interface Track extends Section {
  progressAt: (clock: number) => number;
  startAt: (progress: number, slack: number) => number;
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
 * The timed clock is written to `clock` for teach taps.
 * The even pace started from the top of the chord section holds there for its first 2 seconds, so the first chords
 * can be read, and plays the rest a touch faster to still end on time. A taught version keeps its own timing, and
 * a resume or a live take does not hold.
 */
export function runScroll(
  el: Scroller,
  motion: { current: Motion },
  section: () => Section | null,
  clock: { current: number },
  onStop: (reason: "user" | "end") => void,
): () => void {
  const limit = () => Math.max(0, el.scrollHeight - el.clientHeight);
  const track = (current: Exclude<Motion, { kind: "pace" }>): Track => {
    const max = limit();
    const clamp = (at: number) => Math.min(max, Math.max(0, at));
    const found = section() ?? { start: 0, end: max };
    if (current.kind === "learned") return learnedTrack(current.arrivals, (found.lines?.() ?? [found.start, found.end]).map(clamp));
    const start = clamp(found.start);
    return { start, end: Math.max(start, clamp(found.end)), progressAt: current.progressAt, startAt: current.startAt };
  };

  // scrollTop is integer on some browsers, and 78 BPM is only ~19px/s,
  // so a per-frame bump of a fraction of a pixel would be rounded away.
  let position = el.scrollTop;
  const initial = motion.current;
  const first = initial.kind === "pace" ? null : track(initial);
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
    initial.kind === "timed" && length > 2 && [0.25, 0.5, 0.75].every((f) => Math.abs(initial.progressAt(length * f) - f) < 1e-6);
  const hold = even && clock.current === 0 ? 2 : 0;
  const planTime = (at: number) => (hold ? (Math.max(0, at - hold) * length) / (length - hold) : at);
  let expected = position;
  let armed = false;
  let frame = 0;
  let last = performance.now();

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

  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const current = motion.current;
    if (current.kind !== "pace") {
      clock.current += dt * current.rate;
      const path = track(current);
      const progress = path.progressAt(planTime(clock.current));
      place(path.start + (path.end - path.start) * progress);
      if (progress >= 1) return onStop("end");
    } else {
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
