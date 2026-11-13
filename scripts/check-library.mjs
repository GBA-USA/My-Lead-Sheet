import { readFileSync } from "node:fs";

const library = JSON.parse(readFileSync(new URL("../data/library.json", import.meta.url), "utf8"));
const original = JSON.parse(
  readFileSync(new URL("../docs/handoff/lead-sheets-data-export.json", import.meta.url), "utf8"),
);

const SONG_KEYS = [
  "id",
  "title",
  "artist",
  "keyLabel",
  "keyRoot",
  "keyMode",
  "keyNote",
  "tempo",
  "tempoNote",
  "timeSignature",
  "officialRuntimeSec",
  "feel",
  "sourceNote",
  "atAGlance",
  "howToPlay",
  "practiceTip",
  "bassNotes",
  "body",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (original.songCount !== 16 || original.songs.length !== 16) {
  fail("handoff export should still contain all 16 songs");
}
if (!original.songs.some((song) => song.id === 12 && song.bassNotes.length === 0 && song.body.length === 0)) {
  fail("handoff export should still contain the empty id 12 stub");
}

if (library.songCount !== 15 || library.songs.length !== 15) {
  fail(`seed should have 15 songs, found ${library.songs.length}`);
}
if (library.songs.some((song) => song.id === 12)) fail("seed must drop song id 12");
if (!library.songs.some((song) => song.id === 13 && song.title === "No Half Steppin'")) {
  fail("seed must keep song id 13");
}

const nullTempos = library.songs.filter((song) => song.tempo === null).map((song) => song.id);
if (nullTempos.join(",") !== "5,13") {
  fail(`null tempos should be ids 5 and 13, found ${nullTempos.join(",") || "(none)"}`);
}

/** MusicBrainz album-track lengths in seconds. Truth (8) is from the album page. */
const RUNTIMES = { 1: 244, 2: 261, 3: 259, 4: 166, 5: 237, 6: 273, 7: 310, 8: 222, 9: 240, 10: 197, 11: 267, 13: 233, 14: 272, 15: 310, 16: 183 };

for (const song of library.songs) {
  if (song.officialRuntimeSec !== RUNTIMES[song.id]) {
    fail(`song ${song.id} officialRuntimeSec should be ${RUNTIMES[song.id]}, found ${song.officialRuntimeSec}`);
  }
  const keys = Object.keys(song);
  if (keys.join("|") !== SONG_KEYS.join("|")) {
    fail(`song ${song.id} keys differ: ${keys.join(",")}`);
  }
  if (song.keyMode !== "major" && song.keyMode !== "minor") fail(`song ${song.id} keyMode`);
  if (song.tempo !== null && !Number.isInteger(song.tempo)) fail(`song ${song.id} tempo`);
  for (const note of song.bassNotes) {
    const noteKeys = Object.keys(note);
    if (noteKeys.join("|") !== "chord|nashville|bassNote|position") {
      fail(`song ${song.id} bass note keys ${noteKeys.join(",")}`);
    }
  }
  for (const section of song.body) {
    if (Object.keys(section).join("|") !== "heading|lines") fail(`song ${song.id} section keys`);
    for (const line of section.lines) {
      const extra = Object.keys(line).filter((key) => !["chords", "lyrics", "bars", "note"].includes(key));
      if (extra.length) fail(`song ${song.id} unexpected line fields ${extra.join(",")}`);
    }
  }
}

const ids = new Set(library.songs.map((song) => song.id));
if (library.setlists.length !== 2) fail("expected 2 setlists");
for (const setlist of library.setlists) {
  for (const id of setlist.songIds) {
    if (!ids.has(id)) fail(`setlist ${setlist.name} references missing song ${id}`);
  }
}
if (library.setlists[0].songIds.join(",") !== "11,8,10,9") fail("Worship Set order");
if (library.setlists[1].songIds.join(",") !== "10,11,9,8") fail("Biker church order");

const chain = library.songs.find((song) => song.id === 10);
if (!chain || chain.title !== "Chain Breaker" || chain.tempo !== 78 || chain.keyLabel !== "C major") {
  fail("Chain Breaker record changed");
}
const first = chain.body[0].lines[0];
if (first.chords !== "            C                                  F         C") {
  fail("Chain Breaker chord spacing was not preserved");
}
if (first.lyrics !== "If you've been walking the same old road for miles and miles") {
  fail("Chain Breaker lyric was not preserved");
}
if (!chain.feel.startsWith("Slow-building Southern gospel-rock ballad")) {
  fail("Chain Breaker feel changed");
}
if (chain.bassNotes[0].position !== "A string, 3rd fret") fail("Chain Breaker bass position changed");

/**
 * No Half Steppin' moved its "THE FORM" reference block out of the body, so Learn counts only song sections.
 * Its notes went to howToPlay and its 12-bar row opens every section. Everything else matches the export.
 */
const half = library.songs.find((song) => song.id === 13);
const halfExport = original.songs.find((song) => song.id === 13);
const [form, ...sections] = halfExport.body;
const formBars = form.lines.find((line) => line.bars !== undefined);
const formNotes = form.lines.filter((line) => line.note !== undefined).map((line) => line.note);
if (!form.heading.startsWith("THE FORM") || !formBars || formNotes.length !== 2) fail("export's No Half Steppin' THE FORM block changed");
if (half.body.some((section) => section.heading.startsWith("THE FORM"))) fail("No Half Steppin' still has a THE FORM heading");
if (half.body.map((section) => section.heading).join("|") !== sections.map((section) => section.heading).join("|") || half.body.length !== 6) {
  fail(`No Half Steppin' should have its 6 song headings, found ${half.body.map((section) => section.heading).join(", ")}`);
}
half.body.forEach((section, i) => {
  if (JSON.stringify(section.lines) !== JSON.stringify([formBars, ...sections[i].lines])) {
    fail(`No Half Steppin' ${section.heading} should be the 12-bar row, then its original lines unchanged`);
  }
});
if (!formNotes.every((note) => half.howToPlay.includes(note)) || !half.howToPlay.startsWith(halfExport.howToPlay)) {
  fail("No Half Steppin' howToPlay should keep its text and add THE FORM's notes verbatim");
}
for (const key of SONG_KEYS.filter((key) => !["officialRuntimeSec", "howToPlay", "body"].includes(key))) {
  if (JSON.stringify(half[key]) !== JSON.stringify(halfExport[key])) fail(`No Half Steppin' ${key} changed`);
}

console.log("library.json ok: 15 songs, id 12 dropped, id 13 kept, Chain Breaker intact, official runtimes set, No Half Steppin' has 6 song sections with the 12-bar form in each");
