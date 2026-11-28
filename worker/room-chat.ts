import { parseMentions, type ChatKind, type ChatMessage, type MessageKind } from "../src/chat-model";
import type { Person } from "./directory-http";
import { roomRefused as refused } from "./refused";
import { inRoom, type RoomStore } from "./room-members";

const MAX_THREAD_PAGE = 500;

type MessageRow = { seq: number; msg_id: string; author: string; author_name: string; body: string; created_at: number; kind: MessageKind; ref: string | null; mentions: string | null };

/** Columns added after a table first shipped. A room made before them has its table as it was, so each is added there once. */
const MESSAGE_COLUMNS_ADDED: Record<string, string> = { kind: "TEXT NOT NULL DEFAULT 'text'", ref: "TEXT", mentions: "TEXT" };

/** The only table and column names, and column types, `addColumns` puts into SQL text. */
const SQL_NAME = /^[a-z][a-z0-9_]*$/;
const SQL_COLUMN_TYPE = /^(TEXT|INTEGER|REAL|BLOB)( NOT NULL)?( DEFAULT ('[a-z]*'|-?[0-9]+))?$/;

export function addColumns(sql: SqlStorage, table: string, columns: Record<string, string>) {
  if (!SQL_NAME.test(table)) throw new Error("bad-sql-name");
  const have = new Set(sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((row) => row.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!SQL_NAME.test(name) || !SQL_COLUMN_TYPE.test(type)) throw new Error("bad-sql-name");
    if (!have.has(name)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

export function createChatTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id TEXT NOT NULL,
    author TEXT NOT NULL,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    ref TEXT,
    mentions TEXT,
    UNIQUE (author, msg_id)
  )`);
  addColumns(sql, "messages", MESSAGE_COLUMNS_ADDED);
}

const toMessage = (row: MessageRow): ChatMessage => ({ seq: row.seq, msgId: row.msg_id, fromId: row.author, fromName: row.author_name, text: row.body, at: row.created_at, kind: row.kind, ref: row.ref, mentions: row.mentions ? (JSON.parse(row.mentions) as string[]) : [] });

/** `updateOf` is the earlier song share a song card replaces, or null. A gig, setlist or band-song card replaces nothing. */
export type Card = { kind: "song"; ref: string; updateOf: string | null } | { kind: "gig" | "setlist" | "band-song"; ref: string; updateOf?: undefined };

/**
 * Whether a second card for the same `ref` from the same author is the first one again. A song, setlist or gig card is
 * the one card for its thing. A band-song card is a player pointing at a song, which they may do as often as they like.
 */
const ONE_CARD_PER_REF: Record<Card["kind"], boolean> = { song: true, setlist: true, gig: true, "band-song": false };

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
    inRoom(sql, userId, "chat");
    return sql
      .exec<MessageRow>(`SELECT * FROM (SELECT * FROM messages WHERE seq > ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`, after, MAX_THREAD_PAGE)
      .toArray()
      .map(toMessage);
  },

  /**
   * Stores the message under the phone's `msgId`. The same id again from the same author stores nothing and returns the
   * first copy, and so does a card for the same `ref` when that card is the one for its thing (`ONE_CARD_PER_REF`). A
   * `card` points at a gig, song, setlist or band song by `ref`. An update card must name an earlier song card of the
   * same author. Words in a band may name its active members with `@`, and their ids are kept with the message.
   */
  post({ sql }: RoomStore, author: Person, msgId: string, text: string, now: number, card: Card | null = null): Posted {
    const { meta } = inRoom(sql, author.userId, "chat");
    const kind = card?.kind ?? "text";
    const sameRef = card && ONE_CARD_PER_REF[card.kind] ? card.ref : null;
    const mine = () => sql.exec<MessageRow>(`SELECT * FROM messages WHERE author = ? AND (msg_id = ? OR (ref = ? AND kind = ?)) ORDER BY seq LIMIT 1`, author.userId, msgId, sameRef, kind).toArray()[0];
    const members = sql
      .exec<{ user_id: string; display_name: string }>(`SELECT user_id, display_name FROM members WHERE state = 'active'`)
      .toArray()
      .map((row): Person => ({ userId: row.user_id, name: row.display_name }));
    const stored = mine() === undefined;
    if (stored && card?.updateOf && !sql.exec(`SELECT 1 FROM messages WHERE author = ? AND kind = 'song' AND ref = ?`, author.userId, card.updateOf).toArray().length) throw refused("not-found");
    if (stored) {
      const mentions = meta.kind === "band" && card === null ? parseMentions(text, members) : [];
      sql.exec(
        `INSERT INTO messages (msg_id, author, author_name, body, created_at, kind, ref, mentions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        msgId,
        author.userId,
        author.name,
        text,
        now,
        kind,
        card?.ref ?? null,
        mentions.length > 0 ? JSON.stringify(mentions) : null,
      );
    }
    return { message: toMessage(mine()!), stored, kind: meta.kind, title: meta.name, members };
  },
};
