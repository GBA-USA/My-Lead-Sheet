import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Phone, startApi } from "./api-session.ts";
import { openSite } from "./chrome.ts";
import { signInCpuMs } from "./sign-in-cpu.ts";
import { newSalt, parseCommonPasswords, passwordKey, passwordProblem } from "../src/password.ts";

const MINUTE_MS = 100;
const RACE_ROUNDS = 40;
const PEPPER = "check-only-password-pepper-0123456789abcdef";
const root = new URL("..", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const randomKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const PASSWORDS = new Set<string>();
const SENT_KEYS = new Set<string>();
/** The phone's key, remembered so the check can prove the Directory never stores it or the password. */
async function phoneKey(password: string, salt: string) {
  const key = await passwordKey(password, salt);
  PASSWORDS.add(password);
  SENT_KEYS.add(key);
  return key;
}

let address = 0;
/** A phone on its own network address, so the per-address limit of one part of the check stays out of the others. */
const phoneOnNewAddress = (base: string) => {
  address += 1;
  const phone = new Phone(base);
  const call = phone.call.bind(phone);
  const ip = `198.51.100.${address}`;
  phone.call = (path, body, headers = {}) => call(path, body, { "cf-connecting-ip": ip, ...headers });
  return phone;
};

async function signInWithPassword(phone: Phone, handle: string, password: string) {
  const { salt } = (await phone.call("/api/auth/password/salt", { handle })).body;
  return phone.call("/api/auth/password/sign-in", { handle, key: await phoneKey(password, salt) });
}

async function createWithPassword(phone: Phone, name: string, handle: string, password: string) {
  const salt = newSalt();
  return phone.call("/api/auth/password/create", { name, handle, salt, key: await phoneKey(password, salt) });
}

function assertWait(waitMs: unknown, minutes: number, label: string) {
  const full = minutes * MINUTE_MS;
  assert.ok(typeof waitMs === "number" && waitMs <= full && waitMs > full - 80, `${label}: a ${minutes}-minute wait (waitMs ${waitMs}, minute ${MINUTE_MS} ms)`);
}

async function apiChecks() {
  const salt = newSalt();
  assert.equal(
    await phoneKey("correct horse battery", salt),
    pbkdf2Sync("correct horse battery", Buffer.from(salt, "base64url"), 600_000, 32, "sha256").toString("base64url"),
    "the phone's key is PBKDF2-SHA256 at 600,000 rounds, 32 bytes",
  );

  const list = parseCommonPasswords(readFileSync(new URL("../public/common-passwords.txt", import.meta.url), "utf8"));
  assert.equal(list.size, 5000, "the common-password list has 5,000 entries");
  assert.ok([...list].every((entry) => entry.length >= 10), "every listed password is 10 or more characters");
  assert.match(passwordProblem("QwertyUIOP", list) ?? "", /common passwords/, "a common password is refused, whatever its case");
  assert.match(passwordProblem("short", list) ?? "", /at least 10/, "a short password is refused");
  assert.equal(passwordProblem("violet tram 42 lantern", list), null, "an uncommon long password is fine");

  const state = mkdtempSync(join(tmpdir(), "check-password-state-"));
  const { worker, base } = await startApi({ PASSWORD_PEPPER: PEPPER, PASSWORD_MINUTE_MS: String(MINUTE_MS) }, state);
  try {
    assert.equal((await fetch(new URL("/api/auth/config", base)).then((r) => r.json())).password, true, "with a pepper the server offers passwords");
    const pat = phoneOnNewAddress(base);
    const made = await createWithPassword(pat, "Pat Password", "@PatBass", "violet tram 42 lantern");
    assert.equal(made.status, 200, `Make a password creates the account (${JSON.stringify(made.body)})`);
    assert.deepEqual([made.body.account.handle, made.body.account.displayName], ["patbass", "Pat Password"], "the username is the public @name");
    assert.deepEqual(made.body.account.ways.map((way: { kind: string }) => way.kind), ["password"], "the account's one way is a password");
    assert.equal(made.body.backupCodes.length, 8, "a password account gets 8 backup codes");
    assert.deepEqual((await createWithPassword(phoneOnNewAddress(base), "Other Pat", "patbass", "violet tram 42 lantern")).body.error, "handle-taken", "a taken @name is refused");
    assert.deepEqual((await createWithPassword(phoneOnNewAddress(base), "Bad", "no spaces!", "violet tram 42 lantern")).body.error, "bad-handle", "an @name with other characters is refused");
    const shortKey = await phoneOnNewAddress(base).call("/api/auth/password/create", { name: "Short", handle: "shortkey", salt: newSalt(), key: "AAAA" });
    assert.deepEqual([shortKey.status, shortKey.body.error], [400, "bad-request"], "anything but a 32-byte key is refused");

    const passkeyOnly = new Phone(base);
    await passkeyOnly.createAccount("Kim Passkey");
    const ask = async (handle: string) => {
      const reply = await phoneOnNewAddress(base).call("/api/auth/password/salt", { handle });
      return { status: reply.status, keys: Object.keys(reply.body).join(","), salt: reply.body.salt as string };
    };
    const real = await ask("patbass");
    const unknown = await ask("nobodyhere");
    const noPassword = await ask("kimpasskey");
    for (const [label, answer] of [["an unknown @name", unknown], ["an account with no password", noPassword]] as const) {
      assert.deepEqual([answer.status, answer.keys], [real.status, real.keys], `${label} gets a salt answer of the same form`);
      assert.equal(Buffer.from(answer.salt, "base64url").length, 16, `${label} gets a 16-byte salt like a real one`);
      assert.equal(answer.salt.length, real.salt.length, `${label}'s salt has the same length`);
      assert.equal((await ask(label === "an unknown @name" ? "nobodyhere" : "kimpasskey")).salt, answer.salt, `${label} gets the same made-up salt every time`);
    }
    assert.notEqual(unknown.salt, (await ask("nobodyelse")).salt, "different unknown names get different made-up salts");
    assert.equal(real.salt, (await ask("patbass")).salt, "a real account's salt is stable");

    const laptop = phoneOnNewAddress(base);
    const right = await signInWithPassword(laptop, "@patbass", "violet tram 42 lantern");
    assert.deepEqual([right.status, right.body.account?.userId], [200, made.body.account.userId], "the right password signs in to the account");
    const wrong = await signInWithPassword(phoneOnNewAddress(base), "patbass", "violet tram 42 lanterns");
    assert.deepEqual([wrong.status, wrong.body], [401, { error: "wrong-password" }], "a wrong password is refused");
    const nobody = await signInWithPassword(phoneOnNewAddress(base), "nobodyhere", "violet tram 42 lantern");
    assert.deepEqual([nobody.status, nobody.body], [401, { error: "wrong-password" }], "an unknown @name gets the same refusal");

    const tries = phoneOnNewAddress(base);
    const miss = () => tries.call("/api/auth/password/sign-in", { handle: "patbass", key: randomKey() });
    const patKey = await phoneKey("violet tram 42 lantern", real.salt);
    for (let n = 2; n <= 4; n += 1) assert.deepEqual((await miss()).body, { error: "wrong-password" }, `wrong try ${n} starts no wait`);
    const fifth = await miss();
    assertWait(fifth.body.waitMs, 1, "the fifth wrong try in a row");
    let lastWait: number = fifth.body.waitMs;
    const waiting = await tries.call("/api/auth/password/sign-in", { handle: "patbass", key: patKey });
    assert.deepEqual([waiting.status, waiting.body.error], [429, "wait"], "during the wait even the right password is turned away");
    assert.ok(waiting.body.waitMs <= MINUTE_MS, "the wait answer says how long is left");
    for (const minutes of [5, 15, 60, 60]) {
      await sleep(Math.max(lastWait, MINUTE_MS) + 20);
      const next = await miss();
      assertWait(next.body.waitMs, minutes, "the next wrong try after the wait");
      lastWait = next.body.waitMs;
    }
    await sleep(lastWait + 20);
    assert.equal((await signInWithPassword(tries, "patbass", "violet tram 42 lantern")).status, 200, "after the longest wait the right password works: no permanent lockout");
    assert.deepEqual((await miss()).body, { error: "wrong-password" }, "a right password resets the count, so the next wrong try starts no wait");

    const ghost = phoneOnNewAddress(base);
    let ghostReply;
    for (let n = 1; n <= 5; n += 1) ghostReply = await ghost.call("/api/auth/password/sign-in", { handle: "ghostname", key: randomKey() });
    assertWait(ghostReply!.body.waitMs, 1, "an unknown @name waits on the same schedule");

    const kimLaptop = new Phone(base, passkeyOnly.authenticator);
    assert.equal((await kimLaptop.signIn()).status, 200, "Kim is signed in on a second phone");
    const kimSalt = newSalt();
    assert.equal((await passkeyOnly.call("/api/me/password", { salt: kimSalt, key: await phoneKey("kim's long passphrase", kimSalt) })).status, 200, "a passkey account adds a password");
    assert.equal((await passkeyOnly.call("/api/me")).status, 200, "the phone that added it stays signed in");
    assert.equal((await kimLaptop.call("/api/me")).status, 401, "setting a password signs the other phone out");
    const kimTries = phoneOnNewAddress(base);
    for (let n = 1; n <= 5; n += 1) await kimTries.call("/api/auth/password/sign-in", { handle: "kimpasskey", key: randomKey() });
    assert.equal((await kimTries.call("/api/auth/password/sign-in", { handle: "kimpasskey", key: randomKey() })).status, 429, "Kim's password is waiting");
    assert.equal((await new Phone(base, passkeyOnly.authenticator).signIn()).status, 200, "Face ID sign-in is not affected by password waits");

    const crowd = phoneOnNewAddress(base);
    const burst = await Promise.all(Array.from({ length: 30 }, (_, n) => crowd.call("/api/auth/password/sign-in", { handle: `crowd${n}`, key: randomKey() })));
    assert.ok(burst.every((reply) => reply.status === 401), "30 wrong tries from one address on 30 names are each refused");
    assertWait(burst.map((reply) => reply.body.waitMs ?? 0).sort((a, b) => b - a)[0], 15, "the 30th wrong try from one address in 10 minutes");
    const blocked = await signInWithPassword(crowd, "patbass", "violet tram 42 lantern");
    assert.deepEqual([blocked.status, blocked.body.error], [429, "wait"], "that address then waits, even with a right password");
    assert.equal((await signInWithPassword(phoneOnNewAddress(base), "patbass", "violet tram 42 lantern")).status, 200, "another address is not held up");
    await sleep(blocked.body.waitMs + 20);
    assert.equal((await signInWithPassword(crowd, "patbass", "violet tram 42 lantern")).status, 200, "after 15 minutes the address can sign in again");

    const recover = phoneOnNewAddress(base);
    const codes: string[] = made.body.backupCodes;
    const used = await recover.call("/api/auth/backup-code", { handle: "patbass", code: codes[0] });
    assert.deepEqual([used.status, used.body.account.backupCodesLeft], [200, 7], "Forgot password: a backup code signs in and 7 are left");
    assert.equal((await phoneOnNewAddress(base).call("/api/auth/backup-code", { handle: "patbass", code: codes[0] })).status, 401, "the same code is refused the second time");
    const resetSalt = newSalt();
    const reset = await recover.call("/api/me/password", { salt: resetSalt, key: await phoneKey("a brand new passphrase", resetSalt) });
    assert.equal(reset.status, 200, "then sets a new password");
    assert.equal((await signInWithPassword(phoneOnNewAddress(base), "patbass", "violet tram 42 lantern")).status, 401, "the old password no longer works");
    assert.equal((await signInWithPassword(phoneOnNewAddress(base), "patbass", "a brand new passphrase")).status, 200, "the new one does");

    const keeper = phoneOnNewAddress(base);
    const other = phoneOnNewAddress(base);
    await signInWithPassword(keeper, "patbass", "a brand new passphrase");
    await signInWithPassword(other, "patbass", "a brand new passphrase");
    const before = Number(keeper.cookie.split(".")[1]);
    const changeSalt = newSalt();
    const changed = await keeper.call("/api/me/password", { salt: changeSalt, key: await phoneKey("changed on the keeper", changeSalt) });
    assert.equal(changed.status, 200, "Change password works");
    assert.equal(Number(keeper.cookie.split(".")[1]), before + 1, "Change password bumps session_version");
    assert.equal((await keeper.call("/api/me")).status, 200, "the phone that changed it stays signed in");
    assert.equal((await other.call("/api/me")).status, 401, "every other phone is signed out");
    assert.equal((await laptop.call("/api/me")).status, 401, "including the one signed in earlier");

    const raceKey = (n: number) => Buffer.alloc(32, n).toString("base64url");
    const raceSalt = newSalt();
    const outcomes = new Map<string, number>();
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      for (const other of ["sign-out-everywhere", "change-password"] as const) {
        const k = new Phone(base);
        await k.createAccount(`Race ${round}`);
        const a = new Phone(base, k.authenticator);
        await a.signIn();
        const [change, rival] = await Promise.all([
          a.call("/api/me/password", { salt: raceSalt, key: raceKey(1) }),
          other === "sign-out-everywhere" ? k.call("/api/auth/sign-out-everywhere", {}) : k.call("/api/me/password", { salt: raceSalt, key: raceKey(2) }),
        ]);
        const outcome = `Change password on A ${change.status}, ${other} on K ${rival.status}, then A ${(await a.call("/api/me")).status} K ${(await k.call("/api/me")).status}`;
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      }
    }
    const serial = new Set([
      "Change password on A 200, sign-out-everywhere on K 401, then A 200 K 401",
      "Change password on A 401, sign-out-everywhere on K 200, then A 401 K 401",
      "Change password on A 200, change-password on K 401, then A 200 K 401",
      "Change password on A 401, change-password on K 200, then A 401 K 200",
    ]);
    const report = [...outcomes].map(([outcome, n]) => `${n}x ${outcome}`).join("; ");
    assert.ok([...outcomes.keys()].every((outcome) => serial.has(outcome)), `in ${RACE_ROUNDS} rounds of each race, every outcome matches one of the two serial orders: ${report}`);

    const lastWay = await keeper.call("/api/me/remove-password", { id: "password" });
    assert.deepEqual([lastWay.status, lastWay.body.error], [409, "last-way"], "removing the only password is refused");
    const kimRemoved = await passkeyOnly.call("/api/me/remove-password", { id: "password" });
    assert.deepEqual(kimRemoved.body.account?.ways.map((way: { kind: string }) => way.kind), ["passkey"], "Remove takes the password off while Face ID is left");
  } finally {
    await worker.dispose();
  }
  try {
    const files = (readdirSync(state, { recursive: true }) as string[]).filter((file) => file.endsWith(".sqlite")).map((file) => join(state, file));
    const values: string[] = [];
    let passwordRows = 0;
    for (const file of files) {
      const db = new DatabaseSync(file, { readOnly: true });
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
      for (const { name } of tables) {
        const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
        if (name === "passwords") passwordRows += rows.length;
        for (const row of rows) for (const value of Object.values(row)) values.push(value instanceof Uint8Array ? Buffer.from(value).toString("base64url") : String(value));
      }
      db.close();
    }
    assert.ok(passwordRows >= 1, `the Directory's saved SQLite holds the passwords table (${files.length} files, ${passwordRows} rows)`);
    assert.ok(SENT_KEYS.size >= 5 && PASSWORDS.size >= 3, "the check sent several phone keys");
    const leaked = values.filter((value) => [...SENT_KEYS, ...PASSWORDS].some((secret) => value.includes(secret)));
    assert.deepEqual(leaked, [], "no stored value holds a password or the phone's PBKDF2 result");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

async function screenChecks() {
  let apiBase = "";
  const site = await openSite(root, "check-password", () => apiBase);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER: PEPPER });
  apiBase = base;
  const js = JSON.stringify;
  const until = async (expression: string, what: string, ms = 10000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await site.evaluate<boolean>(expression).catch(() => false)) return;
    throw new Error(`timed out waiting for ${what} at ${await site.evaluate<string>("location.href")} (${await site.evaluate<string>(`document.querySelector(".account-sheet")?.innerText`)})`);
  };
  const step = () => site.evaluate<string>(`document.querySelector(".account-sheet")?.dataset.step ?? ""`);
  const atStep = async (name: string) => {
    await until(`document.querySelector(".account-sheet")?.dataset.step === ${js(name)}`, `the ${name} screen`);
    const privacy = await site.evaluate<string>(`document.querySelector(".account-sheet a.account-privacy")?.getAttribute("href") ?? ""`);
    assert.equal(privacy, "privacy.html", `the ${name} screen keeps the privacy link`);
  };
  const click = (text: string) =>
    site.evaluate<boolean>(`(() => { const el = [...document.querySelectorAll(".account-sheet button")].find((b) => b.textContent.trim() === ${js(text)} && !b.disabled); el?.click(); return !!el; })()`);
  const type = async (label: string, text: string) => {
    await site.evaluate(`(() => { const input = [...document.querySelectorAll(".account-sheet label")].find((l) => l.textContent.trim() === ${js(label)}).control; input.focus(); input.select(); })()`);
    await site.send("Input.insertText", { text });
  };
  const value = (label: string) => site.evaluate<string>(`[...document.querySelectorAll(".account-sheet label")].find((l) => l.textContent.trim() === ${js(label)}).control.value`);
  const alert = () => until(`!!document.querySelector(".account-sheet [role=alert]")`, "an error").then(() => site.evaluate<string>(`document.querySelector(".account-sheet [role=alert]").textContent`));
  const sheetText = () => site.evaluate<string>(`document.querySelector(".account-sheet").innerText`);
  const signOut = async () => {
    assert.ok(await click("Sign out"), "Sign out");
    await atStep("start");
  };
  try {
    await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await site.send("Page.enable");
    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await until(`!!document.querySelector(".shell-header [aria-label=More]")`, "the library", 15000);
    await site.evaluate(`document.querySelector(".shell-header [aria-label=More]").click()`);
    await until(`[...document.querySelectorAll("[role=menu] button")].some((b) => b.textContent.trim() === "Sign in")`, "the More menu");
    await site.evaluate(`[...document.querySelectorAll("[role=menu] button")].find((b) => b.textContent.trim() === "Sign in").click()`);
    await atStep("start");
    assert.ok((await sheetText()).includes("Sign in with a password"), "the sign-in screen offers a password");

    assert.ok(await click("New here? Create an account"));
    await atStep("create");
    await type("Your name (what bandmates see)", "Pat Chrome");
    assert.ok(await click("Make a password"), "Make a password");
    await atStep("make-password");
    assert.equal(await value("Username (your public @name)"), "patchrome", "the username is suggested from the name");
    await type("Password", "1234567890");
    assert.ok(await click("Make account"));
    assert.match(await alert(), /common passwords/, "a common password is refused on the phone");
    assert.equal(await step(), "make-password", "and no account is made");
    await type("Password", "violet tram 42 lantern");
    assert.ok(await click("Make account"));
    await atStep("codes");
    const codes = await site.evaluate<string[]>(`[...document.querySelectorAll(".account-codes li")].map((li) => li.textContent)`);
    assert.equal(codes.length, 8, "a password account ends on Save your backup codes");
    assert.ok(await click("I saved them"));
    await atStep("account");
    let text = await sheetText();
    assert.ok(text.includes("@patchrome") && text.includes("Password") && text.includes("Change password"), `Ways to sign in lists the password and Change password (${text})`);

    await signOut();
    assert.ok(await click("Sign in with a password"));
    await atStep("password");
    await type("Your @name", "@patchrome");
    await type("Password", "violet tram 42 lantern");
    assert.ok(await click("Sign in"));
    await atStep("account");

    assert.ok(await click("Change password"));
    await atStep("set-password");
    await type("New password", "changed in chrome 77");
    assert.ok(await click("Save password"));
    await atStep("account");

    await signOut();
    assert.ok(await click("Sign in with a password"));
    await atStep("password");
    await type("Your @name", "patchrome");
    await type("Password", "violet tram 42 lantern");
    assert.ok(await click("Sign in"));
    assert.match(await alert(), /don't match/, "the old password is refused after Change password");
    await type("Password", "changed in chrome 77");
    assert.ok(await click("Sign in"));
    await atStep("account");

    await signOut();
    assert.ok(await click("Sign in with a password"));
    await atStep("password");
    assert.ok(await click("Forgot password? Use a backup code"));
    await atStep("backup-code");
    await type("Your @name", "patchrome");
    await type("Backup code", codes[0]);
    assert.ok(await click("Sign in"));
    await atStep("set-password");
    text = await sheetText();
    assert.ok(text.includes("Set a new password") && text.includes("Backup code used. 7 left."), `a backup code leads to Set a new password and says how many are left (${text})`);
    await type("New password", "reset by backup code");
    assert.ok(await click("Save password"));
    await atStep("account");
    await signOut();
    assert.ok(await click("Sign in with a password"));
    await atStep("password");
    await type("Your @name", "patchrome");
    await type("Password", "reset by backup code");
    assert.ok(await click("Sign in"));
    await atStep("account");
  } finally {
    await site.close();
    await worker.dispose();
  }
}

async function cpuChecks() {
  const perTry = await signInCpuMs(PEPPER);
  const report = Object.entries(perTry).map(([label, ms]) => `${label} ${ms.toFixed(3)} ms`).join(", ");
  console.log(`sign-in handler CPU per try: ${report}`);
  assert.ok(Object.values(perTry).every((ms) => ms < 2), `the Worker's sign-in handler stays under 2 ms of CPU locally (${report})`);
}

let failed = false;
try {
  await cpuChecks();
  await apiChecks();
  await screenChecks();
  console.log(
    "check:password passed: PBKDF2 600,000 rounds on the phone, made-up salts look real, right and wrong passwords, waits of 1, 5, 15 and 60 minutes and reset on success, no permanent lockout, 30 per address, backup code once then a new password, Change password signs out other phones even when it races Sign out everywhere or another Change password, the sign-in handler under 2 ms of CPU, common passwords refused, the sheet's password screens",
  );
} catch (error) {
  failed = true;
  console.error(error);
}
process.exit(failed ? 1 : 0);
