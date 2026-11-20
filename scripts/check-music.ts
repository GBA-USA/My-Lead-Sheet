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
  convertNoteNames,
  degree,
  displayBassNote,
  displayChordCell,
  displayChordLine,
  displayKeyLabel,
  nashvilleNumber,
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

const leading = /^(b|#)?\d+/;

for (const song of library.songs) {
  for (const row of song.bassNotes) {
    if (row.chord.includes("pattern notes")) continue;
    const symbol = row.chord.includes(" / ") ? row.chord.split(" / ")[0].trim() : row.chord.trim();
    const rootNote = parseChord(symbol)?.root;
    if (!rootNote) fail(`${song.id} could not parse ${symbol}`);
    const got = degree(rootNote, song.keyRoot);
    const expect = row.nashville.trim().match(leading)?.[0];
    if (got !== expect) fail(`${song.title} ${symbol} degree ${got} != stored ${row.nashville}`);
  }
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
if (toNashvilleSymbol("Am7", chain) !== "6") fail("Am7");
if (toNashvilleSymbol("Gsus4", chain) !== "5") fail("Gsus4");

const fire = library.songs.find((song) => song.id === 1)!;
const truth = library.songs.find((song) => song.id === 8)!;
if (toNashvilleSymbol("F#m", fire) !== "6") fail("Fire Away F#m");
if (toNashvilleSymbol("Gm", truth) !== "6m") fail("Truth Gm");

const possum = library.songs.find((song) => song.id === 7)!;
if (convertNoteNames("D (F# in bass)", possum.keyRoot) !== "b7 (2 in bass)") {
  fail(`prose bass ${convertNoteNames("D (F# in bass)", possum.keyRoot)}`);
}
if (convertNoteNames("Bass rests until the last bar", chain.keyRoot) !== "Bass rests until the last bar") {
  fail("plain prose changed");
}

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
if (toNashvilleSymbol("F#m", east) !== "1") fail("east tonic");

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
expect(displayBassNote("A", east, 1, "notes"), "Bb", "G minor bass note");

expect(displayKeyLabel(half, 0), "A (practice version — recording key unverified)", "No Half Steppin' key");
expect(displayKeyLabel(half, 1), "Bb major (practice version — recording key unverified)", "No Half Steppin' +1 key");
expect(displayKeyLabel(possum, 1), "F major (F-centered)", "Possum Kingdom +1 key");

const toTable = library.songs.find((song) => song.id === 9)!;
const row = (song: Song, chord: string) => song.bassNotes.find((note) => note.chord === chord)!;
expect(nashvilleNumber(row(chain, "G/B"), chain), "5/7", "Chain Breaker G/B table number");
expect(nashvilleNumber(row(chain, "C/E"), chain), "1/3", "Chain Breaker C/E table number");
expect(nashvilleNumber(row(toTable, "E/G#"), toTable), "5/7", "To The Table E/G# table number");
expect(displayChordCell(row(chain, "G/B"), chain, 0, "nashville"), "5/7", "Chain Breaker G/B chord cell in Nashville");
expect(displayChordCell(row(chain, "G/B"), chain, 1, "notes"), "Ab/C", "Chain Breaker G/B chord cell +1");
expect(nashvilleNumber(row(half, "A7 pattern notes"), half), "5 / b7", "pattern notes keep stored degrees");
for (const song of library.songs) {
  for (const note of song.bassNotes) {
    if (!parseChord(note.chord)?.bass) expect(nashvilleNumber(note, song), note.nashville, `${song.title} ${note.chord}`);
  }
}

expect(originalKey(fire, 0), null, "untransposed has no original-key label");
expect(originalKey(fire, 12), null, "an octave is not a transpose");
expect(originalKey(fire, 1), "A major", "Fire Away +1 original key");
expect(originalKey(half, -2), "A major", "No Half Steppin' -2 original key");

if (problems.length > 0) fail(problems.join("\n"));

console.log("music ok: degrees match stored nashville, Chain Breaker is 1-4-5, transpose keeps numbers, spacing, spelling, caveats and slash numbers");
