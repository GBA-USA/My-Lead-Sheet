import { newSalt, passwordKey } from "./password";

export type WayKind = "passkey" | "google" | "password";

export interface Way {
  kind: WayKind;
  id: string;
  /** The connected address, for Google. */
  detail?: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface Account {
  userId: string;
  handle: string;
  displayName: string;
  ways: Way[];
  backupCodesLeft: number;
}

/** What a create or sign-in reply carries. A new account also gets its 8 backup codes, shown once. */
export interface SignedIn {
  account: Account;
  backupCodes?: string[];
}

/** A refusal from the API (`{error}` with its status), or `offline` when the request never got an answer. `waitMs` comes with password waits. */
export class ApiError extends Error {
  constructor(
    readonly reason: string,
    readonly status = 0,
    readonly waitMs = 0,
  ) {
    super(reason);
  }
}

export async function api<T>(path: string, body?: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("offline");
  }
  const reply = (await response.json().catch(() => ({}))) as { error?: string; waitMs?: number };
  if (!response.ok) throw new ApiError(reply.error ?? "offline", response.status, reply.waitMs);
  return reply as T;
}

/** What this server offers, from `GET /api/auth/config`. Google stays hidden until the Worker has a Google client, and passwords until it has a pepper. */
export interface AuthConfig {
  google: boolean;
  password: boolean;
}

/** A sheet screen a way opens when it needs typing first, instead of finishing in one tap. */
export type FormStep = "password" | "make-password" | "set-password";

export type Action<Args extends unknown[]> = ((...args: Args) => Promise<SignedIn>) | FormStep;

/**
 * One way to sign in. The sign-in and create screens show a button per entry, and Ways to sign in
 * lists the account's ways by `kind`.
 */
export interface SignInMethod {
  kind: WayKind;
  label: string;
  createLabel: string;
  wayLabel: string;
  /** Shown under this way's button on the sign-in screen. */
  note?: string;
  offered(config: AuthConfig): boolean;
  /** False in browsers that can't do this way, such as in-app browsers. */
  works(): boolean;
  signIn: Action<[]>;
  create: Action<[displayName: string]>;
  /** The account screen's button for this way, or null when there is nothing to add. */
  addLabel(ways: Way[]): string | null;
  add: Action<[]>;
  remove(id: string): Promise<Account>;
}

const toBytes = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const toText = (buffer: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The server's creation options: the same fields, with base64url text where WebAuthn wants bytes. */
type CreationJson = Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials"> & {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials: { type: "public-key"; id: string }[];
};

const creationOptions = (options: CreationJson): PublicKeyCredentialCreationOptions => ({
  ...options,
  challenge: toBytes(options.challenge),
  user: { ...options.user, id: toBytes(options.user.id) },
  excludeCredentials: options.excludeCredentials.map((item) => ({ ...item, id: toBytes(item.id) })),
});

async function makePasskey(path: string, body: object) {
  const { options } = await api<{ options: CreationJson }>(`${path}/options`, body);
  const credential = (await navigator.credentials.create({ publicKey: creationOptions(options) })) as PublicKeyCredential;
  const response = credential.response as AuthenticatorAttestationResponse;
  return api<SignedIn>(`${path}/finish`, { id: credential.id, clientDataJSON: toText(response.clientDataJSON), attestationObject: toText(response.attestationObject) });
}

const passkey: SignInMethod = {
  kind: "passkey",
  label: "Sign in with Face ID or fingerprint",
  createLabel: "Sign in with Face ID or fingerprint",
  wayLabel: "Face ID or fingerprint",
  offered: () => true,
  works: () => typeof PublicKeyCredential === "function" && !!navigator.credentials,
  create: (displayName) => makePasskey("/api/auth/passkey/create", { name: displayName }),
  async signIn() {
    const { options } = await api<{ options: Omit<PublicKeyCredentialRequestOptions, "challenge"> & { challenge: string } }>("/api/auth/passkey/sign-in/options", {});
    const credential = (await navigator.credentials.get({ publicKey: { ...options, challenge: toBytes(options.challenge) } })) as PublicKeyCredential;
    const response = credential.response as AuthenticatorAssertionResponse;
    return api<SignedIn>("/api/auth/passkey/sign-in/finish", {
      id: credential.id,
      clientDataJSON: toText(response.clientDataJSON),
      authenticatorData: toText(response.authenticatorData),
      signature: toText(response.signature),
      ...(response.userHandle ? { userHandle: toText(response.userHandle) } : {}),
    });
  },
  addLabel: () => "+ Add another phone",
  add: () => makePasskey("/api/auth/passkey/add", {}),
  remove: async (id) => (await api<SignedIn>("/api/me/remove-passkey", { id })).account,
};

/** Google refuses sign-in inside apps' built-in browsers (its "disallowed_useragent" error), so those are sent to Safari or Chrome. */
const IN_APP_BROWSER = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat|TikTok|musical_ly|Twitter|LinkedInApp|; wv\)/;

/** Goes to Google. The Worker sends the phone back to the app with `?google=` and the outcome, so this never resolves. */
async function goToGoogle(body: { intent: "sign-in" | "link"; name?: string }): Promise<SignedIn> {
  const { url } = await api<{ url: string }>("/api/auth/google/start", body);
  location.assign(url);
  return new Promise(() => {});
}

const google: SignInMethod = {
  kind: "google",
  label: "Continue with Google",
  createLabel: "Continue with Google",
  wayLabel: "Google",
  note: "New here? This makes a new account. Already have one? Sign in another way, then connect Google in Settings.",
  offered: (config) => config.google,
  works: () => !IN_APP_BROWSER.test(navigator.userAgent),
  signIn: () => goToGoogle({ intent: "sign-in" }),
  create: (name) => goToGoogle({ intent: "sign-in", name }),
  addLabel: (ways) => (ways.some((way) => way.kind === "google") ? null : "+ Connect Google"),
  add: () => goToGoogle({ intent: "link" }),
  remove: async (id) => (await api<SignedIn>("/api/me/remove-google", { id })).account,
};

const password: SignInMethod = {
  kind: "password",
  label: "Sign in with a password",
  createLabel: "Make a password",
  wayLabel: "Password",
  offered: (config) => config.password,
  works: () => !!globalThis.crypto?.subtle,
  signIn: "password",
  create: "make-password",
  addLabel: (ways) => (ways.some((way) => way.kind === "password") ? "Change password" : "+ Add a password"),
  add: "set-password",
  remove: async (id) => (await api<SignedIn>("/api/me/remove-password", { id })).account,
};

export const SIGN_IN_METHODS: readonly SignInMethod[] = [passkey, google, password];

const normalizeHandle = (handle: string) => handle.trim().replace(/^@/, "").toLowerCase();

export async function signInWithPassword(handle: string, typed: string): Promise<SignedIn> {
  const { salt } = await api<{ salt: string }>("/api/auth/password/salt", { handle: normalizeHandle(handle) });
  return api<SignedIn>("/api/auth/password/sign-in", { handle: normalizeHandle(handle), key: await passwordKey(typed, salt) });
}

export async function createWithPassword(name: string, handle: string, typed: string): Promise<SignedIn> {
  const salt = newSalt();
  return api<SignedIn>("/api/auth/password/create", { name, handle: normalizeHandle(handle), salt, key: await passwordKey(typed, salt) });
}

/** Sets or changes the password. Every other phone is signed out. */
export async function setPassword(typed: string): Promise<SignedIn> {
  const salt = newSalt();
  return api<SignedIn>("/api/me/password", { salt, key: await passwordKey(typed, salt) });
}
