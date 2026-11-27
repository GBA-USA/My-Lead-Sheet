import type { Analysis, HeardSection } from "./learn-result";
import type { LyricBlock } from "./learn-words";

/** The energy of the whole sound and of a few bands in one 50 ms frame. */
export interface Bands {
  total: number;
  low: number;
  voice: number;
  high: number;
}

/** One beat as the sections are told apart by it. */
export interface BeatFeatures {
  /** Loudness, brightness, low and voice shares, and onset strength, before scaling. */
  texture: number[];
  voiceShare: number;
  chroma: number[];
}

/** A beat's texture from its 50 ms frames and its mean onset strength. */
export function beatTexture(part: Bands[], onset: number): Omit<BeatFeatures, "chroma"> {
  const band = (name: keyof Bands) => part.reduce((sum, frame) => sum + frame[name], 0) / part.length + 1e-12;
  const total = band("total");
  return {
    texture: [10 * Math.log10(total), band("high") / total, band("low") / total, band("voice") / total, Math.log(1e-6 + onset)],
    voiceShare: band("voice") / total,
  };
}

/** How different the 2 bars after each beat sound from the 2 bars before, with every feature scaled alike. */
export function novelty(features: number[][], width: number): number[] {
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

/**
 * Where a chart's headings after the first fall on the heard song: the novelty picks for that many headings. Null when
 * the song is too short to hold them two bars apart. The chart is placed on what was heard, never the other way.
 */
export function placeHeadings(analysis: Analysis, headingCount: number, beatsPerBar: number): number[] | null {
  const gap = 2 * beatsPerBar;
  return analysis.beats.length < headingCount * gap ? null : sectionBoundaries(analysis.novelty, headingCount, gap);
}

/**
 * The song's sections as heard, in order from the first beat to the last, with no chart and no count. `lyricBlocks`
 * are the player's words as `splitLyrics` reads them, or null with no words. Until the sections are heard, the whole
 * song is one section, unsure.
 */
export function hearSections(
  _features: BeatFeatures[],
  beats: number[],
  _downbeatPhase: number,
  _beatsPerBar: number,
  _lyricBlocks: LyricBlock[] | null,
): HeardSection[] {
  return [{ fromBeat: 0, toBeat: beats.length, group: "A", label: "VERSE", number: null, band: "check" }];
}
