import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Song search against the live catalog. `check:song-search` answers the catalog from a stub, and a stub cannot judge
 * which songs a query lists. This sends each typed line below through the app's own `catalogSearcher` to the real
 * catalog and counts the rows that are the song. A line passes when the song is in the first three rows.
 *
 * Run it by hand after any change to the query `src/song-search.ts` sends, and record the output in VERIFY.md:
 *   node --experimental-strip-types scripts/song-search-live.ts            every line, about a minute
 *   node --experimental-strip-types scripts/song-search-live.ts "wagon wheel" "fire away"
 *
 * It is not a `check:*` script, so `npm run verify` never waits on the catalog. The catalog often answers 503 when it is
 * busy. Each line is asked up to four times, and a line the catalog never answers is a FAIL to rerun, not a result.
 */

type CatalogSong = { title: string; artist: string };
type SearchState = { kind: "idle" | "searching" | "none" | "offline" | "failed" } | { kind: "found"; songs: CatalogSong[] };
type Searcher = { search: (typed: string, report: (state: SearchState) => void) => void };

const titled = (title: string, artist = "") => (song: CatalogSong) =>
  song.title.toLowerCase().startsWith(title) && song.artist.toLowerCase().includes(artist);
const LINES: Record<string, (song: CatalogSong) => boolean> = {
  "wagon wheel": titled("wagon wheel"),
  "fire away": titled("fire away"),
  "mustang sally": titled("mustang sally"),
  "tennessee whiskey": titled("tennessee whiskey"),
  "the weight": titled("the weight"),
  "chris stapleton": titled("", "chris stapleton"),
  "wagon wheel old crow medicine show": titled("wagon wheel", "old crow medicine show"),
  "tennessee whiskey chris stapleton": titled("tennessee whiskey", "chris stapleton"),
  '"Heroes" (live': titled("heroes"),
  "YOU AND ME": titled("you and me"),
};

const root = fileURLToPath(new URL("..", import.meta.url));
const bundle = await build({ entryPoints: [join(root, "src", "song-search.ts")], bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" });
const { catalogSearcher } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const sent: string[] = [];
const searcher: Searcher = catalogSearcher({
  // A hand run is not the app, so it names a generic client and no origin.
  fetch: (url: string, init: RequestInit) => {
    sent.push(new URL(url).searchParams.get("query") ?? "");
    return fetch(url, { ...init, headers: { ...init.headers, "User-Agent": "catalog-query-probe/1.0" } });
  },
  now: () => Date.now(),
  setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  online: () => true,
  origin: "",
});
const answer = (typed: string) =>
  new Promise<SearchState>((done) => searcher.search(typed, (state) => state.kind !== "searching" && done(state)));

const wanted = process.argv.slice(2);
const unknown = wanted.filter((typed) => !(typed in LINES));
if (unknown.length) throw new Error(`no such line: ${unknown.join(", ")}`);
let failed = 0;
for (const typed of wanted.length ? wanted : Object.keys(LINES)) {
  let state = await answer(typed);
  for (let tries = 1; tries < 4 && (state.kind === "failed" || state.kind === "offline"); tries += 1) {
    await sleep(3000);
    state = await answer(typed);
  }
  await sleep(1000);
  const rows = state.kind === "found" ? state.songs : [];
  const hits = rows.filter(LINES[typed]);
  const first = rows.findIndex(LINES[typed]) + 1;
  const pass = first >= 1 && first <= 3;
  if (!pass) failed += 1;
  const result = state.kind === "found" ? `${hits.length} of ${rows.length} rows are the song${first ? `, the first is row ${first}` : ""}` : `the catalog said ${state.kind}`;
  console.log(`${pass ? "ok  " : "FAIL"} ${JSON.stringify(typed)}: ${result}`);
  for (const song of rows.slice(0, 3)) console.log(`       ${song.title} (${song.artist})`);
}
console.log(`asked: ${sent[0] ?? "nothing"}`);
process.exit(failed ? 1 : 0);
