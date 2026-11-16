import { MAX_MESSAGE_CHARS, previewText, type ChatEntry, type ChatKind } from "../src/chat-model";
import type { SongContent } from "../src/band-library-model";
import type { SetlistCard, SetlistCopy } from "../src/setlist-code-model";
import type { ShareChoice } from "../src/share-rule";
import type { SongData } from "../src/types";
import { randomBytes, toBase64Url } from "./bytes";
import { pairOf } from "./directory-friends";
import { signedIn, userById, who, type Context, type Route, type User } from "./directory-http";
import { fromRoom, Refused } from "./refused";
import type { Posted } from "./room-chat";
import { liveCode } from "./codes";
import { choiceIn, guardContent, printOf, receivedCopy, record, selfRoom, setlistCopyFor, songIn } from "./room-library";

const ROOM_ID = /^(band|dm)_[A-Za-z0-9_-]{22}$/;
const MSG_ID = /^[A-Za-z0-9_-]{8,64}$/;
const PREVIEW_CHARS = 100;

type InboxRow = { user_id: string; room_id: string; kind: ChatKind; title: string; last_seq: number; last_read_seq: number; muted_until: number | null; preview: string; last_at: number };

export function createInboxTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS inbox (
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    muted_until INTEGER,
    preview TEXT NOT NULL DEFAULT '',
    last_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_id)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS dm_index (
    pair_key TEXT PRIMARY KEY,
    room_id TEXT NOT NULL UNIQUE
  )`);
}

/** Puts a thread on someone's Messages list, or renames it there. Counts already on the row stay. */
export function joinInbox(sql: SqlStorage, userId: string, thread: { roomId: string; kind: ChatKind; title: string }, now: number) {
  sql.exec(
    `INSERT INTO inbox (user_id, room_id, kind, title, last_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, room_id) DO UPDATE SET title = excluded.title`,
    userId,
    thread.roomId,
    thread.kind,
    thread.title,
    now,
  );
}

export function leaveInbox(sql: SqlStorage, userId: string, roomId: string) {
  sql.exec(`DELETE FROM inbox WHERE user_id = ? AND room_id = ?`, userId, roomId);
}

const entryOf = (row: InboxRow): ChatEntry => ({ roomId: row.room_id, kind: row.kind, title: row.title, lastSeq: row.last_seq, lastReadSeq: row.last_read_seq, mutedUntil: row.muted_until, preview: row.preview, lastAt: row.last_at });

function roomIdIn(body: Record<string, unknown>): string {
  if (typeof body.roomId !== "string" || !ROOM_ID.test(body.roomId)) throw new Refused("bad-request");
  return body.roomId;
}

function seqIn(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Refused("bad-request");
  return value as number;
}

const SHARE_ID = /^[A-Za-z0-9]{16,64}$/;
const MAX_VERSIONS = 20;

function idOrNull(value: unknown, pattern: RegExp): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !pattern.test(value)) throw new Refused("bad-request");
  return value;
}

/** A timing version as it travels (`ScrollVersion` on the phone, whose file the Worker can't load). The phone checks each again when it adds the song. */
type SentVersion = { name: string; bpm: number; marks: unknown[]; learned?: unknown; tempo?: unknown };

/** The body of `POST /api/chat/send-song`, read. The card keeps everything but `userId`, `choice` and `copyId` (`SongMessage` on the phone). */
type SongSend = { userId: string; msgId: string; shareId: string; song: SongContent; versions: SentVersion[]; data: SongData | null; choice: ShareChoice; copyId: string | null; updateOf: string | null };

function versionIn(value: unknown): SentVersion {
  const version = record(value);
  if (!version || typeof version.name !== "string" || version.name.length < 1 || version.name.length > 80 || typeof version.bpm !== "number" || !Array.isArray(version.marks)) throw new Refused("bad-request");
  const { name, bpm, marks, learned, tempo } = version;
  return { name, bpm, marks, ...(learned === undefined ? {} : { learned }), ...(tempo === undefined ? {} : { tempo }) };
}

function dataIn(value: unknown): SongData | null {
  if (value === null || value === undefined) return null;
  const data = record(value);
  if (!data) throw new Refused("bad-request");
  const kept: SongData = {};
  if (typeof data.officialRuntimeSec === "number") kept.officialRuntimeSec = data.officialRuntimeSec;
  if (typeof data.tempo === "number") kept.tempo = data.tempo;
  if (typeof data.timeSignature === "string") kept.timeSignature = data.timeSignature;
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * A send's body. The share id becomes the friend's copy id, so it has no `_` and can never be a server id. Nothing the
 * phone says about whether the copy may be passed on is read: the server works that out.
 */
function songSendIn(body: Record<string, unknown>): SongSend {
  const choice = choiceIn(body);
  if (typeof body.userId !== "string" || typeof body.msgId !== "string" || !MSG_ID.test(body.msgId) || typeof body.shareId !== "string" || !SHARE_ID.test(body.shareId)) throw new Refused("bad-request");
  if (!Array.isArray(body.versions) || body.versions.length > MAX_VERSIONS) throw new Refused("bad-request");
  return {
    userId: body.userId,
    msgId: body.msgId,
    shareId: body.shareId,
    song: songIn(body.song),
    versions: body.versions.map(versionIn),
    data: dataIn(body.data),
    choice,
    copyId: idOrNull(body.copyId, /^.{1,64}$/),
    updateOf: idOrNull(body.updateOf, SHARE_ID),
  };
}

const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** The person `userId` in the request names, who must have an account and not be the caller. */
function otherIn(c: Context, me: User): User {
  const other = typeof c.body.userId === "string" ? userById(c.sql, c.body.userId) : undefined;
  if (!other) throw new Refused("not-found", 404);
  if (other.user_id === me.user_id) throw new Refused("yourself");
  return other;
}

/**
 * Who may DM whom (PLAN.md 6): friends, and people who are both still in one band. A block closes the DM both ways,
 * and is reported with the same word as not being friends, so it is not revealed.
 */
async function allowDm(c: Context, me: User, other: User) {
  const pair = pairOf(c.sql, me.user_id, other.user_id);
  if (pair?.state === "friends") return;
  if (pair?.state !== "blocked") {
    const shared = c.sql.exec<{ room_id: string }>(`SELECT a.room_id FROM band_rooms a JOIN band_rooms b ON a.room_id = b.room_id WHERE a.user_id = ? AND b.user_id = ?`, me.user_id, other.user_id).toArray();
    for (const { room_id } of shared) {
      const room = c.env.ROOM.getByName(room_id);
      const [mine, theirs] = await Promise.all([room.bandSummary(me.user_id), room.bandSummary(other.user_id)]);
      if (mine && theirs) return;
    }
  }
  throw new Refused("not-friends", 403);
}

/** For a DM room, the caller must be one of its pair and still allowed to talk to the other. A band room checks its own members. */
async function allowRoom(c: Context, me: User, roomId: string) {
  if (!roomId.startsWith("dm_")) return;
  const pair = c.sql.exec<{ pair_key: string }>(`SELECT pair_key FROM dm_index WHERE room_id = ?`, roomId).toArray()[0]?.pair_key.split(":");
  const otherId = pair?.find((id) => id !== me.user_id);
  if (!pair?.includes(me.user_id) || otherId === undefined) throw new Refused("not-a-member", 403);
  const other = userById(c.sql, otherId);
  if (!other) throw new Refused("not-a-member", 403);
  await allowDm(c, me, other);
}

/** The one DM room for this pair: the index row goes in first, so two phones asking at once get the same room. */
async function dmRoomFor(c: Context, me: User, other: User): Promise<string> {
  const key = pairKey(me.user_id, other.user_id);
  c.sql.exec(`INSERT OR IGNORE INTO dm_index (pair_key, room_id) VALUES (?, ?)`, key, `dm_${toBase64Url(randomBytes(16))}`);
  const roomId = c.sql.exec<{ room_id: string }>(`SELECT room_id FROM dm_index WHERE pair_key = ?`, key).one().room_id;
  await fromRoom(c.env.ROOM.getByName(roomId).createDm([who(me), who(other)], c.now));
  joinInbox(c.sql, me.user_id, { roomId, kind: "dm", title: other.display_name }, c.now);
  return roomId;
}

/** Puts a stored post on every member's Messages list: the newest preview, and read up to it for the one who wrote it. */
export function deliver(c: Context, roomId: string, posted: Posted) {
  const { message } = posted;
  const preview = `${message.fromName}: ${previewText(message)}`.slice(0, PREVIEW_CHARS);
  for (const member of posted.members) {
    const title = posted.kind === "band" ? posted.title : (posted.members.find((other) => other.userId !== member.userId)?.name ?? "");
    c.sql.exec(
      `INSERT INTO inbox (user_id, room_id, kind, title, last_seq, last_read_seq, preview, last_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (user_id, room_id) DO UPDATE SET
         title = excluded.title,
         preview = CASE WHEN excluded.last_seq >= inbox.last_seq THEN excluded.preview ELSE inbox.preview END,
         last_seq = max(inbox.last_seq, excluded.last_seq),
         last_read_seq = max(inbox.last_read_seq, excluded.last_read_seq),
         last_at = max(inbox.last_at, excluded.last_at)`,
      member.userId,
      roomId,
      posted.kind,
      title,
      message.seq,
      member.userId === message.fromId ? message.seq : 0,
      preview,
      message.at,
    );
  }
}

export const CHAT_ROUTES: Record<string, Route> = {
  async "GET /api/chat"(c) {
    const rows = c.sql.exec<InboxRow>(`SELECT * FROM inbox WHERE user_id = ? ORDER BY last_at DESC, room_id`, signedIn(c).user_id).toArray();
    return { body: { chats: rows.map(entryOf) } };
  },

  async "POST /api/chat/dm"(c) {
    const me = signedIn(c);
    const other = otherIn(c, me);
    await allowDm(c, me, other);
    return { body: { roomId: await dmRoomFor(c, me, other), title: other.display_name } };
  },

  async "POST /api/chat/open"(c) {
    const roomId = roomIdIn(c.body);
    const after = c.body.after === undefined ? 0 : seqIn(c.body.after);
    const me = signedIn(c);
    await allowRoom(c, me, roomId);
    return { body: { messages: await fromRoom(c.env.ROOM.getByName(roomId).chatMessages(me.user_id, after)) } };
  },

  async "POST /api/chat/send"(c) {
    const roomId = roomIdIn(c.body);
    const text = typeof c.body.text === "string" ? c.body.text.trim() : "";
    if (typeof c.body.msgId !== "string" || !MSG_ID.test(c.body.msgId) || text.length < 1 || text.length > MAX_MESSAGE_CHARS) throw new Refused("bad-request");
    const me = signedIn(c);
    await allowRoom(c, me, roomId);
    const posted = await fromRoom(c.env.ROOM.getByName(roomId).chatPost(who(me), c.body.msgId, text, c.now));
    deliver(c, roomId, posted);
    return { body: { message: posted.message } };
  },

  async "POST /api/chat/send-song"(c) {
    const me = signedIn(c);
    const { msgId, ...send } = songSendIn(c.body);
    const other = otherIn(c, me);
    await allowDm(c, me, other);
    const roomId = await dmRoomFor(c, me, other);
    const print = await printOf(send.song);
    const from = await guardContent(c, me.user_id, print, send.choice, send.copyId, null);
    const copyFor = (shareId: string) => receivedCopy(shareId, other.user_id, me.user_id, from, send.choice);
    const { userId: _to, choice, copyId: _copy, ...shown } = send;
    const body = { ...shown, sharedAs: choice, reshareable: copyFor(send.shareId).reshareable };
    const card = { kind: "song", ref: send.shareId, updateOf: send.updateOf } as const;
    const posted = await fromRoom(c.env.ROOM.getByName(roomId).chatPost(who(me), msgId, JSON.stringify(body), c.now, card));
    await fromRoom(selfRoom(c, other.user_id).receiveCopy(copyFor(posted.message.ref ?? send.shareId).chain, print));
    deliver(c, roomId, posted);
    return { body: { roomId, message: posted.message } };
  },

  /** A friend scans a copy code. The copy arrives as a setlist card from the code's owner in their DM, once however often they scan. */
  async "POST /api/chat/setlist-code"(c) {
    const row = await liveCode(c.sql, c.env, c.body.code, c.now, { kind: "my-setlist", refusal: "not-a-setlist-code" });
    const me = signedIn(c);
    const owner = userById(c.sql, row.created_by);
    if (!owner) throw new Refused("code-stopped", 410);
    if (owner.user_id === me.user_id) throw new Refused("yourself");
    await allowDm(c, me, owner);
    const sent = await fromRoom(selfRoom(c, owner.user_id).setlistSend(row.target_id));
    if (!sent) throw new Refused("code-stopped", 410);
    const { setlist, songs, reshareable } = setlistCopyFor(sent, me.user_id);
    const roomId = await dmRoomFor(c, me, owner);
    const copyId = setlist[0].id;
    const card: SetlistCard = { name: sent.name, titles: sent.songs.map((item) => item.song.title), copyId, sharedAs: setlist[0].choice, reshareable };
    const posted = await fromRoom(c.env.ROOM.getByName(roomId).chatPost(who(owner), copyId, JSON.stringify(card), c.now, { kind: "setlist", ref: copyId }));
    await fromRoom(selfRoom(c, me.user_id).receiveSetlist(setlist, songs));
    deliver(c, roomId, posted);
    return { body: { roomId } };
  },

  /** Add to My Songs on a setlist card: only the scanner, whose own room holds the copy under the owner's code, gets the charts. */
  async "POST /api/chat/setlist-copy"(c) {
    if (typeof c.body.copyId !== "string" || c.body.copyId.length > 64) throw new Refused("bad-request");
    const me = signedIn(c);
    const [mine, code] = await fromRoom(selfRoom(c, me.user_id).heldChain(c.body.copyId));
    const sent = mine.ownerId === me.user_id && code ? await fromRoom(selfRoom(c, code.ownerId).setlistSend(code.id)) : null;
    if (!sent) throw new Refused("not-found", 404);
    const copy = setlistCopyFor(sent, me.user_id);
    if (copy.setlist[0].id !== mine.id) throw new Refused("not-found", 404);
    return { body: { name: sent.name, songs: copy.songs.map((item) => ({ song: item.song, copyId: item.chain[0].id })), reshareable: copy.reshareable } satisfies SetlistCopy };
  },

  async "POST /api/chat/read"(c) {
    const roomId = roomIdIn(c.body);
    const seq = seqIn(c.body.seq);
    c.sql.exec(`UPDATE inbox SET last_read_seq = max(last_read_seq, ?) WHERE user_id = ? AND room_id = ?`, seq, signedIn(c).user_id, roomId);
    return { body: { ok: true } };
  },

  async "POST /api/chat/mute"(c) {
    const roomId = roomIdIn(c.body);
    const until = c.body.mutedUntil === null ? null : seqIn(c.body.mutedUntil);
    const changed = c.sql.exec(`UPDATE inbox SET muted_until = ? WHERE user_id = ? AND room_id = ?`, until, signedIn(c).user_id, roomId).rowsWritten;
    if (changed !== 1) throw new Refused("not-found", 404);
    return { body: { ok: true } };
  },
};
