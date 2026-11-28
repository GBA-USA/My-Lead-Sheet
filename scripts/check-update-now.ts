/**
 * check:update-now — the leader-pushed update, on two real builds of the app that differ only in their version id.
 *
 * Each phone is its own headless Chrome at 360 px with its own served site: a small server here that serves one folder
 * of built files and passes /api/ on to the one real Worker. "Publishing a new version" for a phone replaces the files
 * in its folder with the other build's, so its open page is really old and a reload really lands on the new one. The
 * server can also cut that phone's network, and counts the requests it gets for build.json.
 *
 * Cases U1 to U22 print `ok   <name>` or `FAIL <name>: <reason>`; the check exits 1 on any FAIL.
 * `UPDATE_NOW_SHOTS=<dir>` writes the 360 px screenshots, light and dark.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { passwordKey } from "../src/password.ts";
import { startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer } from "./app-page.ts";
import { openSite, type Site } from "./chrome.ts";

type Json = Record<string, any>;
type Reply = { status: number; body: Json };

const root = fileURLToPath(new URL("..", import.meta.url));
const MODEL = join(root, "src", "gig-check-in-model.ts");
const js = (value: unknown) => JSON.stringify(value);
const PASSWORD = "violet tram 42 lantern";
const SHAPE = { "X-Song-Shape": "chordpro" };
const WIDTH = 360;
const BUILD_ENV = "MLS_BUILD_ID";
/** The new version's id sorts before the old one's, so anything that ranks ids instead of comparing them gets it backwards. */
const OLD_ID = "zz-first-version-of-tonight";
const NEW_ID = "aa-second-version-of-tonight";
const SHOTS = process.env.UPDATE_NOW_SHOTS ?? "";
/** How long public/sw.js waits for the network before it opens its cached page; U18's slow network answers later. */
const NAVIGATION_WAIT_MS = Number(/const NAVIGATION_WAIT_MS = (\d+);/.exec(readFileSync(join(root, "public", "sw.js"), "utf8"))?.[1]);
assert.ok(NAVIGATION_WAIT_MS > 0, "public/sw.js still names NAVIGATION_WAIT_MS");
/** How long Update now waits for the new service worker before it gives up; U21 waits it out. */
const NEW_WORKER_WAIT_MS = Number(/const NEW_WORKER_WAIT_MS = ([\d_]+);/.exec(readFileSync(join(root, "src", "app-build.ts"), "utf8"))?.[1].replaceAll("_", ""));
assert.ok(NEW_WORKER_WAIT_MS > 0, "src/app-build.ts still names NEW_WORKER_WAIT_MS");
const started = Date.now();
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const newGigId = () => `gig_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;
const newPassId = () => `pass_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;
const today = () => {
  const day = new Date();
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};

// The words this brief puts on screen.
const SELF_FIRST = "Update this phone first";
const BETWEEN_SONGS = "Between songs is best.";
const ON_NEW = "On the new version";
const NEEDS = "Needs the update";
const ASK_THEM = "A phone on an older version can't be reached from here. Ask them to close the app and open it again.";
const READY = "A new version is ready.";
const OFFLINE = "Connect to the internet, then tap again.";
const NOT_LEADING = "You're not leading now";
const ASKED = "Asked. Their phones show the update now.";
const GETTING = "Getting the new version.";

let failed = 0;
const ONLY = (process.env.UPDATE_NOW_CASES ?? "").split(",").filter(Boolean);
async function check(name: string, run: () => Promise<void>) {
  if (ONLY.length && !ONLY.includes(name.split(" ")[0])) return;
  const t0 = Date.now();
  try {
    await run();
    console.log(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Polls `probe` until it gives a value, for at most `ms`. The failure says what never happened. */
async function waitFor<T>(what: string, ms: number, probe: () => T | null | undefined | false | Promise<T | null | undefined | false>): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > end) throw new Error(`${what}, not within ${ms / 1000} s${last ? ` (${last instanceof Error ? last.message : String(last)})` : ""}`);
    await pause(50);
  }
}

// ---- U14, the version rule on its own: 500 seeded rosters against an oracle written from the brief ------------------

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Stand = "current" | "needs-update" | "cannot-be-reached";
type VersionModel = {
  versionOf: (published: string, builds: readonly (string | null)[]) => Stand;
  asBuildId: (value: unknown) => string | null;
  rosterRows: (lineup: string[], sockets: { userId: string; lastBeat: number | null; build?: string | null }[], receipts: never[], now: number) => { userId: string; builds: (string | null)[] }[];
};

/**
 * The brief's rule, written here on its own: what a phone reported counts as an id only when it is a string of at most
 * 64 characters, else as none. A player needs the update exactly when any phone's id is missing or differs from the
 * published one, and cannot be reached exactly when every phone that differs reported none.
 */
function oracle(published: string, reported: unknown[]): Stand {
  let differs = 0;
  let differsWithId = 0;
  for (const value of reported) {
    const id = typeof value === "string" && value.length <= 64 ? value : null;
    if (id === published) continue;
    differs += 1;
    if (id !== null) differsWithId += 1;
  }
  if (differs === 0) return "current";
  return differsWithId === 0 ? "cannot-be-reached" : "needs-update";
}

const POOL = ["m-version", "a-version", "z-version", "m-version-2", "M-VERSION", "m-versio", "0", "~", "x".repeat(64)];
const BAD: unknown[] = [7, "x".repeat(65), { id: "m-version" }, true, ["m-version"], null, 0];

function roster(seed: number) {
  const random = mulberry(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const published = pick(POOL);
  const players: unknown[][] = [];
  for (let p = 0, n = 1 + Math.floor(random() * 6); p < n; p += 1) {
    const phones: unknown[] = [];
    for (let k = 0, m = 1 + Math.floor(random() * 3); k < m; k += 1) {
      const roll = random();
      phones.push(roll < 0.4 ? published : roll < 0.7 ? pick(POOL.filter((id) => id !== published)) : roll < 0.85 ? undefined : pick(BAD));
    }
    players.push(phones);
  }
  return { published, players };
}

async function u14() {
  let model: Partial<VersionModel>;
  try {
    model = (await import(pathToFileURL(MODEL).href)) as Partial<VersionModel>;
  } catch (error) {
    throw new Error(`src/gig-check-in-model.ts did not load: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof model.versionOf !== "function" || typeof model.asBuildId !== "function") throw new Error("the version rule is not there yet");
  const { versionOf, asBuildId, rosterRows } = model as VersionModel;
  let sawHigher = 0;
  let sawLower = 0;
  for (let seed = 1; seed <= 500; seed += 1) {
    const { published, players } = roster(seed);
    for (const phones of players) {
      const builds = phones.map((value) => asBuildId(value));
      const got = versionOf(published, builds);
      const want = oracle(published, phones);
      if (got !== want) throw new Error(`seed ${seed}: versionOf(${js(published)}, ${js(builds)}) is ${got} but the rule says ${want} for the phones ${js(phones)}`);
      for (const id of builds) if (typeof id === "string" && id !== published) id > published ? (sawHigher += 1) : (sawLower += 1);
    }
  }
  assert.ok(sawHigher > 50 && sawLower > 50, `the rosters hold other ids that sort both above and below the published one (${sawHigher} above, ${sawLower} below)`);
  assert.equal(versionOf("m", ["a"]), "needs-update", "an id that sorts lower needs the update");
  assert.equal(versionOf("m", ["z"]), "needs-update", "an id that sorts higher needs the update too: ids are never ranked");
  assert.equal(versionOf("m", ["m", "m"]), "current", "two phones on the published id are current");
  assert.equal(versionOf("m", ["m", "a"]), "needs-update", "two phones of one player: behind while either is");
  assert.equal(versionOf("m", ["m", null]), "cannot-be-reached", "the only phone behind reported no id: it cannot be reached");
  assert.equal(versionOf("m", [null]), "cannot-be-reached", "a phone that reported no id cannot be reached");
  assert.equal(versionOf("m", ["a", null]), "needs-update", "one reachable phone behind is enough to need the update");
  assert.equal(asBuildId(7), null, "a number is no id");
  assert.equal(asBuildId("x".repeat(65)), null, "a 65 character id is no id");
  assert.equal(asBuildId("x".repeat(64)), "x".repeat(64), "a 64 character id is kept");
  assert.equal(asBuildId(undefined), null, "a missing id is none");
  // The roster rule beside it: one entry per fresh socket, so a second phone counts and a quiet one does not.
  const now = 1_000_000;
  const rows = rosterRows(
    ["p1", "p2"],
    [
      { userId: "p1", lastBeat: now - 1000, build: "m" },
      { userId: "p1", lastBeat: null, build: "a" },
      { userId: "p2", lastBeat: now - 60_000, build: "a" },
      { userId: "p2", lastBeat: null },
    ],
    [],
    now,
  );
  assert.deepEqual(rows.map((row) => [row.userId, row.builds]), [["p1", ["m", "a"]], ["p2", [null]]], "builds holds one entry per fresh socket; a quiet socket's id is left out");
  assert.equal(versionOf("m", rows[0].builds), "needs-update", "p1's row is behind while either phone is");
}

// ---- Two real builds ------------------------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "check-update-now-"));
/** Builds the app from this tree into `out`, with the version id `id`, or with no override when it is null. */
async function buildApp(id: string | null, out: string) {
  const before = process.env[BUILD_ENV];
  if (id === null) delete process.env[BUILD_ENV];
  else process.env[BUILD_ENV] = id;
  try {
    await viteBuild({ root, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  } finally {
    if (before === undefined) delete process.env[BUILD_ENV];
    else process.env[BUILD_ENV] = before;
  }
  return out;
}
const publishedIn = (dir: string): unknown => {
  const file = join(dir, "build.json");
  if (!existsSync(file)) return "(no build.json)";
  return (JSON.parse(readFileSync(file, "utf8")) as Json).id;
};
/** A file the new service worker must fetch to install `build`, and that no open page waits on: the one a case holds back or loses. */
function precachedSpare(build: string) {
  const files = (JSON.parse(/const BUILD = (\{.*?\});/.exec(readFileSync(join(build, "sw.js"), "utf8"))?.[1] ?? "{}") as { files?: string[] }).files;
  const spare = files?.map((file) => file.replaceAll("\\", "/")).find((file) => file === "favicon.svg");
  assert.ok(spare, `the worker of ${build} precaches favicon.svg (${js(files)})`);
  return `/${spare}`;
}
/** Replaces every file a phone's site serves with the files of `from`. */
function publish(dir: string, from: string) {
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
  cpSync(from, dir, { recursive: true });
}

// ---- One phone's own site: its files, the API passed on to the Worker, its network switch, its build.json count -----

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
let apiBase = "";
let appOrigin = "";

type Front = {
  origin: string;
  dir: string;
  buildJsonGets: number;
  setOff(off: boolean): void;
  setSlow(ms: number): void;
  setHeld(path: string | null): void;
  setMissing(path: string | null): void;
  close(): Promise<void>;
};

/**
 * A phone's site. The Worker lets in one app origin, so the API's Origin is set to it on the way; everything else goes
 * as the browser sent it. Off, the site drops every open connection, the room socket too, and refuses new ones. Slow,
 * every file it serves, build.json and sw.js included, answers that many milliseconds late. A held file gets no answer
 * until it is let go, so a worker that precaches it cannot finish installing. A missing file answers 404.
 */
async function front(dir: string): Promise<Front> {
  let off = false;
  let slow = 0;
  let held: string | null = null;
  let missing: string | null = null;
  const holding: (() => void)[] = [];
  const open = new Set<NetSocket | Duplex>();
  const site: Front = {
    origin: "",
    dir,
    buildJsonGets: 0,
    setSlow(ms) {
      slow = ms;
    },
    setHeld(path) {
      held = path;
      if (path === null) for (const go of holding.splice(0)) go();
    },
    setMissing(path) {
      missing = path;
    },
    setOff(next) {
      off = next;
      if (off) for (const socket of open) socket.destroy();
    },
    close: () => new Promise((done) => {
      for (const socket of open) socket.destroy();
      server.close(() => done());
    }),
  };
  const forward = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const headers = Object.fromEntries(
      Object.entries(request.headers)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0] !== "host")
        .map(([key, value]) => [key, key === "origin" ? appOrigin : value]),
    );
    const reply = await fetch(new URL(request.url ?? "/", apiBase), { method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual" });
    const location = reply.headers.get("location");
    response.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json", "set-cookie": reply.headers.getSetCookie(), ...(location ? { location } : {}) });
    response.end(Buffer.from(await reply.arrayBuffer()));
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path.startsWith("/api/") || path.startsWith("/c/")) {
      forward(request, response).catch(() => {
        response.writeHead(502);
        response.end();
      });
      return;
    }
    if (request.method === "GET" && path === "/build.json") site.buildJsonGets += 1;
    const file = join(site.dir, path === "/" ? "index.html" : decodeURIComponent(path));
    const answer = () => {
      try {
        if (path === missing) throw new Error(`${path} is missing`);
        const body = readFileSync(file);
        response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end();
      }
    };
    if (path === held) holding.push(answer);
    else if (slow) setTimeout(answer, slow);
    else answer();
  });
  server.on("connection", (socket) => {
    if (off) return void socket.destroy();
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (off || !request.url?.startsWith("/api/")) return void socket.destroy();
    const target = new URL(apiBase);
    const upstream = connect(Number(target.port), target.hostname, () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const key = request.rawHeaders[i].toLowerCase();
        lines.push(`${request.rawHeaders[i]}: ${key === "host" ? target.host : key === "origin" ? appOrigin : request.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    open.add(upstream);
    upstream.on("close", () => {
      open.delete(upstream);
      socket.destroy();
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  site.origin = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;
  return site;
}

// ---- A phone's page ---------------------------------------------------------------------------------------------------

/** What the page sends and hears on its room socket, every fetch it makes, and its sockets, so a case can blink them. */
const WATCH = `(() => {
  window.__calls = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      window.__calls.push({ path: new URL(url, location.href).pathname, at: Date.now() });
    } catch {}
    return realFetch(input, init);
  };
  const Real = window.WebSocket;
  window.__rooms = [];
  window.__sent = [];
  window.__got = [];
  class Watched extends Real {
    constructor(url, protocols) {
      super(url, protocols);
      window.__rooms.push(this);
      this.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data !== "beat") window.__got.push(event.data.slice(0, 400)); });
    }
    send(data) {
      if (String(data) !== "beat") window.__sent.push(String(data).slice(0, 400));
      return super.send(data);
    }
  }
  window.WebSocket = Watched;
})();`;

const blank = mkdtempSync(join(tmpdir(), "check-update-now-blank-"));
writeFileSync(join(blank, "index.html"), "<!doctype html><title>blank</title>");

type Account = Awaited<ReturnType<typeof player>>;

async function phonePage(name: string, served: string) {
  const site: Site = await openSite(blank, name);
  const site_ = await front(served);
  await appPage(site);
  await site.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 780, deviceScaleFactor: 2, mobile: true });
  await site.send("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
  const evaluate = <T>(expression: string) => site.evaluate<T>(expression);
  const until = (expression: string, what: string, ms = 10000) => waitFor(what, ms, () => evaluate<boolean>(expression));
  const has = (selector: string) => evaluate<boolean>(`!!document.querySelector(${js(selector)})`);
  const buttonIn = (text: string, scope: string) => `[...(document.querySelector(${js(scope)})?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === ${js(text)})`;
  const tap = async (text: string, scope = "body") => {
    const tapped = await evaluate<boolean>(`(() => { const b = ${buttonIn(text, scope)}; b?.click(); return !!b; })()`);
    assert.ok(tapped, `a ${text} button to tap in ${scope} on ${name}'s phone`);
  };
  const text = () => evaluate<string>(`document.body.innerText`);
  const anyButton = (label: string) => evaluate<boolean>(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === ${js(label)})`);
  const go = async (hash: string, ready: string, what: string) => {
    await evaluate(`location.hash = ${js(hash)}`);
    await until(ready, what, 15000);
  };
  const loaded = () => waitFor(`${name}'s app to load`, 20000, () => evaluate<boolean>(`!!document.querySelector(".shell-header")`));
  await site.send("Page.navigate", { url: `${site_.origin}/` });
  await loaded();
  /** The id the running page reported in its newest join to the gig, read from what the page itself sent. */
  const reported = (gigId: string) =>
    evaluate<unknown>(`(() => {
      const joins = window.__sent.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter((m) => m && m.kind === "join-gig" && m.gigId === ${js(gigId)});
      if (!joins.length) return "(no join yet)";
      const last = joins[joins.length - 1];
      return "build" in last ? last.build : "(no id in the join)";
    })()`);
  const heardUpdates = (gigId: string) => evaluate<number>(`window.__got.filter((s) => s.includes('"update-now"') && s.includes(${js(gigId)})).length`);
  const prompts = () => evaluate<number>(`document.querySelectorAll(".update-prompt").length`);
  const mark = () => evaluate(`window.__stillHere = true`);
  const reloaded = () => evaluate<boolean>(`window.__stillHere !== true && !!document.querySelector(".shell-header")`);
  const blink = () => evaluate(`window.__rooms.filter((ws) => ws.readyState === 1 && ws.url.includes("/api/rooms/")).forEach((ws) => ws.close())`);
  const fits = () => evaluate<boolean>(`document.documentElement.scrollWidth <= window.innerWidth`);
  const heightOf = (text: string, scope: string) => evaluate<number>(`${buttonIn(text, scope)}?.getBoundingClientRect().height ?? 0`);
  const shot = async (file: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    for (const theme of ["stage", "day"]) {
      await evaluate(`document.documentElement.dataset.theme = ${js(theme)}`);
      await pause(200);
      writeFileSync(join(SHOTS, `${file}-${theme === "stage" ? "dark" : "light"}.png`), Buffer.from((await site.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    }
    await evaluate(`document.documentElement.dataset.theme = "stage"`);
  };
  /** Signs the phone in as `who` with their password, then loads the app fresh, as opening it again would. */
  const signIn = async (who: Account) => {
    await evaluate(`fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json", "X-Song-Shape": "chordpro" }, body: "{}" }).then((r) => r.status)`);
    const status = await evaluate<number>(
      `fetch("/api/auth/password/sign-in", { method: "POST", headers: { "content-type": "application/json", "X-Song-Shape": "chordpro" }, body: ${js(js({ handle: who.handle, key: who.key }))} }).then((r) => r.status)`,
    );
    assert.equal(status, 200, `${who.name} signs in on ${name}'s phone`);
    await evaluate(`localStorage.setItem("leadSheetsSignedIn", ${js(who.userId)})`);
    await evaluate(`location.hash = "#/songs"`);
    await site.send("Page.reload", { ignoreCache: false });
    await loaded();
    await waitFor(`${name}'s phone to be ${who.name}'s`, 10000, async () => (await evaluate<Json>(`fetch("/api/me", { headers: { "X-Song-Shape": "chordpro" } }).then((r) => r.json())`)).account?.userId === who.userId);
  };
  const me = () => evaluate<string | null>(`fetch("/api/me", { headers: { "X-Song-Shape": "chordpro" } }).then((r) => r.json()).then((b) => b.account?.userId ?? null)`);
  return { name, site, front: site_, evaluate, until, has, tap, text, anyButton, go, reported, heardUpdates, prompts, mark, reloaded, blink, fits, heightOf, shot, signIn, me, buttonIn };
}
type Page = Awaited<ReturnType<typeof phonePage>>;

// ---- Raw sockets to the real Room: a phone the check drives by hand, or one from before this cook -------------------

class Sock {
  heard: Json[] = [];
  closeCode: number | null = null;
  readonly who: Account;
  readonly ws: WebSocket;
  private constructor(who: Account, ws: WebSocket) {
    this.who = who;
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        this.heard.push({ ...JSON.parse(event.data), heardAt: Date.now() });
      } catch {
        // the heartbeat's own reply
      }
    });
    ws.addEventListener("close", (event) => (this.closeCode = event.code));
  }
  static async open(who: Account, bandId: string) {
    const ws = new WebSocket(who.socketUrl(bandId), { headers: { origin: appOrigin, cookie: who.cookie } } as unknown as string[]);
    const sock = new Sock(who, ws);
    await waitFor(`${who.name}'s socket greeted by the Room`, 5000, () => sock.heard.some((m) => m.kind === "hello") || sock.closeCode !== null);
    assert.equal(sock.closeCode, null, `${who.name}'s socket stays open`);
    return sock;
  }
  send(message: object) {
    this.ws.send(js(message));
  }
  /** Joins the gig reporting `build`, or reporting nothing at all when it is undefined, as a phone from before this cook. */
  async join(gigId: string, build?: unknown) {
    this.send({ kind: "join-gig", gigId, ...(build === undefined ? {} : { build }) });
    await waitFor(`${this.who.name}'s join answered`, 5000, () => this.heard.some((m) => m.kind === "gig" && m.gigId === gigId) || this.closeCode !== null);
    return this;
  }
  updates(gigId: string) {
    return this.heard.filter((m) => m.kind === "update-now" && m.gigId === gigId);
  }
  latest(gigId: string) {
    return this.heard.filter((m) => m.kind === "roster" && m.gigId === gigId).at(-1) as { rows: Json[] } | undefined;
  }
  async close() {
    if (this.closeCode !== null) return;
    this.ws.close();
    await waitFor(`${this.who.name}'s socket closed`, 5000, () => this.closeCode !== null);
  }
}
const socks: Sock[] = [];
const openSock = async (who: Account, bandId: string) => {
  const sock = await Sock.open(who, bandId);
  socks.push(sock);
  return sock;
};

async function player(name: string, handle: string) {
  const made = await passwordPlayer(apiBase, appOrigin, name, handle);
  const raw = made.call.bind(made);
  made.call = (path, body, headers = {}) => raw(path, body, { ...SHAPE, ...headers });
  const salt = (await made.call("/api/auth/password/salt", { handle })).body.salt as string;
  return Object.assign(made, { key: await passwordKey(PASSWORD, salt), raw });
}
const ok = (reply: Reply, what: string) => {
  assert.equal(reply.status, 200, `${what} (${reply.status} ${js(reply.body)})`);
  return reply.body;
};

// ---- The run ----------------------------------------------------------------------------------------------------------

await check("U14 the rule, 500 rosters", u14);

const cleanups: (() => Promise<unknown> | unknown)[] = [];
try {
  const oldBuild = await buildApp(OLD_ID, join(scratch, "old"));
  const newBuild = await buildApp(NEW_ID, join(scratch, "new"));
  const leeDir = join(scratch, "lee-site");
  const boDir = join(scratch, "bo-site");
  mkdirSync(leeDir);
  mkdirSync(boDir);
  publish(leeDir, oldBuild);
  publish(boDir, oldBuild);

  // The leader's site comes up first: its origin is the one the Worker lets in.
  const lee = await phonePage("lee", leeDir);
  cleanups.push(() => lee.site.close(), () => lee.front.close());
  appOrigin = lee.front.origin;
  const { worker, base } = await startApi({ APP_ORIGIN: appOrigin, RP_ID: "localhost", PASSWORD_PEPPER });
  cleanups.push(() => worker.dispose());
  apiBase = base;
  const bo = await phonePage("bo", boDir);
  cleanups.push(() => bo.site.close(), () => bo.front.close());

  const ada = await player("Ada Lowe", "adalowe");
  const leeA = await player("Lee O'Brien", "leeobrien");
  const boA = await player("Bo Hart", "bohart");
  const mo = await player("Mo Diaz", "modiaz");
  const rex = await player("Rex Moon", "rexmoon");
  const ray = await player("Ray Quill", "rayquill");
  const kit = await player("Kit Lark", "kitlark");
  const gus = await player("Gus Vale", "gusvale");

  const SONGS = [
    "{title: Porch Light Waltz}\n{artist: The Late Shift}\n{key: G}\n{tempo: 92}\n[G]Porch light [C]on, the [D]screen door [G]sings",
    "{title: Cold Brew Shuffle}\n{artist: The Late Shift}\n{key: A}\n{tempo: 118}\n[A]Up before the [D]sun, the [E]kettle's [A]done",
  ];
  const bandId = ok(await ada.call("/api/bands/create", { name: "Update Night" }), "Ada makes the band").bandId as string;
  const code = ok(await ada.call("/api/codes", { kind: "band", bandId }), "Ada's invite").code as string;
  for (const who of [leeA, boA, mo, rex, ray, kit]) ok(await who.call("/api/bands/join", { code }), `${who.name} joins the band`);
  const songIds: string[] = [];
  for (const chordpro of SONGS) songIds.push(ok(await ada.call("/api/bands/library/share-song", { bandId, song: { chordpro }, choice: "public", localId: null }), "Ada shares a song").songId);
  const setlistId = ok(await ada.call("/api/bands/library/share-setlist", { bandId, name: "Tonight", songIds, tags: [], choice: "public", localId: null }), "Ada shares the set").setlistId as string;
  const lineup = [leeA, boA, mo, rex, ray, kit].map((who) => who.userId);
  const gigId = ok(
    await ada.call("/api/bands/gig/plan", { bandId, setlistId, gigId: newGigId(), name: "Update night", date: today(), lineup, leader: leeA.userId, backup: mo.userId }),
    "Ada plans the gig, Lee leading, Mo the backup",
  ).gig.gigId as string;
  const pass = ok(await ada.call("/api/bands/guests/create", { bandId, gigId, passId: newPassId(), name: "Gus", expiresAt: Date.now() + 86_400_000, canSeeChat: false, canSeeSetlists: false }), "Ada makes Gus a guest pass");
  ok(await gus.call("/api/guest/claim", { code: pass.code }), "Gus claims the pass");
  cleanups.push(() => ada.call("/api/bands/gig/end", { bandId, gigId }).catch(() => {}));

  const gigScreen = `#/gig/${bandId}/${gigId}`;
  const gigView = `document.querySelector(${js(`.gig-view[data-gig="${gigId}"]`)})`;
  const onGigScreen = (page: Page) => page.go(gigScreen, `!!${gigView} && !${gigView}.textContent.includes("Loading")`, `${page.name}'s gig screen`);
  const NOT_FOLLOWING = ["", "join", "getting", "start", "ended", "off-lineup"];
  const following = (page: Page) =>
    page.evaluate<boolean>(`(() => { const s = document.querySelector(".gig-strip"); return !!s && !${js(NOT_FOLLOWING)}.includes(s.dataset.strip ?? "") && ![...s.querySelectorAll("button")].some((b) => b.textContent.trim() === "Join gig"); })()`);

  // Bo's phone holds a second account's data: Ada used it first.
  await bo.signIn(ada);
  await pause(1500);
  await bo.signIn(boA);
  await lee.signIn(leeA);

  // Lee starts the gig from the gig's screen, as the leader does.
  await onGigScreen(lee);
  if (await lee.evaluate<boolean>(`[...${gigView}.querySelectorAll("button")].some((b) => b.textContent.trim() === "Get ready")`)) {
    await lee.tap("Get ready", `.gig-view[data-gig="${gigId}"]`);
    await lee.until(`!!${gigView}?.querySelector(".gig-count")`, "tonight's set on Lee's phone", 15000);
  }
  await lee.until(`[...document.querySelectorAll(".gig-strip button")].some((b) => b.textContent.trim() === "Hold to start the gig")`, "Hold to start on Lee's strip", 15000);
  await lee.evaluate(`[...document.querySelectorAll(".gig-strip button")].find((b) => b.textContent.trim() === "Hold to start the gig").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  await waitFor("Lee's start to go through", 15000, async () => {
    if (await lee.has(".gig-question")) await lee.evaluate(`document.querySelectorAll(".gig-question button")[1].click()`);
    return (ok(await ada.call("/api/bands/gig/open", { bandId, gigId }), "Ada reads the gig").gig.status as string) === "live";
  });
  await onGigScreen(lee);
  await waitFor("Lee's phone to follow its gig", 15000, () => following(lee));

  // Bo joins from the gig's screen and answers the click question, so his phone needs no tap to come back to a gig.
  await onGigScreen(bo);
  await bo.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
  await bo.until(`[...document.querySelectorAll(".gig-strip button")].some((b) => b.textContent.trim() === "Join gig")`, "Join gig on Bo's strip", 40000);
  await bo.tap("Join gig", ".gig-strip");
  await waitFor("Bo's phone to join, answering the click question", 15000, async () => {
    if (await bo.has(".gig-question")) await bo.evaluate(`document.querySelectorAll(".gig-question button")[1].click()`);
    return following(bo);
  });
  await onGigScreen(bo);

  /** The leader's own second phone, a raw socket on the new version: it reads every roster the Room sends Lee. */
  let leeRaw: Sock | null = null;
  const rowOf = (who: Account) => leeRaw?.latest(gigId)?.rows.find((row) => row.userId === who.userId);
  const panelRows = () =>
    lee.evaluate<{ name: string; word: string }[]>(`[...document.querySelectorAll(".update-panel .update-row")].map((r) => ({ name: r.querySelector(".update-name")?.textContent.trim() ?? "", word: r.querySelector(".update-word")?.textContent.trim() ?? "" }))`);
  const rowReads = (first: string, word: string, what: string, ms = 10000) => waitFor(what, ms, async () => (await panelRows()).some((row) => row.name === first && row.word === word));
  const versionWords = async (page: Page) => {
    const words = await page.text();
    return words.includes(ON_NEW) || words.includes(NEEDS);
  };
  const updateNowOnLee = () => lee.evaluate<boolean>(`!!${lee.buttonIn("Update now", ".update-panel")}`);
  let boOnNew: unknown = null;

  await check("U1 the build id", async () => {
    assert.equal(publishedIn(oldBuild), OLD_ID, "the first build publishes build.json with the id it was built with");
    assert.equal(publishedIn(newBuild), NEW_ID, "the second build publishes its own id");
    const served = (await (await fetch(`${bo.front.origin}/build.json`)).json()) as Json;
    assert.deepEqual(served, { id: OLD_ID }, "Bo's site serves build.json as { id }");
    assert.equal(await bo.reported(gigId), OLD_ID, "the id Bo's running page reports when it joins the gig is the id its site publishes");
    assert.equal(await lee.reported(gigId), OLD_ID, "the id Lee's running page reports is the one it was built with");
    const plainOne = await buildApp(null, join(scratch, "plain-one"));
    const plainTwo = await buildApp(null, join(scratch, "plain-two"));
    const one = publishedIn(plainOne);
    assert.equal(typeof one, "string", `a build with no override publishes an id (${js(one)})`);
    assert.ok((one as string).length > 0 && (one as string).length <= 64, "the id is at most 64 characters");
    assert.equal(publishedIn(plainTwo), one, "building the same source twice with no override gives the same id");
    assert.notEqual(one, OLD_ID, "the override really replaced it");
  });

  await check("U4 the leader is behind", async () => {
    publish(leeDir, newBuild);
    await lee.blink();
    await lee.until(`(document.querySelector(".update-self")?.textContent ?? "").includes(${js(SELF_FIRST)})`, "Lee's strip to say to update this phone first once the roster opens again", 15000);
    const self = await lee.evaluate<string>(`document.querySelector(".update-self").textContent`);
    assert.ok(self.includes(BETWEEN_SONGS), `the strip says between songs is best (${self})`);
    assert.ok(await lee.evaluate<boolean>(`!!${lee.buttonIn("Reload", ".update-self")}`), "with a Reload button");
    assert.ok((await lee.heightOf("Reload", ".update-self")) >= 44, "Reload is at least 44 px tall");
    assert.ok(!(await versionWords(lee)), "the roster has no version words while this phone is behind");
    assert.ok(!(await lee.anyButton("Update now")), "and there is no Update now");
    await lee.shot("leader-update-this-phone-first");
    const asked = lee.front.buildJsonGets;
    await lee.mark();
    await lee.tap("Reload", ".update-self");
    await waitFor("Lee's page to reload", 15000, () => lee.reloaded());
    assert.ok(lee.front.buildJsonGets > asked, "tapping Reload asked for the published id first");
    await waitFor("Lee's reloaded page to join the gig again", 20000, async () => (await lee.reported(gigId)) !== "(no join yet)");
    assert.equal(await lee.reported(gigId), NEW_ID, "after Reload the page itself reports the second build's id");
    await waitFor("Lee's phone to lead the gig again", 15000, () => following(lee));
  });

  await check("U2 reported on join", async () => {
    leeRaw = await (await openSock(leeA, bandId)).join(gigId, NEW_ID);
    const moOne = await (await openSock(mo, bandId)).join(gigId, NEW_ID);
    await waitFor("Mo's row to carry his phone's id", 8000, () => js(rowOf(mo)?.builds) === js([NEW_ID]));
    const moTwo = await (await openSock(mo, bandId)).join(gigId, OLD_ID);
    await waitFor("Mo's row to carry both of his phones", 8000, () => js([...(rowOf(mo)?.builds ?? [])].sort()) === js([NEW_ID, OLD_ID].sort()));
    const number = await (await openSock(rex, bandId)).join(gigId, 7);
    await waitFor("a join whose id is a number to count as none", 8000, () => js(rowOf(rex)?.builds) === js([null]));
    const long = await (await openSock(rex, bandId)).join(gigId, "x".repeat(65));
    await waitFor("a 65 character id to count as none", 8000, () => js(rowOf(rex)?.builds) === js([null, null]));
    const longest = await (await openSock(rex, bandId)).join(gigId, "y".repeat(64));
    await waitFor("a 64 character id to be kept", 8000, () => (rowOf(rex)?.builds ?? []).includes("y".repeat(64)));
    const asking = await openSock(rex, bandId);
    asking.send({ kind: "gig-state", gigId, build: OLD_ID });
    await waitFor("a socket that only asked for the gig's state to carry its id too", 8000, () => (rowOf(rex)?.builds ?? []).includes(OLD_ID));
    const bo = rowOf(boA);
    assert.deepEqual(bo?.builds, [OLD_ID], `Bo's page reported its id (${js(bo)})`);
    for (const sock of [moTwo, number, long, longest, asking]) await sock.close();
    await waitFor("Rex's row to have no phones once his sockets closed", 8000, () => js(rowOf(rex)?.builds) === js([]));
    void moOne;
  });

  await check("U3 who needs it", async () => {
    await rowReads("Bo", NEEDS, "Bo's row on Lee's roster to read Needs the update");
    await rowReads("Mo", ON_NEW, "Mo's row to read On the new version");
    await rowReads("Lee", ON_NEW, "Lee's own row to read On the new version");
    assert.ok(await updateNowOnLee(), "Update now is offered");
    const above = await lee.evaluate<boolean>(`${lee.buttonIn("Update now", ".update-panel")}.getBoundingClientRect().bottom <= document.querySelector(".update-panel .update-row").getBoundingClientRect().top`);
    assert.ok(above, "Update now sits above the rows");
    assert.ok(!(await lee.has(".update-ask")), "no ask-them line while every phone behind can be reached");
    await lee.shot("leader-roster-one-new-one-needs");
  });

  let kitSock: Sock | null = null;
  let gusSock: Sock | null = null;
  await check("U6 the server decides", async () => {
    const rexSock = await (await openSock(rex, bandId)).join(gigId, NEW_ID);
    rexSock.send({ kind: "update-now", gigId });
    const moSock = await (await openSock(mo, bandId)).join(gigId, NEW_ID);
    moSock.send({ kind: "update-now", gigId });
    for (const [sock, who] of [[rexSock, "Rex, on the lineup and not leading"], [moSock, "Mo, the backup, while Lee leads"]] as const) {
      const refusal = await waitFor(`the Room to answer ${who}`, 5000, () => sock.heard.find((m) => m.kind === "update-refused" || (m.kind === "error" && m.error === "bad-message")));
      assert.deepEqual([refusal.kind, refusal.gigId, refusal.refused], ["update-refused", gigId, "not-leading"], `the Room refuses ${who} with a machine word (${js(refusal)})`);
    }
    await pause(2000);
    assert.equal(await bo.heardUpdates(gigId), 0, "Bo's phone hears no update message from them");
    assert.equal(await bo.prompts(), 0, "and shows no prompt");
    kitSock = await (await openSock(kit, bandId)).join(gigId, OLD_ID);
    gusSock = await (await openSock(gus, bandId)).join(gigId, OLD_ID);
    assert.equal(gusSock.closeCode, null, "Gus's socket is in the gig on his pass");
    ok(await ada.call("/api/bands/remove", { bandId, userId: kit.userId }), "Ada removes Kit from the band");
    await waitFor("Kit's socket closed by the Room", 5000, () => kitSock!.closeCode !== null);
    await rowReads("Bo", NEEDS, "Bo still needs the update");
    await lee.tap("Update now", ".update-panel");
    await waitFor("Bo's phone to show the prompt after Lee's tap", 10000, async () => (await bo.prompts()) === 1);
    await pause(2000);
    assert.equal(gusSock.updates(gigId).length, 0, "Gus, a guest on the old version, receives nothing");
    assert.equal(kitSock.updates(gigId).length, 0, "Kit, removed, receives nothing");
    await rexSock.close();
    await moSock.close();
    await bo.tap("Not now", ".update-prompt");
    await bo.until(`!document.querySelector(".update-prompt")`, "Bo's prompt to close");
  });

  let rexOld: Sock | null = null;
  await check("U7 once, and late joiners", async () => {
    await lee.tap("Update now", ".update-panel");
    await lee.tap("Update now", ".update-panel");
    await waitFor("Bo's phone to show the prompt", 10000, async () => (await bo.prompts()) >= 1);
    for (let i = 0; i < 20; i += 1) {
      assert.equal(await bo.prompts(), 1, "two taps by the leader give Bo one prompt");
      await pause(100);
    }
    const moNew = await (await openSock(mo, bandId)).join(gigId, NEW_ID);
    rexOld = await (await openSock(rex, bandId)).join(gigId, OLD_ID);
    await waitFor("Rex, joining after the tap on the old version, to get the update message", 5000, () => rexOld!.updates(gigId).length > 0);
    const rexNew = await (await openSock(rex, bandId)).join(gigId, NEW_ID);
    await rowReads("Rex", NEEDS, "Rex's row to read Needs the update while either of his phones is behind");
    await rexOld.close();
    rexOld = await (await openSock(rex, bandId)).join(gigId, OLD_ID);
    await waitFor("Rex, reconnecting on the old version, to get the update message again", 5000, () => rexOld!.updates(gigId).length > 0);
    const rexBack = await (await openSock(rex, bandId)).join(gigId, NEW_ID);
    await pause(2500);
    assert.equal(moNew.updates(gigId).length, 0, "Mo, already on the leader's version, never gets one");
    assert.equal(rexNew.updates(gigId).length, 0, "Rex's phone on the new version gets none");
    assert.equal(rexBack.updates(gigId).length, 0, "Rex reconnecting on the new version gets none");
    assert.equal(leeRaw!.updates(gigId).length, 0, "Lee's own second phone on his version gets none");
    for (const sock of [moNew, rexNew, rexBack]) await sock.close();
  });

  await check("U9 Not now", async () => {
    assert.equal(await bo.prompts(), 1, "Bo's phone shows the prompt");
    await bo.tap("Not now", ".update-prompt");
    await bo.until(`!document.querySelector(".update-prompt")`, "the prompt to close");
    assert.ok(await following(bo), "Bo still follows the gig");
    const number = () => bo.evaluate<string>(`${gigView}?.querySelector(".gig-set li[aria-current=true] .gig-set-number")?.textContent ?? ""`);
    const was = await number();
    assert.equal(was, "1", "Bo's screen shows the first song");
    await lee.evaluate(`${gigView}.querySelector(".gig-set button").click()`);
    await waitFor("Bo's screen to follow Lee's next song", 10000, async () => (await number()) === "2");
    await rowReads("Bo", NEEDS, "Bo's row still reads Needs the update");
    await pause(4000);
    assert.equal(await bo.prompts(), 0, "no new prompt comes by itself");
    await lee.tap("Update now", ".update-panel");
    await waitFor("a new prompt once Lee asks again", 10000, async () => (await bo.prompts()) === 1);
    await bo.shot("player-prompt");
  });

  await check("U12 on the phone", async () => {
    assert.ok((await lee.heightOf("Update now", ".update-panel")) >= 44, "Lee's Update now is at least 44 px tall");
    assert.ok((await bo.heightOf("Update now", ".update-prompt")) >= 44, "Bo's Update now is at least 44 px tall");
    assert.ok((await bo.heightOf("Not now", ".update-prompt")) >= 44, "Bo's Not now is at least 44 px tall");
    const prompt = await bo.evaluate<string>(`document.querySelector(".update-prompt").innerText`);
    assert.ok(prompt.includes(READY), `the prompt says ${READY} (${prompt})`);
    assert.deepEqual(await bo.evaluate<string[]>(`[...document.querySelectorAll(".update-prompt button")].map((b) => b.textContent.trim())`), ["Update now", "Not now"], "the prompt's two buttons");
    for (const page of [bo, lee]) {
      const words = await page.text();
      assert.ok(!words.includes(OLD_ID) && !words.includes(NEW_ID), `${page.name}'s screen never shows a version id`);
    }
    assert.ok(!/\bbuild\b|\bhash\b/i.test(await bo.evaluate<string>(`document.querySelector(".update-prompt").innerText`)), "the prompt says version, never build or hash");
    assert.ok(!/\bbuild\b|\bhash\b/i.test(await lee.evaluate<string>(`document.querySelector(".update-panel").innerText`)), "the leader's panel says version, never build or hash");
    assert.ok(await lee.fits(), "Lee's page does not scroll sideways at 360 px");
    assert.ok(await bo.fits(), "Bo's page does not scroll sideways at 360 px");
    const moving = await bo.evaluate<string>(`getComputedStyle(document.querySelector(".update-prompt")).animationName`);
    assert.notEqual(moving, "none", "the prompt slides in when motion is allowed");
    await bo.site.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await bo.tap("Not now", ".update-prompt");
    await lee.tap("Update now", ".update-panel");
    await waitFor("the prompt again", 10000, async () => (await bo.prompts()) === 1);
    assert.equal(await bo.evaluate<string>(`getComputedStyle(document.querySelector(".update-prompt")).animationName`), "none", "with reduced motion the prompt appears without animation");
    await bo.site.send("Emulation.setEmulatedMedia", { features: [] });
    await lee.shot("leader-update-now");
  });

  await check("U10 no internet", async () => {
    publish(boDir, newBuild);
    assert.equal(await bo.prompts(), 1, "Bo's phone shows the prompt");
    await bo.mark();
    bo.front.setOff(true);
    await bo.tap("Update now", ".update-prompt");
    await bo.until(`(document.querySelector(".update-prompt")?.textContent ?? "").includes(${js(OFFLINE)})`, "the no-internet line on Bo's prompt");
    await pause(3000);
    assert.ok(!(await bo.reloaded()), "Bo's page did not reload");
    assert.equal(await bo.prompts(), 1, "the prompt stays");
    bo.front.setOff(false);
    lee.front.setOff(true);
    await waitFor("Lee's roster to show no version words with Lee's network off", 20000, async () => !(await versionWords(lee)) && !(await lee.anyButton("Update now")));
    lee.front.setOff(false);
    await rowReads("Bo", NEEDS, "Lee's roster to come back with the network", 20000);
    await waitFor("Bo's phone back on the room line", 20000, () => following(bo));
  });

  await check("U5 one tap", async () => {
    await waitFor("Bo's prompt", 10000, async () => (await bo.prompts()) === 1);
    const before = await bo.evaluate<Record<string, string>>(`Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]))`);
    assert.ok(Object.keys(before).length > 0, "Bo's phone holds stored data");
    await bo.mark();
    await bo.tap("Update now", ".update-prompt");
    await waitFor("Bo's page to reload", 15000, () => bo.reloaded());
    await waitFor("Bo's reloaded page to join the gig with no tap", 20000, async () => (await bo.reported(gigId)) !== "(no join yet)");
    boOnNew = await bo.reported(gigId);
    assert.equal(boOnNew, NEW_ID, "the page itself now reports the second build's id");
    await waitFor("Bo back in the gig with no tap", 15000, () => following(bo));
    assert.ok(await bo.evaluate<boolean>(`location.hash.startsWith(${js(gigScreen)})`), "on the gig's screen");
    assert.equal(await bo.me(), boA.userId, "still signed in as Bo");
    await rowReads("Bo", ON_NEW, "Bo's row to read On the new version");
    assert.equal(await bo.prompts(), 0, "no prompt on the new version");
    const after = await bo.evaluate<Record<string, string>>(`Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]))`);
    assert.deepEqual(after, before, "Bo's stored library, settings and Ada's data on the phone are byte for byte what they were");
  });

  await check("U8 a phone from before", async () => {
    await rexOld?.close();
    const old = await (await openSock(ray, bandId)).join(gigId);
    await rowReads("Ray", NEEDS, "Ray's row to read Needs the update");
    await lee.until(`(document.querySelector(".update-ask")?.textContent ?? "").trim() === ${js(ASK_THEM)}`, "the ask-them line on Lee's roster");
    assert.ok(!(await updateNowOnLee()), "with only a phone from before behind, Update now is not offered");
    const heard = old.updates(gigId).length;
    leeRaw!.send({ kind: "update-now", gigId });
    await pause(3000);
    assert.ok(!leeRaw!.heard.some((m) => m.kind === "update-refused"), "Lee's ask is taken");
    assert.equal(old.updates(gigId).length, heard, "the Room sends the phone from before no update message");
    await old.close();
  });

  await check("U11 the safety rule is intact", async () => {
    assert.equal(boOnNew, NEW_ID, `Bo's phone is on the new version (${js(boOnNew)})`);
    const first = await boA.call("/api/backup", { since: 0, changes: [{ key: "leadSheetsScrollPercent.u11", kind: "scroll", value: "100", base: 0 }] });
    assert.equal(first.status, 200, `a backup with the header goes through (${js(first.body)})`);
    const rowsBefore = ok(await boA.call("/api/backup", { since: 0, changes: [] }), "Bo reads his rows");
    const refused = await boA.raw("/api/backup", { since: 0, changes: [{ key: "leadSheetsScrollPercent.u11", kind: "scroll", value: "5", base: 1 }] });
    assert.deepEqual([refused.status, refused.body], [409, { error: "update-app" }], "a backup without the header is still answered 409 update-app");
    const rowsAfter = ok(await boA.call("/api/backup", { since: 0, changes: [] }), "Bo reads his rows again");
    assert.deepEqual(rowsAfter.rows, rowsBefore.rows, "the rows in that room are unchanged");
  });

  await check("U13 no polling", async () => {
    await lee.until(`!document.querySelector(".update-self")`, "Lee on the live roster, current");
    const from = lee.front.buildJsonGets;
    await pause(30_000);
    const quiet = lee.front.buildJsonGets - from;
    console.log(`     count: build.json requests from the leader's page in 30 s on the live roster = ${quiet}`);
    assert.ok(quiet <= 1, `the leader's page asked for build.json ${quiet} times in 30 s`);
    await lee.blink();
    await waitFor("opening the roster again to ask again", 15000, () => lee.front.buildJsonGets > from + quiet);
    publish(leeDir, oldBuild);
    const reopened = lee.front.buildJsonGets;
    await lee.blink();
    await lee.until(`!!document.querySelector(".update-self")`, "Lee behind once another version is published, whichever way the ids sort", 15000);
    assert.ok(lee.front.buildJsonGets > reopened, "the roster asked again when it opened");
    const tapped = lee.front.buildJsonGets;
    await lee.mark();
    await lee.tap("Reload", ".update-self");
    await waitFor("Lee's page to reload", 15000, () => lee.reloaded());
    assert.ok(lee.front.buildJsonGets > tapped, "tapping Reload asked again");
    await waitFor("Lee's page to join again", 20000, async () => (await lee.reported(gigId)) !== "(no join yet)");
    assert.equal(await lee.reported(gigId), OLD_ID, "and the page now runs the published version");
  });

  // ---- U15 to U17: the Room's refusal on the leader's page, and the version boxes inside the screen ------------------

  const gigOpsCode = (await esbuild({ stdin: { contents: 'export { reduce } from "./src/gig-state.ts";', resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" })).outputFiles[0].text;
  const gigOps = (await import(`data:text/javascript;base64,${Buffer.from(gigOpsCode).toString("base64")}`)) as typeof import("../src/gig-state.ts");
  /** Reads the Room's copy of the gig on `sock`, then sends `who`'s op on it as their own phone would. */
  const opBy = async (sock: Sock, who: Account, op: Json) => {
    const from = sock.heard.length;
    sock.send({ kind: "gig-state", gigId });
    const copy = await waitFor(`the Room's copy of the gig on ${who.name}'s socket`, 5000, () => sock.heard.slice(from).find((m) => m.kind === "gig-state" && m.state?.gigId === gigId));
    const now = Date.now();
    const full = { opId: `${who.handle}-${op.kind}-${now}`, epoch: copy.state.epoch, ...op };
    const out = gigOps.reduce(copy.state, full as never, { by: who.userId, now: now as never, lead: 0 });
    assert.ok(out.ok, `${who.name} may ${op.kind} (${js(out)})`);
    sock.send({ kind: "gig-op", op: full, state: out.state, at: now });
    await pause(500);
    assert.ok(!sock.heard.slice(from).some((m) => m.kind === "gig-refused"), `the Room takes ${who.name}'s ${op.kind}`);
  };
  /** Lee's phone leads on the published version and Bo's phone is on the other one, so Update now shows. */
  const leeLeadsWithBoBehind = async () => {
    const leeOn = await lee.reported(gigId);
    if (publishedIn(leeDir) !== leeOn) publish(leeDir, leeOn === NEW_ID ? newBuild : oldBuild);
    if ((await bo.reported(gigId)) === leeOn) {
      publish(boDir, leeOn === NEW_ID ? oldBuild : newBuild);
      await bo.mark();
      await bo.site.send("Page.reload", { ignoreCache: true });
      await waitFor("Bo's page to load the other version", 20000, () => bo.reloaded());
      await waitFor("Bo's page to join again on the other version", 20000, async () => ![leeOn, "(no join yet)"].includes((await bo.reported(gigId)) as string));
    }
    const sockets = await lee.evaluate<number>(`window.__rooms.length`);
    await lee.blink();
    await lee.until(`window.__rooms.slice(${sockets}).some((ws) => ws.readyState === 1 && ws.url.includes("/api/rooms/"))`, "Lee's page to open a new room socket after the blink", 20000);
    await waitFor("Lee's phone to follow its gig", 20000, () => following(lee));
    await rowReads("Bo", NEEDS, "Bo's row on Lee's roster to read Needs the update", 20000);
    assert.ok(await updateNowOnLee(), "Update now is offered on Lee's panel");
  };
  /** Every box of `selector` on `page` that leaves the screen or a box that clips it, each named. */
  const outside = (page: Page, selector: string) =>
    page.evaluate<string[]>(`(() => {
      const root = document.querySelector(${js(selector)});
      if (!root) return [${js(`no ${selector} on the page`)}];
      const misses = [];
      const name = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).join(".") : "");
      const span = (r) => Math.round(r.left) + ".." + Math.round(r.right) + " x " + Math.round(r.top) + ".." + Math.round(r.bottom);
      for (const el of [root, ...root.querySelectorAll("*")]) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.left < -0.5 || r.right > window.innerWidth + 0.5) misses.push(name(el) + " at " + span(r) + " leaves the " + window.innerWidth + " px screen");
        for (let box = el.parentElement; box; box = box.parentElement) {
          const style = getComputedStyle(box);
          const c = box.getBoundingClientRect();
          const clipsX = style.overflowX !== "visible";
          const clipsY = style.overflowY === "hidden" || style.overflowY === "clip";
          if ((clipsX && (r.left < c.left - 0.5 || r.right > c.right + 0.5)) || (clipsY && (r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5)))
            misses.push(name(el) + " at " + span(r) + " is cut off by " + name(box) + " at " + span(c));
        }
      }
      return misses;
    })()`);
  const insideAt360And390 = async (page: Page, selector: string) => {
    for (const width of [360, 390]) {
      await page.site.send("Emulation.setDeviceMetricsOverride", { width, height: 780, deviceScaleFactor: 2, mobile: true });
      await pause(300);
      const misses = await outside(page, selector);
      assert.deepEqual(misses, [], `every box of ${selector} on ${page.name}'s phone is inside the screen and its clipping boxes at ${width} px (${misses.join("; ")})`);
    }
    await page.site.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 780, deviceScaleFactor: 2, mobile: true });
  };

  await check("U15 a refusal goes with the lead", async () => {
    await leeLeadsWithBoBehind();
    const moSock = await (await openSock(mo, bandId)).join(gigId, NEW_ID);
    await opBy(moSock, mo, { kind: "takeOver" });
    await lee.until(`!document.querySelector(".update-panel")`, "Lee's panel to go once Mo leads");
    // Lee's tap reaches the Room just after Mo took the lead, so the Room refuses it.
    await lee.until(`window.__rooms.some((ws) => ws.readyState === 1 && ws.url.includes("/api/rooms/"))`, "Lee's page to have its room socket open", 15000);
    await lee.evaluate(`window.__rooms.filter((ws) => ws.readyState === 1 && ws.url.includes("/api/rooms/")).forEach((ws) => ws.send(${js(js({ kind: "update-now", gigId }))}))`);
    await lee.until(`window.__got.some((s) => s.includes('"update-refused"') && s.includes(${js(gigId)}))`, "the Room to refuse Lee's ask while Mo leads");
    await opBy(moSock, mo, { kind: "setBackup", userId: leeA.userId });
    const leeSock = await (await openSock(leeA, bandId)).join(gigId, await lee.reported(gigId));
    await opBy(leeSock, leeA, { kind: "takeOver" });
    await waitFor("Lee's panel back once Lee leads again", 20000, () => updateNowOnLee());
    await pause(1000);
    const panel = await lee.evaluate<string>(`document.querySelector(".update-panel")?.innerText ?? ""`);
    assert.ok(!panel.includes(NOT_LEADING), `Lee leads again, so the panel does not say ${NOT_LEADING} (${js(panel)})`);
    await leeSock.close();
    await moSock.close();
  });

  await check("U16 the leader's page says the Room's refusal", async () => {
    await leeLeadsWithBoBehind();
    await lee.evaluate(
      `window.__rooms.filter((ws) => ws.readyState === 1 && ws.url.includes("/api/rooms/")).forEach((ws) => ws.dispatchEvent(new MessageEvent("message", { data: ${js(js({ kind: "update-refused", gigId, refused: "not-leading" }))} })))`,
    );
    await lee.until(`[...document.querySelectorAll(".update-panel [role=status]")].some((p) => p.textContent.trim() === ${js(NOT_LEADING)})`, `Lee's panel to say ${NOT_LEADING} when the Room refuses the ask`);
    await lee.tap("Update now", ".update-panel");
    await lee.until(`(() => { const words = document.querySelector(".update-panel")?.innerText ?? ""; return words.includes(${js(ASKED)}) && !words.includes(${js(NOT_LEADING)}); })()`, "the next tap to replace the refusal with the asked line");
  });

  await check("U17 every version box inside 360 and 390 px", async () => {
    await leeLeadsWithBoBehind();
    await lee.tap("Update now", ".update-panel");
    await lee.until(`(document.querySelector(".update-panel")?.innerText ?? "").includes(${js(ASKED)})`, "Lee's panel to hold the asked line above the rows");
    await insideAt360And390(lee, ".update-panel");
    await waitFor("Bo's prompt after Lee's tap", 10000, async () => (await bo.prompts()) === 1);
    await insideAt360And390(bo, ".update-prompt");
    const leeOn = await lee.reported(gigId);
    publish(leeDir, leeOn === NEW_ID ? oldBuild : newBuild);
    await lee.blink();
    await lee.until(`!!document.querySelector(".update-self")`, "Lee's strip to say to update this phone first", 20000);
    await insideAt360And390(lee, ".update-self");
    const reload = await lee.evaluate<{ icon: number; worded: string[] } | null>(`(() => {
      const button = ${lee.buttonIn("Reload", ".update-self")};
      if (!button) return null;
      const icon = button.querySelector("svg")?.getBoundingClientRect().width ?? 0;
      const worded = [button, ...button.querySelectorAll("*")]
        .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 1 || r.height > 1)
        .map((r) => Math.round(r.width) + "x" + Math.round(r.height));
      return { icon, worded };
    })()`);
    assert.ok(reload, "Lee's strip has a button named Reload");
    assert.ok(reload.icon >= 16, `Reload draws its icon (${reload.icon} px wide)`);
    assert.deepEqual(reload.worded, [], "Reload is icon-only: the word is its name and draws no box (UI rule 1)");
  });

  await check("U18 one tap on a slow network", async () => {
    await leeLeadsWithBoBehind();
    const leeOn = await lee.reported(gigId);
    const boWas = await bo.reported(gigId);
    const workerHoldsThisPage = `(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      const src = document.querySelector('script[type="module"][src]')?.src;
      return !!r?.active && !r.installing && !r.waiting && !!src && !!(await caches.match(src));
    })()`;
    // A reload that skips the cache also skips the worker's own update check, so ask for it here.
    await bo.evaluate(`navigator.serviceWorker.getRegistration().then((r) => r?.update()).then(() => true, () => false)`);
    await waitFor("Bo's service worker to hold the version Bo's page runs", 30_000, () => bo.evaluate<boolean>(workerHoldsThisPage));
    await bo.mark();
    await bo.site.send("Page.reload", { ignoreCache: false });
    await waitFor("Bo's page to load again under its service worker", 20000, () => bo.reloaded());
    await waitFor("Bo's page to join again", 20000, async () => (await bo.reported(gigId)) === boWas);
    assert.ok(await bo.evaluate<boolean>(`!!navigator.serviceWorker.controller`), "Bo's page is controlled by its service worker");
    publish(boDir, leeOn === NEW_ID ? newBuild : oldBuild);
    await lee.tap("Update now", ".update-panel");
    await waitFor("Bo's prompt after Lee's tap", 10000, async () => (await bo.prompts()) === 1);
    bo.front.setSlow(NAVIGATION_WAIT_MS + 500);
    try {
      await bo.mark();
      await bo.tap("Update now", ".update-prompt");
      await waitFor("Bo's page to reload", 150_000, () => bo.reloaded());
      await waitFor("Bo's reloaded page to join the gig with no tap", 60_000, async () => (await bo.reported(gigId)) !== "(no join yet)");
      const now = await bo.reported(gigId);
      assert.equal(now, leeOn, `on a slow network the reload lands on the published version, not back on the one Bo had (${js(boWas)})`);
    } finally {
      bo.front.setSlow(0);
    }
    await waitFor("Bo back in the gig with no tap", 20000, () => following(bo));
    assert.equal(await bo.prompts(), 0, "no prompt on the published version");
  });

  // ---- U19 to U22: an Update now that waits for the new service worker, and every way that wait ends ----------------

  const workerHoldsItsPage = `(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    const src = document.querySelector('script[type="module"][src]')?.src;
    return !!r?.active && !r.installing && !r.waiting && !!src && !!(await caches.match(src));
  })()`;
  /** Remembers the page's active worker, so a case can tell when a different one takes charge. */
  const rememberWorker = (page: Page) => page.evaluate<boolean>(`navigator.serviceWorker.getRegistration().then((r) => { window.__leavingWorker = r?.active ?? null; return !!r?.active; })`);
  const newWorkerInstalling = (page: Page) => page.evaluate<boolean>(`navigator.serviceWorker.getRegistration().then((r) => !!r?.installing)`);
  const newWorkerInCharge = (page: Page) =>
    page.evaluate<boolean>(`navigator.serviceWorker.getRegistration().then((r) => !!r?.active && r.active !== window.__leavingWorker && r.active.state === "activated" && !r.installing && !r.waiting)`);
  const boxOf = (page: Page, selector: string) =>
    page.evaluate<{ words: string; buttons: string[] }>(`(() => {
      const box = document.querySelector(${js(selector)});
      return { words: box?.innerText ?? "", buttons: [...(box?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()) };
    })()`);
  const builtAs = (id: unknown) => (id === NEW_ID ? newBuild : oldBuild);
  /** Bo's page runs the version Lee's does not, is answered by its own service worker, and Lee's version is published. */
  const boBehindUnderItsWorker = async () => {
    await leeLeadsWithBoBehind();
    const leeOn = await lee.reported(gigId);
    const boWas = await bo.reported(gigId);
    await bo.evaluate(`navigator.serviceWorker.getRegistration().then((r) => r?.update()).then(() => true, () => false)`);
    await waitFor("Bo's service worker to hold the version Bo's page runs", 30_000, () => bo.evaluate<boolean>(workerHoldsItsPage));
    await bo.mark();
    await bo.site.send("Page.reload", { ignoreCache: false });
    await waitFor("Bo's page to load again under its service worker", 20000, () => bo.reloaded());
    await waitFor("Bo's page to join again", 20000, async () => (await bo.reported(gigId)) === boWas);
    await waitFor("Bo following the gig again", 20000, () => following(bo));
    assert.ok(await bo.evaluate<boolean>(`!!navigator.serviceWorker.controller`), "Bo's page is controlled by its service worker");
    assert.ok(await rememberWorker(bo), "Bo's page has an active service worker");
    publish(boDir, builtAs(leeOn));
    return { leeOn, boWas, spare: precachedSpare(builtAs(leeOn)) };
  };
  /** Lee asks, and Bo taps Update now on the prompt. */
  const boTapsUpdateNow = async () => {
    await lee.tap("Update now", ".update-panel");
    await waitFor("Bo's prompt after Lee's tap", 10000, async () => (await bo.prompts()) === 1);
    await bo.mark();
    await bo.tap("Update now", ".update-prompt");
  };

  await check("U19 Not now while Update now waits", async () => {
    const { leeOn, boWas, spare } = await boBehindUnderItsWorker();
    bo.front.setHeld(spare);
    let waiting = { words: "", buttons: [] as string[] };
    try {
      await boTapsUpdateNow();
      await waitFor("Bo's new service worker to start installing", 20000, () => newWorkerInstalling(bo));
      waiting = await boxOf(bo, ".update-prompt");
      await bo.tap("Not now", ".update-prompt");
      await bo.until(`!document.querySelector(".update-prompt")`, "the prompt to close on Not now");
    } finally {
      bo.front.setHeld(null);
    }
    await waitFor("Bo's new service worker to take charge once its files arrive", 30000, () => newWorkerInCharge(bo));
    await pause(4000);
    assert.ok(!(await bo.reloaded()), "Bo's page did not reload after Bo tapped Not now");
    assert.equal(await bo.reported(gigId), boWas, "Bo's page still runs the version Bo had");
    assert.ok(await following(bo), "Bo still follows the gig");
    assert.equal(await bo.prompts(), 0, "the prompt stays closed");
    await rowReads("Bo", NEEDS, "Bo's row still reads Needs the update");
    assert.ok(waiting.words.includes(GETTING), `while it waits, the prompt says ${GETTING} (${js(waiting.words)})`);
    assert.deepEqual(waiting.buttons, ["Not now"], "while it waits, the prompt offers only Not now: Update now is not shown again (UI rule 3)");
    await boTapsUpdateNow();
    await waitFor("Bo's page to reload on the tap after Not now", 30000, () => bo.reloaded());
    await waitFor("Bo's reloaded page to join the gig with no tap", 30000, async () => (await bo.reported(gigId)) !== "(no join yet)");
    assert.equal(await bo.reported(gigId), leeOn, "the next Update now lands on the published version");
    await waitFor("Bo back in the gig with no tap", 20000, () => following(bo));
  });

  await check("U20 an update that fails to install", async () => {
    const { boWas, spare } = await boBehindUnderItsWorker();
    bo.front.setMissing(spare);
    try {
      await boTapsUpdateNow();
      await bo.until(`(document.querySelector(".update-prompt")?.textContent ?? "").includes(${js(OFFLINE)})`, "the line on Bo's prompt once the new worker fails to install", 30000);
      await pause(3000);
      assert.ok(!(await bo.reloaded()), "Bo's page did not reload onto the old worker");
      assert.equal(await bo.reported(gigId), boWas, "Bo's page still runs the version Bo had");
      assert.equal(await bo.prompts(), 1, "the prompt stays, so Bo can tap again");
      assert.deepEqual((await boxOf(bo, ".update-prompt")).buttons, ["Update now", "Not now"], "Update now is offered again");
      assert.ok(await following(bo), "Bo still follows the gig");
    } finally {
      bo.front.setMissing(null);
    }
    await bo.tap("Not now", ".update-prompt");
  });

  await check("U21 the leader's Reload waits, then gives up", async () => {
    await leeLeadsWithBoBehind();
    const leeOn = await lee.reported(gigId);
    await lee.evaluate(`navigator.serviceWorker.getRegistration().then((r) => r?.update()).then(() => true, () => false)`);
    await waitFor("Lee's service worker to hold the version Lee's page runs", 30_000, () => lee.evaluate<boolean>(workerHoldsItsPage));
    assert.ok(await rememberWorker(lee), "Lee's page has an active service worker");
    const other = leeOn === NEW_ID ? oldBuild : newBuild;
    publish(leeDir, other);
    lee.front.setHeld(precachedSpare(other));
    let busy = { words: "", buttons: [] as string[] };
    let tappedAt = 0;
    try {
      const sockets = await lee.evaluate<number>(`window.__rooms.length`);
      await lee.blink();
      await lee.until(`window.__rooms.slice(${sockets}).some((ws) => ws.readyState === 1 && ws.url.includes("/api/rooms/"))`, "Lee's page to open a new room socket", 20000);
      await lee.until(`(document.querySelector(".update-self")?.textContent ?? "").includes(${js(SELF_FIRST)})`, "Update this phone first on Lee's strip", 20000);
      await lee.mark();
      await lee.tap("Reload", ".update-self");
      tappedAt = Date.now();
      await waitFor("Lee's new service worker to start installing", 20000, () => newWorkerInstalling(lee));
      busy = await boxOf(lee, ".update-self");
      await lee.until(`(document.querySelector(".update-self")?.textContent ?? "").includes(${js(OFFLINE)})`, "the line on Lee's strip once the wait runs out", NEW_WORKER_WAIT_MS + 30_000);
      const waited = Date.now() - tappedAt;
      assert.ok(waited >= NEW_WORKER_WAIT_MS - 1000, `the line comes when the ${NEW_WORKER_WAIT_MS / 1000} s wait runs out, not before (${(waited / 1000).toFixed(1)} s)`);
      assert.ok(!(await lee.reloaded()), "Lee's page did not reload onto the old worker");
      assert.deepEqual((await boxOf(lee, ".update-self")).buttons, ["Reload"], "Reload is offered again");
    } finally {
      lee.front.setHeld(null);
    }
    await waitFor("Lee's new service worker to take charge once its files arrive", 30000, () => newWorkerInCharge(lee));
    await pause(4000);
    assert.ok(!(await lee.reloaded()), "a wait that gave up never reloads later");
    assert.ok(busy.words.includes(GETTING), `while it waits, Lee's strip says ${GETTING} (${js(busy.words)})`);
    assert.deepEqual(busy.buttons, [], "while it waits, Reload is not shown again (UI rule 3)");
  });

  await check("U22 the gig ends while Update now waits", async () => {
    const { boWas, spare } = await boBehindUnderItsWorker();
    bo.front.setHeld(spare);
    try {
      await boTapsUpdateNow();
      await waitFor("Bo's new service worker to start installing", 20000, () => newWorkerInstalling(bo));
      ok(await ada.call("/api/bands/gig/end", { bandId, gigId }), "Ada ends the gig");
      await waitFor("Bo's phone to leave the gig that ended", 30000, async () => !(await following(bo)) && (await bo.prompts()) === 0);
    } finally {
      bo.front.setHeld(null);
    }
    await waitFor("Bo's new service worker to take charge once its files arrive", 30000, () => newWorkerInCharge(bo));
    await pause(4000);
    assert.ok(!(await bo.reloaded()), "Bo's page did not reload after the gig ended");
    assert.equal(await bo.reported(gigId), boWas, "Bo's page still runs the version Bo had");
  });
} catch (error) {
  failed += 1;
  console.log(`FAIL setup: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  for (const sock of socks) await sock.close().catch(() => {});
  for (const step of cleanups.reverse()) await Promise.resolve(step()).catch(() => {});
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10 });
  rmSync(blank, { recursive: true, force: true, maxRetries: 10 });
}

console.log(`check:update-now took ${((Date.now() - started) / 1000).toFixed(0)} s`);
process.exit(failed ? 1 : 0);
