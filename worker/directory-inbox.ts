import { MAX_MESSAGE_CHARS, type ChatEntry, type ChatKind } from "../src/chat-model";
import { randomBytes, toBase64Url } from "./bytes";
import { pairOf } from "./directory-friends";
import { signedIn, userById, who, type Context, type Route, type User } from "./directory-http";
import { fromRoom, Refused } from "./refused";

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
    const { message } = posted;
    const preview = `${message.fromName}: ${message.text}`.slice(0, PREVIEW_CHARS);
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
    return { body: { message } };
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
