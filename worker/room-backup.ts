import { MAX_VALUE_CHARS, backupKindOf, songIdOf, validBackupKey } from "../src/backup-keys";
import { Refused } from "./refused";

/** Each account's own backup lives in one Room. The Worker derives this name from the session, never from the request. */
export const selfRoomId = (userId: string) => `self:${userId}`;

/** The owner's caps on one account's backup. A sync that would pass either gets 413. */
export const MAX_BACKUP_ROWS = 5_000;
export const MAX_BACKUP_BYTES = 5_000_000;

const MAX_BODY_CHARS = 4_000_000;
const MAX_CHANGES = 500;

type Change = { key: string; kind: string; value: string | null; base: number };
type Row = { key: string; value: string | null; rev: number };

const revision = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

function parseChange(value: unknown): Change {
  const { key, kind, value: text, base } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const goodValue = text === null || (typeof text === "string" && text.length <= MAX_VALUE_CHARS);
  if (typeof key !== "string" || !validBackupKey(key) || kind !== backupKindOf(key) || !goodValue || !revision(base)) throw new Refused("bad-request");
  return { key, kind: kind as string, value: text as string | null, base: base as number };
}

async function readRequest(request: Request): Promise<{ since: number; changes: Change[] }> {
  if (request.method !== "POST") throw new Refused("not-found", 404);
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw new Refused("too-large", 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refused("bad-request");
  }
  if (!revision(body?.since) || !Array.isArray(body.changes) || body.changes.length > MAX_CHANGES) throw new Refused("bad-request");
  const changes = body.changes.map(parseChange);
  if (new Set(changes.map((change) => change.key)).size !== changes.length) throw new Refused("bad-request");
  return { since: body.since as number, changes };
}

/**
 * One sync round for a self room. A change is stored when its `base` is the key's current rev, or when it matches what
 * is stored already. Otherwise the stored row comes back unchanged, and the phone merges it and sends the result.
 * When a song's row is refused, so are that song's settings in the same request: the phone moves its song to a new id,
 * and the settings go with it. The reply holds every row newer than `since` and the current row for every key sent.
 */
export async function handleBackup(request: Request, storage: DurableObjectStorage, roomName: string | undefined, userId: string): Promise<Response> {
  try {
    if (roomName !== selfRoomId(userId)) throw new Refused("not-your-backup", 403);
    const { since, changes } = await readRequest(request);
    const sql = storage.sql;
    const reply = storage.transactionSync(() => {
      sql.exec(`CREATE TABLE IF NOT EXISTS backup_items (key TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT, rev INTEGER NOT NULL)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS backup_items_by_rev ON backup_items (rev)`);
      const current = (key: string) => sql.exec<Row>(`SELECT key, value, rev FROM backup_items WHERE key = ?`, key).toArray()[0];
      const size = () =>
        sql.exec<{ n: number; bytes: number }>(`SELECT count(*) AS n, coalesce(sum(length(CAST(key AS BLOB)) + coalesce(length(CAST(value AS BLOB)), 0)), 0) AS bytes FROM backup_items`).one();
      const before = changes.length > 0 ? size() : null;
      let rev = sql.exec<{ rev: number }>(`SELECT coalesce(max(rev), 0) AS rev FROM backup_items`).one().rev;
      const stale = (change: Change, row = current(change.key)) => !!row && row.value !== change.value && row.rev !== change.base;
      const refusedSongs = new Set(changes.filter((change) => change.kind === "song" && stale(change)).map((change) => songIdOf(change.key)));
      for (const change of changes) {
        const row = current(change.key);
        const song = change.kind === "song" ? undefined : songIdOf(change.key);
        if (row?.value === change.value || stale(change, row) || (song !== undefined && refusedSongs.has(song))) continue;
        rev += 1;
        sql.exec(
          `INSERT INTO backup_items (key, kind, value, rev) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, value = excluded.value, rev = excluded.rev`,
          change.key,
          change.kind,
          change.value,
          rev,
        );
      }
      const after = before && size();
      const grewPastCap = before && after && ((after.n > MAX_BACKUP_ROWS && after.n > before.n) || (after.bytes > MAX_BACKUP_BYTES && after.bytes > before.bytes));
      if (grewPastCap) throw new Refused("backup-full", 413);
      const rows = new Map(sql.exec<Row>(`SELECT key, value, rev FROM backup_items WHERE rev > ? ORDER BY rev`, since).toArray().map((row) => [row.key, row]));
      for (const change of changes) if (!rows.has(change.key)) rows.set(change.key, current(change.key) ?? { key: change.key, value: null, rev: 0 });
      const counts = Object.fromEntries(
        sql.exec<{ kind: string; n: number }>(`SELECT kind, count(*) AS n FROM backup_items WHERE value IS NOT NULL GROUP BY kind`).toArray().map((row) => [row.kind, row.n]),
      );
      return { rev, rows: [...rows.values()], counts };
    });
    return Response.json(reply, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Refused) return Response.json({ error: error.reason }, { status: error.status });
    throw error;
  }
}
