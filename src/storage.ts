import seedLibrary from "../data/library.json";
import { PER_ACCOUNT, SONG_SETTING_KEYS } from "./backup-keys";
import { clampScrollPercent, isNotation, pitchClass, type Notation } from "./music";
import { parsePersonal, type PersonalDefaults } from "./personal-settings-model";
import type { Learned, Mark, ScrollPlan, Span, Tempo } from "./scroll-timing";
import type { BassNote, ChartLine, ChartSection, CopyMark, Library, LibraryFile, Song, SongData, SongRef } from "./types";

export const LIBRARY_KEY = "leadSheetsLibrary";
export const TEXT_SCALE_KEY = "leadSheetsTextScale";
/** Per-song scroll percentage, stored under `leadSheetsScrollPercent.<ref key>`. */
export const SCROLL_PERCENT_KEY = "leadSheetsScrollPercent";
/** Per-song Notes/Nashville choice, stored under `leadSheetsNotation.<ref key>`. The spec does not name the key. */
export const NOTATION_KEY = "leadSheetsNotation";
export const PENDING_INVITE_KEY = "leadSheetsPendingInvite";
/** This phone's sync state for the signed-in account (`src/backup.ts`). Present only while signed in. */
export const BACKUP_KEY = "leadSheetsBackup";
/** Each backed-up value an account left on this phone when it signed out, by key: that account and a print of the value. */
export const LEFT_BY_KEY = "leadSheetsLeftBy";
/** `leadSheetsSetAside.<account id>`: that account's values moved off this phone's keys while another account's backup used them. */
export const SET_ASIDE_KEY = "leadSheetsSetAside";
/** Present when the server keeps My Songs per account, so the list shows only the signed-in account's own songs. */
export const LIBRARY_MODE_KEY = "leadSheetsLibraryMode";

/** Sheet body scale. 100% is the default. Steps are a Phase 1 stand-in; the spec doesn't set them. */
export const TEXT_SCALES = [0.85, 1, 1.15, 1.3, 1.5, 1.7] as const;

export function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Returns false when the browser refused the write. Private mode and some embedded webviews throw. */
export function writeRaw(key: string, value: string): boolean {
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

const isCopy = shaped<CopyMark>({ id: isString, canSendOn: (value) => typeof value === "boolean", from: optional(shaped<{ name: string }>({ name: isString })) });

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
  copy: optional(isCopy),
});
const isSetlist = shaped<StoredSetlist>({ id: isId, name: isString, songIds: listOf(isId), copy: optional(isCopy) });

/** Fingerprint of each seed item as it was stored, by id. An item whose stored copy no longer matches was edited. */
type SeedPrints = Record<string, string>;

interface StoredLibrary extends LibraryFile {
  seedPrints: { songs: SeedPrints; setlists: SeedPrints };
  /** The highest song id this library has ever held. A deleted song's id stays taken, so nothing keyed by it (a send, a band copy) passes to a new song. */
  lastSongId: number;
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
    return { songs: record.songs.filter(isSong), setlists: record.setlists.filter(isSetlist), seedPrints: record.seedPrints, lastSongId: Number.isSafeInteger(record.lastSongId) ? record.lastSongId : undefined };
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
  const lastSongId = Math.max(stored?.lastSongId ?? 0, ...songs.items.map((song) => song.id));
  return { ...seed, songs: songs.items, setlists: setlists.items, seedPrints: { songs: songs.prints, setlists: setlists.prints }, lastSongId };
}

/** The library as stored, and per account without what other accounts left here. Only the stored copy is written back. */
export function loadLibrary(): Library {
  const raw = readRaw(LIBRARY_KEY);
  const library = storedLibrary(parseStored(raw));
  const next = JSON.stringify(library);
  if (next !== raw) writeRaw(LIBRARY_KEY, next);
  const shown = readRaw(LIBRARY_MODE_KEY) === PER_ACCOUNT ? withoutOthers(library, next) : library;
  return {
    songs: shown.songs.map((song) => ({ ...song, ref: localRef(song.id) })),
    setlists: shown.setlists.map(({ songIds, ...setlist }) => ({ ...setlist, songRefs: songIds.map(localRef) })),
  };
}

/** The library without the own songs and setlists other accounts left here. A seed song one of them edited shows as the seed. */
function withoutOthers(library: StoredLibrary, raw: string): StoredLibrary {
  const others = leftByOthers(ownLibraryItems(raw), backupAccount());
  if (others.size === 0) return library;
  const kept = (row: string) => (item: { id: number }) => !others.has(`${row}.${item.id}`);
  return storedLibrary({ ...library, songs: library.songs.filter(kept(SONG_ROW)), setlists: library.setlists.filter(kept(SETLIST_ROW)) });
}

/** The account this phone backs up to, or null signed out. */
export function backupAccount(): string | null {
  const account = readObject(BACKUP_KEY).account;
  return typeof account === "string" ? account : null;
}

export type LeftBy = Record<string, [account: string, print: string]>;

export const valuePrint = (value: string) => fingerprint(value);

export const readLeftBy = () => readObject(LEFT_BY_KEY) as LeftBy;

/**
 * The keys in `values` that another account left here and nobody changed since, each with that account: not
 * `account`'s to back up, and per account not shown. A value changed after its account left was changed by whoever
 * used the phone next, so it is theirs.
 */
export function leftByOthers(values: Map<string, string>, account: string | null, leftBy: LeftBy = readLeftBy()): Map<string, string> {
  const others = new Map<string, string>();
  for (const [key, value] of values) {
    const entry = leftBy[key];
    if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0] !== account && entry[1] === valuePrint(value)) others.set(key, entry[0]);
  }
  return others;
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

/** A song or setlist id past every one the stored library uses or `taken` holds, and past every song id it ever held. */
export function freeOwnId(raw: string | null, key: typeof SONG_ROW | typeof SETLIST_ROW, taken: number[]): number {
  const library = storedLibrary(parseStored(raw));
  const used = key === SONG_ROW ? [library.lastSongId] : library.setlists.map((setlist) => setlist.id);
  return Math.max(0, ...used, ...taken) + 1;
}

/** Keeps every song id a backup reply names taken, a deleted song's too, though this phone never held it. Throws when the browser refuses the write, like the rest of a sync's writes. */
export function takeSongIds(ids: number[]) {
  const library = storedLibrary(parseStored(localStorage.getItem(LIBRARY_KEY)));
  const lastSongId = Math.max(library.lastSongId, ...ids);
  if (lastSongId > library.lastSongId) localStorage.setItem(LIBRARY_KEY, JSON.stringify({ ...library, lastSongId }));
}

/** False when the browser refused the write or the song isn't one this phone can show. */
function writeOwnSong(raw: string | null, id: number, song: Omit<Song, "ref" | "id">): boolean {
  if (!writeRaw(LIBRARY_KEY, withOwnLibraryItems(raw, new Map([[`${SONG_ROW}.${id}`, JSON.stringify({ item: { ...song, id } })]])))) return false;
  storageChanged();
  return loadLibrary().songs.some((stored) => stored.id === id);
}

/** Adds a song to My Songs under a new id. Null when the browser refused the write or the song isn't one this phone can show. */
export function addOwnSong(song: Omit<Song, "ref" | "id">): number | null {
  const raw = readRaw(LIBRARY_KEY);
  const id = freeOwnId(raw, SONG_ROW, []);
  return writeOwnSong(raw, id, song) ? id : null;
}

/** Adds a setlist of own songs under a new id. Null when the browser refused the write. */
export function addOwnSetlist(setlist: Omit<StoredSetlist, "id">): number | null {
  const raw = readRaw(LIBRARY_KEY);
  const id = freeOwnId(raw, SETLIST_ROW, []);
  if (!writeRaw(LIBRARY_KEY, withOwnLibraryItems(raw, new Map([[`${SETLIST_ROW}.${id}`, JSON.stringify({ item: { ...setlist, id } })]])))) return null;
  storageChanged();
  return id;
}

/** Puts a new chart in an own song's place, read from what is stored now. */
export const replaceOwnSong = (id: number, song: Omit<Song, "ref" | "id">) => writeOwnSong(readRaw(LIBRARY_KEY), id, song);

const SEED_SONG_IDS = new Set(seedLibrary.songs.map((song) => song.id));

/** A song the player made: not a built-in song, edited or not, and not a copy from a band or a friend. Only these can be edited or deleted. */
export const madeHere = (song: Pick<Song, "id" | "copy">) => !SEED_SONG_IDS.has(song.id) && song.copy === undefined;

/**
 * Removes a song the player made from the library, from every own setlist, and its per-song settings and drafts. Its
 * id is never handed out again. Backup sends each removed key as gone. False for any other song, or when the browser
 * refused the write.
 */
export function removeOwnSong(id: number): boolean {
  const raw = readRaw(LIBRARY_KEY);
  const song = storedLibrary(parseStored(raw)).songs.find((item) => item.id === id);
  if (!song || !madeHere(song)) return false;
  const changes = new Map<string, string | null>([[`${SONG_ROW}.${id}`, null]]);
  for (const [key, value] of ownLibraryItems(raw)) {
    if (!key.startsWith(`${SETLIST_ROW}.`)) continue;
    const entry = JSON.parse(value) as OwnEntry<StoredSetlist>;
    if (entry.item.songIds.includes(id)) changes.set(key, JSON.stringify({ ...entry, item: { ...entry.item, songIds: entry.item.songIds.filter((each) => each !== id) } }));
  }
  if (!writeRaw(LIBRARY_KEY, withOwnLibraryItems(raw, changes))) return false;
  const draft = `${SONG_DRAFT_KEY}.${id}`;
  const keys = [...SONG_SETTING_KEYS.map((key) => `${key}.${id}`), ...storedKeys().filter((key) => key === draft || key.startsWith(`${draft}.`))];
  for (const key of keys) removeRaw(key);
  storageChanged();
  return true;
}

function storedKeys(): string[] {
  try {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => key !== null);
  } catch {
    return [];
  }
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

/** The five themes. `index.html` applies the saved one before the bundle loads, so its own list must agree with this one. */
export const THEMES = ["stage", "day", "cb-rg", "cb-by", "contrast"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_KEY = "leadSheetsTheme";

export function loadTheme(): Theme {
  const raw = readRaw(THEME_KEY);
  return THEMES.find((theme) => theme === raw) ?? "stage";
}

export function saveTheme(theme: Theme): boolean {
  return writeRaw(THEME_KEY, theme);
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

/** The Chords and Transpose defaults from Settings, one entry per account on this phone and "" for signed out. */
export const PERSONAL_KEY = "leadSheetsPersonal";

/** An account with no entry yet starts from what the player set while signed out, never from another account's. */
export function loadPersonal(owner: string | null): PersonalDefaults {
  const entries = readObject(PERSONAL_KEY);
  return parsePersonal(entries[owner ?? ""] ?? entries[""]);
}

export function savePersonal(owner: string | null, next: PersonalDefaults): boolean {
  return writeRaw(PERSONAL_KEY, JSON.stringify({ ...readObject(PERSONAL_KEY), [owner ?? ""]: parsePersonal(next) }));
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
  if (raw === null) return readObject(key)[refKey(ref)];
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeSongPref(key: string, ref: SongRef, value: number | Notation): boolean {
  return writeRaw(`${key}.${refKey(ref)}`, JSON.stringify(value));
}

/** A stored JSON object, or {} when it is missing or unreadable. Before per-song keys, each song setting was one such map of song id to value, so old saves still load through it. */
function readObject(key: string): Record<string, unknown> {
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

export function loadNotation(ref: SongRef, fallback: Notation = "notes"): Notation {
  const value = readSongPref(NOTATION_KEY, ref);
  return isNotation(value) ? value : fallback;
}

export function saveNotation(ref: SongRef, notation: Notation): boolean {
  return writeSongPref(NOTATION_KEY, ref, notation);
}

/** Per-song runtime, BPM and time signature entered in the app, under `leadSheetsSongData.<ref key>`. */
export const SONG_DATA_KEY = "leadSheetsSongData";
/** Per-song saved versions and which one is in use, under `leadSheetsScrollVersions.<ref key>`. */
export const SCROLL_VERSIONS_KEY = "leadSheetsScrollVersions";
/** Per-song changes not yet saved: the signed-out player's under `leadSheetsSongDraft.<ref key>`, an account's under `leadSheetsSongDraft.<ref key>.<account id>`. */
export const SONG_DRAFT_KEY = "leadSheetsSongDraft";

function isPositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function removeRaw(key: string): boolean {
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

/**
 * A saved version as stored. The timing keeps the top-level fields it had before versions held settings, so an older
 * build and the send route still read it. A version saved without taught timing has none of them in memory; on disk
 * it carries `EVEN_PACE`, which `loadScrollVersions` strips. The settings are absent on a version saved before them.
 */
export type StoredVersion = Partial<ScrollPlan> & {
  name: string;
  learned?: Learned;
  semitones?: number;
  metronomeBpm?: number;
  scrollPercent?: number;
  notation?: Notation;
  data?: SongData;
};

export interface ScrollVersions {
  versions: StoredVersion[];
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

const isSongData: Check = (value) =>
  !!value && typeof value === "object" && Object.entries(value as Record<string, unknown>).every(([name, field]) => name in SONG_DATA_FIELDS && SONG_DATA_FIELDS[name as keyof SongData](field));

const isSettings = shaped<Omit<StoredVersion, keyof ScrollPlan | "learned">>({
  name: isString,
  semitones: optional((value) => Number.isInteger(value)),
  metronomeBpm: optional(isPositive),
  scrollPercent: optional(isPositive),
  notation: optional(isNotation),
  data: optional(isSongData),
});

const isTiming: Check = (value) => {
  const fields = { bpm: isPositive, marks: listOf(isMark), learned: optional(isLearned), tempo: optional(isTempoMap) };
  if (!shaped<ScrollPlan & { learned?: Learned }>(fields)(value)) return false;
  const marks = (value as ScrollPlan).marks;
  return (
    marks.length >= 2 &&
    marks[marks.length - 1].progress === 1 &&
    marks.every((mark, i) => i === 0 || (mark.at >= marks[i - 1].at && mark.progress >= marks[i - 1].progress))
  );
};

const untimed: Check = (value) => ["bpm", "marks", "tempo", "learned"].every((name) => (value as Record<string, unknown>)[name] === undefined);

const isVersion = (value: unknown): value is StoredVersion => isSettings(value) && ((value as StoredVersion).marks === undefined ? untimed(value) : isTiming(value));

/**
 * On disk a version without taught timing carries this pace, because a build from before versions held settings
 * (U1 and earlier) requires `bpm` and `marks`, drops a row without them, and its next write of the song stores the
 * shorter list, which backup spreads to every phone. That build scrolls the version top to bottom over four minutes.
 * A constant, not the song's own pace, so two phones store the same version as the same bytes and backup's merge
 * keeps one. The stand-in is known by its value alone, because an older build's Save keeps only `bpm` and `marks`
 * (U3's `toStored`), and the value is one no take can produce: a taught plan's bpm is the metronome's, which
 * `clampMetronomeBpm` rounds to a whole number, while an early Done on a 4:00 song at tempo 100 ends on exactly
 * these marks at bpm 100.
 */
const EVEN_PACE: ScrollPlan = { bpm: 100.5, marks: [{ at: 0, progress: 0 }, { at: 240, progress: 1 }] };

const isEvenPace = (row: StoredVersion): boolean => row.bpm === EVEN_PACE.bpm && JSON.stringify(row.marks) === JSON.stringify(EVEN_PACE.marks);

function withoutEvenPace(row: unknown): unknown {
  if (!row || typeof row !== "object" || !isEvenPace(row as StoredVersion)) return row;
  const { bpm: _bpm, marks: _marks, tempo: _tempo, learned: _learned, ...settings } = row as StoredVersion;
  return settings;
}

const withEvenPace = (version: StoredVersion): StoredVersion => (version.marks === undefined ? { ...version, ...EVEN_PACE } : version);

/**
 * On disk a Chords only version says Notes and carries `chordsOnly`, because a build from before Chords only drops a
 * version whose notation it does not know, and its next write of the song stores the shorter list, which backup
 * spreads to every phone. That build shows the version in Notes.
 */
const withChordsOnly = (version: StoredVersion) => (version.notation === "chords" ? { ...version, notation: "notes", chordsOnly: true } : version);

function withoutChordsOnly(row: unknown): unknown {
  if (!row || typeof row !== "object" || (row as { chordsOnly?: unknown }).chordsOnly !== true) return row;
  const { chordsOnly: _chordsOnly, ...version } = row as StoredVersion & { chordsOnly: true };
  return { ...version, notation: "chords" };
}

export function loadScrollVersions(ref: SongRef): ScrollVersions {
  const value = readSongPref(SCROLL_VERSIONS_KEY, ref) as Partial<ScrollVersions> | undefined;
  const versions = Array.isArray(value?.versions) ? value.versions.map(withoutEvenPace).map(withoutChordsOnly).filter(isVersion) : [];
  const selected = value?.selected;
  const valid = typeof selected === "number" && Number.isInteger(selected) && selected >= 0 && selected < versions.length;
  return { versions, selected: valid ? selected : null };
}

export function saveScrollVersions(ref: SongRef, value: ScrollVersions): boolean {
  return writeRaw(`${SCROLL_VERSIONS_KEY}.${refKey(ref)}`, JSON.stringify({ ...value, versions: value.versions.map((version) => withChordsOnly(withEvenPace(version))) }));
}

/** Applies one change to the stored versions, not to a copy a screen holds, so a version pulled meanwhile stays. Null when the browser refused the write. */
export function updateScrollVersions(ref: SongRef, change: (current: ScrollVersions) => ScrollVersions): ScrollVersions | null {
  const next = change(loadScrollVersions(ref));
  return saveScrollVersions(ref, next) ? next : null;
}

const draftKey = (owner: string | null, ref: SongRef) => `${SONG_DRAFT_KEY}.${refKey(ref)}${owner === null ? "" : `.${owner}`}`;

/** This account's unsaved changes to one song, as stored, or undefined when it has none. The Save model parses what comes back. */
export function loadSongDraft(owner: string | null, ref: SongRef): unknown {
  const raw = readRaw(draftKey(owner, ref));
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A null `draft` removes this account's key. Each account has its own, so a drop never rewrites another account's draft and a full phone cannot refuse it. */
export function saveSongDraft(owner: string | null, ref: SongRef, draft: object | null): boolean {
  const key = draftKey(owner, ref);
  return draft === null ? removeRaw(key) : writeRaw(key, JSON.stringify(draft));
}
