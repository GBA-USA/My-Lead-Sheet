import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SongContent } from "../src/band-library-model.ts";
import { startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/**
 * U4c: the top that folds on a My Songs lead sheet folds on every other scrolling screen with a big top. One case per
 * pass condition, named by it. The cases read what the player sees. "The top" is every header, library tab, control and
 * Live bar shown above the scrolling page; its reach is the lowest bottom edge among them. The top is folded when its
 * reach sits at least 40 px higher than at rest, and open when it is back where it was at rest.
 */

type Box = { l: number; t: number; r: number; b: number; w: number; h: number };
type Size = { name: string; width: number; height: number; top: number; bottom: number; mobile: boolean };

const root = new URL("..", import.meta.url).pathname;
const PHONE: Size = { name: "390", width: 390, height: 844, top: 47, bottom: 34, mobile: true };
const DESK: Size = { name: "1280", width: 1280, height: 800, top: 0, bottom: 0, mobile: false };
const PLAIN_390: Size = { name: "390 plain", width: 390, height: 844, top: 0, bottom: 0, mobile: true };
const SIZES: Size[] = [
  PHONE,
  { name: "Fold 7 folded 344", width: 344, height: 882, top: 0, bottom: 0, mobile: true },
  { name: "Fold unfolded 884", width: 884, height: 1104, top: 0, bottom: 0, mobile: true },
  { name: "tablet 820", width: 820, height: 1180, top: 24, bottom: 20, mobile: true },
  DESK,
];
const TALL = 120;
const FOLD_BY = 40;
const js = (value: unknown) => JSON.stringify(value);
const seed = JSON.parse(readFileSync(`${root}data/library.json`, "utf8")) as { songs: (SongContent & { id: number })[]; setlists: { id: number; name: string; songIds: number[] }[] };
const content = ({ id: _id, ...song }: SongContent & { id: number }): SongContent => song;
const chart = (title: string): SongContent => ({ ...content(seed.songs[0]), title, artist: "Terry Bass" });
const newId = () => crypto.randomUUID().replace(/-/g, "");
const gigId = () => `gig_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;
const dayFromNow = (days: number) => {
  const day = new Date();
  day.setDate(day.getDate() + days);
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

const LOOK = `window.__look = {
  box(el) { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; },
  shown(el) {
    if (!el || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  },
  top() { return [...document.querySelectorAll(".shell-header button, .shell-header .shell-title, .tabs .tab, .controls button, .controls [role=group], .live-nav button, .live-nav .live-count")].filter((el) => __look.shown(el)); },
  reach() { return Math.max(0, ...__look.top().map((el) => el.getBoundingClientRect().bottom)); },
  lowest(scope) {
    for (const el of [scope, ...scope.querySelectorAll("*")]) {
      if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight;
    }
    const clipped = (el, r) => {
      for (let up = el.parentElement; up && up !== scope.parentElement; up = up.parentElement) {
        if (getComputedStyle(up).overflowY === "visible" || up === scope) continue;
        const c = up.getBoundingClientRect();
        if (r.top + r.height / 2 < c.top || r.top + r.height / 2 > c.bottom) return true;
      }
      return false;
    };
    const found = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!node.textContent.trim() || !el || el.closest("[aria-hidden=true]") || getComputedStyle(el).visibility === "hidden") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0 && !clipped(el, r)) found.push({ el, r, what: node.textContent.trim().slice(0, 40) });
    }
    for (const el of scope.querySelectorAll("button, input, textarea, select")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !clipped(el, r)) found.push({ el, r, what: el.tagName + " " + (el.textContent.trim() || el.getAttribute("aria-label") || "").slice(0, 40) });
    }
    const last = found.reduce((a, b) => (b.r.bottom > a.r.bottom ? b : a), found[0]);
    if (!last) return null;
    const hit = document.elementFromPoint(last.r.left + Math.min(last.r.width / 2, 8), last.r.top + last.r.height / 2);
    return { what: last.what, bottom: last.r.bottom, view: innerHeight, covered: !hit || !(hit === last.el || last.el.contains(hit) || hit.contains(last.el)) };
  },
  headings() { return [...document.querySelectorAll("#sheet-scroll :is(h2, h3, .sheet-label, .chart-heading)")].filter((h) => h.getClientRects().length && h.textContent.trim()); },
  heading(h) {
    const range = document.createRange();
    range.selectNodeContents(h);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const r = rects[0];
    const scroller = document.getElementById("sheet-scroll").getBoundingClientRect();
    const hits = [[r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1]].map(([x, y]) => document.elementFromPoint(x, y));
    const under = hits.map((hit) => (hit && (hit === h || h.contains(hit)) ? null : hit?.closest(".shell-header, .tabs, .controls, .live-nav, .song-chrome") ? "the top" : String(hit?.className || hit?.tagName))).filter(Boolean);
    return { what: h.textContent.trim().slice(0, 24), top: r.top, bottom: r.bottom, reach: __look.reach(), inView: r.top >= scroller.top - 0.5 && r.bottom <= scroller.bottom + 0.5, under };
  },
};`;

let apiBase = "";
const site = await openSite(root, "check-ux-collapse-everywhere", () => apiBase, ["--autoplay-policy=no-user-gesture-required"]);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;
try {
  const app = await appPage(site);
  await site.send("Page.addScriptToEvaluateOnNewDocument", { source: LOOK });
  const painted = (count: number) => site.evaluate(`new Promise((done) => { let left = ${count}; const tick = () => (--left > 0 ? requestAnimationFrame(tick) : done(null)); requestAnimationFrame(tick); })`);
  const size = async (at: Size) => {
    await site.send("Emulation.setDeviceMetricsOverride", { width: at.width, height: at.height, deviceScaleFactor: 2, mobile: at.mobile });
    await site.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: at.top, bottom: at.bottom } });
    await painted(6);
  };
  const go = async (hash: string, ready: string, what: string) => {
    await site.evaluate(`location.hash = ${js(hash)}`);
    await app.until(ready, what, 15000);
    await painted(6);
  };
  const appCalls = (path: string, body: object) =>
    site.evaluate<{ status: number; body: Record<string, any> }>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const shown = (selector: string) => site.evaluate<boolean>(`__look.shown(document.querySelector(${js(selector)}))`);
  const reach = () => site.evaluate<number>(`__look.reach()`);
  const scrollBy = (by: number, step: number) =>
    site.evaluate(`(async () => {
      const el = document.getElementById("sheet-scroll");
      for (let moved = 0; moved < Math.abs(${by}); moved += ${step}) {
        el.scrollTop += Math.sign(${by}) * ${step};
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      }
      await new Promise((done) => setTimeout(done, 250));
    })()`);
  const toTop = async () => {
    await site.evaluate(`document.getElementById("sheet-scroll").scrollTop = 0`);
    await settle(250);
    await painted(4);
  };
  const tapBar = async () => {
    await site.evaluate(`document.querySelector(".shell-header .shell-title").click()`);
    await settle(300);
  };
  const lowest = () => site.evaluate<{ what: string; bottom: number; view: number; covered: boolean } | null>(`__look.lowest(document.getElementById("sheet-scroll"))`);
  const KEEP_LIST: Record<string, string> = {
    Back: `document.querySelector(".shell-header [aria-label=Back]")`,
    title: `document.querySelector(".shell-header .shell-title")`,
  };
  const KEEP_SONG: Record<string, string> = {
    ...KEEP_LIST,
    "Key −": `document.querySelector("[aria-label='Transpose down']")`,
    "Key readout": `document.querySelector(".key-readout")`,
    "Key +": `document.querySelector("[aria-label='Transpose up']")`,
  };
  const missing = (keep: Record<string, string>) =>
    site.evaluate<string[]>(`Object.entries({ ${Object.entries(keep).map(([name, el]) => `${js(name)}: ${el}`).join(", ")} }).filter(([, el]) => !__look.shown(el)).map(([name]) => name)`);

  const foldsLikeMySongs = async (what: string, open: () => Promise<void>, keep: Record<string, string>) => {
    await open();
    await toTop();
    const rest = await reach();
    await scrollBy(600, 20);
    const down = await reach();
    assert.ok(down <= rest - FOLD_BY, `${what}: scrolling down folds the top (reach ${Math.round(down)} px, at rest ${Math.round(rest)} px)`);
    assert.deepEqual(await missing(keep), [], `${what}: the folded top keeps its controls`);
    await scrollBy(-80, 10);
    assert.ok((await reach()) >= rest - 1, `${what}: scrolling up 80 px opens the top again (reach ${Math.round(await reach())} px, at rest ${Math.round(rest)} px)`);
    await scrollBy(300, 20);
    assert.ok((await reach()) <= rest - FOLD_BY, `${what}: scrolling down again folds it`);
    await tapBar();
    assert.ok((await reach()) >= rest - 1, `${what}: a tap on the folded bar opens it (reach ${Math.round(await reach())} px, at rest ${Math.round(rest)} px)`);
  };

  const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
  const bandId = (await terry.call("/api/bands/create", { name: "The Low Tides" })).body.bandId as string;
  const code = (await terry.call("/api/codes", { kind: "band", bandId })).body.code as string;
  assert.equal((await mike.call("/api/bands/join", { code })).status, 200, "Mike joins");
  const songIds: string[] = [];
  for (const n of Array.from({ length: 24 }, (_, i) => i + 1)) {
    const shared = await terry.call("/api/bands/library/share-song", { bandId, song: chart(`Tide Song ${n}`), choice: "public", localId: null });
    assert.equal(shared.status, 200, `song ${n} is shared (${js(shared.body)})`);
    songIds.push(shared.body.songId);
  }
  for (const n of Array.from({ length: 24 }, (_, i) => i + 1)) await terry.call("/api/chat/send", { roomId: bandId, msgId: newId(), text: `Note ${n} about the Friday set` });

  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await app.library();
  const extra = seed.setlists.flatMap((set, n) => [0, 1, 2].map((copy) => ({ id: 900 + n * 3 + copy, name: `${set.name} take ${copy + 2}` })));
  await site.evaluate(`(() => { const stored = JSON.parse(localStorage.getItem("leadSheetsLibrary")); const first = stored.setlists[0]; stored.setlists = stored.setlists.filter((set) => set.id < 900).concat(${js(extra)}.map((set) => ({ ...first, ...set }))); localStorage.setItem("leadSheetsLibrary", JSON.stringify(stored)); })()`);
  await site.evaluate(`window.__beforeReload = true; location.reload()`);
  await app.until(`!window.__beforeReload && !!document.querySelector(".shell-header")`, "the reload");
  await app.library();
  await app.signUp("Sam Rivera");
  const sam = await site.evaluate<{ userId: string }>(`fetch("/api/me").then((r) => r.json()).then((reply) => reply.account)`);
  assert.equal((await appCalls("/api/bands/join", { code })).status, 200, "Sam joins The Low Tides");
  const samSong = await appCalls("/api/bands/library/share-song", { bandId, song: chart("Sam Tune"), choice: "public", localId: null });
  assert.equal(samSong.status, 200, `Sam shares a song (${js(samSong.body)})`);
  const friday = await terry.call("/api/bands/library/share-setlist", { bandId, name: "Friday set", songIds: [...songIds, samSong.body.songId], tags: [], choice: "public", localId: null });
  assert.equal(friday.status, 200, "Terry shares the Friday set");
  for (const n of Array.from({ length: 6 }, (_, i) => i + 2)) await terry.call("/api/bands/library/share-setlist", { bandId, name: `Terry set ${n}`, songIds: songIds.slice(0, 3), tags: [], choice: "public", localId: null });
  assert.equal((await terry.call("/api/bands/gig/plan", { bandId, setlistId: friday.body.setlistId, gigId: gigId(), name: "Saturday at the Pier", date: dayFromNow(5), lineup: [terry.userId, sam.userId], leader: terry.userId })).status, 200, "Terry plans a gig");
  for (const n of Array.from({ length: 11 }, (_, i) => i + 1)) assert.equal((await appCalls("/api/bands/create", { name: `Sam Band ${n}` })).status, 200, `Sam makes band ${n}`);

  const page = `document.querySelector(${js(`.band-page[data-band="${bandId}"]`)})`;
  const openBand = async () => {
    await go("#/bands", `!!document.querySelector(".bands-tab")`, "the Bands tab");
    await go(`#/band/${bandId}`, `${page}?.dataset.view === "band" && !${page}.textContent.includes("Loading")`, "the band page");
  };
  const SECTION_READY: Record<string, string> = {
    Members: `${page}.textContent.includes("Mike Keys")`,
    Songs: `${page}.querySelectorAll(".band-library-songs li").length >= 25`,
    Setlists: `${page}.querySelectorAll(".band-library-setlists li").length >= 7`,
    Chat: `${page}.textContent.includes("Note 24 about the Friday set")`,
    Gigs: `${page}.textContent.includes("Saturday at the Pier")`,
  };
  const section = async (name: string) => {
    await openBand();
    await app.click(name, `${page}?.querySelector(".band-tabs")`);
    await app.until(`${page}?.querySelector(".band-tabs [aria-selected=true]")?.firstChild?.textContent.trim() === ${js(name)}`, `the ${name} section`);
    await app.until(SECTION_READY[name], `the ${name} section filled`, 15000);
    await painted(6);
  };
  const openRow = async (list: string, name: string) => {
    const tapped = await site.evaluate<boolean>(`(() => { const row = [...${page}.querySelectorAll(${js(`${list} .band-library-row`)})].find((b) => b.querySelector(".band-library-name")?.textContent.trim() === ${js(name)}); row?.click(); return !!row; })()`);
    assert.ok(tapped, `a ${name} row on the band page`);
  };
  const bandSong = (name: string, songId: string) => async () => {
    await section("Songs");
    await openRow(".band-library-songs", name);
    await app.until(`location.hash === ${js(`#/band/${bandId}/song/${songId}`)} && document.querySelector(".sheet .sheet-name")?.textContent === ${js(name)}`, `${name} from the band page`, 15000);
    await painted(6);
  };
  const terrySong = bandSong("Tide Song 1", songIds[0]);
  const samTune = bandSong("Sam Tune", samSong.body.songId);
  const mySong = () => go("#/song/1", `!!document.querySelector(".sheet .sheet-name") && !!document.querySelector(".controls")`, "My Songs lead sheet");
  const mySetlists = () => go("#/setlists", `document.querySelectorAll(".setlists .setlist").length >= ${seed.setlists.length + extra.length}`, "My setlists");
  const bandSetlist = async () => {
    await section("Setlists");
    await openRow(".band-library-setlists", "Friday set");
    await app.until(`${page}?.dataset.view === "setlist" && ${page}.querySelectorAll(".band-setlist-songs li").length === 25`, "the band setlist view");
    await painted(6);
  };
  const myLive = () => go(`#/live/${seed.setlists[0].id}/0`, `!!document.querySelector(".live-nav") && !!document.querySelector(".sheet .sheet-name")`, "My setlist Live");
  const bandLive = async () => {
    await bandSetlist();
    await app.click("Live", `${page}.querySelector(".band-setlist-view")`);
    await app.until(`location.hash === ${js(`#/live/band/${bandId}/${friday.body.setlistId}/0`)} && document.querySelector(".sheet .sheet-name")?.textContent === "Tide Song 1"`, "the band Live song", 15000);
    await painted(6);
  };

  await check("a band song sheet folds its top on scroll down and unfolds on scroll up or a bar tap, like My songs", async () => {
    for (const at of [PHONE, DESK]) {
      await size(at);
      await foldsLikeMySongs(`a band library song Terry shared, at ${at.name}`, terrySong, KEEP_SONG);
      await foldsLikeMySongs(`a song Sam shared to the band, at ${at.name}`, samTune, KEEP_SONG);
    }
  });

  await check("a setlist screen (My setlists and a band setlist view) folds its top on scroll down and unfolds on scroll up or a bar tap", async () => {
    for (const at of [PHONE, DESK]) {
      await size(at);
      await foldsLikeMySongs(`My setlists at ${at.name}`, mySetlists, KEEP_LIST);
      await foldsLikeMySongs(`the band setlist view at ${at.name}`, bandSetlist, KEEP_LIST);
    }
  });

  await check("Live / setlist mode song pages fold the same way", async () => {
    for (const at of [PHONE, DESK]) {
      await size(at);
      await foldsLikeMySongs(`My setlist Live at ${at.name}`, myLive, KEEP_SONG);
      await foldsLikeMySongs(`band Live at ${at.name}`, bandLive, KEEP_SONG);
    }
  });

  await check("every other route whose top is taller than 120 px at 390 folds; list that route set in the check", async () => {
    const ROUTES: { what: string; open: () => Promise<void>; folds: boolean }[] = [
      { what: "My Songs list", open: () => go("#/songs", `!!document.querySelector(".song-list")`, "My Songs"), folds: false },
      { what: "Bands list", open: () => go("#/bands", `document.querySelectorAll(".bands-tab .song-row").length >= 12`, "the Bands tab"), folds: false },
      ...Object.keys(SECTION_READY).map((name) => ({ what: `band page ${name}`, open: () => section(name), folds: true })),
      { what: "Messages", open: () => go("#/messages", `document.querySelectorAll(".messages .chat-row-preview").length >= 2`, "Messages"), folds: false },
      { what: "band chat room", open: () => go(`#/messages/${bandId}`, `!!document.querySelector(".room") && document.querySelector(".room").textContent.includes("Note 24")`, "the band room"), folds: false },
      { what: "Settings", open: () => go("#/settings", `!!document.querySelector(".settings")`, "Settings"), folds: false },
    ];
    const LONG = new Set(["band page Songs", "band page Setlists", "band page Gigs"]);
    await size(PLAIN_390);
    const wrong: string[] = [];
    for (const route of ROUTES) {
      await route.open();
      await toTop();
      const rest = await reach();
      const top = await site.evaluate<number>(`Math.max(__look.reach(), document.querySelector(".band-page .band-tabs")?.getBoundingClientRect().bottom ?? 0)`);
      if (top > TALL !== route.folds) wrong.push(`${route.what}: its top is ${Math.round(top)} px, so it ${top > TALL ? "should" : "should not"} be in the folding set`);
      const room = await site.evaluate<number>(`(() => { const el = document.getElementById("sheet-scroll"); return el.scrollHeight - el.clientHeight; })()`);
      await scrollBy(600, 20);
      const down = await reach();
      if (route.folds && room < FOLD_BY + 24) {
        if (LONG.has(route.what)) wrong.push(`${route.what}: the page scrolls only ${room} px, too little to show the fold`);
      } else if (route.folds && down > rest - FOLD_BY) wrong.push(`${route.what}: top ${Math.round(top)} px did not fold (reach ${Math.round(down)}, at rest ${Math.round(rest)})`);
      else if (!route.folds && Math.abs(down - rest) > 1) wrong.push(`${route.what}: a small top changed while scrolling (reach ${Math.round(down)}, at rest ${Math.round(rest)})`);
    }
    assert.ok(wrong.length === 0, `the route set folds where its top is taller than 120 px and stays as is elsewhere: ${wrong.join("; ")}`);
  });

  await check("the folded bar keeps the same controls kept on My songs (back, title, key, the four-state dot) and nothing is cut off at the bottom at 390, Fold 7 folded 344, Fold unfolded 884, tablet 820 and 1280", async () => {
    const SCREENS: { what: string; open: () => Promise<void>; song: boolean }[] = [
      { what: "My Songs lead sheet", open: mySong, song: true },
      { what: "band song", open: terrySong, song: true },
      { what: "My setlists", open: mySetlists, song: false },
      { what: "band setlist view", open: bandSetlist, song: false },
      { what: "band page Songs", open: () => section("Songs"), song: false },
    ];
    const wrong: string[] = [];
    for (const at of SIZES) {
      await size(at);
      for (const screen of SCREENS) {
        const where = `${screen.what} at ${at.name}`;
        await screen.open();
        await toTop();
        const rest = await reach();
        if (screen.song) {
          await site.evaluate(`document.querySelector(".sheet .metro-pad").click()`);
          await app.until(`!!document.querySelector(".metro-pad.is-on") && !!document.querySelector(".beat-dot")`, `the metronome on with its beat dot, ${where}`);
        }
        await scrollBy(600, 20);
        if ((await reach()) > rest - FOLD_BY) wrong.push(`${where}: the top did not fold`);
        const gone = await missing(screen.song ? KEEP_SONG : KEEP_LIST);
        if (gone.length) wrong.push(`${where}: the folded bar lost ${gone.join(", ")}`);
        if (screen.song) {
          const dot = await site.evaluate<{ underTop: boolean; box: Box; scroller: Box }>(`(() => {
            const dot = document.querySelector(".beat-dot");
            const r = dot.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return { underTop: !hit || !!hit.closest(".shell-header, .tabs, .controls, .song-chrome"), box: __look.box(dot), scroller: __look.box(document.getElementById("sheet-scroll")) };
          })()`);
          if (dot.underTop || dot.box.r > at.width || dot.box.t < dot.scroller.t - 0.5) wrong.push(`${where}: the four-state dot is not clear of the folded bar (${js(dot)})`);
          await site.evaluate(`document.querySelector(".sheet .metro-pad").click()`);
          await app.until(`!document.querySelector(".metro-pad.is-on")`, "the metronome off");
        }
        const last = await lowest();
        await painted(4);
        if ((await reach()) > rest - FOLD_BY) wrong.push(`${where}: the top is open at the bottom of the page`);
        if (!last || last.bottom > last.view - at.bottom + 0.5 || last.covered) wrong.push(`${where}: the last item is cut off (${js(last)})`);
      }
    }
    assert.ok(wrong.length === 0, `every folded bar keeps its controls and every page bottom is clear: ${wrong.join("; ")}`);
  });

  await check("when folded or sticky, the top never covers a section heading; a heading scrolled to the top sits fully below the bar at 390 and 1280", async () => {
    const SCREENS: { what: string; open: () => Promise<void> }[] = [
      { what: "My Songs lead sheet", open: mySong },
      { what: "band song", open: terrySong },
      { what: "My setlists", open: mySetlists },
      { what: "band setlist view", open: bandSetlist },
      { what: "band page Setlists", open: () => section("Setlists") },
    ];
    type Heading = { what: string; top: number; bottom: number; reach: number; inView: boolean; under: string[] };
    const wrong: string[] = [];
    for (const at of [PHONE, DESK]) {
      await size(at);
      for (const screen of SCREENS) {
        const where = `${screen.what} at ${at.name}`;
        await screen.open();
        await toTop();
        const rest = await reach();
        const count = await site.evaluate<number>(`__look.headings().length`);
        if (count === 0) wrong.push(`${where}: no section heading to look at`);
        for (let moved = 0; moved < 600 && (await reach()) > rest - FOLD_BY; moved += 40) await scrollBy(40, 20);
        if ((await reach()) > rest - FOLD_BY) wrong.push(`${where}: the top did not fold`);
        const lifted = new Set<number>();
        for (let step = 0; step < 4; step += 1) {
          const at = await site.evaluate<number>(`(() => {
            const edge = Math.max(__look.reach(), document.getElementById("sheet-scroll").getBoundingClientRect().top);
            const at = __look.headings().findIndex((h) => h.getBoundingClientRect().top > edge + 1);
            if (at >= 0) document.getElementById("sheet-scroll").scrollTop += __look.headings()[at].getBoundingClientRect().top - edge;
            return at;
          })()`);
          if (at < 0) break;
          await settle(200);
          await painted(4);
          const seen = await site.evaluate<Heading>(`__look.heading(__look.headings()[${at}])`);
          if (!seen.inView || lifted.has(at)) break;
          lifted.add(at);
          if (seen.under.length || seen.top < seen.reach - 0.5) wrong.push(`${where}, folded: "${seen.what}" sits under the bar (${js(seen)})`);
        }
        if (count > 0 && lifted.size === 0) wrong.push(`${where}: no heading could be scrolled to the top`);
        await scrollBy(-80, 10);
        if ((await reach()) < rest - 1) wrong.push(`${where}: scrolling up did not open the top`);
        const open = await site.evaluate<Heading[]>(`__look.headings().map((h) => __look.heading(h)).filter((seen) => seen.inView)`);
        for (const seen of open) if (seen.under.length || seen.top < seen.reach - 0.5) wrong.push(`${where}, opened mid-page: "${seen.what}" sits under the bar (${js(seen)})`);
        await site.evaluate(`__look.headings()[Math.min(${count} - 1, 2)].scrollIntoView({ block: "start" })`);
        await settle(300);
        await painted(4);
        const jumped = await site.evaluate<Heading>(`__look.heading(__look.headings()[Math.min(${count} - 1, 2)])`);
        if (jumped.under.length || jumped.top < jumped.reach - 0.5) wrong.push(`${where}, scrolled into view: "${jumped.what}" sits under the bar (${js(jumped)})`);
      }
    }
    assert.ok(wrong.length === 0, `no section heading is ever under the top: ${wrong.join("; ")}`);
  });

  await check("My songs lead sheets fold exactly as before", async () => {
    for (const at of [PHONE, DESK]) {
      await size(at);
      await mySong();
      await toTop();
      const rest = await reach();
      assert.ok(await shown(".tabs"), `the song opens with the library tabs at ${at.name}`);
      await scrollBy(20, 20);
      assert.ok(Math.abs((await reach()) - rest) <= 1, `20 px of scroll leaves it open at ${at.name}`);
      await scrollBy(600, 20);
      const down = await reach();
      assert.ok(!(await shown(".tabs")), `scrolling down hides the library tabs at ${at.name}`);
      assert.ok(down <= at.top + 116 + 0.5, `the folded bar ends ${Math.round(down)} px down, within the safe area plus 116 px at ${at.name}`);
      assert.deepEqual(await missing({ ...KEEP_SONG, Scroll: `[...document.querySelectorAll(".controls button")].find((b) => /^Scroll: (On|Off)$/.test(b.textContent.trim()))`, Metronome: `[...document.querySelectorAll(".controls button")].find((b) => b.textContent.trim() === "Metronome")` }), [], `the folded bar keeps every playing control at ${at.name}`);
      await scrollBy(-10, 10);
      assert.ok(!(await shown(".tabs")), `10 px back up keeps it folded at ${at.name}`);
      await scrollBy(-20, 10);
      assert.ok(await shown(".tabs"), `30 px back up opens it at ${at.name}`);
      assert.ok(Math.abs((await reach()) - rest) <= 1, `opened, it reaches where it did at rest at ${at.name}`);
      await scrollBy(300, 20);
      assert.ok(!(await shown(".tabs")), `scrolling down folds it again at ${at.name}`);
      await tapBar();
      assert.ok(await shown(".tabs") && (await shown("[aria-label='Scroll settings']")), `a tap on the folded bar opens it at ${at.name}`);
    }
  });

  assert.deepEqual(await app.errors(), [], "no page errors");
} finally {
  await site.close();
  await worker.dispose();
}
if (failed) {
  console.log(`check:ux-collapse-everywhere: ${failed} failed`);
  process.exit(1);
}
console.log("check:ux-collapse-everywhere passed");
