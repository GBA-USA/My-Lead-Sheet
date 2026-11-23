import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { appPage } from "./app-page.ts";
import { openSite, type Site } from "./chrome.ts";

/**
 * Song search: start a new sheet from a public song catalog, and Find lyrics on the web. One case per pass condition,
 * numbered by it. The cases fix this contract:
 *
 * `src/song-search.ts` is pure (no DOM), so other screens can import it:
 * - `lyricsSearchUrl(title, artist)` is `https://www.google.com/search?q=` plus encodeURIComponent of
 *   `"<title>" "<artist>" lyrics`, leaving out a field that is blank.
 * - `catalogSearcher(deps)` gives `{ search(query, report), stop() }`. `deps` is `{ fetch, now, setTimeout,
 *   clearTimeout, online, origin }`. `search` debounces the query (400 to 800 ms) and never sends a second request
 *   within 1000 ms of the last one. `report` hears `{ kind: "idle" }` for a blank query, then `searching`, then one of
 *   `found` (with `songs`, each `{ id, title, artist, year, lengthSec }`), `none`, `offline` or `failed`, each with its
 *   `query`. A reply to a query the box no longer holds is never reported. The request is a MusicBrainz WS/2 recording
 *   search with `fmt=json` and `User-Agent: MyLeadSheet/1.0 ( <origin> )`.
 *
 * On the phone, signed in (the same rule as + Add a song), My Songs and the New song dialog have a search box labelled
 * "Find a song to add". While a request is out it says "Searching". Each result is a button showing title, artist, year and m:ss length. Tapping one adds an own
 * song with that title, artist and length, every other field at the New song defaults, and opens it. The new sheet and
 * the New song dialog (once it has a title or artist) offer "Find lyrics on the web".
 *
 * The unit cases run anywhere. The screen cases build the app and drive headless Chrome (`CHROME`) against a stub
 * `/api/me` and a stub catalog in the page, so nothing here reaches the live catalog or any lyrics site.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
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

const GOOGLE = "https://www.google.com/search?q=";
const RECORDING_SEARCH = "https://musicbrainz.org/ws/2/recording";
const PREVIEW_ORIGIN = "https://my-lead-sheet-preview.pages.dev";
const lyricsUrl = (words: string) => GOOGLE + encodeURIComponent(words);

type CatalogSong = { id: string; title: string; artist: string; year: string | null; lengthSec: number | null };
type SearchState =
  | { kind: "idle" }
  | { kind: "searching" | "none" | "offline" | "failed"; query: string }
  | { kind: "found"; query: string; songs: CatalogSong[] };
type Deps = {
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  online: () => boolean;
  origin: string;
};
type Searcher = { search: (query: string, report: (state: SearchState) => void) => void; stop: () => void };
type SongSearch = { lyricsSearchUrl: (title: string, artist: string) => string; catalogSearcher: (deps: Deps) => Searcher };

/** A recording search reply as the catalog sends it, with a decoy field the phone must never keep. */
const PAYLOAD = {
  created: "2026-11-23T00:00:00.000Z",
  count: 2,
  offset: 0,
  recordings: [
    {
      id: "rec-fire-away",
      score: 100,
      title: "Fire Away",
      length: 232000,
      "artist-credit": [
        { name: "Pat Bass", joinphrase: " & ", artist: { id: "a1", name: "Pat Bass" } },
        { name: "The Low End", joinphrase: "", artist: { id: "a2", name: "The Low End" } },
      ],
      "first-release-date": "2015-05-04",
      lyrics: "DECOY WORDS NEVER STORED",
    },
    { id: "rec-live", score: 80, title: "Fire Away (live)", length: 61500, "artist-credit": [{ name: "Pat Bass", joinphrase: "" }], "first-release-date": "1999" },
  ],
};
const EMPTY = { created: "2026-11-23T00:00:00.000Z", count: 0, offset: 0, recordings: [] };

let mod: SongSearch | null = null;
try {
  const bundle = await build({
    entryPoints: [join(root, "src", "song-search.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
} catch (error) {
  console.log(`FAIL src/song-search.ts loads as a pure module: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  failed += 1;
}
const need = (): SongSearch => {
  assert.ok(mod, "src/song-search.ts loaded");
  return mod;
};

/** A clock and timers the case moves by hand, so debounce and the 1 s floor are exact. */
function fakeTime() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((done) => setImmediate(done));
  };
  return {
    now: () => now,
    setTimeout: (run: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + Math.max(0, ms), run });
      return id;
    },
    clearTimeout: (handle: unknown) => void timers.delete(handle as number),
    settle,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

type Reply = Response | Error | Promise<Response>;
/** A searcher on fake time whose catalog answers with `reply`, logging each request and when it left. */
function harness(reply: (url: string) => Reply = () => new Response(js(PAYLOAD), { status: 200 }), online = () => true) {
  const time = fakeTime();
  const calls: { url: string; headers: Record<string, string>; at: number }[] = [];
  const states: SearchState[] = [];
  const searcher = need().catalogSearcher({
    fetch: (url, init) => {
      calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers ?? {})), at: time.now() });
      const answer = reply(url);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    now: time.now,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    online,
    origin: PREVIEW_ORIGIN,
  });
  const search = (query: string) => searcher.search(query, (state) => states.push(state));
  const last = () => states[states.length - 1];
  return { time, calls, states, search, last, searcher };
}

// ---------------------------------------------------------------------------------------------- unit cases

await check("1a. Find lyrics on the web is a general search for the quoted title and artist plus lyrics", () => {
  const { lyricsSearchUrl } = need();
  assert.equal(lyricsSearchUrl("Fire Away", "Pat Bass"), lyricsUrl('"Fire Away" "Pat Bass" lyrics'));
  assert.equal(lyricsSearchUrl("Rock & Roll / Part 2?", "AC/DC"), GOOGLE + encodeURIComponent('"Rock & Roll / Part 2?" "AC/DC" lyrics'), "every special character is encoded");
  assert.ok(!/site(:|%3A)/i.test(lyricsSearchUrl("Fire Away", "Pat Bass")), "no site-restricted search");
});

await check("1b. a missing title or artist still searches with what is there, plus lyrics", () => {
  const { lyricsSearchUrl } = need();
  assert.equal(lyricsSearchUrl("Fire Away", ""), lyricsUrl('"Fire Away" lyrics'), "no artist");
  assert.equal(lyricsSearchUrl("", "Pat Bass"), lyricsUrl('"Pat Bass" lyrics'), "no title");
  assert.equal(lyricsSearchUrl("  Fire Away ", "   "), lyricsUrl('"Fire Away" lyrics'), "blank space is no field");
  assert.equal(lyricsSearchUrl("", ""), lyricsUrl("lyrics"), "neither");
});

await check("2a. building the lyrics search asks no network at all", () => {
  const { lyricsSearchUrl } = need();
  const real = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = (() => {
    asked += 1;
    return Promise.reject(new Error("no fetch allowed"));
  }) as typeof fetch;
  try {
    lyricsSearchUrl("Fire Away", "Pat Bass");
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(asked, 0, "fetch was never called");
});

const OWNED = ["src/song-search.ts", "src/song-search.tsx", "src/song-search.css", "src/library-lists.tsx", "src/song-editor.tsx"];
await check("2b. this feature's files hold no lyrics site, no lyrics API and no network step but the catalog search", () => {
  const LYRICS_HOSTS = /genius\.com|azlyrics|musixmatch|lyrics\.ovh|lyricfind|songlyrics|lyricsfreak|metrolyrics|lyrics\.com|chartlyrics|letras\.|lyricstranslate|happi\.dev|apiseeds|lololyrics/i;
  for (const file of OWNED) {
    const text = readFileSync(join(root, file), "utf8");
    assert.ok(!LYRICS_HOSTS.test(text), `${file} names a lyrics site (${LYRICS_HOSTS.exec(text)?.[0]})`);
    for (const [url] of text.matchAll(/https?:\/\/[^\s"'`<>)]+/g)) {
      assert.ok(url.startsWith(GOOGLE) || url.startsWith(RECORDING_SEARCH), `${file} holds ${url}, which is neither the general web search nor the catalog search`);
    }
    for (const primitive of ["XMLHttpRequest", "sendBeacon", "new WebSocket", "EventSource", "importScripts"]) {
      assert.ok(!text.includes(primitive), `${file} uses ${primitive}`);
    }
    assert.ok(!/\bsite:/i.test(text), `${file} builds a site-restricted search`);
  }
});

await check("2c. the catalog request asks only for recordings: no lyrics, no extra includes", async () => {
  const run = harness();
  run.search("fire away");
  await run.time.advance(2000);
  assert.equal(run.calls.length, 1, "one request");
  const url = new URL(run.calls[0].url);
  assert.ok(!/lyric/i.test(url.href), "the request never names lyrics");
  assert.deepEqual([...url.searchParams.keys()].filter((key) => !["query", "fmt", "limit", "offset"].includes(key)), [], "only query, fmt, limit and offset");
  const found = run.last();
  assert.equal(found.kind, "found");
  assert.ok(!js(found).includes("DECOY"), "nothing past title, artist, year and length is kept from the reply");
});

await check("3a. a search is a MusicBrainz WS/2 recording search in JSON with the app's User-Agent", async () => {
  const run = harness();
  run.search("fire away");
  await run.time.advance(2000);
  assert.equal(run.calls.length, 1, "one request");
  const url = new URL(run.calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, RECORDING_SEARCH, "the recording search");
  assert.equal(url.searchParams.get("fmt"), "json", "fmt=json");
  assert.ok(/fire/i.test(url.searchParams.get("query") ?? "") && /away/i.test(url.searchParams.get("query") ?? ""), `the typed words are the query (${url.searchParams.get("query")})`);
  assert.equal(run.calls[0].headers["user-agent"], `MyLeadSheet/1.0 ( ${PREVIEW_ORIGIN} )`, "User-Agent names the app and where it lives");
});

await check("3b. a reply becomes songs with title, artist, year and length in seconds", async () => {
  const run = harness();
  run.search("fire away");
  assert.equal(run.last()?.kind, "searching", "searching shows at once");
  await run.time.advance(2000);
  const found = run.last();
  assert.ok(found.kind === "found", `found (${js(found)})`);
  assert.equal(found.query, "fire away");
  assert.deepEqual(
    found.songs.map(({ title, artist, year, lengthSec }) => ({ title, artist, year, lengthSec })),
    [
      { title: "Fire Away", artist: "Pat Bass & The Low End", year: "2015", lengthSec: 232 },
      { title: "Fire Away (live)", artist: "Pat Bass", year: "1999", lengthSec: 62 },
    ],
  );
  assert.ok(found.songs.every((song) => typeof song.id === "string" && song.id !== ""), "each song keeps its catalog id");
});

await check("3c. a blank query sends nothing and clears the list", async () => {
  const run = harness();
  run.search("fire away");
  await run.time.advance(2000);
  run.search("   ");
  await run.time.advance(2000);
  assert.equal(run.calls.length, 1, "no request for a blank box");
  assert.deepEqual(run.last(), { kind: "idle" }, "a cleared box is idle, with no rows");
});

await check("4. no recordings is its own state, not an error and not a blank", async () => {
  const run = harness(() => new Response(js(EMPTY), { status: 200 }));
  run.search("zzzz qqqq");
  await run.time.advance(2000);
  assert.deepEqual(run.last(), { kind: "none", query: "zzzz qqqq" });
});

await check("5a. offline (navigator.onLine false) says offline and sends nothing", async () => {
  const run = harness(undefined, () => false);
  run.search("fire away");
  await run.time.advance(2000);
  assert.equal(run.calls.length, 0, "no request while offline");
  assert.deepEqual(run.last(), { kind: "offline", query: "fire away" });
});

await check("5b. a failed network (fetch rejects) says offline, with no rows", async () => {
  const run = harness(() => new TypeError("Failed to fetch"));
  run.search("fire away");
  await run.time.advance(2000);
  assert.deepEqual(run.last(), { kind: "offline", query: "fire away" });
});

await check("6a. a 5xx from the catalog says failed, with no rows", async () => {
  const run = harness(() => new Response(js({ error: "The MusicBrainz web server is currently busy. Please try again later." }), { status: 503 }));
  run.search("fire away");
  await run.time.advance(2000);
  assert.deepEqual(run.last(), { kind: "failed", query: "fire away" });
});

await check("6b. a malformed reply (not JSON, or no recordings list) says failed, with no rows", async () => {
  for (const body of ["<html>oops</html>", js({ error: "busy" }), js({ recordings: "nope" })]) {
    const run = harness(() => new Response(body, { status: 200 }));
    run.search("fire away");
    await run.time.advance(2000);
    assert.deepEqual(run.last(), { kind: "failed", query: "fire away" }, `for ${body}`);
  }
});

await check("6c. a reply for a query the box no longer holds is never shown", async () => {
  let release: (response: Response) => void = () => {};
  const slow = new Promise<Response>((done) => (release = done));
  const run = harness((url) => (new URL(url).searchParams.get("query")?.includes("old") ? slow : new Response(js(EMPTY), { status: 200 })));
  run.search("old song");
  await run.time.advance(900);
  assert.equal(run.calls.length, 1, "the first query went out");
  run.search("new song");
  await run.time.advance(3000);
  release(new Response(js(PAYLOAD), { status: 200 }));
  await run.time.advance(100);
  assert.ok(!run.states.some((state) => state.kind === "found"), "the old query's rows never show");
  assert.deepEqual(run.last(), { kind: "none", query: "new song" });
});

await check("7a. rapid typing sends one request, after a 400-800 ms pause", async () => {
  const run = harness();
  for (const [index, text] of ["f", "fi", "fir", "fire", "fire ", "fire a", "fire aw", "fire away"].entries()) {
    if (index) await run.time.advance(120);
    run.search(text);
  }
  const typedAt = run.time.now();
  await run.time.advance(399);
  assert.equal(run.calls.length, 0, "nothing before 400 ms of quiet");
  await run.time.advance(2000);
  assert.equal(run.calls.length, 1, "one request for the whole burst");
  assert.ok(run.calls[0].at - typedAt >= 400 && run.calls[0].at - typedAt <= 800, `sent ${run.calls[0].at - typedAt} ms after the last key`);
  assert.match(new URL(run.calls[0].url).searchParams.get("query") ?? "", /away/i, "for the last text");
});

/** Moves time 10 ms at a time until the `count`th request leaves, so the next search starts the moment it did. */
async function untilSent(run: ReturnType<typeof harness>, count: number) {
  for (let waited = 0; run.calls.length < count; waited += 10) {
    assert.ok(waited < 5000, `request ${count} never left`);
    await run.time.advance(10);
  }
}

await check("7b. a search right after a request waits for the 1 s floor, not just the debounce", async () => {
  const run = harness(() => new Response(js(EMPTY), { status: 200 }));
  run.search("fire away");
  await untilSent(run, 1);
  run.search("kitchen floor");
  await run.time.advance(5000);
  assert.equal(run.calls.length, 2, "the second search went out");
  assert.ok(run.calls[1].at - run.calls[0].at >= 1000, `the second request left ${run.calls[1].at - run.calls[0].at} ms after the first`);
  assert.match(new URL(run.calls[1].url).searchParams.get("query") ?? "", /kitchen/i, "for the new text");
});

await check("7c. Try again right after a failure waits for the 1 s floor too", async () => {
  const run = harness(() => new TypeError("Failed to fetch"));
  run.search("fire away");
  await untilSent(run, 1);
  assert.equal(run.last()?.kind, "offline");
  for (let i = 0; i < 3; i += 1) {
    run.search("fire away");
    await untilSent(run, i + 2);
  }
  const gaps = run.calls.slice(1).map((call, i) => call.at - run.calls[i].at);
  assert.ok(gaps.every((gap) => gap >= 1000), `each retry left at least 1 s after the one before (gaps ${js(gaps)})`);
});

await check("7d. stop() ends a pending search: no request, no report", async () => {
  const run = harness();
  run.search("fire away");
  const heard = run.states.length;
  run.searcher.stop();
  await run.time.advance(5000);
  assert.equal(run.calls.length, 0, "nothing sent after stop");
  assert.equal(run.states.length, heard, "nothing reported after stop");
});

// ---------------------------------------------------------------------------------------------- screen cases

/** In the page before any app script: the catalog answers from here by `__mb.mode`, every other host is refused and logged, and window.open is logged. */
const STUB = `(() => {
  const PAYLOAD = ${js(PAYLOAD)};
  const EMPTY = ${js(EMPTY)};
  window.__mb = { mode: "ok", calls: [], opened: [] };
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, location.href);
    if (url.origin === location.origin) return realFetch(input, init);
    window.__mb.calls.push({ url: url.href, headers: Object.fromEntries(new Headers(init.headers || {})) });
    if (!url.href.startsWith(${js(RECORDING_SEARCH)})) return Promise.reject(new TypeError("refused by the check"));
    const mode = window.__mb.mode;
    if (mode === "offline") return Promise.reject(new TypeError("Failed to fetch"));
    if (mode === "error") return Promise.resolve(new Response("busy", { status: 503 }));
    if (mode === "malformed") return Promise.resolve(new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }));
    return Promise.resolve(new Response(JSON.stringify(mode === "none" ? EMPTY : PAYLOAD), { status: 200, headers: { "content-type": "application/json" } }));
  };
  window.open = (url) => { window.__mb.opened.push(String(url)); return null; };
})();`;

const ACCOUNT = { userId: "u_song_search", handle: "pat", displayName: "Pat Bass", ways: [] };
const SCREEN_CASES = [
  "0. signed out, My Songs has no catalog search (the same rule as + Add a song)",
  "3d. on My Songs, a search lists title, artist, year and m:ss length",
  "4b. no recordings says no songs were found and invites a different search",
  "5c. offline says so, shows no rows, and Try again finds the songs once back online",
  "6d. a catalog error or a malformed reply says so, with no rows and Try again",
  "3e. clearing the box clears the list",
  "9a. at 360 px and 390 px the search box and result rows fit and are glove-sized",
  "8a. tapping a result on My Songs opens a new own song with title, artist and length",
  "1c. the new sheet offers Find lyrics on the web for its title and artist, and Learn this song",
  "9b. at 360 px and 390 px Find lyrics on the web on the new sheet fits and is glove-sized",
  "8b. in Add a song, the same search starts the new song from a pick",
  "1d. in Add a song, Find lyrics on the web follows the typed title and artist, and fits at 360 px and 390 px",
  "2d. across the whole flow the page asked only the catalog search, opened nothing, and stored no reply text",
];

const api = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  response.writeHead(path === "/api/me" ? 200 : 404, { "content-type": "application/json" });
  response.end(js(path === "/api/me" ? { account: ACCOUNT } : { error: "not-found" }));
});
await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
const apiAddress = api.address();
const apiBase = `http://127.0.0.1:${typeof apiAddress === "object" && apiAddress ? apiAddress.port : 0}`;

let site: Site | null = null;
try {
  site = await openSite(root, "check-song-search", () => apiBase);
} catch (error) {
  for (const name of SCREEN_CASES) {
    failed += 1;
    console.log(`FAIL ${name}: the app or Chrome did not start (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
  }
}

if (site) {
  const s = site;
  try {
    const app = await appPage(s);
    await s.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
    const phone = async (width: number) => {
      await s.send("Emulation.setDeviceMetricsOverride", { width, height: 780, deviceScaleFactor: 2, mobile: true });
      await s.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`);
    };
    const BOX = `document.querySelector('input[aria-label="Find a song to add"]')`;
    const DIALOG_BOX = `document.querySelector('[role=dialog] input[aria-label="Find a song to add"]')`;
    const ROWS = (box: string) => `[...(${box}?.closest(".song-search")?.querySelectorAll("li button") ?? [])]`;
    const NOTE = (box: string) => `(${box}?.closest(".song-search")?.textContent ?? "")`;
    const lyricsLink = (scope: string) => `[...(${scope}?.querySelectorAll("a, button") ?? [])].find((el) => el.textContent.trim() === "Find lyrics on the web")`;
    const typeInto = async (box: string, text: string) => {
      await s.evaluate(`(() => { const field = ${box}; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, ${js(text)}); field.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    };
    const typeLabel = async (label: string, text: string) => {
      await s.evaluate(`(() => { const field = [...document.querySelectorAll("[role=dialog] label")].find((l) => l.textContent.trim() === ${js(label)}).control; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, ${js(text)}); field.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    };
    const mode = (next: string) => s.evaluate(`window.__mb.mode = ${js(next)}`);
    const stored = () => s.evaluate<Record<string, unknown>[]>(`JSON.parse(localStorage.getItem("leadSheetsLibrary") ?? "{}").songs ?? []`);
    const hashId = () => s.evaluate<number | null>(`(() => { const m = location.hash.match(/^#\\/song\\/(\\d+)/); return m ? Number(m[1]) : null; })()`);
    type Box = { left: number; right: number; top: number; bottom: number; h: number; w: number; clipped: boolean; inner: number; page: number };
    const measure = (expression: string) =>
      s.evaluate<Box | null>(`(() => {
        const el = ${expression};
        if (!el || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, h: r.height, w: r.width, clipped: el.scrollWidth > el.clientWidth + 1, inner: innerWidth, page: document.documentElement.scrollWidth };
      })()`);
    const addButton = `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "+ Add a song")`;
    const glove = async (expression: string, what: string, width: number, floor = 44) => {
      const box = await measure(expression);
      assert.ok(box, `${what} is visible at ${width} px`);
      assert.ok(box.h >= floor, `${what} is ${box.h} px tall at ${width} px (needs ${floor})`);
      assert.ok(box.left >= 0 && box.right <= box.inner + 0.5, `${what} runs ${box.left}..${box.right} in a ${box.inner} px screen`);
      assert.ok(box.top >= 0 && box.bottom <= 780 + 0.5, `${what} is on screen (top ${box.top}, bottom ${box.bottom})`);
      assert.ok(!box.clipped, `${what} is not clipped at ${width} px`);
      assert.ok(box.page <= box.inner + 0.5, `the page scrolls sideways at ${width} px (${box.page} > ${box.inner})`);
    };
    const searchFor = async (box: string, text: string) => {
      await typeInto(box, text);
      await app.until(`!${NOTE(box)}.includes("Searching") || ${ROWS(box)}.length > 0`, "the search to settle", 6000);
      await sleep(100);
    };

    await phone(390);
    await s.send("Page.navigate", { url: `${s.origin}/#/songs` });
    await app.library();

    await check(SCREEN_CASES[0], async () => {
      await app.until(`!!document.querySelector(".song-list")`, "My Songs");
      assert.equal(await s.evaluate<boolean>(`!!${BOX}`), false, "no catalog search signed out");
      assert.equal(await s.evaluate<boolean>(`!!${addButton}`), false, "and no + Add a song");
    });

    await s.evaluate(`localStorage.setItem("leadSheetsSignedIn", ${js(ACCOUNT.userId)})`);
    await s.send("Page.reload");
    await app.library();
    await app.until(`!!${addButton}`, "+ Add a song, signed in", 15000);
    /** Page errors from here on, so the stub API's 404s for screens this check never opens are not counted against the search. */
    const seen = (await app.errors()).length;
    const newErrors = async () => (await app.errors()).slice(seen);

    await check(SCREEN_CASES[1], async () => {
      await app.until(`!!${BOX}`, "the catalog search box on My Songs");
      await searchFor(BOX, "fire away");
      await app.until(`${ROWS(BOX)}.length === 2`, "two result rows");
      const rows = await s.evaluate<string[]>(`${ROWS(BOX)}.map((b) => b.textContent)`);
      for (const word of ["Fire Away", "Pat Bass & The Low End", "2015", "3:52"]) assert.ok(rows[0].includes(word), `row 1 shows ${word} (${rows[0]})`);
      for (const word of ["Fire Away (live)", "1999", "1:02"]) assert.ok(rows[1].includes(word), `row 2 shows ${word} (${rows[1]})`);
      const sent = await s.evaluate<{ url: string; headers: Record<string, string> }[]>(`window.__mb.calls`);
      assert.ok(sent.length >= 1 && sent.every((call) => call.url.startsWith(RECORDING_SEARCH)), `only recording searches went out (${js(sent.map((c) => c.url))})`);
      assert.equal(sent[sent.length - 1].headers["user-agent"], `MyLeadSheet/1.0 ( ${s.origin} )`, "with the app's User-Agent");
      assert.ok(!/musicbrainz/i.test(await s.evaluate<string>(`document.body.innerText`)), "no internal service name on screen");
    });

    await check(SCREEN_CASES[2], async () => {
      await mode("none");
      await sleep(1100);
      await searchFor(BOX, "zzzz qqqq");
      await app.until(`/no songs/i.test(${NOTE(BOX)})`, "the no-songs message", 6000);
      const note = await s.evaluate<string>(NOTE(BOX));
      assert.match(note, /no songs (were )?found/i);
      assert.match(note, /different/i, `it invites a different search (${note})`);
      assert.equal(await s.evaluate<number>(`${ROWS(BOX)}.length`), 0, "no rows");
    });

    await check(SCREEN_CASES[3], async () => {
      await mode("offline");
      await sleep(1100);
      await searchFor(BOX, "kitchen floor");
      await app.until(`/offline/i.test(${NOTE(BOX)})`, "the offline message", 6000);
      assert.equal(await s.evaluate<number>(`${ROWS(BOX)}.length`), 0, "no rows");
      assert.deepEqual(await newErrors(), [], "no crash");
      await mode("ok");
      await sleep(1100);
      await app.click("Try again", `${BOX}.closest(".song-search")`);
      await app.until(`${ROWS(BOX)}.length === 2`, "the rows after Try again", 6000);
    });

    await check(SCREEN_CASES[4], async () => {
      for (const kind of ["error", "malformed"]) {
        await mode(kind);
        await sleep(1100);
        await searchFor(BOX, `fire away ${kind}`);
        await app.until(`/try again/i.test(${NOTE(BOX)})`, `the ${kind} message`, 6000);
        const note = await s.evaluate<string>(NOTE(BOX));
        assert.ok(!/offline/i.test(note), `a ${kind} is not called offline (${note})`);
        assert.equal(await s.evaluate<number>(`${ROWS(BOX)}.length`), 0, `no rows after a ${kind}`);
        assert.ok(await s.evaluate<boolean>(`[...${BOX}.closest(".song-search").querySelectorAll("button")].some((b) => b.textContent.trim() === "Try again")`), "a Try again button");
      }
      assert.deepEqual(await newErrors(), [], "no crash");
      await mode("ok");
    });

    await check(SCREEN_CASES[5], async () => {
      await sleep(1100);
      await searchFor(BOX, "fire away");
      await app.until(`${ROWS(BOX)}.length === 2`, "rows");
      await typeInto(BOX, "");
      await app.until(`${ROWS(BOX)}.length === 0`, "the list to clear", 3000);
      assert.ok(!/no songs|offline|try again|searching/i.test(await s.evaluate<string>(NOTE(BOX))), "and no stale message");
    });

    await check(SCREEN_CASES[6], async () => {
      await sleep(1100);
      await searchFor(BOX, "fire away");
      await app.until(`${ROWS(BOX)}.length === 2`, "rows");
      for (const width of [360, 390]) {
        await phone(width);
        const add = await measure(addButton);
        assert.ok(add, "+ Add a song is there to compare with");
        await glove(BOX, "the search box", width, Math.max(44, add.h - 0.5));
        for (const index of [0, 1]) await glove(`${ROWS(BOX)}[${index}]`, `result row ${index + 1}`, width, Math.max(44, add.h - 0.5));
      }
    });

    let pickedId: number | null = null;
    await check(SCREEN_CASES[7], async () => {
      await phone(390);
      const before = (await stored()).length;
      await s.evaluate(`${ROWS(BOX)}[0].click()`);
      await app.until(`/^#\\/song\\/\\d+/.test(location.hash)`, "the new song's page", 6000);
      pickedId = await hashId();
      const songs = await stored();
      assert.equal(songs.length, before + 1, "exactly one song added");
      const song = songs.find((each) => each.id === pickedId);
      assert.ok(song, "the open page is the added song");
      assert.deepEqual(
        { title: song.title, artist: song.artist, officialRuntimeSec: song.officialRuntimeSec },
        { title: "Fire Away", artist: "Pat Bass & The Low End", officialRuntimeSec: 232 },
        "title, artist and length from the pick",
      );
      assert.deepEqual(
        [song.keyRoot, song.keyMode, song.tempo, song.timeSignature, song.body, song.bassNotes, song.copy],
        ["C", "major", null, "4/4", [], [], undefined],
        "every other field at the New song defaults, and no copy mark",
      );
      for (const field of ["keyNote", "tempoNote", "feel", "sourceNote", "atAGlance", "howToPlay", "practiceTip"]) assert.equal(song[field], "", `${field} is empty`);
      await app.until(`document.querySelector(".shell-title")?.textContent.includes("Fire Away") || document.body.innerText.includes("Fire Away")`, "the title on the page");
    });

    await check(SCREEN_CASES[8], async () => {
      assert.ok(pickedId !== null, "a song was picked");
      const link = await s.evaluate<{ tag: string; href: string; target: string } | null>(
        `(() => { const el = ${lyricsLink("document.querySelector('#sheet-scroll')")}; return el ? { tag: el.tagName, href: el.href ?? "", target: el.target ?? "" } : null; })()`,
      );
      assert.ok(link, "Find lyrics on the web is on the new sheet");
      const expected = lyricsUrl('"Fire Away" "Pat Bass & The Low End" lyrics');
      if (link.tag === "A") {
        assert.equal(link.href, expected, "it links to the general search");
        assert.equal(link.target, "_blank", "in the player's browser, not over the app");
      } else {
        await s.evaluate(`${lyricsLink("document.querySelector('#sheet-scroll')")}.click()`);
        assert.deepEqual(await s.evaluate<string[]>(`window.__mb.opened`), [expected], "it opens the general search");
      }
      await s.evaluate(`document.querySelector('[aria-label="Scroll settings"]').click()`);
      await app.until(`[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Learn this song")`, "Learn this song in the Scroll sheet");
      await s.evaluate(`document.querySelector('[role=dialog] [aria-label="Close"]').click()`);
      await sleep(200);
    });

    await check(SCREEN_CASES[9], async () => {
      await s.evaluate(`location.hash = "#/songs"`);
      await app.until(`!!${addButton}`, "My Songs");
      const add = await measure(addButton);
      assert.ok(add, "+ Add a song is there to compare with");
      await s.evaluate(`location.hash = "#/song/${pickedId}"`);
      await app.until(`!!${lyricsLink("document.querySelector('#sheet-scroll')")}`, "the new sheet");
      for (const width of [360, 390]) {
        await phone(width);
        await glove(lyricsLink("document.querySelector('#sheet-scroll')"), "Find lyrics on the web", width, Math.max(44, add.h - 0.5));
      }
      await phone(390);
    });

    await check(SCREEN_CASES[10], async () => {
      await s.evaluate(`location.hash = "#/songs"`);
      await app.until(`!!${addButton}`, "My Songs");
      await app.click("+ Add a song");
      await app.until(`!!${DIALOG_BOX}`, "the catalog search in the New song dialog");
      const before = (await stored()).length;
      await sleep(1100);
      await searchFor(DIALOG_BOX, "fire away live");
      await app.until(`${ROWS(DIALOG_BOX)}.length === 2`, "rows in the dialog", 6000);
      await s.evaluate(`${ROWS(DIALOG_BOX)}[1].click()`);
      await app.until(`/^#\\/song\\/\\d+/.test(location.hash) && !document.querySelector("[role=dialog]")`, "the new song's page with the dialog closed", 6000);
      const songs = await stored();
      assert.equal(songs.length, before + 1, "exactly one song added");
      const openId = await hashId();
      const song = songs.find((each) => each.id === openId);
      assert.ok(song, "the open page is the added song");
      assert.deepEqual([song.title, song.artist, song.officialRuntimeSec, song.body], ["Fire Away (live)", "Pat Bass", 62, []]);
    });

    await check(SCREEN_CASES[11], async () => {
      await s.evaluate(`location.hash = "#/songs"`);
      await app.until(`!!${addButton}`, "My Songs");
      await app.click("+ Add a song");
      await app.until(`!!document.querySelector("[role=dialog]")`, "the New song dialog");
      await typeLabel("Title", "Kitchen Floor");
      await typeLabel("Artist", "Sam Rivera");
      await app.until(`!!${lyricsLink(`document.querySelector("[role=dialog]")`)}`, "Find lyrics on the web in the dialog");
      const read = () =>
        s.evaluate<{ tag: string; href: string; target: string }>(`(() => { const el = ${lyricsLink(`document.querySelector("[role=dialog]")`)}; return { tag: el.tagName, href: el.href ?? "", target: el.target ?? "" }; })()`);
      const link = await read();
      if (link.tag === "A") {
        assert.equal(link.href, lyricsUrl('"Kitchen Floor" "Sam Rivera" lyrics'));
        assert.equal(link.target, "_blank");
      } else {
        await s.evaluate(`${lyricsLink(`document.querySelector("[role=dialog]")`)}.click()`);
        assert.equal((await s.evaluate<string[]>(`window.__mb.opened`)).at(-1), lyricsUrl('"Kitchen Floor" "Sam Rivera" lyrics'));
      }
      await typeLabel("Artist", "");
      await sleep(150);
      const titleOnly = await read();
      if (titleOnly.tag === "A") assert.equal(titleOnly.href, lyricsUrl('"Kitchen Floor" lyrics'), "with no artist, the title alone");
      for (const width of [360, 390]) {
        await phone(width);
        await glove(lyricsLink(`document.querySelector("[role=dialog]")`), "Find lyrics on the web in Add a song", width);
      }
      await phone(390);
      await app.click("Cancel", `document.querySelector("[role=dialog]")`);
    });

    await check(SCREEN_CASES[12], async () => {
      const calls = await s.evaluate<{ url: string }[]>(`window.__mb.calls`);
      assert.ok(calls.length > 0, "the flow searched");
      const other = calls.filter((call) => !call.url.startsWith(RECORDING_SEARCH));
      assert.deepEqual(other, [], "no request but the catalog's recording search left the page");
      assert.ok(!calls.some((call) => /lyric/i.test(call.url)), "no request named lyrics");
      assert.deepEqual(await s.evaluate<string[]>(`window.__mb.opened`).then((opened) => opened.filter((url) => !url.startsWith(GOOGLE))), [], "nothing opened but the general search");
      const everything = await s.evaluate<string>(`JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])))`);
      assert.ok(!everything.includes("DECOY"), "no reply text past title, artist and length was stored");
      assert.deepEqual(await newErrors(), [], "no page errors");
    });
  } finally {
    await s.close();
  }
}
api.close();

console.log(failed ? `check:song-search: ${failed} FAIL` : "check:song-search: all ok");
process.exit(failed ? 1 : 0);
