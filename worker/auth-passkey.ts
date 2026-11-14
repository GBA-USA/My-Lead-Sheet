import { sameBytes, sha256, toBase64Url, utf8 } from "./bytes";
import { Refused } from "./refused";

/** Who the passkeys belong to, from the Worker's vars. A passkey made for one RP id never works for another. */
export interface RelyingParty {
  id: string;
  name: string;
  origin: string;
}

export function relyingParty(env: { RP_ID?: string; RP_NAME?: string; APP_ORIGIN?: string }): RelyingParty {
  if (!env.RP_ID || !env.APP_ORIGIN) throw new Refused("not-configured", 503);
  return { id: env.RP_ID, name: env.RP_NAME || env.RP_ID, origin: env.APP_ORIGIN };
}

export type Ceremony = "webauthn.create" | "webauthn.get";

export interface NewPasskey {
  credentialId: string;
  publicKey: Uint8Array;
  signCount: number;
}

const ES256 = -7;
const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const ATTESTED_CREDENTIAL = 0x40;

export function creationOptions(rp: RelyingParty, challenge: string, user: { id: string; handle: string; displayName: string }, exclude: string[], timeoutMs: number) {
  return {
    challenge,
    rp: { id: rp.id, name: rp.name },
    user: { id: toBase64Url(utf8(user.id)), name: `@${user.handle}`, displayName: user.displayName },
    pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    attestation: "none",
    excludeCredentials: exclude.map((id) => ({ type: "public-key", id })),
    timeout: timeoutMs,
  };
}

export function requestOptions(rp: RelyingParty, challenge: string, timeoutMs: number) {
  return { challenge, rpId: rp.id, userVerification: "required", timeout: timeoutMs };
}

/** Checks the browser's client data for this ceremony and origin, and returns the challenge it signed. */
export function clientChallenge(clientDataJSON: Uint8Array, ceremony: Ceremony, rp: RelyingParty): string {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    data = JSON.parse(new TextDecoder().decode(clientDataJSON));
  } catch {
    throw new Refused("bad-client-data");
  }
  if (data.type !== ceremony) throw new Refused("wrong-ceremony");
  if (data.origin !== rp.origin || data.crossOrigin === true) throw new Refused("wrong-origin");
  if (typeof data.challenge !== "string") throw new Refused("bad-client-data");
  return data.challenge;
}

type Cbor = number | Uint8Array | string | boolean | null | Cbor[] | Map<Cbor, Cbor>;

/** Reads one CTAP2 canonical CBOR item: definite lengths only, no tags or floats, which is all WebAuthn sends. */
function readCbor(bytes: Uint8Array, start: number): { value: Cbor; end: number } {
  let at = start;
  const need = (count: number) => {
    if (at + count > bytes.length) throw new Refused("bad-attestation");
  };
  const uint = (size: number) => {
    need(size);
    let value = 0;
    for (let index = 0; index < size; index += 1) value = value * 256 + bytes[at++];
    return value;
  };
  const item = (): Cbor => {
    const head = uint(1);
    const major = head >> 5;
    const info = head & 31;
    if (info > 26) throw new Refused("bad-attestation");
    const length = info < 24 ? info : uint(2 ** (info - 24));
    if ((major === 4 || major === 5) && length > bytes.length - at) throw new Refused("bad-attestation");
    switch (major) {
      case 0:
        return length;
      case 1:
        return -1 - length;
      case 2:
      case 3: {
        need(length);
        const raw = bytes.slice(at, (at += length));
        return major === 2 ? raw : new TextDecoder().decode(raw);
      }
      case 4:
        return Array.from({ length }, item);
      case 5: {
        const map = new Map<Cbor, Cbor>();
        for (let index = 0; index < length; index += 1) map.set(item(), item());
        return map;
      }
      case 7:
        if (info === 20 || info === 21) return info === 21;
        if (info === 22) return null;
    }
    throw new Refused("bad-attestation");
  };
  const value = item();
  return { value, end: at };
}

interface AuthenticatorData {
  flags: number;
  signCount: number;
  credential?: { id: Uint8Array; publicKey: Uint8Array };
}

/** An EC2 P-256 COSE key as the 65-byte uncompressed point WebCrypto imports. */
function coseToRawP256(cose: Cbor): Uint8Array {
  if (!(cose instanceof Map)) throw new Refused("unsupported-key");
  const x = cose.get(-2);
  const y = cose.get(-3);
  const ok = cose.get(1) === 2 && cose.get(3) === ES256 && cose.get(-1) === 1 && x instanceof Uint8Array && y instanceof Uint8Array && x.length === 32 && y.length === 32;
  if (!ok) throw new Refused("unsupported-key");
  return Uint8Array.of(4, ...x, ...y);
}

async function readAuthenticatorData(bytes: Uint8Array, rp: RelyingParty): Promise<AuthenticatorData> {
  if (bytes.length < 37) throw new Refused("bad-authenticator-data");
  if (!sameBytes(bytes.slice(0, 32), await sha256(utf8(rp.id)))) throw new Refused("wrong-rp");
  const flags = bytes[32];
  if (!(flags & USER_PRESENT)) throw new Refused("no-user-presence");
  if (!(flags & USER_VERIFIED)) throw new Refused("no-user-verification");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signCount = view.getUint32(33);
  if (!(flags & ATTESTED_CREDENTIAL)) return { flags, signCount };
  if (bytes.length < 55) throw new Refused("bad-authenticator-data");
  const idLength = view.getUint16(53);
  const id = bytes.slice(55, 55 + idLength);
  if (id.length !== idLength) throw new Refused("bad-authenticator-data");
  return { flags, signCount, credential: { id, publicKey: coseToRawP256(readCbor(bytes, 55 + idLength).value) } };
}

/** Checks a new passkey's attestation object. Attestation is "none", so the statement itself is not checked. */
export async function verifyRegistration(rp: RelyingParty, attestationObject: Uint8Array, credentialId: string): Promise<NewPasskey> {
  const { value, end } = readCbor(attestationObject, 0);
  const authData = value instanceof Map ? value.get("authData") : undefined;
  if (end !== attestationObject.length || !(authData instanceof Uint8Array)) throw new Refused("bad-attestation");
  const parsed = await readAuthenticatorData(authData, rp);
  if (!parsed.credential) throw new Refused("bad-attestation");
  if (toBase64Url(parsed.credential.id) !== credentialId) throw new Refused("credential-mismatch");
  return { credentialId, publicKey: parsed.credential.publicKey, signCount: parsed.signCount };
}

/** WebAuthn signs ECDSA as ASN.1 DER. WebCrypto verifies the 64-byte r||s form. */
function derToRaw(der: Uint8Array): Uint8Array {
  const part = (at: number): { bytes: Uint8Array; end: number } => {
    if (der[at] !== 0x02) throw new Refused("bad-signature");
    const length = der[at + 1];
    const bytes = der.slice(at + 2, at + 2 + length);
    if (length > 33 || bytes.length !== length || (length === 33 && bytes[0] !== 0)) throw new Refused("bad-signature");
    return { bytes, end: at + 2 + length };
  };
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new Refused("bad-signature");
  const r = part(2);
  const s = part(r.end);
  if (s.end !== der.length) throw new Refused("bad-signature");
  const out = new Uint8Array(64);
  for (const [index, { bytes }] of [r, s].entries()) {
    const trimmed = bytes.slice(Math.max(0, bytes.length - 32));
    out.set(trimmed, index * 32 + 32 - trimmed.length);
  }
  return out;
}

/** Checks a sign-in signature against the stored key, and returns the new signature counter. */
export async function verifyAssertion(
  rp: RelyingParty,
  stored: { publicKey: Uint8Array; signCount: number },
  response: { clientDataJSON: Uint8Array; authenticatorData: Uint8Array; signature: Uint8Array },
): Promise<number> {
  const { signCount } = await readAuthenticatorData(response.authenticatorData, rp);
  const key = await crypto.subtle.importKey("raw", stored.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signed = Uint8Array.of(...response.authenticatorData, ...(await sha256(response.clientDataJSON)));
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(response.signature), signed);
  if (!ok) throw new Refused("bad-signature");
  if ((signCount !== 0 || stored.signCount !== 0) && signCount <= stored.signCount) throw new Refused("counter-went-back");
  return signCount;
}
