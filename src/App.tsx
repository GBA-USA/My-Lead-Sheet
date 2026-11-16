import { useCallback, useEffect, useMemo, useState } from "react";
import { AccountSheet, googleReturn, useAccount } from "./account";
import { backupOff, backupOn, syncBackup, type BackupResult } from "./backup";
import { BandsSheet, BandsTab } from "./bands";
import { ChatSheet, queueOwner, type ChatTarget } from "./chat";
import { readPayload, type CodeScreen } from "./code-link";
import { clearLanding, landedCode } from "./codes";
import { BackIcon, OverflowMenu, SongControls, TextSizeButtons } from "./controls";
import { LearnedCues } from "./cues";
import { APP_NAME } from "./data-kinds";
import { useAutoScroll, useScrolling, useStored, useWakeLock } from "./hooks";
import { LearnSong } from "./learn-song";
import { SetlistList, SongBody, SongList, Tabs } from "./library-lists";
import { useSendSong } from "./send-song";
import { initialMetronomeBpm } from "./metronome";
import { useMetronome } from "./metronome-view";
import { clampScrollPercent, displayKeyLabel } from "./music";
import type { PersonalDefaults } from "./personal-settings-model";
import { parseHash, settingsHref, type TabName } from "./route";
import { READING_LINE, changeTempo, evenPlan, scrollMotion, startTake, toggleHold, type ScrollVersion, type Take } from "./scroll-timing";
import { ScrollSheet } from "./scroll-sheet";
import { FriendsSheet } from "./friends";
import { MySetlistCodeSheet, SetlistCopySheet } from "./setlist-code";
import { GearIcon, SettingsScreen } from "./settings";
import { LeadSheet } from "./sheet";
import type { Account } from "./sign-in-methods";
import { SongDataEditor } from "./song-data-editor";
import { useSongVersion } from "./song-version";
import {
  TEXT_SCALES,
  loadLibrary,
  loadPersonal,
  loadSongData,
  loadTextScaleIndex,
  localRef,
  savePersonal,
  saveSongData,
  saveTextScaleIndex,
  songByRef,
  withSongData,
} from "./storage";
import { SongLine, TakeBar, taughtPlan, useFollowTempo, type LineMenu } from "./teach";
import type { Library, Setlist, Song, SongData, SongRef } from "./types";

type MenuId = "shell" | LineMenu | null;

type SongDataByRef = Record<SongRef, SongData>;


/** Teach mode: the take while it plays, or Learn this song while it listens. What either taught goes into the song's draft. */
type Teaching = { take: Take } | { learning: true };

const BACKUP_EVERY_MS = 60_000;

const loadAllSongData = (library: Library): SongDataByRef => Object.fromEntries(library.songs.map((song) => [song.ref, loadSongData(song.ref)]));

export function App() {
  const [stored] = useStored<Library>(loadLibrary);
  const [songData, setSongData] = useStored<SongDataByRef>(() => loadAllSongData(stored), stored);
  const library = useMemo<Library>(
    () => ({ ...stored, songs: stored.songs.map((song) => withSongData(song, songData[song.ref] ?? {})) }),
    [stored, songData],
  );
  const [editing, setEditing] = useState(false);
  const [teaching, setTeaching] = useState<Teaching | null>(null);
  const [hash, setHash] = useState(() => window.location.hash);
  const [textIndex, setTextIndex] = useStored(loadTextScaleIndex);
  const [menu, setMenu] = useState<MenuId>(null);
  const [scrollSheet, setScrollSheet] = useState(false);
  const { account, setAccount, checking } = useAccount();
  const owner = account?.userId ?? null;
  const [personal, setPersonal] = useStored(() => loadPersonal(owner), owner);
  const [accountOpen, setAccountOpen] = useState(() => googleReturn() !== null);
  const [friends, setFriends] = useState<{ code?: string } | null>(null);
  const [bands, setBands] = useState<{ code?: string; bandId?: string } | null>(null);
  const [setlistCode, setSetlistCode] = useState<Setlist | null>(null);
  const [setlistCopy, setSetlistCopy] = useState<{ code: string } | null>(null);
  const [chat, setChat] = useState<{ open?: ChatTarget } | null>(null);
  const [landed, setLanded] = useState(landedCode);
  const sendSong = useSendSong(account, stored.songs, { friends: () => setFriends({}), chat: (roomId) => setChat({ open: { roomId } }) });

  useEffect(() => {
    if (landed) clearLanding();
  }, []);
  useEffect(() => queueOwner(account?.userId ?? null), [account?.userId]);

  const landings: Record<CodeScreen, (code: string) => void> = {
    friends: (code) => setFriends({ code }),
    bands: (code) => setBands({ code }),
    gig: (code) => setBands({ code }),
    setlists: (code) => (readPayload(code)?.kind === "my-setlist" ? setSetlistCopy({ code }) : setBands({ code })),
  };

  useEffect(() => {
    if (!landed || checking) return;
    if (!account) return setAccountOpen(true);
    if (accountOpen) return;
    landings[landed.screen](landed.code);
    setLanded(null);
  }, [landed, account, checking, accountOpen]);

  const [backup, setBackup] = useState<BackupResult | null>(null);

  const runBackup = useCallback(async (onlyIfChanged = false) => {
    const result = await syncBackup({ onlyIfChanged });
    if (result.signedOut) setAccount(null);
    setBackup(result);
  }, []);

  useEffect(() => {
    runBackup();
    const timer = setInterval(() => runBackup(true), BACKUP_EVERY_MS);
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
  const showTabs = route.name !== "live" && route.name !== "settings";
  const tab: TabName =
    route.name === "bands" ? "bands" : route.name === "setlists" || (route.name === "song" && route.from === "setlists") ? "setlists" : "songs";

  const liveSetlist = route.name === "live" ? library.setlists.find((set) => set.id === route.setlistId) : undefined;
  const liveIndex =
    route.name === "live" && liveSetlist
      ? Math.min(Math.max(route.index, 0), Math.max(liveSetlist.songRefs.length - 1, 0))
      : 0;
  const liveSong =
    route.name === "live" && liveSetlist ? songByRef(library.songs, liveSetlist.songRefs[liveIndex]) : undefined;
  const activeSong =
    route.name === "song" ? songByRef(library.songs, localRef(route.id)) : route.name === "live" ? liveSong : undefined;

  const performance = useScrolling(activeSong?.ref ?? null);
  const song = useSongVersion(activeSong ?? null, owner, personal);
  const draft = song.draft;
  const shownSong = activeSong && draft?.data ? withSongData(activeSong, draft.data) : activeSong;
  const shownLibrary = shownSong && draft?.data ? { ...library, songs: library.songs.map((each) => (each.ref === shownSong.ref ? shownSong : each)) } : library;
  const [followed, setFollowed] = useState<{ ref: SongRef; bpm: number } | null>(null);
  const metronome = useMetronome(activeSong?.id ?? null, activeSong ? activeSong.tempo : null, {
    bpm: (followed && followed.ref === activeSong?.ref ? followed.bpm : null) ?? draft?.bpm ?? null,
    setBpm: (bpm) => { setFollowed(null); song.set({ bpm }); },
  });
  const take = teaching && "take" in teaching ? teaching.take : null;
  const playing: ScrollVersion | null = draft?.plan ? { name: "", ...draft.plan, ...(draft.learned ? { learned: draft.learned } : {}) } : null;
  const learned = take ? undefined : playing?.learned;
  const even = shownSong ? evenPlan(shownSong) : null;
  // The metronome's speed against the plan's BPM scales the timed scroll, so a tempo change applies at once.
  const motion =
    shownSong && draft
      ? scrollMotion(shownSong, playing, take, metronome.bpm, draft.scrollPercent)
      : ({ kind: "pace", pxPerSec: 0 } as const);
  const clock = useAutoScroll(
    performance.scrolling && activeSong != null,
    motion,
    take ? "take" : playing ? `version ${JSON.stringify(draft?.plan)}` : `even ${shownSong?.officialRuntimeSec} ${shownSong?.tempo}`,
    (reason) => (take ? (reason === "end" ? finishTake(take) : stopTake(take)) : performance.stopScroll()),
  );
  useWakeLock();
  useFollowTempo(performance.scrolling && !take ? playing?.tempo : undefined, clock, (bpm) => activeSong && setFollowed({ ref: activeSong.ref, bpm }));

  useEffect(() => {
    if (!take || metronome.bpm == null) return;
    const next = changeTempo(take, clock.current, metronome.bpm);
    if (next !== take) setTeaching({ take: next });
  }, [metronome.bpm]);

  useEffect(() => {
    document.getElementById("sheet-scroll")?.scrollTo(0, 0);
    setMenu(null);
    setScrollSheet(false);
    setEditing(false);
    setTeaching(null);
  }, [hash]);

  useEffect(() => {
    document.title = activeSong ? `${activeSong.title} — ${APP_NAME}` : APP_NAME;
  }, [activeSong]);

  const closeMenu = () => setMenu(null);
  const toggleMenu = (id: Exclude<MenuId, null>) => setMenu((current) => (current === id ? null : id));

  const openChat = (open: ChatTarget) => {
    setFriends(null);
    setBands(null);
    setSetlistCopy(null);
    setChat({ open });
  };
  const messageUser = (userId: string) => openChat({ userId });

  const changeText = (index: number) => {
    const next = Math.max(0, Math.min(TEXT_SCALES.length - 1, index));
    setTextIndex(next);
    return saveTextScaleIndex(next);
  };

  const changePersonal = (next: PersonalDefaults) => {
    setPersonal(next);
    return savePersonal(owner, next);
  };

  const goBack = () => {
    if (route.name === "song") {
      window.location.hash = route.from === "setlists" ? "#/setlists" : "#/songs";
    } else if (route.name === "live") {
      window.location.hash = "#/setlists";
    } else if (route.name === "settings") {
      window.location.hash = `#/${route.from}`;
    }
  };

  const teach = () => {
    if (!even) return;
    setTeaching({ take: startTake(even, metronome.bpm ?? even.bpm) });
    performance.setScrolling(true);
  };

  const finishTake = (current: Take) => {
    performance.stopScroll();
    setTeaching(null);
    song.set({ plan: taughtPlan(current, clock.current), learned: undefined });
  };

  const discardTake = () => {
    performance.stopScroll();
    setTeaching(null);
  };

  /** A stop mid-take keeps it in the draft, unless nothing was taught yet. */
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
      <header className={activeSong ? "shell-header song-header" : "shell-header"}>
        <button
          type="button"
          className="icon-btn"
          aria-label="Back"
          disabled={route.name !== "song" && route.name !== "live" && route.name !== "settings"}
          onClick={goBack}
        >
          <BackIcon />
        </button>
        {activeSong ? <p className="shell-title">{APP_NAME}</p> : <h1 className="shell-title">{route.name === "settings" ? "Settings" : APP_NAME}</h1>}
        {activeSong ? <TextSizeButtons index={textIndex} count={TEXT_SCALES.length} onChange={changeText} /> : null}
        {activeSong ? (
          <OverflowMenu label="More" size="shell" open={menu === "shell"} onToggle={() => toggleMenu("shell")} onClose={closeMenu} onSongData={() => setEditing(true)}>
            {sendSong.item(activeSong, closeMenu)}
          </OverflowMenu>
        ) : route.name === "settings" ? null : (
          <button type="button" className="icon-btn" aria-label="Settings" onClick={() => (window.location.hash = settingsHref(tab))}>
            <GearIcon />
          </button>
        )}
        {activeSong ? <SongLine key={activeSong.ref} state={song} menu={menu} onToggleMenu={toggleMenu} onCloseMenu={closeMenu} /> : null}
      </header>

      {showTabs ? <Tabs tab={tab} /> : null}

      {activeSong && shownSong && draft ? (
        <SongControls
          keyLabel={displayKeyLabel(shownSong, draft.semitones)}
          onTransposeDown={() => song.set((current) => ({ semitones: current.semitones - 1 }))}
          onTransposeUp={() => song.set((current) => ({ semitones: current.semitones + 1 }))}
          onOriginalKey={() => song.set({ semitones: personal.transpose })}
          notation={draft.notation}
          onNotation={(notation) => song.set({ notation })}
          scrolling={performance.scrolling}
          onToggleScroll={() => (take ? stopTake(take) : performance.setScrolling((on) => !on))}
          onScrollSheet={() => {
            closeMenu();
            setScrollSheet(true);
          }}
          onMetronome={() => document.querySelector(".sheet .metronome")?.scrollIntoView({ block: "nearest" })}
          onSend={route.name === "song" ? sendSong.onSend(activeSong) : undefined}
          take={
            take ? (
              <TakeBar
                holding={take.holding}
                bpm={metronome.bpm}
                onHold={() => setTeaching({ take: toggleHold(take, clock.current) })}
                onBpm={metronome.setBpm}
                onDone={() => finishTake(take)}
                onDiscard={discardTake}
              />
            ) : undefined
          }
        />
      ) : null}

      {activeSong && draft && scrollSheet ? (
        <ScrollSheet
          percent={draft.scrollPercent}
          onPercent={(next) => song.set({ scrollPercent: clampScrollPercent(next) })}
          canTeach={even != null}
          onListen={route.name === "song" ? () => setTeaching({ learning: true }) : undefined}
          onTeach={teach}
          onBpm={metronome.setBpm}
          onClose={() => setScrollSheet(false)}
        />
      ) : null}

      {shownSong && teaching && "learning" in teaching ? (
        <LearnSong
          song={shownSong}
          original={withSongData(songByRef(stored.songs, shownSong.ref)!, {})}
          metronomeBpm={metronome.bpm}
          onSave={({ learned: heard, ...plan }, data) => {
            setTeaching(null);
            const retempo = data?.tempo != null && data.tempo !== shownSong.tempo ? { bpm: initialMetronomeBpm(data.tempo) } : {};
            song.set({ plan, learned: heard, ...(data ? { data } : {}), ...retempo });
          }}
          onClose={() => setTeaching(null)}
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

      {accountOpen ? (
        <AccountSheet
          account={account}
          backup={backup}
          onAccount={onAccount}
          onClose={() => {
            setAccountOpen(false);
            if (!account) setLanded(null);
          }}
        />
      ) : null}

      {friends && account ? (
        <FriendsSheet
          account={account}
          code={friends.code}
          onMessage={messageUser}
          onSignedOut={() => {
            setAccount(null);
            setFriends(null);
          }}
          onClose={() => setFriends(null)}
        />
      ) : null}

      {bands && account ? (
        <BandsSheet
          account={account}
          code={bands.code}
          bandId={bands.bandId}
          onMessage={messageUser}
          onChat={(roomId) => openChat({ roomId })}
          onSetlistCopy={(code) => { setBands(null); setSetlistCopy({ code }); }}
          onSettings={() => { setBands(null); window.location.hash = settingsHref("bands"); }}
          onSignedOut={() => setAccount(null)}
          onClose={() => setBands(null)}
        />
      ) : null}
      {setlistCode && account ? <MySetlistCodeSheet key={account.userId} setlist={setlistCode} onSignedOut={() => setAccount(null)} onClose={() => setSetlistCode(null)} /> : null}
      {setlistCopy && account ? (
        <SetlistCopySheet code={setlistCopy.code} onChat={(roomId) => openChat({ roomId })} onSignedOut={() => setAccount(null)} onClose={() => setSetlistCopy(null)} />
      ) : null}
      {sendSong.sheet}

      {chat && account ? (
        <ChatSheet
          key={account.userId}
          account={account}
          open={chat.open}
          onSignedOut={() => {
            setAccount(null);
            setChat(null);
          }}
          onClose={() => setChat(null)}
        />
      ) : null}

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
        {route.name === "songs" ? <SongList songs={library.songs} userId={account?.userId ?? null} /> : null}
        {route.name === "setlists" ? <SetlistList setlists={library.setlists} songs={library.songs} onShowCode={account ? setSetlistCode : undefined} /> : null}
        {route.name === "settings" ? (
          <SettingsScreen
            account={account}
            backup={backup}
            textIndex={textIndex}
            onTextIndex={changeText}
            personal={personal}
            onPersonal={changePersonal}
            metronome={metronome}
            onAccount={() => setAccountOpen(true)}
            onFriends={() => setFriends({})}
            onMessages={() => setChat({})}
          />
        ) : null}
        {route.name === "bands" ? <BandsTab account={account} onOpen={(bandId) => setBands({ bandId })} onSignIn={() => setAccountOpen(true)} onSignedOut={() => setAccount(null)} /> : null}
        {route.name === "song" ? (
          <SongBody
            library={shownLibrary}
            songRef={localRef(route.id)}
            scale={TEXT_SCALES[textIndex]}
            semitones={draft?.semitones ?? 0}
            notation={draft?.notation ?? "notes"}
            metronome={metronome}
          />
        ) : null}
        {route.name === "live" ? (
          shownSong ? (
            <LeadSheet
              song={shownSong}
              scale={TEXT_SCALES[textIndex]}
              semitones={draft?.semitones ?? 0}
              notation={draft?.notation ?? "notes"}
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
