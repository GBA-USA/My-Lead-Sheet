import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SongContent } from "../src/band-library-model.ts";
import { startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle } from "./app-page.ts";
import { chordAnchors, type Row } from "./chord-anchors.ts";
import { openSite } from "./chrome.ts";

/**
 * Phone layout follow-up after U4: the library tabs, the bottom of each page, the band filter pill, and the song chrome
 * that folds while a song scrolls. One case per pass condition, named by it. Every layout case runs at the four phone
 * widths with a phone's safe-area insets (Chrome's `Emulation.setSafeAreaInsetsOverride`), so `env(safe-area-inset-*)`
 * is what a real phone reports, not 0.
 *
 * The cases read what the player sees: an element counts as shown when it has a box inside the screen and a tap at its
 * centre lands on it. The song chrome is the header (`.shell-header`), the library tabs (`.tabs`) and the controls
 * (`.controls`). The chrome is folded when the library tabs are not shown on a song.
 */

type Box = { l: number; t: number; r: number; b: number; w: number; h: number };
type Frame = { y: number; top: number; st: number; sh: number; folded: boolean };

const root = new URL("..", import.meta.url).pathname;
const WIDTHS = [360, 390, 412, 430];
const HEIGHTS: Record<number, number> = { 360: 780, 390: 844, 412: 915, 430: 932 };
const INSET = { top: 47, bottom: 34 };
const js = (value: unknown) => JSON.stringify(value);
const seed = JSON.parse(readFileSync(`${root}data/library.json`, "utf8")) as { songs: (SongContent & { id: number })[]; setlists: { id: number; songIds: number[] }[] };
const TIMED = 1;
const PACED = 5;
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
  inset() {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom);padding-top:env(safe-area-inset-top)";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const out = { top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom) };
    probe.remove();
    return out;
  },
  chrome() { return [...document.querySelectorAll(".shell-header button, .shell-header .shell-title, .tabs .tab, .controls button, .controls [role=group]")].filter((el) => __look.shown(el)); },
  rows(els) { return new Set(els.map((el) => { const r = el.getBoundingClientRect(); return Math.round((r.top + r.height / 2) / 6); })).size; },
  chromeBottom() { return Math.max(0, ...__look.chrome().map((el) => el.getBoundingClientRect().bottom)); },
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
};`;

let apiBase = "";
const site = await openSite(root, "check-ux-layout-fix", () => apiBase, ["--autoplay-policy=no-user-gesture-required"]);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;
try {
  const app = await appPage(site);
  await site.send("Page.addScriptToEvaluateOnNewDocument", { source: LOOK });
  const painted = (count: number) => site.evaluate(`new Promise((done) => { let left = ${count}; const tick = () => (--left > 0 ? requestAnimationFrame(tick) : done(null)); requestAnimationFrame(tick); })`);
  const phone = async (width: number) => {
    await site.send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHTS[width], deviceScaleFactor: 2, mobile: true });
    await site.send("Emulation.setSafeAreaInsetsOverride", { insets: INSET });
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
  const folded = async () => !(await shown(".tabs"));
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
    await painted(6);
  };
  const tabRow = () =>
    site.evaluate<{ count: number; tops: number[]; listHeight: number; tabHeight: number; listBottom: number; nextTop: number | null; covered: string[] }>(`(() => {
      const list = document.querySelector(".tabs");
      const tabs = [...list.querySelectorAll(".tab")];
      const lb = list.getBoundingClientRect();
      let next = list.nextElementSibling;
      while (next && !next.getClientRects().length) next = next.nextElementSibling;
      return {
        count: tabs.length,
        tops: tabs.map((tab) => tab.getBoundingClientRect().top),
        listHeight: lb.height,
        tabHeight: Math.max(...tabs.map((tab) => tab.getBoundingClientRect().height)),
        listBottom: lb.bottom,
        nextTop: next ? next.getBoundingClientRect().top : null,
        covered: tabs.filter((tab) => !__look.shown(tab)).map((tab) => tab.textContent),
      };
    })()`);
  const oneRow = (row: Awaited<ReturnType<typeof tabRow>>) =>
    row.count === 3 && Math.max(...row.tops) - Math.min(...row.tops) <= 2 && row.listHeight < row.tabHeight * 2 && (row.nextTop === null || row.listBottom <= row.nextTop + 0.5) && row.covered.length === 0;
  const lowest = () => site.evaluate<{ what: string; bottom: number; view: number; covered: boolean } | null>(`__look.lowest(document.getElementById("sheet-scroll"))`);
  const clear = (last: Awaited<ReturnType<typeof lowest>>) => !!last && last.bottom <= last.view - INSET.bottom + 0.5 && !last.covered;
  const chromeInfo = () =>
    site.evaluate<{ rows: number; bottom: number; texts: string[] }>(`(() => { const els = __look.chrome(); return { rows: __look.rows(els), bottom: __look.chromeBottom(), texts: els.map((el) => el.textContent.trim() || el.getAttribute("aria-label")) }; })()`);
  const sheetRows = () =>
    site.evaluate<Row[]>(`[...document.querySelectorAll(".chart .pair")].filter((pair) => pair.querySelector(".chords")?.firstChild && pair.querySelector(".lyrics")?.firstChild).map((pair) => {
      const chords = pair.querySelector(".chords");
      const lyrics = pair.querySelector(".lyrics");
      const range = (node, from, to) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return r.getBoundingClientRect(); };
      const text = chords.textContent;
      const lyric = lyrics.textContent;
      const left = lyrics.getBoundingClientRect().left;
      const advance = range(lyrics.firstChild, 0, lyric.length).width / lyric.length;
      return { chords: text, lyrics: lyric, at: [...text.matchAll(/\\S+/g)].map((chord) => Math.round((range(chords.firstChild, chord.index, chord.index + 1).left - left) / advance)) };
    })`);
  const openSong = (hash: string) => go(hash, `!!document.querySelector(".sheet .sheet-name") && !!document.querySelector(".controls")`, `the song at ${hash}`);
  const foldSong = async () => {
    await toTop();
    await scrollBy(600, 20);
    return folded();
  };

  const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
  const bandId = (await terry.call("/api/bands/create", { name: "The Low Tides" })).body.bandId as string;
  const code = (await terry.call("/api/codes", { kind: "band", bandId })).body.code as string;
  assert.equal((await mike.call("/api/bands/join", { code })).status, 200, "Mike joins");
  const songIds: string[] = [];
  for (const n of Array.from({ length: 12 }, (_, i) => i + 1)) {
    const shared = await terry.call("/api/bands/library/share-song", { bandId, song: chart(`Tide Song ${n}`), choice: "public", localId: null });
    assert.equal(shared.status, 200, `song ${n} is shared (${js(shared.body)})`);
    songIds.push(shared.body.songId);
  }
  const terrySets: { name: string; setlistId: string }[] = [];
  for (const n of Array.from({ length: 9 }, (_, i) => i + 1)) {
    const name = n === 1 ? "Friday set" : `Terry set ${n}`;
    const set = await terry.call("/api/bands/library/share-setlist", { bandId, name, songIds: songIds.slice(0, 3), tags: [], choice: "public", localId: null });
    assert.equal(set.status, 200, `${name} is shared`);
    terrySets.push({ name, setlistId: set.body.setlistId });
  }
  for (const n of Array.from({ length: 24 }, (_, i) => i + 1)) await terry.call("/api/chat/send", { roomId: bandId, msgId: newId(), text: `Note ${n} about the Friday set` });

  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await app.library();
  await app.signUp("Sam Rivera");
  const sam = await site.evaluate<{ userId: string }>(`fetch("/api/me").then((r) => r.json()).then((reply) => reply.account)`);
  assert.equal((await appCalls("/api/bands/join", { code })).status, 200, "Sam joins The Low Tides");
  const samSong = await appCalls("/api/bands/library/share-song", { bandId, song: chart("Sam Tune"), choice: "public", localId: null });
  const samSet = await appCalls("/api/bands/library/share-setlist", { bandId, name: "Sam's set", songIds: [samSong.body.songId], tags: [], choice: "public", localId: null });
  assert.equal(samSet.status, 200, `Sam shares a setlist (${js(samSet.body)})`);
  assert.equal((await terry.call("/api/bands/gig/plan", { bandId, setlistId: terrySets[0].setlistId, gigId: gigId(), name: "Saturday at the Pier", date: dayFromNow(5), lineup: [terry.userId, sam.userId], leader: terry.userId })).status, 200, "Terry plans a gig");
  for (const n of Array.from({ length: 11 }, (_, i) => i + 1)) assert.equal((await appCalls("/api/bands/create", { name: `Sam Band ${n}` })).status, 200, `Sam makes band ${n}`);
  const allSets = [...terrySets.map((set) => set.name), "Sam's set"].sort();

  const page = `document.querySelector(${js(`.band-page[data-band="${bandId}"]`)})`;
  const openBand = () => go(`#/band/${bandId}`, `${page}?.dataset.view === "band" && !${page}.textContent.includes("Loading")`, "the band page");
  const section = async (name: string) => {
    await app.click(name, `${page}?.querySelector(".band-tabs")`);
    await app.until(`${page}?.querySelector(".band-tabs [aria-selected=true]")?.firstChild?.textContent.trim() === ${js(name)}`, `the ${name} section`);
    await painted(6);
  };
  const SECTION_READY: Record<string, string> = {
    Songs: `${page}.querySelectorAll(".band-library-songs li").length >= 13`,
    Setlists: `${page}.querySelectorAll(".band-library-setlists li").length >= 10`,
    Chat: `${page}.textContent.includes("Note 24 about the Friday set")`,
    Gigs: `${page}.textContent.includes("Saturday at the Pier")`,
    Members: `${page}.textContent.includes("Mike Keys")`,
  };
  const setlistRows = () => app.texts(`.band-page .band-library-setlists .band-library-name`);
  const chips = () => app.texts(`.band-page .band-library-chips button`);
  const PILL = `[...document.querySelectorAll(".band-page .band-library-chips button")].find((b) => b.textContent.trim() === "Shared by me")`;

  await check("the library tabs My Songs, Setlists, and Bands stay on one row at 360, 390, 412, and 430 CSS pixels, and do not cover content underneath", async () => {
    for (const width of WIDTHS) {
      await phone(width);
      for (const [hash, ready] of [["#/songs", `!!document.querySelector(".song-list")`], ["#/setlists", `!!document.querySelector(".setlists")`], ["#/bands", `!!document.querySelector(".bands-tab .song-row")`], [`#/song/${TIMED}`, `!!document.querySelector(".sheet .sheet-name")`]]) {
        await go(hash, ready, hash);
        const row = await tabRow();
        assert.ok(oneRow(row), `at ${width} px on ${hash} the tabs are not one clear row: ${js(row)}`);
      }
    }
  });

  await check("the last item on every main page is fully visible or reachable by scrolling, including with a realistic iPhone safe-area-inset-bottom, at 360, 390, 412, and 430 CSS pixels", async () => {
    const clipped: string[] = [];
    const look = async (where: string) => {
      const last = await lowest();
      if (!clear(last)) clipped.push(`${where}: ${js(last)}`);
    };
    for (const width of WIDTHS) {
      await phone(width);
      await go("#/songs", `!!document.querySelector(".song-list")`, "My Songs");
      await look(`${width} My Songs`);
      await go("#/setlists", `!!document.querySelector(".setlists")`, "Setlists");
      await look(`${width} Setlists`);
      await go("#/bands", `document.querySelectorAll(".bands-tab .song-row").length >= 12`, "the Bands tab");
      await look(`${width} Bands`);
      await openBand();
      for (const name of Object.keys(SECTION_READY)) {
        await section(name);
        await app.until(SECTION_READY[name], `the ${name} section filled`, 15000);
        await look(`${width} band page ${name}`);
      }
      await openSong(`#/song/${TIMED}`);
      await look(`${width} song sheet`);
    }
    assert.deepEqual(clipped, [], "something sits behind the bottom of the screen");
  });

  await check("the layout check runs at 360, 390, 412, and 430 CSS pixels with a non-zero safe-area inset, so a wrap or a clipped last row fails the check", async () => {
    for (const width of WIDTHS) {
      await phone(width);
      await go("#/songs", `!!document.querySelector(".song-list")`, "My Songs");
      assert.equal(await site.evaluate<number>("innerWidth"), width, `the page is ${width} CSS px wide`);
      assert.deepEqual(await site.evaluate("__look.inset()"), INSET, `env(safe-area-inset-*) reads the phone's insets at ${width} px`);
      await site.evaluate(`(() => { const s = document.createElement("style"); s.id = "broken"; s.textContent = ".tabs { grid-template-columns: 1fr 1fr !important } .privacy-link { padding-bottom: 0 !important }"; document.head.append(s); })()`);
      await painted(2);
      const wrapped = await tabRow();
      const cut = await lowest();
      await site.evaluate(`document.getElementById("broken").remove()`);
      await painted(2);
      assert.ok(!oneRow(wrapped), `at ${width} px the tab measure sees a two-column wrap (${js(wrapped)})`);
      assert.ok(!clear(cut), `at ${width} px the bottom measure sees a row inside the inset (${js(cut)})`);
      assert.ok(oneRow(await tabRow()), `at ${width} px the real tabs pass the same measure`);
      assert.ok(clear(await lowest()), `at ${width} px the real My Songs bottom passes the same measure`);
      await openBand();
      await section("Setlists");
      await app.until(SECTION_READY.Setlists, "the band's setlists");
      assert.ok(clear(await lowest()), `at ${width} px the band's Setlists bottom passes the same measure (${js(await lowest())})`);
    }
  });

  await check("the band library filter pill label reads Shared by me", async () => {
    await phone(412);
    await openBand();
    await section("Setlists");
    await app.until(SECTION_READY.Setlists, "the band's setlists");
    const labels = await chips();
    assert.ok(labels.includes("Shared by me"), `a Shared by me pill (${js(labels)})`);
    assert.ok(!labels.includes("Mine"), `no Mine pill (${js(labels)})`);
  });

  await check("Shared by me keeps the same filter behavior as Mine", async () => {
    await phone(412);
    await openBand();
    await section("Setlists");
    await app.until(SECTION_READY.Setlists, "the band's setlists");
    assert.deepEqual([...(await setlistRows())].sort(), allSets, "every setlist shows before the pill is on");
    await app.click("Shared by me", `document.querySelector(".band-page .band-library-chips")`);
    assert.equal(await site.evaluate<string | null>(`${PILL}?.getAttribute("aria-pressed") ?? null`), "true", "the pill is on");
    assert.deepEqual(await setlistRows(), ["Sam's set"], "on, only the setlist Sam shared");
    await app.click("Shared by me", `document.querySelector(".band-page .band-library-chips")`);
    assert.equal(await site.evaluate<string | null>(`${PILL}?.getAttribute("aria-pressed") ?? null`), "false", "the pill is off");
    assert.deepEqual([...(await setlistRows())].sort(), allSets, "off again, everyone's setlists");
  });

  await check("the Shared by me pill fits on its row at 360, 390, 412, and 430 CSS pixels", async () => {
    for (const width of WIDTHS) {
      await phone(width);
      await openBand();
      await section("Setlists");
      await app.until(SECTION_READY.Setlists, "the band's setlists");
      const pill = await site.evaluate<{ box: Box; lines: number; page: number; shown: boolean } | null>(`(() => {
        const pill = ${PILL};
        if (!pill) return null;
        pill.scrollIntoView({ block: "center" });
        const range = document.createRange();
        range.selectNodeContents(pill);
        return { box: __look.box(pill), lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size, page: document.documentElement.scrollWidth, shown: __look.shown(pill) };
      })()`);
      assert.ok(pill, `a Shared by me pill at ${width} px`);
      assert.ok(pill.shown && pill.box.l >= 0 && pill.box.r <= width, `the pill is fully on screen at ${width} px (${js(pill)})`);
      assert.equal(pill.lines, 1, `the label stays on one line at ${width} px`);
      assert.ok(pill.page <= width, `the page does not overflow sideways at ${width} px (${pill.page})`);
    }
  });

  await check("scrolling down a song collapses the header chrome to one or two tight rows", async () => {
    for (const width of WIDTHS) {
      await phone(width);
      await openSong(`#/song/${TIMED}`);
      await toTop();
      const open = await chromeInfo();
      assert.ok(!(await folded()), `the chrome starts open at ${width} px`);
      assert.ok(await foldSong(), `scrolling down hides the library tabs at ${width} px (${js(await chromeInfo())})`);
      const shut = await chromeInfo();
      assert.ok(shut.rows <= 2, `the folded chrome is ${shut.rows} rows at ${width} px (${js(shut.texts)})`);
      assert.ok(shut.bottom <= open.bottom - 80, `the folded chrome ends at ${Math.round(shut.bottom)}, open at ${Math.round(open.bottom)}, at ${width} px`);
      assert.ok(shut.bottom <= INSET.top + 8 + 2 * 48 + 24, `the folded chrome is tight: it ends at ${Math.round(shut.bottom)} at ${width} px`);
    }
  });

  await check("the collapsed song chrome keeps back, title, Key −/+, the notation switch, Scroll on/off, Metronome, and the four-state tap on the dot in the top-right corner", async () => {
    const KEEP = {
      Back: `document.querySelector(".shell-header [aria-label=Back]")`,
      title: `document.querySelector(".shell-header .shell-title")`,
      "Key −": `document.querySelector("[aria-label='Transpose down']")`,
      "Key readout": `document.querySelector(".key-readout")`,
      "Key +": `document.querySelector("[aria-label='Transpose up']")`,
      Notes: `[...document.querySelectorAll(".controls button")].find((b) => b.textContent.trim() === "Notes")`,
      Nashville: `[...document.querySelectorAll(".controls button")].find((b) => b.textContent.trim() === "Nashville")`,
      Scroll: `[...document.querySelectorAll(".controls button")].find((b) => /^Scroll: (On|Off)$/.test(b.textContent.trim()))`,
      Metronome: `[...document.querySelectorAll(".controls button")].find((b) => b.textContent.trim() === "Metronome")`,
    };
    for (const width of WIDTHS) {
      await phone(width);
      await openSong(`#/song/${TIMED}`);
      await toTop();
      await site.evaluate(`document.querySelector(".sheet .metro-pad").click()`);
      await app.until(`!!document.querySelector(".metro-pad.is-on") && !!document.querySelector(".beat-dot")`, "the metronome on with its beat dot");
      assert.ok(await foldSong(), `the chrome folds at ${width} px`);
      const missing = await site.evaluate<string[]>(`Object.entries({ ${Object.entries(KEEP).map(([name, el]) => `${js(name)}: ${el}`).join(", ")} }).filter(([, el]) => !__look.shown(el)).map(([name]) => name)`);
      assert.deepEqual(missing, [], `the folded chrome shows every playing control at ${width} px`);
      const optional = await site.evaluate<string[]>(`[...document.querySelectorAll("[aria-label='Smaller text'], [aria-label='Larger text'], .shell-header [aria-label=More]")].filter((el) => el.getClientRects().length && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== "hidden" && !__look.shown(el)).map((el) => el.getAttribute("aria-label"))`);
      assert.deepEqual(optional, [], `A− A+ and ••• are either fully shown or gone at ${width} px, never half under something`);
      const dot = await site.evaluate<{ inSheet: boolean; underChrome: boolean; box: Box; scroller: Box }>(`(() => {
        const dot = document.querySelector(".beat-dot");
        const r = dot.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { inSheet: !!dot.closest(".sheet"), underChrome: !!hit?.closest(".shell-header, .tabs, .controls"), box: __look.box(dot), scroller: __look.box(document.getElementById("sheet-scroll")) };
      })()`);
      assert.ok(dot.inSheet, "the beat dot still lives in the sheet");
      assert.ok(!dot.underChrome, `the folded chrome does not cover the beat dot at ${width} px (${js(dot)})`);
      assert.ok(dot.box.t >= dot.scroller.t - 0.5 && dot.box.t <= dot.scroller.t + 40 && dot.box.r <= width && dot.box.l >= width * 0.75, `the beat dot sits in the top-right corner of the sheet at ${width} px (${js(dot)})`);
      await site.evaluate(`document.querySelector(".sheet .metro-pad").click()`);
      await app.until(`!document.querySelector(".metro-pad.is-on")`, "the metronome off");
    }
  });

  await check("the expanded song chrome returns when the player scrolls up or taps the collapsed bar", async () => {
    for (const width of WIDTHS) {
      await phone(width);
      await openSong(`#/song/${TIMED}`);
      assert.ok(await foldSong(), `the chrome folds at ${width} px`);
      await scrollBy(-80, 10);
      assert.ok(!(await folded()), `scrolling up 80 px brings the tabs back at ${width} px`);
      await scrollBy(300, 20);
      assert.ok(await folded(), `scrolling down again folds it at ${width} px`);
      await site.evaluate(`document.querySelector(".shell-header .shell-title").click()`);
      await settle(300);
      assert.ok(!(await folded()), `a tap on the folded bar brings the tabs back at ${width} px`);
      assert.ok(await shown("[aria-label='Scroll settings']"), `the open chrome has the Scroll settings caret again at ${width} px`);
    }
  });

  await check("collapsing the song chrome does not fight auto-scroll or jump the chart, and check:chords anchors stay stable", async () => {
    for (const [width, id] of [[360, TIMED], [412, PACED]]) {
      await phone(width);
      await openSong(`#/song/${id}`);
      await toTop();
      const before = await sheetRows();
      assert.ok(before.length > 3, `song ${id} has chord rows`);
      await app.click("Scroll: Off", `document.querySelector(".controls")`);
      await app.until(`!__look.shown(document.querySelector(".tabs"))`, `auto-scroll folding the chrome on song ${id} at ${width} px`, 40000);
      await site.evaluate(`(() => {
        window.__frames = [];
        window.__sampling = true;
        const el = document.getElementById("sheet-scroll");
        const pairs = document.querySelectorAll(".chart .pair .chords");
        const mark = pairs[Math.min(6, pairs.length - 1)];
        const tick = () => {
          if (!window.__sampling) return;
          const r = el.getBoundingClientRect();
          window.__frames.push({ y: mark.getBoundingClientRect().top, top: el.scrollTop, st: r.top, sh: r.height, folded: !__look.shown(document.querySelector(".tabs")) });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })()`);
      await settle(300);
      await site.evaluate(`document.querySelector(".shell-header .shell-title").click()`);
      await app.until(`__look.shown(document.querySelector(".tabs"))`, "the tap opening the chrome during auto-scroll");
      await app.until(`!__look.shown(document.querySelector(".tabs"))`, `auto-scroll folding it again on song ${id} at ${width} px`, 40000);
      await settle(400);
      const frames = await site.evaluate<Frame[]>(`(window.__sampling = false, window.__frames)`);
      const scrolling = await site.evaluate<boolean>(`[...document.querySelectorAll(".controls button")].some((b) => b.textContent.trim() === "Scroll: On")`);
      await app.click("Scroll: On", `document.querySelector(".controls")`);
      const after = await sheetRows();
      assert.ok(scrolling, `auto-scroll is still running after the chrome opened and folded on song ${id} at ${width} px`);
      assert.ok(frames.some((f) => !f.folded) && frames.at(-1)!.folded && frames[0].folded, `the samples cover open and folded (${frames.length} frames)`);
      const spread = (pick: (f: Frame) => number) => Math.max(...frames.map(pick)) - Math.min(...frames.map(pick));
      assert.ok(spread((f) => f.st) < 0.5 && spread((f) => f.sh) < 0.5, `the sheet's box stays put while the chrome opens and folds (top moved ${spread((f) => f.st)}, height ${spread((f) => f.sh)})`);
      const steps = frames.slice(1).map((f, i) => ({ chart: f.y - frames[i].y, scroll: f.top - frames[i].top }));
      const unexplained = Math.max(...steps.map((s) => Math.abs(s.chart + s.scroll)));
      assert.ok(unexplained <= 1, `the chart moves only with the scroll on song ${id} at ${width} px (off by ${unexplained.toFixed(2)} px in one frame)`);
      const moves = steps.map((s) => Math.abs(s.scroll)).sort((a, b) => a - b);
      const median = moves[Math.floor(moves.length / 2)];
      assert.ok(moves.at(-1)! <= median * 3 + 4, `auto-scroll never lurches across the fold on song ${id} at ${width} px (largest frame ${moves.at(-1)!.toFixed(2)} px, median ${median.toFixed(2)} px)`);
      assert.deepEqual(chordAnchors(after), chordAnchors(before), `every chord stays over its syllable on song ${id} at ${width} px`);
      const line = seed.songs.find((song) => song.id === id)!.body.flatMap((part) => part.lines).find((each) => each.chords && each.lyrics)!;
      assert.equal(chordAnchors([before[0]])[0], chordAnchors([{ chords: line.chords!, lyrics: line.lyrics }])[0], `the first chord sits on its syllable on song ${id}`);
    }
  });

  await check("the collapse works on the player's own songs, locked songs, and band songs", async () => {
    await phone(412);
    await site.evaluate(`(() => { const stored = JSON.parse(localStorage.getItem("leadSheetsLibrary")); stored.songs = stored.songs.filter((song) => song.id !== 901); stored.songs.push(${js({ ...seed.songs.find((song) => song.id === TIMED), id: 901, title: "Mike's Fire Away", copy: { id: "copy-dm", canSendOn: false, from: { name: "Mike" } } })}); localStorage.setItem("leadSheetsLibrary", JSON.stringify(stored)); })()`);
    await site.evaluate(`window.__beforeReload = true; location.reload()`);
    await app.until(`!window.__beforeReload && !!document.querySelector(".shell-header")`, "the reload");
    await openBand();
    await section("Songs");
    await app.until(SECTION_READY.Songs, "the band's songs");
    await site.evaluate(`[...${page}.querySelectorAll(".band-library-songs .band-library-row")].find((b) => b.querySelector(".band-library-name")?.textContent.trim() === "Tide Song 1").click()`);
    await app.until(`location.hash === ${js(`#/band/${bandId}/song/${songIds[0]}`)} && document.querySelector(".sheet .sheet-name")?.textContent === "Tide Song 1"`, "the band song", 15000);
    for (const [hash, what, locked] of [[`#/song/${TIMED}`, "an own song", false], ["#/song/901", "a locked copy", true], [`#/band/${bandId}/song/${songIds[0]}`, "a band song", true]] as const) {
      await openSong(hash);
      assert.equal(await site.evaluate<boolean>(`!!document.querySelector(".song-lock[aria-label=Locked]")`), locked, `${what} is ${locked ? "" : "not "}locked`);
      assert.ok(!(await folded()), `${what} opens with the chrome open`);
      assert.ok(await foldSong(), `scrolling ${what} folds the chrome (${js(await chromeInfo())})`);
      assert.ok((await chromeInfo()).rows <= 2, `${what} folds to two rows at most`);
      await scrollBy(-80, 10);
      assert.ok(!(await folded()), `scrolling ${what} back up opens the chrome`);
    }

    const gigChrome = () =>
      site.evaluate<{ boxes: (Box | null)[]; tabs: boolean }>(`({ boxes: [".shell-header", ".controls", ".live-nav", "#sheet-scroll", ".shell-header .shell-title", "[aria-label='Transpose up']", "[aria-label='Scroll settings']"].map((s) => { const el = document.querySelector(s); return el && el.getClientRects().length ? __look.box(el) : null; }), tabs: !!document.querySelector(".tabs") })`);
    const stageFolded = () => site.evaluate<boolean>(`!!document.querySelector(".song-chrome-bar[data-folded]")`);
    const steady = async (what: string) => {
      await toTop();
      const top = await gigChrome();
      assert.equal(top.tabs, false, `${what} has no library tabs`);
      assert.ok(!(await stageFolded()), `${what} opens with its header open`);
      assert.ok(await shown(".shell-header .text-size"), `${what} shows A− A+ while open`);
      await scrollBy(600, 20);
      const down = await gigChrome();
      assert.ok(await stageFolded(), `${what} folds its header while it scrolls`);
      assert.ok(!(await shown(".shell-header .text-size")), `${what} hides A− A+ while folded`);
      assert.deepEqual(down.boxes[2], top.boxes[2], `${what} keeps the stage bar in place across the fold`);
      await scrollBy(-80, 10);
      assert.ok(!(await stageFolded()), `${what} opens its header again on the way up`);
    };
    const live = seed.setlists[0];
    await go(`#/live/${live.id}/0`, `!!document.querySelector(".live-nav") && !!document.querySelector(".sheet .sheet-name")`, "a setlist live");
    await steady("Live");
    await openBand();
    await section("Setlists");
    await app.until(SECTION_READY.Setlists, "the band's setlists");
    await site.evaluate(`[...${page}.querySelectorAll(".band-library-setlists .band-library-row")].find((b) => b.querySelector(".band-library-name")?.textContent.trim() === "Friday set").click()`);
    await app.until(`${page}?.dataset.view === "setlist"`, "the band setlist view");
    await app.click("Live", `${page}.querySelector(".band-setlist-view")`);
    await app.until(`location.hash === ${js(`#/live/band/${bandId}/${terrySets[0].setlistId}/0`)} && document.querySelector(".sheet .sheet-name")?.textContent === "Tide Song 1"`, "the band Live song", 15000);
    await steady("band Live");
  });

  assert.deepEqual(await app.errors(), [], "no page errors");
} finally {
  await site.close();
  await worker.dispose();
}
if (failed) {
  console.log(`check:ux-layout-fix: ${failed} failed`);
  process.exit(1);
}
console.log("check:ux-layout-fix passed");
