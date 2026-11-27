import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { LibraryFile } from "../src/types.ts";

/**
 * P3, one library per account, every visit (DataMuse Walk 1 #5, #6). One case per pass condition, named by it.
 *
 * Pure cases run anywhere. The Worker cases start the mls-rooms Worker under Miniflare, and the browser cases also need
 * headless Chrome (`CHROME`), so those two parts run on the box. The switch is the Worker var `MY_SONGS_PER_ACCOUNT`:
 * empty (the default) keeps My Songs per phone, "1" keeps it per account. In both, an account's backup takes only the
 * songs that account made or already holds, never the ones another account left on a shared browser.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const js = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as LibraryFile;
const CATALOG = seed.songs.map((song) => song.title);

let failed = 0;
async function check(name: string, run: () => Promise<void> | void) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type App = typeof import("../src/backup.ts") & typeof import("../src/storage.ts") & typeof import("../src/search.ts");

/** The app's own modules, bundled. Each call is a fresh copy, the way a second tab runs its own copy of the app over the same localStorage. */
async function loadApp(): Promise<App> {
  const bundle = await build({
    stdin: { contents: `export * from "./src/backup.ts"; export * from "./src/storage.ts"; export * from "./src/search.ts";`, resolveDir: root, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}#${Math.random()}`);
}

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

const useStore = (store: FakeStorage) => Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });

/** A song as `data/library.json` holds it, under a new id and title: one that passes every check a stored song gets. */
const ownSong = (id: number, title: string, extra: object = {}) => ({ ...JSON.parse(JSON.stringify(seed.songs[1])), id, title, ...extra });

/** Puts songs into the stored library the way the app keeps it, then loads it, as the app does on start. */
function storeSongs(app: App, store: FakeStorage, songs: object[]) {
  useStore(store);
  app.loadLibrary();
  const stored = JSON.parse(store.getItem("leadSheetsLibraryV2")!);
  const ids = new Set(songs.map((song) => (song as { id: number }).id));
  stored.songs = [...stored.songs.filter((song: { id: number }) => !ids.has(song.id)), ...songs];
  store.setItem("leadSheetsLibraryV2", JSON.stringify(stored));
  return app.loadLibrary();
}

const titlesOf = (library: { songs: { title: string }[] }) => library.songs.map((song) => song.title);
const REPORTED = ["After Midnight", "Blue Train", "So What", "Tennessee Whiskey"];
const fiftySongs = () => Array.from({ length: 35 }, (_, i) => ownSong(100 + i, REPORTED[i] ?? `Stored Song ${i + 1}`));

const app = await loadApp();

// ---- Pure: condition 1 (where the 50 songs went) and the search the picker uses ----

await check("condition 1, path (b): a stored own song whose key is H shows on no load and is gone from storage after the first", () => {
  const store = new FakeStorage();
  const shown = storeSongs(app, store, [ownSong(30, "Blue Train", { keyRoot: "H" })]);
  assert.ok(!titlesOf(shown).includes("Blue Train"), "the song fails isSong, so the first load leaves it out");
  assert.ok(!(store.getItem("leadSheetsLibraryV2") ?? "").includes("Blue Train"), "and loadLibrary wrote the shorter library back, so no later build can show it");
});

await check("condition 1, path (c): 35 own songs in a stored library with no seed prints show on no load and are gone after the first", () => {
  const store = new FakeStorage();
  useStore(store);
  const older = { ...JSON.parse(JSON.stringify(seed)), songs: [...JSON.parse(JSON.stringify(seed.songs)), ...fiftySongs()] };
  store.setItem("leadSheetsLibraryV2", JSON.stringify(older));
  const shown = app.loadLibrary();
  assert.equal(older.songs.length, 50, "the stored library holds 50 songs");
  assert.equal(shown.songs.length, CATALOG.length, `this build shows the catalog only (${shown.songs.length})`);
  assert.ok(!REPORTED.some((title) => (store.getItem("leadSheetsLibraryV2") ?? "").includes(title)), "and the 35 extra songs are erased from storage on that first load");
});

await check("condition 1, control: the same 50 songs stored the way this build stores them show on every one of three loads", () => {
  const store = new FakeStorage();
  storeSongs(app, store, fiftySongs());
  const counts = [app.loadLibrary(), app.loadLibrary(), app.loadLibrary()].map((library) => library.songs.length);
  assert.deepEqual(counts, [50, 50, 50], "fifty songs, three times");
});

await check("condition 3, pure: the picker's search finds nothing for After in the catalog, and an empty query lists every song", () => {
  const store = new FakeStorage();
  const library = storeSongs(app, store, [ownSong(30, "Night Owl"), ownSong(31, "Owl From Kim", { copy: { id: "copy-kim-1", canSendOn: true, from: { name: "Kim Keys" } } })]);
  assert.deepEqual(app.matchingSongs(library.songs, "After"), [], "no song matches After");
  assert.deepEqual(titlesOf({ songs: app.matchingSongs(library.songs, "") }), [...CATALOG, "Night Owl", "Owl From Kim"], "an empty query lists the catalog, own songs and friend copies");
});

await check("the switch defaults to off: the test and production configs declare MY_SONGS_PER_ACCOUNT as empty", () => {
  const wrangler = JSON.parse(readFileSync(join(root, "worker", "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  assert.notEqual(wrangler.vars?.MY_SONGS_PER_ACCOUNT, "1", "the top-level config never turns it on");
  for (const env of ["test", "production"]) assert.equal(wrangler.env[env].vars.MY_SONGS_PER_ACCOUNT, "", `the ${env} config declares it empty`);
});

// ---- Worker: condition 2 (the account switch) in both modes, and condition 4 by loads ----

const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
const android = "Mozilla/5.0 (Linux; Android 15; Pixel 9)";

async function accountSwitch(perAccount: boolean) {
  const { Phone, TEST_ORIGIN, startApi } = await import("./api-session.ts");
  type PhoneT = InstanceType<typeof Phone>;
  const realFetch = globalThis.fetch;
  const { worker, base } = await startApi(perAccount ? { MY_SONGS_PER_ACCOUNT: "1" } : {});
  const mode = perAccount ? "switch on" : "switch off";

  /** One browser: its localStorage, the session cookie it holds now, and the app it runs. */
  class Device {
    readonly store = new FakeStorage();
    phone: PhoneT;
    readonly agent: string;
    constructor(phone: PhoneT, agent: string) {
      this.phone = phone;
      this.agent = agent;
    }
    use(copy: App = app) {
      useStore(this.store);
      Object.defineProperty(globalThis, "navigator", { value: { userAgent: this.agent }, configurable: true });
      globalThis.fetch = async (path, init) => {
        const headers = { ...(init?.headers as Record<string, string>), origin: TEST_ORIGIN, ...(this.phone.cookie ? { cookie: this.phone.cookie } : {}) };
        return realFetch(new URL(String(path), base), { ...init, headers });
      };
      return copy;
    }
    async signIn(phone: PhoneT, userId: string) {
      this.phone = phone;
      this.use().backupOn(userId);
      const result = await this.use().syncBackup();
      assert.ok(result.ok, `the sign-in sync went through (${js(result)})`);
    }
    async signOut() {
      this.use().backupOff();
      await this.phone.call("/api/auth/sign-out", {});
    }
    titles(copy: App = app) {
      return titlesOf(this.use(copy).loadLibrary());
    }
  }

  /** The account's song rows as its backup holds them: title by row key. */
  const songRows = async (phone: PhoneT) => {
    const reply = await realFetch(new URL("/api/backup", base), {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN, cookie: phone.cookie },
      body: js({ since: 0, changes: [] }),
    });
    const { rows } = (await reply.json()) as { rows: { key: string; value: string | null }[] };
    return {
      songs: Object.fromEntries(rows.filter((row) => row.key.startsWith("leadSheetsSong.") && row.value !== null).map((row) => [row.key, JSON.parse(row.value!).item.title as string])),
      keys: rows.filter((row) => row.value !== null).map((row) => row.key),
    };
  };

  try {
    const beaPhone = new Device(new Phone(base), android);
    storeSongs(app, beaPhone.store, [ownSong(30, "Bee Song")]);
    const bea: string = (await beaPhone.phone.createAccount("Bea Drums")).body.account.userId;
    await beaPhone.signIn(beaPhone.phone, bea);

    const shared = new Device(new Phone(base), iphone);
    storeSongs(app, shared.store, [ownSong(30, "Night Owl"), ownSong(31, "Owl Two")]);
    shared.use().saveSongData(app.localRef(30), { tempo: 91, timeSignature: "3/4" });
    const alPhone = shared.phone;
    const al: string = (await alPhone.createAccount("Al Bass")).body.account.userId;
    await shared.signIn(alPhone, al);
    const alRows = await songRows(alPhone);

    await check(`${mode}: account A's first backup holds the two songs A made on this browser`, () => {
      assert.deepEqual(Object.values(alRows.songs).sort(), ["Night Owl", "Owl Two"], js(alRows.songs));
    });

    await check(`${mode}, condition 4: My Songs is the same on three loads and in a second tab while A is signed in`, async () => {
      const tab = await loadApp();
      const loads = [shared.titles(), shared.titles(), shared.titles(), shared.titles(tab)];
      assert.ok(loads.every((titles) => js(titles) === js(loads[0])), `the same list each time (${loads.map((titles) => titles.length).join(", ")})`);
      assert.ok(loads[0].includes("Night Owl") && loads[0].includes("Owl Two") && CATALOG.every((title) => loads[0].includes(title)), "the catalog and A's own songs");
    });

    await shared.signOut();
    const beaOnShared = new Phone(base, beaPhone.phone.authenticator);
    assert.equal((await beaOnShared.signIn()).status, 200, "B signs in on A's browser");
    await shared.signIn(beaOnShared, bea);
    const beaRows = await songRows(beaOnShared);

    await check(`${mode}, condition 2: B's backup holds no leadSheetsSong row A made, and none of A's song settings`, () => {
      assert.deepEqual(Object.values(beaRows.songs), ["Bee Song"], `B's song rows ${js(beaRows.songs)}`);
      assert.ok(!beaRows.keys.some((key) => key.startsWith("leadSheetsSongData.")), `B's backup has no song data row (${js(beaRows.keys)})`);
    });

    await check(`${mode}: B's own song with the same id as A's shows on A's browser, with none of A's song data`, () => {
      const library = shared.use().loadLibrary();
      const thirty = library.songs.find((song) => song.id === 30);
      assert.equal(thirty?.title, "Bee Song", `song 30 is B's (${thirty?.title})`);
      assert.deepEqual(app.loadSongData(thirty!.ref), {}, "A's tempo and time signature for song 30 stay with A's song");
    });

    await beaPhone.use().syncBackup();
    await check(`${mode}: B's own phone pulls none of A's songs after B used A's browser`, () => {
      const titles = beaPhone.titles();
      assert.ok(titles.includes("Bee Song") && !titles.some((title) => title.includes("Owl")), js(titles.filter((title) => !CATALOG.includes(title))));
    });

    if (perAccount) {
      await check("switch on, condition 2: B sees only B's own songs on A's browser, on three loads and in a second tab", async () => {
        const tab = await loadApp();
        const loads = [shared.titles(), shared.titles(), shared.titles(), shared.titles(tab)];
        assert.ok(loads.every((titles) => js(titles) === js(loads[0])), `the same list each time (${loads.map((titles) => titles.length).join(", ")})`);
        assert.deepEqual(loads[0], [...CATALOG, "Bee Song"], "the catalog and B's own song");
      });
    } else {
      await check("switch off: the phone library still shows A's other song to B on the shared browser", () => {
        const titles = shared.titles();
        assert.ok(titles.includes("Owl Two") && titles.includes("Bee Song"), js(titles.filter((title) => !CATALOG.includes(title))));
      });
    }

    await shared.signOut();
    if (perAccount) {
      await check("switch on: signed out, the shared browser shows the catalog and neither account's songs", () => {
        const loads = [shared.titles(), shared.titles(), shared.titles()];
        assert.ok(loads.every((titles) => js(titles) === js(CATALOG)), js(loads[0].filter((title) => !CATALOG.includes(title))));
      });
    }

    const alAgain = new Phone(base, alPhone.authenticator);
    assert.equal((await alAgain.signIn()).status, 200, "A signs in again on the shared browser");
    await shared.signIn(alAgain, al);
    const alAfter = await songRows(alAgain);

    await check(`${mode}: back on A's browser, A has both songs and A's song data, and A's backup gained no copy and none of B's`, () => {
      assert.deepEqual(Object.values(alAfter.songs).sort(), ["Night Owl", "Owl Two"], js(alAfter.songs));
      const library = shared.use().loadLibrary();
      const thirty = library.songs.find((song) => song.id === 30);
      assert.equal(thirty?.title, "Night Owl", `song 30 is A's again (${thirty?.title})`);
      assert.deepEqual(app.loadSongData(thirty!.ref), { tempo: 91, timeSignature: "3/4" }, "with A's tempo and time signature");
      if (perAccount) assert.deepEqual(titlesOf(library), [...CATALOG, "Night Owl", "Owl Two"], "and only A's songs");
    });

    await check(`${mode}: B's backup is unchanged after A came back`, async () => {
      assert.deepEqual((await songRows(beaPhone.phone)).songs, beaRows.songs);
    });
  } finally {
    globalThis.fetch = realFetch;
    await worker.dispose();
  }
}

for (const perAccount of [false, true]) {
  try {
    await accountSwitch(perAccount);
  } catch (error) {
    failed += 1;
    console.log(`FAIL the account-switch cases with the switch ${perAccount ? "on" : "off"} could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---- Browser: condition 3 (the two no-results lines), and conditions 2 and 4 on screen with the switch on ----

const WIDTHS = [344, 390, 820, 884, 1280];

async function onScreen() {
  const { startApi } = await import("./api-session.ts");
  const { appPage, PASSWORD_PEPPER, settle } = await import("./app-page.ts");
  const { openSite } = await import("./chrome.ts");
  let apiBase = "";
  const site = await openSite(root, "check-library-consistency", () => apiBase, ["--disable-popup-blocking"]);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER, MY_SONGS_PER_ACCOUNT: "1" });
  apiBase = base;
  try {
    const page = await appPage(site);
    await site.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => { window.__api = 0; const next = window.fetch; window.fetch = (input, init) => { if (String(input?.url ?? input).includes("/api/")) window.__api += 1; return next(input, init); }; })();`,
    });
    const width = (px: number) => site.send("Emulation.setDeviceMetricsOverride", { width: px, height: 844, deviceScaleFactor: 2, mobile: px < 800 });
    const songList = `[...document.querySelectorAll(".song-list .song-title")].map((t) => t.textContent.trim())`;
    const listed = () => site.evaluate<string[]>(songList);
    const reload = async () => {
      await site.evaluate(`window.__beforeReload = true; location.reload()`);
      await page.until(`!window.__beforeReload`, "the reload");
      await page.until(`location.hash === "#/songs" && document.querySelectorAll(".song-list .song-title").length > 0`, "My Songs after the reload", 15000);
      await settle(500);
      return listed();
    };
    /** A second tab on the same origin, opened from this one, read once My Songs is on it. */
    const secondTab = () =>
      site.evaluate<string[]>(`new Promise((done) => {
        const tab = window.open(location.origin + "/#/songs", "_blank");
        const read = () => [...(tab.document?.querySelectorAll(".song-list .song-title") ?? [])].map((t) => t.textContent.trim());
        let tries = 0;
        const poll = () => { const titles = read(); if (titles.length > 0 || tries++ > 150) { setTimeout(() => { const last = read(); tab.close(); done(last); }, 500); } else setTimeout(poll, 100); };
        poll();
      })`);
    const backedUp = () => page.until(`(() => { const s = JSON.parse(localStorage.getItem("leadSheetsBackupV2") ?? "null"); return !!s && s.at != null; })()`, "the backup to finish", 15000);
    const fitsEverywhere = async (selector: string, words: string) => {
      for (const px of WIDTHS) {
        await width(px);
        await settle(300);
        const box = await site.evaluate<{ text: string; left: number; right: number; height: number; page: number; view: number } | null>(`(() => {
          const el = document.querySelector(${js(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { text: el.textContent.trim(), left: r.left, right: r.right, height: r.height, page: document.documentElement.scrollWidth, view: innerWidth };
        })()`);
        assert.ok(box, `the line is on screen at ${px}px`);
        assert.equal(box.text, words, `the words at ${px}px`);
        assert.ok(box.height > 0 && box.left >= 0 && box.right <= box.view + 0.5 && box.page <= box.view, `the line fits at ${px}px (${js(box)})`);
      }
      await width(390);
    };

    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await page.library();
    await page.until(`document.querySelectorAll(".song-list .song-title").length > 0`, "My Songs");
    await site.evaluate(`(() => {
      const stored = JSON.parse(localStorage.getItem("leadSheetsLibraryV2"));
      stored.songs.push(${js(ownSong(30, "Night Owl"))}, ${js(ownSong(31, "Owl From Kim", { copy: { id: "copy-kim-1", canSendOn: true, from: { name: "Kim Keys" } } }))});
      localStorage.setItem("leadSheetsLibraryV2", JSON.stringify(stored));
    })()`);
    await reload();

    await check("condition 3b: My Songs search shows Nothing matches \"After\" with the query, and the line fits at every width", async () => {
      await site.evaluate(`document.querySelector('input[aria-label="Search songs"]').focus()`);
      await site.send("Input.insertText", { text: "After" });
      await page.until(`(document.querySelector(".search-empty")?.textContent ?? "").trim().length > 0`, "the no-results line");
      await fitsEverywhere(".search-empty", 'Nothing matches "After"');
    });

    await reload();
    await page.signUp("Al Bass");
    await backedUp();

    await check("switch on, condition 4: My Songs shows the same songs on three reloads and in a second tab while A is signed in", async () => {
      const loads = [await reload(), await reload(), await reload(), await secondTab()];
      assert.ok(loads.every((titles) => js(titles) === js(loads[0])), `the same list each time (${loads.map((titles) => titles.length).join(", ")})`);
      assert.deepEqual(loads[0], [...CATALOG, "Night Owl", "Owl From Kim"], "the catalog, A's own song and A's friend copy");
    });

    const bandId = await site.evaluate<string>(
      `fetch("/api/bands/create", { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js({ name: "The Night Owls" }))} }).then((r) => r.json()).then((b) => b.bandId)`,
    );
    const bandPage = `document.querySelector(${js(`.band-page[data-band="${bandId}"]`)})`;
    const openPicker = async () => {
      await page.click("+ Add songs", bandPage);
      await page.until(`!!${bandPage}.querySelector(".band-library-pick")`, "the picker");
    };

    await check("condition 3a: the band Add songs picker shows No songs match \"After\" with no server call, and the line fits at every width", async () => {
      await site.evaluate(`location.hash = ${js(`#/band/${bandId}?s=songs`)}`);
      await page.until(`${bandPage}?.textContent.includes("Band songs stay here.")`, "the band's Songs section", 15000);
      await openPicker();
      const calls = await site.evaluate<number>("window.__api");
      await page.type("Find a song", "After");
      await page.until(`(${bandPage}.querySelector(".band-library-pick .account-note")?.textContent ?? "").trim().length > 0`, "the no-results line");
      await fitsEverywhere(".band-library-pick .account-note", 'No songs match "After"');
      assert.equal(await site.evaluate<number>("window.__api"), calls, "typing in the picker calls no API");
      assert.equal(await site.evaluate<number>(`${bandPage}.querySelectorAll(".band-library-pick-row").length`), 0, "and lists no rows");
      await page.click("Cancel", bandPage);
    });

    await check("condition 3a: with no query the picker lists the catalog, A's own song and A's friend copy", async () => {
      await openPicker();
      const rows = await site.evaluate<string[]>(`[...${bandPage}.querySelectorAll(".band-library-pick-row")].map((b) => b.firstChild.textContent.trim())`);
      assert.deepEqual(rows, [...CATALOG, "Night Owl", "Owl From Kim"], js(rows));
      assert.equal(await site.evaluate<boolean>(`!!${bandPage}.querySelector(".band-library-pick .account-note")`), false, "and no no-results line");
      await page.click("Cancel", bandPage);
    });

    await site.evaluate(`location.hash = "#/songs"`);
    await page.openMenu();
    await page.pick("Account");
    await page.until(`document.querySelector(".account-sheet")?.dataset.step === "account"`, "the account screen");
    await page.click("Sign out");
    await page.until(`!localStorage.getItem("leadSheetsBackupV2")`, "signing out");
    await page.click("âœ•").catch(() => {});
    await page.closeMenu();
    await site.evaluate(`location.hash = "#/songs"`);
    await reload();
    await page.signUp("Bea Drums");
    await backedUp();

    await check("switch on, conditions 2 and 4: after A signs out and B signs in on the same browser, B's My Songs has none of A's songs on three reloads and in a second tab", async () => {
      const loads = [await reload(), await reload(), await reload(), await secondTab()];
      assert.ok(loads.every((titles) => js(titles) === js(loads[0])), `the same list each time (${loads.map((titles) => titles.length).join(", ")})`);
      assert.deepEqual(loads[0], CATALOG, js(loads[0].filter((title) => !CATALOG.includes(title))));
    });

    await check("the screens raised no errors", async () => {
      assert.deepEqual(await page.errors(), []);
    });
  } finally {
    await site.close();
    await worker.dispose();
  }
}

const chrome = process.env.CHROME ?? "/usr/bin/google-chrome";
try {
  if (!existsSync(chrome)) throw new Error(`no Chrome at ${chrome}; set CHROME`);
  await onScreen();
} catch (error) {
  failed += 1;
  console.log(`FAIL the browser cases could not run: ${error instanceof Error ? error.message : String(error)}`);
}

await sleep(0);
if (failed > 0) {
  console.error(`check:library-consistency failed (${failed})`);
  process.exit(1);
}
console.log("check:library-consistency passed: where the 50 songs went, no song crosses accounts on a shared browser with the switch off or on, the two no-results lines, and the same My Songs on every load");
