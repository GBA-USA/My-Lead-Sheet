import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { AccountSheet } from "./account";
import { backupOff, backupOn, syncBackup, type BackupResult } from "./backup";
import { BackIcon, DotsIcon, Menu, OverflowMenu, ScreenToggle, SongControls } from "./controls";
import { LearnedCues } from "./cues";
import { useAutoScroll, usePerformance, useWakeLock } from "./hooks";
import { LearnSong } from "./learn-song";
import { initialMetronomeBpm } from "./metronome";
import { useMetronome } from "./metronome-view";
import { displayKeyLabel } from "./music";
import { READING_LINE, changeTempo, evenPlan, nextVersionName, scrollMotion, startTake, toggleHold, type ScrollVersion, type Take } from "./scroll-timing";
import { LeadSheet } from "./sheet";
import { PRIVACY_HREF } from "./data-kinds";
import type { Account } from "./sign-in-methods";
import { SongDataEditor } from "./song-data-editor";
import {
  TEXT_SCALES,
  loadAwake,
  loadLibrary,
  loadSongData,
  loadTextScaleIndex,
  localRef,
  saveAwake,
  saveSongData,
  saveTextScaleIndex,
  songByRef,
  tempoText,
  withSongData,
} from "./storage";
import { SaveTake, TeachBar, taughtPlan, useFollowTempo, useScrollVersions, type BarMenu } from "./teach";
import type { Library, Setlist, Song, SongData, SongRef } from "./types";
import { SearchBox } from "./search-box";
import { matchingSetlists, matchingSongs } from "./search";

type TabName = "songs" | "setlists";

type Route =
  | { name: "songs" }
  | { name: "setlists" }
  | { name: "song"; id: number; from: TabName }
  | { name: "live"; setlistId: number; index: number };

type MenuId = "shell" | "song" | BarMenu | null;

type SongDataByRef = Record<SongRef, SongData>;

/** Teach mode: the take while it plays or Learn this song while it listens, then what either taught, until Save or Discard. */
type Teaching = { take: Take } | { learning: true } | { taught: Omit<ScrollVersion, "name">; data?: SongData | null };

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

const BACKUP_EVERY_MS = 60_000;

const loadAllSongData = (library: Library): SongDataByRef => Object.fromEntries(library.songs.map((song) => [song.ref, loadSongData(song.ref)]));

export function App() {
  const [stored, setStored] = useState<Library>(() => loadLibrary());
  const [songData, setSongData] = useState<SongDataByRef>(() => loadAllSongData(stored));
  const library = useMemo<Library>(
    () => ({ ...stored, songs: stored.songs.map((song) => withSongData(song, songData[song.ref] ?? {})) }),
    [stored, songData],
  );
  const [editing, setEditing] = useState(false);
  const [teaching, setTeaching] = useState<Teaching | null>(null);
  const [hash, setHash] = useState(() => window.location.hash);
  const [textIndex, setTextIndex] = useState(() => loadTextScaleIndex());
  const [awake, setAwake] = useState(() => loadAwake());
  const [menu, setMenu] = useState<MenuId>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [backup, setBackup] = useState<BackupResult | null>(null);

  const runBackup = useCallback(async () => {
    const result = await syncBackup();
    if (result.signedOut) setAccount(null);
    if (result.changed.length > 0) {
      const next = loadLibrary();
      setStored(next);
      setSongData(loadAllSongData(next));
      setTextIndex(loadTextScaleIndex());
      setAwake(loadAwake());
    }
    setBackup(result);
  }, []);

  useEffect(() => {
    runBackup();
    const timer = setInterval(runBackup, BACKUP_EVERY_MS);
    const onShow = () => document.visibilityState === "visible" && runBackup();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [runBackup]);

  const onAccount = useCallback(
    (next: Account | null) => {
      setAccount(next);
      if (next) {
        backupOn(next.userId);
        runBackup();
      } else {
        backupOff();
        setBackup(null);
      }
    },
    [runBackup],
  );

  useEffect(() => {
    if (!window.location.hash) {
      history.replaceState(null, "", "#/songs");
    }
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const route = parseHash(hash);
  const showTabs = route.name !== "live";
  const tab: TabName =
    route.name === "setlists" || (route.name === "song" && route.from === "setlists")
      ? "setlists"
      : "songs";

  const liveSetlist = route.name === "live" ? library.setlists.find((set) => set.id === route.setlistId) : undefined;
  const liveIndex =
    route.name === "live" && liveSetlist
      ? Math.min(Math.max(route.index, 0), Math.max(liveSetlist.songRefs.length - 1, 0))
      : 0;
  const liveSong =
    route.name === "live" && liveSetlist ? songByRef(library.songs, liveSetlist.songRefs[liveIndex]) : undefined;
  const activeSong =
    route.name === "song" ? songByRef(library.songs, localRef(route.id)) : route.name === "live" ? liveSong : undefined;

  const performance = usePerformance(activeSong?.ref ?? null);
  const metronome = useMetronome(activeSong?.id ?? null, activeSong ? activeSong.tempo : null);
  const versions = useScrollVersions(activeSong?.ref ?? null);
  const take = teaching && "take" in teaching ? teaching.take : null;
  const version = versions.selected == null ? null : versions.versions[versions.selected];
  const learned = take ? undefined : version?.learned;
  const even = activeSong ? evenPlan(activeSong) : null;
  // The metronome's speed against the plan's BPM scales the timed scroll, so a tempo change applies at once.
  const motion = activeSong
    ? scrollMotion(activeSong, version, take, metronome.bpm, performance.percent)
    : ({ kind: "pace", pxPerSec: 0 } as const);
  const clock = useAutoScroll(
    performance.scrolling && activeSong != null,
    motion,
    take ? "take" : version ? `version ${versions.selected}` : `even ${activeSong?.officialRuntimeSec} ${activeSong?.tempo}`,
    (reason) => (take ? (reason === "end" ? finishTake(take) : stopTake(take)) : performance.stopScroll()),
  );
  useWakeLock(awake);
  useFollowTempo(performance.scrolling && !take ? version?.tempo : undefined, clock, metronome.setBpm);

  useEffect(() => {
    if (!take || metronome.bpm == null) return;
    const next = changeTempo(take, clock.current, metronome.bpm);
    if (next !== take) setTeaching({ take: next });
  }, [metronome.bpm]);

  useEffect(() => {
    document.getElementById("sheet-scroll")?.scrollTo(0, 0);
    setMenu(null);
    setEditing(false);
    setTeaching(null);
  }, [hash]);

  useEffect(() => {
    document.title = activeSong ? `${activeSong.title} — Lead Sheets` : "Lead Sheets";
  }, [activeSong]);

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
    const next: TabName = tab === "songs" ? "setlists" : "songs";
    document.getElementById(`tab-${next}`)?.focus();
    window.location.hash = `#/${next}`;
  };

  const goBack = () => {
    if (route.name === "song") {
      window.location.hash = route.from === "setlists" ? "#/setlists" : "#/songs";
    } else if (route.name === "live") {
      window.location.hash = "#/setlists";
    }
  };

  const teach = () => {
    if (!even) return;
    setTeaching({ take: startTake(even, metronome.bpm ?? even.bpm) });
    performance.setScrolling(true);
  };

  const finishTake = (current: Take) => {
    performance.stopScroll();
    setTeaching({ taught: taughtPlan(current, clock.current) });
  };

  const discardTake = () => {
    performance.stopScroll();
    setTeaching(null);
  };

  /** A stop mid-take offers to save it, unless nothing was taught yet. */
  const stopTake = (current: Take) => (current.marks.length > 1 ? finishTake(current) : discardTake());

  const saveData = (song: Song, data: SongData) => {
    saveSongData(song.ref, data);
    setSongData((current) => ({ ...current, [song.ref]: data }));
    const tempo = data.tempo ?? songByRef(stored.songs, song.ref)?.tempo ?? null;
    if (tempo !== song.tempo) metronome.setBpm(initialMetronomeBpm(tempo));
    setEditing(false);
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
        {activeSong ? <p className="shell-title">Lead Sheets</p> : <h1 className="shell-title">Lead Sheets</h1>}
        {activeSong ? (
          <OverflowMenu
            label="More"
            size="shell"
            open={menu === "shell"}
            onToggle={() => toggleMenu("shell")}
            onClose={closeMenu}
          />
        ) : (
          <Menu button={<DotsIcon />} label="More" className="icon-btn" open={menu === "shell"} onToggle={() => toggleMenu("shell")} onClose={closeMenu}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu();
                setAccountOpen(true);
              }}
            >
              {account ? "Account" : "Sign in"}
            </button>
          </Menu>
        )}
      </header>

      {showTabs ? (
        <div className="tabs" role="tablist" aria-label="Library" onKeyDown={onTabKey}>
          <Tab name="songs" selected={tab === "songs"}>
            My Songs
          </Tab>
          <Tab name="setlists" selected={tab === "setlists"}>
            Setlists
          </Tab>
        </div>
      ) : null}

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
          onSongData={() => setEditing(true)}
          notation={performance.notation}
          onNotation={performance.changeNotation}
          scrolling={performance.scrolling}
          onToggleScroll={() => (take ? stopTake(take) : performance.setScrolling((on) => !on))}
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

      {activeSong && (even || versions.versions.length > 0 || route.name === "song") ? (
        <TeachBar
          key={activeSong.ref}
          versions={versions.versions}
          selected={versions.selected}
          canTeach={even != null}
          teaching={take != null}
          holding={take?.holding ?? false}
          bpm={metronome.bpm}
          menu={menu}
          onToggleMenu={toggleMenu}
          onCloseMenu={closeMenu}
          onSelect={versions.select}
          onRename={versions.rename}
          onRetime={versions.retime}
          onDelete={versions.remove}
          onTeach={teach}
          onListen={route.name === "song" ? () => setTeaching({ learning: true }) : undefined}
          onHold={() => take && setTeaching({ take: toggleHold(take, clock.current) })}
          onBpm={metronome.setBpm}
          onDone={() => take && finishTake(take)}
          onDiscard={discardTake}
        />
      ) : null}

      {activeSong && teaching && "learning" in teaching ? (
        <LearnSong
          song={activeSong}
          original={withSongData(songByRef(stored.songs, activeSong.ref)!, {})}
          metronomeBpm={metronome.bpm}
          onSave={(taught, data) => setTeaching({ taught, data })}
          onClose={() => setTeaching(null)}
        />
      ) : null}

      {activeSong && teaching && "taught" in teaching ? (
        <SaveTake
          name={nextVersionName(versions.versions)}
          onSave={(name) => {
            versions.add(teaching.taught, name);
            if (teaching.data) saveData(activeSong, teaching.data);
            setTeaching(null);
          }}
          onDiscard={() => setTeaching(null)}
        />
      ) : null}

      {activeSong && editing ? (
        <SongDataEditor
          song={activeSong}
          original={withSongData(songByRef(stored.songs, activeSong.ref)!, {})}
          onSave={(data) => saveData(activeSong, data)}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {accountOpen ? <AccountSheet account={account} backup={backup} onAccount={onAccount} onClose={() => setAccountOpen(false)} /> : null}

      {liveSetlist && liveSetlist.songRefs.length > 0 ? (
        <div className="live-nav">
          <button type="button" aria-label="Previous song" disabled={liveIndex <= 0} onClick={() => goLive(liveIndex - 1)}>
            Prev
          </button>
          <span className="live-count">
            {liveSetlist.name} · {liveIndex + 1}/{liveSetlist.songRefs.length}
          </span>
          <button
            type="button"
            aria-label="Next song"
            disabled={liveIndex >= liveSetlist.songRefs.length - 1}
            onClick={() => goLive(liveIndex + 1)}
          >
            Next
          </button>
        </div>
      ) : null}

      <div
        className="scroll"
        id="sheet-scroll"
        role={showTabs ? "tabpanel" : undefined}
        aria-labelledby={showTabs ? `tab-${tab}` : undefined}
      >
        {performance.scrolling && learned && motion.kind === "learned" ? (
          <LearnedCues learned={learned} clock={clock} rate={motion.rate} metronomeOn={metronome.playing} />
        ) : null}
        {route.name === "songs" ? <SongList songs={library.songs} /> : null}
        {route.name === "setlists" ? <SetlistList setlists={library.setlists} songs={library.songs} /> : null}
        {route.name === "song" ? (
          <SongBody
            library={library}
            songRef={localRef(route.id)}
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
              <p>{liveSetlist?.songRefs.length === 0 ? "This setlist is empty." : "That setlist isn't in this library."}</p>
              <a href="#/setlists">Back to Setlists</a>
            </div>
          )
        ) : null}
        {/* Room below the sheet, so a learned version can bring the chart's end up to the reading line. */}
        {learned ? <div style={{ height: `calc(100% - ${READING_LINE}px)` }} /> : null}
      </div>
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

function SongBody({
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

function SongList({ songs }: { songs: Song[] }) {
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

function SetlistList({ setlists, songs }: { setlists: Setlist[]; songs: Song[] }) {
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
