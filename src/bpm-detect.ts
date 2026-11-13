import { METRONOME_MAX, METRONOME_MIN } from "./metronome";

const HOPS_PER_SECOND = 200;
const SLOWEST = 60;
const FASTEST = 180;
const GRID_STEP = 0.05;
const HARMONICS = 4;
/** Clicks buried in heavy noise score 0.10 and up; hiss, hum and pads with no beat stay under 0.04. */
const MIN_CLARITY = 0.06;

/**
 * Hears audio a chunk at a time and keeps only an onset envelope: how much louder each 5 ms got.
 * Raw samples are never stored.
 */
export class TempoDetector {
  private readonly hop: number;
  private readonly rate: number;
  private readonly onsets: number[] = [];
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

  push(samples: Float32Array) {
    for (const sample of samples) {
      this.energy += sample * sample;
      if (++this.filled < this.hop) continue;
      const level = Math.log1p(1000 * Math.sqrt(this.energy / this.hop));
      this.onsets.push(Math.max(0, level - this.level));
      this.level = level;
      this.energy = 0;
      this.filled = 0;
    }
  }

  /** The steadiest beat between 60 and 180 BPM, or null when nothing steady was heard. */
  tempo(): number | null {
    const longestLag = Math.ceil((HARMONICS * 60 * this.rate) / SLOWEST) + 1;
    if (this.onsets.length < 2 * longestLag) return null;
    const correlation = autocorrelate(centered(smoothed(this.onsets)), longestLag);
    if (correlation[0] <= 0) return null;

    let best = SLOWEST;
    let bestScore = -Infinity;
    for (let bpm = SLOWEST; bpm <= FASTEST; bpm += GRID_STEP) {
      let score = 0;
      for (let harmonic = 1; harmonic <= HARMONICS; harmonic++) score += at(correlation, (harmonic * 60 * this.rate) / bpm);
      if (score > bestScore) [best, bestScore] = [bpm, score];
    }
    return bestScore / (HARMONICS * correlation[0]) >= MIN_CLARITY ? best : null;
  }
}

function smoothed(values: number[]): number[] {
  const kernel = [1, 2, 3, 2, 1];
  return values.map((_, index) => kernel.reduce((sum, weight, k) => sum + weight * (values[index + k - 2] ?? 0), 0) / 9);
}

function centered(values: number[]): number[] {
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
