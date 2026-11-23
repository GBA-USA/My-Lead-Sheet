import { METRONOME_MAX, METRONOME_MIN } from "./metronome";

const HOPS_PER_SECOND = 200;
const SLOWEST = 60;
const FASTEST = 180;
const GRID_STEP = 0.05;
const HARMONICS = 4;
/** Clicks buried in heavy noise score 0.10 and up; hiss, hum and pads with no beat stay under 0.04. */
const MIN_CLARITY = 0.06;
/** Loudness is read over 25 ms, one cycle of a bass guitar's low E, so a held bass note doesn't ripple like onsets. */
const LEVEL_HOPS = 5;

/**
 * Hears audio a chunk at a time and keeps only an onset envelope: how much louder it got every 5 ms.
 * Raw samples are never stored.
 */
export class TempoDetector {
  private readonly hop: number;
  private readonly rate: number;
  private readonly onsets: number[] = [];
  private readonly recent: number[] = [];
  private energy = 0;
  private filled = 0;
  private level = 0;

  constructor(sampleRate: number) {
    this.hop = Math.round(sampleRate / HOPS_PER_SECOND);
    this.rate = sampleRate / this.hop;
  }

  get seconds(): number {
    return this.onsets.length / this.rate;
  }

  /** The onset envelope heard so far, `hopsPerSecond` values a second. */
  get envelope(): readonly number[] {
    return this.onsets;
  }

  get hopsPerSecond(): number {
    return this.rate;
  }

  push(samples: Float32Array) {
    for (const sample of samples) {
      this.energy += sample * sample;
      if (++this.filled < this.hop) continue;
      this.recent.push(this.energy);
      if (this.recent.length > LEVEL_HOPS) this.recent.shift();
      const energy = this.recent.reduce((sum, each) => sum + each, 0) / (this.recent.length * this.hop);
      const level = Math.log1p(1000 * Math.sqrt(energy));
      this.onsets.push(Math.max(0, level - this.level));
      this.level = level;
      this.energy = 0;
      this.filled = 0;
    }
  }

  /** The steadiest beat between 60 and 180 BPM, or null when nothing steady was heard. */
  tempo(): number | null {
    return tempoOf(this.onsets, this.rate);
  }
}

/** The steadiest beat in an onset envelope sampled `rate` times a second. Needs about 8 s of it. */
export function tempoOf(onsets: readonly number[], rate: number): number | null {
  const comb = combOf(onsets, rate, SLOWEST, FASTEST);
  if (!comb) return null;
  let best = 0;
  comb.scores.forEach((score, i) => (score > comb.scores[best] ? (best = i) : 0));
  return comb.scores[best] >= MIN_CLARITY ? comb.bpm(best) : null;
}

/** The tempos a whole song is heard at: every candidate from here on lies in this range. */
export const CANDIDATE_SLOWEST = 40;
export const CANDIDATE_FASTEST = 220;
/** Peaks closer than this share of their tempo are one peak. */
const SAME_PEAK = 0.04;

/**
 * The strongest `count` peaks of the beat comb between 40 and 220 BPM, strongest first; empty when nothing steady was
 * heard. Octave mistakes live between these and their halves and doubles, so the caller scores those too.
 */
export function tempoCandidates(onsets: readonly number[], rate: number, count = 3): number[] {
  const comb = combOf(onsets, rate, CANDIDATE_SLOWEST, CANDIDATE_FASTEST);
  if (!comb) return [];
  const { scores } = comb;
  const peaks = scores
    .map((score, i) => ({ bpm: comb.bpm(i), score, i }))
    .filter(({ score, i }) => score >= MIN_CLARITY && score >= (scores[i - 1] ?? -Infinity) && score > (scores[i + 1] ?? -Infinity))
    .sort((a, b) => b.score - a.score);
  const kept: number[] = [];
  for (const peak of peaks) {
    if (kept.length === count) break;
    if (kept.every((bpm) => Math.abs(bpm - peak.bpm) > SAME_PEAK * bpm)) kept.push(peak.bpm);
  }
  return kept;
}

/** How well a beat at each tempo from `slowest` to `fastest` fits the envelope, as a share of its energy. */
function combOf(onsets: readonly number[], rate: number, slowest: number, fastest: number) {
  const longestLag = Math.ceil((HARMONICS * 60 * rate) / slowest) + 1;
  if (onsets.length < 2 * longestLag) return null;
  const correlation = autocorrelate(centered(smoothed(onsets)), longestLag);
  if (correlation[0] <= 0) return null;
  const bpm = (i: number) => slowest + i * GRID_STEP;
  const scores: number[] = [];
  for (let i = 0; bpm(i) <= fastest + 1e-9; i++) {
    let score = 0;
    for (let harmonic = 1; harmonic <= HARMONICS; harmonic++) score += at(correlation, (harmonic * 60 * rate) / bpm(i));
    scores.push(score / (HARMONICS * correlation[0]));
  }
  return { scores, bpm };
}

export function smoothed(values: readonly number[]): number[] {
  const kernel = [1, 2, 3, 2, 1];
  return values.map((_, index) => kernel.reduce((sum, weight, k) => sum + weight * (values[index + k - 2] ?? 0), 0) / 9);
}

function centered(values: readonly number[]): number[] {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.map((value) => value - mean);
}

function autocorrelate(values: number[], lags: number): number[] {
  return Array.from({ length: lags + 1 }, (_, lag) => {
    let sum = 0;
    for (let index = lag; index < values.length; index++) sum += values[index] * values[index - lag];
    return sum;
  });
}

function at(values: number[], position: number): number {
  const below = Math.floor(position);
  const fraction = position - below;
  return values[below] * (1 - fraction) + values[below + 1] * fraction;
}

export const TAP_RESET_MS = 2000;
const TAP_WINDOW = 8;

/** Keeps the last few taps; a pause longer than TAP_RESET_MS starts over. */
export function addTap(taps: readonly number[], at: number): number[] {
  const last = taps[taps.length - 1];
  if (last == null || at - last > TAP_RESET_MS) return [at];
  return [...taps, at].slice(-TAP_WINDOW);
}

export function tapBpm(taps: readonly number[]): number | null {
  if (taps.length < 2) return null;
  return (60_000 * (taps.length - 1)) / (taps[taps.length - 1] - taps[0]);
}

export interface TempoChoice {
  bpm: number;
  feel: "Half time" | "Suggested" | "Double time";
}

/** The suggestion with its half and double time, rounded, keeping only what the BPM field accepts. */
export function tempoChoices(bpm: number): TempoChoice[] {
  const choices: TempoChoice[] = [
    { bpm: Math.round(bpm / 2), feel: "Half time" },
    { bpm: Math.round(bpm), feel: "Suggested" },
    { bpm: Math.round(bpm * 2), feel: "Double time" },
  ];
  return choices.filter((choice) => choice.bpm >= METRONOME_MIN && choice.bpm <= METRONOME_MAX);
}
