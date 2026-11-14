import { parseChord, pitchClass } from "./music";
import type { ChartSection } from "./types";

/** The pitches heard, A2 to B5 as MIDI numbers. A bass's low root still shows through its overtones. */
const LOWEST = 45;
const HIGHEST = 83;
/** Cycles in each pitch's window. A Hann window's first null is two bins out, so this puts it one semitone away. */
const CYCLES = 34;
/**
 * A bar names a chord only when its chroma correlates this well with that chord's template. In the synthetic
 * songs of scripts/check-heard.ts every wrong match scored 0.69 or less (a bar straddling two chords) and every
 * clean right one 0.74 or more.
 */
export const SURE = 0.72;

/** Semitones above the root, for the qualities the library's charts use. Any other is matched as its triad. */
const QUALITIES: Record<string, number[]> = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  "7": [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  "2": [0, 2, 7],
  sus2: [0, 2, 7],
  sus: [0, 5, 7],
  sus4: [0, 5, 7],
  "5": [0, 7],
};

interface Pitch {
  pitchClass: number;
  coefficient: number;
  window: Float32Array;
}

/**
 * The strength of each pitch class, C to B, in the latest samples of a stream. Each pitch has its own Goertzel
 * filter over a Hann window CYCLES periods long. Only that longest window of samples is kept, and overwritten.
 */
export class Chroma {
  private readonly pitches: Pitch[] = [];
  private readonly recent: Float32Array;
  private readonly ordered: Float32Array;
  private written = 0;

  constructor(sampleRate: number) {
    for (let midi = LOWEST; midi <= HIGHEST; midi++) {
      const frequency = 440 * 2 ** ((midi - 69) / 12);
      const length = Math.round((CYCLES * sampleRate) / frequency);
      this.pitches.push({
        pitchClass: midi % 12,
        coefficient: 2 * Math.cos((2 * Math.PI * frequency) / sampleRate),
        window: Float32Array.from({ length }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length)),
      });
    }
    this.recent = new Float32Array(this.pitches[0].window.length);
    this.ordered = new Float32Array(this.recent.length);
  }

  push(sample: number) {
    this.recent[this.written++ % this.recent.length] = sample;
  }

  /** Each pitch's amplitude, summed by pitch class. */
  now(): number[] {
    const size = this.recent.length;
    const oldest = this.written % size;
    this.ordered.set(this.recent.subarray(oldest));
    this.ordered.set(this.recent.subarray(0, oldest), size - oldest);
    const bins = new Array<number>(12).fill(0);
    for (const { pitchClass, coefficient, window } of this.pitches) {
      const start = size - window.length;
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < window.length; i++) {
        const s = this.ordered[start + i] * window[i] + coefficient * s1 - s2;
        s2 = s1;
        s1 = s;
      }
      bins[pitchClass] += Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coefficient * s1 * s2)) / window.length;
    }
    return bins;
  }
}

/** One bar as heard: a chord from the chart when the match clears SURE, otherwise null for not sure. */
export interface HeardBar {
  chord: string | null;
  confidence: number;
}

/** Every chord named in the chart's chord and bar rows, in the order they first appear. */
export function chartChords(sections: ChartSection[]): string[] {
  const tokens = sections.flatMap((section) => section.lines.flatMap((line) => `${line.chords ?? ""} ${line.bars ?? ""}`.split(/[\s|]+/)));
  return [...new Set(tokens.filter((token) => parseChord(token)))];
}

/** What each bar of the section's bar rows holds: `| A7 | D7 |` is A7, D7. */
export function chartForm(section: ChartSection): string[] {
  return section.lines.flatMap((line) => line.bars?.split("|").map((cell) => cell.trim()).filter(Boolean) ?? []);
}

function template(chord: string): number[] {
  const { root, quality, minor } = parseChord(chord)!;
  const tones = QUALITIES[quality] ?? (minor ? QUALITIES.m : QUALITIES[""]);
  const bins = new Array<number>(12).fill(0);
  for (const tone of tones) bins[(pitchClass(root) + tone) % 12] = 1;
  return bins;
}

/** Pearson correlation; 0 when either side is flat, as silence is. */
function correlation(a: number[], b: number[]): number {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const [ma, mb] = [mean(a), mean(b)];
  let ab = 0;
  let aa = 0;
  let bb = 0;
  a.forEach((value, i) => {
    ab += (value - ma) * (b[i] - mb);
    aa += (value - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  });
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * One per bar from beat `from` up to beat `to`, each from the chroma of its beats. Only `chords` can be named,
 * so a chord the chart does not have is never heard.
 */
export function heardBars(chroma: number[][], from: number, to: number, beatsPerBar: number, chords: string[]): HeardBar[] {
  const templates = chords.map((chord) => ({ chord, template: template(chord) }));
  const bars: HeardBar[] = [];
  for (let start = from; start < to; start += beatsPerBar) {
    const sum = new Array<number>(12).fill(0);
    for (const beat of chroma.slice(start, Math.min(to, start + beatsPerBar))) beat.forEach((value, i) => (sum[i] += value));
    let best: HeardBar = { chord: null, confidence: 0 };
    for (const { chord, template } of templates) {
      const confidence = correlation(sum, template);
      if (confidence > best.confidence) best = { chord, confidence };
    }
    bars.push(best.confidence >= SURE ? best : { chord: null, confidence: best.confidence });
  }
  return bars;
}
