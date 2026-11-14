import seedLibrary from "../data/library.json";
import { clampScrollPercent, pitchClass, type Notation } from "./music";
import type { Learned, Mark, ScrollVersion, Span, Tempo } from "./scroll-timing";
import type { BassNote, ChartLine, ChartSection, Library, LibraryFile, Song, SongData, SongRef } from "./types";

export const LIBRARY_KEY = "leadSheetsLibrary";
export const AWAKE_KEY = "leadSheetsKeepAwake";
export const TEXT_SCALE_KEY = "leadSheetsTextScale";
/** Per-song scroll percentage, stored under `leadSheetsScrollPercent.<ref key>`. */
export const SCROLL_PERCENT_KEY = "leadSheetsScrollPercent";
/** Per-song Notes/Nashville choice, stored under `leadSheetsNotation.<ref key>`. The spec does not name the key. */
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

let generation = 0;
const listeners = new Set<() => void>();

/** Goes up each time a sync rewrites stored values, so every screen holding a copy of one reads it again. */
export const storageGeneration = () => generation;

export function onStorageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function storageChanged() {
  generation += 1;
  for (const listener of listeners) listener();
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

const ownItems = <T extends { id: number }>(stored: T[], prints: SeedPrints | undefined) =>
  stored.filter((item) => prints && prints[item.id] !== fingerprint(item));

/**
 * Seed items win unless the stored copy is the user's: added (no print) or edited (print differs).
 * A library stored before prints existed holds only seed copies, so `prints` is undefined there.
 */
function mergeSeed<T extends { id: number }>(seed: T[], stored: T[], prints: SeedPrints | undefined) {
  const own = new Map(ownItems(stored, prints).map((item) => [item.id, item]));
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

/** The storage key suffix for a ref. This phone's own songs keep the suffix they had before refs, `<id>`, so nothing saved earlier has to move. */
function refKey(ref: SongRef): string {
  return ref.startsWith(LOCAL) ? ref.slice(LOCAL.length) : ref;
}

const seedCopy = () => JSON.parse(JSON.stringify(seedLibrary)) as LibraryFile;

function storedLibrary(stored: Partial<StoredLibrary> | null): StoredLibrary {
  const seed = seedCopy();
  const songs = mergeSeed(seed.songs, stored?.songs ?? [], stored?.seedPrints?.songs);
  const setlists = mergeSeed(seed.setlists, stored?.setlists ?? [], stored?.seedPrints?.setlists);
  return { ...seed, songs: songs.items, setlists: setlists.items, seedPrints: { songs: songs.prints, setlists: setlists.prints } };
}

export function loadLibrary(): Library {
  const raw = readRaw(LIBRARY_KEY);
  const library = storedLibrary(parseStored(raw));
  const next = JSON.stringify(library);
  if (next !== raw) writeRaw(LIBRARY_KEY, next);
  return {
    songs: library.songs.map((song) => ({ ...song, ref: localRef(song.id) })),
    setlists: library.setlists.map(({ songIds, ...setlist }) => ({ ...setlist, songRefs: songIds.map(localRef) })),
  };
}

/** Backup row names, not localStorage keys: each own song and setlist is backed up as its own row, `leadSheetsSong.<id>` or `leadSheetsSetlist.<id>`. */
export const SONG_ROW = "leadSheetsSong";
export const SETLIST_ROW = "leadSheetsSetlist";

type OwnEntry<T> = { item: T; print?: string };

const ownEntry = <T extends { id: number }>(item: T, prints: SeedPrints | undefined) =>
  JSON.stringify(prints?.[item.id] === undefined ? { item } : { item, print: prints[item.id] });

/**
 * The songs and setlists this phone added or edited, from stored library text, one entry each. The value holds the
 * item and, for an edited seed item, the seed print it was edited from. Seed copies are left out: every phone has them.
 */
export function ownLibraryItems(raw: string | null): Map<string, string> {
  const stored = parseStored(raw);
  const songs = ownItems(stored?.songs ?? [], stored?.seedPrints?.songs).map((song) => [`${SONG_ROW}.${song.id}`, ownEntry(song, stored?.seedPrints?.songs)] as const);
  const setlists = ownItems(stored?.setlists ?? [], stored?.seedPrints?.setlists).map((setlist) => [`${SETLIST_ROW}.${setlist.id}`, ownEntry(setlist, stored?.seedPrints?.setlists)] as const);
  return new Map([...songs, ...setlists]);
}

function parseEntry<T>(value: string, check: Check): OwnEntry<T> | null {
  try {
    const entry = JSON.parse(value) as OwnEntry<T>;
    return check(entry?.item) && (entry.print === undefined || isString(entry.print)) ? entry : null;
  } catch {
    return null;
  }
}

function setOwn<T extends { id: number }>(items: T[], prints: SeedPrints, seed: T[], id: number, entry: OwnEntry<T> | null) {
  const at = items.findIndex((item) => item.id === id);
  const seedItem = seed.find((item) => item.id === id);
  const next = entry?.item ?? seedItem;
  if (entry?.print !== undefined) prints[id] = entry.print;
  else if (entry || !seedItem) delete prints[id];
  else prints[id] = fingerprint(seedItem);
  if (at >= 0 && next) items[at] = next;
  else if (at >= 0) items.splice(at, 1);
  else if (next) {
    const seedIds = new Set(seed.map((item) => item.id));
    const after = items.findIndex((item) => !seedIds.has(item.id) && item.id > id);
    items.splice(after < 0 ? items.length : after, 0, next);
  }
}

/**
 * Stored library text with own songs and setlists set (an `ownLibraryItems` value) or removed (null). A removed seed
 * item goes back to its seed copy. A new item goes in id order after the seed, so every phone stores the same text.
 */
export function withOwnLibraryItems(raw: string | null, changes: Map<string, string | null>): string {
  const library = storedLibrary(parseStored(raw));
  const seed = seedCopy();
  for (const [key, value] of changes) {
    const id = Number(key.slice(key.indexOf(".") + 1));
    if (!Number.isInteger(id)) continue;
    if (key.startsWith(`${SONG_ROW}.`)) {
      const entry = value === null ? null : parseEntry<StoredSong>(value, isSong);
      if (value === null || entry?.item.id === id) setOwn(library.songs, library.seedPrints.songs, seed.songs, id, entry);
    } else if (key.startsWith(`${SETLIST_ROW}.`)) {
      const entry = value === null ? null : parseEntry<StoredSetlist>(value, isSetlist);
      if (value === null || entry?.item.id === id) setOwn(library.setlists, library.seedPrints.setlists, seed.setlists, id, entry);
    }
  }
  return JSON.stringify(storedLibrary(library));
}

/** The first song or setlist id that neither the stored library nor `taken` uses. */
export function freeOwnId(raw: string | null, key: typeof SONG_ROW | typeof SETLIST_ROW, taken: number[]): number {
  const library = storedLibrary(parseStored(raw));
  const items: { id: number }[] = key === SONG_ROW ? library.songs : library.setlists;
  return Math.max(0, ...items.map((item) => item.id), ...taken) + 1;
}

/** An own song or setlist entry copied to a new id, named "<name> · from <phone>". It is an added item, so it has no seed print. */
export function copiedOwnItem(value: string, id: number, phone: string): string {
  const { item } = JSON.parse(value) as OwnEntry<{ title?: string; name?: string }>;
  const from = (name: string) => `${name} · from ${phone}`;
  return JSON.stringify({ item: { ...item, id, ...(item.title === undefined ? {} : { title: from(item.title) }), ...(item.name === undefined ? {} : { name: from(item.name) }) } });
}

/** An own setlist entry with song `from` swapped for song `to`. */
export function setlistWithSongMoved(value: string, from: number, to: number): string {
  const entry = JSON.parse(value) as OwnEntry<StoredSetlist>;
  if (!entry.item.songIds.includes(from)) return value;
  return JSON.stringify({ ...entry, item: { ...entry.item, songIds: entry.item.songIds.map((id) => (id === from ? to : id)) } });
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
  const raw = readRaw(`${key}.${refKey(ref)}`);
  if (raw === null) return readLegacyMap(key)[refKey(ref)];
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeSongPref(key: string, ref: SongRef, value: number | Notation): boolean {
  return writeRaw(`${key}.${refKey(ref)}`, JSON.stringify(value));
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

/** Per-song runtime, BPM and time signature entered in the app, under `leadSheetsSongData.<ref key>`. */
export const SONG_DATA_KEY = "leadSheetsSongData";
/** Per-song taught scroll versions and which one plays, under `leadSheetsScrollVersions.<ref key>`. */
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
  if (Object.keys(data).length === 0) return removeRaw(`${SONG_DATA_KEY}.${refKey(ref)}`);
  return writeRaw(`${SONG_DATA_KEY}.${refKey(ref)}`, JSON.stringify(data));
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
  return writeRaw(`${SCROLL_VERSIONS_KEY}.${refKey(ref)}`, JSON.stringify(value));
}

/** Applies one change to the stored versions, not to a copy a screen holds, so a version pulled meanwhile stays. */
export function updateScrollVersions(ref: SongRef, change: (current: ScrollVersions) => ScrollVersions): ScrollVersions {
  const next = change(loadScrollVersions(ref));
  saveScrollVersions(ref, next);
  return next;
}
