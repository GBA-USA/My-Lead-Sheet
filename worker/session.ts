import { fromBase64Url, toBase64Url, utf8 } from "./bytes";
import { Refused } from "./refused";

/** What a signed-in phone's cookie proves: who it is, which `session_version` it was issued under, and when. */
export interface Session {
  userId: string;
  version: number;
  issuedAt: number;
}

const COOKIE = "mls_session";
const DAY_MS = 24 * 60 * 60 * 1000;
const LIFETIME_MS = 90 * DAY_MS;
const RENEW_AFTER_MS = DAY_MS;
const CLOCK_SLACK_MS = 5 * 60 * 1000;
const ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Lax";

async function hmacKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Refused("not-configured", 503);
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const payload = (session: Session) => `${session.userId}.${session.version}.${session.issuedAt}`;

export async function signSession(secret: string | undefined, session: Session): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(payload(session)));
  return `${payload(session)}.${toBase64Url(new Uint8Array(signature))}`;
}

/** The session in a `Cookie` header, or null when it is missing, tampered with, or past its 90 days. */
export async function readSession(secret: string | undefined, cookieHeader: string | null, now: number): Promise<Session | null> {
  const key = await hmacKey(secret);
  const value = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const parts = value?.split(".");
  if (!parts || parts.length !== 4) return null;
  const [userId, versionText, issuedText, signatureText] = parts;
  const session = { userId, version: Number(versionText), issuedAt: Number(issuedText) };
  const signature = fromBase64Url(signatureText);
  if (!signature || !Number.isSafeInteger(session.version) || !Number.isSafeInteger(session.issuedAt)) return null;
  if (!(await crypto.subtle.verify("HMAC", key, signature, utf8(parts.slice(0, 3).join("."))))) return null;
  if (now >= session.issuedAt + LIFETIME_MS || session.issuedAt > now + CLOCK_SLACK_MS) return null;
  return session;
}

export const needsRenewal = (session: Session, now: number) => now - session.issuedAt > RENEW_AFTER_MS;

export const sessionCookie = (value: string) => `${COOKIE}=${value}; ${ATTRIBUTES}; Max-Age=${LIFETIME_MS / 1000}`;

export const CLEARED_COOKIE = `${COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;
