import type { BandLibrary, BandSetlist, BandSong, CopiedSong, SongContent } from "../src/band-library-model";
import type { ChartLine, ChartSection } from "../src/types";
import { randomBytes, toBase64Url } from "./bytes";
import { signedIn, type Context, type Route } from "./directory-http";
import { Refused } from "./refused";
import { selfRoomId } from "./room-backup";
import { bandIdIn, bandIdsOf, fromRoom, inBand, refused, roomOf, shutOut, type Band } from "./room-members";
import { checkSend, lineage, type ShareChoice, type StoredShare } from "./share-guard";

type Shared = { share_id: string; shared_by: string; local_id: number | null; shared_at: number; updated_by: string; updated_at: number; rev: number };
type SongRow = Shared & { song_id: string; song: string; print: string };
type SetlistRow = Shared & { setlist_id: string; name: string; song_ids: string; tags: string };
type ShareRow = { id: string; owner_id: string; parent_id: string | null; choice: ShareChoice };

/** A chain from `lineage`: the copy the caller would send first, then each copy it came from, back to an original. */
type Chain = StoredShare[];

type Saved<T> = { item: T; changed: boolean };

export function createLibraryTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, parent_id TEXT, choice TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS band_songs (
    song_id TEXT PRIMARY KEY, share_id TEXT NOT NULL, song TEXT NOT NULL, print TEXT NOT NULL,
    shared_by TEXT NOT NULL, local_id INTEGER, shared_at INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS band_songs_by_print ON band_songs (print)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS band_setlists (
    setlist_id TEXT PRIMARY KEY, share_id TEXT NOT NULL, name TEXT NOT NULL, song_ids TEXT NOT NULL, tags TEXT NOT NULL,
    shared_by TEXT NOT NULL, local_id INTEGER, shared_at INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS song_copies (copy_id TEXT PRIMARY KEY, print TEXT NOT NULL)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS song_copies_by_print ON song_copies (print)`);
}

const newId = (prefix: string) => `${prefix}_${toBase64Url(randomBytes(16))}`;

function storeOf(sql: SqlStorage) {
  return (id: string): StoredShare | undefined => {
    const row = sql.exec<ShareRow>(`SELECT * FROM shares WHERE id = ?`, id).toArray()[0];
    return row && { id: row.id, ownerId: row.owner_id, parentId: row.parent_id, choice: row.choice };
  };
}

const chainStore = (chain: Chain) => (id: string) => chain.find((share) => share.id === id);

const allowed = (chain: Chain, senderId: string, choice: ShareChoice) => checkSend(chainStore(chain), { senderId, copyId: chain[0].id, choice });

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
 * holds the band's copy, so the choice made when it was shared into the band is the one that applies to them.
 */
function holding(sql: SqlStorage, row: Shared, userId: string): Chain {
  const chain = lineage(storeOf(sql), row.share_id);
  if (!chain) throw refused("lineage_broken");
  return userId === row.shared_by ? chain.slice(1) : [{ ...chain[0], ownerId: userId }, ...chain.slice(1)];
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

const memberNames = (sql: SqlStorage) =>
  new Map(
    sql
      .exec<{ user_id: string; display_name: string }>(`SELECT user_id, display_name FROM members`)
      .toArray()
      .map((row) => [row.user_id, row.display_name]),
  );

const songOf = (sql: SqlStorage, row: SongRow, userId: string, names = memberNames(sql)): BandSong => ({ songId: row.song_id, song: JSON.parse(row.song), ...sharedFields(sql, row, userId, names) });

const setlistOf = (sql: SqlStorage, row: SetlistRow, userId: string, names = memberNames(sql)): BandSetlist => ({
  setlistId: row.setlist_id,
  name: row.name,
  songIds: JSON.parse(row.song_ids),
  tags: JSON.parse(row.tags),
  ...sharedFields(sql, row, userId, names),
});

const songRow = (sql: SqlStorage, songId: string) => sql.exec<SongRow>(`SELECT * FROM band_songs WHERE song_id = ?`, songId).toArray()[0];
const setlistRow = (sql: SqlStorage, setlistId: string) => sql.exec<SetlistRow>(`SELECT * FROM band_setlists WHERE setlist_id = ?`, setlistId).toArray()[0];

function editable<T extends Shared>(band: Band, userId: string, row: T | undefined): T {
  const { me } = inBand(band.sql, userId);
  if (!row) throw refused("not-found");
  if (me.role !== "admin" && row.shared_by !== userId) throw refused("not-yours");
  return row;
}

function bandSongsOnly(sql: SqlStorage, songIds: string[]) {
  for (const id of songIds) if (!songRow(sql, id)) throw refused("not-a-band-song");
}

export type SongShare = { song: SongContent; print: string; localId: number | null; choice: ShareChoice };
export type SetlistFields = { name: string; songIds: string[]; tags: string[] };
export type SetlistShare = SetlistFields & { localId: number | null; choice: ShareChoice };

/** Every user id here is trusted: only the Directory calls these, after it has checked the session and the share rule. */
export const bandLibrary = {
  view(band: Band, userId: string): BandLibrary {
    inBand(band.sql, userId);
    const names = memberNames(band.sql);
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

  requireMember(band: Band, userId: string) {
    inBand(band.sql, userId);
  },

  shareSong(band: Band, userId: string, share: SongShare, from: Chain | null, now: number): BandSong {
    inBand(band.sql, userId);
    const songId = newId("song");
    const shareId = adopt(band.sql, `${band.bandId}/${songId}`, userId, from, share.choice);
    band.sql.exec(
      `INSERT INTO band_songs (song_id, share_id, song, print, shared_by, local_id, shared_at, updated_by, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      songId,
      shareId,
      JSON.stringify(share.song),
      share.print,
      userId,
      share.localId,
      now,
      userId,
      now,
    );
    return songOf(band.sql, songRow(band.sql, songId), userId);
  },

  shareSetlist(band: Band, userId: string, fields: SetlistShare, now: number): BandSetlist {
    inBand(band.sql, userId);
    bandSongsOnly(band.sql, fields.songIds);
    const setlistId = newId("setlist");
    const shareId = adopt(band.sql, `${band.bandId}/${setlistId}`, userId, null, fields.choice);
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

  editSong(band: Band, userId: string, songId: string, base: number, song: SongContent, print: string, now: number): Saved<BandSong> {
    const row = editable(band, userId, songRow(band.sql, songId));
    if (row.rev !== base) return { item: songOf(band.sql, row, userId), changed: true };
    band.sql.exec(`UPDATE band_songs SET song = ?, print = ?, updated_by = ?, updated_at = ?, rev = rev + 1 WHERE song_id = ?`, JSON.stringify(song), print, userId, now, songId);
    return { item: songOf(band.sql, songRow(band.sql, songId), userId), changed: false };
  },

  editSetlist(band: Band, userId: string, setlistId: string, base: number, fields: SetlistFields, now: number): Saved<BandSetlist> {
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

  copyOut(band: Band, userId: string, songId: string): { song: SongContent; print: string; from: Chain } {
    inBand(band.sql, userId);
    const row = songRow(band.sql, songId);
    if (!row) throw refused("not-found");
    return { song: JSON.parse(row.song), print: row.print, from: holding(band.sql, row, userId) };
  },

  /** What the caller holds of every band song with this chart, except the song being edited. */
  heldByPrint(band: Band, userId: string, print: string, except: string | null): Chain[] {
    if (shutOut(band.sql, userId)) return [];
    return band.sql
      .exec<SongRow>(`SELECT * FROM band_songs WHERE print = ? AND song_id IS NOT ?`, print, except)
      .toArray()
      .map((row) => holding(band.sql, row, userId));
  },
};

export const selfCopies = {
  record(sql: SqlStorage, userId: string, from: Chain, print: string): CopiedSong["copy"] {
    const id = adopt(sql, newId("copy"), userId, from, "public");
    sql.exec(`INSERT INTO song_copies (copy_id, print) VALUES (?, ?)`, id, print);
    return { id, canSendOn: allowed([storeOf(sql)(id)!, ...from], userId, "public").ok };
  },

  chains(sql: SqlStorage, copyId: string | null, print: string): { named: Chain | null; byPrint: Chain[] } {
    const chainOf = (id: string) => {
      const chain = lineage(storeOf(sql), id);
      if (!chain) throw refused("lineage_broken");
      return chain;
    };
    const named = copyId !== null && sql.exec(`SELECT 1 FROM song_copies WHERE copy_id = ?`, copyId).toArray().length > 0 ? chainOf(copyId) : null;
    const byPrint = sql
      .exec<{ copy_id: string }>(`SELECT copy_id FROM song_copies WHERE print = ?`, print)
      .toArray()
      .map((row) => chainOf(row.copy_id));
    return { named, byPrint };
  },
};

const MAX_SONG_CHARS = 12_000;
const MAX_SETLIST_SONGS = 200;
const isText = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

function choiceIn(body: Record<string, unknown>): ShareChoice {
  if (body.choice !== "public" && body.choice !== "private") throw new Refused("choice_required");
  return body.choice;
}

const LINE_FIELDS = ["chords", "lyrics", "bars", "note"] as const;
const record = (value: unknown) => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

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

/** The chart keeps only the parts a sheet shows. The other fields ride along as stored, and the phone checks them again when it adds the song. */
function songIn(value: unknown): SongContent {
  const song = record(value);
  if (!song || !isText(song.title, 200) || typeof song.artist !== "string" || !Array.isArray(song.body) || JSON.stringify(song).length > MAX_SONG_CHARS) throw new Refused("bad-request");
  const { ref: _ref, id: _id, copy: _copy, ...content } = song;
  return { ...content, body: song.body.map(sectionIn) } as SongContent;
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

function setlistIn(body: Record<string, unknown>): SetlistFields {
  const { name, songIds, tags } = body;
  if (!isText(name, 60)) throw new Refused("bad-name");
  if (!Array.isArray(songIds) || songIds.length > MAX_SETLIST_SONGS || !Array.isArray(tags) || tags.length > 8 || !tags.every((tag) => isText(tag, 24))) throw new Refused("bad-request");
  return { name: (name as string).trim(), songIds: songIds.map(idIn), tags: tags.map((tag: string) => tag.trim()) };
}

/** A one-way code of the chart as a sheet shows it, so changes that never show (spacing at line ends, empty lines) give the same code. */
async function printOf(song: SongContent): Promise<string> {
  const shown = song.body
    .map((section) => [section.heading.trim(), section.lines.map((line) => LINE_FIELDS.map((field) => line[field]?.trimEnd() ?? "")).filter((fields) => fields.some(Boolean))] as const)
    .filter(([heading, lines]) => heading || lines.length > 0);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(shown)));
  return toBase64Url(new Uint8Array(digest));
}

const selfRoom = (c: Context, userId: string) => c.env.ROOM.getByName(selfRoomId(userId));

/**
 * The server's share rule for a chart the phone sends. The phone may name the copy it is sending, and that copy must
 * allow it. The phone can't hide a copy either: when the caller holds this same chart (a copy in their self room, or a
 * song in one of their bands), one of those must allow sending it on. Returns the chain the new copy comes from, or
 * null for the caller's own original.
 */
async function guardContent(c: Context, userId: string, print: string, choice: ShareChoice, copyId: string | null, except: string | null): Promise<Chain | null> {
  const [mine, ...inBands] = await Promise.all([
    fromRoom(selfRoom(c, userId).copyChains(copyId, print)),
    ...bandIdsOf(c.sql, userId).map((bandId) => fromRoom(roomOf(c, bandId).heldByPrint(userId, print, except))),
  ]);
  const verdict = (chain: Chain) => allowed(chain, userId, choice);
  const mustAllow = (chain: Chain) => {
    const result = verdict(chain);
    if (!result.ok) throw new Refused(result.code, result.status);
  };
  if (copyId !== null && !mine.named) throw new Refused("not_found", 404);
  if (mine.named) mustAllow(mine.named);
  const held = [...mine.byPrint, ...inBands.flat()];
  const allowing = held.find((chain) => verdict(chain).ok);
  if (held.length > 0 && !allowing) mustAllow(held[0]);
  return mine.named ?? allowing ?? null;
}

function saved<T>({ item, changed }: Saved<T>): { body: T } {
  if (changed) throw new Refused("changed", 409, { current: item });
  return { body: item };
}

export const LIBRARY_ROUTES: Record<string, Route> = {
  async "POST /api/bands/library"(c) {
    const bandId = bandIdIn(c.body);
    return { body: await fromRoom(roomOf(c, bandId).bandLibrary(signedIn(c).user_id)) };
  },

  async "POST /api/bands/library/share-song"(c) {
    const bandId = bandIdIn(c.body);
    const userId = signedIn(c).user_id;
    await fromRoom(roomOf(c, bandId).requireMember(userId));
    const choice = choiceIn(c.body);
    const song = songIn(c.body.song);
    const print = await printOf(song);
    const from = await guardContent(c, userId, print, choice, c.body.copyId === undefined ? null : idIn(c.body.copyId), null);
    return { body: await fromRoom(roomOf(c, bandId).shareSong(userId, { song, print, localId: localIdIn(c.body.localId), choice }, from, c.now)) };
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
    await guardContent(c, userId, print, "public", null, songId);
    return saved(await fromRoom(roomOf(c, bandId).editBandSong(userId, songId, base, song, print, c.now)));
  },

  async "POST /api/bands/library/edit-setlist"(c) {
    const bandId = bandIdIn(c.body);
    const setlistId = idIn(c.body.setlistId);
    const base = baseIn(c.body.base);
    const fields = setlistIn(c.body);
    return saved(await fromRoom(roomOf(c, bandId).editBandSetlist(signedIn(c).user_id, setlistId, base, fields, c.now)));
  },

  async "POST /api/bands/library/copy-song"(c) {
    const bandId = bandIdIn(c.body);
    const songId = idIn(c.body.songId);
    const userId = signedIn(c).user_id;
    const { song, print, from } = await fromRoom(roomOf(c, bandId).copyBandSong(userId, songId));
    const copy = await selfRoom(c, userId).recordCopy(userId, from, print);
    return { body: { song, copy } satisfies CopiedSong };
  },
};
