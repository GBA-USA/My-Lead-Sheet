import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { appPage } from "./app-page.ts";
import { openSite, type Site } from "./chrome.ts";

/**
 * Song start panel: a sheet with no words shows one panel with the three ways to finish it: web search, paste what
 * was copied (in the editor's short layout), or Learn this song. Cases S1 to S11 match docs/PLAN-song-search-layers.md
 * sections 4 and 5.3. Every chart here is written for this check with made-up words.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const js = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

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

const endpoints = JSON.parse(readFileSync(join(root, "data", "song-search.json"), "utf8")) as {
  chartSearch: string;
  recordingSearch: string;
};
const SEARCH_BASE = endpoints.chartSearch;

type SongSearchMod = {
  chordsSearchUrl?: (title: string, artist: string) => string;
  lyricsSearchUrl?: (title: string, artist: string) => string;
  chartSearchUrl?: (title: string, artist: string) => string;
};

let searchMod: SongSearchMod | null = null;
try {
  const bundle = await build({
    entryPoints: [join(root, "src", "song-search.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  searchMod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
} catch (error) {
  console.log(`FAIL src/song-search.ts loads: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  failed += 1;
}

// ---------------------------------------------------------------------------------------------- S1 (unit)

await check("S1. chordsSearchUrl and lyricsSearchUrl build general web search URLs from data/song-search.json, leaving out blank fields", () => {
  assert.ok(searchMod, "src/song-search.ts loaded");
  assert.equal(typeof searchMod.chordsSearchUrl, "function", "chordsSearchUrl is exported");
  assert.equal(typeof searchMod.lyricsSearchUrl, "function", "lyricsSearchUrl is exported");
  const { chordsSearchUrl, lyricsSearchUrl } = searchMod;
  assert.equal(chordsSearchUrl("Paper Boats", "The Hollow Pines"), SEARCH_BASE + encodeURIComponent('"Paper Boats" "The Hollow Pines" chords'));
  assert.equal(chordsSearchUrl("Paper Boats", ""), SEARCH_BASE + encodeURIComponent('"Paper Boats" chords'), "blank artist left out");
  assert.equal(chordsSearchUrl("", "The Hollow Pines"), SEARCH_BASE + encodeURIComponent('"The Hollow Pines" chords'), "blank title left out");
  assert.equal(chordsSearchUrl("  ", "   "), SEARCH_BASE + encodeURIComponent("chords"), "both blank");
  assert.equal(lyricsSearchUrl("Paper Boats", "The Hollow Pines"), SEARCH_BASE + encodeURIComponent('"Paper Boats" "The Hollow Pines" lyrics'));
  assert.equal(lyricsSearchUrl("Paper Boats", ""), SEARCH_BASE + encodeURIComponent('"Paper Boats" lyrics'), "lyrics blank artist left out");
  assert.equal(lyricsSearchUrl("", "The Hollow Pines"), SEARCH_BASE + encodeURIComponent('"The Hollow Pines" lyrics'), "lyrics blank title left out");
  assert.ok(!/site(:|%3A)/i.test(chordsSearchUrl("Paper Boats", "The Hollow Pines")), "general search, never site-restricted");
});

// ---------------------------------------------------------------------------------------------- Screen cases (S2 to S10)

const CHART_PASTE = [
  "Key: G",
  "Tempo: 120 bpm",
  "Capo: 2nd fret",
  "",
  "[Intro]",
  "| G | D | Em | C |",
  "",
  "[Verse 1]",
  "G           C(add9)",
  "Paper boats on the river",
  "Em          D",
  "Rain on the window pane",
  "",
  "[Chorus]",
  "C           G*",
  "Float away, float away",
  "D        Em",
  "Into the morning light",
].join("\n");

const WORDS_ONLY = [
  "Paper boats on the river",
  "Rain on the window pane",
  "",
  "Float away, float away",
  "Into the morning light",
].join("\n");

const HEADERS_ONLY = "Key: G\nTempo: 120 bpm";

const STAND_INS = `(() => {
  window.__calls = [];
  window.__opened = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, location.href);
    if (url.origin === location.origin) return realFetch(input, init);
    window.__calls.push(url.href);
    return Promise.resolve(new Response(JSON.stringify({ created: "2026-11-26T00:00:00.000Z", count: 0, offset: 0, recordings: [] }), { status: 200, headers: { "content-type": "application/json" } }));
  };
  window.open = (url) => { window.__opened.push(String(url)); return null; };
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => ({ getTracks: () => [{ stop() {} }] }) });
  AudioContext.prototype.createMediaStreamSource = () => ({ connect() {} });
  AudioContext.prototype.createScriptProcessor = function () {
    return (window.__mic = { rate: this.sampleRate, connect() {}, onaudioprocess: null });
  };
  window.__playSong = (parts) => {
    const { rate } = window.__mic;
    const beat = 0.5;
    const beats = parts * 8 * 4;
    const samples = new Float32Array(Math.round((2 + beats * beat + 2) * rate));
    for (let k = 0; k < beats; k++) {
      const from = Math.round((2 + k * beat) * rate);
      const loud = [0.2, 0.5, 0.3, 0.6][Math.floor(k / 32) % 4];
      for (let i = 0; i < 0.3 * rate; i++) samples[from + i] += loud * Math.sin((2 * Math.PI * 60 * i) / rate) * Math.exp(-i / (0.08 * rate));
    }
    for (let at = 0; at < samples.length; at += 4096) {
      const chunk = samples.subarray(at, at + 4096);
      window.__mic.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } });
    }
  };
})();`;

const ACCOUNT = { userId: "u_song_start", handle: "pat", displayName: "Pat Bass", ways: [] };

const api = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  response.writeHead(path === "/api/me" ? 200 : 404, { "content-type": "application/json" });
  response.end(js(path === "/api/me" ? { account: ACCOUNT } : { error: "not-found" }));
});
await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
const apiAddress = api.address();
const apiBase = `http://127.0.0.1:${typeof apiAddress === "object" && apiAddress ? apiAddress.port : 0}`;

const SCREEN_NAMES = [
  "S2. own empty song shows start panel with No words yet and four controls (also signed out); built-in and band copy show none; blank title/artist hides web links",
  "S3. Find chords on the web and Find lyrics on the web link to S1 URLs in a new tab and send no network request",
  "S4. Paste what you copied opens short layout with status line and headings; Cancel keeps song unchanged; storage error stays open; Save shows chart and hides panel",
  "S5. clipboard refused opens full editor with Paste your sheet into the box.; empty-after-cleaning paste opens full editor with raw text",
  "S6. Edit text in short layout shows full editor with cleaned chart in box",
  "S7. song at 152 BPM shows chip for 76; one tap sets 76 on sheet and on metronome",
  "S8. song with bar rows and no words shows short line; paste of words alone offers Add below the chart and bar rows stay",
  "S9. plan section 4 cases 1 to 4: Learn this song opens one LearnChooser, tempo row updates sheet BPM, one-copy guards helpers, listen review lists pasted headings",
  "S10. at 360 px and 390 px every control in panel and short layout is at least 44 px tall and not clipped",
];

let site: Site | null = null;
try {
  site = await openSite(root, "check-song-start", () => apiBase);
} catch (error) {
  for (const name of SCREEN_NAMES) {
    failed += 1;
    console.log(`FAIL ${name}: app or Chrome did not start (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
  }
}

if (site) {
  const s = site;
  try {
    const app = await appPage(s);
    await s.send("Page.addScriptToEvaluateOnNewDocument", { source: STAND_INS });
    const HEIGHT = 780;
    const phone = async (width: number) => {
      await s.send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: 2, mobile: true });
      await s.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`);
    };

    const PANEL = `document.querySelector("#sheet-scroll .song-search-start")`;
    const EDITOR = `document.querySelector(".song-editor[role=dialog]")`;
    const DIALOG = `document.querySelector("[role=dialog]")`;
    const controlIn = (scope: string, label: string) =>
      `[...(${scope}?.querySelectorAll("a, button") ?? [])].find((el) => el.textContent.trim() === ${js(label)})`;
    const chipContaining = (scope: string, text: string) =>
      `[...(${scope}?.querySelectorAll("button") ?? [])].find((el) => el.textContent.includes(${js(text)}))`;
    const clipboard = (value: string | null) =>
      s.evaluate(
        `Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: () => ${
          value === null ? `Promise.reject(new DOMException("Denied", "NotAllowedError"))` : `Promise.resolve(${js(value)})`
        } } })`,
      );
    const seedSong = async (song: Record<string, unknown>) => {
      await s.evaluate(`(() => {
        const lib = JSON.parse(localStorage.getItem("leadSheetsLibrary") || "{}");
        lib.songs = (lib.songs || []).filter((each) => each.id !== ${js(song.id)});
        lib.songs.push(${js(song)});
        lib.lastSongId = Math.max(lib.lastSongId || 0, ${js(song.id)});
        localStorage.setItem("leadSheetsLibrary", JSON.stringify(lib));
      })()`);
    };
    const blankSong = (id: number, overrides: Record<string, unknown> = {}) => ({
      id,
      title: "Paper Boats",
      artist: "The Hollow Pines",
      keyLabel: "C major",
      keyRoot: "C",
      keyMode: "major",
      keyNote: "",
      tempo: null,
      tempoNote: "",
      timeSignature: "4/4",
      officialRuntimeSec: 210,
      feel: "",
      sourceNote: "",
      atAGlance: "",
      howToPlay: "",
      practiceTip: "",
      bassNotes: [],
      body: [],
      ...overrides,
    });
    const openSong = async (id: number) => {
      await s.evaluate(`location.hash = "#/songs"`);
      await sleep(100);
      await s.evaluate(`location.hash = ${js(`#/song/${id}`)}`);
      await app.until(`!!document.querySelector(".sheet .sheet-name") && location.hash === ${js(`#/song/${id}`)}`, `song ${id}`);
      await sleep(150);
    };
    type Box = { left: number; right: number; top: number; bottom: number; h: number; w: number; clipped: boolean; inner: number; page: number };
    const glove = async (expression: string, what: string, width: number) => {
      const box = await s.evaluate<Box | null>(`(() => {
        const el = ${expression};
        if (!el || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, h: r.height, w: r.width, clipped: el.scrollWidth > el.clientWidth + 1, inner: innerWidth, page: document.documentElement.scrollWidth };
      })()`);
      assert.ok(box, `${what} is visible at ${width} px`);
      assert.ok(box.h >= 44, `${what} is ${box.h.toFixed(1)} px tall at ${width} px (needs >= 44)`);
      assert.ok(box.left >= 0 && box.right <= box.inner + 0.5, `${what} runs ${box.left.toFixed(1)}..${box.right.toFixed(1)} in ${box.inner} px`);
      assert.ok(box.top >= 0 && box.bottom <= HEIGHT + 0.5, `${what} is on screen (${box.top.toFixed(1)}..${box.bottom.toFixed(1)})`);
      assert.ok(!box.clipped, `${what} is not clipped at ${width} px`);
      assert.ok(box.page <= box.inner + 0.5, `page does not scroll sideways at ${width} px (${box.page} > ${box.inner})`);
    };

    await phone(390);
    await s.send("Page.navigate", { url: `${s.origin}/#/songs` });
    await app.library();

    // Seed songs into localStorage (while signed out first to also prove signed-out operation!)
    await seedSong(blankSong(501));
    await seedSong(blankSong(502, { title: "Band Copy Song", copy: { id: "copy-band-502", canSendOn: true } }));
    await seedSong(blankSong(503, { title: "", artist: "" }));
    await seedSong(blankSong(504, { title: "Half Time Song", tempo: 152 }));
    await seedSong(
      blankSong(505, {
        title: "Chords Only Song",
        artist: "The Hollow Pines",
        tempo: 108,
        body: [
          { heading: "INTRO", lines: [{ bars: "| G | D | Em | C |" }] },
          { heading: "VERSE 1", lines: [{ bars: "| G | C | D | G |" }] },
        ],
      }),
    );
    await seedSong(blankSong(506, { title: "Clipboard Refused Song" }));
    await seedSong(blankSong(507, { title: "Edit Text Song" }));
    await seedSong(blankSong(508, { title: "Learn Seam Song" }));
    await s.send("Page.reload");
    await app.library();

    await check(SCREEN_NAMES[0], async () => {
      // Signed out: own empty song shows the start panel with No words yet and all 4 controls
      await openSong(501);
      await app.until(`!!${PANEL}`, "start panel on own empty song (signed out)");
      const text = await s.evaluate<string>(`${PANEL}.textContent ?? ""`);
      assert.ok(text.includes("No words yet"), `panel says No words yet (${js(text)})`);
      assert.ok(text.includes("Listen to set the tempo and the length."), `panel carries exact listen line (${js(text)})`);
      for (const label of ["Find chords on the web", "Find lyrics on the web", "Paste what you copied", "Learn this song"]) {
        assert.ok(await s.evaluate<boolean>(`!!${controlIn(PANEL, label)}`), `panel has ${label}`);
      }
      // Built-in song shows no panel
      await openSong(10);
      assert.equal(await s.evaluate<boolean>(`!!${PANEL}`), false, "built-in song shows no panel");
      // Copy from a band (even with empty body) shows no panel
      await openSong(502);
      assert.equal(await s.evaluate<boolean>(`!!${PANEL}`), false, "band copy shows no panel");
      // Song with no title and no artist shows panel without the two web links
      await openSong(503);
      await app.until(`!!${PANEL}`, "start panel on song with no title/artist");
      assert.equal(await s.evaluate<boolean>(`!!${controlIn(PANEL, "Find chords on the web")}`), false, "no Find chords link without title/artist");
      assert.equal(await s.evaluate<boolean>(`!!${controlIn(PANEL, "Find lyrics on the web")}`), false, "no Find lyrics link without title/artist");
      assert.ok(await s.evaluate<boolean>(`!!${controlIn(PANEL, "Paste what you copied")}`), "Paste what you copied still present");
      assert.ok(await s.evaluate<boolean>(`!!${controlIn(PANEL, "Learn this song")}`), "Learn this song still present");
    });

    await check(SCREEN_NAMES[1], async () => {
      await openSong(501);
      await app.until(`!!${PANEL}`, "start panel");
      const chords = await s.evaluate<{ tag: string; href: string; target: string; rel: string } | null>(
        `(() => { const el = ${controlIn(PANEL, "Find chords on the web")}; return el ? { tag: el.tagName, href: el.href, target: el.target, rel: el.rel } : null; })()`,
      );
      const lyrics = await s.evaluate<{ tag: string; href: string; target: string; rel: string } | null>(
        `(() => { const el = ${controlIn(PANEL, "Find lyrics on the web")}; return el ? { tag: el.tagName, href: el.href, target: el.target, rel: el.rel } : null; })()`,
      );
      assert.ok(chords && chords.tag === "A", "Find chords on the web is an <a> link");
      assert.equal(chords.href, SEARCH_BASE + encodeURIComponent('"Paper Boats" "The Hollow Pines" chords'));
      assert.equal(chords.target, "_blank");
      assert.ok(chords.rel.includes("noopener"), "rel includes noopener");
      assert.ok(lyrics && lyrics.tag === "A", "Find lyrics on the web is an <a> link");
      assert.equal(lyrics.href, SEARCH_BASE + encodeURIComponent('"Paper Boats" "The Hollow Pines" lyrics'));
      assert.equal(lyrics.target, "_blank");
      const before = await s.evaluate<number>(`window.__calls.length`);
      // Tap link while preventing actual tab navigation in headless Chrome, verify zero fetch requests leave page
      await s.evaluate(`(() => {
        const el = ${controlIn(PANEL, "Find chords on the web")};
        el.addEventListener("click", (e) => e.preventDefault(), { once: true });
        el.click();
      })()`);
      await sleep(200);
      assert.equal(await s.evaluate<number>(`window.__calls.length`), before, "tapping Find chords on the web sends no request");
    });

    await check(SCREEN_NAMES[2], async () => {
      await openSong(501);
      await app.until(`!!${PANEL}`, "start panel");
      await clipboard(CHART_PASTE);
      await s.evaluate(`${controlIn(PANEL, "Paste what you copied")}.click()`);
      await app.until(`!!${EDITOR}`, "short paste editor opens");
      // Short layout: textarea is NOT shown, status line and preview headings ARE shown, Save and Edit text exist
      const textareaVisible = await s.evaluate<boolean>(`!!document.querySelector(".song-editor textarea")?.getClientRects().length`);
      assert.equal(textareaVisible, false, "textarea is folded away in short layout");
      const status = await s.evaluate<string>(`document.querySelector(".song-editor [role=status]")?.textContent ?? ""`);
      assert.ok(status.includes("Found"), `status line says what was found (${js(status)})`);
      assert.deepEqual(await app.texts(".song-editor-preview .chart-heading"), ["INTRO", "VERSE 1", "CHORUS"], "preview draws the headings");
      assert.ok(await s.evaluate<boolean>(`!!${controlIn(EDITOR, "Save")}`), "short layout has Save");
      assert.ok(await s.evaluate<boolean>(`!!${controlIn(EDITOR, "Edit text")}`), "short layout has Edit text");
      assert.ok(await s.evaluate<boolean>(`!!${controlIn(EDITOR, "Cancel")}`), "short layout has Cancel");

      // Cancel changes nothing on the song
      await s.evaluate(`${controlIn(EDITOR, "Cancel")}.click()`);
      await app.until(`!${EDITOR}`, "editor closes on Cancel");
      assert.ok(await s.evaluate<boolean>(`!!${PANEL}`), "panel still visible after Cancel");
      assert.equal(await s.evaluate<number>(`document.querySelectorAll(".sheet .chart-heading").length`), 0, "song chart still empty after Cancel");

      // Re-open short layout, test storage failure on Save keeps layout open with landed message
      await s.evaluate(`${controlIn(PANEL, "Paste what you copied")}.click()`);
      await app.until(`!!${EDITOR}`, "short paste editor re-opens");
      await s.evaluate(`(() => {
        window.__realSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          if (k === "leadSheetsLibrary") throw new DOMException("full", "QuotaExceededError");
          return window.__realSetItem.call(this, k, v);
        };
      })()`);
      try {
        await s.evaluate(`${controlIn(EDITOR, "Save")}.click()`);
        await app.until(`!!document.querySelector(".song-editor [role=alert]")`, "storage refusal alert");
        const alert = await app.text(".song-editor [role=alert]");
        assert.equal(alert, "This phone couldn't save the song. Free some space and try again.");
        assert.ok(await s.evaluate<boolean>(`!!${EDITOR}`), "short layout stays open on storage failure");
      } finally {
        await s.evaluate(`if (window.__realSetItem) Storage.prototype.setItem = window.__realSetItem`);
      }

      // Now Save succeeds: chart appears on sheet and panel is gone
      await s.evaluate(`${controlIn(EDITOR, "Save")}.click()`);
      await app.until(`!${EDITOR}`, "editor closes on Save");
      await app.until(`document.querySelectorAll(".sheet .chart-heading").length === 3`, "saved chart headings on sheet");
      assert.deepEqual(await app.texts(".sheet .chart-heading"), ["INTRO", "VERSE 1", "CHORUS"]);
      assert.equal(await s.evaluate<boolean>(`!!${PANEL}`), false, "panel is gone after Save");
    });

    await check(SCREEN_NAMES[3], async () => {
      await openSong(506);
      await app.until(`!!${PANEL}`, "start panel");
      await clipboard(null);
      await s.evaluate(`${controlIn(PANEL, "Paste what you copied")}.click()`);
      await app.until(`!!${EDITOR}`, "full editor opens on refused clipboard");
      const textareaVisible = await s.evaluate<boolean>(`!!document.querySelector(".song-editor textarea")?.getClientRects().length`);
      assert.equal(textareaVisible, true, "full editor shows textarea");
      const editorText = await s.evaluate<string>(`${EDITOR}.textContent ?? ""`);
      assert.ok(editorText.includes("Paste your sheet into the box."), `editor says fallback message (${js(editorText)})`);
      await s.evaluate(`${controlIn(EDITOR, "Cancel")}.click()`);
      await app.until(`!${EDITOR}`, "editor closes");

      // Paste that leaves nothing after cleaning opens full editor with raw text
      await clipboard(HEADERS_ONLY);
      await s.evaluate(`${controlIn(PANEL, "Paste what you copied")}.click()`);
      await app.until(`!!${EDITOR}`, "full editor opens for empty-after-cleaning paste");
      assert.equal(await s.evaluate<boolean>(`!!document.querySelector(".song-editor textarea")?.getClientRects().length`), true, "full editor textarea shown");
      assert.equal(await s.evaluate<string>(`document.querySelector(".song-editor textarea").value`), HEADERS_ONLY, "raw text is in the box");
      await s.evaluate(`${controlIn(EDITOR, "Cancel")}.click()`);
      await app.until(`!${EDITOR}`, "editor closes");
    });

    await check(SCREEN_NAMES[4], async () => {
      await openSong(507);
      await app.until(`!!${PANEL}`, "start panel");
      await clipboard(CHART_PASTE);
      await s.evaluate(`${controlIn(PANEL, "Paste what you copied")}.click()`);
      await app.until(`!!${EDITOR}`, "short layout opens");
      await s.evaluate(`${controlIn(EDITOR, "Edit text")}.click()`);
      await app.until(`!!document.querySelector(".song-editor textarea")?.getClientRects().length`, "full editor textarea appears");
      const boxVal = await s.evaluate<string>(`document.querySelector(".song-editor textarea").value`);
      assert.ok(boxVal.includes("VERSE 1") && boxVal.includes("CHORUS") && !boxVal.includes("Capo:"), `box holds cleaned chart (${js(boxVal)})`);
      await s.evaluate(`${controlIn(EDITOR, "Cancel")}.click()`);
      await app.until(`!${EDITOR}`, "editor closes");
    });

    await check(SCREEN_NAMES[5], async () => {
      await openSong(504);
      await app.until(`!!${PANEL}`, "start panel on 152 BPM song");
      assert.ok((await app.text(".sheet .meta")).includes("152"), "sheet starts at 152 bpm");
      const chip76 = chipContaining(PANEL, "76");
      assert.ok(await s.evaluate<boolean>(`!!${chip76}`), "panel shows a chip for 76");
      await s.evaluate(`${chip76}.click()`);
      await app.until(`(document.querySelector(".sheet .meta")?.textContent ?? "").includes("76")`, "sheet updates to 76 bpm");
      // Check metronome follows to 76
      await s.evaluate(`document.querySelector(".controls .metronome-pill").click()`);
      await app.until(`!!document.querySelector('input[aria-label="Metronome speed in bpm"]')`, "metronome sheet opens");
      const metroBpm = await s.evaluate<string>(`document.querySelector('input[aria-label="Metronome speed in bpm"]').value`);
      assert.equal(metroBpm, "76", "metronome updated to 76");
      await s.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      await app.until(`!document.querySelector('input[aria-label="Metronome speed in bpm"]')`, "metronome sheet closes");
    });

    await check(SCREEN_NAMES[6], async () => {
      await openSong(505);
      await app.until(`!!${PANEL}`, "short line on chords-only song");
      assert.ok(await s.evaluate<boolean>(`!!${controlIn(PANEL, "Find lyrics on the web")}`), "short line has Find lyrics on the web");
      assert.ok(await s.evaluate<boolean>(`!!${controlIn(PANEL, "Paste what you copied")}`), "short line has Paste what you copied");
      assert.equal(await s.evaluate<boolean>(`!!${controlIn(PANEL, "Find chords on the web")}`), false, "short line omits Find chords on the web");

      await clipboard(WORDS_ONLY);
      await s.evaluate(`${controlIn(PANEL, "Paste what you copied")}.click()`);
      await app.until(`!!${EDITOR}`, "short layout opens for words-only paste");
      const addBelow = controlIn(EDITOR, "Add below the chart");
      assert.ok(await s.evaluate<boolean>(`!!${addBelow}`), "short layout offers Add below the chart");
      await s.evaluate(`${addBelow}.click()`);
      await app.until(`!${EDITOR}`, "editor closes");
      await app.until(`(document.querySelector(".sheet")?.textContent ?? "").includes("Paper boats on the river")`, "pasted words show on sheet");
      const bars = await app.texts(".sheet .bars");
      assert.ok(bars.some((b) => b.includes("| G | D | Em | C |")), `bar rows stayed (${js(bars)})`);
      assert.ok(bars.some((b) => b.includes("| G | C | D | G |")), `second bar row stayed (${js(bars)})`);
      assert.equal(await s.evaluate<boolean>(`!!${PANEL}`), false, "short line is gone once words are added");
    });

    await check(SCREEN_NAMES[7], async () => {
      // Plan section 4 case 1: Learn this song opens the dialog titled Learn this song, and the page holds one such dialog
      await openSong(508);
      await app.until(`!!${PANEL}`, "start panel");
      await s.evaluate(`${controlIn(PANEL, "Learn this song")}.click()`);
      await app.until(`${DIALOG}?.querySelector("h2")?.textContent === "Learn this song"`, "Learn this song dialog opens");
      const count = await s.evaluate<number>(
        `[...document.querySelectorAll("[role=dialog]")].filter((d) => d.querySelector("h2")?.textContent?.trim() === "Learn this song").length`,
      );
      assert.equal(count, 1, "page holds exactly one Learn this song dialog");

      // Plan section 4 case 2: chooser opened from panel sets BPM through its tempo row, and sheet shows new BPM
      await app.click("Find BPM", DIALOG);
      await app.until(`!!document.querySelector('[role=group][aria-label="Find BPM"]')`, "Find BPM panel opens");
      await app.click("Tap tempo", DIALOG);
      await app.until(`!!document.querySelector('button[aria-label="Tap the beat"]')`, "Tap tempo opens");
      // Tap 4 times 500ms apart -> ~120 BPM
      for (let i = 0; i < 4; i += 1) {
        if (i > 0) await sleep(500);
        await s.evaluate(`document.querySelector('button[aria-label="Tap the beat"]').click()`);
      }
      await app.until(`!!document.querySelector('.bpm-choices button.is-suggested')`, "suggested BPM choice appears");
      const chosen = await s.evaluate<string>(`document.querySelector('.bpm-choices button.is-suggested strong').textContent.trim()`);
      await s.evaluate(`document.querySelector('.bpm-choices button.is-suggested').click()`);
      await app.until(`!${DIALOG}`, "chooser closes after picking BPM");
      await app.until(`(document.querySelector(".sheet .meta")?.textContent ?? "").includes(${js(chosen)})`, `sheet shows new BPM ${chosen}`);

      // Plan section 4 case 3: check-one-copy guards lyricsSearchUrl, readPaste, and LearnChooser
      const oneCopySrc = readFileSync(join(root, "scripts", "check-one-copy.ts"), "utf8");
      for (const symbol of ["lyricsSearchUrl", "readPaste", "LearnChooser"]) {
        assert.ok(oneCopySrc.includes(symbol), `scripts/check-one-copy.ts guards ${symbol}`);
      }

      // Plan section 4 case 4: on a sheet with a pasted chart, landed listen review lists that chart's headings
      await openSong(501); // song 501 has the saved pasted chart (INTRO, VERSE 1, CHORUS) from S4!
      await app.until(`document.querySelectorAll(".sheet .chart-heading").length === 3`, "pasted chart on song 501");
      await s.evaluate(`document.querySelector('[aria-label="Scroll settings"]').click()`);
      await app.until(`!!${DIALOG}`, "Scroll sheet opens");
      await app.click("Learn this song", DIALOG);
      await app.until(`${DIALOG}?.querySelector("h2")?.textContent === "Learn this song"`, "Learn chooser opens");
      await s.evaluate(`document.querySelector('[role=dialog] button[aria-label="Learn by listen"]').click()`);
      await app.until(`!!document.querySelector(".learn")`, "LearnSong dialog opens");
      await s.evaluate(`document.querySelector('.learn button[aria-label="Listen with the mic"]').click()`);
      await app.until(`!!window.__mic`, "stand-in mic started");
      await s.evaluate(`window.__playSong(3)`);
      await app.click("Stop", `document.querySelector(".learn")`);
      await app.until(`!!document.querySelector(".learn-sections")`, "listen review appears", 15000);
      const reviewHeadings = await app.texts(".learn-sections .learn-heading");
      assert.deepEqual(reviewHeadings, ["INTRO", "VERSE 1", "CHORUS"], `listen review lists pasted chart headings (${js(reviewHeadings)})`);
      await app.click("Cancel", `document.querySelector(".learn")`);
      await app.until(`!document.querySelector(".learn")`, "LearnSong closes");
    });

    await check(SCREEN_NAMES[8], async () => {
      // Seed fresh chords-only song (505 already had words saved in S8)
      await seedSong(
        blankSong(509, {
          title: "Layout Chords Only",
          artist: "The Hollow Pines",
          tempo: 152,
          body: [{ heading: "INTRO", lines: [{ bars: "| G | C | D | G |" }] }],
        }),
      );
      await s.evaluate(`location.hash = "#/songs"`);
      await s.send("Page.reload");
      await app.library();

      for (const width of [360, 390]) {
        await phone(width);
        // 1. Full start panel with BPM chip (song 504 -> reset to 152 or use 508/510)
        await openSong(508);
        await app.until(`!!${PANEL}`, `panel at ${width} px`);
        for (const label of ["Find chords on the web", "Find lyrics on the web", "Paste what you copied", "Learn this song"]) {
          await glove(controlIn(PANEL, label), `panel ${label}`, width);
        }
        // Check BPM chip in panel (508 now has BPM from S9, or check 509's 76 chip)
        await openSong(509);
        await app.until(`!!${PANEL}`, `short line at ${width} px`);
        for (const label of ["Find lyrics on the web", "Paste what you copied"]) {
          await glove(controlIn(PANEL, label), `chords-only ${label}`, width);
        }
        await glove(chipContaining(PANEL, "76"), "BPM 76 chip", width);

        // 2. Short paste layout controls (with capo + chips + Cancel + Edit text + Save)
        await openSong(508);
        await app.until(`!!${PANEL}`, `panel for short layout at ${width} px`);
        await clipboard(CHART_PASTE);
        await s.evaluate(`${controlIn(PANEL, "Paste what you copied")}.click()`);
        await app.until(`!!${EDITOR}`, `short layout at ${width} px`);
        const controls = await s.evaluate<string[]>(`[...${EDITOR}.querySelectorAll("button, a")].filter((el) => el.getClientRects().length > 0).map((el) => el.textContent.trim())`);
        assert.ok(controls.includes("Save") && controls.includes("Edit text") && controls.includes("Cancel"), `short layout has Save, Edit text, Cancel (${js(controls)})`);
        for (const label of controls) {
          await glove(controlIn(EDITOR, label), `short layout ${label}`, width);
        }
        await s.evaluate(`${controlIn(EDITOR, "Cancel")}.click()`);
        await app.until(`!${EDITOR}`, "editor closes");
      }
      await phone(390);
    });
  } finally {
    await s.close();
  }
}
api.close();

// ---------------------------------------------------------------------------------------------- S11 (one-copy, line count, hygiene)

await check("S11. check:one-copy passes with src/App.tsx <= 500 lines and src/song-start.tsx has no outside URLs or internal labels", () => {
  assert.ok(existsSync(join(root, "src", "song-start.tsx")), "src/song-start.tsx exists");
  const startSrc = readFileSync(join(root, "src", "song-start.tsx"), "utf8");
  assert.ok(!/https?:\/\//i.test(startSrc), "src/song-start.tsx has no outside URL");
  assert.ok(!/\b(musicbrainz|acousticbrainz|impeccable|gemini)\b/i.test(startSrc), "src/song-start.tsx has no internal names");
  const appLines = readFileSync(join(root, "src", "App.tsx"), "utf8").split("\n").length;
  assert.ok(appLines <= 500, `src/App.tsx has ${appLines} lines (limit 500)`);
  const oneCopySrc = readFileSync(join(root, "scripts", "check-one-copy.ts"), "utf8");
  for (const symbol of ["lyricsSearchUrl", "readPaste", "LearnChooser"]) {
    assert.ok(oneCopySrc.includes(symbol), `scripts/check-one-copy.ts guards ${symbol}`);
  }
  execFileSync(process.execPath, ["--experimental-strip-types", join(root, "scripts", "check-one-copy.ts")], { cwd: root, stdio: "pipe" });
});

if (failed > 0) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
