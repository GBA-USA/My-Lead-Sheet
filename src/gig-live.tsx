/**
 * The live gig on screen: the strip, Join gig and the click question, and the hooks App runs for the gig sheet. Its
 * model is gig-live.ts, the file of the same name, so this file imports it as "./gig-live.js" and App imports this one
 * as "./gig-live.tsx": esbuild maps both ".js" and ".jsx" to gig-live.ts first, so only ".tsx" reaches this file.
 */
import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import type { LocalMs } from "./band-time";
import type { BandView } from "./bands-model";
import type { ChatEntry } from "./chat-model";
import { downloadPack, type GigPack } from "./gig-pack";
import type { GigPlan } from "./gig-plan-model";
import { useGigPosition, type GigPosition } from "./gig-position";
import { position as positionAt } from "./gig-state";
import { useGigPack } from "./gig-view";
import {
  CLICK_ANSWERS,
  CLICK_QUESTION,
  answerClick,
  asksClick,
  holdScreen,
  liveGig,
  scrollsWithLeader,
  stripOf,
  unreadOnStage,
  type ClickAnswer,
  type LiveGig,
  type OpBody,
  type Strip,
  type StripPhase,
} from "./gig-live.js";
import { roomLine, type RoomLine } from "./links/server-link";
import type { MetronomePrefs } from "./metronome";
import { followBand, stopMetronome } from "./metronome-audio";
import type { MetronomeState } from "./metronome-view";
import type { PersonalDefaults } from "./personal-settings-model";
import { getFromPhone, heldFor } from "./phone-db";
import { gigHref, type Route } from "./route";
import { api } from "./sign-in-methods";
import { savePersonal } from "./storage";
import { FREE_STUN } from "./sync-history";
import type { Song } from "./types";

/** How often a signed-in phone asks whether one of its gigs is live. */
const LIVE_POLL_MS = 30_000;
/** A change that moves the band needs a half-second hold (PLAN.md 8.3 rule 1). */
const HOLD_MS = 500;
const PACK_FAILED = "Can't get the setlist now · try again on Wi-Fi";
const SCREEN_MAY_SLEEP = "Your screen may sleep";

/** What the live gig reaches outside this phone. Each has the app's own by default; a check swaps in stand-ins. */
export type LiveDeps = {
  gigs(): Promise<GigPlan[]>;
  pack(me: string, gig: GigPlan): Promise<GigPack>;
  room(bandId: string): RoomLine;
  names(bandId: string): Promise<Record<string, string>>;
  admins(bandId: string): Promise<string[]>;
  screenOn(): Promise<(() => void) | null>;
};

const roomUrl = (bandId: string) => `${location.origin.replace(/^http/, "ws")}/api/rooms/${bandId}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const bandOf = (bandId: string) => api<BandView>("/api/bands/open", { bandId });

const APP_DEPS: LiveDeps = {
  gigs: () => api<{ gigs: GigPlan[] }>("/api/bands/gig/live", {}).then((reply) => reply.gigs),
  async pack(me, gig) {
    const held = heldFor(me) ? await getFromPhone("gigPacks", gig.gigId).catch(() => undefined) : undefined;
    return held ?? downloadPack(me, gig.bandId, gig.gigId);
  },
  room: (bandId) => roomLine(roomUrl(bandId)),
  names: (bandId) => bandOf(bandId).then((band) => Object.fromEntries(band.members.map((member) => [member.userId, firstName(member.name)]))),
  admins: (bandId) => bandOf(bandId).then((band) => band.members.filter((member) => member.role === "admin").map((member) => member.userId)),
  screenOn: holdScreen,
};

type Joining = { gig: GigPlan; step: "getting" | "asking" | "failed"; pack: GigPack | null; starting: boolean };
type Joined = { gig: GigPlan; pack: GigPack; room: RoomLine; session: LiveGig; starting: boolean };

export type Live = {
  /** The gig the strip is about: the one this phone follows, or one it may join or start. */
  gig: GigPlan | null;
  strip: Strip | null;
  sleepy: boolean;
  error: string | null;
  asking: boolean;
  /** The gig this phone follows or leads, with its pack and its live session. */
  joined: { gig: GigPlan; pack: GigPack; session: LiveGig } | null;
  names: Record<string, string>;
  join(): void;
  start(): void;
  answer(choice: ClickAnswer): void;
  dismiss(): void;
  tap(body: OpBody): void;
  askToLead(): void;
};

type Args = {
  me: string | null;
  /** The planned gig on screen with this phone's pack, so its leader can start it. */
  stage?: { gig: GigPlan; pack: GigPack } | null;
  metronome: { setPrefs(patch: Partial<MetronomePrefs>): void };
  personal: PersonalDefaults;
  onPersonal(next: PersonalDefaults): void;
  /** Opens the gig's sheet once this phone has joined. */
  onOpen?(gig: GigPlan): void;
  deps?: Partial<LiveDeps>;
};

/**
 * The live gig for this phone (PLAN.md 8.2): which of its gigs is live, Join gig, the click question once per account,
 * and the session that follows the leader. Screen on is held while joined. App reads the session for the sheet, the
 * click and the scroll; the strip reads it every frame for its words and its hand-off flash.
 */
export function useLiveGig({ me, stage = null, metronome, personal, onPersonal, onOpen, deps }: Args): Live {
  const use = useMemo(() => ({ ...APP_DEPS, ...deps }), [deps]);
  const [gigs, setGigs] = useState<GigPlan[]>([]);
  const [joining, setJoining] = useState<Joining | null>(null);
  const [joined, setJoined] = useState<Joined | null>(null);
  const [ended, setEnded] = useState<GigPlan | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [sleepy, setSleepy] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [, changed] = useReducer((n: number) => n + 1, 0);
  const [, setFrame] = useState("");
  const release = useRef<(() => void) | null>(null);

  useEffect(() => {
    setGigs([]);
    if (!me) return;
    let live = true;
    const load = () => void use.gigs().then((list) => live && setGigs(list), () => {});
    load();
    const timer = setInterval(load, LIVE_POLL_MS);
    const onShow = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [me, use]);

  // A session belongs to the account that joined it: signing out or switching accounts leaves the gig.
  useEffect(() => () => leave(), [me]);

  useEffect(() => {
    if (!joined) return;
    let live = true;
    const acquire = () =>
      void use.screenOn().then((done) => {
        if (!live) return done?.();
        release.current?.();
        release.current = done;
        setSleepy(done === null);
      });
    acquire();
    const onShow = () => document.visibilityState === "visible" && acquire();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onShow);
      release.current?.();
      release.current = null;
      setSleepy(false);
    };
  }, [joined, use]);

  const session = joined?.session ?? null;
  const state = session?.view().state ?? null;
  const listed = joined ? gigs.find((gig) => gig.gigId === joined.gig.gigId) : undefined;
  const over = !!joined && (state?.status === "ended" || listed?.status === "ended");

  useEffect(() => {
    if (!over || !joined) return;
    setEnded(joined.gig);
    leave();
  }, [over]);

  // The planned leader starts the gig once the room has named this phone the leader.
  useEffect(() => {
    if (!joined?.starting || !session) return;
    const view = session.view();
    if (!view.leading || view.state) return;
    joined.starting = false;
    use.admins(joined.gig.bandId).then(
      (admins) =>
        session.start({
          order: joined.pack.songs.map((song) => song.songId),
          admin: admins.includes(joined.gig.leader) ? joined.gig.leader : (admins[0] ?? joined.gig.leader),
          backup: joined.gig.backup,
          lineup: joined.gig.lineup,
          route: joined.gig.route,
          scrollAlong: joined.pack.scrollWithLeader,
        }),
      () => (joined.starting = true),
    );
  });

  function leave() {
    setJoined((current) => {
      current?.session.close();
      current?.room.close();
      return null;
    });
    setJoining(null);
  }

  function follow(gig: GigPlan, pack: GigPack, starting: boolean) {
    if (!me) return;
    const room = use.room(gig.bandId);
    const session = liveGig({ me, gigId: gig.gigId, room, stun: FREE_STUN, onChange: changed });
    setJoining(null);
    setEnded(null);
    setJoined({ gig, pack, room, session, starting });
    use.names(gig.bandId).then(setNames, () => {});
    onOpen?.(gig);
  }

  async function begin(gig: GigPlan, held: GigPack | null, starting: boolean) {
    if (!me) return;
    setJoining({ gig, step: "getting", pack: null, starting });
    try {
      const pack = held ?? (await use.pack(me, gig));
      if (asksClick(personal)) setJoining({ gig, step: "asking", pack, starting });
      else follow(gig, pack, starting);
    } catch {
      setJoining({ gig, step: "failed", pack: null, starting });
    }
  }

  const liveGigNow = gigs.find((gig) => gig.status === "live" && !dismissed.includes(gig.gigId));
  const startable = stage && stage.gig.status === "planned" && stage.gig.leader === me && !gigs.some((gig) => gig.gigId === stage.gig.gigId && gig.status === "live") ? stage : null;
  const gig = joined?.gig ?? joining?.gig ?? (ended && !dismissed.includes(ended.gigId) ? ended : null) ?? liveGigNow ?? startable?.gig ?? null;
  const phase: StripPhase | null = joined
    ? "joined"
    : joining
      ? joining.step === "getting"
        ? "getting"
        : joining.starting
          ? "planned"
          : "invited"
      : gig && gig === ended
        ? "ended"
        : gig && gig === startable?.gig
          ? "planned"
          : gig
            ? "invited"
            : null;

  const strip =
    gig && phase && me
      ? stripOf({ me, gigName: gig.name, plannedLeader: gig.leader, names, phase, view: session?.view() ?? null, bandNow: session?.bandNow() ?? null })
      : null;
  const shown = strip && joining?.step === "asking" ? { ...strip, join: false, start: false } : strip;

  // Every frame while joined: redraw when the strip's words or flash, or the band's song or section, change.
  useEffect(() => {
    if (!session || !me || !joined) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const t = session.bandNow();
      const view = session.view();
      const now = stripOf({ me, gigName: joined.gig.name, plannedLeader: joined.gig.leader, names, phase: "joined", view, bandNow: t });
      const where = view.state && t !== null ? positionAt(view.state, t) : null;
      const next = `${now.key}|${now.words}|${now.flash}|${now.takeOver}|${where?.song.key}|${where?.section}|${where?.scroll ? 1 : 0}|${view.asks.length}`;
      setFrame((last) => (last === next ? last : next));
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [session, me, names]);

  return {
    gig,
    strip: shown,
    sleepy: !!joined && sleepy,
    error: joining?.step === "failed" ? PACK_FAILED : null,
    asking: joining?.step === "asking",
    joined: joined && { gig: joined.gig, pack: joined.pack, session: joined.session },
    names,
    join: () => gig && begin(gig, null, false),
    start: () => startable && begin(startable.gig, startable.pack, true),
    answer(choice) {
      if (!joining?.pack) return;
      const { personal: next, prefs } = answerClick(personal, choice);
      metronome.setPrefs(prefs);
      onPersonal(next);
      follow(joining.gig, joining.pack, joining.starting);
    },
    dismiss() {
      if (gig) setDismissed((list) => [...list, gig.gigId]);
      if (joined) leave();
      setEnded(null);
    },
    tap: (body) => void session?.tap(body),
    askToLead: () => session?.askToLead(),
  };
}

type GigRoute = Extract<Route, { name: "gig" }>;
type Following = { pack: GigPack; session: LiveGig };
type PrefsSink = { current: (patch: Partial<MetronomePrefs>) => void };

/** Where the band is in the set: the song `position` gives at this frame's band time, never a stored index. Only the leader moves it. */
function livePosition({ pack, session }: Following): GigPosition {
  const view = session.view();
  const t = session.bandNow();
  const key = view.state && t !== null ? positionAt(view.state, t).song.key : null;
  return {
    index: Math.max(0, pack.songs.findIndex((song) => song.songId === key)),
    canMove: view.leading && view.state !== null,
    goTo: (next) => pack.songs[next] && session.tap({ kind: "goTo", key: pack.songs[next].songId }),
  };
}

/**
 * App's gig for this render: the live gig, and on a gig screen its pack and the band's place in the set, from the live
 * session while this phone follows that gig and from the phone's own index otherwise. The metronome comes later in
 * App's render, so the click question reaches it through `sink`, which `useBandFollow` fills.
 */
export function useGigStage({ me, route, personal, setPersonal, deps }: { me: string | null; route: GigRoute | null; personal: PersonalDefaults; setPersonal(next: PersonalDefaults): void; deps?: Partial<LiveDeps> }) {
  const heldPack = useGigPack(me, route?.gigId ?? "");
  const sink = useRef<PrefsSink["current"]>(() => {});
  const live = useLiveGig({
    me,
    deps,
    stage: route && heldPack ? { gig: heldPack.gig, pack: heldPack } : null,
    metronome: { setPrefs: (patch) => sink.current(patch) },
    personal,
    onPersonal: (next) => {
      setPersonal(next);
      savePersonal(me, next);
    },
    onOpen: (gig) => (window.location.hash = gigHref(gig.bandId, gig.gigId, 0)),
  });
  const following = live.joined && route?.gigId === live.joined.gig.gigId ? live.joined : null;
  const pack = following?.pack ?? heldPack;
  const own = useGigPosition(pack?.gig, me, pack?.songs.length ?? 0, route?.index ?? null);
  const unread = (chats: readonly ChatEntry[] | null | undefined, offStage: number) => (live.joined ? unreadOnStage(chats ?? [], Date.now(), live.joined.gig.bandId) : offStage);
  return { live, pack, position: following ? livePosition(following) : own, following, sink, unread };
}

/**
 * While this phone follows the gig on screen, the metronome clicks the band's grid on this phone's speaker delay, and
 * with Scroll with the leader on, the chart scrolls while the leader's song runs. On the leader's phone its own metronome
 * counts the band in and stops it. Call it after App's metronome, so a song change that stops the metronome hands the
 * click back to the band. Returns the band clock for the scroll, or undefined outside a gig.
 */
export function useBandFollow(following: Following | null, sink: PrefsSink, metronome: MetronomeState, song: Song | null, scroll: { setScrolling(on: boolean): void }) {
  sink.current = metronome.setPrefs;
  const session = following?.session ?? null;
  const view = session?.view();
  const state = view?.state ?? null;
  const t = session?.bandNow() ?? null;
  const where = state && t !== null ? positionAt(state, t) : null;
  const click = session?.click() ?? null;
  const clickKey = click && JSON.stringify(click);
  useEffect(() => {
    if (!session || !click) return;
    followBand(click, (perfMs) => session.bandAt((window.performance.timeOrigin + perfMs) as LocalMs) ?? Number.NaN, metronome.prefs.speakerDelayMs, () => {});
    return () => stopMetronome();
  }, [session, clickKey, song?.id, metronome.playing, metronome.prefs.speakerDelayMs]);

  const leading = !!view?.leading && state !== null;
  const counting = state !== null && state.click[state.click.length - 1].value !== null;
  useEffect(() => {
    if (!session || !leading) return;
    if (metronome.playing && !counting && metronome.bpm) session.tap({ kind: "countIn", bpm: metronome.bpm, beatsPerBar: parseInt(song?.timeSignature ?? "", 10) || 4, bars: 1, version: null, rate: 1 });
    if (!metronome.playing && counting) session.tap({ kind: "stop" });
  }, [session, leading, metronome.playing]);

  const bandScrolls = state !== null && scrollsWithLeader(state) && where?.scroll != null;
  useEffect(() => {
    if (state && scrollsWithLeader(state)) scroll.setScrolling(bandScrolls);
  }, [session, bandScrolls, song?.ref]);
  return useMemo(() => (session ? () => session.bandNow() ?? 0 : undefined), [session]);
}

const TONE_STYLE: Record<Strip["tone"], CSSProperties> = {
  gold: { background: "var(--gold, #e1a01e)", color: "#13120d" },
  blue: { background: "#2f6fd6", color: "#fff" },
  amber: { background: "#c77700", color: "#13120d" },
  grey: { background: "#3a3a36", color: "#f2efe6" },
};
const STRIP_STYLE: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 10px", padding: "8px 12px", fontWeight: 600 };
const FLASH_STYLE: CSSProperties = { filter: "brightness(1.6)" };
const BUTTON_STYLE: CSSProperties = { minHeight: 44, padding: "0 14px", borderRadius: 8, border: "2px solid currentColor", background: "transparent", color: "inherit", font: "inherit" };

/** A button that acts only after a half-second hold, as every change that moves the band does. */
function HoldButton({ label, onHeld }: { label: string; onHeld?: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holding, setHolding] = useState(false);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  useEffect(() => stop, []);
  return (
    <button
      type="button"
      style={{ ...BUTTON_STYLE, ...(holding ? { background: "rgba(0,0,0,0.2)" } : {}) }}
      onPointerDown={() => {
        stop();
        setHolding(true);
        timer.current = setTimeout(() => {
          stop();
          onHeld?.();
        }, HOLD_MS);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
    >
      {label}
    </button>
  );
}

export type StripActions = { join?: () => void; start?: () => void; takeOver?: () => void; accept?: () => void; askToLead?: () => void; close?: () => void };

/** The strip at the top of every screen: who leads, the route and the sync bars, and the one button this phone may need. */
export function GigStrip({ strip, sleepy, error = null, on }: { strip: Strip; sleepy: boolean; error?: string | null; on: StripActions }) {
  return (
    <div className={`gig-strip is-${strip.tone}`} role="status" data-strip={strip.key} data-flash={strip.flash ? "on" : "off"} style={{ ...STRIP_STYLE, ...TONE_STYLE[strip.tone], ...(strip.flash ? FLASH_STYLE : {}) }}>
      <span className="gig-strip-words">{strip.words}</span>
      {strip.bars !== null ? (
        <span className="gig-strip-bars" aria-label={`Sync: ${strip.bars} of 4 bars`}>
          {"▮".repeat(strip.bars)}
          {"▯".repeat(4 - strip.bars)}
        </span>
      ) : null}
      {strip.join ? (
        <button type="button" style={BUTTON_STYLE} onClick={on.join}>
          Join gig
        </button>
      ) : null}
      {strip.start ? <HoldButton label="Hold to start the gig" onHeld={on.start} /> : null}
      {strip.accept ? (
        <button type="button" style={BUTTON_STYLE} onClick={on.accept}>
          Take it
        </button>
      ) : null}
      {strip.takeOver ? <HoldButton label="Hold to take the lead" onHeld={on.takeOver} /> : null}
      {strip.askToLead ? (
        <button type="button" style={BUTTON_STYLE} onClick={on.askToLead}>
          Ask to lead
        </button>
      ) : null}
      {strip.waiting ? <span className="gig-strip-note">{strip.waiting}</span> : null}
      {sleepy ? <span className="gig-strip-note">{SCREEN_MAY_SLEEP}</span> : null}
      {error ? (
        <span className="gig-strip-note" role="alert">
          {error}
        </span>
      ) : null}
      {on.close ? (
        <button type="button" style={{ ...BUTTON_STYLE, marginLeft: "auto" }} aria-label="Close" onClick={on.close}>
          ✕
        </button>
      ) : null}
    </div>
  );
}

/** The strip as App mounts it, with the click question under it the first time and the leader's hand-off for anyone who asked. */
export function LiveGigStrip({ live }: { live: Live }) {
  const { strip, joined } = live;
  if (!strip) return null;
  const view = joined?.session.view();
  const state = view?.state;
  const asker = view?.leading && state ? view.asks.find((id) => id !== state.handoff?.to) : undefined;
  const closable = strip.key === "ended" || strip.key === "off-lineup" || strip.join;
  return (
    <>
      <GigStrip
        strip={strip}
        sleepy={live.sleepy}
        error={live.error}
        on={{
          join: live.join,
          start: live.start,
          takeOver: () => live.tap({ kind: "takeOver" }),
          accept: () => live.tap({ kind: "accept" }),
          askToLead: live.askToLead,
          close: closable ? live.dismiss : undefined,
        }}
      />
      {live.asking ? (
        <div className="gig-question" role="group" aria-label={CLICK_QUESTION} style={{ ...STRIP_STYLE, ...TONE_STYLE.grey }}>
          <span>{CLICK_QUESTION}</span>
          <button type="button" style={BUTTON_STYLE} onClick={() => live.answer("loud")}>
            {CLICK_ANSWERS.loud.label}
          </button>
          <button type="button" style={BUTTON_STYLE} onClick={() => live.answer("dot")}>
            {CLICK_ANSWERS.dot.label}
          </button>
        </div>
      ) : null}
      {asker ? (
        <div className="gig-ask-lead" style={{ ...STRIP_STYLE, ...TONE_STYLE.grey }}>
          <span>{live.names[asker] ?? "A bandmate"} asks to lead</span>
          <HoldButton label="Hold to hand off" onHeld={() => live.tap({ kind: "handOff", to: asker })} />
        </div>
      ) : null}
    </>
  );
}
