import { toBase64Url, utf8 } from "./bytes";
import { Refused } from "./refused";

export const SALT_BYTES = 16;
export const KEY_BYTES = 32;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const FREE_MISSES = 5;
const WAIT_MINUTES = [1, 5, 15, 60];
const ADDRESS_MISSES = 30;
const ADDRESS_WINDOW_MINUTES = 10;
const ADDRESS_WAIT_MINUTES = 15;

/** How wrong tries on one counter turn into a wait. A wait never grows past 60 minutes, so nobody is locked out for good. */
export interface WaitRule {
  windowMs: number;
  waitMs(misses: number): number;
}

/** The pepper (a Worker secret) and the rules for waits. `PASSWORD_MINUTE_MS` shortens a minute for checks. */
export interface PasswordSecrets {
  pepper: CryptoKey;
  forName: WaitRule;
  forAddress: WaitRule;
}

export async function passwordSecrets(env: { PASSWORD_PEPPER?: string; PASSWORD_MINUTE_MS?: string }): Promise<PasswordSecrets> {
  if (!env.PASSWORD_PEPPER || env.PASSWORD_PEPPER.length < 32) throw new Refused("not-configured", 503);
  const minute = Number(env.PASSWORD_MINUTE_MS) || MINUTE_MS;
  return {
    pepper: await crypto.subtle.importKey("raw", utf8(env.PASSWORD_PEPPER), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    forName: { windowMs: DAY_MS, waitMs: (misses) => (misses < FREE_MISSES ? 0 : WAIT_MINUTES[Math.min(misses - FREE_MISSES, WAIT_MINUTES.length - 1)] * minute) },
    forAddress: { windowMs: ADDRESS_WINDOW_MINUTES * minute, waitMs: (misses) => (misses < ADDRESS_MISSES ? 0 : ADDRESS_WAIT_MINUTES * minute) },
  };
}

const mac = async (pepper: CryptoKey, bytes: Uint8Array) => new Uint8Array(await crypto.subtle.sign("HMAC", pepper, bytes));

/** What the Directory stores for a password: HMAC-SHA256(pepper, the phone's PBKDF2 result). */
export const keyMac = async (secrets: PasswordSecrets, key: Uint8Array) => toBase64Url(await mac(secrets.pepper, key));

/** The salt answer for an @name with no password: derived from the name, so it is the same every time and looks like a real one. */
export const madeUpSalt = async (secrets: PasswordSecrets, handle: string) => toBase64Url((await mac(secrets.pepper, utf8(`salt:${handle}`))).slice(0, SALT_BYTES));

/** The key a wait counter is stored under, so a typed @name or a network address is never kept as written. */
export const counterKey = async (secrets: PasswordSecrets, kind: "name" | "address", value: string) => toBase64Url(await mac(secrets.pepper, utf8(`${kind}:${value}`)));

export function sameText(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return diff === 0;
}
