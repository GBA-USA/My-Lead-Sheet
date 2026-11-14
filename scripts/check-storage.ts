import { readFileSync } from "node:fs";
import { build } from "esbuild";
import type { Learned, ScrollVersion } from "../src/scroll-timing.ts";
import type { Library, LibraryFile, Song, SongRef } from "../src/types.ts";
import { displayChordLine, displayKeyLabel } from "../src/music.ts";

type Storage = typeof import("../src/storage.ts");

const seed = JSON.parse(readFileSync(new URL("../data/library.json", import.meta.url), "utf8")) as LibraryFile;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${message}`);
  }
}

async function loadApp(seedFile: LibraryFile): Promise<Storage> {
  const result = await build({
    entryPoints: [new URL("../src/storage.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    plugins: [
      {
        name: "seed",
        setup(b) {
          b.onLoad({ filter: /library\.json$/ }, () => ({ contents: JSON.stringify(seedFile), loader: "json" }));
        },
      },
    ],
  });
  const code = Buffer.from(result.outputFiles[0].text).toString("base64");
  return import(`data:text/javascript;base64,${code}#${Math.random()}`);
}

class FakeStorage {
  map = new Map<string, string>();
  onSet: ((key: string) => void) | null = null;
  failWrites = false;
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new DOMException("quota", "QuotaExceededError");
    const hook = this.onSet;
    this.onSet = null;
    hook?.(key);
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

let storage = new FakeStorage();
function freshStorage() {
  storage = new FakeStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
}
const stored = () => JSON.parse(storage.getItem("leadSheetsLibrary") ?? "null") as LibraryFile;
const putStored = (value: unknown) => storage.map.set("leadSheetsLibrary", JSON.stringify(value));
const title = (library: Library | LibraryFile, id: number) => library.songs.find((song) => song.id === id)?.title;

function renders(library: Library): string | null {
  try {
    for (const song of library.songs as Song[]) {
      void song.keyLabel.length;
      void song.artist.length;
      displayKeyLabel(song, 1);
      for (const section of song.body) for (const line of section.lines) displayChordLine(line.chords ?? "", song, 1, "nashville");
      for (const note of song.bassNotes) void note.position.length;
    }
    for (const setlist of library.setlists) setlist.songRefs.map((ref) => ref.length);
    return null;
  } catch (error) {
    return String(error);
  }
}

const app = await loadApp(seed);

freshStorage();
const first = app.loadLibrary();
check(first.songs.length === seed.songs.length, "first visit loads every seed song");
check(stored()?.songs.length === seed.songs.length, "first visit stores the seed");

freshStorage();
const stale = clone(seed);
stale.songs = [{ ...stale.songs[0], title: "STALE SONG" }];
putStored(stale);
const fromStale = app.loadLibrary();
check(fromStale.songs.length === seed.songs.length, `stale stored library picks up the seed (got ${fromStale.songs.length} songs)`);
check(title(fromStale, seed.songs[0].id) === seed.songs[0].title, "stale stored copy of a seed song is replaced");

const oldSeed = clone(seed);
const updatedId = 11;
const newId = seed.songs[seed.songs.length - 1].id;
oldSeed.songs = oldSeed.songs.filter((song) => song.id !== newId);
oldSeed.songs.find((song) => song.id === updatedId)!.title = "OLD TITLE";
const oldApp = await loadApp(oldSeed);
freshStorage();
oldApp.loadLibrary();
const edited = stored();
edited.songs.find((song) => song.id === 10)!.title = "My Chain Breaker";
edited.songs.push({ ...clone(seed.songs[0]), id: 99, title: "My Own Song" });
putStored(edited);
const upgraded = app.loadLibrary();
check(title(upgraded, updatedId) === title(seed, updatedId), `updated seed song reaches a return visit (got ${title(upgraded, updatedId)})`);
check(title(upgraded, newId) === title(seed, newId), "new seed song reaches a return visit");
check(title(upgraded, 10) === "My Chain Breaker", "a song the user edited is not overwritten");
check(title(upgraded, 99) === "My Own Song", "a song the user added is kept");
check(upgraded.songs.length === seed.songs.length + 1, `upgrade keeps one copy of each song (got ${upgraded.songs.length})`);
const again = app.loadLibrary();
check(title(again, 10) === "My Chain Breaker" && title(again, updatedId) === title(seed, updatedId), "a second visit keeps the same result");

freshStorage();
app.loadLibrary();
const broken = stored() as unknown as { songs: Record<string, unknown>[]; setlists: Record<string, unknown>[] };
delete broken.songs.find((song) => song.id === 10)!.keyLabel;
broken.songs.find((song) => song.id === 8)!.keyRoot = "H";
broken.songs.push({ ...clone(seed.songs[0]), id: 99, title: "My Own Song" });
broken.songs.push({ id: 98, title: "Half a song", bassNotes: [], body: [] });
delete broken.setlists[0].songIds;
broken.setlists[1].songIds = ["10", 11];
putStored(broken);
const repaired = app.loadLibrary();
check(renders(repaired) === null, `repaired library renders (${renders(repaired)})`);
const song = (library: Library | LibraryFile, id: number) => library.songs.find((entry) => entry.id === id);
check(song(repaired, 10)?.keyLabel === song(seed, 10)?.keyLabel, "a seed song with a missing field comes back from the seed");
check(song(repaired, 8)?.keyRoot === song(seed, 8)?.keyRoot, "a seed song with a bad key comes back from the seed");
check(title(repaired, 99) === "My Own Song", "a good user song survives a repair");
check(title(repaired, 98) === undefined, "an unrenderable user song is dropped");
check(JSON.stringify(repaired.setlists.map((set) => set.songRefs)) === JSON.stringify(seed.setlists.map((set) => set.songIds.map((id) => `local/${id}`))), "broken setlists come back from the seed");

for (const garbage of ["null", "[]", '{"songs":5,"setlists":[]}', "{not json", '{"songs":[null],"setlists":[1]}']) {
  freshStorage();
  storage.map.set("leadSheetsLibrary", garbage);
  const library = app.loadLibrary();
  check(library.songs.length === seed.songs.length && renders(library) === null, `garbage ${garbage} reseeds`);
}

freshStorage();
app.saveScrollPercent("local/10", 100);
app.saveScrollPercent("local/11", 100);
storage.onSet = () => app.saveScrollPercent("local/11", 80);
app.saveScrollPercent("local/10", 120);
check(app.loadScrollPercent("local/10") === 120 && app.loadScrollPercent("local/11") === 80, `two tabs both keep their scroll saves (10=${app.loadScrollPercent("local/10")} 11=${app.loadScrollPercent("local/11")})`);

freshStorage();
storage.onSet = () => app.saveNotation("local/11", "nashville");
app.saveNotation("local/10", "nashville");
check(app.loadNotation("local/10") === "nashville" && app.loadNotation("local/11") === "nashville", "two tabs both keep their notation saves");

freshStorage();
storage.onSet = () => app.saveNotation("local/10", "nashville");
app.saveScrollPercent("local/10", 150);
check(app.loadScrollPercent("local/10") === 150 && app.loadNotation("local/10") === "nashville", "scroll and notation saves keep each other");

freshStorage();
storage.map.set("leadSheetsScrollPercent", JSON.stringify({ 10: 150 }));
storage.map.set("leadSheetsNotation", JSON.stringify({ 10: "nashville" }));
app.saveScrollPercent("local/11", 60);
check(app.loadScrollPercent("local/10") === 150 && app.loadScrollPercent("local/11") === 60, "earlier saved scroll speeds still load");
check(app.loadNotation("local/10") === "nashville", "earlier saved notation still loads");

freshStorage();
storage.failWrites = true;
check(app.saveScrollPercent("local/10", 150) === false, "a failed scroll save is reported to the caller");
check(app.saveNotation("local/10", "nashville") === false, "a failed notation save is reported to the caller");
check(app.saveTextScaleIndex(2) === false && app.saveAwake(false) === false, "failed text size and wake saves are reported");
check(app.loadLibrary().songs.length === seed.songs.length, "the library still loads in memory when storage is full");
storage.failWrites = false;
check(app.saveScrollPercent("local/10", 150) === true, "a stored scroll save is reported as saved");

freshStorage();
const learned: Learned = { beatsPerBar: 4, downbeat: 2.4, beats: [2.4, 3, 3.6, 4.2], sections: [{ heading: "VERSE 1", at: 0 }, { heading: "HOOK", at: 3.6 }], vocals: [] };
const version = (sections: unknown[]) => ({ name: "V1", bpm: 100, marks: [{ at: 0, progress: 0 }, { at: 5, progress: 1 }], learned: { ...learned, sections } }) as ScrollVersion;
storage.map.set(`${app.SCROLL_VERSIONS_KEY}.13`, JSON.stringify({ versions: [version(learned.sections)], selected: 0 }));
const old = app.loadScrollVersions("local/13");
check(old.selected === 0 && old.versions[0].learned?.sections.every((section) => section.heard === undefined), "a learned version saved before heard chords still loads, with no heard bars");
const kept = [{ heading: "VERSE 1", at: 0, heard: ["A7", null, "D7"] }, learned.sections[1]];
app.saveScrollVersions("local/13", { versions: [version(kept)], selected: 0 });
check(JSON.stringify(app.loadScrollVersions("local/13").versions[0].learned?.sections) === JSON.stringify(kept), "kept heard bars, not-sure bars included, load back as saved");
storage.map.set(`${app.SCROLL_VERSIONS_KEY}.13`, JSON.stringify({ versions: [version([{ heading: "VERSE 1", at: 0, heard: ["A7", 7] }])], selected: 0 }));
check(app.loadScrollVersions("local/13").versions.length === 0, "a version whose heard bars are not chord names is dropped");

freshStorage();
const taught = { name: "V1", bpm: 78, marks: [{ at: 0, progress: 0 }, { at: 12.5, progress: 0.2 }, { at: 30, progress: 0.2 }, { at: 190, progress: 1 }] };
const tempoMapped = { ...taught, name: "Slow intro", tempo: [{ at: 0, bpm: 72 }, { at: 40, bpm: 78 }] };
const learnedV2 = {
  name: "V2",
  bpm: 76,
  marks: [{ at: 0, progress: 0 }, { at: 188.4, progress: 1 }],
  tempo: [{ at: 0, bpm: 76 }],
  learned: { beatsPerBar: 4, downbeat: 1.92, beats: [1.92, 2.71, 3.5, 4.29], sections: [{ heading: "VERSE 1", at: 0, heard: ["G", null, "C"] }, { heading: "CHORUS", at: 42.1 }], vocals: [{ start: 3.1, end: 20.4 }] },
};
const phone: Record<string, string> = {
  "leadSheetsScrollVersions.13": JSON.stringify({ versions: [taught, tempoMapped, learnedV2], selected: 2 }),
  "leadSheetsScrollVersions.10": JSON.stringify({ versions: [tempoMapped], selected: null }),
  "leadSheetsSongData.13": JSON.stringify({ officialRuntimeSec: 191, tempo: 76, timeSignature: "6/8" }),
  "leadSheetsScrollPercent.13": JSON.stringify(85),
  "leadSheetsNotation.13": JSON.stringify("nashville"),
  leadSheetsScrollPercent: JSON.stringify({ 11: 120 }),
  leadSheetsNotation: JSON.stringify({ 11: "nashville" }),
};
for (const [key, value] of Object.entries(phone)) storage.map.set(key, value);
const loadedOnce = app.loadLibrary();
const storedBefore = storage.getItem("leadSheetsLibrary")!;
const fromPhone = (await loadApp(seed)).loadLibrary();
const ref = (id: number) => fromPhone.songs.find((entry) => entry.id === id)!.ref;
check(JSON.stringify(loadedOnce) === JSON.stringify(fromPhone), "a second visit loads the same library with the same refs");
check(fromPhone.songs.every((entry) => entry.ref === `local/${entry.id}`), "every song on this phone has a local/<id> ref");
check(
  JSON.stringify(fromPhone.setlists.map((set) => set.songRefs)) === JSON.stringify(seed.setlists.map((set) => set.songIds.map((id) => `local/${id}`))),
  "every setlist lists its songs as refs, in the same order",
);
check(storage.getItem("leadSheetsLibrary") === storedBefore && !storedBefore.includes("songRefs") && !storedBefore.includes('"ref"'), "the stored library keeps the shape an older build reads");
check(JSON.stringify(app.loadScrollVersions(ref(13))) === phone["leadSheetsScrollVersions.13"], "old taught, tempo-mapped and learned versions load byte-equal under the song's ref");
check(JSON.stringify(app.loadScrollVersions(ref(10))) === phone["leadSheetsScrollVersions.10"], "another song's old versions load byte-equal under its ref");
check(JSON.stringify(app.loadSongData(ref(13))) === phone["leadSheetsSongData.13"], "old song data loads byte-equal under the song's ref");
check(app.loadScrollPercent(ref(13)) === 85 && app.loadNotation(ref(13)) === "nashville", "old per-song scroll speed and notation load under the song's ref");
check(app.loadScrollPercent(ref(11)) === 120 && app.loadNotation(ref(11)) === "nashville", "the oldest one-map saves still load under the song's ref");
const keysBefore = [...storage.map.keys()].sort().join();
app.saveScrollVersions(ref(13), app.loadScrollVersions(ref(13)));
app.saveSongData(ref(13), app.loadSongData(ref(13)));
check(storage.getItem("leadSheetsScrollVersions.13") === phone["leadSheetsScrollVersions.13"] && storage.getItem("leadSheetsSongData.13") === phone["leadSheetsSongData.13"], "saving under the ref writes back to the same old key, unchanged");
check([...storage.map.keys()].sort().join() === keysBefore, "saving under the ref adds no second copy");

const bandRef: SongRef = "01JBANDROOM0000000000000000/01JBANDSONG0000000000000000";
const bandSong: Song = { ...fromPhone.songs.find((entry) => entry.id === 13)!, ref: bandRef };
check(app.loadScrollVersions(bandSong.ref).versions.length === 0 && JSON.stringify(app.loadSongData(bandSong.ref)) === "{}", "a band's copy with the same id starts with none of this phone's saves");
app.saveScrollVersions(bandSong.ref, { versions: [taught], selected: 0 });
app.saveSongData(bandSong.ref, { tempo: 90 });
app.saveScrollPercent(bandSong.ref, 60);
app.saveNotation(bandSong.ref, "notes");
check(JSON.stringify(app.loadScrollVersions(bandSong.ref)) === JSON.stringify({ versions: [taught], selected: 0 }) && app.loadSongData(bandSong.ref).tempo === 90, "a band song keeps its own versions and song data");
check(app.loadScrollPercent(bandSong.ref) === 60 && app.loadNotation(bandSong.ref) === "notes", "a band song keeps its own scroll speed and notation");
check(
  JSON.stringify(app.loadScrollVersions(ref(13))) === phone["leadSheetsScrollVersions.13"] &&
    JSON.stringify(app.loadSongData(ref(13))) === phone["leadSheetsSongData.13"] &&
    app.loadScrollPercent(ref(13)) === 85 &&
    app.loadNotation(ref(13)) === "nashville",
  "saves for the band's copy leave this phone's song untouched",
);

if (failures) {
  console.error(`${failures} storage check(s) failed`);
  process.exit(1);
}
console.log("storage ok");
