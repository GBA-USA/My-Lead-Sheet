import type { BassNote, KeyMode, Song } from "./types";

/** Notes mode shows letter names. Nashville mode shows numbers and does not follow transpose. */
export type Notation = "notes" | "nashville";

export const SCROLL_MIN = 20;
export const SCROLL_MAX = 200;
export const SCROLL_STEP = 5;

const TONICS: Record<KeyMode, string[]> = {
  major: ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"],
  minor: ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"],
};
/** Keys with flats in the signature but none in the tonic name. */
const FLAT_KEYS = new Set(["F major", "C minor", "D minor", "F minor", "G minor"]);
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
/** Semitone offset from the major tonic. Offset 8 is b6, matching East to West. */
const DEGREES = ["1", "b2", "2", "b3", "3", "4", "b5", "5", "b6", "6", "b7", "7"];

const PITCH: Record<string, number> = {};
for (const [name, pc] of [
  ["C", 0],
  ["B#", 0],
  ["C#", 1],
  ["Db", 1],
  ["D", 2],
  ["D#", 3],
  ["Eb", 3],
  ["E", 4],
  ["Fb", 4],
  ["F", 5],
  ["E#", 5],
  ["F#", 6],
  ["Gb", 6],
  ["G", 7],
  ["G#", 8],
  ["Ab", 8],
  ["A", 9],
  ["A#", 10],
  ["Bb", 10],
  ["B", 11],
  ["Cb", 11],
] as const) {
  PITCH[name] = pc;
}

/** A chord token, not a word. Quality stays attached so Am7 is not read as Am plus a 7. */
const CHORD_RE =
  /(?<![A-Za-z])([A-G](?:#|b)?(?:(?:maj|min|dim|aug|sus|add|m)\d*|\d+)?(?:\/[A-G](?:#|b)?)?)(?![A-Za-z])/g;

const NOTE_RE = /(?<![A-Za-z])([A-G](?:#|b)?)(?![A-Za-z#b])/g;
const SIMPLE_DEGREE = /^(?:b|#)?\d+m?$/;

export interface ParsedChord {
  root: string;
  quality: string;
  bass?: string;
  minor: boolean;
}

export function pitchClass(note: string): number {
  const pc = PITCH[note];
  if (pc === undefined) throw new Error(`Unknown note ${note}`);
  return pc;
}

function mod12(n: number): number {
  return ((n % 12) + 12) % 12;
}

/** The destination tonic and whether its key signature spells flats (G minor → Bb, Eb). */
function transposedKey(song: Song, semitones: number): { tonic: string; flats: boolean } {
  const tonic = TONICS[song.keyMode][mod12(pitchClass(song.keyRoot) + semitones)];
  return { tonic, flats: tonic.includes("b") || FLAT_KEYS.has(`${tonic} ${song.keyMode}`) };
}

/** The original key's name while transposed, for text that stays in that key. Null when not transposed. */
export function originalKey(song: Song, semitones: number): string | null {
  return mod12(semitones) === 0 ? null : `${song.keyRoot} ${song.keyMode}`;
}

/** A caveat after the tonic ("A (practice version — …)") stays, with its note names moved too. */
export function displayKeyLabel(song: Song, semitones: number): string {
  if (mod12(semitones) === 0) return song.keyLabel;
  const { tonic, flats } = transposedKey(song, semitones);
  const name = `${song.keyRoot} ${song.keyMode}`;
  const prefix = song.keyLabel.startsWith(name) ? name : song.keyLabel.startsWith(song.keyRoot) ? song.keyRoot : "";
  const caveat = prefix ? transposeNoteNames(song.keyLabel.slice(prefix.length), semitones, flats) : "";
  return `${tonic} ${song.keyMode}${caveat}`;
}

export function degree(note: string, tonic: string): string {
  return DEGREES[mod12(pitchClass(note) - pitchClass(tonic))];
}

export function parseChord(symbol: string): ParsedChord | null {
  const match = symbol.match(
    /^([A-G](?:#|b)?)((?:maj|min|dim|aug|sus|add|m)\d*|\d+)?(?:\/([A-G](?:#|b)?))?$/,
  );
  if (!match) return null;
  const quality = match[2] ?? "";
  const minor = quality.startsWith("min") || /^m(?!aj)/.test(quality);
  return { root: match[1], quality, bass: match[3], minor };
}

function splitAliases(chordField: string): string[] {
  if (chordField.includes(" / ")) return chordField.split(" / ").map((part) => part.trim());
  return [chordField.trim()];
}

function aliasMap(song: Song): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of song.bassNotes) {
    if (row.chord.includes("pattern notes")) continue;
    for (const alias of splitAliases(row.chord)) {
      if (parseChord(alias)) map.set(alias, row.nashville.trim());
    }
  }
  return map;
}

function songUsesMinorSuffix(song: Song): boolean {
  for (const row of song.bassNotes) {
    if (row.chord.includes("pattern notes")) continue;
    for (const alias of splitAliases(row.chord)) {
      const parsed = parseChord(alias);
      if (parsed?.minor && /m$/.test(row.nashville.trim())) return true;
    }
  }
  return false;
}

/** Chart token → Nashville number. Slash bass notes are scale degrees (C/E → 1/3). */
export function toNashvilleSymbol(symbol: string, song: Song): string {
  const parsed = parseChord(symbol);
  if (!parsed) return symbol;
  const minorM = songUsesMinorSuffix(song);
  if (parsed.bass) {
    const mark = parsed.minor && minorM ? "m" : "";
    return `${degree(parsed.root, song.keyRoot)}${mark}/${degree(parsed.bass, song.keyRoot)}`;
  }
  const stored = aliasMap(song).get(symbol);
  if (stored && SIMPLE_DEGREE.test(stored)) return stored;
  const num = degree(parsed.root, song.keyRoot);
  if (parsed.minor && minorM) return `${num}m`;
  return num;
}

function spell(note: string, semitones: number, flats: boolean): string {
  const names = flats ? FLAT_NAMES : SHARP_NAMES;
  return names[mod12(pitchClass(note) + semitones)];
}

export function transposeChordSymbol(symbol: string, semitones: number, flats: boolean): string {
  if (mod12(semitones) === 0) return symbol;
  const parsed = parseChord(symbol);
  if (!parsed) return symbol;
  const root = spell(parsed.root, semitones, flats);
  const bass = parsed.bass ? `/${spell(parsed.bass, semitones, flats)}` : "";
  return `${root}${parsed.quality}${bass}`;
}

/**
 * Replace chord tokens and keep each one over its original column where the spacing allows.
 * A longer token (Bb for A) pushes the line right; later spaces and shorter tokens take the push back.
 * A run of spaces before more text always keeps one space, so two tokens never merge.
 */
export function replaceChordTokens(line: string, replacer: (token: string) => string): string {
  let out = "";
  let cursor = 0;
  let drift = 0;
  const absorb = (gap: string, atEnd: boolean) =>
    gap.replace(/ +/g, (run, offset: number) => {
      const keep = atEnd && offset + run.length === gap.length ? 0 : 1;
      const take = Math.min(drift, run.length - keep);
      drift -= take;
      return run.slice(take);
    });
  for (const match of line.matchAll(CHORD_RE)) {
    const start = match.index ?? 0;
    const token = match[0];
    out += absorb(line.slice(cursor, start), false);
    const next = replacer(token);
    drift += next.length - token.length;
    const pad = Math.max(0, -drift);
    drift = Math.max(0, drift);
    out += next + " ".repeat(pad);
    cursor = start + token.length;
  }
  return out + absorb(line.slice(cursor), true);
}

export function displayChordLine(
  line: string,
  song: Song,
  semitones: number,
  notation: Notation,
): string {
  if (notation === "nashville") {
    return replaceChordTokens(line, (token) => toNashvilleSymbol(token, song));
  }
  if (mod12(semitones) === 0) return line;
  const { flats } = transposedKey(song, semitones);
  return replaceChordTokens(line, (token) => transposeChordSymbol(token, semitones, flats));
}

export function convertNoteNames(text: string, tonic: string): string {
  return text.replace(NOTE_RE, (note) => degree(note, tonic));
}

export function transposeNoteNames(text: string, semitones: number, flats: boolean): string {
  if (mod12(semitones) === 0) return text;
  return text.replace(NOTE_RE, (note) => spell(note, semitones, flats));
}

export function displayBassNote(note: string, song: Song, semitones: number, notation: Notation): string {
  if (notation === "nashville") return convertNoteNames(note, song.keyRoot);
  if (mod12(semitones) === 0) return note;
  const { flats } = transposedKey(song, semitones);
  return transposeNoteNames(note, semitones, flats);
}

/**
 * The table's Nashville number. A slash chord gets the key-relative bass (G/B in C → 5/7),
 * because its stored text is a teaching phrase ("5 over 3"), which the table shows as a hint.
 */
export function nashvilleNumber(row: BassNote, song: Song): string {
  return parseChord(row.chord.trim())?.bass ? toNashvilleSymbol(row.chord.trim(), song) : row.nashville;
}

export function displayChordCell(row: BassNote, song: Song, semitones: number, notation: Notation): string {
  if (notation === "nashville") return nashvilleNumber(row, song);
  return displayChordLine(row.chord, song, semitones, "notes");
}

/**
 * The whole-page scroll for a song without a runtime and BPM. 100% = the song's stored BPM × 0.25 pixels
 * per second. A null tempo uses 90 BPM for scroll only, never for the metronome.
 */
export function scrollPixelsPerSecond(tempo: number | null, percent: number): number {
  const bpm = tempo == null ? 90 : tempo;
  return bpm * 0.25 * (percent / 100);
}

export function clampScrollPercent(percent: number): number {
  const snapped = Math.round(percent / SCROLL_STEP) * SCROLL_STEP;
  return Math.min(SCROLL_MAX, Math.max(SCROLL_MIN, snapped));
}
