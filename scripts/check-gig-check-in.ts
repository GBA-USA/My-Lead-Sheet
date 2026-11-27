import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { passwordKey } from "../src/password.ts";
import { startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/**
 * Gig check-in (plan 6, third cook): before a gig the leader confirms Tonight's players; once it is live the leader and
 * the band's admins see each lineup player Connected, Not connected or Not synced, from one roster message the Room
 * pushes on its socket. Cases K1 to K18, one per pass condition, named by it.
 *
 * The contract these cases fix:
 * - Phone to Room: `{ kind: "roster-ask", gigId }`, and the heartbeat, the fixed text frame `beat`.
 * - Room to phone: `{ kind: "roster", gigId, packRev, rows: { userId, connected, packRev }[] }`, one row per lineup
 *   player, only to the sockets of the player leading now and of the band's admins.
 * - `src/gig-check-in-model.ts` exports `rosterRows(lineup, sockets, receipts, now)` with a socket
 *   `{ userId, lastBeat: number | null }` and a receipt `{ userId, packRev, at }`, `checkInOf(row, packRev)` and
 *   `notReady(rows, packRev, except)`.
 * - On the gig view, `button` "Tonight's players" opens `[role=dialog].tonight-sheet`: one `.tonight-row` per band
 *   member with `.tonight-name`; a row that may change has an `input[type=checkbox]`, the leader's row is
 *   `.tonight-row.is-fixed` with no input and an `aria-label`. "Save" saves; `.tonight-line` says why the list is read-only.
 * - Band status rows (`.band-status-row`) carry the check-in word in `.band-status-route` and its reason in
 *   `.band-status-why`; a kept copy marks rows `.band-status-old` and says `.band-status-line` "Can't reach the band…".
 * - The leader's warning is `.check-in-warning` under the strip: "<n> not ready", a "See who" button that opens Band
 *   status, and a "Dismiss for tonight" (aria-label) button.
 */

type Json = Record<string, any>;
type Reply = { status: number; body: Json };
type Row = { userId: string; connected: boolean; packRev: number | null };
type Roster = { kind: "roster"; gigId: string; packRev: number; rows: Row[] };

const root = fileURLToPath(new URL("..", import.meta.url));
const js = (value: unknown) => JSON.stringify(value);
const PASSWORD = "violet tram 42 lantern";
const SHAPE = { "X-Song-Shape": "chordpro" };
const BEAT = "beat";
const BEAT_EVERY_MS = 3000;
const WIDTH = 360;
const SHOTS = process.env.GIG_CHECK_IN_SHOTS ?? "";
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const newGigId = () => `gig_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;
const newPassId = () => `pass_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;
const today = () => {
  const day = new Date();
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};

const NEVER = "Has not downloaded tonight's set";
const OLDER = "Has an older set. They need to download again.";
const LIVE_LINE = "Only an admin can change the lineup once the gig is live.";
const SHEET = "[role=dialog].band-status-sheet";
const TONIGHT = "[role=dialog].tonight-sheet";
const WARNING = ".check-in-warning";

let failed = 0;
/** A debugging run may name some cases, `GIG_CHECK_IN_CASES=K10,K9`; the registered check runs every case. */
const ONLY = (process.env.GIG_CHECK_IN_CASES ?? "").split(",").filter(Boolean);
let whereNow: () => Promise<string> = async () => "";
async function check(name: string, run: () => Promise<void>) {
  if (ONLY.length && !ONLY.includes(name.split(" ")[0])) return;
  const t0 = Date.now();
  try {
    await run();
    console.log(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`     the phone was at ${await whereNow().catch(() => "?")}`);
  } finally {
    await cleanUp();
  }
}
/** Set once the players exist: closes the case's sockets and ends the gigs it started, pass or fail. */
let cleanUp: () => Promise<void> = async () => {};
/** A case that leaves its live gig to the next case (K10 to K9) sets this, and the cleanup after it skips once. */
let handOver = false;

/** Polls `probe` until it gives a value, for at most `ms`. The failure names what was waited for and the bound. */
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
    if (Date.now() > end) throw new Error(`${what}: not within ${ms / 1000} s${last ? ` (${last instanceof Error ? last.message : String(last)})` : ""}`);
    await pause(50);
  }
}

// ---- K17, the rule on its own: 500 seeded histories against an oracle written here ----------------------------

const MODEL = join(root, "src", "gig-check-in-model.ts");

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

type Socket = { userId: string; lastBeat: number | null };
type Receipt = { userId: string; packRev: number; at: number };

/** The rule as the brief words it: one row per lineup player in lineup order, connected when a socket of theirs never beat or beat within 10 s, and the pack rev of their newest receipt. */
function oracle(lineup: string[], sockets: Socket[], receipts: Receipt[], now: number): Row[] {
  const rows: Row[] = [];
  for (const id of lineup) {
    if (rows.some((row) => row.userId === id)) continue;
    let connected = false;
    for (const socket of sockets) if (socket.userId === id && (socket.lastBeat === null || now - socket.lastBeat <= 10_000)) connected = true;
    let newest: Receipt | null = null;
    for (const receipt of receipts) if (receipt.userId === id && (newest === null || receipt.at > newest.at || (receipt.at === newest.at && receipt.packRev > newest.packRev))) newest = receipt;
    rows.push({ userId: id, connected, packRev: newest ? newest.packRev : null });
  }
  return rows;
}

/** One random history for a lineup of four: joins, closes, beats that stop and resume, receipts, a lineup change, and a second phone for one player. */
function history(seed: number) {
  const random = mulberry(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const people = ["p0", "p1", "p2", "p3", "p4", "p5"];
  let lineup = people.slice(0, 4);
  const open: { userId: string; lastBeat: number | null; beating: boolean }[] = [];
  const receipts: Receipt[] = [];
  let rev = 1;
  let t = 1_000_000;
  const twoPhones = pick(lineup);
  const steps = 5 + Math.floor(random() * 40);
  for (let step = 0; step < steps; step += 1) {
    t += 1000 * Math.floor(random() * 6);
    const roll = random();
    if (roll < 0.25) open.push({ userId: pick(people), lastBeat: null, beating: random() < 0.7 });
    else if (roll < 0.32 && open.length) open.splice(Math.floor(random() * open.length), 1);
    else if (roll < 0.5) for (const socket of open) if (socket.beating) socket.lastBeat = t;
    else if (roll < 0.58 && open.length) pick(open).beating = !pick(open).beating;
    else if (roll < 0.72) receipts.push({ userId: pick(people), packRev: 1 + Math.floor(random() * rev), at: t });
    else if (roll < 0.76) {
      const out = pick(lineup);
      lineup = [...lineup.filter((id) => id !== out), pick(people.filter((id) => !lineup.includes(id)))];
      rev += 1;
    } else if (roll < 0.82) open.push({ userId: twoPhones, lastBeat: random() < 0.5 ? null : t, beating: true });
    else if (roll < 0.86) lineup = [...lineup, pick(lineup)];
  }
  const now = t + 1000 * Math.floor(random() * 14);
  return { lineup, sockets: open.map(({ userId, lastBeat }) => ({ userId, lastBeat })), receipts, now, rev };
}

async function k17() {
  if (!existsSync(MODEL)) throw new Error("src/gig-check-in-model.ts is not there yet");
  const model = (await import(pathToFileURL(MODEL).href)) as {
    rosterRows: (lineup: string[], sockets: Socket[], receipts: Receipt[], now: number) => Row[];
    checkInOf: (row: Row, packRev: number) => { kind: string; why?: string };
    notReady: (rows: Row[], packRev: number, except: string | null) => number;
  };
  for (let seed = 1; seed <= 500; seed += 1) {
    const { lineup, sockets, receipts, now } = history(seed);
    const got = model.rosterRows(lineup, sockets, receipts, now);
    try {
      assert.deepEqual(got, oracle(lineup, sockets, receipts, now));
    } catch {
      throw new Error(`seed ${seed}: rosterRows ${js(got)} but the rule says ${js(oracle(lineup, sockets, receipts, now))} for ${js({ lineup, sockets, receipts, now })}`);
    }
  }
  const row = (connected: boolean, packRev: number | null): Row => ({ userId: "p1", connected, packRev });
  assert.deepEqual(model.checkInOf(row(true, 3), 3), { kind: "connected" }, "connected with tonight's pack is Connected");
  assert.deepEqual(model.checkInOf(row(false, 3), 3), { kind: "not-connected" }, "no fresh socket is Not connected, whatever pack they hold");
  assert.deepEqual(model.checkInOf(row(true, null), 3), { kind: "not-synced", why: "never" }, "connected with no receipt is Not synced, never downloaded");
  assert.deepEqual(model.checkInOf(row(true, 2), 3), { kind: "not-synced", why: "older" }, "connected with an older rev is Not synced, older");
  const rows: Row[] = [
    { userId: "lead", connected: true, packRev: 2 },
    { userId: "a", connected: true, packRev: 3 },
    { userId: "b", connected: false, packRev: 3 },
    { userId: "c", connected: true, packRev: null },
  ];
  assert.equal(model.notReady(rows, 3, "lead"), 2, "the leader's own row is not counted; b and c are not ready");
}

// ---- The Worker, the band, and the players ----------------------------------------------------------------------

let apiBase = "";
const site = await openSite(root, "check-gig-check-in", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;

const bundled = await build({
  stdin: { contents: 'export { startGig, reduce } from "./src/gig-state.ts"; export { statusRows, panelLine, livePlayers } from "./src/band-status-model.ts";', resolveDir: root, loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const phone = (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`)) as typeof import("../src/gig-state.ts") & typeof import("../src/band-status-model.ts");

async function player(name: string, handle: string) {
  const made = await passwordPlayer(base, origin, name, handle);
  const call = made.call.bind(made);
  made.call = (path, body, headers = {}) => call(path, body, { ...SHAPE, ...headers });
  const salt = (await made.call("/api/auth/password/salt", { handle })).body.salt as string;
  return Object.assign(made, { key: await passwordKey(PASSWORD, salt) });
}
type Player = Awaited<ReturnType<typeof player>>;

const ok = (reply: Reply, what: string) => {
  assert.equal(reply.status, 200, `${what} (${reply.status} ${js(reply.body)})`);
  return reply.body;
};

/** One real socket to the real Room, as a phone on another build or a phone the check drives by hand. */
class Sock {
  heard: Json[] = [];
  closeCode: number | null = null;
  lastBeatAt: number | null = null;
  private beats: ReturnType<typeof setInterval> | null = null;
  readonly who: Player;
  readonly ws: WebSocket;
  private constructor(who: Player, ws: WebSocket) {
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
    ws.addEventListener("close", (event) => {
      this.closeCode = event.code;
      this.stopBeats();
    });
  }

  static async open(who: Player, bandId: string) {
    const ws = new WebSocket(who.socketUrl(bandId), { headers: { origin, cookie: who.cookie } } as unknown as string[]);
    const sock = new Sock(who, ws);
    await waitFor(`${who.name}'s socket greeted by the Room`, 5000, () => sock.heard.some((m) => m.kind === "hello") || sock.closeCode !== null);
    assert.equal(sock.closeCode, null, `${who.name}'s socket stays open`);
    return sock;
  }

  send(message: object) {
    this.ws.send(js(message));
  }

  async join(gigId: string) {
    this.send({ kind: "join-gig", gigId });
    await waitFor(`${this.who.name}'s join answered`, 5000, () => this.heard.some((m) => m.kind === "gig" && m.gigId === gigId) || this.closeCode !== null);
    return this;
  }

  beat() {
    this.ws.send(BEAT);
    this.lastBeatAt = Date.now();
  }

  startBeats() {
    this.stopBeats();
    this.beat();
    this.beats = setInterval(() => this.ws.readyState === WebSocket.OPEN && this.beat(), BEAT_EVERY_MS);
  }

  stopBeats() {
    if (this.beats) clearInterval(this.beats);
    this.beats = null;
  }

  rosters(gigId: string): Roster[] {
    return this.heard.filter((m) => m.kind === "roster" && m.gigId === gigId) as unknown as Roster[];
  }

  latest(gigId: string): Roster | undefined {
    return this.rosters(gigId).at(-1);
  }

  async close() {
    this.stopBeats();
    if (this.closeCode !== null) return;
    this.ws.close();
    await waitFor(`${this.who.name}'s socket closed`, 5000, () => this.closeCode !== null);
  }
}

const sockets: Sock[] = [];
const openSock = async (who: Player, bandId: string) => {
  const sock = await Sock.open(who, bandId);
  sockets.push(sock);
  return sock;
};
/** The gigs a case started. Each case ends its own, so a gig left live by a failed case shadows no later case's strip. */
const started: { bandId: string; gigId: string }[] = [];
const closeAll = async () => {
  for (const sock of sockets.splice(0)) await sock.close().catch(() => {});
  for (const gig of started.splice(0)) await ada.call("/api/bands/gig/end", gig).catch(() => {});
};

/** Waits until the newest roster on `sock` has `who`'s row reading `connected`. */
const reads = (sock: Sock, gigId: string, who: Player, connected: boolean, ms: number, what: string) =>
  waitFor(what, ms, () => {
    const row = sock.latest(gigId)?.rows.find((item) => item.userId === who.userId);
    return row && row.connected === connected ? sock.latest(gigId)! : null;
  });

/** Every roster `sock` heard for the gig has exactly one row for `who`. */
const oneRow = (sock: Sock, gigId: string, who: Player) => {
  for (const roster of sock.rosters(gigId)) assert.equal(roster.rows.filter((row) => row.userId === who.userId).length, roster.rows.some((row) => row.userId === who.userId) ? 1 : 0, `one row for ${who.name} in ${js(roster.rows)}`);
};

/** Asks the Room for the roster and waits for the answer, so a case reads the Room's view now, not the last push. */
async function askRoster(sock: Sock, gigId: string, what: string) {
  const before = sock.rosters(gigId).length;
  sock.send({ kind: "roster-ask", gigId });
  await waitFor(what, 5000, () => sock.rosters(gigId).length > before);
  return sock.latest(gigId)!;
}

const ada = await player("Ada Lowe", "adalowe");
const lee = await player("Lee O'Brien", "leeobrien");
const bo = await player("Bo Hart", "bohart");
const mo = await player("Mo Diaz", "modiaz");
const ray = await player("Ray Quill", "rayquill");
const gus = await player("Gus Vale", "gusvale");
cleanUp = async () => {
  if (handOver) {
    handOver = false;
    return;
  }
  const pageGigs = started.length > 0;
  await closeAll();
  if (pageGigs) await letGo().catch(() => {});
};
const rex = await player("Rex Moon", "rexmoon");

const SONGS = [
  "{title: Porch Light Waltz}\n{artist: The Late Shift}\n{key: G}\n{tempo: 92}\n[G]Porch light [C]on, the [D]screen door [G]sings",
  "{title: Cold Brew Shuffle}\n{artist: The Late Shift}\n{key: A}\n{tempo: 118}\n[A]Up before the [D]sun, the [E]kettle's [A]done",
];

/** A band of five made-up accounts: Ada the admin, Lee who leads, Bo the backup, Mo, and Ray, who is in the band but not on tonight's lineup. */
async function newBand(name: string, extra: Player[] = []) {
  const bandId = ok(await ada.call("/api/bands/create", { name }), `Ada makes ${name}`).bandId as string;
  const code = ok(await ada.call("/api/codes", { kind: "band", bandId }), "Ada's invite").code as string;
  for (const who of [lee, bo, mo, ray, ...extra]) ok(await who.call("/api/bands/join", { code }), `${who.name} joins ${name}`);
  const songIds: string[] = [];
  for (const chordpro of SONGS) songIds.push(ok(await ada.call("/api/bands/library/share-song", { bandId, song: { chordpro }, choice: "public", localId: null }), "Ada shares a song").songId);
  const setlistId = ok(await ada.call("/api/bands/library/share-setlist", { bandId, name: "Tonight", songIds, tags: [], choice: "public", localId: null }), "Ada shares the set").setlistId as string;
  return { bandId, setlistId };
}
type Band = Awaited<ReturnType<typeof newBand>>;

async function planGig(band: Band, name: string, lineup = [ada, lee, bo, mo]) {
  return ok(
    await ada.call("/api/bands/gig/plan", { ...band, gigId: newGigId(), name, date: today(), lineup: lineup.map((who) => who.userId), leader: lee.userId, backup: bo.userId }),
    `Ada plans ${name} with Lee leading and Bo as backup`,
  ).gig.gigId as string;
}

const gigOf = async (band: Band, gigId: string) => ok(await ada.call("/api/bands/gig/open", { bandId: band.bandId, gigId }), "Ada reads the gig");
const packFor = (who: Player, band: Band, gigId: string) => who.call("/api/bands/gig/pack", { bandId: band.bandId, gigId }).then((reply) => ok(reply, `${who.name} downloads tonight's set`));

/** Lee's socket starts the gig the way the leader's phone does, and stays open as the leader's phone. */
async function startBySocket(band: Band, gigId: string) {
  const view = await gigOf(band, gigId);
  const sock = await openSock(lee, band.bandId);
  await sock.join(gigId);
  const now = Date.now();
  const state = phone.startGig({ gigId, order: view.songIds, leader: lee.userId, admin: ada.userId, backup: view.gig.backup, lineup: view.gig.lineup, route: view.gig.route, scrollAlong: true, now: now as never });
  sock.send({ kind: "gig-start", state, at: now });
  await waitFor("the gig to go live", 5000, async () => (await gigOf(band, gigId)).gig.status === "live");
  started.push({ bandId: band.bandId, gigId });
  return Object.assign(sock, { state });
}

const endGig = (band: Band, gigId: string) => ada.call("/api/bands/gig/end", { bandId: band.bandId, gigId });

// ---- The leader's phone: headless Chrome at 360 px ------------------------------------------------------------

const app = await appPage(site);
await site.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 780, deviceScaleFactor: 2, mobile: true });
await site.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.__calls = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      try { window.__calls.push({ path: new URL(typeof input === "string" ? input : input.url, location.href).pathname, body: init && typeof init.body === "string" ? init.body : null }); } catch {}
      return realFetch(input, init);
    };
    const Real = window.WebSocket;
    window.__rooms = [];
    window.__sent = [];
    window.__got = [];
    window.__roomsDown = false;
    class Watched extends Real {
      constructor(url, protocols) {
        super(window.__roomsDown && String(url).includes("/api/rooms/") ? "ws://127.0.0.1:9/" : url, protocols);
        window.__rooms.push(this);
        this.addEventListener("message", (event) => { if (typeof event.data === "string") window.__got.push(event.data.slice(0, 300)); });
      }
      send(data) {
        window.__sent.push(String(data).slice(0, 300));
        return super.send(data);
      }
    }
    window.WebSocket = Watched;
  })();`,
});

const evaluate = <T>(expression: string) => site.evaluate<T>(expression);
whereNow = () => evaluate<string>(`location.hash + " · " + (document.querySelector(".app")?.innerText ?? "").replace(/\\s+/g, " ").slice(0, 240)`);
const has = (selector: string) => evaluate<boolean>(`!!document.querySelector(${js(selector)})`);
const texts = (selector: string) => evaluate<string[]>(`[...document.querySelectorAll(${js(selector)})].map((el) => el.textContent.trim())`);
const until = (expression: string, what: string, ms = 8000) => waitFor(what, ms, () => evaluate<boolean>(expression));
const clickButton = async (text: string, scope = "document") => {
  const clicked = await evaluate<boolean>(`(() => { const el = [...(${scope}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === ${js(text)}); el?.click(); return !!el; })()`);
  assert.ok(clicked, `a ${text} button to tap`);
};
const shot = async (name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ["dark", "day"]) {
    await evaluate(`document.documentElement.dataset.theme = ${js(theme === "dark" ? "" : theme)}; if (!document.documentElement.dataset.theme) delete document.documentElement.dataset.theme;`);
    await pause(150);
    writeFileSync(join(SHOTS, `${name}-${theme === "dark" ? "dark" : "light"}.png`), Buffer.from((await site.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  }
  await evaluate(`delete document.documentElement.dataset.theme`);
};

let pageAccount: Player | null = null;
/** Signs the phone in as `who` with their password, then loads the app fresh, as opening it again would. */
async function pageAs(who: Player | null) {
  await evaluate(`fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json", "X-Song-Shape": "chordpro" }, body: "{}" }).then((r) => r.status)`);
  if (who) {
    const status = await evaluate<number>(
      `fetch("/api/auth/password/sign-in", { method: "POST", headers: { "content-type": "application/json", "X-Song-Shape": "chordpro" }, body: ${js(js({ handle: who.handle, key: who.key }))} }).then((r) => r.status)`,
    );
    assert.equal(status, 200, `${who.name} signs in on the phone`);
  }
  // The app's own sign-in leaves this mark, so a fresh load asks the server who is signed in.
  await evaluate(who ? `localStorage.setItem("leadSheetsSignedIn", ${js(who.userId)})` : `localStorage.removeItem("leadSheetsSignedIn")`);
  pageAccount = who;
  await evaluate(`location.hash = "#/songs"`);
  await site.send("Page.reload", { ignoreCache: false });
  await waitFor("the app to load again", 15000, () => evaluate<boolean>(`!!document.querySelector(".shell-header")`));
  if (who) await waitFor(`the phone to be ${who.name}'s`, 10000, async () => (await evaluate<Json>(`fetch("/api/me").then((r) => r.json())`)).account?.userId === who.userId);
}

const go = async (hash: string, ready: string, what: string) => {
  await evaluate(`location.hash = ${js(hash)}`);
  await until(ready, what, 15000);
};
const gigView = (gigId: string) => `document.querySelector(${js(`.gig-view[data-gig="${gigId}"]`)})`;
const openGigScreen = (band: Band, gigId: string) => go(`#/gig/${band.bandId}/${gigId}`, `!!${gigView(gigId)} && !${gigView(gigId)}.textContent.includes("Loading")`, "the gig's screen");
const openBandPage = async (band: Band) => {
  await go("#/songs", `!document.querySelector(".band-page")`, "off the band page");
  await go(`#/band/${band.bandId}`, `!!document.querySelector(${js(`.band-page[data-band="${band.bandId}"]`)})`, "the band page");
};
const visibleAgain = () => evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);

/** Lee's phone on the gig's screen: downloads tonight's set, holds Start, answers the click question if asked, and comes back to the gig's screen. */
async function leaderStarts(band: Band, gigId: string) {
  await openGigScreen(band, gigId);
  if (await evaluate<boolean>(`[...${gigView(gigId)}.querySelectorAll("button")].some((b) => b.textContent.trim() === "Get ready")`)) {
    await clickButton("Get ready", gigView(gigId));
    await until(`!!${gigView(gigId)}?.querySelector(".gig-count")`, "tonight's set on Lee's phone", 15000);
  }
  await until(`[...document.querySelectorAll(".gig-strip button")].some((b) => b.textContent.trim() === "Hold to start the gig")`, "Hold to start on Lee's strip", 15000);
  await evaluate(`[...document.querySelectorAll(".gig-strip button")].find((b) => b.textContent.trim() === "Hold to start the gig").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  await waitFor("Lee's start to go through", 10000, async () => {
    if (await has(".gig-question")) await evaluate(`document.querySelectorAll(".gig-question button")[1].click()`);
    return (await gigOf(band, gigId)).gig.status === "live";
  });
  started.push({ bandId: band.bandId, gigId });
  await openGigScreen(band, gigId);
}

/** The leader ends tonight's gig from the server, and the phone lets it go. */
async function endPageGig(band: Band, gigId: string) {
  await endGig(band, gigId);
  await openGigScreen(band, gigId).catch(() => {});
  await letGo();
}
/** The phone hears that its gigs have ended and closes the strip. */
async function letGo() {
  for (const end = Date.now() + 20000; ; await pause(1000)) {
    await visibleAgain();
    await pause(300);
    if (await evaluate<boolean>(`(() => { const b = document.querySelector(".gig-strip [aria-label=Close]"); b?.click(); return !document.querySelector(".gig-strip"); })()`)) return;
    if (Date.now() > end) throw new Error("the phone to leave the ended gig: not within 20 s");
  }
}

type PanelRow = { name: string; word: string; why: string; old: boolean; height: number };
const panelRows = () =>
  evaluate<PanelRow[]>(
    `[...document.querySelectorAll(${js(`${SHEET} .band-status-row`)})].map((row) => ({ name: row.querySelector(".band-status-name")?.textContent.trim() ?? "", word: row.querySelector(".band-status-route")?.textContent.trim() ?? "", why: row.querySelector(".band-status-why")?.textContent.trim() ?? "", old: row.classList.contains("band-status-old"), height: row.getBoundingClientRect().height }))`,
  );
const rowFor = (rows: PanelRow[], who: Player) => rows.find((row) => row.name === who.name);
const openPanel = async () => {
  if (await has(SHEET)) return;
  await until(`!!document.querySelector(".gig-view .band-status-slot button.band-status-face")`, "a face Lee can tap on the gig's screen");
  await evaluate(`document.querySelector(".gig-view .band-status-slot button.band-status-face").click()`);
  await until(`!!document.querySelector(${js(SHEET)})`, "Band status to open");
};
const closePanel = async () => {
  await evaluate(`document.querySelector(${js(`${SHEET} [aria-label=Close]`)})?.click()`);
  await until(`!document.querySelector(${js(SHEET)})`, "Band status to close");
};
/** Waits until Band status shows each named player with the given word (and reason, when given). */
const panelReads = (want: [Player, string, string?][], ms: number, what: string) =>
  waitFor(what, ms, async () => {
    const rows = await panelRows();
    return want.every(([who, word, why]) => rowFor(rows, who)?.word === word && (why === undefined || rowFor(rows, who)?.why === why)) ? rows : null;
  });
const warningText = () => evaluate<string>(`document.querySelector(${js(WARNING)})?.textContent.trim() ?? ""`);
const warningSays = (count: number, ms: number, what: string) => waitFor(what, ms, async () => (await warningText()).includes(`${count} not ready`));
const lineupCalls = () => evaluate<number>(`window.__calls.filter((c) => c.path === "/api/bands/gig/lineup").length`);

const openTonight = async (gigId: string) => {
  await until(`[...(${gigView(gigId)}?.querySelectorAll("button") ?? [])].some((b) => b.textContent.trim() === "Tonight's players")`, "a Tonight's players button on the gig's screen");
  await clickButton("Tonight's players", gigView(gigId));
  await until(`!!document.querySelector(${js(TONIGHT)})`, "Tonight's players to open");
};
type TonightRow = { name: string; ticked: boolean; fixed: boolean; box: boolean; label: string; height: number };
const tonightRows = () =>
  evaluate<TonightRow[]>(
    `[...document.querySelectorAll(${js(`${TONIGHT} .tonight-row`)})].map((row) => { const box = row.querySelector("input[type=checkbox]"); return { name: row.querySelector(".tonight-name")?.textContent.trim() ?? "", ticked: box ? box.checked : row.classList.contains("is-fixed"), fixed: row.classList.contains("is-fixed"), box: !!box, label: box ? ([...(box.labels ?? [])].map((l) => l.textContent.trim()).join(" ") || box.getAttribute("aria-label") || "") : row.getAttribute("aria-label") ?? "", height: row.getBoundingClientRect().height }; })`,
  );
const tick = (who: Player) =>
  evaluate(`[...document.querySelectorAll(${js(`${TONIGHT} .tonight-row`)})].find((row) => row.querySelector(".tonight-name")?.textContent.trim() === ${js(who.name)}).querySelector("input[type=checkbox]").click()`);

try {
  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await app.library();
  await pageAs(lee);

  await check("K17 the rule, 500 histories: rosterRows matches the oracle on 500 seeded histories", async () => {
    try {
      await k17();
    } catch (error) {
      if (!existsSync(MODEL)) throw new Error("src/gig-check-in-model.ts is not there yet");
      throw error;
    }
  });

  // ---- Cases about what the Room sends: real sockets, Lee's socket leading -------------------------------------

  await check("K8 the server decides who gets the roster and who may change the lineup", async () => {
    const band = await newBand("Server Night", [rex]);
    const gigId = await planGig(band, "Server night", [ada, lee, bo, mo, rex]);
    const passId = newPassId();
    const pass = ok(await ada.call("/api/bands/guests/create", { bandId: band.bandId, gigId, passId, name: "Gus", expiresAt: Date.now() + 86_400_000, canSeeChat: false, canSeeSetlists: false }), "Ada makes Gus a guest pass");
    ok(await gus.call("/api/guest/claim", { code: pass.code }), "Gus claims the pass");
    const leader = await startBySocket(band, gigId);
    const member = await (await openSock(mo, band.bandId)).join(gigId);
    const backup = await (await openSock(bo, band.bandId)).join(gigId);
    const removed = await (await openSock(rex, band.bandId)).join(gigId);
    const guest = await (await openSock(gus, band.bandId)).join(gigId);
    assert.equal(guest.closeCode, null, "Gus's socket is in the gig on his pass");
    const admin = await (await openSock(ada, band.bandId)).join(gigId);
    const joinedAt = Date.now();
    await reads(leader, gigId, ada, true, 5000, "Lee's roster reads Ada Connected within 5 s of her join");
    await waitFor("Ada, the admin, receives the roster too", 5000, () => admin.rosters(gigId).length > 0);
    const shape = leader.latest(gigId)!;
    assert.deepEqual(Object.keys(shape).sort(), ["gigId", "heardAt", "kind", "packRev", "rows"], "the roster carries the gig, its pack rev and the rows, nothing else");
    for (const row of shape.rows) assert.deepEqual(Object.keys(row).sort(), ["connected", "packRev", "userId"], "a row is a user id, connected and a pack rev: no name, handle or socket id");
    await pause(Math.max(0, joinedAt + 3000 - Date.now()));
    for (const sock of [member, backup, removed, guest]) assert.equal(sock.rosters(gigId).length, 0, `${sock.who.name}'s socket receives no roster in the 3 s after Ada joins`);
    for (const sock of [member, backup, guest]) sock.send({ kind: "roster-ask", gigId });
    await askRoster(leader, gigId, "Lee's own ask answered after the others asked");
    const askedAt = Date.now();
    await pause(Math.max(0, askedAt + 2000 - Date.now()));
    assert.equal(member.rosters(gigId).length, 0, "Mo, a plain lineup member, is not answered when he asks");
    assert.equal(backup.rosters(gigId).length, 0, "Bo, the backup, is not answered while Lee leads");
    assert.equal(guest.rosters(gigId).length, 0, "Gus, a guest with a pass, is not answered");

    ok(await ada.call("/api/bands/remove", { bandId: band.bandId, userId: rex.userId }), "Ada removes Rex from the band");
    await waitFor("Rex's socket closed by the Room", 5000, () => removed.closeCode !== null);
    assert.equal(removed.rosters(gigId).length, 0, "Rex, removed, received no roster");
    await waitFor("Lee's roster drops Rex's row", 5000, () => leader.latest(gigId) && !leader.latest(gigId)!.rows.some((row) => row.userId === rex.userId));

    const refused = await mo.call("/api/bands/gig/lineup", { bandId: band.bandId, gigId, lineup: [ada.userId, lee.userId, mo.userId] });
    assert.deepEqual([refused.status, refused.body.error], [403, "not-allowed"], "Mo's lineup request is refused not-allowed");
    const leaderLive = await lee.call("/api/bands/gig/lineup", { bandId: band.bandId, gigId, lineup: [ada.userId, lee.userId, bo.userId] });
    assert.deepEqual([leaderLive.status, leaderLive.body.error], [403, "not-allowed"], "Lee's lineup request on the live gig is refused");
    await openGigScreen(band, gigId);
    await openTonight(gigId);
    await until(`(document.querySelector(${js(`${TONIGHT} .tonight-line`)})?.textContent ?? "").includes(${js(LIVE_LINE)})`, "the line that only an admin can change a live lineup");
    assert.ok(!(await has(`${TONIGHT} [role=alert]`)), "the leader's screen shows the line, not an error");
    assert.ok(!(await has(`${TONIGHT} input[type=checkbox]`)), "and no ticks to change");
    await evaluate(`document.querySelector(${js(`${TONIGHT} [aria-label=Close]`)}).click()`);
    ok(await ada.call("/api/bands/gig/lineup", { bandId: band.bandId, gigId, lineup: [ada.userId, lee.userId, bo.userId, mo.userId, ray.userId] }), "Ada's lineup change on the live gig still works");

    const now = Date.now();
    const taken = phone.reduce(leader.state, { opId: `bo-${now}`, epoch: leader.state.epoch, kind: "takeOver" } as never, { by: bo.userId, now: now as never, lead: 0 });
    assert.ok(taken.ok, `Bo may take over (${js(taken)})`);
    backup.send({ kind: "gig-op", op: { opId: `bo-${now}`, epoch: leader.state.epoch, kind: "takeOver" }, state: taken.state, at: now });
    await waitFor("the Room to pass Bo's take-over to Lee", 5000, () => leader.heard.some((m) => m.kind === "gig-state" && m.state?.leader === bo.userId));
    await askRoster(backup, gigId, "Bo's ask answered once he leads");
    await endGig(band, gigId);
    await closeAll();
  });

  await check("K6 drops out and comes back: Not connected within 5 s of a close, Connected again by itself, one row", async () => {
    const band = await newBand("Drop Night");
    const gigId = await planGig(band, "Drop night");
    const leader = await startBySocket(band, gigId);
    const first = await (await openSock(mo, band.bandId)).join(gigId);
    await reads(leader, gigId, mo, true, 5000, "Mo Connected within 5 s of his join");
    await first.close();
    await reads(leader, gigId, mo, false, 5000, "Mo Not connected within 5 s of his socket closing");
    const again = await (await openSock(mo, band.bandId)).join(gigId);
    await reads(leader, gigId, mo, true, 5000, "Mo Connected again within 5 s, with nothing from Lee");
    const quick = await (await openSock(mo, band.bandId)).join(gigId);
    await again.close();
    const settled = await askRoster(leader, gigId, "Lee's ask after a join and a close in quick succession");
    assert.equal(settled.rows.find((row) => row.userId === mo.userId)?.connected, true, "Mo is still Connected on his newest socket");
    oneRow(leader, gigId, mo);
    await quick.close();
    await endGig(band, gigId);
    await closeAll();
  });

  await check("K11 one player, two phones: one row, Connected while either is open", async () => {
    const band = await newBand("Two Phones");
    const gigId = await planGig(band, "Two phones");
    const leader = await startBySocket(band, gigId);
    const pocket = await (await openSock(bo, band.bandId)).join(gigId);
    const stand = await (await openSock(bo, band.bandId)).join(gigId);
    await reads(leader, gigId, bo, true, 5000, "Bo Connected within 5 s");
    await pocket.close();
    const one = await askRoster(leader, gigId, "Lee's ask after Bo's first phone closes");
    assert.equal(one.rows.find((row) => row.userId === bo.userId)?.connected, true, "Bo is Connected while his second phone is open");
    await stand.close();
    await reads(leader, gigId, bo, false, 5000, "Bo Not connected within 5 s of both phones closing");
    oneRow(leader, gigId, bo);
    await endGig(band, gigId);
    await closeAll();
  });

  await check("K14 a silent phone: Not connected within 15 s of its last beat, Connected again when it beats, one row", async () => {
    const band = await newBand("Silent Night");
    const gigId = await planGig(band, "Silent night");
    const leader = await startBySocket(band, gigId);
    const silent = await (await openSock(mo, band.bandId)).join(gigId);
    silent.startBeats();
    await reads(leader, gigId, mo, true, 5000, "Mo Connected within 5 s");
    await waitFor("three of Mo's beats sent", 10000, () => silent.lastBeatAt !== null && Date.now() - (silent.heard.find((m) => m.kind === "gig")?.heardAt ?? Date.now()) > 2 * BEAT_EVERY_MS);
    silent.stopBeats();
    const lastBeat = silent.lastBeatAt!;
    await reads(leader, gigId, mo, false, 15000 - (Date.now() - lastBeat), "Mo Not connected within 15 s of his last beat, his socket still open");
    assert.equal(silent.closeCode, null, "Mo's socket never closed");
    silent.startBeats();
    await reads(leader, gigId, mo, true, 10000, "Mo Connected within 10 s of his beats resuming, with nothing from Lee");
    oneRow(leader, gigId, mo);
    await endGig(band, gigId);
    await closeAll();
  });

  await check("K15 a quiet roster: no roster on Lee's socket in 30 quiet seconds, then one join brings exactly one", async () => {
    const band = await newBand("Quiet Night");
    const gigId = await planGig(band, "Quiet night");
    const leader = await startBySocket(band, gigId);
    const players = [await (await openSock(ada, band.bandId)).join(gigId), await (await openSock(bo, band.bandId)).join(gigId)];
    for (const sock of players) sock.startBeats();
    await reads(leader, gigId, bo, true, 5000, "Bo Connected within 5 s");
    await reads(leader, gigId, ada, true, 5000, "Ada Connected within 5 s");
    const quietFrom = leader.rosters(gigId).length;
    await pause(30_000);
    const quiet = leader.rosters(gigId).length - quietFrom;
    console.log(`     count: ${quiet} roster messages on Lee's socket in 30 quiet seconds`);
    assert.equal(quiet, 0, "nothing changed, so nothing was sent");
    const joinFrom = leader.rosters(gigId).length;
    const late = await (await openSock(mo, band.bandId)).join(gigId);
    late.startBeats();
    await reads(leader, gigId, mo, true, 5000, "Mo Connected within 5 s of his join");
    await pause(3000);
    const joined = leader.rosters(gigId).length - joinFrom;
    console.log(`     count: ${joined} roster message on Lee's socket after one join`);
    assert.equal(joined, 1, "one join, one message");
    await endGig(band, gigId);
    await closeAll();
  });

  await check("K16 a phone from before: a socket that never beats is Connected for 20 s, Not connected within 5 s of closing", async () => {
    const band = await newBand("Old Phone");
    const gigId = await planGig(band, "Old phone");
    const leader = await startBySocket(band, gigId);
    const old = await (await openSock(bo, band.bandId)).join(gigId);
    await reads(leader, gigId, bo, true, 5000, "Bo Connected within 5 s");
    const from = Date.now();
    await pause(20_000);
    const after = await askRoster(leader, gigId, "Lee's ask after 20 s");
    assert.equal(after.rows.find((row) => row.userId === bo.userId)?.connected, true, "Bo still Connected after 20 s with no beat");
    for (const roster of leader.rosters(gigId).filter((m) => (m as Json).heardAt >= from)) assert.equal(roster.rows.find((row) => row.userId === bo.userId)?.connected, true, "Bo never read Not connected while open");
    await old.close();
    await reads(leader, gigId, bo, false, 5000, "Bo Not connected within 5 s of closing");
    await endGig(band, gigId);
    await closeAll();
  });

  // ---- The leader's own phone ---------------------------------------------------------------------------------

  await check("K1 Tonight's players: every member listed, the lineup ticked, the leader fixed; an untick saves and keeps them out", async () => {
    const band = await newBand("Lineup Night");
    const gigId = await planGig(band, "Lineup night");
    const members = (ok(await ada.call("/api/bands/open", { bandId: band.bandId }), "the band").members as { userId: string; name: string }[]).map((m) => m.name).sort();
    await openGigScreen(band, gigId);
    await openTonight(gigId);
    const rows = await tonightRows();
    assert.deepEqual(rows.map((row) => row.name).sort(), members, "every current band member is listed");
    assert.deepEqual(rows.filter((row) => row.ticked).map((row) => row.name).sort(), [ada, lee, bo, mo].map((who) => who.name).sort(), "the planned lineup is ticked");
    const leaderRow = rows.find((row) => row.name === lee.name)!;
    assert.ok(leaderRow.fixed && !leaderRow.box, "Lee's own row is ticked and has nothing to untick");
    await shot("tonight-players");
    await tick(mo);
    await clickButton("Save", `document.querySelector(${js(TONIGHT)})`);
    await until(`!document.querySelector(${js(TONIGHT)})`, "Tonight's players to close after Save");
    const lineup = (await gigOf(band, gigId)).gig.lineup as string[];
    assert.deepEqual([...lineup].sort(), [ada, lee, bo].map((who) => who.userId).sort(), "read back as Ada, the lineup no longer has Mo");
    await startBySocket(band, gigId);
    const live = ok(await mo.call("/api/bands/gig/live", {}), "Mo's live gigs").gigs as { gigId: string }[];
    assert.ok(!live.some((gig) => gig.gigId === gigId), "Mo's live-gig list no longer has the gig");
    const refused = await openSock(mo, band.bandId);
    refused.send({ kind: "join-gig", gigId });
    await waitFor("Mo's join refused", 5000, () => refused.closeCode !== null);
    assert.equal(refused.closeCode, 4404, "Mo's join is closed as not on the lineup");
    await endGig(band, gigId);
    await closeAll();
  });

  await check("K2 no change, nothing sent: Save with no tick touched sends nothing and nobody turns Not synced", async () => {
    const band = await newBand("Same Night");
    const gigId = await planGig(band, "Same night");
    await packFor(bo, band, gigId);
    const before = (await gigOf(band, gigId)).packRev;
    await openGigScreen(band, gigId);
    const sent = await lineupCalls();
    await openTonight(gigId);
    await clickButton("Save", `document.querySelector(${js(TONIGHT)})`);
    await until(`!document.querySelector(${js(TONIGHT)})`, "Tonight's players to close after Save");
    await openTonight(gigId);
    await tick(mo);
    await tick(mo);
    await clickButton("Save", `document.querySelector(${js(TONIGHT)})`);
    await until(`!document.querySelector(${js(TONIGHT)})`, "Tonight's players to close after an untick and a re-tick");
    assert.equal(await lineupCalls(), sent, "no lineup request left the phone");
    assert.equal((await gigOf(band, gigId)).packRev, before, "the gig's pack rev is the same as before");
    const leader = await startBySocket(band, gigId);
    await (await openSock(bo, band.bandId)).join(gigId);
    const roster = await reads(leader, gigId, bo, true, 5000, "Bo Connected within 5 s");
    assert.equal(roster.rows.find((row) => row.userId === bo.userId)?.packRev, roster.packRev, "Bo's receipt is still for tonight's pack: he is not Not synced");
    await endGig(band, gigId);
    await closeAll();
  });

  let k10: { band: Band; gigId: string } | null = null;
  await check("K10 start is not blocked: with Mo Not connected, Lee holds Start and the gig goes live", async () => {
    const band = await newBand("Start Night");
    const gigId = await planGig(band, "Start night");
    for (const who of [ada, bo]) {
      await packFor(who, band, gigId);
      (await openSock(who, band.bandId)).send({ kind: "gig-state", gigId });
    }
    await leaderStarts(band, gigId);
    assert.equal((await gigOf(band, gigId)).gig.status, "live", "the gig is live");
    k10 = { band, gigId };
    handOver = true;
    await openPanel();
    await panelReads([[ada, "Connected"], [bo, "Connected"], [mo, "Not connected"]], 8000, "Band status reads Ada and Bo Connected and Mo Not connected within 8 s");
    await closePanel();
    await warningSays(1, 5000, "the warning says 1 not ready");
  });

  await check("K9 off the lineup: Ray is not on the roster, not counted and not offered Join gig", async () => {
    assert.ok(k10, "K10's live gig");
    const { band, gigId } = k10;
    await openPanel();
    const rows = await panelRows();
    assert.ok(rows.some((row) => row.word === "Not connected"), "Band status has the check-in words");
    assert.ok(!rowFor(rows, ray), "Ray has no row");
    await closePanel();
    await warningSays(1, 5000, "the warning counts 1, not Ray");
    const live = ok(await ray.call("/api/bands/gig/live", {}), "Ray's live gigs").gigs as { gigId: string }[];
    assert.ok(!live.some((gig) => gig.gigId === gigId), "Ray's live-gig list does not have the gig, so his phone offers no Join gig");
    const sock = await openSock(ray, band.bandId);
    assert.ok(!(sock.heard.find((m) => m.kind === "hello")!.lineups as string[]).includes(gigId), "the Room does not name the gig to Ray");
    await endPageGig(band, gigId);
    await closeAll();
  });

  await check("K5 Not synced: no receipt reads Has not downloaded; after a lineup change an old pack reads Has an older set; the count follows", async () => {
    const band = await newBand("Sync Night");
    const gigId = await planGig(band, "Sync night");
    await leaderStarts(band, gigId);
    await (await openSock(ada, band.bandId)).join(gigId);
    await openPanel();
    await panelReads([[ada, "Not synced", NEVER], [bo, "Not connected"], [mo, "Not connected"]], 8000, "Ada Not synced: Has not downloaded tonight's set");
    await warningSays(3, 5000, "the warning says 3 not ready");
    const boSock = await (await openSock(bo, band.bandId)).join(gigId);
    await (await openSock(mo, band.bandId)).join(gigId);
    await packFor(bo, band, gigId);
    await packFor(mo, band, gigId);
    await panelReads([[bo, "Connected"], [mo, "Connected"], [ada, "Not synced", NEVER]], 8000, "Bo and Mo Connected once they download");
    await warningSays(1, 5000, "the warning says 1 not ready");
    ok(await ada.call("/api/bands/gig/lineup", { bandId: band.bandId, gigId, lineup: [ada.userId, lee.userId, bo.userId] }), "Ada takes Mo off the live gig, which raises the pack rev");
    await panelReads([[bo, "Not synced", OLDER], [ada, "Not synced", NEVER]], 8000, "Bo, holding the old pack, reads Has an older set");
    await warningSays(2, 5000, "the warning says 2 not ready");
    await packFor(bo, band, gigId);
    await panelReads([[bo, "Connected"]], 8000, "Bo Connected once his phone fetches again");
    await warningSays(1, 5000, "the warning says 1 not ready again");
    assert.equal(boSock.closeCode, null, "Bo's socket stayed in the gig");
    await shot("roster");
    await closePanel();
    await shot("warning");
    await endPageGig(band, gigId);
    await closeAll();
  });

  await check("K7 the warning: up while anyone is not ready, gone when all are; a dismiss holds for this gig and the roster still shows the drop", async () => {
    const band = await newBand("Warning Night");
    const gigId = await planGig(band, "Warning night");
    await leaderStarts(band, gigId);
    await warningSays(3, 8000, "the warning says 3 not ready");
    await clickButton("See who", `document.querySelector(${js(WARNING)})`);
    await until(`!!document.querySelector(${js(SHEET)})`, "See who opens Band status");
    await closePanel();
    const joined: Record<string, Sock> = {};
    for (const who of [ada, bo, mo]) {
      await packFor(who, band, gigId);
      joined[who.handle] = await (await openSock(who, band.bandId)).join(gigId);
    }
    await until(`!document.querySelector(${js(WARNING)})`, "the warning to clear once everyone is ready");
    await joined[mo.handle].close();
    await warningSays(1, 5000, "the warning back with 1 not ready within 5 s of Mo dropping");
    await evaluate(`document.querySelector(${js(`${WARNING} [aria-label="Dismiss for tonight"]`)}).click()`);
    await until(`!document.querySelector(${js(WARNING)})`, "the warning to go on dismiss");
    await joined[bo.handle].close();
    await openPanel();
    await panelReads([[bo, "Not connected"], [mo, "Not connected"], [ada, "Connected"]], 8000, "the roster still opens and shows Bo's drop");
    assert.ok(!(await has(WARNING)), "the warning stays dismissed for this gig on this phone");
    await closePanel();
    await endPageGig(band, gigId);
    await closeAll();
  });

  await check("K13 the leader loses signal: Band status says it can't reach the band and keeps the last rows, marked old", async () => {
    const band = await newBand("Signal Night");
    const gigId = await planGig(band, "Signal night");
    await leaderStarts(band, gigId);
    await packFor(ada, band, gigId);
    await (await openSock(ada, band.bandId)).join(gigId);
    await openPanel();
    await panelReads([[ada, "Connected"], [bo, "Not connected"]], 8000, "Ada Connected on Lee's phone");
    await evaluate(`window.__roomsDown = true; for (const ws of window.__rooms) ws.close();`);
    await until(`[...document.querySelectorAll(${js(`${SHEET} .band-status-line`)})].some((el) => el.textContent.includes("Can't reach the band"))`, "the line that the band can't be reached", 10000);
    const rows = await panelRows();
    assert.equal(rowFor(rows, ada)?.word, "Connected", "Ada's last known status is kept, not turned Not connected");
    assert.ok(rows.filter((row) => row.word).every((row) => row.old), "every kept row is marked old");
    await evaluate(`window.__roomsDown = false;`);
    await until(`![...document.querySelectorAll(${js(`${SHEET} .band-status-line`)})].some((el) => el.textContent.includes("Can't reach the band"))`, "the line to go once the room is back", 15000);
    assert.ok((await panelRows()).every((row) => !row.old), "fresh rows once Lee's phone hears the Room again");
    await closePanel();
    await endPageGig(band, gigId);
    await closeAll();
  });

  await check("K18 Band status opens on a live gig for the leader with each check-in word, for an admin, not for a member; no check-in draws as C23", async () => {
    const band = await newBand("Status Night");
    const gigId = await planGig(band, "Status night");
    await leaderStarts(band, gigId);
    await packFor(ada, band, gigId);
    await (await openSock(ada, band.bandId)).join(gigId);
    await (await openSock(mo, band.bandId)).join(gigId);
    await openPanel();
    await panelReads([[ada, "Connected"], [bo, "Not connected"], [mo, "Not synced", NEVER]], 8000, "Lee's tap opens Band status with each player's check-in word");
    await closePanel();

    const plain = (id: string, name: string) => ({ id, name, leader: id === "lead", you: id === "lead", route: "auto" as const, downloaded: false, live: null });
    const c23 = phone.livePlayers([plain("lead", "Lee"), plain("p1", "Ada")], "lead", [], 0);
    const drawn = phone.statusRows(c23);
    assert.deepEqual(
      drawn.map((row) => [row.name, row.routeText, row.tone]),
      [
        ["Lee", "", "steady"],
        ["Ada", "Not joined", "grey"],
      ],
      "a player with no check-in reads Not joined, grey, as C23 draws them",
    );
    assert.equal(phone.panelLine(c23), "Just you so far", "and the panel line is C23's");
    const checkedIn = phone.statusRows(phone.livePlayers([plain("lead", "Lee"), { ...plain("p1", "Ada"), checkIn: { kind: "connected" } } as never], "lead", [], 0));
    assert.equal(checkedIn[1].routeText, "Connected", "with a check-in the row says its word where C23 says Not joined");

    await pageAs(ada);
    await openGigScreen(band, gigId);
    await openPanel();
    await closePanel();
    await pageAs(mo);
    await openGigScreen(band, gigId);
    await until(`document.querySelectorAll(".gig-view .band-status-slot .band-status-face").length > 0`, "the faces on Mo's gig screen");
    assert.ok(!(await has(".gig-view .band-status-slot button.band-status-face")), "Mo's faces are pictures, not buttons");
    await evaluate(`document.querySelector(".gig-view .band-status-slot .band-status-face").click()`);
    await pause(600);
    assert.ok(!(await has(SHEET)), "Mo's tap opens nothing");
    await endGig(band, gigId);
    await closeAll();
  });

  await check("K4 Join gig otherwise: a player who never answered sees Join gig and the question; once answered Lee reads Connected", async () => {
    if (pageAccount !== mo) await pageAs(mo);
    const band = await newBand("Join Night");
    const gigId = await planGig(band, "Join night");
    const leader = await startBySocket(band, gigId);
    await openBandPage(band);
    await visibleAgain();
    await until(`[...document.querySelectorAll(".gig-strip button")].some((b) => b.textContent.trim() === "Join gig")`, "Join gig on Mo's strip", 10000);
    const shownAt = Date.now();
    await pause(3000);
    const before = await askRoster(leader, gigId, "Lee's ask 3 s after Mo sees Join gig");
    assert.equal(before.rows.find((row) => row.userId === mo.userId)?.connected, false, "Mo is not connected before he taps");
    assert.ok(leader.rosters(gigId).filter((m) => (m as Json).heardAt >= shownAt).every((m) => !m.rows.find((row) => row.userId === mo.userId)?.connected), "Mo never read Connected before his tap");
    await clickButton("Join gig", `document.querySelector(".gig-strip")`);
    await until(`!!document.querySelector(".gig-question")`, "the click question");
    await evaluate(`document.querySelectorAll(".gig-question button")[1].click()`);
    await reads(leader, gigId, mo, true, 5000, "Lee's roster reads Mo Connected within 5 s of his answer");
    await endGig(band, gigId);
    await closeAll();
  });

  await check("K3 joins without a tap: Bo, on the gig's screen and asked before, is Connected within 5 s of the start and stays where he was", async () => {
    await pageAs(bo);
    const band = await newBand("Auto Night");
    const earlier = await planGig(band, "Earlier night");
    const first = await startBySocket(band, earlier);
    await openBandPage(band);
    await visibleAgain();
    await until(`[...document.querySelectorAll(".gig-strip button")].some((b) => b.textContent.trim() === "Join gig")`, "Join gig on Bo's strip for the earlier gig", 10000);
    await clickButton("Join gig", `document.querySelector(".gig-strip")`);
    await until(`!!document.querySelector(".gig-question")`, "the click question on the earlier gig");
    await evaluate(`document.querySelectorAll(".gig-question button")[1].click()`);
    await reads(first, earlier, bo, true, 5000, "Bo Connected on the earlier gig");
    await endPageGig(band, earlier);
    await closeAll();

    const gigId = await planGig(band, "Auto night");
    await packFor(bo, band, gigId);
    await openGigScreen(band, gigId);
    const where = await evaluate<string>("location.hash");
    await until(
      `window.__sent.some((m) => m.includes('"gig-state"') && m.includes(${js(gigId)})) && window.__got.some((m) => m.includes('"gig-state"'))`,
      "Bo's phone watching the gig in the Room",
      10000,
    );
    const startedAt = Date.now();
    const leader = await startBySocket(band, gigId);
    await reads(leader, gigId, bo, true, Math.max(0, startedAt + 5000 - Date.now()), "Bo Connected on Lee's roster within 5 s of the start");
    assert.ok(
      leader.rosters(gigId).every((m) => m.rows.find((row) => row.userId === bo.userId)?.connected !== false),
      `Bo never read Not connected after the start (${js(leader.rosters(gigId).map((m) => m.rows.find((row) => row.userId === bo.userId)))})`,
    );
    await pause(1000);
    assert.equal(await evaluate<string>("location.hash"), where, "Bo's own screen is still the gig's screen he was on");
    assert.ok(await evaluate<boolean>(`!!${gigView(gigId)}`), "the gig's screen is still showing");
    await endGig(band, gigId);
    await closeAll();
  });

  await check("K12 on the phone: 44 px rows with names, a roster of names and words only, nothing sideways; a signed-out gig link can sign in or close", async () => {
    await pageAs(lee);
    const band = await newBand("Phone Night");
    const gigId = await planGig(band, "Phone night");
    await openGigScreen(band, gigId);
    await openTonight(gigId);
    for (const row of await tonightRows()) {
      assert.ok(row.height >= 44, `${row.name}'s row in Tonight's players is at least 44 px (${row.height})`);
      assert.ok(row.label.includes(row.name), `${row.name}'s row has an accessible name (${js(row.label)})`);
    }
    assert.ok(await evaluate<boolean>(`document.documentElement.scrollWidth <= ${WIDTH}`), "Tonight's players does not scroll sideways");
    await evaluate(`document.querySelector(${js(`${TONIGHT} [aria-label=Close]`)}).click()`);
    await until(`!document.querySelector(${js(TONIGHT)})`, "Tonight's players to close with no change");
    await leaderStarts(band, gigId);
    await packFor(ada, band, gigId);
    await (await openSock(ada, band.bandId)).join(gigId);
    await openPanel();
    const rows = await panelRows();
    await panelReads([[ada, "Connected"]], 8000, "Ada Connected");
    for (const row of await panelRows()) assert.ok(row.height >= 44, `${row.name}'s roster row is at least 44 px (${row.height})`);
    const text = await evaluate<string>(`document.querySelector(${js(SHEET)}).textContent`);
    for (const who of [ada, lee, bo, mo]) {
      assert.ok(text.includes(who.name), `the roster names ${who.name}`);
      assert.ok(!text.includes(who.handle) && !text.includes(who.userId), `the roster holds no handle or id for ${who.name}`);
    }
    assert.ok(!/@|https?:|\/\//.test(text), "the roster holds no address");
    assert.ok(rows.length === 4, `one roster row per lineup player (${rows.length})`);
    assert.ok(await evaluate<boolean>(`document.documentElement.scrollWidth <= ${WIDTH} && document.querySelector(${js(SHEET)}).scrollWidth <= document.querySelector(${js(SHEET)}).clientWidth`), "the roster does not scroll sideways");
    await closePanel();
    const link = ok(await ada.call("/api/codes", { kind: "gig", bandId: band.bandId, gigId }), "Ada's gig link").link as string;
    await endPageGig(band, gigId);
    await pageAs(null);
    await site.send("Page.navigate", { url: link.replace(/^https?:\/\/[^/]+/, origin) });
    await waitFor("the sign-in path for a signed-out visitor", 15000, () => evaluate<boolean>(`!!document.querySelector(".account-sheet")`));
    await evaluate(`[...document.querySelectorAll(".account-sheet button")].find((b) => b.textContent.trim() === "✕" || b.getAttribute("aria-label") === "Close")?.click()`);
    await waitFor("the visitor back in the app", 8000, () => evaluate<boolean>(`!document.querySelector(".account-sheet") && !!document.querySelector(".shell-header")`));
    await closeAll();
  });

  // ---- Added after the build (the brief allows new cases; K1 to K18 above are as in the tests-only commit) ----------

  await check("K19 downloaded after the screen loaded: a Connected player who fetches tonight's set later reads Downloaded, not Not yet", async () => {
    await pageAs(lee);
    const band = await newBand("Late Fetch");
    const gigId = await planGig(band, "Late fetch");
    await leaderStarts(band, gigId);
    const adaSock = await (await openSock(ada, band.bandId)).join(gigId);
    adaSock.startBeats();
    await packFor(ada, band, gigId);
    await openPanel();
    await panelReads([[ada, "Connected"]], 8000, "Ada Connected once she downloads");
    const adaText = await evaluate<string>(
      `[...document.querySelectorAll(${js(`${SHEET} .band-status-row`)})].find((row) => row.querySelector(".band-status-name")?.textContent.trim() === ${js(ada.name)})?.textContent ?? ""`,
    );
    assert.ok(adaText.includes("Downloaded") && !adaText.includes("Not yet"), `Ada, Connected with tonight's set, reads Downloaded, not Not yet (${adaText})`);
    await closePanel();
    await endPageGig(band, gigId);
    await closeAll();
  });
} finally {
  await closeAll();
  await site.close();
  await worker.dispose();
}

if (failed) {
  console.log(`${failed} case(s) failed`);
  process.exit(1);
}
console.log("all gig check-in cases passed");
process.exit(0);
