/**
 * check:links (C17): links to the leader. Two headless Chrome phones run the real `src/links/` code against the Worker
 * under Miniflare. One machine stands in for every network: a Wi-Fi link is host to host, "local candidates blocked"
 * drops every host candidate before it is sent (the onicecandidate filter), and a STUN responder on this machine gives
 * the server-reflexive address an over-the-internet link uses. There is no TURN server anywhere (Terry t28u).
 */
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { SongContent } from "../src/band-library-model.ts";
import { startApi } from "./api-session.ts";
import { PASSWORD_PEPPER, passwordPlayer } from "./app-page.ts";
import { openSite, type Site } from "./chrome.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const js = (value: unknown) => JSON.stringify(value);

const WIFI_WORDS = "This Wi-Fi keeps phones apart";
const SIGN_IN_WORDS = "This Wi-Fi wants you to sign in first";
const NO_DIRECT_WORDS = "No direct path over the internet";
const WAITING_WORDS = "Waiting for the leader";
const NO_SIGNAL_WORDS = "No signal";
const NOT_IN_BAND_WORDS = "You're not in this band";
const SIGN_IN_TO_JOIN_WORDS = "Sign in to join the gig";
const NOT_ON_LINEUP_WORDS = "You're not on tonight's lineup";
const LOST_FOR_MS = 30_000;

let failures = 0;
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${String((error as Error)?.stack ?? error).split("\n").slice(0, 6).join("\n     ")}`);
  }
}

// ---------------------------------------------------------------- pure: recorded getStats samples and the route tables

type Side = { type: string; protocol: string; relayProtocol: string | null; address: string };
type Sample = { setup: string; selected: { local: Side; remote: Side } | null; words: string };
const side = (type: string, address = "ipv4", protocol = "udp"): Side => ({ type, protocol, relayProtocol: null, address });

/**
 * The `selected` record spike/lan/links.js saves per link (local and remote candidate type, protocol, address kind),
 * one row per C1 and C2 setup in spike/RUNBOOK.md. C1 and C2 have not run on real phones yet (parked with Terry), so
 * these are the shapes the spike records, not files from phones. C20 swaps in the real files. Relay rows are gone (t28u).
 */
const SAMPLES: Sample[] = [
  { setup: "C1 own-router, .local names resolved", selected: { local: side("host", "local-name"), remote: side("host", "local-name") }, words: "Wi-Fi link" },
  { setup: "C1 home router, real addresses (camera permission)", selected: { local: side("host"), remote: side("host") }, words: "Wi-Fi link" },
  { setup: "C1 leader's hotspot, IPv6", selected: { local: side("host", "ipv6"), remote: side("host", "ipv6") }, words: "Wi-Fi link" },
  { setup: "C1 .local name not resolved, peer seen by its checks", selected: { local: side("host", "local-name"), remote: side("prflx") }, words: "Wi-Fi link" },
  { setup: "C1 venue Wi-Fi keeps phones apart, over the venue's internet", selected: { local: side("host", "local-name"), remote: side("srflx") }, words: "Over the internet" },
  { setup: "C2 two carriers, direct", selected: { local: side("srflx"), remote: side("srflx") }, words: "Over the internet" },
  { setup: "C2 carrier NAT seen by its checks", selected: { local: side("prflx"), remote: side("srflx") }, words: "Over the internet" },
  { setup: "C2 cell to venue Wi-Fi over TCP", selected: { local: side("host", "ipv4", "tcp"), remote: side("srflx", "ipv4", "tcp") }, words: "Over the internet" },
  { setup: "C2 nothing direct linked", selected: null, words: "Through the server" },
];

/** Raw `getStats` reports in Chrome's shape (a transport names its pair) and Safari's (only the pair says it is nominated). */
function rawStats(local: string, remote: string, chromeShape: boolean) {
  const entries: Record<string, unknown>[] = [
    { id: "L1", type: "local-candidate", candidateType: local, protocol: "udp", address: local === "host" ? "6f1c2a.local" : "203.0.113.4" },
    { id: "R1", type: "remote-candidate", candidateType: remote, protocol: "udp", address: "198.51.100.7" },
    { id: "P0", type: "candidate-pair", localCandidateId: "L1", remoteCandidateId: "R1", state: "failed", nominated: false },
    { id: "P1", type: "candidate-pair", localCandidateId: "L1", remoteCandidateId: "R1", state: "succeeded", nominated: true, bytesSent: 10, bytesReceived: 12 },
  ];
  if (chromeShape) entries.push({ id: "T1", type: "transport", selectedCandidatePairId: "P1" });
  return new Map(entries.map((entry) => [entry.id as string, entry]));
}

async function pureChecks() {
  await check("4. recorded getStats samples from C1 and C2 map to the right route word", async () => {
    const { routeOfPair, selectedPair } = await import("../src/links/wifi-link.ts");
    const { ROUTE_WORDS } = await import("../src/routes.ts");
    for (const sample of SAMPLES) assert.equal(ROUTE_WORDS[routeOfPair(sample.selected)], sample.words, sample.setup);
    for (const chromeShape of [true, false]) {
      const shape = chromeShape ? "Chrome" : "Safari";
      assert.equal(ROUTE_WORDS[routeOfPair(selectedPair(rawStats("host", "host", chromeShape)))], "Wi-Fi link", `${shape} host to host`);
      assert.equal(ROUTE_WORDS[routeOfPair(selectedPair(rawStats("host", "srflx", chromeShape)))], "Over the internet", `${shape} host to srflx`);
      assert.equal(selectedPair(rawStats("host", "host", chromeShape))?.local.type, "host", `${shape} pair reads its local candidate`);
    }
    assert.equal(selectedPair(new Map()), null, "no pair yet reads as none");
  });

  await check("5a. no route, word or ping rate for a relay is left in the tables", async () => {
    const { ROUTE_WORDS, CHOICE_WORDS } = await import("../src/routes.ts");
    const { PING_EVERY_MS } = await import("../src/band-time.ts");
    assert.deepEqual(Object.keys(ROUTE_WORDS), ["wifi", "internet", "server"], "ROUTE_WORDS names three routes");
    assert.deepEqual(Object.keys(PING_EVERY_MS), ["wifi", "internet", "server"], "PING_EVERY_MS names three routes");
    assert.doesNotMatch(JSON.stringify(CHOICE_WORDS), /relay/i, "no choice mentions a relay");
  });
}

// ---------------------------------------------------------------- the network pieces this machine plays

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((net) => net?.family === "IPv4" && !net.internal)?.address;

const ownAddresses = new Set(Object.values(networkInterfaces()).flat().map((net) => net?.address));

/**
 * The follower's side of a link between two tabs on this machine starts at this machine's own address. That is the host
 * candidate, or the srflx one when the STUN reply beat the `.local` name: host and srflx share one socket, Chrome names
 * the pair after whichever it listed first (see `routeOfPair`), and with no NAT the srflx address is this machine's own.
 */
const oneMachinePair = (pair: View["pairs"][number] | undefined) =>
  pair?.local === "host" || (pair?.local === "srflx" && ownAddresses.has(pair.localAddress ?? ""));

/** A STUN binding responder (RFC 5389): answers each request with the sender's address, the way a free public STUN server does. */
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

/** A venue sign-in page: every request is sent off to a login page. It allows any origin, as an intercepting portal answers whatever asked. */
async function startPortal() {
  const stats = { hits: 0 };
  const server = createServer((request, response) => {
    stats.hits += 1;
    response.writeHead(302, { location: "http://127.0.0.1/portal-login", "access-control-allow-origin": "*" });
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`, stats, close: () => server.close() };
}

// ---------------------------------------------------------------- the harness page each phone opens

/**
 * Runs before any app code: counts live timers, keeps every RTCPeerConnection and its ICE config, drops host candidates
 * while `__blockLocal` is on (a Wi-Fi that keeps phones apart), counts pings sent on any carrier, and holds back each
 * `join-gig` for `__delayJoin` ms (a slower phone, a backgrounded tab, a room socket still reconnecting), and holds back
 * each room socket's `close` for `__delayClose` ms (a slow network still carrying the room's close to the phone).
 */
const PAGE_HOOKS = `
window.__timers = new Set();
const setT = window.setTimeout, clearT = window.clearTimeout, setI = window.setInterval, clearI = window.clearInterval;
window.setTimeout = (fn, ms, ...args) => { const id = setT(() => { window.__timers.delete("t" + id); typeof fn === "function" ? fn(...args) : 0; }, ms); window.__timers.add("t" + id); return id; };
window.clearTimeout = (id) => { window.__timers.delete("t" + id); clearT(id); };
window.setInterval = (fn, ms, ...args) => { const id = setI(fn, ms, ...args); window.__timers.add("i" + id); return id; };
window.clearInterval = (id) => { window.__timers.delete("i" + id); clearI(id); };
window.__pcs = []; window.__iceConfigs = []; window.__blockLocal = false; window.__pingsSent = 0;
const Peer = window.RTCPeerConnection;
window.RTCPeerConnection = class extends Peer {
  constructor(config) { super(config); window.__pcs.push(this); window.__iceConfigs.push(JSON.stringify(config ?? {})); }
  addEventListener(type, listener, options) {
    if (type !== "icecandidate") return super.addEventListener(type, listener, options);
    return super.addEventListener(type, (event) => { if (window.__blockLocal && event.candidate && event.candidate.type === "host") return; listener(event); }, options);
  }
  set onicecandidate(listener) { this.addEventListener("icecandidate", listener); }
};
const counted = (proto) => { const send = proto.send; proto.send = function (data) { if (typeof data === "string" && data.includes('"k":"ping"')) window.__pingsSent++; return send.call(this, data); }; };
counted(RTCDataChannel.prototype); counted(WebSocket.prototype);
window.__sockets = [];
const Socket = window.WebSocket;
window.__delayClose = 0;
window.WebSocket = class extends Socket {
  constructor(...args) { super(...args); window.__sockets.push(this); }
  addEventListener(type, listener, options) {
    if (type !== "close") return super.addEventListener(type, listener, options);
    return super.addEventListener(type, (event) => { const ms = window.__delayClose; ms ? setT(() => listener(event), ms) : listener(event); }, options);
  }
};
window.__dropRoom = () => window.__sockets.filter((ws) => ws.readyState === Socket.OPEN).forEach((ws) => ws.close());
window.__delayJoin = 0;
const sendNow = Socket.prototype.send;
Socket.prototype.send = function (data) {
  if (!window.__delayJoin || typeof data !== "string" || !data.includes('"join-gig"')) return sendNow.call(this, data);
  setT(() => { try { sendNow.call(this, data); } catch {} }, window.__delayJoin);
};
`;

function harnessEntry(dir: string) {
  const from = (file: string) => relative(dir, join(root, file)).replaceAll("\\", "/");
  return `
import { linkToLeader } from ${js(from("src/links/attempt.ts"))};
import { roomLine } from ${js(from("src/links/server-link.ts"))};
import { selectedPair } from ${js(from("src/links/wifi-link.ts"))};
import { bandNow, confidence } from ${js(from("src/band-time.ts"))};

let session = null, room = null, you = null, intros = 0, errors = [], chosen = null, generation = 0;
const localNow = () => performance.timeOrigin + performance.now();
const pairOf = async (pc) => {
  if (pc.connectionState !== "connected") return null;
  const stats = await pc.getStats();
  const pair = selectedPair(stats);
  const picked = [...stats.values()].find((entry) => entry.type === "transport")?.selectedCandidatePairId;
  const local = picked && stats.get(stats.get(picked)?.localCandidateId);
  return pair && { local: pair.local.type, remote: pair.remote.type, localAddress: local?.address ?? null };
};
window.harness = {
  start({ bandId, gigId, stun, rows, healthUrl, roomUrl, blockLocal }) {
    window.__blockLocal = !!blockLocal;
    window.__sockets = [];
    you = null; intros = 0; errors = []; chosen = null; generation = 0;
    room = roomLine(roomUrl ?? location.origin.replace(/^http/, "ws") + "/api/rooms/" + bandId);
    room.listen((message) => {
      if (message.kind === "hello") you = message.you;
      if (message.kind === "intro") intros++;
      if (message.kind === "error") errors.push(message.error);
    });
    session = linkToLeader({ room, gigId, stun, rows, healthUrl, onChange: () => {
      const now = session?.attempt().chosen ?? null;
      if (now && now !== chosen) generation++;
      chosen = now;
    } });
  },
  async view() {
    const attempt = session?.attempt() ?? { tried: [], chosen: null, reasons: {} };
    const clock = session?.clock();
    const local = localNow();
    const band = clock ? bandNow(clock, local) : null;
    return {
      you, intros, errors, generation,
      leading: session?.leading() ?? false,
      tried: attempt.tried,
      reasons: attempt.reasons,
      chosen: attempt.chosen && { route: attempt.chosen.route, state: attempt.chosen.state, reason: attempt.chosen.reason },
      followers: (session?.followers() ?? []).map((link) => ({ route: link.route, state: link.state })),
      clock: clock ? { points: clock.points.length, served: band !== null, offset: band === null ? null : band - local, confidence: confidence(clock, local) } : null,
      pairs: (await Promise.all(window.__pcs.map(pairOf))).filter(Boolean),
      pcs: window.__pcs.map((pc) => pc.signalingState),
      iceConfigs: window.__iceConfigs,
      resources: performance.getEntriesByType("resource").map((entry) => entry.name),
      pingsSent: window.__pingsSent,
      timers: window.__timers.size,
      roomSockets: window.__sockets.length,
    };
  },
  send(message) { room.send(message); },
  close() { session?.close(); room?.close(); session = null; room = null; },
};
`;
}

function writeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "check-links-page-"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><title>links</title><script>${PAGE_HOOKS}</script><script type="module" src="./harness.ts"></script>`);
  writeFileSync(join(dir, "harness.ts"), harnessEntry(dir));
  return dir;
}

// ---------------------------------------------------------------- the band, the gig and the two phones

type View = {
  you: string | null;
  intros: number;
  errors: string[];
  generation: number;
  leading: boolean;
  tried: string[];
  reasons: Record<string, string>;
  chosen: { route: string; state: string; reason: string | null } | null;
  followers: { route: string; state: string }[];
  clock: { points: number; served: boolean; offset: number | null; confidence: string } | null;
  pairs: { local: string; remote: string; localAddress: string | null }[];
  pcs: string[];
  iceConfigs: string[];
  resources: string[];
  pingsSent: number;
  timers: number;
  roomSockets: number;
};

const view = (site: Site) => site.evaluate<View>("window.harness.view()");

async function until(what: string, site: Site, ok: (v: View) => boolean, timeoutMs = 15_000): Promise<View> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await view(site).catch(() => null);
    if (seen && ok(seen)) return seen;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${js(seen && { ...seen, resources: seen.resources.length, iceConfigs: seen.iceConfigs.length })}`);
    await sleep(100);
  }
}

const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: (SongContent & { id: number })[] };
const song = (({ id: _id, ...content }) => content)(seed.songs[0]);

await pureChecks();

await check("1b. a one-machine pair whose local side Chrome names srflx, at this machine's own address, still starts at this machine (CI run 45281740592)", async () => {
  assert.ok(lanAddress, "this machine has a network address");
  assert.ok(oneMachinePair({ local: "host", remote: "host", localAddress: "6f1c2a.local" }), "a host candidate");
  assert.ok(oneMachinePair({ local: "srflx", remote: "host", localAddress: lanAddress }), "the STUN reply came before the .local name, so Chrome named the shared socket's srflx candidate");
  assert.ok(!oneMachinePair({ local: "srflx", remote: "host", localAddress: "203.0.113.4" }), "a public address a NAT gave is not this machine");
  assert.ok(!oneMachinePair({ local: "relay", remote: "host", localAddress: lanAddress }), "a relay is never this machine's own path");
  assert.ok(!oneMachinePair(undefined), "no pair");
});

const pageDir = writeHarness();
const sockets: WebSocket[] = [];
const stun = await startStun();
const portal = await startPortal();
let apiBase = "";
let origin = "";
const sites: Site[] = [];
let stopWorker = async () => {};

type Player = Awaited<ReturnType<typeof passwordPlayer>>;
type Opened = { ws: WebSocket; hello: Record<string, unknown> | null; received: Record<string, unknown>[]; closed: Promise<number> };

/** A phone's room socket from Node, sending the app's Origin and the player's cookie. */
function socket(player: Player, bandId: string): Promise<Opened> {
  const ws = new WebSocket(player.socketUrl(bandId), { headers: { origin, cookie: player.cookie } } as unknown as string[]);
  sockets.push(ws);
  const received: Record<string, unknown>[] = [];
  const closed = new Promise<number>((done) => ws.addEventListener("close", (event) => done(event.code)));
  ws.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))));
  return new Promise((done) => {
    const timer = setTimeout(() => done({ ws, hello: null, received, closed }), 5000);
    ws.addEventListener("message", () => (clearTimeout(timer), done({ ws, hello: received[0] ?? null, received, closed })), { once: true });
    ws.addEventListener("close", () => (clearTimeout(timer), done({ ws, hello: null, received, closed })), { once: true });
  });
}

/** The close code the server sent. The local dev proxy holds TCP open after a server close, so the client finishes it. */
async function serverClose(opened: Opened, label: string): Promise<number> {
  for (const end = Date.now() + 5000; opened.ws.readyState === WebSocket.OPEN; await sleep(50)) {
    if (Date.now() > end) throw new Error(`timed out waiting for the room to close ${label}`);
  }
  opened.ws.close();
  return opened.closed;
}

async function signIn(site: Site, player: Player | null) {
  await site.send("Network.clearBrowserCookies");
  if (player) {
    const cut = player.cookie.indexOf("=");
    const [name, value] = [player.cookie.slice(0, cut), player.cookie.slice(cut + 1)];
    await site.send("Network.setCookie", { name, value, url: origin, httpOnly: true, secure: true, sameSite: "Lax" });
  }
  await site.send("Page.navigate", { url: `${origin}/` });
  for (const end = Date.now() + 15_000; !(await site.evaluate<boolean>("!!window.harness").catch(() => false)); await sleep(100)) {
    if (Date.now() > end) throw new Error("the harness page never loaded");
  }
}

try {
  assert.ok(lanAddress, "this machine has a network address for host candidates");
  const leaderSite = await openSite(pageDir, "check-links-leader", () => apiBase);
  sites.push(leaderSite);
  const followerSite = await openSite(pageDir, "check-links-follower", () => apiBase);
  sites.push(followerSite);
  const thirdSite = await openSite(pageDir, "check-links-third", () => apiBase);
  sites.push(thirdSite);
  origin = leaderSite.origin;
  const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
  apiBase = base;
  stopWorker = () => worker.dispose();

  const lee = await passwordPlayer(base, origin, "Lee Leader", "leeleader");
  const fran = await passwordPlayer(base, origin, "Fran Follow", "franfollow");
  const ben = await passwordPlayer(base, origin, "Ben Bench", "benbench");
  const stan = await passwordPlayer(base, origin, "Stan Stranger", "stanstranger");
  const bandId = (await lee.call("/api/bands/create", { name: "The Link Testers" })).body.bandId as string;
  const invite = (await lee.call("/api/codes", { kind: "band", bandId })).body.code as string;
  for (const member of [fran, ben]) assert.equal((await member.call("/api/bands/join", { code: invite })).status, 200, `${member.name} joins`);
  const shared = await lee.call("/api/bands/library/share-song", { bandId, song, choice: "public", localId: null });
  const setlist = await lee.call("/api/bands/library/share-setlist", { bandId, name: "Link set", songIds: [shared.body.songId], tags: [], choice: "public", localId: null });
  const planned = await lee.call("/api/bands/gig/plan", { bandId, setlistId: setlist.body.setlistId, name: "Friday link test", date: "2026-11-27", lineup: [lee.userId, fran.userId], leader: lee.userId });
  assert.equal(planned.status, 200, `Lee plans the gig (${js(planned.body)})`);
  const gigId = planned.body.gig.gigId as string;
  const lineup = (people: Player[]) => lee.call("/api/bands/gig/lineup", { bandId, gigId, lineup: people.map((p) => p.userId) });

  await signIn(leaderSite, lee);
  await signIn(followerSite, fran);

  type Start = { stun?: string[]; rows?: string[]; healthUrl?: string; roomUrl?: string; blockLocal?: boolean };
  const start = (site: Site, options: Start = {}) => site.evaluate(`window.harness.start(${js({ bandId, gigId, stun: [stun.url], ...options })})`);
  const stopBoth = async () => {
    await followerSite.evaluate("window.harness.close()");
    await leaderSite.evaluate("window.harness.close()");
    await sleep(500);
  };
  const leaderBand = async () => (await view(leaderSite)).leading;

  await check("empty state: a follower who joins before the leader waits for the leader", async () => {
    await start(followerSite);
    const waiting = await until("the waiting words", followerSite, (v) => v.reasons.server === WAITING_WORDS);
    assert.equal(waiting.chosen, null, "no link while the leader is away");
    assert.equal(waiting.leading, false);
  });

  let wifiAt = 0;
  await check("1. two tabs on one machine open a data channel labeled Wi-Fi link within 5 s", async () => {
    const t0 = Date.now();
    await start(leaderSite);
    const linked = await until("a Wi-Fi link", followerSite, (v) => v.chosen?.route === "wifi" && v.chosen.state === "open", 10_000);
    wifiAt = Date.now() - t0;
    assert.ok(wifiAt < 5000, `linked ${wifiAt} ms after the leader arrived`);
    assert.ok(await leaderBand(), "the room told the leader's phone that it leads");
    const pair = linked.pairs[0];
    assert.ok(oneMachinePair(pair), `the follower's pair starts at this machine's own address (${js(linked.pairs)})`);
    assert.ok(["host", "prflx"].includes(pair?.remote), `and remote host (prflx when its checks beat its candidate): ${js(linked.pairs)}`);
    assert.ok(linked.tried.includes("wifi") && linked.tried.includes("internet"), `one attempt tries every address type at once (${js(linked.tried)})`);
    const leader = await until("the leader's side of the link", leaderSite, (v) => v.followers.some((f) => f.route === "wifi" && f.state === "open"));
    assert.ok(leader.followers.length >= 1);
  });

  await check("6a. a ping over the Wi-Fi link returns band time and the clock filter accepts it", async () => {
    const synced = await until("the clock on the Wi-Fi link", followerSite, (v) => !!v.clock?.served && v.clock.points >= 8);
    assert.ok(Math.abs(synced.clock!.offset!) < 25, `two phones on one machine share a clock, so the offset ${synced.clock!.offset} ms is near 0`);
  });

  await check("9a. closing a link stops its pings and timers (Wi-Fi link)", async () => {
    await stopBoth();
    const [follower, leader] = [await view(followerSite), await view(leaderSite)];
    await sleep(3000);
    const [followerLater, leaderLater] = [await view(followerSite), await view(leaderSite)];
    assert.equal(followerLater.pingsSent, follower.pingsSent, "no ping after close");
    assert.equal(followerLater.timers, 0, `no follower timer left (${followerLater.timers})`);
    assert.equal(leaderLater.timers, 0, `no leader timer left (${leaderLater.timers})`);
    assert.ok(followerLater.pcs.every((state) => state === "closed") && leaderLater.pcs.every((state) => state === "closed"), `every peer connection closed (${js([followerLater.pcs, leaderLater.pcs])})`);
    assert.equal(leaderLater.pingsSent, leader.pingsSent);
  });

  await check("3. a redirecting health check gives 'This Wi-Fi wants you to sign in first' and the Wi-Fi link is still tried", async () => {
    await start(leaderSite);
    await until("the leader in the room", leaderSite, (v) => v.leading);
    await start(followerSite, { healthUrl: portal.url });
    const seen = await until("the sign-in words and a Wi-Fi link", followerSite, (v) => v.reasons.wifi === SIGN_IN_WORDS && v.chosen?.route === "wifi" && v.chosen.state === "open");
    assert.ok(seen.tried.includes("wifi"), "the Wi-Fi link was tried");
    assert.ok(portal.stats.hits >= 1, "the health check reached the sign-in page");
    await stopBoth();
  });

  await check("2. with local candidates blocked the tabs connect another way within 5 s and the reason is 'This Wi-Fi keeps phones apart'", async () => {
    await start(leaderSite, { blockLocal: true });
    await until("the leader in the room", leaderSite, (v) => v.leading);
    const t0 = Date.now();
    await start(followerSite, { blockLocal: true });
    const linked = await until("a link another way", followerSite, (v) => v.chosen?.state === "open", 10_000);
    const openMs = Date.now() - t0;
    assert.ok(openMs < 5000, `connected another way in ${openMs} ms`);
    assert.equal(linked.chosen!.route, "internet", "over the internet, through the STUN address");
    const told = await until("the isolation words", followerSite, (v) => v.reasons.wifi === WIFI_WORDS, 8000);
    assert.ok(Date.now() - t0 < 6500, "said at the Wi-Fi link's 5 s deadline");
    assert.ok(told.pairs.every((pair) => pair.remote !== "host"), `no host-to-host pair while local candidates are blocked (${js(told.pairs)})`);
    assert.ok(stun.stats.answered > 0, "the phones asked the STUN server for their address");
  });

  await check("6b. a ping over the internet link returns band time and the clock filter accepts it", async () => {
    const synced = await until("the clock over the internet", followerSite, (v) => v.chosen?.route === "internet" && !!v.clock?.served && v.clock.points >= 8);
    assert.ok(Math.abs(synced.clock!.offset!) < 25, `offset ${synced.clock!.offset} ms near 0`);
    await stopBoth();
  });

  await check("5. when no direct link opens, the link falls to the server and no relay is ever tried", async () => {
    await start(leaderSite, { blockLocal: true, stun: [] });
    await until("the leader in the room", leaderSite, (v) => v.leading);
    const t0 = Date.now();
    await start(followerSite, { blockLocal: true, stun: [] });
    const fell = await until("the server link", followerSite, (v) => v.chosen?.route === "server" && v.chosen.state === "open", 15_000);
    assert.ok(Date.now() - t0 >= 7500, "the direct attempt kept its 8 s before falling");
    assert.deepEqual(fell.tried, ["wifi", "internet", "server"], "every row tried, the server last");
    assert.equal(fell.reasons.wifi, WIFI_WORDS);
    assert.equal(fell.reasons.internet, NO_DIRECT_WORDS);
    for (const page of [fell, await view(leaderSite)]) {
      assert.deepEqual(page.resources.filter((url) => url.includes("/api/relay")), [], "no /api/relay request");
      assert.ok(page.iceConfigs.length > 0 && page.iceConfigs.every((config) => !/turns?:/.test(config)), `no turn: URL in any ICE config (${js(page.iceConfigs)})`);
    }
  });

  await check("6c. a ping over the server link returns band time and the clock filter accepts it", async () => {
    const synced = await until("the clock through the server", followerSite, (v) => v.chosen?.route === "server" && !!v.clock?.served && v.clock.points >= 8, 20_000);
    assert.ok(Math.abs(synced.clock!.offset!) < 25, `offset ${synced.clock!.offset} ms near 0`);
  });

  await check("9b. closing a link stops its pings and timers (server link)", async () => {
    await stopBoth();
    const before = await view(followerSite);
    await sleep(3000);
    const later = await view(followerSite);
    assert.equal(later.pingsSent, before.pingsSent, "no ping after close");
    assert.equal(later.timers, 0, `no timer left (${later.timers})`);
    assert.equal((await view(leaderSite)).timers, 0, "no leader timer left");
  });

  await check("7. a link lost for 30 s reconnects through the room without a new introduction being needed from the person", async () => {
    await start(leaderSite);
    await until("the leader in the room", leaderSite, (v) => v.leading);
    await start(followerSite);
    const first = await until("a Wi-Fi link with a clock", followerSite, (v) => v.chosen?.route === "wifi" && v.chosen.state === "open" && !!v.clock?.served, 15_000);
    await leaderSite.send("Page.setWebLifecycleState", { state: "frozen" });
    const lostAt = Date.now();
    const lost = await until("the follower noticing the leader is gone", followerSite, (v) => v.chosen?.route !== "wifi" || v.chosen.state !== "open", LOST_FOR_MS - 2000);
    assert.ok(lost.clock?.served, "the last clock estimate is kept while the link is down");
    await sleep(Math.max(0, LOST_FOR_MS - (Date.now() - lostAt)));
    await leaderSite.send("Page.setWebLifecycleState", { state: "active" });
    const back = await until("the link back through the room", followerSite, (v) => v.chosen?.route === "wifi" && v.chosen.state === "open" && v.generation > first.generation, 30_000);
    assert.ok(back.clock?.served, "the clock carried across the new link");
    await stopBoth();
  });

  await check("8. a stranger's socket is refused and a non-lineup member gets no introduction", async () => {
    await start(leaderSite);
    const leader = await until("the leader in the room", leaderSite, (v) => v.leading && !!v.you);
    const stranger = await socket(stan, bandId);
    assert.equal(stranger.hello, null, "the stranger's socket never opens");
    assert.equal((await fetch(new URL(`/api/rooms/${bandId}`, base), { headers: { cookie: stan.cookie } })).status, 403, "the room refuses the stranger");

    const bench = await socket(ben, bandId);
    assert.equal(bench.hello?.kind, "hello", "a band member's socket opens");
    bench.ws.send(js({ kind: "intro", to: leader.you, body: { a: "x", sdp: "v=0" } }));
    await sleep(500);
    assert.ok(bench.received.some((m) => m.kind === "error" && m.error === "not-on-lineup"), `the room refuses Ben's introduction (${js(bench.received)})`);
    await leaderSite.evaluate(`window.harness.send(${js({ kind: "intro", to: bench.hello!.you, body: { a: "y" } })})`);
    await sleep(500);
    assert.ok(!bench.received.some((m) => m.kind === "intro"), "nothing reaches Ben from the leader");
    assert.equal((await view(leaderSite)).intros, leader.intros, "nothing reaches the leader from Ben");
    assert.ok((await view(leaderSite)).errors.includes("not-on-lineup"), "the leader hears Ben is not on the lineup");
    bench.ws.send(js({ kind: "join-gig", gigId }));
    assert.equal(await serverClose(bench, "Ben's socket"), 4404, "join-gig from a member off the lineup closes with not-on-lineup");

    const wrong = await socket(fran, bandId);
    wrong.ws.send(js({ kind: "join-gig", gigId: "gig_not_a_real_gig_id_000" }));
    assert.equal(await serverClose(wrong, "a wrong gig"), 4404, "a gig that does not exist is refused the same way");

    const playing = await socket(fran, bandId);
    playing.ws.send(js({ kind: "join-gig", gigId }));
    await sleep(500);
    const peers = playing.received.find((m) => m.kind === "gig");
    assert.equal(peers?.leader, leader.you, `a lineup member is told the leader's socket (${js(playing.received)})`);
    assert.equal((await lineup([lee])).status, 200, "Lee takes Fran off the lineup");
    assert.equal(await serverClose(playing, "Fran's socket"), 4404, "coming off the lineup closes the gig socket");
    assert.equal((await lineup([lee, fran])).status, 200, "Lee puts Fran back");
    await stopBoth();
  });

  await check("8b. a phone the room refuses before its socket opens says why and stops asking (a stranger, then signed out)", async () => {
    for (const [who, player, words] of [["the stranger", stan, NOT_IN_BAND_WORDS], ["a signed-out phone", null, SIGN_IN_TO_JOIN_WORDS]] as const) {
      await signIn(thirdSite, player);
      await start(thirdSite);
      const refused = await until(`${who}'s words`, thirdSite, (v) => v.reasons.server === words, 10_000);
      assert.equal(refused.chosen, null, `${who} has no link`);
      await sleep(4000);
      const later = await view(thirdSite);
      assert.equal(later.reasons.server, words, `${who} still reads '${words}'`);
      assert.equal(later.roomSockets, 1, `${who}'s phone asked the room once and stopped (${later.roomSockets} sockets)`);
      await thirdSite.evaluate("window.harness.close()");
    }
  });

  await check("empty state: with no room reachable and no link the strip word is 'No signal'", async () => {
    await start(followerSite, { roomUrl: "ws://127.0.0.1:9/api/rooms/nowhere" });
    const seen = await until("the no-signal words", followerSite, (v) => v.reasons.server === NO_SIGNAL_WORDS);
    assert.equal(seen.chosen, null);
    await followerSite.evaluate("window.harness.close()");
    await sleep(500);
    assert.equal((await view(followerSite)).timers, 0, "the room retry timer stops on close");
  });

  await check("9c. closing a link stops its pings and timers (three join and close rounds leak nothing)", async () => {
    await start(leaderSite);
    await until("the leader in the room", leaderSite, (v) => v.leading);
    for (let round = 1; round <= 3; round += 1) {
      await start(followerSite);
      const open = await until(`round ${round} link`, followerSite, (v) => v.chosen?.state === "open" && (v.clock?.points ?? 0) >= 16, 15_000);
      await sleep(2500);
      const later = await view(followerSite);
      assert.ok(later.timers <= open.timers + 1 && later.timers <= 6, `timers stay flat while linked (${open.timers} then ${later.timers})`);
      await followerSite.evaluate("window.harness.close()");
      await sleep(1000);
      const closed = await view(followerSite);
      assert.equal(closed.timers, 0, `round ${round}: no timer left`);
      await sleep(2000);
      assert.equal((await view(followerSite)).pingsSent, closed.pingsSent, `round ${round}: no ping after close`);
    }
    await leaderSite.evaluate("window.harness.close()");
    await sleep(500);
    assert.equal((await view(leaderSite)).timers, 0, "no leader timer left");
  });

  await check("10. the leader's second phone follows the first, a room blip on either leaves the band's links alone, and the second leads once the first leaves", async () => {
    await signIn(thirdSite, lee);
    await start(leaderSite);
    await until("phone A leading", leaderSite, (v) => v.leading);
    await start(followerSite);
    const linked = await until("Fran's Wi-Fi link to phone A", followerSite, (v) => v.chosen?.route === "wifi" && v.chosen.state === "open", 15_000);
    await start(thirdSite);
    await until("phone B following phone A", thirdSite, (v) => !v.leading && v.chosen?.state === "open", 15_000);
    const steady = async (after: string) => {
      await sleep(3000);
      const [a, b, fran] = await Promise.all([view(leaderSite), view(thirdSite), view(followerSite)]);
      assert.ok(a.leading && !b.leading, `after ${after}, phone A still leads and phone B follows (A ${a.leading}, B ${b.leading})`);
      assert.equal(fran.generation, linked.generation, `after ${after}, Fran keeps the same link (generation ${linked.generation} then ${fran.generation})`);
      assert.equal(fran.chosen?.state, "open", `after ${after}, Fran's link is open`);
      assert.deepEqual(a.reasons, {}, `after ${after}, phone A shows no reason (${js(a.reasons)})`);
    };
    await steady("phone B opens the gig");
    for (const [name, site] of [["phone A", leaderSite], ["phone B", thirdSite]] as const) {
      const before = (await view(site)).you;
      await site.evaluate("window.__dropRoom()");
      await until(`${name} back in the room`, site, (v) => !!v.you && v.you !== before, 15_000);
      await steady(`${name}'s room socket drops and comes back`);
    }
    await leaderSite.evaluate("window.harness.close()");
    await until("phone B leading once phone A leaves", thirdSite, (v) => v.leading, 20_000);
    await until("Fran's Wi-Fi link to phone B", followerSite, (v) => v.chosen?.route === "wifi" && v.chosen.state === "open" && v.generation > linked.generation, 20_000);
    await followerSite.evaluate("window.harness.close()");
    await thirdSite.evaluate("window.harness.close()");
    await sleep(500);
  });

  /**
   * Phone A leads, phone B and Fran follow. Phone B's `join-gig` is held back, so Fran asks the room first and dials
   * phone B before it knows it leads, and phone B drops that offer. Fran must still end on a direct link to phone B.
   */
  const asksFirst = async (holdMs: number, onTheWay: (fran: View) => boolean) => {
    await signIn(thirdSite, lee);
    await start(leaderSite);
    await until("phone A leading", leaderSite, (v) => v.leading);
    await start(followerSite);
    await until("Fran's Wi-Fi link to phone A", followerSite, (v) => v.chosen?.route === "wifi" && v.chosen.state === "open", 15_000);
    await start(thirdSite);
    await until("phone B following phone A", thirdSite, (v) => !v.leading && v.chosen?.state === "open", 15_000);
    await thirdSite.evaluate(`window.__delayJoin = ${holdMs}`);
    await leaderSite.evaluate("window.harness.close()");
    try {
      await until("Fran on the way to phone B", followerSite, onTheWay, holdMs + 15_000);
      await until("phone B leading", thirdSite, (v) => v.leading, holdMs + 10_000);
      const direct = await until("Fran's Wi-Fi link to phone B", followerSite, (v) => v.chosen?.route === "wifi" && v.chosen.state === "open", 20_000);
      assert.equal(direct.reasons.wifi, undefined, `no Wi-Fi reason once linked (${js(direct.reasons)})`);
      await sleep(3000);
      assert.equal((await view(followerSite)).chosen?.route, "wifi", "Fran stays on the Wi-Fi link");
    } finally {
      await thirdSite.evaluate("window.__delayJoin = 0");
      await followerSite.evaluate("window.harness.close()");
      await thirdSite.evaluate("window.harness.close()");
      await sleep(500);
    }
  };

  await check("11a. a follower that asks before the leader's next phone leads still ends on a direct link to it", async () => {
    await asksFirst(1500, (v) => v.chosen === null);
  });

  await check("11b. a follower that fell to the server while the leader's next phone was slow moves to a direct link once it leads", async () => {
    await asksFirst(12_000, (v) => v.chosen?.route === "server" && v.chosen.state === "open");
  });

  await check("12. a player taken off the lineup and put back links again with no reload", async () => {
    await start(leaderSite);
    await until("phone A leading", leaderSite, (v) => v.leading);
    await start(followerSite);
    await until("Fran linked", followerSite, (v) => v.chosen?.state === "open", 15_000);
    assert.equal((await lineup([lee])).status, 200, "Lee takes Fran off the lineup");
    const off = await until("Fran told she is off the lineup", followerSite, (v) => v.reasons.server === NOT_ON_LINEUP_WORDS && v.chosen === null, 10_000);
    await sleep(4000);
    const waiting = await view(followerSite);
    assert.equal(waiting.reasons.server, NOT_ON_LINEUP_WORDS, `Fran still reads '${NOT_ON_LINEUP_WORDS}' (${js(waiting.reasons)})`);
    assert.equal(waiting.roomSockets, 2, "the room line came back once to hear the lineup, and did not ask in a loop");
    assert.equal((await lineup([lee, fran])).status, 200, "Lee puts Fran back");
    const back = await until("Fran linked again", followerSite, (v) => v.chosen?.state === "open", 15_000);
    assert.equal(back.reasons.server, undefined, `the lineup words are gone (${js(back.reasons)})`);
    assert.ok(back.generation > off.generation, "a new link, made with no reload");
    await stopBoth();
  });

  await check("12a. a player put back on the lineup while their phone is still hearing it was taken off links again with no reload", async () => {
    await start(leaderSite);
    await until("phone A leading", leaderSite, (v) => v.leading);
    await start(followerSite);
    const linked = await until("Fran linked", followerSite, (v) => v.chosen?.state === "open", 15_000);
    await followerSite.evaluate("window.__delayClose = 2000");
    try {
      assert.equal((await lineup([lee])).status, 200, "Lee takes Fran off the lineup");
      await sleep(700);
      assert.equal((await lineup([lee, fran])).status, 200, "Lee puts Fran back before her phone has heard the room close");
      const back = await until("Fran linked again", followerSite, (v) => v.chosen?.state === "open" && v.generation > linked.generation, 30_000);
      assert.equal(back.reasons.server, undefined, `no lineup words once linked (${js(back.reasons)})`);
      await sleep(3000);
      assert.equal((await view(followerSite)).chosen?.state, "open", "Fran stays linked");
    } finally {
      await followerSite.evaluate("window.__delayClose = 0");
      await stopBoth();
    }
  });

  await check("12b. a phone off the lineup whose room drops asks nothing, and a put-back the drop hid still links it", async () => {
    await start(leaderSite);
    await until("phone A leading", leaderSite, (v) => v.leading);
    assert.equal((await lineup([lee])).status, 200, "Lee takes Fran off the lineup before she opens the gig");
    try {
      await start(followerSite);
      await until("Fran told she is off the lineup", followerSite, (v) => v.reasons.server === NOT_ON_LINEUP_WORDS && v.chosen === null, 10_000);
      await sleep(4000);
      const before = await view(followerSite);
      await followerSite.evaluate("window.__dropRoom()");
      await until("Fran's room back", followerSite, (v) => !!v.you && v.you !== before.you, 40_000);
      await sleep(4000);
      const after = await view(followerSite);
      assert.equal(after.reasons.server, NOT_ON_LINEUP_WORDS, `Fran still reads '${NOT_ON_LINEUP_WORDS}' (${js(after.reasons)})`);
      assert.equal(after.roomSockets, before.roomSockets + 1, `the room's greeting said she is off, so she asked nothing (${before.roomSockets} then ${after.roomSockets} sockets)`);
      await followerSite.evaluate("window.__dropRoom()");
      assert.equal((await lineup([lee, fran])).status, 200, "Lee puts Fran back while her room is down");
      const back = await until("Fran linked once her room is back", followerSite, (v) => v.chosen?.state === "open", 40_000);
      assert.equal(back.reasons.server, undefined, `the lineup words are gone (${js(back.reasons)})`);
    } finally {
      await lineup([lee, fran]);
      await stopBoth();
    }
  });
} catch (error) {
  failures += 1;
  console.log(`FAIL setup\n     ${String((error as Error)?.stack ?? error)}`);
} finally {
  for (const ws of sockets) ws.close();
  stun.close();
  portal.close();
  await Promise.all(sites.map((site) => site.close()));
  await stopWorker();
  rmSync(pageDir, { recursive: true, force: true });
}

console.log(failures ? `check:links: ${failures} failed` : "check:links ok");
process.exit(failures ? 1 : 0);
