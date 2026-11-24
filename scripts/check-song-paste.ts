import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  LEFT_OUT: readonly string[];
};
type TextModule = {
  parseSheet: (text: string) => { sections: Section[]; warnings: { line: number; message: string }[] };
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

await check("6b. a chord that grows into its neighbour inside one word is warned in the editor, not moved in silence", () => {
  const tight: [string, string, string[], string][] = [
    ["Key: C", "CM7 F\nLovely day for it", ["Cmaj7", "F"], "Lovely"],
    ["Capo 2", "Em D C G\nPaper boats on the water", ["F#m", "E", "D", "A"], "Paper"],
  ];
  for (const [header, row, chords, word] of tight) {
    const chart = read(`${header}\n[Verse 1]\n${row}`).chart;
    const verse = sections(chart)[0];
    assert.deepEqual(tokens(verse?.lines[0]), chords, `${header}: the chords respelled (${js(chart)})`);
    assert.deepEqual(verse?.lines[0]?.lyrics?.split(/\s+/), row.split("\n")[1].split(/\s+/), `${header}: over the same words`);
    const warnings = text().parseSheet(chart).warnings;
    assert.ok(warnings.some((warning) => warning.message.includes(`'${word}'`)), `${header}: the editor warns about '${word}' (${js(warnings)}, ${js(chart)})`);
  }
});

await check("7. tabs, no-break spaces, zero-width characters, sharps, flats and CRLF are cleaned", () => {
  const pasted = read("[Verse 1]\r\nF♯m\tB♭\u00a0\u00a0 C\r\nPa\u200bper\u00a0boats\ton the river\ufeff\r\n");
  for (const bad of ["\r", "\t", "\u00a0", "\u200b", "\ufeff", "♯", "♭"]) assert.ok(!pasted.chart.includes(bad), `no ${js(bad)} left (${js(pasted.chart)})`);
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

/** For each kind of line a paste leaves out: two such lines, where they sit in the paste, and the status line's word for one. */
const LEFT_OUT_PASTES: Record<string, { lines: [string, string]; above?: true; one: string }> = {
  "tab lines": { lines: ["G|-----5-----7-----|", "D|--5-----5-----5--|"], one: "tab line" },
  "lines above the first section": { lines: ["Difficulty: novice", "Tuning: E A D G B E"], above: true, one: "line above the first section" },
  directives: { lines: ["{new_song_page}", "{column_break}"], one: "directive" },
  "site lines": { lines: ["Login to add to songbook", "Tabbed by Nobody Real"], one: "site line" },
};
const leftOutKinds = () => {
  const kinds = paste().LEFT_OUT;
  assert.ok(Array.isArray(kinds) && kinds.length > 0, "src/song-paste.ts exports LEFT_OUT, every kind of line a paste leaves out");
  return kinds;
};
const leavingOut = (what: string, count: 1 | 2) => {
  const row = LEFT_OUT_PASTES[what];
  assert.ok(row, `LEFT_OUT_PASTES has a paste that leaves out ${js(what)}`);
  const left = row.lines.slice(0, count);
  return { left, pasted: (row.above ? [...left, "", VERSE] : [VERSE, "", ...left]).join("\n") };
};

await check("9b. every kind of left-out line is counted under its own name, for one line and for two, and leaves the chart", () => {
  for (const what of leftOutKinds()) {
    for (const count of [1, 2] as const) {
      const { left, pasted } = leavingOut(what, count);
      const got = read(pasted);
      assert.deepEqual(got.leftOut, [{ count, what }], `${count} of ${js(what)} counted and nothing else (${js(got.leftOut)})`);
      assert.deepEqual(headings(got.chart), ["VERSE 1"], `${count} of ${js(what)}: the verse stays (${js(got.chart)})`);
      for (const line of left) assert.ok(!got.chart.includes(line), `${js(line)} leaves the chart (${js(got.chart)})`);
    }
  }
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

// A phone that copies a chord page puts each chord and the words under it on lines of their own, with a blank line
// where the page broke a lyric line, so these charts come as a page copy and as the same chart typed with columns.
const CHROME_WORDS = /\bvotes?\b|\d\s*\/\s*5\b|log\s?in|songbook|tabbed by|\bchords\b/i;
/** The lines of a section that are chord rows over words, and the words of each. */
const sung = (section: Section | undefined) => (section?.lines ?? []).filter((line) => line.lyrics !== undefined);
const rowsOf = (section: Section | undefined): Row[] => sung(section).flatMap((line) => (line.chords === undefined ? [] : [{ chords: line.chords, lyrics: line.lyrics }]));

await check("12b. a chord page with site lines gives its title and artist, Intro with its instructions as notes, and Verse and Chorus with each chord over its syllable", () => {
  const page = [
    "3.4/5 · 2 votes",
    "Login to add to songbook",
    "Paper Lanterns chords",
    "The Hollow Pines",
    "Tabbed by Nobody Real",
    "",
    "[Intro]",
    "Form a D chord, then pick the single strings D D B/G",
    "Form a C chord, then pick the single strings A A B/G",
    "Play four times.",
    "",
    "D",
    "",
    "C",
    "",
    "G",
    "",
    "[Verse]",
    "D",
    "Tall",
    "",
    "C",
    "lanterns",
    "over the",
    "G",
    "water",
    "",
    "D",
    "Carry",
    "my",
    "C",
    "boat",
    "along the",
    "G",
    "shore.",
    "",
    "[Chorus]",
    chordRow([["G", 0], ["C", 6], ["D", 17]]),
    "Paper lights are falling",
    chordRow([["G", 0], ["C", 5], ["D", 14]]),
    "Down upon the harbor",
  ].join("\n");
  const pasted = read(page);
  assert.deepEqual([pasted.facts.title, pasted.facts.artist], ["Paper Lanterns", "The Hollow Pines"], `title and artist from the header (${js(pasted.facts)})`);
  assert.ok(!CHROME_WORDS.test(pasted.chart), `no rating, vote, login, songbook, credit or "chords" title line in the chart (${js(pasted.chart)})`);
  assert.ok(!/Paper Lanterns|Hollow Pines/.test(pasted.chart), "the title and artist lines leave the chart");
  assert.equal(leftOut(pasted, "lines above the first section"), 5, `the five header lines are left out (${js(pasted.leftOut)})`);
  const [intro, verse, chorus, ...more] = sections(pasted.chart);
  assert.deepEqual(headings(pasted.chart), ["INTRO", "VERSE 1", "CHORUS"], `the page's three sections and no other (${js(pasted.chart)})`);
  assert.equal(more.length, 0, "no section per line");
  assert.deepEqual(
    intro.lines.flatMap((line) => (line.note === undefined ? [] : [line.note])),
    ["Form a D chord, then pick the single strings D D B/G", "Form a C chord, then pick the single strings A A B/G", "Play four times."],
    `the instructions are notes on the intro (${js(intro.lines)})`,
  );
  assert.ok(intro.lines.every((line) => line.lyrics === undefined), "the intro has no sung words");
  assert.deepEqual(intro.lines.flatMap(tokens), ["D", "C", "G"], "the intro's chords in order");
  const typed: Row[] = [
    { chords: chordRow([["D", 0], ["C", 5], ["G", 23]]), lyrics: "Tall lanterns over the water" },
    { chords: chordRow([["D", 0], ["C", 9], ["G", 24]]), lyrics: "Carry my boat along the shore." },
  ];
  assert.deepEqual(sung(verse).map((line) => line.lyrics?.replace(/\s+/g, " ")), typed.map((row) => row.lyrics), `each lyric line whole (${js(verse.lines)})`);
  assert.ok(verse.lines.every((line) => line.lyrics !== undefined && line.chords !== undefined), "the verse is chord rows over words, nothing else");
  assert.deepEqual(places(rowsOf(verse)), places(typed), "each chord over the syllable the page put it on");
  assert.deepEqual(sung(chorus).map((line) => line.lyrics), ["Paper lights are falling", "Down upon the harbor"], "the chorus as pasted");
  assert.deepEqual(places(rowsOf(chorus)), places([{ chords: chordRow([["G", 0], ["C", 6], ["D", 17]]), lyrics: "Paper lights are falling" }, { chords: chordRow([["G", 0], ["C", 5], ["D", 14]]), lyrics: "Down upon the harbor" }]), "and its chords where they were");
});

await check("12c. a chord-over-words stanza gives one section with every chord over its letter, typed with columns or as a page copy", () => {
  const typed = [chordRow([["G", 0], ["C", 13]]), "Morning tide on the harbor", chordRow([["D", 0], ["G", 13]]), "Sails go out and come back"].join("\n");
  const copy = ["G", "Morning tide", "C", "on the harbor", "", "D", "Sails go out", "G", "and come back"].join("\n");
  const want = pairs(typed);
  for (const [form, chart] of [["typed", typed], ["page copy", copy]] as const) {
    const parts = sections(read(chart).chart);
    assert.equal(parts.length, 1, `${form}: one section (${js(parts)})`);
    assert.deepEqual(sung(parts[0]).map((line) => line.lyrics?.replace(/\s+/g, " ")), ["Morning tide on the harbor", "Sails go out and come back"], `${form}: two whole lyric lines`);
    assert.deepEqual(places(pairs(read(chart).chart)), places(want), `${form}: each chord over its letter`);
    assert.deepEqual(lyricWords(pairs(read(chart).chart)), lyricWords(want), `${form}: the same words`);
  }
  const stanzas = sections(read(`${typed}\n\n${typed}`).chart);
  assert.equal(stanzas.length, 2, "two stanzas are two sections");
});

await check("12d. a ChordPro paste among site lines keeps its title, artist, sections and inline chords, and leaves the site lines out", () => {
  const pasted = read(
    [
      "4.1/5 · 9 votes",
      "{title: Lantern Song}",
      "{artist: The Hollow Pines}",
      "{start_of_verse}",
      "[G]Lanterns on the [C]water",
      "[D]Carry me a[G]long",
      "{end_of_verse}",
      "",
      "{start_of_chorus}",
      "[C]Light the [G]harbor",
      "{end_of_chorus}",
      "",
      "Login to add to songbook",
      "Tabbed by Nobody Real",
    ].join("\n"),
  );
  assert.deepEqual([pasted.facts.title, pasted.facts.artist], ["Lantern Song", "The Hollow Pines"], "title and artist from the directives");
  assert.deepEqual(headings(pasted.chart), ["VERSE 1", "CHORUS"], `the two sections and no other (${js(pasted.chart)})`);
  assert.ok(!CHROME_WORDS.test(pasted.chart), `no site line in the chart (${js(pasted.chart)})`);
  const [verse, chorus] = sections(pasted.chart);
  assert.deepEqual([sung(verse).map((line) => line.lyrics), sung(chorus).map((line) => line.lyrics)], [["Lanterns on the water", "Carry me along"], ["Light the harbor"]], "the words of each line whole");
  assert.deepEqual(places(pairs(pasted.chart)), places(pairs("[G]Lanterns on the [C]water\n[D]Carry me a[G]long\n\n[C]Light the [G]harbor")), "each inline chord on its syllable");
});

await check("12e. a paste of words with site lines and a blank line after every line gives its stanzas, whole lines and no facts", () => {
  const words = ["Lanterns on the water", "Carry me along the shore", "Light the harbor, light the bay", "Bring the paper boats back home"];
  const pasted = read(["3.9/5 · 7 votes", "Login to add to songbook", "", words[0], "", words[1], "", "", words[2], "", words[3]].join("\n"));
  assert.deepEqual(pasted.facts, {}, "no facts");
  assert.ok(!CHROME_WORDS.test(pasted.chart), `no site line in the chart (${js(pasted.chart)})`);
  assert.deepEqual(sections(pasted.chart).map((section) => section.lines.map((line) => line.lyrics)), [words.slice(0, 2), words.slice(2)], `two stanzas of two whole lines (${js(pasted.chart)})`);
  const plain = read([words[0], words[1], "", words[2], words[3]].join("\n"));
  assert.deepEqual([plain.chart, plain.facts], [[words[0], words[1], "", words[2], words[3]].join("\n"), {}], "the same words typed plainly stay as pasted");
});

await check("12f. short lines typed with one chord each stay lines; only words that run on are a page copy", () => {
  const typed = ["G", "Oh yeah", "C", "Oh no", "", "D", "Hey there", "G", "Go now"].join("\n");
  assert.equal(read(typed).chart, typed, "a chart the app already reads stays as pasted");
  assert.deepEqual(sections(read(typed).chart).map((section) => section.lines.map((line) => line.lyrics)), [["Oh yeah", "Oh no"], ["Hey there", "Go now"]], "each line its own");
});

const notes = (section: Section | undefined) => (section?.lines ?? []).flatMap((line) => (line.note === undefined ? [] : [line.note]));

await check("12g. blank lines inside an intro keep its instructions as notes on the intro, with no verse the page never named", () => {
  const steps = ["Form a D chord, then pick the single strings D D B/G", "Form a C chord, then pick the single strings A A B/G"];
  const verse = ["D", "Big", "", "C", "lanterns", "keep on", "G", "burning", "", "D", "Carry", "me", "C", "home", "to see my", "G", "kin."];
  const pages = [
    ["the smallest", ["[Intro]", "Form a D chord, then pick", "", "Play four times.", "", "D", "", "C", "", "[Verse]", "D", "Big"], ["Form a D chord, then pick", "Play four times."], ["D", "C"]],
    ["the reporter's page", ["2.3/5 · 1 vote", "Login to add to songbook", "Paper Lanterns chords", "The Hollow Pines", "", "[Intro]", ...steps, "", "Play four times.", "", "D", "", "C", "", "G", "", "[Verse]", ...verse], [...steps, "Play four times."], ["D", "C", "G"]],
    ["a name line under the marker", ["[Intro]", "Opening", "", ...steps, "", "Play four times.", "", "D", "", "C", "", "G", "", "[Verse]", ...verse], ["Opening", ...steps, "Play four times."], ["D", "C", "G"]],
  ] as const;
  for (const [form, page, said, chords] of pages) {
    const pasted = read(page.join("\n"));
    assert.deepEqual(headings(pasted.chart), ["INTRO", "VERSE 1"], `${form}: the page's two sections and no other (${js(pasted.chart)})`);
    const [intro] = sections(pasted.chart);
    assert.deepEqual(notes(intro), said, `${form}: every instruction is a note on the intro (${js(intro.lines)})`);
    assert.ok(intro.lines.every((line) => line.lyrics === undefined), `${form}: the intro has no sung words`);
    assert.deepEqual(intro.lines.flatMap(tokens), chords, `${form}: the intro's chords in order`);
  }
});

await check("12h. a typed chart with a lone chord over a line and no chord over the next stays as pasted", () => {
  for (const typed of [
    ["VERSE 1", "G", "Amazing grace", "how sweet the sound"],
    ["VERSE 1", "G", "Hello my friend", "Nice to see you", "", "C", "Goodbye my friend", "See you soon"],
  ]) {
    const chart = typed.join("\n");
    assert.equal(read(chart).chart, chart, `stays as pasted (${js(read(chart).chart)})`);
  }
  const copy = read(["G", "Lanterns", "", "C", "over the", "water"].join("\n")).chart;
  assert.deepEqual(sections(copy).map((section) => sung(section).map((line) => line.lyrics?.replace(/\s+/g, " "))), [["Lanterns over the water"]], `a page copy's one-chord block that starts mid-line still joins its line (${js(copy)})`);
  assert.deepEqual(places(pairs(copy)), places([{ chords: chordRow([["G", 0], ["C", 9]]), lyrics: "Lanterns over the water" }]), "with each chord over its word");
});

await check("12i. a header's one-line by, an Artist: line, ChordPro facts over the header, and every played part's instructions", () => {
  const chart = ["", "[Verse]", chordRow([["G", 0], ["C", 12]]), "Paper boats on the river"];
  const oneLine = read(["Paper Lanterns Chords by The Hollow Pines", "Learn this one slowly.", ...chart].join("\n"));
  assert.deepEqual([oneLine.facts.title, oneLine.facts.artist], ["Paper Lanterns", "The Hollow Pines"], `title and artist from one line (${js(oneLine.facts)})`);
  const labeled = read(["Paper Lanterns chords", "Artist: The Hollow Pines", ...chart].join("\n"));
  assert.deepEqual([labeled.facts.title, labeled.facts.artist], ["Paper Lanterns", "The Hollow Pines"], `the artist from an Artist: line (${js(labeled.facts)})`);
  const chordPro = read(["{title: Lantern Song}", "{artist: The Hollow Pines}", "Lantern Song Live chords", "Some Uploader", ...chart].join("\n"));
  assert.deepEqual([chordPro.facts.title, chordPro.facts.artist], ["Lantern Song", "The Hollow Pines"], `the ChordPro title and artist win (${js(chordPro.facts)})`);
  for (const part of ["Solo", "Interlude", "Instrumental", "Riff", "Break"]) {
    const pasted = read([`[${part}]`, "Let it ring out.", "| G | C |", ...chart].join("\n"));
    const [played] = sections(pasted.chart);
    assert.deepEqual(notes(played), ["Let it ring out."], `${part}: the words are a note (${js(played?.lines)})`);
    assert.ok(played.lines.every((line) => line.lyrics === undefined), `${part}: no sung words`);
  }
});

await check("12j. a blank after an intro or solo of chords alone ends it, so the next unmarked verse stays sung", () => {
  const typed = ["INTRO", "| G | C |", "", "Hello there my friend", "Nice to see you", "", "CHORUS", "G        C", "Sing along now"].join("\n");
  assert.equal(read(typed).chart, typed, `a chart the app already reads stays as pasted (${js(read(typed).chart)})`);
  const pages = [
    ["a typed INTRO of bars", typed.split("\n"), ["Hello there my friend", "Nice to see you", "Sing along now"]],
    ["an [Intro] of bars", ["[Intro]", "| G | C | D |", "", "Words of the song go here", "And more of them", "", "[Chorus]", "G        C", "Sing along now"], ["Words of the song go here", "And more of them", "Sing along now"]],
    ["an Intro: line of chords", ["Intro: G C D", "", "Well I woke up early", "G        C", "And the sun was out"], ["Well I woke up early", "And the sun was out"]],
    ["a [Solo] then a pickup line", ["[Verse]", "G        C", "Paper boats on the river", "", "[Solo]", "| Em | C |", "", "And so we sail", "G        C", "Paper boats on the river"], ["Paper boats on the river", "And so we sail", "Paper boats on the river"]],
  ] as const;
  for (const [form, page, words] of pages) {
    const all = sections(read(page.join("\n")).chart);
    assert.deepEqual(all.flatMap(notes), [], `${form}: no words made into a note (${js(all)})`);
    assert.deepEqual(all.flatMap((section) => sung(section).map((line) => line.lyrics?.trim())), words, `${form}: every sung line stays sung`);
    assert.ok(all.filter((section) => /^(intro|solo)$/i.test(section.heading)).every((section) => sung(section).length === 0), `${form}: the intro or solo holds no sung words (${js(all.map((section) => section.heading))})`);
  }
});

// A phone's real copy of a chord page: each chord, and the one word under it, on a line of its own, the words between
// them with the spaces the page had, a line of spaces where the page had only spaces, and an empty line where the page
// broke a line. The fixtures hold such copies as the clipboard gave them, trailing spaces and all.
const fixture = (name: string) => readFileSync(join(root, "tests", "fixtures", "paste", name), "utf8").replace(/\r\n/g, "\n");
const said = (section: Section | undefined) => sung(section).map((line) => line.lyrics?.trim().replace(/\s+/g, " "));

await check("12k. a phone's copy with one chord or piece of a line on each line gives whole lyric lines under their chords, the page's own sections, no rules, and its comments as notes", () => {
  const copy = fixture("tiny-dancer-ug-phone.txt");
  assert.equal(createHash("sha256").update(copy).digest("hex"), "37f328d94a3cefb059802819cc4a37b53557682e6b4de6d4d9b35218a25b1d18", "the fixture is the paste as the phone gave it, unchanged");
  const pasted = read(copy);
  const all = sections(pasted.chart);
  assert.deepEqual(all.map((section) => section.heading.toUpperCase()), ["VERSE 1", "VERSE 2", "PRE-CHORUS", "CHORUS"], `the first verse and the page's three named sections, and no other (${js(all.map((section) => section.heading))})`);
  const [verse1, verse2, pre, chorus] = all;
  assert.deepEqual(pasted.facts, { keyRoot: "C", keyMode: "major" }, `the page names no title or artist, so the key is the one fact (${js(pasted.facts)})`);

  assert.deepEqual(said(verse1).slice(0, 6), ["Blue jean baby,", "L.A. lady,", "seamstress for the band", "Pretty eyed,", "pirate smile,", "you'll marry a music man"], `the first stanza's lines whole (${js(said(verse1))})`);
  assert.deepEqual(sung(verse1).slice(0, 6).map(tokens), [["C", "F"], ["C", "F"], ["C", "F", "F", "G"], ["C", "F"], ["C", "F"], ["C", "F", "F", "G"]], "each of those lines under its own chords");
  const first: Row[] = [
    { chords: chordRow([["C", 0], ["F", 10]]), lyrics: "Blue jean baby," },
    { chords: chordRow([["C", 0], ["F", 5]]), lyrics: "L.A. lady," },
    { chords: chordRow([["C", 0], ["F", 19], ["F", 24], ["G", 26]]), lyrics: "seamstress for the band" },
  ];
  assert.deepEqual(places(rowsOf(verse1).slice(0, 3)), places(first), `each chord over the first letter of the word the page put it on (${js(rowsOf(verse1).slice(0, 3))})`);
  for (const verse of [verse1, verse2]) {
    assert.ok(sung(verse).length >= 10, `${verse.heading}: the verse holds its lines (${sung(verse).length})`);
    for (const line of sung(verse)) assert.ok((line.lyrics?.trim().split(/\s+/).length ?? 0) >= 2 && line.chords !== undefined, `${verse.heading}: no line is one piece of a line, and each has its chords (${js(line)})`);
  }

  const rows = pairs(pasted.chart);
  const words = lyricWords(rows);
  for (const whole of ["auditorium", "hums"]) assert.ok(words.includes(whole), `${whole} is one word (${js(words.filter((word) => /^(audi|hum|um$|s$)/.test(word)))})`);
  for (const piece of ["auditori", "um", "hum", "s", "VERSE", "2:"]) assert.ok(!words.includes(piece), `no ${js(piece)} left on its own`);
  const rowWith = (word: string) => rows.filter((row) => row.lyrics?.split(/\s+/).includes(word));
  const split = "in the auditorium";
  assert.deepEqual(places(rowWith("auditorium")), places([{ chords: chordRow([["Dm7", 0], ["E7", 7], ["Am", 15], ["G", 18]]), lyrics: split }]), `the chord inside auditorium stays over its syllable (${js(rowWith("auditorium"))})`);
  const tune = rowWith("hums")[0]?.lyrics?.trim().replace(/\s+/g, " ") ?? "";
  const hums = tune.indexOf("hums");
  assert.deepEqual(places(rowWith("hums")), places([{ chords: chordRow([["C", 0], ["G", hums], ["F", hums + 3], ["Em", tune.length + 1], ["Dm7", tune.length + 4]]), lyrics: tune }]), `the chord inside hums stays over its last letter (${js(rowWith("hums"))})`);

  assert.ok(!/-{3,}/.test(pasted.chart), `no rule of dashes in the chart (${js(lines(pasted.chart).filter((line) => line.includes("--")))})`);
  const noted = all.flatMap(notes).map((note) => note.trim().replace(/\s+/g, " "));
  const prose = ["or G#dim (020130) E7/D", "In the chorus the C is probably supposed to be C/E.", "I just use the regular C, but if you wanna use C/E", "it's played either like this (032010) or (xx2010)."];
  for (const comment of ["or just a regular D", ...prose]) assert.ok(noted.includes(comment), `${js(comment)} is a note (${js(noted)})`);
  for (const comment of prose) assert.ok(notes(pre).map((note) => note.trim().replace(/\s+/g, " ")).includes(comment), `${js(comment)} is a note on the pre-chorus it sat in`);
  for (const section of all) for (const line of sung(section)) assert.ok(!/C\/E|G#dim|\d{6}|xx\d{4}|regular [CD]/.test(line.lyrics ?? ""), `no comment is sung (${js(line.lyrics)})`);

  assert.equal(sung(pre).length, 4, `the pre-chorus is its four lines (${js(said(pre))})`);
  assert.deepEqual(tokens(sung(pre)[0]), ["Ab", "Bb"], "the first under its two chords");
  const soft = "when I say softly, slowly";
  assert.equal(said(pre)[3], soft, "the line the page set apart from its chords by a comment is still sung");
  assert.deepEqual(places(rowsOf(pre).slice(3)), places([{ chords: chordRow([["G/B", 11], ["G/B", 19]]), lyrics: soft }]), `and its chords sit over the words the page lined them up with (${js(rowsOf(pre).slice(3))})`);

  assert.equal(said(chorus)[0], "Hold me closer tiny dancer", `the chorus opens with its first line whole (${js(said(chorus))})`);
  assert.deepEqual(tokens(sung(chorus)[0]), ["F", "C/E", "Dm", "C/E"], "under its four chords");
  assert.deepEqual(tokens(chorus.lines[chorus.lines.length - 1]), ["F", "C", "Dm", "C"], "and the chorus ends with the page's last row of chords");
});

await check("12l. a phone's copy of a chord page with site lines gives its title and artist, the intro's instructions as notes, each stanza as one section, and every chord over its word", () => {
  const pasted = read(fixture("sweet-home-shape-ug-phone.txt"));
  assert.deepEqual([pasted.facts.title, pasted.facts.artist], ["Porch Light Carolina", "The Hollow Pines"], `title and artist from the header (${js(pasted.facts)})`);
  assert.ok(!CHROME_WORDS.test(pasted.chart), `no rating, vote, login, songbook, credit or "chords" title line in the chart (${js(pasted.chart)})`);
  assert.ok(!/Porch Light Carolina|Hollow Pines/.test(pasted.chart), "the title and artist lines leave the chart");
  assert.equal(leftOut(pasted, "lines above the first section"), 5, `the five header lines are left out (${js(pasted.leftOut)})`);
  assert.equal(leftOut(pasted, "tab lines"), 6, `the six tab lines are left out (${js(pasted.leftOut)})`);
  assert.ok(!/\|-/.test(pasted.chart), "no tab line stays");
  assert.deepEqual(headings(pasted.chart), ["INTRO", "VERSE 1", "CHORUS"], `the page's three sections and no other (${js(pasted.chart)})`);
  const [intro, verse, chorus] = sections(pasted.chart);
  assert.deepEqual(
    notes(intro),
    ["Form a D chord, then pick the single strings D D B/G", "Form a C chord, then pick the single strings A A B/G", "Play the riff below four times.", "x4"],
    `the instructions and the repeat mark are notes on the intro (${js(intro.lines)})`,
  );
  assert.ok(intro.lines.every((line) => line.lyrics === undefined), "the intro has no sung words");
  assert.deepEqual(intro.lines.flatMap(tokens), ["D", "C", "G"], "the intro's chords in order");

  const typed: Row[] = [
    { chords: chordRow([["D", 0], ["C", 12], ["G", 20]]), lyrics: "Porch light burning on the hill," },
    { chords: chordRow([["D", 0], ["C", 14], ["G", 29]]), lyrics: "A screen door singing in the wind" },
    { chords: chordRow([["D", 0], ["C", 17], ["G", 22]]), lyrics: "Mama hums in Carolina tonight" },
    { chords: chordRow([["D", 0], ["G", 22], ["C", 25], ["D", 27]]), lyrics: "Leave the porch light on" },
  ];
  assert.deepEqual(said(verse), typed.map((row) => row.lyrics), `each lyric line whole: a word that reads as a chord stays a word, and a word a chord splits stays one word (${js(verse.lines)})`);
  assert.ok(verse.lines.every((line) => line.lyrics !== undefined && line.chords !== undefined), "the verse is chord rows over words, nothing else");
  assert.deepEqual(places(rowsOf(verse)), places(typed), `each chord over the syllable the page put it on (${js(rowsOf(verse))})`);

  assert.deepEqual(said(chorus), ["Carolina,", "keep it burning", "Till I come home", "Porch light, porch light on"], `a wide gap before a chord starts a new row, and a line break the copy does not show still ends its line (${js(chorus.lines)})`);
  assert.deepEqual(sung(chorus).map(tokens), [["D"], ["C"], ["G", "D"], ["C", "G", "D"]], "each row under its own chords");
  const lead = chordAnchors(rowsOf(chorus).slice(2, 3));
  assert.match(lead[0] ?? "", /^G on word 1 "Till" at -\d+$/, `a chord the page played before the line sits left of its first word (${js(lead)})`);
  assert.equal(lead[1], 'D on word 1 "Till" at 0', "and the chord on that word stays over its first letter");
  assert.deepEqual(places(rowsOf(chorus).slice(3)), places([{ chords: chordRow([["C", 0], ["G", 13], ["D", 25]]), lyrics: "Porch light, porch light on" }]), "the last row's chords over their words");
});

await check("12m. a rule of dashes, equals, stars or tildes leaves the chart, a line of underscores stays, and a heading right under a row of chords alone still starts its section", () => {
  const typed = ["[Verse 1]", chordRow([["G", 0], ["C", 12]]), "Paper boats on the river", "G D", "CHORUS:", "--------", chordRow([["C", 0], ["G", 12]]), "Float away, float away"].join("\n");
  const pasted = read(typed);
  assert.deepEqual(headings(pasted.chart), ["VERSE 1", "CHORUS"], `both sections (${js(pasted.chart)})`);
  assert.ok(!pasted.chart.includes("--"), `the rule is gone (${js(pasted.chart)})`);
  const [verse, chorus] = sections(pasted.chart);
  assert.deepEqual([said(verse), tokens(verse.lines[verse.lines.length - 1])], [["Paper boats on the river"], ["G", "D"]], `the verse keeps its words and ends on its row of chords (${js(verse.lines)})`);
  assert.deepEqual(said(chorus), ["Float away, float away"], `the chorus holds its words (${js(chorus?.lines)})`);
  for (const rule of ["========", "********", "~~~~~~~~"]) assert.ok(!read(typed.replace("--------", rule)).chart.includes(rule), `a rule of ${rule[0]} is gone too`);
  const blanks = ["[Verse 1]", chordRow([["G", 0], ["C", 12]]), "Paper boats on the river", chordRow([["G", 0], ["C", 12]]), "__________"].join("\n");
  assert.deepEqual(said(sections(read(blanks).chart)[0]), ["Paper boats on the river", "__________"], `a line of underscores is a blank to fill in, kept under its chords (${js(read(blanks).chart)})`);
});

await check("12n. a phone's copy of a page with no section names keeps its stanzas, its title, a sung line that starts with A, and each line's own chords, less the page's indent", () => {
  const copy = [
    "B52 Motel chords",
    "The Hollow Pines",
    "",
    "   ",
    "D",
    "Porch",
    " light ",
    "G",
    "on",
    "C",
    "  ",
    "   and no chord here",
    "   ",
    "D",
    "Leave",
    " it ",
    "G",
    "burning",
    "",
    "   G        D",
    "    A light to bring me home",
    "",
    "   ",
    "D",
    "Carry",
    " me ",
    "G",
    "home",
  ].join("\n");
  const pasted = read(copy);
  assert.deepEqual([pasted.facts.title, pasted.facts.artist], ["B52 Motel", "The Hollow Pines"], `a title with a word that reads as a chord is still the title (${js(pasted.facts)})`);
  const all = sections(pasted.chart);
  assert.deepEqual(all.map(said), [["Porch light on", "and no chord here", "Leave it burning", "A light to bring me home"], ["Carry me home"]], `the page's blank line parts its two stanzas, and each line is whole and sung (${js(pasted.chart)})`);
  assert.deepEqual(all.flatMap(notes), [], "no sung line is made a note");
  assert.deepEqual(all.map((section) => sung(section).map(tokens)), [[["D", "G", "C"], [], ["D", "G"], ["G", "D"]], [["D", "G"]]], "a chord after the last word stays on its line, a line with no chord stays its own line, and the next line starts with its own chord");
  const typed: Row[] = [
    { chords: chordRow([["D", 0], ["G", 12], ["C", 15]]), lyrics: "Porch light on" },
    { chords: chordRow([["D", 0], ["G", 9]]), lyrics: "Leave it burning" },
    { chords: chordRow([["G", 3], ["D", 12]]), lyrics: "    A light to bring me home" },
  ];
  assert.deepEqual(places(rowsOf(all[0])), places(typed), `each chord over the word the page put it on (${js(rowsOf(all[0]))})`);
  for (const line of all.flatMap(sung)) assert.ok((line.lyrics?.search(/\S/) ?? 0) <= 1, `the indent the page gives every line is gone (${js(line.lyrics)})`);

  const ending = read(["D", "Porch", " light ", "G", "on", "", "G/B  G/B*", "or G#dim (020130)", "[Chorus]", "D", "Carry", " me ", "G", "home"].join("\n"));
  const [verse, chorus] = sections(ending.chart);
  assert.deepEqual(headings(ending.chart).map((heading) => heading.toUpperCase()), ["VERSE 1", "CHORUS"], `a verse and the page's chorus (${js(ending.chart)})`);
  assert.deepEqual([notes(verse), notes(chorus)], [["or G#dim (020130)"], []], "a comment under a part's last row of chords stays a note on that part, not on the section after it");
  assert.deepEqual([said(verse), tokens(verse.lines[1]), said(chorus)], [["Porch light on"], ["G/B", "G/B"], ["Carry me home"]], "and the heading after it is taken for no row's words");
});

await check("12o. a typed chart with one line of spaces under a lone chord is no page copy, and a heading under a row of chords alone starts its section with nothing else to clean", () => {
  const stray = ["INTRO", "G", " ", "VERSE 1", chordRow([["G", 0], ["C", 12]]), "Paper boats on the river"].join("\n");
  assert.equal(read(stray).chart, stray, `stays as pasted (${js(read(stray).chart)})`);
  const tight = ["VERSE 1", chordRow([["G", 0], ["C", 12]]), "Paper boats on the river", "G D", "CHORUS", chordRow([["C", 0], ["G", 12]]), "Float away, float away"].join("\n");
  assert.deepEqual(headings(read(tight).chart), ["VERSE 1", "CHORUS"], `both sections (${js(read(tight).chart)})`);
  assert.deepEqual(sections(read(tight).chart).map(said), [["Paper boats on the river"], ["Float away, float away"]], "each with its own words");
});

await check("12p. a typed chart whose stanzas end on a lone chord over a line of spaces is no page copy, so its headings, stanzas and chord columns stay as typed, while a copy of a page's chords alone still is one", () => {
  const intro = read(["[Intro]", "D", "    ", "C", "    ", "G", "  ", "x4", "", "[Verse 1]", chordRow([["G", 0], ["C", 9]]), "Porch light burning"].join("\n"));
  const [played] = sections(intro.chart);
  assert.deepEqual([played.lines.flatMap(tokens), notes(played), sung(played)], [["D", "C", "G"], ["x4"], []], `a page's row of chords alone stays one row with its repeat mark as a note (${js(intro.chart)})`);
  const row = chordRow([["G", 0], ["C", 12]]);
  const charts = [
    ["a one-word heading", ["Verse 1", row, "Amazing grace how sweet", "D", " ", "Verse 2", row, "That saved a wretch", "D", " ", "Chorus", chordRow([["C", 0], ["G", 9]]), "I once was lost"]],
    ["no headings", [row, "Amazing grace how sweet", "D", " ", row, "That saved a wretch", "D", " ", chordRow([["C", 0], ["G", 9]]), "I once was lost"]],
    ["boxed headings", ["[Verse]", row, "Amazing grace how sweet", "D", " ", "[Bridge]", row, "That saved a wretch", "D", " ", "[Chorus]", chordRow([["C", 0], ["G", 9]]), "I once was lost"]],
    ["stanzas that open on a lone chord", ["Verse 1", row, "Amazing grace how sweet", "D", " ", "G", "Was blind but now I see", "D", " ", "G", "Was lost but now am found"]],
    ["one lone chord over a line of spaces before a one-word line", ["[Verse]", row, "Amazing grace how sweet", "D", " ", "Amen", "", "[Chorus]", chordRow([["C", 0], ["G", 9]]), "I once was lost"]],
  ] as const;
  for (const [form, typed] of charts) {
    const chart = typed.join("\n");
    const stanzas = (text: string) => sections(text).map((section) => section.lines);
    assert.deepEqual(stanzas(read(chart).chart), stanzas(chart),`${form}: every section keeps its lines and each chord its column (${js(read(chart).chart)})`);
  }
});

const stanzasOf = (text: string) => sections(text).map((section) => [section.heading, section.lines]);

await check("12q. a typed chart whose lone chord over a line of spaces leads to a one-word line no heading reader knows is no page copy, so the row of chords under that line keeps its columns", () => {
  const row = chordRow([["G", 0], ["C", 12]]);
  const stanza = (heading: string, words: string) => [heading, row, words, "D", " "];
  const charts = [
    ["a Riff heading", [...stanza("Verse 1", "Amazing grace how sweet"), "Riff", "G  C  D", " ", ...stanza("Verse 2", "That saved a wretch"), "Riff", "G  C  D"]],
    ["a Turnaround: and a Post-Chorus heading", [...stanza("Verse 1", "Amazing grace how sweet"), "Turnaround:", "G  C  D", " ", ...stanza("Verse 2", "That saved a wretch"), "Post-Chorus", chordRow([["C", 0], ["G", 9]]), "I once was lost"]],
    ["a Breakdown heading twice", ["Verse 1", row, "Amazing grace how sweet", "D", " ", "Breakdown", chordRow([["C", 0], ["G", 9]]), "I once was lost", "D", " ", "Breakdown", chordRow([["C", 0], ["G", 9]]), "I once was lost"]],
    ["a one-word sung line", [row, "Amazing grace how sweet", "D", " ", "Oh", row, "That saved a wretch", "D", " ", "Oh", chordRow([["C", 0], ["G", 9]]), "I once was lost"]],
    ["a one-word sung line over no chords", [row, "Amazing grace how sweet", "D", " ", "Oh", "That saved a wretch", row, "I once was lost", "D", " ", "Oh", "Was blind but now I see"]],
    ["lines typed one chord each", ["Verse 1", "G", "Amazing grace how sweet", "D", " ", "Riff", "G  C  D", " ", "Verse 2", "G", "That saved a wretch", "D", " ", "Riff", "G  C  D"]],
  ] as const;
  for (const [form, typed] of charts) {
    const chart = typed.join("\n");
    assert.deepEqual(stanzasOf(read(chart).chart), stanzasOf(chart), `${form}: every section keeps its name, its lines and each chord its column (${js(read(chart).chart)})`);
  }
});

await check("12r. a typed chart whose lyric lines keep a space at both ends is no page copy, so each lyric line stays its own line", () => {
  const row = chordRow([["G", 0], ["C", 12]]);
  const charts = [
    ["under a heading", ["Verse 1", row, " Amazing grace how sweet the sound ", "D", " That saved a wretch like me ", row, " I once was lost but now ", "D", " Was blind but now I see "]],
    ["with no heading", [row, " Amazing grace how sweet the sound ", "D", " That saved a wretch like me ", "", row, " I once was lost but now ", "D", " Was blind but now I see "]],
  ] as const;
  for (const [form, typed] of charts) {
    const chart = typed.join("\n");
    assert.deepEqual(stanzasOf(read(chart).chart), stanzasOf(chart), `${form}: every section keeps its lines and each chord its column (${js(read(chart).chart)})`);
  }
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
  // A chart as the app writes it reads back the same. The one change allowed is the plan's own: Esus is stored as Esus4.
  const sus4 = (token: string) => token.replace(/^([A-G][#b]?)sus$/, "$1sus4");
  const meaning = (chart: string) => ({
    headings: headings(chart),
    places: places(pairs(chart)),
    words: lyricWords(pairs(chart)),
    lines: sections(chart).map((section) => section.lines.map((line) => [line.lyrics, line.note, ...`${line.chords ?? ""} ${line.bars ?? ""}`.trim().split(/\s+/).map(sus4)])),
  });
  for (const song of library.songs) {
    const own = text().sectionsToText(song.body);
    assert.deepEqual(meaning(paste().readPaste(own).chart), meaning(own), `${song.title}: a chart as the app writes it reads back the same`);
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
  "23. a capo note leaves with its chart: a chart with no capo pasted into the emptied box saves with no capo note",
  "24. a paste that leaves nothing after cleaning stays in the box as pasted, says so, and changes no field",
  "25. Select all, then Paste over a capo chart, is a fresh paste: it is cleaned, the capo note and its status go, and Save stores no capo note",
  "26. a capo note the player can see and remove: typed over, the paste status goes, the note shows with Remove capo note, and Edit song shows it too",
  "27. a typed chart, then Select all and Paste the app takes, comes back with one Ctrl+Z, and the paste status goes",
  "28. a paste with the caret at the top of a chart, or over part of its first line, is left to the box and the chart stays as typed",
  "29. a paste scrolls the preview into view, and a capo switch or Use it as pasted leaves the screen where the player tapped",
  "30. the status line says how many lines of each kind were left out, in the word for one line and for two",
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
    /** A keyboard paste into the box. True when the app took it. */
    const keyboard = (pasted: string) =>
      s.evaluate<boolean>(`(() => { const data = new DataTransfer(); data.setData("text/plain", ${js(pasted)}); return !${field("Chart")}.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); })()`);

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
        assert.equal(await s.evaluate<string>(`fetch("/api/me?probe=" + Date.now(), { cache: "no-store" }).then(() => "online", () => "offline")`), "offline", "the network is off");
        await s.send("Page.reload");
        await sleep(500);
        await shows("after a reload with the network off");
      } finally {
        await s.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        // An offline start reads the account as unknown, so the next cases start from an online reload.
        await s.evaluate(`location.hash = "#/songs"`);
        await s.send("Page.reload");
        await app.library();
        await app.until(`!!${addButton}`, "+ Add a song, back online", 15000);
      }
    });

    await check(SCREEN_CASES[7], async () => {
      await phone(390);
      await openNew();
      await fill("Key", "D");
      await fill("BPM", "90");
      await pasteTap(CAPO_WEB);
      await app.until(`!!${button("Show guitar shapes")}`, "the capo switch");
      const controls = ["Use A major", "Use 120 bpm", "Show guitar shapes", "Use it as pasted", "Remove capo note"];
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

    await check(SCREEN_CASES[9], async () => {
      const capo = ["Capo: 2nd fret", "", "[Verse 1]", "G      C       D", "Paper boats on the river"].join("\n");
      const plain = ["[Chorus]", "G           C", "Float away into the light"].join("\n");
      const preview = () => s.evaluate<string>(`document.querySelector(".song-editor-preview")?.textContent ?? ""`);
      const pastePlain = async () => {
        await fill("Chart", "");
        assert.equal(await keyboard(plain), true, "the app takes a keyboard paste into the emptied box");
        await app.until(`${field("Chart")}.value.includes("Float away")`, "the plain chart in the box");
      };
      const savedNote = async (title: string) => (await stored()).find((song) => song.title === title)?.keyNote ?? "";
      await phone(390);
      await openNew();
      await pasteTap(capo);
      await app.until(`!!${button("Show guitar shapes")}`, "the capo switch");
      await tap("Show guitar shapes");
      await app.until(`document.querySelector(".song-editor-preview")?.textContent.includes("Capo 2. The chords are guitar shapes.")`, "the shapes note in the preview");
      await pastePlain();
      assert.ok(!(await preview()).includes("Capo 2"), `new song: the preview drops the capo note (${js(await preview())})`);
      await fill("Title", "Float Away Plain");
      await tap("Save");
      await app.until(`/^#\\/song\\/\\d+/.test(location.hash) && !document.querySelector(".song-editor")`, "the saved song's page");
      assert.equal(await savedNote("Float Away Plain"), "", "new song: no capo note is stored");
      assert.ok(!(await app.text(".sheet")).includes("Capo 2"), "new song: the saved sheet names no capo");

      await openNew();
      await pasteTap(capo);
      await app.until(`!!${button("Show guitar shapes")}`, "the capo switch");
      await fill("Title", "River Boats");
      await tap("Save");
      await app.until(`/^#\\/song\\/\\d+/.test(location.hash) && !document.querySelector(".song-editor")`, "the capo song's page");
      assert.equal(await savedNote("River Boats"), "Capo 2 for guitar", "the capo song is stored with its note");
      await s.evaluate(`document.querySelector('.shell-header [aria-label="More"]').click()`);
      await app.until(`!!document.querySelector("[role=menu]")`, "the More menu");
      await app.click("Edit", `document.querySelector("[role=menu]")`);
      await app.until(`!!${editor}`, "Edit song");
      await pastePlain();
      assert.ok(!(await preview()).includes("Capo 2"), `Edit song: the preview drops the capo note (${js(await preview())})`);
      await tap("Save");
      await app.until(`!document.querySelector(".song-editor")`, "Edit song closed");
      assert.equal(await savedNote("River Boats"), "", "Edit song: the capo note is gone from the stored song");
    });

    await check(SCREEN_CASES[10], async () => {
      const headers = "Key: G\nTempo: 120 bpm";
      await openNew();
      await pasteTap(headers);
      await app.until(`${editor}.textContent.includes("Nothing here looks like a chart. It is in the box as pasted.")`, "the nothing-here words");
      assert.equal(await value("Chart"), headers, "the box holds the paste as pasted");
      assert.deepEqual([await value("Key"), await s.evaluate<string>(`${mode}.value`), await value("BPM")], ["C", "major", ""], "Key and BPM are left alone");
    });

    const CAPO_CHART = ["Capo: 2nd fret", "", "[Verse 1]", "G      C       D", "Paper boats on the river"].join("\n");
    const PLAIN_CHART = ["[Chorus]", "G           C", "Float away into the light"].join("\n");
    const preview = () => s.evaluate<string>(`document.querySelector(".song-editor-preview")?.textContent ?? ""`);
    const pasteStatus = () => s.evaluate<string>(`document.querySelector(".song-editor-paste")?.textContent ?? ""`);
    const savedNote = async (title: string) => (await stored()).find((song) => song.title === title)?.keyNote;
    const capoPasted = async () => {
      await openNew();
      await pasteTap(CAPO_CHART);
      await app.until(`!!${button("Show guitar shapes")}`, "the capo switch");
      assert.ok((await preview()).includes("Capo 2 for guitar"), "the capo paste sets the note");
    };

    await check(SCREEN_CASES[11], async () => {
      await phone(390);
      await capoPasted();
      await s.evaluate(`(() => { const el = ${field("Chart")}; el.focus(); el.setSelectionRange(0, el.value.length); })()`);
      assert.equal(await keyboard(`Tuning: E A D G B E\n${PLAIN_CHART}`), true, "the app takes a paste over the whole box");
      await app.until(`${field("Chart")}.value.includes("Float away")`, "the new chart in the box");
      const box = await value("Chart");
      assert.ok(!box.includes("Paper boats") && !box.includes("Tuning:"), `the paste takes the box's place and is cleaned (${js(box)})`);
      assert.ok(!(await preview()).includes("Capo 2"), `the preview drops the capo note (${js(await preview())})`);
      assert.ok(!/capo/i.test(await pasteStatus()), `the status names no capo (${js(await pasteStatus())})`);
      await fill("Title", "Whole Box Paste");
      await tap("Save");
      await app.until(`/^#\\/song\\/\\d+/.test(location.hash) && !document.querySelector(".song-editor")`, "the saved song's page");
      assert.equal(await savedNote("Whole Box Paste"), "", "no capo note is stored");
    });

    await check(SCREEN_CASES[12], async () => {
      await phone(390);
      await capoPasted();
      await fill("Chart", "");
      await fill("Chart", PLAIN_CHART);
      assert.equal(await pasteStatus(), "", "the paste status goes once the box no longer holds the paste");
      assert.ok(await s.evaluate<boolean>(`!!${button("Remove capo note")}`), "the editor shows the capo note with Remove capo note");
      await tap("Remove capo note");
      assert.ok(!(await preview()).includes("Capo 2"), `the preview drops the capo note (${js(await preview())})`);
      assert.equal(await s.evaluate<boolean>(`!!${button("Remove capo note")}`), false, "and the button goes");
      await fill("Title", "Typed Over");
      await tap("Save");
      await app.until(`/^#\\/song\\/\\d+/.test(location.hash) && !document.querySelector(".song-editor")`, "the saved song's page");
      assert.equal(await savedNote("Typed Over"), "", "no capo note is stored");

      await capoPasted();
      await fill("Title", "Harbor Lights");
      await tap("Save");
      await app.until(`/^#\\/song\\/\\d+/.test(location.hash) && !document.querySelector(".song-editor")`, "the capo song's page");
      assert.equal(await savedNote("Harbor Lights"), "Capo 2 for guitar", "the capo song is stored with its note");
      await s.evaluate(`document.querySelector('.shell-header [aria-label="More"]').click()`);
      await app.until(`!!document.querySelector("[role=menu]")`, "the More menu");
      await app.click("Edit", `document.querySelector("[role=menu]")`);
      await app.until(`!!${editor}`, "Edit song");
      assert.ok(await s.evaluate<boolean>(`!!${button("Remove capo note")}`), "Edit song shows the saved capo note with Remove capo note");
      await tap("Remove capo note");
      await tap("Save");
      await app.until(`!document.querySelector(".song-editor")`, "Edit song closed");
      assert.equal(await savedNote("Harbor Lights"), "", "Edit song: the capo note is gone from the stored song");
    });

    const TYPED_CHART = ["VERSE 1", "A               E", "Honey, load up your questions"].join("\n");
    const realKey = async (key: string, code: string, keyCode: number, commands: string[]) => {
      await s.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers: 2, commands });
      await s.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers: 2 });
      await sleep(200);
    };
    const typeChart = async () => {
      await s.evaluate(`${field("Chart")}.focus()`);
      await s.send("Input.insertText", { text: TYPED_CHART });
      await sleep(200);
      assert.equal(await value("Chart"), TYPED_CHART, "the chart is typed in");
    };

    await check(SCREEN_CASES[13], async () => {
      await phone(390);
      await openNew();
      await typeChart();
      await realKey("a", "KeyA", 65, ["selectAll"]);
      assert.equal(await keyboard(`Tuning: E A D G B E\n${PLAIN_CHART}`), true, "the app takes the paste over the whole box");
      await app.until(`${field("Chart")}.value.includes("Float away")`, "the pasted chart in the box");
      assert.ok(!(await value("Chart")).includes("Tuning:"), `the paste is cleaned (${js(await value("Chart"))})`);
      await realKey("z", "KeyZ", 90, ["undo"]);
      assert.equal(await value("Chart"), TYPED_CHART, "one Ctrl+Z brings back the typed chart");
      assert.equal(await pasteStatus(), "", "the paste status goes with the paste");
      assert.ok((await preview()).includes("Honey, load up your questions"), `the preview draws the typed chart again (${js(await preview())})`);
    });

    await check(SCREEN_CASES[14], async () => {
      await phone(390);
      await openNew();
      await typeChart();
      for (const [from, to, where] of [
        [0, 0, "the caret at the top"],
        [0, 5, "part of the first line selected"],
      ] as const) {
        await s.evaluate(`${field("Chart")}.setSelectionRange(${from}, ${to})`);
        assert.equal(await keyboard(PLAIN_CHART), false, `a paste with ${where} is left to the box`);
        await sleep(150);
        assert.equal(await value("Chart"), TYPED_CHART, `with ${where} the chart stays as typed`);
      }
    });

    await check(SCREEN_CASES[15], async () => {
      const backdrop = `document.querySelector(".song-editor-backdrop")`;
      const onScreen = (expression: string) => `(() => { const r = ${expression}.getBoundingClientRect(); return r.top >= 0 && r.top < ${HEIGHT}; })()`;
      const previewBox = `document.querySelector(".song-editor-preview")`;
      const pasteBox = `document.querySelector(".song-editor-paste")`;
      await phone(390);
      await openNew();
      await fill("Title", "Scroll To The Preview");
      await s.evaluate(`${backdrop}.scrollTop = 0`);
      await sleep(100);
      assert.equal(await s.evaluate<boolean>(onScreen(previewBox)), false, "the preview starts below the screen");
      await pasteTap(CAPO_CHART);
      await app.until(`!!${button("Show guitar shapes")}`, "the capo switch");
      await app.until(onScreen(previewBox), "the preview scrolled into view after the paste");
      for (const label of ["Show guitar shapes", "Use it as pasted"]) {
        await s.evaluate(`${button(label)}.scrollIntoView({ block: "center" })`);
        await sleep(150);
        assert.ok(await s.evaluate<boolean>(onScreen(pasteBox)), `the paste controls are on screen before ${label}`);
        await tap(label);
        await sleep(300);
        assert.ok(await s.evaluate<boolean>(onScreen(pasteBox)), `after ${label} the paste controls stay on screen (top ${await s.evaluate<number>(`${pasteBox}.getBoundingClientRect().top`)})`);
      }
    });

    await check(SCREEN_CASES[16], async () => {
      const status = `document.querySelector(".song-editor-paste [role=status]")`;
      await phone(390);
      for (const what of leftOutKinds()) {
        for (const count of [1, 2] as const) {
          await openNew();
          await pasteTap(leavingOut(what, count).pasted);
          await app.until(`!!${status}`, `the status line after a paste that leaves out ${count} of ${what}`);
          const words = await s.evaluate<string>(`${status}.textContent.trim()`);
          const want = `Left out ${count} ${count === 1 ? LEFT_OUT_PASTES[what].one : what}.`;
          assert.ok(words.includes(want), `the status line says ${js(want)} (${js(words)})`);
        }
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
