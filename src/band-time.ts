export type BandMs = number & { readonly __clock: "band" };
export type LocalMs = number & { readonly __clock: "local" };

export type LinkRoute = "wifi" | "internet" | "relay" | "server";

export const PING_EVERY_MS: Record<LinkRoute, number> = { wifi: 2000, internet: 3000, relay: 3000, server: 5000 };
export const BURST = { pings: 16, everyMs: 100 };

const KEEP_SAMPLES = 32;
const FASTEST = 8;
const MARK_MS = 30_000;
const MARKS_KEPT_MS = 20 * 60_000;
const MIN_FIT_MS = 10_000;
const FULL_FIT_MS = 10 * 60_000;
const MAX_SLEW = 0.001;
const STEP_OVER_MS = 50;
const SPREAD_OK_MS = 8;
const OUT_OF_SYNC_AFTER_MS = 10_000;

export interface Line {
  at: LocalMs;
  offset: number;
  skew: number;
}

const lineOffset = (line: Line, local: LocalMs) => line.offset + line.skew * (local - line.at);
export const bandAt = (line: Line, local: LocalMs) => (local + lineOffset(line, local)) as BandMs;
export const localAt = (line: Line, band: BandMs) =>
  (line.at + (band - line.at - line.offset) / (1 + line.skew)) as LocalMs;

export interface Ping {
  t0: LocalMs;
  t1: LocalMs;
  band: BandMs;
}

interface Point {
  at: LocalMs;
  rtt: number;
  offset: number;
}

export interface Clock {
  points: Point[];
  marks: Point[];
  skew: number;
  skewSpan: number;
  spread: number;
  served: { from: Line; to: Line; since: LocalMs } | null;
  step: { at: LocalMs; to: Line } | null;
  spreadHighSince: LocalMs | null;
}

export const newClock = (): Clock => ({
  points: [],
  marks: [],
  skew: 0,
  skewSpan: 0,
  spread: Infinity,
  served: null,
  step: null,
  spreadHighSince: null,
});

function servedOffset(served: NonNullable<Clock["served"]>, local: LocalMs) {
  const from = lineOffset(served.from, local);
  const gap = lineOffset(served.to, local) - from;
  const room = MAX_SLEW * Math.max(0, local - served.since);
  return from + Math.max(-room, Math.min(room, gap));
}

function servedLine(clock: Clock, local: LocalMs): Line | null {
  if (clock.step && local >= clock.step.at) return clock.step.to;
  if (!clock.served) return null;
  return { at: local, offset: servedOffset(clock.served, local), skew: clock.served.to.skew };
}

export function bandNow(clock: Clock, local: LocalMs): BandMs | null {
  const line = servedLine(clock, local);
  return line && bandAt(line, local);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const span = (points: Point[]) => Math.max(...points.map((p) => p.at)) - Math.min(...points.map((p) => p.at));

/** Theil-Sen, so one spiked ping in a sparse 30 s bucket can't tilt the rate. */
function slope(points: Point[]) {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      if (points[j].at !== points[i].at) slopes.push((points[j].offset - points[i].offset) / (points[j].at - points[i].at));
    }
  }
  return median(slopes);
}

/** After a rebase the old marks are gone, so a short new baseline must not replace a skew fit over a longer one. */
function fitSkew(marks: Point[], fastest: Point[], clock: Clock) {
  const longest = [marks, fastest]
    .filter((points) => points.length >= 4 && span(points) >= Math.max(MIN_FIT_MS, Math.min(clock.skewSpan, FULL_FIT_MS)))
    .sort((a, b) => span(b) - span(a))[0];
  return longest ? { skew: slope(longest), skewSpan: span(longest) } : { skew: clock.skew, skewSpan: clock.skewSpan };
}

function keepMark(marks: Point[], point: Point) {
  const bucket = Math.floor(point.at / MARK_MS);
  const last = marks[marks.length - 1];
  const kept = marks.filter((m) => point.at - m.at <= MARKS_KEPT_MS);
  if (last && Math.floor(last.at / MARK_MS) === bucket) {
    return last.rtt <= point.rtt ? kept : [...kept.slice(0, -1), point];
  }
  return [...kept, point];
}

/**
 * The 8 fastest of one 32-ping window can't pin a rate to the 2 ppm the offline drift budget needs (alone they
 * leave two phones 19 ms apart after 10 minutes in check:time), so the skew also fits 20 minutes of marks.
 */
export function addPing(clock: Clock, ping: Ping, grid: Grid | null): Clock {
  const at = ((ping.t0 + ping.t1) / 2) as LocalMs;
  const point = { at, rtt: ping.t1 - ping.t0, offset: ping.band - at };
  const points = [...clock.points, point].slice(-KEEP_SAMPLES);
  const marks = keepMark(clock.marks, point);
  const fastest = [...points].sort((a, b) => a.rtt - b.rtt).slice(0, FASTEST);
  const { skew, skewSpan } = fitSkew(marks, fastest, clock);
  const aligned = fastest.map((p) => p.offset + skew * (at - p.at));
  const offset = median(aligned);
  const full = points.length >= FASTEST;
  const spread = full ? Math.max(...aligned) - Math.min(...aligned) : Infinity;
  const target: Line = { at, offset, skew };
  const now = ping.t1;
  const spreadHighSince = full && spread > SPREAD_OK_MS ? (clock.spreadHighSince ?? now) : null;
  const next = { ...clock, points, marks, skew, skewSpan, spread, spreadHighSince };
  if (!full) return next;

  const current = servedLine(clock, now);
  if (!current) return { ...next, served: { from: target, to: target, since: now }, step: null };
  const gap = bandAt(target, now) - bandAt(current, now);
  if (Math.abs(gap) <= STEP_OVER_MS) return { ...next, served: { from: current, to: target, since: now }, step: null };
  const running = grid && bandAt(current, now) >= grid.startAt;
  if (!running) return { ...next, served: { from: target, to: target, since: now }, step: null };
  const barLine = nextBarLine(grid, bandAt(current, now));
  const stepAt = localAt(current, barLine);
  return { ...next, served: { from: current, to: current, since: now }, step: { at: stepAt, to: target } };
}

export const rebase = (clock: Clock): Clock => ({ ...clock, points: [], marks: [], spread: Infinity, spreadHighSince: null });

export function adoptLead(clock: Clock, local: LocalMs): Line | null {
  return servedLine(clock, local);
}

export type Confidence = "syncing" | "synced" | "out-of-sync";

export function confidence(clock: Clock, local: LocalMs): Confidence {
  if (clock.points.length < FASTEST || !clock.served) return "syncing";
  if (clock.step && local < clock.step.at) return "syncing";
  if (clock.spreadHighSince !== null && local - clock.spreadHighSince >= OUT_OF_SYNC_AFTER_MS) return "out-of-sync";
  return "synced";
}

/** Rounds up to 10 ms as sync-budget.mjs does, so its modeled leads reproduce. */
export function leadMs(p99OneWayMs: number[]): number {
  const slowest = Math.max(0, ...p99OneWayMs);
  return Math.min(400, Math.max(150, Math.ceil((slowest + 30) / 10) * 10));
}

/** A count-in of 2 bars has firstBar -2, so bar 0 is the song's first downbeat. */
export interface Grid {
  bpm: number;
  beatsPerBar: number;
  startAt: BandMs;
  firstBar: number;
}

const EDGE = 1e-9;
const beatMs = (grid: Grid) => 60_000 / grid.bpm;
const barMs = (grid: Grid) => beatMs(grid) * grid.beatsPerBar;
export const beatTime = (grid: Grid, beat: number) => (grid.startAt + beat * beatMs(grid)) as BandMs;
export const barTime = (grid: Grid, bar: number) => (grid.startAt + (bar - grid.firstBar) * barMs(grid)) as BandMs;

function nextBeat(grid: Grid, t: BandMs): BandMs {
  return beatTime(grid, Math.max(0, Math.ceil((t - grid.startAt) / beatMs(grid) - EDGE)));
}

function nextBarLine(grid: Grid, t: BandMs): BandMs {
  const bars = Math.max(0, Math.ceil((t - grid.startAt) / barMs(grid) - EDGE));
  return barTime(grid, grid.firstBar + bars);
}

export function beatAt(grid: Grid, t: BandMs): { bar: number; beat: number } | null {
  if (t < grid.startAt) return null;
  const beats = Math.floor((t - grid.startAt) / beatMs(grid) + EDGE);
  return { bar: grid.firstBar + Math.floor(beats / grid.beatsPerBar), beat: beats % grid.beatsPerBar };
}

export type SnapRule = "song" | "section" | "countIn" | "tempo" | "scroll" | "stop";

export function snap(rule: SnapRule, earliest: BandMs, grid: Grid | null): BandMs {
  if (!grid) return earliest;
  switch (rule) {
    case "song":
    case "countIn":
    case "tempo":
      return nextBarLine(grid, earliest);
    case "section":
      return (nextBarLine(grid, (earliest + beatMs(grid)) as BandMs) - beatMs(grid)) as BandMs;
    case "scroll":
      return Math.max(barTime(grid, 0), nextBarLine(grid, earliest)) as BandMs;
    case "stop":
      return nextBeat(grid, earliest);
  }
}

export const flipNow = (at: BandMs, displayAt: BandMs, frameMs: number) => at - displayAt < frameMs / 2;
