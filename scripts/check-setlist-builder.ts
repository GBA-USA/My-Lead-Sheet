import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { newSalt, passwordKey } from "../src/password.ts";
import type { ChordProStoredSong } from "../src/storage.ts";
import type { Library, LibraryFile, Song, SongRef } from "../src/types.ts";
import { Phone, TEST_ORIGIN, startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, settle } from "./app-page.ts";
import { openSite, type Site } from "./chrome.ts";

/**
 * Setlist builder (Plan 6, cook 2): cases B1 to B19 at 360 px wide, real touch events,
 * real storage path, and real Worker for Show code, two-phone backup, and per-account isolation.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const shotsDir = process.env.SETLIST_BUILDER_SHOTS;
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

type StorageBackupMod = typeof import("../src/storage.ts") & typeof import("../src/backup.ts");

async function loadStorageBackup(): Promise<StorageBackupMod> {
  const bundle = await build({
    stdin: {
      contents: `export * from "./src/storage.ts"; export * from "./src/backup.ts";`,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}#${Math.random()}`);
}

const appMod = await loadStorageBackup();
const seedFile = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as LibraryFile;

class FakeStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

function readLibraryFromRaw(raw: string | null): Library {
  const store = new FakeStorage();
  if (raw !== null) store.setItem("leadSheetsLibraryV2", raw);
  const prev = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });
  try {
    return appMod.loadLibrary();
  } finally {
    if (prev) Object.defineProperty(globalThis, "localStorage", prev);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

const makeSong = (id: number, overrides: Partial<Omit<Song, "ref">> = {}): Omit<Song, "ref"> => ({
  id,
  title: "Cedar Creek",
  artist: "Maple Trio",
  keyLabel: "A major",
  keyRoot: "A",
  keyMode: "major",
  keyNote: "",
  tempo: 96,
  tempoNote: "",
  timeSignature: "4/4",
  officialRuntimeSec: 195,
  feel: "",
  sourceNote: "",
  atAGlance: "",
  howToPlay: "",
  practiceTip: "",
  body: [{ heading: "Verse 1", lines: [{ chords: "A       D", lyrics: "Down by the cedar creek tonight" }] }],
  ...overrides,
});

const MADE_SONGS: Omit<Song, "ref">[] = [
  makeSong(801, { title: "Lantern Road", artist: "Cedar Hollow", keyLabel: "G major", keyRoot: "G", keyMode: "major", tempo: 92 }),
  makeSong(802, { title: "Copper Kettle", artist: "Birch Creek", keyLabel: "D major", keyRoot: "D", keyMode: "major", tempo: 108 }),
  makeSong(803, { title: "Evening Ferry", artist: "Harbor Pines", keyLabel: "E minor", keyRoot: "E", keyMode: "minor", tempo: 84 }),
  makeSong(804, { title: "Windmill Waltz", artist: "Prairie Band", keyLabel: "C major", keyRoot: "C", keyMode: "major", tempo: 118 }),
  makeSong(805, { title: "Rain on Tin", artist: "Porch Trio", keyLabel: "A minor", keyRoot: "A", keyMode: "minor", tempo: 76 }),
  makeSong(806, { title: "Morning Freight", artist: "Railroad Four", keyLabel: "F major", keyRoot: "F", keyMode: "major", tempo: 132 }),
  makeSong(807, { title: "Timberline", artist: "North Ridge", keyLabel: "Bb major", keyRoot: "Bb", keyMode: "major", tempo: 98 }),
  makeSong(808, { title: "Canyon Echo", artist: "Red Rock Duo", keyLabel: "A major", keyRoot: "A", keyMode: "major", tempo: 104 }),
  makeSong(809, { title: "Silver Birch", artist: "Lake Trio", keyLabel: "G minor", keyRoot: "G", keyMode: "minor", tempo: 88 }),
  makeSong(810, { title: "Same Horizon", artist: "Twin Rivers", keyLabel: "C major", keyRoot: "C", keyMode: "major", tempo: 100 }),
  makeSong(811, { title: "Same Horizon", artist: "Twin Rivers", keyLabel: "C major", keyRoot: "C", keyMode: "major", tempo: 100 }),
];

const STORED_MADE_SONGS: ChordProStoredSong[] = MADE_SONGS.map((song) => appMod.songToStored(song));

// ---------------------------------------------------------------------------------------------- B19 (pure model, 500 histories)

type BuilderModel = {
  named: (raw: string) => { ok: true; name: string } | { ok: false; reason: string };
  moved: (refs: readonly SongRef[], from: number, to: number) => SongRef[];
  added: (refs: readonly SongRef[], picked: readonly SongRef[]) => SongRef[];
  removedAt: (refs: readonly SongRef[], index: number) => SongRef[];
};

{
  const modelPath = join(root, "src", "setlist-builder-model.ts");
  if (!existsSync(modelPath)) {
    failed += 1;
    console.log("FAIL B19: src/setlist-builder-model.ts is not there yet");
  } else {
    let model: BuilderModel | null = null;
    try {
      const bundle = await build({
        entryPoints: [modelPath],
        bundle: true,
        write: false,
        format: "esm",
        platform: "neutral",
        logLevel: "silent",
      });
      model = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL B19 the model, 500 histories: failed to load model (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
    }

    if (model) {
      const m = model;
      await check("B19 the model, 500 histories", () => {
        assert.equal(typeof m.named, "function", "named is exported");
        assert.equal(typeof m.moved, "function", "moved is exported");
        assert.equal(typeof m.added, "function", "added is exported");
        assert.equal(typeof m.removedAt, "function", "removedAt is exported");

        // Oracle written straight from the brief
        const oracleNamed = (raw: string): { ok: true; name: string } | { ok: false } => {
          const trimmed = raw.trim();
          return trimmed.length >= 1 && trimmed.length <= 60 ? { ok: true, name: trimmed } : { ok: false };
        };
        const oracleMoved = (refs: SongRef[], from: number, to: number): SongRef[] => {
          if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= refs.length || to < 0 || to >= refs.length || from === to) {
            return [...refs];
          }
          const copy = [...refs];
          const [picked] = copy.splice(from, 1);
          copy.splice(to, 0, picked);
          return copy;
        };
        const oracleAdded = (refs: SongRef[], picked: SongRef[]): SongRef[] => {
          const copy = [...refs];
          for (const ref of picked) {
            if (!copy.includes(ref)) copy.push(ref);
          }
          return copy;
        };
        const oracleRemovedAt = (refs: SongRef[], index: number): SongRef[] => {
          if (!Number.isInteger(index) || index < 0 || index >= refs.length) return [...refs];
          return refs.filter((_, i) => i !== index);
        };

        // Explicit boundary cases for named
        const exact60 = "A".repeat(60);
        const over61 = "A".repeat(61);
        assert.equal(m.named("").ok, false, "empty name refused");
        assert.equal(m.named("   \t\n ").ok, false, "whitespace-only name refused");
        assert.deepEqual(m.named("  O'Malley's “Set”  "), { ok: true, name: "O'Malley's “Set”" }, "apostrophes and curly quotes preserved and trimmed");
        assert.deepEqual(m.named(exact60), { ok: true, name: exact60 }, "60-char name accepted");
        assert.equal(m.named(over61).ok, false, "61-char name refused");
        assert.deepEqual(m.named(`  ${exact60}  `), { ok: true, name: exact60 }, "60-char name after trim accepted");

        // Explicit duplicate-song removeAt check
        assert.deepEqual(m.removedAt(["local/1", "local/2", "local/1"], 2), ["local/1", "local/2"], "removedAt removes only the chosen slot");
        assert.deepEqual(m.removedAt(["local/1", "local/2", "local/1"], 0), ["local/2", "local/1"], "removedAt removes only the first slot");

        const pool: SongRef[] = Array.from({ length: 12 }, (_, i) => `local/${i + 1}` as SongRef);
        const nameSamples = [
          "",
          "   ",
          "O'Reilly's Gig",
          "“Acoustic” Night",
          "  Porch Session  ",
          exact60,
          over61,
          "Set 1",
          "A",
          "   " + "B".repeat(61) + "   ",
        ];

        const makeRng = (seed: number) => {
          let state = seed >>> 0;
          return () => {
            state = (state + 0x6d2b79f5) >>> 0;
            let t = Math.imul(state ^ (state >>> 15), 1 | state);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
          };
        };

        for (let seed = 1; seed <= 500; seed += 1) {
          const rand = makeRng(seed);
          const pickInt = (n: number) => Math.floor(rand() * n);
          // Seed initial list, sometimes with duplicate refs (like B15)
          const initLen = pickInt(6);
          let oracle: SongRef[] = Array.from({ length: initLen }, () => pool[pickInt(5)]);
          let actual: SongRef[] = [...oracle];

          for (let step = 1; step <= 25; step += 1) {
            const op = pickInt(4);
            if (op === 0) {
              const from = actual.length > 0 ? pickInt(actual.length) : 0;
              const to = actual.length > 0 ? pickInt(actual.length) : 0;
              const beforeSorted = [...actual].sort();
              const nextActual = m.moved(actual, from, to);
              const nextOracle = oracleMoved(oracle, from, to);
              assert.deepEqual(nextActual, nextOracle, `seed=${seed} step=${step} moved(${from},${to}) mismatch`);
              assert.deepEqual([...nextActual].sort(), beforeSorted, `seed=${seed} step=${step} moved lost or doubled an entry`);
              actual = nextActual;
              oracle = nextOracle;
            } else if (op === 1) {
              const count = pickInt(5);
              const picked: SongRef[] = Array.from({ length: count }, () => pool[pickInt(pool.length)]);
              const beforeSet = new Set(actual);
              const beforeLen = actual.length;
              const nextActual = m.added(actual, picked);
              const nextOracle = oracleAdded(oracle, picked);
              assert.deepEqual(nextActual, nextOracle, `seed=${seed} step=${step} added mismatch`);
              for (const addedRef of nextActual.slice(beforeLen)) {
                assert.ok(!beforeSet.has(addedRef), `seed=${seed} step=${step} added duplicated existing ref ${addedRef}`);
              }
              actual = nextActual;
              oracle = nextOracle;
            } else if (op === 2) {
              const index = actual.length > 0 ? pickInt(actual.length) : 0;
              const beforeLen = actual.length;
              const nextActual = m.removedAt(actual, index);
              const nextOracle = oracleRemovedAt(oracle, index);
              assert.deepEqual(nextActual, nextOracle, `seed=${seed} step=${step} removedAt(${index}) mismatch`);
              if (beforeLen > 0) {
                assert.equal(nextActual.length, beforeLen - 1, `seed=${seed} step=${step} removedAt must take exactly one row`);
              }
              actual = nextActual;
              oracle = nextOracle;
            } else {
              const sample = nameSamples[pickInt(nameSamples.length)];
              const resActual = m.named(sample);
              const resOracle = oracleNamed(sample);
              assert.equal(resActual.ok, resOracle.ok, `seed=${seed} step=${step} named(${js(sample)}) ok mismatch`);
              if (resActual.ok && resOracle.ok) {
                assert.equal(resActual.name, resOracle.name, `seed=${seed} step=${step} named(${js(sample)}) value mismatch`);
              }
            }
          }
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------- Browser + Worker cases (B1 to B18)

const BROWSER_CASES = [
  "B1 new setlist",
  "B2 open and close",
  "B3 hold and drag",
  "B4 a swipe is not a drag",
  "B5 keyboard and cancel",
  "B6 add from My Songs",
  "B7 same title, two songs",
  "B8 take a song off",
  "B9 Show code moved",
  "B10 rename",
  "B11 delete",
  "B12 a delete stays deleted",
  "B13 signed out, and a shared phone",
  "B14 fits, and a full phone",
  "B15 one song twice",
  "B16 delete, then a new one",
  "B17 a built-in setlist changed",
  "B18 one write per drop",
  "B20 closing mid-rename keeps the stored name",
  "B21 closing the picker adds nothing",
  "B22 a song missing from the library",
  "B23 Show code keeps focus out of the screen behind",
  "B24 no setlists yet",
  "B25 a song that arrives while ticked is added once",
  "B26 a long drag scrolls the list",
  "B27 a press inside let go on the backdrop keeps the builder open",
  "B28 a sync in the middle of a drag moves nothing",
  "B29 a list filled by a sync can be dragged",
  "B30 a rename from another phone keeps a name being typed",
  "B31 every refused write shows the words and what is stored",
  "B32 a friend's private copy keeps its copy mark when reordered and renamed",
] as const;

let apiBase = "";
let site: Site | null = null;
let worker: Awaited<ReturnType<typeof startApi>>["worker"] | null = null;

try {
  site = await openSite(root, "check-setlist-builder", () => apiBase);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  const started = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
  worker = started.worker;
  apiBase = started.base;
} catch (error) {
  for (const name of BROWSER_CASES) {
    failed += 1;
    console.log(`FAIL ${name}: app or Worker did not start (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
  }
  await site?.close();
  await worker?.dispose();
  process.exit(1);
}

try {
  const s = site;
  const origin = s.origin.replace("127.0.0.1", "localhost");
  const app = await appPage(s);
  await s.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

  const WIDTH = 360;
  const HEIGHT = 780;
  const phone360 = async () => {
    await s.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true });
    await s.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`);
  };
  await phone360();

  const shoot = async (name: string) => {
    if (!shotsDir) return;
    mkdirSync(shotsDir, { recursive: true });
    await app.shot(join(shotsDir, `${name}.png`));
  };

  const readStoredLibrary = async (): Promise<Library> => {
    const raw = await s.evaluate<string | null>(`localStorage.getItem("leadSheetsLibraryV2")`);
    return readLibraryFromRaw(raw);
  };

  const goSetlists = async () => {
    await s.evaluate(`location.hash = "#/setlists"`);
    await app.until(`location.hash === "#/setlists" && document.querySelectorAll("section.setlist").length > 0`, "Setlists screen");
    await settle(100);
  };

  const reloadSetlists = async () => {
    await s.evaluate(`location.hash = "#/setlists"`);
    await s.send("Page.reload");
    await app.library();
    await phone360();
    await app.until(`location.hash === "#/setlists" && document.querySelectorAll("section.setlist").length > 0`, "Setlists screen after reload");
    await settle(150);
  };

  const seedOwnData = async (extraSetlists: { id: number; name: string; songIds: number[]; copy?: { id: string; canSendOn: boolean; from?: { name: string } } }[]) => {
    await s.evaluate(`(() => {
      const lib = JSON.parse(localStorage.getItem("leadSheetsLibraryV2") || "{}");
      const songIds = new Set(${js(STORED_MADE_SONGS.map((song) => song.id))});
      const setIds = new Set(${js(extraSetlists.map((set) => set.id))});
      lib.songs = [...(lib.songs || []).filter((each) => !songIds.has(each.id)), ...${js(STORED_MADE_SONGS)}];
      lib.setlists = [...(lib.setlists || []).filter((each) => !setIds.has(each.id)), ...${js(extraSetlists)}];
      lib.lastSongId = Math.max(lib.lastSongId || 0, 811);
      localStorage.setItem("leadSheetsLibraryV2", JSON.stringify(lib));
    })()`);
  };

  const openNewBuilder = async () => {
    await goSetlists();
    const clicked = await s.evaluate<boolean>(`(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "+ New setlist");
      btn?.click();
      return !!btn;
    })()`);
    assert.ok(clicked, "no + New setlist button on Setlists screen");
    await app.until(`!!document.querySelector("[role=dialog]")`, "New setlist dialog");
  };

  const openBuilderFor = async (name: string) => {
    await goSetlists();
    const clicked = await s.evaluate<boolean>(`(() => {
      const sec = [...document.querySelectorAll("section.setlist")].find((el) => el.getAttribute("aria-label") === ${js(name)});
      const btn = sec?.querySelector(".setlist-head button");
      if (!btn || btn.textContent.trim() !== ${js(name)}) return false;
      btn.click();
      return true;
    })()`);
    assert.ok(clicked, `setlist name ${js(name)} is not a tappable button`);
    await app.until(`!!document.querySelector(".setlist-builder[role=dialog]")`, `builder dialog for ${name}`);
    await settle(100);
  };

  const closeBuilder = async () => {
    await s.evaluate(`document.querySelector('.setlist-builder [aria-label="Close"]')?.click()`);
    await app.until(`!document.querySelector(".setlist-builder[role=dialog]")`, "builder closes");
    await settle(100);
  };

  const builderTitles = () =>
    s.evaluate<string[]>(`[...document.querySelectorAll(".setlist-builder [data-builder-row] .song-title")].map((el) => el.textContent.trim())`);

  const setlistScreenTitles = (name: string) =>
    s.evaluate<string[]>(`(() => {
      const sec = [...document.querySelectorAll("section.setlist")].find((el) => el.getAttribute("aria-label") === ${js(name)});
      return [...(sec?.querySelectorAll(".song-title") ?? [])].map((el) => el.textContent.trim());
    })()`);

  const setInputValue = async (selector: string, value: string) => {
    await s.evaluate(`(() => {
      const el = document.querySelector(${js(selector)});
      if (!el) throw new Error("missing input " + ${js(selector)});
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${js(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await settle(50);
  };

  const rowCenter = async (index: number) => {
    const box = await s.evaluate<{ x: number; y: number; top: number; bottom: number; height: number } | null>(`(() => {
      const rows = [...document.querySelectorAll(".setlist-builder [data-builder-row]")];
      const el = rows[${index}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width * 0.4, y: r.top + r.height / 2, top: r.top, bottom: r.bottom, height: r.height };
    })()`);
    assert.ok(box, `builder row ${index} exists`);
    return box;
  };

  const touchStart = (x: number, y: number) =>
    s.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 10, radiusY: 10, force: 1 }],
    });
  const touchMove = (x: number, y: number) =>
    s.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 10, radiusY: 10, force: 1 }],
    });
  const touchEnd = () => s.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  const holdAndDrag = async (fromIndex: number, targetY: number, options: { holdMs?: number; shotWhileDragging?: string; cancelWithEscape?: boolean } = {}) => {
    const start = await rowCenter(fromIndex);
    await touchStart(start.x, start.y);
    await sleep(options.holdMs ?? 600);
    const steps = 10;
    for (let step = 1; step <= steps; step += 1) {
      const y = start.y + ((targetY - start.y) * step) / steps;
      await touchMove(start.x, y);
      await sleep(20);
    }
    if (options.shotWhileDragging) await shoot(options.shotWhileDragging);
    if (options.cancelWithEscape) {
      await s.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      await settle(120);
    }
    await touchEnd();
    await settle(150);
  };

  // Navigate to app and seed our test songs + setlists (signed out initially)
  await s.send("Page.navigate", { url: `${origin}/#/songs` });
  await app.library();
  await seedOwnData([
    { id: 901, name: "Drag Trio", songIds: [801, 802, 803] },
    { id: 902, name: "Long Swipe Set", songIds: [801, 802, 803, 804, 805, 806, 807, 808, 809] },
    { id: 903, name: "Twin Check", songIds: [810] },
    { id: 904, name: "Remove One", songIds: [801, 802, 803] },
    { id: 905, name: "Double Up", songIds: [801, 802, 801] },
    { id: 906, name: "Empty Private", songIds: [] },
    { id: 907, name: "Private Copy Set", songIds: [801, 802], copy: { id: "copy-priv-907", canSendOn: false, from: { name: "Dana" } } },
  ]);
  await reloadSetlists();

  // ---------------------------------------------------------------------------------------------- B1 new setlist
  await check("B1 new setlist", async () => {
    await openNewBuilder();
    // Name box should be focused
    const focused = await s.evaluate<boolean>(`document.activeElement?.matches('.setlist-builder input[aria-label="Setlist name"]')`);
    assert.equal(focused, true, "name input is focused when + New setlist opens");

    const beforeCount = (await readStoredLibrary()).setlists.length;

    // Empty name refused
    await setInputValue('.setlist-builder input[aria-label="Setlist name"]', "");
    await app.click("Save", `document.querySelector(".setlist-builder")`);
    const emptyAlert = await app.text(".setlist-builder [role=alert]");
    assert.ok(emptyAlert.trim().length > 0, `empty name shows words (${js(emptyAlert)})`);
    assert.equal((await readStoredLibrary()).setlists.length, beforeCount, "empty name creates nothing");

    // Spaces-only name refused
    await setInputValue('.setlist-builder input[aria-label="Setlist name"]', "    ");
    await app.click("Save", `document.querySelector(".setlist-builder")`);
    const spaceAlert = await app.text(".setlist-builder [role=alert]");
    assert.ok(spaceAlert.trim().length > 0, `spaces-only name shows words (${js(spaceAlert)})`);
    assert.equal((await readStoredLibrary()).setlists.length, beforeCount, "spaces-only name creates nothing");

    // 61st character cannot be saved
    const sixtyOne = "X".repeat(61);
    await s.evaluate(`(() => {
      const el = document.querySelector('.setlist-builder input[aria-label="Setlist name"]');
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await s.send("Input.insertText", { text: sixtyOne });
    await settle(50);
    const typedLen = await s.evaluate<number>(`document.querySelector('.setlist-builder input[aria-label="Setlist name"]').value.length`);
    assert.ok(typedLen <= 60, `input caps at 60 characters (got ${typedLen})`);

    // Name with apostrophe creates setlist, stays open on it, survives reload
    const apostropheName = "O'Malley's Porch";
    await setInputValue('.setlist-builder input[aria-label="Setlist name"]', apostropheName);
    await app.click("Save", `document.querySelector(".setlist-builder")`);
    await app.until(`document.querySelector(".setlist-builder h2")?.textContent?.trim() === ${js(apostropheName)}`, "builder stays open on new setlist");
    const listedNow = await s.evaluate<boolean>(`!!document.querySelector(${js(`section.setlist[aria-label="${apostropheName}"]`)})`);
    assert.equal(listedNow, true, "new setlist appears in Setlists list");
    await closeBuilder();

    await reloadSetlists();
    const afterLib = await readStoredLibrary();
    assert.ok(afterLib.setlists.some((set) => set.name === apostropheName), "apostrophe name comes back identical via reader after reload");
    const onScreen = await s.evaluate<boolean>(`!!document.querySelector(${js(`section.setlist[aria-label="${apostropheName}"]`)})`);
    assert.equal(onScreen, true, "apostrophe name comes back on screen after reload");
  });

  // ---------------------------------------------------------------------------------------------- B2 open and close
  await check("B2 open and close", async () => {
    await openBuilderFor("Drag Trio");
    const heading = await s.evaluate<string>(`(() => {
      const dlg = document.querySelector(".setlist-builder[role=dialog]");
      const id = dlg?.getAttribute("aria-labelledby");
      return (id ? document.getElementById(id)?.textContent : dlg?.querySelector("h2")?.textContent)?.trim() ?? "";
    })()`);
    assert.equal(heading, "Drag Trio", "dialog is titled with the tapped setlist's name");

    // Escape closes it and restores focus to the setlist name button
    await s.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await app.until(`!document.querySelector(".setlist-builder[role=dialog]")`, "Escape closes builder");
    await settle(80);
    const focusAfterEsc = await s.evaluate<string>(`document.activeElement?.textContent?.trim() ?? ""`);
    assert.equal(focusAfterEsc, "Drag Trio", `focus returned to tapped name after Escape (got ${js(focusAfterEsc)})`);

    // Reopen and close with Close button; focus returns again
    await openBuilderFor("Drag Trio");
    await closeBuilder();
    await settle(80);
    const focusAfterClose = await s.evaluate<string>(`document.activeElement?.textContent?.trim() ?? ""`);
    assert.equal(focusAfterClose, "Drag Trio", `focus returned to tapped name after Close (got ${js(focusAfterClose)})`);
  });

  // ---------------------------------------------------------------------------------------------- B3 hold and drag
  await check("B3 hold and drag", async () => {
    await openBuilderFor("Drag Trio");
    assert.deepEqual(await builderTitles(), ["Lantern Road", "Copper Kettle", "Evening Ferry"]);
    const first = await rowCenter(0);
    await holdAndDrag(2, first.top - 10, { holdMs: 600, shotWhileDragging: "drag-in-progress" });
    assert.deepEqual(await builderTitles(), ["Evening Ferry", "Lantern Road", "Copper Kettle"], "third song is now first in builder");
    await closeBuilder();
    assert.deepEqual(await setlistScreenTitles("Drag Trio"), ["Evening Ferry", "Lantern Road", "Copper Kettle"], "Setlists screen shows new order");

    await reloadSetlists();
    assert.deepEqual(await setlistScreenTitles("Drag Trio"), ["Evening Ferry", "Lantern Road", "Copper Kettle"], "new order holds on Setlists screen after reload");
    const lib = await readStoredLibrary();
    const set = lib.setlists.find((entry) => entry.name === "Drag Trio");
    assert.deepEqual(set?.songRefs, ["local/803", "local/801", "local/802"], "new order holds through the real reader");
  });

  // ---------------------------------------------------------------------------------------------- B4 a swipe is not a drag
  await check("B4 a swipe is not a drag", async () => {
    await openBuilderFor("Long Swipe Set");
    const initialOrder = await builderTitles();
    assert.equal(initialOrder.length, 9, "nine songs in Long Swipe Set");

    const scrollable = await s.evaluate<{ sh: number; ch: number }>(`(() => {
      const list = document.querySelector(".setlist-builder-list");
      return { sh: list?.scrollHeight ?? 0, ch: list?.clientHeight ?? 0 };
    })()`);
    assert.ok(scrollable.sh > scrollable.ch, `builder list can scroll (${js(scrollable)})`);

    // 1. Quick upward swipe over a row scrolls the list and leaves order unchanged
    const row = await rowCenter(2);
    await touchStart(row.x, row.y);
    for (let step = 1; step <= 8; step += 1) {
      await touchMove(row.x, row.y - step * 22);
      await sleep(14);
    }
    await touchEnd();
    await settle(250);
    const scrollTop = await s.evaluate<number>(`document.querySelector(".setlist-builder-list")?.scrollTop ?? 0`);
    assert.ok(scrollTop > 0, `quick upward swipe scrolled list (scrollTop=${scrollTop})`);
    assert.deepEqual(await builderTitles(), initialOrder, "order unchanged after quick swipe");

    // Reset scroll to top for second sub-case
    await s.evaluate(`document.querySelector(".setlist-builder-list").scrollTop = 0`);
    await settle(100);

    // 2. Touch moving 12 px in its first 200 ms and then held does NOT lift the row
    const r1 = await rowCenter(1);
    await touchStart(r1.x, r1.y);
    await sleep(100);
    await touchMove(r1.x, r1.y - 12);
    await sleep(600);
    const lifted = await s.evaluate<boolean>(`!!document.querySelector('.setlist-builder [data-dragging="true"]')`);
    assert.equal(lifted, false, "moving 12 px in first 200 ms then holding does not lift the row");
    await touchMove(r1.x, r1.y - 120);
    await touchEnd();
    await settle(150);
    assert.deepEqual(await builderTitles(), initialOrder, "order unchanged after 12 px move + hold");
    await closeBuilder();
  });

  // ---------------------------------------------------------------------------------------------- B5 keyboard and cancel
  await check("B5 keyboard and cancel", async () => {
    await openBuilderFor("Drag Trio");
    // Currently ["Evening Ferry", "Lantern Road", "Copper Kettle"] from B3
    assert.deepEqual(await builderTitles(), ["Evening Ferry", "Lantern Road", "Copper Kettle"]);

    // Focus first row's handle and press ArrowDown -> moves down one place and saves
    await s.evaluate(`(() => {
      const handle = document.querySelectorAll(".setlist-builder .setlist-builder-handle")[0];
      if (!handle) throw new Error("no drag handle");
      handle.focus();
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    })()`);
    await settle(150);
    assert.deepEqual(await builderTitles(), ["Lantern Road", "Evening Ferry", "Copper Kettle"], "ArrowDown moved first song down one place");

    // Verify saved after reload
    await reloadSetlists();
    assert.deepEqual(await setlistScreenTitles("Drag Trio"), ["Lantern Road", "Evening Ferry", "Copper Kettle"], "ArrowDown reorder saved across reload");

    // Escape during a drag puts the song back and leaves builder open
    await openBuilderFor("Drag Trio");
    const first = await rowCenter(0);
    await holdAndDrag(2, first.top - 10, { holdMs: 600, cancelWithEscape: true });
    assert.equal(await s.evaluate<boolean>(`!!document.querySelector(".setlist-builder[role=dialog]")`), true, "builder stays open after Escape cancels drag");
    assert.deepEqual(await builderTitles(), ["Lantern Road", "Evening Ferry", "Copper Kettle"], "Escape during drag restores original order");
    await closeBuilder();
  });

  // ---------------------------------------------------------------------------------------------- B6 add from My Songs
  await check("B6 add from My Songs", async () => {
    await openBuilderFor("Drag Trio");
    await app.click("+ Add songs", `document.querySelector(".setlist-builder")`);
    await app.until(`!!document.querySelector(".setlist-picker")`, "Add songs picker opens");

    // Already-in song reads "Already in this setlist" and cannot be ticked
    const alreadyIn = await s.evaluate<{ label: string; disabled: boolean } | null>(`(() => {
      const row = [...document.querySelectorAll(".setlist-picker-row")].find((el) => el.querySelector(".song-title")?.textContent?.trim() === "Lantern Road");
      if (!row) return null;
      const box = row.querySelector('input[type="checkbox"]');
      return { label: row.textContent ?? "", disabled: !!box?.disabled };
    })()`);
    assert.ok(alreadyIn && alreadyIn.label.includes("Already in this setlist"), `already-in row reads Already in this setlist (${js(alreadyIn)})`);
    assert.equal(alreadyIn.disabled, true, "already-in song checkbox is disabled");
    await shoot("picker-already-in");

    // Search narrows My Songs; tick Windmill Waltz first, then Morning Freight (in that order!)
    await setInputValue('.setlist-picker input[type="search"]', "Windmill");
    await settle(100);
    const narrowed = await s.evaluate<string[]>(`[...document.querySelectorAll(".setlist-picker-row .song-title")].map((el) => el.textContent.trim())`);
    assert.deepEqual(narrowed, ["Windmill Waltz"], "typing narrows picker to Windmill Waltz");
    await s.evaluate(`document.querySelector('.setlist-picker-row input[type="checkbox"]').click()`);
    await settle(60);

    await setInputValue('.setlist-picker input[type="search"]', "Morning Freight");
    await settle(100);
    await s.evaluate(`document.querySelector('.setlist-picker-row input[type="checkbox"]').click()`);
    await settle(60);

    // Tap Add twice quickly -> adds each song ONCE in the order ticked
    await s.evaluate(`(() => {
      const btn = [...document.querySelectorAll(".setlist-builder button")].find((b) => b.textContent.trim() === "Add");
      if (!btn || btn.disabled) throw new Error("Add button missing or disabled");
      btn.click();
      btn.click();
    })()`);
    await app.until(`!document.querySelector(".setlist-picker")`, "picker closes after Add");
    await settle(150);

    assert.deepEqual(
      await builderTitles(),
      ["Lantern Road", "Evening Ferry", "Copper Kettle", "Windmill Waltz", "Morning Freight"],
      "both songs appended at end in ticked order, once each",
    );
    await closeBuilder();

    await reloadSetlists();
    assert.deepEqual(
      await setlistScreenTitles("Drag Trio"),
      ["Lantern Road", "Evening Ferry", "Copper Kettle", "Windmill Waltz", "Morning Freight"],
      "added songs persist after reload",
    );
  });

  // ---------------------------------------------------------------------------------------------- B7 same title, two songs
  await check("B7 same title, two songs", async () => {
    await openBuilderFor("Twin Check");
    assert.deepEqual(await builderTitles(), ["Same Horizon"]);
    await app.click("+ Add songs", `document.querySelector(".setlist-builder")`);
    await app.until(`!!document.querySelector(".setlist-picker")`, "picker opens");
    await setInputValue('.setlist-picker input[type="search"]', "Same Horizon");
    await settle(100);

    const rows = await s.evaluate<{ disabled: boolean; already: boolean }[]>(`[...document.querySelectorAll(".setlist-picker-row")].map((el) => ({
      disabled: !!el.querySelector('input[type="checkbox"]')?.disabled,
      already: (el.textContent ?? "").includes("Already in this setlist"),
    }))`);
    assert.equal(rows.length, 2, `two songs with title Same Horizon shown (${js(rows)})`);
    assert.deepEqual(rows.map((r) => r.disabled).sort(), [false, true], "one is already in and disabled, the second can be ticked");

    await s.evaluate(`[...document.querySelectorAll('.setlist-picker-row input[type="checkbox"]')].find((b) => !b.disabled).click()`);
    await settle(60);
    await app.click("Add", `document.querySelector(".setlist-builder")`);
    await app.until(`!document.querySelector(".setlist-picker")`, "picker closes");
    await settle(120);
    assert.deepEqual(await builderTitles(), ["Same Horizon", "Same Horizon"], "both songs with same title are now in setlist");
    await closeBuilder();

    const lib = await readStoredLibrary();
    const twin = lib.setlists.find((entry) => entry.name === "Twin Check");
    assert.deepEqual(twin?.songRefs, ["local/810", "local/811"], "setlist holds both distinct song refs");
  });

  // ---------------------------------------------------------------------------------------------- B8 take a song off
  await check("B8 take a song off", async () => {
    await openBuilderFor("Remove One");
    assert.deepEqual(await builderTitles(), ["Lantern Road", "Copper Kettle", "Evening Ferry"]);
    await s.evaluate(`document.querySelectorAll(".setlist-builder [data-builder-row] .setlist-builder-remove")[1].click()`);
    await settle(150);
    assert.deepEqual(await builderTitles(), ["Lantern Road", "Evening Ferry"], "Copper Kettle removed immediately in builder");
    await closeBuilder();

    await reloadSetlists();
    assert.deepEqual(await setlistScreenTitles("Remove One"), ["Lantern Road", "Evening Ferry"], "removal persists after reload");
    const lib = await readStoredLibrary();
    assert.ok(lib.songs.some((song) => song.id === 802 && song.title === "Copper Kettle"), "removed song is still in My Songs");
  });

  // ---------------------------------------------------------------------------------------------- B10 rename
  await check("B10 rename", async () => {
    await openBuilderFor("Remove One");
    // Clearing box keeps old name and shows words
    await setInputValue('.setlist-builder input[aria-label="Setlist name"]', "");
    await s.evaluate(`document.querySelector('.setlist-builder input[aria-label="Setlist name"]').blur()`);
    await settle(100);
    const alertText = await app.text(".setlist-builder [role=alert]");
    assert.ok(alertText.trim().length > 0, `clearing name box shows words (${js(alertText)})`);
    assert.ok((await readStoredLibrary()).setlists.some((entry) => entry.id === 904 && entry.name === "Remove One"), "old name kept when box cleared");

    // Changing name and leaving box saves new name
    await setInputValue('.setlist-builder input[aria-label="Setlist name"]', "Renamed Porch");
    await s.evaluate(`document.querySelector('.setlist-builder input[aria-label="Setlist name"]').blur()`);
    await settle(150);
    await closeBuilder();

    await reloadSetlists();
    const hasNew = await s.evaluate<boolean>(`!!document.querySelector('section.setlist[aria-label="Renamed Porch"]')`);
    assert.equal(hasNew, true, "renamed setlist shows on Setlists screen after reload");
    assert.ok((await readStoredLibrary()).setlists.some((entry) => entry.id === 904 && entry.name === "Renamed Porch"), "renamed setlist persists via reader");
  });

  const nameBox = '.setlist-builder input[aria-label="Setlist name"]';
  const tapAt = async (x: number, y: number) => {
    await touchStart(x, y);
    await sleep(40);
    await touchEnd();
    await settle(150);
  };
  const centerOf = async (selector: string) => {
    const spot = await s.evaluate<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector(${js(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    assert.ok(spot, `${selector} is on screen`);
    return spot;
  };
  const pressEscape = async () => {
    await s.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await s.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await settle(150);
  };
  const storedSetlist = async (id: number) => (await readStoredLibrary()).setlists.find((entry) => entry.id === id);

  // ---------------------------------------------------------------------------------------------- B20 closing mid-rename keeps the stored name
  await check("B20 closing mid-rename keeps the stored name", async () => {
    const backdropSpot = async () => {
      const spot = { x: WIDTH / 2, y: 24 };
      const onBackdrop = await s.evaluate<boolean>(`document.elementFromPoint(${spot.x}, ${spot.y})?.classList.contains("account-backdrop") ?? false`);
      assert.ok(onBackdrop, "the top of the screen above the builder is the backdrop");
      return spot;
    };
    const ways: { how: string; close: () => Promise<void> }[] = [
      {
        how: "a tap on the backdrop",
        close: async () => {
          const spot = await backdropSpot();
          await tapAt(spot.x, spot.y);
        },
      },
      {
        how: "a mouse click on the backdrop",
        close: async () => {
          const spot = await backdropSpot();
          await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: spot.x, y: spot.y, button: "left", clickCount: 1 });
          await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: spot.x, y: spot.y, button: "left", clickCount: 1 });
          await settle(150);
        },
      },
      { how: "Escape", close: pressEscape },
      {
        how: "a tap on Close",
        close: async () => {
          const spot = await centerOf('.setlist-builder [aria-label="Close"]');
          await tapAt(spot.x, spot.y);
        },
      },
    ];
    for (const way of ways) {
      await openBuilderFor("Twin Check");
      await s.evaluate(`(() => {
        const el = document.querySelector(${js(nameBox)});
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      })()`);
      await s.send("Input.insertText", { text: " Draft" });
      await settle(60);
      assert.equal(await s.evaluate<string>(`document.querySelector(${js(nameBox)}).value`), "Twin Check Draft", `a new name is typed before ${way.how}`);
      await way.close();
      await app.until(`!document.querySelector(".setlist-builder[role=dialog]")`, `${way.how} closes the builder`);
      await settle(100);
      assert.equal((await storedSetlist(903))?.name, "Twin Check", `${way.how} in the middle of a rename keeps the stored name`);
      assert.equal(await s.evaluate<boolean>(`!!document.querySelector('section.setlist[aria-label="Twin Check"]')`), true, `${way.how}: the Setlists screen keeps the old name`);
    }
    await reloadSetlists();
    assert.equal((await storedSetlist(903))?.name, "Twin Check", "the old name holds after a reload");
    assert.equal(await s.evaluate<boolean>(`!!document.querySelector('section.setlist[aria-label="Twin Check Draft"]')`), false, "no draft name on the Setlists screen after a reload");
  });

  // ---------------------------------------------------------------------------------------------- B21 closing the picker adds nothing
  await check("B21 closing the picker adds nothing", async () => {
    const before = ["local/810", "local/811"];
    assert.deepEqual((await storedSetlist(903))?.songRefs, before, "Twin Check holds its two songs before");
    const pickerBox = `document.querySelector('.setlist-picker-row input[type="checkbox"]')`;
    const tickLantern = async () => {
      if (!(await s.evaluate<boolean>(`!!document.querySelector(".setlist-picker")`))) {
        await app.click("+ Add songs", `document.querySelector(".setlist-builder")`);
        await app.until(`!!document.querySelector(".setlist-picker")`, "the picker opens");
      }
      await setInputValue('.setlist-picker input[type="search"]', "Lantern Road");
      await settle(80);
      assert.equal(await s.evaluate<boolean>(`${pickerBox}.checked`), false, "Lantern Road starts unticked");
      await s.evaluate(`${pickerBox}.click()`);
      await settle(50);
      assert.equal(await s.evaluate<boolean>(`${pickerBox}.checked`), true, "Lantern Road is ticked");
    };

    await openBuilderFor("Twin Check");
    await tickLantern();
    const back = await centerOf('.setlist-builder [aria-label="Back"]');
    await tapAt(back.x, back.y);
    await app.until(`!document.querySelector(".setlist-picker")`, "Back closes the picker");
    assert.deepEqual(await builderTitles(), ["Same Horizon", "Same Horizon"], "Back adds nothing on screen");
    assert.deepEqual((await storedSetlist(903))?.songRefs, before, "Back adds nothing stored");

    await tickLantern();
    await pressEscape();
    await app.until(`!document.querySelector(".setlist-picker")`, "Escape closes the picker");
    assert.equal(await s.evaluate<boolean>(`!!document.querySelector(".setlist-builder[role=dialog]")`), true, "Escape on the picker leaves the builder open");
    assert.deepEqual(await builderTitles(), ["Same Horizon", "Same Horizon"], "Escape adds nothing on screen");
    assert.deepEqual((await storedSetlist(903))?.songRefs, before, "Escape adds nothing stored");

    await tickLantern();
    const close = await centerOf('.setlist-builder [aria-label="Close"]');
    await tapAt(close.x, close.y);
    await app.until(`!document.querySelector(".setlist-builder[role=dialog]")`, "Close shuts the builder from the picker");
    assert.deepEqual((await storedSetlist(903))?.songRefs, before, "Close from the picker adds nothing stored");

    await reloadSetlists();
    assert.deepEqual(await setlistScreenTitles("Twin Check"), ["Same Horizon", "Same Horizon"], "nothing was added after a reload");
    assert.deepEqual((await storedSetlist(903))?.songRefs, before, "nothing was added through the reader after a reload");
  });

  // ---------------------------------------------------------------------------------------------- B22 a song missing from the library
  await check("B22 a song missing from the library", async () => {
    await s.evaluate(`(() => {
      const lib = JSON.parse(localStorage.getItem("leadSheetsLibraryV2"));
      lib.setlists = [...lib.setlists.filter((each) => each.id !== 908), { id: 908, name: "Ghost Row", songIds: [801, 899, 802] }];
      localStorage.setItem("leadSheetsLibraryV2", JSON.stringify(lib));
    })()`);
    await reloadSetlists();
    const songsBefore = (await readStoredLibrary()).songs.map((song) => song.ref).sort();
    assert.equal(songsBefore.includes("local/899"), false, "the library has no song 899");

    const rowTexts = () => s.evaluate<string[]>(`[...document.querySelectorAll(".setlist-builder [data-builder-row] .setlist-builder-song")].map((el) => el.textContent.trim())`);
    await openBuilderFor("Ghost Row");
    const opened = await rowTexts();
    assert.equal(opened.length, 3, `three rows open (${js(opened)})`);
    assert.equal(opened[1], "Missing from this library", `the second row reads Missing from this library (${js(opened)})`);

    const first = await rowCenter(0);
    await holdAndDrag(1, first.top - 10, { holdMs: 600 });
    assert.equal((await rowTexts())[0], "Missing from this library", "the missing row is dragged to the top");
    assert.deepEqual(await builderTitles(), ["Lantern Road", "Copper Kettle"], "the other rows keep their order");
    assert.deepEqual((await storedSetlist(908))?.songRefs, ["local/899", "local/801", "local/802"], "the drag of the missing row is saved");

    await s.evaluate(`document.querySelectorAll(".setlist-builder [data-builder-row] .setlist-builder-remove")[0].click()`);
    await settle(150);
    assert.deepEqual(await rowTexts().then((rows) => rows.length), 2, "Remove takes the missing row off");
    assert.deepEqual((await storedSetlist(908))?.songRefs, ["local/801", "local/802"], "the remove of the missing row is saved");
    await closeBuilder();

    await reloadSetlists();
    assert.deepEqual(await setlistScreenTitles("Ghost Row"), ["Lantern Road", "Copper Kettle"], "Ghost Row after a reload");
    assert.deepEqual((await storedSetlist(908))?.songRefs, ["local/801", "local/802"], "Ghost Row through the reader after a reload");
    assert.deepEqual((await readStoredLibrary()).songs.map((song) => song.ref).sort(), songsBefore, "My Songs is unchanged");
  });

  // ---------------------------------------------------------------------------------------------- B26 a long drag scrolls the list
  await check("B26 a long drag scrolls the list", async () => {
    await openBuilderFor("Long Swipe Set");
    const titles = ["Lantern Road", "Copper Kettle", "Evening Ferry", "Windmill Waltz", "Rain on Tin", "Morning Freight", "Timberline", "Canyon Echo", "Silver Birch"];
    assert.deepEqual(await builderTitles(), titles, "Long Swipe Set opens in its stored order");
    const list = () =>
      s.evaluate<{ top: number; bottom: number; scrollTop: number; maxScroll: number }>(`(() => {
        const el = document.querySelector(".setlist-builder-list");
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, scrollTop: el.scrollTop, maxScroll: el.scrollHeight - el.clientHeight };
      })()`);
    const before = await list();
    assert.equal(before.scrollTop, 0, "the list starts at the top");
    assert.ok(before.maxScroll > 60, `the last row starts out of sight (${js(before)})`);

    const start = await rowCenter(0);
    await touchStart(start.x, start.y);
    try {
      await sleep(600);
      const edgeY = before.bottom - 8;
      for (let step = 1; step <= 10; step += 1) {
        await touchMove(start.x, start.y + ((edgeY - start.y) * step) / 10);
        await sleep(20);
      }
      for (let held = 0; held < 80 && (await list()).scrollTop < before.maxScroll; held += 1) {
        await touchMove(start.x, edgeY - (held % 2));
        await sleep(20);
      }
      const during = await list();
      assert.equal(during.scrollTop, during.maxScroll, `holding the lifted song at the bottom edge scrolls the list to its end (${js(during)})`);
    } finally {
      await touchEnd();
      await settle(150);
    }

    const expected = [...titles.slice(1), "Lantern Road"];
    assert.deepEqual(await builderTitles(), expected, "the lifted song lands at the end, out of the first view");
    assert.deepEqual(
      (await storedSetlist(902))?.songRefs,
      ["local/802", "local/803", "local/804", "local/805", "local/806", "local/807", "local/808", "local/809", "local/801"],
      "the long drag is saved",
    );
    await closeBuilder();
    await reloadSetlists();
    assert.deepEqual(await setlistScreenTitles("Long Swipe Set"), expected, "the long drag holds after a reload");
  });

  // ---------------------------------------------------------------------------------------------- B27 a press inside let go on the backdrop keeps the builder open
  await check("B27 a press inside let go on the backdrop keeps the builder open", async () => {
    await openBuilderFor("Twin Check");
    const inside = await centerOf(nameBox);
    const outside = { x: WIDTH / 2, y: 24 };
    assert.equal(
      await s.evaluate<boolean>(`document.elementFromPoint(${outside.x}, ${outside.y})?.classList.contains("account-backdrop") ?? false`),
      true,
      "the top of the screen above the builder is the backdrop",
    );
    await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: inside.x, y: inside.y, button: "left", buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 6; step += 1) {
      const x = inside.x + ((outside.x - inside.x) * step) / 6;
      const y = inside.y + ((outside.y - inside.y) * step) / 6;
      await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      await sleep(20);
    }
    await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: outside.x, y: outside.y, button: "left", buttons: 0, clickCount: 1 });
    await settle(200);
    assert.equal(await s.evaluate<boolean>(`!!document.querySelector(".setlist-builder[role=dialog]")`), true, "a press that began in the name box and ended on the backdrop leaves the builder open");
    assert.equal((await storedSetlist(903))?.name, "Twin Check", "the name is unchanged");

    await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: outside.x, y: outside.y, button: "left", buttons: 1, clickCount: 1 });
    await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: outside.x, y: outside.y, button: "left", buttons: 0, clickCount: 1 });
    await app.until(`!document.querySelector(".setlist-builder[role=dialog]")`, "a click that begins and ends on the backdrop still closes the builder");
    await settle(100);
  });

  // ---------------------------------------------------------------------------------------------- B11 delete
  await check("B11 delete", async () => {
    // 1. Built-in setlist has no Delete button and shows its line
    await openBuilderFor("Worship Set");
    const builtInHasDelete = await s.evaluate<boolean>(
      `[...document.querySelectorAll(".setlist-builder button")].some((b) => b.textContent.trim() === "Delete setlist")`,
    );
    assert.equal(builtInHasDelete, false, "built-in setlist offers no Delete setlist button");
    const builtInText = await app.text(".setlist-builder");
    assert.ok(builtInText.includes("Built-in setlists can't be deleted."), `built-in setlist shows its line (${js(builtInText)})`);
    await closeBuilder();

    // 2. Own setlist: Keep leaves it
    await openBuilderFor("Renamed Porch");
    await app.click("Delete setlist", `document.querySelector(".setlist-builder")`);
    await app.until(`(document.querySelector(".setlist-builder")?.textContent ?? "").includes("Delete this setlist? Your songs stay in My Songs.")`, "delete confirm text");
    await shoot("delete-confirm");
    await app.click("Keep", `document.querySelector(".setlist-builder")`);
    await settle(100);
    assert.ok((await readStoredLibrary()).setlists.some((entry) => entry.id === 904), "Keep leaves the setlist intact");

    // 3. Yes, delete removes it immediately on screen (tests storageChanged!) and after reload, keeping its songs
    await app.click("Delete setlist", `document.querySelector(".setlist-builder")`);
    await app.click("Yes, delete", `document.querySelector(".setlist-builder")`);
    await app.until(`!document.querySelector(".setlist-builder[role=dialog]")`, "builder closes after delete");
    await settle(100);
    const stillOnScreen = await s.evaluate<boolean>(`!!document.querySelector('section.setlist[aria-label="Renamed Porch"]')`);
    assert.equal(stillOnScreen, false, "deleted setlist leaves the Setlists screen immediately");

    await reloadSetlists();
    const afterLib = await readStoredLibrary();
    assert.equal(afterLib.setlists.some((entry) => entry.id === 904), false, "deleted setlist stays gone after reload");
    assert.ok(afterLib.songs.some((song) => song.id === 801 && song.title === "Lantern Road"), "Lantern Road stays in My Songs");
    assert.ok(afterLib.songs.some((song) => song.id === 803 && song.title === "Evening Ferry"), "Evening Ferry stays in My Songs");
  });

  // ---------------------------------------------------------------------------------------------- B15 one song twice
  await check("B15 one song twice", async () => {
    await openBuilderFor("Double Up");
    assert.deepEqual(await builderTitles(), ["Lantern Road", "Copper Kettle", "Lantern Road"], "both duplicate rows open");

    // Picker reads "Already in this setlist" for Lantern Road
    await app.click("+ Add songs", `document.querySelector(".setlist-builder")`);
    await app.until(`!!document.querySelector(".setlist-picker")`, "picker opens");
    const dupInPicker = await s.evaluate<boolean>(`(() => {
      const row = [...document.querySelectorAll(".setlist-picker-row")].find((el) => el.querySelector(".song-title")?.textContent?.trim() === "Lantern Road");
      return !!(row && (row.textContent ?? "").includes("Already in this setlist") && row.querySelector('input[type="checkbox"]')?.disabled);
    })()`);
    assert.equal(dupInPicker, true, "picker reads Already in this setlist for duplicated song");
    await s.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await app.until(`!document.querySelector(".setlist-picker")`, "Escape closes picker back to builder");

    // Drag first row below second -> keeps both occurrences!
    const second = await rowCenter(1);
    const third = await rowCenter(2);
    await holdAndDrag(0, (second.y + third.y) / 2, { holdMs: 600 });
    assert.deepEqual(await builderTitles(), ["Copper Kettle", "Lantern Road", "Lantern Road"], "dragging first duplicate below second keeps both");

    // Drag it back above first so duplicates are at 0 and 2 again, then remove 3rd row (index 2)
    const top = await rowCenter(0);
    await holdAndDrag(1, top.top - 10, { holdMs: 600 });
    assert.deepEqual(await builderTitles(), ["Lantern Road", "Copper Kettle", "Lantern Road"]);

    await s.evaluate(`document.querySelectorAll(".setlist-builder [data-builder-row] .setlist-builder-remove")[2].click()`);
    await settle(150);
    assert.deepEqual(await builderTitles(), ["Lantern Road", "Copper Kettle"], "removing third row leaves first duplicate intact");
    await closeBuilder();

    await reloadSetlists();
    const lib = await readStoredLibrary();
    assert.deepEqual(lib.setlists.find((entry) => entry.name === "Double Up")?.songRefs, ["local/801", "local/802"], "first duplicate stays saved");
  });

  // ---------------------------------------------------------------------------------------------- B14 fits, and a full phone
  await check("B14 fits, and a full phone", async () => {
    await phone360();
    await openBuilderFor("Drag Trio");
    await shoot("builder-360");

    // Check every visible control in builder is >= 44px tall, rows show title, artist, key and tempo, no sideways scroll
    const builderAudit = await s.evaluate<{ small: string[]; rows: { title: string; artist: string; meta: string }[]; pageW: number; innerW: number }>(`(() => {
      const dlg = document.querySelector(".setlist-builder");
      const small = [];
      for (const el of dlg.querySelectorAll("button, input, a")) {
        if (!el.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.height < 43.5) small.push((el.textContent.trim() || el.getAttribute("aria-label") || el.tagName) + ":" + Math.round(r.height));
      }
      const rows = [...dlg.querySelectorAll("[data-builder-row]")].map((row) => ({
        title: row.querySelector(".song-title")?.textContent?.trim() ?? "",
        artist: row.querySelector(".song-artist")?.textContent?.trim() ?? "",
        meta: row.querySelector(".song-meta")?.textContent?.trim() ?? "",
      }));
      return { small, rows, pageW: document.documentElement.scrollWidth, innerW: innerWidth };
    })()`);
    assert.deepEqual(builderAudit.small, [], `all builder controls >= 44 px (${js(builderAudit.small)})`);
    assert.ok(builderAudit.pageW <= builderAudit.innerW + 0.5, `builder does not scroll sideways (${builderAudit.pageW} > ${builderAudit.innerW})`);
    for (const row of builderAudit.rows) {
      assert.ok(row.title && row.artist && row.meta.includes("bpm"), `builder row shows title, artist, key and tempo (${js(row)})`);
    }

    // Check picker at 360px
    await app.click("+ Add songs", `document.querySelector(".setlist-builder")`);
    await app.until(`!!document.querySelector(".setlist-picker")`, "picker opens");
    const pickerAudit = await s.evaluate<{ small: string[]; pageW: number; innerW: number }>(`(() => {
      const dlg = document.querySelector(".setlist-builder");
      const small = [];
      for (const el of dlg.querySelectorAll("button, input, a")) {
        if (!el.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.height < 43.5) small.push((el.textContent.trim() || el.getAttribute("aria-label") || el.tagName) + ":" + Math.round(r.height));
      }
      return { small, pageW: document.documentElement.scrollWidth, innerW: innerWidth };
    })()`);
    assert.deepEqual(pickerAudit.small, [], `all picker controls >= 44 px (${js(pickerAudit.small)})`);
    assert.ok(pickerAudit.pageW <= pickerAudit.innerW + 0.5, `picker does not scroll sideways (${pickerAudit.pageW} > ${pickerAudit.innerW})`);
    await s.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await app.until(`!document.querySelector(".setlist-picker")`, "picker closes");

    // Every view again at 390 x 844 too, and the delete confirm at both widths: no control under 44 px, no sideways scroll
    const viewAudit = (label: string) =>
      s.evaluate<{ label: string; small: string[]; pageW: number; innerW: number; controls: number }>(`(() => {
        const dlg = document.querySelector(".setlist-builder");
        const small = [];
        let controls = 0;
        for (const el of dlg.querySelectorAll("button, input, a")) {
          if (!el.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
          controls += 1;
          const r = el.getBoundingClientRect();
          if (r.height < 43.5 || r.width < 43.5) small.push((el.textContent.trim() || el.getAttribute("aria-label") || el.tagName) + ":" + Math.round(r.width) + "x" + Math.round(r.height));
        }
        return { label: ${js(label)}, small, pageW: document.documentElement.scrollWidth, innerW: innerWidth, controls };
      })()`);
    const auditAll = async (width: number) => {
      const audits = [await viewAudit(`songs view at ${width}`)];
      await app.click("+ Add songs", `document.querySelector(".setlist-builder")`);
      await app.until(`!!document.querySelector(".setlist-picker")`, "picker opens");
      audits.push(await viewAudit(`picker at ${width}`));
      await s.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      await app.until(`!document.querySelector(".setlist-picker")`, "picker closes");
      await app.click("Delete setlist", `document.querySelector(".setlist-builder")`);
      await app.until(`(document.querySelector(".setlist-builder")?.textContent ?? "").includes("Delete this setlist? Your songs stay in My Songs.")`, "delete confirm");
      const confirm = await viewAudit(`delete confirm at ${width}`);
      const confirmButtons = await s.evaluate<string[]>(`[...document.querySelectorAll(".setlist-builder-confirm button")].map((b) => b.textContent.trim())`);
      assert.deepEqual(confirmButtons, ["Yes, delete", "Keep"], `the delete confirm at ${width} offers Yes, delete and Keep (${js(confirmButtons)})`);
      audits.push(confirm);
      if (width === 390) await shoot("delete-confirm-390");
      await app.click("Keep", `document.querySelector(".setlist-builder")`);
      await app.until(`!document.querySelector(".setlist-builder-confirm")`, "Keep goes back to the songs");
      for (const audit of audits) {
        assert.ok(audit.controls >= 3, `${audit.label} has its controls (${audit.controls})`);
        assert.deepEqual(audit.small, [], `every control in the ${audit.label} is at least 44 x 44 px (${js(audit.small)})`);
        assert.ok(audit.pageW <= audit.innerW + 0.5, `the ${audit.label} does not scroll sideways (${audit.pageW} > ${audit.innerW})`);
      }
    };
    await auditAll(360);
    await s.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await s.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`);
    try {
      await auditAll(390);
      await shoot("builder-390");
      const at390 = await builderTitles();
      const top390 = await rowCenter(0);
      await holdAndDrag(2, top390.top - 10, { holdMs: 600 });
      const moved390 = await builderTitles();
      assert.ok(at390.length >= 3, `Drag Trio has at least three songs (${js(at390)})`);
      assert.deepEqual(moved390, [at390[2], ...at390.filter((_, i) => i !== 2)], `a drag at 390 x 844 moves the third song to the top (${js(at390)} -> ${js(moved390)})`);
      const last390 = await rowCenter(2);
      await holdAndDrag(0, last390.bottom + 10, { holdMs: 600 });
      const back390 = await builderTitles();
      assert.deepEqual(back390, at390, `a drag at 390 x 844 puts it back third (${js(back390)})`);
    } finally {
      await phone360();
    }

    // Full phone: make setItem throw for leadSheetsLibraryV2; drop shows words and reverts list to stored order
    const storedBefore = await builderTitles();
    await s.evaluate(`(() => {
      window.__origSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === "leadSheetsLibraryV2") throw new DOMException("full", "QuotaExceededError");
        return window.__origSetItem.call(this, k, v);
      };
    })()`);
    try {
      const first = await rowCenter(0);
      await holdAndDrag(2, first.top - 10, { holdMs: 600 });
      const alertText = await app.text(".setlist-builder [role=alert]");
      assert.equal(alertText.trim(), "This phone couldn't save the setlist. Free some space and try again.");
      assert.deepEqual(await builderTitles(), storedBefore, "refused write reverts list on screen to stored order");
    } finally {
      await s.evaluate(`if (window.__origSetItem) Storage.prototype.setItem = window.__origSetItem`);
    }
    await closeBuilder();
  });

  // ---------------------------------------------------------------------------------------------- B31 every refused write
  // A full phone refuses each of the builder's writes in turn. Each one must show the words, leave the screen on what
  // is stored and write nothing. The builder is reopened before each write, so words left by an earlier step cannot
  // stand in for the next one.
  await check("B31 every refused write shows the words and what is stored", async () => {
    const FULL = "This phone couldn't save the setlist. Free some space and try again.";
    const NAME = "Full Phone Set";
    const NAME_BOX = '.setlist-builder input[aria-label="Setlist name"]';
    const rawLibrary = () => s.evaluate<string | null>(`localStorage.getItem("leadSheetsLibraryV2")`);
    const alertNow = () => s.evaluate<string>(`document.querySelector(".setlist-builder [role=alert]")?.textContent?.trim() ?? ""`);
    const headingNow = () => s.evaluate<string>(`document.querySelector(".setlist-builder h2")?.textContent?.trim() ?? ""`);
    const builderOpen = () => s.evaluate<boolean>(`!!document.querySelector(".setlist-builder[role=dialog]")`);
    await s.evaluate(`(() => {
      const lib = JSON.parse(localStorage.getItem("leadSheetsLibraryV2") || "{}");
      lib.setlists = [...(lib.setlists || []).filter((each) => each.id !== 908), { id: 908, name: ${js(NAME)}, songIds: [801, 802, 803] }];
      localStorage.setItem("leadSheetsLibraryV2", JSON.stringify(lib));
    })()`);
    await reloadSetlists();
    const stored = await rawLibrary();
    const setsBefore = (await readStoredLibrary()).setlists.length;
    const reopen = async (step: string) => {
      await openBuilderFor(NAME);
      assert.equal(await alertNow(), "", `${step}: the builder opens with no words left from the step before`);
      return builderTitles();
    };
    const refusedHere = async (step: string, titles: string[]) => {
      assert.equal(await alertNow(), FULL, `${step}: a refused write shows the words (${js(await alertNow())})`);
      assert.equal(await rawLibrary(), stored, `${step}: a refused write stores nothing`);
      assert.deepEqual(await builderTitles(), titles, `${step}: the list on screen is the stored list`);
    };
    const keyOnHandle = async (index: number, key: "ArrowUp" | "ArrowDown") => {
      await s.evaluate(`(() => {
        const handle = document.querySelectorAll(".setlist-builder .setlist-builder-handle")[${index}];
        if (!handle) throw new Error("no drag handle ${index}");
        handle.focus();
        handle.dispatchEvent(new KeyboardEvent("keydown", { key: ${js(key)}, bubbles: true, cancelable: true }));
      })()`);
      await settle(150);
    };
    await s.evaluate(`(() => {
      window.__b31RealSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === "leadSheetsLibraryV2") throw new DOMException("full", "QuotaExceededError");
        return window.__b31RealSetItem.call(this, k, v);
      };
    })()`);
    let tickedTitle = "";
    try {
      // Rename: type a new name and leave the box. The box goes back to the stored name.
      let titles = await reopen("rename");
      await s.evaluate(`(() => {
        const el = document.querySelector(${js(NAME_BOX)});
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      })()`);
      await s.send("Input.insertText", { text: " Live" });
      await settle(50);
      await s.evaluate(`document.querySelector(${js(NAME_BOX)}).blur()`);
      await settle(150);
      await refusedHere("rename", titles);
      const box = await s.evaluate<string>(`document.querySelector(${js(NAME_BOX)}).value`);
      assert.equal(box, NAME, `rename: the name box reads the stored name, not the unsaved one (${js(box)})`);
      assert.equal(await headingNow(), NAME, "rename: the heading reads the stored name");
      await closeBuilder();

      // ArrowUp and ArrowDown on a handle: the order stays the stored order.
      titles = await reopen("ArrowUp");
      await keyOnHandle(1, "ArrowUp");
      await refusedHere("ArrowUp", titles);
      await closeBuilder();
      titles = await reopen("ArrowDown");
      await keyOnHandle(0, "ArrowDown");
      await refusedHere("ArrowDown", titles);
      await closeBuilder();

      // Remove: the row stays.
      titles = await reopen("remove");
      await s.evaluate(`document.querySelectorAll(".setlist-builder [data-builder-row] .setlist-builder-remove")[0].click()`);
      await settle(150);
      await refusedHere("remove", titles);
      await closeBuilder();

      // Add: the picker stays open with the song still ticked.
      titles = await reopen("add");
      await app.click("+ Add songs", `document.querySelector(".setlist-builder")`);
      await app.until(`!!document.querySelector(".setlist-picker")`, "picker opens");
      tickedTitle = await s.evaluate<string>(`(() => {
        const box = [...document.querySelectorAll('.setlist-picker-row input[type="checkbox"]')].find((each) => !each.disabled);
        if (!box) return "";
        box.click();
        return box.closest(".setlist-picker-row")?.querySelector(".song-title")?.textContent?.trim() ?? "";
      })()`);
      assert.ok(tickedTitle, "add: the picker has a song to tick");
      await settle(60);
      await app.click("Add", `document.querySelector(".setlist-builder")`);
      await settle(150);
      assert.equal(await s.evaluate<boolean>(`!!document.querySelector(".setlist-picker")`), true, "add: a refused Add keeps the picker open");
      assert.equal(await alertNow(), FULL, `add: a refused Add shows the words (${js(await alertNow())})`);
      assert.equal(await rawLibrary(), stored, "add: a refused Add stores nothing");
      const stillTicked = await s.evaluate<number>(`document.querySelectorAll('.setlist-picker-row input[type="checkbox"]:checked:not(:disabled)').length`);
      assert.equal(stillTicked, 1, `add: the ticked song stays ticked (${stillTicked})`);
    } finally {
      await s.evaluate(`if (window.__b31RealSetItem) Storage.prototype.setItem = window.__b31RealSetItem`);
    }
    // Room again: the same Add now goes through, so a refused Add did not leave the picker stuck.
    await app.click("Add", `document.querySelector(".setlist-builder")`);
    await app.until(`!document.querySelector(".setlist-picker")`, "picker closes once Add is saved");
    await settle(150);
    const afterAdd = await builderTitles();
    assert.equal(afterAdd[afterAdd.length - 1], tickedTitle, `add: with room again Add puts the ticked song last (${js(afterAdd)})`);
    const withSong = await rawLibrary();
    await closeBuilder();

    await s.evaluate(`(() => {
      window.__b31RealSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === "leadSheetsLibraryV2") throw new DOMException("full", "QuotaExceededError");
        return window.__b31RealSetItem.call(this, k, v);
      };
    })()`);
    try {
      // Delete: the builder stays open on the setlist, and it is still listed.
      await openBuilderFor(NAME);
      assert.equal(await alertNow(), "", "delete: the builder opens with no words left from the step before");
      await app.click("Delete setlist", `document.querySelector(".setlist-builder")`);
      await app.until(`!!document.querySelector(".setlist-builder-confirm")`, "delete confirm");
      await app.click("Yes, delete", `document.querySelector(".setlist-builder")`);
      await settle(150);
      assert.equal(await builderOpen(), true, "delete: a refused delete keeps the builder open");
      assert.equal(await alertNow(), FULL, `delete: a refused delete shows the words (${js(await alertNow())})`);
      assert.equal(await rawLibrary(), withSong, "delete: a refused delete stores nothing");
      await closeBuilder();
      assert.equal(await s.evaluate<boolean>(`!!document.querySelector(${js(`section.setlist[aria-label="${NAME}"]`)})`), true, "delete: the setlist is still listed");

      // Create: the sheet stays on New setlist, and no setlist is made.
      await openNewBuilder();
      assert.equal(await alertNow(), "", "create: the sheet opens with no words");
      await setInputValue(NAME_BOX, "Never Stored");
      await app.click("Save", `document.querySelector(".setlist-builder")`);
      await settle(150);
      assert.equal(await alertNow(), FULL, `create: a refused Save shows the words (${js(await alertNow())})`);
      assert.equal(await headingNow(), "New setlist", "create: the sheet stays on New setlist");
      assert.equal(await rawLibrary(), withSong, "create: a refused Save stores nothing");
      await closeBuilder();
    } finally {
      await s.evaluate(`if (window.__b31RealSetItem) Storage.prototype.setItem = window.__b31RealSetItem`);
    }

    await reloadSetlists();
    const lib = await readStoredLibrary();
    assert.equal(lib.setlists.length, setsBefore, "after a reload: no setlist was made or lost");
    assert.ok(!lib.setlists.some((each) => each.name === "Never Stored" || each.name === `${NAME} Live`), "after a reload: no refused name is stored");
    assert.deepEqual(await setlistScreenTitles(NAME), afterAdd, "after a reload: the list is the one stored with room");

    // Leave the library as the cases after this one expect it.
    await openBuilderFor(NAME);
    await app.click("Delete setlist", `document.querySelector(".setlist-builder")`);
    await app.until(`!!document.querySelector(".setlist-builder-confirm")`, "delete confirm");
    await app.click("Yes, delete", `document.querySelector(".setlist-builder")`);
    await app.until(`!document.querySelector(".setlist-builder[role=dialog]")`, "builder closes once the delete is saved");
    await settle(150);
    assert.ok(!(await readStoredLibrary()).setlists.some((each) => each.id === 908), "the test setlist is deleted with room again");
  });

  // ---------------------------------------------------------------------------------------------- B18 one write per drop
  await check("B18 one write per drop", async () => {
    await goSetlists();
    await s.evaluate(`(() => {
      window.__libWrites = 0;
      window.__countRealSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === "leadSheetsLibraryV2") window.__libWrites += 1;
        return window.__countRealSetItem.call(this, k, v);
      };
    })()`);
    try {
      const writes = () => s.evaluate<number>(`window.__libWrites`);
      const resetWrites = () => s.evaluate(`window.__libWrites = 0`);

      // Open and close: 0 writes
      await resetWrites();
      await openBuilderFor("Drag Trio");
      await closeBuilder();
      const openCloseWrites = await writes();
      assert.equal(openCloseWrites, 0, `opening and closing builder writes 0 times (got ${openCloseWrites})`);

      // Drop in a new place: 1 write
      await openBuilderFor("Drag Trio");
      await resetWrites();
      const first = await rowCenter(0);
      await holdAndDrag(2, first.top - 10, { holdMs: 600 });
      const moveWrites = await writes();
      assert.equal(moveWrites, 1, `dropping in a new place writes once (got ${moveWrites})`);

      // Drop back in the same place: 0 writes
      await resetWrites();
      const r0 = await rowCenter(0);
      await holdAndDrag(0, r0.y, { holdMs: 600 });
      const sameWrites = await writes();
      assert.equal(sameWrites, 0, `dropping back in the same place writes 0 times (got ${sameWrites})`);

      // Rename writes once on blur, 0 on each key
      await resetWrites();
      await s.evaluate(`(() => {
        const el = document.querySelector('.setlist-builder input[aria-label="Setlist name"]');
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      })()`);
      for (const ch of ["!", "2", "3"]) {
        await s.send("Input.insertText", { text: ch });
        await settle(30);
      }
      const typingWrites = await writes();
      assert.equal(typingWrites, 0, `typing in rename box writes 0 times (got ${typingWrites})`);
      await s.evaluate(`document.querySelector('.setlist-builder input[aria-label="Setlist name"]').blur()`);
      await settle(150);
      const blurWrites = await writes();
      assert.equal(blurWrites, 1, `leaving rename box writes once (got ${blurWrites})`);
      console.log(`info B18 counts: openClose=${openCloseWrites} dropMove=${moveWrites} dropSame=${sameWrites} renameTyping=${typingWrites} renameBlur=${blurWrites}`);
      await closeBuilder();
    } finally {
      await s.evaluate(`if (window.__countRealSetItem) Storage.prototype.setItem = window.__countRealSetItem`);
    }
  });

  const ensureSignedIn = async () => {
    const signedIn = await s.evaluate<boolean>(`!!localStorage.getItem("leadSheetsBackupV2")`);
    if (!signedIn) {
      await app.signUp("Sam Builder");
      await phone360();
    }
    await app.until(
      `(() => { const st = JSON.parse(localStorage.getItem("leadSheetsBackupV2") || "null"); return !!st && st.at !== null; })()`,
      "initial Phone A backup",
      15000,
    );
  };

  // ---------------------------------------------------------------------------------------------- B9 Show code moved (signed out first, then signed in)
  await check("B9 Show code moved", async () => {
    // Signed out: no Show code on Setlists screen or inside builder, and nothing asks for sign-in
    await goSetlists();
    const showOnScreenSignedOut = await s.evaluate<boolean>(
      `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Show code") || !!document.querySelector(".setlist-code-show")`,
    );
    assert.equal(showOnScreenSignedOut, false, "signed out: no Show code on Setlists screen");
    await openBuilderFor("Worship Set");
    const showInBuilderSignedOut = await s.evaluate<boolean>(
      `[...document.querySelectorAll(".setlist-builder button")].some((b) => b.textContent.trim() === "Show code")`,
    );
    assert.equal(showInBuilderSignedOut, false, "signed out: no Show code inside builder");
    assert.equal(await s.evaluate<boolean>(`!!document.querySelector(".account-sheet")`), false, "signed out: nothing asks for sign-in");
    await closeBuilder();

    // Sign in and verify Show code moved inside builder
    await ensureSignedIn();
    await goSetlists();
    await shoot("setlists-no-show-code");

    const showOnScreenSignedIn = await s.evaluate<boolean>(
      `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Show code") || !!document.querySelector(".setlist-code-show")`,
    );
    assert.equal(showOnScreenSignedIn, false, "signed in: Setlists screen has no Show code button");

    // Empty setlist says "Add a song first"
    await openBuilderFor("Empty Private");
    const emptyText = await app.text(".setlist-builder");
    assert.ok(emptyText.includes("Add a song first"), `empty setlist says Add a song first (${js(emptyText)})`);
    assert.equal(await s.evaluate<boolean>(`!!document.querySelector(".setlist-builder .setlist-code-show")`), false, "empty setlist has no Show code button");
    await closeBuilder();

    // Privately shared copy offers none
    await openBuilderFor("Private Copy Set");
    const privText = await app.text(".setlist-builder");
    assert.equal(await s.evaluate<boolean>(`!!document.querySelector(".setlist-builder .setlist-code-show")`), false, "private copy has no Show code button");
    assert.equal(privText.includes("Add a song first"), false, "private copy shows no Add a song first");
    await closeBuilder();

    // Non-empty own/built-in setlist has Show code inside builder and opens the same code sheet
    await openBuilderFor("Worship Set");
    await app.click("Show code", `document.querySelector(".setlist-builder")`);
    await app.until(`!!document.querySelector(".setlist-code-sheet")`, "MySetlistCodeSheet opens from builder");
    await s.evaluate(`document.querySelector(".setlist-code-sheet .account-close")?.click()`);
    await app.until(`!document.querySelector(".setlist-code-sheet")`, "code sheet closes");
  });

  // ---------------------------------------------------------------------------------------------- B23 Show code keeps focus out of the screen behind
  await check("B23 Show code keeps focus out of the screen behind", async () => {
    await openBuilderFor("Worship Set");
    await app.click("Show code", `document.querySelector(".setlist-builder")`);
    await app.until(`!!document.querySelector(".setlist-code-sheet")`, "the code sheet opens from the builder");
    await s.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`);
    await settle(150);
    const where = await s.evaluate<string>(`(() => {
      const el = document.activeElement;
      if (el?.closest("section.setlist")) return "setlists: " + el.textContent.trim();
      if (el?.closest(".setlist-code-sheet")) return "code sheet";
      return el?.tagName ?? "";
    })()`);
    assert.ok(!where.startsWith("setlists:"), `focus stays out of the Setlists screen behind the code sheet (${where})`);
    await s.evaluate(`document.querySelector(".setlist-code-sheet .account-close")?.click()`);
    await app.until(`!document.querySelector(".setlist-code-sheet")`, "the code sheet closes");
  });

  // ---------------------------------------------------------------------------------------------- B32 a friend's private copy keeps its copy mark
  // Every builder save of a friend's copy must keep its `copy` mark: the mark is the copy's lineage, and its
  // canSendOn=false is what keeps Show code off a private copy. Signed in, so Show code would show if the mark went.
  await check("B32 a friend's private copy keeps its copy mark when reordered and renamed", async () => {
    const NAME = "Dana Copy Set";
    const MARK = { id: "copy-priv-909", canSendOn: false, from: { name: "Dana" } };
    const NAME_BOX = '.setlist-builder input[aria-label="Setlist name"]';
    const showCode = () => s.evaluate<boolean>(`!!document.querySelector(".setlist-builder .setlist-code-show")`);
    await ensureSignedIn();
    await s.evaluate(`(() => {
      const lib = JSON.parse(localStorage.getItem("leadSheetsLibraryV2") || "{}");
      lib.setlists = [...(lib.setlists || []).filter((each) => each.id !== 909), { id: 909, name: ${js(NAME)}, songIds: [801, 802, 803], copy: ${js(MARK)} }];
      localStorage.setItem("leadSheetsLibraryV2", JSON.stringify(lib));
    })()`);
    await reloadSetlists();
    assert.deepEqual((await storedSetlist(909))?.copy, MARK, "the seeded copy mark is stored");

    // Reorder: ArrowDown on the first handle saves the new order and keeps the mark.
    await openBuilderFor(NAME);
    assert.equal(await showCode(), false, "a private copy offers no Show code before any save");
    const before = await builderTitles();
    await s.evaluate(`(() => {
      const handle = document.querySelectorAll(".setlist-builder .setlist-builder-handle")[0];
      if (!handle) throw new Error("no drag handle 0");
      handle.focus();
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    })()`);
    await settle(150);
    const moved = [before[1], before[0], ...before.slice(2)];
    assert.deepEqual(await builderTitles(), moved, "ArrowDown moved the first song down one place");
    assert.deepEqual((await storedSetlist(909))?.songRefs, ["local/802", "local/801", "local/803"], "the reorder is stored");
    assert.deepEqual((await storedSetlist(909))?.copy, MARK, "a reorder keeps the copy mark");
    assert.equal(await showCode(), false, "a reordered private copy offers no Show code");

    // Rename: type in the name box and leave it. The new name is stored and the mark is kept.
    await s.evaluate(`(() => {
      const el = document.querySelector(${js(NAME_BOX)});
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    })()`);
    await s.send("Input.insertText", { text: " Live" });
    await settle(50);
    await s.evaluate(`document.querySelector(${js(NAME_BOX)}).blur()`);
    await settle(150);
    assert.equal((await storedSetlist(909))?.name, `${NAME} Live`, "the rename is stored");
    assert.deepEqual((await storedSetlist(909))?.copy, MARK, "a rename keeps the copy mark");
    await closeBuilder();

    // After a reload the order, the name and the mark hold, and the builder still offers no Show code.
    await reloadSetlists();
    const after = await storedSetlist(909);
    assert.deepEqual(after?.songRefs, ["local/802", "local/801", "local/803"], "after a reload: the reorder holds");
    assert.deepEqual(after?.copy, MARK, "after a reload: the copy mark holds");
    await openBuilderFor(`${NAME} Live`);
    assert.equal(await showCode(), false, "after a reload: the private copy still offers no Show code");

    // Leave the library as the cases after this one expect it.
    await app.click("Delete setlist", `document.querySelector(".setlist-builder")`);
    await app.until(`!!document.querySelector(".setlist-builder-confirm")`, "delete confirm");
    await app.click("Yes, delete", `document.querySelector(".setlist-builder")`);
    await app.until(`!document.querySelector(".setlist-builder[role=dialog]")`, "builder closes once the delete is saved");
    await settle(150);
    assert.ok(!(await readStoredLibrary()).setlists.some((each) => each.id === 909), "the test setlist is deleted");
  });

  // Set up Phone B on the same account via password for B12, B16, B17
  await ensureSignedIn();
  const me = await s.evaluate<{ userId: string; handle: string }>(`fetch("/api/me").then((r) => r.json()).then((r) => r.account)`);
  const salt = newSalt();
  const key = await passwordKey("violet tram 42 lantern", salt);
  const setPw = await s.evaluate<{ status: number }>(
    `fetch("/api/me/password", { method: "POST", headers: { "content-type": "application/json", "x-song-shape": "chordpro" }, body: ${js(js({ salt, key }))} }).then((r) => ({ status: r.status }))`,
  );
  assert.equal(setPw.status, 200, "Phone A sets password for second-phone sync");

  const phoneB = new Phone(apiBase);
  const bSignIn = await phoneB.call("/api/auth/password/sign-in", { handle: me.handle, key }, { origin });
  assert.equal(bSignIn.status, 200, "Phone B signs in to same account");

  const phoneBStore = new FakeStorage();
  const phoneBMod = await loadStorageBackup();
  const realFetch = globalThis.fetch;
  const runPhoneB = async <T>(work: (mod: StorageBackupMod) => Promise<T> | T): Promise<T> => {
    const prevStore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const prevNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "localStorage", { value: phoneBStore, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)" }, configurable: true });
    globalThis.fetch = async (path, init) => {
      const headers = { ...(init?.headers as Record<string, string>), origin, ...(phoneB.cookie ? { cookie: phoneB.cookie } : {}) };
      return realFetch(new URL(String(path), apiBase), { ...init, headers });
    };
    try {
      return await work(phoneBMod);
    } finally {
      globalThis.fetch = realFetch;
      if (prevStore) Object.defineProperty(globalThis, "localStorage", prevStore);
      if (prevNav) Object.defineProperty(globalThis, "navigator", prevNav);
    }
  };

  const syncPhoneA = async () => {
    const beforeAt = await s.evaluate<number | null>(`JSON.parse(localStorage.getItem("leadSheetsBackupV2") || "null")?.at ?? null`);
    const beforeRev = await s.evaluate<number>(`JSON.parse(localStorage.getItem("leadSheetsBackupV2") || "null")?.pulled ?? 0`);
    await sleep(25);
    await s.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
    await app.until(
      `(() => { const st = JSON.parse(localStorage.getItem("leadSheetsBackupV2") || "null"); return !!st && st.at !== null && (st.at !== ${js(beforeAt)} || st.pulled > ${js(beforeRev)}); })()`,
      "Phone A backup finishes",
      15000,
    );
    await settle(200);
  };

  // Initial sync for Phone A and Phone B
  await syncPhoneA();
  await runPhoneB(async (mod) => {
    mod.loadLibrary();
    mod.backupOn(me.userId);
    const res = await mod.syncBackup();
    assert.ok(res.ok, `Phone B initial sync ok (${js(res)})`);
  });

  // ---------------------------------------------------------------------------------------------- B12 a delete stays deleted
  await check("B12 a delete stays deleted", async () => {
    // Create a dedicated setlist on Phone A with 2 songs, sync both phones
    await openNewBuilder();
    await setInputValue('.setlist-builder input[aria-label="Setlist name"]', "Sync Delete Test");
    await app.click("Save", `document.querySelector(".setlist-builder")`);
    await app.until(`document.querySelector(".setlist-builder h2")?.textContent?.trim() === "Sync Delete Test"`, "Sync Delete Test created");
    await app.click("+ Add songs", `document.querySelector(".setlist-builder")`);
    await app.until(`!!document.querySelector(".setlist-picker")`, "picker opens");
    for (const title of ["Lantern Road", "Copper Kettle"]) {
      await setInputValue('.setlist-picker input[type="search"]', title);
      await settle(80);
      await s.evaluate(`document.querySelector('.setlist-picker-row input[type="checkbox"]').click()`);
      await settle(50);
    }
    await app.click("Add", `document.querySelector(".setlist-builder")`);
    await app.until(`!document.querySelector(".setlist-picker")`, "picker closes");
    await closeBuilder();

    await syncPhoneA();
    const bHasBefore = await runPhoneB(async (mod) => {
      assert.ok((await mod.syncBackup()).ok);
      return mod.loadLibrary().setlists.some((entry) => entry.name === "Sync Delete Test");
    });
    assert.equal(bHasBefore, true, "Phone B synced Sync Delete Test");

    // Phone A deletes it and backs up
    await openBuilderFor("Sync Delete Test");
    await app.click("Delete setlist", `document.querySelector(".setlist-builder")`);
    await app.click("Yes, delete", `document.querySelector(".setlist-builder")`);
    await app.until(`!document.querySelector(".setlist-builder[role=dialog]")`, "deleted");
    await syncPhoneA();

    // Phone B syncs -> no longer has it, songs still there
    const bAfter = await runPhoneB(async (mod) => {
      assert.ok((await mod.syncBackup()).ok);
      return mod.loadLibrary();
    });
    assert.equal(bAfter.setlists.some((entry) => entry.name === "Sync Delete Test"), false, "Phone B no longer has deleted setlist");
    assert.ok(bAfter.songs.some((song) => song.title === "Lantern Road") && bAfter.songs.some((song) => song.title === "Copper Kettle"), "songs stay on Phone B");

    // Phone A syncs again -> still does not have it, songs still there
    await syncPhoneA();
    const aAfter = await readStoredLibrary();
    assert.equal(aAfter.setlists.some((entry) => entry.name === "Sync Delete Test"), false, "Phone A still does not have deleted setlist");
    assert.ok(aAfter.songs.some((song) => song.title === "Lantern Road") && aAfter.songs.some((song) => song.title === "Copper Kettle"), "songs stay on Phone A");
  });

  // ---------------------------------------------------------------------------------------------- B16 delete, then a new one
  await check("B16 delete, then a new one", async () => {
    // Phone A creates the newest setlist and both phones sync
    await openNewBuilder();
    await setInputValue('.setlist-builder input[aria-label="Setlist name"]', "Newest Old Set");
    await app.click("Save", `document.querySelector(".setlist-builder")`);
    await app.until(`document.querySelector(".setlist-builder h2")?.textContent?.trim() === "Newest Old Set"`, "Newest Old Set created");
    await app.click("+ Add songs", `document.querySelector(".setlist-builder")`);
    await app.until(`!!document.querySelector(".setlist-picker")`, "picker opens");
    await setInputValue('.setlist-picker input[type="search"]', "Lantern Road");
    await settle(80);
    await s.evaluate(`document.querySelector('.setlist-picker-row input[type="checkbox"]').click()`);
    await app.click("Add", `document.querySelector(".setlist-builder")`);
    await app.until(`!document.querySelector(".setlist-picker")`, "picker closes");
    await closeBuilder();

    const oldId = (await readStoredLibrary()).setlists.find((entry) => entry.name === "Newest Old Set")?.id;
    assert.ok(oldId !== undefined, "Newest Old Set has an id");
    await syncPhoneA();
    await runPhoneB(async (mod) => {
      assert.ok((await mod.syncBackup()).ok);
      assert.ok(mod.loadLibrary().setlists.some((entry) => entry.id === oldId && entry.name === "Newest Old Set"), "Phone B has Newest Old Set");
    });

    // Phone A deletes it and backs up, then makes a new setlist (which reuses oldId) with another name and other songs and backs up
    await openBuilderFor("Newest Old Set");
    await app.click("Delete setlist", `document.querySelector(".setlist-builder")`);
    await app.click("Yes, delete", `document.querySelector(".setlist-builder")`);
    await app.until(`!document.querySelector(".setlist-builder[role=dialog]")`, "deleted Newest Old Set");
    await syncPhoneA();

    await openNewBuilder();
    await setInputValue('.setlist-builder input[aria-label="Setlist name"]', "Fresh Replacement");
    await app.click("Save", `document.querySelector(".setlist-builder")`);
    await app.until(`document.querySelector(".setlist-builder h2")?.textContent?.trim() === "Fresh Replacement"`, "Fresh Replacement created");
    await app.click("+ Add songs", `document.querySelector(".setlist-builder")`);
    await app.until(`!!document.querySelector(".setlist-picker")`, "picker opens");
    for (const title of ["Timberline", "Canyon Echo"]) {
      await setInputValue('.setlist-picker input[type="search"]', title);
      await settle(80);
      await s.evaluate(`document.querySelector('.setlist-picker-row input[type="checkbox"]').click()`);
      await settle(50);
    }
    await app.click("Add", `document.querySelector(".setlist-builder")`);
    await app.until(`!document.querySelector(".setlist-picker")`, "picker closes");
    await closeBuilder();
    await syncPhoneA();

    // Phone B syncs -> shows Fresh Replacement with [Timberline, Canyon Echo] and nothing of Newest Old Set
    const bLib = await runPhoneB(async (mod) => {
      assert.ok((await mod.syncBackup()).ok);
      return mod.loadLibrary();
    });
    assert.equal(bLib.setlists.some((entry) => entry.name === "Newest Old Set"), false, "Phone B has nothing of Newest Old Set");
    const bFresh = bLib.setlists.find((entry) => entry.name === "Fresh Replacement");
    assert.ok(bFresh, "Phone B has Fresh Replacement");
    assert.equal(bFresh.id, oldId, "new setlist reused the deleted newest id");
    assert.deepEqual(
      bFresh.songRefs.map((ref) => bLib.songs.find((song) => song.ref === ref)?.title),
      ["Timberline", "Canyon Echo"],
      "Phone B shows the new songs",
    );

    // Phone A syncs one more time -> shows the same on screen and through the reader
    await syncPhoneA();
    const aLib = await readStoredLibrary();
    assert.equal(aLib.setlists.some((entry) => entry.name === "Newest Old Set"), false, "Phone A has nothing of Newest Old Set");
    assert.deepEqual(await setlistScreenTitles("Fresh Replacement"), ["Timberline", "Canyon Echo"], "Phone A shows Fresh Replacement on screen");
  });

  // ---------------------------------------------------------------------------------------------- B17 a built-in setlist changed
  await check("B17 a built-in setlist changed", async () => {
    const builtInBefore = seedFile.setlists[1]; // id 2: "Biker church"
    await openBuilderFor(builtInBefore.name);
    const beforeTitles = await builderTitles();
    assert.ok(beforeTitles.length >= 3, "built-in setlist has at least 3 songs");

    // Rename it
    await setInputValue('.setlist-builder input[aria-label="Setlist name"]', "Sunday Acoustics");
    await s.evaluate(`document.querySelector('.setlist-builder input[aria-label="Setlist name"]').blur()`);
    await settle(150);

    // Move first song down one place
    await s.evaluate(`(() => {
      const handle = document.querySelectorAll(".setlist-builder .setlist-builder-handle")[0];
      handle.focus();
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    })()`);
    await settle(150);
    const expectedOrder = [beforeTitles[1], beforeTitles[0], ...beforeTitles.slice(2)];
    assert.deepEqual(await builderTitles(), expectedOrder, "built-in setlist reordered");
    await closeBuilder();

    // Holds after reload
    await reloadSetlists();
    assert.deepEqual(await setlistScreenTitles("Sunday Acoustics"), expectedOrder, "renamed and reordered built-in setlist holds after reload");

    // Syncs to Phone B; built-in songs themselves are unchanged
    await syncPhoneA();
    const bLib = await runPhoneB(async (mod) => {
      assert.ok((await mod.syncBackup()).ok);
      return mod.loadLibrary();
    });
    const bBuiltIn = bLib.setlists.find((entry) => entry.id === builtInBefore.id);
    assert.equal(bBuiltIn?.name, "Sunday Acoustics", "Phone B shows renamed built-in setlist");
    assert.deepEqual(
      bBuiltIn?.songRefs.map((ref) => bLib.songs.find((song) => song.ref === ref)?.title),
      expectedOrder,
      "Phone B shows reordered built-in setlist",
    );
    for (const seedSong of seedFile.songs) {
      const bSong = bLib.songs.find((song) => song.id === seedSong.id);
      assert.equal(bSong?.title, seedSong.title, `built-in song ${seedSong.id} unchanged`);
    }
  });

  // ---------------------------------------------------------------------------------------------- B25 a song that arrives while ticked is added once
  await check("B25 a song that arrives while ticked is added once", async () => {
    const pickerSearch = '.setlist-picker input[type="search"]';
    const tickFirst = () => s.evaluate(`document.querySelector('.setlist-picker-row input[type="checkbox"]').click()`);
    await openNewBuilder();
    await setInputValue(nameBox, "Race Set");
    await app.click("Save", `document.querySelector(".setlist-builder")`);
    await app.until(`document.querySelector(".setlist-builder h2")?.textContent?.trim() === "Race Set"`, "Race Set created");
    await app.click("+ Add songs", `document.querySelector(".setlist-builder")`);
    await app.until(`!!document.querySelector(".setlist-picker")`, "the picker opens");
    await setInputValue(pickerSearch, "Copper Kettle");
    await settle(80);
    await tickFirst();
    await settle(50);
    await app.click("Add", `document.querySelector(".setlist-builder")`);
    await app.until(`!document.querySelector(".setlist-picker")`, "the picker closes");
    const raceId = (await readStoredLibrary()).setlists.find((entry) => entry.name === "Race Set")?.id;
    assert.ok(raceId !== undefined, "Race Set has an id");
    await syncPhoneA();
    await runPhoneB(async (mod) => {
      assert.ok((await mod.syncBackup()).ok);
      assert.deepEqual(mod.loadLibrary().setlists.find((entry) => entry.id === raceId)?.songRefs, ["local/802"], "Phone B has Race Set");
    });

    await app.click("+ Add songs", `document.querySelector(".setlist-builder")`);
    await app.until(`!!document.querySelector(".setlist-picker")`, "the picker opens again");
    for (const title of ["Lantern Road", "Windmill Waltz"]) {
      await setInputValue(pickerSearch, title);
      await settle(80);
      await tickFirst();
      await settle(50);
    }
    await setInputValue(pickerSearch, "");
    await runPhoneB(async (mod) => {
      assert.ok(mod.saveOwnSetlist(raceId, "Race Set", ["local/802", "local/801"]), "Phone B adds Lantern Road");
      assert.ok((await mod.syncBackup()).ok);
    });
    await syncPhoneA();
    await app.until(
      `(() => {
        const row = [...document.querySelectorAll(".setlist-picker-row")].find((el) => el.querySelector(".song-title")?.textContent?.trim() === "Lantern Road");
        return !!row && row.textContent.includes("Already in this setlist");
      })()`,
      "Lantern Road arrives from Phone B while it is ticked",
    );
    await app.click("Add", `document.querySelector(".setlist-builder")`);
    await app.until(`!document.querySelector(".setlist-picker")`, "the picker closes after Add");
    assert.deepEqual(await builderTitles(), ["Copper Kettle", "Lantern Road", "Windmill Waltz"], "Lantern Road is in the setlist once");
    await closeBuilder();
    await reloadSetlists();
    assert.deepEqual((await storedSetlist(raceId))?.songRefs, ["local/802", "local/801", "local/804"], "Race Set through the reader after a reload");
  });

  // ---------------------------------------------------------------------------------------------- B28 a sync in the middle of a drag moves nothing
  await check("B28 a sync in the middle of a drag moves nothing", async () => {
    const raceId = (await readStoredLibrary()).setlists.find((entry) => entry.name === "Race Set")?.id;
    assert.ok(raceId !== undefined, "Race Set is there from B25");
    await syncPhoneA();
    await runPhoneB(async (mod) => {
      assert.ok((await mod.syncBackup()).ok);
      assert.deepEqual(mod.loadLibrary().setlists.find((entry) => entry.id === raceId)?.songRefs, ["local/802", "local/801", "local/804"], "Phone B starts from Phone A's order");
    });

    await openBuilderFor("Race Set");
    assert.deepEqual(await builderTitles(), ["Copper Kettle", "Lantern Road", "Windmill Waltz"], "Race Set opens in its stored order");
    const first = await rowCenter(0);
    const lifted = await rowCenter(2);
    await touchStart(lifted.x, lifted.y);
    try {
      await sleep(600);
      for (let step = 1; step <= 10; step += 1) {
        await touchMove(lifted.x, lifted.y + ((first.top - 10 - lifted.y) * step) / 10);
        await sleep(20);
      }
      assert.deepEqual(await builderTitles(), ["Windmill Waltz", "Copper Kettle", "Lantern Road"], "Windmill Waltz is lifted above the first row");

      await runPhoneB(async (mod) => {
        assert.ok(mod.saveOwnSetlist(raceId, "Race Set", ["local/804", "local/802", "local/801"]), "Phone B puts Windmill Waltz first");
        assert.ok((await mod.syncBackup()).ok);
      });
      await syncPhoneA();
      await app.until(
        `JSON.stringify(JSON.parse(localStorage.getItem("leadSheetsLibraryV2")).setlists.find((each) => each.id === ${raceId})?.songIds) === "[804,802,801]"`,
        "Phone B's order reaches Phone A while the finger is still down",
      );
      await settle(100);
      assert.deepEqual(await builderTitles(), ["Windmill Waltz", "Copper Kettle", "Lantern Road"], "the screen shows Phone B's order, with no lifted row");
      assert.equal(await s.evaluate<number>(`document.querySelectorAll(".setlist-builder .is-dragging").length`), 0, "the sync puts the lifted row down");
    } finally {
      await touchEnd();
      await settle(150);
    }
    assert.deepEqual(await builderTitles(), ["Windmill Waltz", "Copper Kettle", "Lantern Road"], "letting go after the sync moves no song");
    assert.deepEqual((await storedSetlist(raceId))?.songRefs, ["local/804", "local/802", "local/801"], "letting go after the sync saves nothing");
    await closeBuilder();
    await reloadSetlists();
    assert.deepEqual(await setlistScreenTitles("Race Set"), ["Windmill Waltz", "Copper Kettle", "Lantern Road"], "Race Set after a reload");
  });

  // ---------------------------------------------------------------------------------------------- B29 a list filled by a sync can be dragged
  await check("B29 a list filled by a sync can be dragged", async () => {
    await openNewBuilder();
    await setInputValue(nameBox, "Filled Later");
    await app.click("Save", `document.querySelector(".setlist-builder")`);
    await app.until(`document.querySelector(".setlist-builder h2")?.textContent?.trim() === "Filled Later"`, "Filled Later created");
    const fillId = (await readStoredLibrary()).setlists.find((entry) => entry.name === "Filled Later")?.id;
    assert.ok(fillId !== undefined, "Filled Later has an id");
    assert.ok((await app.text(".setlist-builder")).includes("No songs yet."), "the new setlist starts empty");
    await syncPhoneA();
    await runPhoneB(async (mod) => {
      assert.ok((await mod.syncBackup()).ok);
      assert.ok(mod.saveOwnSetlist(fillId, "Filled Later", ["local/805", "local/806", "local/807"]), "Phone B fills Filled Later");
      assert.ok((await mod.syncBackup()).ok);
    });
    await syncPhoneA();
    await app.until(`document.querySelectorAll(".setlist-builder [data-builder-row]").length === 3`, "Phone B's songs appear in the open builder");
    assert.deepEqual(await builderTitles(), ["Rain on Tin", "Morning Freight", "Timberline"], "the open builder shows Phone B's songs");

    const first = await rowCenter(0);
    await holdAndDrag(2, first.top - 10, { holdMs: 600 });
    assert.deepEqual(await builderTitles(), ["Timberline", "Rain on Tin", "Morning Freight"], "the third song drags to the top");
    assert.deepEqual((await storedSetlist(fillId))?.songRefs, ["local/807", "local/805", "local/806"], "the drag is saved");
    await closeBuilder();
    await reloadSetlists();
    assert.deepEqual(await setlistScreenTitles("Filled Later"), ["Timberline", "Rain on Tin", "Morning Freight"], "Filled Later after a reload");
  });

  // ---------------------------------------------------------------------------------------------- B30 a rename from another phone keeps a name being typed
  await check("B30 a rename from another phone keeps a name being typed", async () => {
    const fillId = (await readStoredLibrary()).setlists.find((entry) => entry.name === "Filled Later")?.id;
    assert.ok(fillId !== undefined, "Filled Later is there from B29");
    const nameValue = () => s.evaluate<string>(`document.querySelector(${js(nameBox)})?.value ?? ""`);
    const renameOnPhoneB = async (name: string) => {
      await runPhoneB(async (mod) => {
        assert.ok((await mod.syncBackup()).ok);
        const refs = mod.loadLibrary().setlists.find((entry) => entry.id === fillId)?.songRefs;
        assert.ok(refs && refs.length === 3, `Phone B holds Filled Later (${js(refs)})`);
        assert.ok(mod.saveOwnSetlist(fillId, name, refs), `Phone B renames it ${name}`);
        assert.ok((await mod.syncBackup()).ok);
      });
      await syncPhoneA();
      await app.until(
        `JSON.parse(localStorage.getItem("leadSheetsLibraryV2")).setlists.find((each) => each.id === ${fillId})?.name === ${js(name)}`,
        `Phone B's name ${name} reaches Phone A`,
      );
      await settle(150);
    };

    // 1. Not typing: Phone B's rename shows in the open builder
    await syncPhoneA();
    await openBuilderFor("Filled Later");
    await renameOnPhoneB("Filled Again");
    assert.equal(await nameValue(), "Filled Again", "with the name box left alone, Phone B's rename shows");

    // 1b. Focused but nothing typed: Phone B's rename still shows, and leaving the box keeps B's name
    await s.evaluate(`document.querySelector(${js(nameBox)}).focus()`);
    await renameOnPhoneB("Filled Twice");
    assert.equal(await nameValue(), "Filled Twice", "with the name box focused but untouched, Phone B's rename shows");
    await s.evaluate(`document.querySelector(${js(nameBox)}).blur()`);
    await settle(150);
    assert.equal((await storedSetlist(fillId))?.name, "Filled Twice", "leaving an untouched box keeps Phone B's name");
    await renameOnPhoneB("Filled Again");

    // 2. Typing: Phone A's half-typed name stays in the box and in focus while Phone B's rename arrives
    await s.evaluate(`(() => {
      const el = document.querySelector(${js(nameBox)});
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    })()`);
    for (const ch of [" ", "L", "i", "v", "e"]) {
      await s.send("Input.insertText", { text: ch });
      await settle(30);
    }
    assert.equal(await nameValue(), "Filled Again Live", "Phone A has typed its new name");
    await renameOnPhoneB("Filled Third");
    const afterB = await s.evaluate<{ value: string; focus: string }>(`(() => {
      const a = document.activeElement;
      return { value: document.querySelector(${js(nameBox)})?.value ?? "", focus: a ? a.tagName + "." + a.className + (a.getAttribute("aria-label") ? "[" + a.getAttribute("aria-label") + "]" : "") : "none" };
    })()`);
    assert.equal(afterB.value, "Filled Again Live", `a rename from Phone B does not replace the name Phone A is typing (${js(afterB)})`);
    assert.equal(
      await s.evaluate<boolean>(`document.activeElement === document.querySelector(${js(nameBox)})`),
      true,
      "the name box keeps focus",
    );

    // 3. Leaving the box saves what Phone A typed
    await s.evaluate(`document.querySelector(${js(nameBox)}).blur()`);
    await settle(150);
    assert.equal((await storedSetlist(fillId))?.name, "Filled Again Live", "leaving the box saves the typed name");
    assert.equal(await s.evaluate<string>(`document.querySelector(".setlist-builder h2")?.textContent?.trim() ?? ""`), "Filled Again Live", "the heading shows the saved name");
    await closeBuilder();
    await reloadSetlists();
    assert.ok(await s.evaluate<boolean>(`!!document.querySelector('section.setlist[aria-label="Filled Again Live"]')`), "the typed name holds after a reload");
  });

  // ---------------------------------------------------------------------------------------------- B13 signed out, and a shared phone
  await check("B13 signed out, and a shared phone", async () => {
    // 1. Signed out on Chrome: make a setlist, add 2 songs, reorder, reload, with no sign-in asked
    if (await s.evaluate<boolean>(`!!localStorage.getItem("leadSheetsBackupV2")`)) {
      await app.openMenu();
      await app.pick("Account");
      await app.until(`document.querySelector(".account-sheet")?.dataset.step === "account"`, "account sheet");
      await app.click("Sign out", `document.querySelector(".account-sheet")`);
      await app.until(`!localStorage.getItem("leadSheetsBackupV2")`, "signed out");
      await s.evaluate(`document.querySelector(".account-sheet .account-close")?.click()`);
      await app.closeMenu();
      await phone360();
    }

    await openNewBuilder();
    await setInputValue('.setlist-builder input[aria-label="Setlist name"]', "Offline Porch");
    await app.click("Save", `document.querySelector(".setlist-builder")`);
    await app.until(`document.querySelector(".setlist-builder h2")?.textContent?.trim() === "Offline Porch"`, "signed-out setlist made");
    await app.click("+ Add songs", `document.querySelector(".setlist-builder")`);
    await app.until(`!!document.querySelector(".setlist-picker")`, "picker opens signed out");
    for (const title of ["Lantern Road", "Copper Kettle"]) {
      await setInputValue('.setlist-picker input[type="search"]', title);
      await settle(80);
      await s.evaluate(`document.querySelector('.setlist-picker-row input[type="checkbox"]').click()`);
      await settle(50);
    }
    await app.click("Add", `document.querySelector(".setlist-builder")`);
    await app.until(`!document.querySelector(".setlist-picker")`, "picker closes");
    const r0 = await rowCenter(0);
    await holdAndDrag(1, r0.top - 10, { holdMs: 600 });
    assert.deepEqual(await builderTitles(), ["Copper Kettle", "Lantern Road"], "signed-out reorder works");
    assert.equal(await s.evaluate<boolean>(`!!document.querySelector(".account-sheet")`), false, "no sign-in asked signed out");
    await closeBuilder();

    await reloadSetlists();
    assert.deepEqual(await setlistScreenTitles("Offline Porch"), ["Copper Kettle", "Lantern Road"], "signed-out setlist holds after reload");

    // 2. Per-account isolation on a shared phone (MY_SONGS_PER_ACCOUNT="1", like check-library-consistency.ts)
    const perAcc = await startApi({ MY_SONGS_PER_ACCOUNT: "1" });
    try {
      const sharedStore = new FakeStorage();
      const mod = await loadStorageBackup();
      const useShared = (phone: Phone) => {
        Object.defineProperty(globalThis, "localStorage", { value: sharedStore, configurable: true });
        Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }, configurable: true });
        globalThis.fetch = async (path, init) => {
          const headers = { ...(init?.headers as Record<string, string>), origin: TEST_ORIGIN, ...(phone.cookie ? { cookie: phone.cookie } : {}) };
          return realFetch(new URL(String(path), perAcc.base), { ...init, headers });
        };
      };
      const prevStore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
      const prevNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
      try {
        const phoneA = new Phone(perAcc.base);
        const userA = (await phoneA.createAccount("Account A")).body.account.userId as string;
        useShared(phoneA);
        mod.loadLibrary();
        mod.backupOn(userA);
        assert.ok((await mod.syncBackup()).ok);
        const madeId = mod.addOwnSetlist({ name: "Account A Secret Set", songIds: [1, 2] });
        assert.ok(madeId !== null, "Account A makes a setlist");
        assert.ok((await mod.syncBackup()).ok);
        assert.ok(mod.loadLibrary().setlists.some((entry) => entry.name === "Account A Secret Set"), "Account A sees its own setlist");

        // Account A signs out, Account B signs in on the same shared phone
        mod.backupOff();
        await phoneA.call("/api/auth/sign-out", {});

        const phoneB2 = new Phone(perAcc.base);
        const userB = (await phoneB2.createAccount("Account B")).body.account.userId as string;
        useShared(phoneB2);
        mod.backupOn(userB);
        assert.ok((await mod.syncBackup()).ok);
        const bVisible = mod.loadLibrary().setlists.map((entry) => entry.name);
        assert.equal(bVisible.includes("Account A Secret Set"), false, `Account B never sees Account A's setlist (${js(bVisible)})`);
      } finally {
        globalThis.fetch = realFetch;
        if (prevStore) Object.defineProperty(globalThis, "localStorage", prevStore);
        if (prevNav) Object.defineProperty(globalThis, "navigator", prevNav);
      }
    } finally {
      await perAcc.worker.dispose();
    }
  });

  // ---------------------------------------------------------------------------------------------- B24 no setlists yet
  await check("B24 no setlists yet", async () => {
    const harness = await build({
      stdin: {
        contents: `
          import { createElement } from "react";
          import { createRoot } from "react-dom/client";
          import { SetlistList } from "./src/library-lists.tsx";
          window.__mountEmptySetlists = () => {
            const host = document.createElement("div");
            host.id = "empty-setlists";
            host.className = "app";
            document.body.append(host);
            const reactRoot = createRoot(host);
            reactRoot.render(createElement(SetlistList, { setlists: [], songs: [] }));
            window.__unmountEmptySetlists = () => {
              reactRoot.unmount();
              host.remove();
            };
          };`,
        resolveDir: root,
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      logLevel: "silent",
      loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await s.evaluate(`${harness.outputFiles[0].text}; window.__mountEmptySetlists(); true`);
    try {
      await app.until(`!!document.querySelector("#empty-setlists [role=status]")`, "the empty Setlists screen");
      const seen = await s.evaluate<{ lines: string[]; buttons: string[]; setlists: number }>(`(() => {
        const host = document.getElementById("empty-setlists");
        return {
          lines: [...host.querySelectorAll("[role=status]")].map((el) => el.textContent.trim()),
          buttons: [...host.querySelectorAll("button")].map((b) => b.textContent.trim()),
          setlists: host.querySelectorAll("section.setlist").length,
        };
      })()`);
      assert.deepEqual(seen.lines, ["No setlists yet."], "the screen says there are no setlists yet");
      assert.ok(seen.buttons.includes("+ New setlist"), `+ New setlist is offered (${js(seen.buttons)})`);
      assert.equal(seen.setlists, 0, "no setlist sections");
    } finally {
      await s.evaluate(`window.__unmountEmptySetlists?.(); true`);
    }
  });

  // Page errors check
  if (failed === 0) {
    const pageErrors = await app.errors();
    assert.deepEqual(pageErrors, [], `page raised no errors (${js(pageErrors)})`);
  }
} finally {
  await site.close();
  await worker.dispose();
}

if (failed > 0) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
