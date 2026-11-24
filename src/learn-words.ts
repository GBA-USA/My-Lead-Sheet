import type { HeardChange, HeardLine, HeardSection, SectionLabel } from "./learn-result";
import type { ChartSection } from "./types";

/** One block of the player's words: its lines, and the section its tag names, when it has a tag. */
export interface LyricBlock {
  label: SectionLabel | null;
  number: number | null;
  lines: string[];
}

/** The player's words as blocks of lines. */
export function splitLyrics(_text: string): LyricBlock[] {
  return [];
}

/** Where each syllable of `word` starts, as offsets into it. */
export function splitSyllables(word: string): number[] {
  return word ? [0] : [];
}

/**
 * When each line of `lyrics` is sung and where its syllables fall, from the voice band's onsets, the beats, the heard
 * sections and the heard chord changes. Until the words are timed, none.
 */
export function hearLines(
  _voiceOnsets: Float32Array,
  _beats: number[],
  _sections: HeardSection[],
  _changes: HeardChange[],
  _lyrics: string | null,
): HeardLine[] {
  return [];
}

/**
 * The song's chart from what was heard: per section, chord lines over the words with each chord over the syllable it
 * is sung on, and bar rows where nothing is sung. Until the words are timed, none.
 */
export function buildChart(_sections: HeardSection[], _changes: HeardChange[], _lines: HeardLine[], _lyrics: string | null): ChartSection[] {
  return [];
}
