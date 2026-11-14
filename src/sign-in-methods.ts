/** One way into an account, as `/api/me` lists it. */
export interface Way {
  kind: string;
  id: string;
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

/** A refusal from the API (`{error}` with its status), or `offline` when the request never got an answer. */
export class ApiError extends Error {
  constructor(
    readonly reason: string,
    readonly status = 0,
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
  const reply = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(reply.error ?? "offline", response.status);
  return reply as T;
}

/**
 * One way to sign in. The sign-in and create screens show a button per entry, and Ways to sign in
 * lists the account's ways by `kind`. Google and password sign-in each add one entry here.
 */
export interface SignInMethod {
  kind: string;
  label: string;
  wayLabel: string;
  /** False in browsers that can't do this way, such as in-app browsers without passkeys. */
  works(): boolean;
  create(displayName: string): Promise<SignedIn>;
  signIn(): Promise<SignedIn>;
  add(): Promise<Account>;
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
  wayLabel: "Face ID or fingerprint",
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
  add: async () => (await makePasskey("/api/auth/passkey/add", {})).account,
  remove: async (id) => (await api<SignedIn>("/api/me/remove-passkey", { id })).account,
};

export const SIGN_IN_METHODS: readonly SignInMethod[] = [passkey];
