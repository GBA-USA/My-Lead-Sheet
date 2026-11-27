import { readFileSync } from "node:fs";
import type { Song } from "../src/types.ts";
import {
  METRONOME_DOUBLE_TAP_MS,
  clampMetronomeBpm,
  initialMetronomeBpm,
  metronomeBeatSeconds,
  metronomePadAction,
} from "../src/metronome.ts";
import {
  degree,
  displayChordLine,
  displayKeyLabel,
  originalKey,
  parseChord,
  scrollPixelsPerSecond,
  toNashvilleSymbol,
} from "../src/music.ts";

const library = JSON.parse(readFileSync(new URL("../data/library.json", import.meta.url), "utf8")) as {
  songs: Song[];
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const chain = library.songs.find((song) => song.id === 10);
if (!chain) fail("missing chain breaker");

const chorus = chain.body.find((section) => section.heading === "CHORUS");
if (!chorus) fail("missing chorus");
const nashvilleChorus = chorus.lines
  .map((line) => (line.chords ? displayChordLine(line.chords, chain, 0, "nashville") : ""))
  .join("\n");
for (const token of ["1", "4", "5"]) {
  if (!new RegExp(`(?:^|\\s)${token}(?:\\s|$)`).test(nashvilleChorus)) {
    fail(`chorus missing ${token}:\n${nashvilleChorus}`);
  }
}
if (/[A-G]/.test(nashvilleChorus)) fail(`chorus still has letters:\n${nashvilleChorus}`);

if (toNashvilleSymbol("C/E", chain) !== "1/3") fail("C/E");
if (toNashvilleSymbol("F/G", chain) !== "4/5") fail("F/G");
if (toNashvilleSymbol("Gsus4", chain) !== "5") fail("Gsus4");

const fire = library.songs.find((song) => song.id === 1)!;
const truth = library.songs.find((song) => song.id === 8)!;
if (toNashvilleSymbol("Gm", truth) !== "6m") fail("Truth Gm");

const possum = library.songs.find((song) => song.id === 7)!;

const original = chorus.lines[0].chords ?? "";
const converted = displayChordLine(original, chain, 0, "nashville");
const cAt = original.indexOf("C");
if (converted[cAt] !== "1") fail(`column drift ${cAt} ${converted}`);
if (converted.length !== original.length) fail("line length changed");

if (displayKeyLabel(chain, 0) !== "C major") fail("original key");
if (displayKeyLabel(chain, 1) !== "Db major") fail(`up one ${displayKeyLabel(chain, 1)}`);
const transposedNumbers = displayChordLine(original, chain, 1, "nashville");
if (transposedNumbers !== converted) fail("nashville numbers moved when transposed");
const letters = displayChordLine(original, chain, 1, "notes");
if (!letters.includes("Db")) fail(`notes transpose ${letters}`);
if (/(?<![A-Za-z])C(?![A-Za-z#b])/.test(letters)) fail(`original C left after transpose: ${letters}`);
if (displayChordLine("C", chain, 1, "notes") !== "Db") fail("single C");

if (scrollPixelsPerSecond(78, 100) !== 19.5) fail("chain pace");
if (scrollPixelsPerSecond(null, 100) !== 22.5) fail("fallback pace");
if (scrollPixelsPerSecond(78, 50) !== 9.75) fail("half pace");
if (scrollPixelsPerSecond(78, 120) !== 23.4) fail("chain 120");

if (initialMetronomeBpm(78) !== 78) fail("metronome should open on the stored tempo");
if (initialMetronomeBpm(null) !== null) fail("null tempo must not invent a metronome bpm");
if (initialMetronomeBpm(null) === 90) fail("scroll fallback leaked into the metronome");
if (clampMetronomeBpm(20) !== 30) fail("metronome min");
if (clampMetronomeBpm(400) !== 300) fail("metronome max");
if (clampMetronomeBpm(100.4) !== 100) fail("metronome round");
if (metronomeBeatSeconds(78) !== 60 / 78) fail("beat length");

if (metronomePadAction(1, null, true) !== "edit") fail("single tap edits");
if (metronomePadAction(1, METRONOME_DOUBLE_TAP_MS, true) !== "edit") fail("slow second tap edits");
if (metronomePadAction(1, METRONOME_DOUBLE_TAP_MS - 1, true) !== "toggle") fail("fast second tap toggles");
if (metronomePadAction(2, 10, true) !== "toggle") fail("detail double tap toggles");
if (metronomePadAction(2, 10, false) !== "edit") fail("double tap with no bpm must not start");
if (metronomePadAction(1, 10, false) !== "edit") fail("unset single tap edits");

const take = library.songs.find((song) => song.id === 5);
const half = library.songs.find((song) => song.id === 13);
if (!take || take.tempo !== null) fail("Take Me Out tempo must stay null");
if (!half || half.tempo !== null) fail("No Half Steppin' tempo must stay null");
if (take.tempoNote.indexOf("122") < 0 || take.tempoNote.indexOf("104") < 0) fail("Take Me Out tempo note");
if (initialMetronomeBpm(take.tempo) !== null) fail("Take Me Out metronome invented a bpm");
if (scrollPixelsPerSecond(take.tempo, 100) !== 22.5) fail("Take Me Out scroll still uses 90");

let performanceBpm = initialMetronomeBpm(chain.tempo);
const pace100 = scrollPixelsPerSecond(chain.tempo, 100);
const pace120 = scrollPixelsPerSecond(chain.tempo, 120);
performanceBpm = 100;
if (performanceBpm !== 100) fail("metronome override");
if (chain.tempo !== 78) fail("Chain Breaker stored tempo changed");
if (scrollPixelsPerSecond(chain.tempo, 100) !== pace100) fail("metronome bpm changed 100% scroll");
if (scrollPixelsPerSecond(chain.tempo, 120) !== pace120) fail("scroll percent changed by metronome");
if (pace100 === performanceBpm * 0.25) fail("100% scroll followed the metronome instead of 78");

const east = library.songs.find((song) => song.id === 11)!;
if (toNashvilleSymbol("A", east) !== "b3") fail("east A");
if (toNashvilleSymbol("E", east) !== "b7") fail("east E");

const problems: string[] = [];
function expect(got: unknown, want: unknown, label: string) {
  if (got !== want) problems.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

expect(displayChordLine("E7                 Asus4 A", possum, 1, "notes"), "F7                 Bbsus4 Bb", "Possum +1");
expect(displayChordLine("| A | E | F#m | F#m |", fire, 1, "notes"), "| Bb | F | Gm | Gm  |", "Fire Away bars +1");
expect(displayChordLine("A / Asus4", possum, 1, "notes"), "Bb / Bbsus4", "Possum alias +1");
expect(
  displayChordLine(chain.atAGlance, chain, 1, "notes").includes("(Ab/C and Db/F slash chords)"),
  true,
  "Chain Breaker at a glance +1",
);

const words = (line: string) => [...line.matchAll(/\S+/g)].map((match) => ({ text: match[0], column: match.index ?? 0 }));
for (const song of library.songs) {
  const lines = [song.atAGlance, ...song.body.flatMap((section) => section.lines.flatMap((line) => [line.chords, line.bars]))];
  for (const line of lines) {
    if (!line) continue;
    const before = words(line);
    for (let semitones = 0; semitones < 12; semitones += 1) {
      for (const notation of ["notes", "nashville"] as const) {
        const out = displayChordLine(line, song, semitones, notation);
        const shape = before
          .map((word) => {
            const pieces = words(displayChordLine(word.text, song, semitones, notation));
            return `(${pieces.map((piece) => piece.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(" *")})`;
          })
          .join(" +");
        const match = new RegExp(`^ *${shape} *$`, "d").exec(out);
        const where = `${song.title} ${notation} +${semitones} ${JSON.stringify(line)} -> ${JSON.stringify(out)}`;
        if (!match) problems.push(`tokens merged: ${where}`);
        else if (before.some((word, k) => match.indices![k + 1][0] < word.column)) problems.push(`token moved left of its word: ${where}`);
      }
    }
  }
}

const minorKeys = ["F# minor", "G minor", "G# minor", "A minor", "Bb minor", "B minor", "C minor", "C# minor", "D minor", "Eb minor", "E minor", "F minor"];
const majorKeys = ["C major", "Db major", "D major", "Eb major", "E major", "F major", "F# major", "G major", "Ab major", "A major", "Bb major", "B major"];
for (let semitones = 0; semitones < 12; semitones += 1) {
  expect(displayKeyLabel(east, semitones), minorKeys[semitones], `East to West +${semitones} key`);
  expect(displayKeyLabel(chain, semitones), majorKeys[semitones], `Chain Breaker +${semitones} key`);
}
expect(displayChordLine("D E F#m A D", east, 1, "notes"), "Eb F Gm Bb Eb", "G minor spells flats");
expect(displayChordLine("D E F#m A D", east, 2, "notes"), "E F# G#m B E", "G# minor spells sharps");
expect(displayChordLine("D E F#m A D", east, 9, "notes"), "B Db Ebm Gb B", "Eb minor spells flats");

expect(displayKeyLabel(half, 0), "A (practice version — recording key unverified)", "No Half Steppin' key");
expect(displayKeyLabel(half, 1), "Bb major (practice version — recording key unverified)", "No Half Steppin' +1 key");
expect(displayKeyLabel(possum, 1), "F major (F-centered)", "Possum Kingdom +1 key");

expect(originalKey(fire, 0), null, "untransposed has no original-key label");
expect(originalKey(fire, 12), null, "an octave is not a transpose");
expect(originalKey(fire, 1), "A major", "Fire Away +1 original key");
expect(originalKey(half, -2), "A major", "No Half Steppin' -2 original key");

if (problems.length > 0) fail(problems.join("\n"));

let nFailures = 0;
const nCheck = (ok: boolean, label: string) => {
  if (!ok) nFailures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
};
const makeSong = (keyRoot: string, keyMode: "major" | "minor") =>
  ({
    ref: "local/999",
    id: 999,
    title: "Test",
    artist: "Test",
    keyLabel: `${keyRoot} ${keyMode}`,
    keyRoot,
    keyMode,
    keyNote: "",
    tempo: null,
    tempoNote: "",
    timeSignature: "4/4",
    officialRuntimeSec: null,
    feel: "",
    sourceNote: "",
    atAGlance: "",
    howToPlay: "",
    practiceTip: "",
    bassNotes: [],
    body: [],
  }) as unknown as Song;
const tokensOf = (line: string) => line.trim().split(/\s+/).filter(Boolean);
const songA = makeSong("A", "major");
const songC = makeSong("C", "major");
const songEm = makeSong("E", "minor");
const songFsm = makeSong("F#", "minor");
const songFs = makeSong("F#", "major");

nCheck(
  toNashvilleSymbol("F#m", songA) === "6m" && toNashvilleSymbol("Am7", songC) === "6m",
  "N1: F#m in A major is 6m and Am7 in C major is 6m with no bass table",
);

const n2Bad: string[] = [];
for (const song of library.songs) {
  for (const section of song.body) {
    for (const line of section.lines) {
      for (const row of [line.chords, line.bars]) {
        if (!row) continue;
        for (const token of row.split(/[\s|]+/).filter(Boolean)) {
          const parsed = parseChord(token);
          if (!parsed?.minor) continue;
          const converted = toNashvilleSymbol(token, song);
          const rootPart = converted.split("/")[0];
          if (!rootPart.endsWith("m")) n2Bad.push(`${song.title}: ${token}->${converted}`);
        }
      }
    }
  }
}
nCheck(
  n2Bad.length === 0,
  `N2: every minor chord in all ${library.songs.length} built-in songs shows m${n2Bad.length ? ` (${n2Bad.length} without m, e.g. ${n2Bad[0]})` : ""}`,
);

nCheck(
  toNashvilleSymbol("G/B", songC) === "5/7" && toNashvilleSymbol("C/E", songC) === "1/3" && toNashvilleSymbol("Am/G", songC) === "6m/5",
  "N3: slash chords G/B -> 5/7, C/E -> 1/3, Am/G -> 6m/5 in C",
);

const n4Row = "G7  Gsus4  Cmaj7  Bdim  Caug  C6/9  C7sus4  Bm7b5";
const n4Nash = tokensOf(displayChordLine(n4Row, songC, 0, "nashville"));
const n4Notes = tokensOf(displayChordLine(n4Row, songC, 2, "notes"));
nCheck(
  JSON.stringify(n4Nash) === JSON.stringify(["5", "5", "1", "7", "1", "1", "1", "7m"]) &&
    JSON.stringify(n4Notes) === JSON.stringify(["A7", "Asus4", "Dmaj7", "C#dim", "Daug", "D6/9", "D7sus4", "C#m7b5"]),
  `N4: chord extensions in C map cleanly in Nashville and transpose up 2 in Notes (got ${JSON.stringify(n4Nash)} / ${JSON.stringify(n4Notes)})`,
);

const n5Nash = tokensOf(displayChordLine("Db  Eb  F#  Ab  Bb", songC, 0, "nashville"));
nCheck(
  JSON.stringify(n5Nash) === JSON.stringify(["b2", "b3", "b5", "b6", "b7"]),
  "N5 (guard): Db, Eb, F#, Ab, Bb in C show b2, b3, b5, b6, b7",
);

nCheck(
  toNashvilleSymbol("Em", songEm) === "1m" &&
    toNashvilleSymbol("G", songEm) === "b3" &&
    toNashvilleSymbol("Am", songEm) === "4m" &&
    toNashvilleSymbol("D", songEm) === "b7" &&
    toNashvilleSymbol("A", songFsm) === "b3" &&
    toNashvilleSymbol("E", songFsm) === "b7" &&
    toNashvilleSymbol("F#m", songFsm) === "1m",
  "N6: minor keys E minor and F# minor count from their own root",
);

const n7Row = displayChordLine("A  N.C.  hold  D", songA, 0, "nashville");
const n7BarsNotes = displayChordLine("| A | N.C. | D |", songA, 2, "notes");
const n7BarsNash = displayChordLine("| A | N.C. | D |", songA, 0, "nashville");
const n7Glance = displayChordLine("Intro (A D) then Verse, end on A.", songA, 0, "nashville");
nCheck(
  JSON.stringify(tokensOf(n7Row)) === JSON.stringify(["1", "N.C.", "hold", "4"]) &&
    n7BarsNotes === "| B | N.C. | E |" &&
    n7BarsNash.includes("N.C.") &&
    !n7BarsNash.includes("N.1.") &&
    n7Glance === "Intro (1 4) then Verse, end on 1.",
  `N7: N.C. stays N.C. in Nashville and Transpose, words stay, At a glance converts chords (got ${JSON.stringify(n7Row)} / ${JSON.stringify(n7BarsNotes)})`,
);

const n8RowA = displayChordLine("A   F#m  D   Bm7  E", songA, 0, "nashville");
const n8RowTight = displayChordLine("Cm D", songFs, 0, "nashville");
const n8RowSlash = displayChordLine("Am/G C", songC, 0, "nashville");
nCheck(
  n8RowA === "1   6m   4   2m   5" && n8RowTight === "b5m b6" && n8RowSlash === "6m/5 1",
  `N8: minor chords keep later chords at their columns and tokens never merge (got ${JSON.stringify(n8RowA)}, ${JSON.stringify(n8RowTight)}, ${JSON.stringify(n8RowSlash)})`,
);

if (nFailures > 0) fail(`${nFailures} N check(s) failed`);

console.log("music ok: degrees match stored nashville, Chain Breaker is 1-4-5, transpose keeps numbers, spacing, spelling, caveats and slash numbers");
