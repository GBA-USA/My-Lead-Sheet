import { TempoDetector, smoothed, tempoOf } from "./bpm-detect";
import type { Learned, ScrollVersion, Span } from "./scroll-timing";

const FRAMES_PER_SECOND = 20;
/** Sound starts and ends where a frame is 12 dB over the room's quietest second. */
const ABOVE_FLOOR = 16;
const TEMPO_WINDOW_SECONDS = 10;
const TEMPO_STEP_SECONDS = 2;
/** How strongly the beat tracker keeps to the local tempo. */
const TIGHTNESS = 100;
/** A tempo change is a run of beats more than 4% off the current tempo. */
const TEMPO_CHANGE = 0.04;
/** Voice-band share that sets the vocal suggestions apart from the rest of the song. */
const MIN_VOICE_LIFT = 0.08;

interface Bands {
  total: number;
  low: number;
  voice: number;
  high: number;
}

/** A second-order filter from the RBJ cookbook, Q = 0.707. */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private readonly b: number[];
  private readonly a: number[];

  constructor(kind: "low" | "high", frequency: number, sampleRate: number) {
    const w = (2 * Math.PI * frequency) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / Math.SQRT2;
    const a0 = 1 + alpha;
    const edge = kind === "low" ? (1 - cos) / 2 : (1 + cos) / 2;
    this.b = [edge / a0, ((kind === "low" ? 2 : -2) * edge) / a0, edge / a0];
    this.a = [(-2 * cos) / a0, (1 - alpha) / a0];
  }

  run(x: number): number {
    const y = this.b[0] * x + this.b[1] * this.x1 + this.b[2] * this.x2 - this.a[0] * this.y1 - this.a[1] * this.y2;
    [this.x2, this.x1, this.y2, this.y1] = [this.x1, x, this.y1, y];
    return y;
  }
}

interface Tempo {
  at: number;
  bpm: number;
}

/** What one listen found, in seconds from when listening began. */
export interface Analysis {
  /** First note to last note. */
  sound: Span;
  beats: number[];
  /** The opening tempo, then each change. */
  tempos: Tempo[];
  /** The beat each heading after the first starts on. */
  boundaries: number[];
  /** Where the voice band stands out. Only suggestions. */
  vocals: Span[];
}

/**
 * Hears a whole song a chunk at a time. Keeps D's onset envelope and the energy of a few bands
 * every 50 ms; raw samples are never stored.
 */
export class SongListener {
  private readonly detector: TempoDetector;
  private readonly frames: Bands[] = [];
  private readonly frameSize: number;
  private readonly frameRate: number;
  private readonly low: Biquad;
  private readonly voiceLow: Biquad;
  private readonly voiceHigh: Biquad;
  private readonly high: Biquad;
  private sum: Bands = { total: 0, low: 0, voice: 0, high: 0 };
  private filled = 0;

  constructor(sampleRate: number) {
    this.detector = new TempoDetector(sampleRate);
    this.frameSize = Math.round(sampleRate / FRAMES_PER_SECOND);
    this.frameRate = sampleRate / this.frameSize;
    this.low = new Biquad("low", 200, sampleRate);
    this.voiceLow = new Biquad("high", 300, sampleRate);
    this.voiceHigh = new Biquad("low", 3400, sampleRate);
    this.high = new Biquad("high", 5000, sampleRate);
  }

  get seconds(): number {
    return this.frames.length / this.frameRate;
  }

  push(samples: Float32Array) {
    this.detector.push(samples);
    for (const x of samples) {
      const low = this.low.run(x);
      const voice = this.voiceHigh.run(this.voiceLow.run(x));
      const high = this.high.run(x);
      this.sum.total += x * x;
      this.sum.low += low * low;
      this.sum.voice += voice * voice;
      this.sum.high += high * high;
      if (++this.filled < this.frameSize) continue;
      this.frames.push(this.sum);
      this.sum = { total: 0, low: 0, voice: 0, high: 0 };
      this.filled = 0;
    }
  }

  /** Null when no song with a steady beat was heard. */
  analyze(headingCount: number, beatsPerBar: number): Analysis | null {
    const sound = soundSpan(this.frames.map((frame) => frame.total), this.frameRate);
    if (!sound) return null;
    const envelope = this.detector.envelope;
    const rate = this.detector.hopsPerSecond;
    const beats = trackBeats(envelope, rate, sound);
    if (beats.length < headingCount * 2 * beatsPerBar) return null;
    const features = beatFeatures(beats, sound.end, this.frames, this.frameRate, envelope, rate);
    return {
      sound,
      beats,
      tempos: tempoChanges(beats, beatsPerBar),
      boundaries: sectionBoundaries(novelty(features.map((beat) => beat.texture), 2 * beatsPerBar), headingCount, 2 * beatsPerBar),
      vocals: vocalSpans(features.map((beat) => beat.voiceShare), beats, sound.end, beatsPerBar),
    };
  }
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

/** The room's level: the quietest second heard, before the song starts or after it ends. */
function roomFloor(power: number[], frameRate: number): number {
  const width = Math.min(power.length, Math.round(frameRate));
  let sum = power.slice(0, width).reduce((total, value) => total + value, 0);
  let quietest = sum;
  for (let i = width; i < power.length; i++) {
    sum += power[i] - power[i - width];
    quietest = Math.min(quietest, sum);
  }
  return quietest / width;
}

/** From the first frame above the room floor to the end of the last one. */
function soundSpan(power: number[], frameRate: number): Span | null {
  const threshold = Math.max(roomFloor(power, frameRate), 1e-10) * ABOVE_FLOOR;
  const first = power.findIndex((value) => value > threshold);
  if (first < 0) return null;
  let last = power.length - 1;
  while (power[last] <= threshold) last--;
  return { start: first / frameRate, end: (last + 1) / frameRate };
}

/** The local tempo every few seconds, so the tracker follows a tempo change. Null where no beat is clear. */
function localTempos(envelope: readonly number[], rate: number, from: number, to: number): (number | null)[] {
  const half = Math.round((TEMPO_WINDOW_SECONDS * rate) / 2);
  const step = Math.round(TEMPO_STEP_SECONDS * rate);
  const tempos: (number | null)[] = [];
  for (let center = from; center < to + step; center += step) {
    const start = Math.max(from, Math.min(center - half, to - 2 * half));
    tempos.push(tempoOf(envelope.slice(start, start + 2 * half), rate));
  }
  return tempos;
}

/**
 * Dynamic-programming beat tracking (Ellis 2007): each beat is the strongest onset about one local
 * beat period after the one before. Weak beats at either end, in a fade or a ringing tail, are dropped.
 */
function trackBeats(envelope: readonly number[], rate: number, sound: Span): number[] {
  const from = Math.floor(sound.start * rate);
  const to = Math.min(envelope.length, Math.ceil(sound.end * rate));
  const tempos = localTempos(envelope, rate, from, to);
  const known = tempos.filter((bpm): bpm is number => bpm != null);
  if (known.length === 0) return [];
  const fallback = percentile(known, 0.5);
  const step = Math.round(TEMPO_STEP_SECONDS * rate);
  const period = (hop: number) => (60 * rate) / (tempos[Math.round((hop - from) / step)] ?? fallback);

  const onset = smoothed(envelope);
  const mean = onset.reduce((sum, value) => sum + value, 0) / onset.length;
  const spread = Math.sqrt(onset.reduce((sum, value) => sum + (value - mean) ** 2, 0) / onset.length) || 1;
  const score = new Float64Array(to);
  const previous = new Int32Array(to).fill(-1);
  for (let hop = from; hop < to; hop++) {
    const beat = period(hop);
    let best = 0;
    for (let back = Math.max(from, hop - Math.round(2 * beat)); back <= hop - Math.round(beat / 2); back++) {
      const candidate = score[back] - TIGHTNESS * Math.log((hop - back) / beat) ** 2;
      if (candidate > best) [best, previous[hop]] = [candidate, back];
    }
    score[hop] = onset[hop] / spread + best;
  }

  let last = to - 1;
  for (let hop = Math.max(from, to - Math.round(period(to - 1))); hop < to; hop++) if (score[hop] > score[last]) last = hop;
  const hops: number[] = [];
  for (let hop = last; hop >= 0; hop = previous[hop]) hops.unshift(hop);
  const weak = median(hops.map((hop) => onset[hop])) / 2;
  while (hops.length > 0 && onset[hops[0]] < weak) hops.shift();
  while (hops.length > 0 && onset[hops[hops.length - 1]] < weak) hops.pop();
  return hops.map((hop) => hop / rate);
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

/** The opening tempo and every lasting change, each from the beats it covers. */
function tempoChanges(beats: number[], beatsPerBar: number): Tempo[] {
  const gaps = beats.slice(1).map((beat, i) => beat - beats[i]);
  const local = gaps.map((_, i) => median(gaps.slice(Math.max(0, i - beatsPerBar), i + beatsPerBar)));
  const starts = [0];
  for (let i = 1; i < gaps.length; i++) {
    const current = local[starts[starts.length - 1]];
    if (Math.abs(local[i] - current) / current > TEMPO_CHANGE) starts.push(i);
  }
  const lasting = starts.filter((start, k) => (starts[k + 1] ?? gaps.length) - start >= 2 * beatsPerBar || k === 0);
  const tempos = lasting.map((start, k) => {
    const run = gaps.slice(start, lasting[k + 1] ?? gaps.length);
    const typical = median(run);
    const steady = run.filter((gap) => Math.abs(gap - typical) / typical <= TEMPO_CHANGE);
    return { at: beats[start], bpm: (60 * steady.length) / steady.reduce((sum, gap) => sum + gap, 0) };
  });
  return tempos.filter((tempo, k) => k === 0 || Math.abs(tempo.bpm - tempos[k - 1].bpm) / tempos[k - 1].bpm > TEMPO_CHANGE);
}

interface BeatFeatures {
  /** Loudness, brightness, low and voice shares, and onset strength, before scaling. */
  texture: number[];
  voiceShare: number;
}

function beatFeatures(
  beats: number[],
  end: number,
  frames: Bands[],
  frameRate: number,
  envelope: readonly number[],
  rate: number,
): BeatFeatures[] {
  const mean = (values: readonly number[], from: number, to: number) => {
    const part = values.slice(from, Math.max(from + 1, to));
    return part.reduce((sum, value) => sum + value, 0) / part.length || 0;
  };
  return beats.map((beat, i) => {
    const next = beats[i + 1] ?? Math.min(end, 2 * beat - beats[i - 1]);
    const from = Math.floor(beat * frameRate);
    const to = Math.ceil(next * frameRate);
    const part = frames.slice(from, Math.max(from + 1, to));
    const band = (name: keyof Bands) => part.reduce((sum, frame) => sum + frame[name], 0) / part.length + 1e-12;
    const total = band("total");
    return {
      texture: [
        10 * Math.log10(total),
        band("high") / total,
        band("low") / total,
        band("voice") / total,
        Math.log(1e-6 + mean(envelope, Math.floor(beat * rate), Math.floor(next * rate))),
      ],
      voiceShare: band("voice") / total,
    };
  });
}

/** How different the 2 bars after each beat sound from the 2 bars before, with every feature scaled alike. */
function novelty(features: number[][], width: number): number[] {
  const columns = features[0]?.length ?? 0;
  const scaled = features.map((row) => [...row]);
  for (let c = 0; c < columns; c++) {
    const values = features.map((row) => row[c]);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const spread = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) || 1;
    scaled.forEach((row) => (row[c] = (row[c] - mean) / spread));
  }
  const average = (from: number, to: number) =>
    Array.from({ length: columns }, (_, c) => scaled.slice(from, to).reduce((sum, row) => sum + row[c], 0) / (to - from));
  return scaled.map((_, i) => {
    if (i === 0) return 0;
    const before = average(Math.max(0, i - width), i);
    const after = average(i, Math.min(scaled.length, i + width));
    return Math.hypot(...before.map((value, c) => value - after[c]));
  });
}

/**
 * One boundary per heading after the first, in order: the beats with the most novelty in total,
 * at least `gap` beats apart and from either end. Needs `headingCount * gap` beats.
 */
function sectionBoundaries(novelty: number[], headingCount: number, gap: number): number[] {
  const needed = headingCount - 1;
  if (needed <= 0) return [];
  const spacing = gap;
  const last = novelty.length - spacing;
  let best = novelty.map((value, i) => (i >= spacing && i <= last ? value : -Infinity));
  const picks: Int32Array[] = [];
  for (let k = 1; k < needed; k++) {
    const pick = new Int32Array(novelty.length).fill(-1);
    const next = novelty.map(() => -Infinity);
    let top = -Infinity;
    let topAt = -1;
    for (let i = spacing; i <= last; i++) {
      if (best[i - spacing] > top) [top, topAt] = [best[i - spacing], i - spacing];
      if (topAt >= 0) [next[i], pick[i]] = [top + novelty[i], topAt];
    }
    picks.push(pick);
    best = next;
  }
  let at = best.indexOf(Math.max(...best));
  const boundaries = [at];
  for (let k = picks.length - 1; k >= 0; k--) boundaries.unshift((at = picks[k][at]));
  return boundaries;
}

/** Runs of at least two bars where the voice band's share of the sound is in the song's upper group. */
function vocalSpans(shares: number[], beats: number[], end: number, beatsPerBar: number): Span[] {
  const smooth = shares.map((_, i) => median(shares.slice(Math.max(0, i - beatsPerBar), i + beatsPerBar)));
  let low = Math.min(...smooth);
  let high = Math.max(...smooth);
  let split = (low + high) / 2;
  for (let round = 0; round < 10; round++) {
    split = (low + high) / 2;
    low = median(smooth.filter((share) => share <= split));
    high = median(smooth.filter((share) => share > split));
  }
  if (!(high - low >= MIN_VOICE_LIFT)) return [];
  const spans: Span[] = [];
  let start = -1;
  smooth.forEach((share, i) => {
    const voiced = share > split;
    if (voiced && start < 0) start = i;
    if ((!voiced || i === smooth.length - 1) && start >= 0) {
      const stop = voiced ? i + 1 : i;
      if (stop - start >= 2 * beatsPerBar) spans.push({ start: beats[start], end: beats[stop] ?? end });
      start = -1;
    }
  });
  return spans;
}

/** The top number of a time signature: "3/4 — waltz" is 3. */
export function beatsPerBar(timeSignature: string): number {
  return Number(timeSignature.match(/^\s*(\d+)\s*\//)?.[1]) || 4;
}

/** The heading without its notes: "RIFF / CHORUS 1 (tempo drops to ~104)" is "RIFF / CHORUS 1". */
export function shortHeading(heading: string): string {
  return heading.split(/\s+[(—]/)[0].trim();
}

interface LearnChoice {
  boundaries: number[];
  vocals: Span[];
}

/**
 * The confirmed result as a normal timing version. The clock opens with a one-bar count-in at the
 * opening tempo, then each heading reaches its place in the chart (`fractions`, 0 to 1) when its section starts.
 */
export function learnedVersion(
  analysis: Analysis,
  choice: LearnChoice,
  headings: string[],
  fractions: number[],
  bar: number,
  bpm: number,
): Omit<ScrollVersion, "name"> {
  const shift = (bar * 60) / analysis.tempos[0].bpm - analysis.beats[0];
  const clock = (seconds: number) => Math.round(Math.max(0, seconds + shift) * 1000) / 1000;
  const sections = headings.map((heading, i) => ({
    heading,
    at: clock(i === 0 ? analysis.sound.start : analysis.beats[choice.boundaries[i - 1]]),
  }));
  const learned: Learned = {
    beatsPerBar: bar,
    downbeat: clock(analysis.beats[0]),
    beats: analysis.beats.map(clock),
    sections,
    vocals: choice.vocals.map((span) => ({ start: clock(span.start), end: clock(span.end) })),
  };
  const marks = [
    { at: 0, progress: 0 },
    ...sections.map((section, i) => ({ at: section.at, progress: i === 0 ? 0 : fractions[i] })),
    { at: clock(analysis.sound.end), progress: 1 },
  ];
  return { bpm, marks, learned };
}
