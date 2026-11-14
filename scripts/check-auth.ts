import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Phone, SoftAuthenticator, TEST_ORIGIN, TEST_SECRET, startApi } from "./api-session.ts";

async function workerSessionModule(): Promise<typeof import("../worker/session.ts")> {
  const result = await build({ entryPoints: [new URL("../worker/session.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "neutral" });
  const dir = mkdtempSync(join(tmpdir(), "check-auth-"));
  const file = join(dir, "session.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const { signSession } = await workerSessionModule();

const CHALLENGE_TTL_SECONDS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

type Socket = { ws: WebSocket; opened: boolean; closed: Promise<number> };

function openSocket(url: string, headers: Record<string, string>): Promise<Socket> {
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ws, opened: false, closed }), 5000);
    ws.addEventListener("message", () => (clearTimeout(timer), resolve({ ws, opened: true, closed })), { once: true });
    ws.addEventListener("close", () => (clearTimeout(timer), resolve({ ws, opened: false, closed })), { once: true });
  });
}

/** The close code the server sent. The local dev proxy holds TCP open after a server close, so the client finishes it. */
async function serverClose(socket: Socket, label: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (socket.ws.readyState === WebSocket.OPEN) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for the server to close ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  socket.ws.close();
  return socket.closed;
}

const { worker, base } = await startApi({ CHALLENGE_TTL_SECONDS: String(CHALLENGE_TTL_SECONDS) });
const sockets: WebSocket[] = [];
let failed = false;
try {
  const join = async (phone: Phone, room: string, origin = TEST_ORIGIN) => {
    const socket = await openSocket(phone.socketUrl(room), { origin, ...(phone.cookie ? { cookie: phone.cookie } : {}) });
    sockets.push(socket.ws);
    return socket;
  };

  const stranger = new Phone(base);
  assert.equal((await stranger.call("/api/me")).status, 401, "/api/me is 401 with no cookie");
  assert.equal((await stranger.call("/api/rooms/band-a")).status, 401, "a room's GET is 401 with no session");
  assert.equal((await join(stranger, "band-a")).opened, false, "a room socket is refused with no session");
  const noOrigin = await stranger.call("/api/auth/passkey/create/options", { name: "X" }, { origin: "https://evil.test" });
  assert.deepEqual([noOrigin.status, noOrigin.body.error], [403, "wrong-origin"], "a POST from another site is refused");

  const phone = new Phone(base);
  const created = await phone.createAccount("Sam Rivera");
  assert.equal(created.status, 200, `create account succeeds (${JSON.stringify(created.body)})`);
  assert.equal(created.body.account.handle, "samrivera", "the @handle comes from the display name");
  assert.equal(created.body.account.displayName, "Sam Rivera");
  assert.equal(created.body.account.ways.length, 1, "the account has one way to sign in");
  const codes: string[] = created.body.backupCodes;
  assert.equal(new Set(codes).size, 8, "8 different backup codes are shown once");
  assert.ok(codes.every((code) => /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code)), `backup codes look like XXXX-XXXX-XXXX (${codes[0]})`);
  const setCookie = phone.lastSetCookie ?? "";
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", `Max-Age=${90 * 24 * 60 * 60}`]) {
    assert.ok(setCookie.includes(attribute), `the session cookie has ${attribute} (${setCookie})`);
  }
  const me = await phone.call("/api/me");
  assert.deepEqual([me.status, me.body.account.handle], [200, "samrivera"], "/api/me returns the handle for the new session");

  const twin = new Phone(base);
  assert.equal((await twin.createAccount("Sam Rivera")).body.account?.handle, "samrivera2", "a clashing handle gets a number");

  const replayPhone = new Phone(base);
  const options = (await replayPhone.call("/api/auth/passkey/create/options", { name: "Replay" })).body.options;
  const registration = await replayPhone.authenticator.create(options);
  assert.equal((await replayPhone.call("/api/auth/passkey/create/finish", registration)).status, 200, "a fresh registration is accepted");
  const replayed = await new Phone(base).call("/api/auth/passkey/create/finish", registration);
  assert.deepEqual([replayed.status, replayed.body.error], [400, "wrong-challenge"], "a replayed registration is refused");

  const laptop = new Phone(base, phone.authenticator);
  const signedIn = await laptop.signIn();
  assert.equal(signedIn.status, 200, `sign in with the passkey succeeds (${JSON.stringify(signedIn.body)})`);
  assert.equal((await laptop.call("/api/me")).body.account.handle, "samrivera", "the sign-in session is the same account");

  const refusals: [string, Parameters<Phone["signIn"]>[0], string][] = [
    ["a bad signature", { badSignature: true }, "bad-signature"],
    ["a wrong origin", { origin: "https://evil.test" }, "wrong-origin"],
    ["a wrong RP id", { rpId: "evil.test" }, "wrong-rp"],
    ["a create ceremony posing as a sign-in", { type: "webauthn.create" }, "wrong-ceremony"],
    ["a sign-in without Face ID or fingerprint", { flags: 0x01 }, "no-user-verification"],
    ["a challenge the server never made", { challenge: "bm90LWEtY2hhbGxlbmdl" }, "wrong-challenge"],
  ];
  for (const [label, tamper, error] of refusals) {
    const other = new Phone(base, phone.authenticator);
    const result = await other.signIn(tamper);
    assert.deepEqual([result.status, result.body.error, other.cookie], [400, error, ""], `${label} is refused with ${error} and no cookie`);
  }
  const wrongRpCreate = await new Phone(base).createAccount("Wrong RP", { rpId: "evil.test" });
  assert.deepEqual([wrongRpCreate.status, wrongRpCreate.body.error], [400, "wrong-rp"], "a passkey made for another RP id is refused");
  const wrongOriginCreate = await new Phone(base).createAccount("Wrong Origin", { origin: "https://evil.test" });
  assert.deepEqual([wrongOriginCreate.status, wrongOriginCreate.body.error], [400, "wrong-origin"], "a passkey made on another origin is refused");

  const replayIn = new Phone(base, phone.authenticator);
  const signInOptions = (await replayIn.call("/api/auth/passkey/sign-in/options", {})).body.options;
  const assertion = await phone.authenticator.get(signInOptions);
  assert.equal((await replayIn.call("/api/auth/passkey/sign-in/finish", assertion)).status, 200);
  const replayedIn = await new Phone(base).call("/api/auth/passkey/sign-in/finish", assertion);
  assert.deepEqual([replayedIn.status, replayedIn.body.error], [400, "wrong-challenge"], "a replayed sign-in is refused");

  const slow = new Phone(base, phone.authenticator);
  const staleOptions = (await slow.call("/api/auth/passkey/sign-in/options", {})).body.options;
  await new Promise((resolve) => setTimeout(resolve, CHALLENGE_TTL_SECONDS * 1000 + 300));
  const expired = await slow.call("/api/auth/passkey/sign-in/finish", await phone.authenticator.get(staleOptions));
  assert.deepEqual([expired.status, expired.body.error], [400, "challenge-expired"], "an expired challenge is refused");

  const counting = new Phone(base);
  await counting.createAccount("Counter");
  assert.equal((await counting.signIn({ counter: 5 })).status, 200, "a rising signature counter is accepted");
  assert.deepEqual((await counting.signIn({ counter: 3 })).body.error, "counter-went-back", "a counter that goes back (a cloned key) is refused");

  const [userId, version, issuedAt, signature] = phone.cookie.slice("mls_session=".length).split(".");
  // Middle character carries 6 full bits; last char has padding bits that can decode the same.
  const flip = (text: string) => {
    const mid = Math.floor(text.length / 2);
    return text.slice(0, mid) + (text.at(mid) === "A" ? "B" : "A") + text.slice(mid + 1);
  };
  const tampered = [
    ["another user id", `${flip(userId)}.${version}.${issuedAt}.${signature}`],
    ["a raised session version", `${userId}.${Number(version) + 1}.${issuedAt}.${signature}`],
    ["a later issue time", `${userId}.${version}.${Number(issuedAt) + 1}.${signature}`],
    ["a changed signature", `${userId}.${version}.${issuedAt}.${flip(signature)}`],
    ["no signature", `${userId}.${version}.${issuedAt}`],
  ];
  for (const [label, value] of tampered) {
    assert.equal((await stranger.call("/api/me", undefined, { cookie: `mls_session=${value}` })).status, 401, `a cookie with ${label} gets 401`);
  }
  const old = await signSession(TEST_SECRET, { userId, version: Number(version), issuedAt: Date.now() - 91 * DAY_MS });
  assert.equal((await stranger.call("/api/me", undefined, { cookie: `mls_session=${old}` })).status, 401, "a cookie past 90 days gets 401");
  const forged = await signSession("a-different-secret-that-is-long-enough-000", { userId, version: Number(version), issuedAt: Date.now() });
  assert.equal((await stranger.call("/api/me", undefined, { cookie: `mls_session=${forged}` })).status, 401, "a cookie signed with another key gets 401");
  const twoDays = await signSession(TEST_SECRET, { userId, version: Number(version), issuedAt: Date.now() - 2 * DAY_MS });
  const renewed = new Phone(base);
  renewed.cookie = `mls_session=${twoDays}`;
  assert.equal((await renewed.call("/api/me")).status, 200, "a two-day-old cookie still works");
  assert.ok(renewed.cookie !== `mls_session=${twoDays}` && /Max-Age=7776000/.test(renewed.lastSetCookie ?? ""), "using it renews it for another 90 days");
  assert.equal((await renewed.call("/api/me")).lastSetCookie ?? null, null, "a fresh cookie is not re-sent on every call");

  const codePhone = new Phone(base);
  const code = codes[0];
  const used = await codePhone.call("/api/auth/backup-code", { handle: "@SamRivera", code: code.toLowerCase().replace(/-/g, " ") });
  assert.deepEqual([used.status, used.body.account?.handle, used.body.account?.backupCodesLeft], [200, "samrivera", 7], "a backup code signs in once and 7 are left");
  const again = await new Phone(base).call("/api/auth/backup-code", { handle: "samrivera", code });
  assert.deepEqual([again.status, again.body.error], [401, "wrong-code"], "the same backup code is refused the second time");
  assert.equal((await new Phone(base).call("/api/auth/backup-code", { handle: "samrivera2", code: codes[1] })).status, 401, "a code only works for its own account");

  const secondPhone = new SoftAuthenticator();
  const addOptions = (await phone.call("/api/auth/passkey/add/options", {})).body.options;
  assert.deepEqual(addOptions.excludeCredentials.map((c: { id: string }) => c.id), phone.authenticator.ids, "Add another phone excludes the passkey already saved");
  const added = await phone.call("/api/auth/passkey/add/finish", await secondPhone.create(addOptions));
  assert.equal(added.body.account?.ways.length, 2, `Add another phone saves a second passkey (${JSON.stringify(added.body)})`);
  const onSecond = new Phone(base, secondPhone);
  assert.equal((await onSecond.signIn()).body.account?.handle, "samrivera", "the second phone signs in to the same account");
  const strangerAdd = await stranger.call("/api/auth/passkey/add/options", {});
  assert.equal(strangerAdd.status, 401, "Add another phone needs a session");

  assert.equal((await phone.call("/api/me/remove-passkey", { id: secondPhone.ids[0] })).body.account?.ways.length, 1, "removing a phone leaves one way");
  const last = await phone.call("/api/me/remove-passkey", { id: phone.authenticator.ids[0] });
  assert.deepEqual([last.status, last.body.error], [409, "last-way"], "removing the last way to sign in is refused");
  assert.equal((await new Phone(base, secondPhone).signIn()).body.error, "unknown-passkey", "a removed phone's passkey no longer signs in");

  assert.equal((await join(phone, "band-a", "https://evil.test")).opened, false, "a room socket from another site is refused even with a session");
  const inA = await join(phone, "band-a");
  const inB = await join(laptop, "band-b");
  assert.ok(inA.opened && inB.opened, "signed-in phones join room sockets");
  assert.equal((await phone.call("/api/rooms/band-a")).body.peers, 1, "a signed-in GET reads the room");
  const otherUser = await join(twin, "band-a");
  assert.ok(otherUser.opened, "another account joins the same room");

  const oldPhoneCookie = phone.cookie;
  const everywhere = await codePhone.call("/api/auth/sign-out-everywhere", {});
  assert.equal(everywhere.status, 200, "Sign out everywhere succeeds");
  assert.equal(codePhone.cookie, "", "Sign out everywhere clears this phone's cookie");
  assert.equal(await serverClose(inA, "band-a"), 4401, "Sign out everywhere closes the account's socket in band-a");
  assert.equal(await serverClose(inB, "band-b"), 4401, "Sign out everywhere closes the account's socket in band-b");
  assert.equal(otherUser.ws.readyState, WebSocket.OPEN, "another account's socket in the same room stays open");
  for (const [label, who] of [["the first phone", phone], ["the laptop", laptop], ["the second phone", onSecond]] as const) {
    assert.equal((await who.call("/api/me")).status, 401, `${label}'s old cookie gets 401`);
  }
  assert.equal((await join(phone, "band-a")).opened, false, "an old cookie can't open a room socket");
  phone.cookie = oldPhoneCookie;
  assert.equal((await phone.call("/api/rooms/band-a")).status, 401, "an old cookie can't read a room");

  const back = new Phone(base, phone.authenticator);
  assert.equal((await back.signIn()).status, 200, "signing in again after Sign out everywhere works");
  assert.ok((await join(back, "band-a")).opened, "the new session opens a room socket");

  const out = await back.call("/api/auth/sign-out", {});
  assert.deepEqual([out.status, back.cookie, /Max-Age=0/.test(back.lastSetCookie ?? "")], [200, "", true], "Sign out clears this phone's cookie");

  console.log("check:auth passed: create, sign in, add and remove a phone, last way kept, backup code once, bad signature, wrong origin and RP, replayed and expired challenges, cookie tamper and expiry, renewal, sign out everywhere closes sockets, rooms need a session");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const ws of sockets) ws.close();
  await worker.dispose();
}
process.exit(failed ? 1 : 0);
