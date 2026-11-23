// song-search.ts holds the same stem, so it is "./song-search.js" here: esbuild maps ".js" to the ".ts" file, as gig-live.tsx does.
import { useEffect, useMemo, useRef, useState } from "react";
import { songHref } from "./route";
import { catalogSearcher, lengthText, lyricsSearchUrl, type CatalogSong, type Floor, type SearchState } from "./song-search.js";
import { ownSong } from "./song-text";
import { addOwnSong, madeHere } from "./storage";
import type { Song } from "./types";
import "./song-search.css";

const NOT_ADDED = "This phone couldn't add the song. Free some space and try again.";

/** Every search box on this phone keeps one floor, so two boxes open at once still ask the catalog at most once a second. */
const PHONE_FLOOR: Floor = { lastSent: -Infinity };

const browserSearcher = () =>
  catalogSearcher({
    fetch: (url, init) => fetch(url, init),
    now: () => performance.now(),
    setTimeout: (run, ms) => window.setTimeout(run, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    online: () => navigator.onLine,
    origin: window.location.origin,
    floor: PHONE_FLOOR,
  });

/** A new own song from a catalog pick: its title, artist and length, and every other field as a new song starts. */
function addCatalogSong(pick: CatalogSong): number | null {
  const blank = ownSong({ title: pick.title, artist: pick.artist, keyRoot: "C", keyMode: "major", tempo: null, timeSignature: "4/4" }, []);
  return addOwnSong({ ...blank, officialRuntimeSec: pick.lengthSec });
}

const MESSAGES: Record<Exclude<SearchState["kind"], "idle" | "found">, (query: string) => string> = {
  searching: () => "Searching…",
  none: (query) => `No songs found for "${query}". Try a different title or artist.`,
  offline: () => "You're offline, so songs can't be found right now. Check your connection, then try again.",
  failed: () => "The song list didn't answer. Try again in a moment.",
};

/** Search the public song catalog and start a new sheet from a pick. Signed in only, the same as + Add a song. */
export function SongSearch() {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [problem, setProblem] = useState("");
  const searcher = useMemo(browserSearcher, []);
  const picked = useRef(false);
  useEffect(() => searcher.stop, [searcher]);

  const change = (next: string) => {
    setQuery(next);
    setProblem("");
    searcher.search(next, setState);
  };
  const pick = (song: CatalogSong) => {
    if (picked.current) return;
    const id = addCatalogSong(song);
    if (id === null) return setProblem(NOT_ADDED);
    picked.current = true;
    window.location.hash = songHref(id, "songs");
  };

  return (
    <section className="song-search" aria-label="Find a song to add">
      <input
        type="search"
        className="search-box song-search-box"
        aria-label="Find a song to add"
        placeholder="Find a song to add: title or artist"
        value={query}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && event.preventDefault()}
      />
      {state.kind === "idle" || state.kind === "found" ? null : (
        <p className="song-search-note" role="status">
          {MESSAGES[state.kind](state.query)}
        </p>
      )}
      {state.kind === "offline" || state.kind === "failed" ? (
        <button type="button" className="song-search-retry" onClick={() => change(query)}>
          Try again
        </button>
      ) : null}
      {state.kind === "found" ? <p className="song-search-note">Tap one to start a new sheet with its title, artist and length.</p> : null}
      {state.kind === "found" ? (
        <ul className="song-search-results" aria-label="Songs found">
          {state.songs.map((song) => (
            <li key={song.id}>
              <button type="button" className="song-row song-search-row" onClick={() => pick(song)}>
                <span className="song-title">{song.title}</span>
                {song.artist ? <span className="song-artist">{song.artist}</span> : null}
                <span className="song-meta">{[song.year, song.lengthSec === null ? null : lengthText(song.lengthSec)].filter(Boolean).join(" · ")}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {problem ? (
        <p className="song-search-note" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

/** Opens a general web search for the song's words in the player's own browser. The app never reads what it finds. */
export function FindLyrics({ title, artist }: { title: string; artist: string }) {
  return (
    <a className="find-lyrics" href={lyricsSearchUrl(title, artist)} target="_blank" rel="noopener noreferrer">
      Find lyrics on the web
    </a>
  );
}

/** On a song the player made with nothing in its chart yet, such as one started from a search: where to find the words, and how to put them in. */
export function NoWordsYet({ song }: { song: Song }) {
  if (!madeHere(song) || song.body.length > 0) return null;
  return (
    <div className="song-search-start">
      <p>No words yet. Find them on the web and copy them, then tap More, Edit and Paste a sheet. Learn this song, under the caret by the Scroll pill, can listen along too.</p>
      <FindLyrics title={song.title} artist={song.artist} />
    </div>
  );
}
