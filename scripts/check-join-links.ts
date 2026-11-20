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
 * P1 persona-join-links: a remote bandmate on a desktop browser can always get into the band. One case per pass
 * condition, named by it. The landing-page case needs only the Worker; the rest drive the app in headless Chrome
 * (`CHROME` names the browser). Paths come from fileURLToPath and path.join so the script runs on Windows and Linux.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const js = JSON.stringify;
const DAY_MS = 24 * 60 * 60 * 1000;
const WIDTHS = [344, 390, 820, 884, 1280];

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

await check("bad-code landing page says to check the whole link and has Open the app", async () => {
  const { worker, base } = await startApi();
  try {
    const terry = new Phone(base);
    ok(await terry.createAccount("Terry Bass"), "Terry signs up");
    const bandId = ok(await terry.call("/api/bands/create", { name: "The Low Tides" }), "Terry makes a band").bandId as string;
    const code = ok(await terry.call("/api/codes", { kind: "band", bandId }), "Terry's invite").code as string;
    const land = async (payload: string) => {
      const reply = await fetch(new URL(`/c/${payload}`, base), { redirect: "manual" });
      return { status: reply.status, type: reply.headers.get("content-type") ?? "", text: await reply.text() };
    };
    assert.equal((await land(code)).status, 302, "the whole link still goes on to the app");
    const mistyped = {
      "a link cut short": code.slice(0, -6),
      "a link with one character copied wrong": code.replace(/.(?=.{3}$)/, (c) => (c === "A" ? "B" : "A")),
    };
    for (const [what, bad] of Object.entries(mistyped)) {
      const page = await land(bad);
      assert.equal(page.status, 404, `${what} is still a 404`);
      assert.match(page.type, /^text\/html/, `${what} gets a page`);
      assert.match(page.text, /This code doesn't work/, `${what} says the code doesn't work`);
      assert.match(page.text, /whole link/i, `${what} says to check the whole link was copied (${page.text})`);
      assert.match(page.text, /fresh one/i, `${what} says to ask for a fresh one`);
      assert.match(page.text, new RegExp(`<a href="[^"]*/">Open ${APP_NAME}</a>`), `${what} has Open ${APP_NAME}`);
      assert.ok(!/Terry|Low Tides/.test(page.text), `${what} names nobody`);
    }
    ok(await terry.call("/api/codes/stop", { code }), "Terry stops the code");
    const stopped = await land(code);
    assert.deepEqual([stopped.status, /This code was stopped/.test(stopped.text)], [410, true], "a stopped code keeps its 410 and its words");
  } finally {
    await worker.dispose();
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
    source: `window.__calls = []; window.__fetch = window.fetch.bind(window); window.fetch = (input, init) => { window.__calls.push(new URL(String(input instanceof Request ? input.url : input), location.href).pathname); return window.__fetch(input, init); };`,
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
    await waitFor(`[...${bandPage}.querySelectorAll("[role=alert], [role=status]")].some((el) => /admin/i.test(el.textContent))`, "words saying an admin invites");
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

  await check("pasting a band, setlist or friend link (or a bare code) opens the same screen the camera scan opens", async () => {
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
    await paste(".bands-sheet", mikesBand.link.slice(0, -5));
    await waitFor(`!!document.querySelector(".bands-sheet [role=alert]")`, "words for a link cut short");
    assert.equal(await site.evaluate<string>(`document.querySelector(".bands-sheet").dataset.view`), "scan", "a link cut short stays on Scan a code");

    await paste(".bands-sheet", (await linkOf(terry, { kind: "band-setlist", bandId: lowTides, setlistId })).link);
    await waitFor(`!!document.querySelector(${js(`.band-library-setlists [data-setlist="${setlistId}"][aria-current="true"]`)})`, "the pasted setlist, open and marked");

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

  await check("invite page and Scan a code sheets fit at 344, 390, 820, 884 and 1280 px", async () => {
    for (const width of WIDTHS) {
      await atWidth(width);
      await openBand(trio);
      await app.click("Show as QR", bandPage);
      await waitFor(`!!document.querySelector(".band-page .codes-link")`, "the invite link");
      await fitsAt(width, "the invite page");
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
