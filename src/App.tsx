import { useEffect, useState, type KeyboardEvent } from "react";
import { BackIcon, DotsIcon, OverflowMenu, ScreenToggle, SongControls } from "./controls";
import { useAutoScroll, usePerformance, useWakeLock } from "./hooks";
import { useMetronome } from "./metronome-view";
import { displayKeyLabel, scrollPixelsPerSecond } from "./music";
import { LeadSheet } from "./sheet";
import {
  TEXT_SCALES,
  loadAwake,
  loadLibrary,
  loadTextScaleIndex,
  saveAwake,
  saveTextScaleIndex,
  songById,
  tempoText,
} from "./storage";
import type { LibraryFile, Setlist, Song } from "./types";

type TabName = "songs" | "setlists";

type Route =
  | { name: "songs" }
  | { name: "setlists" }
  | { name: "song"; id: number; from: TabName }
  | { name: "live"; setlistId: number; index: number };

type MenuId = "shell" | "song" | null;

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const path = (raw.split("?")[0] || "/songs").replace(/\/$/, "") || "/songs";
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
  const live = path.match(/^\/live\/(\d+)(?:\/(\d+))?$/);
  if (live) return { name: "live", setlistId: Number(live[1]), index: Number(live[2] ?? 0) };
  const match = path.match(/^\/song\/(\d+)$/);
  if (match) {
    const from = new URLSearchParams(query).get("from") === "setlists" ? "setlists" : "songs";
    return { name: "song", id: Number(match[1]), from };
  }
  if (path === "/setlists") return { name: "setlists" };
  return { name: "songs" };
}

function songHref(id: number, from: TabName): string {
  return from === "setlists" ? `#/song/${id}?from=setlists` : `#/song/${id}`;
}

export function App() {
  const [library] = useState<LibraryFile>(() => loadLibrary());
  const [hash, setHash] = useState(() => window.location.hash);
  const [textIndex, setTextIndex] = useState(() => loadTextScaleIndex());
  const [awake, setAwake] = useState(() => loadAwake());
  const [menu, setMenu] = useState<MenuId>(null);

  useEffect(() => {
    if (!window.location.hash) {
      history.replaceState(null, "", "#/songs");
    }
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const route = parseHash(hash);
  const tab: TabName =
    route.name === "setlists" || (route.name === "song" && route.from === "setlists")
      ? "setlists"
      : "songs";

  const liveSetlist = route.name === "live" ? library.setlists.find((set) => set.id === route.setlistId) : undefined;
  const liveIndex =
    route.name === "live" && liveSetlist
      ? Math.min(Math.max(route.index, 0), Math.max(liveSetlist.songIds.length - 1, 0))
      : 0;
  const liveSong =
    route.name === "live" && liveSetlist ? songById(library.songs, liveSetlist.songIds[liveIndex] ?? -1) : undefined;
  const activeSong =
    route.name === "song" ? songById(library.songs, route.id) : route.name === "live" ? liveSong : undefined;

  const performance = usePerformance(activeSong?.id ?? null);
  const metronome = useMetronome(activeSong?.id ?? null, activeSong ? activeSong.tempo : null);
  // Scroll reads the stored song tempo and the scroll percentage only.
  // metronome.bpm is a separate performance setting and must not be passed in.
  useAutoScroll(
    performance.scrolling && activeSong != null,
    activeSong ? scrollPixelsPerSecond(activeSong.tempo, performance.percent) : 0,
    performance.stopScroll,
  );
  useWakeLock(awake);

  useEffect(() => {
    document.getElementById("sheet-scroll")?.scrollTo(0, 0);
    setMenu(null);
    const current = parseHash(hash);
    const titleSong =
      current.name === "song"
        ? songById(library.songs, current.id)
        : current.name === "live"
          ? songById(
              library.songs,
              library.setlists.find((set) => set.id === current.setlistId)?.songIds[current.index] ?? -1,
            )
          : undefined;
    document.title = titleSong ? `${titleSong.title} — Lead Sheets` : "Lead Sheets";
  }, [hash, library.songs, library.setlists]);

  const closeMenu = () => setMenu(null);
  const toggleMenu = (id: Exclude<MenuId, null>) => setMenu((current) => (current === id ? null : id));

  const changeText = (index: number) => {
    const next = Math.max(0, Math.min(TEXT_SCALES.length - 1, index));
    setTextIndex(next);
    saveTextScaleIndex(next);
  };

  const toggleAwake = () => {
    setAwake((current) => {
      saveAwake(!current);
      return !current;
    });
  };

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    window.location.hash = tab === "songs" ? "#/setlists" : "#/songs";
  };

  const goBack = () => {
    if (route.name === "song") {
      window.location.hash = route.from === "setlists" ? "#/setlists" : "#/songs";
    } else if (route.name === "live") {
      window.location.hash = "#/setlists";
    }
  };

  const goLive = (index: number) => {
    if (route.name !== "live") return;
    window.location.hash = `#/live/${route.setlistId}/${index}`;
  };

  return (
    <div className="app">
      <header className="shell-header">
        <button
          type="button"
          className="icon-btn"
          aria-label="Back"
          disabled={route.name !== "song" && route.name !== "live"}
          onClick={goBack}
        >
          <BackIcon />
        </button>
        <h1 className="shell-title">Lead Sheets</h1>
        {activeSong ? (
          <OverflowMenu
            label="More"
            size="shell"
            open={menu === "shell"}
            onToggle={() => toggleMenu("shell")}
            onClose={closeMenu}
            onEdit={closeMenu}
            onDelete={closeMenu}
          />
        ) : (
          <button type="button" className="icon-btn" aria-label="More">
            <DotsIcon />
          </button>
        )}
      </header>

      {route.name === "live" ? null : (
        <div className="tabs" role="tablist" aria-label="Library" onKeyDown={onTabKey}>
          <a href="#/songs" role="tab" aria-selected={tab === "songs"} className={tab === "songs" ? "tab is-selected" : "tab"}>
            My Songs
          </a>
          <a
            href="#/setlists"
            role="tab"
            aria-selected={tab === "setlists"}
            className={tab === "setlists" ? "tab is-selected" : "tab"}
          >
            Setlists
          </a>
        </div>
      )}

      {activeSong ? (
        <SongControls
          textIndex={textIndex}
          textCount={TEXT_SCALES.length}
          onTextIndex={changeText}
          awake={awake}
          onAwake={toggleAwake}
          menuOpen={menu === "song"}
          onMenuToggle={() => toggleMenu("song")}
          onMenuClose={closeMenu}
          onEdit={closeMenu}
          onDelete={closeMenu}
          notation={performance.notation}
          onNotation={performance.changeNotation}
          scrolling={performance.scrolling}
          onToggleScroll={() => performance.setScrolling((on) => !on)}
          percent={performance.percent}
          onPercent={performance.changePercent}
          keyLabel={displayKeyLabel(activeSong, performance.semitones)}
          onTransposeDown={() => performance.setSemitones((value) => value - 1)}
          onTransposeUp={() => performance.setSemitones((value) => value + 1)}
          onOriginalKey={() => performance.setSemitones(0)}
        />
      ) : (
        <div className="list-tools">
          <ScreenToggle on={awake} onToggle={toggleAwake} />
        </div>
      )}

      {route.name === "live" && liveSetlist ? (
        <div className="live-nav">
          <button type="button" aria-label="Previous song" disabled={liveIndex <= 0} onClick={() => goLive(liveIndex - 1)}>
            Prev
          </button>
          <span className="live-count">
            {liveSetlist.name} · {liveIndex + 1}/{liveSetlist.songIds.length}
          </span>
          <button
            type="button"
            aria-label="Next song"
            disabled={liveIndex >= liveSetlist.songIds.length - 1}
            onClick={() => goLive(liveIndex + 1)}
          >
            Next
          </button>
        </div>
      ) : null}

      <div className="scroll" id="sheet-scroll">
        {route.name === "songs" ? <SongList songs={library.songs} /> : null}
        {route.name === "setlists" ? <SetlistList setlists={library.setlists} songs={library.songs} /> : null}
        {route.name === "song" ? (
          <SongBody
            library={library}
            id={route.id}
            scale={TEXT_SCALES[textIndex]}
            semitones={performance.semitones}
            notation={performance.notation}
            metronome={metronome}
          />
        ) : null}
        {route.name === "live" ? (
          liveSong ? (
            <LeadSheet
              song={liveSong}
              scale={TEXT_SCALES[textIndex]}
              semitones={performance.semitones}
              notation={performance.notation}
              metronome={metronome}
            />
          ) : (
            <div className="missing">
              <p>That setlist isn&apos;t in this library.</p>
              <a href="#/setlists">Back to Setlists</a>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

function SongBody({
  library,
  id,
  scale,
  semitones,
  notation,
  metronome,
}: {
  library: LibraryFile;
  id: number;
  scale: number;
  semitones: number;
  notation: "notes" | "nashville";
  metronome: ReturnType<typeof useMetronome>;
}) {
  const song = songById(library.songs, id);
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

function SongList({ songs }: { songs: Song[] }) {
  return (
    <ul className="song-list">
      {songs.map((song) => (
        <li key={song.id}>
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
  );
}

function SetlistList({ setlists, songs }: { setlists: Setlist[]; songs: Song[] }) {
  return (
    <div className="setlists">
      {setlists.map((setlist) => (
        <section key={setlist.id} className="setlist" aria-label={setlist.name}>
          <div className="setlist-head">
            <h2>{setlist.name}</h2>
            <a className="live-launch" href={`#/live/${setlist.id}/0`}>
              Live
            </a>
          </div>
          <ol>
            {setlist.songIds.map((id, index) => {
              const song = songById(songs, id);
              return (
                <li key={`${setlist.id}-${id}-${index}`}>
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
        </section>
      ))}
    </div>
  );
}
