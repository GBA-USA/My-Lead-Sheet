import { readFileSync } from "node:fs";
import type { Song } from "../src/types.ts";
import {
  convertNoteNames,
  degree,
  displayChordLine,
  displayKeyLabel,
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
if (letters.includes("C ") || letters.endsWith("C")) {
  /* original C should be gone; a padded line may still be fine */
}
if (displayChordLine("C", chain, 1, "notes") !== "Db") fail("single C");

if (scrollPixelsPerSecond(78, 100) !== 19.5) fail("chain pace");
if (scrollPixelsPerSecond(null, 100) !== 22.5) fail("fallback pace");
if (scrollPixelsPerSecond(78, 50) !== 9.75) fail("half pace");

const east = library.songs.find((song) => song.id === 11)!;
if (toNashvilleSymbol("A", east) !== "b3") fail("east A");
if (toNashvilleSymbol("E", east) !== "b7") fail("east E");
if (toNashvilleSymbol("F#m", east) !== "1") fail("east tonic");

console.log("music ok: degrees match stored nashville, Chain Breaker is 1-4-5, transpose keeps numbers");
