import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { SongContent } from "../src/band-library-model.ts";

/**
 * Song info: on every sheet the title is followed by the Key / Time / Tempo line, then one Song info row, closed, then
 * the chart. The row opens a panel holding the source line, Feel, How to play, At a glance, Practice tip, Key & tempo
 * notes and the band's notes, in that order. Cases I1 to I14 and guard G1 are the brief's (plans 2 to 6, plan 2), and
 * I15 is its "account switch" must-handle.
 * The app runs in headless Chrome at 360 x 740 against a real Worker; every song here is made up for this check.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const js = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const WIDTH = 360;
const HEIGHT = 740;

let failed = 0;
async function check(name: string, run: () => Promise<void> | void) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

const NAMES = {
  G1: "G1 guard: src/App.tsx has no more than 494 lines",
  I1: "I1 closed by default: on the song page none of the folded texts is laid out, the Key / Time / Tempo line is",
  I2: "I2 chart next: only the Song info row sits between the meta line and the chart, and the first Intro bar row is on screen",
  I3: "I3 open and close: a tap shows every field in order with aria-expanded true, a second tap hides them with aria-expanded false",
  I4: "I4 nothing to show: no row for a song with no fields, nor for one whose only notes are spaces",
  I5: "I5 one field: a song with only Feel has the row and its open panel holds Feel and no empty heading",
  I6live: "I6 every mount: a Live route of a personal setlist shows the row closed",
  I6editor: "I6 every mount: the editor preview shows the row closed",
  I6band: "I6 every mount: a band song (real Worker) shows the row closed",
  I6gig: "I6 every mount: the gig sheet shows the row closed",
  I6search: "I6 every mount: a band song opened from My Songs search shows the row closed",
  I6import: "I6 every mount: the import preview shows the row closed",
  I7: "I7 band notes: the count is on the row, the notes are inside the panel and never above the sheet, members and admins see the right row",
  I7count: "I7 band notes: an admin's Save note and Delete in the open panel change the row's count at once",
  I8: "I8 song change closes: Next in Live, A to B and back to A, and the next gig song all start closed",
  I9: "I9 key and view apply inside: At a glance A D E F#m reads B E F# G#m two steps up and 1 4 5 6m in Nashville",
  I10: "I10 reading position held: opening and closing during auto-scroll keeps the chart row at the reading line within 2 px",
  I16: "I16 the pill starts the closed sheet: on built-in song 10 at 1280 x 800 with Song info closed, the chart moves within 1.2 s of the Scroll pill",
  I11: "I11 keyboard and motion: a button with aria-expanded and aria-controls, Enter and Space toggle it with focus kept, no transition with reduced motion",
  I12: "I12 odd text: an apostrophe, curly quotes and typed markup show as the same characters and make no element",
  I13: "I13 fits at 360 px: one meta line, a row at least 44 px tall, no sideways scroll closed or open",
  I14signal: "I14 no signal: on a band song whose notes request fails the row shows with no count, the fields open, no error and no waiting mark",
  I14out: "I14 signed out: on the song page the row works and no notes request is sent",
  I15switch: "I15 account switch: after a member signs out on this phone, signed out, a second account outside the band, and that account in the band with no signal for notes see none of the first account's notes or count",
};

// ---------------------------------------------------------------------------------------------- G1

await check(NAMES.G1, () => {
  const text = readFileSync(join(root, "src", "App.tsx"), "utf8");
  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  assert.ok(lines <= 494, `src/App.tsx is ${lines} lines`);
});

// ---------------------------------------------------------------------------------------------- Songs, through the one writer

type Writer = { songToStored(song: Record<string, unknown>): { id: number; chordpro: string } };
let writer: Writer | null = null;
try {
  const bundle = await build({ entryPoints: [join(root, "src", "storage.ts")], bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" });
  writer = (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`)) as Writer;
} catch (error) {
  failed += 1;
  console.log(`FAIL src/storage.ts loads: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
}

const EMPTY = { keyNote: "", tempoNote: "", feel: "", sourceNote: "", atAGlance: "", howToPlay: "", practiceTip: "" };
const LONG_TIP = "Count four before the chorus, then hold the Lanternbridgechordrightthroughtheturnaroundandbackagain.";
const chartOf = (lyric: string): SongContent["body"] => [
  { heading: "Intro", lines: [{ bars: "| A | D | E | A |" }] },
  { heading: "Verse 1", lines: [{ chords: "A          D", lyrics: lyric }, { chords: "E          A", lyrics: "Paper cranes along the shore" }] },
  { heading: "Chorus", lines: [{ chords: "D          A", lyrics: "Hold the line and sing it slow" }, { chords: "E          F#m", lyrics: "Every lantern burning low" }] },
];
const content = (title: string, fields: Partial<typeof EMPTY>, extra: Partial<SongContent> = {}): SongContent => ({
  title,
  artist: "The Lantern Pines",
  keyLabel: "A major",
  keyRoot: "A",
  keyMode: "major",
  tempo: 96,
  timeSignature: "4/4",
  officialRuntimeSec: 200,
  body: chartOf("Lanterns on the water"),
  ...EMPTY,
  ...fields,
  ...extra,
});

const EVERY = {
  sourceNote: "Charted from a band rehearsal, Nov 2026.",
  feel: "Easy shuffle, laid back.",
  howToPlay: "Let the bass lead the verse.",
  atAGlance: "A  D  E  F#m",
  practiceTip: LONG_TIP,
  keyNote: "Capo 2 for the guitar.",
  tempoNote: "Slows a little in the bridge.",
};
/** Every field, open, top to bottom, as the player reads it. */
const EVERY_SHOWN = [
  "Charted from a band rehearsal, Nov 2026.",
  "Feel: Easy shuffle, laid back.",
  "How to play",
  "Let the bass lead the verse.",
  "At a glance",
  "A D E F#m",
  "Practice tip",
  LONG_TIP,
  "Key & tempo notes",
  "Capo 2 for the guitar.",
  "Slows a little in the bridge.",
];
const FOLDED = ["Charted from a band rehearsal", "Easy shuffle, laid back.", "Let the bass lead the verse.", "Lanternbridgechord", "Capo 2 for the guitar.", "Slows a little in the bridge.", "At a glance"];
const TWIN = { feel: "Bright and even.", howToPlay: "Strum on every beat." };
const longBody: SongContent["body"] = [
  { heading: "Intro", lines: [{ bars: "| A | D | E | A |" }] },
  ...Array.from({ length: 8 }, (_, n) => ({
    heading: n % 2 ? `Chorus ${(n + 1) / 2}` : `Verse ${n / 2 + 1}`,
    lines: Array.from({ length: 4 }, (_, k) => ({ chords: "A          D          E", lyrics: `Line ${k + 1} of part ${n + 1} goes rolling down the road` })),
  })),
];

const legacy = (id: number, title: string, fields: Partial<typeof EMPTY>) => ({ id, ...content(title, fields) });
const stored = (id: number, song: SongContent) => writer!.songToStored({ id, ...song });

const MEMBER_FIELDS = { feel: "Rolling, with a heavy back beat.", howToPlay: "Keys hold the pad under the verse." };
const ADMIN = { name: "Terry Bass", handle: "terrybass" };

// ---------------------------------------------------------------------------------------------- The app

const STAND_INS = `(() => {
  window.__notes = { asked: 0, settled: 0 };
  const plain = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) {
      return Promise.resolve(new Response(JSON.stringify({ created: "2026-11-27T00:00:00.000Z", count: 0, offset: 0, recordings: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    if (!url.pathname.endsWith("/api/bands/notes/list")) return plain(input, init);
    window.__notes.asked += 1;
    if (sessionStorage.getItem("check-fail-notes")) {
      window.__notes.settled += 1;
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    return plain(input, init).finally(() => { window.__notes.settled += 1; });
  };
})();`;

const { startApi } = await import("./api-session.ts");
const { appPage, PASSWORD_PEPPER, passwordPlayer, settle } = await import("./app-page.ts");
const { openSite } = await import("./chrome.ts");

let apiBase = "";
type Site = Awaited<ReturnType<typeof openSite>>;
let site: Site | null = null;
let api: Awaited<ReturnType<typeof startApi>> | null = null;
try {
  site = await openSite(root, "check-song-info", () => apiBase);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  api = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
  apiBase = api.base;
  const s = site;
  const app = await appPage(s);
  await s.send("Page.addScriptToEvaluateOnNewDocument", { source: STAND_INS });
  await s.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true });

  const SHEET = `document.querySelector("#sheet-scroll .sheet")`;
  const rowIn = (sheet: string) => `[...(${sheet}?.querySelectorAll("button") ?? [])].find((b) => /^Song info/.test(b.textContent.trim()))`;
  const ROW = rowIn(SHEET);
  /** Whether any text in `scope` holding `text` is laid out (has client rects). */
  const laidOut = (scope: string, text: string) =>
    s.evaluate<boolean>(`(() => {
      const scope = ${scope};
      if (!scope) return false;
      const walk = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        if (node.textContent.includes(${js(text)}) && node.parentElement.getClientRects().length > 0) return true;
      }
      return false;
    })()`);
  type RowState = { text: string; expanded: string | null; controls: string | null; tag: string; height: number } | null;
  const rowState = (row = ROW) =>
    s.evaluate<RowState>(`(() => {
      const el = ${row};
      return el ? { text: el.textContent.trim(), expanded: el.getAttribute("aria-expanded"), controls: el.getAttribute("aria-controls"), tag: el.tagName, height: el.getBoundingClientRect().height } : null;
    })()`);
  const needRow = async (what: string, row = ROW) => {
    const state = await rowState(row);
    assert.ok(state, `a Song info row on ${what}`);
    return state;
  };
  const closedRow = async (what: string, row = ROW, sheet = SHEET, folded = FOLDED) => {
    const state = await needRow(what, row);
    assert.equal(state.expanded, "false", `the row on ${what} starts closed`);
    for (const text of folded) assert.equal(await laidOut(sheet, text), false, `${js(text)} is not laid out on ${what} while closed`);
    return state;
  };
  /** The texts the open panel shows, top to bottom, as drawn. */
  const panelTexts = (row = ROW) =>
    s.evaluate<string[]>(`(() => {
      const row = ${row};
      const panel = row && document.getElementById(row.getAttribute("aria-controls"));
      if (!panel) return [];
      return [...panel.querySelectorAll("p, h2, h3")].filter((el) => el.getClientRects().length > 0).map((el) => el.textContent.replace(/\\s+/g, " ").trim());
    })()`);
  /** A real tap at the middle of what `expression` finds, once it is on screen and nothing covers it. */
  const tap = async (expression: string, what: string) => {
    const box = await s.evaluate<{ x: number; y: number; hit: boolean } | null>(`(() => {
      const el = ${expression};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return { x, y, hit: y > 0 && y < innerHeight && el.contains(document.elementFromPoint(x, y)) };
    })()`);
    assert.ok(box, `${what} to tap`);
    assert.ok(box.hit, `${what} is on screen and not covered (${Math.round(box.x)}, ${Math.round(box.y)})`);
    for (const type of ["mousePressed", "mouseReleased"]) await s.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    await settle(200);
  };
  const tapRow = (row = ROW) => tap(row, "the Song info row");
  const openSong = async (id: number) => {
    await s.evaluate(`location.hash = "#/songs"`);
    await sleep(100);
    await s.evaluate(`location.hash = ${js(`#/song/${id}`)}`);
    await app.until(`!!document.querySelector("#sheet-scroll .sheet .sheet-name") && location.hash === ${js(`#/song/${id}`)}`, `song ${id}`);
    await settle(300);
  };
  const button = (label: string, scope = "document") => `[...(${scope}?.querySelectorAll("button, [role=menuitem]") ?? [])].find((b) => (b.getAttribute("aria-label") ?? b.textContent.trim()) === ${js(label)} || b.textContent.trim() === ${js(label)})`;
  const tapButton = async (label: string, scope = "document") => {
    assert.ok(await s.evaluate<boolean>(`(() => { const el = ${button(label, scope)}; if (!el || el.disabled) return false; el.click(); return true; })()`), `a ${label} button`);
    await settle(250);
  };
  const notesSettled = async (asked: number, what: string) => {
    await app.until(`window.__notes.asked > ${asked} && window.__notes.settled >= window.__notes.asked`, `the notes reply on ${what}`, 15000);
    await settle(400);
  };

  await s.send("Page.navigate", { url: `${origin}/#/songs` });
  await app.library();
  if (!writer) throw new Error("src/storage.ts did not load");
  const SONGS = [
    stored(901, content("Every Field", EVERY)),
    stored(902, content("Bare Song", {})),
    stored(903, content("Blank Notes", { keyNote: "   ", tempoNote: "  " })),
    stored(904, content("Only Feel", { feel: "Steady and bright." })),
    stored(905, content("Don't Look Back", { feel: "“Like a slow ‘sway’”", howToPlay: "<b>bold</b>" })),
    stored(906, content("Twin Rivers", TWIN)),
    stored(907, content("Twin Rivers", TWIN)),
    legacy(908, "Old Shape Song", { feel: "Kept from an older phone." }),
    stored(909, content("Long Road", { feel: "Slow and steady." }, { tempo: 60, officialRuntimeSec: 600, body: longBody })),
  ];
  await s.evaluate(`(() => {
    const lib = JSON.parse(localStorage.getItem("leadSheetsLibraryV2") || "{}");
    const ours = ${js(SONGS)};
    lib.songs = (lib.songs || []).filter((each) => !ours.some((song) => song.id === each.id)).concat(ours);
    lib.setlists = (lib.setlists || []).filter((each) => each.id !== 901).concat([{ id: 901, name: "Info Check Set", songIds: [901, 906, 907] }]);
    lib.lastSongId = Math.max(lib.lastSongId || 0, 909);
    localStorage.setItem("leadSheetsLibraryV2", JSON.stringify(lib));
  })()`);
  await s.send("Page.reload");
  await app.library();

  // ---------------------------------------------------------------------------------------------- Signed out, the song page

  await check(NAMES.I1, async () => {
    await openSong(901);
    const meta = await s.evaluate<{ text: string; laid: boolean } | null>(`(() => { const el = ${SHEET}.querySelector(".meta"); return el && { text: el.textContent.trim(), laid: el.getClientRects().length > 0 }; })()`);
    assert.deepEqual(meta, { text: "Key: A major • Time: 4/4 • Tempo: ~96 bpm", laid: true }, "the Key / Time / Tempo line is laid out");
    for (const text of FOLDED) assert.equal(await laidOut(SHEET, text), false, `${js(text)} is not laid out while closed`);
    await closedRow("the song page");
  });

  await check(NAMES.I2, async () => {
    await openSong(901);
    const seen = await s.evaluate<{ between: string[]; above: string[]; chartUnder: boolean; firstHeading: string; bar: { top: number; bottom: number; text: string } | null; scroller: { top: number; bottom: number } }>(`(() => {
      const sheet = ${SHEET};
      const meta = sheet.querySelector(".meta"), chart = sheet.querySelector(".chart"), title = sheet.querySelector(".sheet-title");
      const kids = [...sheet.children].filter((el) => el.getClientRects().length > 0);
      const at = (el) => kids.indexOf(el);
      const name = (el) => el.tagName.toLowerCase() + "." + el.className + ":" + el.textContent.trim().slice(0, 24);
      const between = kids.slice(at(meta) + 1, at(chart)).map(name);
      const above = kids.slice(at(title) + 1, at(meta)).map(name);
      const section = chart.querySelector(".chart-section");
      const bar = section?.querySelector(".bars");
      const row = ${ROW};
      const box = document.getElementById("sheet-scroll").getBoundingClientRect();
      return {
        between, above,
        chartUnder: !!row && row.getBoundingClientRect().bottom <= chart.getBoundingClientRect().top + 0.5,
        firstHeading: section?.querySelector(".chart-heading")?.textContent.trim() ?? "",
        bar: bar ? { top: bar.getBoundingClientRect().top, bottom: bar.getBoundingClientRect().bottom, text: bar.textContent.trim() } : null,
        scroller: { top: box.top, bottom: box.bottom },
      };
    })()`);
    assert.deepEqual(seen.above, [], `nothing sits between the title and the meta line (${js(seen.above)})`);
    assert.equal(seen.between.length, 1, `only the Song info row sits between the meta line and the chart (${js(seen.between)})`);
    assert.ok(seen.chartUnder, "the chart starts under the Song info row");
    assert.equal(seen.firstHeading, "Intro", "the chart's first section is the Intro");
    assert.ok(seen.bar && seen.bar.text === "| A | D | E | A |", `the Intro's first bar row is first in the chart (${js(seen.bar)})`);
    assert.ok(seen.bar.top >= seen.scroller.top && seen.bar.bottom <= Math.min(seen.scroller.bottom, HEIGHT), `the first Intro bar row is on screen (${Math.round(seen.bar.top)}..${Math.round(seen.bar.bottom)} in ${Math.round(seen.scroller.top)}..${Math.round(seen.scroller.bottom)})`);
  });

  await check(NAMES.I3, async () => {
    await openSong(901);
    await needRow("the song page");
    await tapRow();
    assert.equal((await rowState())!.expanded, "true", "aria-expanded is true once open");
    assert.deepEqual(await panelTexts(), EVERY_SHOWN, "every field shows in order with its own words");
    await tapRow();
    assert.equal((await rowState())!.expanded, "false", "aria-expanded is false once closed");
    for (const text of FOLDED) assert.equal(await laidOut(SHEET, text), false, `${js(text)} is hidden again`);
    assert.deepEqual(await panelTexts(), [], "the closed panel shows nothing");
  });

  await check(NAMES.I4, async () => {
    await openSong(901);
    await needRow("Every Field, which has fields");
    for (const [id, what] of [[902, "Bare Song, with no fields"], [903, "Blank Notes, whose only notes are spaces"]] as const) {
      await openSong(id);
      assert.equal(await rowState(), null, `no Song info row on ${what}`);
      const gap = await s.evaluate<string[]>(`(() => {
        const sheet = ${SHEET}, kids = [...sheet.children].filter((el) => el.getClientRects().length > 0);
        return kids.slice(kids.indexOf(sheet.querySelector(".meta")) + 1, kids.indexOf(sheet.querySelector(".chart"))).map((el) => el.className);
      })()`);
      assert.deepEqual(gap, [], `the chart follows the meta line on ${what}`);
      assert.equal(await laidOut(SHEET, "Key & tempo notes"), false, `no Key & tempo notes heading on ${what}`);
    }
  });

  await check(NAMES.I5, async () => {
    await openSong(904);
    await closedRow("Only Feel", ROW, SHEET, ["Steady and bright."]);
    await tapRow();
    assert.deepEqual(await panelTexts(), ["Feel: Steady and bright."], "the open panel holds Feel alone");
    const headings = await s.evaluate<number>(`(() => { const row = ${ROW}; const panel = document.getElementById(row.getAttribute("aria-controls")); return [...panel.querySelectorAll("h2, h3")].filter((el) => el.getClientRects().length > 0).length; })()`);
    assert.equal(headings, 0, "with no heading");
  });

  await check(NAMES.I6live, async () => {
    await s.evaluate(`location.hash = "#/live/901/0"`);
    await app.until(`(${SHEET}?.querySelector(".sheet-name")?.textContent ?? "") === "Every Field"`, "Every Field on Live");
    await settle(300);
    await closedRow("the Live route");
  });

  await check(NAMES.I8, async () => {
    await s.evaluate(`location.hash = "#/live/901/0"`);
    await app.until(`(${SHEET}?.querySelector(".sheet-name")?.textContent ?? "") === "Every Field"`, "Every Field on Live");
    await settle(300);
    await needRow("Every Field on Live");
    await tapRow();
    assert.equal((await rowState())!.expanded, "true", "open on Every Field");
    await tapButton("Next song");
    await app.until(`location.hash === "#/live/901/1"`, "the next song");
    await settle(300);
    await closedRow("the next song in Live", ROW, SHEET, ["Bright and even."]);
    await openSong(906);
    await tapRow();
    assert.equal((await rowState())!.expanded, "true", "open on Twin Rivers A");
    await openSong(907);
    await closedRow("Twin Rivers B, the same words as A", ROW, SHEET, ["Bright and even."]);
    await openSong(906);
    await closedRow("Twin Rivers A again", ROW, SHEET, ["Bright and even."]);
  });

  await check(NAMES.I9, async () => {
    await openSong(901);
    const glance = () =>
      s.evaluate<string>(`(() => {
        const row = ${ROW};
        const panel = row && document.getElementById(row.getAttribute("aria-controls"));
        const label = [...(panel?.querySelectorAll(".sheet-label") ?? [])].find((el) => el.textContent.trim().startsWith("At a glance"));
        return label?.nextElementSibling?.textContent.replace(/\\s+/g, " ").trim() ?? "";
      })()`);
    const view = (label: string) => `[...document.querySelectorAll(".controls button")].find((b) => b.textContent.trim() === ${js(label)})`;
    let up = 0;
    try {
      await needRow("Every Field");
      await tapRow();
      assert.equal(await glance(), "A D E F#m", "as written in A");
      for (; up < 2; up += 1) await tapButton("Transpose up");
      assert.equal(await glance(), "B E F# G#m", "two steps up");
      for (; up > 0; up -= 1) await tapButton("Transpose down");
      await s.evaluate(`${view("Nashville")}.click()`);
      await settle(250);
      assert.equal(await glance(), "1 4 5 6m", "in Nashville");
    } finally {
      for (; up > 0; up -= 1) await tapButton("Transpose down");
      await s.evaluate(`${view("Notes")}?.click()`);
      await settle(250);
    }
  });

  await check(NAMES.I10, async () => {
    try {
      await heldReading();
    } finally {
      await s.evaluate(`document.querySelector(".scroll-pill")?.getAttribute("aria-pressed") === "true" && document.querySelector(".scroll-pill").click()`);
      await settle(300);
    }
  });

  async function heldReading() {
    await openSong(909);
    await needRow("Long Road");
    const scroller = `document.getElementById("sheet-scroll")`;
    // A little way down, so the chart is part-way up the screen with the row still in view below the song's top bar.
    await s.evaluate(`${scroller}.scrollTop = 40`);
    await settle(400);
    await s.evaluate(`document.querySelector(".scroll-pill").click()`);
    await app.until(`document.querySelector(".scroll-pill")?.getAttribute("aria-pressed") === "true"`, "auto-scroll on");
    const startTop = await s.evaluate<number>(`${scroller}.scrollTop`);
    await app.until(`${scroller}.scrollTop > ${startTop} + 2`, "the chart moving", 15000);
    // The capture listener reads the screen before the tap's update, the bubble one after it, in the same task, so the
    // auto-scroll cannot move the chart in between.
    await s.evaluate(`(() => {
      window.__held = [];
      const sheet = ${scroller};
      const line = () => sheet.getBoundingClientRect().top + sheet.clientHeight / 2;
      const nearest = () => [...sheet.querySelectorAll(".chart .pair, .chart .bars")].reduce((best, el) => (Math.abs(el.getBoundingClientRect().top - line()) < Math.abs(best.getBoundingClientRect().top - line()) ? el : best));
      const onRow = (event) => event.target instanceof Element && !!event.target.closest(".sheet button") && /^Song info/.test(event.target.closest("button").textContent.trim());
      window.addEventListener("click", (event) => { if (onRow(event)) { window.__heldRow = nearest(); window.__heldBefore = window.__heldRow.getBoundingClientRect().top; } }, true);
      window.addEventListener("click", (event) => { if (onRow(event)) window.__held.push({ before: window.__heldBefore, after: window.__heldRow.getBoundingClientRect().top, text: window.__heldRow.textContent }); });
    })()`);
    await tapRow();
    assert.equal((await rowState())!.expanded, "true", "the panel opened");
    assert.ok(await s.evaluate<boolean>(`document.querySelector(".scroll-pill")?.getAttribute("aria-pressed") === "true"`), "auto-scroll keeps running");
    // Held, the open panel grew upward and took the row up with it. Bring the row back into view and scroll on again.
    await s.evaluate(`document.querySelector(".scroll-pill").click()`);
    await app.until(`document.querySelector(".scroll-pill")?.getAttribute("aria-pressed") === "false"`, "auto-scroll off");
    await s.evaluate(`(() => { const sheet = ${scroller}, r = ${ROW}.getBoundingClientRect(), box = sheet.getBoundingClientRect(); sheet.scrollTop += r.top - (box.top + sheet.clientHeight * 0.3); })()`);
    await settle(400);
    await s.evaluate(`document.querySelector(".scroll-pill").click()`);
    await app.until(`document.querySelector(".scroll-pill")?.getAttribute("aria-pressed") === "true"`, "auto-scroll on again");
    const againTop = await s.evaluate<number>(`${scroller}.scrollTop`);
    await app.until(`${scroller}.scrollTop > ${againTop} + 2`, "the chart moving again", 15000);
    await tapRow();
    assert.equal((await rowState())!.expanded, "false", "the panel closed");
    const held = await s.evaluate<{ before: number; after: number; text: string }[]>(`window.__held`);
    assert.equal(held.length, 2, `one reading per tap (${js(held)})`);
    held.forEach(({ before, after, text }, i) => assert.ok(Math.abs(after - before) <= 2, `${i ? "closing" : "opening"} keeps ${js(text.slice(0, 30))} at the reading line (${before.toFixed(1)} -> ${after.toFixed(1)})`));
  }

  await check(NAMES.I16, async () => {
    const scroller = `document.getElementById("sheet-scroll")`;
    await s.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
    try {
      await openSong(10);
      await closedRow("built-in song 10");
      assert.equal(await s.evaluate<number>(`${scroller}.scrollTop`), 0, "the sheet opens at the top");
      await s.evaluate(`document.querySelector(".scroll-pill").click()`);
      await sleep(1200);
      const on = await s.evaluate<boolean>(`document.querySelector(".scroll-pill")?.getAttribute("aria-pressed") === "true"`);
      const top = await s.evaluate<number>(`${scroller}.scrollTop`);
      assert.ok(on && top > 0, `1.2 s after the pill the scroll is ${on ? "on" : "off"} at top ${top}`);
    } finally {
      await s.evaluate(`document.querySelector(".scroll-pill")?.getAttribute("aria-pressed") === "true" && document.querySelector(".scroll-pill").click()`);
      await s.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true });
      await settle(300);
    }
  });

  await check(NAMES.I11, async () => {
    await openSong(901);
    const state = await needRow("Every Field");
    assert.equal(state.tag, "BUTTON", "the row is a button");
    assert.equal(state.expanded, "false", "with aria-expanded");
    assert.ok(state.controls && (await s.evaluate<boolean>(`!!document.getElementById(${js(state.controls)})?.closest(".sheet")`)), `aria-controls names the panel (${state.controls})`);
    await s.evaluate(`${ROW}.focus({ preventScroll: true })`);
    const key = async (key: string, code: string, keyCode: number, text: string) => {
      await s.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, text });
      await s.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
      await settle(200);
    };
    const focused = () => s.evaluate<boolean>(`document.activeElement === ${ROW}`);
    await key("Enter", "Enter", 13, "\r");
    assert.equal((await rowState())!.expanded, "true", "Enter opens it");
    assert.ok(await focused(), "focus stays on the row after Enter");
    await key(" ", "Space", 32, " ");
    assert.equal((await rowState())!.expanded, "false", "Space closes it");
    assert.ok(await focused(), "focus stays on the row after Space");
    await s.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    try {
      await key(" ", "Space", 32, " ");
      const moving = await s.evaluate<string[]>(`(() => {
        const row = ${ROW}, panel = document.getElementById(row.getAttribute("aria-controls"));
        return [row, ...row.querySelectorAll("*"), panel].filter((el) => getComputedStyle(el).transitionDuration.split(",").some((d) => parseFloat(d) > 0) || getComputedStyle(el).animationName !== "none").map((el) => el.className || el.tagName);
      })()`);
      assert.deepEqual(moving, [], "with reduced motion nothing in the row or panel moves");
    } finally {
      await s.send("Emulation.setEmulatedMedia", { features: [] });
    }
  });

  await check(NAMES.I12, async () => {
    await openSong(905);
    assert.equal(await s.evaluate<string>(`${SHEET}.querySelector(".sheet-name").textContent`), "Don't Look Back", "the title keeps its apostrophe");
    await needRow("Don't Look Back");
    await tapRow();
    assert.deepEqual(await panelTexts(), ["Feel: “Like a slow ‘sway’”", "How to play", "<b>bold</b>"], "the curly quotes and the typed markup show as typed");
    assert.equal(await s.evaluate<number>(`${SHEET}.querySelectorAll("b").length`), 0, "no element is made from the text");
  });

  await check(NAMES.I13, async () => {
    await openSong(901);
    const measure = () =>
      s.evaluate<{ lines: number; row: number; page: number; sheet: number; inner: number; client: number }>(`(() => {
        const meta = ${SHEET}.querySelector(".meta"), range = document.createRange();
        range.selectNodeContents(meta);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        const scroller = document.getElementById("sheet-scroll");
        return { lines: tops.size, row: ${ROW}?.getBoundingClientRect().height ?? 0, page: document.documentElement.scrollWidth, sheet: scroller.scrollWidth, inner: innerWidth, client: scroller.clientWidth };
      })()`);
    await needRow("Every Field");
    const closed = await measure();
    assert.equal(closed.lines, 1, "the meta line is one line at 360 px");
    assert.ok(closed.row >= 44, `the row is ${closed.row.toFixed(1)} px tall`);
    assert.ok(closed.page <= closed.inner && closed.sheet <= closed.client, `no sideways scroll closed (${closed.page}, ${closed.sheet})`);
    await tapRow();
    const open = await measure();
    assert.ok(open.page <= open.inner && open.sheet <= open.client, `no sideways scroll open, with a long word in Practice tip (${open.page}, ${open.sheet})`);
    assert.ok(open.row >= 44, `the row is ${open.row.toFixed(1)} px tall open`);
  });

  await check(NAMES.I14out, async () => {
    await openSong(908);
    await closedRow("Old Shape Song, stored the old way", ROW, SHEET, ["Kept from an older phone."]);
    await s.evaluate(`window.__notes.asked = 0`);
    await openSong(901);
    await needRow("the song page, signed out");
    await tapRow();
    assert.equal((await rowState())!.expanded, "true", "the row opens signed out");
    assert.equal(await laidOut(SHEET, "Easy shuffle, laid back."), true, "and shows the fields");
    await settle(800);
    assert.equal(await s.evaluate<number>(`window.__notes.asked`), 0, "no notes request is sent");
  });

  await check(NAMES.I6editor, async () => {
    await openSong(901);
    await s.evaluate(`document.querySelector(".shell-header [aria-label=More]").click()`);
    await settle(250);
    await tapButton("Edit");
    const editor = `document.querySelector(".song-editor[role=dialog]")`;
    try {
      await app.until(`!!${editor}?.querySelector(".sheet .sheet-name")`, "the editor's preview");
      await closedRow("the editor preview", rowIn(`${editor}.querySelector(".sheet")`), `${editor}.querySelector(".sheet")`);
    } finally {
      await closeEditor(editor);
    }
  });

  async function closeEditor(editor: string) {
    await s.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await settle(300);
    await s.evaluate(`${button("Cancel", editor)}?.click()`);
    await settle(300);
  }

  // ---------------------------------------------------------------------------------------------- A band, a gig, and signed in

  const terry = await passwordPlayer(api.base, origin, ADMIN.name, ADMIN.handle);
  const bandId = (await terry.call("/api/bands/create", { name: "The Low Tides" })).body.bandId as string;
  const code = (await terry.call("/api/codes", { kind: "band", bandId })).body.code as string;
  const share = async (band: string, song: SongContent) => {
    const reply = await terry.call("/api/bands/library/share-song", { bandId: band, song, choice: "public" });
    assert.equal(reply.status, 200, `${song.title} is shared (${js(reply.body)})`);
    return reply.body.songId as string;
  };
  const harbor = await share(bandId, content("Harbor Song", MEMBER_FIELDS, { body: chartOf("Harbor lights are calling") }));
  const quiet = await share(bandId, content("Quiet Song", {}, { body: chartOf("Soft and low tonight") }));
  const oneNote = await share(bandId, content("One Note Song", {}, { body: chartOf("Just a word tonight") }));
  const second = await share(bandId, content("Second Song", { feel: "Lifted, a little faster." }, { body: chartOf("Second verse rising") }));
  for (const [song, body] of [[harbor, "Watch the push into the chorus"], [harbor, "Bass: walk up on the last bar"], [oneNote, "Count in from the drums"]] as const) {
    assert.equal((await terry.call("/api/bands/notes/add", { bandId, songId: song, body })).status, 200, "Terry adds a note");
  }
  const setlist = await terry.call("/api/bands/library/share-setlist", { bandId, name: "Friday", songIds: [harbor, second], tags: [], choice: "public" });
  const appCalls = (path: string, body: object) =>
    s.evaluate<{ status: number; body: Record<string, any> }>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const openBandSong = async (band: string, songId: string, lyric: string) => {
    await s.evaluate(`location.hash = ${js(`#/band/${band}?s=songs`)}`);
    await app.until(`!!document.querySelector(".band-page") && !document.querySelector(".band-page").textContent.includes("Loading")`, "the band page", 15000);
    await settle(500);
    const asked = await s.evaluate<number>(`window.__notes.asked`);
    await s.evaluate(`location.hash = ${js(`#/band/${band}/song/${songId}`)}`);
    await app.until(`(${SHEET}?.textContent ?? "").includes(${js(lyric)})`, `the band song with ${lyric}`, 15000);
    await notesSettled(asked, lyric);
  };
  const outsideSheet = (text: string) =>
    s.evaluate<boolean>(`(() => {
      const sheet = ${SHEET}, walk = document.createTreeWalker(document.getElementById("sheet-scroll"), NodeFilter.SHOW_TEXT);
      for (let node = walk.nextNode(); node; node = walk.nextNode()) if (node.textContent.includes(${js(text)}) && !sheet?.contains(node)) return true;
      return false;
    })()`);

  await s.send("Page.navigate", { url: `${origin}/#/songs` });
  await app.library();
  await app.signUp("Sam Rivera");
  assert.equal((await appCalls("/api/bands/join", { code })).status, 200, "Sam joins The Low Tides");
  const trio = (await appCalls("/api/bands/create", { name: "Sam's Trio" })).body.bandId as string;
  const trioShared = await appCalls("/api/bands/library/share-song", { bandId: trio, song: content("Trio Song", {}, { body: chartOf("Three of us tonight") }), choice: "public" });
  assert.equal(trioShared.status, 200, `Sam shares Trio Song (${js(trioShared.body)})`);
  const trioSong = trioShared.body.songId as string;

  await check(NAMES.I6band, async () => {
    await openBandSong(bandId, harbor, "Harbor lights are calling");
    await closedRow("a band song", ROW, SHEET, ["Rolling, with a heavy back beat.", "Bass: walk up on the last bar"]);
  });

  await check(NAMES.I7, async () => {
    await openBandSong(bandId, harbor, "Harbor lights are calling");
    assert.equal((await needRow("Harbor Song")).text, "Song info · 2 band notes", "a member with two notes sees the count");
    assert.equal(await outsideSheet("Bass: walk up on the last bar"), false, "no note sits above the sheet");
    assert.equal(await laidOut(SHEET, "Bass: walk up on the last bar"), false, "the notes are folded with the panel");
    await tapRow();
    const inside = await s.evaluate<{ strip: boolean; laid: boolean; text: string; expanded: string | null }>(`(() => { const row = ${ROW}, panel = document.getElementById(row.getAttribute("aria-controls")), strip = panel?.querySelector(".song-notes"); return { strip: !!strip, laid: !!strip && strip.getClientRects().length > 0, text: strip?.textContent ?? "", expanded: row.getAttribute("aria-expanded") }; })()`);
    assert.ok(inside.strip && inside.laid && inside.text.includes("Bass: walk up on the last bar"), `open, the band notes show inside the panel (${js(inside)})`);
    const texts = await panelTexts();
    assert.deepEqual(texts.slice(0, 4), ["Feel: Rolling, with a heavy back beat.", "How to play", "Keys hold the pad under the verse.", "Band notes"], `band notes come after the fields (${js(texts)})`);

    await openBandSong(bandId, oneNote, "Just a word tonight");
    assert.equal((await needRow("One Note Song, no fields and one note")).text, "Song info · 1 band note", "one note, no fields: the row shows");
    await tapRow();
    assert.equal(await laidOut(SHEET, "Count in from the drums"), true, "and holds the note");

    await openBandSong(bandId, quiet, "Soft and low tonight");
    assert.equal(await rowState(), null, "a member with no notes and no fields sees no row");

    await openBandSong(trio, trioSong, "Three of us tonight");
    assert.equal((await needRow("Trio Song, as its admin")).text, "Song info", "an admin with no notes and no fields sees the row");
    assert.equal(await s.evaluate<boolean>(`(() => { const add = ${button("Add a note", `document.getElementById("sheet-scroll")`)}; return !!add && ${SHEET}.contains(add); })()`), true, "Add a note is inside the sheet");
    await tapRow();
    const addInside = await s.evaluate<boolean>(`(() => { const row = ${ROW}, panel = document.getElementById(row.getAttribute("aria-controls")); const add = ${button("Add a note", "panel")}; return !!add && add.getClientRects().length > 0; })()`);
    assert.ok(addInside, "and Add a note is inside the open panel");
  });

  await check(NAMES.I7count, async () => {
    await openBandSong(trio, trioSong, "Three of us tonight");
    assert.equal((await needRow("Trio Song, as its admin")).text, "Song info", "no notes yet, no count");
    await tapRow();
    const panel = `document.getElementById(${ROW}.getAttribute("aria-controls"))`;
    const rowReads = (text: string, what: string) => app.until(`${ROW}?.textContent.trim() === ${js(text)}`, what, 8000);
    await tapButton("Add a note", panel);
    await s.evaluate(`${panel}.querySelector("textarea[aria-label='Note for the band']").focus()`);
    await s.send("Input.insertText", { text: "Count in from the bass" });
    await tapButton("Save note", panel);
    await rowReads("Song info · 1 band note", "the row's count after Save note");
    await tapButton("Delete", panel);
    await tapButton("Yes, delete", panel);
    await rowReads("Song info", "the row's count gone after Delete");
    assert.equal((await rowState())?.expanded, "true", "the panel stays open through both");
  });

  await check(NAMES.I14signal, async () => {
    await s.evaluate(`sessionStorage.setItem("check-fail-notes", "1")`);
    try {
      await openBandSong(bandId, harbor, "Harbor lights are calling");
      assert.equal((await needRow("Harbor Song with no signal for notes")).text, "Song info", "the row shows with no count");
      await tapRow();
      assert.equal(await laidOut(SHEET, "Rolling, with a heavy back beat."), true, "the panel shows the fields");
      assert.equal(await laidOut(SHEET, "Bass: walk up on the last bar"), false, "and no notes");
      assert.equal(await s.evaluate<boolean>(`!!document.querySelector("#sheet-scroll [role=alert], #sheet-scroll [aria-busy=true], #sheet-scroll [role=progressbar]")`), false, "no error and no waiting mark");
      assert.equal(await laidOut(`document.getElementById("sheet-scroll")`, "Loading"), false, "no Loading words");
      assert.equal(await laidOut(`document.getElementById("sheet-scroll")`, "Something went wrong"), false, "no error words");
    } finally {
      await s.evaluate(`sessionStorage.removeItem("check-fail-notes")`);
    }
  });

  assert.equal(setlist.status, 200, `Terry shares a setlist (${js(setlist.body)})`);
  const gig = await terry.call("/api/bands/gig/plan", { bandId, setlistId: setlist.body.setlistId, name: "Friday at Lou's", date: "2026-12-04" });
  assert.equal(gig.status, 200, `Terry plans a gig (${js(gig.body)})`);
  const gigId = gig.body.gig.gigId as string;
  await s.evaluate(`location.hash = ${js(`#/band/${bandId}?s=gigs`)}`);
  await app.until(
    `[...(document.querySelector(${js(`.band-page [data-gig="${gigId}"]`)})?.querySelectorAll(".gig-card-lineup li") ?? [])].some((li) => li.textContent.includes("Sam Rivera") && li.textContent.includes("Downloaded ✓"))`,
    "Sam's phone to hold the gig pack",
    20000,
  );

  await check(NAMES.I6gig, async () => {
    await s.evaluate(`location.hash = ${js(`#/gig/${bandId}/${gigId}/0`)}`);
    await app.until(`(${SHEET}?.textContent ?? "").includes("Harbor lights are calling")`, "Harbor Song in gig mode", 15000);
    await settle(1500);
    await closedRow("the gig sheet", ROW, SHEET, ["Rolling, with a heavy back beat.", "Bass: walk up on the last bar"]);
    await tapRow();
    assert.equal((await rowState())!.expanded, "true", "open on the gig sheet");
    await s.evaluate(`location.hash = ${js(`#/gig/${bandId}/${gigId}/1`)}`);
    await app.until(`(${SHEET}?.textContent ?? "").includes("Second verse rising")`, "the next gig song", 15000);
    await settle(500);
    await closedRow("the next gig song", ROW, SHEET, ["Lifted, a little faster."]);
  });

  await check(NAMES.I6search, async () => {
    await s.evaluate(`location.hash = "#/songs"`);
    await app.until(`!!document.querySelector("input[aria-label='Search songs']")`, "the search box");
    await s.evaluate(`document.querySelector("input[aria-label='Search songs']").focus()`);
    await s.send("Input.insertText", { text: "Harbor Song" });
    await app.until(`[...document.querySelectorAll("button.song-row")].some((b) => b.textContent.includes("Harbor Song"))`, "Harbor Song in the search", 10000);
    await s.evaluate(`[...document.querySelectorAll("button.song-row")].find((b) => b.textContent.includes("Harbor Song")).click()`);
    const opened = `document.querySelector(".search-open .sheet")`;
    try {
      await app.until(`!!${opened}`, "the band song from search");
      await settle(300);
      await closedRow("a band song opened from search", rowIn(opened), opened, ["Rolling, with a heavy back beat."]);
    } finally {
      await clearSearch();
    }
  });

  async function clearSearch() {
    await s.evaluate(`${button("Back", `document.querySelector(".search-open")`)}?.click()`);
    await s.evaluate(`(() => { const box = document.querySelector("input[aria-label='Search songs']"); if (!box) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(box, ""); box.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await settle(300);
  }

  await check(NAMES.I6import, async () => {
    const folder = mkdtempSync(join(tmpdir(), "check-song-info-"));
    const file = join(folder, "lantern-song.txt");
    writeFileSync(file, ["Lantern Song", "The Lantern Pines", "Key: G", "Capo: 2nd fret", "", "[Intro]", "| G | D | Em | C |", "", "[Verse 1]", "G           C", "Lanterns down the river", "Em          D", "Paper cranes along the shore", ""].join("\n"));
    await s.evaluate(`location.hash = "#/songs"`);
    await app.until(`!!${button("Import files")}`, "Import files");
    await s.evaluate(`${button("Import files")}.click()`);
    const sheet = `document.querySelector(".song-import")`;
    await app.until(`!!${sheet}?.querySelector("input[type=file]")`, "the import sheet");
    const { result } = await s.send("Runtime.evaluate", { expression: `document.querySelector(".song-import input[type=file]")` });
    await s.send("DOM.setFileInputFiles", { files: [file], objectId: result.objectId });
    await app.until(`document.querySelectorAll(".song-import-row").length === 1 && !["waiting", "reading"].includes(document.querySelector(".song-import-row").dataset.mark)`, "the file read", 15000);
    await s.evaluate(`document.querySelector(".song-import-row .song-import-open")?.click()`);
    const preview = `document.querySelector(".song-import .sheet")`;
    await app.until(`!!${preview}`, "the import preview");
    await settle(300);
    await closedRow("the import preview", rowIn(preview), preview, ["Capo 2"]);
    await s.evaluate(`${button("Close", sheet)}?.click()`);
    await settle(200);
    await s.evaluate(`${button("Leave", sheet)}?.click()`);
    await settle(200);
  });

  await check(NAMES.I15switch, async () => {
    const NOTES = ["Watch the push into the chorus", "Bass: walk up on the last bar"];
    const nothingOfSams = async (what: string) => {
      const row = await rowState();
      assert.ok(row === null || row.text === "Song info", `${what}: the row is absent or reads Song info (${js(row?.text)})`);
      for (const note of NOTES) assert.equal(await laidOut("document.body", note), false, `${what}: ${js(note)} is not on screen`);
      const kept = await s.evaluate<string>(`JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })`);
      for (const note of NOTES) assert.ok(!kept.includes(note), `${what}: ${js(note)} is not kept on the phone`);
    };
    const toSongs = async () => {
      await s.evaluate(`location.hash = "#/songs"`);
      await app.library();
    };
    const openHarborLink = async (what: string) => {
      await toSongs();
      await s.evaluate(`location.hash = ${js(`#/band/${bandId}/song/${harbor}`)}`);
      await settle(2500);
      await nothingOfSams(what);
      await toSongs();
    };

    await openBandSong(bandId, harbor, "Harbor lights are calling");
    assert.equal((await needRow("Harbor Song, Sam a member")).text, "Song info · 2 band notes", "Sam sees the count first");
    await tapRow();
    assert.equal(await laidOut(SHEET, NOTES[1]), true, "and the notes in the open panel");

    await toSongs();
    await app.openMenu();
    await app.pick("Account");
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "account"`, "the account screen");
    await app.click("Sign out");
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "start"`, "the sign-in screen");
    await app.click("✕");
    await app.closeMenu();
    await openHarborLink("signed out, Harbor Song's band link");

    await app.signUp("Pat Moreno");
    await openHarborLink("Pat, outside the band, Harbor Song's band link");

    assert.equal((await appCalls("/api/bands/join", { code })).status, 200, "Pat joins The Low Tides");
    await s.evaluate(`sessionStorage.setItem("check-fail-notes", "1")`);
    try {
      await openBandSong(bandId, harbor, "Harbor lights are calling");
      await nothingOfSams("Pat in the band, no signal for notes");
    } finally {
      await s.evaluate(`sessionStorage.removeItem("check-fail-notes")`);
    }
    await openBandSong(bandId, harbor, "Harbor lights are calling");
    assert.equal((await needRow("Harbor Song, Pat a member")).text, "Song info · 2 band notes", "with signal Pat's own reply brings the count");
  });

  await check("no page errors", async () => {
    const errors = await app.errors();
    assert.deepEqual(errors, [], `the page logged ${js(errors)}`);
  });
} catch (error) {
  failed += 1;
  console.log(`FAIL the check could not run: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
} finally {
  await site?.close();
  await api?.worker.dispose();
}

if (failed > 0) {
  console.log(`check:song-info: ${failed} failed`);
  process.exit(1);
}
console.log("check:song-info passed");
