import { SYNC_BEAT_MS, SYNC_ROUTES, SYNC_RUN_BEATS, SYNC_RUN_MS, type SyncBeat, type SyncRoute, type SyncRow, type SyncRun } from "../src/sync-log";
import { randomBytes, toBase64Url } from "./bytes";
import { signedIn, type Context, type Route } from "./directory-http";
import { fromRoom, Refused } from "./refused";
import { bandIdIn, bandRoom, inRoom, type RoomStore } from "./room-members";

/**
 * The Sync check's log in a band's Room (PLAN.md 5, 7.17). `sync_log` takes rows only while a run is live, so a
 * phone with the Sync check open and no run costs no writes. The admin starts a run; every member's phone logs its beats.
 */
export function createSyncLogTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS sync_runs (run_id TEXT PRIMARY KEY, started_by TEXT NOT NULL, start_at INTEGER NOT NULL, ends_at INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS sync_log (
    run_id TEXT NOT NULL, user_id TEXT NOT NULL, beat INTEGER NOT NULL, route TEXT NOT NULL, carrier TEXT NOT NULL,
    at REAL NOT NULL, shown_at REAL, clicked_at REAL, offset_ms REAL NOT NULL, spread_ms REAL, rtt_ms REAL, frame_ms REAL,
    PRIMARY KEY (run_id, user_id, beat)
  )`);
}

/** Time after a run ends for its last beats to arrive. A phone sends its beats every few seconds. */
export const SYNC_LOG_GRACE_MS = 30_000;
/** Time from Start to the run's first beat, so every phone's next look for a run lands before it. */
const RUN_LEAD_MS = 5_000;
const MAX_BEATS_PER_WRITE = 60;
const MAX_CARRIER_CHARS = 40;

type RunRow = { run_id: string; started_by: string; start_at: number; ends_at: number };
const asRun = (row: RunRow): SyncRun => ({ runId: row.run_id, startAt: row.start_at, endsAt: row.ends_at });
const latest = (sql: SqlStorage) => sql.exec<RunRow>(`SELECT * FROM sync_runs ORDER BY start_at DESC LIMIT 1`).toArray()[0];

const COLUMNS = "run_id, user_id, beat, route, carrier, at, shown_at, clicked_at, offset_ms, spread_ms, rtt_ms, frame_ms";

/** Every user id here is trusted: only the Directory calls these, after it has checked the session. */
export const syncLogRoom = {
  /** A second tap on Start while a run is live gives back that run. */
  start(band: RoomStore, adminId: string, now: number): SyncRun {
    const { sql } = band;
    bandRoom.requireAdmin(band, adminId);
    const live = latest(sql);
    if (live && now < live.ends_at) return asRun(live);
    const startAt = Math.ceil((now + RUN_LEAD_MS) / SYNC_BEAT_MS) * SYNC_BEAT_MS;
    const run = { run_id: `run_${toBase64Url(randomBytes(12))}`, started_by: adminId, start_at: startAt, ends_at: startAt + SYNC_RUN_MS };
    sql.exec(`INSERT INTO sync_runs (run_id, started_by, start_at, ends_at) VALUES (?, ?, ?, ?)`, run.run_id, run.started_by, run.start_at, run.ends_at);
    return asRun(run);
  },

  current({ sql }: RoomStore, userId: string, now: number): SyncRun | null {
    inRoom(sql, userId);
    const live = latest(sql);
    return live && now < live.ends_at ? asRun(live) : null;
  },

  /** Stores the caller's beats for a run that is live or just ended. A beat sent twice is stored once. */
  write({ sql }: RoomStore, userId: string, runId: string, beats: SyncBeat[], now: number): { stored: number } {
    inRoom(sql, userId);
    const run = sql.exec<RunRow>(`SELECT * FROM sync_runs WHERE run_id = ?`, runId).toArray()[0];
    if (!run || now > run.ends_at + SYNC_LOG_GRACE_MS) throw new Refused("no-sync-run", 409);
    if (beats.some((beat) => beat.beat >= SYNC_RUN_BEATS)) throw new Refused("bad-request");
    let stored = 0;
    for (const b of beats) {
      stored += sql.exec(
        `INSERT OR IGNORE INTO sync_log (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        runId, userId, b.beat, b.route, b.carrier, b.at, b.shown_at, b.clicked_at, b.offset_ms, b.spread_ms, b.rtt_ms, b.frame_ms,
      ).rowsWritten;
    }
    return { stored };
  },

  rows({ sql }: RoomStore, userId: string, runId: string): SyncRow[] {
    inRoom(sql, userId);
    return sql.exec<SyncRow>(`SELECT ${COLUMNS} FROM sync_log WHERE run_id = ? ORDER BY user_id, beat`, runId).toArray();
  },
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const finiteOrNull = (value: unknown) => value === null || finite(value);

/** The phone's beats, checked at the boundary. Any field the phone adds, such as a user id, is not read. */
function beatsIn(value: unknown): SyncBeat[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BEATS_PER_WRITE) throw new Refused("bad-request");
  return value.map((item) => {
    const b = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const ok =
      Number.isInteger(b.beat) && (b.beat as number) >= 0 && SYNC_ROUTES.includes(b.route as SyncRoute) &&
      typeof b.carrier === "string" && b.carrier.length <= MAX_CARRIER_CHARS && finite(b.at) && finiteOrNull(b.shown_at) && finiteOrNull(b.clicked_at) &&
      finite(b.offset_ms) && finiteOrNull(b.spread_ms) && finiteOrNull(b.rtt_ms) && finiteOrNull(b.frame_ms);
    if (!ok) throw new Refused("bad-request");
    return {
      beat: b.beat as number, route: b.route as SyncRoute, carrier: b.carrier as string, at: b.at as number,
      shown_at: b.shown_at as number | null, clicked_at: b.clicked_at as number | null, offset_ms: b.offset_ms as number,
      spread_ms: b.spread_ms as number | null, rtt_ms: b.rtt_ms as number | null, frame_ms: b.frame_ms as number | null,
    };
  });
}

const runIdIn = (value: unknown) => {
  if (typeof value !== "string" || !/^run_[A-Za-z0-9_-]{1,40}$/.test(value)) throw new Refused("bad-request");
  return value;
};

/** What the routes need of a band's Room. `worker/room.ts` provides it by calling `syncLogRoom` on its own store. */
export interface SyncRoom {
  syncStart(userId: string, now: number): Promise<SyncRun>;
  syncCurrent(userId: string, now: number): Promise<SyncRun | null>;
  syncWrite(userId: string, runId: string, beats: SyncBeat[], now: number): Promise<{ stored: number }>;
  syncRows(userId: string, runId: string): Promise<SyncRow[]>;
}

/** A Room refusal over RPC arrives as a plain error; this one is not in the shared table, so it gets its status back here. */
async function fromSyncRoom<T>(call: Promise<T>): Promise<T> {
  try {
    return await fromRoom(call);
  } catch (error) {
    if (error instanceof Error && !(error instanceof Refused) && (error.message === "no-sync-run" || error.message === "bad-request")) {
      throw new Refused(error.message, error.message === "no-sync-run" ? 409 : 400);
    }
    throw error;
  }
}

/** `POST /api/bands/sync/*`, for the Directory's `ROUTES`. `roomFor` is `roomOf` from `worker/room-members.ts`. */
export function syncLogRoutes(roomFor: (c: Context, bandId: string) => SyncRoom): Record<string, Route> {
  const at = (c: Context) => ({ room: roomFor(c, bandIdIn(c.body)), me: signedIn(c).user_id });
  return {
    async "POST /api/bands/sync/start"(c) {
      const { room, me } = at(c);
      return { body: { run: await fromSyncRoom(room.syncStart(me, c.now)) } };
    },
    async "POST /api/bands/sync/current"(c) {
      const { room, me } = at(c);
      return { body: { run: await fromSyncRoom(room.syncCurrent(me, c.now)) } };
    },
    async "POST /api/bands/sync/log"(c) {
      const runId = runIdIn(c.body.runId);
      const beats = beatsIn(c.body.beats);
      const { room, me } = at(c);
      return { body: await fromSyncRoom(room.syncWrite(me, runId, beats, c.now)) };
    },
    async "POST /api/bands/sync/rows"(c) {
      const runId = runIdIn(c.body.runId);
      const { room, me } = at(c);
      return { body: { rows: await fromSyncRoom(room.syncRows(me, runId)) } };
    },
  };
}
