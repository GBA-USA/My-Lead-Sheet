/**
 * Song search, the half with no screen: the general web search a player opens to find a song's chord chart, and the public
 * song catalog's recording search. The app never asks for, keeps or shows lyrics. The player opens the web search in
 * their own browser and pastes what they find. The catalog gives title, artist, year and length only.
 *
 * A chart the player pasted with no title or artist is looked up here too: `pasteLookup` asks the catalog for the
 * title, or for one or two lines the chart sings, each as a title to search for. What comes back is shown as guesses.
 */

import endpoints from "../data/song-search.json";
import type { ChartSection } from "./types";

const CHART_SEARCH = endpoints.chartSearch;
const RECORDING_SEARCH = endpoints.recordingSearch;
/** Quiet time after the last key before the box asks the catalog. */
export const DEBOUNCE_MS = 600;
/** The catalog's rate rule: never more than one request a second from this phone. */
export const FLOOR_MS = 1000;
/** How long a request may stay out before the box reports `failed` and aborts it, so a hung network still shows Try again. */
const ANSWER_MS = 8000;
/** A catalog that says it is busy (503) or asked too often (429) is asked this many more times before the box says `failed`. */
const BUSY = [503, 429];
const BUSY_RETRIES = 2;
const BUSY_WAIT_MAX_MS = 2000;
const LIMIT = 15;

/** A general web search for `"<title>" "<artist>" chords`, leaving out a blank field. */
export function chartSearchUrl(title: string, artist: string): string {
  const quoted = [title, artist].map((field) => field.trim()).filter(Boolean).map((field) => `"${field}"`);
  return CHART_SEARCH + encodeURIComponent([...quoted, "chords"].join(" "));
}

/** One recording from the catalog, as much as a new sheet uses. */
export type CatalogSong = { id: string; title: string; artist: string; year: string | null; lengthSec: number | null };

export type SearchState =
  | { kind: "idle" }
  | { kind: "searching" | "none" | "offline" | "failed"; query: string }
  | { kind: "found"; query: string; songs: CatalogSong[] };

/** When this phone last asked the catalog. Searchers that share one keep the floor between them. */
export type Floor = { lastSent: number };

export type SearchDeps = {
  fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  online: () => boolean;
  /** Where the app lives, named in the User-Agent so the catalog can reach whoever runs it. */
  origin: string;
  floor?: Floor;
};

export const lengthText = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

/**
 * What the catalog is asked for one typed line, or null when the line holds no words. Words left loose inside a field
 * list titles that repeat one of them, so the line is asked as one phrase (a title typed alone) or as every word (a
 * title typed with its artist). Nothing typed is read as a query operator, capitals included.
 * `scripts/song-search-live.ts` measures a shape against the live catalog.
 */
function catalogQuery(typed: string): string | null {
  const words = typed.toLowerCase().replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const phrase = `"${words.join(" ")}"`;
  const everyWord = words.map((word) => `(recording:${word} OR artist:${word})`).join(" AND ");
  return `recording:${phrase} OR artist:${phrase} OR (${everyWord})`;
}

function requestUrl(asked: string): string {
  const params = new URLSearchParams({ query: asked, fmt: "json", limit: String(LIMIT) });
  return `${RECORDING_SEARCH}?${params}`;
}

/** How long a busy reply asks the phone to wait: its Retry-After in whole seconds, 1 s when missing or unreadable, at most 2 s. */
function busyWaitMs(retryAfter: string | null): number {
  const seconds = retryAfter !== null && /^\s*\d+\s*$/.test(retryAfter) ? Number(retryAfter) : 1;
  return Math.min(seconds * 1000, BUSY_WAIT_MAX_MS);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The reply's recordings, or null when the reply is not a recording list. A recording with no title is left out. */
function songsOf(body: unknown): CatalogSong[] | null {
  if (!isObject(body) || !Array.isArray(body.recordings)) return null;
  return body.recordings.flatMap((recording): CatalogSong[] => {
    if (!isObject(recording) || !text(recording.id) || !text(recording.title).trim()) return [];
    const credits = Array.isArray(recording["artist-credit"]) ? recording["artist-credit"] : [];
    const artist = credits.map((credit) => (isObject(credit) ? text(credit.name) + text(credit.joinphrase) : "")).join("").trim();
    const year = /^\d{4}/.exec(text(recording["first-release-date"]))?.[0] ?? null;
    const ms = recording.length;
    const lengthSec = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.round(ms / 1000)) : null;
    return [{ id: text(recording.id), title: text(recording.title).trim(), artist, year, lengthSec }];
  });
}

/**
 * One search box's link to the catalog. Each `search` replaces the one before: it reports `searching` at once, waits
 * for typing to pause, keeps a second request at least `FLOOR_MS` after the last, and reports what came back. A busy
 * catalog is asked again after its Retry-After while the `ANSWER_MS` budget lasts. A reply for a search that was
 * replaced, or after `stop`, is dropped, and a replaced search asks no more.
 */
export function catalogSearcher(deps: SearchDeps) {
  const floor = deps.floor ?? { lastSent: -Infinity };
  let timer: unknown = null;
  let current = 0;

  const cancel = () => {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
    current += 1;
  };

  const pause = (ms: number) => new Promise<void>((done) => deps.setTimeout(done, ms));

  /** `live` is false once the search that asked was replaced or stopped. */
  function ask(query: string, asked: string, live: () => boolean): Promise<SearchState> {
    if (!deps.online()) return Promise.resolve({ kind: "offline", query });
    const deadline = deps.now() + ANSWER_MS;
    const abort = new AbortController();
    let limit: unknown;
    const late = new Promise<SearchState>((done) => {
      limit = deps.setTimeout(() => {
        done({ kind: "failed", query });
        abort.abort();
      }, ANSWER_MS);
    });
    return Promise.race([read(query, asked, abort.signal, deadline, live), late]).finally(() => deps.clearTimeout(limit));
  }

  async function read(query: string, asked: string, signal: AbortSignal, deadline: number, live: () => boolean): Promise<SearchState> {
    let response: Response;
    for (let retries = 0; ; retries += 1) {
      floor.lastSent = deps.now();
      try {
        const headers = { Accept: "application/json", "User-Agent": `MyLeadSheet/1.0 ( ${deps.origin} )` };
        response = await deps.fetch(requestUrl(asked), { headers, signal });
      } catch {
        return { kind: "offline", query };
      }
      if (!BUSY.includes(response.status) || retries === BUSY_RETRIES) break;
      const wait = Math.max(busyWaitMs(response.headers.get("Retry-After")), floor.lastSent + FLOOR_MS - deps.now());
      if (deps.now() + wait >= deadline) break;
      await pause(wait);
      // Another searcher sharing the floor may have asked during the wait.
      for (let gap; (gap = floor.lastSent + FLOOR_MS - deps.now()) > 0; ) await pause(gap);
      if (signal.aborted || !live()) return { kind: "failed", query };
    }
    if (!response.ok) return { kind: "failed", query };
    let songs: CatalogSong[] | null;
    try {
      songs = songsOf(await response.json());
    } catch {
      return { kind: "failed", query };
    }
    if (songs === null) return { kind: "failed", query };
    return songs.length ? { kind: "found", query, songs } : { kind: "none", query };
  }

  return {
    search(typed: string, report: (state: SearchState) => void) {
      cancel();
      const mine = current;
      const query = typed.trim();
      if (!query) return report({ kind: "idle" });
      const asked = catalogQuery(query);
      if (asked === null) return report({ kind: "none", query });
      report({ kind: "searching", query });
      // The floor is read again when the wait ends, since another searcher sharing it may have asked meanwhile.
      const send = () => {
        const wait = floor.lastSent + FLOOR_MS - deps.now();
        if (wait > 0) return void (timer = deps.setTimeout(send, wait));
        timer = null;
        ask(query, asked, () => mine === current).then((state) => mine === current && report(state));
      };
      timer = deps.setTimeout(send, DEBOUNCE_MS);
    },
    stop: cancel,
  };
}

/** What looking up a pasted chart's missing title or artist came to. A guess is shown for the player to tap, never written for them. */
export type Lookup = { kind: "idle" | "searching" | "none" | "offline" | "failed" } | { kind: "found"; songs: CatalogSong[] };

/** How many sung lines one lookup may ask the catalog for, and how many guesses it shows. */
const LOOKUP_LINES = 2;
const GUESSES = 3;
/** A sung line shorter or longer than this is rarely a title. */
const TITLE_WORDS = { min: 2, max: 8 };

/** The words of a title or a sung line, as they compare: no capitals, no punctuation, and nothing in round brackets such as (live). */
const plainWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/['\p{Pi}\p{Pf}]/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const wordSet = (text: string) => [...new Set(plainWords(text))].sort().join(" ");

/** The sung lines most likely to be the title: the line sung most, a chorus line before a verse line, a short line before a long one. */
function titleLines(sections: ChartSection[]): string[] {
  const lines = new Map<string, { count: number; chorus: boolean; words: number; at: number }>();
  for (const section of sections) {
    const chorus = /chorus|refrain|hook/i.test(section.heading);
    for (const { lyrics } of section.lines) {
      const words = plainWords(lyrics ?? "");
      if (words.length < TITLE_WORDS.min || words.length > TITLE_WORDS.max) continue;
      const line = lines.get(words.join(" "));
      if (!line) lines.set(words.join(" "), { count: 1, chorus, words: words.length, at: lines.size });
      else {
        line.count += 1;
        line.chorus ||= chorus;
      }
    }
  }
  return [...lines]
    .sort(([, a], [, b]) => b.count - a.count || Number(b.chorus) - Number(a.chorus) || a.words - b.words || a.at - b.at)
    .slice(0, LOOKUP_LINES)
    .map(([line]) => line);
}

/** The songs worth showing for what was asked: the title is the asked words and no more, by `artist` when one is known, one row an artist. */
function guessesIn(songs: CatalogSong[], asked: string, artist: string): CatalogSong[] {
  const title = wordSet(asked);
  const by = wordSet(artist);
  const artists = new Set<string>();
  return songs
    .filter((song) => {
      const credit = wordSet(song.artist);
      if (wordSet(song.title) !== title || (by && credit !== by) || artists.has(credit)) return false;
      artists.add(credit);
      return true;
    })
    .slice(0, GUESSES);
}

/**
 * Looks up the title or artist a pasted chart lacks. With a title it asks for that title. With none it asks for the
 * sung lines of `titleLines`, one request a line, until one gives a guess. `report` hears `searching`, then `found`
 * with the guesses, `none`, `offline` or `failed`. Stopping `searcher`, or searching it again, ends the lookup unheard.
 */
export function pasteLookup(
  searcher: Pick<ReturnType<typeof catalogSearcher>, "search">,
  known: { title: string; artist: string },
  sections: ChartSection[],
  report: (lookup: Lookup) => void,
) {
  const asks = known.title.trim() ? [known.title] : titleLines(sections);
  const ask = (index: number) => {
    if (index === asks.length) return report({ kind: "none" });
    searcher.search(asks[index], (state) => {
      if (state.kind === "searching" || state.kind === "offline" || state.kind === "failed") return report({ kind: state.kind });
      const songs = state.kind === "found" ? guessesIn(state.songs, asks[index], known.artist) : [];
      if (songs.length) report({ kind: "found", songs });
      else ask(index + 1);
    });
  };
  ask(0);
}
