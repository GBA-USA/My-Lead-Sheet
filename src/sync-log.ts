import type { Route } from "./sync-rating";

/**
 * The Sync check's log (PLAN.md 5, 7.17): one row per beat per phone, written only during a run.
 * No runtime imports, so `scripts/sync-report.ts` and `scripts/sync-video.ts` load this file as it is.
 */

/** What a phone was on for one beat: its route to the leader, or the leader itself, which is the band's clock. */
export type SyncRoute = Route | "leader";
export const SYNC_ROUTES: readonly SyncRoute[] = ["leader", "wifi", "internet", "server"];

/** One `sync_log` row, in the table's frozen column order. Times are band milliseconds. */
export type SyncRow = {
  run_id: string;
  user_id: string;
  beat: number;
  route: SyncRoute;
  /** The phone's carrier as the player picked it, or "" when they didn't. A browser can't read it. */
  carrier: string;
  /** When the beat is due. */
  at: number;
  /** The band time of the frame that showed the flash, or null if no frame did. */
  shown_at: number | null;
  /** When the click reached the listener, by this phone's own reckoning, or null if none was heard. */
  clicked_at: number | null;
  offset_ms: number;
  spread_ms: number | null;
  rtt_ms: number | null;
  frame_ms: number | null;
};

/** What a phone sends for one beat. The server adds the run and the caller's user id. */
export type SyncBeat = Omit<SyncRow, "run_id" | "user_id">;

/** One Sync check run. Beat `n` of the run is at `startAt + n * SYNC_BEAT_MS` in band time. */
export type SyncRun = {
  runId: string;
  startAt: number;
  endsAt: number;
};

/** The check clicks 120 bpm on a grid that starts at band time 0, so every run starts on a beat everyone is already on. */
export const SYNC_BEAT_MS = 500;
export const SYNC_RUN_MS = 60_000;
export const SYNC_RUN_BEATS = SYNC_RUN_MS / SYNC_BEAT_MS;

/** PLAN.md 7.15, p95 and max between any two phones, by the looser route of the pair. No relay row: the app uses no relay. */
export const SYNC_TARGETS: Record<Route, { screen: readonly [number, number]; click: readonly [number, number] }> = {
  wifi: { screen: [17, 30], click: [5, 10] },
  internet: { screen: [18, 32], click: [8, 18] },
  server: { screen: [20, 35], click: [10, 20] },
};
/** Logged spread at p95 on every route (PLAN.md 7.15). */
export const SPREAD_TARGET_MS = 5;

const LOOSENESS: readonly Route[] = ["wifi", "internet", "server"];

/** The loosest route a phone or pair used in a run. The leader is held to its partner's route, and leader alone to the Wi-Fi link's. */
function loosest(routes: Iterable<SyncRoute>): Route {
  let at = 0;
  for (const route of routes) if (route !== "leader") at = Math.max(at, LOOSENESS.indexOf(route));
  return LOOSENESS[at];
}

/** Nearest-rank p95: the smallest value at least 95% of the values are at or under. */
function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

export type Spread = { p95: number; max: number };
export type PairResult = { a: string; b: string; route: Route; screen: Spread | null; click: Spread | null; pass: boolean };
export type PhoneResult = { userId: string; carrier: string; spreadP95: number | null; pass: boolean };
export type RunReport = { runId: string; phones: PhoneResult[]; pairs: PairResult[]; pass: boolean };

const spread = (gaps: number[]): Spread | null => (gaps.length ? { p95: p95(gaps), max: Math.max(...gaps) } : null);
const within = (measured: Spread | null, [p95Ms, maxMs]: readonly [number, number]) => !measured || (measured.p95 <= p95Ms && measured.max <= maxMs);

function gaps(a: Map<number, SyncRow>, b: Map<number, SyncRow>, field: "shown_at" | "clicked_at"): number[] {
  const out: number[] = [];
  for (const [beat, mine] of a) {
    const [at, theirs] = [mine[field], b.get(beat)?.[field]];
    if (at !== null && theirs != null) out.push(Math.abs(at - theirs));
  }
  return out;
}

/** Every run in `rows`, in the order they first appear: each phone's spread and each pair's screen and click gaps against 7.15. */
export function syncReport(rows: SyncRow[]): RunReport[] {
  const runs = new Map<string, Map<string, Map<number, SyncRow>>>();
  for (const row of rows) {
    const phones = runs.get(row.run_id) ?? runs.set(row.run_id, new Map()).get(row.run_id)!;
    const beats = phones.get(row.user_id) ?? phones.set(row.user_id, new Map()).get(row.user_id)!;
    beats.set(row.beat, row);
  }
  return [...runs].map(([runId, byPhone]) => {
    const ids = [...byPhone.keys()].sort();
    const phones = ids.map((userId): PhoneResult => {
      const beats = [...byPhone.get(userId)!.values()];
      const spreads = beats.flatMap((beat) => (beat.spread_ms === null ? [] : [beat.spread_ms]));
      const spreadP95 = spreads.length ? p95(spreads) : null;
      return { userId, carrier: beats.find((beat) => beat.carrier)?.carrier ?? "", spreadP95, pass: spreadP95 === null || spreadP95 <= SPREAD_TARGET_MS };
    });
    const pairs = ids.flatMap((a, i) =>
      ids.slice(i + 1).map((b): PairResult => {
        const [mine, theirs] = [byPhone.get(a)!, byPhone.get(b)!];
        const route = loosest([...mine.values(), ...theirs.values()].map((beat) => beat.route));
        const screen = spread(gaps(mine, theirs, "shown_at"));
        const click = spread(gaps(mine, theirs, "clicked_at"));
        return { a, b, route, screen, click, pass: within(screen, SYNC_TARGETS[route].screen) && within(click, SYNC_TARGETS[route].click) };
      }),
    );
    return { runId, phones, pairs, pass: phones.every((phone) => phone.pass) && pairs.every((pair) => pair.pass) };
  });
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const numberOrNull = (value: unknown) => value === null || isNumber(value);

/**
 * Rows from a saved log: a JSON list, `{ rows: [...] }` as the rows route answers, or one JSON row per line.
 * A row that isn't a `sync_log` row throws, naming it, so a report never quietly skips a phone.
 */
export function readSyncRows(text: string): SyncRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  }
  const rows = (parsed as { rows?: unknown } | null)?.rows;
  const values = Array.isArray(parsed) ? parsed : Array.isArray(rows) ? rows : [parsed];
  return values.map((value, i) => {
    const row = value as Record<string, unknown>;
    const ok =
      typeof row === "object" && row !== null &&
      typeof row.run_id === "string" && typeof row.user_id === "string" && Number.isInteger(row.beat) &&
      SYNC_ROUTES.includes(row.route as SyncRoute) && typeof row.carrier === "string" && isNumber(row.at) &&
      numberOrNull(row.shown_at) && numberOrNull(row.clicked_at) && isNumber(row.offset_ms) &&
      numberOrNull(row.spread_ms) && numberOrNull(row.rtt_ms) && numberOrNull(row.frame_ms);
    if (!ok) throw new Error(`row ${i + 1} is not a sync_log row: ${JSON.stringify(value).slice(0, 200)}`);
    return row as unknown as SyncRow;
  });
}

/**
 * The phone's side of the log for one run. Rows wait here until `flush` sends them. A send that fails keeps nothing:
 * the beat already flashed and clicked, so its row is dropped and counted, and the count is shown after the run.
 * Flushes run one after another, so the counts read once a flush settles include every send already under way.
 */
export function syncLogQueue(send: (beats: SyncBeat[]) => Promise<unknown>, perSend = 40) {
  let waiting: SyncBeat[] = [];
  let logged = 0;
  let dropped = 0;
  let sending = Promise.resolve();
  const drain = async () => {
    while (waiting.length) {
      const batch = waiting.slice(0, perSend);
      waiting = waiting.slice(perSend);
      try {
        await send(batch);
        logged += batch.length;
      } catch {
        dropped += batch.length;
      }
    }
  };
  return {
    add(beat: SyncBeat) {
      waiting.push(beat);
    },
    flush() {
      sending = sending.then(drain);
      return sending;
    },
    counts: () => ({ logged, dropped }),
  };
}
