import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Song } from "../src/types.ts";
import { appPage } from "./app-page.ts";
import { openSite, type Site } from "./chrome.ts";

/**
 * View pill and finger-sized rows: cases V1 to V13 and guard G1.
 * Drives the built app in headless Chrome at 360 px and 390 px wide using made-up songs
 * seeded through the real ChordPro storage path (`songToStored`).
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.VIEW_PILL_SHOTS;
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

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

function parseColor(css: string): Rgba | null {
  const m = /rgba?\(([^)]+)\)/.exec(css || "");
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return null;
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Bundle src/storage.ts so made-up songs go through the real ChordPro writer (`songToStored`).
const storageBundle = await build({
  entryPoints: [join(root, "src", "storage.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  loader: { ".json": "json" },
  logLevel: "silent",
});
const storageMod = (await import(
  `data:text/javascript;base64,${Buffer.from(storageBundle.outputFiles[0].text).toString("base64")}`
)) as typeof import("../src/storage.ts");

const VERSE_CHORDS_1 = "A              F#m";
const VERSE_LYRICS_1 = "Cedar creek is running cold";
const VERSE_CHORDS_2 = "D             E";
const VERSE_LYRICS_2 = "Silver moon above the bend";
const INTRO_BARS = "| A | F#m | D | E |";

const makeSections = () => [
  { heading: "INTRO", lines: [{ bars: INTRO_BARS }] },
  ...Array.from({ length: 8 }, (_, i) => ({
    heading: `VERSE ${i + 1}`,
    lines: [
      { chords: VERSE_CHORDS_1, lyrics: VERSE_LYRICS_1 },
      { chords: VERSE_CHORDS_2, lyrics: VERSE_LYRICS_2 },
    ],
  })),
];

function madeUpSong(id: number, overrides: Partial<Omit<Song, "ref" | "id">> = {}): Omit<Song, "ref"> {
  return {
    id,
    title: "Cedar Creek",
    artist: "The Gravel Roads",
    keyLabel: "A major",
    keyRoot: "A",
    keyMode: "major",
    keyNote: "",
    tempo: 112,
    tempoNote: "",
    timeSignature: "4/4",
    officialRuntimeSec: 210,
    feel: "",
    sourceNote: "",
    atAGlance: "",
    howToPlay: "",
    practiceTip: "",
    body: makeSections(),
    ...overrides,
  };
}

const STORED_SONGS = [
  storageMod.songToStored(madeUpSong(701)),
  storageMod.songToStored(madeUpSong(702, { title: "Cedar Creek (Acoustic)" })),
  storageMod.songToStored(
    madeUpSong(703, {
      title: "Pine Ridge Jam",
      body: [
        { heading: "INTRO", lines: [{ bars: INTRO_BARS }] },
        { heading: "CHORUS", lines: [{ bars: "| D | E | A | F#m |" }] },
      ],
    }),
  ),
  storageMod.songToStored(
    madeUpSong(704, {
      title: "Long Key Song",
      keyLabel: "A major (practice version — capo 2)",
    }),
  ),
];

const STORED_SETLISTS = [
  { id: 71, name: "Empty Set", songIds: [] as number[] },
  { id: 72, name: "Friday Acoustic", songIds: [701] },
];

const CASE_NAMES = [
  "G1 guard",
  "V1 labels",
  "V2 a real radio group",
  "V3 keys",
  "V4 each view draws what it should",
  "V5 stored values unchanged",
  "V6 one line, equal parts",
  "V7 finger-sized parts",
  "V8 one label map",
  "V9 menu rows",
  "V10 Live link",
  "V11 themes",
  "V12 folded bar",
  "V13 instant theme switch",
  "V14 long key label",
];

let site: Site | null = null;
try {
  site = await openSite(root, "check-view-pill");
} catch (error) {
  for (const name of CASE_NAMES) {
    failed += 1;
    console.log(`FAIL ${name}: app or Chrome did not start (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
  }
}

if (site) {
  const s = site;
  try {
    const app = await appPage(s);
    const HEIGHT = 780;
    const painted = () => s.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`);
    const phone = async (width: number) => {
      await s.send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: 2, mobile: true });
      await painted();
    };
    const shoot = async (name: string) => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true });
      await app.shot(join(shots, `${name}.png`));
    };
    const openSong = async (id: number) => {
      await s.evaluate(`location.hash = "#/songs"`);
      await sleep(80);
      await s.evaluate(`location.hash = ${js(`#/song/${id}`)}`);
      await app.until(`!!document.querySelector(".sheet .sheet-name") && !!document.querySelector(".controls .notes-switch") && location.hash === ${js(`#/song/${id}`)}`, `song ${id}`);
      await s.evaluate(`document.fonts.ready.then(() => true)`);
      await painted();
    };
    const tapRadio = async (label: string) => {
      const result = await s.evaluate<{ ok: boolean; found: string[]; hasGroup: boolean }>(`(() => {
        const group = document.querySelector(".controls [role=radiogroup]");
        if (!group) return { ok: false, found: [...document.querySelectorAll(".controls .notes-switch button")].map((b) => b.textContent.trim()), hasGroup: false };
        const radios = [...group.querySelectorAll("[role=radio]")];
        const target = radios.find((b) => b.textContent.trim() === ${js(label)});
        if (!target) return { ok: false, found: radios.map((b) => b.textContent.trim()), hasGroup: true };
        target.click();
        return { ok: true, found: radios.map((b) => b.textContent.trim()), hasGroup: true };
      })()`);
      assert.ok(result.hasGroup, `a [role=radiogroup] switch exists in .controls (found buttons: ${js(result.found)})`);
      assert.ok(result.ok, `a [role=radio] part labelled ${js(label)} (found: ${js(result.found)})`);
      await painted();
    };
    const pressKey = async (key: string, code: string, keyCode: number) => {
      await s.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
      await s.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
      await painted();
    };
    const foldBar = async () => {
      await s.evaluate(`(() => { const el = document.getElementById("sheet-scroll"); el.scrollTop = 600; el.dispatchEvent(new Event("scroll")); })()`);
      await app.until(`!!document.querySelector(".song-chrome-bar[data-folded='song']")`, "folded song bar");
      await painted();
    };
    const unfoldBar = async () => {
      await s.evaluate(`(() => { const el = document.getElementById("sheet-scroll"); el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); })()`);
      await app.until(`!document.querySelector(".song-chrome-bar[data-folded]")`, "unfolded song bar");
      await painted();
    };

    await phone(360);
    await s.send("Page.navigate", { url: `${s.origin}/#/songs` });
    await app.library();

    // Seed made-up ChordPro songs and setlists into localStorage, then reload cleanly.
    await s.evaluate(`(() => {
      const lib = JSON.parse(localStorage.getItem("leadSheetsLibraryV2") || "{}");
      const addSongs = ${js(STORED_SONGS)};
      const ids = new Set(addSongs.map((each) => each.id));
      lib.songs = (lib.songs || []).filter((each) => !ids.has(each.id)).concat(addSongs);
      lib.lastSongId = Math.max(lib.lastSongId || 0, ...addSongs.map((each) => each.id));
      const addSets = ${js(STORED_SETLISTS)};
      const setIds = new Set(addSets.map((each) => each.id));
      lib.setlists = (lib.setlists || []).filter((each) => !setIds.has(each.id)).concat(addSets);
      localStorage.setItem("leadSheetsLibraryV2", JSON.stringify(lib));
    })()`);
    await s.send("Page.reload");
    await app.library();

    // ------------------------------------------------------------------ G1 guard
    await check("G1 guard", async () => {
      await phone(360);
      await openSong(701);
      const readHeights = () =>
        s.evaluate<{ down: number; readout: number; up: number }>(`(() => {
          const h = (sel) => document.querySelector(sel)?.getBoundingClientRect().height ?? 0;
          return {
            down: h(".controls [aria-label='Transpose down']"),
            readout: h(".controls .key-readout"),
            up: h(".controls [aria-label='Transpose up']"),
          };
        })()`);
      const open = await readHeights();
      assert.ok(open.down >= 44 && open.readout >= 44 && open.up >= 44, `unfolded at 360 px: ${js(open)} (each needs >= 44)`);
      await foldBar();
      const folded = await readHeights();
      await unfoldBar();
      assert.ok(folded.down >= 44 && folded.readout >= 44 && folded.up >= 44, `folded at 360 px: ${js(folded)} (each needs >= 44)`);
    });

    // ------------------------------------------------------------------ V1 labels
    await check("V1 labels", async () => {
      await phone(360);
      await openSong(701);
      const seen = await s.evaluate<{ labels: string[]; text: string; ariaLabel: string }>(`(() => {
        const sw = document.querySelector(".controls .notes-switch");
        return {
          labels: [...(sw?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()),
          text: sw?.textContent ?? "",
          ariaLabel: sw?.getAttribute("aria-label") ?? "",
        };
      })()`);
      assert.deepEqual(seen.labels, ["Chords", "Nashville", "Chords only"], `switch labels are ${js(seen.labels)}`);
      assert.ok(!/\bNotes\b/i.test(seen.text), `word Notes found in switch text (${js(seen.text)})`);
      assert.ok(!/\bNotes\b/i.test(seen.ariaLabel), `word Notes found in switch aria-label (${js(seen.ariaLabel)})`);
    });

    // ------------------------------------------------------------------ V2 a real radio group
    await check("V2 a real radio group", async () => {
      await phone(360);
      await openSong(701);
      const inspect = () =>
        s.evaluate<{
          groups: number;
          name: string;
          radios: { text: string; checked: string | null; pressed: string | null }[];
          anyPressed: boolean;
        }>(`(() => {
          const groups = [...document.querySelectorAll(".controls [role=radiogroup]")];
          const group = groups[0] ?? null;
          const labelledBy = group?.getAttribute("aria-labelledby");
          const name = (group?.getAttribute("aria-label") || (labelledBy ? document.getElementById(labelledBy)?.textContent : "") || "").trim();
          const radios = group ? [...group.querySelectorAll("[role=radio]")].map((r) => ({
            text: r.textContent.trim(),
            checked: r.getAttribute("aria-checked"),
            pressed: r.getAttribute("aria-pressed"),
          })) : [];
          const anyPressed = [...document.querySelectorAll(".controls .notes-switch button")].some((b) => b.hasAttribute("aria-pressed"));
          return { groups: groups.length, name, radios, anyPressed };
        })()`);
      const first = await inspect();
      assert.equal(first.groups, 1, `expected 1 [role=radiogroup] in .controls, found ${first.groups}`);
      assert.ok(first.name.length > 0, "radiogroup has an accessible name");
      assert.equal(first.radios.length, 3, `expected 3 [role=radio] children, found ${first.radios.length}`);
      assert.equal(first.anyPressed, false, "no aria-pressed attribute left on any switch button");
      assert.equal(first.radios.filter((r) => r.checked === "true").length, 1, `exactly 1 aria-checked=true (${js(first.radios)})`);
      assert.equal(first.radios.filter((r) => r.checked === "false").length, 2, `exactly 2 aria-checked=false (${js(first.radios)})`);
      await tapRadio("Nashville");
      const after = await inspect();
      assert.equal(after.radios.find((r) => r.text === "Nashville")?.checked, "true", "Nashville becomes aria-checked=true");
      assert.equal(after.radios.filter((r) => r.checked === "false").length, 2, "other two become aria-checked=false");
      await tapRadio("Chords");
    });

    // ------------------------------------------------------------------ V3 keys
    await check("V3 keys", async () => {
      await phone(360);
      await openSong(701);
      await tapRadio("Chords");
      const state = () =>
        s.evaluate<{
          tabs: { text: string; tabIndex: number; checked: string | null }[];
          focused: string;
          firstChords: string;
          lyricCount: number;
        }>(`(() => {
          const radios = [...document.querySelectorAll(".controls [role=radiogroup] [role=radio]")];
          const first = document.querySelector("#chord-section .pair .chords");
          return {
            tabs: radios.map((r) => ({ text: r.textContent.trim(), tabIndex: r.tabIndex, checked: r.getAttribute("aria-checked") })),
            focused: document.activeElement?.textContent?.trim() ?? "",
            firstChords: first?.textContent?.trim() ?? "",
            lyricCount: document.querySelectorAll("#chord-section .lyrics, #chord-section .lyric-only").length,
          };
        })()`);
      await s.evaluate(`document.querySelector(".controls [role=radiogroup] [role=radio][aria-checked=true]")?.focus()`);
      await painted();
      const s0 = await state();
      assert.deepEqual(s0.tabs.map((t) => t.tabIndex), [0, -1, -1], `only chosen part is tabbable initially (${js(s0.tabs)})`);
      assert.equal(s0.focused, "Chords", `focus starts on Chords (${js(s0.focused)})`);

      await pressKey("ArrowRight", "ArrowRight", 39);
      const s1 = await state();
      assert.equal(s1.focused, "Nashville", `ArrowRight moves focus to Nashville (${js(s1.focused)})`);
      assert.deepEqual(s1.tabs.map((t) => [t.checked, t.tabIndex]), [["false", -1], ["true", 0], ["false", -1]], `roving state on Nashville (${js(s1.tabs)})`);
      assert.equal(s1.firstChords, "1              6m", `sheet follows ArrowRight to Nashville (${js(s1.firstChords)})`);

      await pressKey("ArrowRight", "ArrowRight", 39);
      const s2 = await state();
      assert.equal(s2.focused, "Chords only", `ArrowRight moves focus to Chords only (${js(s2.focused)})`);
      assert.equal(s2.lyricCount, 0, `sheet follows ArrowRight to Chords only (${s2.lyricCount} lyric rows)`);

      await pressKey("ArrowRight", "ArrowRight", 39);
      const s3 = await state();
      assert.equal(s3.focused, "Chords", `ArrowRight wraps focus to Chords (${js(s3.focused)})`);
      assert.equal(s3.firstChords, VERSE_CHORDS_1, `sheet follows wrap back to Chords (${js(s3.firstChords)})`);
      assert.ok(s3.lyricCount > 0, "lyrics return after wrap to Chords");

      await pressKey("ArrowLeft", "ArrowLeft", 37);
      const s4 = await state();
      assert.equal(s4.focused, "Chords only", `ArrowLeft wraps back to Chords only (${js(s4.focused)})`);
      assert.equal(s4.lyricCount, 0, "sheet follows ArrowLeft wrap to Chords only");

      await pressKey("ArrowLeft", "ArrowLeft", 37);
      const s5 = await state();
      assert.equal(s5.focused, "Nashville", `ArrowLeft moves back to Nashville (${js(s5.focused)})`);
      assert.equal(s5.firstChords, "1              6m", `sheet follows ArrowLeft to Nashville (${js(s5.firstChords)})`);

      await tapRadio("Chords");
    });

    // ------------------------------------------------------------------ V4 each view draws what it should
    await check("V4 each view draws what it should", async () => {
      await phone(360);
      await openSong(701);
      const readChart = () =>
        s.evaluate<{ pairs: { chords: string; lyrics: string | null }[]; bars: string[]; lyricCount: number; fullText: string }>(`(() => {
          const chart = document.getElementById("chord-section");
          const pairs = [...chart.querySelectorAll(".pair")].map((p) => ({
            chords: p.querySelector(".chords")?.textContent?.trim() ?? "",
            lyrics: p.querySelector(".lyrics")?.textContent?.trim() ?? null,
          }));
          const bars = [...chart.querySelectorAll(".bars")].map((b) => b.textContent.trim());
          const lyricCount = chart.querySelectorAll(".lyrics, .lyric-only").length;
          return { pairs, bars, lyricCount, fullText: chart.textContent ?? "" };
        })()`);

      await tapRadio("Chords");
      const chordsView = await readChart();
      assert.equal(chordsView.pairs[0]?.chords, "A              F#m", `Chords row 1 chords (${js(chordsView.pairs[0])})`);
      assert.equal(chordsView.pairs[0]?.lyrics, "Cedar creek is running cold", `Chords row 1 lyrics (${js(chordsView.pairs[0])})`);
      assert.equal(chordsView.pairs[1]?.chords, "D             E", `Chords row 2 chords (${js(chordsView.pairs[1])})`);
      assert.equal(chordsView.pairs[1]?.lyrics, "Silver moon above the bend", `Chords row 2 lyrics (${js(chordsView.pairs[1])})`);

      await tapRadio("Nashville");
      const nashView = await readChart();
      assert.equal(nashView.pairs[0]?.chords, "1              6m", `Nashville row 1 has 6m (${js(nashView.pairs[0])})`);
      assert.equal(nashView.pairs[0]?.lyrics, "Cedar creek is running cold", `Nashville row 1 lyrics (${js(nashView.pairs[0])})`);
      assert.equal(nashView.pairs[1]?.chords, "4             5", `Nashville row 2 numbers (${js(nashView.pairs[1])})`);
      assert.equal(nashView.pairs[1]?.lyrics, "Silver moon above the bend", `Nashville row 2 lyrics (${js(nashView.pairs[1])})`);

      await tapRadio("Chords only");
      const onlyView = await readChart();
      assert.equal(onlyView.lyricCount, 0, `Chords only hides all lyric rows (found ${onlyView.lyricCount})`);
      assert.ok(!onlyView.fullText.includes("Cedar creek is running cold"), "Chords only omits lyric text");
      assert.equal(onlyView.pairs[0]?.chords, "A              F#m", `Chords only row 1 progression (${js(onlyView.pairs[0])})`);
      assert.equal(onlyView.pairs[1]?.chords, "D             E", `Chords only row 2 progression (${js(onlyView.pairs[1])})`);
      assert.equal(onlyView.bars[0], "| A | F#m | D | E |", `Chords only bar row (${js(onlyView.bars[0])})`);

      // Empty-lyric song still offers all three parts; Chords only shows its progression.
      await openSong(703);
      const noLyricLabels = await s.evaluate<string[]>(`[...document.querySelectorAll(".controls [role=radiogroup] [role=radio]")].map((r) => r.textContent.trim())`);
      assert.deepEqual(noLyricLabels, ["Chords", "Nashville", "Chords only"], "no-lyric song offers all three parts");
      await tapRadio("Chords only");
      const noLyricBars = await s.evaluate<string[]>(`[...document.querySelectorAll("#chord-section .bars")].map((b) => b.textContent.trim())`);
      assert.equal(noLyricBars[0], "| A | F#m | D | E |", "no-lyric song shows bars in Chords only");
      await tapRadio("Chords");
    });

    // ------------------------------------------------------------------ V5 stored values unchanged
    await check("V5 stored values unchanged", async () => {
      await phone(360);
      await s.evaluate(`(() => {
        localStorage.removeItem("leadSheetsSongDraft.701");
        localStorage.removeItem("leadSheetsScrollVersions.701");
        localStorage.removeItem("leadSheetsNotation.701");
        localStorage.removeItem("leadSheetsSongDraft.702");
        localStorage.removeItem("leadSheetsNotation.702");
      })()`);
      await openSong(701);

      const readDraftNotation = () =>
        s.evaluate<string | null>(`JSON.parse(localStorage.getItem("leadSheetsSongDraft.701") || "null")?.notation ?? null`);

      await tapRadio("Nashville");
      assert.equal(await readDraftNotation(), "nashville", "tapping Nashville stores notation 'nashville'");

      await tapRadio("Chords only");
      assert.equal(await readDraftNotation(), "chords", "tapping Chords only stores notation 'chords'");

      await tapRadio("Chords");
      assert.equal(await readDraftNotation(), "notes", "tapping Chords stores notation 'notes'");

      // Same content is not the same item: switching 701 to Nashville does not switch 702.
      await tapRadio("Nashville");
      await openSong(702);
      const checked702 = await s.evaluate<string>(`document.querySelector(".controls [role=radiogroup] [role=radio][aria-checked=true]")?.textContent?.trim() ?? ""`);
      assert.equal(checked702, "Chords", `song 702 with same content stays on Chords (saw ${js(checked702)})`);

      // A saved version stored with notation "notes" opens with Chords chosen.
      await s.evaluate(`(() => {
        localStorage.removeItem("leadSheetsSongDraft.701");
        localStorage.setItem("leadSheetsScrollVersions.701", ${js(js({ versions: [{ name: "Acoustic", semitones: 0, scrollPercent: 100, notation: "notes" }], selected: 0 }))});
      })()`);
      await openSong(701);
      const checkedFromSaved = await s.evaluate<string>(`document.querySelector(".controls [role=radiogroup] [role=radio][aria-checked=true]")?.textContent?.trim() ?? ""`);
      assert.equal(checkedFromSaved, "Chords", `saved version with notation 'notes' opens with Chords chosen (saw ${js(checkedFromSaved)})`);

      // Saving a version in Chords only writes notation "notes" + chordsOnly: true (withChordsOnly).
      await tapRadio("Chords only");
      await app.until(`[...document.querySelectorAll(".shell-header button")].some((b) => b.textContent.trim() === "Save")`, "Save button after switching to Chords only");
      await app.click("Save", `document.querySelector(".shell-header")`);
      await app.click("Save as…");
      await app.until(`!!document.querySelector("[role=dialog] input[aria-label='Version name']")`, "Save as dialog");
      await s.evaluate(`(() => {
        const input = document.querySelector("[role=dialog] input[aria-label='Version name']");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Stage");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await app.click("Save", `document.querySelector("[role=dialog]")`);
      await app.until(`!document.querySelector("[role=dialog]")`, "Save as dialog closes");
      const rawStage = await s.evaluate<{ notation?: string; chordsOnly?: boolean } | null>(
        `(JSON.parse(localStorage.getItem("leadSheetsScrollVersions.701") || "{}").versions || []).find((v) => v.name === "Stage") ?? null`,
      );
      assert.ok(rawStage, "Stage version was stored");
      assert.equal(rawStage.notation, "notes", `withChordsOnly writes notation 'notes' (got ${js(rawStage)})`);
      assert.equal(rawStage.chordsOnly, true, `withChordsOnly sets chordsOnly: true (got ${js(rawStage)})`);

      // Restore song 701 to Acoustic (notes) for clean state in subsequent cases.
      await s.evaluate(`(() => {
        localStorage.removeItem("leadSheetsSongDraft.701");
        localStorage.setItem("leadSheetsScrollVersions.701", ${js(js({ versions: [{ name: "Acoustic", semitones: 0, scrollPercent: 100, notation: "notes" }], selected: 0 }))});
      })()`);
    });

    // ------------------------------------------------------------------ V6 one line, equal parts
    await check("V6 one line, equal parts", async () => {
      for (const width of [360, 390]) {
        await phone(width);
        await openSong(701);
        const geo = await s.evaluate<{
          count: number;
          tops: number[];
          widths: number[];
          lines: number[];
          whiteSpaces: string[];
          clipped: boolean[];
          pillOverflow: boolean;
          pillLeft: number;
          pillRight: number;
          pillTop: number;
          transposeBottom: number;
          pageWidth: number;
        }>(`(() => {
          const pill = document.querySelector(".controls .notes-switch");
          const transpose = document.querySelector(".controls .transpose");
          const buttons = [...(pill?.querySelectorAll("button") ?? [])];
          const pr = pill.getBoundingClientRect();
          const tr = transpose.getBoundingClientRect();
          const rects = buttons.map((b) => b.getBoundingClientRect());
          const lines = buttons.map((b) => {
            const range = document.createRange();
            range.selectNodeContents(b);
            return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
          });
          const clipped = buttons.map((b, i) => {
            const range = document.createRange();
            range.selectNodeContents(b);
            const tb = range.getBoundingClientRect();
            return b.scrollWidth > b.clientWidth + 0.5 || tb.left < rects[i].left - 0.5 || tb.right > rects[i].right + 0.5;
          });
          return {
            count: buttons.length,
            tops: rects.map((r) => r.top),
            widths: rects.map((r) => r.width),
            lines,
            whiteSpaces: buttons.map((b) => getComputedStyle(b).whiteSpace),
            clipped,
            pillOverflow: pill.scrollWidth > pill.clientWidth + 0.5,
            pillLeft: pr.left,
            pillRight: pr.right,
            pillTop: pr.top,
            transposeBottom: tr.bottom,
            pageWidth: document.documentElement.scrollWidth,
          };
        })()`);
        assert.equal(geo.count, 3, `at ${width} px switch has 3 parts`);
        assert.ok(Math.max(...geo.tops) - Math.min(...geo.tops) <= 0.5, `at ${width} px parts share one top edge (${js(geo.tops)})`);
        assert.ok(Math.max(...geo.widths) - Math.min(...geo.widths) <= 1, `at ${width} px widths differ by at most 1 px (${js(geo.widths)})`);
        assert.ok(geo.lines.every((n) => n === 1), `at ${width} px no label wraps (${js(geo.lines)})`);
        assert.ok(geo.whiteSpaces.every((ws) => ws === "nowrap"), `at ${width} px parts prevent wrapping (${js(geo.whiteSpaces)})`);
        assert.ok(geo.clipped.every((c) => !c) && !geo.pillOverflow, `at ${width} px nothing is clipped (${js({ clipped: geo.clipped, pillOverflow: geo.pillOverflow })})`);
        assert.ok(geo.pillLeft >= 0 && geo.pillRight <= width + 0.5, `at ${width} px bar is inside screen (${geo.pillLeft.toFixed(1)}..${geo.pillRight.toFixed(1)})`);
        assert.ok(geo.pageWidth <= width + 0.5, `at ${width} px page does not scroll sideways (${geo.pageWidth})`);
        assert.ok(geo.pillTop >= geo.transposeBottom - 0.5, `at ${width} px pill sits on its own row under Key (${geo.pillTop.toFixed(1)} >= ${geo.transposeBottom.toFixed(1)})`);
      }

      // Very long key label at 360 px must not push the pill off screen.
      await phone(360);
      await openSong(704);
      const longKey = await s.evaluate<{ left: number; right: number; page: number }>(`(() => {
        const r = document.querySelector(".controls .notes-switch").getBoundingClientRect();
        return { left: r.left, right: r.right, page: document.documentElement.scrollWidth };
      })()`);
      assert.ok(longKey.left >= 0 && longKey.right <= 360.5 && longKey.page <= 360.5, `long key label keeps pill on screen at 360 px (${js(longKey)})`);
    });

    // ------------------------------------------------------------------ V7 finger-sized parts
    await check("V7 finger-sized parts", async () => {
      await phone(360);
      await openSong(701);
      const heights = await s.evaluate<number[]>(`[...document.querySelectorAll(".controls [role=radiogroup] [role=radio]")].map((el) => el.getBoundingClientRect().height)`);
      assert.equal(heights.length, 3, `expected 3 radio parts, found ${heights.length}`);
      assert.ok(heights.every((h) => h >= 44), `each radio part >= 44 px tall at 360 px (${js(heights)})`);
    });

    // ------------------------------------------------------------------ V8 one label map
    await check("V8 one label map", async () => {
      const personalSrc = readFileSync(join(root, "src", "personal-settings.tsx"), "utf8");
      assert.ok(/from\s+["']\.\/controls["']/.test(personalSrc), "src/personal-settings.tsx imports from ./controls");
      assert.ok(!/["']Nashville["']/.test(personalSrc) && !/["']Notes["']/.test(personalSrc), "src/personal-settings.tsx defines no local notation label list");

      await phone(360);
      await s.evaluate(`location.hash = "#/settings"`);
      await app.until(`!!document.querySelector(".settings [role=group][aria-label=Chords]")`, "Settings Chords default");
      await painted();

      const labels = await s.evaluate<string[]>(`[...document.querySelectorAll(".settings [role=group][aria-label=Chords] button")].map((b) => b.textContent.trim())`);
      assert.deepEqual(labels, ["Chords", "Nashville"], `Settings Chords reads ${js(labels)}`);

      await app.click("Nashville", `document.querySelector(".settings [role=group][aria-label=Chords]")`);
      const afterNash = await s.evaluate<string | null>(`JSON.parse(localStorage.getItem("leadSheetsPersonal") || "{}")[""]?.chordStyle ?? null`);
      assert.equal(afterNash, "nashville", `Nashville default stores 'nashville' (got ${js(afterNash)})`);

      await app.click("Chords", `document.querySelector(".settings [role=group][aria-label=Chords]")`);
      const afterChords = await s.evaluate<string | null>(`JSON.parse(localStorage.getItem("leadSheetsPersonal") || "{}")[""]?.chordStyle ?? null`);
      assert.equal(afterChords, "notes", `Chords default stores 'notes' (got ${js(afterChords)})`);
    });

    // ------------------------------------------------------------------ V9 menu rows
    await check("V9 menu rows", async () => {
      await phone(360);
      await s.evaluate(`(() => {
        if (!localStorage.getItem("leadSheetsScrollVersions.701")) {
          localStorage.setItem("leadSheetsScrollVersions.701", ${js(js({ versions: [{ name: "Acoustic", semitones: 0, scrollPercent: 100, notation: "notes" }], selected: 0 }))});
        }
      })()`);
      await openSong(701);

      // More menu on a song the player made
      await s.evaluate(`document.querySelector(".shell-header [aria-label=More]").click()`);
      await app.until(`!!document.querySelector("[role=menu]")`, "More menu opens");
      await painted();
      const moreRows = await s.evaluate<{ text: string; h: number }[]>(
        `[...document.querySelectorAll("[role=menu] button")].map((b) => ({ text: b.textContent.trim(), h: b.getBoundingClientRect().height }))`,
      );
      for (const expected of ["Song timing", "Edit", "Delete"]) {
        assert.ok(moreRows.some((r) => r.text === expected), `More menu includes ${expected} (${js(moreRows)})`);
      }
      assert.ok(moreRows.every((r) => r.h >= 44), `every More menu row >= 44 px tall at 360 px (${js(moreRows)})`);
      await shoot("menu-open-360-stage");
      await pressKey("Escape", "Escape", 27);
      await app.until(`!document.querySelector("[role=menu]")`, "More menu closes");

      // Version menu rows on song 701
      await app.until(`!!document.querySelector(".shell-header button.version-chip")`, "version chip");
      await s.evaluate(`document.querySelector(".shell-header button.version-chip").click()`);
      await app.until(`!!document.querySelector("[role=menu]")`, "version menu opens");
      await painted();
      const versionRows = await s.evaluate<{ text: string; h: number }[]>(
        `[...document.querySelectorAll("[role=menu] button")].map((b) => ({ text: b.textContent.trim(), h: b.getBoundingClientRect().height }))`,
      );
      assert.ok(versionRows.length >= 3, `version menu has rows (${js(versionRows)})`);
      assert.ok(versionRows.every((r) => r.h >= 44), `every version menu row >= 44 px tall at 360 px (${js(versionRows)})`);
      await pressKey("Escape", "Escape", 27);
      await app.until(`!document.querySelector("[role=menu]")`, "version menu closes");

      // Opening and closing a menu leaves the chosen view unchanged.
      await tapRadio("Nashville");
      await s.evaluate(`document.querySelector(".shell-header [aria-label=More]").click()`);
      await app.until(`!!document.querySelector("[role=menu]")`, "More menu re-opens");
      await pressKey("Escape", "Escape", 27);
      await app.until(`!document.querySelector("[role=menu]")`, "More menu closes again");
      const stillNash = await s.evaluate<string>(`document.querySelector(".controls [role=radiogroup] [role=radio][aria-checked=true]")?.textContent?.trim() ?? ""`);
      assert.equal(stillNash, "Nashville", "closing More menu leaves chosen view unchanged");

      // Built-in song: disabled Edit/Delete rows are still >= 44 px, and the note is not a button.
      await openSong(1);
      await s.evaluate(`document.querySelector(".shell-header [aria-label=More]").click()`);
      await app.until(`!!document.querySelector("[role=menu]")`, "built-in More menu opens");
      await painted();
      const lockedRows = await s.evaluate<{ rows: { text: string; h: number; disabled: boolean }[]; noteTag: string }>(`(() => ({
        rows: [...document.querySelectorAll("[role=menu] button")].map((b) => ({ text: b.textContent.trim(), h: b.getBoundingClientRect().height, disabled: b.disabled })),
        noteTag: document.querySelector("[role=menu] .menu-note")?.tagName ?? "",
      }))()`);
      assert.ok(lockedRows.rows.every((r) => r.h >= 44), `disabled More menu rows >= 44 px tall (${js(lockedRows.rows)})`);
      assert.equal(lockedRows.noteTag, "P", `menu note is a paragraph, not a row button (${js(lockedRows.noteTag)})`);
      await pressKey("Escape", "Escape", 27);
    });

    // ------------------------------------------------------------------ V10 Live link
    await check("V10 Live link", async () => {
      await phone(360);
      await s.evaluate(`location.hash = "#/setlists"`);
      await app.until(`document.querySelectorAll(".setlists .setlist .live-launch").length >= 2`, "Setlists with Live links");
      await painted();
      const rows = await s.evaluate<
        { name: string; w: number; h: number; sameLine: boolean; emptyText: string }[]
      >(`[...document.querySelectorAll(".setlists .setlist")].map((sec) => {
        const h2 = sec.querySelector(".setlist-head h2");
        const live = sec.querySelector(".setlist-head .live-launch");
        const hr = h2.getBoundingClientRect();
        const lr = live.getBoundingClientRect();
        const sameLine = lr.left >= hr.right - 0.5 && lr.top < hr.bottom && hr.top < lr.bottom;
        return {
          name: h2.textContent.trim(),
          w: lr.width,
          h: lr.height,
          sameLine,
          emptyText: sec.querySelector(".setlist-empty")?.textContent?.trim() ?? "",
        };
      })`);
      assert.ok(rows.length >= 2, `found ${rows.length} setlists`);
      for (const row of rows) {
        assert.ok(row.h >= 44 && row.w >= 44, `Live link on ${js(row.name)} is ${row.w.toFixed(1)}x${row.h.toFixed(1)} (needs >= 44x44)`);
        assert.ok(row.sameLine, `Live link on ${js(row.name)} sits on the same line as its name`);
      }
      const empty = rows.find((r) => r.name === "Empty Set");
      assert.equal(empty?.emptyText, "This setlist is empty.", `empty setlist keeps its line (${js(empty)})`);
      await shoot("setlists-360-stage");
    });

    // ------------------------------------------------------------------ V11 themes
    await check("V11 themes", async () => {
      await phone(360);
      await openSong(701);

      const checkedBgs: Record<string, string> = {};
      const barBgs: Record<string, string> = {};
      try {
        for (const theme of ["stage", "day", "contrast"] as const) {
          await s.evaluate(`document.documentElement.dataset.theme = ${js(theme)}`);
          await painted();
          const colors = await s.evaluate<{
            barBg: string;
            chosenColor: string;
            chosenBg: string;
            plainColor: string;
            hasRadio: boolean;
          }>(`(() => {
            const bar = document.querySelector(".controls .notes-switch");
            const chosen = bar?.querySelector("[role=radio][aria-checked=true]");
            const plain = bar?.querySelector("[role=radio][aria-checked=false]");
            return {
              hasRadio: !!chosen && !!plain,
              barBg: bar ? getComputedStyle(bar).backgroundColor : "",
              chosenColor: chosen ? getComputedStyle(chosen).color : "",
              chosenBg: chosen ? getComputedStyle(chosen).backgroundColor : "",
              plainColor: plain ? getComputedStyle(plain).color : "",
            };
          })()`);
          assert.ok(colors.hasRadio, `theme ${theme}: switch has checked and unchecked radio parts`);
          const barBg = parseColor(colors.barBg);
          const chosenColor = parseColor(colors.chosenColor);
          const chosenBg = parseColor(colors.chosenBg);
          const plainColor = parseColor(colors.plainColor);
          assert.ok(barBg && barBg[3] > 0.9, `theme ${theme}: bar has opaque fill (${js(colors.barBg)})`);
          assert.ok(chosenBg && chosenBg[3] > 0.9, `theme ${theme}: chosen part has opaque fill (${js(colors.chosenBg)})`);
          assert.ok(chosenColor && plainColor, `theme ${theme}: text colors parsed (${js(colors)})`);

          const chosenRatio = contrastRatio([chosenColor[0], chosenColor[1], chosenColor[2]], [chosenBg[0], chosenBg[1], chosenBg[2]]);
          const plainRatio = contrastRatio([plainColor[0], plainColor[1], plainColor[2]], [barBg[0], barBg[1], barBg[2]]);
          assert.ok(chosenRatio >= 4.5, `theme ${theme}: chosen contrast ${chosenRatio.toFixed(2)} < 4.5 (${colors.chosenColor} on ${colors.chosenBg})`);
          assert.ok(plainRatio >= 4.5, `theme ${theme}: plain contrast ${plainRatio.toFixed(2)} < 4.5 (${colors.plainColor} on ${colors.barBg})`);
          checkedBgs[theme] = colors.chosenBg;
          barBgs[theme] = colors.barBg;
        }
        assert.notEqual(checkedBgs.stage, checkedBgs.contrast, `chosen fill follows theme token across stage (${checkedBgs.stage}) and contrast (${checkedBgs.contrast})`);
        assert.notEqual(barBgs.stage, barBgs.day, `bar fill follows theme token across stage (${barBgs.stage}) and day (${barBgs.day})`);
      } finally {
        await s.evaluate(`document.documentElement.dataset.theme = "stage"`);
        await painted();
      }
    });

    // ------------------------------------------------------------------ V13 instant theme switch
    await check("V13 instant theme switch", async () => {
      await phone(360);
      await openSong(701);
      const read = `(() => {
        const bar = document.querySelector(".controls .notes-switch");
        return [...bar.querySelectorAll("[role=radio]")].map((b) => {
          const style = getComputedStyle(b);
          return b.textContent.trim() + " " + style.color + " on " + style.backgroundColor;
        });
      })()`;
      await s.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
      try {
        for (const theme of ["day", "cb-rg", "contrast", "stage"] as const) {
          const first = await s.evaluate<string[]>(`(() => { document.documentElement.dataset.theme = ${js(theme)}; return ${read}; })()`);
          await painted();
          await new Promise((done) => setTimeout(done, 400));
          const settled = await s.evaluate<string[]>(read);
          assert.deepEqual(first, settled, `theme ${theme}: the pill shows its theme colors the moment the theme changes (first frame ${js(first)}, settled ${js(settled)})`);
        }
      } finally {
        await s.send("Emulation.setEmulatedMedia", { features: [] });
        await s.evaluate(`document.documentElement.dataset.theme = "stage"`);
        await painted();
      }
    });

    // ------------------------------------------------------------------ V12 folded bar
    await check("V12 folded bar", async () => {
      await phone(360);
      await openSong(701);
      await s.evaluate(`[...document.querySelectorAll(".controls .notes-switch button")].find((b) => b.textContent.trim() === "Nashville")?.click()`);
      await painted();
      await foldBar();

      const seen = await s.evaluate<{
        barHeight: number;
        expectedHeight: number;
        clipped: string[];
        outside: string[];
        overlaps: string[];
        pillOverflow: boolean;
        chosenFolded: string;
      }>(`(() => {
        const chrome = document.querySelector(".song-chrome");
        const bar = document.querySelector(".song-chrome-bar[data-folded='song']");
        const probe = document.createElement("div");
        probe.style.cssText = "position:absolute;visibility:hidden;height:var(--song-chrome-folded)";
        chrome.append(probe);
        const expectedHeight = probe.getBoundingClientRect().height;
        probe.remove();

        const br = bar.getBoundingClientRect();
        const items = [...bar.querySelectorAll("button, .shell-title")].filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden");
        const rects = items.map((el) => ({ el, label: el.getAttribute("aria-label") || el.textContent.trim(), r: el.getBoundingClientRect() }));
        const clipped = rects
          .filter(({ el }) => !el.classList.contains("shell-title") && el.scrollWidth > el.clientWidth + 1)
          .map(({ label }) => label);
        const outside = rects
          .filter(({ r }) => r.left < br.left - 0.5 || r.right > br.right + 0.5 || r.top < br.top - 0.5 || r.bottom > br.bottom + 0.5)
          .map(({ label }) => label);
        const overlaps = [];
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i].r, b = rects[j].r;
            if (a.right > b.left + 0.5 && b.right > a.left + 0.5 && a.bottom > b.top + 0.5 && b.bottom > a.top + 0.5) {
              overlaps.push(rects[i].label + " / " + rects[j].label);
            }
          }
        }
        const pill = bar.querySelector(".notes-switch");
        const pillOverflow = pill ? pill.scrollWidth > pill.clientWidth + 1 : false;
        const chosenFolded = bar.querySelector("[role=radiogroup] [role=radio][aria-checked=true]")?.textContent?.trim() ?? "";
        return { barHeight: br.height, expectedHeight, clipped, outside, overlaps, pillOverflow, chosenFolded };
      })()`);

      assert.ok(Math.abs(seen.barHeight - seen.expectedHeight) <= 0.5, `folded bar height ${seen.barHeight.toFixed(1)} != --song-chrome-folded ${seen.expectedHeight.toFixed(1)}`);
      assert.deepEqual(seen.clipped, [], `clipped controls in folded bar: ${js(seen.clipped)}`);
      assert.deepEqual(seen.outside, [], `controls outside folded bar: ${js(seen.outside)}`);
      assert.deepEqual(seen.overlaps, [], `overlapping controls in folded bar: ${js(seen.overlaps)}`);
      assert.equal(seen.pillOverflow, false, "pill does not clip horizontally in folded bar");
      assert.equal(seen.chosenFolded, "Nashville", `chosen view stayed Nashville while folded (got ${js(seen.chosenFolded)})`);

      await unfoldBar();
      const chosenAfter = await s.evaluate<string>(`document.querySelector(".controls [role=radiogroup] [role=radio][aria-checked=true]")?.textContent?.trim() ?? ""`);
      assert.equal(chosenAfter, "Nashville", `chosen view stayed Nashville after unfolding (got ${js(chosenAfter)})`);
      await tapRadio("Chords");
    });

    // ------------------------------------------------------------------ V14 long key label
    // Built-in song 13 carries a 47-character key label; 704 is a made-up long key. Open and folded, from 360 px
    // to past the 430 and 540 px steps, every part stays whole inside the pill and the screen, whichever is chosen.
    await check("V14 long key label", async () => {
      const bad: string[] = [];
      const measure = () =>
        s.evaluate<{
          parts: { text: string; checked: boolean; left: number; right: number; width: number; clipped: boolean }[];
          pill: [number, number];
          readout: { width: number; height: number; spills: boolean; nameLines: number };
          page: number;
        }>(`(() => {
          const pill = document.querySelector(".controls .notes-switch");
          const pr = pill.getBoundingClientRect();
          const parts = [...pill.querySelectorAll("[role=radio]")].map((b) => {
            const r = b.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(b);
            const tb = range.getBoundingClientRect();
            const lines = new Set([...range.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size;
            return {
              text: b.textContent.trim(),
              checked: b.getAttribute("aria-checked") === "true",
              left: r.left,
              right: r.right,
              width: r.width,
              clipped: lines !== 1 || b.scrollWidth > b.clientWidth + 0.5 || tb.left < r.left - 0.5 || tb.right > r.right + 0.5,
            };
          });
          const readout = document.querySelector(".controls .key-readout");
          const rr = readout.getBoundingClientRect();
          const name = readout.querySelector(".key-name");
          const nr = name.getBoundingClientRect();
          const nameRange = document.createRange();
          nameRange.selectNodeContents(name);
          const nameLines = new Set([...nameRange.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size;
          return {
            parts,
            pill: [pr.left, pr.right],
            readout: { width: rr.width, height: rr.height, spills: nr.left < rr.left - 0.5 || nr.right > rr.right + 0.5 || nr.top < rr.top - 0.5 || nr.bottom > rr.bottom + 0.5, nameLines },
            page: document.documentElement.scrollWidth,
          };
        })()`);
      const judge = (tag: string, width: number, folded: boolean, m: Awaited<ReturnType<typeof measure>>) => {
        const [pl, pr] = m.pill;
        for (const p of m.parts) {
          const where = `${tag} ${p.text}${p.checked ? " (chosen)" : ""} at ${p.left.toFixed(0)}..${p.right.toFixed(0)}, pill ${pl.toFixed(0)}..${pr.toFixed(0)}`;
          if (p.left < pl - 0.5 || p.right > pr + 0.5 || p.left < -0.5 || p.right > width + 0.5) bad.push(`${where}: not whole on screen`);
          if (p.clipped) bad.push(`${where}: label clipped or wrapped`);
        }
        for (let i = 1; i < m.parts.length; i++) {
          if (m.parts[i].left < m.parts[i - 1].right - 0.5) bad.push(`${tag}: ${m.parts[i - 1].text} and ${m.parts[i].text} overlap`);
        }
        if (!folded) {
          const ws = m.parts.map((p) => p.width);
          if (Math.max(...ws) - Math.min(...ws) > 1) bad.push(`${tag}: parts not equal (${js(ws.map((w) => +w.toFixed(1)))})`);
        }
        if (m.readout.width < 44 || m.readout.height < 44) bad.push(`${tag}: key readout ${m.readout.width.toFixed(0)}x${m.readout.height.toFixed(0)} under 44 px`);
        if (m.readout.spills) bad.push(`${tag}: key label spills out of its button`);
        if (folded && m.readout.nameLines !== 1) bad.push(`${tag}: folded key label runs to ${m.readout.nameLines} lines`);
        if (m.page > width + 0.5) bad.push(`${tag}: page scrolls sideways (${m.page})`);
      };

      for (const id of [13, 704]) {
        for (const width of [360, 390, 412, 429, 430, 480, 539, 540, 600]) {
          await phone(width);
          await openSong(id);
          for (const label of ["Chords", "Nashville", "Chords only"]) {
            await tapRadio(label);
            judge(`song ${id} @${width} open, ${label} chosen`, width, false, await measure());
            await foldBar();
            judge(`song ${id} @${width} folded, ${label} chosen`, width, true, await measure());
            await unfoldBar();
          }
          await tapRadio("Chords");
        }
      }
      await phone(360);
      for (const line of bad) console.log(`     ${line}`);
      assert.equal(bad.length, 0, `${bad.length} long-key layout problems (listed above)`);
    });

    // Optional screenshot capture for report when VIEW_PILL_SHOTS is set
    if (shots) {
      for (const theme of ["stage", "day"] as const) {
        await s.evaluate(`document.documentElement.dataset.theme = ${js(theme)}`);
        await painted();
        for (const width of [360, 390]) {
          await phone(width);
          await openSong(701);
          for (const [slug, label] of [["chords", "Chords"], ["nashville", "Nashville"], ["chords-only", "Chords only"]] as const) {
            await tapRadio(label);
            await shoot(`pill-${slug}-${width}-${theme}`);
          }
          await s.evaluate(`document.querySelector(".shell-header [aria-label=More]").click()`);
          await app.until(`!!document.querySelector("[role=menu]")`, "More menu for shot");
          await painted();
          await shoot(`menu-${width}-${theme}`);
          await pressKey("Escape", "Escape", 27);
          await s.evaluate(`location.hash = "#/setlists"`);
          await app.until(`!!document.querySelector(".setlists .live-launch")`, "Setlists for shot");
          await painted();
          await shoot(`setlists-${width}-${theme}`);
        }
      }
      await s.evaluate(`document.documentElement.dataset.theme = "stage"`);
    }

    assert.deepEqual(await app.errors(), [], "no page errors");
  } finally {
    await s.close();
  }
}

if (failed > 0) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
