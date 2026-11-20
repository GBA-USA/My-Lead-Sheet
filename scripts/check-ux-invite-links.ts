import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SongContent } from "../src/band-library-model.ts";
import { Phone, startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle } from "./app-page.ts";
import { openSite } from "./chrome.ts";
import { startMockGoogle } from "./mock-google.ts";

/** Signs in with PBKDF2 passwords and the mock Google, so run it under `flock /tmp/mls-auth-checks.lock`. */

const root = new URL("..", import.meta.url).pathname;
const js = JSON.stringify;
const PASSWORD = "violet tram 42 lantern";
const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_KEY = "leadSheetsPendingInvite";
const FRIEND_LINE = "Sign in to add your friend.";
const BAND_LINE = "Sign in to join the band.";
const OFFLINE = "Can't reach the server. Check your connection and try again.";
const CLIENT = { clientId: "check-client.apps.example", clientSecret: "check-only-google-secret" };

const seed = JSON.parse(readFileSync(`${root}data/library.json`, "utf8")) as { songs: (SongContent & { id: number })[] };
const chart = (index: number, title: string): SongContent => {
  const { id: _id, ...song } = seed.songs[index];
  return { ...song, title };
};

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

type Person = { name: string };
type Reply = { status: number; body: any };
const ok = (reply: Reply, what: string) => {
  assert.equal(reply.status, 200, `${what} (${js(reply.body)})`);
  return reply.body;
};
const names = (people: Person[]) => people.map((person) => person.name);

const mock = await startMockGoogle(CLIENT);
let apiBase = "";
const site = await openSite(root, "check-ux-invite-links", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const vars = {
  APP_ORIGIN: origin,
  RP_ID: "localhost",
  PASSWORD_PEPPER,
  GOOGLE_ISSUER: mock.issuer,
  GOOGLE_CLIENT_ID: CLIENT.clientId,
  GOOGLE_CLIENT_SECRET: CLIENT.clientSecret,
  GOOGLE_REDIRECT_URI: `${origin}/api/auth/google/callback`,
};
const main = await startApi(vars);
const short = await startApi({ ...vars, CODE_MINUTE_MS: "1" });
apiBase = main.base;

try {
  const app = await appPage(site);
  await site.send("Network.enable");

  const waitFor = async (expression: string, what: string, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await settle(100)) if (await site.evaluate<boolean>(expression).catch(() => false)) return;
    throw new Error(`timed out waiting for ${what} at ${await site.evaluate<string>("location.href").catch(() => "?")}`);
  };
  const signInSheet = `document.querySelector(".account-sheet[data-step]")`;
  const atStep = (step: string) =>
    waitFor(`${signInSheet}?.dataset.step === ${js(step)}`, `the ${step} screen`).catch(async (error) => {
      const seen = await site.evaluate<string>(`(${signInSheet}?.dataset.step ?? "no sheet") + ": " + (${signInSheet}?.querySelector("[role=alert]")?.textContent ?? "")`).catch(() => "?");
      throw new Error(`${error.message} (saw ${seen})`);
    });
  const firstLine = () => site.evaluate<string>(`${signInSheet}?.querySelector(".account-top")?.nextElementSibling?.textContent ?? ""`);
  const words = (selector: string, text: string) => waitFor(`document.querySelector(${js(selector)})?.textContent === ${js(text)}`, `"${text}"`);
  const alertsSaying = (text: string) => site.evaluate<number>(`[...document.querySelectorAll("[role=alert]")].filter((el) => el.textContent.trim() === ${js(text)}).length`);
  const pending = () => site.evaluate<string | null>(`localStorage.getItem(${js(PENDING_KEY)})`);
  const anySheet = () => site.evaluate<boolean>(`!!document.querySelector("[role=dialog]")`);
  const inPage = (path: string, body?: object) =>
    site.evaluate<Reply>(
      `fetch(${js(path)}, ${body ? `{ method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }` : "{}"}).then(async (r) => ({ status: r.status, body: await r.json() }))`,
    );
  const me = async () => (await inPage("/api/me")).body.account as { userId: string } | undefined;

  /** A wiped phone with its own Face ID: no cookie, no passkey, nothing in storage, the Songs tab, signed out. */
  const fresh = async () => {
    await site.send("Network.setBlockedURLs", { urls: [] });
    await site.send("WebAuthn.disable");
    await site.send("WebAuthn.enable");
    await site.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    await site.send("Page.navigate", { url: "about:blank" });
    await site.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
    await site.send("Network.clearBrowserCookies");
    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await app.library();
  };
  const open = async (link: string) => {
    await site.send("Page.navigate", { url: link });
  };
  const closeSignIn = async () => {
    await app.click("✕", signInSheet);
    await waitFor(`!${signInSheet}`, "the sign-in sheet closing");
  };
  const nothingPending = async (what: string) => {
    assert.equal(await pending(), null, `${what}: nothing is pending`);
    assert.equal(await site.evaluate<string>("location.search"), "", `${what}: the landed code left the address bar`);
  };
  const createWithPasskey = async (name: string) => {
    await app.click("New here? Create an account", signInSheet);
    await app.type("Your name (what bandmates see)", name);
    await app.click("Sign in with Face ID or fingerprint", signInSheet);
    await atStep("nudge");
    await app.click("Not now", signInSheet);
  };
  const signInWithPassword = async (handle: string) => {
    await app.click("Sign in with a password", signInSheet);
    await atStep("password");
    await app.type("Your @name", handle);
    await app.type("Password", PASSWORD);
    await app.click("Sign in", signInSheet);
  };
  const signInFromSettings = async (handle: string) => {
    await app.openMenu();
    await app.pick("Sign in");
    await atStep("start");
    await signInWithPassword(handle);
    await atStep("account");
    await closeSignIn();
    await app.closeMenu();
  };

  const terry = await passwordPlayer(main.base, origin, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(main.base, origin, "Mike Keys", "mikekeys");
  const dana = await passwordPlayer(main.base, origin, "Dana Drums", "danadrums");
  const lou = await passwordPlayer(main.base, origin, "Lou Stops", "loustops");
  await passwordPlayer(main.base, origin, "Lee Horn", "leehorn");
  await passwordPlayer(main.base, origin, "Bob Reed", "bobreed");
  const bandId = ok(await terry.call("/api/bands/create", { name: "The Low Tides" }), "Terry makes The Low Tides").bandId as string;
  const songId = ok(await terry.call("/api/bands/library/share-song", { bandId, song: chart(0, "Low Tide Opener"), choice: "public", localId: null }), "Terry shares a song").songId as string;
  const setlistId = ok(await terry.call("/api/bands/library/share-setlist", { bandId, name: "Harbor set", songIds: [songId], tags: [], choice: "public", localId: null }), "Terry shares the Harbor set")
    .setlistId as string;

  const linkOf = async (who: Phone, request: object) => ok(await who.call("/api/codes", request), `a code for ${js(request)}`) as { code: string; link: string; expiresAt: number };
  const friendsOf = async (who: Phone) => names(ok(await who.call("/api/friends"), "the friends list").friends);
  const requestsOf = async (who: Phone) => names(ok(await who.call("/api/friends"), "the friends list").requests);
  const membersOf = async (admin: Phone, band: string) => names(ok(await admin.call("/api/bands/open", { bandId: band }), "the band").members);

  await check("a signed-in phone that opens a friend link is friends with the sender at once and sees the line", async () => {
    await fresh();
    await app.signUp("Sam Rivera");
    await open((await linkOf(mike, { kind: "friend-link" })).link);
    await words(".friends-notice", "You and Mike Keys are friends.");
    assert.deepEqual(await app.texts(".friends-friends li > span:first-child"), ["Mike Keys@mikekeys"], "Mike is on the list in the sheet");
    assert.ok((await friendsOf(mike)).includes("Sam Rivera"), "and the server has them as friends on Mike's side");
    await nothingPending("after the friend link");
  });

  await check("a scanned in-person friend code still asks before sending a request", async () => {
    await fresh();
    await app.signUp("Nia Scan");
    await open((await linkOf(dana, { kind: "friend-now" })).link);
    await words(".friends-sheet .codes-words", "Dana Drums @danadrums");
    await settle(1500);
    assert.ok((await app.texts(".friends-sheet button")).includes("Send request"), "the in-person code waits on Send request");
    assert.deepEqual([await requestsOf(dana), await friendsOf(dana)], [[], []], "before the tap, Dana has no request and no new friend");
    await app.click("Send request", `document.querySelector(".friends-sheet")`);
    await words(".friends-notice", "Request sent. Dana Drums needs to accept.");
    assert.deepEqual(await requestsOf(dana), ["Nia Scan"], "the tap sends Dana a request to accept");
    assert.deepEqual(await friendsOf(dana), [], "and nobody is friends until she accepts");
    await nothingPending("after the in-person code");
  });

  await check("a signed-in phone that opens a band link is in the band at once and sees You joined", async () => {
    await fresh();
    await app.signUp("Ray Joins");
    await open((await linkOf(terry, { kind: "band", bandId })).link);
    await words(".band-page .bands-notice", "You joined The Low Tides.");
    const hash = await site.evaluate<string>("location.hash");
    assert.ok(hash.startsWith(`#/band/${bandId}`), `the band page is open (${hash})`);
    assert.ok((await membersOf(terry, bandId)).includes("Ray Joins"), "and Ray is a member on the server");
    await nothingPending("after the band link");
  });

  await check("a signed-out phone that opens either link sees the sign-in sheet with Create account and the invite line, and closing it keeps the app usable with nothing pending", async () => {
    const links: [string, string][] = [
      ["friend", FRIEND_LINE],
      ["band", BAND_LINE],
    ];
    for (const [kind, line] of links) {
      await fresh();
      await open((await linkOf(kind === "friend" ? mike : terry, kind === "friend" ? { kind: "friend-link" } : { kind: "band", bandId })).link);
      await atStep("start");
      assert.equal(await firstLine(), line, `a ${kind} link: the sheet's first line says what signing in does`);
      assert.ok((await app.texts(".account-sheet[data-step] button")).includes("New here? Create an account"), `a ${kind} link: Create account is right there`);
      assert.ok(await pending(), `a ${kind} link: the invite waits on the phone while the sheet is open`);
      await closeSignIn();
      await settle(1500);
      assert.equal(await anySheet(), false, `a ${kind} link: no other sheet opens after Close`);
      await nothingPending(`a ${kind} link closed`);
      assert.deepEqual(await app.openMenu(), ["Sign in"], `a ${kind} link: the visitor is back in the app, still signed out`);
      await app.closeMenu();
      await site.evaluate(`document.getElementById("tab-setlists").click()`);
      await waitFor(`location.hash === "#/setlists" && document.querySelectorAll("section.setlist").length > 0`, "the Setlists tab");
      await site.send("Page.reload");
      await app.library();
      await settle(1500);
      assert.equal(await anySheet(), false, `a ${kind} link: a reload opens no sign-in sheet again`);
    }
  });

  await check("creating an account from that sheet connects the friend or joins the band", async () => {
    await fresh();
    await open((await linkOf(mike, { kind: "friend-link" })).link);
    await atStep("start");
    await createWithPasskey("Pat Lee");
    await words(".friends-notice", "You and Mike Keys are friends.");
    assert.equal(await site.evaluate<boolean>(`!!${signInSheet}`), false, "the sign-in sheet closed itself");
    assert.ok((await friendsOf(mike)).includes("Pat Lee"), "Pat, new with a passkey, is Mike's friend");
    await nothingPending("after Create account with a passkey");

    await fresh();
    await open((await linkOf(terry, { kind: "band", bandId })).link);
    await atStep("start");
    await app.click("New here? Create an account", signInSheet);
    await app.type("Your name (what bandmates see)", "Quinn Pass");
    await app.click("Make a password", signInSheet);
    await atStep("make-password");
    await app.type("Password", PASSWORD);
    await app.click("Make account", signInSheet);
    await words(".band-page .bands-notice", "You joined The Low Tides.");
    assert.ok((await membersOf(terry, bandId)).includes("Quinn Pass"), "Quinn, new with a password, is in the band");
    await nothingPending("after Create account with a password");
  });

  await check("a password sign-in and a Google return both complete the pending invite", async () => {
    await fresh();
    await open((await linkOf(mike, { kind: "friend-link" })).link);
    await atStep("start");
    await signInWithPassword("leehorn");
    await words(".friends-notice", "You and Mike Keys are friends.");
    assert.ok((await friendsOf(mike)).includes("Lee Horn"), "Lee signed in with a password and is Mike's friend");
    await nothingPending("after a password sign-in");

    await fresh();
    await open((await linkOf(terry, { kind: "band", bandId })).link);
    await atStep("start");
    assert.ok(await pending(), "the band invite waits on the phone before Google");
    mock.signInAs({ sub: "100000000000000000091", email: "giagoogle@example.test", name: "Gia Google" });
    await app.click("Continue with Google", signInSheet);
    await waitFor(`["nudge", "account"].includes(${signInSheet}?.dataset.step) || !!document.querySelector(".band-page .bands-notice")`, "the return from Google");
    if ((await site.evaluate<string>(`${signInSheet}?.dataset.step ?? ""`)) === "nudge") await app.click("Not now", signInSheet);
    await words(".band-page .bands-notice", "You joined The Low Tides.");
    assert.ok((await membersOf(terry, bandId)).includes("Gia Google"), "Gia came back from Google and is in the band");
    await nothingPending("after the Google return");
  });

  await check("a pending invite older than 24 hours is dropped", async () => {
    await fresh();
    await open((await linkOf(terry, { kind: "band", bandId })).link);
    await atStep("start");
    await site.send("Page.reload");
    await atStep("start");
    assert.equal(await firstLine(), BAND_LINE, "within the day, reopening the app brings the invite back");
    const { identifier } = await site.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => { const Real = Date; const shift = ${DAY_MS + 60 * 60 * 1000}; globalThis.Date = class extends Real { constructor(...args) { if (args.length) super(...args); else super(Real.now() + shift); } static now() { return Real.now() + shift; } }; })();`,
    });
    try {
      await site.send("Page.navigate", { url: `${origin}/#/songs` });
      await site.send("Page.reload");
      await app.library();
      await settle(1500);
      assert.equal(await anySheet(), false, "25 hours later the app opens with no sign-in sheet");
      assert.equal(await pending(), null, "and the stale invite is gone");
    } finally {
      await site.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
    await site.send("Page.reload");
    await app.library();
    await settle(1000);
    assert.equal(await anySheet(), false, "back on today's clock, it stays gone");
  });

  await check("an expired or stopped link shows the refusal once and leaves nothing pending", async () => {
    await fresh();
    const stopped = await linkOf(lou, { kind: "friend-link" });
    await open(stopped.link);
    await atStep("start");
    ok(await lou.call("/api/codes/stop", { code: stopped.code }), "Lou stops the link while the visitor signs up");
    await createWithPasskey("Uma Late");
    const stoppedWords = "This code was stopped. Ask for a fresh one.";
    await waitFor(`[...document.querySelectorAll(".friends-sheet [role=alert]")].some((el) => el.textContent.trim() === ${js(stoppedWords)})`, "the stopped words");
    await settle(1000);
    assert.equal(await alertsSaying(stoppedWords), 1, "the stopped link is refused once");
    assert.ok(!(await site.evaluate<string>(`document.querySelector(".friends-sheet").textContent`)).includes("Lou"), "the refusal names nobody");
    assert.deepEqual(await friendsOf(lou), [], "and adds nobody");
    await nothingPending("after the stopped link");
    await site.send("Page.reload");
    await app.library();
    await settle(1500);
    assert.deepEqual([await anySheet(), await alertsSaying(stoppedWords)], [false, 0], "a reload shows the refusal no second time");

    apiBase = short.base;
    try {
      await fresh();
      const tess = await passwordPlayer(short.base, origin, "Tess Short", "tessshort");
      const shortBand = ok(await tess.call("/api/bands/create", { name: "The Short Band" }), "Tess makes a band").bandId as string;
      const ending = await linkOf(tess, { kind: "band", bandId: shortBand });
      await open(ending.link);
      await atStep("start");
      await new Promise((done) => setTimeout(done, Math.max(0, ending.expiresAt - Date.now()) + 300));
      await createWithPasskey("Vic Late");
      const endedWords = "This code has ended. Ask for a fresh one.";
      await waitFor(`[...document.querySelectorAll(".bands-sheet [role=alert]")].some((el) => el.textContent.trim() === ${js(endedWords)})`, "the ended words");
      await settle(1000);
      assert.equal(await alertsSaying(endedWords), 1, "the expired link is refused once");
      assert.ok(!(await site.evaluate<string>(`document.querySelector(".bands-sheet").textContent`)).includes("Short Band"), "the refusal names no band");
      assert.deepEqual(await membersOf(tess, shortBand), ["Tess Short"], "and joins nobody");
      await nothingPending("after the expired link");
      await site.send("Page.reload");
      await app.library();
      await settle(1500);
      assert.deepEqual([await anySheet(), await alertsSaying(endedWords)], [false, 0], "a reload shows the refusal no second time");
    } finally {
      apiBase = main.base;
    }
  });

  await check("gig, band-setlist and my-setlist codes keep their current landing", async () => {
    await fresh();
    await app.signUp("Wes Gig");
    const wes = (await me())!;
    ok(await inPage("/api/bands/join", { code: (await linkOf(terry, { kind: "band", bandId })).code }), "Wes joins The Low Tides");
    ok(await inPage("/api/friends/add-by-code", { code: (await linkOf(terry, { kind: "friend-link" })).code }), "Wes adds Terry");
    const gigId = ok(await terry.call("/api/bands/gig/plan", { bandId, setlistId, name: "Harbor night", date: "2026-11-28" }), "Terry plans a gig").gig.gigId as string;
    assert.ok(ok(await terry.call("/api/bands/gig/open", { bandId, gigId }), "the gig").gig.lineup.includes(wes.userId), "Wes is on the lineup");

    await open((await linkOf(terry, { kind: "gig", bandId, gigId })).link);
    await waitFor(`!!document.querySelector(${js(`.band-page [data-gig="${gigId}"]`)})`, "the gig card on the band page");
    assert.ok((await site.evaluate<string>("location.hash")).startsWith(`#/band/${bandId}`), "a gig link opens the band");
    await nothingPending("after the gig link");

    await open((await linkOf(terry, { kind: "band-setlist", bandId, setlistId })).link);
    await waitFor(`!!document.querySelector(${js(`.band-library-setlists [data-setlist="${setlistId}"][aria-current="true"]`)})`, "the landed setlist, marked");
    await nothingPending("after the band setlist link");

    const copy = await linkOf(terry, { kind: "my-setlist", choice: "public", name: "Porch set", songs: [{ song: chart(1, "Porch Song"), copyId: null }], setlistCopyId: null });
    await open(copy.link);
    await waitFor(`location.hash.startsWith("#/messages/") && !document.querySelector(".setlist-copy-sheet")`, "the DM the copy arrives in");
    await nothingPending("after the setlist copy link");
  });

  await check("no paste box exists on Bands or Friends", async () => {
    await fresh();
    await app.signUp("Xan Paste");
    await app.openBands();
    await waitFor(`!document.querySelector(".bands-sheet").textContent.includes("Loading")`, "the Bands sheet list");
    assert.deepEqual(await app.texts(".bands-sheet label"), ["New band"], "the Bands sheet has one field, New band");
    assert.ok((await app.texts(".bands-sheet button")).includes("Scan a code"), "and Scan a code");
    await app.click("✕", `document.querySelector(".bands-sheet")`);
    await site.evaluate(`location.hash = "#/songs"`);
    await app.openMenu();
    await app.pick("Friends");
    await waitFor(`document.querySelector(".friends-sheet")?.dataset.view === "list" && !document.querySelector(".friends-sheet").textContent.includes("Loading")`, "the Friends list");
    assert.deepEqual(await app.texts(".friends-sheet label"), ["Add by @name"], "the Friends sheet has one field, Add by @name");
    assert.ok((await app.texts(".friends-sheet button")).includes("Scan a code"), "and Scan a code");
  });

  await check("a second account on the same phone never inherits the first's pending invite", async () => {
    await fresh();
    await open((await linkOf(terry, { kind: "band", bandId })).link);
    await atStep("start");
    assert.equal(await firstLine(), BAND_LINE, "the first visitor sees the band invite");
    await closeSignIn();
    await signInFromSettings("bobreed");
    await settle(2000);
    assert.equal(await site.evaluate<boolean>(`!!document.querySelector(".band-page, .bands-sheet")`), false, "Bob signing in next opens no band");
    assert.ok(!(await membersOf(terry, bandId)).includes("Bob Reed"), "and Bob is not in the band");
    await nothingPending("after Bob signs in");

    await fresh();
    await app.signUp("Yan First");
    await site.send("Network.setBlockedURLs", { urls: ["*/api/friends/code*", "*/api/friends/add-by-code*"] });
    await open((await linkOf(mike, { kind: "friend-link" })).link);
    await waitFor(`[...document.querySelectorAll(".friends-sheet [role=alert]")].some((el) => el.textContent.trim() === ${js(OFFLINE)})`, "the no-signal words");
    await site.send("Network.setBlockedURLs", { urls: [] });
    await app.click("✕", `document.querySelector(".friends-sheet")`);
    await app.openMenu();
    await app.pick("Account");
    await atStep("account");
    await app.click("Sign out", signInSheet);
    await atStep("start");
    await closeSignIn();
    await app.closeMenu();
    await signInFromSettings("bobreed");
    await settle(2000);
    assert.equal(await site.evaluate<boolean>(`!!document.querySelector(".friends-sheet")`), false, "Bob signing in after Yan opens no Friends sheet");
    const mikes = await friendsOf(mike);
    assert.ok(!mikes.includes("Bob Reed") && !mikes.includes("Yan First"), `neither Yan's failed link nor Bob made a friend (${js(mikes)})`);
    await nothingPending("after the account switch");
  });

  await check("no page errors", async () => assert.deepEqual(await app.errors(), [], "the page logged no errors"));
} finally {
  await site.close();
  await main.worker.dispose();
  await short.worker.dispose();
  await mock.close();
}

if (failed) {
  console.log(`check:ux-invite-links: ${failed} failed`);
  process.exit(1);
}
console.log("check:ux-invite-links passed");
