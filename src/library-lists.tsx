import { useEffect, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { bandSongRef } from "./band-library-model";
import { PRIVACY_HREF } from "./data-kinds";
import { GigSong } from "./gig-plan";
import type { useMetronome } from "./metronome-view";
import type { Notation } from "./music";
import { allOnPhone, heldFor, onPhoneChange, phoneGeneration, type CachedBandSong } from "./phone-db";
import { songHref, type TabName } from "./route";
import { groupedSongs, keyName, matchingSetlists, NO_CHIPS } from "./search";
import { SearchBox, SearchChips } from "./search-box";
import { CodeOfferButton } from "./setlist-code";
import { codeOffer } from "./setlist-code-model";
import { LeadSheet } from "./sheet";
import { hasTiming } from "./song-version";
import { songByRef, tempoText } from "./storage";
import type { Library, Setlist, Song, SongRef } from "./types";

const TABS: [TabName, string][] = [
  ["songs", "My Songs"],
  ["setlists", "Setlists"],
  ["bands", "Bands"],
];

export function Tabs({ tab }: { tab: TabName }) {
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const at = TABS.findIndex(([name]) => name === tab);
    const [next] = TABS[(at + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    document.getElementById(`tab-${next}`)?.focus();
    window.location.hash = `#/${next}`;
  };
  return (
    <div className="tabs" role="tablist" aria-label="Library" onKeyDown={onKey}>
      {TABS.map(([name, label]) => (
        <Tab key={name} name={name} selected={tab === name}>
          {label}
        </Tab>
      ))}
    </div>
  );
}

function Tab({ name, selected, children }: { name: TabName; selected: boolean; children: string }) {
  return (
    <a
      href={`#/${name}`}
      id={`tab-${name}`}
      role="tab"
      aria-selected={selected}
      aria-controls="sheet-scroll"
      tabIndex={selected ? 0 : -1}
      className={selected ? "tab is-selected" : "tab"}
    >
      {children}
    </a>
  );
}

/** Where a copy came from, and the lock when it was shared Private, so it can't be passed on. Nothing for the player's own songs. */
function CopyNote({ song }: { song: Song }) {
  if (!song.copy) return null;
  return (
    <span className="song-copy-note">
      {song.copy.from ? `From ${song.copy.from.name}` : "From a band"}
      {song.copy.canSendOn ? null : (
        <span role="img" aria-label="Private">
          {" "}🔒
        </span>
      )}
    </span>
  );
}

export function SongBody({
  library,
  songRef,
  scale,
  semitones,
  notation,
  metronome,
}: {
  library: Library;
  songRef: SongRef;
  scale: number;
  semitones: number;
  notation: Notation;
  metronome: ReturnType<typeof useMetronome>;
}) {
  const song = songByRef(library.songs, songRef);
  if (!song) {
    return (
      <div className="missing">
        <p>That song isn&apos;t in this library.</p>
        <a href="#/songs">Back to My Songs</a>
      </div>
    );
  }
  return (
    <>
      <CopyNote song={song} />
      <LeadSheet song={song} scale={scale} semitones={semitones} notation={notation} metronome={metronome} />
    </>
  );
}

function SongRowText({ song }: { song: Song }) {
  return (
    <>
      <span className="song-title">{song.title}</span>
      <span className="song-artist">{song.artist}</span>
      <CopyNote song={song} />
      <span className="song-meta">
        <span className="song-key">{song.keyLabel}</span>
        <span> · {song.tempo == null ? "Tempo —" : tempoText(song.tempo)}</span>
      </span>
    </>
  );
}

/**
 * This phone's songs, and while searching, the band songs this phone holds too, grouped by where they live. Nothing
 * here asks the server, and nothing here writes. Signed in, only band data this account saved shows, so another
 * account's never does. Each change to the phone's band data reads it again, so a sign-out that clears the phone
 * empties open results too.
 */
export function SongList({ songs, userId, onAdd }: { songs: Song[]; userId: string | null; onAdd?: () => void }) {
  const [query, setQuery] = useState("");
  const [chips, setChips] = useState(NO_CHIPS);
  const [held, setHeld] = useState<CachedBandSong[]>([]);
  const [open, setOpen] = useState<CachedBandSong | null>(null);
  const searching = query !== "" || chips.key !== null || chips.band !== null || chips.timed;

  const phone = useSyncExternalStore(onPhoneChange, phoneGeneration, phoneGeneration);

  useEffect(() => {
    if (!searching || (userId && !heldFor(userId))) return setHeld([]);
    let current = true;
    allOnPhone("bandSongs").then(
      (rows) => current && setHeld(rows),
      () => current && setHeld([]),
    );
    return () => {
      current = false;
    };
  }, [searching, userId, phone]);

  if (open) {
    return (
      <div className="search-open" data-ref={bandSongRef(open.bandId, open.songId)}>
        <GigSong bandId={open.bandId} item={{ ...open, bandTiming: null }} onBack={() => setOpen(null)} />
      </div>
    );
  }

  const heldByRef = new Map(held.map((item) => [bandSongRef(item.bandId, item.songId), item]));
  const bandSongs = held.map((item): Song => ({ ...item.song, ref: bandSongRef(item.bandId, item.songId), id: 0 }));
  const bands = new Map(held.map((item) => [item.bandId, item.bandName]));
  const keys = [...new Set([...songs, ...bandSongs].map(keyName))].sort();
  const row = (song: Song) => {
    const band = heldByRef.get(song.ref);
    return (
      <li key={song.ref}>
        {band ? (
          <button type="button" className="song-row" onClick={() => setOpen(band)}>
            <SongRowText song={song} />
          </button>
        ) : (
          <a className="song-row" href={songHref(song.id, "songs")}>
            <SongRowText song={song} />
          </a>
        )}
      </li>
    );
  };
  const groups = searching ? groupedSongs([...songs, ...bandSongs], bands, query, chips, hasTiming) : [];
  return (
    <>
      <SearchBox label="Search songs" value={query} onChange={setQuery} />
      {onAdd && !searching ? (
        <button type="button" className="song-list-add" onClick={onAdd}>
          + Add a song
        </button>
      ) : null}
      {searching ? <SearchChips keys={keys} bands={bands} chips={chips} onChange={setChips} /> : null}
      {!searching ? (
        <ul className="song-list">{songs.map(row)}</ul>
      ) : groups.length === 0 ? (
        <p className="search-empty" role="status">
          {query.trim() ? `Nothing matches "${query.trim()}"` : "Nothing matches"}
        </p>
      ) : (
        groups.map((group, index) => (
          <section key={index} className="search-group" aria-label={group.label}>
            <h2 className="search-group-head">{group.label}</h2>
            <ul className="song-list">{group.songs.map(row)}</ul>
          </section>
        ))
      )}
      <a className="privacy-link" href={PRIVACY_HREF}>
        Privacy
      </a>
    </>
  );
}

/** `onShowCode` is there only while signed in, since a code is made on the server. */
export function SetlistList({ setlists, songs, onShowCode }: { setlists: Setlist[]; songs: Song[]; onShowCode?: (setlist: Setlist) => void }) {
  const [query, setQuery] = useState("");
  const shown = matchingSetlists(setlists, songs, query);
  return (
    <>
      <SearchBox label="Search setlists" value={query} onChange={setQuery} />
      {query && shown.length === 0 ? (
        <p className="search-empty" role="status">No setlists match.</p>
      ) : (
        <div className="setlists">
          {shown.map((setlist) => (
            <section key={setlist.id} className="setlist" aria-label={setlist.name}>
              <div className="setlist-head">
                <h2>{setlist.name}</h2>
                {onShowCode ? <CodeOfferButton offer={codeOffer(setlist.songRefs.length, setlist.copy?.canSendOn !== false)} onShow={() => onShowCode(setlist)} /> : null}
                <a className="live-launch" href={`#/live/${setlist.id}/0`}>
                  Live
                </a>
              </div>
              {setlist.songRefs.length === 0 ? (
                <p className="setlist-empty">This setlist is empty.</p>
              ) : (
                <ol>
                  {setlist.songRefs.map((ref, index) => {
                    const song = songByRef(songs, ref);
                    return (
                      <li key={`${setlist.id}-${ref}-${index}`}>
                        {song ? (
                          <a className="song-row setlist-row" href={songHref(song.id, "setlists")}>
                            <span className="setlist-num">{index + 1}</span>
                            <span className="setlist-copy">
                              <span className="song-title">{song.title}</span>
                              <span className="song-artist">{song.artist}</span>
                            </span>
                          </a>
                        ) : (
                          <div className="song-row setlist-row">
                            <span className="setlist-num">{index + 1}</span>
                            <span className="song-artist">Missing from this library</span>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
