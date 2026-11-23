import { addPing, newClock, type Ping } from "./band-time";
import type { LinkRoute } from "./routes";
import type { RouteSummary } from "./sync-rating";

/** Where a measurement came from: a gig, Settings > Connection > Test now, or Test with a bandmate. */
export type SyncSource = "gig" | "test-now" | "bandmate";

/**
 * One route on one day of this phone's history, keyed `"<route>/<day>"` in the `syncHistory` store (PLAN.md 7.5).
 * It holds numbers and a day and nothing else: a browser can't read the Wi-Fi network's name, and none is kept, so a
 * rating belongs to this phone and the route, never to a venue.
 */
export type SyncRecord = RouteSummary & { day: string; source: SyncSource };

/** What one run measured. A run with no numbers is a try that failed. */
export type Run = { spreadMs?: number; p99Ms?: number; lateRate?: number; tries: boolean[]; source: SyncSource };

/** The phone's `syncHistory` store (src/phone-db.ts). The tests hand in a Map instead. */
export interface HistoryStore {
  get(key: string): Promise<SyncRecord | undefined>;
  put(key: string, value: SyncRecord): Promise<void>;
  remove(key: string): Promise<void>;
  entries(): Promise<Array<[string, SyncRecord]>>;
}

export const KEEP_DAYS = 30;
/** A day's measurement counts half as much for each 5 days older it is, so the newest days count most. */
export const HALF_LIFE_DAYS = 5;
const KEEP_TRIES = 8;
const DAY_MS = 86_400_000;
const ROUTES: readonly LinkRoute[] = ["wifi", "internet", "server"];

/** Test now measures for about this long (PLAN.md 7.5). The address can shorten it for a check. */
export const TEST_NOW_MS = 20_000;
/** A bandmate who has been scanned and does not answer within this long is given up on. The wait for the scan is not counted. */
export const BANDMATE_WAIT_MS = 30_000;
/** Free public STUN only. No TURN server in any ICE config. */
export const FREE_STUN: readonly string[] = ["stun:stun.cloudflare.com:3478"];

const pad = (n: number) => String(n).padStart(2, "0");

/** The phone's own calendar day, `YYYY-MM-DD`. */
export function dayOf(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const keyOf = (route: LinkRoute, day: string) => `${route}/${day}`;

function parts(key: string): { route: LinkRoute; day: string } | null {
  const [route, day, ...rest] = key.split("/");
  return rest.length === 0 && ROUTES.includes(route as LinkRoute) && /^\d{4}-\d{2}-\d{2}$/.test(day ?? "") ? { route: route as LinkRoute, day } : null;
}

const dayStart = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
};
/** Whole calendar days from `day` to `now`. Rounded, so a clock change never makes a day 23 or 25 hours, and never below 0 if the phone's clock moved back. */
const daysBetween = (day: string, now: number) => Math.max(0, Math.round((dayStart(dayOf(now)) - dayStart(day)) / DAY_MS));

const has = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/** Saves a run under its route and today. A second run on the same day replaces the numbers (if it has any) and adds its tries. Days past the last 30 are dropped. */
export async function saveRun(store: HistoryStore, route: LinkRoute, run: Run, now: number): Promise<void> {
  const day = dayOf(now);
  const key = keyOf(route, day);
  const before = await store.get(key);
  const numbers = has(run.spreadMs) ? run : before;
  const next: SyncRecord = { tries: [...(before?.tries ?? []), ...run.tries].slice(-KEEP_TRIES), day, source: run.source };
  if (has(numbers?.spreadMs)) next.spreadMs = numbers!.spreadMs;
  if (has(numbers?.p99Ms)) next.p99Ms = numbers!.p99Ms;
  if (has(numbers?.lateRate)) next.lateRate = numbers!.lateRate;
  await store.put(key, next);
  for (const [other] of await store.entries()) {
    const at = parts(other);
    if (!at || daysBetween(at.day, now) >= KEEP_DAYS) await store.remove(other);
  }
}

const MONTH_DAY = { month: "short", day: "numeric" } as const;

/** How old a measurement is and where it came from, in the words a player reads next to the rating. */
export function testedWords(source: SyncSource, day: string, now: number): string {
  const age = daysBetween(day, now);
  const date = new Date(dayStart(day));
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  const when = age <= 0 ? "today" : age === 1 ? "yesterday" : age < 7 ? weekday : null;
  const on = date.toLocaleDateString("en-US", MONTH_DAY);
  if (source === "gig") return when ? `tested at ${when}'s gig` : `tested at the gig on ${on}`;
  if (source === "test-now") return `tested ${when ?? on}`;
  return `tested with a bandmate ${when ?? `on ${on}`}`;
}

const weighted = (records: Array<{ record: SyncRecord; weight: number }>, field: "spreadMs" | "p99Ms" | "lateRate") => {
  const used = records.filter(({ record }) => has(record[field]));
  const total = used.reduce((sum, { weight }) => sum + weight, 0);
  return total > 0 ? used.reduce((sum, { record, weight }) => sum + record[field]! * weight, 0) / total : undefined;
};

/** The phone's summary for each route it has any history for: the newest days count most, and the age and source are the newest measurement's. */
export async function loadSummaries(store: HistoryStore, now: number): Promise<Partial<Record<LinkRoute, RouteSummary>>> {
  const byRoute = new Map<LinkRoute, SyncRecord[]>();
  for (const [key, record] of await store.entries()) {
    const at = parts(key);
    if (!at || daysBetween(at.day, now) >= KEEP_DAYS) continue;
    byRoute.set(at.route, [...(byRoute.get(at.route) ?? []), record]);
  }
  const out: Partial<Record<LinkRoute, RouteSummary>> = {};
  for (const [route, records] of byRoute) {
    const sorted = [...records].sort((a, b) => a.day.localeCompare(b.day));
    const weights = sorted.map((record) => ({ record, weight: 0.5 ** (daysBetween(record.day, now) / HALF_LIFE_DAYS) }));
    const measured = sorted.filter((record) => has(record.spreadMs));
    const newest = measured.at(-1) ?? sorted.at(-1)!;
    const summary: RouteSummary = { tries: sorted.flatMap((record) => record.tries), ageDays: daysBetween(newest.day, now), source: testedWords(newest.source, newest.day, now) };
    const spreadMs = weighted(weights, "spreadMs");
    if (spreadMs !== undefined) {
      summary.spreadMs = spreadMs;
      summary.p99Ms = weighted(weights, "p99Ms");
      summary.lateRate = weighted(weights, "lateRate") ?? 0;
    }
    out[route] = summary;
  }
  return out;
}

const FASTEST = 8;
const WINDOW = 32;

/** Nearest-rank 99th percentile. */
const p99 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.99) - 1)];

/**
 * Round trips to a server with no clock of its own become the same two numbers a gig keeps: the range of the 8 fastest
 * one-way times among the last 32 (the spread), and the slowest one-way time (p99). One way is half a round trip.
 */
export function summarizeRtts(rtts: number[]): { spreadMs: number; p99Ms: number; lateRate: number } {
  const oneWay = rtts.slice(-WINDOW).map((rtt) => rtt / 2);
  const fastest = [...oneWay].sort((a, b) => a - b).slice(0, FASTEST);
  return { spreadMs: fastest.length ? Math.max(...fastest) - Math.min(...fastest) : 0, p99Ms: p99(oneWay), lateRate: 0 };
}

/** Clock pings to another phone: the spread is the band clock's own (src/band-time.ts), the delay is the p99 one-way time. */
export function measureFromPings(pings: Ping[]): { spreadMs?: number; p99Ms: number; lateRate: number } {
  let clock = newClock();
  for (const ping of pings) clock = addPing(clock, ping, null);
  const oneWay = pings.slice(-WINDOW).map((ping) => (ping.t1 - ping.t0) / 2);
  return { ...(Number.isFinite(clock.spread) ? { spreadMs: clock.spread } : {}), p99Ms: oneWay.length ? p99(oneWay) : 0, lateRate: 0 };
}

export type Overrides = { stun?: string[]; testMs?: number; timeoutMs?: number };

const lengthParam = (value: string | null) => {
  const ms = Number(value);
  return value !== null && Number.isFinite(ms) && ms > 0 ? Math.min(60_000, Math.max(500, Math.round(ms))) : undefined;
};

/**
 * What the address may change, so a check can run Test now in seconds against a STUN server on its own machine:
 * `?stun=` (only stun: and stuns: URLs, so no TURN server can reach an ICE config), `syncTestMs`, `syncTimeoutMs`.
 */
export function testOverrides(search: string): Overrides {
  const params = new URLSearchParams(search);
  const stun = (params.get("stun") ?? "").split(",").map((url) => url.trim()).filter((url) => /^stuns?:/.test(url));
  const out: Overrides = {};
  if (stun.length) out.stun = stun;
  const testMs = lengthParam(params.get("syncTestMs"));
  if (testMs !== undefined) out.testMs = testMs;
  const timeoutMs = lengthParam(params.get("syncTimeoutMs"));
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  return out;
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Round trips to this site's own Worker, one after another, for `ms`. A failed request counts as a failure, not as a slow one. */
async function probeServer(ms: number, signal: AbortSignal): Promise<{ rtts: number[]; failed: number }> {
  const rtts: number[] = [];
  let failed = 0;
  for (const end = performance.now() + ms; performance.now() < end && !signal.aborted; await pause(100)) {
    const start = performance.now();
    const asked = new AbortController();
    const giveUp = setTimeout(() => asked.abort(), 3000);
    try {
      const reply = await fetch(`/api/health?t=${Math.random().toString(36).slice(2)}`, { cache: "no-store", signal: asked.signal });
      if (!reply.ok) throw new Error("not ok");
      await reply.arrayBuffer();
      rtts.push(performance.now() - start);
    } catch {
      failed += 1;
    } finally {
      clearTimeout(giveUp);
    }
  }
  return { rtts, failed };
}

/** One STUN round trip: how long a fresh connection takes to hear its public address back. */
function stunRoundTrip(urls: readonly string[], timeoutMs: number): Promise<number | null> {
  return new Promise((done) => {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: [...urls] }] });
    } catch {
      return done(null);
    }
    const start = performance.now();
    const finish = (value: number | null) => {
      clearTimeout(timer);
      pc.onicecandidate = null;
      pc.close();
      done(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    pc.onicecandidate = (event) => {
      if (event.candidate && /\btyp srflx\b/.test(event.candidate.candidate)) finish(performance.now() - start);
    };
    pc.createDataChannel("sync");
    pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => finish(null));
  });
}

async function probeInternet(urls: readonly string[], ms: number, signal: AbortSignal): Promise<{ rtts: number[]; failed: number }> {
  const rtts: number[] = [];
  let failed = 0;
  for (const end = performance.now() + ms; performance.now() < end && !signal.aborted; await pause(150)) {
    const rtt = await stunRoundTrip(urls, 2000);
    if (rtt === null) failed += 1;
    else rtts.push(rtt);
  }
  return { rtts, failed };
}

const ENOUGH = 3;

export type TestNowResult = { outcome: "offline" } | { outcome: "done"; saved: LinkRoute[] };

/**
 * Test now: about 20 s alone, measuring the server (this site's Worker) and the internet path (a free public STUN
 * server). The Wi-Fi link needs a second phone, so it is left alone. With no network, or a Worker that never answers,
 * nothing is saved: a phone with no signal says nothing about the routes.
 */
export async function testNow(store: HistoryStore, options: { stun: readonly string[]; ms: number; now?: () => number; signal?: AbortSignal }): Promise<TestNowResult> {
  const signal = options.signal ?? new AbortController().signal;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { outcome: "offline" };
  const [server, internet] = await Promise.all([probeServer(options.ms, signal), options.stun.length ? probeInternet(options.stun, options.ms, signal) : Promise.resolve(null)]);
  if (server.rtts.length < ENOUGH || signal.aborted) return { outcome: "offline" };
  const now = options.now ?? Date.now;
  const saved: LinkRoute[] = [];
  await saveRun(store, "server", { ...summarizeRtts(server.rtts), tries: [true], source: "test-now" }, now());
  saved.push("server");
  if (internet) {
    await saveRun(store, "internet", internet.rtts.length >= ENOUGH ? { ...summarizeRtts(internet.rtts), tries: [true], source: "test-now" } : { tries: [false], source: "test-now" }, now());
    saved.push("internet");
  }
  return { outcome: "done", saved };
}
