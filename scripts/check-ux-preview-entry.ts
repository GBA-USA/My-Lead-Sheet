import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Phone, startApi, TEST_ORIGIN } from "./api-session.ts";
import { appPage, settle, WIDTH } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/** Signs phones in, so run it under `flock /tmp/mls-auth-checks.lock`. Set SHOTS to a folder to save the Bands tab at 390 and 1280. */

const root = new URL("..", import.meta.url).pathname;
const shots = process.env.SHOTS;
const js = JSON.stringify;
const ENTER = "/api/preview-enter";
const DAY_S = 24 * 60 * 60;
const HANDLE = /^[a-z0-9]{3,20}$/;

let failed = 0;
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type Reply = { status: number; body: any; setCookie: string | null };

/** A POST the way the phone's silent enter sends it: the app's Origin, the phone's cookie if it has one, and no body. */
async function enter(base: string, origin: string, cookie = ""): Promise<Reply> {
  const response = await fetch(new URL(ENTER, base), { method: "POST", headers: { origin, ...(cookie ? { cookie } : {}) } });
  return { status: response.status, body: await response.json().catch(() => null), setCookie: response.headers.get("set-cookie") };
}

const cookiePair = (setCookie: string | null) => setCookie?.split(";")[0] ?? "";
const attributes = (setCookie: string | null) => setCookie?.replace(/^mls_session=[^;]*/, "") ?? "";

let apiBase = "";
const site = await openSite(root, "check-ux-preview-entry", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const browserVars = { APP_ORIGIN: origin, RP_ID: "localhost" };
const browserOn = await startApi({ ...browserVars, PREVIEW_OPEN_ACCESS: "1" });
const browserOff = await startApi(browserVars);

try {
  const app = await appPage(site);
  await site.send("Network.enable");
  await site.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__login = new Set();
      new MutationObserver(() => {
        if (document.querySelector(".account-sheet")) __login.add("the sign-in sheet");
        if ([...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Sign in")) __login.add("a Sign in button");
        const hit = (document.body?.innerText ?? "").match(/Continue as|Sign in to|Sign in with|Create an account|Face ID|fingerprint|[Pp]asskey|[Pp]assword/);
        if (hit) __login.add(hit[0]);
      }).observe(document, { subtree: true, childList: true, characterData: true });`,
  });

  const loginSeen = () => site.evaluate<string[]>("[...window.__login]");
  const apiCalls = () => site.evaluate<string[]>(`performance.getEntriesByType("resource").map((e) => new URL(e.name).pathname).filter((p) => p.startsWith("/api/"))`);
  const button = (text: string) => `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === ${js(text)})`;
  const inPage = (path: string, body?: object) =>
    site.evaluate<{ status: number; body: any }>(
      `fetch(${js(path)}, ${body ? `{ method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }` : "{}"}).then(async (r) => ({ status: r.status, body: await r.json() }))`,
    );
  const me = async () => (await inPage("/api/me")).body.account as { userId: string; handle: string; displayName: string } | undefined;

  /** A browser that has never opened the app: no cookie, nothing stored, on My Songs, pointed at `worker`. */
  const fresh = async (worker: { base: string }) => {
    apiBase = worker.base;
    await site.send("Page.navigate", { url: "about:blank" });
    await site.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
    await site.send("Network.clearBrowserCookies");
    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await app.library();
  };
  const tapBands = async () => {
    await site.evaluate(`document.getElementById("tab-bands").click()`);
    await settle(100);
  };
  const shotBoth = async (name: string) => {
    if (!shots) return;
    for (const width of [WIDTH, 1280]) {
      await site.send("Emulation.setDeviceMetricsOverride", width === WIDTH ? { width, height: 844, deviceScaleFactor: 2, mobile: true } : { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await settle(300);
      await app.shot(`${shots}/${name}-${width}.png`);
    }
    await site.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 844, deviceScaleFactor: 2, mobile: true });
  };
  const noErrors = async () => assert.deepEqual(await app.errors(), [], "the page logged no errors");

  await check("when PREVIEW_OPEN_ACCESS is not 1, POST /api/preview-enter returns 404 and auth config does not offer open access", async () => {
    const settings: [string, Record<string, string>][] = [
      ["missing", {}],
      ["empty", { PREVIEW_OPEN_ACCESS: "" }],
      ['"0"', { PREVIEW_OPEN_ACCESS: "0" }],
      ['"true"', { PREVIEW_OPEN_ACCESS: "true" }],
      ['" 1"', { PREVIEW_OPEN_ACCESS: " 1" }],
      ['"1 "', { PREVIEW_OPEN_ACCESS: "1 " }],
    ];
    const wrangler = JSON.parse(readFileSync(`${root}worker/wrangler.jsonc`, "utf8").replace(/^\s*\/\/.*$/gm, ""));
    assert.notEqual(wrangler.vars?.PREVIEW_OPEN_ACCESS, "1", "the Worker config never turns open access on at the top level");
    for (const env of ["test", "production"]) assert.equal(wrangler.env[env].vars.PREVIEW_OPEN_ACCESS, "", `the ${env} config declares PREVIEW_OPEN_ACCESS as empty`);
    for (const [label, extra] of settings) {
      const api = await startApi(extra);
      try {
        const config = await new Phone(api.base).call("/api/auth/config");
        assert.equal(config.status, 200, `flag ${label}: auth config answers`);
        assert.ok(!("previewOpen" in config.body) || config.body.previewOpen === false, `flag ${label}: auth config does not offer open access (${js(config.body)})`);

        const signedOut = await enter(api.base, TEST_ORIGIN);
        assert.equal(signedOut.status, 404, `flag ${label}: a signed-out enter is 404 (${js(signedOut.body)})`);
        assert.equal(signedOut.setCookie, null, `flag ${label}: a signed-out enter sets no cookie`);
        assert.equal(signedOut.body?.account, undefined, `flag ${label}: a signed-out enter returns no account`);

        const withBody = await new Phone(api.base).call(ENTER, {});
        assert.deepEqual([withBody.status, withBody.body.account], [404, undefined], `flag ${label}: an enter with a JSON body is 404 too`);

        const player = new Phone(api.base);
        assert.equal((await player.createAccount("Sam Rivera")).status, 200, `flag ${label}: a real account signs up`);
        const before = player.cookie;
        const signedIn = await enter(api.base, TEST_ORIGIN, before);
        assert.deepEqual([signedIn.status, signedIn.setCookie], [404, null], `flag ${label}: a signed-in enter is 404 and leaves the cookie alone`);
        const after = await player.call("/api/me");
        assert.deepEqual([after.status, after.body.account.handle], [200, "samrivera"], `flag ${label}: the signed-in phone is still the same account`);
      } finally {
        await api.worker.dispose();
      }
    }

    await fresh(browserOff);
    assert.deepEqual(await apiCalls(), [], "flag off: a signed-out launch still calls no API");
    await tapBands();
    await app.until(`document.querySelector(".bands-tab-note")?.textContent === "Sign in to see your bands." && ${button("Sign in")}`, "the signed-out Bands tab with its Sign in button", 8000);
    await settle(500);
    assert.ok(!(await apiCalls()).includes(ENTER), "flag off: the Bands tab never asks to enter");
    assert.equal(await me(), undefined, "flag off: the browser stays signed out");
    await shotBoth("bands-signed-out-flag-off");
    await app.click("Sign in");
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "start"`, "the usual sign-in sheet", 8000);
    assert.ok((await app.texts(".account-sheet button")).includes("New here? Create an account"), "flag off: Sign in opens the usual sheet");
    await app.click("✕");
    await noErrors();
  });

  await check("when PREVIEW_OPEN_ACCESS is 1, a signed-out phone that opens Band is signed in with no login screen and can use Band", async () => {
    const api = await startApi({ PREVIEW_OPEN_ACCESS: "1" });
    try {
      const config = await new Phone(api.base).call("/api/auth/config");
      assert.equal(config.body.previewOpen, true, `auth config offers open access (${js(config.body)})`);
      const entered = await enter(api.base, TEST_ORIGIN);
      assert.equal(entered.status, 200, `a bodyless enter signs in (${js(entered.body)})`);
      assert.ok(cookiePair(entered.setCookie).startsWith("mls_session="), `the reply sets the session cookie (${entered.setCookie})`);
      const regular = new Phone(api.base);
      await regular.createAccount("Regular Login");
      assert.equal(attributes(entered.setCookie), attributes(regular.lastSetCookie), "the cookie has the same name, flags and 90-day life as a regular sign-in");
      assert.match(entered.setCookie ?? "", new RegExp(`Max-Age=${90 * DAY_S}`), "the cookie lives 90 days");
      const { account } = entered.body;
      assert.equal(account.displayName, "Band member", "the account is named Band member");
      assert.match(account.handle, /^preview[a-z0-9]+$/, `the handle is preview and a short suffix (${account.handle})`);
      assert.match(account.handle, HANDLE, "the handle fits the @name rule");
      const mine = await new Phone(api.base).call("/api/me", undefined, { cookie: cookiePair(entered.setCookie) });
      assert.equal(mine.body.account?.userId, account.userId, "the cookie is a working session for that account");
    } finally {
      await api.worker.dispose();
    }

    await fresh(browserOn);
    assert.deepEqual(await apiCalls(), [], "a signed-out launch on My Songs calls no API before Band opens");
    await tapBands();
    await app.until(button("+ New band"), "the Bands tab, signed in", 10000);
    await app.until(`document.querySelector(".bands-tab-note")?.textContent === "No bands yet. Make one, or scan a bandmate's code."`, "the empty band list", 8000);
    assert.deepEqual(await loginSeen(), [], "no login screen, passkey, password or Continue as ever showed");
    const account = await me();
    assert.ok(account, "the browser is signed in");
    assert.equal(account.displayName, "Band member", "as Band member");
    assert.match(account.handle, /^preview[a-z0-9]+$/, `with a preview handle (${account.handle})`);
    assert.match(account.handle, HANDLE, "that fits the @name rule");
    const { cookies } = await site.send("Network.getCookies", { urls: [origin] });
    const session = (cookies as { name: string; httpOnly: boolean; secure: boolean; sameSite: string; path: string; expires: number }[]).find((cookie) => cookie.name === "mls_session");
    assert.ok(session, "the browser holds the mls_session cookie");
    assert.deepEqual([session.httpOnly, session.secure, session.sameSite, session.path], [true, true, "Lax", "/"], "it is HttpOnly, Secure, SameSite=Lax on /");
    assert.ok(Math.abs(session.expires - Date.now() / 1000 - 90 * DAY_S) < 600, `it lasts 90 days (${Math.round((session.expires - Date.now() / 1000) / DAY_S)} days)`);
    await shotBoth("bands-after-auto-enter");

    await app.click("+ New band");
    await app.until(`!!document.querySelector(".bands-sheet")`, "the band sheet", 8000);
    await site.evaluate(`[...document.querySelectorAll("[role=dialog] label")].find((l) => l.textContent.trim() === "New band").control.focus()`);
    await site.send("Input.insertText", { text: "Preview Tides" });
    await app.click("Create band", `document.querySelector(".bands-sheet")`);
    await app.until(`location.hash.startsWith("#/band/")`, "the new band's page", 10000);
    const bands = (await inPage("/api/bands")).body.bands as { name: string; role: string }[];
    assert.deepEqual(bands.map((band) => [band.name, band.role]), [["Preview Tides", "admin"]], "the server has the new band with this account as admin");
    assert.deepEqual(await loginSeen(), [], "and still no login screen");
    await noErrors();
  });

  await check("two browsers each get their own Preview account and a reload keeps the same one", async () => {
    const api = await startApi({ PREVIEW_OPEN_ACCESS: "1" });
    try {
      const [terry, brian] = [await enter(api.base, TEST_ORIGIN), await enter(api.base, TEST_ORIGIN)];
      assert.deepEqual([terry.status, brian.status], [200, 200], "both browsers enter");
      assert.notEqual(terry.body.account.userId, brian.body.account.userId, "each browser is its own account");
      assert.notEqual(terry.body.account.handle, brian.body.account.handle, "with its own handle");
      for (const handle of [terry.body.account.handle, brian.body.account.handle]) assert.match(handle, HANDLE, `${handle} fits the @name rule`);

      const again = await enter(api.base, TEST_ORIGIN, cookiePair(terry.setCookie));
      assert.equal(again.status, 200, "entering again with a session answers");
      assert.equal(again.body.account.userId, terry.body.account.userId, "a call with a valid session returns that same account");
      assert.equal(again.setCookie, null, "and does not hand out a new session");

      const pair = cookiePair(terry.setCookie);
      const forged = `${pair.slice(0, -5)}${pair.at(-5) === "A" ? "B" : "A"}${pair.slice(-4)}`;
      const replaced = await enter(api.base, TEST_ORIGIN, forged);
      assert.equal(replaced.status, 200, "a tampered cookie still gets in");
      assert.ok(![terry.body.account.userId, brian.body.account.userId].includes(replaced.body.account.userId), "but as a new account, not Terry's");
    } finally {
      await api.worker.dispose();
    }

    await fresh(browserOn);
    await tapBands();
    await app.until(button("+ New band"), "the Bands tab, signed in", 10000);
    const first = await me();
    assert.ok(first, "the browser entered");
    await site.evaluate("window.__beforeReload = true");
    await site.send("Page.reload");
    await app.until(`!window.__beforeReload && ${button("+ New band")}`, "the Bands tab after the reload", 10000);
    assert.equal((await me())?.userId, first.userId, "the reload keeps the same account");
    assert.ok(!(await apiCalls()).includes(ENTER), "and does not ask to enter again");

    const terry = new Phone(browserOn.base);
    const terryEnter = await terry.call(ENTER, {}, { origin });
    assert.equal(terryEnter.status, 200, "Terry's own browser enters");
    const bandId = (await terry.call("/api/bands/create", { name: "Two Phones" }, { origin })).body.bandId as string;
    const link = (await terry.call("/api/codes", { kind: "band", bandId }, { origin })).body.link as string;
    assert.ok(link, "Terry gets an invite link");

    await fresh(browserOn);
    await site.send("Page.navigate", { url: link });
    await app.until(`document.querySelector(".band-page .bands-notice")?.textContent === "You joined Two Phones."`, "Brian joining from the link", 15000);
    assert.deepEqual(await loginSeen(), [], "Brian's fresh browser joins with no login screen");
    const brian = await me();
    assert.ok(brian && ![first.userId, terryEnter.body.account.userId].includes(brian.userId), "Brian's browser is a third account of its own");
    const members = (await terry.call("/api/bands/open", { bandId }, { origin })).body.members as { name: string }[];
    assert.equal(members.length, 2, `Terry sees two members in the band (${js(members)})`);
    await noErrors();
  });
} finally {
  await site.close();
  await browserOn.worker.dispose();
  await browserOff.worker.dispose();
}

if (failed) {
  console.log(`check:ux-preview-entry: ${failed} failed`);
  process.exit(1);
}
console.log("check:ux-preview-entry passed");
