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
  /** One per chart section, in order. The first starts at the first note. */
  sections: { heading: string; at: number }[];
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

/** What the scroll loop follows. Songs without a runtime and tempo keep the fixed page speed. */
export type Motion =
  | { kind: "pace"; pxPerSec: number }
  | {
      kind: "timed";
      progressAt: (clock: number) => number;
      startAt: (progress: number, slack: number) => number;
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
 */
export function runScroll(
  el: Scroller,
  motion: { current: Motion },
  section: () => Section | null,
  clock: { current: number },
  onStop: (reason: "user" | "end") => void,
): () => void {
  const limit = () => Math.max(0, el.scrollHeight - el.clientHeight);
  const range = (): Section => {
    const max = limit();
    const found = section() ?? { start: 0, end: max };
    const start = Math.min(max, Math.max(0, found.start));
    return { start, end: Math.min(max, Math.max(start, found.end)) };
  };

  // scrollTop is integer on some browsers, and 78 BPM is only ~19px/s,
  // so a per-frame bump of a fraction of a pixel would be rounded away.
  let position = el.scrollTop;
  const initial = motion.current;
  if (initial.kind === "timed") {
    const { start, end } = range();
    const progress = end > start ? (position - start) / (end - start) : 0;
    clock.current = progress < 0 || position >= end - 2 ? 0 : initial.startAt(progress, 2 / (end - start));
  } else if (position >= limit() - 2) {
    position = 0;
    el.scrollTop = 0;
  }
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
    if (current.kind === "timed") {
      clock.current += dt * current.rate;
      const progress = current.progressAt(clock.current);
      const { start, end } = range();
      place(start + (end - start) * progress);
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
