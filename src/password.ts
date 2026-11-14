export const MIN_PASSWORD_LENGTH = 10;
const PBKDF2_ROUNDS = 600_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

const toText = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const toBytes = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export const newSalt = () => toText(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));

/** The slow part of password storage, run on the phone: PBKDF2-SHA256 at 600,000 rounds. Only this 32-byte result is sent. */
export async function passwordKey(password: string, salt: string): Promise<string> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: toBytes(salt), iterations: PBKDF2_ROUNDS }, material, KEY_BITS);
  return toText(new Uint8Array(bits));
}

export const parseCommonPasswords = (text: string) => new Set(text.split("\n").map((line) => line.trim()).filter(Boolean));

let common: Promise<Set<string>> | null = null;

/** The 5,000 common passwords of 10 or more characters, fetched once when a password screen first needs them. */
export function commonPasswords(): Promise<Set<string>> {
  common ??= fetch(new URL("common-passwords.txt", document.baseURI))
    .then((reply) => (reply.ok ? reply.text() : Promise.reject(new Error("offline"))))
    .then(parseCommonPasswords)
    .catch((error) => {
      common = null;
      throw error;
    });
  return common;
}

export function passwordProblem(password: string, list: ReadonlySet<string>): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (list.has(password.toLowerCase())) return "That password is on a list of common passwords. Pick another.";
  return null;
}
