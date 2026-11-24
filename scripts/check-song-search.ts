import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startApi, TEST_ORIGIN } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer } from "./app-page.ts";
import { openSite, type Site } from "./chrome.ts";

/**
 * Song search: start a new sheet from a public song catalog, and Find chords on the web. One case per pass condition,
 * numbered by it. The cases fix this contract:
 *
 * `src/song-search.ts` is pure (no DOM), so other screens can import it:
 * - `chartSearchUrl(title, artist)` is `https://www.google.com/search?q=` plus encodeURIComponent of
 *   `"<title>" "<artist>" chords`, leaving out a field that is blank.
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
 * the New song dialog (once it has a title or artist) offer "Find chords on the web".
 *
 * The unit cases run anywhere. The screen cases build the app and drive headless Chrome (`CHROME`) against a stub
 * `/api/me` and a stub catalog in the page, so nothing here reaches the live catalog or any lyrics site. The last case
 * starts the Worker (`tsc -p worker` runs first): a pick has an empty chart, and an empty chart is no one's to guard.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "worker"], { cwd: root, stdio: "inherit" });
const js =(value: unknown) => JSON.stringify(value);
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
const chartUrl = (words: string) => GOOGLE + encodeURIComponent(words);

type CatalogSong = { id: string; title: string; artist: string; year: string | null; lengthSec: number | null };
type SearchState =
  | { kind: "idle" }
  | { kind: "searching" | "none" | "offline" | "failed"; query: string }
  | { kind: "found"; query: string; songs: CatalogSong[] };
type Deps = {
  fetch: (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  online: () => boolean;
  origin: string;
  floor?: { lastSent: number };
};
type Searcher = { search: (query: string, report: (state: SearchState) => void) => void; stop: () => void };
type SongSearch = { chartSearchUrl: (title: string, artist: string) => string; catalogSearcher: (deps: Deps) => Searcher };

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
/** What the catalog's rate limiter sends when it is busy for a moment. */
const BUSY_BODY = js({ error: "The MusicBrainz web server is currently busy. Please try again later." });
const busy = (status: 503 | 429, retryAfter?: string) =>
  new Response(BUSY_BODY, { status, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } });

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
  const calls: { url: string; headers: Record<string, string>; at: number; signal?: AbortSignal }[] = [];
  const states: SearchState[] = [];
  const searcher = need().catalogSearcher({
    fetch: (url, init) => {
      calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers ?? {})), at: time.now(), signal: init?.signal });
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

await check("1a. Find chords on the web is a general search for the quoted title and artist plus chords", () => {
  const { chartSearchUrl } = need();
  assert.equal(chartSearchUrl("Fire Away", "Pat Bass"), chartUrl('"Fire Away" "Pat Bass" chords'));
  assert.equal(chartSearchUrl("Rock & Roll / Part 2?", "AC/DC"), GOOGLE + encodeURIComponent('"Rock & Roll / Part 2?" "AC/DC" chords'), "every special character is encoded");
  assert.ok(!/site(:|%3A)/i.test(chartSearchUrl("Fire Away", "Pat Bass")), "no site-restricted search");
});

await check("1b. a missing title or artist still searches with what is there, plus chords", () => {
  const { chartSearchUrl } = need();
  assert.equal(chartSearchUrl("Fire Away", ""), chartUrl('"Fire Away" chords'), "no artist");
  assert.equal(chartSearchUrl("", "Pat Bass"), chartUrl('"Pat Bass" chords'), "no title");
  assert.equal(chartSearchUrl("  Fire Away ", "   "), chartUrl('"Fire Away" chords'), "blank space is no field");
  assert.equal(chartSearchUrl("", ""), chartUrl("chords"), "neither");
});

await check("2a. building the chords search asks no network at all", () => {
  const { chartSearchUrl } = need();
  const real = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = (() => {
    asked += 1;
    return Promise.reject(new Error("no fetch allowed"));
  }) as typeof fetch;
  try {
    chartSearchUrl("Fire Away", "Pat Bass");
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

/** The query the catalog is sent for one typed line, or null when no request leaves. */
async function sentQuery(typed: string): Promise<string | null> {
  const run = harness();
  run.search(typed);
  await run.time.advance(2000);
  assert.ok(run.calls.length <= 1, `at most one request for ${js(typed)}`);
  return run.calls.length ? new URL(run.calls[0].url).searchParams.get("query") : null;
}

// 3f and 3g pin the one query shape measured against the live catalog (scripts/song-search-live.ts, VERIFY.md). A stub
// cannot judge which songs a shape lists, so a new shape needs a new live run before these two lines change.
await check("3f. a title alone asks for the whole title as one phrase, so a title that only repeats one of its words is not listed first", async () => {
  const sent = await sentQuery("wagon wheel");
  const want = 'recording:"wagon wheel" OR artist:"wagon wheel" OR ((recording:wagon OR artist:wagon) AND (recording:wheel OR artist:wheel))';
  assert.equal(sent, want, `the catalog was asked ${sent}`);
});

await check("3g. title plus artist in one box asks for every typed word, each in the title or the artist", async () => {
  const each = ["wagon", "wheel", "old", "crow", "medicine", "show"].map((word) => `(recording:${word} OR artist:${word})`).join(" AND ");
  const sent = await sentQuery("wagon wheel old crow medicine show");
  const want = `recording:"wagon wheel old crow medicine show" OR artist:"wagon wheel old crow medicine show" OR (${each})`;
  assert.equal(sent, want, `the catalog was asked ${sent}`);
});

await check("3h. punctuation the catalog reads as a query operator is searched as a space", async () => {
  for (const [typed, plain] of [
    ['"Heroes" (live', "Heroes live"],
    ["AC/DC: Back in Black!", "AC DC Back in Black"],
    ["  rock & roll [take 2]~ *?  ", "rock roll take 2"],
    ["title:fire^2 +away -home || {a} \\b", "title fire 2 away home a b"],
  ]) {
    const sent = await sentQuery(typed);
    assert.ok(sent, `${js(typed)} is searched`);
    assert.equal(sent, await sentQuery(plain), `${js(typed)} asks what ${js(plain)} asks`);
  }
});

await check("3i. a line with nothing but punctuation is No songs found, and no request leaves", async () => {
  for (const typed of ['"(-)" ?!', "***", "&& ||"]) {
    const run = harness();
    run.search(typed);
    await run.time.advance(2000);
    assert.equal(run.calls.length, 0, `no request for ${js(typed)}`);
    assert.deepEqual(run.last(), { kind: "none", query: typed }, `for ${js(typed)}`);
  }
});

await check("3j. AND, OR and NOT typed in capitals are searched as words, not read as operators", async () => {
  for (const [typed, plain] of [
    ["YOU AND ME", "you and me"],
    ["DO OR DIE", "do or die"],
    ["NOT FADE AWAY", "not fade away"],
  ]) {
    const sent = await sentQuery(typed);
    assert.ok(sent, `${js(typed)} is searched`);
    assert.equal(sent, await sentQuery(plain), `${js(typed)} asks what ${js(plain)} asks`);
  }
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
  // A 503 that stays busy is asked twice more, 1 s apart (no Retry-After), so it says failed about 2 s after the
  // first request: 5 s on the clock is past that and still inside the 8 s answer limit.
  const run = harness(() => new Response(BUSY_BODY, { status: 503 }));
  run.search("fire away");
  await run.time.advance(5000);
  assert.deepEqual(run.last(), { kind: "failed", query: "fire away" }, "a 503 that stays busy");
  const broken = harness(() => new Response("oops", { status: 500 }));
  broken.search("fire away");
  await broken.time.advance(2000);
  assert.deepEqual(broken.last(), { kind: "failed", query: "fire away" }, "a 500");
  assert.equal(broken.calls.length, 1, "a 500 is not asked again");
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

await check("6e. a request the catalog never answers says failed within 10 s, so Try again shows, and its late reply is dropped", async () => {
  let release: (response: Response) => void = () => {};
  const hung = new Promise<Response>((done) => (release = done));
  const run = harness(() => (run.calls.length === 1 ? hung : new Response(js(EMPTY), { status: 200 })));
  run.search("wagon wheel");
  await untilSent(run, 1);
  await run.time.advance(3000);
  assert.deepEqual(run.last(), { kind: "searching", query: "wagon wheel" }, "a reply 3 s late still has time to come");
  await run.time.advance(7000);
  assert.deepEqual(run.last(), { kind: "failed", query: "wagon wheel" }, "10 s after the request left, the box says so");
  assert.equal(run.calls.length, 1, "the box does not ask again by itself");
  run.search("wagon wheel");
  await untilSent(run, 2);
  assert.ok(run.calls[1].at - run.calls[0].at >= 1000, `Try again left ${run.calls[1].at - run.calls[0].at} ms after the hung request`);
  await run.time.advance(100);
  assert.deepEqual(run.last(), { kind: "none", query: "wagon wheel" }, "Try again gets the catalog's answer");
  release(new Response(js(PAYLOAD), { status: 200 }));
  await run.time.advance(100);
  assert.ok(!run.states.some((state) => state.kind === "found"), "the hung request's late rows never show");
  assert.equal(run.calls.length, 2, "two requests in all");
});

await check("6f. a reply that sends its headers and then stalls mid-body also says failed within 10 s", async () => {
  const stalled = () =>
    new Response(new ReadableStream({ start: (body) => body.enqueue(new TextEncoder().encode('{"recordings":[')) }), { status: 200 });
  const run = harness(() => (run.calls.length === 1 ? stalled() : new Response(js(EMPTY), { status: 200 })));
  run.search("wagon wheel");
  await untilSent(run, 1);
  await run.time.advance(3000);
  assert.deepEqual(run.last(), { kind: "searching", query: "wagon wheel" }, "the rest of the body still has time to come");
  await run.time.advance(7000);
  assert.deepEqual(run.last(), { kind: "failed", query: "wagon wheel" }, "10 s after the request left, the box says so");
  assert.equal(run.calls.length, 1, "the box does not ask again by itself");
});

await check("6g. a request still out at the limit is aborted, so a hung network keeps no connection open; one that answers is not", async () => {
  const run = harness(() => (run.calls.length === 1 ? new Promise<Response>(() => {}) : new Response(js(EMPTY), { status: 200 })));
  run.search("wagon wheel");
  await untilSent(run, 1);
  const hung = run.calls[0].signal;
  assert.ok(hung instanceof AbortSignal, "the request carries an abort signal");
  await run.time.advance(3000);
  assert.equal(hung.aborted, false, "a request 3 s out still has time");
  await run.time.advance(7000);
  assert.deepEqual(run.last(), { kind: "failed", query: "wagon wheel" }, "the box says failed");
  assert.equal(hung.aborted, true, "the hung request is aborted");
  run.search("wagon wheel");
  await untilSent(run, 2);
  await run.time.advance(10000);
  assert.deepEqual(run.last(), { kind: "none", query: "wagon wheel" }, "Try again gets the catalog's answer");
  assert.equal(run.calls[1].signal?.aborted, false, "a request that answered in time is never aborted");
});

await check("6h. a busy catalog (503) that answers on the next try shows the songs and never says failed", async () => {
  const run = harness(() => (run.calls.length === 1 ? busy(503, "1") : new Response(js(PAYLOAD), { status: 200 })));
  run.search("fire away");
  await untilSent(run, 1);
  await run.time.advance(100);
  assert.deepEqual(run.last(), { kind: "searching", query: "fire away" }, "a busy reply keeps the box searching");
  await run.time.advance(5000);
  assert.equal(run.calls.length, 2, "asked once more");
  assert.equal(run.calls[1].url, run.calls[0].url, "the same request");
  assert.ok(run.calls[1].at - run.calls[0].at >= 1000, `the second try left ${run.calls[1].at - run.calls[0].at} ms after the first`);
  const found = run.last();
  assert.ok(found.kind === "found" && found.query === "fire away", `found (${js(found)})`);
  assert.equal(found.songs.length, 2, "the catalog's rows");
  assert.ok(!run.states.some((state) => state.kind === "failed"), "failed was never said");
});

await check("6i. a catalog busy three times in a row says failed, with no rows, after three requests and inside the 8 s limit", async () => {
  const run = harness(() => busy(503, "1"));
  run.search("fire away");
  await untilSent(run, 1);
  await run.time.advance(4000);
  assert.deepEqual(run.last(), { kind: "failed", query: "fire away" }, "4 s after the first request, well before the 8 s limit");
  assert.equal(run.calls.length, 3, "three tries in all");
  const gaps = run.calls.slice(1).map((call, i) => call.at - run.calls[i].at);
  assert.ok(gaps.every((gap) => gap >= 1000), `each try left at least 1 s after the one before (gaps ${js(gaps)})`);
  await run.time.advance(10000);
  assert.equal(run.calls.length, 3, "no fourth request");
  assert.deepEqual(run.states.filter((state) => state.kind !== "searching"), [{ kind: "failed", query: "fire away" }], "failed said once, and nothing else");
});

await check("6j. a 429 waits its Retry-After (2 s at most, 1 s when missing or unreadable, never under the 1 s floor), then asks again", async () => {
  for (const [header, wait] of [["5", 2000], ["2", 2000], [undefined, 1000], ["soon", 1000], ["0", 1000]] as const) {
    const what = `Retry-After ${header ?? "missing"}`;
    const run = harness(() => (run.calls.length === 1 ? busy(429, header) : new Response(js(PAYLOAD), { status: 200 })));
    run.search("fire away");
    await untilSent(run, 1);
    await run.time.advance(run.calls[0].at + wait - 1 - run.time.now());
    assert.equal(run.calls.length, 1, `${what}: nothing before ${wait} ms`);
    assert.deepEqual(run.last(), { kind: "searching", query: "fire away" }, `${what}: still searching during the wait`);
    await run.time.advance(1);
    assert.equal(run.calls.length, 2, `${what}: asked again at ${wait} ms`);
    assert.equal(run.calls[1].at - run.calls[0].at, wait, `${what}: the second try left ${run.calls[1].at - run.calls[0].at} ms after the first`);
    await run.time.advance(100);
    assert.equal(run.last().kind, "found", `${what}: the retry's rows show`);
  }
});

await check("6k. a new query or stop() during a busy wait ends the old search: no report and no request for it", async () => {
  const run = harness((url) => (new URL(url).searchParams.get("query")?.includes("old") ? busy(503, "2") : new Response(js(EMPTY), { status: 200 })));
  run.search("old song");
  await untilSent(run, 1);
  await run.time.advance(500);
  assert.deepEqual(run.last(), { kind: "searching", query: "old song" }, "the busy reply started a wait");
  run.search("new song");
  await run.time.advance(10000);
  const old = run.calls.filter((call) => new URL(call.url).searchParams.get("query")?.includes("old"));
  assert.equal(old.length, 1, "no request for the old query after it changed");
  assert.ok(!run.states.some((state) => state.kind !== "searching" && "query" in state && state.query === "old song"), `nothing but searching was said for the old query (${js(run.states)})`);
  assert.deepEqual(run.last(), { kind: "none", query: "new song" }, "the new query's answer");

  const stopped = harness(() => busy(503, "2"));
  stopped.search("fire away");
  await untilSent(stopped, 1);
  await stopped.time.advance(500);
  const heard = stopped.states.length;
  stopped.searcher.stop();
  await stopped.time.advance(10000);
  assert.equal(stopped.calls.length, 1, "no request after stop");
  assert.equal(stopped.states.length, heard, "no report after stop");
});

await check("6l. a busy reply too late to wait out inside the 8 s limit says failed at once and asks no more", async () => {
  let release: (response: Response) => void = () => {};
  const run = harness(() => new Promise<Response>((done) => (release = done)));
  run.search("fire away");
  await untilSent(run, 1);
  await run.time.advance(7000);
  release(busy(503, "2"));
  await run.time.advance(10);
  assert.deepEqual(run.last(), { kind: "failed", query: "fire away" }, "7 s in, a 2 s wait cannot end inside the limit");
  await run.time.advance(5000);
  assert.equal(run.calls.length, 1, "no second request");
});

await check("6m. a retry still keeps the 1 s floor when a second box sharing it asked during the wait", async () => {
  const time = fakeTime();
  const floor = { lastSent: -Infinity };
  const calls: { query: string; at: number }[] = [];
  const box = (reply: (query: string) => Response) => {
    const states: SearchState[] = [];
    const searcher = need().catalogSearcher({
      fetch: (url) => {
        const query = new URL(url).searchParams.get("query") ?? "";
        calls.push({ query, at: time.now() });
        return Promise.resolve(reply(query));
      },
      now: time.now,
      setTimeout: time.setTimeout,
      clearTimeout: time.clearTimeout,
      online: () => true,
      origin: PREVIEW_ORIGIN,
      floor,
    });
    return { search: (typed: string) => searcher.search(typed, (state) => states.push(state)), states };
  };
  const dialog = box(() => (calls.length === 1 ? busy(503, "2") : new Response(js(PAYLOAD), { status: 200 })));
  const songs = box(() => new Response(js(EMPTY), { status: 200 }));
  dialog.search("fire away");
  await time.advance(600);
  assert.equal(calls.length, 1, "the dialog's box asked and heard busy, 2 s");
  await time.advance(800);
  songs.search("kitchen floor");
  await time.advance(10000);
  assert.deepEqual(calls.map((call) => (/fire/.test(call.query) ? "fire" : "kitchen")), ["fire", "kitchen", "fire"], "My Songs' box asked during the wait");
  const gaps = calls.slice(1).map((call, i) => call.at - calls[i].at);
  assert.ok(gaps.every((gap) => gap >= 1000), `each request left at least 1 s after the one before (gaps ${js(gaps)})`);
  assert.equal(dialog.states.at(-1)?.kind, "found", "the dialog's retry still found the songs");
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
  window.__mb = { mode: "ok", payload: null, calls: [], opened: [] };
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, location.href);
    if (url.origin === location.origin) return realFetch(input, init);
    window.__mb.calls.push({ url: url.href, headers: Object.fromEntries(new Headers(init.headers || {})), at: performance.now() });
    if (!url.href.startsWith(${js(RECORDING_SEARCH)})) return Promise.reject(new TypeError("refused by the check"));
    const mode = window.__mb.mode;
    if (mode === "offline") return Promise.reject(new TypeError("Failed to fetch"));
    if (mode === "error") return Promise.resolve(new Response("busy", { status: 503 }));
    if (mode === "malformed") return Promise.resolve(new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }));
    return Promise.resolve(new Response(JSON.stringify(mode === "none" ? EMPTY : window.__mb.payload ?? PAYLOAD), { status: 200, headers: { "content-type": "application/json" } }));
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
  "1c. the new sheet offers Find chords on the web for its title and artist, and Learn this song",
  "9b. at 360 px and 390 px Find chords on the web on the new sheet fits and is glove-sized",
  "8b. in Add a song, the same search starts the new song from a pick",
  "1d. in Add a song, Find chords on the web follows the typed title and artist, and fits at 360 px and 390 px",
  "7e. My Songs' box under the open Add a song still waits 1 s after the dialog's box asked, so the phone asks once a second",
  "8c. a second tap on a result before the new sheet opens adds no second song",
  "1e. once the player pastes a chart in, the sheet no longer says No words yet",
  "8d. picking a song this phone already has asks first: Open goes to it, and Add anyway adds one copy",
  "8e. when the phone refuses the write, a pick says so, adds nothing, stays on My Songs, and a later pick still works",
  "8f. in Add a song, picking a song this phone already has asks first, and Open goes to it with nothing added",
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
    const chordsLink = (scope: string) => `[...(${scope}?.querySelectorAll("a, button") ?? [])].find((el) => el.textContent.trim() === "Find chords on the web")`;
    const typeInto = async (box: string, text: string) => {
      await s.evaluate(`(() => { const field = ${box}; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, ${js(text)}); field.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    };
    const typeLabel = async (label: string, text: string) => {
      await s.evaluate(`(() => { const field = [...document.querySelectorAll("[role=dialog] label")].find((l) => l.textContent.trim() === ${js(label)}).control; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, ${js(text)}); field.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    };
    const mode = (next: string) => s.evaluate(`window.__mb.mode = ${js(next)}`);
    /** The catalog answers these recordings until `catalog(null)` puts the usual reply back. */
    const catalog = (recordings: object[] | null) =>
      s.evaluate(`window.__mb.payload = ${recordings ? js({ ...EMPTY, count: recordings.length, recordings }) : "null"}`);
    const recording = (id: string, title: string, artist: string, length: number) => ({ id, score: 100, title, length, "artist-credit": [{ name: artist, joinphrase: "" }], "first-release-date": "2014" });
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
      await app.until(`document.querySelector(".sheet .sheet-name")?.textContent === "Fire Away"`, "the title on the page");
    });

    await check(SCREEN_CASES[8], async () => {
      assert.ok(pickedId !== null, "a song was picked");
      const link = await s.evaluate<{ tag: string; href: string; target: string } | null>(
        `(() => { const el = ${chordsLink("document.querySelector('#sheet-scroll')")}; return el ? { tag: el.tagName, href: el.href ?? "", target: el.target ?? "" } : null; })()`,
      );
      assert.ok(link, "Find chords on the web is on the new sheet");
      const expected = chartUrl('"Fire Away" "Pat Bass & The Low End" chords');
      if (link.tag === "A") {
        assert.equal(link.href, expected, "it links to the general search");
        assert.equal(link.target, "_blank", "in the player's browser, not over the app");
      } else {
        await s.evaluate(`${chordsLink("document.querySelector('#sheet-scroll')")}.click()`);
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
      await app.until(`!!${chordsLink("document.querySelector('#sheet-scroll')")}`, "the new sheet");
      for (const width of [360, 390]) {
        await phone(width);
        await glove(chordsLink("document.querySelector('#sheet-scroll')"), "Find chords on the web", width, Math.max(44, add.h - 0.5));
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
      await app.until(`!!${chordsLink(`document.querySelector("[role=dialog]")`)}`, "Find chords on the web in the dialog");
      const read = () =>
        s.evaluate<{ tag: string; href: string; target: string }>(`(() => { const el = ${chordsLink(`document.querySelector("[role=dialog]")`)}; return { tag: el.tagName, href: el.href ?? "", target: el.target ?? "" }; })()`);
      const link = await read();
      if (link.tag === "A") {
        assert.equal(link.href, chartUrl('"Kitchen Floor" "Sam Rivera" chords'));
        assert.equal(link.target, "_blank");
      } else {
        await s.evaluate(`${chordsLink(`document.querySelector("[role=dialog]")`)}.click()`);
        assert.equal((await s.evaluate<string[]>(`window.__mb.opened`)).at(-1), chartUrl('"Kitchen Floor" "Sam Rivera" chords'));
      }
      await typeLabel("Artist", "");
      await sleep(150);
      const titleOnly = await read();
      if (titleOnly.tag === "A") assert.equal(titleOnly.href, chartUrl('"Kitchen Floor" chords'), "with no artist, the title alone");
      for (const width of [360, 390]) {
        await phone(width);
        await glove(chordsLink(`document.querySelector("[role=dialog]")`), "Find chords on the web in Add a song", width);
      }
      await phone(390);
      await app.click("Cancel", `document.querySelector("[role=dialog]")`);
    });

    await check(SCREEN_CASES[12], async () => {
      const SONGS_BOX = `[...document.querySelectorAll('input[aria-label="Find a song to add"]')].find((el) => !el.closest("[role=dialog]"))`;
      await s.evaluate(`location.hash = "#/songs"`);
      await app.until(`!!${addButton}`, "My Songs");
      await app.click("+ Add a song");
      await app.until(`!!${DIALOG_BOX} && !!${SONGS_BOX}`, "both search boxes, the dialog's and My Songs' beneath it");
      await sleep(1100);
      const sent = (await s.evaluate<unknown[]>(`window.__mb.calls`)).length;
      // The moment the dialog's box asks the catalog, the player types in My Songs' box as well.
      await s.evaluate(`(() => {
        const inner = window.fetch;
        window.fetch = (input, init) => {
          if (!String(input).startsWith(${js(RECORDING_SEARCH)})) return inner(input, init);
          window.fetch = inner;
          setTimeout(() => {
            const field = ${SONGS_BOX};
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, "kitchen floor");
            field.dispatchEvent(new Event("input", { bubbles: true }));
          }, 0);
          return inner(input, init);
        };
      })()`);
      try {
        await typeInto(DIALOG_BOX, "fire away");
        await app.until(`window.__mb.calls.length >= ${sent + 2}`, "a request from each box", 8000);
        const [first, second] = (await s.evaluate<{ url: string; at: number }[]>(`window.__mb.calls`)).slice(sent);
        assert.match(new URL(first.url).searchParams.get("query") ?? "", /fire/i, "the dialog's box asked first");
        assert.match(new URL(second.url).searchParams.get("query") ?? "", /kitchen/i, "then My Songs' box");
        // The stub logs a request a moment after the floor's own clock read, so 5 ms of slack, far from the 600 ms debounce.
        assert.ok(second.at - first.at >= 995, `My Songs' box asked ${(second.at - first.at).toFixed(1)} ms after the dialog's box`);
      } finally {
        await app.click("Cancel", `document.querySelector("[role=dialog]")`);
      }
    });

    let tappedId: number | null = null;
    await check(SCREEN_CASES[13], async () => {
      await s.evaluate(`location.hash = "#/songs"`);
      await app.until(`!!${addButton} && !document.querySelector("[role=dialog]")`, "My Songs");
      // A song no one on this phone holds, so the first tap adds and the second meets only the double-tap guard.
      await catalog([recording("rec-wagon", "Wagon Wheel", "Pat Bass", 245000)]);
      try {
        await sleep(1100);
        await searchFor(BOX, "wagon wheel");
        await app.until(`${ROWS(BOX)}.length === 1`, "the one row");
        const before = (await stored()).length;
        await s.evaluate(`(() => { const row = ${ROWS(BOX)}[0]; row.click(); row.click(); })()`);
        await app.until(`/^#\\/song\\/\\d+/.test(location.hash)`, "the new song's page", 6000);
        await sleep(300);
        tappedId = await hashId();
        assert.equal((await stored()).length, before + 1, "exactly one song added for two taps");
      } finally {
        await catalog(null);
      }
    });

    await check(SCREEN_CASES[14], async () => {
      assert.ok(tappedId !== null, "a song was picked");
      const NO_WORDS = `(document.querySelector("#sheet-scroll")?.textContent ?? "").includes("No words yet")`;
      await app.until(NO_WORDS, "No words yet on the new sheet");
      await s.evaluate(`document.querySelector('.shell-header [aria-label="More"]').click()`);
      await app.until(`!!document.querySelector("[role=menu]")`, "the More menu");
      await app.click("Edit", `document.querySelector("[role=menu]")`);
      const editor = `document.querySelector(".song-editor[role=dialog]")`;
      await app.until(`!!${editor}`, "the editor on the new song");
      const chart = ["[Verse 1]", "G        C", "Fire away, fire away"].join("\n");
      await s.evaluate(`(() => {
        const field = [...${editor}.querySelectorAll("label")].find((l) => l.textContent.trim() === "Chart").control;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${js(chart)});
        field.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await app.click("Save", editor);
      await app.until(`!document.querySelector(".song-editor")`, "the editor to close");
      const song = (await stored()).find((each) => each.id === tappedId);
      assert.ok(Array.isArray(song?.body) && song.body.length > 0, "the song holds the pasted chart");
      await app.until(`!!document.querySelector("#sheet-scroll .chart-heading")`, "the pasted chart on the sheet");
      assert.equal(await s.evaluate<boolean>(NO_WORDS), false, "No words yet is gone once the song has words");
    });

    await check(SCREEN_CASES[15], async () => {
      await s.evaluate(`location.hash = "#/songs"`);
      await app.until(`!!${addButton} && !document.querySelector("[role=dialog]")`, "My Songs");
      const heldHref = await s.evaluate<string[]>(
        `[...document.querySelectorAll(".song-list a.song-row")].filter((a) => a.textContent.includes("Fire Away") && a.textContent.includes("Chris Stapleton")).map((a) => a.getAttribute("href"))`,
      );
      assert.equal(heldHref.length, 1, `My Songs holds the built-in Fire Away by Chris Stapleton once (${js(heldHref)})`);
      const OFFER = `${BOX}?.closest(".song-search")?.querySelector(".you-have-it")`;
      const inOffer = (label: string) => `[...(${OFFER}?.querySelectorAll("a, button") ?? [])].find((el) => el.textContent.trim() === ${js(label)})`;
      await catalog([recording("rec-stapleton", "Fire Away", "Chris Stapleton", 232000)]);
      try {
        const before = (await stored()).length;
        const tapHeld = async () => {
          await sleep(1100);
          await searchFor(BOX, "fire away stapleton");
          await app.until(`${ROWS(BOX)}.length === 1`, "the one row");
          await s.evaluate(`${ROWS(BOX)}[0].click()`);
          await app.until(`!!${OFFER} || /^#\\/song\\//.test(location.hash)`, "an answer to the tap", 4000);
          await sleep(300);
          assert.equal(await s.evaluate<string>(`location.hash`), "#/songs", "the tap stays on My Songs");
          assert.equal((await stored()).length, before, "the tap adds no second Fire Away");
        };
        await tapHeld();
        assert.match(await s.evaluate<string>(`${OFFER}.textContent`), /You already have Fire Away/, "it says the phone has it");
        assert.equal(await s.evaluate<string>(`${inOffer("Open")}?.getAttribute("href") ?? ""`), heldHref[0], "Open goes to the Fire Away this phone has");
        await phone(360);
        for (const label of ["Open", "Add anyway"]) await glove(inOffer(label), label, 360);
        await phone(390);
        await s.evaluate(`${inOffer("Open")}.click()`);
        await app.until(`location.hash === ${js(heldHref[0])}`, "the Fire Away this phone has", 4000);
        assert.equal((await stored()).length, before, "Open adds nothing");
        await s.evaluate(`location.hash = "#/songs"`);
        await app.until(`!!${BOX} && !${OFFER}`, "My Songs, with no offer left over");
        await tapHeld();
        await s.evaluate(`(() => { const add = ${inOffer("Add anyway")}; add.click(); add.click(); })()`);
        await app.until(`/^#\\/song\\/\\d+/.test(location.hash)`, "the new song's page", 6000);
        await sleep(300);
        const songs = await stored();
        assert.equal(songs.length, before + 1, "Add anyway, tapped twice, adds one copy");
        const openId = await hashId();
        const song = songs.find((each) => each.id === openId);
        assert.deepEqual([song?.title, song?.artist, song?.officialRuntimeSec, song?.body], ["Fire Away", "Chris Stapleton", 232, []], "the open page is the added copy");
      } finally {
        await catalog(null);
      }
    });

    await check(SCREEN_CASES[16], async () => {
      await s.evaluate(`location.hash = "#/songs"`);
      await app.until(`!!${addButton} && !document.querySelector("[role=dialog]")`, "My Songs");
      await catalog([recording("rec-gravel", "Gravel Road", "Pat Bass", 201000)]);
      // The phone refuses only the library write, as a full or locked-down storage does.
      await s.evaluate(`(() => {
        const real = Storage.prototype.setItem;
        window.__realSetItem = real;
        Storage.prototype.setItem = function (key, value) {
          if (key === "leadSheetsLibrary") throw new DOMException("full", "QuotaExceededError");
          return real.call(this, key, value);
        };
      })()`);
      try {
        const before = (await stored()).length;
        await sleep(1100);
        await searchFor(BOX, "gravel road");
        await app.until(`${ROWS(BOX)}.length === 1`, "the one row");
        await s.evaluate(`${ROWS(BOX)}[0].click()`);
        await app.until(`/couldn't add/.test(${NOTE(BOX)}) || /^#\\/song\\//.test(location.hash)`, "an answer to the tap", 4000);
        await sleep(300);
        assert.equal(await s.evaluate<string>(`location.hash`), "#/songs", "the page stays on My Songs");
        assert.equal(
          await s.evaluate<string>(`${BOX}.closest(".song-search").querySelector("[role=alert]")?.textContent ?? ""`),
          "This phone couldn't add the song. Free some space and try again.",
          "it says the phone couldn't add the song",
        );
        assert.equal((await stored()).length, before, "no song added");
        await s.evaluate(`Storage.prototype.setItem = window.__realSetItem`);
        await s.evaluate(`${ROWS(BOX)}[0].click()`);
        await app.until(`/^#\\/song\\/\\d+/.test(location.hash)`, "the new song's page once the phone can write again", 6000);
        const openId = await hashId();
        const song = (await stored()).find((each) => each.id === openId);
        assert.deepEqual([song?.title, song?.artist], ["Gravel Road", "Pat Bass"], "the later pick adds the song");
      } finally {
        await s.evaluate(`if (window.__realSetItem) Storage.prototype.setItem = window.__realSetItem`);
        await catalog(null);
      }
    });

    await check(SCREEN_CASES[17], async () => {
      await s.evaluate(`location.hash = "#/songs"`);
      await app.until(`!!${addButton} && !document.querySelector("[role=dialog]")`, "My Songs");
      const heldHref = await s.evaluate<string | null>(
        `[...document.querySelectorAll(".song-list a.song-row")].find((a) => a.textContent.includes("Fire Away") && a.textContent.includes("Chris Stapleton"))?.getAttribute("href") ?? null`,
      );
      assert.ok(heldHref, "My Songs holds the built-in Fire Away by Chris Stapleton");
      const OFFER = `${DIALOG_BOX}?.closest(".song-search")?.querySelector(".you-have-it")`;
      const open = `[...(${OFFER}?.querySelectorAll("a, button") ?? [])].find((el) => el.textContent.trim() === "Open")`;
      await catalog([recording("rec-stapleton", "Fire Away", "Chris Stapleton", 232000)]);
      try {
        await app.click("+ Add a song");
        await app.until(`!!${DIALOG_BOX}`, "the catalog search in the New song dialog");
        const before = (await stored()).length;
        await sleep(1100);
        await searchFor(DIALOG_BOX, "fire away stapleton");
        await app.until(`${ROWS(DIALOG_BOX)}.length === 1`, "the one row in the dialog");
        await s.evaluate(`${ROWS(DIALOG_BOX)}[0].click()`);
        await app.until(`!!${OFFER} || /^#\\/song\\//.test(location.hash)`, "an answer to the tap", 4000);
        await sleep(300);
        assert.equal(await s.evaluate<string>(`location.hash`), "#/songs", "the tap stays in Add a song");
        assert.equal((await stored()).length, before, "the tap adds no second Fire Away");
        assert.match(await s.evaluate<string>(`${OFFER}.textContent`), /You already have Fire Away/, "the dialog says the phone has it");
        await s.evaluate(`${open}.click()`);
        await app.until(`location.hash === ${js(heldHref)} && !document.querySelector("[role=dialog]")`, "the Fire Away this phone has, with the dialog closed", 4000);
        assert.equal((await stored()).length, before, "Open adds nothing");
      } finally {
        await catalog(null);
      }
    });

    await check(SCREEN_CASES[18], async () => {
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

// ---------------------------------------------------------------------------------------------- Worker case

await check("10. a player's own catalog picks send on after a friend's Private pick arrived, while the friend's Private words still stay put", async () => {
  const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: Record<string, unknown>[] };
  const { id: _id, ...base } = seed.songs[0];
  const pick = (title: string, artist: string) => ({ ...base, title, artist, body: [], officialRuntimeSec: 232 });
  const withWords = (title: string, words: string) => ({ ...base, title, artist: "Bea", body: [{ heading: "Verse 1", lines: [{ chords: "G", lyrics: words }] }] });
  const newId = () => crypto.randomUUID().replace(/-/g, "");
  const { worker, base: apiUrl } = await startApi({ PASSWORD_PEPPER });
  try {
    const [bea, pat, cal] = [await passwordPlayer(apiUrl, TEST_ORIGIN, "Bea", "bea"), await passwordPlayer(apiUrl, TEST_ORIGIN, "Pat", "pat"), await passwordPlayer(apiUrl, TEST_ORIGIN, "Cal", "cal")];
    for (const [a, b] of [[bea, pat], [pat, cal]]) {
      assert.equal((await a.call("/api/friends/request", { handle: b.handle })).status, 200, `${a.name} asks ${b.name}`);
      assert.equal((await b.call("/api/friends/accept", { userId: a.userId })).status, 200, `${b.name} accepts ${a.name}`);
    }
    const send = (from: typeof bea, to: typeof bea, song: object, choice: string) =>
      from.call("/api/chat/send-song", { userId: to.userId, msgId: newId(), shareId: newId(), song, versions: [], data: null, choice });
    assert.equal((await send(bea, pat, pick("Fire Away", "Bea Band"), "private")).status, 200, "Bea sends Pat her own pick, Private");
    assert.equal((await send(bea, pat, withWords("Bea's Tune", "words only Bea wrote"), "private")).status, 200, "Bea sends Pat her own song with words, Private");
    for (const choice of ["public", "private"]) {
      const reply = await send(pat, cal, pick("Wagon Wheel", "Pat"), choice);
      assert.equal(reply.status, 200, `Pat sends Cal Pat's own pick ${choice} (${reply.status} ${js(reply.body)})`);
    }
    const passOn = await send(pat, cal, withWords("Pat's Tune", "words only Bea wrote"), "public");
    assert.deepEqual([passOn.status, passOn.body.error], [403, "private_copy"], "Bea's Private words still can't be passed on as Pat's");
  } finally {
    await worker.dispose();
  }
});

console.log(failed ? `check:song-search: ${failed} FAIL` : "check:song-search: all ok");
process.exit(failed ? 1 : 0);
