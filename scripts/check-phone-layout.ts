import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SongContent } from "../src/band-library-model.ts";
import { startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/**
 * P8, the phone layout gaps from the box walk at 390x844: the band setlist row, the New band sheet over an iPhone
 * keyboard, the last chart line under the Prev/Scroll/Next bar, and tap targets under 44px. One case per pass condition.
 *
 * The page is a phone (390x844, scale 2, mobile, touch, an iPhone UA) with an iPhone's safe-area insets. iOS Safari
 * keeps the layout viewport and shrinks only the visual one when the keyboard opens, which headless Chrome cannot do,
 * so `window.visualViewport` is a stand-in whose height drops by `__keyboard` px and which fires `resize` like Safari's.
 * `PHONE_LAYOUT_SHOTS=<dir>` writes the FRAME shots at 344, 390, 820, 884 and 1280 px.
 */

type Box = { l: number; t: number; r: number; b: number; w: number; h: number };

const root = fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/");
const INSET = { top: 47, bottom: 34 };
const KEYBOARD = 336;
const FRAME = [344, 390, 820, 884, 1280];
const SHOTS = process.env.PHONE_LAYOUT_SHOTS;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const js = (value: unknown) => JSON.stringify(value);
const seed = JSON.parse(readFileSync(`${root}data/library.json`, "utf8")) as { songs: (SongContent & { id: number })[] };
const content = ({ id: _id, ...song }: SongContent & { id: number }): SongContent => song;
const gigId = () => `gig_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;
const tomorrow = () => {
  const day = new Date(Date.now() + 86_400_000);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
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

const LOOK = `(() => {
  const fake = new EventTarget();
  window.__keyboard = 0;
  Object.defineProperties(fake, {
    width: { get: () => innerWidth },
    height: { get: () => innerHeight - __keyboard },
    offsetTop: { get: () => 0 },
    offsetLeft: { get: () => 0 },
    pageTop: { get: () => scrollY },
    pageLeft: { get: () => scrollX },
    scale: { get: () => 1 },
  });
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
  window.__look = {
    box(el) { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; },
    tappable(el) {
      if (!el || !el.getClientRects().length) return false;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.width >= 1 && r.height >= 1 && r.left >= -0.5 && r.right <= innerWidth + 0.5 && !!hit && (hit === el || el.contains(hit));
    },
    lines(el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
    },
    keyboard(px) { __keyboard = px; fake.dispatchEvent(new Event("resize")); },
    lastLine(scope) {
      let last = null;
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim() || node.parentElement.closest("[aria-hidden=true]")) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) if (r.width > 0 && (!last || r.bottom > last.bottom)) last = { bottom: r.bottom, what: node.textContent.trim().slice(0, 40) };
      }
      return last;
    },
  };
})();`;

let apiBase = "";
const site = await openSite(root, "check-phone-layout", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;
try {
  const app = await appPage(site);
  await site.send("Page.addScriptToEvaluateOnNewDocument", { source: LOOK });
  await site.send("Emulation.setUserAgentOverride", { userAgent: UA, platform: "iPhone" });
  await site.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  const painted = (count = 6) => site.evaluate(`new Promise((done) => { let left = ${count}; const tick = () => (--left > 0 ? requestAnimationFrame(tick) : done(null)); requestAnimationFrame(tick); })`);
  const phone = async (width = 390, height = 844) => {
    await site.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: width < 600 });
    await site.send("Emulation.setSafeAreaInsetsOverride", { insets: width < 600 ? INSET : { top: 0, bottom: 0 } });
    await painted();
  };
  const shoot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await app.shot(`${SHOTS}/${name}.png`);
  };
  const go = async (hash: string, ready: string, what: string) => {
    await site.evaluate(`location.hash = ${js(hash)}`);
    try {
      await app.until(ready, what, 15000);
    } catch (error) {
      await shoot(`timeout-${what.replace(/W+/g, "-")}`);
      throw error;
    }
    await painted();
  };
  const appCalls = (path: string, body: object) =>
    site.evaluate<{ status: number; body: Record<string, any> }>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const box = (expression: string) => site.evaluate<Box | null>(`(() => { const el = ${expression}; return el && el.getClientRects().length ? __look.box(el) : null; })()`);
  const button = (text: string, scope = "document") => `[...(${scope}).querySelectorAll("button")].find((b) => b.textContent.trim() === ${js(text)})`;

  await phone();
  await site.send("Page.navigate", { url: `${origin}/#/bands` });
  await app.library();

  await check("signed out, the Bands tab shows Sign in at least 44px tall, not a New band sheet", async () => {
    await go("#/bands", `!!${button("Sign in")}`, "the Bands tab Sign in");
    const signIn = await box(button("Sign in"));
    assert.ok(signIn && signIn.h >= 44, `Sign in is ${js(signIn)}`);
    assert.equal(await site.evaluate<boolean>(`!!document.querySelector(".bands-sheet")`), false, "no band sheet opens on its own");
  });

  await app.signUp("Sam Rivera");
  const sam = await site.evaluate<{ userId: string }>(`fetch("/api/me").then((r) => r.json()).then((reply) => reply.account)`);

  const newBandSheet = async () => {
    await go("#/bands", `!!${button("+ New band")}`, "+ New band");
    await site.evaluate(`${button("+ New band")}.click()`);
    await app.until(`!!document.querySelector(".bands-sheet input[placeholder='Band name']")`, "the New band sheet");
    await painted();
  };
  const closeSheet = async () => {
    await site.evaluate(`__look.keyboard(0); document.activeElement?.blur(); document.querySelector(".bands-sheet .account-close")?.click()`);
    await app.until(`!document.querySelector(".bands-sheet")`, "the New band sheet to close");
    await painted();
  };
  const aboveKeyboard = async (where: string) => {
    await site.evaluate(`document.querySelector(".bands-sheet input[placeholder='Band name']").focus(); __look.keyboard(${KEYBOARD})`);
    await painted();
    const seen = await site.evaluate<{ view: { top: number; bottom: number }; field: Box; create: Box }>(`(() => ({
      view: { top: visualViewport.offsetTop, bottom: visualViewport.offsetTop + visualViewport.height },
      field: __look.box(document.querySelector(".bands-sheet input[placeholder='Band name']")),
      create: __look.box(${button("Create band", `document.querySelector(".bands-sheet")`)}),
    }))()`);
    await shoot(`new-band-keyboard-${where}`);
    for (const [name, b] of [["Band name", seen.field], ["Create band", seen.create]] as const) {
      assert.ok(b.t >= seen.view.top - 0.5 && b.b <= seen.view.bottom + 0.5, `${where}: ${name} at y=${Math.round(b.t)}-${Math.round(b.b)} is outside the visual viewport ${Math.round(seen.view.top)}-${Math.round(seen.view.bottom)}`);
    }
  };

  await check("2a. with no bands yet and visualViewport.height shrunk by 336px, Band name and Create band on the New band sheet are fully inside the visual viewport", async () => {
    await phone();
    await newBandSheet();
    try {
      await aboveKeyboard("empty");
    } finally {
      await closeSheet();
    }
  });

  const made = await appCalls("/api/bands/create", { name: "The Low Tides" });
  assert.equal(made.status, 200, `Sam makes a band (${js(made.body)})`);
  const bandId = made.body.bandId as string;
  const songIds: string[] = [];
  for (const song of [seed.songs[1], seed.songs[0]]) {
    const shared = await appCalls("/api/bands/library/share-song", { bandId, song: content(song), choice: "public", localId: null });
    assert.equal(shared.status, 200, `${song.title} is shared (${js(shared.body)})`);
    songIds.push(shared.body.songId);
  }
  const SET_NAME = "Friday night at the Pier";
  const set = await appCalls("/api/bands/library/share-setlist", { bandId, name: SET_NAME, songIds, tags: [], choice: "public", localId: null });
  assert.equal(set.status, 200, `the setlist is shared (${js(set.body)})`);
  const setlistId = set.body.setlistId as string;
  const gig = gigId();
  const planned = await appCalls("/api/bands/gig/plan", { bandId, setlistId, gigId: gig, name: "Saturday at the Pier", date: tomorrow(), lineup: [sam.userId], leader: sam.userId });
  assert.equal(planned.status, 200, `Sam plans a gig (${js(planned.body)})`);

  await check("2b. with a band listed and visualViewport.height shrunk by 336px, Band name and Create band on the New band sheet are fully inside the visual viewport", async () => {
    await phone();
    await newBandSheet();
    try {
      await app.until(`document.querySelector(".bands-sheet").textContent.includes("The Low Tides")`, "the band in the sheet's list");
      await aboveKeyboard("one-band");
    } finally {
      await closeSheet();
    }
  });

  const page = `document.querySelector(${js(`.band-page[data-band="${bandId}"]`)})`;
  const ROW = `${page}.querySelector(${js(`.band-library-setlists li[data-setlist="${setlistId}"]`)})`;
  const openSetlists = async () => {
    await go(`#/band/${bandId}?s=setlists`, `!!${page} && !!${ROW}`, "the band's Setlists");
  };

  await check("1. a band setlist row at 390x844 keeps the name button at least 180px wide; the title does not wrap one letter per line; Show code, Plan a gig and Edit stay tappable", async () => {
    await phone();
    await openSetlists();
    await site.evaluate(`${ROW}.scrollIntoView({ block: "center" })`);
    await painted();
    const row = await site.evaluate<{ name: Box; lines: number; actions: Record<string, boolean> }>(`(() => {
      const li = ${ROW};
      const actions = {};
      for (const text of ["Show code", "Plan a gig", "Edit"]) actions[text] = __look.tappable([...li.querySelectorAll("button")].find((b) => b.textContent.trim() === text));
      return { name: __look.box(li.querySelector(".band-library-row")), lines: __look.lines(li.querySelector(".band-library-name")), actions };
    })()`);
    await shoot("setlist-row-390");
    assert.ok(row.name.w >= 180, `the name button is ${Math.round(row.name.w)}px wide`);
    assert.equal(row.lines, 1, `"${SET_NAME}" takes ${row.lines} lines`);
    assert.deepEqual(row.actions, { "Show code": true, "Plan a gig": true, Edit: true }, "each action is on screen and takes a tap");
  });

  await check("1b. song rows on the band Songs tab keep their actions beside the title", async () => {
    await phone();
    await go(`#/band/${bandId}?s=songs`, `${page}?.querySelectorAll(".band-library-songs li").length >= 2`, "the band's Songs");
    const rows = await site.evaluate<{ name: Box; actions: Box | null }[]>(`[...${page}.querySelectorAll(".band-library-songs li")].map((li) => {
      const actions = li.querySelector(".friends-actions");
      return { name: __look.box(li.querySelector(".band-library-row")), actions: actions && actions.getClientRects().length && actions.getBoundingClientRect().width > 0 ? __look.box(actions) : null };
    })`);
    for (const row of rows) if (row.actions) assert.ok(row.actions.t < row.name.b, `a song row's actions sit beside its title (${js(row)})`);
  });

  const scrollToEnd = async () => {
    await site.evaluate(`(async () => {
      const el = document.getElementById("sheet-scroll");
      for (let i = 0; i < 4; i += 1) { el.scrollTop = el.scrollHeight; await new Promise((done) => setTimeout(done, 150)); }
    })()`);
    await painted();
  };
  const clearsBar = async (where: string) => {
    await scrollToEnd();
    const seen = await site.evaluate<{ last: { bottom: number; what: string }; howTo: Box | null; bar: Box; padding: number; inset: number }>(`(() => {
      const sheet = document.querySelector("#sheet-scroll .sheet");
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom)";
      document.body.append(probe);
      const inset = parseFloat(getComputedStyle(probe).paddingBottom);
      probe.remove();
      const how = [...sheet.querySelectorAll(".sheet-label")].find((h) => /how to play/i.test(h.textContent))?.parentElement;
      return { last: __look.lastLine(sheet), howTo: how ? __look.box(how) : null, bar: __look.box(document.querySelector(".live-nav")), padding: parseFloat(getComputedStyle(sheet).paddingBottom), inset };
    })()`);
    await shoot(`sheet-end-${where}`);
    assert.ok(seen.howTo, `${where}: the sheet has How to play`);
    assert.ok(seen.last.bottom <= seen.bar.t + 0.5, `${where}: the last line "${seen.last.what}" ends at ${Math.round(seen.last.bottom)}, under the bar at ${Math.round(seen.bar.t)}`);
    assert.ok(seen.howTo.b <= seen.bar.t + 0.5, `${where}: How to play ends at ${Math.round(seen.howTo.b)}, under the bar at ${Math.round(seen.bar.t)}`);
    assert.ok(seen.padding >= seen.bar.h + seen.inset - 0.5, `${where}: the sheet's padding-bottom ${seen.padding}px is less than the bar ${seen.bar.h}px plus the safe area ${seen.inset}px`);
  };
  const SHEET_READY = `!!document.querySelector("#sheet-scroll .sheet .sheet-name") && document.querySelector(".sheet-name").textContent.includes("Fire Away") && !!document.querySelector(".live-nav")`;

  await check("3a. on a gig sheet, the last line of Fire Away, How to play included, scrolls fully above the Prev/Scroll/Next bar, and the padding covers the bar plus the safe area", async () => {
    await phone();
    await go(`#/gig/${bandId}/${gig}/1`, SHEET_READY, "Fire Away on the gig sheet");
    await clearsBar("gig");
  });

  await check("3b. on a band setlist sheet, the last line of Fire Away, How to play included, scrolls fully above the Prev/Scroll/Next bar", async () => {
    await phone();
    await go(`#/live/band/${bandId}/${setlistId}/1`, SHEET_READY, "Fire Away on the band setlist sheet");
    await clearsBar("band-live");
  });

  await check("4. at 390x844, Back and Settings are at least 44px by 44px, the My Songs / Setlists / Bands tabs and + New band are at least 44px tall, and + Add a song is at least 44px tall", async () => {
    await phone();
    const small: string[] = [];
    const atLeast = (name: string, b: Box | null, w: number, h: number) => {
      if (!b || b.w < w - 0.5 || b.h < h - 0.5) small.push(`${name} ${b ? `${Math.round(b.w)}x${Math.round(b.h)}` : "missing"}`);
    };
    await go("#/songs", `!!document.querySelector(".song-list-add")`, "My Songs with + Add a song");
    atLeast("Settings", await box(`document.querySelector(".shell-header [aria-label=Settings]")`), 44, 44);
    for (const tab of ["My Songs", "Setlists", "Bands"]) atLeast(`tab ${tab}`, await box(`[...document.querySelectorAll(".tabs .tab")].find((t) => t.textContent.trim() === ${js(tab)})`), 0, 44);
    atLeast("+ Add a song", await box(`document.querySelector(".song-list-add")`), 0, 44);
    await go("#/bands", `!!${button("+ New band")}`, "+ New band");
    atLeast("+ New band", await box(button("+ New band")), 0, 44);
    await shoot("bands-390");
    await go(`#/band/${bandId}`, `!!${page} && !!document.querySelector(".shell-header [aria-label=Back]")`, "the band page");
    atLeast("Back on the band page", await box(`document.querySelector(".shell-header [aria-label=Back]")`), 44, 44);
    await go("#/settings", `!!document.querySelector(".settings") && !!document.querySelector(".shell-header [aria-label=Back]")`, "Settings");
    atLeast("Back on Settings", await box(`document.querySelector(".shell-header [aria-label=Back]")`), 44, 44);
    assert.deepEqual(small, [], "every one is at least 44px");
  });

  await check("FRAME: the setlist row, the Bands tab and the gig sheet fit at 344, 390, 820, 884 and 1280 px with no sideways scroll", async () => {
    const wide: string[] = [];
    const across = async (where: string) => {
      const page = await site.evaluate<number>("document.documentElement.scrollWidth");
      if (page > (await site.evaluate<number>("innerWidth")) + 0.5) wide.push(`${where} ${page}`);
      await shoot(where);
    };
    for (const width of FRAME) {
      await phone(width, width < 600 ? 844 : 1000);
      await openSetlists();
      const row = await site.evaluate<{ w: number; lines: number }>(`(() => { const li = ${ROW}; return { w: li.querySelector(".band-library-row").getBoundingClientRect().width, lines: __look.lines(li.querySelector(".band-library-name")) }; })()`);
      if (row.w < 180 || row.lines !== 1) wide.push(`setlist row at ${width}: ${js(row)}`);
      await across(`frame-setlists-${width}`);
      await go("#/bands", `!!${button("+ New band")}`, "+ New band");
      await across(`frame-bands-${width}`);
      await go(`#/gig/${bandId}/${gig}/1`, SHEET_READY, "Fire Away on the gig sheet");
      await scrollToEnd();
      await across(`frame-gig-end-${width}`);
    }
    assert.deepEqual(wide, [], "nothing runs off the side");
  });

  assert.deepEqual(await app.errors(), [], "no page errors");
} catch (error) {
  failed += 1;
  console.log(`FAIL setup: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await site.close();
  await worker.dispose();
}
if (failed) {
  console.log(`check:phone-layout: ${failed} failed`);
  process.exit(1);
}
console.log("check:phone-layout passed");
