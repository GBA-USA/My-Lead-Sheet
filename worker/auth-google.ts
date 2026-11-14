import { fromBase64Url, sha256, toBase64Url, utf8 } from "./bytes";
import { Refused } from "./refused";

/** The Google sign-in client, from the Worker's vars and secrets. Checks and local dev point `GOOGLE_ISSUER` at the mock issuer. */
export interface GoogleClient {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleEnv {
  GOOGLE_ISSUER?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
}

/** What the Directory keeps from a verified ID token. Accounts are keyed on `sub`, never on the email address. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const CLOCK_SLACK_SECONDS = 60;

export function googleClient(env: GoogleEnv): GoogleClient | null {
  const { GOOGLE_ISSUER: issuer, GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REDIRECT_URI: redirectUri } = env;
  return issuer && clientId && clientSecret && redirectUri ? { issuer, clientId, clientSecret, redirectUri } : null;
}

async function discover(issuer: string): Promise<Discovery> {
  const reply = await fetch(`${issuer}/.well-known/openid-configuration`);
  const doc = (await reply.json().catch(() => null)) as Record<string, unknown> | null;
  const ok = reply.ok && doc?.issuer === issuer && [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri].every((value) => typeof value === "string");
  if (!ok) throw new Refused("google-unreachable", 502);
  return doc as unknown as Discovery;
}

/** The PKCE verifier and nonce for one flow, derived from its state with the session secret, so the Directory stores only the state. */
async function flowSecrets(sessionSecret: string, state: string) {
  const key = await crypto.subtle.importKey("raw", utf8(sessionSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derive = async (label: string) => toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(`${label}:${state}`))));
  return { verifier: await derive("google-pkce"), nonce: await derive("google-nonce") };
}

export async function authorizeUrl(client: GoogleClient, sessionSecret: string, state: string): Promise<string> {
  const { authorization_endpoint } = await discover(client.issuer);
  const { verifier, nonce } = await flowSecrets(sessionSecret, state);
  const url = new URL(authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: toBase64Url(await sha256(utf8(verifier))),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.href;
}

function jsonPart(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64Url(text) ?? new Uint8Array()));
    if (typeof value === "object" && value !== null) return value;
  } catch {}
  throw new Refused("bad-token");
}

async function verifiedClaims(idToken: unknown, jwksUri: string): Promise<Record<string, unknown>> {
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  if (parts.length !== 3) throw new Refused("bad-token");
  const [head, body, signature] = parts;
  const header = jsonPart(head);
  if (header.alg !== "RS256") throw new Refused("bad-token");
  const reply = await fetch(jwksUri);
  const keys = reply.ok ? ((await reply.json().catch(() => ({}))) as { keys?: (JsonWebKey & { kid?: string })[] }).keys : undefined;
  const jwk = Array.isArray(keys) ? keys.find((key) => key.kid === header.kid && key.kty === "RSA") : undefined;
  if (!jwk) throw new Refused("bad-token");
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signed = fromBase64Url(signature);
  if (!signed || !(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signed, utf8(`${head}.${body}`)))) throw new Refused("bad-signature");
  return jsonPart(body);
}

/** The token endpoint checks the PKCE verifier, so a code stolen from another flow is refused there, before any ID token. */
export async function identityFromCode(client: GoogleClient, sessionSecret: string, state: string, code: string, now: number): Promise<GoogleIdentity> {
  const doc = await discover(client.issuer);
  const { verifier, nonce } = await flowSecrets(sessionSecret, state);
  const reply = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: client.redirectUri, client_id: client.clientId, client_secret: client.clientSecret, code_verifier: verifier }),
  });
  if (!reply.ok) throw new Refused("google-refused", 401);
  const claims = await verifiedClaims(((await reply.json().catch(() => ({}))) as { id_token?: unknown }).id_token, doc.jwks_uri);
  // Google's tokens may name the issuer as a bare host (developers.google.com/identity/openid-connect/openid-connect, "Validate an ID token").
  if (claims.iss !== client.issuer && claims.iss !== new URL(client.issuer).host) throw new Refused("wrong-issuer", 401);
  if (claims.aud !== client.clientId || (claims.azp !== undefined && claims.azp !== client.clientId)) throw new Refused("wrong-audience", 401);
  if (typeof claims.exp !== "number" || now >= (claims.exp + CLOCK_SLACK_SECONDS) * 1000) throw new Refused("token-expired", 401);
  if (claims.nonce !== nonce) throw new Refused("wrong-nonce", 401);
  if (typeof claims.sub !== "string" || !claims.sub) throw new Refused("bad-token");
  return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : "", name: typeof claims.name === "string" ? claims.name : "" };
}
