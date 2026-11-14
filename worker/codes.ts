import { CODE_KINDS, CODE_REFUSED, CODE_SCREEN, readPayload, signedText, type CodeFields, type CodeKind } from "../src/code-link";
import { reshareable } from "../src/share-rule";
import { fromBase64Url, randomBytes, toBase64Url, utf8 } from "./bytes";
import { signedIn, type Context, type Route, type User } from "./directory-account";
import type { Env } from "./index";
import { Refused } from "./refused";
import { bandInviteTarget } from "./room-members";
import { hmacKey } from "./session";

const MINUTE_MS = 60 * 1000;
const DAY_MINUTES = 24 * 60;
const MAX_SONGS = 500;

export const LANDING_PATH = /^\/c\/([^/]+)$/;

export function createCodeTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS codes (
    code_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    stopped_at INTEGER,
    song_ids TEXT,
    shared_as TEXT,
    created_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS codes_by_owner ON codes (created_by, kind, expires_at)`);
}

export type CodeRow = {
  code_id: string;
  kind: CodeKind;
  target_id: string;
  created_by: string;
  nonce: string;
  expires_at: number;
  stopped_at: number | null;
  song_ids: string | null;
  shared_as: string | null;
  created_at: number;
};

type Target = { targetId: string; songIds?: string[]; sharedAs?: "private" | "public" };

/** How a signed-in player gets each kind of code. A kind with no entry can't be made yet. */
interface Minter {
  minutes: number;
  /** Hand back the player's live code of this kind instead of making another, so Stop this code stops the one link they shared. */
  reuse?: true;
  target(c: Context, user: User): Target | Promise<Target>;
}

function setlistCopy(body: Record<string, unknown>): Target {
  const { setlistId, songIds, sharedAs } = body;
  if (!reshareable({ reshareable: body.reshareable === true }, "public")) throw new Refused("shared-privately", 403);
  if (typeof setlistId !== "string" || !/^[A-Za-z0-9_/-]{1,80}$/.test(setlistId)) throw new Refused("bad-request");
  if (!Array.isArray(songIds) || songIds.length < 1 || songIds.length > MAX_SONGS || !songIds.every((id) => typeof id === "string" && id.length <= 80)) throw new Refused("bad-request");
  if (sharedAs !== "private" && sharedAs !== "public") throw new Refused("bad-request");
  return { targetId: setlistId, songIds, sharedAs };
}

const MINTERS: Partial<Record<CodeKind, Minter>> = {
  "friend-now": { minutes: 10, target: (_, user) => ({ targetId: user.user_id }) },
  "friend-link": { minutes: 7 * DAY_MINUTES, reuse: true, target: (_, user) => ({ targetId: user.user_id }) },
  "my-setlist": { minutes: 7 * DAY_MINUTES, target: (c) => setlistCopy(c.body) },
  band: { minutes: 7 * DAY_MINUTES, reuse: true, target: bandInviteTarget },
};

const fieldsOf = (row: CodeRow): CodeFields => ({ kind: row.kind, codeId: row.code_id, expiresAt: row.expires_at, nonce: row.nonce });

async function payloadFor(env: Env, row: CodeRow): Promise<string> {
  const text = signedText(fieldsOf(row));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET), utf8(`code:${text}`));
  return `${text}.${toBase64Url(new Uint8Array(mac))}`;
}

async function codeView(env: Env, row: CodeRow) {
  const code = await payloadFor(env, row);
  return { kind: row.kind, code, link: `${env.APP_ORIGIN ?? ""}/c/${code}`, expiresAt: row.expires_at };
}

/**
 * The row of a code that is real, not past its end time, and not stopped.
 * The signature is checked first, so a made-up code never reaches the table.
 */
export async function liveCode(sql: SqlStorage, env: Env, payload: unknown, now: number): Promise<CodeRow> {
  const fields = typeof payload === "string" ? readPayload(payload) : null;
  const mac = fields && fromBase64Url(fields.mac);
  const key = await hmacKey(env.SESSION_SECRET);
  if (!fields || !mac || !(await crypto.subtle.verify("HMAC", key, mac, utf8(`code:${signedText(fields)}`)))) throw new Refused("bad-code", 404);
  if (fields.expiresAt <= now) throw new Refused("code-ended", 410);
  const row = sql.exec<CodeRow>(`SELECT * FROM codes WHERE code_id = ?`, fields.codeId).toArray()[0];
  if (!row || row.kind !== fields.kind || row.expires_at !== fields.expiresAt) throw new Refused("bad-code", 404);
  if (row.stopped_at !== null) throw new Refused("code-stopped", 410);
  return row;
}

export const CODE_ROUTES: Record<string, Route> = {
  async "POST /api/codes"(c) {
    const kind = c.body.kind;
    const minter = typeof kind === "string" && (CODE_KINDS as readonly string[]).includes(kind) ? MINTERS[kind as CodeKind] : undefined;
    if (!minter) throw new Refused("bad-kind");
    const user = signedIn(c);
    const target = await minter.target(c, user);
    const reused = minter.reuse
      ? c.sql
          .exec<CodeRow>(`SELECT * FROM codes WHERE created_by = ? AND kind = ? AND target_id = ? AND stopped_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`, user.user_id, kind, target.targetId, c.now)
          .toArray()[0]
      : undefined;
    if (reused) return { body: await codeView(c.env, reused) };
    const row: CodeRow = {
      code_id: toBase64Url(randomBytes(12)),
      kind: kind as CodeKind,
      target_id: target.targetId,
      created_by: user.user_id,
      nonce: toBase64Url(randomBytes(6)),
      expires_at: c.now + minter.minutes * (Number(c.env.CODE_MINUTE_MS) || MINUTE_MS),
      stopped_at: null,
      song_ids: target.songIds ? JSON.stringify(target.songIds) : null,
      shared_as: target.sharedAs ?? null,
      created_at: c.now,
    };
    c.sql.exec(`DELETE FROM codes WHERE expires_at <= ?`, c.now);
    c.sql.exec(
      `INSERT INTO codes (code_id, kind, target_id, created_by, nonce, expires_at, song_ids, shared_as, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.code_id,
      row.kind,
      row.target_id,
      row.created_by,
      row.nonce,
      row.expires_at,
      row.song_ids,
      row.shared_as,
      c.now,
    );
    return { body: await codeView(c.env, row) };
  },

  async "POST /api/codes/stop"(c) {
    const fields = typeof c.body.code === "string" ? readPayload(c.body.code) : null;
    const user = signedIn(c);
    const stopped = fields ? c.sql.exec(`UPDATE codes SET stopped_at = coalesce(stopped_at, ?) WHERE code_id = ? AND created_by = ?`, c.now, fields.codeId, user.user_id).rowsWritten : 0;
    if (stopped !== 1) throw new Refused("not-found", 404);
    return { body: { ok: true } };
  },
};

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * `GET /c/<payload>`, the link inside every QR code. A live code goes on to the screen for its kind with the payload,
 * so a phone's own camera app and a plain browser land where the in-app scanner does. Anything else gets a short page saying why.
 */
export async function codeLanding(sql: SqlStorage, env: Env, payload: string): Promise<Response> {
  const origin = env.APP_ORIGIN ?? "";
  try {
    const row = await liveCode(sql, env, payload, Date.now());
    return new Response(null, { status: 302, headers: { Location: `${origin}/?open=${CODE_SCREEN[row.kind]}&code=${payload}`, "Cache-Control": "no-store" } });
  } catch (error) {
    if (!(error instanceof Refused) || !(error.reason in CODE_REFUSED)) throw error;
    const text = CODE_REFUSED[error.reason as keyof typeof CODE_REFUSED];
    const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>My Lead Sheet</title><p>${escapeHtml(text)}</p><p><a href="${escapeHtml(origin)}/">Open My Lead Sheet</a></p></html>`;
    return new Response(page, { status: error.status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
}
