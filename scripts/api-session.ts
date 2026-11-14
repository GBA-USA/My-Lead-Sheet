import { unstable_startWorker } from "wrangler";

export const TEST_ORIGIN = "https://app.test";
export const TEST_RP_ID = "app.test";
export const TEST_SECRET = "check-only-session-secret-0123456789abcdef";

type Json = Record<string, any>;

/** Starts the mls-rooms Worker under Miniflare with test vars and no saved state. */
export async function startApi(extra: Record<string, string> = {}) {
  const vars = { APP_ORIGIN: TEST_ORIGIN, RP_ID: TEST_RP_ID, RP_NAME: "Check", SESSION_SECRET: TEST_SECRET, ...extra };
  const worker = await unstable_startWorker({
    config: "worker/wrangler.jsonc",
    bindings: Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, { type: "plain_text", value }])),
    dev: { server: { port: 0 }, inspector: false, persist: false, watch: false, logLevel: "error" },
  } as Parameters<typeof unstable_startWorker>[0]);
  await worker.ready;
  return { worker, base: String(await worker.url) };
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));
const utf8 = (text: string) => new TextEncoder().encode(text);
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

type CborValue = number | string | Uint8Array | Map<number | string, CborValue>;

function cbor(value: CborValue): Uint8Array {
  const head = (major: number, length: number) => {
    if (length < 24) return [(major << 5) | length];
    if (length < 256) return [(major << 5) | 24, length];
    return [(major << 5) | 25, length >> 8, length & 255];
  };
  if (typeof value === "number") return Uint8Array.from(value >= 0 ? head(0, value) : head(1, -1 - value));
  if (typeof value === "string") return Uint8Array.from([...head(3, utf8(value).length), ...utf8(value)]);
  if (value instanceof Uint8Array) return Uint8Array.from([...head(2, value.length), ...value]);
  const parts = [...value].flatMap(([key, item]) => [cbor(key), cbor(item)]);
  return Uint8Array.from([...head(5, value.size), ...parts.flatMap((part) => [...part])]);
}

/** WebCrypto signs ECDSA as 64-byte r||s. WebAuthn carries it as ASN.1 DER. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = bytes.slice(start);
    const body = trimmed[0] & 0x80 ? [0, ...trimmed] : [...trimmed];
    return [0x02, body.length, ...body];
  };
  const sequence = [...integer(raw.slice(0, 32)), ...integer(raw.slice(32))];
  return Uint8Array.from([0x30, sequence.length, ...sequence]);
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export interface Tamper {
  origin?: string;
  rpId?: string;
  type?: string;
  flags?: number;
  challenge?: string;
  counter?: number;
  badSignature?: boolean;
}

/** A software passkey store: real P-256 keys, real attestation and assertion bytes, like a phone's authenticator. */
export class SoftAuthenticator {
  private readonly keys = new Map<string, { pair: CryptoKeyPair; userHandle: string; counter: number }>();
  private readonly origin = TEST_ORIGIN;
  private readonly rpId = TEST_RP_ID;

  private clientData(type: string, challenge: string, tamper: Tamper) {
    return utf8(JSON.stringify({ type: tamper.type ?? type, challenge: tamper.challenge ?? challenge, origin: tamper.origin ?? this.origin, crossOrigin: false }));
  }

  private async authData(flags: number, counter: number, tamper: Tamper, attested?: Uint8Array) {
    const counterBytes = [counter >>> 24, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255];
    return Uint8Array.from([...(await sha256(utf8(tamper.rpId ?? this.rpId))), tamper.flags ?? flags, ...counterBytes, ...(attested ?? [])]);
  }

  async create(options: Json, tamper: Tamper = {}) {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const id = crypto.getRandomValues(new Uint8Array(32));
    const cose = cbor(new Map<number, CborValue>([[1, 2], [3, -7], [-1, 1], [-2, unb64(jwk.x!)], [-3, unb64(jwk.y!)]]));
    const attested = Uint8Array.from([...new Uint8Array(16), id.length >> 8, id.length & 255, ...id, ...cose]);
    const authData = await this.authData(UP | UV | AT, tamper.counter ?? 0, tamper, attested);
    const attestationObject = cbor(new Map<string, CborValue>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    this.keys.set(b64(id), { pair, userHandle: options.user.id, counter: tamper.counter ?? 0 });
    return { id: b64(id), clientDataJSON: b64(this.clientData("webauthn.create", options.challenge, tamper)), attestationObject: b64(attestationObject) };
  }

  /** Signs a sign-in challenge with the newest passkey, or the one named by `id`. */
  async get(options: Json, tamper: Tamper = {}, id = [...this.keys.keys()].at(-1)!) {
    const key = this.keys.get(id)!;
    if (tamper.counter !== undefined) key.counter = tamper.counter;
    const authenticatorData = await this.authData(UP | UV, key.counter, tamper);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, tamper);
    const signed = Uint8Array.from([...authenticatorData, ...(await sha256(clientDataJSON))]);
    if (tamper.badSignature) signed[0] ^= 1;
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.pair.privateKey, signed));
    return { id, clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature: b64(rawToDer(raw)), userHandle: key.userHandle };
  }

  get ids() {
    return [...this.keys.keys()];
  }
}

/** One phone's browser: keeps the session cookie the API sets and sends the app's Origin. */
export class Phone {
  cookie = "";
  lastSetCookie: string | null = null;
  readonly base: string;
  readonly authenticator: SoftAuthenticator;

  constructor(base: string, authenticator = new SoftAuthenticator()) {
    this.base = base;
    this.authenticator = authenticator;
  }

  async call(path: string, body?: Json, headers: Record<string, string> = {}) {
    const response = await fetch(new URL(path, this.base), {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json", origin: TEST_ORIGIN }), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.lastSetCookie = response.headers.get("set-cookie");
    const pair = this.lastSetCookie?.split(";")[0];
    if (pair) this.cookie = pair.endsWith("=") ? "" : pair;
    return { status: response.status, body: (await response.json()) as Json };
  }

  async createAccount(name: string, tamper: Tamper = {}) {
    const { body } = await this.call("/api/auth/passkey/create/options", { name });
    return this.call("/api/auth/passkey/create/finish", await this.authenticator.create(body.options, tamper));
  }

  async signIn(tamper: Tamper = {}) {
    const { body } = await this.call("/api/auth/passkey/sign-in/options", {});
    return this.call("/api/auth/passkey/sign-in/finish", await this.authenticator.get(body.options, tamper));
  }

  socketUrl(room: string) {
    return new URL(`/api/rooms/${room}`, this.base).href.replace(/^http/, "ws");
  }
}
