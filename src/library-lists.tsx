import { useState } from "react";
import { PRIVACY_HREF } from "./data-kinds";
import type { useMetronome } from "./metronome-view";
import { songHref, type TabName } from "./route";
import { matchingSetlists, matchingSongs } from "./search";
import { SearchBox } from "./search-box";
import { LeadSheet } from "./sheet";
import { songByRef, tempoText } from "./storage";
import type { Library, Setlist, Song, SongRef } from "./types";

export function Tab({ name, selected, children }: { name: TabName; selected: boolean; children: string }) {
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
  notation: "notes" | "nashville";
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
  return <LeadSheet song={song} scale={scale} semitones={semitones} notation={notation} metronome={metronome} />;
}

export function SongList({ songs }: { songs: Song[] }) {
  const [query, setQuery] = useState("");
  const shown = matchingSongs(songs, query);
  return (
    <>
      <SearchBox label="Search songs" value={query} onChange={setQuery} />
      {query && shown.length === 0 ? (
        <p className="search-empty" role="status">No songs match.</p>
      ) : (
        <ul className="song-list">
          {shown.map((song) => (
            <li key={song.ref}>
              <a className="song-row" href={songHref(song.id, "songs")}>
                <span className="song-title">{song.title}</span>
                <span className="song-artist">{song.artist}</span>
                <span className="song-meta">
                  <span className="song-key">{song.keyLabel}</span>
                  <span> · {song.tempo == null ? "Tempo —" : tempoText(song.tempo)}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <a className="privacy-link" href={PRIVACY_HREF}>
        Privacy
      </a>
    </>
  );
}

export function SetlistList({ setlists, songs }: { setlists: Setlist[]; songs: Song[] }) {
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
