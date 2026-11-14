import { liveCode, type CodeRow } from "./codes";
import { normalizeHandle, signedIn, userById, type Context, type Route, type User } from "./directory-account";
import { Refused } from "./refused";

export function createFriendTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS friendships (
    low_id TEXT NOT NULL,
    high_id TEXT NOT NULL,
    state TEXT NOT NULL,
    asked_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (low_id, high_id)
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS friendships_by_high ON friendships (high_id)`);
}

type State = "requested" | "friends" | "blocked";
type Pair = { state: State; asked_by: string };
export type Outcome = "requested" | "friends" | "already-friends";

/**
 * One person asking another, by @name, by a code shown in person, or by a link (PLAN.md 9.3):
 * only a link the other person shared is pre-approved, so every other ask waits for them to accept.
 * Two people asking each other are friends. A block is never lifted, and the blocked side is told only "requested".
 */
export function afterAsk(pair: Pair | undefined, asker: string, preApproved: boolean): { next?: Pair; outcome: Outcome } {
  if (pair?.state === "blocked") return { outcome: "requested" };
  if (pair?.state === "friends") return { outcome: "already-friends" };
  if (preApproved || (pair && pair.asked_by !== asker)) return { next: { state: "friends", asked_by: pair?.asked_by ?? asker }, outcome: "friends" };
  return { next: { state: "requested", asked_by: asker }, outcome: "requested" };
}

const sorted = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

const pairOf = (sql: SqlStorage, a: string, b: string) => sql.exec<Pair>(`SELECT state, asked_by FROM friendships WHERE low_id = ? AND high_id = ?`, ...sorted(a, b)).toArray()[0];

function savePair(c: Context, a: string, b: string, pair: Pair) {
  c.sql.exec(
    `INSERT INTO friendships (low_id, high_id, state, asked_by, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (low_id, high_id) DO UPDATE SET state = excluded.state, asked_by = excluded.asked_by, updated_at = excluded.updated_at`,
    ...sorted(a, b),
    pair.state,
    pair.asked_by,
    c.now,
  );
}

type Person = { userId: string; handle: string; name: string };

/** The caller's friends and the requests waiting for them, by name. Blocks and their own sent requests are not listed. */
function lists(sql: SqlStorage, me: string): { friends: Person[]; requests: Person[] } {
  const rows = sql
    .exec<{ user_id: string; handle: string; display_name: string; state: State; asked_by: string }>(
      `SELECT u.user_id, u.handle, u.display_name, f.state, f.asked_by FROM friendships f
       JOIN users u ON u.user_id = CASE WHEN f.low_id = ?1 THEN f.high_id ELSE f.low_id END
       WHERE (f.low_id = ?1 OR f.high_id = ?1) AND f.state != 'blocked'
       ORDER BY u.display_name COLLATE NOCASE, u.handle`,
      me,
    )
    .toArray();
  const person = (row: (typeof rows)[number]): Person => ({ userId: row.user_id, handle: row.handle, name: row.display_name });
  return {
    friends: rows.filter((row) => row.state === "friends").map(person),
    requests: rows.filter((row) => row.state === "requested" && row.asked_by !== me).map(person),
  };
}

function ask(c: Context, user: User, otherId: string, preApproved: boolean) {
  if (otherId === user.user_id) throw new Refused("yourself");
  const { next, outcome } = afterAsk(pairOf(c.sql, user.user_id, otherId), user.user_id, preApproved);
  if (next) savePair(c, user.user_id, otherId, next);
  return { body: { outcome, ...lists(c.sql, user.user_id) } };
}

/** The live friend code in the request, and the person it adds. */
async function friendCode(c: Context): Promise<{ row: CodeRow; owner: User }> {
  const row = await liveCode(c.sql, c.env, c.body.code, c.now);
  const owner = row.kind === "friend-now" || row.kind === "friend-link" ? userById(c.sql, row.target_id) : undefined;
  if (!owner) throw new Refused("not-a-friend-code");
  return { row, owner };
}

/** The other person named by `userId` in the request, who must have an account. */
function other(c: Context): User {
  const found = typeof c.body.userId === "string" ? userById(c.sql, c.body.userId) : undefined;
  if (!found) throw new Refused("not-found", 404);
  return found;
}

export const FRIEND_ROUTES: Record<string, Route> = {
  async "GET /api/friends"(c) {
    return { body: lists(c.sql, signedIn(c).user_id) };
  },

  async "POST /api/friends/request"(c) {
    const user = signedIn(c);
    const found = c.sql.exec<{ user_id: string }>(`SELECT user_id FROM users WHERE handle = ?`, normalizeHandle(c.body.handle)).toArray()[0];
    if (!found) throw new Refused("no-such-handle", 404);
    return ask(c, user, found.user_id, false);
  },

  async "POST /api/friends/code"(c) {
    const { row, owner } = await friendCode(c);
    if (owner.user_id === signedIn(c).user_id) throw new Refused("yourself");
    return { body: { kind: row.kind, name: owner.display_name, handle: owner.handle, expiresAt: row.expires_at } };
  },

  async "POST /api/friends/add-by-code"(c) {
    const { row, owner } = await friendCode(c);
    return ask(c, signedIn(c), owner.user_id, row.kind === "friend-link");
  },

  async "POST /api/friends/accept"(c) {
    const user = signedIn(c);
    const asker = other(c);
    const pair = pairOf(c.sql, user.user_id, asker.user_id);
    if (pair?.state !== "requested" || pair.asked_by !== asker.user_id) throw new Refused("no-request", 404);
    savePair(c, user.user_id, asker.user_id, { state: "friends", asked_by: asker.user_id });
    return { body: lists(c.sql, user.user_id) };
  },

  async "POST /api/friends/decline"(c) {
    const user = signedIn(c);
    const asker = other(c);
    c.sql.exec(`DELETE FROM friendships WHERE low_id = ? AND high_id = ? AND state = 'requested' AND asked_by = ?`, ...sorted(user.user_id, asker.user_id), asker.user_id);
    return { body: lists(c.sql, user.user_id) };
  },

  async "POST /api/friends/block"(c) {
    const user = signedIn(c);
    const blocked = other(c);
    if (blocked.user_id === user.user_id) throw new Refused("yourself");
    if (pairOf(c.sql, user.user_id, blocked.user_id)?.state !== "blocked") savePair(c, user.user_id, blocked.user_id, { state: "blocked", asked_by: user.user_id });
    return { body: lists(c.sql, user.user_id) };
  },
};
