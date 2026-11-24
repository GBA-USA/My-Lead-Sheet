import type { HeardChange, HeardLine, HeardSection, SectionLabel } from "./learn-result";
import type { ChartSection } from "./types";

/** One block of the player's words: its lines, and the section its tag names, when it has a tag. */
export interface LyricBlock {
  label: SectionLabel | null;
  number: number | null;
  lines: string[];
}

/** The words lyric pages write in a tag, for each section label. */
const LABELS: [RegExp, SectionLabel][] = [
  [/^pre ?chorus$/, "PRE-CHORUS"],
  [/^(chorus|refrain|hook)$/, "CHORUS"],
  [/^verse$/, "VERSE"],
  [/^(bridge|middle 8|middle eight)$/, "BRIDGE"],
  [/^(intro|introduction)$/, "INTRO"],
  [/^(outro|coda|ending)$/, "OUTRO"],
  [/^(\w+ )?solo$/, "SOLO"],
  [/^(instrumental|interlude|break|instrumental break)$/, "INSTRUMENTAL"],
];

/** A repeat mark ending a line or a tag: (x2), [x2], (2x), x2 or ×2. */
const TIMES = /(?:\s*[([]\s*(?:[x×]\s*(\d+)|(\d+)\s*[x×])\s*[)\]]|(?:^|\s+)[x×]\s*(\d+))$/i;

const timesOf = (mark: RegExpExecArray) => Math.max(1, Number(mark[1] ?? mark[2] ?? mark[3]));

/**
 * A line that is a section's tag: a whole line in square brackets, or a label in parentheses, before a colon or on its
 * own. A singer's name after the label and a "Repeat" before it are left out. A bracketed tag that names no section
 * has label null. Null for a lyric line.
 */
function tagOf(line: string): { label: SectionLabel | null; number: number | null; times: number } | null {
  const bracket = /^([[(])([^\])]+)[\])](.*)$/.exec(line);
  let inner = bracket ? bracket[2] : line.replace(/\s*:$/, "");
  let times = 1;
  const after = bracket?.[3].trim() ?? "";
  if (after) {
    const mark = TIMES.exec(after);
    if (!mark || mark.index > 0) return null;
    times = timesOf(mark);
  }
  const inside = TIMES.exec(inner);
  if (inside && inside.index > 0) {
    times = timesOf(inside);
    inner = inner.slice(0, inside.index);
  }
  const name = inner
    .replace(/\s*:.*$/, "")
    .replace(/\s+[-–—]\s+.*$/, "")
    .replace(/^repeat\s+/i, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, " ");
  const numbered = /^(.*?)\s*(\d+)$/.exec(name);
  for (const [pattern, label] of LABELS) {
    if (pattern.test(name)) return { label, number: null, times };
    if (numbered && pattern.test(numbered[1])) return { label, number: Number(numbered[2]), times };
  }
  return bracket?.[1] === "[" ? { label: null, number: null, times } : null;
}

/**
 * The player's words as blocks of lines, in the order they are sung. Blank lines and tag lines part the blocks; a tag
 * names its block. A block or a line marked (x2) is sung that many times. A tag with no words sings the words of the
 * last block before it with that label, and that number when it has one, except a verse, since verses differ.
 */
export function splitLyrics(text: string): LyricBlock[] {
  const blocks: (LyricBlock & { times: number })[] = [];
  let open: (LyricBlock & { times: number }) | null = null;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) {
      open = null;
      continue;
    }
    const mark = TIMES.exec(line);
    if (mark?.index === 0) {
      const sung = open ?? blocks[blocks.length - 1];
      if (sung) sung.times = timesOf(mark);
      open = null;
      continue;
    }
    const tag = tagOf(line);
    if (tag) {
      blocks.push((open = { label: tag.label, number: tag.number, lines: [], times: tag.times }));
      continue;
    }
    if (!open) blocks.push((open = { label: null, number: null, lines: [], times: 1 }));
    const words = mark ? line.slice(0, mark.index).trimEnd() : line;
    for (let k = 0; k < (mark ? timesOf(mark) : 1); k++) open.lines.push(words);
  }
  blocks.forEach((each, i) => {
    if (each.lines.length || !each.label || each.label === "VERSE") return;
    const written = blocks
      .slice(0, i)
      .reverse()
      .find((earlier) => earlier.label === each.label && (each.number === null || earlier.number === each.number) && earlier.lines.length);
    if (written) each.lines = [...written.lines];
  });
  return blocks.map(({ label, number, lines, times }) => ({ label, number, lines: Array.from({ length: times }, () => lines).flat() }));
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
