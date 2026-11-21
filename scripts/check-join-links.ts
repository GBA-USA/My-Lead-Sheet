import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { SongContent } from "../src/band-library-model.ts";
import { APP_NAME } from "../src/data-kinds.ts";
import { Phone, startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/**
 * P1 persona-join-links (and its P1b follow-up): a remote bandmate on a desktop browser can always get into the band.
 * One case per pass condition, named by it. The pure cases need nothing; the landing-page case needs only the Worker;
 * the rest drive the app in headless Chrome (`CHROME` names the browser). Paths come from fileURLToPath and path.join
 * so the script runs on Windows and Linux.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const js = JSON.stringify;
const DAY_MS = 24 * 60 * 60 * 1000;
const WIDTHS = [344, 390, 820, 884, 1280];
/** The day the landing page names, as the Worker writes it: the server can't know the visitor's time zone, so UTC. */
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const WHY = {
  incomplete: "This link is incomplete or out of date. Copy it again, or ask for a fresh one.",
  replaced: "This link was replaced. Ask for a fresh one.",
  reset: (ms: number) => `This link was reset on ${day(ms)}. Ask for a fresh one.`,
  ended: (ms: number) => `This link ended on ${day(ms)}. Ask for a fresh one.`,
};
const NOT_A_LINK = `That isn't a ${APP_NAME} link.`;
const OFFLINE = "Can't reach the server. Check your connection and try again.";

const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: (SongContent & { id: number })[] };
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

type Reply = { status: number; body: any };
const ok = (reply: Reply, what: string) => {
  assert.equal(reply.status, 200, `${what} (${js(reply.body)})`);
  return reply.body;
};

await check("refreshDelay caps a code's refresh timer at one day and keeps a short one as it is", async () => {
  const link = (await import("../src/code-link.ts")) as Record<string, unknown>;
  assert.equal(typeof link.refreshDelay, "function", "src/code-link.ts exports refreshDelay(expiresAt, now)");
  const refreshDelay = link.refreshDelay as (expiresAt: number, now: number) => number;
  const now = Date.UTC(2026, 10, 20, 19, 55);
  assert.equal(refreshDelay(now + 10 * 365 * DAY_MS, now), DAY_MS, "a never-ending code waits one day, under the browser's 32-bit timer limit");
  assert.equal(refreshDelay(now + 60000, now), 60000, "a code ending in a minute waits that minute");
  assert.equal(refreshDelay(now + DAY_MS, now), DAY_MS, "a code ending in exactly a day waits that day");
  assert.equal(refreshDelay(now - 1, now), 0, "a code already past its end waits no time");
  assert.ok(refreshDelay(now + 10 * 365 * DAY_MS, now) <= 2147483647, "never over the timer limit");
});

await check("the refusal word table says why each code fails", async () => {
  const { CODE_REFUSED } = (await import("../src/code-link.ts")) as { CODE_REFUSED: Record<string, string> };
  assert.equal(CODE_REFUSED["bad-code"], WHY.incomplete, "a bad signature or a cut-off link says it is incomplete or out of date");
  assert.equal(CODE_REFUSED["code-replaced"], WHY.replaced, "a real code whose row is gone says it was replaced");
  assert.equal(CODE_REFUSED["code-stopped"], "This code was stopped. Ask for a fresh one.", "the in-app stopped words stay as earlier checks pin them");
  assert.equal(CODE_REFUSED["code-ended"], "This code has ended. Ask for a fresh one.", "the in-app ended words stay as earlier checks pin them");
});

await check("every refused code says WHY on the /c/ landing page, with Open the app", async () => {
  // A code minute on `home` is 10 ms, so a ten-minute in-person code ends in 100 ms.
  const home = await startApi({ CODE_MINUTE_MS: "10" });
  try {
    const land = async (base: string, payload: string) => {
      const reply = await fetch(new URL(`/c/${payload}`, base), { redirect: "manual" });
      return { status: reply.status, type: reply.headers.get("content-type") ?? "", text: await reply.text() };
    };
    const refusedPage = (page: Awaited<ReturnType<typeof land>>, what: string, status: number, headline: RegExp, why: string) => {
      assert.equal(page.status, status, `${what} keeps its ${status}`);
      assert.match(page.type, /^text\/html/, `${what} gets a page`);
      assert.match(page.text, headline, `${what} keeps its headline (${page.text})`);
      assert.ok(page.text.includes(why), `${what} says why: ${js(why)} (${page.text})`);
      assert.match(page.text, new RegExp(`<a href="[^"]*/">Open ${APP_NAME}</a>`), `${what} has Open ${APP_NAME}`);
      assert.ok(!/Terry|Low Tides/.test(page.text), `${what} names nobody and no band`);
    };
    const terry = new Phone(home.base);
    ok(await terry.createAccount("Terry Bass"), "Terry signs up");
    const bandId = ok(await terry.call("/api/bands/create", { name: "The Low Tides" }), "Terry makes a band").bandId as string;
    const code = ok(await terry.call("/api/codes", { kind: "band", bandId }), "Terry's invite").code as string;
    assert.equal((await land(home.base, code)).status, 302, "the whole link still goes on to the app");

    const mistyped = {
      "a link cut short": code.slice(0, -6),
      "a link with one character copied wrong": code.replace(/.(?=.{3}$)/, (c) => (c === "A" ? "B" : "A")),
    };
    for (const [what, bad] of Object.entries(mistyped)) {
      refusedPage(await land(home.base, bad), what, 404, /This code doesn't work/, WHY.incomplete);
      const scanned = await terry.call("/api/bands/code", { code: bad });
      assert.deepEqual([scanned.status, scanned.body.error], [404, "bad-code"], `${what} is bad-code in the app`);
    }

    const rotated = await startApi({ SESSION_SECRET: "a-rotated-preview-session-secret-0123456789" });
    try {
      const old = new Phone(rotated.base);
      ok(await old.createAccount("Old Key"), "a player on the server before the key changed");
      const oldBand = ok(await old.call("/api/bands/create", { name: "Old Band" }), "a band there").bandId as string;
      const signedBefore = ok(await old.call("/api/codes", { kind: "band", bandId: oldBand }), "an invite signed with the old key").code as string;
      refusedPage(await land(home.base, signedBefore), "a link signed with an older key", 404, /This code doesn't work/, WHY.incomplete);
    } finally {
      await rotated.worker.dispose();
    }

    const elsewhere = await startApi();
    try {
      const lost = new Phone(elsewhere.base);
      ok(await lost.createAccount("Gone Row"), "a player on a server whose codes table is not home's");
      const goneBand = ok(await lost.call("/api/bands/create", { name: "Gone Band" }), "a band there").bandId as string;
      const replaced = ok(await lost.call("/api/codes", { kind: "band", bandId: goneBand }), "an invite home has no row for").code as string;
      refusedPage(await land(home.base, replaced), "a real link whose code is gone", 404, /This code doesn't work/, WHY.replaced);
      const scanned = await terry.call("/api/bands/code", { code: replaced });
      assert.deepEqual([scanned.status, scanned.body.error], [404, "code-replaced"], "and it is code-replaced in the app");
      assert.ok(!js(scanned.body).includes("Gone"), "the refusal carries no band or person");
    } finally {
      await elsewhere.worker.dispose();
    }

    const before = Date.now();
    ok(await terry.call("/api/codes/stop", { code }), "Terry resets the invite");
    const stopped = await land(home.base, code);
    const resetWords = [WHY.reset(before), WHY.reset(Date.now())].find((words) => stopped.text.includes(words)) ?? WHY.reset(before);
    refusedPage(stopped, "a reset link", 410, /This code was stopped/, resetWords);
    assert.equal((await terry.call("/api/bands/code", { code })).body.error, "code-stopped", "and it is code-stopped in the app");

    const short = ok(await terry.call("/api/codes", { kind: "friend-now" }), "Terry's in-person code") as { code: string; expiresAt: number };
    await settle(Math.max(0, short.expiresAt - Date.now()) + 200);
    refusedPage(await land(home.base, short.code), "an ended link", 410, /This code has ended/, WHY.ended(short.expiresAt));
    assert.equal((await terry.call("/api/friends/code", { code: short.code })).body.error, "code-ended", "and it is code-ended in the app");
  } finally {
    await home.worker.dispose();
  }
});

let apiBase = "";
const site = await openSite(root, "check-join-links", () => apiBase).catch((error: Error) => {
  console.log(`FAIL the browser checks could start: ${error.message.split("\n")[0]}`);
  process.exit(1);
});
const origin = site.origin.replace("127.0.0.1", "localhost");
const main = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = main.base;

try {
  const app = await appPage(site);
  await site.send("Page.addScriptToEvaluateOnNewDocument", {
    // __calls is every path the page fetched; __links is each link the server handed back from /api/codes.
    source: `window.__calls = []; window.__links = []; window.__fetch = window.fetch.bind(window); window.fetch = (input, init) => {
      const path = new URL(String(input instanceof Request ? input.url : input), location.href).pathname;
      window.__calls.push(path);
      const reply = window.__fetch(input, init);
      if (path === "/api/codes") reply.then((r) => r.clone().json()).then((body) => body.link && window.__links.push(body.link), () => {});
      return reply;
    };`,
  });

  const waitFor = async (expression: string, what: string, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await settle(100)) if (await site.evaluate<boolean>(expression).catch(() => false)) return;
    throw new Error(`timed out waiting for ${what} at ${await site.evaluate<string>("location.href").catch(() => "?")}`);
  };
  const signInSheet = `document.querySelector(".account-sheet[data-step]")`;
  const atStep = (step: string) => waitFor(`${signInSheet}?.dataset.step === ${js(step)}`, `the ${step} screen`);
  const inPage = (path: string, body?: object) =>
    site.evaluate<Reply>(
      `window.__fetch(${js(path)}, ${body ? `{ method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }` : "{}"}).then(async (r) => ({ status: r.status, body: await r.json() }))`,
    );
  const fresh = async () => {
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
  let loads = 0;
  const openBand = async (bandId: string) => {
    await site.send("Page.navigate", { url: `${origin}/?load=${(loads += 1)}#/band/${bandId}` });
    await waitFor(`!!document.querySelector(${js(`.band-page[data-band="${bandId}"] .band-tabs`)})`, "the band page");
  };
  const bandPage = `document.querySelector(".band-page")`;
  const sheetView = (sheet: string, name: string) => waitFor(`document.querySelector(${js(sheet)})?.dataset.view === ${js(name)}`, `${sheet} ${name}`);
  const paste = async (sheet: string, text: string) => {
    await sheetView(sheet, "scan");
    await site.evaluate(`(() => { const input = [...document.querySelectorAll(${js(`${sheet} label`)})].find((l) => l.textContent.trim() === "Paste a link")?.control; input.value = ""; input.focus(); })()`);
    await site.send("Input.insertText", { text });
    await app.click("Open link", `document.querySelector(${js(sheet)})`);
  };
  const fitsAt = async (width: number, what: string) => {
    const fit = await site.evaluate<{ page: number; right: number }>(`(() => {
      const box = document.querySelector("[role=dialog], .band-page").getBoundingClientRect();
      return { page: document.documentElement.scrollWidth, right: Math.max(box.right, ...[...document.querySelectorAll(".codes-link, .account-input, button")].map((el) => el.getBoundingClientRect().right)) };
    })()`);
    assert.ok(fit.page <= width && fit.right <= width + 0.5, `${what} at ${width} px has no sideways scroll (${js(fit)})`);
  };
  const atWidth = (width: number) => site.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 820 });

  const terry = await passwordPlayer(main.base, origin, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(main.base, origin, "Mike Keys", "mikekeys");
  const lowTides = ok(await terry.call("/api/bands/create", { name: "The Low Tides" }), "Terry makes The Low Tides").bandId as string;
  const songId = ok(await terry.call("/api/bands/library/share-song", { bandId: lowTides, song: chart(0, "Low Tide Opener"), choice: "public", localId: null }), "Terry shares a song").songId as string;
  const setlistId = ok(await terry.call("/api/bands/library/share-setlist", { bandId: lowTides, name: "Harbor set", songIds: [songId], tags: [], choice: "public", localId: null }), "Terry shares the Harbor set")
    .setlistId as string;
  const quartet = ok(await mike.call("/api/bands/create", { name: "Mike's Quartet" }), "Mike makes a band").bandId as string;
  const linkOf = async (who: Phone, request: object) => ok(await who.call("/api/codes", request), `a code for ${js(request)}`) as { code: string; link: string };
  const membersOf = async (who: Phone, bandId: string) => (ok(await who.call("/api/bands/open", { bandId }), "the band").members as { name: string }[]).map((m) => m.name);

  await check("fresh invite link opened signed out in a new browser joins the band", async () => {
    await fresh();
    await site.send("Page.navigate", { url: (await linkOf(terry, { kind: "band", bandId: lowTides })).link });
    await atStep("start");
    await app.click("New here? Create an account", signInSheet);
    await app.type("Your name (what bandmates see)", "Sam Rivera");
    await app.click("Sign in with Face ID or fingerprint", signInSheet);
    await atStep("nudge");
    await app.click("Not now", signInSheet);
    await waitFor(`document.querySelector(".band-page .bands-notice")?.textContent === "You joined The Low Tides."`, "You joined The Low Tides.");
    assert.ok((await membersOf(terry, lowTides)).includes("Sam Rivera"), "Sam is a member on the server");
  });

  await check("a band member who is not admin makes no /api/codes request on the band page", async () => {
    await openBand(lowTides);
    await settle(2000);
    await app.click("Invite", `${bandPage}.querySelector("header")`);
    await waitFor(`[...${bandPage}.querySelectorAll("[role=alert], [role=status]")].some((el) => el.textContent.includes("Only a band admin can do that."))`, "Only a band admin can do that.");
    await app.click("Show as QR", bandPage);
    await waitFor(`${bandPage}.dataset.view === "invite"`, "the invite view");
    await settle(1500);
    assert.ok(!(await site.evaluate<boolean>(`!!document.querySelector(".codes-qr")`)), "a member is shown no QR the server would refuse");
    await app.click("Back", bandPage);
    await settle(500);
    const calls = await site.evaluate<string[]>("window.__calls");
    assert.ok(calls.includes("/api/bands/open"), `the band page did talk to the server (${js(calls)})`);
    assert.deepEqual(calls.filter((path) => path === "/api/codes"), [], `no /api/codes request from a member (${js(calls)})`);
  });

  let trio = "";
  await check("invite page shows the full link text and a Copy link button", async () => {
    trio = ok(await inPage("/api/bands/create", { name: "Sam's Trio" }), "Sam makes a band").bandId as string;
    await openBand(trio);
    await app.click("Show as QR", bandPage);
    await waitFor(`!!document.querySelector(".band-page .codes-link") && !!document.querySelector(".band-page .codes-qr svg")`, "the invite link");
    const link = ok(await inPage("/api/codes", { kind: "band", bandId: trio }), "the server's invite").link as string;
    assert.equal((await app.text(".band-page .codes-link")).trim(), link, "the link text on screen is the server's whole link");
    await site.evaluate(`(() => {
      window.__copied = null; window.__shared = [];
      Object.defineProperty(navigator, "share", { configurable: true, value: (data) => { window.__shared.push(data); return Promise.resolve(); } });
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text) => { window.__copied = text; return Promise.resolve(); } } });
    })()`);
    await app.click("Copy link", bandPage);
    await waitFor(`[...document.querySelectorAll(".band-page button")].some((b) => b.textContent.trim() === "Copied")`, "the Copied state");
    assert.equal(await site.evaluate<string>("window.__copied"), link, "Copy link put the whole link on the clipboard");
    assert.deepEqual(await site.evaluate<unknown[]>("window.__shared"), [], "Copy link copies even where a share sheet exists");
  });

  await check("Copy link puts the server's link on the clipboard on the Invite page and every Share link page", async () => {
    await site.send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
    await site.send("Page.bringToFront");
    /** Copy link on the page in `scope`, after the server's code reply, and what the real clipboard then holds. */
    const copyOn = async (scope: string, what: string) => {
      await waitFor(`!!${scope}?.querySelector(".codes-link") && window.__links.length > 0`, `${what}: the link and the server's reply`);
      const link = await site.evaluate<string>("window.__links.at(-1)");
      assert.equal(await site.evaluate<string>(`${scope}.querySelector(".codes-link").textContent.trim()`), link, `${what}: the whole server link is on screen`);
      await site.send("Page.bringToFront");
      await site.evaluate(`navigator.clipboard.writeText("")`);
      await app.click("Copy link", scope);
      await waitFor(`[...${scope}.querySelectorAll("button")].some((b) => b.textContent.trim() === "Copied")`, `${what}: Copied`);
      assert.equal(await site.evaluate<string>("navigator.clipboard.readText()"), link, `${what}: the clipboard holds the server's link`);
    };
    const fromNoLinks = () => site.evaluate("window.__links = []");

    await openBand(trio);
    await fromNoLinks();
    await app.click("Show as QR", bandPage);
    await copyOn(bandPage, "band Invite");

    await site.evaluate(`location.hash = "#/songs"`);
    await app.openMenu();
    await app.pick("Friends");
    await sheetView(".friends-sheet", "list");
    await fromNoLinks();
    await app.click("Share link", `document.querySelector(".friends-sheet")`);
    await copyOn(`document.querySelector(".friends-sheet")`, "friend Share link");
    await app.click("✕", `document.querySelector(".friends-sheet")`);

    await openBand(lowTides);
    await app.click("Setlists", `document.querySelector(".band-tabs")`);
    const harbor = `document.querySelector(${js(`.band-library-setlists [data-setlist="${setlistId}"]`)})`;
    await waitFor(`!!${harbor}`, "the Harbor set row");
    await fromNoLinks();
    await app.click("Show code", harbor);
    await copyOn(bandPage, "band setlist Show code");

    await site.send("Page.navigate", { url: `${origin}/?load=${(loads += 1)}#/songs` });
    await app.library();
    await site.evaluate(`document.getElementById("tab-setlists").click()`);
    const worship = `document.querySelector("section.setlist[aria-label='Worship Set']")`;
    await waitFor(`!!${worship}`, "the built-in Worship Set");
    await app.click("Show code", worship);
    await waitFor(`!!document.querySelector(".setlist-code-sheet")`, "the setlist code sheet");
    await app.click("Public", `document.querySelector(".setlist-code-sheet")`);
    await fromNoLinks();
    await app.click("Show code", `document.querySelector(".setlist-code-sheet")`);
    await copyOn(`document.querySelector(".setlist-code-sheet")`, "my-setlist Show code");
    await app.click("✕", `document.querySelector(".setlist-code-sheet")`);
  });

  await check("when the clipboard is refused, Copy link selects the link and says to copy it", async () => {
    await openBand(trio);
    await app.click("Show as QR", bandPage);
    await waitFor(`!!document.querySelector(".band-page .codes-link")`, "the invite link");
    const link = (await app.text(".band-page .codes-link")).trim();
    await site.evaluate(`Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError")) } })`);
    await site.evaluate("getSelection().removeAllRanges()");
    await app.click("Copy link", bandPage);
    await waitFor(`[...${bandPage}.querySelectorAll("[role=alert], [role=status], .account-note")].some((el) => el.textContent.trim() === "Select the link above and copy it.")`, "Select the link above and copy it.");
    assert.equal((await site.evaluate<string>("getSelection().toString()")).trim(), link, "the whole link is selected for a hand copy");
    assert.ok(!(await app.texts(".band-page button")).includes("Copied"), "and nothing claims it was copied");
  });

  await check("pasting a band, setlist, gig or friend link, or a bare code, opens the same screen the camera scan opens", async () => {
    const mikesBand = await linkOf(mike, { kind: "band", bandId: quartet });
    const toScan = async () => {
      await app.openBands();
      await sheetView(".bands-sheet", "list");
      await app.click("Scan a code", `document.querySelector(".bands-sheet")`);
    };

    await site.send("Page.navigate", { url: `${origin}/?load=${(loads += 1)}#/songs` });
    await app.library();
    await toScan();
    await paste(".bands-sheet", mikesBand.link);
    await sheetView(".bands-sheet", "code");
    await waitFor(`document.querySelector(".bands-sheet .codes-words")?.textContent === "Mike's Quartet Invited by Mike Keys"`, "the band a pasted link joins");
    assert.ok((await app.texts(".bands-sheet button")).includes("Join"), "a pasted band link asks before joining, as a scan does");
    assert.ok(!(await membersOf(mike, quartet)).includes("Sam Rivera"), "and joins nobody before the tap");

    await app.click("Back", `document.querySelector(".bands-sheet")`);
    await app.click("Scan a code", `document.querySelector(".bands-sheet")`);
    await paste(".bands-sheet", `  ${mikesBand.code}\n`);
    await sheetView(".bands-sheet", "code");
    await waitFor(`document.querySelector(".bands-sheet .codes-words")?.textContent === "Mike's Quartet Invited by Mike Keys"`, "the band a bare code joins");

    await app.click("Back", `document.querySelector(".bands-sheet")`);
    await app.click("Scan a code", `document.querySelector(".bands-sheet")`);
    const notALink = `[...document.querySelectorAll(".bands-sheet [role=alert]")].some((el) => el.textContent.includes(${js(NOT_A_LINK)}))`;
    for (const [what, text] of Object.entries({ "a link cut short": mikesBand.link.slice(0, -5), "plain words": "see you at the gig friday" })) {
      await paste(".bands-sheet", text);
      await waitFor(notALink, `${NOT_A_LINK} for ${what}`);
      assert.equal(await site.evaluate<string>(`document.querySelector(".bands-sheet").dataset.view`), "scan", `${what} stays on Scan a code`);
    }

    await paste(".bands-sheet", (await linkOf(terry, { kind: "band-setlist", bandId: lowTides, setlistId })).link);
    await waitFor(`!!document.querySelector(${js(`.band-library-setlists [data-setlist="${setlistId}"][aria-current="true"]`)})`, "the pasted setlist, open and marked");

    const date = new Date(Date.now() + 7 * DAY_MS).toISOString().slice(0, 10);
    const gigId = ok(await terry.call("/api/bands/gig/plan", { bandId: lowTides, setlistId, name: "Harbor night", date }), "Terry plans a gig with Sam on the lineup").gig.gigId as string;
    await toScan();
    await paste(".bands-sheet", (await linkOf(terry, { kind: "gig", bandId: lowTides, gigId })).link);
    await waitFor(`!!document.querySelector(${js(`.band-page [data-gig="${gigId}"]`)})`, "the pasted gig on the band page");

    await site.evaluate(`location.hash = "#/songs"`);
    await app.openMenu();
    await app.pick("Friends");
    await sheetView(".friends-sheet", "list");
    await app.click("Scan a code", `document.querySelector(".friends-sheet")`);
    await paste(".friends-sheet", (await linkOf(mike, { kind: "friend-link" })).link);
    await sheetView(".friends-sheet", "code");
    await waitFor(`document.querySelector(".friends-sheet .codes-words")?.textContent === "Mike Keys @mikekeys"`, "the friend a pasted link adds");
    assert.ok((await app.texts(".friends-sheet button")).includes("Add friend"), "a pasted friend link shows Add friend, as a scan does");
    assert.deepEqual(ok(await mike.call("/api/friends"), "Mike's friends").friends, [], "and adds nobody before the tap");
    await app.click("✕", `document.querySelector(".friends-sheet")`);
  });

  await check("a refused or offline paste says why in the app and joins nobody", async () => {
    const bandsSheet = `document.querySelector(".bands-sheet")`;
    const alertSays = (words: string) => waitFor(`[...document.querySelectorAll(".bands-sheet [role=alert]")].some((el) => el.textContent.trim() === ${js(words)})`, js(words));
    const toScan = async () => {
      await site.send("Page.navigate", { url: `${origin}/?load=${(loads += 1)}#/songs` });
      await app.library();
      await app.openBands();
      await sheetView(".bands-sheet", "list");
      await app.click("Scan a code", bandsSheet);
    };
    const mikesBand = await linkOf(mike, { kind: "band", bandId: quartet });

    await toScan();
    await paste(".bands-sheet", mikesBand.link.replace(/.(?=.{3}$)/, (c) => (c === "A" ? "B" : "A")));
    await alertSays(WHY.incomplete);

    const elsewhere = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
    try {
      const lost = await passwordPlayer(elsewhere.base, origin, "Gone Row", "gonerow");
      const goneBand = ok(await lost.call("/api/bands/create", { name: "Gone Band" }), "a band there").bandId as string;
      const replaced = await linkOf(lost, { kind: "band", bandId: goneBand });
      await toScan();
      await paste(".bands-sheet", replaced.link);
      await alertSays(WHY.replaced);
      assert.ok(!(await site.evaluate<string>(`${bandsSheet}.textContent`)).includes("Gone"), "the refusal names no band or person");
    } finally {
      await elsewhere.worker.dispose();
    }

    await toScan();
    await site.send("Network.enable");
    await site.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    try {
      await paste(".bands-sheet", mikesBand.link);
      await alertSays(OFFLINE);
    } finally {
      await site.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
    await toScan();
    await paste(".bands-sheet", mikesBand.link);
    await waitFor(`document.querySelector(".bands-sheet .codes-words")?.textContent === "Mike's Quartet Invited by Mike Keys"`, "the band, once back online");
    assert.ok(!(await membersOf(mike, quartet)).includes("Sam Rivera"), "no paste, offline or not, joined Sam");
    await app.click("✕", bandsSheet);
  });

  await check("a band setlist code says up front who can open it and an empty setlist asks for a song first", async () => {
    const membersOnly = "Only members of The Low Tides can open this code.";
    const emptyId = ok(await terry.call("/api/bands/library/share-setlist", { bandId: lowTides, name: "Empty set", songIds: [], tags: [], choice: "public", localId: null }), "Terry shares an empty setlist")
      .setlistId as string;
    const row = (id: string) => `document.querySelector(${js(`.band-library-setlists [data-setlist="${id}"]`)})`;
    await openBand(lowTides);
    await app.click("Setlists", `document.querySelector(".band-tabs")`);
    await waitFor(`!!${row(emptyId)} && !!${row(setlistId)}`, "the Harbor and Empty set rows");
    assert.ok(!(await site.evaluate<string[]>(`[...${row(emptyId)}.querySelectorAll("button")].map((b) => b.textContent.trim())`)).includes("Show code"), "an empty setlist has no Show code");
    assert.match(await site.evaluate<string>(`${row(emptyId)}.textContent`), /Add a song first/, "and says Add a song first");

    const before = (await site.evaluate<string[]>("window.__calls")).length;
    await site.evaluate("window.__links = []");
    await app.click("Show code", row(setlistId));
    await waitFor(`!!document.querySelector(".band-page .codes-qr svg") && window.__links.length > 0`, "the Harbor set code and the server's first reply");
    const upFront = await site.evaluate<{ line: boolean; first: boolean }>(`(() => {
      const line = [...document.querySelectorAll(".band-page p")].find((p) => p.textContent.trim() === ${js(membersOnly)});
      const qr = document.querySelector(".band-page .codes-qr");
      return { line: !!line, first: !!line && !!(line.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING) };
    })()`);
    assert.deepEqual(upFront, { line: true, first: true }, `the code page says ${js(membersOnly)} above the code`);
    await settle(3000);
    const posts = (await site.evaluate<string[]>("window.__calls")).slice(before).filter((path) => path === "/api/codes");
    assert.equal(posts.length, 1, `the never-ending code is asked for once in three seconds, not ${posts.length} times`);

    const quartetSong = ok(await mike.call("/api/bands/library/share-song", { bandId: quartet, song: chart(1, "Quartet tune"), choice: "public", localId: null }), "Mike shares a song").songId as string;
    const quartetSet = ok(await mike.call("/api/bands/library/share-setlist", { bandId: quartet, name: "Quartet set", songIds: [quartetSong], tags: [], choice: "public", localId: null }), "Mike shares a setlist")
      .setlistId as string;
    await site.send("Page.navigate", { url: `${origin}/?load=${(loads += 1)}#/songs` });
    await app.library();
    await app.openBands();
    await sheetView(".bands-sheet", "list");
    await app.click("Scan a code", `document.querySelector(".bands-sheet")`);
    await paste(".bands-sheet", (await linkOf(mike, { kind: "band-setlist", bandId: quartet, setlistId: quartetSet })).link);
    await waitFor(`[...document.querySelectorAll(".bands-sheet [role=alert]")].some((el) => el.textContent.trim() === "This setlist belongs to a band you're not in.")`, "the not-in-band words");
    assert.ok(!(await site.evaluate<string>(`document.querySelector(".bands-sheet").textContent`)).includes("Quartet set"), "the refusal names no setlist");
    await app.click("✕", `document.querySelector(".bands-sheet")`);
  });

  await check("invite page and Scan a code sheets fit at 344, 390, 820, 884 and 1280 px", async () => {
    for (const width of WIDTHS) {
      await atWidth(width);
      await openBand(trio);
      await app.click("Show as QR", bandPage);
      await waitFor(`!!document.querySelector(".band-page .codes-link")`, "the invite link");
      await fitsAt(width, "the invite page");
      await openBand(lowTides);
      await app.click("Setlists", `document.querySelector(".band-tabs")`);
      await waitFor(`!!document.querySelector(${js(`.band-library-setlists [data-setlist="${setlistId}"]`)})`, "the Harbor set row");
      await app.click("Show code", `document.querySelector(${js(`.band-library-setlists [data-setlist="${setlistId}"]`)})`);
      await waitFor(`!!document.querySelector(".band-page .codes-link")`, "the band setlist code");
      await fitsAt(width, "the band setlist code page");
      await app.openBands();
      await sheetView(".bands-sheet", "list");
      await app.click("Scan a code", `document.querySelector(".bands-sheet")`);
      await sheetView(".bands-sheet", "scan");
      await settle(500);
      await fitsAt(width, "Bands Scan a code");
      assert.ok((await app.texts(".bands-sheet label")).includes("Paste a link"), `Paste a link is there at ${width} px`);
    }
    await atWidth(390);
  });

  await check("a never-ending code (band setlist) does not re-request itself", async () => {
    const bundle = await build({
      stdin: {
        contents: `import { createElement } from "react";
          import { createRoot } from "react-dom/client";
          import { ShowCode } from "./src/codes.tsx";
          window.__showCode = (kind, inMs) => {
            window.__codeCalls = 0;
            window.fetch = async (url, init) => {
              if (!String(url).endsWith("/api/codes")) return window.__fetch(url, init);
              window.__codeCalls += 1;
              return new Response(JSON.stringify({ kind, code: "c0de" + window.__codeCalls, link: location.origin + "/c/c0de", expiresAt: Date.now() + inMs }), { status: 200, headers: { "content-type": "application/json" } });
            };
            const box = document.createElement("div");
            document.body.replaceChildren(box);
            createRoot(box).render(createElement(ShowCode, { request: { kind }, words: "Friday set · The Band", share: true, onStopped() {}, onError() {} }));
          };`,
        resolveDir: root,
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      jsx: "automatic",
      loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    });
    const callsFor = async (kind: string, inMs: number, waitMs: number) => {
      const url = `${origin}/?load=${(loads += 1)}#/songs`;
      await site.send("Page.navigate", { url });
      await waitFor(`location.href === ${js(url)} && document.readyState === "complete" && !!window.__fetch`, "a page");
      await site.evaluate(bundle.outputFiles[0].text);
      await site.evaluate(`window.__showCode(${js(kind)}, ${inMs})`);
      await waitFor(`document.body.textContent.includes("Stop this code")`, `the ${kind} code`);
      await settle(waitMs);
      return site.evaluate<number>("window.__codeCalls");
    };
    // The server hands back the same live band setlist code each time, so its end can be anywhere up to ten years out.
    // A browser keeps a timer delay as a 32-bit int, so some of these ends wrap to a timer that fires at once.
    for (const ageDays of [0, 15, 30, 45]) {
      const calls = await callsFor("band-setlist", (10 * 365 - ageDays) * DAY_MS, 2500);
      assert.equal(calls, 1, `a never-ending code made ${ageDays} days ago is asked for once, not ${calls} times`);
    }
    assert.ok((await callsFor("band", 1200, 2500)) >= 2, "while a code that ends on screen is swapped for a fresh one");
  });

  await check("no page errors", async () => assert.deepEqual(await app.errors(), [], "the page logged no errors"));
} finally {
  await site.close();
  await main.worker.dispose();
}

if (failed) {
  console.log(`check:join-links: ${failed} failed`);
  process.exit(1);
}
console.log("check:join-links passed");
