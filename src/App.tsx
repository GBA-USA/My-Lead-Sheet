import { useEffect, useState, type KeyboardEvent } from "react";
import { BackIcon, DotsIcon, OverflowMenu, ScreenToggle, SongControls } from "./controls";
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
  | { name: "song"; id: number; from: TabName };

type MenuId = "shell" | "song" | null;

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const path = (raw.split("?")[0] || "/songs").replace(/\/$/, "") || "/songs";
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
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

  useEffect(() => {
    document.getElementById("sheet-scroll")?.scrollTo(0, 0);
    setMenu(null);
    const current = parseHash(hash);
    if (current.name === "song") {
      const song = songById(library.songs, current.id);
      document.title = song ? `${song.title} — Lead Sheets` : "Lead Sheets";
    } else {
      document.title = "Lead Sheets";
    }
  }, [hash, library.songs]);

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

  return (
    <div className="app">
      <header className="shell-header">
        <button
          type="button"
          className="icon-btn"
          aria-label="Back"
          disabled={route.name !== "song"}
          onClick={() => {
            if (route.name === "song") {
              window.location.hash = route.from === "setlists" ? "#/setlists" : "#/songs";
            }
          }}
        >
          <BackIcon />
        </button>
        <h1 className="shell-title">Lead Sheets</h1>
        {route.name === "song" ? (
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

      {route.name === "song" ? (
        <SongHeader
          library={library}
          route={route}
          textIndex={textIndex}
          awake={awake}
          menuOpen={menu === "song"}
          onTextIndex={changeText}
          onAwake={toggleAwake}
          onMenuToggle={() => toggleMenu("song")}
          onMenuClose={closeMenu}
        />
      ) : (
        <div className="list-tools">
          <ScreenToggle on={awake} onToggle={toggleAwake} />
        </div>
      )}

      <div className="scroll" id="sheet-scroll">
        {route.name === "songs" ? <SongList songs={library.songs} /> : null}
        {route.name === "setlists" ? <SetlistList setlists={library.setlists} songs={library.songs} /> : null}
        {route.name === "song" ? (
          <SongBody library={library} id={route.id} scale={TEXT_SCALES[textIndex]} />
        ) : null}
      </div>
    </div>
  );
}

function SongHeader({
  library,
  route,
  textIndex,
  awake,
  menuOpen,
  onTextIndex,
  onAwake,
  onMenuToggle,
  onMenuClose,
}: {
  library: LibraryFile;
  route: Extract<Route, { name: "song" }>;
  textIndex: number;
  awake: boolean;
  menuOpen: boolean;
  onTextIndex: (index: number) => void;
  onAwake: () => void;
  onMenuToggle: () => void;
  onMenuClose: () => void;
}) {
  const song = songById(library.songs, route.id);
  if (!song) return null;
  return (
    <SongControls
      song={song}
      textIndex={textIndex}
      textCount={TEXT_SCALES.length}
      onTextIndex={onTextIndex}
      awake={awake}
      onAwake={onAwake}
      menuOpen={menuOpen}
      onMenuToggle={onMenuToggle}
      onMenuClose={onMenuClose}
      onEdit={onMenuClose}
      onDelete={onMenuClose}
    />
  );
}

function SongBody({ library, id, scale }: { library: LibraryFile; id: number; scale: number }) {
  const song = songById(library.songs, id);
  if (!song) {
    return (
      <div className="missing">
        <p>That song isn&apos;t in this library.</p>
        <a href="#/songs">Back to My Songs</a>
      </div>
    );
  }
  return <LeadSheet song={song} scale={scale} />;
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
          <h2>{setlist.name}</h2>
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
