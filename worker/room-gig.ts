import type { SongContent } from "../src/band-library-model";
import { DETAIL_LIMITS, gigLine, KIND_WORDS, type GigDetails, type GigKind, type GigList, type GigPlan, type GigStatus, type GigView, type PackReceipt } from "../src/gig-plan-model";
import { CHOICE_WORDS, type RouteChoice } from "../src/routes";
import { randomBytes, toBase64Url, utf8 } from "./bytes";
import { liveCode } from "./codes";
import { signedIn, wantsChordPro, who, type Context, type Person, type Route, type User } from "./directory-http";
import { deliver } from "./directory-inbox";
import { fromRoom, Refused, roomRefused as refused } from "./refused";
import { addColumns, chatRoom, type Posted } from "./room-chat";
import { firstName, guestGigsOf, guestOpens, liveGuestGigs, type GuestOpens } from "./room-guest";
import { bandSongsOnly, isText, MAX_SETLIST_SONGS, songForCaller, storedSong } from "./room-library";
import { bandIdIn, bandIdsOf, inRoom, roomOf, type RoomStore } from "./room-members";
import { hmacKey } from "./session";

const GIG_ID = /^gig_[A-Za-z0-9_-]{22}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const MAX_LINEUP = 64;
const GIG_LINK_DAYS = 30;

type GigRow = {
  gig_id: string;
  setlist_id: string;
  name: string;
  date: string;
  song_order: string;
  lineup: string;
  leader: string;
  backup: string | null;
  route: RouteChoice;
  epoch: number;
  rev: number;
  state: string | null;
  status: GigStatus;
  started_at: number | null;
  ended_at: number | null;
  secret_rev: number;
  kind: GigKind;
  start_time: string | null;
  call_time: string | null;
  venue: string | null;
  address: string | null;
  notes: string | null;
};

/** The P2 columns. A band room made before them has its `gigs` table as it was, so each is added there once. */
const GIG_COLUMNS_ADDED: Record<string, string> = { kind: "TEXT NOT NULL DEFAULT 'gig'", start_time: "TEXT", call_time: "TEXT", venue: "TEXT", address: "TEXT", notes: "TEXT" };

/**
 * `GigPack` from `src/gig-pack.ts` as this Room makes it. That file reaches the phone's scroll code, which the Worker
 * can't compile, so the shape is written here with `bandTiming` always null until the band can share timing.
 */
type PackSong = { songId: string; song: SongContent; bandTiming: null };
type Pack = { gig: GigPlan; songs: PackSong[]; scrollWithLeader: boolean; secret: string | null; packRev: number; expiresAt: number | null };

export function createGigTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS gigs (
    gig_id TEXT PRIMARY KEY, setlist_id TEXT NOT NULL, name TEXT NOT NULL, date TEXT NOT NULL, song_order TEXT NOT NULL,
    lineup TEXT NOT NULL, leader TEXT NOT NULL, backup TEXT, route TEXT NOT NULL, epoch INTEGER NOT NULL, rev INTEGER NOT NULL,
    state TEXT, status TEXT NOT NULL, started_at INTEGER, ended_at INTEGER, secret_rev INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'gig', start_time TEXT, call_time TEXT, venue TEXT, address TEXT, notes TEXT
  )`);
  addColumns(sql, "gigs", GIG_COLUMNS_ADDED);
  sql.exec(`CREATE TABLE IF NOT EXISTS pack_receipts (gig_id TEXT NOT NULL, user_id TEXT NOT NULL, pack_rev INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (gig_id, user_id))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS gig_ops (gig_id TEXT NOT NULL, op_id TEXT NOT NULL, rev INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (gig_id, op_id))`);
}

/** Who may change what on a planned gig (PLAN.md 6). Reading the plan is open to every member. */
type Change = "lineup" | "backup" | "route" | "songs";
type Caller = { admin: boolean; leader: boolean; planned: boolean };
const MAY: Record<Change, (caller: Caller) => boolean> = {
  lineup: ({ admin, leader, planned }) => admin || (leader && planned),
  backup: ({ admin, leader }) => admin || leader,
  route: ({ admin }) => admin,
  songs: ({ admin }) => admin,
};

type LiveState = { status: "live" | "ended"; leader: string; backup: string | null };
const liveOf = (row: GigRow): LiveState | null => (row.state ? (JSON.parse(row.state) as LiveState) : null);

/**
 * The live state the leader's phone sends is the gig's truth once it exists (PLAN.md 7.10), so the row's status follows
 * it: planned turns live once a state is held, and live turns ended when the state ends. The Room writes this the first
 * time it reads the gig after the state changed, so every read, the lineup check on a socket included, sees one status.
 */
function settled(sql: SqlStorage, row: GigRow, now = Date.now()): GigRow {
  const live = row && liveOf(row);
  if (!live || row.status === "ended") return row;
  if (live.status === "ended") {
    sql.exec(`UPDATE gigs SET status = 'ended', ended_at = ? WHERE gig_id = ?`, now, row.gig_id);
    return { ...row, status: "ended", ended_at: now };
  }
  if (row.status === "live") return row;
  sql.exec(`UPDATE gigs SET status = 'live', started_at = ? WHERE gig_id = ?`, now, row.gig_id);
  return { ...row, status: "live", started_at: now };
}

const gigRow = (sql: SqlStorage, gigId: string) => settled(sql, sql.exec<GigRow>(`SELECT * FROM gigs WHERE gig_id = ?`, gigId).toArray()[0]);
const settleLive = (sql: SqlStorage) => sql.exec<GigRow>(`SELECT * FROM gigs WHERE state IS NOT NULL AND status != 'ended'`).toArray().forEach((row) => settled(sql, row));
const lineupOf = (row: GigRow): string[] => JSON.parse(row.lineup);
const songsOf = (row: GigRow): string[] => JSON.parse(row.song_order);
const activeIds = (sql: SqlStorage) => new Set(sql.exec<{ user_id: string }>(`SELECT user_id FROM members WHERE state = 'active'`).toArray().map((row) => row.user_id));
const isAdmin = (sql: SqlStorage, userId: string) => sql.exec(`SELECT 1 FROM members WHERE user_id = ? AND state = 'active' AND role = 'admin'`, userId).toArray().length > 0;

/** The lineup by first name only, which is all a guest is shown of the band's members (PLAN.md 7.14). */
function firstNames(sql: SqlStorage, row: GigRow): Record<string, string> {
  const lineup = lineupOf(row);
  const rows = sql.exec<{ user_id: string; display_name: string }>(`SELECT user_id, display_name FROM members WHERE state = 'active'`).toArray();
  return Object.fromEntries(rows.filter((member) => lineup.includes(member.user_id)).map((member) => [member.user_id, firstName(member.display_name)]));
}

/** Who leads the gig now: the live state's leader once it is live, the planned leader before. Only the room's introductions read it; every plan keeps the planned pair. */
const leadingNow = (row: GigRow) => (row.status === "live" ? liveOf(row)?.leader : null) ?? row.leader;

const planOf = (row: GigRow, bandId: string): GigPlan => ({
  gigId: row.gig_id,
  bandId,
  setlistId: row.setlist_id,
  name: row.name,
  date: row.date,
  lineup: lineupOf(row),
  leader: row.leader,
  backup: row.backup,
  route: row.route,
  status: row.status,
  kind: row.kind ?? "gig",
  startTime: row.start_time ?? null,
  callTime: row.call_time ?? null,
  venue: row.venue ?? null,
  address: row.address ?? null,
  notes: row.notes ?? null,
});

function viewOf({ sql, bandId }: RoomStore, row: GigRow): GigView {
  const lineup = lineupOf(row);
  const receipts = sql
    .exec<{ user_id: string; pack_rev: number; at: number }>(`SELECT user_id, pack_rev, at FROM pack_receipts WHERE gig_id = ? ORDER BY at, user_id`, row.gig_id)
    .toArray()
    .filter((receipt) => lineup.includes(receipt.user_id))
    .map((receipt): PackReceipt => ({ userId: receipt.user_id, packRev: receipt.pack_rev, at: receipt.at }));
  const songIds = songsOf(row);
  return { gig: planOf(row, bandId), packRev: row.rev, receipts, songIds, songCount: songIds.length };
}

/** A lineup of active members, each once. The leader must be on it. */
function checkedLineup(sql: SqlStorage, lineup: string[], leader: string): string[] {
  const active = activeIds(sql);
  const unique = [...new Set(lineup)];
  if (unique.length === 0 || unique.some((id) => !active.has(id))) throw new Refused("bad-request");
  if (!unique.includes(leader)) throw refused("not-on-lineup");
  return unique;
}

function checkedBackup(backup: string | null, lineup: string[], leader: string): string | null {
  if (backup === null) return null;
  if (!lineup.includes(backup)) throw refused("not-on-lineup");
  if (backup === leader) throw refused("is-leader");
  return backup;
}

/** The gig, after checking the caller is in the band and may make this change. */
function changeable(band: RoomStore, userId: string, gigId: string, change: Change): GigRow {
  const { me } = inRoom(band.sql, userId);
  const row = gigRow(band.sql, gigId);
  if (!row) throw refused("not-found");
  if (!MAY[change]({ admin: me.role === "admin", leader: row.leader === userId, planned: row.status === "planned" })) throw refused("not-allowed");
  if (row.status === "ended") throw refused("gig-ended");
  return row;
}

type Changes = { lineup?: string[]; leader?: string; backup?: string | null; route?: RouteChoice };

/** Every change a pack can see raises the pack rev, so a phone holding an older pack shows Not yet until it downloads again. */
function save(band: RoomStore, row: GigRow, changes: Changes): GigView {
  const was = lineupOf(row);
  const lineupChanged = changes.lineup !== undefined && JSON.stringify([...changes.lineup].sort()) !== JSON.stringify([...was].sort());
  const lineup = lineupChanged ? changes.lineup! : was;
  const leader = changes.leader ?? row.leader;
  const asked = changes.backup === undefined ? row.backup : changes.backup;
  const backup = asked !== null && lineup.includes(asked) && asked !== leader ? asked : null;
  const route = changes.route ?? row.route;
  if (!lineupChanged && leader === row.leader && backup === row.backup && route === row.route) return viewOf(band, row);
  band.sql.exec(
    `UPDATE gigs SET lineup = ?, leader = ?, backup = ?, route = ?, rev = rev + 1, secret_rev = secret_rev + ? WHERE gig_id = ?`,
    JSON.stringify(lineup),
    leader,
    backup,
    route,
    lineupChanged ? 1 : 0,
    row.gig_id,
  );
  return viewOf(band, gigRow(band.sql, row.gig_id));
}

/** The secret a lineup phone proves itself with when it joins by QR (PLAN.md 7.14). It changes with `secret_rev`, so an old pack's secret stops working. */
async function gigSecret(sessionSecret: string | undefined, bandId: string, gigId: string, secretRev: number): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(sessionSecret), utf8(`gig-secret:${bandId}/${gigId}:${secretRev}`));
  return toBase64Url(new Uint8Array(mac));
}

export type GigFields = { gigId: string; setlistId: string; name: string; date: string; lineup: string[] | null; leader: string | null; backup: string | null; route: RouteChoice } & GigDetails;

/** Every user id here is trusted: only the Directory calls these, after it has checked the session. */
export const gigRoom = {
  /**
   * An admin plans a gig from a band setlist. The setlist's order is copied now, so every pack has the same songs in the
   * same order however the setlist changes later. The card goes into the band chat in the same step, its words the gig's
   * name and `gigLine`. The same `gigId` again returns the gig already made, so a retry after a lost reply makes no
   * second gig or card.
   */
  plan(band: RoomStore, planner: Person, fields: GigFields, now: number): { view: GigView; posted: Posted } {
    const { me } = inRoom(band.sql, planner.userId);
    if (me.role !== "admin") throw refused("not-allowed");
    const card = { kind: "gig" as const, ref: fields.gigId };
    const text = `${fields.name} · ${gigLine(fields)}`;
    const made = gigRow(band.sql, fields.gigId);
    if (made) return { view: viewOf(band, made), posted: chatRoom.post(band, planner, fields.gigId, text, now, card) };
    const setlist = band.sql.exec<{ song_ids: string }>(`SELECT song_ids FROM band_setlists WHERE setlist_id = ?`, fields.setlistId).toArray()[0];
    if (!setlist) throw refused("not-found");
    const leader = fields.leader ?? planner.userId;
    const lineup = checkedLineup(band.sql, fields.lineup ?? [...activeIds(band.sql)], leader);
    const backup = checkedBackup(fields.backup, lineup, leader);
    band.sql.exec(
      `INSERT INTO gigs (gig_id, setlist_id, name, date, song_order, lineup, leader, backup, route, epoch, rev, state, status, started_at, ended_at, secret_rev,
         kind, start_time, call_time, venue, address, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, NULL, 'planned', NULL, NULL, 1, ?, ?, ?, ?, ?, ?)`,
      fields.gigId,
      fields.setlistId,
      fields.name,
      fields.date,
      setlist.song_ids,
      JSON.stringify(lineup),
      leader,
      backup,
      fields.route,
      fields.kind,
      fields.startTime,
      fields.callTime,
      fields.venue,
      fields.address,
      fields.notes,
    );
    return { view: viewOf(band, gigRow(band.sql, fields.gigId)), posted: chatRoom.post(band, planner, fields.gigId, text, now, card) };
  },

  /** The gigs `userId` is on the lineup of, or follows as a guest, each with whoever leads it now, so the room introduces each phone to that leader. */
  lineups(band: RoomStore, userId: string): Map<string, string> {
    const { me } = inRoom(band.sql, userId, "gigs");
    settleLive(band.sql);
    const guestOf = me.role === "guest" ? liveGuestGigs(band.sql, userId) : null;
    const rows = band.sql.exec<GigRow>(`SELECT * FROM gigs`).toArray();
    return new Map(rows.filter((row) => (guestOf ? guestOf.has(row.gig_id) : lineupOf(row).includes(userId))).map((row) => [row.gig_id, leadingNow(row)]));
  },

  /** The gigs not yet ended, soonest first, and the ended ones, newest first. An ended gig is kept as the band's record. */
  list(band: RoomStore, userId: string): GigList {
    inRoom(band.sql, userId);
    settleLive(band.sql);
    const views = (query: string) => band.sql.exec<GigRow>(query).toArray().map((row) => viewOf(band, row));
    return {
      gigs: views(`SELECT * FROM gigs WHERE status != 'ended' ORDER BY date, gig_id`),
      past: views(`SELECT * FROM gigs WHERE status = 'ended' ORDER BY date DESC, ended_at DESC, gig_id`),
    };
  },

  /** A guest opens only their pass's gig, sees its lineup by first name, and is told what else their pass opens and when it ends. */
  open(band: RoomStore, userId: string, gigId: string): GigView & { names?: Record<string, string>; guest?: GuestOpens } {
    const { me } = inRoom(band.sql, userId, { gigId });
    const row = gigRow(band.sql, gigId);
    if (!row) throw refused("not-found");
    return me.role === "guest" ? { ...viewOf(band, row), names: firstNames(band.sql, row), guest: guestOpens(band.sql, me, Date.now()) } : viewOf(band, row);
  },

  setLineup(band: RoomStore, userId: string, gigId: string, lineup: string[]): GigView {
    const row = changeable(band, userId, gigId, "lineup");
    return save(band, row, { lineup: checkedLineup(band.sql, lineup, row.leader) });
  },

  setBackup(band: RoomStore, userId: string, gigId: string, backup: string | null): GigView {
    const row = changeable(band, userId, gigId, "backup");
    return save(band, row, { backup: checkedBackup(backup, lineupOf(row), row.leader) });
  },

  setRoute(band: RoomStore, userId: string, gigId: string, route: RouteChoice): GigView {
    return save(band, changeable(band, userId, gigId, "route"), { route });
  },

  /**
   * An admin sets a planned gig's own songs and their order. The setlist it came from stays as it was. A live gig's set
   * is locked until phones can follow a change on stage (C21). The same order again changes nothing, so a retry after a
   * lost reply raises the pack rev once. The secret stays, since the lineup did not change.
   */
  setSongs(band: RoomStore, userId: string, gigId: string, songIds: string[]): GigView {
    const row = changeable(band, userId, gigId, "songs");
    if (row.status === "live") throw refused("set-locked");
    bandSongsOnly(band.sql, songIds);
    if (JSON.stringify(songIds) === JSON.stringify(songsOf(row))) return viewOf(band, row);
    band.sql.exec(`UPDATE gigs SET song_order = ?, rev = rev + 1 WHERE gig_id = ?`, JSON.stringify(songIds), gigId);
    return viewOf(band, gigRow(band.sql, gigId));
  },

  /**
   * The pack for a lineup player, with the secret and a receipt for this pack rev. An admin who isn't playing may read it,
   * with no secret and no receipt. A song no longer in the band is left out. The reads and the receipt happen before the
   * first await, so the pack, its rev and its secret all come from one moment.
   */
  async pack(band: RoomStore, sessionSecret: string | undefined, userId: string, gigId: string, now: number): Promise<Pack> {
    const { me, meta } = inRoom(band.sql, userId, { gigId });
    const row = gigRow(band.sql, gigId);
    if (!row) throw refused("not-found");
    const guest = me.role === "guest" ? me.pass : null;
    const playing = lineupOf(row).includes(userId);
    if (!playing && !guest && me.role !== "admin") throw refused("not-on-lineup");
    const songs = songsOf(row).flatMap((songId): PackSong[] => {
      const song = band.sql.exec<{ song: string }>(`SELECT song FROM band_songs WHERE song_id = ?`, songId).toArray()[0];
      return song ? [{ songId, song: storedSong(song.song), bandTiming: null }] : [];
    });
    if (playing) {
      band.sql.exec(
        `INSERT INTO pack_receipts (gig_id, user_id, pack_rev, at) VALUES (?, ?, ?, ?)
         ON CONFLICT (gig_id, user_id) DO UPDATE SET pack_rev = excluded.pack_rev, at = excluded.at WHERE excluded.pack_rev > pack_receipts.pack_rev`,
        gigId,
        userId,
        row.rev,
        now,
      );
    }
    const secret = playing || guest ? await gigSecret(sessionSecret, band.bandId, gigId, row.secret_rev) : null;
    return { gig: planOf(row, band.bandId), songs, scrollWithLeader: meta.scroll_with_leader === 1, secret, packRev: row.rev, expiresAt: guest?.expires_at ?? null };
  },

  /** A gig link opens the gig for its lineup and the band's admins. Anyone else hears only that it is for the lineup. */
  viaLink(band: RoomStore, userId: string, gigId: string): GigView {
    const row = gigRow(band.sql, gigId);
    const active = activeIds(band.sql);
    if (!row || !active.has(userId) || !(lineupOf(row).includes(userId) || isAdmin(band.sql, userId))) throw refused("not-on-lineup");
    return viewOf(band, row);
  },

  /** The leader, the backup or an admin ends the gig for everyone. Ending it again changes nothing and answers the same. */
  end(band: RoomStore, userId: string, gigId: string, now: number): GigView {
    const { me } = inRoom(band.sql, userId);
    const row = gigRow(band.sql, gigId);
    if (!row) throw refused("not-found");
    if (!(me.role === "admin" || row.leader === userId || row.backup === userId)) throw refused("not-allowed");
    if (row.status !== "ended") band.sql.exec(`UPDATE gigs SET status = 'ended', ended_at = ? WHERE gig_id = ?`, now, gigId);
    return viewOf(band, gigRow(band.sql, gigId));
  },

  requireGigAdmin(band: RoomStore, userId: string, gigId: string) {
    const { me } = inRoom(band.sql, userId);
    if (me.role !== "admin") throw refused("not-allowed");
    if (!gigRow(band.sql, gigId)) throw refused("not-found");
  },

  /** Someone who left or was removed comes off every lineup not yet played and the secret changes for the rest. If they led, the backup leads, or else whoever is first on the lineup. */
  dropMember(band: RoomStore, userId: string) {
    for (const row of band.sql.exec<GigRow>(`SELECT * FROM gigs WHERE status != 'ended'`).toArray()) {
      const lineup = lineupOf(row).filter((id) => id !== userId);
      if (lineup.length === lineupOf(row).length || lineup.length === 0) continue;
      save(band, row, { lineup, leader: row.leader === userId ? (row.backup ?? lineup[0]) : row.leader });
    }
  },
};

export function gigIdIn(value: unknown): string {
  if (typeof value !== "string" || !GIG_ID.test(value)) throw new Refused("bad-request");
  return value;
}

function userIdOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 64) throw new Refused("bad-request");
  return value;
}

function lineupIn(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_LINEUP || !value.every((id) => typeof id === "string" && id.length <= 64)) throw new Refused("bad-request");
  return value;
}

/** A gig's songs: 1 to 200 ids, each once. An empty set is refused, since a gig with no songs cannot start. */
function songIdsIn(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SETLIST_SONGS || !value.every((id) => typeof id === "string" && id.length <= 64) || new Set(value).size !== value.length) {
    throw new Refused("bad-request");
  }
  return value;
}

function routeIn(value: unknown): RouteChoice {
  if (typeof value !== "string" || !Object.hasOwn(CHOICE_WORDS, value)) throw new Refused("bad-request");
  return value as RouteChoice;
}

function dateIn(value: unknown): string {
  if (typeof value !== "string" || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Refused("bad-date");
  }
  return value;
}

/** A blank optional field is null. */
const blank = (value: unknown) => value === undefined || value === null || value === "";

function kindIn(value: unknown): GigKind {
  if (value === undefined) return "gig";
  if (typeof value !== "string" || !Object.hasOwn(KIND_WORDS, value)) throw new Refused("bad-request");
  return value as GigKind;
}

function timeIn(value: unknown): string | null {
  if (blank(value)) return null;
  if (typeof value !== "string" || !TIME.test(value) || Number(value.slice(0, 2)) > 23 || Number(value.slice(3)) > 59) throw new Refused("bad-request");
  return value;
}

function textIn(value: unknown, max: number): string | null {
  if (blank(value)) return null;
  if (!isText(value, max)) throw new Refused("bad-request");
  return (value as string).trim();
}

function nameIn(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > 60) throw new Refused("bad-gig-name");
  return name;
}

function fieldsIn(body: Record<string, unknown>): GigFields {
  if (typeof body.setlistId !== "string" || body.setlistId.length > 64) throw new Refused("bad-request");
  return {
    gigId: body.gigId === undefined ? `gig_${toBase64Url(randomBytes(16))}` : gigIdIn(body.gigId),
    setlistId: body.setlistId,
    name: nameIn(body.name),
    date: dateIn(body.date),
    lineup: body.lineup === undefined ? null : lineupIn(body.lineup),
    leader: userIdOrNull(body.leader),
    backup: userIdOrNull(body.backup),
    route: body.route === undefined ? "auto" : routeIn(body.route),
    kind: kindIn(body.kind),
    startTime: timeIn(body.startTime),
    callTime: timeIn(body.callTime),
    venue: textIn(body.venue, DETAIL_LIMITS.venue),
    address: textIn(body.address, DETAIL_LIMITS.address),
    notes: textIn(body.notes, DETAIL_LIMITS.notes),
  };
}

/** `POST /api/codes { kind: "gig", bandId, gigId }`: only an admin makes a gig link. Its target names the band and the gig. */
export async function gigLinkTarget(c: Context, user: User) {
  const bandId = bandIdIn(c.body);
  const gigId = gigIdIn(c.body.gigId);
  await fromRoom(roomOf(c, bandId).requireGigAdmin(user.user_id, gigId));
  return { targetId: `${bandId}/${gigId}` };
}

export const GIG_LINK_MINUTES = GIG_LINK_DAYS * 24 * 60;

/**
 * In a change, `not-on-lineup` is about a person the request names, so it is a bad request (400). Only a caller asking
 * for a pack or a gig link who isn't playing hears it as 403. The Room gives one status per word, so the change routes set this one.
 */
async function fromGigChange<T>(call: Promise<T>): Promise<T> {
  try {
    return await fromRoom(call);
  } catch (error) {
    if (error instanceof Refused && error.reason === "not-on-lineup") throw new Refused("not-on-lineup", 400);
    throw error;
  }
}

const inGig = (c: Context) => {
  const bandId = bandIdIn(c.body);
  return { room: roomOf(c, bandId), gigId: gigIdIn(c.body.gigId), me: signedIn(c).user_id };
};

export const GIG_ROUTES: Record<string, Route> = {
  async "POST /api/bands/gig/plan"(c) {
    const bandId = bandIdIn(c.body);
    const fields = fieldsIn(c.body);
    const user = signedIn(c);
    const { view, posted } = await fromGigChange(roomOf(c, bandId).planGig(who(user), fields, c.now));
    deliver(c, bandId, posted);
    return { body: view };
  },

  async "POST /api/bands/gig/list"(c) {
    const bandId = bandIdIn(c.body);
    return { body: await fromRoom(roomOf(c, bandId).gigList(signedIn(c).user_id)) };
  },

  /**
   * The gigs the caller plays tonight across their bands: each live one, and each ended since yesterday so a phone that
   * joined can say the gig is over. A gig whose lineup does not name the caller is not listed, an admin's included.
   * A band that no longer has the caller is skipped.
   */
  async "POST /api/bands/gig/live"(c) {
    const me = signedIn(c).user_id;
    const since = new Date(c.now - 24 * 3_600_000).toISOString().slice(0, 10);
    const lists = await Promise.all(bandIdsOf(c.sql, me).map((bandId) => fromRoom(roomOf(c, bandId).gigList(me)).catch(() => null)));
    const passes = await Promise.all(guestGigsOf(c.sql, me).map((held) => fromRoom(roomOf(c, held.band_id).gigOpen(me, held.gig_id)).then((view) => view.gig, () => null)));
    const tonight = (gig: GigPlan) => gig.status === "live" || (gig.status === "ended" && gig.date >= since);
    const gigs = [
      ...lists.flatMap((list) => (list ? [...list.gigs, ...list.past].map((view) => view.gig).filter((gig) => gig.lineup.includes(me) && tonight(gig)) : [])),
      ...passes.filter((gig): gig is GigPlan => gig !== null && tonight(gig)),
    ];
    return { body: { gigs } };
  },

  async "POST /api/bands/gig/open"(c) {
    const { room, gigId, me } = inGig(c);
    return { body: await fromRoom(room.gigOpen(me, gigId)) };
  },

  async "POST /api/bands/gig/lineup"(c) {
    const { room, gigId, me } = inGig(c);
    return { body: await fromGigChange(room.gigLineup(me, gigId, lineupIn(c.body.lineup))) };
  },

  async "POST /api/bands/gig/backup"(c) {
    const { room, gigId, me } = inGig(c);
    return { body: await fromGigChange(room.gigBackup(me, gigId, userIdOrNull(c.body.backup))) };
  },

  async "POST /api/bands/gig/route"(c) {
    const { room, gigId, me } = inGig(c);
    return { body: await fromRoom(room.gigRoute(me, gigId, routeIn(c.body.route))) };
  },

  async "POST /api/bands/gig/songs"(c) {
    const { room, gigId, me } = inGig(c);
    return { body: await fromRoom(room.gigSongs(me, gigId, songIdsIn(c.body.songIds))) };
  },

  async "POST /api/bands/gig/end"(c) {
    const { room, gigId, me } = inGig(c);
    return { body: await fromRoom(room.gigEnd(me, gigId, c.now)) };
  },

  async "POST /api/bands/gig/pack"(c) {
    const { room, gigId, me } = inGig(c);
    const pack = await fromRoom(room.gigPack(me, gigId, c.now));
    const chordpro = wantsChordPro(c.request);
    return { body: { ...pack, songs: pack.songs.map((item) => ({ ...item, song: songForCaller(item.song, chordpro) })) } };
  },

  async "POST /api/bands/gig/code"(c) {
    const row = await liveCode(c.sql, c.env, c.body.code, c.now);
    if (row.kind !== "gig") throw new Refused("not-a-gig-code");
    const [bandId, gigId] = row.target_id.split("/");
    return { body: await fromRoom(c.env.ROOM.getByName(bandId).gigViaLink(signedIn(c).user_id, gigId)) };
  },
};
