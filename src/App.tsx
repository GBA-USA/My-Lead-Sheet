import { useCallback, useEffect, useMemo, useState } from "react";
import { AccountSheet, googleReturn, useAccount, usePreviewEntry } from "./account";
import { backupOff, backupOn, syncBackup, type BackupResult } from "./backup";
import { BandPlayMissing, useBandPlay } from "./band-setlist-view";
import { BandPage, BandsSheet, BandsTab, PlanGigScreen, type BandLanding } from "./bands";
import { goneWords, openDm, queueOwner, useInbox } from "./chat";
import { readPayload, type CodeScreen } from "./code-link";
import { BackIcon, OverflowMenu, SongControls, TextSizeButtons } from "./controls";
import { LearnedCues } from "./cues";
import { APP_NAME } from "./data-kinds";
import { useGigPosition } from "./gig-position";
import { GigSongMissing, GigViewScreen, useGigPack } from "./gig-view";
import { useAutoScroll, useScrolling, useStored, useWakeLock } from "./hooks";
import { LearnSong } from "./learn-song";
import { SetlistList, SongBody, SongList, Tabs } from "./library-lists";
import { useSendSong } from "./send-song";
import { initialMetronomeBpm } from "./metronome";
import { MessagesScreen } from "./messages";
import { useInvite } from "./pending-invite";
import { useMetronome } from "./metronome-view";
import { clampScrollPercent, displayKeyLabel } from "./music";
import type { PersonalDefaults } from "./personal-settings-model";
import { backHref, bandHref, messagesHref, parseHash, roomHref, settingsHref, type Route, type TabName } from "./route";
import { Room } from "./room";
import { READING_LINE, changeTempo, evenPlan, scrollMotion, startTake, toggleHold, type ScrollVersion, type Take } from "./scroll-timing";
import { ScrollSheet } from "./scroll-sheet";
import { FriendsSheet } from "./friends";
import { MySetlistCodeSheet, SetlistCopySheet } from "./setlist-code";
import { GearIcon, SettingsScreen } from "./settings";
import { LeadSheet } from "./sheet";
import type { Account } from "./sign-in-methods";
import { FOLDS, SongChromeRoom, SongChromeSlot, useSongChrome } from "./song-chrome";
import { SongEditors, type SongEdit } from "./song-editor";
import { BandSongNotes } from "./song-notes";
import { useSongVersion } from "./song-version";
import { StageBar, stageSetOf } from "./stage-bar";
import {
  TEXT_SCALES,
  loadLibrary,
  loadPersonal,
  loadSongData,
  loadTextScaleIndex,
  localRef,
  madeHere,
  savePersonal,
  saveSongData,
  saveTextScaleIndex,
  songByRef,
  tempoText,
  withSongData,
} from "./storage";
import { SongLine, TakeBar, taughtPlan, useFollowTempo, type LineMenu } from "./teach";
import type { Library, Setlist, Song, SongData, SongRef } from "./types";

type MenuId = "shell" | LineMenu | null;

type SongDataByRef = Record<SongRef, SongData>;

/** Teach mode: the take while it plays, or Learn this song while it listens. What either taught goes into the song's draft. */
type Teaching = { take: Take } | { learning: true };

const BACKUP_EVERY_MS = 60_000;

const SCREEN_TITLES: Partial<Record<Route["name"], string>> = { settings: "Settings", messages: "Messages", room: "Messages" };

const loadAllSongData = (library: Library): SongDataByRef => Object.fromEntries(library.songs.map((song) => [song.ref, loadSongData(song.ref)]));

export function App() {
  const [stored] = useStored<Library>(loadLibrary);
  const [songData, setSongData] = useStored<SongDataByRef>(() => loadAllSongData(stored), stored);
  const library = useMemo<Library>(
    () => ({ ...stored, songs: stored.songs.map((song) => withSongData(song, songData[song.ref] ?? {})) }),
    [stored, songData],
  );
  const [editing, setEditing] = useState<SongEdit | null>(null);
  const [teaching, setTeaching] = useState<Teaching | null>(null);
  const [hash, setHash] = useState(() => window.location.hash);
  const [textIndex, setTextIndex] = useStored(loadTextScaleIndex);
  const [menu, setMenu] = useState<MenuId>(null);
  const [scrollSheet, setScrollSheet] = useState(false);
  const { account, setAccount, checking, owner } = useAccount();
  const [personal, setPersonal] = useStored(() => loadPersonal(owner ?? null), owner);
  const [accountOpen, setAccountOpen] = useState(() => googleReturn() !== null);
  const [friends, setFriends] = useState<{ code?: string } | null>(null);
  const [bands, setBands] = useState<{ code?: string } | null>(null);
  const [landing, setLanding] = useState<BandLanding | null>(null);
  const [notice, setNotice] = useState("");
  const [setlistCode, setSetlistCode] = useState<Setlist | null>(null);
  const [setlistCopy, setSetlistCopy] = useState<{ code: string } | null>(null);
  const { invite, dropInvite } = useInvite();

  useEffect(() => queueOwner(account?.userId ?? null), [account?.userId]);

  const landings: Record<CodeScreen, (code: string) => void> = {
    friends: (code) => setFriends({ code }),
    bands: (code) => setBands({ code }),
    gig: (code) => setBands({ code }),
    setlists: (code) => (readPayload(code)?.kind === "my-setlist" ? setSetlistCopy({ code }) : setBands({ code })),
  };

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
  const inbox = useInbox(owner ?? null, route.name, () => setAccount(null));
  const bandRoute = route.name === "band-song" || route.name === "band-live";
  const gigRoute = route.name === "gig" ? route : null;
  const onStage = gigRoute !== null;
  const liveRoute = route.name === "live" || route.name === "band-live";
  const showTabs = !["live", "band-live", "gig", "settings", "messages", "room"].includes(route.name);
  const tab: TabName =
    route.name === "bands" || route.name === "band" || route.name === "band-song" || route.name === "band-plan" || route.name === "gig" ? "bands" : route.name === "setlists" || (route.name === "song" && route.from === "setlists") ? "setlists" : "songs";
  const entering = usePreviewEntry(tab === "bands" || invite !== null, owner, checking, onAccount);
  const holding = entering && tab === "bands";

  useEffect(() => {
    if (!invite || checking || entering) return;
    if (!account) return setAccountOpen(true);
    if (accountOpen) return;
    dropInvite();
    landings[invite.screen](invite.code);
  }, [invite, account, checking, entering, accountOpen]);

  const back = backHref(route);
  const play = useBandPlay(route, owner ?? null);
  const pack = useGigPack(owner ?? null, gigRoute?.gigId ?? "");
  const position = useGigPosition(pack?.gig, owner ?? null, pack?.songs.length ?? 0, gigRoute?.index ?? null);
  const stage = onStage || liveRoute ? stageSetOf(route, library, play, pack, position) : null;
  const stageCanMove = !gigRoute || position.canMove;
  const activeSong = route.name === "song" ? songByRef(library.songs, localRef(route.id)) : route.name === "band-song" ? play.song : stage?.song;

  const performance = useScrolling(activeSong?.ref ?? null);
  const songVersion = useSongVersion(activeSong ?? null, owner, personal);
  const draft = songVersion.draft;
  const shownSong = activeSong && draft?.data ? withSongData(activeSong, draft.data) : activeSong;
  const shownLibrary = shownSong && draft?.data ? { ...library, songs: library.songs.map((each) => (each.ref === shownSong.ref ? shownSong : each)) } : library;
  const [followed, setFollowed] = useState<number | null>(null);
  const metronome = useMetronome(activeSong?.id ?? null, activeSong ? activeSong.tempo : null, {
    bpm: followed ?? draft?.bpm ?? null,
    setBpm: (bpm) => { setFollowed(null); songVersion.set({ bpm }); },
  });
  const take = teaching && "take" in teaching ? teaching.take : null;
  const fold = FOLDS[route.name] ?? (activeSong ? "song" : undefined);
  const chrome = useSongChrome(fold === "song" ? (activeSong?.ref ?? null) : fold ? hash : null, performance.scrolling, take != null, () => setMenu(null));
  const bandTiming = gigRoute && pack?.scrollWithLeader ? (pack.songs[position.index]?.bandTiming ?? null) : null;
  const playing: ScrollVersion | null = bandTiming ?? (draft?.plan ? { name: "", ...draft.plan, ...(draft.learned ? { learned: draft.learned } : {}) } : null);
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
    take ? "take" : playing ? `version ${JSON.stringify(bandTiming ?? draft?.plan)}` : `even ${shownSong?.officialRuntimeSec} ${shownSong?.tempo}`,
    (reason) => (take ? (reason === "end" ? finishTake(take) : stopTake(take)) : performance.stopScroll()),
  );
  useWakeLock();
  useFollowTempo(performance.scrolling && !take ? playing?.tempo : undefined, clock, setFollowed);

  useEffect(() => {
    if (!take || metronome.bpm == null) return;
    const next = changeTempo(take, clock.current, metronome.bpm);
    if (next !== take) setTeaching({ take: next });
  }, [metronome.bpm]);

  useEffect(() => {
    document.getElementById("sheet-scroll")?.scrollTo(0, 0);
    setMenu(null);
    setScrollSheet(false);
    setEditing(null);
    setTeaching(null);
    const now = parseHash(window.location.hash).name;
    if (now !== "bands" && now !== "messages") setNotice("");
    if (now !== "band") setLanding(null);
  }, [hash]);

  useEffect(() => {
    document.title = activeSong ? `${activeSong.title} — ${APP_NAME}` : APP_NAME;
  }, [activeSong]);

  const closeMenu = () => setMenu(null);
  const toggleMenu = (id: Exclude<MenuId, null>) => setMenu((current) => (current === id ? null : id));

  const openRoom = (roomId: string) => {
    setFriends(null);
    setBands(null);
    setSetlistCopy(null);
    window.location.hash = roomHref(roomId);
  };
  const messageUser = (userId: string) => openDm(userId).then(openRoom);
  const sendSong = useSendSong(account, stored.songs, { friends: () => setFriends({}), chat: openRoom });
  const openBand = (next: BandLanding, replace = false) => {
    setBands(null);
    setLanding(next);
    window.location[replace ? "replace" : "assign"](bandHref(next.bandId, next.section));
  };
  const gone = (to: string, words: string) => {
    setNotice(words);
    window.location.replace(to);
  };

  const changeText = (index: number) => {
    const next = Math.max(0, Math.min(TEXT_SCALES.length - 1, index));
    setTextIndex(next);
    return saveTextScaleIndex(next);
  };

  const changePersonal = (next: PersonalDefaults) => {
    setPersonal(next);
    return savePersonal(owner ?? null, next);
  };

  const teach = () => {
    if (!even) return;
    setTeaching({ take: startTake(even, metronome.bpm ?? even.bpm) });
    performance.setScrolling(true);
  };

  const finishTake = (current: Take) => {
    performance.stopScroll();
    setTeaching(null);
    songVersion.set({ plan: taughtPlan(current, clock.current), learned: undefined });
  };

  const discardTake = () => {
    performance.stopScroll();
    setTeaching(null);
  };

  /** A stop mid-take keeps it in the draft, unless nothing was taught yet. */
  const stopTake = (current: Take) => (current.marks.length > 1 ? finishTake(current) : discardTake());

  /** A held draft keeps its metronome bpm, so a sheet that changes the song's tempo starts the metronome at the new one. */
  const retempo = (song: Song, tempo: number | null) => {
    if (tempo !== song.tempo) metronome.setBpm(initialMetronomeBpm(tempo));
  };

  const saveData = (song: Song, data: SongData) => {
    saveSongData(song.ref, data);
    setSongData((current) => ({ ...current, [song.ref]: data }));
    retempo(song, data.tempo ?? songByRef(stored.songs, song.ref)?.tempo ?? null);
    setEditing(null);
  };

  return (
    <div className={onStage ? "app gig-stage" : "app"}>
      <SongChromeSlot chrome={chrome} list={fold === "list"}>
        <header className={activeSong ? "shell-header song-header" : "shell-header"}>
          <button
            type="button"
            className="icon-btn"
            aria-label="Back"
            disabled={back === null}
            onClick={() => back && (window.location.hash = back)}
          >
            <BackIcon />
          </button>
          {activeSong ? (
            <p className="shell-title">{gigRoute && stage && shownSong && draft ? `${stage.index + 1} of ${stage.count} · ${displayKeyLabel(shownSong, draft.semitones)} · ${tempoText(shownSong.tempo)}` : APP_NAME}</p>
          ) : (
            <h1 className="shell-title">{SCREEN_TITLES[route.name] ?? APP_NAME}</h1>
          )}
          {activeSong ? <TextSizeButtons index={textIndex} count={TEXT_SCALES.length} onChange={changeText} /> : null}
          {activeSong ? (
            <OverflowMenu label="More" size="shell" open={menu === "shell"} onToggle={() => toggleMenu("shell")} onClose={closeMenu} onSongData={bandRoute || gigRoute ? undefined : () => setEditing("timing")} {...(route.name === "song" && madeHere(activeSong) ? { onEdit: () => setEditing("chart"), onDelete: () => setEditing("delete") } : {})}>
              {bandRoute || gigRoute ? null : sendSong.item(activeSong, closeMenu)}
            </OverflowMenu>
          ) : route.name === "settings" ? null : (
            <button type="button" className="icon-btn gear-btn" aria-label="Settings" onClick={() => (window.location.hash = settingsHref(tab))}>
              <GearIcon />
              {inbox.unread > 0 ? <span className="chat-badge">{inbox.unread}</span> : null}
            </button>
          )}
          {activeSong && !onStage ? <SongLine key={activeSong.ref} state={songVersion} menu={menu} onToggleMenu={toggleMenu} onCloseMenu={closeMenu} /> : null}
        </header>

        {showTabs ? <Tabs tab={tab} /> : null}

        {activeSong && shownSong && draft && !onStage ? (
          <SongControls
            keyLabel={displayKeyLabel(shownSong, draft.semitones)}
            onTransposeDown={() => songVersion.set((current) => ({ semitones: current.semitones - 1 }))}
            onTransposeUp={() => songVersion.set((current) => ({ semitones: current.semitones + 1 }))}
            onOriginalKey={() => songVersion.set({ semitones: personal.transpose })}
            notation={draft.notation}
            onNotation={(notation) => songVersion.set({ notation })}
            scrolling={performance.scrolling}
            onToggleScroll={() => (take ? stopTake(take) : performance.setScrolling((on) => !on))}
            onScrollSheet={() => { closeMenu(); setScrollSheet(true); }}
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
      </SongChromeSlot>

      {activeSong && draft && scrollSheet ? (
        <ScrollSheet
          percent={draft.scrollPercent}
          onPercent={(next) => songVersion.set({ scrollPercent: clampScrollPercent(next) })}
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
            songVersion.set({ plan, learned: heard, ...(data ? { data } : {}), ...retempo });
          }}
          onClose={() => setTeaching(null)}
        />
      ) : null}

      <SongEditors editing={editing} song={activeSong} songs={stored.songs} onSongData={saveData} onTempo={retempo} onClose={() => setEditing(null)} />

      {accountOpen ? (
        <AccountSheet
          account={account}
          backup={backup}
          invite={invite?.line}
          onAccount={onAccount}
          onClose={() => {
            setAccountOpen(false);
            if (!account) dropInvite();
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

      {bands && owner ? (
        <BandsSheet code={bands.code} onBand={openBand} onSetlistCopy={(code) => { setBands(null); setSetlistCopy({ code }); }} onSignedOut={() => setAccount(null)} onClose={() => setBands(null)} />
      ) : null}
      {setlistCode && account ? <MySetlistCodeSheet key={account.userId} setlist={setlistCode} onSignedOut={() => setAccount(null)} onClose={() => setSetlistCode(null)} /> : null}
      {setlistCopy && account ? (
        <SetlistCopySheet code={setlistCopy.code} onChat={openRoom} onSignedOut={() => setAccount(null)} onClose={() => setSetlistCopy(null)} />
      ) : null}
      {sendSong.sheet}

      <div
        className="scroll"
        id="sheet-scroll"
        role={showTabs ? "tabpanel" : undefined}
        aria-labelledby={showTabs ? `tab-${tab}` : undefined}
        style={chrome.sheetStyle}
      >
        <SongChromeRoom chrome={chrome} />
        {performance.scrolling && learned && motion.kind === "learned" ? (
          <LearnedCues learned={learned} clock={clock} rate={motion.rate} metronomeOn={metronome.playing} />
        ) : null}
        {route.name === "songs" ? <SongList songs={library.songs} userId={account?.userId ?? null} onAdd={account ? () => setEditing("new") : undefined} /> : null}
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
            onMessages={() => (window.location.hash = messagesHref)}
          />
        ) : null}
        {holding ? <div className="bands-tab"><p className="bands-tab-note">Checking…</p></div> : null}
        {route.name === "bands" && !holding ? <BandsTab me={owner ?? null} notice={notice} onNew={() => setBands({})} onSignIn={() => setAccountOpen(true)} onSignedOut={() => setAccount(null)} /> : null}
        {route.name === "band" && !holding ? (
          <BandPage key={`${owner}/${route.bandId}`} me={owner ?? null} bandId={route.bandId} section={route.section} landing={landing?.bandId === route.bandId ? landing : undefined}
            inbox={inbox} onMessage={messageUser} onSignIn={() => setAccountOpen(true)} onSignedOut={() => setAccount(null)} onGone={(words) => gone("#/bands", words)} />
        ) : null}
        {route.name === "band-plan" && !holding ? <PlanGigScreen key={`${owner}/${route.bandId}/${route.gigId}`} me={owner ?? null} bandId={route.bandId} gigId={route.gigId} setlistId={route.setlistId} onSignIn={() => setAccountOpen(true)} onSignedOut={() => setAccount(null)} onDone={(next) => openBand(next, true)} /> : null}
        {route.name === "messages" || (route.name === "room" && !owner) ? <MessagesScreen me={owner ?? null} inbox={inbox} notice={notice} onSignIn={() => setAccountOpen(true)} /> : null}
        {route.name === "room" && owner ? (
          <Room key={`${owner}/${route.roomId}`} me={owner} roomId={route.roomId} entry={inbox.chats?.find((c) => c.roomId === route.roomId)} onEntry={inbox.change} onGone={(error) => gone(messagesHref, goneWords(route.roomId, error))} onSignedOut={() => setAccount(null)} />
        ) : null}
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
        {gigRoute && gigRoute.index === null && !holding ? (
          <GigViewScreen key={`${owner}/${gigRoute.gigId}`} me={owner ?? null} bandId={gigRoute.bandId} gigId={gigRoute.gigId} pack={pack} position={position} onSignIn={() => setAccountOpen(true)} onSignedOut={() => setAccount(null)} />
        ) : null}
        {holding ? null : <BandSongNotes route={route} me={owner ?? null} pack={pack} />}
        {!holding && (route.name === "live" || bandRoute || (gigRoute && gigRoute.index !== null)) ? (
          shownSong ? (
            <LeadSheet
              song={shownSong}
              scale={TEXT_SCALES[textIndex]}
              semitones={draft?.semitones ?? 0}
              notation={draft?.notation ?? "notes"}
              metronome={metronome}
            />
          ) : gigRoute ? (
            <GigSongMissing bandId={gigRoute.bandId} gigId={gigRoute.gigId} pack={pack} />
          ) : bandRoute ? (
            <BandPlayMissing play={play} back={back ?? "#/bands"} />
          ) : (
            <div className="missing">
              <p>{stage?.count === 0 ? "This setlist is empty." : "That setlist isn't in this library."}</p>
              <a href="#/setlists">Back to Setlists</a>
            </div>
          )
        ) : null}
        {/* Room below the sheet, so a learned version can bring the chart's end up to the reading line. */}
        {learned ? <div style={{ height: `calc(100% - ${READING_LINE}px)` }} /> : null}
      </div>

      {stage && stage.count > 0 && (activeSong || stageCanMove) ? (
        <StageBar set={stage} canMove={stageCanMove} scroll={activeSong ? { on: performance.scrolling, toggle: () => (take ? stopTake(take) : performance.setScrolling((on) => !on)) } : undefined} />
      ) : null}
    </div>
  );
}
