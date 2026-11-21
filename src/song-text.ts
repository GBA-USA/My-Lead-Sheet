import type { ChartLine, ChartSection, KeyMode, Song } from "./types";

/**
 * The chart as text, the way a player types or pastes it. The two-line form is the chart's own: a chord line over
 * its lyric line, columns as typed. Inline brackets, `[A]Honey, load [E]up`, become that pair. A blank line ends a
 * section; a heading line (VERSE 1, Chorus:, [Bridge]) starts one. `Note:` and `Bars:` lines keep a note and a bar
 * row that would otherwise read as words.
 */

export type SheetWarning = { line: number; message: string };
export type ParsedSheet = { sections: ChartSection[]; warnings: SheetWarning[] };

const CHORD = /^(?:[A-G][#b]?(?:maj|min|m|dim|aug|sus|add)?\d*(?:(?:sus|add|b|#)\d+)*(?:\/[A-G][#b]?)?|N\.C\.)$/;
const SECTION_WORD = /^(?:intro|verse|pre-?chorus|chorus|bridge|middle 8|outro|solo|interlude|instrumental|tag|ending|hook|refrain|coda|break)(?:\s+\d+)?(?:\s*\(.*\))?:?$/i;
const NOTE = /^\s*note: ?/i;
const BARS = /^\s*bars: ?/i;
const BRACKET = /\[([^\]\s]+)\]/g;

type Read =
  | { kind: "blank" }
  | { kind: "heading"; text: string; raw: string }
  | { kind: "note"; text: string }
  | { kind: "bars"; text: string }
  | { kind: "chords"; text: string }
  | { kind: "bracket"; text: string }
  | { kind: "lyric"; text: string };

const isChordLine = (text: string) => text.trim() !== "" && text.trim().split(/\s+/).every((token) => CHORD.test(token));

function read(raw: string): Read {
  const text = raw.trimEnd();
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "blank" };
  if (NOTE.test(text)) return { kind: "note", text: text.replace(NOTE, "") };
  if (BARS.test(text)) return { kind: "bars", text: text.replace(BARS, "") };
  if (trimmed.startsWith("|")) return { kind: "bars", text };
  if (isChordLine(text)) return { kind: "chords", text };
  const boxed = trimmed.match(/^\[([^\]]+)\]$/);
  if (boxed && !CHORD.test(boxed[1])) return { kind: "heading", text: boxed[1].trim(), raw: text };
  if ([...text.matchAll(BRACKET)].some((match) => CHORD.test(match[1]))) return { kind: "bracket", text };
  if ((/[A-Z]/.test(trimmed) && !/[a-z]/.test(trimmed)) || trimmed.endsWith(":") || SECTION_WORD.test(trimmed)) {
    return { kind: "heading", text: trimmed.replace(/:$/, "").trim(), raw: text };
  }
  return { kind: "lyric", text };
}

/** Puts each chord name at its column, one space at least after the one before. */
function chordRow(chords: { name: string; at: number }[]): string {
  let row = "";
  for (const { name, at } of chords) row = row.padEnd(at) + name;
  return row;
}

/**
 * One bracket line as a two-line pair. A chord sits on the letter after its bracket. When a name would run into the
 * next chord, spaces go into the lyric at a word gap between the two, which moves the later words right and keeps
 * every chord on its syllable. With no gap (two chords inside one word) the lyric stays and the line is warned.
 */
function fromBrackets(text: string): { line: ChartLine; warning?: string } {
  const chords: { name: string; at: number }[] = [];
  let lyrics = "";
  let cursor = 0;
  for (const match of text.matchAll(BRACKET)) {
    if (!CHORD.test(match[1])) continue;
    lyrics += text.slice(cursor, match.index);
    chords.push({ name: match[1], at: lyrics.length });
    cursor = match.index + match[0].length;
  }
  lyrics = (lyrics + text.slice(cursor)).trimEnd();
  if (lyrics.trim() === "") return { line: { bars: chords.map((chord) => chord.name).join(" ") } };
  let warning: string | undefined;
  for (let k = 1; k < chords.length; k += 1) {
    const before = chords[k - 1];
    const short = before.at + before.name.length + 1 - chords[k].at;
    if (short <= 0) continue;
    if (chords[k].at >= lyrics.length) {
      chords[k].at += short;
      continue;
    }
    const gap = lyrics.lastIndexOf(" ", chords[k].at);
    if (gap > before.at) {
      lyrics = lyrics.slice(0, gap) + " ".repeat(short) + lyrics.slice(gap);
      for (const later of chords.slice(k)) later.at += short;
      continue;
    }
    const word = [...lyrics.matchAll(/\S+/g)].find((each) => each.index + each[0].length > chords[k].at)?.[0] ?? "";
    warning ??= `Chords too close inside '${word}'`;
    chords[k].at += short;
  }
  return { line: { chords: chordRow(chords), lyrics }, warning };
}

/** Tabs to spaces at the 8-column stops a text box draws them at, so a pasted chord keeps its column. */
function untab(line: string): string {
  let out = "";
  for (const char of line) out += char === "\t" ? " ".repeat(8 - (out.length % 8)) : char;
  return out;
}

export function parseSheet(text: string): ParsedSheet {
  const rows = text.replace(/\r\n?/g, "\n").replace(/\xa0/g, " ").split("\n").map((line) => read(untab(line)));
  const sections: ChartSection[] = [];
  const warnings: SheetWarning[] = [];
  let current: ChartSection | null = null;
  const start = (heading: string) => {
    current = { heading, lines: [] };
    sections.push(current);
  };
  const add = (line: ChartLine) => {
    if (!current) start(`Verse ${sections.filter((section) => /^verse\b/i.test(section.heading)).length + 1}`);
    current!.lines.push(line);
  };
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.kind === "blank") current = null;
    else if (row.kind === "heading") start(row.text);
    else if (row.kind === "note") add({ note: row.text });
    else if (row.kind === "bars") add({ bars: row.text });
    else if (row.kind === "lyric") add({ lyrics: row.text });
    else if (row.kind === "bracket") {
      const { line, warning } = fromBrackets(row.text);
      add(line);
      if (warning) warnings.push({ line: i + 1, message: warning });
    } else {
      const below = rows[i + 1];
      if (below?.kind === "lyric" || below?.kind === "heading") {
        add({ chords: row.text, lyrics: below.kind === "heading" ? below.raw : below.text });
        i += 1;
      } else add({ bars: row.text });
    }
  }
  return { sections, warnings };
}

/** The chart as the editor's text, which `parseSheet` reads back as the same chart. */
export function sectionsToText(sections: ChartSection[]): string {
  return sections
    .map((section) => {
      const heading = read(section.heading);
      const out = [heading.kind === "heading" && heading.text === section.heading ? section.heading : `${section.heading}:`];
      section.lines.forEach((line, index) => {
        if (line.chords !== undefined) out.push(line.chords, ...(line.lyrics === undefined ? [] : [line.lyrics]));
        else if (line.lyrics !== undefined) out.push(line.lyrics);
        if (line.bars !== undefined) {
          const next = section.lines[index + 1];
          const pairsWithNext = line.note === undefined && next?.chords === undefined && next?.lyrics !== undefined;
          const bare = line.bars.trim().startsWith("|") || (isChordLine(line.bars) && !pairsWithNext);
          out.push(bare ? line.bars : `Bars: ${line.bars}`);
        }
        if (line.note !== undefined) out.push(`Note: ${line.note}`);
      });
      return out.join("\n");
    })
    .join("\n\n");
}

/** The twelve key roots the editor offers. A typed root could be one the stored-song check refuses, which drops the song. */
export const KEY_ROOTS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"] as const;

export type SongMeta = { title: string; artist: string; keyRoot: string; keyMode: KeyMode; tempo: number | null; timeSignature: string };

/** The song as stored: what the editor asked for, and every other field empty, so the stored-song check keeps it. */
export function ownSong(meta: SongMeta, sections: ChartSection[], before?: Omit<Song, "ref" | "id">): Omit<Song, "ref" | "id"> {
  return {
    keyNote: "",
    tempoNote: "",
    officialRuntimeSec: null,
    feel: "",
    sourceNote: "",
    atAGlance: "",
    howToPlay: "",
    practiceTip: "",
    bassNotes: [],
    ...before,
    title: meta.title.trim(),
    artist: meta.artist.trim(),
    keyLabel: `${meta.keyRoot} ${meta.keyMode}`,
    keyRoot: meta.keyRoot,
    keyMode: meta.keyMode,
    tempo: meta.tempo,
    timeSignature: meta.timeSignature.trim() || "4/4",
    body: sections,
  };
}

/** Why the song can't be saved yet, or null. A warned line still saves. */
export function sheetProblem(meta: SongMeta, sections: ChartSection[]): string | null {
  if (!meta.title.trim()) return "Add a title";
  if (!sections.some((section) => section.lines.length > 0)) return "Add at least one section";
  return null;
}
