import { codeView, liveCode, storeCode } from "./codes";
import { signedIn, userById, type Context, type Route } from "./directory-http";
import { fromRoom, Refused, roomRefused as refused } from "./refused";
import { gigIdIn } from "./room-gig";
import { bandIdIn, bandRoom, roomOf, type RoomStore } from "./room-members";
import { randomBytes, toBase64Url } from "./bytes";

/**
 * Guest passes (PLAN.md 7.14): a fill-in player who isn't in the band follows one gig for as long as the admin chose.
 * A guest is never a `members` row, so everything that reasons over membership stays closed to them. `inRoom` lets a
 * guest in only where its caller asks for it, by the pass's gig or by one of the two switches.
 */

const PASS_ID = /^pass_[A-Za-z0-9_-]{22}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The longest pass the admin can pick, so a typo in the year can't make one that never ends. */
const MAX_PASS_MS = 366 * DAY_MS;
const MAX_NAME = 40;

export type PassRow = {
  pass_id: string;
  gig_id: string;
  name: string;
  created_by: string;
  expires_at: number;
  revoked: 0 | 1;
  code_id: string;
  claimed_by: string | null;
  can_see_chat: 0 | 1;
  can_see_setlists: 0 | 1;
};

/** A pass as the admin's Guests screen lists it. `claimedName` comes from the Directory, which knows the account. */
export type GuestPassView = {
  passId: string;
  gigId: string;
  name: string;
  expiresAt: number;
  revoked: boolean;
  claimedBy: string | null;
  claimedName: string | null;
  canSeeChat: boolean;
  canSeeSetlists: boolean;
};

/** What opening a pass shows before it is claimed: the gig and band by name, and when the pass ends. */
export type PassOpening = { bandId: string; gigId: string; gigName: string; bandName: string; expiresAt: number };

export type PassFields = { passId: string; gigId: string; name: string; expiresAt: number; canSeeChat: boolean; canSeeSetlists: boolean };

/** Where a pass stands for the account holding it. A gig that ended ends its passes with it. */
export type PassState = "live" | "revoked" | "ended";

/** Where the caller asks `inRoom` to let a guest in: one gig, any of their gigs, the band chat, or the band's setlists. */
export type GuestAccess = { gigId: string } | "gigs" | "chat" | "setlists";

export type GuestMe = { role: "guest"; user_id: string; pass: PassRow };

export function createGuestTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS guest_passes (
    pass_id TEXT PRIMARY KEY, gig_id TEXT NOT NULL, name TEXT NOT NULL, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0, code_id TEXT NOT NULL, claimed_by TEXT, can_see_chat INTEGER NOT NULL, can_see_setlists INTEGER NOT NULL
  )`);
}

/** The Directory's note of which gigs each account holds a pass for, so the phone's live gigs and the share guard can find them. */
export function createGuestIndex(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS guest_gigs (user_id TEXT NOT NULL, band_id TEXT NOT NULL, gig_id TEXT NOT NULL, PRIMARY KEY (user_id, gig_id))`);
}

export const guestGigsOf = (sql: SqlStorage, userId: string) => sql.exec<{ band_id: string; gig_id: string }>(`SELECT band_id, gig_id FROM guest_gigs WHERE user_id = ?`, userId).toArray();
export const guestBandIdsOf = (sql: SqlStorage, userId: string) => [...new Set(guestGigsOf(sql, userId).map((row) => row.band_id))];

const stateOf = (row: PassRow & { gig_status: string | null }, now: number): PassState =>
  row.revoked ? "revoked" : row.expires_at <= now || row.gig_status === null || row.gig_status === "ended" ? "ended" : "live";

/** Every pass `userId` holds in this room, each with where it stands. */
export function passesHeld(sql: SqlStorage, userId: string, now: number): { row: PassRow; state: PassState }[] {
  return sql
    .exec<PassRow & { gig_status: string | null }>(`SELECT p.*, g.status AS gig_status FROM guest_passes p LEFT JOIN gigs g ON g.gig_id = p.gig_id WHERE p.claimed_by = ?`, userId)
    .toArray()
    .map(({ gig_status, ...row }) => ({ row, state: stateOf({ ...row, gig_status }, now) }));
}

const grants = (row: PassRow, access: GuestAccess) =>
  access === "gigs" ? true : access === "chat" ? row.can_see_chat === 1 : access === "setlists" ? row.can_see_setlists === 1 : row.gig_id === access.gigId;

/**
 * The guest `userId` is here for `access`, or the refusal they hear: the pass's own end for the gig it names, `guest`
 * for anything a pass does not open, and `not-a-member` for someone who holds no pass at all.
 */
export function guestIn(sql: SqlStorage, userId: string, access: GuestAccess | undefined, now: number): GuestMe {
  const held = passesHeld(sql, userId, now);
  if (held.length === 0) throw refused("not-a-member");
  const live = access && held.find((pass) => pass.state === "live" && grants(pass.row, access));
  if (live) return { role: "guest", user_id: userId, pass: live.row };
  const forGig = typeof access === "object" ? held.find((pass) => pass.row.gig_id === access.gigId) : undefined;
  if (forGig) throw refused(forGig.state === "revoked" ? "pass-revoked" : "pass-ended");
  throw refused("guest");
}

/** Whether `userId` holds a live pass here, so the room's socket lets them in. */
export const holdsLivePass = (sql: SqlStorage, userId: string) => passesHeld(sql, userId, Date.now()).some((pass) => pass.state === "live");

/** The gigs `userId` follows as a guest now. */
export const liveGuestGigs = (sql: SqlStorage, userId: string) => new Set(passesHeld(sql, userId, Date.now()).flatMap((pass) => (pass.state === "live" ? [pass.row.gig_id] : [])));

/** Whether `userId` ever held a pass here. Tonight's charts stay the band's after the pass ends, so the share guard keeps asking. */
export const everAGuest = (sql: SqlStorage, userId: string) => sql.exec(`SELECT 1 FROM guest_passes WHERE claimed_by = ? LIMIT 1`, userId).toArray().length > 0;

const viewOf = (row: PassRow): GuestPassView => ({
  passId: row.pass_id,
  gigId: row.gig_id,
  name: row.name,
  expiresAt: row.expires_at,
  revoked: row.revoked === 1,
  claimedBy: row.claimed_by,
  claimedName: null,
  canSeeChat: row.can_see_chat === 1,
  canSeeSetlists: row.can_see_setlists === 1,
});

const passRow = (sql: SqlStorage, passId: string) => sql.exec<PassRow>(`SELECT * FROM guest_passes WHERE pass_id = ?`, passId).toArray()[0];
const gigOf = (sql: SqlStorage, gigId: string) => sql.exec<{ name: string; status: string }>(`SELECT name, status FROM gigs WHERE gig_id = ?`, gigId).toArray()[0];

/** A pass `userId` may open now. Someone else's pass says only that it is taken, before anything about its end. */
function usable(sql: SqlStorage, userId: string, passId: string, now: number): PassRow {
  const row = passRow(sql, passId);
  if (!row) throw refused("not-found");
  if (row.claimed_by !== null && row.claimed_by !== userId) throw refused("pass-claimed");
  if (row.revoked) throw refused("pass-revoked");
  const gig = gigOf(sql, row.gig_id);
  if (row.expires_at <= now || !gig || gig.status === "ended") throw refused("pass-ended");
  return row;
}

/** Every user id here is trusted: only the Directory calls these, after it has checked the session. */
export const guestRoom = {
  /** Only the admin makes a pass, for a gig not yet played. The same pass id again hands back the pass already made, so a retry makes no second pass. */
  create(band: RoomStore, adminId: string, fields: PassFields, codeId: string): { pass: GuestPassView; codeId: string; createdBy: string } {
    bandRoom.requireAdmin(band, adminId);
    const made = passRow(band.sql, fields.passId);
    if (made && made.gig_id !== fields.gigId) throw new Refused("bad-request");
    if (!made) {
      const gig = gigOf(band.sql, fields.gigId);
      if (!gig) throw refused("not-found");
      if (gig.status === "ended") throw refused("gig-ended");
      band.sql.exec(
        `INSERT INTO guest_passes (pass_id, gig_id, name, created_by, expires_at, revoked, code_id, claimed_by, can_see_chat, can_see_setlists) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
        fields.passId,
        fields.gigId,
        fields.name,
        adminId,
        fields.expiresAt,
        codeId,
        fields.canSeeChat ? 1 : 0,
        fields.canSeeSetlists ? 1 : 0,
      );
    }
    const row = passRow(band.sql, fields.passId);
    return { pass: viewOf(row), codeId: row.code_id, createdBy: row.created_by };
  },

  list(band: RoomStore, adminId: string, gigId: string): GuestPassView[] {
    bandRoom.requireAdmin(band, adminId);
    return band.sql.exec<PassRow>(`SELECT * FROM guest_passes WHERE gig_id = ? ORDER BY expires_at, rowid`, gigId).toArray().map(viewOf);
  },

  /**
   * Revoke ends the pass and replaces the gig secret (`secret_rev`), so a secret the guest's phone kept no longer joins
   * by QR. The pack rev goes up with it, so lineup phones fetch the new secret. Revoking again changes nothing.
   */
  revoke(band: RoomStore, adminId: string, passId: string): { pass: GuestPassView; codeId: string; claimedBy: string | null } {
    bandRoom.requireAdmin(band, adminId);
    const row = passRow(band.sql, passId);
    if (!row) throw refused("not-found");
    if (!row.revoked) {
      band.sql.exec(`UPDATE guest_passes SET revoked = 1 WHERE pass_id = ?`, passId);
      band.sql.exec(`UPDATE gigs SET secret_rev = secret_rev + 1, rev = rev + 1 WHERE gig_id = ?`, row.gig_id);
    }
    const after = passRow(band.sql, passId);
    return { pass: viewOf(after), codeId: after.code_id, claimedBy: after.claimed_by };
  },

  open(band: RoomStore, userId: string, passId: string, now: number): PassOpening {
    const row = usable(band.sql, userId, passId, now);
    return { bandId: band.bandId, gigId: row.gig_id, gigName: gigOf(band.sql, row.gig_id).name, bandName: bandRoom.nameOf(band), expiresAt: row.expires_at };
  },

  /** Binds the pass to the first account that opens it. The read and the write are one step, so two phones opening one code at once can't both hold it. */
  claim(band: RoomStore, userId: string, passId: string, now: number): PassOpening {
    const opening = guestRoom.open(band, userId, passId, now);
    band.sql.exec(`UPDATE guest_passes SET claimed_by = ? WHERE pass_id = ? AND claimed_by IS NULL`, userId, passId);
    return opening;
  },
};

function passIdIn(value: unknown): string {
  if (typeof value !== "string" || !PASS_ID.test(value)) throw new Refused("bad-request");
  return value;
}

function fieldsIn(c: Context): PassFields {
  const { name, expiresAt, canSeeChat, canSeeSetlists } = c.body;
  const shown = name === undefined ? "" : typeof name === "string" ? name.trim().replace(/\s+/g, " ") : null;
  if (shown === null || shown.length > MAX_NAME) throw new Refused("bad-request");
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= c.now || expiresAt > c.now + MAX_PASS_MS) throw new Refused("bad-request");
  if (typeof canSeeChat !== "boolean" || typeof canSeeSetlists !== "boolean") throw new Refused("bad-request");
  return { passId: passIdIn(c.body.passId), gigId: gigIdIn(c.body.gigId), name: shown, expiresAt, canSeeChat, canSeeSetlists };
}

/** The admin sees who holds each pass by the name bandmates see. */
const named = (c: Context, pass: GuestPassView): GuestPassView => ({ ...pass, claimedName: pass.claimedBy ? (userById(c.sql, pass.claimedBy)?.display_name ?? null) : null });

/** A guest code names the band and the pass. The phone never sees the pass id in it. */
async function passOf(c: Context) {
  const row = await liveCode(c.sql, c.env, c.body.code, c.now, { kind: "guest", refusal: "not-a-guest-code" });
  const [bandId, passId] = row.target_id.split("/");
  return { room: roomOf(c, bandId), passId };
}

export const GUEST_ROUTES: Record<string, Route> = {
  /** The pass and its code are made in one step, the code ending when the pass does, so a pass never goes out without its code. */
  async "POST /api/bands/guests/create"(c) {
    const bandId = bandIdIn(c.body);
    const user = signedIn(c);
    const fields = fieldsIn(c);
    const made = await fromRoom(roomOf(c, bandId).guestCreate(user.user_id, fields, toBase64Url(randomBytes(12))));
    const code = storeCode(c, { code_id: made.codeId, kind: "guest", target_id: `${bandId}/${made.pass.passId}`, created_by: made.createdBy, expires_at: made.pass.expiresAt });
    return { body: { pass: named(c, made.pass), ...(await codeView(c.env, code)) } };
  },

  async "POST /api/bands/guests/list"(c) {
    const bandId = bandIdIn(c.body);
    const passes = await fromRoom(roomOf(c, bandId).guestList(signedIn(c).user_id, gigIdIn(c.body.gigId)));
    return { body: { passes: passes.map((pass) => named(c, pass)) } };
  },

  async "POST /api/bands/guests/revoke"(c) {
    const bandId = bandIdIn(c.body);
    const revoked = await fromRoom(roomOf(c, bandId).guestRevoke(signedIn(c).user_id, passIdIn(c.body.passId)));
    c.sql.exec(`UPDATE codes SET stopped_at = coalesce(stopped_at, ?) WHERE code_id = ?`, c.now, revoked.codeId);
    return { body: { pass: named(c, revoked.pass) } };
  },

  async "POST /api/guest/open"(c) {
    const me = signedIn(c).user_id;
    const { room, passId } = await passOf(c);
    return { body: await fromRoom(room.guestOpen(me, passId, c.now)) };
  },

  async "POST /api/guest/claim"(c) {
    const me = signedIn(c).user_id;
    const { room, passId } = await passOf(c);
    const opening = await fromRoom(room.guestClaim(me, passId, c.now));
    c.sql.exec(`INSERT OR IGNORE INTO guest_gigs (user_id, band_id, gig_id) VALUES (?, ?, ?)`, me, opening.bandId, opening.gigId);
    return { body: opening };
  },
};
