import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Song search against the live catalog. `check:song-search` answers the catalog from a stub, and a stub cannot judge
 * which songs a query lists. This sends each typed line below through the app's own `catalogSearcher` to the real
 * catalog and counts the rows that are the song. A line passes when the song is in the first three rows.
 *
 * The paste lookup is measured the same way. Each line of `LOOKUPS` goes through the app's own `pasteLookup`, as the
 * only line a chart with no title sings, or as a typed title with no artist. A lookup passes when the artist a player
 * expects is one of the guesses and that guess spells the title as the line does, apostrophes included.
 *
 * Run it by hand after any change to the query `src/song-search.ts` sends, and record the output in VERIFY.md:
 *   node --experimental-strip-types scripts/song-search-live.ts            every line, about three minutes
 *   node --experimental-strip-types scripts/song-search-live.ts "wagon wheel" "lookup: Sweet Caroline"
 *
 * It is not a `check:*` script, so `npm run verify` never waits on the catalog. The catalog often answers 503 when it is
 * busy. Each line is asked up to four times, and a line the catalog never answers is a FAIL to rerun, not a result.
 */

type CatalogSong = { title: string; artist: string };
type SearchState = { kind: "idle" | "searching" | "none" | "offline" | "failed" } | { kind: "found"; songs: CatalogSong[] };
type Report = (state: SearchState) => void;
type Searcher = { search: (typed: string, report: Report) => void; titled: (title: string, report: Report) => void };
type Section = { heading: string; lines: { chords: string; lyrics: string }[] };
type PasteLookup = (searcher: Searcher, known: { title: string; artist: string }, sections: Section[], report: Report) => void;

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

/** [the title as a chart sings it or a player types it, the artist a player expects]. The last six were not used to shape the query. */
const SUNG: [line: string, artist: string][] = [
  ["Stand by me", "ben e. king"],
  ["Let it be", "beatles"],
  ["Sweet Caroline", "neil diamond"],
  ["Lean on me", "bill withers"],
  ["Come together", "beatles"],
  ["I will survive", "gloria gaynor"],
  ["Don't stop believin'", "journey"],
  ["Free fallin'", "tom petty"],
  ["Wagon wheel", "old crow medicine show"],
  ["Ain't no sunshine", "bill withers"],
  ["Can’t help falling in love", "elvis presley"],
  ["I'm a believer", "monkees"],
  ["Mustang Sally", "wilson pickett"],
  ["Tennessee whiskey", "chris stapleton"],
  ["Brown eyed girl", "van morrison"],
  ["Folsom prison blues", "johnny cash"],
  ["Proud Mary", "creedence clearwater revival"],
  ["Hotel California", "eagles"],
  ["Friends in low places", "garth brooks"],
  ["Sweet home Alabama", "lynyrd skynyrd"],
];
const TYPED: [title: string, artist: string][] = [
  ["Wagon Wheel", "old crow medicine show"],
  ["Don’t Stop Believin’", "journey"],
  ["Ain't No Sunshine", "bill withers"],
];
type Known = { title: string; artist: string };
const LOOKUPS: Record<string, { known: Known; sections: Section[]; line: string; artist: string }> = {};
for (const [line, artist] of SUNG) {
  const sung = { chords: "G C", lyrics: line };
  LOOKUPS[`lookup: ${line}`] = { known: { title: "", artist: "" }, sections: [{ heading: "Chorus", lines: [sung, sung, sung] }], line, artist };
}
for (const [line, artist] of TYPED) LOOKUPS[`typed title: ${line}`] = { known: { title: line, artist: "" }, sections: [], line, artist };

const root = fileURLToPath(new URL("..", import.meta.url));
const bundle = await build({ entryPoints: [join(root, "src", "song-search.ts")], bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" });
const { catalogSearcher, pasteLookup }: { catalogSearcher: (deps: object) => Searcher; pasteLookup: PasteLookup } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const sent: string[] = [];
let largestReply = 0;
const searcher = catalogSearcher({
  // A hand run is not the app, so it names a generic client and no origin.
  fetch: async (url: string, init: RequestInit) => {
    sent.push(new URL(url).searchParams.get("query") ?? "");
    const response = await fetch(url, { ...init, headers: { ...init.headers, "User-Agent": "catalog-query-probe/1.0" } });
    largestReply = Math.max(largestReply, (await response.clone().text()).length);
    return response;
  },
  now: () => Date.now(),
  setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  online: () => true,
  origin: "",
});
const settled = (ask: (report: Report) => void) => new Promise<SearchState>((done) => ask((state) => state.kind !== "searching" && done(state)));
const answer = (name: string) =>
  name in LOOKUPS ? settled((report) => pasteLookup(searcher, LOOKUPS[name].known, LOOKUPS[name].sections, report)) : settled((report) => searcher.search(name, report));
const spelled = (title: string) => title.toLowerCase().replaceAll("’", "'");

const wanted = process.argv.slice(2);
const unknown = wanted.filter((typed) => !(typed in LINES) && !(typed in LOOKUPS));
if (unknown.length) throw new Error(`no such line: ${unknown.join(", ")}`);
let failed = 0;
let looked = 0;
let guessed = 0;
for (const typed of wanted.length ? wanted : [...Object.keys(LINES), ...Object.keys(LOOKUPS)]) {
  let state = await answer(typed);
  for (let tries = 1; tries < 4 && (state.kind === "failed" || state.kind === "offline"); tries += 1) {
    await sleep(3000);
    state = await answer(typed);
  }
  await sleep(1000);
  const rows = state.kind === "found" ? state.songs : [];
  if (typed in LOOKUPS) {
    const { line, artist } = LOOKUPS[typed];
    const at = rows.findIndex((song) => song.artist.toLowerCase().includes(artist) && spelled(song.title).startsWith(spelled(line))) + 1;
    looked += 1;
    if (at) guessed += 1;
    else failed += 1;
    console.log(`${at ? "ok  " : "FAIL"} ${JSON.stringify(typed)}: ${state.kind === "found" ? (at ? `guess ${at} of ${rows.length} is by the artist` : `none of ${rows.length} guesses is by the artist`) : `the lookup said ${state.kind}`}`);
    for (const song of rows) console.log(`       ${song.title} (${song.artist})`);
    continue;
  }
  const hits = rows.filter(LINES[typed]);
  const first = rows.findIndex(LINES[typed]) + 1;
  const pass = first >= 1 && first <= 3;
  if (!pass) failed += 1;
  const result = state.kind === "found" ? `${hits.length} of ${rows.length} rows are the song${first ? `, the first is row ${first}` : ""}` : `the catalog said ${state.kind}`;
  console.log(`${pass ? "ok  " : "FAIL"} ${JSON.stringify(typed)}: ${result}`);
  for (const song of rows.slice(0, 3)) console.log(`       ${song.title} (${song.artist})`);
}
if (looked) console.log(`lookups: the expected artist was a guess for ${guessed} of ${looked}`);
console.log(`asked: ${sent[0] ?? "nothing"}`);
console.log(`largest reply: ${Math.round(largestReply / 1000)} kB before compression`);
process.exit(failed ? 1 : 0);
