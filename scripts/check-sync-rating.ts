/**
 * check:sync-rating (C18, C18b). The rating table keeps its pure cases. C18b adds the saved history, Test now, Test with
 * a bandmate and the rating column: the numbered cases 1 to 6 are the pass conditions in FABLE-PLAN C18b. The Chrome
 * cases run the real app against the real Worker (set CHROME to a Chrome or Edge; `tsc -p worker` runs first).
 */
import is from "node:assert/strict";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
type RouteSummary = import("../src/sync-rating.ts").RouteSummary;
type Route = import("../src/sync-rating.ts").Route;

/** Bundles one file of src/ so it loads in Node whatever its imports look like (the app's imports have no extensions). */
async function loadSrc(file: string): Promise<any> {
  const bundled = await build({ entryPoints: [join(root, "src", file)], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
  const out = join(mkdtempSync(join(tmpdir(), "check-sync-rating-")), file.replace(/\.tsx?$/, ".mjs"));
  writeFileSync(out, bundled.outputFiles[0].text);
  return import(pathToFileURL(out).href);
}
const rating = (await loadSrc("sync-rating.ts")) as typeof import("../src/sync-rating.ts");
const { rateRoute, autoRoute, rowText, applyTestNow } = rating;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}:`, e);
    process.exit(1);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

test("rateRoute: spread 1.5 p99 80 -> Best", () => {
  const s: RouteSummary = { spreadMs: 1.5, p99Ms: 80, ageDays: 1, tries: [true] };
  assertEqual(rateRoute(s), "Best", "rating");
});

test("rateRoute: spread 4 p99 200 -> Better", () => {
  const s: RouteSummary = { spreadMs: 4, p99Ms: 200, ageDays: 1, tries: [true] };
  assertEqual(rateRoute(s), "Better", "rating");
});

test("rateRoute: spread 7.5 p99 300 -> Good", () => {
  const s: RouteSummary = { spreadMs: 7.5, p99Ms: 300, ageDays: 1, tries: [true] };
  assertEqual(rateRoute(s), "Good", "rating");
});

test("rateRoute: spread 9 p99 100 -> Not steady", () => {
  const s: RouteSummary = { spreadMs: 9, p99Ms: 100, ageDays: 1, tries: [true] };
  assertEqual(rateRoute(s), "Not steady", "rating");
});

test("rateRoute: spread 1.5 p99 80 lateRate 0.02 -> Not steady", () => {
  const s: RouteSummary = { spreadMs: 1.5, p99Ms: 80, lateRate: 0.02, ageDays: 1, tries: [true] };
  assertEqual(rateRoute(s), "Not steady", "rating");
});

test("rateRoute: spread 2 p99 400 -> Not steady", () => {
  const s: RouteSummary = { spreadMs: 2, p99Ms: 400, ageDays: 1, tries: [true] };
  assertEqual(rateRoute(s), "Not steady", "rating");
});

test("rateRoute: undefined -> Not tried yet", () => {
  assertEqual(rateRoute(undefined), "Not tried yet", "rating");
});

test("rateRoute: tries [] -> Not tried yet", () => {
  const s: RouteSummary = { tries: [] };
  assertEqual(rateRoute(s), "Not tried yet", "rating");
});

test("rateRoute: ageDays 31 -> Not tried yet", () => {
  const s: RouteSummary = { spreadMs: 1.5, p99Ms: 80, ageDays: 31, tries: [true] };
  assertEqual(rateRoute(s), "Not tried yet", "rating");
});

test("rateRoute: tries [true, false, false] -> Can't connect here", () => {
  const s: RouteSummary = { spreadMs: 1.5, p99Ms: 80, ageDays: 1, tries: [true, false, false] };
  assertEqual(rateRoute(s), "Can't connect here", "rating");
});

test("rateRoute: tries [false, true] with 1.5 p99 80 -> Best", () => {
  const s: RouteSummary = { spreadMs: 1.5, p99Ms: 80, ageDays: 1, tries: [false, true] };
  assertEqual(rateRoute(s), "Best", "rating");
});

test("autoRoute: picks wifi when wifi Best", () => {
  const m: Partial<Record<Route, RouteSummary>> = {
    wifi: { spreadMs: 1.5, p99Ms: 80, ageDays: 1, tries: [true] },
  };
  assertEqual(autoRoute(m), "wifi", "route");
});

test("autoRoute: picks internet when wifi Can't connect here and internet Better", () => {
  const m: Partial<Record<Route, RouteSummary>> = {
    wifi: { spreadMs: 1.5, p99Ms: 80, ageDays: 1, tries: [true, false, false] },
    internet: { spreadMs: 4, p99Ms: 200, ageDays: 1, tries: [true] },
  };
  assertEqual(autoRoute(m), "internet", "route");
});

test("autoRoute: null when all missing", () => {
  const m: Partial<Record<Route, RouteSummary>> = {};
  assertEqual(autoRoute(m), null, "route");
});

test("rowText: auto -> Best · Wi-Fi link", () => {
  const m: Partial<Record<Route, RouteSummary>> = {
    wifi: { spreadMs: 1.5, p99Ms: 80, ageDays: 1, tries: [true] },
  };
  assertEqual(rowText("auto", m), "Best · Wi-Fi link", "text");
});

test("rowText: wifi with empty map -> Not tried yet · test with a bandmate", () => {
  const m: Partial<Record<Route, RouteSummary>> = {};
  assertEqual(rowText("wifi", m), "Not tried yet · test with a bandmate", "text");
});

test("applyTestNow: fills server and internet, wifi stays absent", () => {
  const m: Partial<Record<Route, RouteSummary>> = {};
  const server: RouteSummary = { spreadMs: 2, p99Ms: 150, ageDays: 1, tries: [true] };
  const internet: RouteSummary = { spreadMs: 3, p99Ms: 180, ageDays: 1, tries: [true] };
  const result = applyTestNow(m, server, internet);
  assert(result.wifi === undefined, "wifi should be absent");
  assertEqual(result.server?.source, "Test now", "server source");
  assertEqual(result.internet?.source, "Test now", "internet source");
});

test("applyTestNow: rowText wifi still Not tried yet · test with a bandmate", () => {
  const m: Partial<Record<Route, RouteSummary>> = {};
  const server: RouteSummary = { spreadMs: 2, p99Ms: 150, ageDays: 1, tries: [true] };
  const internet: RouteSummary = { spreadMs: 3, p99Ms: 180, ageDays: 1, tries: [true] };
  const result = applyTestNow(m, server, internet);
  assertEqual(rowText("wifi", result), "Not tried yet · test with a bandmate", "text");
});

test("applyTestNow: does not mutate input", () => {
  const m: Partial<Record<Route, RouteSummary>> = {};
  const server: RouteSummary = { spreadMs: 2, p99Ms: 150, ageDays: 1, tries: [true] };
  const internet: RouteSummary = { spreadMs: 3, p99Ms: 180, ageDays: 1, tries: [true] };
  applyTestNow(m, server, internet);
  assert(m.server === undefined, "input should not be mutated");
  assert(m.internet === undefined, "input should not be mutated");
});


// ======================================================================================================================
// C18b: history, Test now, Test with a bandmate, the rating column. Cases 1 to 6 are the numbered pass conditions.
// ======================================================================================================================

let failures = 0;
async function check(name: string, run: () => Promise<void> | void) {
  try {
    await Promise.race([Promise.resolve().then(run), new Promise((_, no) => setTimeout(() => no(new Error("timed out after 150 s")), 150_000))]);
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${String((error as Error)?.stack ?? error).split("\n").slice(0, 6).join("\n     ")}`);
  }
}

const js = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const RATED = ["Best", "Better", "Good", "Not steady"];

type History = typeof import("../src/sync-history.ts");
const history = (await loadSrc("sync-history.ts").catch((error: Error) => error)) as History | Error;
const needHistory = (): History => {
  if (history instanceof Error) throw new Error(`src/sync-history.ts did not load: ${history.message.split("\n")[0]}`);
  return history;
};

/** An in-memory stand-in for the phone's `syncHistory` store: the same keys and values IndexedDB holds. */
function memoryStore() {
  const held = new Map<string, unknown>();
  return {
    held,
    get: async (key: string) => held.get(key),
    put: async (key: string, value: unknown) => void held.set(key, structuredClone(value)),
    remove: async (key: string) => void held.delete(key),
    entries: async () => [...held].map(([key, value]) => [key, structuredClone(value)] as [string, unknown]),
  };
}
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0).getTime();
const NOW = at(2026, 11, 22); // a Sunday
const GOOD = { spreadMs: 1.5, p99Ms: 80, lateRate: 0, tries: [true] };
const BAD = { spreadMs: 9, p99Ms: 100, lateRate: 0, tries: [true] };

// ------------------------------------------------------------------------------------------ 1. history (pure)

await check("1a. a gig's per-route summary is saved under route/day with its source, and nothing else", async () => {
  const h = needHistory();
  assert(h.dayOf(at(2026, 11, 20, 23)) === "2026-11-20", "the day is the phone's own calendar day");
  assert(h.keyOf("wifi", "2026-11-20") === "wifi/2026-11-20", "key is <route>/<day>");
  const store = memoryStore();
  await h.saveRun(store, "server", { ...GOOD, source: "gig" }, at(2026, 11, 20));
  const saved = store.held.get("server/2026-11-20") as Record<string, unknown>;
  is.deepEqual(saved, { ...GOOD, day: "2026-11-20", source: "gig" });
  is.deepEqual([...store.held.keys()], ["server/2026-11-20"], "one key");
});

await check("1b. a second run on the same day replaces its numbers and adds its tries", async () => {
  const h = needHistory();
  const store = memoryStore();
  await h.saveRun(store, "wifi", { ...BAD, tries: [true], source: "gig" }, at(2026, 11, 20, 9));
  await h.saveRun(store, "wifi", { ...GOOD, tries: [true], source: "bandmate" }, at(2026, 11, 20, 21));
  const saved = store.held.get("wifi/2026-11-20") as Record<string, unknown>;
  is.equal(saved.spreadMs, 1.5, "the newer numbers");
  is.deepEqual(saved.tries, [true, true], "both tries");
  is.equal(saved.source, "bandmate", "the newer source");
  is.equal(store.held.size, 1);
});

await check("1c. only the last 30 days are kept", async () => {
  const h = needHistory();
  const store = memoryStore();
  for (const daysAgo of [45, 31, 29, 10, 0]) await h.saveRun(store, "server", { ...GOOD, source: "gig" }, NOW - daysAgo * 86_400_000);
  const days = [...store.held.keys()].map((key) => key.split("/")[1]).sort();
  is.equal(days.length, 3, `kept ${days.join(", ")}`);
  is.ok(![...store.held.keys()].some((key) => key.endsWith("2026-10-08") || key.endsWith("2026-09-22")), "the 31 and 45 day old ones are gone");
});

await check("1d. the newest days count most", async () => {
  const h = needHistory();
  const goodNow = memoryStore();
  await h.saveRun(goodNow, "server", { ...BAD, source: "gig" }, NOW - 20 * 86_400_000);
  await h.saveRun(goodNow, "server", { ...GOOD, source: "gig" }, NOW - 1 * 86_400_000);
  const newGood = (await h.loadSummaries(goodNow, NOW)).server!;
  is.ok(newGood.spreadMs! < 3.5, `a recent Best outweighs an old 9 ms (${newGood.spreadMs})`);
  is.ok(newGood.spreadMs! > 1.5, "the old day still counts a little");
  const badNow = memoryStore();
  await h.saveRun(badNow, "server", { ...GOOD, source: "gig" }, NOW - 20 * 86_400_000);
  await h.saveRun(badNow, "server", { ...BAD, source: "gig" }, NOW - 1 * 86_400_000);
  const newBad = (await h.loadSummaries(badNow, NOW)).server!;
  is.ok(newBad.spreadMs! > 7, `a recent 9 ms outweighs an old Best (${newBad.spreadMs})`);
  is.equal(rateRoute(newBad), "Not steady");
});

await check("1e. a summary read back carries its age and its source in words, and routes with no history are absent", async () => {
  const h = needHistory();
  const store = memoryStore();
  await h.saveRun(store, "server", { ...GOOD, source: "gig" }, at(2026, 11, 20));
  const read = await h.loadSummaries(store, NOW);
  is.deepEqual(Object.keys(read), ["server"]);
  is.equal(read.server!.ageDays, 2);
  is.equal(read.server!.source, "tested at Friday's gig");
  is.equal(rateRoute(read.server), "Best");
  is.deepEqual(await h.loadSummaries(memoryStore(), NOW), {}, "no history reads as nothing, so every row says Not tried yet");
});

await check("1f. two failed tries on different days read as Can't connect here, and a later good one clears it", async () => {
  const h = needHistory();
  const store = memoryStore();
  await h.saveRun(store, "internet", { tries: [false], source: "test-now" }, NOW - 3 * 86_400_000);
  is.equal(rateRoute((await h.loadSummaries(store, NOW)).internet), "Not tried yet", "one failure is not yet 'Can't connect here'");
  await h.saveRun(store, "internet", { tries: [false], source: "test-now" }, NOW - 1 * 86_400_000);
  is.equal(rateRoute((await h.loadSummaries(store, NOW)).internet), "Can't connect here");
  await h.saveRun(store, "internet", { ...GOOD, source: "test-now" }, NOW);
  is.equal(rateRoute((await h.loadSummaries(store, NOW)).internet), "Best");
});

// ------------------------------------------------------------------------------------------ 5. age and source words

await check("5a. each rating shows its age and source in words", () => {
  const h = needHistory();
  const gig = (daysAgo: number) => h.testedWords("gig", h.dayOf(NOW - daysAgo * 86_400_000), NOW);
  is.equal(gig(2), "tested at Friday's gig", "inside a week the weekday says the age");
  is.equal(gig(0), "tested at today's gig");
  is.equal(gig(12), "tested at the gig on Nov 10", "older than a week it is the date");
  is.equal(h.testedWords("test-now", h.dayOf(NOW), NOW), "tested today");
  is.equal(h.testedWords("test-now", h.dayOf(NOW - 2 * 86_400_000), NOW), "tested Friday");
  is.equal(h.testedWords("test-now", h.dayOf(NOW - 12 * 86_400_000), NOW), "tested Nov 10");
  is.equal(h.testedWords("bandmate", h.dayOf(NOW), NOW), "tested with a bandmate today");
  is.equal(h.testedWords("bandmate", h.dayOf(NOW - 12 * 86_400_000), NOW), "tested with a bandmate on Nov 10");
});

await check("5b. rowText for a saved summary reads 'Best · tested at Friday's gig'", async () => {
  const h = needHistory();
  const store = memoryStore();
  await h.saveRun(store, "server", { ...GOOD, source: "gig" }, at(2026, 11, 20));
  is.equal(rowText("server", await h.loadSummaries(store, NOW)), "Best · tested at Friday's gig");
});

// ------------------------------------------------------------------------------------------ 3, 4. measuring (pure parts)

await check("3a. round trips become a spread and a p99, and only the last 32 count", () => {
  const h = needHistory();
  const run = h.summarizeRtts([10, 12, 11, 10.5, 10, 11, 12, 40, 10, 11]);
  is.equal(run.spreadMs, 1, "range of the 8 fastest one-way times");
  is.equal(run.p99Ms, 20, "p99 one-way is half the slowest round trip");
  is.equal(run.lateRate, 0);
  const many = h.summarizeRtts([...Array(40).fill(500), ...Array(32).fill(10)]);
  is.equal(many.p99Ms, 5, "the first 40 are out of the window");
});

await check("4a. pings between two phones become the clock spread and a p99", () => {
  const h = needHistory();
  const pings = Array.from({ length: 16 }, (_, i) => ({ t0: 1_000 + i * 100, t1: 1_010 + i * 100, band: 1_005 + i * 100 + 7_000 }));
  const run = h.measureFromPings(pings as never);
  is.ok(run.spreadMs <= 2, `steady pings give a small spread (${run.spreadMs})`);
  is.equal(run.p99Ms, 5);
});

await check("3b. the test seams read only stun urls, a test length and a timeout from the address", () => {
  const h = needHistory();
  is.deepEqual(h.testOverrides("?stun=stun:127.0.0.1:3478&syncTestMs=1500&syncTimeoutMs=2000"), { stun: ["stun:127.0.0.1:3478"], testMs: 1500, timeoutMs: 2000 });
  is.deepEqual(h.testOverrides("?stun=turn:relay.example:3478"), {}, "a TURN url never reaches an ICE config");
  is.deepEqual(h.testOverrides("?syncTestMs=1"), { testMs: 500 }, "too short is lifted");
  is.deepEqual(h.testOverrides(""), {});
  is.equal(h.TEST_NOW_MS, 20_000);
  is.equal(h.BANDMATE_WAIT_MS, 30_000);
});

// ------------------------------------------------------------------------------------------ 2, 6. the tables and the data

await check("2a. the rating table uses the shared route words and names three routes", () => {
  is.ok(!("ROUTE_WORDS" in rating), "sync-rating.ts no longer keeps its own ROUTE_WORDS");
  is.equal(rowText("auto", { server: { ...GOOD, ageDays: 1 } }), "Best · Through the server");
});

await check("6a. a rating is per phone and route: no network name is read anywhere", () => {
  const forbidden = /navigator\.connection|NetworkInformation|\bssid\b|effectiveType|\bbssid\b|getNetworkName|networkName/i;
  for (const file of ["src/sync-rating.ts", "src/sync-history.ts", "src/connection-setting.tsx", "src/sync-bandmate.tsx"]) {
    is.ok(!forbidden.test(readFileSync(join(root, file), "utf8")), `${file} reads no network name`);
  }
});

await check("6b. the data list names the sync history as phone data with no venue or network in it", async () => {
  const { DATA_KINDS } = (await loadSrc("data-kinds.ts")) as typeof import("../src/data-kinds.ts");
  const kind = DATA_KINDS.find((each) => each.key === "syncHistory");
  is.ok(kind, "syncHistory is listed");
  is.equal(kind!.place, "phone");
  is.ok(!/venue name|network name/i.test(kind!.what) || /not/i.test(kind!.what), "it says what it keeps in plain words");
});

// ------------------------------------------------------------------------------------------ the Worker and two phones

const { startApi } = await import("./api-session.ts");
const { appPage, PASSWORD_PEPPER, passwordPlayer, settle } = await import("./app-page.ts");
const { openSite } = await import("./chrome.ts");
type Site = import("./chrome.ts").Site;
type Player = Awaited<ReturnType<typeof passwordPlayer>>;

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((net) => net?.family === "IPv4" && !net.internal)?.address;

/** A STUN binding responder (RFC 5389): answers each request with the sender's address, as a free public STUN server does. */
async function startStun() {
  const socket = createSocket("udp4");
  const stats = { answered: 0 };
  socket.on("message", (message, from) => {
    if (message.length < 20 || message.readUInt16BE(0) !== 0x0001 || from.family !== "IPv4") return;
    const attribute = Buffer.alloc(12);
    attribute.writeUInt16BE(0x0020, 0);
    attribute.writeUInt16BE(8, 2);
    attribute.writeUInt8(1, 5);
    attribute.writeUInt16BE(from.port ^ 0x2112, 6);
    from.address.split(".").forEach((part, i) => attribute.writeUInt8(Number(part) ^ [0x21, 0x12, 0xa4, 0x42][i], 8 + i));
    const head = Buffer.alloc(20);
    head.writeUInt16BE(0x0101, 0);
    head.writeUInt16BE(attribute.length, 2);
    message.copy(head, 4, 4, 20);
    socket.send(Buffer.concat([head, attribute]), from.port, from.address);
    stats.answered += 1;
  });
  await new Promise<void>((done) => socket.bind(0, "0.0.0.0", done));
  return { url: `stun:${lanAddress}:${socket.address().port}`, stats, close: () => socket.close() };
}

/** Sends a phone's requests and sockets to the Worker with the app's own Origin, so a second tab on another port is let in. */
function originProxy(target: string, appOrigin: string) {
  const to = new URL(target);
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const headers = Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0] !== "host"));
    if (headers.origin) headers.origin = appOrigin;
    const reply = await fetch(new URL(request.url ?? "/", target), { method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual" });
    const location = reply.headers.get("location");
    response.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json", "set-cookie": reply.headers.getSetCookie(), ...(location ? { location } : {}) });
    response.end(Buffer.from(await reply.arrayBuffer()));
  });
  server.on("upgrade", (request, socket, head) => {
    const upstream = netConnect(Number(to.port), to.hostname, () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const name = request.rawHeaders[i];
        lines.push(`${name}: ${name.toLowerCase() === "host" ? to.host : name.toLowerCase() === "origin" ? appOrigin : request.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  return new Promise<{ base: string; close: () => void }>((done) => server.listen(0, "127.0.0.1", () => done({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })));
}

const stun = await startStun();
const sites: Site[] = [];
const closers: Array<() => unknown> = [];
let apiBase = "";
let proxyBase = "";
let origin = "";

try {
  await check("0. the machine has an address for host candidates", () => is.ok(lanAddress, "no non-loopback IPv4 address"));
  const siteA = await openSite(root, "check-sync-rating-a", () => apiBase).catch((error: Error) => error);
  if (siteA instanceof Error) throw new Error(`Chrome would not start (set CHROME): ${siteA.message.split("\n")[0]}`);
  sites.push(siteA);
  origin = siteA.origin;
  const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
  apiBase = base;
  closers.push(() => worker.dispose());
  const proxy = await originProxy(base, origin);
  proxyBase = proxy.base;
  closers.push(proxy.close);
  const siteB = await openSite(root, "check-sync-rating-b", () => proxyBase);
  sites.push(siteB);

  const lee = await passwordPlayer(base, origin, "Lee Leader", "leeleader");
  const fran = await passwordPlayer(base, origin, "Fran Follow", "franfollow");

  // ---------------------------------------------------------------------------------------- 4. the code (Worker only)
  let syncCode = "";
  await check("4b. a sync-check code is made for a signed-in phone, opens to one room name, and shows no person", async () => {
    const anon = new (await import("./api-session.ts")).Phone(base);
    is.equal((await anon.call("/api/codes", { kind: "sync-check" }, { origin })).status, 401, "a signed-out phone is refused");
    const made = await lee.call("/api/codes", { kind: "sync-check" });
    is.equal(made.status, 200, js(made.body));
    is.equal(made.body.kind, "sync-check");
    syncCode = made.body.code;
    is.match(syncCode, /^sync-check\./);
    is.equal((await anon.call("/api/codes/sync-check", { code: syncCode }, { origin })).status, 401, "a signed-out phone cannot open it either");
    const opened = await fran.call("/api/codes/sync-check", { code: syncCode });
    is.equal(opened.status, 200, js(opened.body));
    is.deepEqual(Object.keys(opened.body), ["room"], "the reply is a room name and nothing about a person");
    is.match(opened.body.room, /^sync-[A-Za-z0-9_-]{16}$/);
    is.equal((await lee.call("/api/codes/sync-check", { code: syncCode })).body.room, opened.body.room, "both phones get the same room");
  });

  await check("4c. a sync-check code never makes a friend request, and a friend code never starts a measurement", async () => {
    const asked = await fran.call("/api/friends/add-by-code", { code: syncCode });
    is.equal(asked.body.error, "not-a-friend-code", js(asked.body));
    is.equal((await fran.call("/api/friends/code", { code: syncCode })).body.error, "not-a-friend-code");
    for (const phone of [lee, fran]) {
      const lists = (await phone.call("/api/friends")).body;
      is.deepEqual([lists.friends, lists.requests], [[], []], `${phone.name} has no friend or request`);
    }
    const friendCode = (await lee.call("/api/codes", { kind: "friend-now" })).body.code;
    is.equal((await fran.call("/api/codes/sync-check", { code: friendCode })).body.error, "not-a-sync-code");
  });

  await check("4d. a stopped or made-up sync-check code is refused kindly, with no name in the reply", async () => {
    const own = (await lee.call("/api/codes", { kind: "sync-check" })).body.code;
    is.equal((await lee.call("/api/codes/stop", { code: own })).status, 200);
    const stopped = await fran.call("/api/codes/sync-check", { code: own });
    is.equal(stopped.body.error, "code-stopped");
    const made = await fran.call("/api/codes/sync-check", { code: "sync-check.AAAAAAAAAAAAAAAA.1999999999999.AAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    is.equal(made.body.error, "bad-code");
    for (const body of [stopped.body, made.body]) is.ok(!/Lee|leeleader/i.test(js(body)), "no name in a refusal");
  });

  // ---------------------------------------------------------------------------------------- the Settings screen, one phone
  const phoneA = { site: siteA, app: await appPage(siteA), name: "A" };
  const phoneB = { site: siteB, app: await appPage(siteB), name: "B" };
  type Phone = typeof phoneA;
  const cookieFor = (player: Player) => ({ name: player.cookie.slice(0, player.cookie.indexOf("=")), value: player.cookie.slice(player.cookie.indexOf("=") + 1) });
  const signIn = async (phone: Phone, player: Player) => {
    await phone.site.send("Network.setCookie", { ...cookieFor(player), url: phone.site.origin, httpOnly: true, secure: true, sameSite: "Lax" });
  };
  const goSettings = async (phone: Phone, params: Record<string, string> = {}) => {
    const all = { stun: stun.url, syncTestMs: "2500", syncTimeoutMs: "2500", ...params };
    await phone.site.send("Page.navigate", { url: `${phone.site.origin}/?${new URLSearchParams(all)}#/settings` });
    await phone.app.until(`!!document.querySelector(".settings") && [...document.querySelectorAll("button.settings-row")].some((b) => b.textContent.startsWith("Connection"))`, "Settings with the Connection row", 20_000);
  };
  const openConnection = async (phone: Phone) => {
    await phone.site.evaluate(`[...document.querySelectorAll("button.settings-row")].find((b) => b.textContent.startsWith("Connection")).click()`);
    await phone.app.until(`!!document.querySelector("[role=dialog] .gig-plan-route")`, "the Connection sheet");
  };
  type Row = { name: string; word: string; age: string };
  const rows = (phone: Phone) =>
    phone.site.evaluate<Row[]>(
      `[...document.querySelectorAll("[role=dialog] .gig-plan-route label")].map((l) => ({ name: l.querySelector("[data-slot=name]").textContent, word: l.querySelector("[data-word]")?.textContent ?? "", age: l.querySelector("[data-age]")?.textContent ?? "" }))`,
    );
  const rowOf = async (phone: Phone, name: string) => (await rows(phone)).find((row) => row.name === name)!;
  const store = (phone: Phone) =>
    phone.site.evaluate<Array<[string, Record<string, unknown>]> | null>(`new Promise((done) => {
      const open = indexedDB.open("mls-phone");
      open.onerror = () => done(null);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("syncHistory")) { db.close(); return done(null); }
        const tx = db.transaction("syncHistory");
        const keys = tx.objectStore("syncHistory").getAllKeys();
        const values = tx.objectStore("syncHistory").getAll();
        tx.oncomplete = () => { db.close(); done(keys.result.map((key, i) => [key, values.result[i]])); };
      };
    })`);
  const seed = (phone: Phone, entries: Array<[string, unknown]>) =>
    phone.site.evaluate(`new Promise((done, fail) => {
      const open = indexedDB.open("mls-phone");
      open.onerror = () => fail(open.error);
      open.onsuccess = () => {
        const db = open.result;
        try {
          const tx = db.transaction("syncHistory", "readwrite");
          for (const [key, value] of ${js(entries)}) tx.objectStore("syncHistory").put(value, key);
          tx.oncomplete = () => { db.close(); done(true); };
        } catch (error) { db.close(); fail(error); }
      };
    })`);
  const clearHistory = (phone: Phone) =>
    phone.site.evaluate(`new Promise((done) => { const open = indexedDB.open("mls-phone"); open.onsuccess = () => { const tx = open.result.transaction("syncHistory", "readwrite"); tx.objectStore("syncHistory").clear(); tx.oncomplete = () => { open.result.close(); done(true); }; }; })`);
  const local = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const DAY = 86_400_000;
  const status = (phone: Phone, slot: string) => phone.site.evaluate<string>(`document.querySelector("[data-slot=${slot}]")?.textContent ?? ""`);

  await check("2b. Settings > Connection shows a rating on all four rows where today there is none", async () => {
    await goSettings(phoneA);
    await openConnection(phoneA);
    const read = await rows(phoneA);
    is.deepEqual(read.map((row) => row.name), ["Auto", "Wi-Fi link", "Over the internet", "Server"]);
    for (const row of read) is.ok(row.word, `${row.name} shows a rating`);
    is.deepEqual(read.map((row) => row.word), ["Not tried yet", "Not tried yet", "Not tried yet", "Not tried yet"], "no history gives Not tried yet on every row");
    is.equal((await rowOf(phoneA, "Wi-Fi link")).age, "test with a bandmate");
  });

  await check("2c. each row reads this phone's saved history: a rating, its age and its source", async () => {
    await seed(phoneA, [
      [`server/${local(Date.now() - 2 * DAY)}`, { ...GOOD, day: local(Date.now() - 2 * DAY), source: "gig" }],
      [`wifi/${local(Date.now() - 5 * DAY)}`, { tries: [false], day: local(Date.now() - 5 * DAY), source: "gig" }],
      [`wifi/${local(Date.now() - 3 * DAY)}`, { tries: [false], day: local(Date.now() - 3 * DAY), source: "bandmate" }],
    ]);
    await goSettings(phoneA);
    await openConnection(phoneA);
    const weekday = new Date(Date.now() - 2 * DAY).toLocaleDateString("en-US", { weekday: "long" });
    is.deepEqual(await rowOf(phoneA, "Server"), { name: "Server", word: "Best", age: `tested at ${weekday}'s gig` });
    is.equal((await rowOf(phoneA, "Wi-Fi link")).word, "Can't connect here");
    is.equal((await rowOf(phoneA, "Over the internet")).word, "Not tried yet");
    const auto = await rowOf(phoneA, "Auto");
    is.equal(auto.word, "Best");
    is.ok(auto.age.includes("Through the server"), `Auto names the route it would use (${auto.age})`);
    await clearHistory(phoneA);
  });

  await check("2d. with history on every row, each row keeps its name and line readable at 360 and 390 wide", async () => {
    type Box = { name: string; nameWidth: number; lineWidth: number; height: number; ratingFits: boolean };
    const boxes = () =>
      phoneA.site.evaluate<Box[]>(
        `[...document.querySelectorAll("[role=dialog] .gig-plan-route label")].map((l) => { const rating = l.querySelector("[data-slot=rating]"); return { name: l.querySelector("[data-slot=name]").textContent, nameWidth: Math.round(l.querySelector("[data-slot=name]").getBoundingClientRect().width), lineWidth: Math.round(l.querySelector("[data-slot=line]").getBoundingClientRect().width), height: Math.round(l.getBoundingClientRect().height), ratingFits: rating.scrollWidth <= rating.clientWidth + 1 }; })`,
      );
    const histories: Array<[string, number[]]> = [
      ["recent", [2, 2, 0]],
      ["older than a week", [12, 10, 9]],
    ];
    try {
      for (const [label, [serverAgo, wifiAgo, internetAgo]] of histories) {
        await seed(phoneA, [
          [`server/${local(Date.now() - serverAgo * DAY)}`, { ...GOOD, day: local(Date.now() - serverAgo * DAY), source: "gig" }],
          [`wifi/${local(Date.now() - wifiAgo * DAY)}`, { ...GOOD, day: local(Date.now() - wifiAgo * DAY), source: "bandmate" }],
          [`internet/${local(Date.now() - internetAgo * DAY)}`, { ...BAD, day: local(Date.now() - internetAgo * DAY), source: internetAgo === 0 ? "test-now" : "bandmate" }],
        ]);
        await goSettings(phoneA);
        await openConnection(phoneA);
        for (const width of [360, 390]) {
          await phoneA.site.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile: true });
          await settle(150);
          const read = await boxes();
          is.equal(read.length, 4, "four rows");
          for (const row of read) {
            const at = `${label} @${width}px ${row.name}`;
            is.ok(row.nameWidth >= 200 && row.lineWidth >= 200, `${at}: the name and line get ${row.nameWidth} and ${row.lineWidth} px, want at least 200`);
            is.ok(row.height <= 140, `${at}: the row is ${row.height} px tall, want at most 140`);
            is.ok(row.ratingFits, `${at}: the rating is not cut off`);
          }
        }
        await clearHistory(phoneA);
      }
    } finally {
      await clearHistory(phoneA);
      await phoneA.site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    }
  });

  await check("3c. Test now fills the server and internet rows and leaves the Wi-Fi link as 'Not tried yet · test with a bandmate'", async () => {
    await goSettings(phoneA);
    await openConnection(phoneA);
    const before = stun.stats.answered;
    await phoneA.app.click("Test now");
    await phoneA.app.until(`/^Tested/.test(document.querySelector("[data-slot=test-status]")?.textContent ?? "")`, "Test now to finish", 30_000);
    const server = await rowOf(phoneA, "Server");
    const internet = await rowOf(phoneA, "Over the internet");
    is.ok(RATED.includes(server.word), `Server is rated (${server.word})`);
    is.ok(RATED.includes(internet.word), `Over the internet is rated (${internet.word})`);
    is.equal(server.age, "tested today");
    is.equal(internet.age, "tested today");
    const wifi = await rowOf(phoneA, "Wi-Fi link");
    is.deepEqual([wifi.word, wifi.age], ["Not tried yet", "test with a bandmate"]);
    is.ok(stun.stats.answered > before, "the internet row asked the STUN server");
    const saved = (await store(phoneA))!;
    is.deepEqual(saved.map(([key]) => key).sort(), [`internet/${local(Date.now())}`, `server/${local(Date.now())}`]);
    for (const [, value] of saved) is.equal(value.source, "test-now");
  });

  await check("3d. Test now with no network says Can't test now and leaves every row alone", async () => {
    await goSettings(phoneA);
    await openConnection(phoneA);
    const before = { rows: await rows(phoneA), saved: await store(phoneA) };
    await phoneA.site.send("Network.enable");
    await phoneA.site.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    try {
      await phoneA.app.click("Test now");
      await phoneA.app.until(`/^Can't test now/.test(document.querySelector("[data-slot=test-status]")?.textContent ?? "")`, "Can't test now", 30_000);
    } finally {
      await phoneA.site.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
    is.deepEqual(await rows(phoneA), before.rows, "rows unchanged");
    is.deepEqual(await store(phoneA), before.saved, "nothing saved");
  });

  // ---------------------------------------------------------------------------------------- 4. two phones
  const bandmateDialog = `document.querySelector("[role=dialog][aria-label='Test with a bandmate']")`;
  const openBandmate = async (phone: Phone) => {
    await phone.app.click("Test with a bandmate");
    await phone.app.until(`!!${bandmateDialog}`, "the bandmate sheet");
  };
  const closeBandmate = async (phone: Phone) => {
    await phone.site.evaluate(`${bandmateDialog}.querySelector("button[aria-label=Close]").click()`);
    await settle();
  };
  const bandmateStatus = (phone: Phone) => phone.site.evaluate<string>(`${bandmateDialog}?.querySelector("[data-slot=bandmate-status]")?.textContent ?? ""`);
  const showCode = async (phone: Phone) => {
    await openBandmate(phone);
    await phone.app.click("Show my code", bandmateDialog);
    await phone.app.until(`!!${bandmateDialog}.querySelector(".codes-link")`, "the code on screen", 15_000);
    return phone.site.evaluate<string>(`${bandmateDialog}.querySelector(".codes-link").textContent.trim()`);
  };
  const scanLink = async (phone: Phone, link: string) => {
    await openBandmate(phone);
    await phone.app.click("Scan a code", bandmateDialog);
    await phone.app.until(`!!${bandmateDialog}.querySelector("input")`, "the paste box");
    await phone.site.evaluate(`${bandmateDialog}.querySelector("input").focus()`);
    await phone.site.send("Input.insertText", { text: link });
    await settle(150);
    await phone.app.click("Open link", bandmateDialog);
  };

  await check("4e. a signed-out phone is told to sign in and can close the sheet and carry on", async () => {
    await goSettings(phoneB);
    await openConnection(phoneB);
    await phoneB.app.click("Test with a bandmate");
    await phoneB.app.until(`!!${bandmateDialog}`, "the bandmate sheet");
    is.match(await phoneB.site.evaluate<string>(`${bandmateDialog}.textContent`), /Sign in to test with a bandmate/);
    await closeBandmate(phoneB);
    is.ok(await phoneB.site.evaluate<boolean>(`!${bandmateDialog} && !!document.querySelector("[role=dialog] .gig-plan-route")`), "the Connection sheet is still there");
    is.ok(await phoneB.site.evaluate<boolean>(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Test now" && !b.disabled)`), "Test now still works");
  });

  await signIn(phoneA, lee);
  await signIn(phoneB, fran);

  await check("4f. a bandmate who never answers times out with Your bandmate's phone didn't answer", async () => {
    await goSettings(phoneA);
    await openConnection(phoneA);
    const link = await showCode(phoneA);
    await closeBandmate(phoneA);
    await goSettings(phoneB);
    await openConnection(phoneB);
    await scanLink(phoneB, link);
    await phoneB.app.until(`/Your bandmate's phone didn't answer/.test(${bandmateDialog}?.textContent ?? "")`, "the timeout words", 20_000);
    is.deepEqual((await store(phoneB)) ?? [], [], "a timeout saves no rating");
  });

  await check("4a. Test with a bandmate measures every route between two phones through one scanned code", async () => {
    await goSettings(phoneA);
    await openConnection(phoneA);
    const link = await showCode(phoneA);
    is.match(await bandmateStatus(phoneA), /Waiting for your bandmate/);
    // The person's scan time is not counted against the test: the showing phone waits longer than the timeout and the test still runs.
    await sleep(3500);
    is.match(await bandmateStatus(phoneA), /Waiting for your bandmate/, "the showing phone is still waiting after the timeout length");
    await goSettings(phoneB);
    await openConnection(phoneB);
    await scanLink(phoneB, link);
    for (const phone of [phoneA, phoneB]) await phone.app.until(`/^Done/.test(${bandmateDialog}?.querySelector("[data-slot=bandmate-status]")?.textContent ?? "")`, `${phone.name} to finish`, 60_000);
    for (const phone of [phoneA, phoneB]) {
      await closeBandmate(phone);
      for (const name of ["Wi-Fi link", "Over the internet", "Server"]) {
        const row = await rowOf(phone, name);
        is.ok(RATED.includes(row.word), `${phone.name}: ${name} is rated (${row.word})`);
        is.equal(row.age, "tested with a bandmate today", `${phone.name}: ${name} shows its age and source`);
      }
      const saved = (await store(phone))!;
      is.deepEqual(saved.map(([key]) => key).sort(), [`internet/${local(Date.now())}`, `server/${local(Date.now())}`, `wifi/${local(Date.now())}`].sort());
      for (const [, value] of saved) is.equal(value.source, "bandmate");
    }
  });
} catch (error) {
  failures += 1;
  console.log(`FAIL the Chrome section could not run\n     ${String((error as Error)?.stack ?? error).split("\n").slice(0, 6).join("\n     ")}`);
} finally {
  for (const site of sites) await site.close().catch(() => {});
  for (const close of closers) await Promise.resolve(close()).catch(() => {});
  stun.close();
}

if (failures > 0) {
  console.log(`sync-rating: ${failures} FAIL`);
  process.exit(1);
}
console.log("sync-rating: all checks passed");
process.exit(0);
