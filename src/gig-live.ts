import { adoptLead, bandAt as onLine, bandNow as estimate, beatTime, confidence, leadMs, snap, type BandMs, type Confidence, type Grid, type Line, type LinkRoute, type LocalMs } from "./band-time";
import { isMuted, unread, type ChatEntry } from "./chat-model";
import { startGig, type GigState, type Op, type Outcome, type RouteChoice, type SongKey, type Timeline, type UserId } from "./gig-state";
import { KEEPING_THE_BEAT, gigSync } from "./leader-fanout";
import { LOST_AFTER_MS, linkToLeader, type GigLinks } from "./links/attempt";
import { NOT_ON_LINEUP_CLOSE, type Link } from "./links/link";
import { WAITING_FOR_LEADER, type RoomLine } from "./links/server-link";
import { localNow } from "./links/wire";
import { BEAT_FLASH_SECONDS, type ClickPrefs } from "./metronome";
import type { PersonalDefaults } from "./personal-settings-model";
import { ROUTE_WORDS } from "./routes";

/** No answer from the leader on any route for this long: "isn't answering" (PLAN.md 7.13). */
export const LEADER_QUIET_MS = LOST_AFTER_MS;
/** And for this long: "dropped", and the backup may take the lead. */
export const LEADER_DROPPED_MS = 30_000;

export type LeaderHeard = "answering" | "quiet" | "dropped";
export const leaderHeard = (sinceMs: number): LeaderHeard => (sinceMs >= LEADER_DROPPED_MS ? "dropped" : sinceMs >= LEADER_QUIET_MS ? "quiet" : "answering");

/** Only the admin, any time, and the backup, once the leader has dropped, may take the lead (PLAN.md 6, 7.13). */
export function mayTakeOver(state: GigState, me: UserId, heard: LeaderHeard): boolean {
  if (me === state.leader || !state.lineup.includes(me)) return false;
  return me === state.admin || (me === state.backup && heard === "dropped");
}

export const scrollsWithLeader = (state: GigState) => state.scrollAlong;

/** Unread messages for the gear badge. While a gig is live every band thread is quiet on stage, and DMs still count (PLAN.md 8.3). */
export function unreadOnStage(chats: readonly ChatEntry[], now: number, liveGigBand: string | null): number {
  return chats.reduce((total, chat) => total + (isMuted(chat, now, liveGigBand !== null) ? 0 : unread(chat)), 0);
}

// ---------------------------------------------------------------- the click question

export const CLICK_QUESTION = "Click out loud on this phone, or dot only?";
export type ClickAnswer = "loud" | "dot";
/** The answer is the metronome's own Sound and Dot, the two the beat pill cycles, so there is one place it lives. */
export const CLICK_ANSWERS: Record<ClickAnswer, { label: string; prefs: Partial<ClickPrefs> }> = {
  loud: { label: "Click out loud", prefs: { sound: true } },
  dot: { label: "Dot only", prefs: { sound: false, indicator: true } },
};
/** Asked once per account: a second account on a shared phone answers for itself. */
export const asksClick = (personal: PersonalDefaults) => !personal.clickAsked;
export const answerClick = (personal: PersonalDefaults, answer: ClickAnswer) => ({ personal: { ...personal, clickAsked: true }, prefs: CLICK_ANSWERS[answer].prefs });

/** Screen on for the gig: a wake lock, or null when the phone has none or refused it. Releasing it hands the screen back to the player's own choice. */
export async function holdScreen(): Promise<(() => void) | null> {
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return null;
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    return () => void sentinel.release().catch(() => {});
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the strip

export type StripFacts = { gig: string; leader: string; route: string; backup: string | null; songNumber: number };

/** What the strip can say: the gig's own states, and while following, the clock's `Confidence` and what is heard from the leader (PLAN.md 7.12). */
export type StripKey =
  | "join"
  | "getting"
  | "start"
  | "leading"
  | "offered"
  | "waiting"
  | Confidence
  | "quiet"
  | "dropped"
  | "no-signal"
  | "stepped-down"
  | "ended"
  | "off-lineup";

export const STRIP_WORDS: Record<StripKey, (facts: StripFacts) => string> = {
  join: (f) => `${f.gig} is live · Join gig`,
  getting: () => "Getting the setlist…",
  start: (f) => `${f.gig} · You're leading tonight`,
  leading: () => "You're leading",
  offered: (f) => `${f.leader} wants you to lead the gig`,
  waiting: () => WAITING_FOR_LEADER,
  syncing: () => "Syncing",
  synced: (f) => `● ${f.leader} is leading${f.route ? ` · ${f.route}` : ""}`,
  "out-of-sync": () => "Out of sync · fixing",
  quiet: (f) => `${f.leader}'s phone isn't answering`,
  dropped: (f) => `${f.leader}'s phone dropped · still on ${f.songNumber}`,
  "no-signal": () => KEEPING_THE_BEAT,
  "stepped-down": (f) => `${f.leader} is leading`,
  ended: () => "That's the gig. Nice playing.",
  "off-lineup": () => "This gig is for tonight's lineup",
};

/** Gold while the planned leader leads, blue once someone else has taken over; these keys have their own color. */
const TONES: Partial<Record<StripKey, Tone>> = {
  waiting: "grey",
  syncing: "grey",
  "no-signal": "grey",
  "off-lineup": "grey",
  "out-of-sync": "amber",
  quiet: "amber",
  dropped: "amber",
};

export type Tone = "gold" | "blue" | "amber" | "grey";

/** Where this phone is with the gig: told it is live, downloading, its leader's planned gig, following, over, or not on the lineup. */
export type StripPhase = "invited" | "getting" | "planned" | "joined" | "ended" | "off-lineup";

export type StripInput = {
  me: UserId;
  gigName: string;
  plannedLeader: UserId;
  names: Record<UserId, string>;
  phase: StripPhase;
  view: LiveView | null;
  bandNow: BandMs | null;
};

export type Strip = {
  key: StripKey;
  words: string;
  tone: Tone;
  /** On for a moment on each beat of the 2 bars after a hand-off. */
  flash: boolean;
  /** Sync bars out of 4, while synced. */
  bars: number | null;
  /** This phone keeps its click and dot quiet rather than be wrong. */
  quiet: boolean;
  takeOver: boolean;
  askToLead: boolean;
  accept: boolean;
  waiting: string | null;
  join: boolean;
  start: boolean;
};

const barsOf = (spread: number) => (spread <= 2 ? 4 : spread <= 5 ? 3 : spread <= 8 ? 2 : 1);

function gridAt(click: Timeline<Grid | null>, t: number): Grid | null {
  let grid: Grid | null = null;
  for (const step of click) if (step.at <= t) grid = step.value;
  return grid;
}

function keyOf({ me, phase, view }: StripInput): StripKey {
  const state = view?.state ?? null;
  if (phase === "invited") return "join";
  if (phase === "getting") return "getting";
  if (phase === "planned") return "start";
  if (phase === "ended" || state?.status === "ended") return "ended";
  if (phase === "off-lineup" || view?.offLineup) return "off-lineup";
  if (!view) return "syncing";
  if (state?.leader === me || (!state && view.leading)) return "leading";
  if (state?.handoff?.to === me) return "offered";
  if (!state) return view.confidence === "synced" ? "waiting" : "syncing";
  if (!view.signal) return "no-signal";
  if (view.heard !== "answering") return view.heard;
  if (view.steppedDown) return "stepped-down";
  return view.confidence;
}

const FLASH_MS = BEAT_FLASH_SECONDS * 1000;
/** Two bars of flash for a hand-off. */
export const FLASH_BARS = 2;
/** Between songs there is no band beat, so the flash keeps a 120 bpm 4/4 from the hand-off itself. */
const FLASH_BEAT = { bpm: 120, beatsPerBar: 4, firstBar: 0 };

/** Whether the strip is lit at `t`: on each beat of the band's grid from the first beat at or after the hand-off, for 2 bars. */
export function handoffFlash(from: BandMs, grid: Grid | null, t: BandMs): boolean {
  const beats = grid ?? { ...FLASH_BEAT, startAt: from };
  const beatMs = 60_000 / beats.bpm;
  const first = Math.max(0, Math.ceil((from - beats.startAt) / beatMs - 1e-9));
  const n = Math.floor((t - beats.startAt) / beatMs + 1e-9);
  if (n < first || n >= first + FLASH_BARS * beats.beatsPerBar) return false;
  return t - beatTime(beats, n) < FLASH_MS;
}

export function stripOf(input: StripInput): Strip {
  const { me, view } = input;
  const state = view?.state ?? null;
  const name = (id: UserId) => input.names[id] ?? "The leader";
  const leadsNow = state?.leader ?? input.plannedLeader;
  const current = state ? state.current[state.current.length - 1].value : null;
  const facts: StripFacts = {
    gig: input.gigName,
    leader: name(leadsNow),
    route: view?.route ? ROUTE_WORDS[view.route] : "",
    backup: state?.backup ? name(state.backup) : null,
    songNumber: state && current !== null ? state.order[state.order.length - 1].value.indexOf(current) + 1 : 1,
  };
  const key = keyOf(input);
  const tone = TONES[key] ?? (leadsNow === input.plannedLeader ? "gold" : "blue");
  const t = input.bandNow;
  const flash = tone === "blue" && state !== null && view?.handoffAt != null && t !== null && handoffFlash(view.handoffAt, gridAt(state.click, view.handoffAt), t);
  const takeOver = !!state && !!view && key !== "ended" && key !== "off-lineup" && mayTakeOver(state, me, view.heard);
  return {
    key,
    words: STRIP_WORDS[key](facts),
    tone,
    flash,
    bars: key === "synced" && view ? barsOf(view.spread) : null,
    quiet: !!state && state.leader !== me && view?.confidence !== "synced",
    takeOver,
    askToLead: key === "stepped-down",
    accept: state?.handoff?.to === me && state.leader !== me,
    waiting: key === "dropped" && !takeOver ? (facts.backup ? `Waiting for ${facts.backup} (backup) or the admin` : "Waiting for the admin") : null,
    join: key === "join",
    start: key === "start",
  };
}

/** The click from `from` on: silent before it, so a phone that just synced comes in on the bar line it picked. */
export function clickFrom(click: Timeline<Grid | null>, from: BandMs): Timeline<Grid | null> {
  if (click[0].at >= from) return click;
  return [{ at: click[0].at, value: null }, { at: from, value: gridAt(click, from) }, ...click.filter((step) => step.at > from)];
}

// ---------------------------------------------------------------- one phone in the live gig

export type OpBody = Op extends infer O ? (O extends Op ? Omit<O, "opId" | "epoch"> : never) : never;

export type LiveView = {
  state: GigState | null;
  leading: boolean;
  confidence: Confidence;
  spread: number;
  route: LinkRoute | null;
  heard: LeaderHeard;
  /** When the leader last answered a ping, on this phone's clock. */
  heardAt: LocalMs | null;
  signal: boolean;
  offLineup: boolean;
  /** This phone led, and someone else leads now. */
  steppedDown: boolean;
  /** The room's last refusal of this phone's send. */
  refused: string | null;
  /** Band time of the latest change of leader this phone saw happen. */
  handoffAt: BandMs | null;
  /** Players who asked this leader for the lead. */
  asks: UserId[];
};

export interface LiveGigOptions {
  me: UserId;
  gigId: string;
  room: RoomLine;
  stun?: readonly string[];
  rows?: readonly LinkRoute[];
  /** The band clock while this phone is the planned leader: its own clock by default. */
  clock?: () => number;
  onChange?: () => void;
}

export type StartPlan = { order: SongKey[]; admin: UserId; backup: UserId | null; lineup: UserId[]; route: RouteChoice; scrollAlong: boolean };

export interface LiveGig {
  view(): LiveView;
  /** Band time for this frame. It never goes back, so a re-measured clock behind the screen holds the screen still. */
  bandNow(): BandMs | null;
  /** Band time at an instant on this phone's clock, for the metronome and the scroll. */
  bandAt(local: LocalMs): BandMs | null;
  /** The click the metronome follows, or null while this phone keeps quiet. */
  click(): Timeline<Grid | null> | null;
  start(plan: StartPlan): void;
  tap(body: OpBody): Outcome;
  askToLead(): void;
  /** The page is back after a lock or a freeze: measure the leader's clock again before clicking. */
  wake(): void;
  close(): void;
}

const ASK_TO_LEAD = "ask-to-lead";
/** A page hidden this long comes back through Syncing. */
const WAKE_AFTER_MS = 2_000;

/**
 * One phone's live gig (PLAN.md 7.9-7.13): its link to the leader and the gig state it follows or leads. It holds no
 * timer of its own; the links keep theirs. A phone that takes the lead keeps the band time it was following, so the
 * beat carries on with no step.
 */
export function liveGig(options: LiveGigOptions): LiveGig {
  const { me, gigId, room } = options;
  const own = options.clock ?? (() => localNow() as number);
  let closed = false;
  let adopted: Line | null = null;
  let heardAt = localNow();
  let lastPoint: number | null = null;
  let shown = -Infinity;
  let joinFrom: BandMs | null = null;
  let hiddenAt: LocalMs | null = null;
  let led = false;
  let seenEpoch: number | null = null;
  let handoffAt: BandMs | null = null;
  let lastRefusal: unknown = null;
  let refused: string | null = null;
  let offLineup = false;
  let ops = 0;
  const asks = new Set<UserId>();
  const hearing = new Map<Link, () => void>();

  const isLeader = () => {
    const state = sync?.state();
    return state ? state.leader === me : !!links?.leading();
  };

  function bandAt(local: LocalMs): BandMs | null {
    if (isLeader()) return (adopted ? onLine(adopted, local) : own() - localNow() + local) as BandMs;
    return estimate(links.clock(), local);
  }

  function bandNow(): BandMs | null {
    const t = bandAt(localNow());
    if (t !== null && t > shown) shown = t;
    return shown === -Infinity ? null : (shown as BandMs);
  }

  const confidenceNow = (): Confidence => (isLeader() ? "synced" : confidence(links.clock(), localNow()));

  const makeLinks = () =>
    linkToLeader({ room, gigId, stun: options.stun ?? [], rows: options.rows, bandNow: () => bandAt(localNow()) ?? (own() as BandMs), onChange: onLinks });

  const myLinks = (): readonly Link[] => {
    if (!links) return [];
    if (links.leading()) return links.followers();
    const chosen = links.attempt().chosen;
    return chosen ? [chosen] : [];
  };

  function hearAsks() {
    const now = new Set(links.followers());
    for (const [link, stop] of hearing) if (!now.has(link) || link.state === "closed") (stop(), hearing.delete(link));
    for (const link of now) {
      if (hearing.has(link) || link.state === "closed") continue;
      hearing.set(
        link,
        link.onMessage((value) => {
          const { kind, from } = (value ?? {}) as { kind?: unknown; from?: unknown };
          if (kind !== ASK_TO_LEAD || typeof from !== "string") return;
          asks.add(from);
          refresh();
        }),
      );
    }
  }

  function onLinks() {
    if (!links || !sync || closed) return;
    sync.relink();
    hearAsks();
    refresh();
  }

  /** Reads what changed on the links or the state. The 10 s and 30 s marks need no timer: `view` reads them off the clock, and the strip reads `view` every frame. */
  function refresh() {
    if (!links || !sync || closed) return;
    const state = sync.state();
    const points = links.clock().points;
    const last = points.length ? points[points.length - 1].at : null;
    if (last !== null && last !== lastPoint) {
      lastPoint = last;
      heardAt = localNow();
    }
    if (state) {
      if (state.leader === me) led = true;
      if (seenEpoch !== null && state.epoch > seenEpoch) handoffAt = state.changedAt;
      seenEpoch = state.epoch;
      for (const id of asks) if (id === state.leader || id === state.handoff?.to) asks.delete(id);
    }
    const refusals = sync.refused();
    const latest = refusals[refusals.length - 1];
    if (latest && latest !== lastRefusal) {
      lastRefusal = latest;
      refused = latest.refused;
      if (refused === "stale-epoch" || refused === "not-allowed") room.send({ kind: "gig-state", gigId });
    }
    if (confidenceNow() !== "synced") joinFrom = null;
    else if (joinFrom === null && state) {
      const t = bandNow();
      const grid = t === null ? null : gridAt(state.click, t);
      if (t !== null) joinFrom = grid ? snap("song", t, grid) : t;
    }
    options.onChange?.();
  }

  /** A new introduction through the room: after a take-over the room names this phone the leader, and after a lock the clock is measured afresh. */
  function relink() {
    const old = links;
    links = makeLinks();
    old.close();
    for (const stop of hearing.values()) stop();
    hearing.clear();
    onLinks();
  }

  let links: GigLinks = undefined as unknown as GigLinks;
  let sync: ReturnType<typeof gigSync> = undefined as unknown as ReturnType<typeof gigSync>;
  links = makeLinks();
  sync = gigSync({ me, gigId, room, links: myLinks, bandNow, lead: () => leadMs([]), onChange: refresh });

  const unlisten = room.listen((message) => {
    if (closed) return;
    if (message.kind === "hello") offLineup = !(Array.isArray(message.lineups) && message.lineups.includes(gigId));
    else if (message.kind === "on-lineup" && message.gigId === gigId) offLineup = false;
    else if (message.kind === "room-refused" && message.code === NOT_ON_LINEUP_CLOSE) offLineup = true;
    else return;
    refresh();
  });

  function wake() {
    if (closed || isLeader()) return;
    heardAt = localNow();
    joinFrom = null;
    relink();
  }

  const doc = typeof document !== "undefined" && typeof document.addEventListener === "function" ? document : null;
  const away = () => void (hiddenAt ??= localNow());
  const back = (always: boolean) => {
    const was = hiddenAt;
    hiddenAt = null;
    if (always || (was !== null && localNow() - was >= WAKE_AFTER_MS)) wake();
  };
  const onResume = () => back(true);
  const onVisibility = () => (doc?.visibilityState === "hidden" ? away() : back(false));
  doc?.addEventListener("freeze", away);
  doc?.addEventListener("resume", onResume);
  doc?.addEventListener("visibilitychange", onVisibility);

  return {
    view() {
      const state = sync.state();
      const leading = isLeader();
      const chosen = links.attempt().chosen;
      return {
        state,
        leading,
        confidence: confidenceNow(),
        spread: links.clock().spread,
        route: !leading && chosen?.state === "open" ? chosen.route : null,
        heard: leading ? "answering" : leaderHeard(localNow() - heardAt),
        heardAt: leading ? null : heardAt,
        signal: room.state === "open" || chosen?.state === "open",
        offLineup,
        steppedDown: led && !!state && state.leader !== me,
        refused,
        handoffAt,
        asks: [...asks],
      };
    },
    bandNow,
    bandAt,
    click() {
      const state = sync.state();
      if (!state) return null;
      if (isLeader()) return state.click;
      return joinFrom === null ? null : clickFrom(state.click, joinFrom);
    },
    start(plan) {
      sync.start(startGig({ ...plan, gigId, leader: me, now: bandNow() ?? (own() as BandMs) }));
    },
    tap(body) {
      const before = sync.state();
      const wasLeader = before?.leader === me;
      if (!wasLeader) {
        const line = adoptLead(links.clock(), localNow());
        adopted = line ?? (Number.isFinite(shown) ? { at: localNow(), offset: shown - localNow(), skew: 0 } : null);
      }
      const out = sync.tap({ ...body, opId: `${me}-${Date.now().toString(36)}-${(ops += 1)}`, epoch: before?.epoch ?? 0 } as Op);
      if (out.ok && !wasLeader && out.state.leader === me) relink();
      refresh();
      return out;
    },
    askToLead() {
      links.attempt().chosen?.send({ kind: ASK_TO_LEAD, from: me });
    },
    wake,
    close() {
      if (closed) return;
      closed = true;
      unlisten();
      for (const stop of hearing.values()) stop();
      hearing.clear();
      sync.close();
      links.close();
      doc?.removeEventListener("freeze", away);
      doc?.removeEventListener("resume", onResume);
      doc?.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
