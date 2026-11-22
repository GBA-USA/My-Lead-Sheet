import type { BandMs, LinkRoute, LocalMs, Ping } from "../band-time";
import type { Link, LinkState } from "./link";

/** What the two ends of any link say. Sent as plain `JSON.stringify`, so a ping reads `{"k":"ping",...}`. */
export type Wire = { k: "ping"; n: number; t0: number } | { k: "pong"; n: number; t0: number; band: number } | { k: "op"; op: unknown };

export const PING_TIMEOUT_MS = 5000;
export const LINK_LOST = "The link to the leader dropped";

/** This phone's monotonic clock, which band time is measured against (PLAN.md 7.6). Never `Date.now()`. */
export const localNow = () => (performance.timeOrigin + performance.now()) as LocalMs;

export function asWire(value: unknown): Wire | null {
  if (typeof value !== "object" || value === null) return null;
  const { k, n, t0, band } = value as Record<string, unknown>;
  if (k === "op") return value as Wire;
  if (k === "ping" && typeof n === "number" && typeof t0 === "number") return { k, n, t0 };
  if (k === "pong" && typeof n === "number" && typeof t0 === "number" && typeof band === "number") return { k, n, t0, band };
  return null;
}

type Pending = { resolve: (ping: Ping) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/**
 * What every kind of link shares: ops, clock pings with their timers, and one way to end. A kind says how a message
 * goes out (`carry`) and what to shut when the link ends (`release`), and calls `opened`, `receive` and `end`.
 * With `bandNow` this end is the leader's, and it answers pings with its band time.
 */
export class WiredLink implements Link {
  route: LinkRoute;
  state: LinkState = "connecting";
  reason: string | null = null;
  private readonly listeners = new Set<(op: unknown) => void>();
  private readonly watchers = new Set<(state: LinkState) => void>();
  private readonly pending = new Map<number, Pending>();
  private sent = 0;
  private readonly carry: (wire: Wire) => void;
  private readonly release: () => void;
  private readonly bandNow: (() => BandMs) | null;

  constructor(route: LinkRoute, carry: (wire: Wire) => void, release: () => void, bandNow: (() => BandMs) | null) {
    this.route = route;
    this.carry = carry;
    this.release = release;
    this.bandNow = bandNow;
  }

  onState(cb: (state: LinkState) => void): () => void {
    this.watchers.add(cb);
    return () => this.watchers.delete(cb);
  }

  private tell() {
    for (const cb of [...this.watchers]) cb(this.state);
  }

  opened() {
    if (this.state !== "connecting") return;
    this.state = "open";
    this.tell();
  }

  /** A data channel is labeled before it opens, and again if its candidate pair moves. */
  relabel(route: LinkRoute) {
    if (route === this.route || this.state === "closing" || this.state === "closed") return;
    this.route = route;
    if (this.state === "open") this.tell();
  }

  receive(wire: Wire) {
    if (this.state !== "open") return;
    if (wire.k === "ping" && this.bandNow) this.carry({ k: "pong", n: wire.n, t0: wire.t0, band: this.bandNow() });
    if (wire.k === "op") for (const cb of [...this.listeners]) cb(wire.op);
    if (wire.k !== "pong") return;
    const waiting = this.pending.get(wire.n);
    if (!waiting) return;
    this.pending.delete(wire.n);
    clearTimeout(waiting.timer);
    waiting.resolve({ t0: wire.t0 as LocalMs, t1: localNow(), band: wire.band as BandMs });
  }

  send(op: unknown) {
    if (this.state === "open") this.carry({ k: "op", op });
  }

  onMessage(cb: (op: unknown) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  ping(): Promise<Ping> {
    if (this.state !== "open") return Promise.reject(new Error("link-closed"));
    const n = (this.sent += 1);
    const t0 = localNow();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(n);
        reject(new Error("no-pong"));
      }, PING_TIMEOUT_MS);
      this.pending.set(n, { resolve, reject, timer });
      this.carry({ k: "ping", n, t0 });
    });
  }

  /** The link is over, on purpose (`reason` null) or not. Every pending ping fails and its timer stops. */
  end(reason: string | null) {
    if (this.state === "closed") return;
    this.state = "closed";
    this.reason = reason;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("link-closed"));
    }
    this.pending.clear();
    this.listeners.clear();
    this.release();
    this.tell();
    this.watchers.clear();
  }

  close() {
    if (this.state === "closed" || this.state === "closing") return;
    this.state = "closing";
    this.tell();
    this.end(null);
  }
}
