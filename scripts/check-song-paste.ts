import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { appPage } from "./app-page.ts";
import { chordAnchors, lyricWords, type Row } from "./chord-anchors.ts";
import { openSite, type Site } from "./chrome.ts";

/**
 * Smart paste: a chart copied from the web becomes the chart text `parseSheet` reads, with the facts it found and a
 * count of what it left out. Cases are numbered as in section 2 of docs/PLAN-song-search-layers.md.
 *
 * `src/song-paste.ts` is pure. It exports `readPaste(text, view?)`, which returns `{ facts, chart, leftOut }` with
 * chords as they sound when `view` is left out and as the guitar shapes when it is `"shapes"`, `keyFromChords(sections)`,
 * `capoNote(capo, view?)`, the words `Song.keyNote` takes for a capo, and `SPELLINGS`, rows of `[pasted, stored]`
 * chord spellings. Unit cases run in node. Screen cases build the app and drive headless Chrome (`CHROME`) against a
 * stub `/api/me`, at 360 px and 390 px. Every chart here is written for this check, with made-up words.
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

type Line = { chords?: string; lyrics?: string; bars?: string; note?: string };
type Section = { heading: string; lines: Line[] };
type LeftOut = { count: number; what: string };
type Pasted = { facts: Record<string, unknown>; chart: string; leftOut: LeftOut[] };
type PasteModule = {
  readPaste: (text: string, view?: "sounding" | "shapes") => Pasted;
  keyFromChords: (sections: Section[]) => { keyRoot: string; keyMode: string } | null;
  capoNote: (capo: number, view?: "sounding" | "shapes") => string;
  SPELLINGS: readonly (readonly [string, string])[];
};
type TextModule = {
  parseSheet: (text: string) => { sections: Section[] };
  sectionsToText: (sections: Section[]) => string;
  transposeChordSymbol: (symbol: string, semitones: number, flats: boolean) => string;
};

async function load<T>(contents: string, what: string): Promise<T | null> {
  try {
    const bundle = await build({ stdin: { contents, resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" });
    return await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  } catch (error) {
    console.log(`FAIL ${what} loads as a pure module: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    failed += 1;
    return null;
  }
}

const pasteMod = await load<PasteModule>(`export * from "./src/song-paste.ts";`, "src/song-paste.ts");
const textMod = await load<TextModule>(`export { parseSheet, sectionsToText } from "./src/song-text.ts"; export { transposeChordSymbol } from "./src/music.ts";`, "src/song-text.ts and src/music.ts");
const paste = (): PasteModule => {
  assert.ok(pasteMod, "src/song-paste.ts loaded");
  return pasteMod;
};
const text = (): TextModule => {
  assert.ok(textMod, "src/song-text.ts loaded");
  return textMod;
};

const sections = (chart: string) => text().parseSheet(chart).sections;
const headings = (chart: string) => sections(chart).map((section) => section.heading);
const lines = (chart: string) => chart.split("\n");
const leftOut = (pasted: Pasted, what: string) => pasted.leftOut.find((each) => each.what === what)?.count ?? 0;
const tokens = (line: Line | undefined) => (line?.chords ?? line?.bars ?? "").trim().split(/\s+/).filter(Boolean);
/** A chord row with each chord at the column given, the way a web page lines chords up over words. */
const chordRow = (chords: [string, number][]) => chords.reduce((row, [name, at]) => row.padEnd(at) + name, "");
/** Where each chord sits on its words, with the chord's own name left out, so a respelled chord compares with its paste. */
const places = (rows: Row[]) => chordAnchors(rows).map((anchor) => anchor.replace(/^\S+ /, ""));
const pairs = (chart: string): Row[] => sections(chart).flatMap((section) => section.lines.flatMap((line) => (line.chords === undefined ? [] : [{ chords: line.chords, lyrics: line.lyrics }])));

const VERSE = ["[Verse 1]", "G           C", "Paper boats on the river"].join("\n");

const FIXTURES: string[] = [];
const read = (pasted: string, view?: "sounding" | "shapes") => {
  FIXTURES.push(pasted);
  return paste().readPaste(pasted, view);
};

await check("1. header facts are read and leave the chart, for each form", () => {
  const forms: [string, Record<string, unknown>][] = [
    ["Key: G", { keyRoot: "G", keyMode: "major" }],
    ["Key of Em", { keyRoot: "E", keyMode: "minor" }],
    ["Tempo: 120 bpm", { tempo: 120 }],
    ["BPM 96", { tempo: 96 }],
    ["Capo: 2nd fret", { capo: 2 }],
    ["Capo 3", { capo: 3 }],
    ["Time: 6/8", { timeSignature: "6/8" }],
  ];
  for (const [header, want] of forms) {
    const pasted = read(`${header}\n${VERSE}`);
    for (const [field, value] of Object.entries(want)) assert.equal(pasted.facts[field], value, `${header} gives ${field} ${value} (${js(pasted.facts)})`);
    assert.ok(!lines(pasted.chart).some((line) => line.trim() === header), `${header} leaves the chart (${js(pasted.chart)})`);
    assert.deepEqual(headings(pasted.chart), ["VERSE 1"], `${header}: the chart is the one verse`);
  }
});

await check("2. ChordPro facts, sections and comments follow the rules; an unknown directive is left out and counted", () => {
  const pasted = read(
    [
      "{title: Paper Boats}",
      "{artist: The Made Up Band}",
      "{key: G}",
      "{tempo: 96}",
      "{time: 3/4}",
      "{start_of_verse}",
      "[G]Paper boats on the [C]river",
      "{end_of_verse}",
      "",
      "{soc}",
      "[D]Float away, [G]float away",
      "{eoc}",
      "",
      "{comment: Verse 2}",
      "[G]Rain on the [C]window",
      "{c: Play softly}",
      "",
      "{sob}",
      "[Em]Under the [D]bridge we go",
      "{end_of_bridge}",
      "{new_song_page}",
      "{x_made_up: something}",
    ].join("\n"),
  );
  assert.deepEqual(
    { title: pasted.facts.title, artist: pasted.facts.artist, keyRoot: pasted.facts.keyRoot, keyMode: pasted.facts.keyMode, tempo: pasted.facts.tempo, timeSignature: pasted.facts.timeSignature },
    { title: "Paper Boats", artist: "The Made Up Band", keyRoot: "G", keyMode: "major", tempo: 96, timeSignature: "3/4" },
    "title, artist, key, tempo and time from the directives",
  );
  assert.deepEqual(headings(pasted.chart), ["VERSE 1", "CHORUS", "VERSE 2", "BRIDGE"], "each section directive and the section-name comment give a heading");
  const verse2 = sections(pasted.chart)[2];
  assert.ok(verse2.lines.some((line) => line.note === "Play softly"), `a comment that is no section name is a note (${js(verse2.lines)})`);
  assert.equal(leftOut(pasted, "directives"), 2, `two unknown directives left out (${js(pasted.leftOut)})`);
  assert.ok(!lines(pasted.chart).some((line) => line.trim().startsWith("{")), "no directive stays in the chart");
  const short = read(["{t: Small Hours}", "{subtitle: Nobody Real}", "{start_of_chorus}", "[G]Late at [C]night", "{end_of_chorus}"].join("\n"));
  assert.deepEqual([short.facts.title, short.facts.artist, headings(short.chart)], ["Small Hours", "Nobody Real", ["CHORUS"]], "{t:} and {subtitle:} are the title and artist");
});

await check("3. every heading form gives a library-style heading; a heading with chords gives the heading and a chord row", () => {
  const forms: [string, string][] = [
    ["[Verse 1]", "VERSE 1"],
    ["Verse 1:", "VERSE 1"],
    ["(Bridge)", "BRIDGE"],
    ["chorus", "CHORUS"],
    ["Chorus x2", "CHORUS"],
  ];
  for (const [form, want] of forms) {
    const pasted = read(`Key: G\n\n${form}\nG           C\nPaper boats on the river`);
    assert.deepEqual(headings(pasted.chart), [want], `${form} gives ${want} (${js(pasted.chart)})`);
  }
  const repeat = sections(read(`Key: G\n\nChorus x2\nG           C\nPaper boats on the river`).chart)[0];
  assert.ok(repeat.lines.some((line) => /\bx2\b/.test(line.note ?? "")), `the repeat count is a note (${js(repeat.lines)})`);
  const tight = read(["[Verse 1]", "G           C", "Paper boats on the river", "(Bridge)", "Em          D", "Under the bridge we go"].join("\n"));
  assert.deepEqual(headings(tight.chart), ["VERSE 1", "BRIDGE"], "(Bridge) with no blank line before it still starts a section");
  for (const form of ["Intro: G D Em C", "[Intro] G D Em C"]) {
    const pasted = read(`${form}\n\n${VERSE}`);
    const [intro] = sections(pasted.chart);
    assert.equal(intro?.heading, "INTRO", `${form}: the heading (${js(pasted.chart)})`);
    assert.deepEqual(tokens(intro.lines[0]), ["G", "D", "Em", "C"], `${form}: the chords as a row below it`);
  }
});

const PLAN_SPELLINGS: [string, string][] = [
  ["C(add9)", "Cadd9"],
  ["CM7", "Cmaj7"],
  ["CΔ", "Cmaj7"],
  ["G*", "G"],
  ["(D)", "D"],
  ["C-7", "Cm7"],
  ["Cmin7", "Cm7"],
  ["Dsus", "Dsus4"],
  ["C°", "Cdim"],
  ["Co", "Cdim"],
  ["Cø", "Cm7b5"],
  ["Cm7(b5)", "Cm7b5"],
  ["C+", "Caug"],
  ["F♯m", "F#m"],
  ["G6/9", "G6/9"],
  ["E7#9", "E7#9"],
];

await check("4. each pasted spelling gives its stored spelling, which passes CHORD and comes back after +2 and -2 semitones", () => {
  const rows = [...PLAN_SPELLINGS, ...paste().SPELLINGS];
  assert.ok(paste().SPELLINGS.length > 0, "the module's spelling table has rows");
  for (const [pasted, stored] of rows) {
    const chart = read(`[Verse 1]\n${chordRow([[pasted, 0], ["G", 12]])}\nPaper boats on the river`).chart;
    const first = sections(chart)[0]?.lines[0];
    assert.equal(tokens(first)[0], stored, `${pasted} is stored as ${stored} (${js(chart)})`);
    assert.equal(first?.lyrics, "Paper boats on the river", `${pasted}: the row stays a chord row over its words`);
    const alone = sections(`${stored}\nPaper boats`)[0]?.lines[0];
    assert.equal(alone?.chords?.trim(), stored, `${stored} passes CHORD (it reads as a chord row)`);
    const up = text().transposeChordSymbol(stored, 2, false);
    assert.notEqual(up[0], stored[0], `${stored} raised two semitones moves its root (${up})`);
    assert.equal(text().transposeChordSymbol(up, -2, false), stored, `${stored} comes back after +2 and -2 (via ${up})`);
  }
});

await check("5. a chord row with row marks keeps its chords, and the mark becomes the note", () => {
  const marked: [string, string[], RegExp | null][] = [
    ["G - D - Em - C (x2)", ["G", "D", "Em", "C"], /x2/],
    ["G D Em C x2", ["G", "D", "Em", "C"], /x2/],
    ["G  D  (hold)", ["G", "D"], /hold/],
  ];
  for (const [row, chords, note] of marked) {
    const [intro] = sections(read(`[Intro]\n${row}\n\n${VERSE}`).chart);
    assert.deepEqual(tokens(intro?.lines[0]), chords, `${row} keeps ${chords.join(" ")} (${js(intro?.lines)})`);
    if (note) assert.match(intro.lines[1]?.note ?? "", note, `${row}: the mark is the note under it`);
  }
  const over = `[Verse 1]\nG - C (x2)\nPaper boats on the river`;
  const verse = sections(read(over).chart)[0];
  assert.deepEqual(tokens(verse.lines[0]), ["G", "C"], "over words, the chords stay");
  assert.equal(verse.lines[0].lyrics, "Paper boats on the river", "over the same words");
  assert.deepEqual(places([{ chords: verse.lines[0].chords ?? "", lyrics: verse.lines[0].lyrics }]), places([{ chords: "G   C", lyrics: "Paper boats on the river" }]), "each chord at its pasted column");
  assert.ok(verse.lines.some((line) => /x2/.test(line.note ?? "")), "and the mark is a note");
});

await check("6. in a chord row over a lyric row, every chord starts over the same letter after the paste as before", () => {
  const lyric = "Paper boat on the river";
  const pasted: [string, number][] = [["G*", 0], ["CM7", 6], ["Am", 11], ["Dsus", 18]];
  const before = [{ chords: chordRow(pasted), lyrics: lyric }];
  const after = pairs(read(`Key: G\n[Verse 1]\n${chordRow(pasted)}\n${lyric}`).chart);
  assert.deepEqual(after.flatMap((row) => row.chords.trim().split(/\s+/)), ["G", "Cmaj7", "Am", "Dsus4"], "one shrinks, one grows into its neighbour, one grows with room");
  assert.deepEqual(places(after), places(before), `each chord over the letter it was pasted over (${js(after)})`);
  assert.deepEqual(lyricWords(after), lyricWords(before), "and the words are the same words");
});

await check("7. tabs, no-break spaces, zero-width characters, sharps, flats and CRLF are cleaned", () => {
  const pasted = read("[Verse 1]\r\nF♯m\tB♭   C\r\nPa​per boats\ton the river﻿\r\n");
  for (const bad of ["\r", "\t", " ", "​", "﻿", "♯", "♭"]) assert.ok(!pasted.chart.includes(bad), `no ${js(bad)} left (${js(pasted.chart)})`);
  const line = sections(pasted.chart)[0]?.lines[0];
  assert.deepEqual([line?.chords, line?.lyrics], ["F#m     Bb   C", "Paper boats     on the river"], "columns kept at the 8-column tab stops");
});

const BASS_TAB = ["G|-----------------|", "D|-----5-----7-----|", "A|--5-----5-----5--|", "E|-----------------|"];
const GUITAR_TAB = ["e|---3---2---0---|", "B|---0---3---1---|", "G|---0---2---0---|", "D|---0---0---2---|", "A|---2-------3---|", "E|---3-----------|"];

await check("8. a four-line bass tab and a six-line guitar tab are left out and counted; no tab line becomes a heading", () => {
  for (const [what, tab] of [["bass", BASS_TAB], ["guitar", GUITAR_TAB]] as const) {
    const pasted = read(["[Riff]", ...tab, "", VERSE].join("\n"));
    assert.equal(leftOut(pasted, "tab lines"), tab.length, `${what}: ${tab.length} tab lines counted (${js(pasted.leftOut)})`);
    assert.deepEqual(headings(pasted.chart), ["RIFF", "VERSE 1"], `${what}: no tab line is a heading`);
    assert.ok(!/\|-/.test(pasted.chart), `${what}: no tab line stays (${js(pasted.chart)})`);
  }
});

await check("9. lines above the first section are left out of a chart, kept in words alone, and cut at the first chord row with no heading", () => {
  const site = read(["Paper Boats Chords by The Made Up Band", "Difficulty: novice", "Tuning: E A D G B E", "Strumming: down up", "", VERSE].join("\n"));
  assert.equal(leftOut(site, "lines above the first section"), 4, `four site lines left out (${js(site.leftOut)})`);
  assert.equal(lines(site.chart)[0], "VERSE 1", `the chart starts at its first section (${js(site.chart)})`);
  const words = ["Paper boats on the river", "Float away, float away", "", "Rain on the window pane"].join("\n");
  const kept = read(words);
  assert.deepEqual([kept.chart, kept.leftOut], [words, []], "a paste of words keeps every line");
  const bare = read(["Paper Boats Chords by The Made Up Band", "Tuning: E A D G B E", "G           C", "Paper boats on the river"].join("\n"));
  assert.equal(leftOut(bare, "lines above the first section"), 2, `with no heading, the lines above the first chord row (${js(bare.leftOut)})`);
  assert.deepEqual(tokens(sections(bare.chart)[0]?.lines[0]), ["G", "C"], "and the first chord row starts the first section");
});

await check("10. a capo raises every chord by default, sets the note, and the switch gives the shapes back", () => {
  const body = ["[Verse 1]", "G      C       D", "Paper boats on the river"].join("\n");
  const sounding = read(`Capo: 2nd fret\n${body}`);
  assert.equal(sounding.facts.capo, 2, "capo 2 found");
  assert.deepEqual(tokens(sections(sounding.chart)[0]?.lines[0]), ["A", "D", "E"], `chords as they sound (${js(sounding.chart)})`);
  assert.deepEqual([sounding.facts.keyRoot, sounding.facts.keyMode], ["A", "major"], "the key as it sounds");
  assert.equal(paste().capoNote(2), "Capo 2 for guitar", "the key note");
  assert.deepEqual(places(pairs(sounding.chart)), places(pairs(body)), "each raised chord over its pasted letter");
  const shapes = read(`Capo: 2nd fret\n${body}`, "shapes");
  assert.deepEqual(tokens(sections(shapes.chart)[0]?.lines[0]), ["G", "C", "D"], "the switch gives the shapes back");
  assert.deepEqual([shapes.facts.capo, shapes.facts.keyRoot], [2, "G"], "with the shapes' key and the capo still known");
  assert.match(paste().capoNote(2, "shapes"), /Capo 2/, "and a note that still names the capo");
  for (const header of ["Key: G", "Key: A"]) {
    const keyed = read(`${header}\nCapo 2\n${body}`);
    assert.equal(keyed.facts.keyRoot, "A", `${header} over G shapes with capo 2 sounds in A`);
  }
});

await check("11. keyFromChords: G major, A minor, E major, and null with no chords", () => {
  const key = (chart: string) => paste().keyFromChords(sections(chart));
  assert.deepEqual(key("G D Em C"), { keyRoot: "G", keyMode: "major" });
  assert.deepEqual(key("Am F C G"), { keyRoot: "A", keyMode: "minor" });
  assert.deepEqual(key("E A B7"), { keyRoot: "E", keyMode: "major" });
  assert.equal(key("Paper boats on the river"), null, "words alone");
  assert.equal(paste().keyFromChords([]), null, "no sections");
});

await check("12. a paste of words alone gives sections split at blank lines, and no facts", () => {
  const pasted = read(["Paper boats on the river", "Float away, float away", "", "Rain on the window pane", "Into the morning light"].join("\n"));
  assert.deepEqual(pasted.facts, {}, "no facts");
  const parts = sections(pasted.chart);
  assert.equal(parts.length, 2, "two sections");
  assert.deepEqual(parts.map((section) => section.lines.map((line) => line.lyrics)), [["Paper boats on the river", "Float away, float away"], ["Rain on the window pane", "Into the morning light"]]);
});

await check("13. readPaste is stable: its own output reads back as the same chart, and a chart the app already reads stays as pasted", () => {
  assert.ok(FIXTURES.length > 20, "the fixtures above ran");
  for (const fixture of FIXTURES) {
    const once = paste().readPaste(fixture).chart;
    assert.equal(paste().readPaste(once).chart, once, `stable for ${js(fixture.slice(0, 40))}`);
  }
  const typed = ["[Intro]", "| A | E |", "", "[A]Honey, load up your ques[Am7]ti[E]ons", "", "CHORUS", "D        A", "Fire away, fire away"].join("\n");
  assert.equal(paste().readPaste(typed).chart, typed, "a chart with nothing to clean is kept as pasted");
  const library = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: { title: string; body: Section[] }[] };
  for (const song of library.songs) {
    const own = text().sectionsToText(song.body);
    assert.equal(paste().readPaste(own).chart, own, `${song.title}: a chart as the app writes it comes back unchanged`);
  }
});

await check("14. src/song-paste.ts makes no network call", () => {
  const file = join(root, "src", "song-paste.ts");
  assert.ok(existsSync(file), "src/song-paste.ts exists");
  const source = readFileSync(file, "utf8");
  for (const banned of ["fetch", "XMLHttpRequest", "WebSocket", "import("]) assert.ok(!source.includes(banned), `no ${banned}`);
});

// Screen cases.

/** A chord chart as a site shows it: site lines, header facts, tab, and two odd spellings. */
const WEB = [
  "Paper Boats Chords by The Made Up Band",
  "Difficulty: novice",
  "Tuning: E A D G B E",
  "Key: G",
  "Tempo: 120 bpm",
  "",
  "[Verse 1]",
  "G           C(add9)",
  "Paper boats on the river",
  "Em          D",
  "Rain on the window pane",
  "",
  ...GUITAR_TAB,
  "",
  "[Chorus]",
  "C           G*",
  "Float away, float away",
  "D        Em",
  "Into the morning light",
].join("\n");
const CAPO_WEB = `Capo: 2nd fret\n${WEB}`;
/** The chart the Live box names: a capo, [Chorus] and C(add9). */
const LIVE = ["Capo: 2nd fret", "", "[Verse 1]", "G      C(add9)    D", "Paper boats on the river", "", "[Chorus]", "Em        C(add9)  G", "Float away into the morning"].join("\n");
/** Each pasted chord row over its words, as the player copied it. */
const pastedPairs = (chart: string): Row[] => {
  const all = lines(chart);
  return all.flatMap((line, index) => (index + 1 < all.length && /^[A-G]/.test(line) && !line.includes("|") && /[a-z]{3}/.test(all[index + 1]) && !all[index + 1].includes(":") ? [{ chords: line, lyrics: all[index + 1] }] : []));
};

const ACCOUNT = { userId: "u_song_paste", handle: "pat", displayName: "Pat Bass", ways: [] };
const SCREEN_CASES = [
  "15. in New song, Paste a sheet with a web chart fills Key and BPM, shows the status line, and draws VERSE 1 and CHORUS, at 360 px and 390 px",
  "16. chords sit over their syllables in the preview and on the saved sheet",
  "17. on a song in A minor, a pasted chart in G leaves the key alone and shows Use G major; one tap sets it",
  "18. the capo switch changes the chords in the preview",
  "19. Use it as pasted puts the raw text in the box",
  "20. with the clipboard refused the editor says Paste your sheet into the box., and a keyboard paste into the empty box is cleaned",
  "21. after Save the sheet shows the chart, and after a reload with the network off it still does",
  "22. every new control is at least 44 px tall and not clipped at 360 px and 390 px",
  "P. perf: at 4x CPU slowdown, the tap on Paste a sheet draws a 300-line chart within 100 ms of drawing the same text typed in",
];

const api = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  response.writeHead(path === "/api/me" ? 200 : 404, { "content-type": "application/json" });
  response.end(js(path === "/api/me" ? { account: ACCOUNT } : { error: "not-found" }));
});
await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
const apiAddress = api.address();
const apiBase = `http://127.0.0.1:${typeof apiAddress === "object" && apiAddress ? apiAddress.port : 0}`;

let site: Site | null = null;
try {
  site = await openSite(root, "check-song-paste", () => apiBase);
} catch (error) {
  for (const name of SCREEN_CASES) {
    failed += 1;
    console.log(`FAIL ${name}: the app or Chrome did not start (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
  }
}

if (site) {
  const s = site;
  try {
    const app = await appPage(s);
    const HEIGHT = 780;
    const phone = async (width: number) => {
      await s.send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: 2, mobile: true });
      await s.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`);
    };
    const editor = `document.querySelector(".song-editor[role=dialog]")`;
    const field = (label: string) => `[...${editor}.querySelectorAll("label")].find((l) => l.textContent.trim() === ${js(label)})?.control`;
    const mode = `${editor}.querySelector('select[aria-label="Major or minor"]')`;
    const fill = async (label: string, value: string) => {
      const set = await s.evaluate<boolean>(`(() => {
        const el = ${field(label)};
        if (!el) return false;
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, ${js(value)});
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
        return true;
      })()`);
      assert.ok(set, `a ${label} field`);
      await sleep(150);
    };
    const value = (label: string) => s.evaluate<string>(`${field(label)}?.value ?? ""`);
    const tap = (label: string, scope = editor) => app.click(label, scope);
    const editorText = () => s.evaluate<string>(`${editor}?.textContent ?? ""`);
    const clipboard = (pasted: string | null) =>
      s.evaluate(
        `Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: () => ${pasted === null ? `Promise.reject(new DOMException("No", "NotAllowedError"))` : `Promise.resolve(${js(pasted)})`} } })`,
      );
    const addButton = `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "+ Add a song")`;
    const openNew = async () => {
      await s.evaluate(`document.querySelector(".song-editor") && [...${editor}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Cancel")?.click()`);
      await s.evaluate(`location.hash = "#/songs"`);
      await app.until(`!!${addButton} && !document.querySelector(".song-editor")`, "My Songs");
      await app.click("+ Add a song");
      await app.until(`!!${editor}`, "the New song editor");
    };
    const pasteTap = async (pasted: string | null) => {
      await clipboard(pasted);
      await tap("Paste a sheet");
    };
    const previewHeadings = () => app.texts(".song-editor-preview .chart-heading");
    const firstChords = (scope: string) => s.evaluate<string>(`(document.querySelector(${js(`${scope} .pair .chords`)})?.textContent ?? "").trim().split(/\\s+/)[0]`);
    const stored = () => s.evaluate<{ id: number; title: string; keyNote: string; body: Section[] }[]>(`JSON.parse(localStorage.getItem("leadSheetsLibrary") ?? "{}").songs ?? []`);
    /** Each drawn chord row in `scope`, with the lyric column every chord glyph starts over (the measure check:chords uses). */
    const drawn = (scope: string) =>
      s.evaluate<Row[]>(`(() => {
        const chart = document.querySelector(${js(`${scope} .chart`)});
        if (!chart) return [];
        const range = (node, from, to) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return r.getBoundingClientRect(); };
        return [...chart.querySelectorAll(".pair")].map((row) => {
          const chords = row.querySelector(".chords");
          const lyrics = row.querySelector(".lyrics");
          const text = chords.textContent;
          const lyric = lyrics?.textContent ?? "";
          const left = (lyrics ?? chords).getBoundingClientRect().left;
          const sample = lyric ? { node: lyrics.firstChild, length: lyric.length } : { node: chords.firstChild, length: text.length };
          const advance = range(sample.node, 0, sample.length).width / sample.length;
          const at = [...text.matchAll(/\\S+/g)].map((chord) => Math.round((range(chords.firstChild, chord.index, chord.index + 1).left - left) / advance));
          return { chords: text, lyrics: lyrics ? lyric : undefined, at };
        });
      })()`);
    type Box = { left: number; right: number; top: number; bottom: number; h: number; clipped: boolean; inner: number; page: number };
    const glove = async (expression: string, what: string, width: number) => {
      const box = await s.evaluate<Box | null>(`(() => {
        const el = ${expression};
        if (!el || !el.getClientRects().length) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, h: r.height, clipped: el.scrollWidth > el.clientWidth + 1, inner: innerWidth, page: document.documentElement.scrollWidth };
      })()`);
      assert.ok(box, `${what} is visible at ${width} px`);
      assert.ok(box.h >= 44, `${what} is ${box.h} px tall at ${width} px`);
      assert.ok(box.left >= 0 && box.right <= box.inner + 0.5, `${what} runs ${box.left}..${box.right} in a ${box.inner} px screen`);
      assert.ok(box.top >= 0 && box.bottom <= HEIGHT + 0.5, `${what} is on screen`);
      assert.ok(!box.clipped, `${what} is not clipped at ${width} px`);
      assert.ok(box.page <= box.inner + 0.5, `the page scrolls sideways at ${width} px`);
    };
    const button = (label: string) => `[...${editor}.querySelectorAll("button")].find((b) => b.textContent.trim() === ${js(label)})`;

    await phone(390);
    await s.send("Page.navigate", { url: `${s.origin}/#/songs` });
    await app.library();
    await s.evaluate(`localStorage.setItem("leadSheetsSignedIn", ${js(ACCOUNT.userId)})`);
    await s.send("Page.reload");
    await app.library();
    await app.until(`!!${addButton}`, "+ Add a song, signed in", 15000);

    await check(SCREEN_CASES[0], async () => {
      for (const width of [360, 390]) {
        await phone(width);
        await openNew();
        await pasteTap(WEB);
        await app.until(`document.querySelectorAll(".song-editor-preview .chart-heading").length >= 2`, "the preview's sections");
        assert.deepEqual(await previewHeadings(), ["VERSE 1", "CHORUS"], `${width} px: the preview draws the two sections`);
        assert.deepEqual([await value("Key"), await s.evaluate<string>(`${mode}.value`), await value("BPM")], ["G", "major", "120"], `${width} px: Key and BPM filled`);
        const words = await editorText();
        for (const part of ["Found key G", "120 bpm", "Left out 6 tab lines", "3 lines above the first section"]) assert.ok(words.includes(part), `${width} px: the status line says ${part}`);
      }
    });

    await check(SCREEN_CASES[1], async () => {
      await phone(390);
      await openNew();
      await pasteTap(WEB);
      await app.until(`document.querySelectorAll(".song-editor-preview .chart-heading").length >= 2`, "the preview");
      assert.equal(pastedPairs(WEB).length, 4, "four chord rows pasted");
      const want = places(pastedPairs(WEB));
      const preview = await drawn(".song-editor-preview");
      assert.deepEqual(places(preview), want, `the preview draws each chord over its pasted letter (${js(preview)})`);
      await fill("Title", "Paper Boats");
      await tap("Save");
      await app.until(`/^#\\/song\\/\\d+/.test(location.hash) && !document.querySelector(".song-editor")`, "the saved song's page");
      await app.until(`!!document.querySelector(".sheet .chart .pair")`, "the saved sheet's chart");
      const sheet = await drawn(".sheet");
      assert.deepEqual(places(sheet), want, `the saved sheet draws each chord over its pasted letter (${js(sheet)})`);
    });

    await check(SCREEN_CASES[2], async () => {
      await openNew();
      await fill("Title", "Minor Kitchen");
      await fill("Key", "A");
      await s.evaluate(`(() => { const el = ${mode}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, "minor"); el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await fill("Chart", "[Verse 1]\nAm          F\nPaper boats on the river");
      await tap("Save");
      await app.until(`/^#\\/song\\/\\d+/.test(location.hash) && !document.querySelector(".song-editor")`, "the A minor song's page");
      await s.evaluate(`document.querySelector('.shell-header [aria-label="More"]').click()`);
      await app.until(`!!document.querySelector("[role=menu]")`, "the More menu");
      await app.click("Edit", `document.querySelector("[role=menu]")`);
      await app.until(`!!${editor}`, "Edit song");
      await pasteTap(WEB);
      await app.until(`!!${button("Use G major")}`, "the Use G major chip");
      assert.deepEqual([await value("Key"), await s.evaluate<string>(`${mode}.value`)], ["A", "minor"], "the song's key is left alone");
      await tap("Use G major");
      assert.deepEqual([await value("Key"), await s.evaluate<string>(`${mode}.value`)], ["G", "major"], "one tap sets G major");
      assert.equal(await s.evaluate<boolean>(`!!${button("Use G major")}`), false, "and the chip goes");
    });

    await check(SCREEN_CASES[3], async () => {
      await openNew();
      await pasteTap(LIVE);
      await app.until(`!!document.querySelector(".song-editor-preview .pair")`, "the preview");
      assert.equal(await firstChords(".song-editor-preview"), "A", "chords as they sound by default");
      await tap("Show guitar shapes");
      await app.until(`(document.querySelector(".song-editor-preview .pair .chords")?.textContent ?? "").trim().startsWith("G")`, "the shapes in the preview");
      assert.equal(await firstChords(".song-editor-preview"), "G", "the switch shows the shapes");
    });

    await check(SCREEN_CASES[4], async () => {
      await openNew();
      await pasteTap(WEB);
      await app.until(`!!${button("Use it as pasted")}`, "Use it as pasted");
      assert.notEqual(await value("Chart"), WEB, "the box holds the cleaned chart first");
      await tap("Use it as pasted");
      assert.equal(await value("Chart"), WEB, "Use it as pasted puts the raw text in the box");
    });

    await check(SCREEN_CASES[5], async () => {
      await openNew();
      await pasteTap(null);
      await app.until(`${editor}.textContent.includes("Paste your sheet into the box.")`, "the fallback words");
      assert.ok(await s.evaluate<boolean>(`document.activeElement === ${field("Chart")}`), "with the cursor in the box");
      const keyboard = (pasted: string) =>
        s.evaluate<boolean>(`(() => { const data = new DataTransfer(); data.setData("text/plain", ${js(pasted)}); return !${field("Chart")}.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); })()`);
      assert.equal(await keyboard(WEB), true, "the app takes a keyboard paste into the empty box");
      await app.until(`${field("Chart")}.value.includes("VERSE 1")`, "the cleaned chart in the box");
      const box = await value("Chart");
      assert.ok(!box.includes("Tuning:") && !box.includes("e|") && !box.includes("Key: G"), `the keyboard paste is cleaned (${js(box)})`);
      assert.equal(await value("BPM"), "120", "and its facts fill the fields");
      assert.equal(await keyboard("Rain on the window pane"), false, "a paste into a box that has text is left to the box");
    });

    await check(SCREEN_CASES[6], async () => {
      await openNew();
      await s.evaluate(`delete navigator.clipboard`);
      await s.send("Browser.grantPermissions", { origin: s.origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
      await s.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await s.evaluate(`navigator.clipboard.writeText(${js(LIVE)})`);
      await tap("Paste a sheet");
      await app.until(`document.querySelectorAll(".song-editor-preview .chart-heading").length === 2`, "the preview from the real clipboard");
      await fill("Title", "Paper Boats Live");
      await tap("Save");
      await app.until(`/^#\\/song\\/\\d+/.test(location.hash) && !document.querySelector(".song-editor")`, "the saved song's page");
      const shows = async (where: string) => {
        await app.until(`document.querySelector(".sheet .sheet-name")?.textContent === "Paper Boats Live" && !!document.querySelector(".sheet .chart .pair")`, `the sheet ${where}`, 15000);
        assert.deepEqual(await app.texts(".sheet .chart-heading"), ["VERSE 1", "CHORUS"], `${where}: the headings`);
        assert.ok((await app.text(".sheet")).includes("Capo 2 for guitar"), `${where}: the capo note`);
        assert.deepEqual(places(await drawn(".sheet")), places(pastedPairs(LIVE)), `${where}: each chord over the word it was pasted over`);
      };
      await shows("after Save");
      const saved = (await stored()).find((song) => song.title === "Paper Boats Live");
      assert.equal(saved?.keyNote, "Capo 2 for guitar", "the note is stored with the song");
      await app.until(`!!navigator.serviceWorker?.controller`, "the service worker", 15000);
      await s.send("Network.enable");
      await s.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      try {
        assert.equal(await s.evaluate<string>(`fetch("/index.html?probe=" + Date.now(), { cache: "no-store" }).then(() => "online", () => "offline")`), "offline", "the network is off");
        await s.send("Page.reload");
        await sleep(500);
        await shows("after a reload with the network off");
      } finally {
        await s.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      }
    });

    await check(SCREEN_CASES[7], async () => {
      await phone(390);
      await openNew();
      await fill("Key", "D");
      await fill("BPM", "90");
      await pasteTap(CAPO_WEB);
      await app.until(`!!${button("Show guitar shapes")}`, "the capo switch");
      const controls = ["Use A major", "Use 120 bpm", "Show guitar shapes", "Use it as pasted"];
      for (const width of [360, 390]) {
        await phone(width);
        for (const label of controls) await glove(button(label), label, width);
      }
      await phone(390);
    });

    await check(SCREEN_CASES[8], async () => {
      const verse = (n: number) => [`[Verse ${n}]`, "G           C(add9)", "Paper boats on the river", "Em          D", "Rain on the window pane", "C           G*", "Float away, float away", "D        Em", "Into the morning light", ""];
      const big = ["Paper Boats Chords by The Made Up Band", "Key: G", "Tempo: 120 bpm", "", ...Array.from({ length: 30 }, (_, k) => verse(k + 1)).flat()].join("\n");
      assert.ok(lines(big).length >= 300, "a 300-line chart");
      const time = (start: string) =>
        s.evaluate<number>(`new Promise((done) => {
          const t0 = performance.now();
          ${start};
          const wait = () => (document.querySelectorAll(".song-editor-preview .chart-heading").length >= 30 ? done(performance.now() - t0) : requestAnimationFrame(wait));
          requestAnimationFrame(wait);
        })`);
      await s.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      try {
        await openNew();
        const typed = await time(`(() => { const el = ${field("Chart")}; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${js(big)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
        await openNew();
        await clipboard(big);
        const tapped = await time(`${button("Paste a sheet")}.click()`);
        console.log(`     perf: typed in ${typed.toFixed(0)} ms, Paste a sheet ${tapped.toFixed(0)} ms`);
        assert.deepEqual((await previewHeadings()).slice(0, 2), ["VERSE 1", "VERSE 2"], "the tap drew the cleaned chart");
        assert.ok(tapped <= typed + 100, `Paste a sheet took ${tapped.toFixed(0)} ms, the typed text ${typed.toFixed(0)} ms`);
      } finally {
        await s.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      }
    });
  } finally {
    await s.close();
  }
}
api.close();

if (failed) {
  console.log(`check:song-paste: ${failed} failed`);
  process.exit(1);
}
console.log("check:song-paste: all passed");
