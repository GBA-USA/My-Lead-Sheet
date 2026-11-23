/**
 * Song search, the half with no screen: the general web search a player opens to find a song's words, and the public
 * song catalog's recording search. The app never asks for, keeps or shows lyrics. The player opens the web search in
 * their own browser and pastes what they find. The catalog gives title, artist, year and length only.
 */

const LYRICS_SEARCH = "https://www.google.com/search?q=";
const RECORDING_SEARCH = "https://musicbrainz.org/ws/2/recording";
/** Quiet time after the last key before the box asks the catalog. */
export const DEBOUNCE_MS = 600;
/** The catalog's rate rule: never more than one request a second from this phone. */
export const FLOOR_MS = 1000;
const LIMIT = 15;

/** A general web search for `"<title>" "<artist>" lyrics`, leaving out a blank field. */
export function lyricsSearchUrl(title: string, artist: string): string {
  const quoted = [title, artist].map((field) => field.trim()).filter(Boolean).map((field) => `"${field}"`);
  return LYRICS_SEARCH + encodeURIComponent([...quoted, "lyrics"].join(" "));
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
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  online: () => boolean;
  /** Where the app lives, named in the User-Agent so the catalog can reach whoever runs it. */
  origin: string;
  floor?: Floor;
};

export const lengthText = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

/** The typed words with the catalog's query operators turned to spaces, so any title is a plain search. */
const plainWords = (text: string) => text.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ").trim().replace(/\s+/g, " ");

function requestUrl(words: string): string {
  const params = new URLSearchParams({ query: `recording:(${words}) OR artist:(${words})`, fmt: "json", limit: String(LIMIT) });
  return `${RECORDING_SEARCH}?${params}`;
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
 * for typing to pause, keeps a second request at least `FLOOR_MS` after the last, and reports what came back. A reply
 * for a search that was replaced, or after `stop`, is dropped.
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

  async function ask(query: string, words: string): Promise<SearchState> {
    if (!deps.online()) return { kind: "offline", query };
    floor.lastSent = deps.now();
    let response: Response;
    try {
      response = await deps.fetch(requestUrl(words), { headers: { Accept: "application/json", "User-Agent": `MyLeadSheet/1.0 ( ${deps.origin} )` } });
    } catch {
      return { kind: "offline", query };
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
      const words = plainWords(query);
      if (!words) return report({ kind: "none", query });
      report({ kind: "searching", query });
      // The floor is read again when the wait ends, since another searcher sharing it may have asked meanwhile.
      const send = () => {
        const wait = floor.lastSent + FLOOR_MS - deps.now();
        if (wait > 0) return void (timer = deps.setTimeout(send, wait));
        timer = null;
        ask(query, words).then((state) => mine === current && report(state));
      };
      timer = deps.setTimeout(send, DEBOUNCE_MS);
    },
    stop: cancel,
  };
}
