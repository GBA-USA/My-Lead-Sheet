import type { BandMs, LinkRoute } from "./band-time";
import { receive, reduce, type GigState, type Op, type Outcome, type Received, type Refusal, type UserId } from "./gig-state";
import type { Link } from "./links/link";
import { NO_SIGNAL, WAITING_FOR_LEADER } from "./links/server-link";

/**
 * Phone to room. The leader's phone is the one writer (PLAN.md 7.10), so it sends the whole state its own `reduce` made,
 * with the op the room dedupes by and the band time it was sent. A gig's first state has no op.
 */
export type GigSend = { kind: "gig-op"; op: Op; state: GigState; at: BandMs } | { kind: "gig-start"; state: GigState; at: BandMs };

/** Phone to room: ask for the room's copy. The room answers with a `GigCopy`, and from then on forwards each new one. */
export type GigAsk = { kind: "gig-state"; gigId: string };

/** Room or leader to phone: the latest state and the band time it was sent, or null while the room holds none. */
export type GigCopy = { kind: "gig-state"; state: GigState; at: BandMs } | { kind: "gig-state"; state: null; at: null };

/** Why the room took nothing from a send and forwarded nothing. */
export type RoomRefusal = Extract<Refusal, "ended" | "repeat" | "stale-epoch" | "not-allowed" | "not-on-lineup">;
export type GigRefused = { kind: "gig-refused"; opId: string | null; refused: RoomRefusal };

/** One copy of a state this phone heard: where it came from, what `receive` made of it, and how late it was. */
export type Heard = { rev: number; epoch: number; result: Received; via: LinkRoute | "room"; heardAt: BandMs | null; lateMs: number | null };

export const KEEPING_THE_BEAT = `${NO_SIGNAL} · keeping the beat`;

/** The longest gig send the room reads. A whole state with a 200-song order is well under it. */
export const GIG_SEND_MAX_CHARS = 128_000;
const HEARD_KEPT = 500;
const REFUSED_KEPT = 50;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64;
const isTimeline = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every((step) => isObject(step) && isNumber(step.at));
const CLAIMS: Record<GigState["claim"], true> = { admin: true, backup: true, other: true };
const STATUSES: Record<GigState["status"], true> = { live: true, ended: true };

/** A state from a link or the room, with every field `receive`, the room's rules and `position` read. */
export function asGigState(value: unknown): GigState | null {
  if (!isObject(value)) return null;
  const { gigId, rev, epoch, changedAt, status, claim, leader, admin, backup, lineup, recentOps, handoff, last } = value;
  const ok =
    isId(gigId) && isNumber(rev) && isNumber(epoch) && isNumber(changedAt) && isId(leader) && isId(admin) && (backup === null || isId(backup)) &&
    typeof status === "string" && Object.hasOwn(STATUSES, status) && typeof claim === "string" && Object.hasOwn(CLAIMS, claim) &&
    Array.isArray(lineup) && lineup.every(isId) && Array.isArray(recentOps) && recentOps.every(isId) &&
    (handoff === null || (isObject(handoff) && isId(handoff.to) && isNumber(handoff.until))) &&
    (last === null || (isObject(last) && isId(last.opId) && isNumber(last.at))) &&
    ["order", "current", "section", "click", "scroll"].every((field) => isTimeline(value[field]));
  return ok ? (value as unknown as GigState) : null;
}

const asOp = (value: unknown): Op | null => (isObject(value) && isId(value.opId) && isNumber(value.epoch) && isId(value.kind) ? (value as unknown as Op) : null);

/** The room's boundary: a parsed message from a phone's socket as a send, or null if it is not one. */
export function asGigSend(value: unknown): GigSend | null {
  if (!isObject(value) || !isNumber(value.at)) return null;
  const state = asGigState(value.state);
  if (!state) return null;
  const at = value.at as BandMs;
  if (value.kind === "gig-start") return { kind: "gig-start", state, at };
  const op = value.kind === "gig-op" ? asOp(value.op) : null;
  return op && { kind: "gig-op", op, state, at };
}

/** The phone's boundary: a copy from the room or a link. */
function asGigCopy(value: unknown): GigCopy | null {
  if (!isObject(value) || value.kind !== "gig-state") return null;
  if (value.state === null) return { kind: "gig-state", state: null, at: null };
  const state = asGigState(value.state);
  return state && isNumber(value.at) ? { kind: "gig-state", state, at: value.at as BandMs } : null;
}

/** What this file needs of the room's socket (`roomLine` in src/links/server-link.ts). */
interface RoomSocket {
  readonly state: "connecting" | "open" | "down" | "refused";
  send(message: object): boolean;
  listen(cb: (message: { kind: string; [key: string]: unknown }) => void): () => void;
}

export interface GigSyncOptions {
  me: UserId;
  gigId: string;
  room: RoomSocket;
  /** Every link this phone has now: its link to the leader, and on the leader's phone one per follower. */
  links: () => readonly Link[];
  /** Band time now, or null while this phone has no estimate of the leader's clock. */
  bandNow: () => BandMs | null;
  /** The lead the leader stamps a change with (`leadMs` in src/band-time.ts). */
  lead: () => number;
  /** The state, the words or the refusals changed. */
  onChange?: () => void;
}

export interface GigSync {
  state(): GigState | null;
  /** The leader's first state. It goes out like any change, and a state this phone already has beats it. */
  start(state: GigState): void;
  /** Applies the op with this phone's `reduce`, then sends the state on every direct link and once to the room. */
  tap(op: Op): Outcome;
  /** Listens on links that are new since the last call and lets go of closed ones. Call it whenever the links change. */
  relink(): void;
  /** What the gig strip says, or null when there is nothing to say. */
  words(): string | null;
  heard(): readonly Heard[];
  refused(): readonly GigRefused[];
  close(): void;
}

const keep = <T>(list: T[], entry: T, max: number) => {
  list.push(entry);
  if (list.length > max) list.splice(0, list.length - max);
};

/**
 * One phone's side of the gig state, leader or follower (PLAN.md 7.9). The leader sends each change once on every
 * direct link (Wi-Fi or internet) and once to the room, which forwards it to everyone else on the lineup and keeps it
 * for late joiners. A follower applies whatever copy arrives first through `receive`, so the same rev on two links or
 * a cut-off leader's older epoch changes nothing. No timers: every link and the room keep their own.
 */
export function gigSync(options: GigSyncOptions): GigSync {
  const { me, gigId, room } = options;
  let state: GigState | null = null;
  /** The send that made `state`, while this phone made it. A reconnect sends it again if the room's copy is older. */
  let mine: GigSend | null = null;
  let closed = false;
  const heard: Heard[] = [];
  const refusals: GigRefused[] = [];
  const listening = new Map<Link, () => void>();

  const changed = () => {
    if (!closed) options.onChange?.();
  };
  const ask = () => room.send({ kind: "gig-state", gigId } satisfies GigAsk);

  function send(message: GigSend) {
    mine = message;
    state = message.state;
    relink();
    const copy: GigCopy = { kind: "gig-state", state: message.state, at: message.at };
    for (const link of options.links()) if (link.state === "open" && link.route !== "server") link.send(copy);
    room.send(message);
    changed();
  }

  function hear(copy: GigCopy, via: Heard["via"]) {
    if (copy.state === null) return catchUp(null);
    const incoming = copy.state;
    if (incoming.gigId !== gigId) return;
    const { state: next, result } = receive(state, incoming);
    const heardAt = options.bandNow();
    const lateMs = result === "applied" && incoming.last && heardAt !== null ? heardAt - incoming.last.at : null;
    keep(heard, { rev: incoming.rev, epoch: incoming.epoch, result, via, heardAt, lateMs }, HEARD_KEPT);
    if (result === "applied") {
      state = next;
      mine = null;
      changed();
    }
    if (via === "room") catchUp(incoming);
  }

  /** The room answered with its copy. If this phone leads with a newer state, the room gets it once; it dedupes by op id. */
  function catchUp(roomCopy: GigState | null) {
    if (!mine || !state || state.leader !== me) return;
    if (roomCopy && receive(roomCopy, state).result !== "applied") return;
    room.send(mine);
  }

  function relink() {
    const now = new Set(options.links());
    for (const [link, stop] of listening) {
      if (now.has(link) && link.state !== "closed") continue;
      stop();
      listening.delete(link);
    }
    for (const link of now) {
      if (listening.has(link) || link.state === "closed") continue;
      listening.set(
        link,
        link.onMessage((value) => {
          const copy = asGigCopy(value);
          if (copy?.state && !closed) hear(copy, link.route);
        }),
      );
    }
  }

  const unlisten = room.listen((message) => {
    if (closed) return;
    if (message.kind === "hello") return void ask();
    if (message.kind === "gig-state") {
      const copy = asGigCopy(message);
      return copy ? hear(copy, "room") : undefined;
    }
    if (message.kind === "gig-refused") {
      keep(refusals, { kind: "gig-refused", opId: (message.opId as string | null) ?? null, refused: message.refused as RoomRefusal }, REFUSED_KEPT);
      return changed();
    }
    if (message.kind === "room-down" || message.kind === "room-refused") changed();
  });
  if (room.state === "open") ask();

  return {
    state: () => state,
    start(first) {
      if (state && receive(state, first).result !== "applied") return;
      const at = options.bandNow() ?? first.changedAt;
      send({ kind: "gig-start", state: first, at });
    },
    tap(op) {
      const now = options.bandNow();
      if (!state || now === null) return { ok: false, refused: "not-allowed" };
      const out = reduce(state, op, { by: me, now, lead: options.lead() });
      if (out.ok) send({ kind: "gig-op", op, state: out.state, at: now });
      return out;
    },
    relink,
    words() {
      const linked = options.links().some((link) => link.state === "open");
      if (!state) return linked || room.state === "open" || room.state === "connecting" ? WAITING_FOR_LEADER : NO_SIGNAL;
      return state.leader === me || linked || room.state === "open" ? null : KEEPING_THE_BEAT;
    },
    heard: () => heard,
    refused: () => refusals,
    close() {
      if (closed) return;
      closed = true;
      unlisten();
      for (const stop of listening.values()) stop();
      listening.clear();
    },
  };
}
