import seedLibrary from "../data/library.json" with { type: "json" };
import type { BandSetlist, BandSong } from "../src/band-library-model";
import { chordProToSong, normalizeChordPro, songToChordPro, type SentSong, type SongContent } from "../src/chordpro";
import type { ChartLine, ChartSection } from "../src/types";
import { randomBytes, toBase64Url } from "./bytes";
import { liveCode } from "./codes";
import { signedIn, wantsChordPro, type Context, type Route, type User } from "./directory-http";
import { fromRoom, Refused, roomRefused as refused } from "./refused";
import { selfRoomId } from "./room-backup";
import { everAGuest, firstName, guestBandIdsOf } from "./room-guest";
import { bandIdIn, bandIdsOf, inRoom, roomOf, shutOut, type RoomStore } from "./room-members";
import { checkSend, lineage, type ShareChoice, type StoredShare } from "./share-guard";

type Shared = { share_id: string; shared_by: string; local_id: number | null; shared_at: number; updated_by: string; updated_at: number; rev: number };
type SongRow = Shared & { song_id: string; song: string; print: string; sent_id: string | null };
type SetlistRow = Shared & { setlist_id: string; name: string; song_ids: string; tags: string };
type ShareRow = { id: string; owner_id: string; parent_id: string | null; choice: ShareChoice };

/** A chain from `lineage`: the copy the caller would send first, then each copy it came from, back to an original. */
type Chain = StoredShare[];

type Saved<T> = { item: T; changed: boolean };

export function createLibraryTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, parent_id TEXT, choice TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS band_songs (
    song_id TEXT PRIMARY KEY, share_id TEXT NOT NULL, song TEXT NOT NULL, print TEXT NOT NULL,
    shared_by TEXT NOT NULL, local_id INTEGER, shared_at INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL, sent_id TEXT
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS band_songs_by_print ON band_songs (print)`);
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS band_songs_by_sent ON band_songs (shared_by, sent_id)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS band_setlists (
    setlist_id TEXT PRIMARY KEY, share_id TEXT NOT NULL, name TEXT NOT NULL, song_ids TEXT NOT NULL, tags TEXT NOT NULL,
    shared_by TEXT NOT NULL, local_id INTEGER, shared_at INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS song_copies (copy_id TEXT PRIMARY KEY, print TEXT NOT NULL)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS song_copies_by_print ON song_copies (print)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS setlist_sends (share_id TEXT PRIMARY KEY, name TEXT NOT NULL, songs TEXT NOT NULL, created_at INTEGER NOT NULL)`);
}

const newId = (prefix: string) => `${prefix}_${toBase64Url(randomBytes(16))}`;

export function storeOf(sql: SqlStorage) {
  return (id: string): StoredShare | undefined => {
    const row = sql.exec<ShareRow>(`SELECT * FROM shares WHERE id = ?`, id).toArray()[0];
    return row && { id: row.id, ownerId: row.owner_id, parentId: row.parent_id, choice: row.choice };
  };
}

const chainStore = (chain: Chain) => (id: string) => chain.find((share) => share.id === id);

const allowed = (chain: Chain, senderId: string, choice: ShareChoice) => checkSend(chainStore(chain), { senderId, copyId: chain[0].id, choice });

function mustAllow(chain: Chain, senderId: string, choice: ShareChoice) {
  const result = allowed(chain, senderId, choice);
  if (!result.ok) throw new Refused(result.code, result.status);
}

/** `userId`'s own node under the first copy in `chain`, carrying its choice. The id names them, so it never collides with another holder's. */
const nodeFor = (chain: Chain, userId: string): Chain => [{ id: `${chain[0].id}/${userId}`, ownerId: userId, parentId: chain[0].id, choice: chain[0].choice }, ...chain];

function keep(sql: SqlStorage, share: StoredShare) {
  sql.exec(`INSERT OR IGNORE INTO shares (id, owner_id, parent_id, choice) VALUES (?, ?, ?, ?)`, share.id, share.ownerId, share.parentId, share.choice);
}

/** Stores a new copy owned by `ownerId`, made from `from` (null for the owner's own original), and returns its share id. */
function adopt(sql: SqlStorage, id: string, ownerId: string, from: Chain | null, choice: ShareChoice): string {
  const parent = from ?? [{ id: newId("orig"), ownerId, parentId: null, choice: "public" as const }];
  for (const share of parent) keep(sql, share);
  keep(sql, { id, ownerId, parentId: parent[0].id, choice });
  return id;
}

/**
 * What the caller holds of a band item. The member who shared it holds what they shared it from. Every other member
 * holds their own node under the band's copy, carrying the choice made when it was shared into the band. The node's id
 * names the member, so storing it in another room never collides with the band copy's row or another member's node.
 */
function holding(sql: SqlStorage, row: Shared, userId: string): Chain {
  const chain = lineage(storeOf(sql), row.share_id);
  if (!chain) throw refused("lineage_broken");
  return userId === row.shared_by ? chain.slice(1) : nodeFor(chain, userId);
}

function sharedFields(sql: SqlStorage, row: Shared, userId: string, names: Map<string, string>) {
  return {
    sharedBy: row.shared_by,
    sharedByName: names.get(row.shared_by) ?? "",
    sharedAt: row.shared_at,
    updatedAt: row.updated_at,
    rev: row.rev,
    sharedAs: storeOf(sql)(row.share_id)!.choice,
    canSendOn: allowed(holding(sql, row, userId), userId, "public").ok,
    localId: row.shared_by === userId ? row.local_id : null,
  };
}

/** Who shared each item, by the name bandmates see, or by first name only for a guest (PLAN.md 7.14). */
const memberNames = (sql: SqlStorage, guest = false) =>
  new Map(
    sql
      .exec<{ user_id: string; display_name: string }>(`SELECT user_id, display_name FROM members`)
      .toArray()
      .map((row) => [row.user_id, guest ? firstName(row.display_name) : row.display_name]),
  );

const songOf = (sql: SqlStorage, row: SongRow, userId: string, names = memberNames(sql)): StoredBandSong => ({
  songId: row.song_id,
  song: row.song,
  ...sharedFields(sql, row, userId, names),
});

const setlistOf = (sql: SqlStorage, row: SetlistRow, userId: string, names = memberNames(sql)): BandSetlist => ({
  setlistId: row.setlist_id,
  name: row.name,
  songIds: JSON.parse(row.song_ids),
  tags: JSON.parse(row.tags),
  ...sharedFields(sql, row, userId, names),
});

const songRow = (sql: SqlStorage, songId: string) => sql.exec<SongRow>(`SELECT * FROM band_songs WHERE song_id = ?`, songId).toArray()[0];
const setlistRow = (sql: SqlStorage, setlistId: string) => sql.exec<SetlistRow>(`SELECT * FROM band_setlists WHERE setlist_id = ?`, setlistId).toArray()[0];

function editable<T extends Shared>(band: RoomStore, userId: string, row: T | undefined): T {
  const { me } = inRoom(band.sql, userId);
  if (!row) throw refused("not-found");
  if (me.role !== "admin" && row.shared_by !== userId) throw refused("not-yours");
  return row;
}

export function bandSongsOnly(sql: SqlStorage, songIds: string[]) {
  for (const id of songIds) if (!songRow(sql, id)) throw refused("not-a-band-song");
}

/** A band song as the room returns it: `song` is the stored column (ChordPro text or legacy JSON), shaped on the way out. */
export type StoredBandSong = Omit<BandSong, "song"> & { song: string };
export type StoredBandLibrary = { songs: StoredBandSong[]; setlists: BandSetlist[] };

/** `sentId` is the phone's own id for this share, so a retry after a lost reply gets the band song it already made. */
export type SongShare = { song: SongContent; print: string; localId: number | null; choice: ShareChoice; sentId: string | null };
export type SongChange = { song: SongContent; print: string };
export type SetlistFields = { name: string; songIds: string[]; tags: string[] };
export type SetlistShare = SetlistFields & { localId: number | null; choice: ShareChoice };

/** Every user id here is trusted: only the Directory calls these, after it has checked the session and the share rule. */
export const bandLibrary = {
  view(band: RoomStore, userId: string): StoredBandLibrary {
    const { me } = inRoom(band.sql, userId, "setlists");
    const names = memberNames(band.sql, me.role === "guest");
    return {
      songs: band.sql
        .exec<SongRow>(`SELECT * FROM band_songs ORDER BY shared_at, song_id`)
        .toArray()
        .map((row) => songOf(band.sql, row, userId, names)),
      setlists: band.sql
        .exec<SetlistRow>(`SELECT * FROM band_setlists ORDER BY shared_at, setlist_id`)
        .toArray()
        .map((row) => setlistOf(band.sql, row, userId, names)),
    };
  },

  requireMember(band: RoomStore, userId: string) {
    inRoom(band.sql, userId);
  },

  shareSong(band: RoomStore, userId: string, share: SongShare, from: Chain | null, now: number): StoredBandSong {
    inRoom(band.sql, userId);
    const sent = band.sql.exec<SongRow>(`SELECT * FROM band_songs WHERE shared_by = ? AND sent_id = ?`, userId, share.sentId).toArray()[0];
    if (sent) return songOf(band.sql, sent, userId);
    const songId = newId("song");
    const shareId = adopt(band.sql, `${band.bandId}/${songId}`, userId, from, share.choice);
    band.sql.exec(
      `INSERT INTO band_songs (song_id, share_id, song, print, shared_by, local_id, shared_at, updated_by, updated_at, rev, sent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      songId,
      shareId,
      songText(share.song),
      share.print,
      userId,
      share.localId,
      now,
      userId,
      now,
      share.sentId,
    );
    return songOf(band.sql, songRow(band.sql, songId), userId);
  },

  shareSetlist(band: RoomStore, userId: string, fields: SetlistShare, now: number, from: Chain | null = null): BandSetlist {
    inRoom(band.sql, userId);
    bandSongsOnly(band.sql, fields.songIds);
    const setlistId = newId("setlist");
    const shareId = adopt(band.sql, `${band.bandId}/${setlistId}`, userId, from, fields.choice);
    band.sql.exec(
      `INSERT INTO band_setlists (setlist_id, share_id, name, song_ids, tags, shared_by, local_id, shared_at, updated_by, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      setlistId,
      shareId,
      fields.name,
      JSON.stringify(fields.songIds),
      JSON.stringify(fields.tags),
      userId,
      fields.localId,
      now,
      userId,
      now,
    );
    return setlistOf(band.sql, setlistRow(band.sql, setlistId), userId);
  },

  /** `change` is null when the share rule refused the new chart. The base rev is still checked, so a stale edit always hears `changed`. */
  editSong(band: RoomStore, userId: string, songId: string, base: number, change: SongChange | null, now: number): Saved<StoredBandSong> {
    const row = editable(band, userId, songRow(band.sql, songId));
    if (row.rev !== base || !change) return { item: songOf(band.sql, row, userId), changed: row.rev !== base };
    band.sql.exec(`UPDATE band_songs SET song = ?, print = ?, updated_by = ?, updated_at = ?, rev = rev + 1 WHERE song_id = ?`, songText(change.song), change.print, userId, now, songId);
    return { item: songOf(band.sql, songRow(band.sql, songId), userId), changed: false };
  },

  editSetlist(band: RoomStore, userId: string, setlistId: string, base: number, fields: SetlistFields, now: number): Saved<BandSetlist> {
    const row = editable(band, userId, setlistRow(band.sql, setlistId));
    if (row.rev !== base) return { item: setlistOf(band.sql, row, userId), changed: true };
    bandSongsOnly(band.sql, fields.songIds);
    band.sql.exec(
      `UPDATE band_setlists SET name = ?, song_ids = ?, tags = ?, updated_by = ?, updated_at = ?, rev = rev + 1 WHERE setlist_id = ?`,
      fields.name,
      JSON.stringify(fields.songIds),
      JSON.stringify(fields.tags),
      userId,
      now,
      setlistId,
    );
    return { item: setlistOf(band.sql, setlistRow(band.sql, setlistId), userId), changed: false };
  },

  /** What a member holds of a band setlist, so a code for it follows the same rule as passing it on. */
  setlistHolding(band: RoomStore, userId: string, setlistId: string): Chain {
    inRoom(band.sql, userId);
    const row = setlistRow(band.sql, setlistId);
    if (!row) throw refused("not-found");
    return holding(band.sql, row, userId);
  },

  /** A band setlist code opens only for someone who could already see the setlist. Guests on its gig join them with C21c. */
  openByCode(band: RoomStore, userId: string, setlistId: string) {
    if (shutOut(band.sql, userId)) throw refused("not-in-band");
    if (!setlistRow(band.sql, setlistId)) throw refused("not-found");
  },

  /**
   * What the caller holds of the band songs that show this chart, except the song being edited. With `takenFrom` (the
   * share ids the caller's own copies came through), only the songs the caller shared or took a copy from; with null, all.
   */
  heldByPrint(band: RoomStore, userId: string, print: string, except: string | null, takenFrom: string[] | null): Chain[] {
    if (shutOut(band.sql, userId)) {
      if (everAGuest(band.sql, userId) && band.sql.exec(`SELECT 1 FROM band_songs WHERE print = ? LIMIT 1`, print).toArray().length) throw refused("guest");
      return [];
    }
    const taken = takenFrom && JSON.stringify(takenFrom);
    return band.sql
      .exec<SongRow>(
        `SELECT * FROM band_songs WHERE print = ? AND song_id IS NOT ? AND (? IS NULL OR shared_by = ? OR share_id IN (SELECT value FROM json_each(?)))`,
        print,
        except,
        taken,
        userId,
        taken,
      )
      .toArray()
      .map((row) => holding(band.sql, row, userId));
  },
};

/** The friend's copy of a song sent in a DM: a node under what the sender holds, or under the sender's own original. */
export function receivedCopy(shareId: string, friendId: string, senderId: string, from: Chain | null, choice: ShareChoice): { chain: Chain; reshareable: boolean } {
  const parent = from ?? [{ id: `orig_${shareId}`, ownerId: senderId, parentId: null, choice: "public" as const }];
  const chain = [{ id: shareId, ownerId: friendId, parentId: parent[0].id, choice }, ...parent];
  return { chain, reshareable: allowed(chain, friendId, "public").ok };
}

/** A copy code's setlist as its owner sent it: the chain it comes from, and each ticked chart with the chain its copy comes from. */
export type SentSetlist = { name: string; chain: Chain; songs: { song: SongContent; print: string; chain: Chain }[] };
export type SetlistSend = { name: string; choice: ShareChoice; from: Chain | null; songs: { song: SongContent; print: string; from: Chain | null }[] };

/** A copy code as one scanner takes it: their own node under the setlist and under each song, all with the owner's choice. */
export function setlistCopyFor(sent: SentSetlist, userId: string) {
  const setlist = nodeFor(sent.chain, userId);
  return {
    setlist,
    songs: sent.songs.map((item) => ({ song: item.song, print: item.print, chain: nodeFor(item.chain, userId) })),
    reshareable: allowed(setlist, userId, "public").ok,
  };
}

export const selfCopies = {
  /** Keeps a copy that arrived from a friend. A node already under this id stays as it was, so a reused id can only fail closed. */
  receive(sql: SqlStorage, chain: Chain, print: string) {
    for (const share of chain) keep(sql, share);
    sql.exec(`INSERT OR IGNORE INTO song_copies (copy_id, print) VALUES (?, ?)`, chain[0].id, print);
  },

  /** Keeps a copy code's charts with a share row for the setlist and each song, and returns the setlist's share id. */
  sendSetlist(sql: SqlStorage, ownerId: string, send: SetlistSend, now: number): string {
    const id = adopt(sql, `sent_${toBase64Url(randomBytes(12))}`, ownerId, send.from, send.choice);
    const songs = send.songs.map((item, index) => ({
      chordpro: songText(item.song),
      print: item.print,
      shareId: adopt(sql, `${id}/${index}`, ownerId, item.from, send.choice),
    }));
    sql.exec(`INSERT INTO setlist_sends (share_id, name, songs, created_at) VALUES (?, ?, ?, ?)`, id, send.name, JSON.stringify(songs), now);
    return id;
  },

  setlistSend(sql: SqlStorage, shareId: string): SentSetlist | null {
    const row = sql.exec<{ name: string; songs: string }>(`SELECT name, songs FROM setlist_sends WHERE share_id = ?`, shareId).toArray()[0];
    if (!row) return null;
    const songs = JSON.parse(row.songs) as { chordpro?: string; song?: unknown; print: string; shareId: string }[];
    return {
      name: row.name,
      chain: selfCopies.held(sql, shareId),
      songs: songs.map((item) => ({
        song: typeof item.chordpro === "string" ? storedSong(item.chordpro) : storedSong(JSON.stringify(item.song)),
        print: item.print,
        chain: selfCopies.held(sql, item.shareId),
      })),
    };
  },

  receiveSetlist(sql: SqlStorage, setlist: Chain, songs: { chain: Chain; print: string }[]) {
    for (const share of setlist) keep(sql, share);
    for (const song of songs) selfCopies.receive(sql, song.chain, song.print);
  },

  held(sql: SqlStorage, copyId: string): Chain {
    const chain = lineage(storeOf(sql), copyId);
    if (!chain) throw refused("not-found");
    return chain;
  },

  /** The named copy with the chart it was made of, the copies showing this chart, and every share id the caller's copies came through. */
  chains(sql: SqlStorage, copyId: string | null, print: string): { named: { chain: Chain; print: string } | null; byPrint: Chain[]; takenFrom: string[] } {
    const chainOf = (id: string) => {
      const chain = lineage(storeOf(sql), id);
      if (!chain) throw refused("lineage_broken");
      return chain;
    };
    const namedRow = copyId === null ? undefined : sql.exec<{ print: string }>(`SELECT print FROM song_copies WHERE copy_id = ?`, copyId).toArray()[0];
    const named = namedRow ? { chain: chainOf(copyId!), print: namedRow.print } : null;
    const byPrint = sql
      .exec<{ copy_id: string }>(`SELECT copy_id FROM song_copies WHERE print = ?`, print)
      .toArray()
      .map((row) => chainOf(row.copy_id));
    const takenFrom = sql
      .exec<{ id: string }>(`SELECT id FROM shares`)
      .toArray()
      .map((row) => row.id);
    return { named, byPrint, takenFrom };
  },
};

const MAX_SONG_CHARS = 12_000;
export const MAX_SETLIST_SONGS = 200;
export const isText = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

export function choiceIn(body: Record<string, unknown>): ShareChoice {
  if (body.choice !== "public" && body.choice !== "private") throw new Refused("choice_required");
  return body.choice;
}

const LINE_FIELDS = ["chords", "lyrics", "bars", "note"] as const;
export const record = (value: unknown) => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

function lineIn(value: unknown): ChartLine {
  const line = record(value);
  if (!line || LINE_FIELDS.some((field) => line[field] !== undefined && typeof line[field] !== "string")) throw new Refused("bad-request");
  return Object.fromEntries(LINE_FIELDS.filter((field) => line[field] !== undefined).map((field) => [field, line[field]]));
}

function sectionIn(value: unknown): ChartSection {
  const section = record(value);
  if (typeof section?.heading !== "string" || !Array.isArray(section.lines)) throw new Refused("bad-request");
  return { heading: section.heading, lines: section.lines.map(lineIn) };
}

const KEY_ROOT = /^[A-G][#b]?$/;
const textOr = (value: unknown) => (typeof value === "string" ? value : "");
const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function songFromObject(raw: Record<string, unknown>, body: ChartSection[]): SongContent {
  const keyRoot = typeof raw.keyRoot === "string" && KEY_ROOT.test(raw.keyRoot) ? raw.keyRoot : "C";
  const keyMode = raw.keyMode === "minor" ? "minor" : "major";
  const kept = Array.isArray(raw.kept) ? raw.kept.filter((line): line is string => typeof line === "string") : [];
  return {
    title: textOr(raw.title),
    artist: textOr(raw.artist),
    keyLabel: typeof raw.keyLabel === "string" ? raw.keyLabel : `${keyRoot} ${keyMode}`,
    keyRoot,
    keyMode,
    keyNote: textOr(raw.keyNote),
    tempo: numberOrNull(raw.tempo),
    tempoNote: textOr(raw.tempoNote),
    timeSignature: textOr(raw.timeSignature),
    officialRuntimeSec: numberOrNull(raw.officialRuntimeSec),
    feel: textOr(raw.feel),
    sourceNote: textOr(raw.sourceNote),
    atAGlance: textOr(raw.atAGlance),
    howToPlay: textOr(raw.howToPlay),
    practiceTip: textOr(raw.practiceTip),
    body,
    ...(kept.length > 0 ? { kept } : {}),
  };
}

function safeLine(value: unknown): ChartLine {
  const line = record(value);
  if (!line) return {};
  return Object.fromEntries(LINE_FIELDS.filter((field) => typeof line[field] === "string").map((field) => [field, line[field]]));
}

function safeBody(value: unknown): ChartSection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const section = record(item);
    return section ? [{ heading: textOr(section.heading), lines: Array.isArray(section.lines) ? section.lines.map(safeLine) : [] }] : [];
  });
}

/** The one writer of a stored song: deterministic ChordPro text. */
export const songText = (song: SongContent): string => songToChordPro(song);

/** The one reader of a stored song column: legacy JSON starts with `{"`, ChordPro text starts with `{title`. Never throws. */
export function storedSong(text: string): SongContent {
  if (typeof text !== "string") return chordProToSong("");
  if (text.startsWith('{"')) {
    try {
      const parsed = record(JSON.parse(text));
      if (parsed) return songFromObject(parsed, safeBody(parsed.body));
    } catch {
      return chordProToSong("");
    }
    return chordProToSong("");
  }
  return chordProToSong(text);
}

/** A legacy song object answered to callers that do not ask for ChordPro, with an empty `bassNotes` list for old builds. */
export type OldSong = SongContent & { bassNotes: [] };
export const oldSong = (song: SongContent): OldSong => ({ ...song, bassNotes: [] });

/** Shapes a stored song column or parsed song into `{ chordpro }` or the legacy object for a reply. */
export function songForCaller(stored: string | SongContent, chordpro: boolean): SentSong | OldSong {
  if (typeof stored === "string") {
    if (chordpro && !stored.startsWith('{"')) return { chordpro: stored };
    const parsed = storedSong(stored);
    return chordpro ? { chordpro: songText(parsed) } : oldSong(parsed);
  }
  return chordpro ? { chordpro: songText(stored) } : oldSong(stored);
}

/** A stored song column as `{ chordpro }`, avoiding a parse when the row is already ChordPro text. */
export const storedChordPro = (stored: string): SentSong => (stored.startsWith('{"') ? { chordpro: songText(storedSong(stored)) } : { chordpro: stored });

/** Reads a song sent in either `{ chordpro }` or the legacy object shape, keeping only the plan's fields. */
export function songIn(value: unknown): SongContent {
  const song = record(value);
  if (!song) throw new Refused("bad-request");
  if ("chordpro" in song) {
    if (typeof song.chordpro !== "string") throw new Refused("bad-request");
    const normalized = normalizeChordPro(song.chordpro);
    if (normalized.length > MAX_SONG_CHARS) throw new Refused("bad-request");
    const parsed = chordProToSong(normalized);
    if (!isText(parsed.title, 200) || songText(parsed).length > MAX_SONG_CHARS) throw new Refused("bad-request");
    return parsed;
  }
  if (!isText(song.title, 200) || typeof song.artist !== "string" || !Array.isArray(song.body)) throw new Refused("bad-request");
  const parsed = songFromObject(song, song.body.map(sectionIn));
  if (songText(parsed).length > MAX_SONG_CHARS && JSON.stringify(song).length > MAX_SONG_CHARS) throw new Refused("bad-request");
  return parsed;
}

const localIdIn = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : null);
const idIn = (value: unknown) => {
  if (typeof value !== "string" || value.length > 64) throw new Refused("bad-request");
  return value;
};
const baseIn = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Refused("bad-request");
  return value as number;
};

export function setlistIn(body: Record<string, unknown>): SetlistFields {
  const { name, songIds, tags } = body;
  if (!isText(name, 60)) throw new Refused("bad-name");
  if (!Array.isArray(songIds) || songIds.length > MAX_SETLIST_SONGS || !Array.isArray(tags) || tags.length > 8 || !tags.every((tag) => isText(tag, 24))) throw new Refused("bad-request");
  return { name: (name as string).trim(), songIds: songIds.map(idIn), tags: tags.map((tag: string) => tag.trim()) };
}

/** A one-way code of the chart as a sheet shows it, so changes that never show (spacing at line ends, empty lines) give the same code. */
export async function printOf(song: SongContent): Promise<string> {
  const shown = song.body
    .map((section) => [section.heading.trim(), section.lines.map((line) => LINE_FIELDS.map((field) => line[field]?.trimEnd() ?? "")).filter((fields) => fields.some(Boolean))] as const)
    .filter(([heading, lines]) => heading || lines.length > 0);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(shown)));
  return toBase64Url(new Uint8Array(digest));
}

export const selfRoom = (c: Context, userId: string) => c.env.ROOM.getByName(selfRoomId(userId));

let commonPrints: Promise<Set<string>> | undefined;

/**
 * Every phone ships the built-in library, and every chart with nothing shown yet (a sheet started from the song catalog)
 * prints the same, so holding one of these says nothing about where a player got it.
 */
async function isCommon(print: string) {
  commonPrints ??= Promise.all([...seedLibrary.songs, { body: [] }].map((song) => printOf(song as SongContent))).then((prints) => new Set(prints));
  return (await commonPrints).has(print);
}

/**
 * The server's share rule for a chart the phone sends, judged by lineage, never by who else has the same chart. A copy
 * the phone names must allow it, and vouches for the chart it was made of. Otherwise the caller's copies of this chart
 * and the band songs they shared or took a copy from that show it must include one that allows it; a chart the caller
 * holds none of is their own original. A named copy sent with another chart vouches for nothing more, so every band song
 * the caller can see with that chart counts. A built-in or empty chart is only ever judged by a named copy. Returns the
 * chain the new copy comes from, or null for the caller's own original.
 */
export async function guardContent(c: Context, userId: string, print: string, choice: ShareChoice, copyId: string | null, except: string | null): Promise<Chain | null> {
  const mine = await fromRoom(selfRoom(c, userId).copyChains(copyId, print));
  const verdict = (chain: Chain) => allowed(chain, userId, choice);
  if (copyId !== null && !mine.named) throw new Refused("not_found", 404);
  if (mine.named) mustAllow(mine.named.chain, userId, choice);
  if (mine.named?.print === print || (await isCommon(print))) return mine.named?.chain ?? null;
  const takenFrom = mine.named ? null : mine.takenFrom;
  const inBands = await Promise.all([...bandIdsOf(c.sql, userId), ...guestBandIdsOf(c.sql, userId)].map((bandId) => fromRoom(roomOf(c, bandId).heldByPrint(userId, print, except, takenFrom))));
  const held = [...mine.byPrint, ...inBands.flat()];
  const allowing = held.find((chain) => verdict(chain).ok);
  if (held.length > 0 && !allowing) mustAllow(held[0], userId, choice);
  return mine.named?.chain ?? allowing ?? null;
}

/** A band setlist code is for a member who may pass the setlist on, so a Private one stays with whoever shared it. */
export async function bandSetlistTarget(c: Context, user: User) {
  const bandId = bandIdIn(c.body);
  const setlistId = idIn(c.body.setlistId);
  mustAllow(await fromRoom(roomOf(c, bandId).bandSetlistHolding(user.user_id, setlistId)), user.user_id, "public");
  return { targetId: `${bandId}/${setlistId}` };
}

const MAX_CODE_SONGS = 40;

/**
 * A copy code for the caller's own setlist holds only the songs they ticked, after they picked Private or Public. A
 * named setlist copy, and each chart through `guardContent`, must be one the caller may pass on with that choice.
 */
export async function mySetlistTarget(c: Context, user: User) {
  const choice = choiceIn(c.body);
  const { name, songs, setlistCopyId } = c.body;
  if (!isText(name, 60)) throw new Refused("bad-name");
  if (!Array.isArray(songs) || songs.length < 1 || songs.length > MAX_CODE_SONGS) throw new Refused("bad-request");
  const self = selfRoom(c, user.user_id);
  const from = setlistCopyId === null || setlistCopyId === undefined ? null : await fromRoom(self.heldChain(idIn(setlistCopyId)));
  if (from) mustAllow(from, user.user_id, choice);
  const picked = await Promise.all(
    songs.map(async (value) => {
      const item = record(value);
      if (!item) throw new Refused("bad-request");
      const song = songIn(item.song);
      const print = await printOf(song);
      return { song, print, from: await guardContent(c, user.user_id, print, choice, item.copyId === null || item.copyId === undefined ? null : idIn(item.copyId), null) };
    }),
  );
  return { targetId: await self.sendSetlist(user.user_id, { name: (name as string).trim(), choice, from, songs: picked }, c.now) };
}

const refusalOf = (rule: Promise<unknown>) =>
  rule.then(
    () => null,
    (error) => {
      if (error instanceof Refused) return error;
      throw error;
    },
  );

function saved<T>({ item, changed }: Saved<T>): { body: T } {
  if (changed) throw new Refused("changed", 409, { current: item });
  return { body: item };
}

const shapeBandSong = (item: StoredBandSong, chordpro: boolean) => ({ ...item, song: songForCaller(item.song, chordpro) });

export const LIBRARY_ROUTES: Record<string, Route> = {
  async "POST /api/bands/library"(c) {
    const bandId = bandIdIn(c.body);
    const chordpro = wantsChordPro(c.request);
    const lib = await fromRoom(roomOf(c, bandId).bandLibrary(signedIn(c).user_id));
    return { body: { ...lib, songs: lib.songs.map((item) => shapeBandSong(item, chordpro)) } };
  },

  async "POST /api/bands/library/share-song"(c) {
    const bandId = bandIdIn(c.body);
    const userId = signedIn(c).user_id;
    await fromRoom(roomOf(c, bandId).requireMember(userId));
    const choice = choiceIn(c.body);
    const song = songIn(c.body.song);
    const print = await printOf(song);
    const sentId = c.body.shareId === undefined ? null : idIn(c.body.shareId);
    const from = await guardContent(c, userId, print, choice, c.body.copyId === undefined ? null : idIn(c.body.copyId), null);
    const item = await fromRoom(roomOf(c, bandId).shareSong(userId, { song, print, localId: localIdIn(c.body.localId), choice, sentId }, from, c.now));
    return { body: shapeBandSong(item, wantsChordPro(c.request)) };
  },

  async "POST /api/bands/library/share-setlist"(c) {
    const bandId = bandIdIn(c.body);
    const userId = signedIn(c).user_id;
    await fromRoom(roomOf(c, bandId).requireMember(userId));
    const fields = { ...setlistIn(c.body), localId: localIdIn(c.body.localId), choice: choiceIn(c.body) };
    return { body: await fromRoom(roomOf(c, bandId).shareSetlist(userId, fields, c.now)) };
  },

  async "POST /api/bands/library/edit-song"(c) {
    const bandId = bandIdIn(c.body);
    const songId = idIn(c.body.songId);
    const base = baseIn(c.body.base);
    const song = songIn(c.body.song);
    const userId = signedIn(c).user_id;
    const print = await printOf(song);
    await fromRoom(roomOf(c, bandId).requireMember(userId));
    const refusal = await refusalOf(guardContent(c, userId, print, "public", null, songId));
    const result = await fromRoom(roomOf(c, bandId).editBandSong(userId, songId, base, refusal ? null : { song, print }, c.now));
    if (refusal && !result.changed) throw refusal;
    return saved({ item: shapeBandSong(result.item, wantsChordPro(c.request)), changed: result.changed });
  },

  async "POST /api/bands/library/edit-setlist"(c) {
    const bandId = bandIdIn(c.body);
    const setlistId = idIn(c.body.setlistId);
    const base = baseIn(c.body.base);
    const fields = setlistIn(c.body);
    return saved(await fromRoom(roomOf(c, bandId).editBandSetlist(signedIn(c).user_id, setlistId, base, fields, c.now)));
  },

  async "POST /api/bands/setlist-code"(c) {
    const row = await liveCode(c.sql, c.env, c.body.code, c.now, { kind: "band-setlist", refusal: "not-a-setlist-code" });
    const [bandId, setlistId] = row.target_id.split("/");
    await fromRoom(roomOf(c, bandId).openSetlistByCode(signedIn(c).user_id, setlistId));
    return { body: { bandId, setlistId } };
  },

  /** Band songs stay in the band (t814u): nothing copies one out into a player's own songs. */
  async "POST /api/bands/library/copy-song"(c) {
    signedIn(c);
    throw new Refused("band-only", 403);
  },
};
