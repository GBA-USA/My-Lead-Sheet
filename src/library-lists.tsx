import { useEffect, useId, useRef, useState, useSyncExternalStore, type ComponentProps, type KeyboardEvent } from "react";
import { bandSongRef, songFromSent } from "./band-library-model";
import { CloseMark } from "./close-mark";
import { PRIVACY_HREF } from "./data-kinds";
import { GigSong } from "./gig-plan";
import { useEscape } from "./hooks";
import { lazySheet } from "./lazy-sheet";
import type { useMetronome } from "./metronome-view";
import type { Notation } from "./music";
import { allOnPhone, heldFor, onPhoneChange, phoneGeneration, type CachedBandSong } from "./phone-db";
import { songHref, type TabName } from "./route";
import { groupedSongs, keyName, matchingSetlists, NO_CHIPS } from "./search";
import { SearchBox, SearchChips } from "./search-box";
import type { BuilderTarget, SetlistBuilder as Builder } from "./setlist-builder";
import "./setlist-builder.css";
import { LeadSheet } from "./sheet";
// @ts-expect-error TS5097: song-search.ts holds the same stem, so only ".tsx" names this file in tsc, Vite and esbuild.
import { SongSearch } from "./song-search.tsx";
import { SongStartPanel } from "./song-start";
import { CopyNote, SongRowText } from "./song-row";
import { hasTiming } from "./song-version";
import { songByRef } from "./storage";
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

export function SongBody({
  library,
  songRef,
  scale,
  semitones,
  notation,
  metronome,
  onPaste,
  onLearn,
  onBpm,
}: {
  library: Library;
  songRef: SongRef;
  scale: number;
  semitones: number;
  notation: Notation;
  metronome: ReturnType<typeof useMetronome>;
  onPaste: (text: string) => void;
  onLearn: () => void;
  onBpm: (bpm: number) => void;
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
      <CopyNote copy={song.copy} />
      <SongStartPanel song={song} onPaste={onPaste} onLearn={onLearn} onBpm={onBpm} />
      <LeadSheet song={song} scale={scale} semitones={semitones} notation={notation} metronome={metronome} />
    </>
  );
}

/**
 * This phone's songs, and while searching, the band songs this phone holds too, grouped by where they live. Nothing
 * here asks the server, and nothing here writes. Signed in, only band data this account saved shows, so another
 * account's never does. Each change to the phone's band data reads it again, so a sign-out that clears the phone
 * empties open results too.
 */
/** `onAdd` and `onImport` are there only while signed in. Files dragged onto the page go to `onImport`. */
export function SongList({ songs, userId, onAdd, onImport }: { songs: Song[]; userId: string | null; onAdd?: () => void; onImport?: (files: File[]) => void }) {
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
      (rows) => current && setHeld(rows.map((item) => ({ ...item, song: songFromSent(item.song) }))),
      () => current && setHeld([]),
    );
    return () => {
      current = false;
    };
  }, [searching, userId, phone]);

  // Signed out there is no listener, so a drag does nothing the page did not do before.
  useEffect(() => {
    if (!onImport) return;
    const over = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      onImport(files);
    };
    document.addEventListener("dragover", over);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", drop);
    };
  }, [onImport]);

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
        <>
          <div className="song-list-actions">
            <button type="button" className="song-list-add" onClick={onAdd}>
              + Add a song
            </button>
            {onImport ? (
              <button type="button" className="song-list-add" onClick={() => onImport([])}>
                Import files
              </button>
            ) : null}
          </div>
          <SongSearch songs={songs} />
        </>
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

type BuilderProps = ComponentProps<typeof Builder>;

/** The builder loads on the first tap, so the main script keeps its size. The service worker holds every built file, so it opens offline too. */
const SetlistBuilder = lazySheet<BuilderProps>(
  () => import("./setlist-builder").then((module) => module.SetlistBuilder),
  (props) => <BuilderNote {...props} failed />,
  (props) => <BuilderNote {...props} failed={false} />,
);

const MESSAGES = {
  notLoaded: "The setlist builder couldn't load. Check your connection and try again.",
  opening: "Opening the setlist builder…",
  newSetlist: "New setlist",
  close: "Close",
};

/** Stands where the builder will be: while its code is on its way, or `failed` once it cannot load. */
function BuilderNote({ target, setlists, onClose, failed }: BuilderProps & { failed: boolean }) {
  const titleId = useId();
  useEscape(onClose);
  const heading = target.kind === "edit" ? (setlists.find((setlist) => setlist.id === target.id)?.name ?? MESSAGES.newSetlist) : MESSAGES.newSetlist;
  return (
    <div className="account-backdrop" onClick={onClose}>
      <section
        className={failed ? "setlist-builder" : "setlist-builder-wait"}
        role={failed ? "alertdialog" : undefined}
        aria-modal={failed || undefined}
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="account-top">
          <h2 id={titleId}>{heading}</h2>
          <button type="button" className="account-close" aria-label={MESSAGES.close} onClick={onClose}>
            <CloseMark />
          </button>
        </header>
        <p className={failed ? "account-error" : undefined} role={failed ? "alert" : "status"}>
          {failed ? MESSAGES.notLoaded : MESSAGES.opening}
        </p>
      </section>
    </div>
  );
}

/** `onShowCode` is there only while signed in, since a code is made on the server. */
export function SetlistList({ setlists, songs, onShowCode }: { setlists: Setlist[]; songs: Song[]; onShowCode?: (setlist: Setlist) => void }) {
  const [query, setQuery] = useState("");
  const [builder, setBuilder] = useState<BuilderTarget | null>(null);
  const newBtnRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const shown = matchingSetlists(setlists, songs, query);

  const openBuilder = (target: BuilderTarget, trigger: HTMLElement | null) => {
    returnFocusRef.current = trigger;
    setBuilder(target);
  };

  const closeBuilder = () => {
    const target = returnFocusRef.current;
    setBuilder(null);
    requestAnimationFrame(() => {
      if (document.querySelector("[role=dialog]")) return;
      if (target && target.isConnected) target.focus();
      else newBtnRef.current?.focus();
    });
  };

  return (
    <>
      <SearchBox label="Search setlists" value={query} onChange={setQuery} />
      <div className="setlists-actions">
        <button
          ref={newBtnRef}
          type="button"
          className="setlists-new-btn"
          onClick={(event) => openBuilder({ kind: "new" }, event.currentTarget)}
        >
          + New setlist
        </button>
      </div>
      {query && shown.length === 0 ? (
        <p className="search-empty" role="status">No setlists match.</p>
      ) : setlists.length === 0 ? (
        <p className="search-empty" role="status">No setlists yet.</p>
      ) : (
        <div className="setlists">
          {shown.map((setlist) => (
            <section key={setlist.id} className="setlist" aria-label={setlist.name}>
              <div className="setlist-head">
                <h2>
                  <button
                    type="button"
                    className="setlist-name-btn"
                    onClick={(event) => openBuilder({ kind: "edit", id: setlist.id }, event.currentTarget)}
                  >
                    {setlist.name}
                  </button>
                </h2>
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
                              <SongRowText song={song} facts />
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
      {builder ? (
        <SetlistBuilder
          target={builder}
          setlists={setlists}
          songs={songs}
          onShowCode={onShowCode}
          onCreated={(id) => setBuilder({ kind: "edit", id })}
          onClose={closeBuilder}
        />
      ) : null}
    </>
  );
}
