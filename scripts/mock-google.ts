import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

export interface MockUser {
  sub: string;
  email: string;
  name: string;
}

export interface TokenTamper {
  iss?: string;
  aud?: string;
  nonce?: string;
  expiresIn?: number;
  otherKey?: boolean;
}

interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  user: MockUser;
}

const b64 = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
const json = (value: unknown) => b64(Buffer.from(JSON.stringify(value)));

async function rsaKey() {
  return (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function readForm(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** A stand-in for Google's sign-in, for checks and local dev only. It has its own RS256 key and never talks to Google. */
export async function startMockGoogle(client: { clientId: string; clientSecret: string }) {
  const key = await rsaKey();
  const stranger = await rsaKey();
  const jwk = { ...(await crypto.subtle.exportKey("jwk", key.publicKey)), kid: "mock-1", alg: "RS256", use: "sig" };
  const grants = new Map<string, Grant>();
  const state = { user: { sub: "100000000000000000001", email: "player@example.test", name: "Mock Player" } as MockUser, tamper: {} as TokenTamper, cancel: false };
  let issuer = "";

  async function idToken(grant: Grant) {
    const { tamper } = state;
    state.tamper = {};
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: tamper.iss ?? issuer,
      aud: tamper.aud ?? grant.clientId,
      azp: tamper.aud ?? grant.clientId,
      sub: grant.user.sub,
      email: grant.user.email,
      email_verified: true,
      name: grant.user.name,
      nonce: tamper.nonce ?? grant.nonce,
      iat: now,
      exp: now + (tamper.expiresIn ?? 3600),
    };
    const signed = `${json({ alg: "RS256", kid: "mock-1", typ: "JWT" })}.${json(claims)}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", (tamper.otherKey ? stranger : key).privateKey, new TextEncoder().encode(signed));
    return `${signed}.${b64(new Uint8Array(signature))}`;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return send(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (url.pathname === "/jwks") return send(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      const redirectUri = q.get("redirect_uri") ?? "";
      const ok =
        q.get("client_id") === client.clientId &&
        q.get("response_type") === "code" &&
        q.get("code_challenge_method") === "S256" &&
        !!q.get("code_challenge") &&
        !!q.get("nonce") &&
        !!q.get("state") &&
        (q.get("scope") ?? "").split(" ").includes("openid");
      if (!ok || !redirectUri) return send(400, { error: "invalid_request" });
      const back = new URL(redirectUri);
      back.searchParams.set("state", q.get("state")!);
      if (state.cancel) back.searchParams.set("error", "access_denied");
      else {
        const code = b64(crypto.getRandomValues(new Uint8Array(24)));
        grants.set(code, { clientId: client.clientId, redirectUri, challenge: q.get("code_challenge")!, nonce: q.get("nonce")!, user: state.user });
        back.searchParams.set("code", code);
      }
      response.writeHead(302, { location: back.href });
      return response.end();
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = await readForm(request);
      const code = form.get("code") ?? "";
      const grant = grants.get(code);
      grants.delete(code);
      const verifier = form.get("code_verifier") ?? "";
      const ok =
        grant &&
        form.get("grant_type") === "authorization_code" &&
        form.get("client_id") === grant.clientId &&
        form.get("client_secret") === client.clientSecret &&
        form.get("redirect_uri") === grant.redirectUri &&
        b64(createHash("sha256").update(verifier).digest()) === grant.challenge;
      if (!ok) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: b64(crypto.getRandomValues(new Uint8Array(24))), token_type: "Bearer", expires_in: 3600, id_token: await idToken(grant) });
    }
    send(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  issuer = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  return {
    issuer,
    signInAs(user: MockUser) {
      state.user = user;
    },
    tamperNext(tamper: TokenTamper) {
      state.tamper = tamper;
    },
    pressCancel(on: boolean) {
      state.cancel = on;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (import.meta.main) {
  const clientId = process.env.GOOGLE_CLIENT_ID || "local-dev-client";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "local-dev-secret";
  const mock = await startMockGoogle({ clientId, clientSecret });
  console.log(`Mock Google issuer at ${mock.issuer}. Run the Worker with:`);
  console.log(`  --var GOOGLE_ISSUER:${mock.issuer} --var GOOGLE_CLIENT_ID:${clientId} --var GOOGLE_CLIENT_SECRET:${clientSecret} --var GOOGLE_REDIRECT_URI:<app origin>/api/auth/google/callback`);
}
