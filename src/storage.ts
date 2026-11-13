import seedLibrary from "../data/library.json";
import { clampScrollPercent, pitchClass, type Notation } from "./music";
import type { BassNote, ChartLine, ChartSection, LibraryFile, Setlist, Song } from "./types";

export const LIBRARY_KEY = "leadSheetsLibrary";
export const AWAKE_KEY = "leadSheetsKeepAwake";
export const TEXT_SCALE_KEY = "leadSheetsTextScale";
/** Per-song scroll percentage, stored under `leadSheetsScrollPercent.<song id>`. */
export const SCROLL_PERCENT_KEY = "leadSheetsScrollPercent";
/** Per-song Notes/Nashville choice, stored under `leadSheetsNotation.<song id>`. The spec does not name the key. */
export const NOTATION_KEY = "leadSheetsNotation";

/** Sheet body scale. 100% is the default. Steps are a Phase 1 stand-in; the spec doesn't set them. */
export const TEXT_SCALES = [0.85, 1, 1.15, 1.3, 1.5, 1.7] as const;

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Returns false when the browser refused the write. Private mode and some embedded webviews throw. */
function writeRaw(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

type Check = (value: unknown) => boolean;

const isString: Check = (value) => typeof value === "string";
const isId: Check = (value) => Number.isInteger(value);
const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value);
const listOf =
  (check: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(check);
function shaped<T>(fields: Record<keyof T, Check>): Check {
  return (value) =>
    !!value &&
    typeof value === "object" &&
    Object.entries<Check>(fields).every(([name, check]) => check((value as Record<string, unknown>)[name]));
}
const isNote: Check = (value) => {
  try {
    pitchClass(value as string);
    return true;
  } catch {
    return false;
  }
};

/** Every field a screen reads. A stored item that fails is dropped, so the seed copy of it comes back. */
const isSong = shaped<Song>({
  id: isId,
  title: isString,
  artist: isString,
  keyLabel: isString,
  keyRoot: isNote,
  keyMode: (value) => value === "major" || value === "minor",
  keyNote: isString,
  tempo: (value) => value === null || (typeof value === "number" && Number.isFinite(value)),
  tempoNote: isString,
  timeSignature: isString,
  feel: isString,
  sourceNote: isString,
  atAGlance: isString,
  howToPlay: isString,
  practiceTip: isString,
  bassNotes: listOf(shaped<BassNote>({ chord: isString, nashville: isString, bassNote: isString, position: isString })),
  body: listOf(
    shaped<ChartSection>({
      heading: isString,
      lines: listOf(
        shaped<ChartLine>({
          chords: optional(isString),
          lyrics: optional(isString),
          bars: optional(isString),
          note: optional(isString),
        }),
      ),
    }),
  ),
});
const isSetlist = shaped<Setlist>({ id: isId, name: isString, songIds: listOf(isId) });

/** Fingerprint of each seed item as it was stored, by id. An item whose stored copy no longer matches was edited. */
type SeedPrints = Record<string, string>;

interface StoredLibrary extends LibraryFile {
  seedPrints: { songs: SeedPrints; setlists: SeedPrints };
}

function fingerprint(item: unknown): string {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(item)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return (hash >>> 0).toString(36);
}

/**
 * Seed items win unless the stored copy is the user's: added (no print) or edited (print differs).
 * A library stored before prints existed holds only seed copies, so `prints` is undefined there.
 */
function mergeSeed<T extends { id: number }>(seed: T[], stored: T[], prints: SeedPrints | undefined) {
  const own = new Map(
    stored.filter((item) => prints && prints[item.id] !== fingerprint(item)).map((item) => [item.id, item]),
  );
  const seedIds = new Set(seed.map((item) => item.id));
  const items = [...seed.map((item) => own.get(item.id) ?? item), ...[...own.values()].filter((item) => !seedIds.has(item.id))];
  const nextPrints: SeedPrints = {};
  for (const item of items) {
    const print = own.has(item.id) ? prints?.[item.id] : fingerprint(item);
    if (print !== undefined) nextPrints[item.id] = print;
  }
  return { items, prints: nextPrints };
}

function parseStored(raw: string | null): Partial<StoredLibrary> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Partial<StoredLibrary>;
    if (!Array.isArray(record.songs) || !Array.isArray(record.setlists)) return null;
    return { songs: record.songs.filter(isSong), setlists: record.setlists.filter(isSetlist), seedPrints: record.seedPrints };
  } catch {
    return null;
  }
}

export function loadLibrary(): LibraryFile {
  const raw = readRaw(LIBRARY_KEY);
  const stored = parseStored(raw);
  const seed = JSON.parse(JSON.stringify(seedLibrary)) as LibraryFile;
  const songs = mergeSeed(seed.songs, stored?.songs ?? [], stored?.seedPrints?.songs);
  const setlists = mergeSeed(seed.setlists, stored?.setlists ?? [], stored?.seedPrints?.setlists);
  const library: StoredLibrary = {
    ...seed,
    songs: songs.items,
    setlists: setlists.items,
    seedPrints: { songs: songs.prints, setlists: setlists.prints },
  };
  const next = JSON.stringify(library);
  if (next !== raw) writeRaw(LIBRARY_KEY, next);
  return library;
}

export function loadAwake(): boolean {
  const raw = readRaw(AWAKE_KEY);
  if (raw === null) return true;
  return raw === "true";
}

export function saveAwake(on: boolean): boolean {
  return writeRaw(AWAKE_KEY, on ? "true" : "false");
}

export function loadTextScaleIndex(): number {
  const raw = readRaw(TEXT_SCALE_KEY);
  const index = raw === null ? 1 : Number(raw);
  if (!Number.isInteger(index) || index < 0 || index >= TEXT_SCALES.length) return 1;
  return index;
}

export function saveTextScaleIndex(index: number): boolean {
  return writeRaw(TEXT_SCALE_KEY, String(index));
}

/** Device-wide metronome settings. The metronome module parses what comes back. */
export const METRONOME_PREFS_KEY = "leadSheetsMetronome";

export function loadMetronomePrefs(): unknown {
  try {
    return JSON.parse(readRaw(METRONOME_PREFS_KEY) ?? "null");
  } catch {
    return null;
  }
}

export function saveMetronomePrefs(prefs: object): boolean {
  return writeRaw(METRONOME_PREFS_KEY, JSON.stringify(prefs));
}

export function tempoText(tempo: number | null): string {
  return tempo == null ? "—" : `~${tempo} bpm`;
}

export function songById(songs: Song[], id: number): Song | undefined {
  return songs.find((song) => song.id === id);
}

/** One key per song, so a save never rewrites another song's value from a stale copy in another tab. */
function readSongPref(key: string, songId: number): unknown {
  const raw = readRaw(`${key}.${songId}`);
  if (raw === null) return readLegacyMap(key)[String(songId)];
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeSongPref(key: string, songId: number, value: number | Notation): boolean {
  return writeRaw(`${key}.${songId}`, JSON.stringify(value));
}

/** Before per-song keys, each setting was one JSON map of song id to value. Read it so old saves still load. */
function readLegacyMap(key: string): Record<string, unknown> {
  const raw = readRaw(key);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* A bad old map counts as empty. */
  }
  return {};
}

export function loadScrollPercent(songId: number): number {
  const value = readSongPref(SCROLL_PERCENT_KEY, songId);
  return clampScrollPercent(typeof value === "number" && Number.isFinite(value) ? value : 100);
}

export function saveScrollPercent(songId: number, percent: number): boolean {
  return writeSongPref(SCROLL_PERCENT_KEY, songId, clampScrollPercent(percent));
}

export function loadNotation(songId: number): Notation {
  return readSongPref(NOTATION_KEY, songId) === "nashville" ? "nashville" : "notes";
}

export function saveNotation(songId: number, notation: Notation): boolean {
  return writeSongPref(NOTATION_KEY, songId, notation);
}
