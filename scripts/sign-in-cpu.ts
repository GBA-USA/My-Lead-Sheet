import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const TRIES = 1000;
const WARM_UP = 200;

async function loadDirectory() {
  const result = await build({
    stdin: { contents: `export { handleAccountRequest, createAccountTables } from "./worker/directory-account.ts";`, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const dir = mkdtempSync(join(tmpdir(), "sign-in-cpu-"));
  const file = join(dir, "directory.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Durable Object storage over an in-memory node:sqlite database, with only what the account routes use. */
function memoryStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        const statement = db.prepare(query);
        const returnsRows = statement.columns().length > 0;
        const rows = returnsRows ? (statement.all(...(bindings as never[])) as Record<string, unknown>[]) : [];
        const rowsWritten = returnsRows ? (/^\s*select/i.test(query) ? 0 : rows.length) : Number(statement.run(...(bindings as never[])).changes);
        return { toArray: () => rows, one: () => rows[0], rowsWritten };
      },
    },
    transactionSync<T>(fn: () => T): T {
      db.exec("SAVEPOINT t");
      try {
        const result = fn();
        db.exec("RELEASE t");
        return result;
      } catch (error) {
        db.exec("ROLLBACK TO t");
        db.exec("RELEASE t");
        throw error;
      }
    },
    setAlarm: async () => {},
  };
}

/**
 * Process CPU per password sign-in through the real Directory handler in V8, without workerd's hops.
 * It counts every thread and building each Request, so it is an upper bound on the handler's own CPU.
 */
export async function signInCpuMs(pepper: string): Promise<Record<string, number>> {
  const directory = await loadDirectory();
  const storage = memoryStorage();
  directory.createAccountTables(storage.sql);
  const env = { APP_ORIGIN: "https://app.example.test", SESSION_SECRET: "cpu-only-session-secret-0123456789abcdef", PASSWORD_PEPPER: pepper };
  const salt = Buffer.alloc(16, 5).toString("base64url");
  const key = Buffer.alloc(32, 6).toString("base64url");
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    directory.handleAccountRequest(
      new Request(`https://app.example.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
      storage,
      env,
    ) as Promise<Response>;

  if ((await post("/api/auth/password/create", { name: "Cpu", handle: "cpucheck", salt, key })).status !== 200) throw new Error("sign-in-cpu: making the account failed");
  for (let n = 0; n < WARM_UP; n += 1) await post("/api/auth/password/sign-in", { handle: "cpucheck", key });

  const cases: [string, (n: number) => Promise<Response>, number][] = [
    ["right password", () => post("/api/auth/password/sign-in", { handle: "cpucheck", key }), 200],
    ["right password with an address", () => post("/api/auth/password/sign-in", { handle: "cpucheck", key }, { "cf-connecting-ip": "198.51.100.7" }), 200],
    ["unknown @name, records misses", (n) => post("/api/auth/password/sign-in", { handle: `nobody${n}`, key }, { "cf-connecting-ip": `203.0.113.${n % 250}` }), 401],
  ];
  const perTry: Record<string, number> = {};
  for (const [label, attempt, status] of cases) {
    const start = process.cpuUsage();
    for (let n = 0; n < TRIES; n += 1) {
      const reply = await attempt(n);
      if (reply.status !== status) throw new Error(`sign-in-cpu: ${label} answered ${reply.status}, not ${status}`);
    }
    const used = process.cpuUsage(start);
    perTry[label] = (used.user + used.system) / 1000 / TRIES;
  }
  return perTry;
}
