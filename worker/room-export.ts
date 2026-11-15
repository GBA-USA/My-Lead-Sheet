import type { SongContent } from "../src/band-library-model";
import { signedIn, type Route } from "./directory-http";
import { fromRoom, readJsonObject, Refused, roomRefused as refused } from "./refused";
import { bandLibrary, isText, printOf, record, setlistIn, songIn, storeOf } from "./room-library";
import { bandIdIn, bandRoom, roomOf, type RoomStore } from "./room-members";
import { lineage, type ShareChoice, type StoredShare } from "./share-guard";

/**
 * A band's songs and setlists as the file an admin downloads on one deployment and imports into a band on another.
 * `exportedFrom` is "<APP_ORIGIN>/<bandId>", the source deployment and band; with each item's `id` it is the key an
 * import dedupes on, never the chart. `share.choice` is "private" when the band's share or any share above it is
 * Private, the same walk `checkSend` makes, so the file never says Public of an item the source band could not send
 * on. `share.parentId` is the source's record only, since that share row is not on
 * the importing deployment. On import every item hangs under two share rows the importing admin owns, one for the
 * source band and one per item carrying its `choice`, so a Private share stays unsendable by everyone here, the
 * importing admin included. Band timing rows do not exist yet (PLAN.md 4 says "Band timing" comes later), so
 * `versions` is always empty, has no type to name until then, and members' private versions, which live only on their
 * phones and backups, never enter the file.
 */
export type MovedShare = { choice: ShareChoice; parentId: string | null };
export type MovedSong = { id: string; share: MovedShare; song: SongContent; versions: unknown[] };
export type MovedSetlist = { id: string; name: string; songIds: string[]; tags: string[]; share: MovedShare };
export type BandFile = { exportedFrom: string; exportedAt: string; band: { name: string }; songs: MovedSong[]; setlists: MovedSetlist[] };

export type Counted = { added: number; skipped: number };
export type Imported = { songs: Counted; setlists: Counted };

const MAX_FILE_CHARS = 4_000_000;

export const sourceOf = (origin: string | undefined, bandId: string) => `${origin ?? ""}/${bandId}`;

type SongRow = { song_id: string; share_id: string; song: string };
type SetlistRow = { setlist_id: string; share_id: string; name: string; song_ids: string; tags: string };

function shareOf(sql: SqlStorage, shareId: string): MovedShare {
  const chain = lineage(storeOf(sql), shareId);
  if (!chain) throw refused("lineage_broken");
  return { choice: chain.some((share) => share.choice === "private") ? "private" : "public", parentId: chain[0].parentId };
}

export function exportBand(band: RoomStore, adminId: string, origin: string | undefined, now: number): BandFile {
  bandRoom.requireAdmin(band, adminId);
  const { sql } = band;
  return {
    exportedFrom: sourceOf(origin, band.bandId),
    exportedAt: new Date(now).toISOString(),
    band: { name: bandRoom.pack(band, adminId).name },
    songs: sql
      .exec<SongRow>(`SELECT song_id, share_id, song FROM band_songs ORDER BY shared_at, song_id`)
      .toArray()
      .map((row) => ({ id: row.song_id, share: shareOf(sql, row.share_id), song: JSON.parse(row.song), versions: [] })),
    setlists: sql
      .exec<SetlistRow>(`SELECT setlist_id, share_id, name, song_ids, tags FROM band_setlists ORDER BY shared_at, setlist_id`)
      .toArray()
      .map((row) => ({ id: row.setlist_id, name: row.name, songIds: JSON.parse(row.song_ids), tags: JSON.parse(row.tags), share: shareOf(sql, row.share_id) })),
  };
}

const badFile = () => new Refused("bad-file");

function textIn(value: unknown, max: number): string {
  if (!isText(value, max)) throw badFile();
  return value as string;
}

function shareIn(value: unknown): MovedShare {
  const share = record(value);
  if (!share || (share.choice !== "public" && share.choice !== "private") || (share.parentId !== null && typeof share.parentId !== "string")) throw badFile();
  return { choice: share.choice, parentId: share.parentId };
}

function distinct(ids: string[]) {
  if (new Set(ids).size !== ids.length) throw badFile();
}

function fileIn(body: Record<string, unknown>): BandFile {
  const band = record(body.band);
  if (!band || !Array.isArray(body.songs) || !Array.isArray(body.setlists)) throw badFile();
  const songs = body.songs.map((value): MovedSong => {
    const item = record(value);
    if (!item || !Array.isArray(item.versions)) throw badFile();
    return { id: textIn(item.id, 64), share: shareIn(item.share), song: songIn(item.song), versions: [] };
  });
  distinct(songs.map((song) => song.id));
  const songIds = new Set(songs.map((song) => song.id));
  const setlists = body.setlists.map((value): MovedSetlist => {
    const item = record(value);
    if (!item) throw badFile();
    const fields = setlistIn(item);
    if (!fields.songIds.every((id) => songIds.has(id))) throw badFile();
    return { id: textIn(item.id, 64), ...fields, share: shareIn(item.share) };
  });
  distinct(setlists.map((setlist) => setlist.id));
  return { exportedFrom: textIn(body.exportedFrom, 200), exportedAt: textIn(body.exportedAt, 40), band: { name: textIn(band.name, 60) }, songs, setlists };
}

/** The local id of the item already imported under `movedId`, the share row that stands for the item in its source band. */
const heldAs = (sql: SqlStorage, table: "band_songs" | "band_setlists", column: "song_id" | "setlist_id", movedId: string) =>
  sql.exec<{ id: string }>(`SELECT ${column} AS id FROM ${table} WHERE share_id IN (SELECT id FROM shares WHERE parent_id = ?)`, movedId).toArray()[0]?.id;

function importBand(storage: DurableObjectStorage, band: RoomStore, adminId: string, origin: string | undefined, file: BandFile, prints: string[], now: number): Imported {
  bandRoom.requireAdmin(band, adminId);
  if (file.exportedFrom === sourceOf(origin, band.bandId)) throw new Refused("own-file");
  return storage.transactionSync(() => {
    const { sql } = band;
    const root: StoredShare = { id: file.exportedFrom, ownerId: adminId, parentId: null, choice: "public" };
    const movedId = (id: string) => `${file.exportedFrom}/${id}`;
    const from = (id: string, choice: ShareChoice): StoredShare[] => [{ id: movedId(id), ownerId: adminId, parentId: root.id, choice }, root];
    const counts: Imported = { songs: { added: 0, skipped: 0 }, setlists: { added: 0, skipped: 0 } };
    const localIds = new Map<string, string>();
    file.songs.forEach((item, index) => {
      const held = heldAs(sql, "band_songs", "song_id", movedId(item.id));
      if (held) {
        counts.songs.skipped += 1;
        localIds.set(item.id, held);
        return;
      }
      const share = { song: item.song, print: prints[index], localId: null, choice: item.share.choice, sentId: movedId(item.id) };
      localIds.set(item.id, bandLibrary.shareSong(band, adminId, share, from(item.id, item.share.choice), now).songId);
      counts.songs.added += 1;
    });
    for (const item of file.setlists) {
      if (heldAs(sql, "band_setlists", "setlist_id", movedId(item.id))) {
        counts.setlists.skipped += 1;
        continue;
      }
      const fields = { name: item.name, songIds: item.songIds.map((id) => localIds.get(id)!), tags: item.tags, localId: null, choice: item.share.choice };
      bandLibrary.shareSetlist(band, adminId, fields, now, from(item.id, item.share.choice));
      counts.setlists.added += 1;
    }
    return counts;
  });
}

/** `POST /api/rooms/<bandId>` with a band file as the body. It comes to the Room directly because the Directory caps a body at 16 KB and a band file is bigger. */
export async function importBandFile(request: Request, storage: DurableObjectStorage, band: RoomStore, userId: string, origin: string | undefined): Promise<Response> {
  try {
    let file: BandFile;
    try {
      file = fileIn(await readJsonObject(request, MAX_FILE_CHARS));
    } catch (error) {
      throw error instanceof Refused && error.status === 400 ? badFile() : error;
    }
    const prints = await Promise.all(file.songs.map((item) => printOf(item.song)));
    return Response.json(importBand(storage, band, userId, origin, file, prints, Date.now()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Refused) return Response.json({ error: error.reason }, { status: error.status });
    throw error;
  }
}

export const EXPORT_ROUTES: Record<string, Route> = {
  async "GET /api/bands/export"(c) {
    const bandId = bandIdIn({ bandId: new URL(c.request.url).searchParams.get("bandId") });
    return { body: await fromRoom(roomOf(c, bandId).exportBand(signedIn(c).user_id, c.now)) };
  },
};
