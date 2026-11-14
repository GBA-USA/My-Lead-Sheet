import { barTime, beatAt, snap, type BandMs, type Grid, type SnapRule } from "./band-time";

export type UserId = string;
export type SongKey = string;
export type RouteChoice = "auto" | "band_wifi" | "direct_cell" | "server";

export interface Scheduled<T> {
  value: T;
  at: BandMs;
  before: T;
}

/** At `startAt` the chart is `fromSec` plan seconds in, then moves `rate` plan seconds per band second, as scroll-timing's clock counts them. */
export interface Scroll {
  version: string | null;
  startAt: BandMs;
  fromSec: number;
  rate: number;
}

interface Shown {
  order: Scheduled<SongKey[]>;
  current: Scheduled<SongKey>;
  section: Scheduled<number | null>;
  click: Scheduled<Grid | null>;
  scroll: Scheduled<Scroll | null>;
}

export interface GigState extends Shown {
  gigId: string;
  rev: number;
  epoch: number;
  status: "live" | "ended";
  route: RouteChoice;
  scrollAlong: boolean;
  leader: UserId;
  backup: UserId | null;
  admin: UserId;
  lineup: UserId[];
  handoff: { to: UserId; until: BandMs } | null;
  changedAt: BandMs;
  recentOps: string[];
  last: { opId: string; key: string; at: BandMs; before: Shown } | null;
}

type Move =
  | { kind: "goTo"; key: SongKey }
  | { kind: "section"; index: number }
  | { kind: "countIn"; bpm: number; beatsPerBar: number; bars: number; version: string | null; rate: number }
  | { kind: "tempo"; bpm: number }
  | { kind: "stop" }
  | { kind: "scrollStart"; version: string | null; rate: number; fromSec: number }
  | { kind: "reorder"; order: SongKey[] };

type Control =
  | { kind: "undo"; target: string }
  | { kind: "handOff"; to: UserId }
  | { kind: "accept" }
  | { kind: "takeOver" }
  | { kind: "setBackup"; userId: UserId | null }
  | { kind: "setLineup"; lineup: UserId[] }
  | { kind: "end" };

export type Op = { opId: string; epoch: number } & (Move | Control);

export type Refusal =
  | "ended"
  | "repeat"
  | "stale-epoch"
  | "not-allowed"
  | "same-target"
  | "unknown-song"
  | "changes-songs"
  | "not-running"
  | "scroll-off"
  | "too-late"
  | "not-on-lineup"
  | "offer-expired";

export type Outcome = { ok: true; state: GigState } | { ok: false; refused: Refusal };

const HANDOFF_WAIT_MS = 30_000;
const IDLE_END_MS = 8 * 3_600_000;
const RECENT_OPS = 64;

const shown = <T>(s: Scheduled<T>, t: BandMs): T => (t >= s.at ? s.value : s.before);
const still = <T>(value: T, at: BandMs): Scheduled<T> => ({ value, at, before: value });
const schedule = <T>(s: Scheduled<T>, value: T, at: BandMs, now: BandMs): Scheduled<T> => ({ value, at, before: shown(s, now) });

export function startGig(plan: {
  gigId: string;
  order: SongKey[];
  leader: UserId;
  admin: UserId;
  backup: UserId | null;
  lineup: UserId[];
  route: RouteChoice;
  scrollAlong: boolean;
  now: BandMs;
}): GigState {
  const { now, order, ...rest } = plan;
  return {
    ...rest,
    rev: 0,
    epoch: 0,
    status: "live",
    order: still(order, now),
    current: still(order[0], now),
    section: still(null, now),
    click: still(null, now),
    scroll: still(null, now),
    handoff: null,
    changedAt: now,
    recentOps: [],
    last: null,
  };
}

function runningGrid(state: GigState, t: BandMs): Grid | null {
  const grid = shown(state.click, t);
  return grid && t >= grid.startAt ? grid : null;
}

const runningScroll = (state: GigState, t: BandMs) => {
  const scroll = shown(state.scroll, t);
  return scroll && t >= scroll.startAt ? scroll : null;
};

function retime(scroll: Scroll, from: Grid, to: Grid): Scroll {
  const rate = (scroll.rate * to.bpm) / from.bpm;
  if (scroll.startAt > to.startAt) return { ...scroll, rate, startAt: barTime(to, beatAt(from, scroll.startAt)!.bar) };
  return { ...scroll, rate, startAt: to.startAt, fromSec: scroll.fromSec + (scroll.rate * (to.startAt - scroll.startAt)) / 1000 };
}

type Change = { at: BandMs; fields: Partial<Shown> } | Refusal;

function move(state: GigState, op: Move, now: BandMs, lead: number): Change {
  const earliest = (now + lead) as BandMs;
  const grid = runningGrid(state, earliest);
  const at = (rule: SnapRule) => snap(rule, earliest, grid);
  const order = shown(state.order, earliest);
  switch (op.kind) {
    case "goTo": {
      if (!order.includes(op.key)) return "unknown-song";
      if (state.current.value === op.key) return "same-target";
      const t = at("song");
      return {
        at: t,
        fields: {
          current: schedule(state.current, op.key, t, now),
          section: schedule(state.section, null, t, now),
          click: schedule(state.click, null, t, now),
          scroll: schedule(state.scroll, null, t, now),
        },
      };
    }
    case "section": {
      if (state.section.value === op.index) return "same-target";
      const t = at("section");
      return { at: t, fields: { section: schedule(state.section, op.index, t, now) } };
    }
    case "countIn": {
      const t = at("countIn");
      const click: Grid = { bpm: op.bpm, beatsPerBar: op.beatsPerBar, startAt: t, firstBar: -op.bars };
      const scroll = state.scrollAlong
        ? { version: op.version, startAt: barTime(click, 0), fromSec: 0, rate: op.rate }
        : null;
      return { at: t, fields: { click: schedule(state.click, click, t, now), scroll: schedule(state.scroll, scroll, t, now) } };
    }
    case "tempo": {
      if (!grid) return "not-running";
      if (grid.bpm === op.bpm) return "same-target";
      const t = at("tempo");
      const click: Grid = { ...grid, bpm: op.bpm, startAt: t, firstBar: beatAt(grid, t)!.bar };
      const scroll = shown(state.scroll, t);
      const retimed = scroll && retime(scroll, grid, click);
      return { at: t, fields: { click: schedule(state.click, click, t, now), scroll: schedule(state.scroll, retimed, t, now) } };
    }
    case "stop": {
      if (!grid && !runningScroll(state, earliest)) return "not-running";
      const t = at("stop");
      return { at: t, fields: { click: schedule(state.click, null, t, now), scroll: schedule(state.scroll, null, t, now) } };
    }
    case "scrollStart": {
      if (!state.scrollAlong) return "scroll-off";
      const t = at("scroll");
      const scroll = { version: op.version, startAt: t, fromSec: op.fromSec, rate: op.rate };
      return { at: t, fields: { scroll: schedule(state.scroll, scroll, t, now) } };
    }
    case "reorder": {
      const same = op.order.length === order.length && new Set(op.order).size === order.length && order.every((key) => op.order.includes(key));
      if (!same) return "changes-songs";
      if (op.order.every((key, i) => key === order[i])) return "same-target";
      return { at: earliest, fields: { order: schedule(state.order, op.order, earliest, now) } };
    }
  }
}

const MAY: Record<Op["kind"], (state: GigState, by: UserId) => boolean> = {
  goTo: (s, by) => by === s.leader,
  section: (s, by) => by === s.leader,
  countIn: (s, by) => by === s.leader,
  tempo: (s, by) => by === s.leader,
  stop: (s, by) => by === s.leader,
  scrollStart: (s, by) => by === s.leader,
  reorder: (s, by) => by === s.leader,
  undo: (s, by) => by === s.leader,
  handOff: (s, by) => by === s.leader,
  setLineup: (s, by) => by === s.leader,
  end: (s, by) => by === s.leader,
  setBackup: (s, by) => by === s.leader || by === s.admin,
  accept: (s, by) => by === s.handoff?.to,
  takeOver: (s, by) => by !== s.leader && (by === s.admin || by === s.backup),
};

function control(state: GigState, op: Control, by: UserId, now: BandMs): Partial<GigState> | Refusal {
  switch (op.kind) {
    case "undo": {
      const last = state.last;
      if (!last || last.opId !== op.target) return "not-allowed";
      if (now >= last.at) return "too-late";
      return { ...last.before, last: null };
    }
    case "handOff":
      if (!state.lineup.includes(op.to) || op.to === state.leader) return "not-on-lineup";
      return { handoff: { to: op.to, until: (now + HANDOFF_WAIT_MS) as BandMs } };
    case "accept":
      if (now >= state.handoff!.until) return "offer-expired";
      return { leader: by, epoch: state.epoch + 1, handoff: null, last: null };
    case "takeOver":
      return { leader: by, epoch: state.epoch + 1, handoff: null, last: null };
    case "setBackup":
      if (op.userId !== null && (!state.lineup.includes(op.userId) || op.userId === state.leader)) return "not-on-lineup";
      if (op.userId === state.backup) return "same-target";
      return { backup: op.userId };
    case "setLineup":
      if (!op.lineup.includes(state.leader)) return "not-on-lineup";
      return {
        lineup: op.lineup,
        backup: state.backup && op.lineup.includes(state.backup) ? state.backup : null,
        handoff: state.handoff && op.lineup.includes(state.handoff.to) ? state.handoff : null,
      };
    case "end":
      return { status: "ended" };
  }
}

const MOVES: Record<Move["kind"], true> = { goTo: true, section: true, countIn: true, tempo: true, stop: true, scrollStart: true, reorder: true };
const isMove = (op: Op): op is Op & Move => op.kind in MOVES;

const opKey = ({ opId: _id, epoch: _epoch, ...rest }: Op) => JSON.stringify(rest);

export function reduce(state: GigState, op: Op, ctx: { by: UserId; now: BandMs; lead: number }): Outcome {
  const { by, now, lead } = ctx;
  if (state.status === "ended" || now - state.changedAt >= IDLE_END_MS) return { ok: false, refused: "ended" };
  if (state.recentOps.includes(op.opId)) return { ok: false, refused: "repeat" };
  if (op.epoch !== state.epoch) return { ok: false, refused: "stale-epoch" };
  if (!MAY[op.kind](state, by)) return { ok: false, refused: "not-allowed" };

  let changes: Partial<GigState>;
  if (isMove(op)) {
    const key = opKey(op);
    if (state.last && state.last.key === key && now < state.last.at) return { ok: false, refused: "same-target" };
    const change = move(state, op, now, lead);
    if (typeof change === "string") return { ok: false, refused: change };
    const before = { order: state.order, current: state.current, section: state.section, click: state.click, scroll: state.scroll };
    changes = { ...change.fields, last: { opId: op.opId, key, at: change.at, before } };
  } else {
    const change = control(state, op, by, now);
    if (typeof change === "string") return { ok: false, refused: change };
    changes = change;
  }
  return {
    ok: true,
    state: {
      ...state,
      ...changes,
      rev: state.rev + 1,
      changedAt: now,
      recentOps: [...state.recentOps, op.opId].slice(-RECENT_OPS),
    },
  };
}

export type Received = "applied" | "duplicate" | "old" | "old-epoch" | "lost-tie" | "other-gig";

const rank = (s: GigState) => (s.leader === s.admin ? 0 : s.leader === s.backup ? 1 : 2);

function outranks(a: GigState, b: GigState) {
  return rank(a) - rank(b) || (a.leader < b.leader ? -1 : 1);
}

/** Ordered by (epoch, rev), so a take-over wins even when the cut-off old leader counted more revs. */
export function receive(local: GigState | null, incoming: GigState): { state: GigState; result: Received } {
  if (!local) return { state: incoming, result: "applied" };
  if (incoming.gigId !== local.gigId) return { state: local, result: "other-gig" };
  if (incoming.epoch < local.epoch) return { state: local, result: "old-epoch" };
  if (incoming.epoch > local.epoch) return { state: incoming, result: "applied" };
  if (incoming.leader !== local.leader) {
    return outranks(incoming, local) < 0 ? { state: incoming, result: "applied" } : { state: local, result: "lost-tie" };
  }
  if (incoming.rev === local.rev) return { state: local, result: "duplicate" };
  if (incoming.rev < local.rev) return { state: local, result: "old" };
  return { state: incoming, result: "applied" };
}

export interface Position {
  song: { key: SongKey; index: number };
  section: number | null;
  beat: { bar: number; beat: number } | null;
  scroll: { version: string | null; planSec: number } | null;
  ended: boolean;
}

export function position(state: GigState, t: BandMs): Position {
  const grid = runningGrid(state, t);
  const scroll = runningScroll(state, t);
  const key = shown(state.current, t);
  return {
    song: { key, index: shown(state.order, t).indexOf(key) },
    section: shown(state.section, t),
    beat: grid && beatAt(grid, t),
    scroll: scroll && { version: scroll.version, planSec: scroll.fromSec + (scroll.rate * (t - scroll.startAt)) / 1000 },
    ended: state.status === "ended" || t - state.changedAt >= IDLE_END_MS,
  };
}
