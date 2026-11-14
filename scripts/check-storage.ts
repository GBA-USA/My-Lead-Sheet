import { readFileSync } from "node:fs";
import { build } from "esbuild";
import type { Learned, ScrollVersion } from "../src/scroll-timing.ts";
import type { LibraryFile, Song } from "../src/types.ts";
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
const title = (library: LibraryFile, id: number) => library.songs.find((song) => song.id === id)?.title;

function renders(library: LibraryFile): string | null {
  try {
    for (const song of library.songs as Song[]) {
      void song.keyLabel.length;
      void song.artist.length;
      displayKeyLabel(song, 1);
      for (const section of song.body) for (const line of section.lines) displayChordLine(line.chords ?? "", song, 1, "nashville");
      for (const note of song.bassNotes) void note.position.length;
    }
    for (const setlist of library.setlists) setlist.songIds.map((id) => id + 1);
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
const song = (library: LibraryFile, id: number) => library.songs.find((entry) => entry.id === id);
check(song(repaired, 10)?.keyLabel === song(seed, 10)?.keyLabel, "a seed song with a missing field comes back from the seed");
check(song(repaired, 8)?.keyRoot === song(seed, 8)?.keyRoot, "a seed song with a bad key comes back from the seed");
check(title(repaired, 99) === "My Own Song", "a good user song survives a repair");
check(title(repaired, 98) === undefined, "an unrenderable user song is dropped");
check(JSON.stringify(repaired.setlists) === JSON.stringify(seed.setlists), "broken setlists come back from the seed");

for (const garbage of ["null", "[]", '{"songs":5,"setlists":[]}', "{not json", '{"songs":[null],"setlists":[1]}']) {
  freshStorage();
  storage.map.set("leadSheetsLibrary", garbage);
  const library = app.loadLibrary();
  check(library.songs.length === seed.songs.length && renders(library) === null, `garbage ${garbage} reseeds`);
}

freshStorage();
app.saveScrollPercent(10, 100);
app.saveScrollPercent(11, 100);
storage.onSet = () => app.saveScrollPercent(11, 80);
app.saveScrollPercent(10, 120);
check(app.loadScrollPercent(10) === 120 && app.loadScrollPercent(11) === 80, `two tabs both keep their scroll saves (10=${app.loadScrollPercent(10)} 11=${app.loadScrollPercent(11)})`);

freshStorage();
storage.onSet = () => app.saveNotation(11, "nashville");
app.saveNotation(10, "nashville");
check(app.loadNotation(10) === "nashville" && app.loadNotation(11) === "nashville", "two tabs both keep their notation saves");

freshStorage();
storage.onSet = () => app.saveNotation(10, "nashville");
app.saveScrollPercent(10, 150);
check(app.loadScrollPercent(10) === 150 && app.loadNotation(10) === "nashville", "scroll and notation saves keep each other");

freshStorage();
storage.map.set("leadSheetsScrollPercent", JSON.stringify({ 10: 150 }));
storage.map.set("leadSheetsNotation", JSON.stringify({ 10: "nashville" }));
app.saveScrollPercent(11, 60);
check(app.loadScrollPercent(10) === 150 && app.loadScrollPercent(11) === 60, "earlier saved scroll speeds still load");
check(app.loadNotation(10) === "nashville", "earlier saved notation still loads");

freshStorage();
storage.failWrites = true;
check(app.saveScrollPercent(10, 150) === false, "a failed scroll save is reported to the caller");
check(app.saveNotation(10, "nashville") === false, "a failed notation save is reported to the caller");
check(app.saveTextScaleIndex(2) === false && app.saveAwake(false) === false, "failed text size and wake saves are reported");
check(app.loadLibrary().songs.length === seed.songs.length, "the library still loads in memory when storage is full");
storage.failWrites = false;
check(app.saveScrollPercent(10, 150) === true, "a stored scroll save is reported as saved");

freshStorage();
const learned: Learned = { beatsPerBar: 4, downbeat: 2.4, beats: [2.4, 3, 3.6, 4.2], sections: [{ heading: "VERSE 1", at: 0 }, { heading: "HOOK", at: 3.6 }], vocals: [] };
const version = (sections: unknown[]) => ({ name: "V1", bpm: 100, marks: [{ at: 0, progress: 0 }, { at: 5, progress: 1 }], learned: { ...learned, sections } }) as ScrollVersion;
storage.map.set(`${app.SCROLL_VERSIONS_KEY}.13`, JSON.stringify({ versions: [version(learned.sections)], selected: 0 }));
const old = app.loadScrollVersions(13);
check(old.selected === 0 && old.versions[0].learned?.sections.every((section) => section.heard === undefined), "a learned version saved before heard chords still loads, with no heard bars");
const kept = [{ heading: "VERSE 1", at: 0, heard: ["A7", null, "D7"] }, learned.sections[1]];
app.saveScrollVersions(13, { versions: [version(kept)], selected: 0 });
check(JSON.stringify(app.loadScrollVersions(13).versions[0].learned?.sections) === JSON.stringify(kept), "kept heard bars, not-sure bars included, load back as saved");
storage.map.set(`${app.SCROLL_VERSIONS_KEY}.13`, JSON.stringify({ versions: [version([{ heading: "VERSE 1", at: 0, heard: ["A7", 7] }])], selected: 0 }));
check(app.loadScrollVersions(13).versions.length === 0, "a version whose heard bars are not chord names is dropped");

if (failures) {
  console.error(`${failures} storage check(s) failed`);
  process.exit(1);
}
console.log("storage ok");
