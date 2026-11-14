import { clientChallenge, creationOptions, relyingParty, requestOptions, verifyAssertion, verifyRegistration, type Ceremony } from "./auth-passkey";
import { fromBase64Url, randomBytes, sha256, toBase64Url, utf8 } from "./bytes";
import type { Env } from "./index";
import { Refused } from "./refused";
import { CLEARED_COOKIE, needsRenewal, readSession, sessionCookie, signSession, type Session } from "./session";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    session_version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS passkeys (
    credential_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (user_id),
    public_key BLOB NOT NULL,
    sign_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS passkeys_by_user ON passkeys (user_id)`,
  `CREATE TABLE IF NOT EXISTS backup_codes (
    user_id TEXT NOT NULL REFERENCES users (user_id),
    code_hash TEXT NOT NULL,
    used_at INTEGER,
    PRIMARY KEY (user_id, code_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS challenges (
    challenge TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS open_rooms (
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    PRIMARY KEY (user_id, room_id)
  )`,
  `CREATE TABLE IF NOT EXISTS room_closes (
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_id)
  )`,
];

type User = { user_id: string; handle: string; display_name: string; session_version: number };
type PasskeyRow = { credential_id: string; user_id: string; public_key: ArrayBuffer; sign_count: number; created_at: number; last_used_at: number | null };
type ChallengeRow = { purpose: Purpose; user_id: string; display_name: string; expires_at: number };
type Purpose = "create" | "add" | "sign-in";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_LENGTH = 12;
const MAX_BODY_BYTES = 16 * 1024;
const ROOM_CLOSE_RETRY_MS = 30 * 1000;

const crockford = (bytes: Uint8Array) => Array.from(bytes, (byte) => CROCKFORD[byte & 31]).join("");

function ulid(now: number): string {
  let time = "";
  for (let rest = now, index = 0; index < 10; index += 1, rest = Math.floor(rest / 32)) time = CROCKFORD[rest % 32] + time;
  return time + crockford(randomBytes(16));
}

export function createAccountTables(sql: SqlStorage) {
  for (const statement of SCHEMA) sql.exec(statement);
}

function displayName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (name.length < 1 || name.length > 40) throw new Refused("bad-name");
  return name;
}

/** A free lowercase @handle from the display name: "Sam Rivera" becomes samrivera, then samrivera2 on a clash. */
function freeHandle(sql: SqlStorage, name: string): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 20) || "player";
  const taken = new Set(sql.exec<{ handle: string }>(`SELECT handle FROM users WHERE handle = ?1 OR handle GLOB ?1 || '[0-9]*'`, base).toArray().map((row) => row.handle));
  for (let n = 1; ; n += 1) {
    const handle = n === 1 ? base : `${base}${n}`;
    if (!taken.has(handle)) return handle;
  }
}

const normalizeCode = (code: unknown) =>
  typeof code === "string" ? code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1") : "";

const hashCode = async (userId: string, code: string) => toBase64Url(await sha256(utf8(`${userId}:${code}`)));

/** Eight fresh one-time codes shown once, and their hashes for storage. */
async function makeBackupCodes(userId: string): Promise<{ shown: string[]; hashes: string[] }> {
  const raw = Array.from({ length: BACKUP_CODE_COUNT }, () => crockford(randomBytes(BACKUP_CODE_LENGTH)));
  return { shown: raw.map((code) => code.match(/.{4}/g)!.join("-")), hashes: await Promise.all(raw.map((code) => hashCode(userId, code))) };
}

function storeBackupCodes(sql: SqlStorage, userId: string, hashes: string[]) {
  sql.exec(`DELETE FROM backup_codes WHERE user_id = ?`, userId);
  for (const hash of hashes) sql.exec(`INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)`, userId, hash);
}

function ways(sql: SqlStorage, userId: string) {
  return sql
    .exec<PasskeyRow>(`SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at`, userId)
    .toArray()
    .map((row) => ({ kind: "passkey", id: row.credential_id, createdAt: row.created_at, lastUsedAt: row.last_used_at }));
}

function accountView(sql: SqlStorage, user: User) {
  const left = sql.exec<{ left: number }>(`SELECT count(*) AS left FROM backup_codes WHERE user_id = ? AND used_at IS NULL`, user.user_id).one().left;
  return { userId: user.user_id, handle: user.handle, displayName: user.display_name, ways: ways(sql, user.user_id), backupCodesLeft: left };
}

const userById = (sql: SqlStorage, userId: string) => sql.exec<User>(`SELECT * FROM users WHERE user_id = ?`, userId).toArray()[0];

function newChallenge(sql: SqlStorage, env: Env, now: number, purpose: Purpose, userId: string, name: string) {
  const ttlMs = (Number(env.CHALLENGE_TTL_SECONDS) || 300) * 1000;
  const challenge = toBase64Url(randomBytes(32));
  sql.exec(`DELETE FROM challenges WHERE expires_at <= ?`, now);
  sql.exec(`INSERT INTO challenges (challenge, purpose, user_id, display_name, expires_at) VALUES (?, ?, ?, ?, ?)`, challenge, purpose, userId, name, now + ttlMs);
  return { challenge, ttlMs };
}

/** Uses up the challenge the browser signed. A second use, an expired one, or one from another flow is refused. */
function takeChallenge(sql: SqlStorage, clientDataJSON: Uint8Array, ceremony: Ceremony, purpose: Purpose, env: Env, now: number): ChallengeRow {
  const challenge = clientChallenge(clientDataJSON, ceremony, relyingParty(env));
  const row = sql.exec<ChallengeRow>(`DELETE FROM challenges WHERE challenge = ? RETURNING purpose, user_id, display_name, expires_at`, challenge).toArray()[0];
  if (!row || row.purpose !== purpose) throw new Refused("wrong-challenge");
  if (row.expires_at <= now) throw new Refused("challenge-expired");
  return row;
}

function bytesField(source: unknown, name: string): Uint8Array {
  const value = typeof source === "object" && source !== null ? (source as Record<string, unknown>)[name] : undefined;
  const bytes = typeof value === "string" ? fromBase64Url(value) : null;
  if (!bytes) throw new Refused("bad-request");
  return bytes;
}

function credentialId(body: Record<string, unknown>): string {
  if (typeof body.id !== "string" || !fromBase64Url(body.id)) throw new Refused("bad-request");
  return body.id;
}

/** Verifies a new passkey from `{id, clientDataJSON, attestationObject}` for this flow, and checks it is not already stored. */
async function registeredPasskey(c: Context, purpose: Purpose) {
  const id = credentialId(c.body);
  const challenge = takeChallenge(c.sql, bytesField(c.body, "clientDataJSON"), "webauthn.create", purpose, c.env, c.now);
  const passkey = await verifyRegistration(relyingParty(c.env), bytesField(c.body, "attestationObject"), id);
  if (c.sql.exec(`SELECT 1 FROM passkeys WHERE credential_id = ?`, id).toArray().length) throw new Refused("passkey-exists", 409);
  return { challenge, passkey };
}

function insertPasskey(sql: SqlStorage, userId: string, passkey: { credentialId: string; publicKey: Uint8Array; signCount: number }, now: number) {
  const key = passkey.publicKey.buffer.slice(passkey.publicKey.byteOffset, passkey.publicKey.byteOffset + passkey.publicKey.byteLength);
  sql.exec(`INSERT INTO passkeys (credential_id, user_id, public_key, sign_count, created_at) VALUES (?, ?, ?, ?, ?)`, passkey.credentialId, userId, key, passkey.signCount, now);
}

interface Context {
  storage: DurableObjectStorage;
  sql: SqlStorage;
  env: Env;
  now: number;
  body: Record<string, unknown>;
  user: User | null;
}

interface Reply {
  body: unknown;
  signIn?: User;
  signOut?: true;
}

function signedIn(c: Context): User {
  if (!c.user) throw new Refused("signed-out", 401);
  return c.user;
}

const ROUTES: Record<string, (c: Context) => Promise<Reply>> = {
  async "POST /api/auth/passkey/create/options"(c) {
    const name = displayName(c.body.name);
    const userId = ulid(c.now);
    const { challenge, ttlMs } = newChallenge(c.sql, c.env, c.now, "create", userId, name);
    const user = { id: userId, handle: freeHandle(c.sql, name), displayName: name };
    return { body: { options: creationOptions(relyingParty(c.env), challenge, user, [], ttlMs) } };
  },

  async "POST /api/auth/passkey/create/finish"(c) {
    const { challenge, passkey } = await registeredPasskey(c, "create");
    const codes = await makeBackupCodes(challenge.user_id);
    const user = c.storage.transactionSync(() => {
      const handle = freeHandle(c.sql, challenge.display_name);
      c.sql.exec(`INSERT INTO users (user_id, handle, display_name, created_at, session_version) VALUES (?, ?, ?, ?, 1)`, challenge.user_id, handle, challenge.display_name, c.now);
      insertPasskey(c.sql, challenge.user_id, passkey, c.now);
      storeBackupCodes(c.sql, challenge.user_id, codes.hashes);
      return userById(c.sql, challenge.user_id);
    });
    return { body: { account: accountView(c.sql, user), backupCodes: codes.shown }, signIn: user };
  },

  async "POST /api/auth/passkey/add/options"(c) {
    const user = signedIn(c);
    const { challenge, ttlMs } = newChallenge(c.sql, c.env, c.now, "add", user.user_id, user.display_name);
    const exclude = ways(c.sql, user.user_id).map((way) => way.id);
    const options = creationOptions(relyingParty(c.env), challenge, { id: user.user_id, handle: user.handle, displayName: user.display_name }, exclude, ttlMs);
    return { body: { options } };
  },

  async "POST /api/auth/passkey/add/finish"(c) {
    const user = signedIn(c);
    const { challenge, passkey } = await registeredPasskey(c, "add");
    if (challenge.user_id !== user.user_id) throw new Refused("wrong-challenge");
    insertPasskey(c.sql, user.user_id, passkey, c.now);
    return { body: { account: accountView(c.sql, user) } };
  },

  async "POST /api/auth/passkey/sign-in/options"(c) {
    const { challenge, ttlMs } = newChallenge(c.sql, c.env, c.now, "sign-in", "", "");
    return { body: { options: requestOptions(relyingParty(c.env), challenge, ttlMs) } };
  },

  async "POST /api/auth/passkey/sign-in/finish"(c) {
    const id = credentialId(c.body);
    const clientDataJSON = bytesField(c.body, "clientDataJSON");
    takeChallenge(c.sql, clientDataJSON, "webauthn.get", "sign-in", c.env, c.now);
    const row = c.sql.exec<PasskeyRow>(`SELECT * FROM passkeys WHERE credential_id = ?`, id).toArray()[0];
    if (!row) throw new Refused("unknown-passkey", 401);
    if (typeof c.body.userHandle === "string" && new TextDecoder().decode(bytesField(c.body, "userHandle")) !== row.user_id) throw new Refused("wrong-user", 401);
    const response = { clientDataJSON, authenticatorData: bytesField(c.body, "authenticatorData"), signature: bytesField(c.body, "signature") };
    const signCount = await verifyAssertion(relyingParty(c.env), { publicKey: new Uint8Array(row.public_key), signCount: row.sign_count }, response);
    c.sql.exec(`UPDATE passkeys SET sign_count = max(sign_count, ?), last_used_at = ? WHERE credential_id = ?`, signCount, c.now, id);
    const user = userById(c.sql, row.user_id);
    return { body: { account: accountView(c.sql, user) }, signIn: user };
  },

  async "POST /api/auth/backup-code"(c) {
    const handle = typeof c.body.handle === "string" ? c.body.handle.trim().replace(/^@/, "").toLowerCase() : "";
    const user = c.sql.exec<User>(`SELECT * FROM users WHERE handle = ?`, handle).toArray()[0];
    const hash = user ? await hashCode(user.user_id, normalizeCode(c.body.code)) : "";
    const used = user ? c.sql.exec(`UPDATE backup_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`, c.now, user.user_id, hash).rowsWritten : 0;
    if (!user || used !== 1) throw new Refused("wrong-code", 401);
    return { body: { account: accountView(c.sql, user) }, signIn: user };
  },

  async "GET /api/me"(c) {
    return { body: { account: accountView(c.sql, signedIn(c)) } };
  },

  async "POST /api/me/backup-codes"(c) {
    const user = signedIn(c);
    const codes = await makeBackupCodes(user.user_id);
    storeBackupCodes(c.sql, user.user_id, codes.hashes);
    return { body: { account: accountView(c.sql, user), backupCodes: codes.shown } };
  },

  async "POST /api/me/remove-passkey"(c) {
    const user = signedIn(c);
    const list = ways(c.sql, user.user_id);
    if (!list.some((way) => way.id === c.body.id)) throw new Refused("not-found", 404);
    if (list.length <= 1) throw new Refused("last-way", 409);
    c.sql.exec(`DELETE FROM passkeys WHERE credential_id = ? AND user_id = ?`, c.body.id, user.user_id);
    return { body: { account: accountView(c.sql, user) } };
  },

  async "POST /api/auth/sign-out"() {
    return { body: { ok: true }, signOut: true };
  },

  async "POST /api/auth/sign-out-everywhere"(c) {
    const user = signedIn(c);
    c.storage.transactionSync(() => {
      const version = user.session_version + 1;
      c.sql.exec(`UPDATE users SET session_version = ? WHERE user_id = ?`, version, user.user_id);
      c.sql.exec(
        `INSERT INTO room_closes (user_id, room_id, version) SELECT user_id, room_id, ? FROM open_rooms WHERE user_id = ?
         ON CONFLICT (user_id, room_id) DO UPDATE SET version = excluded.version`,
        version,
        user.user_id,
      );
      c.sql.exec(`DELETE FROM open_rooms WHERE user_id = ?`, user.user_id);
    });
    await closeRooms(c.storage, c.env);
    return { body: { ok: true }, signOut: true };
  },
};

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method !== "POST") return {};
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Refused("too-large", 413);
  let body: unknown;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    throw new Refused("bad-request");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Refused("bad-request");
  return body as Record<string, unknown>;
}

/** The cookie a reply sets: a new session on sign-in, a cleared one on sign-out, or a renewed one for a session older than a day. */
async function replyCookie(env: Env, reply: Reply, session: Session | null, user: User | null, now: number): Promise<string | null> {
  if (reply.signOut) return CLEARED_COOKIE;
  if (reply.signIn) return sessionCookie(await signSession(env.SESSION_SECRET, { userId: reply.signIn.user_id, version: reply.signIn.session_version, issuedAt: now }));
  if (session && user && needsRenewal(session, now)) return sessionCookie(await signSession(env.SESSION_SECRET, { ...session, issuedAt: now }));
  return null;
}

/** Serves every account route the Directory owns. Unknown paths are 404, refusals are `{error}` with their status. */
export async function handleAccountRequest(request: Request, storage: DurableObjectStorage, env: Env): Promise<Response> {
  const route = ROUTES[`${request.method} ${new URL(request.url).pathname}`];
  if (!route) return Response.json({ error: "not-found" }, { status: 404 });
  const headers = new Headers({ "Cache-Control": "no-store" });
  try {
    const now = Date.now();
    const session = await readSession(env.SESSION_SECRET, request.headers.get("Cookie"), now);
    const found = session ? userById(storage.sql, session.userId) : undefined;
    const user = found && found.session_version === session?.version ? found : null;
    const reply = await route({ storage, sql: storage.sql, env, now, body: await readBody(request), user });
    const cookie = await replyCookie(env, reply, session, user, now);
    if (cookie) headers.set("Set-Cookie", cookie);
    return Response.json(reply.body, { headers });
  } catch (error) {
    if (error instanceof Refused) return Response.json({ error: error.reason }, { status: error.status, headers });
    throw error;
  }
}

/** Lets a socket into a room only under the user's current session, and remembers the room so Sign out everywhere can close it. */
export function authorizeRoom(sql: SqlStorage, userId: string, version: number, roomId: string): boolean {
  if (userById(sql, userId)?.session_version !== version) return false;
  sql.exec(`INSERT OR IGNORE INTO open_rooms (user_id, room_id) VALUES (?, ?)`, userId, roomId);
  return true;
}

/** Tells each room to close sockets from older sessions. Rooms that fail stay queued, and the alarm retries them. */
export async function closeRooms(storage: DurableObjectStorage, env: Env) {
  const pending = storage.sql.exec<{ user_id: string; room_id: string; version: number }>(`SELECT * FROM room_closes`).toArray();
  if (pending.length === 0) return;
  await storage.setAlarm(Date.now() + ROOM_CLOSE_RETRY_MS);
  const results = await Promise.allSettled(pending.map((row) => env.ROOM.getByName(row.room_id).closeUser(row.user_id, row.version)));
  pending.forEach((row, index) => {
    if (results[index].status === "fulfilled") storage.sql.exec(`DELETE FROM room_closes WHERE user_id = ? AND room_id = ? AND version = ?`, row.user_id, row.room_id, row.version);
  });
}
