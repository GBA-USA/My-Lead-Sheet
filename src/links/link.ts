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

/** Phone to room: introduce this phone for tonight's gig. The room checks the lineup first (PLAN.md 7.14). */
export type JoinGig = { kind: "join-gig"; gigId: string };

/** Room to phone, after `join-gig` and whenever the leader joins: the leader's socket, or null while the leader is not in the room. */
export type GigPeers = { kind: "gig"; gigId: string; you: string; leader: string | null };

/** The room closes a socket whose player is not on the gig's lineup with this code. */
export const NOT_ON_LINEUP_CLOSE = 4404;
