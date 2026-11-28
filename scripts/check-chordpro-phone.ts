import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { SongContent } from "../src/chordpro.ts";
import type { ChartSection, LibraryFile, Song } from "../src/types.ts";
import { Phone, startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle } from "./app-page.ts";
import { chordAnchors, type Row } from "./chord-anchors.ts";
import { openSite, type Site } from "./chrome.ts";

/**
 * Cook 3 (`chordpro-phone`): cases P1 to P17 of docs/PLAN-chordpro-backbone.md section 3,
 * plus P18 (CRLF and BOM normalization at every door, added by CoS).
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const BASE = "61f18be";
const NEW_SHAPE = { "x-song-shape": "chordpro" } as const;
const js = (value: unknown) => JSON.stringify(value);
const newId = () => crypto.randomUUID().replace(/-/g, "");
const today = () => new Date().toLocaleDateString("en-CA");
const DAY_MS = 24 * 60 * 60 * 1000;

const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as LibraryFile;

let failures = 0;
async function check(name: string, run: () => Promise<void> | void) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

class FakeStorage {
  map = new Map<string, string>();
  maxBytes = Infinity;
  failWrites = false;
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  private totalBytes() {
    let sum = 0;
    for (const [k, v] of this.map) sum += k.length + v.length;
    return sum;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new DOMException("quota", "QuotaExceededError");
    const nextVal = String(value);
    const prev = this.map.get(key);
    const prevBytes = prev === undefined ? 0 : key.length + prev.length;
    const nextTotal = this.totalBytes() - prevBytes + key.length + nextVal.length;
    if (nextTotal > this.maxBytes) throw new DOMException("quota", "QuotaExceededError");
    this.map.set(key, nextVal);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

const useStore = (store: FakeStorage, userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)") => {
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: { userAgent }, configurable: true });
};

type PhoneBundle = typeof import("../src/storage.ts") &
  typeof import("../src/backup.ts") &
  typeof import("../src/chordpro.ts") &
  typeof import("../src/band-library-model.ts") &
  typeof import("../src/send-song-model.ts") &
  typeof import("../src/sign-in-methods.ts") &
  typeof import("../src/song-text.ts") & {
    songFromSent?: (song: unknown) => SongContent;
    songFromStored?: (song: unknown) => Song;
    songToStored?: (song: unknown) => { id: number; copy?: unknown; chordpro: string };
    __parseCalls?: number;
    __resetParseCalls?: () => void;
  };

async function loadBundle(countParses = false): Promise<PhoneBundle> {
  const plugins = countParses
    ? [
        {
          name: "count-chordpro-parses",
          setup(b: { onLoad: (opts: { filter: RegExp }, cb: (args: { path: string }) => { contents: string; loader: "ts" }) => void }) {
            b.onLoad({ filter: /[\\/]src[\\/]chordpro\.ts$/ }, (args) => {
              const source = readFileSync(args.path, "utf8");
              const wrapped =
                source.replace("export function chordProToSong(", "function _realChordProToSong(") +
                `\nlet _parseCalls = 0;\nexport function __resetParseCalls() { _parseCalls = 0; }\nexport function __getParseCalls() { return _parseCalls; }\nexport function chordProToSong(text: string) { _parseCalls += 1; return _realChordProToSong(text); }\n`;
              return { contents: wrapped, loader: "ts" };
            });
          },
        },
      ]
    : [];
  const res = await build({
    stdin: {
      contents: [
        `export * from "./src/storage.ts";`,
        `export * from "./src/backup.ts";`,
        `export * from "./src/chordpro.ts";`,
        `export * from "./src/band-library-model.ts";`,
        `export * from "./src/send-song-model.ts";`,
        `export * from "./src/sign-in-methods.ts";`,
        `export * from "./src/song-text.ts";`,
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    loader: { ".json": "json" },
    plugins,
    logLevel: "silent",
  });
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(res.outputFiles[0].text).toString("base64")}#${Math.random()}`)) as PhoneBundle & {
    __getParseCalls?: () => number;
  };
  if (countParses) {
    const wrapped = Object.create(mod) as PhoneBundle;
    Object.defineProperty(wrapped, "__parseCalls", {
      get() {
        return mod.__getParseCalls?.() ?? 0;
      },
      enumerable: true,
    });
    return wrapped;
  }
  return mod;
}

type OldBuild = typeof import("../src/storage.ts") & typeof import("../src/backup.ts");
let oldBuild: OldBuild | null = null;
let oldBuildError = "";
const oldTree = mkdtempSync(join(tmpdir(), "check-chordpro-phone-old-"));
try {
  const tar = execFileSync("git", ["archive", "--format=tar", BASE, "src", "data"], { cwd: root, maxBuffer: 1 << 28 });
  execFileSync("tar", ["-x", "-C", oldTree], { input: tar });
  const oldBundle = await build({
    stdin: { contents: `export * from "./src/storage.ts"; export * from "./src/backup.ts";`, resolveDir: oldTree, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    loader: { ".json": "json" },
    logLevel: "silent",
  });
  oldBuild = (await import(`data:text/javascript;base64,${Buffer.from(oldBundle.outputFiles[0].text).toString("base64")}`)) as OldBuild;
} catch (error) {
  oldBuildError = error instanceof Error ? error.message.split("\n")[0] : String(error);
}

const needOldBuild = (): OldBuild => {
  assert.ok(oldBuild, `old build at ${BASE} could not be bundled (${oldBuildError})`);
  return oldBuild;
};

const app = await loadBundle();

const blank: SongContent = {
  title: "Untitled",
  artist: "The Made Up Band",
  keyLabel: "A major",
  keyRoot: "A",
  keyMode: "major",
  keyNote: "",
  tempo: 96,
  tempoNote: "",
  timeSignature: "4/4",
  officialRuntimeSec: 192,
  feel: "Easy sway",
  sourceNote: "",
  atAGlance: "",
  howToPlay: "",
  practiceTip: "",
  body: [],
};

const madeSong = (title: string, lyric: string, extra: Partial<SongContent> = {}): SongContent => ({
  ...blank,
  title,
  body: [
    { heading: "INTRO", lines: [{ bars: "| A | D | A | E |" }] },
    { heading: "VERSE 1", lines: [{ chords: "A               E", lyrics: lyric }] },
  ],
  ...extra,
});

const oldFixture = (id: number, title: string, lyric: string, extra: Record<string, unknown> = {}) => ({
  ...madeSong(title, lyric),
  id,
  bassNotes: [] as unknown[],
  ...extra,
});

function fingerprint(item: unknown): string {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(item)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return (hash >>> 0).toString(36);
}

/** Builds a raw library JSON string the way the build before cook 3 stored it under `leadSheetsLibrary`. */
function makeOldLibraryRaw(
  ownSongs: Record<string, unknown>[],
  ownSetlists: { id: number; name: string; songIds: number[] }[] = [],
  { seedWithBass = false }: { seedWithBass?: boolean } = {},
): string {
  const seedSongs = seed.songs.map((s) => (seedWithBass ? { ...s, bassNotes: [] } : { ...s }));
  const seedSetlists = seed.setlists.map((s) => ({ ...s }));
  const songPrints = Object.fromEntries(seedSongs.map((s) => [String(s.id), fingerprint(s)]));
  const setlistPrints = Object.fromEntries(seedSetlists.map((s) => [String(s.id), fingerprint(s)]));
  const songs = [...seedSongs, ...ownSongs];
  const setlists = [...seedSetlists, ...ownSetlists];
  const lastSongId = Math.max(0, ...songs.map((s) => Number(s.id)));
  return JSON.stringify({
    exportedFrom: seed.exportedFrom,
    exportedFor: seed.exportedFor,
    exportedAt: seed.exportedAt,
    songCount: seed.songCount,
    songs,
    setlists,
    seedPrints: { songs: songPrints, setlists: setlistPrints },
    lastSongId,
  });
}

/** In-memory backup room mock for Node backup tests (P5, P6, P8, P17). */
function makeBackupRoom() {
  const rows = new Map<string, { key: string; value: string | null; rev: number }>();
  let rev = 0;
  const requests: { url: string; headers: Record<string, string>; changes: { key: string; value: string | null }[] }[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    const hdrs: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) init.headers.forEach((v, k) => (hdrs[k.toLowerCase()] = v));
      else for (const [k, v] of Object.entries(init.headers as Record<string, string>)) hdrs[k.toLowerCase()] = String(v);
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as { since: number; changes: { key: string; value: string | null; base?: number }[] }) : { since: 0, changes: [] };
    requests.push({ url, headers: hdrs, changes: body.changes ?? [] });
    if (url.includes("/api/backup")) {
      for (const change of body.changes ?? []) {
        const existing = rows.get(change.key);
        const base = change.base ?? 0;
        if (!existing || existing.rev === base) {
          rev += 1;
          rows.set(change.key, { key: change.key, value: change.value, rev });
        }
      }
      const replyRows = [...rows.values()].filter((r) => r.rev > body.since || (body.changes ?? []).some((c) => c.key === r.key));
      const counts: Record<string, number> = {};
      for (const r of rows.values()) {
        if (r.value === null) continue;
        const kind = r.key.startsWith("leadSheetsSong.")
          ? "song"
          : r.key.startsWith("leadSheetsSetlist.")
            ? "setlist"
            : r.key.startsWith("leadSheetsScrollVersions")
              ? "timing"
              : r.key.startsWith("leadSheetsSongData")
                ? "song-data"
                : r.key.startsWith("leadSheetsScrollPercent")
                  ? "scroll"
                  : r.key.startsWith("leadSheetsNotation")
                    ? "notation"
                    : "settings";
        counts[kind] = (counts[kind] ?? 0) + 1;
      }
      return new Response(JSON.stringify({ rev, rows: replyRows, counts }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { rows, requests, fetchMock };
}

const realFetch = globalThis.fetch;

// =================================================================================================
// PART 1: Storage, backup, and old-build cases in Node (P1, P3, P4, P5, P6, P8, P12, P17)
// =================================================================================================

// P1
await check("P1: library and backup state under old keys copy byte-for-byte to V2 keys and old keys stay unchanged", async () => {
  const store = new FakeStorage();
  useStore(store);
  const oldLib = makeOldLibraryRaw(
    [oldFixture(901, "Paper Boats", "Paper boats are sailing"), oldFixture(902, "Tin Kites", "Tin kites in the wind")],
    [{ id: 901, name: "Harbor Set", songIds: [901, 902] }],
  );
  const oldBak = JSON.stringify({ account: "acct-p1", pulled: 4, synced: { "leadSheetsSong.901": [2, "50:abc"] }, at: 1700000000000 });
  store.setItem("leadSheetsLibrary", oldLib);
  store.setItem("leadSheetsBackup", oldBak);

  const fresh = await loadBundle();
  const loaded = fresh.loadLibrary();
  assert.ok(loaded.songs.some((s) => s.id === 901 && s.title === "Paper Boats"), "loads song 901");
  assert.ok(loaded.songs.some((s) => s.id === 902 && s.title === "Tin Kites"), "loads song 902");
  assert.ok(loaded.setlists.some((s) => s.id === 901 && s.name === "Harbor Set"), "loads setlist 901");
  assert.equal(store.getItem("leadSheetsLibraryV2"), oldLib, "leadSheetsLibraryV2 holds the old library byte for byte");
  assert.equal(store.getItem("leadSheetsBackupV2"), oldBak, "leadSheetsBackupV2 holds the old backup state byte for byte");
  assert.equal(store.getItem("leadSheetsLibrary"), oldLib, "leadSheetsLibrary is unchanged");
  assert.equal(store.getItem("leadSheetsBackup"), oldBak, "leadSheetsBackup is unchanged");

  // Also verify a 61f18be-style library whose seed songs carry bassNotes preserves every own item byte for byte
  const store61 = new FakeStorage();
  useStore(store61);
  const oldLib61 = makeOldLibraryRaw(
    [oldFixture(903, "Glass Drums", "Glass drums echo down the hall")],
    [{ id: 903, name: "Hall Set", songIds: [903] }],
    { seedWithBass: true },
  );
  store61.setItem("leadSheetsLibrary", oldLib61);
  store61.setItem("leadSheetsBackup", oldBak);
  const loaded61 = fresh.loadLibrary();
  assert.ok(loaded61.songs.some((s) => s.id === 903 && s.title === "Glass Drums"), "loads own song from 61f18be-style library");
  assert.equal(
    fresh.ownLibraryItems(store61.getItem("leadSheetsLibraryV2")).get("leadSheetsSong.903"),
    fresh.ownLibraryItems(oldLib61).get("leadSheetsSong.903"),
    "own song keeps exact bytes after 61f18be first open",
  );
  assert.equal(store61.getItem("leadSheetsBackupV2"), oldBak, "backup state copied byte for byte on 61f18be first open");
  assert.equal(store61.getItem("leadSheetsLibrary"), oldLib61, "61f18be old library key unchanged");
  assert.equal(store61.getItem("leadSheetsBackup"), oldBak, "61f18be old backup key unchanged");
});

// P3
await check("P3: edited built-in song is stored as text and removing the edit brings the built-in song back", async () => {
  const store = new FakeStorage();
  useStore(store);
  const fresh = await loadBundle();
  const initial = fresh.loadLibrary();
  const builtIn = initial.songs[0];
  const { ref: _ref, id: builtInId, ...rest } = builtIn;
  const editedTitle = `${builtIn.title} (Stage Edit)`;
  assert.equal(fresh.replaceOwnSong(builtInId, { ...rest, title: editedTitle }), true, "replaceOwnSong succeeds");
  const rawAfter = store.getItem("leadSheetsLibraryV2");
  assert.ok(rawAfter, "leadSheetsLibraryV2 exists");
  const storedSongs = (JSON.parse(rawAfter) as { songs: Record<string, unknown>[] }).songs;
  const savedBuiltIn = storedSongs.find((s) => s.id === builtInId);
  assert.ok(savedBuiltIn && typeof savedBuiltIn.chordpro === "string", "edited built-in song is stored as { id, chordpro }");
  assert.equal(savedBuiltIn.title, undefined, "no legacy title field on stored ChordPro song");
  assert.equal(savedBuiltIn.bassNotes, undefined, "no bassNotes field on stored ChordPro song");
  assert.equal(fresh.loadLibrary().songs.find((s) => s.id === builtInId)?.title, editedTitle, "edited title loads back");

  // Remove the edit -> built-in comes back
  const revertedRaw = fresh.withOwnLibraryItems(rawAfter, new Map([[`leadSheetsSong.${builtInId}`, null]]));
  store.setItem("leadSheetsLibraryV2", revertedRaw);
  const reverted = fresh.loadLibrary();
  assert.equal(reverted.songs.find((s) => s.id === builtInId)?.title, builtIn.title, "built-in song returns after removing edit");
  assert.equal(fresh.ownLibraryItems(store.getItem("leadSheetsLibraryV2")).size, 0, "no own items left after reverting built-in");
});

// P4
await check("P4: taking in old-tab saves skips taken items, keeps added ids, moves edited songs with settings and setlists and leadSheetsLeftBy", async () => {
  const store = new FakeStorage();
  useStore(store);
  const s901 = oldFixture(901, "To Delete In New", "Delete me in new build");
  const s902 = oldFixture(902, "To Edit In New", "Original words 902");
  const s903 = oldFixture(903, "To Edit In Old", "Original words 903");
  const s904 = oldFixture(904, "To Remove In Old", "Stay in new build");
  const s905 = oldFixture(905, "Acct A Song", "Original words 905");
  store.setItem("leadSheetsLibrary", makeOldLibraryRaw([s901, s902, s903, s904, s905]));
  store.setItem("leadSheetsScrollPercent.903", "125");
  store.setItem("leadSheetsNotation.903", JSON.stringify("nashville"));
  store.setItem("leadSheetsSongData.903", JSON.stringify({ tempo: 108 }));

  // First open copies to V2 and records taken prints
  const tab1 = await loadBundle();
  tab1.loadLibrary();
  assert.ok(store.getItem("leadSheetsLibraryV2"), "V2 created on first open");
  assert.ok(store.getItem("leadSheetsLibraryTaken"), "taken notes created on first open");

  // New build deletes 901 and edits 902
  assert.equal(tab1.removeOwnSong(901), true, "delete 901 in new build");
  const loaded902 = tab1.loadLibrary().songs.find((s) => s.id === 902)!;
  const { ref: _r, id: _i, ...rest902 } = loaded902;
  assert.equal(tab1.replaceOwnSong(902, { ...rest902, title: "Edited In New" }), true, "edit 902 in new build");

  // Old tab writes to leadSheetsLibrary:
  // - 901 & 902 unchanged (already taken)
  // - 903 edited
  // - 904 removed
  // - 910 added
  // - setlist 920 added pointing at [903, 910]
  // - 905 edited, with leadSheetsLeftBy matching its old-key entry for acct-a
  const s903Edited = oldFixture(903, "Edited In Old Tab", "New words from old tab");
  const s910Added = oldFixture(910, "Added In Old Tab", "Brand new old tab song");
  const s905Edited = oldFixture(905, "Late Edit Acct A", "Acct A edited in old tab");
  const oldRawAfter = makeOldLibraryRaw(
    [s901, s902, s903Edited, s910Added, s905Edited],
    [{ id: 920, name: "Old Tab Setlist", songIds: [903, 910] }],
  );
  store.setItem("leadSheetsLibrary", oldRawAfter);
  const old905Entry = tab1.ownLibraryItems(oldRawAfter).get("leadSheetsSong.905")!;
  const new905Entry = tab1.ownLibraryItems(store.getItem("leadSheetsLibraryV2")).get("leadSheetsSong.905")!;
  store.setItem(
    "leadSheetsLeftBy",
    JSON.stringify({
      "leadSheetsSong.905": ["acct-a", tab1.valuePrint(old905Entry)],
    }),
  );

  // New tab opens -> takes in from old key
  const tab2 = await loadBundle();
  const afterTakeIn = tab2.loadLibrary();
  assert.equal(store.getItem("leadSheetsLibrary"), oldRawAfter, "old key bytes are unchanged after take-in");
  assert.ok(!afterTakeIn.songs.some((s) => s.id === 901 || s.title === "To Delete In New"), "deleted song 901 stays deleted");
  assert.equal(afterTakeIn.songs.filter((s) => s.id === 902 || s.title === "To Edit In New" || s.title === "Edited In New").length, 1, "edited song 902 gets no second copy");
  assert.ok(afterTakeIn.songs.some((s) => s.id === 910 && s.title === "Added In Old Tab"), "song 910 added in old tab keeps its id");
  assert.ok(afterTakeIn.songs.some((s) => s.id === 904 && s.title === "To Remove In Old"), "song 904 removed in old tab stays in V2");

  const orig903 = afterTakeIn.songs.find((s) => s.id === 903);
  const moved903 = afterTakeIn.songs.find((s) => s.title === "Edited In Old Tab");
  assert.ok(orig903 && orig903.title === "To Edit In Old", "original 903 stays untouched");
  assert.ok(moved903 && moved903.id !== 903, "edited 903 added under a new id");
  assert.equal(store.getItem(`leadSheetsScrollPercent.${moved903.id}`), "125", "scroll percent copied to new id");
  assert.equal(store.getItem(`leadSheetsNotation.${moved903.id}`), JSON.stringify("nashville"), "notation copied to new id");
  assert.equal(store.getItem(`leadSheetsSongData.${moved903.id}`), JSON.stringify({ tempo: 108 }), "song data copied to new id");

  const set920 = afterTakeIn.setlists.find((s) => s.name === "Old Tab Setlist");
  assert.ok(set920, "setlist from old tab taken in");
  assert.deepEqual(set920.songRefs, [`local/${moved903.id}`, "local/910"], "setlist follows moved song 903 to its new id and keeps 910");

  // Second pass adds nothing
  const v2BeforeSecond = store.getItem("leadSheetsLibraryV2");
  const tab3 = await loadBundle();
  tab3.loadLibrary();
  assert.equal(store.getItem("leadSheetsLibraryV2"), v2BeforeSecond, "a second pass adds nothing");

  // Per-account ownership: moved 905 carries leadSheetsLeftBy mark for acct-a, so acct-b neither sees nor backs it up
  const moved905 = afterTakeIn.songs.find((s) => s.title === "Late Edit Acct A");
  assert.ok(moved905 && moved905.id !== 905, "edited 905 added under a new id");
  assert.ok(new905Entry, "original 905 still exists");
  store.setItem("leadSheetsLibraryMode", "account");
  store.setItem("leadSheetsBackupV2", JSON.stringify({ account: "acct-b", pulled: 0, synced: {}, at: null }));
  const shownForB = tab3.loadLibrary();
  assert.ok(!shownForB.songs.some((s) => s.id === moved905.id), "next account does not see moved song left by acct-a");
  const othersForB = tab3.leftByOthers(tab3.ownLibraryItems(store.getItem("leadSheetsLibraryV2")), "acct-b");
  assert.equal(othersForB.get(`leadSheetsSong.${moved905.id}`), "acct-a", "moved song is marked leftBy acct-a so acct-b does not back it up");
});

// P5
await check("P5: bundled 61f18be runs loadLibrary, save, and backup after new build opens; V2 keys unchanged, 0 removals, new build takes in old save", async () => {
  const old = needOldBuild();
  const store = new FakeStorage();
  useStore(store);
  const room = makeBackupRoom();
  globalThis.fetch = room.fetchMock;
  try {
    old.loadLibrary();
    old.addOwnSong({ ...madeSong("Old One", "First old song"), bassNotes: [] } as never);
    old.addOwnSong({ ...madeSong("Old Two", "Second old song"), bassNotes: [] } as never);
    old.backupOn("acct-p5");
    await old.syncBackup();
    const roomCountBefore = [...room.rows.values()].filter((r) => r.key.startsWith("leadSheetsSong.") && r.value !== null).length;
    assert.equal(roomCountBefore, 2, "room holds 2 songs from old build");

    // New build opens and saves a song as text
    const tabNew = await loadBundle();
    tabNew.loadLibrary();
    const newSongId = tabNew.addOwnSong(madeSong("New Text Tune", "Saved in ChordPro text"));
    assert.ok(newSongId !== null, "new build saved song");
    const v2LibBefore = store.getItem("leadSheetsLibraryV2");
    const v2BakBefore = store.getItem("leadSheetsBackupV2");
    assert.ok(v2LibBefore && v2BakBefore, "V2 library and backup keys exist");

    // Old build runs loadLibrary, syncBackup, and addOwnSong in the same localStorage
    room.requests.length = 0;
    old.loadLibrary();
    await old.syncBackup({ onlyIfChanged: true });
    const removed = room.requests.flatMap((r) => r.changes).filter((c) => c.value === null);
    assert.deepEqual(removed, [], "old build sends no song as removed");
    const roomCountAfter = [...room.rows.values()].filter((r) => r.key.startsWith("leadSheetsSong.") && r.value !== null).length;
    assert.equal(roomCountAfter, 2, "room still holds 2 songs");

    old.addOwnSong({ ...madeSong("Old Late Save", "Saved late by old tab"), bassNotes: [] } as never);
    assert.equal(store.getItem("leadSheetsLibraryV2"), v2LibBefore, "old build leaves leadSheetsLibraryV2 unchanged");
    assert.equal(store.getItem("leadSheetsBackupV2"), v2BakBefore, "old build leaves leadSheetsBackupV2 unchanged");

    // New build opens again and takes in the song the old build saved
    const tabNew2 = await loadBundle();
    const loaded = tabNew2.loadLibrary();
    assert.ok(loaded.songs.some((s) => s.title === "Old One"), "keeps Old One");
    assert.ok(loaded.songs.some((s) => s.title === "Old Two"), "keeps Old Two");
    assert.ok(loaded.songs.some((s) => s.title === "New Text Tune"), "keeps New Text Tune");
    assert.ok(loaded.songs.some((s) => s.title === "Old Late Save"), "takes in Old Late Save from old build");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// P6
await check("P6: two phones on one account, one holding old shape and one new, sync both ways with no second copy and no unedited upload", async () => {
  const room = makeBackupRoom();
  globalThis.fetch = room.fetchMock;
  try {
    const storeA = new FakeStorage();
    const storeB = new FakeStorage();
    const phoneA = await loadBundle();
    const phoneB = await loadBundle();

    // Phone A upgrades with an old-shape song 901
    useStore(storeA, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)");
    storeA.setItem("leadSheetsLibrary", makeOldLibraryRaw([oldFixture(901, "Mixed Sync Old", "Old shape lyric")]));
    phoneA.loadLibrary();
    phoneA.backupOn("acct-p6");
    await phoneA.syncBackup();
    const oldEntry901 = phoneA.ownLibraryItems(storeA.getItem("leadSheetsLibraryV2")).get("leadSheetsSong.901");
    assert.ok(oldEntry901 && !oldEntry901.includes('"chordpro"'), "song 901 rests in old shape on Phone A");

    // Phone B signs in and pulls song 901
    useStore(storeB, "Mozilla/5.0 (Linux; Android 15)");
    phoneB.loadLibrary();
    phoneB.backupOn("acct-p6");
    await phoneB.syncBackup();
    const bSongs1 = phoneB.loadLibrary().songs;
    assert.ok(bSongs1.some((s) => s.id === 901 && s.title === "Mixed Sync Old"), "Phone B reads pulled old-shape song");
    assert.equal(phoneB.ownLibraryItems(storeB.getItem("leadSheetsLibraryV2")).get("leadSheetsSong.901"), oldEntry901, "Phone B keeps pulled old-shape bytes untouched");

    // Second sync on Phone B uploads nothing (unedited song is not uploaded)
    room.requests.length = 0;
    await phoneB.syncBackup();
    assert.deepEqual(room.requests.flatMap((r) => r.changes), [], "Phone B uploads no unedited song");

    // Phone B adds a new ChordPro song 902 and syncs
    const idB = phoneB.addOwnSong(madeSong("Mixed Sync New", "New shape lyric"));
    assert.ok(idB !== null);
    room.requests.length = 0;
    await phoneB.syncBackup();
    const sentB = room.requests.flatMap((r) => r.changes);
    assert.deepEqual(sentB.map((c) => c.key), [`leadSheetsSong.${idB}`], "Phone B uploads only its new song, not unedited 901");
    assert.ok(sentB[0].value?.includes('"chordpro"'), "new song uploaded as ChordPro text");

    // Phone A pulls 902, uploads nothing, no second copy
    useStore(storeA, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)");
    room.requests.length = 0;
    await phoneA.syncBackup();
    assert.deepEqual(room.requests.flatMap((r) => r.changes), [], "Phone A uploads nothing when pulling 902");
    const aSongs2 = phoneA.loadLibrary().songs;
    assert.ok(aSongs2.some((s) => s.id === 901 && s.title === "Mixed Sync Old"), "Phone A holds 901");
    assert.ok(aSongs2.some((s) => s.id === idB && s.title === "Mixed Sync New"), "Phone A holds new ChordPro song");
    assert.ok(!aSongs2.some((s) => s.title.includes("· from")), "no second copy on Phone A");

    // Phone B edits 901 (converting 901 to text on save), syncs, Phone A pulls cleanly with no second copy
    useStore(storeB, "Mozilla/5.0 (Linux; Android 15)");
    const b901 = phoneB.loadLibrary().songs.find((s) => s.id === 901)!;
    const { ref: _r, id: _i, ...rest901 } = b901;
    phoneB.replaceOwnSong(901, { ...rest901, title: "Mixed Sync Old (Updated)" });
    await phoneB.syncBackup();

    useStore(storeA, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)");
    await phoneA.syncBackup();
    const aFinal = phoneA.loadLibrary().songs;
    assert.equal(aFinal.find((s) => s.id === 901)?.title, "Mixed Sync Old (Updated)", "Phone A pulls updated ChordPro 901");
    assert.ok(!aFinal.some((s) => s.title.includes("· from")), "still no second copy on Phone A");
    assert.ok(phoneA.ownLibraryItems(storeA.getItem("leadSheetsLibraryV2")).get("leadSheetsSong.901")?.includes('"chordpro"'), "901 is now ChordPro on Phone A");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// P8
await check("P8: account switch with mixed shapes sets aside and restores exact bytes, hides from next account, deletes old keys, and 61f18be sends no backup", async () => {
  const store = new FakeStorage();
  useStore(store);
  const room = makeBackupRoom();
  globalThis.fetch = room.fetchMock;
  try {
    store.setItem("leadSheetsLibrary", makeOldLibraryRaw([oldFixture(901, "Acct A Old", "Old shape for A")]));
    store.setItem("leadSheetsBackup", JSON.stringify({ account: "acct-a", pulled: 1, synced: {}, at: 1700000000000 }));
    store.setItem("leadSheetsLibraryMode", "account");

    const fresh = await loadBundle();
    fresh.loadLibrary();
    const idNew = fresh.addOwnSong(madeSong("Acct A New", "ChordPro shape for A"));
    assert.ok(idNew !== null, "added ChordPro song for acct-a");
    assert.ok(store.getItem("leadSheetsLibrary"), "old library key present before switch");
    assert.ok(store.getItem("leadSheetsBackup"), "old backup key present before switch");
    assert.ok(store.getItem("leadSheetsLibraryTaken"), "taken key present before switch");

    const ownABefore = fresh.ownLibraryItems(store.getItem("leadSheetsLibraryV2"));
    const bytesAOld = ownABefore.get("leadSheetsSong.901");
    const bytesANew = ownABefore.get(`leadSheetsSong.${idNew}`);
    assert.ok(bytesAOld && !bytesAOld.includes('"chordpro"'), "A's 901 is old shape");
    assert.ok(bytesANew && bytesANew.includes('"chordpro"'), "A's new song is ChordPro shape");

    // Switch to acct-b
    fresh.backupOn("acct-b");
    assert.equal(store.getItem("leadSheetsLibrary"), null, "leadSheetsLibrary removed on account switch");
    assert.equal(store.getItem("leadSheetsBackup"), null, "leadSheetsBackup removed on account switch");
    assert.equal(store.getItem("leadSheetsLibraryTaken"), null, "leadSheetsLibraryTaken removed on account switch");

    const shownB = fresh.loadLibrary();
    assert.ok(!shownB.songs.some((s) => s.title === "Acct A Old" || s.title === "Acct A New"), "acct-b sees none of acct-a's songs");

    // Pull colliding keys for acct-b so acct-a's mixed-shape songs move into leadSheetsSetAside.acct-a
    const bSong901 = JSON.stringify({ item: { id: 901, chordpro: fresh.songToChordPro(madeSong("Acct B 901", "B owns 901")) } });
    const bSongNew = JSON.stringify({ item: { id: idNew, chordpro: fresh.songToChordPro(madeSong("Acct B New", "B owns new")) } });
    room.rows.set("leadSheetsSong.901", { key: "leadSheetsSong.901", value: bSong901, rev: 1 });
    room.rows.set(`leadSheetsSong.${idNew}`, { key: `leadSheetsSong.${idNew}`, value: bSongNew, rev: 2 });
    await fresh.syncBackup();
    const asideA = JSON.parse(store.getItem("leadSheetsSetAside.acct-a") ?? "{}") as Record<string, string>;
    assert.equal(asideA["leadSheetsSong.901"], bytesAOld, "A's old-shape song set aside with exact bytes");
    assert.equal(asideA[`leadSheetsSong.${idNew}`], bytesANew, "A's ChordPro song set aside with exact bytes");

    // Switch back to acct-a -> both songs return with exact bytes
    fresh.backupOn("acct-a");
    const ownAAfter = fresh.ownLibraryItems(store.getItem("leadSheetsLibraryV2"));
    assert.equal(ownAAfter.get("leadSheetsSong.901"), bytesAOld, "A's old-shape song returns with exact bytes");
    assert.equal(ownAAfter.get(`leadSheetsSong.${idNew}`), bytesANew, "A's ChordPro song returns with exact bytes");
    const shownA = fresh.loadLibrary();
    assert.ok(shownA.songs.some((s) => s.title === "Acct A Old") && shownA.songs.some((s) => s.title === "Acct A New"), "acct-a sees both songs again");
    assert.ok(!shownA.songs.some((s) => s.title.startsWith("Acct B")), "acct-a sees none of acct-b's songs");

    // Bundled 61f18be sends no backup request after the switch (old keys stay gone)
    const old = needOldBuild();
    room.requests.length = 0;
    await old.syncBackup();
    assert.equal(room.requests.length, 0, "61f18be sends no backup request after account switch");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// P12
await check("P12: opening a library of 500 made-up songs parses each text once and a second loadLibrary parses none", async () => {
  const store = new FakeStorage();
  useStore(store);
  const writer = await loadBundle();
  writer.loadLibrary();
  const batch = Array.from({ length: 500 }, (_, i) =>
    madeSong(`Bench Song ${i + 1}`, `Line one of bench song ${i + 1} across the room`, {
      tempo: 80 + (i % 60),
      keyRoot: ["C", "D", "E", "G", "A"][i % 5],
      keyLabel: `${["C", "D", "E", "G", "A"][i % 5]} major`,
    }),
  );
  const ids = writer.addOwnSongs(batch);
  assert.ok(ids && ids.length === 500 && ids.every((id) => id !== null), "500 songs saved");
  const rawV2 = store.getItem("leadSheetsLibraryV2");
  assert.ok(rawV2, "500 songs rest under leadSheetsLibraryV2");

  const counterApp = await loadBundle(true);
  counterApp.__resetParseCalls?.();
  const t0 = process.hrtime.bigint();
  const first = counterApp.loadLibrary();
  const t1 = process.hrtime.bigint();
  const firstCalls = counterApp.__parseCalls ?? 0;

  counterApp.__resetParseCalls?.();
  const t2 = process.hrtime.bigint();
  const second = counterApp.loadLibrary();
  const t3 = process.hrtime.bigint();
  const secondCalls = counterApp.__parseCalls ?? 0;

  const firstMs = Number(t1 - t0) / 1e6;
  const secondMs = Number(t3 - t2) / 1e6;
  console.log(`P12 timing: 500 songs first load ${firstMs.toFixed(2)} ms (${firstCalls} parses), second load ${secondMs.toFixed(2)} ms (${secondCalls} parses)`);

  assert.equal(first.songs.length, seed.songs.length + 500, "all 500 songs plus 15 built-ins loaded");
  assert.equal(second.songs.length, seed.songs.length + 500, "second load returns all songs");
  assert.equal(firstCalls, 500, `first load parsed each of 500 texts once (parsed ${firstCalls})`);
  assert.equal(secondCalls, 0, `second load parsed none (parsed ${secondCalls})`);
});

// P17
await check("P17: full phone with room for one library moves keys in place (61f18be sends nothing); write-locked phone leaves old keys untouched", async () => {
  // 17a: room for one library + backup, not two
  const store1 = new FakeStorage();
  useStore(store1);
  const oldLib = makeOldLibraryRaw([oldFixture(901, "Tight Space", "No room for two libraries")]);
  const oldBak = JSON.stringify({ account: "acct-p17", pulled: 1, synced: {}, at: 1700000000000 });
  store1.setItem("leadSheetsLibrary", oldLib);
  store1.setItem("leadSheetsBackup", oldBak);
  // Limit fits one copy (+ tiny key name diff) but refuses a second copy of the library
  store1.maxBytes = "leadSheetsLibraryV2".length + oldLib.length + "leadSheetsBackupV2".length + oldBak.length + 20;

  const fresh1 = await loadBundle();
  const loaded1 = fresh1.loadLibrary();
  assert.ok(loaded1.songs.some((s) => s.title === "Tight Space"), "tight-space phone still opens the song");
  assert.equal(store1.getItem("leadSheetsLibraryV2"), oldLib, "library moved to leadSheetsLibraryV2");
  assert.equal(store1.getItem("leadSheetsBackupV2"), oldBak, "backup state moved to leadSheetsBackupV2");
  assert.equal(store1.getItem("leadSheetsLibrary"), null, "old leadSheetsLibrary removed");
  assert.equal(store1.getItem("leadSheetsBackup"), null, "old leadSheetsBackup removed");

  // 17b: localStorage refuses every write -> leaves both old keys as they were, loads from old key, refuses save
  const store2 = new FakeStorage();
  useStore(store2);
  store2.setItem("leadSheetsLibrary", oldLib);
  store2.setItem("leadSheetsBackup", oldBak);
  store2.failWrites = true;

  const fresh2 = await loadBundle();
  const loaded2 = fresh2.loadLibrary();
  assert.ok(loaded2.songs.some((s) => s.title === "Tight Space"), "write-locked phone still shows library from old key");
  assert.equal(store2.getItem("leadSheetsLibrary"), oldLib, "old library key untouched when every write fails");
  assert.equal(store2.getItem("leadSheetsBackup"), oldBak, "old backup key untouched when every write fails");
  assert.equal(store2.getItem("leadSheetsLibraryV2"), null, "V2 key absent when every write fails");
  assert.equal(fresh2.addOwnSong(madeSong("Refused Song", "Cannot write")), null, "save is refused on write-locked phone");

  // Next load after space frees copies to V2
  store2.failWrites = false;
  fresh2.loadLibrary();
  assert.equal(store2.getItem("leadSheetsLibraryV2"), oldLib, "next load copies once writes work again");

  // 17a old-build check: after in-place move on store1, 61f18be sends no backup request
  useStore(store1);
  const old = needOldBuild();
  const room = makeBackupRoom();
  globalThis.fetch = room.fetchMock;
  try {
    await old.syncBackup();
    assert.equal(room.requests.length, 0, "61f18be sends no backup request after in-place move");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// =================================================================================================
// PART 2: Screens and the Worker (P2, P7, P9, P10, P11, P13, P14, P15, P16, P18)
// =================================================================================================

const stateDir = mkdtempSync(join(tmpdir(), "check-chordpro-phone-state-"));
let apiBase = "";
let site: Site | null = null;
let siteError = "";
let api: Awaited<ReturnType<typeof startApi>> | null = null;
const phones: Phone[] = [];

try {
  site = await openSite(root, "check-chordpro-phone", () => apiBase);
} catch (error) {
  siteError = error instanceof Error ? error.message.split("\n")[0] : String(error);
}

const origin = site ? site.origin.replace("127.0.0.1", "localhost") : "https://app.test";
const workerEnv = { APP_ORIGIN: origin, RP_ID: site ? "localhost" : "app.test", PASSWORD_PEPPER };

async function withSqlite<T>(work: (files: string[]) => T): Promise<T> {
  assert.ok(api, "Worker running");
  await api.worker.dispose();
  api = null;
  try {
    const files = (readdirSync(stateDir, { recursive: true }) as string[])
      .filter((name) => name.endsWith(".sqlite"))
      .map((name) => join(stateDir, name));
    return work(files);
  } finally {
    api = await startApi(workerEnv, stateDir);
    apiBase = api.base;
    for (const p of phones) Object.assign(p, { base: api.base });
  }
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
}

try {
  if (site) {
    api = await startApi(workerEnv, stateDir);
    apiBase = api.base;
  }

  const needSite = () => {
    assert.ok(site && api, `browser and Worker could not start (${siteError || "no worker"})`);
    return { site, api };
  };

  let appUi: Awaited<ReturnType<typeof appPage>> | null = null;
  let samUserId = "";
  let samHandle = "";
  let terry: Awaited<ReturnType<typeof passwordPlayer>> | null = null;
  let gus: Awaited<ReturnType<typeof passwordPlayer>> | null = null;

  if (site && api) {
    appUi = await appPage(site);
    await site.send("Network.enable");
    // Spy on window.fetch so P7, P11, P14, P15 can verify real outgoing headers, request bodies, and replies
    await site.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        window.__calls = [];
        const realFetch = window.fetch;
        window.fetch = async (input, init) => {
          const url = String(typeof input === "string" ? input : input?.url ?? "");
          const headers = {};
          if (init?.headers) {
            if (init.headers instanceof Headers) init.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
            else for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = String(v);
          }
          let reqBody = null;
          if (typeof init?.body === "string") { try { reqBody = JSON.parse(init.body); } catch {} }
          const resp = await realFetch(input, init);
          let resBody = null;
          if (url.includes("/api/")) {
            try { resBody = await resp.clone().json(); } catch {}
            window.__calls.push({ url, method: init?.method ?? "GET", headers, reqBody, status: resp.status, resBody });
          }
          return resp;
        };
      })();`,
    });

    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await appUi.library();
    await appUi.signUp("Sam Rivera");
    const me = await site.evaluate<{ account?: { userId: string; handle: string } }>(`fetch("/api/me").then((r) => r.json())`);
    samUserId = me.account!.userId;
    samHandle = me.account!.handle;

    terry = await passwordPlayer(api.base, origin, "Terry Bass", "terryp");
    gus = await passwordPlayer(api.base, origin, "Gus Guest", "gusp");
    phones.push(terry, gus);

    // Connect Sam and Terry as friends
    assert.equal((await terry.call("/api/friends/request", { handle: samHandle })).status, 200, "Terry asks Sam");
    const accepted = await site.evaluate<number>(
      `fetch("/api/friends/accept", { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js({ userId: terry.userId }))} }).then((r) => r.status)`,
    );
    assert.equal(accepted, 200, "Sam accepts Terry");
  }

  const setInput = async (selector: string, value: string, isTextarea = false) => {
    const proto = isTextarea ? "HTMLTextAreaElement" : "HTMLInputElement";
    await site!.evaluate(
      `(() => { const el = document.querySelector(${js(selector)}); Object.getOwnPropertyDescriptor(${proto}.prototype, "value").set.call(el, ${js(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`,
    );
    await settle(150);
  };

  // P2: Node storage + all 5 browser save paths (editor new, editor edit, smart paste, bulk import add, bulk import Replace)
  await check("P2: saving one song writes { id, copy?, chordpro } without changing other songs; editor, paste and bulk import all store text", async () => {
    // 2a: Node mixed-library isolation
    const store = new FakeStorage();
    useStore(store);
    const fresh = await loadBundle();
    store.setItem(
      "leadSheetsLibrary",
      makeOldLibraryRaw([
        oldFixture(901, "Keep Old One", "First untouched song"),
        oldFixture(902, "Keep Old Two", "Second untouched song"),
        oldFixture(903, "Keep Old Copy", "Third untouched song", { copy: { id: "cp-old", canSendOn: false, from: { name: "Pat" } } }),
      ]),
    );
    fresh.loadLibrary();
    const beforeOwn = fresh.ownLibraryItems(store.getItem("leadSheetsLibraryV2"));
    const addedId = fresh.addOwnSong(madeSong("Fresh ChordPro", "Written as text"));
    assert.ok(addedId !== null);
    const copyAddedId = fresh.addOwnSong({ ...madeSong("Copied ChordPro", "With copy mark"), copy: { id: "cp-new", canSendOn: true, from: { name: "Kim" } } });
    assert.ok(copyAddedId !== null);
    const afterAddOwn = fresh.ownLibraryItems(store.getItem("leadSheetsLibraryV2"));
    for (const k of ["leadSheetsSong.901", "leadSheetsSong.902", "leadSheetsSong.903"]) {
      assert.equal(afterAddOwn.get(k), beforeOwn.get(k), `${k} bytes untouched when another song is saved`);
    }
    const rawSongs = (JSON.parse(store.getItem("leadSheetsLibraryV2")!) as { songs: Record<string, unknown>[] }).songs;
    const savedNew = rawSongs.find((s) => s.id === addedId)!;
    assert.deepEqual(Object.keys(savedNew).sort(), ["chordpro", "id"], "new song stored as { id, chordpro } only");
    const savedCopy = rawSongs.find((s) => s.id === copyAddedId)!;
    assert.deepEqual(Object.keys(savedCopy).sort(), ["chordpro", "copy", "id"], "copy song stored as { id, copy, chordpro }");
    assert.deepEqual(savedCopy.copy, { id: "cp-new", canSendOn: true, from: { name: "Kim" } }, "copy mark stays outside chordpro text");

    // 2b: Browser flows (editor new, editor edit via content(), smart paste, bulk import new & Replace via content())
    const { site: s } = needSite();
    const ui = appUi!;
    await s.evaluate(`location.hash = "#/songs"`);
    await ui.until(`!!document.querySelector(".song-list-add")`, "My Songs add button");

    // 1. New song from editor
    await ui.click("+ Add a song");
    await ui.until(`!!document.querySelector("form.song-editor")`, "New song editor");
    await setInput(`form.song-editor input[aria-required="true"]`, "Editor New Tune");
    await setInput(`form.song-editor textarea.song-editor-text`, "VERSE 1\nA       E\nEditor new words here", true);
    await ui.click("Save", `document.querySelector("form.song-editor")`);
    await ui.until(`document.querySelector(".sheet .sheet-name")?.textContent === "Editor New Tune"`, "Editor New Tune sheet");

    const v2Raw1 = await s.evaluate<string | null>(`localStorage.getItem("leadSheetsLibraryV2")`);
    assert.ok(v2Raw1, "leadSheetsLibraryV2 present in browser");
    const editorSong1 = (JSON.parse(v2Raw1) as { songs: Record<string, unknown>[] }).songs.find(
      (item) => typeof item.chordpro === "string" && item.chordpro.includes("{title: Editor New Tune}"),
    );
    assert.ok(editorSong1 && editorSong1.title === undefined && editorSong1.bassNotes === undefined, "editor new song stored as { id, chordpro }");

    // 2. Edit saved in editor (calls content())
    await s.evaluate(`document.querySelector('[aria-label="More"]').click()`);
    await ui.until(`!!document.querySelector('[role="menu"]')`, "More menu");
    await s.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === "Edit").click()`);
    await ui.until(`!!document.querySelector("form.song-editor")`, "Edit song dialog");
    await setInput(`form.song-editor textarea.song-editor-text`, "VERSE 1\nD       A\nEdited chart words here", true);
    await ui.click("Save", `document.querySelector("form.song-editor")`);
    await ui.until(`!document.querySelector("form.song-editor")`, "Edit dialog closed");
    const v2Raw2 = await s.evaluate<string>(`localStorage.getItem("leadSheetsLibraryV2")`);
    const editedRow = (JSON.parse(v2Raw2) as { songs: Record<string, unknown>[] }).songs.find((item) => item.id === editorSong1.id);
    assert.ok(editedRow && typeof editedRow.chordpro === "string" && editedRow.chordpro.replace(/\[[^\]]*\]/g, "").includes("Edited chart words here"), "editor edit stored as text");

    // 3. New song from smart paste
    await s.evaluate(`location.hash = "#/songs"`);
    await ui.until(`!!document.querySelector(".song-list-add")`, "My Songs");
    await ui.click("+ Add a song");
    await ui.until(`!!document.querySelector("form.song-editor textarea.song-editor-text")`, "Editor textarea");
    const pasteText = "Smart Paste Tune Chords\nby The Made Up Band\nKey: G\n\n[Verse 1]\nG       C\nPasted words in bright sun";
    await s.evaluate(`(() => {
      const box = document.querySelector("form.song-editor textarea.song-editor-text");
      const dt = new DataTransfer();
      dt.setData("text/plain", ${js(pasteText)});
      box.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    })()`);
    await ui.until(`document.querySelector('form.song-editor input[aria-required="true"]')?.value === "Smart Paste Tune"`, "paste filled title");
    await ui.click("Save", `document.querySelector("form.song-editor")`);
    await ui.until(`document.querySelector(".sheet .sheet-name")?.textContent === "Smart Paste Tune"`, "Smart Paste Tune sheet");
    const v2Raw3 = await s.evaluate<string>(`localStorage.getItem("leadSheetsLibraryV2")`);
    assert.ok(
      (JSON.parse(v2Raw3) as { songs: Record<string, unknown>[] }).songs.some(
        (item) => typeof item.chordpro === "string" && item.chordpro.includes("{title: Smart Paste Tune}") && item.title === undefined,
      ),
      "smart paste song stored as text",
    );

    // 4. Bulk import add + 5. Bulk import Replace (calls content())
    await s.evaluate(`location.hash = "#/songs"`);
    await ui.until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Import files")`, "Import files button");
    await ui.click("Import files");
    await ui.until(`!!document.querySelector("section.song-import input[type=file]")`, "Import sheet");
    const importV1 = "Import Tune Chords\nby The Made Up Band\nKey: D\n\n[Verse 1]\nD       G\nFirst imported lyric line";
    await s.evaluate(`(() => {
      const input = document.querySelector("section.song-import input[type=file]");
      const dt = new DataTransfer();
      dt.items.add(new File([${js(importV1)}], "import-tune.txt", { type: "text/plain" }));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await ui.until(`[...document.querySelectorAll("section.song-import button")].some((b) => b.textContent.trim() === "Save 1 song" && !b.disabled)`, "Save 1 song enabled");
    await ui.click("Save 1 song", `document.querySelector("section.song-import")`);
    await ui.until(`document.querySelector(".song-import-done")?.textContent.includes("1 song saved")`, "1 song saved");
    const v2Raw4 = await s.evaluate<string>(`localStorage.getItem("leadSheetsLibraryV2")`);
    const importedRow = (JSON.parse(v2Raw4) as { songs: Record<string, unknown>[] }).songs.find(
      (item) => typeof item.chordpro === "string" && item.chordpro.includes("{title: Import Tune}") && item.chordpro.replace(/\[[^\]]*\]/g, "").includes("First imported lyric line"),
    );
    assert.ok(importedRow && importedRow.title === undefined, "bulk import song stored as text");

    // Close and reopen Import files to Replace Import Tune
    await ui.click("Close", `document.querySelector("section.song-import")`);
    await ui.until(`!document.querySelector("section.song-import")`, "Import sheet closed");
    await ui.click("Import files");
    await ui.until(`!!document.querySelector("section.song-import input[type=file]")`, "Import sheet reopened");
    const importV2 = "Import Tune Chords\nby The Made Up Band\nKey: D\n\n[Verse 1]\nD       A\nReplaced imported lyric line";
    await s.evaluate(`(() => {
      const input = document.querySelector("section.song-import input[type=file]");
      const dt = new DataTransfer();
      dt.items.add(new File([${js(importV2)}], "import-tune-v2.txt", { type: "text/plain" }));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await ui.until(`[...document.querySelectorAll("section.song-import button")].some((b) => b.textContent.trim() === "Replace")`, "Replace button");
    await ui.click("Replace", `document.querySelector("section.song-import")`);
    await ui.until(`!!document.querySelector('.song-import-ask[aria-label="Replace"]')`, "Replace confirm");
    await ui.click("Replace", `document.querySelector('.song-import-ask[aria-label="Replace"]')`);
    await ui.until(`document.querySelector('.song-import-row')?.dataset.mark === "saved"`, "Replaced row saved");
    await ui.click("Close", `document.querySelector("section.song-import")`);
    await ui.until(`!document.querySelector("section.song-import")`, "Import sheet closed after replace");

    const v2Raw5 = await s.evaluate<string>(`localStorage.getItem("leadSheetsLibraryV2")`);
    const replacedRow = (JSON.parse(v2Raw5) as { songs: Record<string, unknown>[] }).songs.find((item) => item.id === importedRow.id);
    assert.ok(
      replacedRow && typeof replacedRow.chordpro === "string" && replacedRow.chordpro.replace(/\[[^\]]*\]/g, "").includes("Replaced imported lyric line") && replacedRow.title === undefined,
      "bulk import Replace stored as text",
    );
  });

  // P7: Every api() call carries X-Song-Shape: chordpro, the backup call too
  await check("P7: every api() call carries X-Song-Shape: chordpro, including backup calls", async () => {
    const store = new FakeStorage();
    useStore(store);
    const room = makeBackupRoom();
    globalThis.fetch = room.fetchMock;
    try {
      const fresh = await loadBundle();
      await fresh.api("/api/me");
      await fresh.api("/api/bands/library", { bandId: "band_1" });
      fresh.backupOn("acct-p7");
      await fresh.syncBackup();
      assert.ok(room.requests.length >= 3, `captured ${room.requests.length} requests`);
      for (const req of room.requests) {
        assert.equal(req.headers["x-song-shape"], "chordpro", `${req.url} carried X-Song-Shape: chordpro (got ${js(req.headers)})`);
      }
      assert.ok(room.requests.some((r) => r.url.includes("/api/backup")), "backup call included");
    } finally {
      globalThis.fetch = realFetch;
    }

    // Also verify browser calls sent the header
    const { site: s } = needSite();
    const browserCalls = await s.evaluate<{ url: string; headers: Record<string, string> }[]>(`window.__calls.filter((c) => c.url.includes("/api/backup") || c.url.includes("/api/me"))`);
    assert.ok(browserCalls.length > 0, "browser made API calls");
    assert.ok(
      browserCalls.some((c) => c.url.includes("/api/backup") && c.headers["x-song-shape"] === "chordpro"),
      `browser backup call carried X-Song-Shape: chordpro (${js(browserCalls.map((c) => [c.url, c.headers["x-song-shape"]]))})`,
    );
  });

  // P9: Gig pack and kept band song stored in old shape or as text both open on the sheet (offline)
  await check("P9: gig pack and kept band song stored in old shape or as text both open offline on the sheet", async () => {
    const { site: s } = needSite();
    const ui = appUi!;
    const oldBandSong = oldFixture(0, "Kept Old Band Song", "Old band cached lyric");
    const textBandSong = { chordpro: app.songToChordPro(madeSong("Kept Text Band Song", "Text band cached lyric")) };
    const oldPackSong = oldFixture(0, "Pack Old Gig Song", "Old gig pack lyric");
    const textPackSong = { chordpro: app.songToChordPro(madeSong("Pack Text Gig Song", "Text gig pack lyric")) };

    const makePack = (gigId: string, name: string, song: unknown) => ({
      gig: {
        gigId,
        bandId: "band_p9",
        setlistId: "set_p9",
        name,
        date: today(),
        startTime: null,
        callTime: null,
        venue: "",
        address: "",
        notes: "",
        songOrder: ["gs1"],
        lineup: [samUserId],
        leader: samUserId,
        backup: null,
        route: "auto",
        status: "planned",
        startedAt: null,
        endedAt: null,
      },
      songs: [{ songId: "gs1", song, bandTiming: null }],
      scrollWithLeader: false,
      secret: "sec_p9",
      packRev: 1,
      expiresAt: null,
    });

    await s.evaluate(`(async () => {
      localStorage.setItem("leadSheetsPhoneOwner", ${js(samUserId)});
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("mls-phone", 2);
        req.onupgradeneeded = () => {
          for (const name of ["bandSongs", "gigPacks", "syncHistory"]) {
            if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(["bandSongs", "gigPacks"], "readwrite");
        tx.objectStore("bandSongs").put({ bandId: "band_p9", bandName: "P9 Band", songId: "song_old", song: ${js(oldBandSong)}, sharedAs: "public", updatedAt: 1 }, "band_p9/song_old");
        tx.objectStore("bandSongs").put({ bandId: "band_p9", bandName: "P9 Band", songId: "song_new", song: ${js(textBandSong)}, sharedAs: "public", updatedAt: 1 }, "band_p9/song_new");
        tx.objectStore("gigPacks").put(${js(makePack("gig_old", "P9 Old Gig", oldPackSong))}, "gig_old");
        tx.objectStore("gigPacks").put(${js(makePack("gig_new", "P9 New Gig", textPackSong))}, "gig_new");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    })()`);

    await s.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    try {
      for (const [hash, title, lyric] of [
        ["#/band/band_p9/song/song_old", "Kept Old Band Song", "Old band cached lyric"],
        ["#/band/band_p9/song/song_new", "Kept Text Band Song", "Text band cached lyric"],
        ["#/gig/band_p9/gig_old/0", "Pack Old Gig Song", "Old gig pack lyric"],
        ["#/gig/band_p9/gig_new/0", "Pack Text Gig Song", "Text gig pack lyric"],
      ] as const) {
        await s.evaluate(`location.hash = ${js(hash)}`);
        await ui.until(`document.querySelector(".sheet .sheet-name")?.textContent === ${js(title)}`, `${title} on sheet`);
        const chartText = await ui.text(".sheet .chart");
        assert.ok(chartText.includes(lyric), `${title} renders its lyrics (${lyric})`);
      }

      // Also verify library-lists.tsx door: search finds text band song from IndexedDB bandSongs offline
      await s.evaluate(`location.hash = "#/songs"`);
      await ui.until(`!!document.querySelector('input[aria-label="Search songs"]')`, "Search songs box");
      await setInput(`input[aria-label="Search songs"]`, "Kept Text Band");
      await ui.until(`document.body.textContent.includes("Kept Text Band Song")`, "search finds kept text band song");
      await setInput(`input[aria-label="Search songs"]`, "");
    } finally {
      await s.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
  });

  // P10: Song card of either shape opens and adds to My Songs; queued old-shape send delivered once
  await check("P10: song card of either shape opens and adds to My Songs, and a pre-update queued old-shape send delivers once", async () => {
    const { site: s } = needSite();
    const ui = appUi!;
    const t = terry!;

    const oldCardSong = madeSong("Old Card Tune", "Words on an old card");
    const textCardSong = madeSong("Text Card Tune", "Words on a text card");

    assert.equal(
      (
        await t.call("/api/chat/send-song", {
          userId: samUserId,
          msgId: newId(),
          shareId: newId(),
          song: { ...oldCardSong, bassNotes: [] },
          versions: [],
          data: null,
          choice: "public",
        })
      ).status,
      200,
      "Terry sends old-shape card",
    );
    assert.equal(
      (
        await t.call(
          "/api/chat/send-song",
          {
            userId: samUserId,
            msgId: newId(),
            shareId: newId(),
            song: { chordpro: app.songToChordPro(textCardSong) },
            versions: [],
            data: null,
            choice: "public",
          },
          NEW_SHAPE,
        )
      ).status,
      200,
      "Terry sends ChordPro card",
    );

    const dmRoomId = (await t.call("/api/chat/dm", { userId: samUserId })).body.roomId as string;
    await s.evaluate(`location.hash = ${js(`#/messages/${dmRoomId}`)}`);
    await ui.until(
      `document.querySelector(".room")?.textContent.includes("Old Card Tune") && document.querySelector(".room")?.textContent.includes("Text Card Tune")`,
      "both song cards in DM",
      15000,
    );
    assert.ok(!(await ui.text(".room")).includes("A song this app can't show"), "neither card fails to show");

    // Click Add to My Songs on both cards
    for (const title of ["Old Card Tune", "Text Card Tune"]) {
      const clicked = await s.evaluate<boolean>(`(() => {
        const card = [...document.querySelectorAll(".song-card")].find((el) => el.textContent.includes(${js(title)}));
        const btn = [...(card?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Add to My Songs");
        btn?.click();
        return !!btn;
      })()`);
      assert.ok(clicked, `clicked Add to My Songs for ${title}`);
      await ui.until(
        `[...document.querySelectorAll(".song-card")].find((el) => el.textContent.includes(${js(title)}))?.textContent.includes("In My Songs")`,
        `${title} marked In My Songs`,
      );
    }

    const v2After = JSON.parse((await s.evaluate<string>(`localStorage.getItem("leadSheetsLibraryV2")`)) ?? "{}") as { songs: Record<string, unknown>[] };
    for (const title of ["Old Card Tune", "Text Card Tune"]) {
      const row = v2After.songs.find((item) => typeof item.chordpro === "string" && item.chordpro.includes(`{title: ${title}}`));
      assert.ok(row && row.title === undefined, `${title} added to My Songs as ChordPro text`);
    }

    // Queued old-shape send from before update delivers once
    const queuedShareId = newId();
    const queuedSong = { ...madeSong("Queued Legacy Tune", "Queued before update"), bassNotes: [] };
    const queuedItem = {
      msgId: newId(),
      roomId: dmRoomId,
      text: "Queued Legacy Tune",
      at: Date.now(),
      from: samUserId,
      song: {
        userId: t.userId,
        shareId: queuedShareId,
        song: queuedSong,
        versions: [],
        data: null,
        choice: "public",
        copyId: null,
        updateOf: null,
      },
    };
    await s.evaluate(`localStorage.setItem("leadSheetsChatQueue", ${js(js([queuedItem]))})`);
    await s.send("Page.reload");
    await ui.library();
    await ui.until(`!localStorage.getItem("leadSheetsChatQueue")`, "queued old-shape send flushed", 15000);
    const dmMsgs = (await t.call("/api/chat/open", { roomId: dmRoomId })).body.messages as { kind: string; ref: string }[];
    assert.equal(dmMsgs.filter((m) => m.kind === "song" && m.ref === queuedShareId).length, 1, "queued old-shape send arrived once");
  });

  // P11: Share to a band, send to a friend, and mint a copy code each send { chordpro }
  await check("P11: share to a band, send to a friend, and mint a copy code each send { chordpro }", async () => {
    const { site: s } = needSite();
    const ui = appUi!;
    await s.evaluate(`window.__calls = []`);

    // 1. Share to a band
    await ui.openBands();
    await ui.until(`document.querySelector(".bands-sheet")?.dataset.view === "list" && !document.querySelector(".bands-sheet").textContent.includes("Loading")`, "Bands list");
    await ui.type("New band", "P11 Band");
    await ui.click("Create band");
    await ui.until(`document.querySelector(".band-page")?.dataset.view === "band"`, "P11 Band page", 15000);
    await ui.click("Songs", `document.querySelector(".band-tabs")`);
    await ui.click("+ Add songs");
    const firstBuiltInTitle = seed.songs[0].title;
    await s.evaluate(`[...document.querySelectorAll(".band-library-pick-row")].find((b) => b.textContent.includes(${js(firstBuiltInTitle)}) && !b.disabled).click()`);
    await settle();
    await ui.click("Public");
    await ui.click("Share");
    await ui.until(`document.querySelector(".bands-notice")?.textContent.includes("Shared")`, "Share notice", 15000);

    // 2. Send to a friend
    await s.evaluate(`location.hash = "#/song/${seed.songs[0].id}"`);
    await ui.until(`!!document.querySelector(".sheet .sheet-name")`, "song sheet");
    await s.evaluate(`document.querySelector('[aria-label="More"]').click()`);
    await ui.until(`!!document.querySelector('[role="menu"]')`, "More menu");
    await s.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes("Send to a friend")).click()`);
    await ui.until(`!!document.querySelector(".send-song-sheet")`, "Send song sheet");
    await ui.until(`[...document.querySelectorAll(".send-song-sheet button")].some((b) => b.textContent.includes("Terry Bass"))`, "Terry friend row");
    await s.evaluate(`[...document.querySelectorAll(".send-song-sheet button")].find((b) => b.textContent.includes("Terry Bass")).click()`);
    await settle();
    await ui.click("Public", `document.querySelector(".send-song-sheet")`);
    await s.evaluate(`[...document.querySelectorAll(".send-song-sheet button")].find((b) => b.textContent.startsWith("Send to ")).click()`);
    await ui.until(`!document.querySelector(".send-song-sheet") && window.__calls.some((c) => c.url.includes("/api/chat/send-song"))`, "Send song sheet closed and sent", 15000);

    // 3. Mint a copy code
    await s.evaluate(`location.hash = "#/setlists"`);
    await ui.until(`!!document.querySelector("section.setlist .setlist-head button")`, "setlist name button");
    await s.evaluate(`document.querySelector("section.setlist .setlist-head button").click()`);
    await ui.until(`!!document.querySelector(".setlist-builder .setlist-code-show")`, "Show code in setlist builder");
    await s.evaluate(`document.querySelector(".setlist-builder .setlist-code-show").click()`);
    await ui.until(`!!document.querySelector(".setlist-code-sheet")`, "My setlist code sheet");
    await ui.click("Public", `document.querySelector(".setlist-code-sheet")`);
    await ui.click("Show code", `document.querySelector(".setlist-code-sheet")`);
    await ui.until(`!!document.querySelector(".setlist-code-sheet .codes-qr svg")`, "Copy code QR", 15000);
    await ui.click("✕", `document.querySelector(".setlist-code-sheet")`);

    const calls = await s.evaluate<{ url: string; reqBody: Record<string, any> }[]>(`window.__calls`);
    const shareCall = calls.find((c) => c.url.includes("/api/bands/library/share-song"));
    assert.ok(shareCall && typeof shareCall.reqBody?.song?.chordpro === "string" && shareCall.reqBody.song.title === undefined, `share-song sent { chordpro } (${js(shareCall?.reqBody?.song)})`);

    const sendCall = calls.find((c) => c.url.includes("/api/chat/send-song"));
    assert.ok(sendCall && typeof sendCall.reqBody?.song?.chordpro === "string" && sendCall.reqBody.song.title === undefined, `send-song sent { chordpro } (${js(sendCall?.reqBody?.song)})`);

    const mintCall = calls.find((c) => c.url.includes("/api/codes") && c.reqBody?.kind === "my-setlist");
    assert.ok(mintCall && Array.isArray(mintCall.reqBody?.songs) && mintCall.reqBody.songs.length > 0, "my-setlist mint call captured");
    for (const item of mintCall.reqBody.songs) {
      assert.ok(typeof item.song?.chordpro === "string" && item.song.title === undefined, `my-setlist item sent { chordpro } (${js(item.song)})`);
    }
  });

  // P13: A song saved as text and opened again draws every chord over the same syllable as before the save
  await check("P13: a song saved as text draws every chord over the exact same syllable as before the save", async () => {
    const { site: s } = needSite();
    const ui = appUi!;
    const alignSections: ChartSection[] = [
      {
        heading: "VERSE 1",
        lines: [
          { chords: "A               E              F#m", lyrics: "Paper boats are sailing to the sea" },
          { chords: "  D    A                  E", lyrics: "Fold another one for me" },
          { chords: "G/B       C/E       Am/G", lyrics: "Lanterns drifting past the pier" },
        ],
      },
    ];
    const alignSong = oldFixture(987, "Alignment Proof", "unused", { body: alignSections });

    const measureExpr = `(() => {
      const chart = document.querySelector(".chart");
      const range = (node, from, to) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return r.getBoundingClientRect(); };
      return [...chart.querySelectorAll(".pair")].map((row) => {
        const chords = row.querySelector(".chords");
        const lyrics = row.querySelector(".lyrics");
        const text = chords.textContent;
        const lyric = lyrics?.textContent;
        const under = lyrics ?? chords;
        const left = under.getBoundingClientRect().left;
        const sample = lyric ? { node: lyrics.firstChild, length: lyric.length } : { node: chords.firstChild, length: text.length };
        const advance = range(sample.node, 0, sample.length).width / sample.length;
        const at = [...text.matchAll(/\\S+/g)].map((chord) => (range(chords.firstChild, chord.index, chord.index + 1).left - left) / advance);
        return { chords: text, lyrics: lyrics ? lyric : undefined, at };
      });
    })()`;

    const waitSheet = async (title: string) => {
      await ui.until(`document.querySelector(".sheet .sheet-name")?.textContent === ${js(title)} && !!document.querySelector(".chart .pair")`, `${title} chart rendered`);
      await s.evaluate(`document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`);
    };

    // Put old-shape Alignment Proof into V2 (or old key on commit 1), open at width 768 so nothing wraps differently
    await s.send("Emulation.setDeviceMetricsOverride", { width: 768, height: 900, deviceScaleFactor: 2, mobile: false });
    try {
      await s.evaluate(`(() => {
        const key = localStorage.getItem("leadSheetsLibraryV2") ? "leadSheetsLibraryV2" : "leadSheetsLibrary";
        const lib = JSON.parse(localStorage.getItem(key));
        lib.songs = lib.songs.filter((item) => item.id !== 987);
        lib.songs.push(${js(alignSong)});
        lib.lastSongId = Math.max(lib.lastSongId ?? 0, 987);
        localStorage.setItem(key, JSON.stringify(lib));
      })()`);
      await s.send("Page.navigate", { url: `${origin}/?p13=1#/song/987` });
      await waitSheet("Alignment Proof");
      const beforeRows = await s.evaluate<Row[]>(measureExpr);
      for (const row of beforeRows) row.at = row.at!.map(Math.round);
      const beforeAnchors = chordAnchors(beforeRows);

      // Save through editor so it rests as { id: 987, chordpro }
      await s.evaluate(`document.querySelector('[aria-label="More"]').click()`);
      await ui.until(`!!document.querySelector('[role="menu"]')`, "More menu");
      await s.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === "Edit").click()`);
      await ui.until(`!!document.querySelector("form.song-editor")`, "Edit dialog");
      await ui.click("Save", `document.querySelector("form.song-editor")`);
      await ui.until(`!document.querySelector("form.song-editor")`, "Edit dialog closed");

      const v2Raw = await s.evaluate<string | null>(`localStorage.getItem("leadSheetsLibraryV2")`);
      assert.ok(v2Raw, "leadSheetsLibraryV2 exists");
      const stored987 = (JSON.parse(v2Raw) as { songs: Record<string, unknown>[] }).songs.find((item) => item.id === 987);
      assert.ok(stored987 && typeof stored987.chordpro === "string", "Alignment Proof is now stored as ChordPro text");

      await s.send("Page.reload");
      await waitSheet("Alignment Proof");
      const afterRows = await s.evaluate<Row[]>(measureExpr);
      for (const row of afterRows) {
        const off = row.at!.find((col) => Math.abs(col - Math.round(col)) > 0.05);
        assert.equal(off, undefined, `chord sits cleanly on integer column (got ${off} in "${row.chords}")`);
        row.at = row.at!.map(Math.round);
      }
      const afterAnchors = chordAnchors(afterRows);
      assert.deepEqual(afterAnchors, beforeAnchors, `chord anchors match before and after text save`);
    } finally {
      await s.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    }
  });

  // Shared band setup for P14 & P15 (one song stored as text, one stored as old JSON in SQLite)
  let p14BandId = "";
  let p14GigId = "";
  let p14SetlistId = "";

  // P14: Band library with one text song and one old-JSON song in SQLite
  await check("P14: band library shows, searches lyrics, opens on sheet, and names in setlist and gig plan for both text and old-JSON rows", async () => {
    const { site: s } = needSite();
    const ui = appUi!;
    const t = terry!;

    p14BandId = (await t.call("/api/bands/create", { name: "P14 Mixed Band" })).body.bandId as string;
    const bandInvite = (await t.call("/api/codes", { kind: "band", bandId: p14BandId })).body.code as string;
    const joined = await s.evaluate<number>(
      `fetch("/api/bands/join", { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js({ code: bandInvite }))} }).then((r) => r.status)`,
    );
    assert.equal(joined, 200, "Sam joins P14 Mixed Band");

    const textSong = madeSong("P14 Text Song", "Lanterns glowing softly tonight", { artist: "Text Artist" });
    const legacySong = madeSong("P14 Legacy Song", "Compass pointing northward always", { artist: "Legacy Artist" });
    const idText = (await t.call("/api/bands/library/share-song", { bandId: p14BandId, song: { chordpro: app.songToChordPro(textSong) }, choice: "public", localId: null }, NEW_SHAPE)).body.songId as string;
    const idLegacy = (await t.call("/api/bands/library/share-song", { bandId: p14BandId, song: { ...legacySong, bassNotes: [] }, choice: "public", localId: null })).body.songId as string;

    // Set legacySong row back to old JSON in SQLite
    const legacyJson = JSON.stringify({ ...legacySong, bassNotes: [] });
    const updated = await withSqlite((files) => {
      let count = 0;
      for (const file of files) {
        const db = new DatabaseSync(file);
        try {
          if (!hasTable(db, "band_songs")) continue;
          count += Number(db.prepare(`UPDATE band_songs SET song = ? WHERE song_id = ?`).run(legacyJson, idLegacy).changes);
        } finally {
          db.close();
        }
      }
      return count;
    });
    assert.equal(updated, 1, "reset P14 Legacy Song row to old JSON in SQLite");

    p14SetlistId = (
      await t.call("/api/bands/library/share-setlist", {
        bandId: p14BandId,
        name: "P14 Mixed Set",
        songIds: [idText, idLegacy],
        tags: [],
        choice: "public",
        localId: null,
      })
    ).body.setlistId as string;
    p14GigId = (
      await t.call("/api/bands/gig/plan", {
        bandId: p14BandId,
        setlistId: p14SetlistId,
        name: "P14 Mixed Gig",
        date: today(),
        lineup: [t.userId, samUserId],
        leader: t.userId,
      })
    ).body.gig.gigId as string;

    await s.evaluate(`window.__calls = []`);
    await s.evaluate(`location.hash = ${js(`#/band/${p14BandId}?s=songs`)}`);
    await ui.until(`document.querySelectorAll(".band-library-songs li").length === 2`, "both band songs shown", 15000);

    // Verify browser asked for chordpro and received { chordpro } for both songs
    const libCall = await s.evaluate<{ headers: Record<string, string>; resBody: { songs: { song: Record<string, unknown> }[] } } | undefined>(
      `window.__calls.find((c) => c.url.includes("/api/bands/library") && c.reqBody?.bandId === ${js(p14BandId)})`,
    );
    assert.equal(libCall?.headers["x-song-shape"], "chordpro", "band library call sent X-Song-Shape: chordpro");
    assert.ok(libCall?.resBody.songs.every((item) => typeof item.song.chordpro === "string"), "Worker answered { chordpro } for both songs");

    // Both show title and artist
    const songsListText = await ui.text(".band-library-songs");
    assert.ok(songsListText.includes("P14 Text Song") && songsListText.includes("Text Artist"), "text song shows title and artist");
    assert.ok(songsListText.includes("P14 Legacy Song") && songsListText.includes("Legacy Artist"), "legacy song shows title and artist");

    // Search for a word of each song's lyrics
    await setInput(`.band-library-tools input`, "P14 Text");
    assert.deepEqual(await ui.texts(".band-library-songs .band-library-name"), ["P14 Text Song"], "title search finds text song");
    await setInput(`.band-library-tools input`, "P14 Legacy");
    assert.deepEqual(await ui.texts(".band-library-songs .band-library-name"), ["P14 Legacy Song"], "title search finds legacy song");
    await setInput(`.band-library-tools input`, "");

    // Verify IndexedDB bandSongs stored { chordpro } as the reply gave it
    await ui.until(
      `(async () => {
        const db = await new Promise((res, rej) => { const r = indexedDB.open("mls-phone", 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const row = await new Promise((res, rej) => { const r = db.transaction("bandSongs", "readonly").objectStore("bandSongs").get(${js(`${p14BandId}/${idText}`)}); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        db.close();
        return typeof row?.song?.chordpro === "string";
      })()`,
      "bandSongs IndexedDB holds { chordpro }",
    );

    // Open each song on the sheet
    for (const [title, lyric] of [
      ["P14 Text Song", "Lanterns glowing softly tonight"],
      ["P14 Legacy Song", "Compass pointing northward always"],
    ] as const) {
      await s.evaluate(`location.hash = ${js(`#/band/${p14BandId}?s=songs`)}`);
      await ui.until(`document.querySelectorAll(".band-library-songs li").length === 2`, "band songs list");
      await s.evaluate(`[...document.querySelectorAll(".band-library-songs .band-library-row")].find((b) => b.textContent.includes(${js(title)})).click()`);
      await ui.until(`document.querySelector(".sheet .sheet-name")?.textContent === ${js(title)}`, `${title} opened on sheet`);
      assert.ok((await ui.text(".sheet .chart")).includes(lyric), `${title} chart renders lyrics`);
    }

    // Named in band setlist
    await s.evaluate(`location.hash = ${js(`#/band/${p14BandId}?s=setlists`)}`);
    await ui.until(`document.querySelector(".band-library-setlists")?.textContent.includes("P14 Mixed Set")`, "band setlist shown");
    const setText = await ui.text(".band-library-setlists");
    assert.ok(setText.includes("P14 Text Song") && setText.includes("P14 Legacy Song"), "both songs named in band setlist");

    // Named on gig view (after pack download)
    await s.evaluate(`location.hash = ${js(`#/gig/${p14BandId}/${p14GigId}`)}`);
    await ui.until(`!!document.querySelector(".gig-set") || [...document.querySelectorAll(".gig-view button")].some((b) => b.textContent.trim() === "Get ready")`, "gig view ready", 15000);
    const getReadyBtn = await s.evaluate<boolean>(`[...document.querySelectorAll(".gig-view button")].some((b) => b.textContent.trim() === "Get ready")`);
    if (getReadyBtn) await ui.click("Get ready", `document.querySelector(".gig-view")`);
    await ui.until(`document.querySelector(".gig-set")?.textContent.includes("P14 Text Song") && document.querySelector(".gig-set")?.textContent.includes("P14 Legacy Song")`, "both songs named on gig plan", 15000);
  });

  // P15: Guest whose pass shows band's setlists sees both titles, never "A song the band took out"
  await check("P15: guest sees every song title for both text and old-JSON band songs and never 'A song the band took out'", async () => {
    const { site: s } = needSite();
    const ui = appUi!;
    const t = terry!;
    const g = gus!;
    assert.ok(p14BandId && p14GigId, "P14 band and gig created");

    const madePass = await t.call("/api/bands/guests/create", {
      bandId: p14BandId,
      gigId: p14GigId,
      passId: `pass_${newId().slice(0, 22)}`,
      name: "Gus on keys",
      expiresAt: Date.now() + DAY_MS,
      canSeeChat: false,
      canSeeSetlists: true,
    });
    assert.equal(madePass.status, 200, `create guest pass (${js(madePass.body)})`);
    assert.equal((await g.call("/api/guest/claim", { code: madePass.body.code })).status, 200, "Gus claims guest pass");

    // Save Sam's cookie so we can restore after P15
    const samCookies = (await s.send("Network.getCookies", { urls: [origin] })).cookies as { name: string; value: string }[];
    const [gCookieName, gCookieVal] = g.cookie.split(/=(.*)/s);
    await s.send("Network.setCookie", { name: gCookieName, value: gCookieVal, url: origin, httpOnly: true, secure: origin.startsWith("https"), sameSite: "Lax" });
    await s.evaluate(`localStorage.setItem("leadSheetsSignedIn", ${js(g.userId)}); window.__calls = [];`);
    try {
      await s.send("Page.navigate", { url: `${origin}/?p15=1#/gig/${p14BandId}/${p14GigId}` });
      await ui.until(`[...document.querySelectorAll(".guest-rooms button")].some((b) => b.textContent.trim() === "Band setlists")`, "guest Band setlists button", 15000);
      await ui.click("Band setlists", `document.querySelector(".guest-rooms")`);
      await ui.until(`document.querySelector(".guest-rooms .gig-set")?.textContent.includes("P14 Mixed Set")`, "guest Band setlists loaded", 15000);

      const guestText = await ui.text(".guest-rooms");
      assert.ok(guestText.includes("P14 Text Song"), "guest sees text song title");
      assert.ok(guestText.includes("P14 Legacy Song"), "guest sees old-JSON song title");
      assert.ok(!guestText.includes("A song the band took out"), `guest never sees missing-song fallback (${guestText})`);

      const guestLibCall = await s.evaluate<{ headers: Record<string, string>; resBody: { songs: { song: Record<string, unknown> }[] } } | undefined>(
        `window.__calls.find((c) => c.url.includes("/api/bands/library") && c.reqBody?.bandId === ${js(p14BandId)})`,
      );
      assert.equal(guestLibCall?.headers["x-song-shape"], "chordpro", "guest library call sent X-Song-Shape: chordpro");
      assert.ok(guestLibCall?.resBody.songs.every((item) => typeof item.song.chordpro === "string"), "guest library call received { chordpro }");
    } finally {
      for (const c of samCookies) {
        await s.send("Network.setCookie", { name: c.name, value: c.value, url: origin, httpOnly: true, secure: origin.startsWith("https"), sameSite: "Lax" });
      }
      await s.evaluate(`localStorage.setItem("leadSheetsSignedIn", ${js(samUserId)})`);
      await s.send("Page.navigate", { url: `${origin}/?p15done=1#/songs` });
      await ui.library();
    }
  });

  // P16: Scanner taps Add to My Songs on a setlist card (both text and old-JSON SQLite rows) + duplicate prompt
  await check("P16: scanner adds setlist copy code (text and old-JSON rows) stored as text with copy marks, and sees duplicate prompt when already held", async () => {
    const { site: s } = needSite();
    const ui = appUi!;
    const t = terry!;

    const alpha = madeSong("Copy Tune Alpha", "Alpha copied lyrics");
    const beta = madeSong("Copy Tune Beta", "Beta copied lyrics");
    const gamma = madeSong("Copy Tune Gamma", "Gamma legacy copied lyrics");

    const codeText = (
      await t.call(
        "/api/codes",
        {
          kind: "my-setlist",
          choice: "private",
          name: "P16 Text Set",
          songs: [
            { song: { chordpro: app.songToChordPro(alpha) }, copyId: null },
            { song: { chordpro: app.songToChordPro(beta) }, copyId: null },
          ],
          setlistCopyId: null,
        },
        NEW_SHAPE,
      )
    ).body.code as string;

    const codeLegacy = (
      await t.call("/api/codes", {
        kind: "my-setlist",
        choice: "public",
        name: "P16 Legacy Set",
        songs: [{ song: { ...gamma, bassNotes: [] }, copyId: null }],
        setlistCopyId: null,
      })
    ).body.code as string;

    // Rewrite P16 Legacy Set row in setlist_sends back to old JSON
    const rewritten = await withSqlite((files) => {
      let count = 0;
      for (const file of files) {
        const db = new DatabaseSync(file);
        try {
          if (!hasTable(db, "setlist_sends")) continue;
          const row = db.prepare(`SELECT share_id, songs FROM setlist_sends WHERE name = ?`).get("P16 Legacy Set") as { share_id: string; songs: string } | undefined;
          if (!row) continue;
          const parsed = JSON.parse(row.songs) as { print: string; shareId: string }[];
          const oldRows = parsed.map((item) => ({ song: { ...gamma, bassNotes: [] }, print: item.print, shareId: item.shareId }));
          count += Number(db.prepare(`UPDATE setlist_sends SET songs = ? WHERE share_id = ?`).run(JSON.stringify(oldRows), row.share_id).changes);
        } finally {
          db.close();
        }
      }
      return count;
    });
    assert.equal(rewritten, 1, "rewrote P16 Legacy Set in setlist_sends to old JSON");

    // Duplicate setlist code holding a song with the same title & artist as Copy Tune Alpha
    const codeDup = (
      await t.call(
        "/api/codes",
        {
          kind: "my-setlist",
          choice: "public",
          name: "P16 Dup Set",
          songs: [{ song: { chordpro: app.songToChordPro(alpha) }, copyId: null }],
          setlistCopyId: null,
        },
        NEW_SHAPE,
      )
    ).body.code as string;

    // Sam scans all three codes via /api/chat/setlist-code
    let dmRoomId = "";
    for (const code of [codeText, codeLegacy, codeDup]) {
      const scanRes = await s.evaluate<{ status: number; body: { roomId?: string } }>(
        `fetch("/api/chat/setlist-code", { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js({ code }))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`,
      );
      assert.equal(scanRes.status, 200, `scan code succeeded (${js(scanRes.body)})`);
      dmRoomId = scanRes.body.roomId!;
    }

    await s.evaluate(`location.hash = ${js(`#/messages/${dmRoomId}`)}`);
    await ui.until(
      `document.querySelector(".room")?.textContent.includes("P16 Text Set") && document.querySelector(".room")?.textContent.includes("P16 Legacy Set") && document.querySelector(".room")?.textContent.includes("P16 Dup Set")`,
      "all three setlist cards in DM",
      15000,
    );

    const clickCardBtn = async (setName: string, btnLabel: string) => {
      const ok = await s.evaluate<boolean>(`(() => {
        const card = [...document.querySelectorAll(".setlist-card")].find((el) => el.textContent.includes(${js(setName)}));
        const btn = [...(card?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === ${js(btnLabel)} && !b.disabled);
        btn?.click();
        return !!btn;
      })()`);
      assert.ok(ok, `clicked ${btnLabel} on ${setName}`);
    };

    // Add text setlist copy
    await clickCardBtn("P16 Text Set", "Add to My Songs");
    await ui.until(
      `[...document.querySelectorAll(".setlist-card")].find((el) => el.textContent.includes("P16 Text Set"))?.textContent.includes("In your Setlists")`,
      "P16 Text Set added",
      15000,
    );

    // Add legacy setlist copy
    await clickCardBtn("P16 Legacy Set", "Add to My Songs");
    await ui.until(
      `[...document.querySelectorAll(".setlist-card")].find((el) => el.textContent.includes("P16 Legacy Set"))?.textContent.includes("In your Setlists")`,
      "P16 Legacy Set added",
      15000,
    );

    const v2 = JSON.parse((await s.evaluate<string>(`localStorage.getItem("leadSheetsLibraryV2")`)) ?? "{}") as {
      songs: { id: number; chordpro?: string; copy?: { id: string; canSendOn: boolean; from?: { name: string } }; title?: string }[];
      setlists: { id: number; name: string; songIds: number[]; copy?: { id: string } }[];
    };
    const rowAlpha = v2.songs.find((item) => typeof item.chordpro === "string" && item.chordpro.includes("{title: Copy Tune Alpha}"));
    const rowBeta = v2.songs.find((item) => typeof item.chordpro === "string" && item.chordpro.includes("{title: Copy Tune Beta}"));
    const rowGamma = v2.songs.find((item) => typeof item.chordpro === "string" && item.chordpro.includes("{title: Copy Tune Gamma}"));
    assert.ok(rowAlpha && rowAlpha.title === undefined && rowAlpha.copy?.canSendOn === false && rowAlpha.copy?.from?.name === "Terry Bass", "Alpha stored as text with Private copy mark");
    assert.ok(rowBeta && rowBeta.title === undefined && rowBeta.copy?.canSendOn === false, "Beta stored as text with Private copy mark");
    assert.ok(rowGamma && rowGamma.title === undefined && rowGamma.copy?.canSendOn === true, "Gamma (from old-JSON row) stored as text with Public copy mark");
    const setText = v2.setlists.find((item) => item.name === "P16 Text Set");
    const setLegacy = v2.setlists.find((item) => item.name === "P16 Legacy Set");
    assert.deepEqual(setText?.songIds, [rowAlpha.id, rowBeta.id], "P16 Text Set holds Alpha and Beta");
    assert.deepEqual(setLegacy?.songIds, [rowGamma.id], "P16 Legacy Set holds Gamma");

    // Duplicate prompt on P16 Dup Set (already have Copy Tune Alpha)
    await clickCardBtn("P16 Dup Set", "Add to My Songs");
    await ui.until(
      `[...document.querySelectorAll(".setlist-card")].find((el) => el.textContent.includes("P16 Dup Set"))?.textContent.includes("You already have")`,
      "You already have prompt shown for duplicate song",
      15000,
    );
    await clickCardBtn("P16 Dup Set", "Add anyway");
    await ui.until(
      `[...document.querySelectorAll(".setlist-card")].find((el) => el.textContent.includes("P16 Dup Set"))?.textContent.includes("In your Setlists")`,
      "P16 Dup Set added after Add anyway",
      15000,
    );
  });

  // P18 (Added by CoS): CRLF, lone CR, and leading BOM at every kind of door read as the same song as plain LF
  await check("P18: CRLF, lone CR, and leading BOM from reply, phone store, and card doors read as the exact same song as plain LF", async () => {
    const river = madeSong("River Crossing", "Crossing the river before dusk", {
      keyRoot: "G",
      keyLabel: "G major",
      tempo: 104,
      body: [
        { heading: "INTRO", lines: [{ bars: "| G | C | D | G |", note: "Let it ring." }] },
        { heading: "VERSE 1", lines: [{ chords: "G        C", lyrics: "Crossing the river before dusk" }] },
      ],
    });
    const plain = app.songToChordPro(river);
    const expected = app.chordProToSong(plain);
    const variants: [string, string][] = [
      ["CRLF", plain.replaceAll("\n", "\r\n")],
      ["lone CR", plain.replaceAll("\n", "\r")],
      ["BOM", `\uFEFF${plain}`],
      ["BOM + CRLF", `\uFEFF${plain.replaceAll("\n", "\r\n")}`],
    ];

    // 1. Reply/store door function: songFromSent
    assert.equal(typeof app.songFromSent, "function", "src/band-library-model.ts exports songFromSent");
    for (const [label, text] of variants) {
      const got = app.songFromSent!({ chordpro: text });
      assert.deepEqual(got, expected, `songFromSent(${label}) equals plain LF song`);
      assert.equal(got.title, "River Crossing", `songFromSent(${label}) is never an empty song`);
    }

    // 2. Card door: songMessageIn
    for (const [label, text] of variants) {
      const card = JSON.stringify({
        song: { chordpro: text },
        versions: [],
        data: null,
        shareId: "share_p18",
        updateOf: null,
        sharedAs: "public",
        reshareable: true,
      });
      const parsed = app.songMessageIn(card);
      assert.ok(parsed, `songMessageIn(${label}) returns SongMessage`);
      assert.deepEqual(parsed.song, expected, `songMessageIn(${label}) equals plain LF song`);
    }

    // 3. Phone store doors in browser (IndexedDB bandSongs & gigPacks with BOM + CRLF)
    const { site: s } = needSite();
    const ui = appUi!;
    const bomCrlf = `\uFEFF${plain.replaceAll("\n", "\r\n")}`;
    await s.evaluate(`(async () => {
      localStorage.setItem("leadSheetsPhoneOwner", ${js(samUserId)});
      const db = await new Promise((res, rej) => { const r = indexedDB.open("mls-phone", 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      await new Promise((res, rej) => {
        const tx = db.transaction(["bandSongs", "gigPacks"], "readwrite");
        tx.objectStore("bandSongs").put({ bandId: "band_p18", bandName: "P18 Band", songId: "s_bom", song: { chordpro: ${js(bomCrlf)} }, sharedAs: "public", updatedAt: 1 }, "band_p18/s_bom");
        tx.objectStore("gigPacks").put({
          gig: { gigId: "gig_p18", bandId: "band_p18", setlistId: "set_p18", name: "P18 Gig", date: ${js(today())}, startTime: null, callTime: null, venue: "", address: "", notes: "", songOrder: ["s_bom"], lineup: [${js(samUserId)}], leader: ${js(samUserId)}, backup: null, route: "auto", status: "planned", startedAt: null, endedAt: null },
          songs: [{ songId: "s_bom", song: { chordpro: ${js(bomCrlf)} }, bandTiming: null }],
          scrollWithLeader: false,
          secret: "sec_p18",
          packRev: 1,
          expiresAt: null,
        }, "gig_p18");
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    })()`);

    for (const hash of ["#/band/band_p18/song/s_bom", "#/gig/band_p18/gig_p18/0"]) {
      await s.evaluate(`location.hash = ${js(hash)}`);
      await ui.until(`document.querySelector(".sheet .sheet-name")?.textContent === "River Crossing"`, `BOM+CRLF sheet at ${hash}`);
      assert.ok((await ui.text(".sheet .chart")).includes("Crossing the river before dusk"), `BOM+CRLF chart rendered at ${hash}`);
    }
  });
} finally {
  if (site) await site.close();
  if (api) await api.worker.dispose();
  rmSync(oldTree, { recursive: true, force: true, maxRetries: 10 });
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 10 });
}

if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
