import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ChordProStoredSong } from "../src/storage.ts";
import type { Song } from "../src/types.ts";
import { startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/**
 * List rows and Import files row (Plan 6, cook 1): cases R1 to R10 at 360 px wide.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const NEW_SHAPE = { "x-song-shape": "chordpro" } as const;
const js = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

let failed = 0;
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

type StorageMod = {
  songToStored: (song: Omit<Song, "ref">) => ChordProStoredSong;
  songFromStored: (stored: ChordProStoredSong) => Song;
};

const storageBundle = await build({
  entryPoints: [join(root, "src", "storage.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  logLevel: "silent",
});
const storageMod = (await import(
  `data:text/javascript;base64,${Buffer.from(storageBundle.outputFiles[0].text).toString("base64")}`
)) as StorageMod;

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

const LONG_TITLE = "Down by the Old Lighthouse on the Windy Eastern Harbor Point";
assert.equal(LONG_TITLE.length, 60, "test 60-char title length");

const LOCAL_SONGS = [
  makeSong(901, { title: "Cedar Creek", artist: "Maple Trio", keyRoot: "A", keyMode: "major", keyLabel: "A major", tempo: 96 }),
  makeSong(902, {
    title: "Silver Lantern",
    artist: "Harbor Folk",
    keyRoot: "G",
    keyMode: "major",
    keyLabel: "G major",
    tempo: 112,
    copy: { id: "copy-friend-902", canSendOn: true, from: { name: "Dana" } },
  }),
  makeSong(903, { title: "Driftwood Waltz", artist: "Pine Quartet", keyRoot: "D", keyMode: "minor", keyLabel: "D minor", tempo: null }),
  makeSong(904, { title: "Solo Instrumental", artist: "", keyRoot: "E", keyMode: "major", keyLabel: "E major", tempo: 88 }),
  makeSong(905, { title: "Open Sky", artist: "", keyRoot: "C", keyMode: "major", keyLabel: "C major", tempo: null }),
  makeSong(906, { title: "River Bend", artist: "North Band", keyRoot: "A", keyMode: "major", keyLabel: "A major", tempo: 96 }),
  makeSong(907, { title: "River Bend", artist: "South Duo", keyRoot: "D", keyMode: "minor", keyLabel: "D minor", tempo: 120 }),
  makeSong(908, { title: "Don't Look Back", artist: "O'Connor", keyRoot: "G", keyMode: "major", keyLabel: "G major", tempo: 104 }),
  makeSong(909, { title: "“Midnight” Café", artist: "The ’90s Trio", keyRoot: "F", keyMode: "major", keyLabel: "F major", tempo: 92 }),
  makeSong(910, { title: LONG_TITLE, artist: "The Harbor Collective", keyRoot: "Bb", keyMode: "major", keyLabel: "Bb major", tempo: 110 }),
  makeSong(911, { title: "Half Time Creek", artist: "Pat Bass", keyRoot: "C", keyMode: "major", keyLabel: "C major", tempo: 152 }),
];

const LOCAL_SETLISTS = [
  { id: 901, name: "Friday Porch", songIds: [901, 903, 904, 905, 908, 909, 910, 911, 9999] },
  { id: 902, name: "Twin Titles", songIds: [906, 907] },
];

const CASE_NAMES = [
  "R1 My Songs row",
  "R2 My Songs search",
  "R3 setlist row",
  "R4 no tempo",
  "R5 band Songs list",
  "R6 band setlist",
  "R7 same title, two songs",
  "R8 odd titles at 360 px",
  "R9 the two buttons",
  "R10 the tempo the player set",
] as const;

const stateDir = mkdtempSync(join(tmpdir(), "check-list-rows-state-"));
let apiBase = "";
let site: Awaited<ReturnType<typeof openSite>> | null = null;
let api: Awaited<ReturnType<typeof startApi>> | null = null;

try {
  site = await openSite(root, "check-list-rows", () => apiBase);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  const workerEnv = { APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER };
  api = await startApi(workerEnv, stateDir);
  apiBase = api.base;
} catch (error) {
  for (const name of CASE_NAMES) {
    failed += 1;
    console.log(`FAIL ${name}: app or Worker did not start (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
  }
  await site?.close();
  await api?.worker.dispose();
  rmSync(stateDir, { recursive: true, force: true });
  process.exit(1);
}

try {
  const s = site;
  const origin = s.origin.replace("127.0.0.1", "localhost");
  const workerEnv = { APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER };
  const app = await appPage(s);
  const phone360 = async () => {
    await s.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
    await s.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`);
  };
  await phone360();

  const terry = await passwordPlayer(api.base, origin, "Terry Bass", "terrybass");
  const withSqlite = async <T>(work: (files: string[]) => T): Promise<T> => {
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
      Object.assign(terry, { base: api.base });
    }
  };

  const appCalls = (path: string, body: object) =>
    s.evaluate<{ status: number; body: Record<string, any> }>(
      `fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json", "x-song-shape": "chordpro" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`,
    );

  const shareBandSong = async (bandId: string, song: Omit<Song, "ref">, choice: "public" | "private") => {
    const stored = storageMod.songToStored(song);
    const res = await terry.call("/api/bands/library/share-song", { bandId, song: { chordpro: stored.chordpro }, choice, localId: null }, NEW_SHAPE);
    assert.equal(res.status, 200, `share ${song.title} (${js(res.body)})`);
    return res.body.songId as string;
  };

  const bandId = (await terry.call("/api/bands/create", { name: "The Low Tides" })).body.bandId as string;
  const bandCode = (await terry.call("/api/codes", { kind: "band", bandId })).body.code as string;
  const harborId = await shareBandSong(
    bandId,
    makeSong(0, { title: "Harbor Fog", artist: "Terry Bass", keyRoot: "A", keyMode: "major", keyLabel: "A major", tempo: 96 }),
    "public",
  );
  const pierId = await shareBandSong(
    bandId,
    makeSong(0, { title: "Pier Lights", artist: "Terry Bass", keyRoot: "D", keyMode: "minor", keyLabel: "D minor", tempo: null }),
    "private",
  );
  const removedId = await shareBandSong(
    bandId,
    makeSong(0, { title: "Old Wharf", artist: "Terry Bass", keyRoot: "G", keyMode: "major", keyLabel: "G major", tempo: 108 }),
    "public",
  );
  const baySet = await terry.call("/api/bands/library/share-setlist", {
    bandId,
    name: "Bay Set",
    songIds: [harborId, pierId, removedId],
    tags: [],
    choice: "public",
    localId: null,
  });
  assert.equal(baySet.status, 200, `share Bay Set (${js(baySet.body)})`);
  const baySetlistId = baySet.body.setlistId as string;

  await s.send("Page.navigate", { url: `${origin}/#/songs` });
  await app.library();

  const storedSongs = LOCAL_SONGS.map((song) => storageMod.songToStored(song));
  await s.evaluate(`(() => {
    const lib = JSON.parse(localStorage.getItem("leadSheetsLibraryV2") || "{}");
    const ids = new Set(${js(LOCAL_SONGS.map((song) => song.id))});
    const setIds = new Set(${js(LOCAL_SETLISTS.map((set) => set.id))});
    lib.songs = [...(lib.songs || []).filter((each) => !ids.has(each.id)), ...${js(storedSongs)}];
    lib.setlists = [...(lib.setlists || []).filter((each) => !setIds.has(each.id)), ...${js(LOCAL_SETLISTS)}];
    lib.lastSongId = Math.max(lib.lastSongId || 0, 911);
    localStorage.setItem("leadSheetsLibraryV2", JSON.stringify(lib));
  })()`);
  await s.send("Page.reload");
  await app.library();
  await phone360();

  const typeSearch = async (text: string) => {
    const box = `document.querySelector('input[aria-label="Search songs"]')`;
    await app.until(`!!${box}`, "Search songs box");
    await s.evaluate(`(() => {
      const el = ${box};
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.focus();
    })()`);
    if (text) {
      await settle(50);
      await s.send("Input.insertText", { text });
    }
    await settle(150);
  };

  type RowInfo = { text: string; title: string; artist: string; meta: string | null; key: string | null; copy: string | null };
  const songRows = (scope = ".song-list") =>
    s.evaluate<RowInfo[]>(`[...document.querySelectorAll(${js(`${scope} .song-row`)})].map((el) => ({
      text: el.textContent ?? "",
      title: el.querySelector(".song-title")?.textContent ?? "",
      artist: el.querySelector(".song-artist")?.textContent ?? "",
      meta: el.querySelector(".song-meta")?.textContent ?? null,
      key: el.querySelector(".song-key")?.textContent ?? null,
      copy: el.querySelector(".song-copy-note")?.textContent ?? null,
    }))`);

  // ---------------------------------------------------------------------------------------------- R1
  await check("R1 My Songs row", async () => {
    await s.evaluate(`location.hash = "#/songs"`);
    await app.until(`document.querySelectorAll(".song-list .song-row").length >= 11`, "seeded My Songs rows");
    const rows = await songRows();
    const cedar = rows.find((r) => r.title === "Cedar Creek");
    assert.ok(cedar, "Cedar Creek row is drawn");
    assert.equal(cedar.artist, "Maple Trio", "Cedar Creek artist is drawn");
    assert.equal(cedar.meta, null, "Cedar Creek has no .song-meta");
    assert.ok(!cedar.text.includes("A major") && !cedar.text.includes("bpm") && !cedar.text.includes("Tempo"), `no key/tempo on Cedar Creek (${js(cedar.text)})`);

    const copy = rows.find((r) => r.title === "Silver Lantern");
    assert.ok(copy, "Silver Lantern copy row is drawn");
    assert.equal(copy.artist, "Harbor Folk", "Silver Lantern artist is drawn");
    assert.ok((copy.copy ?? "").includes("From Dana"), `copy shows From Dana (${js(copy.copy)})`);
    assert.ok(!copy.text.includes("G major") && !copy.text.includes("bpm") && !copy.text.includes("Tempo"), `no key/tempo on copy (${js(copy.text)})`);
  });

  // Sign up Sam and join The Low Tides, then visit band Songs so bandSongs caches Harbor Fog & Pier Lights for R2
  await app.signUp("Sam Rivera");
  await phone360();
  const me = await s.evaluate<{ userId: string }>(`fetch("/api/me").then((r) => r.json()).then((r) => r.account)`);
  assert.equal((await appCalls("/api/bands/join", { code: bandCode })).status, 200, "Sam joins The Low Tides");

  await s.evaluate(`location.hash = ${js(`#/band/${bandId}?s=songs`)}`);
  await app.until(`document.querySelectorAll(".band-library-songs li").length === 3`, "band Songs loaded");
  await settle(250);

  // ---------------------------------------------------------------------------------------------- R2
  await check("R2 My Songs search", async () => {
    await s.evaluate(`location.hash = "#/songs"`);
    await typeSearch("cedar");
    await app.until(`document.querySelectorAll(".search-group .song-row").length >= 1`, "search match for cedar");
    const cedarRows = await songRows(".search-group");
    const cedar = cedarRows.find((r) => r.title === "Cedar Creek");
    assert.ok(cedar, "Cedar Creek in search results");
    assert.equal(cedar.artist, "Maple Trio", "Cedar Creek artist in search results");
    assert.ok(!cedar.text.includes("A major") && !cedar.text.includes("bpm") && !cedar.text.includes("Tempo"), `no key/tempo in search (${js(cedar.text)})`);

    // Held band song in search results follows My Songs rule
    await typeSearch("harbor fog");
    await app.until(`[...document.querySelectorAll(".search-group .song-title")].some((t) => t.textContent === "Harbor Fog")`, "Harbor Fog in search");
    const bandMatch = (await songRows(".search-group")).find((r) => r.title === "Harbor Fog");
    assert.ok(bandMatch, "Harbor Fog found in My Songs search");
    assert.equal(bandMatch.artist, "Terry Bass", "Harbor Fog artist in search");
    assert.ok(!bandMatch.text.includes("A major") && !bandMatch.text.includes("bpm") && !bandMatch.text.includes("Tempo"), `no key/tempo on band search row (${js(bandMatch.text)})`);

    // Key filter chips still narrow the list
    await typeSearch("creek");
    await app.until(`[...document.querySelectorAll(".search-group .song-title")].length >= 2`, "both Creek songs");
    const beforeChip = (await songRows(".search-group")).map((r) => r.title);
    assert.ok(beforeChip.includes("Cedar Creek") && beforeChip.includes("Half Time Creek"), `before key chip: ${js(beforeChip)}`);
    await s.evaluate(`(() => {
      const sel = document.querySelector('.search-chips select[aria-label="Key"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, "A");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await settle(100);
    const afterChip = await songRows(".search-group");
    assert.deepEqual(afterChip.map((r) => r.title), ["Cedar Creek"], "key chip A narrows list to Cedar Creek");
    assert.ok(!afterChip[0].text.includes("A major") && !afterChip[0].text.includes("bpm") && !afterChip[0].text.includes("Tempo"), "chip-filtered row has no key/tempo");
    await s.evaluate(`(() => {
      const sel = document.querySelector('.search-chips select[aria-label="Key"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, "");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await typeSearch("");
  });

  type SetlistRowInfo = { num: string; text: string; title: string; artist: string; hasArtist: boolean; meta: string | null; key: string | null };
  const setlistRows = (setlistName: string) =>
    s.evaluate<SetlistRowInfo[]>(`[...(document.querySelector(${js(`.setlist[aria-label="${setlistName}"]`)})?.querySelectorAll("li") ?? [])].map((li) => ({
      num: li.querySelector(".setlist-num")?.textContent?.trim() ?? "",
      text: li.textContent ?? "",
      title: li.querySelector(".song-title")?.textContent ?? "",
      artist: li.querySelector(".song-artist")?.textContent ?? "",
      hasArtist: !!li.querySelector(".song-artist"),
      meta: li.querySelector(".song-meta")?.textContent ?? null,
      key: li.querySelector(".song-key")?.textContent ?? null,
    }))`);

  // ---------------------------------------------------------------------------------------------- R3
  await check("R3 setlist row", async () => {
    await s.evaluate(`location.hash = "#/setlists"`);
    await app.until(`!!document.querySelector('.setlist[aria-label="Friday Porch"] .setlist-row')`, "Friday Porch setlist");
    const rows = await setlistRows("Friday Porch");
    const first = rows[0];
    assert.ok(first, "first setlist row present");
    assert.equal(first.num, "1", "row number 1");
    assert.equal(first.title, "Cedar Creek", "title");
    assert.equal(first.artist, "Maple Trio", "artist");
    assert.equal(first.key, "A major", "key");
    assert.ok((first.meta ?? "").includes("A major") && (first.meta ?? "").includes("~96 bpm"), `facts line (${js(first.meta)})`);
    const missing = rows.at(-1);
    assert.ok(missing && missing.text.includes("Missing from this library"), "missing song keeps its message");
    assert.equal(missing.meta, null, "missing song shows no facts");
  });

  // ---------------------------------------------------------------------------------------------- R4
  await check("R4 no tempo", async () => {
    await s.evaluate(`location.hash = "#/setlists"`);
    await app.until(`!!document.querySelector('.setlist[aria-label="Friday Porch"] .setlist-row')`, "Friday Porch setlist");
    const rows = await setlistRows("Friday Porch");
    const waltz = rows.find((r) => r.title === "Driftwood Waltz");
    assert.ok(waltz, "Driftwood Waltz row");
    assert.equal(waltz.artist, "Pine Quartet", "Driftwood Waltz artist");
    assert.equal(waltz.key, "D minor", "Driftwood Waltz key");
    assert.equal(waltz.meta, "D minor", `no-tempo facts line shows key alone (${js(waltz.meta)})`);
    assert.ok(!/bpm|tempo|—|-|·\s*$/i.test(waltz.meta ?? ""), `no dash/bpm/Tempo/trailing dot in (${js(waltz.meta)})`);

    const solo = rows.find((r) => r.title === "Solo Instrumental");
    assert.ok(solo, "Solo Instrumental row");
    assert.equal(solo.hasArtist, false, "no empty artist element");
    assert.equal(solo.meta, "E major · ~88 bpm", `no-artist facts line (${js(solo.meta)})`);
    assert.ok(!solo.text.includes("—") && !solo.text.includes("-"), `no stray dash on no-artist row (${js(solo.text)})`);

    const openSky = rows.find((r) => r.title === "Open Sky");
    assert.ok(openSky, "Open Sky row");
    assert.equal(openSky.hasArtist, false, "Open Sky has no artist element");
    assert.equal(openSky.meta, "C major", `no-artist no-tempo facts line (${js(openSky.meta)})`);
  });

  // ---------------------------------------------------------------------------------------------- R5
  await check("R5 band Songs list", async () => {
    await s.evaluate(`location.hash = ${js(`#/band/${bandId}?s=songs`)}`);
    await app.until(`document.querySelectorAll(".band-library-songs li").length === 3`, "band Songs list");
    await phone360();
    type BandSongRow = {
      text: string;
      name: string;
      artist: string;
      meta: string | null;
      key: string | null;
      hasLock: boolean;
      rowRect: { top: number; bottom: number; right: number };
      lockRect: { top: number; bottom: number; right: number } | null;
      pageScroll: number;
      inner: number;
    };
    const rows = await s.evaluate<BandSongRow[]>(`[...document.querySelectorAll(".band-library-songs li")].map((li) => {
      const btn = li.querySelector(".band-library-row");
      const lock = li.querySelector("[aria-label='Private']");
      const br = btn.getBoundingClientRect();
      const lr = lock?.getBoundingClientRect();
      return {
        text: li.textContent ?? "",
        name: li.querySelector(".band-library-name")?.textContent?.trim() ?? "",
        artist: li.querySelector(".song-artist")?.textContent ?? "",
        meta: li.querySelector(".song-meta")?.textContent ?? null,
        key: li.querySelector(".song-key")?.textContent ?? null,
        hasLock: !!lock,
        rowRect: { top: br.top, bottom: br.bottom, right: br.right },
        lockRect: lr ? { top: lr.top, bottom: lr.bottom, right: lr.right } : null,
        pageScroll: document.documentElement.scrollWidth,
        inner: innerWidth,
      };
    })`);

    const harbor = rows.find((r) => r.name === "Harbor Fog");
    assert.ok(harbor, "Harbor Fog in band Songs");
    assert.equal(harbor.artist, "Terry Bass", "Harbor Fog artist");
    assert.equal(harbor.meta, "A major · ~96 bpm", `Harbor Fog facts (${js(harbor.meta)})`);
    assert.ok(harbor.text.includes("Shared by Terry Bass"), `Harbor Fog sharer (${js(harbor.text)})`);
    assert.ok(harbor.pageScroll <= harbor.inner + 0.5, `band Songs fits 360px (${harbor.pageScroll} <= ${harbor.inner})`);

    const pier = rows.find((r) => r.name === "Pier Lights");
    assert.ok(pier, "Pier Lights in band Songs");
    assert.equal(pier.artist, "Terry Bass", "Pier Lights artist");
    assert.equal(pier.meta, "D minor", `Pier Lights no-tempo facts (${js(pier.meta)})`);
    assert.ok(pier.text.includes("Shared by Terry Bass · Private"), `Pier Lights sharer (${js(pier.text)})`);
    assert.ok(pier.hasLock && pier.lockRect, "Private lock present");
    assert.ok(pier.lockRect.top < pier.rowRect.bottom && pier.lockRect.right <= 360.5, `lock lines up inside 360px (${js(pier)})`);
  });

  // ---------------------------------------------------------------------------------------------- R6
  await check("R6 band setlist", async () => {
    await s.evaluate(`location.hash = "#/songs"`);
    await settle(100);
    const deleted = await withSqlite((files) => {
      let count = 0;
      for (const file of files) {
        const db = new DatabaseSync(file);
        try {
          const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'band_songs'`).get();
          if (!has) continue;
          count += Number(db.prepare(`DELETE FROM band_songs WHERE song_id = ?`).run(removedId).changes);
        } finally {
          db.close();
        }
      }
      return count;
    });
    assert.equal(deleted, 1, "removed Old Wharf from band_songs");

    const planned = await terry.call("/api/bands/gig/plan", {
      bandId,
      setlistId: baySetlistId,
      gigId: `gig_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`,
      name: "Harbor Night",
      date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      lineup: [terry.userId, me.userId],
      leader: terry.userId,
    });
    assert.equal(planned.status, 200, `Terry plans Harbor Night (${js(planned.body)})`);

    await s.evaluate(`location.hash = ${js(`#/band/${bandId}?s=setlists`)}`);
    await app.until(
      `[...document.querySelectorAll(".band-library-setlists .band-library-name")].some((el) => el.textContent.trim() === "Bay Set")`,
      "Bay Set in band Setlists",
      15000,
    );
    await s.evaluate(`[...document.querySelectorAll(".band-library-setlists .band-library-row")].find((b) => b.querySelector(".band-library-name")?.textContent.trim() === "Bay Set").click()`);
    await app.until(`document.querySelector(".band-page")?.dataset.view === "setlist" && document.querySelectorAll(".band-setlist-songs li").length === 3`, "Bay Set view", 15000);

    // Lineup phone downloads the gig pack automatically (or tap Download if still shown), so Downloaded ✓ shows on rows 0 and 1
    await app.until(
      `[...document.querySelectorAll(".band-setlist-songs li")].slice(0, 2).every((li) => li.textContent.includes("Downloaded ✓"))`,
      "Downloaded ✓ on each remaining song in Bay Set",
      15000,
    );

    const rows = await s.evaluate<{ text: string; name: string; artist: string; meta: string | null }[]>(
      `[...document.querySelectorAll(".band-setlist-songs li")].map((li) => ({
        text: li.textContent ?? "",
        name: li.querySelector(".band-library-name")?.textContent?.trim() ?? "",
        artist: li.querySelector(".song-artist")?.textContent ?? "",
        meta: li.querySelector(".song-meta")?.textContent ?? null,
      }))`,
    );
    assert.equal(rows.length, 3, "three rows in Bay Set");
    assert.equal(rows[0].name, "Harbor Fog");
    assert.equal(rows[0].artist, "Terry Bass");
    assert.equal(rows[0].meta, "A major · ~96 bpm");
    assert.ok(rows[0].text.includes("Downloaded ✓"), `row 0 Downloaded ✓ (${js(rows[0].text)})`);

    assert.equal(rows[1].name, "Pier Lights");
    assert.equal(rows[1].artist, "Terry Bass");
    assert.equal(rows[1].meta, "D minor");
    assert.ok(!/bpm|tempo|—|-/i.test(rows[1].meta ?? ""), `no dash/bpm on band setlist row 1 (${js(rows[1].meta)})`);
    assert.ok(rows[1].text.includes("Downloaded ✓"), `row 1 Downloaded ✓ (${js(rows[1].text)})`);

    assert.equal(rows[2].name, "A song no longer in the band");
    assert.equal(rows[2].meta, null, "removed band song shows no facts");
    assert.ok(!/major|minor|bpm|Tempo/i.test(rows[2].text), `removed band song has no facts (${js(rows[2].text)})`);
  });

  // ---------------------------------------------------------------------------------------------- R7
  await check("R7 same title, two songs", async () => {
    await s.evaluate(`location.hash = "#/setlists"`);
    await app.until(`!!document.querySelector('.setlist[aria-label="Twin Titles"] .setlist-row')`, "Twin Titles setlist");
    const rows = await setlistRows("Twin Titles");
    assert.equal(rows.length, 2, "two rows in Twin Titles");
    assert.equal(rows[0].title, "River Bend");
    assert.equal(rows[0].artist, "North Band");
    assert.equal(rows[0].meta, "A major · ~96 bpm");
    assert.equal(rows[1].title, "River Bend");
    assert.equal(rows[1].artist, "South Duo");
    assert.equal(rows[1].meta, "D minor · ~120 bpm");
  });

  // ---------------------------------------------------------------------------------------------- R8
  await check("R8 odd titles at 360 px", async () => {
    await phone360();
    const oddTitles = ["Don't Look Back", "“Midnight” Café", LONG_TITLE];
    for (const hash of ["#/songs", "#/setlists"]) {
      await s.evaluate(`location.hash = ${js(hash)}`);
      await app.until(`!!document.querySelector(${js(hash === "#/songs" ? ".song-list .song-row" : ".setlist .setlist-row")})`, `rows on ${hash}`);
      const scroll = await s.evaluate<{ w: number; inner: number }>(`({ w: document.documentElement.scrollWidth, inner: innerWidth })`);
      assert.ok(scroll.w <= scroll.inner + 0.5, `${hash} does not scroll sideways (${scroll.w} > ${scroll.inner})`);
      for (const title of oddTitles) {
        const seen = await s.evaluate<{ exact: boolean; metaBox: { l: number; r: number; w: number; h: number; clipped: boolean } | null } | null>(
          `(() => {
            const row = [...document.querySelectorAll(".song-row")].find((r) => r.querySelector(".song-title")?.textContent === ${js(title)});
            if (!row) return null;
            const meta = row.querySelector(".song-meta");
            if (!meta) return { exact: true, metaBox: null };
            const r = meta.getBoundingClientRect();
            return {
              exact: true,
              metaBox: { l: r.left, r: r.right, w: r.width, h: r.height, clipped: meta.scrollWidth > meta.clientWidth + 1 },
            };
          })()`,
        );
        assert.ok(seen && seen.exact, `${title} exact characters on ${hash}`);
        if (hash === "#/setlists") {
          assert.ok(seen.metaBox && seen.metaBox.w > 0 && seen.metaBox.h > 0, `${title} facts visible in setlist`);
          assert.ok(seen.metaBox.l >= 0 && seen.metaBox.r <= 360.5 && !seen.metaBox.clipped, `${title} facts fit at 360px (${js(seen.metaBox)})`);
        }
      }
    }
  });

  // ---------------------------------------------------------------------------------------------- R9
  await check("R9 the two buttons", async () => {
    await phone360();
    await s.evaluate(`location.hash = "#/songs"`);
    await app.until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "+ Add a song")`, "+ Add a song signed in");
    const buttons = () =>
      s.evaluate<{ add: { top: number; left: number; right: number; height: number } | null; imp: { top: number; left: number; right: number; height: number } | null; scroll: number; inner: number }>(`(() => {
        const find = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === label && b.getClientRects().length);
        const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, height: r.height }; };
        return { add: box(find("+ Add a song")), imp: box(find("Import files")), scroll: document.documentElement.scrollWidth, inner: innerWidth };
      })()`);
    const b = await buttons();
    assert.ok(b.add && b.imp, "both + Add a song and Import files visible signed in");
    assert.ok(Math.abs(b.add.top - b.imp.top) <= 2, `same top edge (${b.add.top} vs ${b.imp.top})`);
    assert.ok(b.add.right <= b.imp.left + 0.5, `side by side (${b.add.right} <= ${b.imp.left})`);
    assert.ok(b.add.height >= 44 && b.imp.height >= 44, `both >= 44 px tall (${b.add.height}, ${b.imp.height})`);
    assert.ok(b.add.left >= 0 && b.imp.right <= 360.5 && b.scroll <= b.inner + 0.5, `inside 360px screen (${js(b)})`);

    // Search hides both
    await typeSearch("cedar");
    const hidden = await buttons();
    assert.equal(hidden.add, null, "search hides + Add a song");
    assert.equal(hidden.imp, null, "search hides Import files");
    await typeSearch("");
    await app.until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Import files")`, "buttons return after clearing search");

    // Each still opens what it opened before
    await app.click("+ Add a song");
    await app.until(`!!document.querySelector("form.song-editor[role=dialog]")`, "+ Add a song opens song editor");
    await app.click("Cancel", `document.querySelector("form.song-editor")`);
    await app.until(`!document.querySelector("form.song-editor")`, "song editor closes");

    await app.click("Import files");
    await app.until(`!!document.querySelector("section.song-import[role=dialog]")`, "Import files opens import sheet");
    await app.click("Close", `document.querySelector("section.song-import")`);
    await app.until(`!document.querySelector("section.song-import")`, "import sheet closes");

    // Signed out: neither shows and the list still works
    await app.openMenu();
    await app.pick("Account");
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "account"`, "account sheet");
    await app.click("Sign out", `document.querySelector(".account-sheet")`);
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "start"`, "signed out");
    await app.click("✕");
    await app.closeMenu();
    await s.evaluate(`location.hash = "#/songs"`);
    await app.until(`document.querySelectorAll(".song-list .song-row").length >= 11`, "My Songs list works signed out");
    const signedOut = await buttons();
    assert.equal(signedOut.add, null, "no + Add a song signed out");
    assert.equal(signedOut.imp, null, "no Import files signed out");
    await s.evaluate(`[...document.querySelectorAll(".song-list .song-row")].find((r) => r.querySelector(".song-title")?.textContent === "Cedar Creek").click()`);
    await app.until(`document.querySelector(".sheet .sheet-name")?.textContent === "Cedar Creek"`, "signed-out tap opens song");
  });

  // ---------------------------------------------------------------------------------------------- R10
  await check("R10 the tempo the player set", async () => {
    await s.evaluate(`location.hash = "#/songs"`);
    await app.until(`document.querySelectorAll(".song-list .song-row").length >= 11`, "My Songs list");
    await s.evaluate(`[...document.querySelectorAll(".song-list .song-row")].find((r) => r.querySelector(".song-title")?.textContent === "Half Time Creek").click()`);
    await app.until(`document.querySelector(".sheet .sheet-name")?.textContent === "Half Time Creek"`, "Half Time Creek sheet");
    await s.evaluate(`document.querySelector('.shell-header [aria-label="More"]').click()`);
    await app.until(`!!document.querySelector('[role="menu"]')`, "More menu");
    await s.evaluate(`[...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.trim() === "Song timing").click()`);
    await app.until(`!!document.querySelector(".song-data[role=dialog]")`, "Song timing dialog");
    await s.evaluate(`(() => {
      const bpm = [...document.querySelectorAll(".song-data label")].find((l) => l.textContent.trim() === "BPM").control;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(bpm, "76");
      bpm.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await app.click("Save", `document.querySelector(".song-data")`);
    await app.until(`!document.querySelector(".song-data")`, "Song timing saved");

    await s.evaluate(`location.hash = "#/setlists"`);
    await app.until(`!!document.querySelector('.setlist[aria-label="Friday Porch"] .setlist-row')`, "Friday Porch setlists");
    const row = (await setlistRows("Friday Porch")).find((r) => r.title === "Half Time Creek");
    assert.ok(row, "Half Time Creek row in Friday Porch");
    assert.equal(row.meta, "C major · ~76 bpm", `setlist row reads ~76 bpm (${js(row.meta)})`);
  });

  assert.deepEqual(await app.errors(), [], "no page errors");
} finally {
  await site.close();
  await api.worker.dispose();
  rmSync(stateDir, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`check:list-rows: ${failed} failed`);
  process.exit(1);
}
console.log("check:list-rows passed");
