import type { LinkRoute, Ping } from "../band-time";

export type { LinkRoute, Ping } from "../band-time";

/** Where one link to the leader is in its life. */
export type LinkState = "connecting" | "open" | "closing" | "closed";

/** One live path between a phone and the leader, whatever carries it (PLAN.md 7.2). Every kind is this shape. */
export interface Link {
  /** What the link turned out to be. A data channel is labeled from its `getStats` candidate pair, so this can change once while it settles. */
  readonly route: LinkRoute;
  readonly state: LinkState;
  /** Why the link closed, in the player's words, or null while it is up or after a close on purpose. */
  readonly reason: string | null;
  send(op: unknown): void;
  onMessage(cb: (op: unknown) => void): () => void;
  /** One clock ping, stamped by the leader in band time. Rejects when the link closes or no answer comes. */
  ping(): Promise<Ping>;
  /** Stops the link, its pings and every timer it holds. A second call does nothing. */
  close(): void;
}

/** One combined attempt: the routes tried, the link in use, and why each route is not in use (C18's policy reads this). */
export type Attempt = { tried: LinkRoute[]; chosen: Link | null; reasons: Partial<Record<LinkRoute, string>> };

/**
 * Phone to room: introduce this phone for tonight's gig. The room checks the lineup first (PLAN.md 7.14). After its
 * first `gig` reply the phone sends back that reply's `openedAt`, so a reconnect keeps its place among the leader's phones.
 */
export type JoinGig = { kind: "join-gig"; gigId: string; openedAt?: number };

/**
 * Room to phone, after `join-gig` and whenever the leader joins: the leader's socket, or null while the leader is not in
 * the room. Of the leader's phones, the one that opened the gig first leads until it leaves. `openedAt` is this phone's.
 */
export type GigPeers = { kind: "gig"; gigId: string; you: string; leader: string | null; openedAt: number };

/**
 * Room to phone, first on every socket and so on every reconnect. `lineups` lists the gigs this player is on the lineup
 * of right now, so a phone joins only a gig that names it and never misses a lineup change made while it was away.
 */
export type Hello = { kind: "hello"; you: string; peers: string[]; lineups: string[] };

/** The room closes a socket whose player is not on the gig's lineup with this code. */
export const NOT_ON_LINEUP_CLOSE = 4404;

/** Room to phone, when an admin saves a lineup this player is on and this socket has not joined the gig: join it now. */
export type OnLineup = { kind: "on-lineup"; gigId: string };
