import seedLibrary from "../data/library.json";
import { clampScrollPercent, pitchClass, type Notation } from "./music";
import type { Learned, Mark, ScrollVersion, Span, Tempo } from "./scroll-timing";
import type { BassNote, ChartLine, ChartSection, Library, LibraryFile, Song, SongData, SongRef } from "./types";

export const LIBRARY_KEY = "leadSheetsLibrary";
export const AWAKE_KEY = "leadSheetsKeepAwake";
export const TEXT_SCALE_KEY = "leadSheetsTextScale";
/** Per-song scroll percentage, stored under `leadSheetsScrollPercent.<song key>`. */
export const SCROLL_PERCENT_KEY = "leadSheetsScrollPercent";
/** Per-song Notes/Nashville choice, stored under `leadSheetsNotation.<song key>`. The spec does not name the key. */
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
type StoredSong = LibraryFile["songs"][number];
type StoredSetlist = LibraryFile["setlists"][number];

const isSong = shaped<StoredSong>({
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
  officialRuntimeSec: (value) => value == null || isPositive(value),
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
const isSetlist = shaped<StoredSetlist>({ id: isId, name: isString, songIds: listOf(isId) });

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

const LOCAL = "local/";

export function localRef(id: number): SongRef {
  return `${LOCAL}${id}`;
}

/** This phone's own songs keep the key they had before refs, `<id>`, so nothing saved earlier has to move. */
function songKey(ref: SongRef): string {
  return ref.startsWith(LOCAL) ? ref.slice(LOCAL.length) : ref;
}

export function loadLibrary(): Library {
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
  return {
    songs: library.songs.map((song) => ({ ...song, ref: localRef(song.id) })),
    setlists: library.setlists.map(({ songIds, ...setlist }) => ({ ...setlist, songRefs: songIds.map(localRef) })),
  };
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

export function songByRef(songs: Song[], ref: SongRef): Song | undefined {
  return songs.find((song) => song.ref === ref);
}

/** One key per song, so a save never rewrites another song's value from a stale copy in another tab. */
function readSongPref(key: string, ref: SongRef): unknown {
  const raw = readRaw(`${key}.${songKey(ref)}`);
  if (raw === null) return readLegacyMap(key)[songKey(ref)];
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeSongPref(key: string, ref: SongRef, value: number | Notation): boolean {
  return writeRaw(`${key}.${songKey(ref)}`, JSON.stringify(value));
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

export function loadScrollPercent(ref: SongRef): number {
  const value = readSongPref(SCROLL_PERCENT_KEY, ref);
  return clampScrollPercent(typeof value === "number" && Number.isFinite(value) ? value : 100);
}

export function saveScrollPercent(ref: SongRef, percent: number): boolean {
  return writeSongPref(SCROLL_PERCENT_KEY, ref, clampScrollPercent(percent));
}

export function loadNotation(ref: SongRef): Notation {
  return readSongPref(NOTATION_KEY, ref) === "nashville" ? "nashville" : "notes";
}

export function saveNotation(ref: SongRef, notation: Notation): boolean {
  return writeSongPref(NOTATION_KEY, ref, notation);
}

/** Per-song runtime, BPM and time signature entered in the app, under `leadSheetsSongData.<song key>`. */
export const SONG_DATA_KEY = "leadSheetsSongData";
/** Per-song taught scroll versions and which one plays, under `leadSheetsScrollVersions.<song key>`. */
export const SCROLL_VERSIONS_KEY = "leadSheetsScrollVersions";

function isPositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function removeRaw(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

const SONG_DATA_FIELDS: Record<keyof SongData, Check> = {
  officialRuntimeSec: isPositive,
  tempo: isPositive,
  timeSignature: (value) => isString(value) && (value as string).trim().length > 0,
};

export function loadSongData(ref: SongRef): SongData {
  const value = readSongPref(SONG_DATA_KEY, ref);
  if (!value || typeof value !== "object") return {};
  const data: Record<string, unknown> = {};
  for (const [name, check] of Object.entries<Check>(SONG_DATA_FIELDS)) {
    const field = (value as Record<string, unknown>)[name];
    if (check(field)) data[name] = field;
  }
  return data as SongData;
}

/** An empty `data` removes the entry, so the song goes back to the library's values. */
export function saveSongData(ref: SongRef, data: SongData): boolean {
  if (Object.keys(data).length === 0) return removeRaw(`${SONG_DATA_KEY}.${songKey(ref)}`);
  return writeRaw(`${SONG_DATA_KEY}.${songKey(ref)}`, JSON.stringify(data));
}

export function withSongData(song: Song, data: SongData): Song {
  return { ...song, officialRuntimeSec: song.officialRuntimeSec ?? null, ...data };
}

export interface ScrollVersions {
  versions: ScrollVersion[];
  /** Index into `versions`, or null for the even pace. */
  selected: number | null;
}

const isTime: Check = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

const isMark = shaped<Mark>({
  at: isTime,
  progress: (value) => typeof value === "number" && value >= 0 && value <= 1,
});

const isLearned = shaped<Learned>({
  beatsPerBar: (value) => Number.isInteger(value) && (value as number) > 0,
  downbeat: isPositive,
  beats: listOf(isTime),
  sections: listOf(
    shaped<Learned["sections"][number]>({ heading: isString, at: isTime, heard: optional(listOf((value) => value === null || isString(value))) }),
  ),
  vocals: listOf(shaped<Span>({ start: isTime, end: isTime })),
});

const isTempoMap: Check = (value) => {
  if (!listOf(shaped<Tempo>({ at: isTime, bpm: isPositive }))(value)) return false;
  const tempo = value as Tempo[];
  return tempo[0]?.at === 0 && tempo.every((change, i) => i === 0 || change.at > tempo[i - 1].at);
};

const isVersion: Check = (value) => {
  const fields = { name: isString, bpm: isPositive, marks: listOf(isMark), learned: optional(isLearned), tempo: optional(isTempoMap) };
  if (!shaped<ScrollVersion>(fields)(value)) return false;
  const marks = (value as ScrollVersion).marks;
  return (
    marks.length >= 2 &&
    marks[marks.length - 1].progress === 1 &&
    marks.every((mark, i) => i === 0 || (mark.at >= marks[i - 1].at && mark.progress >= marks[i - 1].progress))
  );
};

export function loadScrollVersions(ref: SongRef): ScrollVersions {
  const value = readSongPref(SCROLL_VERSIONS_KEY, ref) as Partial<ScrollVersions> | undefined;
  const versions = Array.isArray(value?.versions) ? value.versions.filter(isVersion) : [];
  const selected = value?.selected;
  const valid = typeof selected === "number" && Number.isInteger(selected) && selected >= 0 && selected < versions.length;
  return { versions, selected: valid ? selected : null };
}

export function saveScrollVersions(ref: SongRef, value: ScrollVersions): boolean {
  return writeRaw(`${SCROLL_VERSIONS_KEY}.${songKey(ref)}`, JSON.stringify(value));
}
