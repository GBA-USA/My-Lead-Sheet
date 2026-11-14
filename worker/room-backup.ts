import { Refused } from "./refused";

/** Each account's own backup lives in one Room. The Worker derives this name from the session, never from the request. */
export const selfRoomId = (userId: string) => `self:${userId}`;

const KEY = /^leadSheets[A-Za-z]{1,40}(\.[A-Za-z0-9/_-]{1,130})?$/;
const KIND = /^[a-z-]{1,20}$/;
const MAX_BODY_CHARS = 4_000_000;
const MAX_VALUE_CHARS = 1_000_000;
const MAX_CHANGES = 500;

type Change = { key: string; kind: string; value: string | null; base: number };
type Row = { key: string; value: string | null; rev: number };

const revision = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

function parseChange(value: unknown): Change {
  const { key, kind, value: text, base } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const goodValue = text === null || (typeof text === "string" && text.length <= MAX_VALUE_CHARS);
  if (typeof key !== "string" || !KEY.test(key) || typeof kind !== "string" || !KIND.test(kind) || !goodValue || !revision(base)) throw new Refused("bad-request");
  return { key, kind, value: text as string | null, base: base as number };
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
 * The reply holds every row newer than `since` and the current row for every key sent.
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
      let rev = sql.exec<{ rev: number }>(`SELECT coalesce(max(rev), 0) AS rev FROM backup_items`).one().rev;
      for (const change of changes) {
        const row = current(change.key);
        if (row && (row.value === change.value || row.rev !== change.base)) continue;
        rev += 1;
        sql.exec(
          `INSERT INTO backup_items (key, kind, value, rev) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, value = excluded.value, rev = excluded.rev`,
          change.key,
          change.kind,
          change.value,
          rev,
        );
      }
      const rows = new Map(sql.exec<Row>(`SELECT key, value, rev FROM backup_items WHERE rev > ? ORDER BY rev`, since).toArray().map((row) => [row.key, row]));
      for (const change of changes) if (!rows.has(change.key)) rows.set(change.key, current(change.key));
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
