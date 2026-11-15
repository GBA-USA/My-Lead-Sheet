import type { ChatKind, ChatMessage } from "../src/chat-model";
import type { Person } from "./directory-http";
import { inRoom, type RoomStore } from "./room-members";

const MAX_THREAD_PAGE = 500;

type MessageRow = { seq: number; msg_id: string; author: string; author_name: string; body: string; created_at: number };

export function createChatTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id TEXT NOT NULL,
    author TEXT NOT NULL,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (author, msg_id)
  )`);
}

const toMessage = (row: MessageRow): ChatMessage => ({ seq: row.seq, msgId: row.msg_id, fromId: row.author, fromName: row.author_name, text: row.body, at: row.created_at });

/** What the Directory needs after a post: the stored message, whether this call stored it, and whose chat lists to update. */
export type Posted = { message: ChatMessage; stored: boolean; kind: ChatKind; title: string; members: Person[] };

/** Every user id here is trusted: only the Directory calls these, after it has checked the session and, for a DM, the pair. */
export const chatRoom = {
  /** Makes the DM room for two people, or leaves the one already there alone. */
  createDm({ sql }: RoomStore, people: [Person, Person], now: number) {
    if (sql.exec(`SELECT 1 FROM meta WHERE id = 1`).toArray().length) return;
    sql.exec(`INSERT INTO meta (id, kind, name, created_by, created_at) VALUES (1, 'dm', '', ?, ?)`, people[0].userId, now);
    for (const person of people) {
      sql.exec(`INSERT INTO members (user_id, role, state, joined_at, changed_at, display_name) VALUES (?, 'member', 'active', ?, ?, ?)`, person.userId, now, now, person.name);
    }
  },

  /** The newest messages past `after`, oldest first, so a thread opens on its latest page and a reconnect fills the gap. */
  messages({ sql }: RoomStore, userId: string, after: number): ChatMessage[] {
    inRoom(sql, userId);
    return sql
      .exec<MessageRow>(`SELECT * FROM (SELECT * FROM messages WHERE seq > ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`, after, MAX_THREAD_PAGE)
      .toArray()
      .map(toMessage);
  },

  /** Stores the message under the phone's `msgId`. The same id again from the same author stores nothing and returns the first copy. */
  post({ sql }: RoomStore, author: Person, msgId: string, text: string, now: number): Posted {
    const { meta } = inRoom(sql, author.userId);
    const mine = () => sql.exec<MessageRow>(`SELECT * FROM messages WHERE author = ? AND msg_id = ?`, author.userId, msgId).toArray()[0];
    const stored = mine() === undefined;
    if (stored) sql.exec(`INSERT INTO messages (msg_id, author, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)`, msgId, author.userId, author.name, text, now);
    const message = toMessage(mine()!);
    const members = sql
      .exec<{ user_id: string; display_name: string }>(`SELECT user_id, display_name FROM members WHERE state = 'active'`)
      .toArray()
      .map((row): Person => ({ userId: row.user_id, name: row.display_name }));
    return { message, stored, kind: meta.kind, title: meta.name, members };
  },
};
