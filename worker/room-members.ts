import type { BandPack, BandPreview, BandSummary, BandView, Member, Role } from "../src/bands-model";
import { randomBytes, toBase64Url } from "./bytes";
import { liveCode } from "./codes";
import { displayName, signedIn, type Context, type Route, type User } from "./directory-account";
import { Refused } from "./refused";

type MemberState = "active" | "removed" | "left";

type Meta = { kind: "band"; name: string; created_by: string; created_at: number; scroll_with_leader: 0 | 1 };
type MemberRow = { user_id: string; role: Role; state: MemberState; joined_at: number; changed_at: number; display_name: string };

export const NOT_A_MEMBER_CLOSE = 4403;
const BAND_ID = /^band_[A-Za-z0-9_-]{22}$/;

/** Room refusals arrive over RPC as plain errors carrying the reason, so the Directory gives each its status back here. */
const ROOM_REFUSALS = {
  "no-band": 404,
  "not-a-member": 403,
  "not-admin": 403,
  "not-found": 404,
  "last-admin": 409,
  "band-exists": 409,
  "code-stopped": 410,
  yourself: 400,
} as const;

const refused = (reason: keyof typeof ROOM_REFUSALS) => new Refused(reason, ROOM_REFUSALS[reason]);

export function createMemberTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    scroll_with_leader INTEGER NOT NULL DEFAULT 0
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS members (
    user_id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    state TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    changed_at INTEGER NOT NULL,
    display_name TEXT NOT NULL
  )`);
}

const metaOf = (sql: SqlStorage) => sql.exec<Meta>(`SELECT * FROM meta WHERE id = 1`).toArray()[0];
const memberOf = (sql: SqlStorage, userId: string) => sql.exec<MemberRow>(`SELECT * FROM members WHERE user_id = ?`, userId).toArray()[0];
const activeAdmins = (sql: SqlStorage) => sql.exec<{ n: number }>(`SELECT count(*) AS n FROM members WHERE state = 'active' AND role = 'admin'`).one().n;

/** Whether this room is a band that `userId` may not enter. Rooms that are not bands stay open to any signed-in player. */
export const shutOut = (sql: SqlStorage, userId: string) => metaOf(sql) !== undefined && memberOf(sql, userId)?.state !== "active";

function inBand(sql: SqlStorage, userId: string): { meta: Meta; me: MemberRow } {
  const meta = metaOf(sql);
  if (!meta) throw refused("no-band");
  const me = memberOf(sql, userId);
  if (me?.state !== "active") throw refused("not-a-member");
  return { meta, me };
}

function asAdmin(sql: SqlStorage, userId: string) {
  const band = inBand(sql, userId);
  if (band.me.role !== "admin") throw refused("not-admin");
  return band;
}

function activeTarget(sql: SqlStorage, userId: string): MemberRow {
  const target = memberOf(sql, userId);
  if (target?.state !== "active") throw refused("not-found");
  return target;
}

type Band = { sql: SqlStorage; bandId: string };

function view({ sql, bandId }: Band, userId: string): BandView {
  const { meta, me } = inBand(sql, userId);
  const members = sql
    .exec<MemberRow>(`SELECT * FROM members WHERE state = 'active' ORDER BY role = 'admin' DESC, display_name COLLATE NOCASE, user_id`)
    .toArray()
    .map((row): Member => ({ userId: row.user_id, name: row.display_name, role: row.role }));
  return { bandId, name: meta.name, role: me.role, members, scrollWithLeader: meta.scroll_with_leader === 1 };
}

function setState(sql: SqlStorage, userId: string, state: MemberState, now: number) {
  sql.exec(`UPDATE members SET state = ?, changed_at = ? WHERE user_id = ?`, state, now, userId);
}

/** Every user id here is trusted: only the Directory calls these, after it has checked the session. */
export const bandRoom = {
  create(band: Band, user: { userId: string; name: string }, name: string, now: number): BandView {
    if (metaOf(band.sql)) throw refused("band-exists");
    band.sql.exec(`INSERT INTO meta (id, kind, name, created_by, created_at) VALUES (1, 'band', ?, ?, ?)`, name, user.userId, now);
    band.sql.exec(`INSERT INTO members (user_id, role, state, joined_at, changed_at, display_name) VALUES (?, 'admin', 'active', ?, ?, ?)`, user.userId, now, now, user.name);
    return view(band, user.userId);
  },

  summary({ sql, bandId }: Band, userId: string): BandSummary | null {
    const meta = metaOf(sql);
    const me = memberOf(sql, userId);
    if (!meta || me?.state !== "active") return null;
    const members = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM members WHERE state = 'active'`).one().n;
    return { bandId, name: meta.name, role: me.role, members };
  },

  view,

  /** Who the code's maker still is in the band decides whether it works: only a live admin's code lets anyone in. */
  preview({ sql }: Band, inviterId: string, userId: string): BandPreview {
    const meta = metaOf(sql);
    const inviter = memberOf(sql, inviterId);
    if (!meta || inviter?.state !== "active" || inviter.role !== "admin") throw refused("code-stopped");
    return { name: meta.name, invitedBy: inviter.display_name, member: memberOf(sql, userId)?.state === "active" };
  },

  /** A removed player comes back only with a code made after they were removed, so an old shared link can't undo Remove. */
  join(band: Band, user: { userId: string; name: string }, code: { inviterId: string; madeAt: number }, now: number): BandView {
    bandRoom.preview(band, code.inviterId, user.userId);
    const me = memberOf(band.sql, user.userId);
    if (me?.state === "active") return view(band, user.userId);
    if (me?.state === "removed" && code.madeAt <= me.changed_at) throw refused("code-stopped");
    band.sql.exec(
      `INSERT INTO members (user_id, role, state, joined_at, changed_at, display_name) VALUES (?1, 'member', 'active', ?2, ?2, ?3)
       ON CONFLICT (user_id) DO UPDATE SET role = 'member', state = 'active', joined_at = ?2, changed_at = ?2, display_name = ?3`,
      user.userId,
      now,
      user.name,
    );
    return view(band, user.userId);
  },

  makeAdmin(band: Band, adminId: string, userId: string): BandView {
    asAdmin(band.sql, adminId);
    activeTarget(band.sql, userId);
    band.sql.exec(`UPDATE members SET role = 'admin' WHERE user_id = ?`, userId);
    return view(band, adminId);
  },

  remove(band: Band, adminId: string, userId: string, now: number): BandView {
    asAdmin(band.sql, adminId);
    if (userId === adminId) throw refused("yourself");
    activeTarget(band.sql, userId);
    setState(band.sql, userId, "removed", now);
    return view(band, adminId);
  },

  leave({ sql }: Band, userId: string, now: number) {
    const { me } = inBand(sql, userId);
    const others = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM members WHERE state = 'active' AND user_id != ?`, userId).one().n;
    if (me.role === "admin" && others > 0 && activeAdmins(sql) === 1) throw refused("last-admin");
    setState(sql, userId, "left", now);
  },

  requireAdmin({ sql }: Band, userId: string) {
    asAdmin(sql, userId);
  },

  setScrollWithLeader(band: Band, adminId: string, on: boolean): BandView {
    asAdmin(band.sql, adminId);
    band.sql.exec(`UPDATE meta SET scroll_with_leader = ? WHERE id = 1`, on ? 1 : 0);
    return view(band, adminId);
  },

  pack({ sql, bandId }: Band, userId: string): BandPack {
    const { meta } = inBand(sql, userId);
    return { bandId, name: meta.name, scrollWithLeader: meta.scroll_with_leader === 1 };
  },
};

export function createBandIndex(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS band_rooms (
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    PRIMARY KEY (user_id, room_id)
  )`);
}

async function fromRoom<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason in ROOM_REFUSALS) throw refused(reason as keyof typeof ROOM_REFUSALS);
    throw error;
  }
}

export function bandIdIn(body: Record<string, unknown>): string {
  if (typeof body.bandId !== "string" || !BAND_ID.test(body.bandId)) throw new Refused("bad-request");
  return body.bandId;
}

const roomOf = (c: Context, bandId: string) => c.env.ROOM.getByName(bandId);
const who = (user: User) => ({ userId: user.user_id, name: user.display_name });

function userIdIn(body: Record<string, unknown>): string {
  if (typeof body.userId !== "string" || body.userId.length > 64) throw new Refused("bad-request");
  return body.userId;
}

export async function bandInviteTarget(c: Context, user: User) {
  const bandId = bandIdIn(c.body);
  await fromRoom(roomOf(c, bandId).requireAdmin(user.user_id));
  return { targetId: bandId };
}

async function bandCode(c: Context) {
  const row = await liveCode(c.sql, c.env, c.body.code, c.now);
  if (row.kind !== "band") throw new Refused("not-a-band-code");
  return row;
}

function remember(c: Context, userId: string, bandId: string) {
  c.sql.exec(`INSERT OR IGNORE INTO band_rooms (user_id, room_id) VALUES (?, ?)`, userId, bandId);
}

function forget(c: Context, userId: string, bandId: string) {
  c.sql.exec(`DELETE FROM band_rooms WHERE user_id = ? AND room_id = ?`, userId, bandId);
}

export const BAND_ROUTES: Record<string, Route> = {
  /** The Directory only remembers which rooms to ask. Each room says whether the caller is still in it, and a room that says no is forgotten. */
  async "GET /api/bands"(c) {
    const me = signedIn(c).user_id;
    const ids = c.sql.exec<{ room_id: string }>(`SELECT room_id FROM band_rooms WHERE user_id = ?`, me).toArray().map((row) => row.room_id);
    const found = await Promise.all(ids.map((id) => roomOf(c, id).bandSummary(me)));
    ids.forEach((id, index) => found[index] === null && forget(c, me, id));
    const bands = found.filter((band): band is BandSummary => band !== null).sort((a, b) => a.name.localeCompare(b.name));
    return { body: { bands } };
  },

  async "POST /api/bands/create"(c) {
    const name = displayName(c.body.name);
    const user = signedIn(c);
    const bandId = `band_${toBase64Url(randomBytes(16))}`;
    const band = await fromRoom(roomOf(c, bandId).createBand(who(user), name, c.now));
    remember(c, user.user_id, bandId);
    return { body: band };
  },

  async "POST /api/bands/open"(c) {
    const bandId = bandIdIn(c.body);
    return { body: await fromRoom(roomOf(c, bandId).bandView(signedIn(c).user_id)) };
  },

  async "POST /api/bands/code"(c) {
    const row = await bandCode(c);
    return { body: await fromRoom(roomOf(c, row.target_id).bandPreview(row.created_by, signedIn(c).user_id)) };
  },

  async "POST /api/bands/join"(c) {
    const row = await bandCode(c);
    const user = signedIn(c);
    const band = await fromRoom(roomOf(c, row.target_id).joinBand(who(user), { inviterId: row.created_by, madeAt: row.created_at }, c.now));
    remember(c, user.user_id, row.target_id);
    return { body: band };
  },

  async "POST /api/bands/make-admin"(c) {
    const bandId = bandIdIn(c.body);
    return { body: await fromRoom(roomOf(c, bandId).makeAdmin(signedIn(c).user_id, userIdIn(c.body))) };
  },

  async "POST /api/bands/remove"(c) {
    const bandId = bandIdIn(c.body);
    const userId = userIdIn(c.body);
    const band = await fromRoom(roomOf(c, bandId).removeMember(signedIn(c).user_id, userId, c.now));
    forget(c, userId, bandId);
    return { body: band };
  },

  async "POST /api/bands/leave"(c) {
    const bandId = bandIdIn(c.body);
    const me = signedIn(c).user_id;
    await fromRoom(roomOf(c, bandId).leaveBand(me, c.now));
    forget(c, me, bandId);
    return { body: { ok: true } };
  },

  async "POST /api/bands/reset-link"(c) {
    const bandId = bandIdIn(c.body);
    await fromRoom(roomOf(c, bandId).requireAdmin(signedIn(c).user_id));
    const stopped = c.sql.exec(`UPDATE codes SET stopped_at = ? WHERE kind = 'band' AND target_id = ? AND stopped_at IS NULL AND expires_at > ?`, c.now, bandId, c.now).rowsWritten;
    return { body: { stopped } };
  },

  async "POST /api/bands/settings"(c) {
    const bandId = bandIdIn(c.body);
    if (typeof c.body.scrollWithLeader !== "boolean") throw new Refused("bad-request");
    return { body: await fromRoom(roomOf(c, bandId).setScrollWithLeader(signedIn(c).user_id, c.body.scrollWithLeader)) };
  },

  async "POST /api/bands/pack"(c) {
    const bandId = bandIdIn(c.body);
    return { body: await fromRoom(roomOf(c, bandId).bandPack(signedIn(c).user_id)) };
  },
};
