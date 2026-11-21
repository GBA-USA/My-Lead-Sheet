import { NOTE_MAX_CHARS, type NoteList, type SongNote } from "../src/song-notes-model";
import { randomBytes, toBase64Url } from "./bytes";
import { signedIn, who, type Person, type Route } from "./directory-http";
import { deliver } from "./directory-inbox";
import { fromRoom, Refused, roomRefused as refused } from "./refused";
import { chatRoom, type Posted } from "./room-chat";
import { isText } from "./room-library";
import { bandIdIn, bandRoom, inRoom, roomOf, type RoomStore } from "./room-members";

type NoteRow = { note_id: string; song_id: string; author: string; author_name: string; body: string; created_at: number; deleted_at: number | null };

/** A note as the band file carries it. `songId` is the file's song id, and `authorName` is text, since the writer's account is not on the other deployment. */
export type MovedNote = { id: string; songId: string; authorName: string; body: string; createdAt: number };

export type NoteFields = { noteId: string; songId: string; body: string };

/** The id a phone gives a note so a retry after a lost reply stores it once. An imported note's id holds a `/`, so the two never meet. */
const PHONE_NOTE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_NOTE_ID = 300;

export function createNoteTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS song_notes (
    note_id TEXT PRIMARY KEY, song_id TEXT NOT NULL, author TEXT NOT NULL, author_name TEXT NOT NULL,
    body TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS song_notes_by_song ON song_notes (song_id, created_at)`);
}

const noteOf = (row: NoteRow): SongNote => ({ noteId: row.note_id, songId: row.song_id, authorName: row.author_name, body: row.body, createdAt: row.created_at });
const noteRow = (sql: SqlStorage, noteId: string) => sql.exec<NoteRow>(`SELECT * FROM song_notes WHERE note_id = ?`, noteId).toArray()[0];

/** The band song's title, or `not-found` for an id the band doesn't hold. */
function bandSongTitle(sql: SqlStorage, songId: string): string {
  const row = sql.exec<{ song: string }>(`SELECT song FROM band_songs WHERE song_id = ?`, songId).toArray()[0];
  if (!row) throw refused("not-found");
  return (JSON.parse(row.song) as { title: string }).title;
}

/** Every user id here is trusted: only the Directory calls these, after it has checked the session. Members read; only an admin writes (t40s3). */
export const noteRoom = {
  list(band: RoomStore, userId: string, songId: string): NoteList {
    const { me } = inRoom(band.sql, userId);
    bandSongTitle(band.sql, songId);
    const notes = band.sql
      .exec<NoteRow>(`SELECT * FROM song_notes WHERE song_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC`, songId)
      .toArray()
      .map(noteOf);
    return { notes, canWrite: me.role === "admin" };
  },

  /**
   * Stores the note and posts "<author> added a note to <title>" in the band chat as a band-song line under the note's
   * id, so the same `noteId` again stores neither twice. A note id already used by another author or song is refused.
   */
  add(band: RoomStore, author: Person, fields: NoteFields, now: number): { note: SongNote; posted: Posted } {
    bandRoom.requireAdmin(band, author.userId);
    const title = bandSongTitle(band.sql, fields.songId);
    const held = noteRow(band.sql, fields.noteId);
    if (held && (held.author !== author.userId || held.song_id !== fields.songId)) throw refused("not-allowed");
    if (!held) {
      band.sql.exec(
        `INSERT INTO song_notes (note_id, song_id, author, author_name, body, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        fields.noteId,
        fields.songId,
        author.userId,
        author.name,
        fields.body,
        now,
      );
    }
    const posted = chatRoom.post(band, author, fields.noteId, `${author.name} added a note to ${title}`, now, { kind: "band-song", ref: fields.songId });
    return { note: noteOf(noteRow(band.sql, fields.noteId)), posted };
  },

  /** A soft delete: the row stays for a later undo, and the list and the band file skip it. Deleting again answers the same. */
  remove(band: RoomStore, userId: string, noteId: string, now: number): { ok: true } {
    bandRoom.requireAdmin(band, userId);
    if (!noteRow(band.sql, noteId)) throw refused("not-found");
    band.sql.exec(`UPDATE song_notes SET deleted_at = ? WHERE note_id = ? AND deleted_at IS NULL`, now, noteId);
    return { ok: true };
  },
};

/** The live notes on band songs, oldest first, for the band file. */
export const movedNotes = (sql: SqlStorage): MovedNote[] =>
  sql
    .exec<NoteRow>(`SELECT * FROM song_notes WHERE deleted_at IS NULL AND song_id IN (SELECT song_id FROM band_songs) ORDER BY created_at, rowid`)
    .toArray()
    .map((row) => ({ id: row.note_id, songId: row.song_id, authorName: row.author_name, body: row.body, createdAt: row.created_at }));

/** Keeps an imported note under `noteId`, made from the source's ids, so importing the same file again adds nothing. The importing admin stands as its author. */
export function keepMovedNote(sql: SqlStorage, noteId: string, songId: string, adminId: string, note: MovedNote) {
  sql.exec(
    `INSERT OR IGNORE INTO song_notes (note_id, song_id, author, author_name, body, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    noteId,
    songId,
    adminId,
    note.authorName,
    note.body,
    note.createdAt,
  );
}

const songIdIn = (value: unknown) => {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) throw new Refused("bad-request");
  return value;
};

function noteIdIn(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_NOTE_ID) throw new Refused("bad-request");
  return value;
}

function phoneNoteIdIn(value: unknown): string {
  if (value === undefined) return `note_${toBase64Url(randomBytes(16))}`;
  if (typeof value !== "string" || !PHONE_NOTE_ID.test(value)) throw new Refused("bad-request");
  return value;
}

function bodyIn(value: unknown): string {
  if (!isText(value, NOTE_MAX_CHARS)) throw new Refused("bad-request");
  return (value as string).trim();
}

export const NOTE_ROUTES: Record<string, Route> = {
  async "POST /api/bands/notes/list"(c) {
    const bandId = bandIdIn(c.body);
    return { body: await fromRoom(roomOf(c, bandId).songNotes(signedIn(c).user_id, songIdIn(c.body.songId))) };
  },

  async "POST /api/bands/notes/add"(c) {
    const bandId = bandIdIn(c.body);
    const fields = { noteId: phoneNoteIdIn(c.body.noteId), songId: songIdIn(c.body.songId), body: bodyIn(c.body.body) };
    const { note, posted } = await fromRoom(roomOf(c, bandId).addSongNote(who(signedIn(c)), fields, c.now));
    deliver(c, bandId, posted);
    return { body: note };
  },

  async "POST /api/bands/notes/delete"(c) {
    const bandId = bandIdIn(c.body);
    return { body: await fromRoom(roomOf(c, bandId).deleteSongNote(signedIn(c).user_id, noteIdIn(c.body.noteId), c.now)) };
  },
};
