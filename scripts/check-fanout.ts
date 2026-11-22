/**
 * check:fanout (C19): the leader's fan-out over mixed routes. First the fan-out on its own in Node, with stand-in
 * links and a stand-in room. Then a leader tab and three follower tabs in headless Chrome run the real `src/links/`
 * and `src/leader-fanout.ts` against the Worker under Miniflare: two followers on data channels (Wi-Fi link, one of
 * them later over the internet through a STUN responder on this machine) and one on the room socket alone. There is
 * no TURN server and no paid relay anywhere (Terry t28u): the room's forward is our own Worker's socket.
 */
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { SongContent } from "../src/band-library-model.ts";
import type { BandMs } from "../src/band-time.ts";
import type { GigState, Op } from "../src/gig-state.ts";
import { startApi } from "./api-session.ts";
import { PASSWORD_PEPPER, passwordPlayer } from "./app-page.ts";
import { openSite, type Site } from "./chrome.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const js = (value: unknown) => JSON.stringify(value);
const band = (ms: number) => ms as BandMs;

const WAITING_WORDS = "Waiting for the leader";
const KEEPING_WORDS = "No signal · keeping the beat";
const LEAD = 150;

let failures = 0;
async function check(name: string, run: () => Promise<void> | void) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${String((error as Error)?.stack ?? error).split("\n").slice(0, 6).join("\n     ")}`);
  }
}

// ---------------------------------------------------------------- the fan-out on its own, in Node

type Fanout = typeof import("../src/leader-fanout.ts");
type Gig = typeof import("../src/gig-state.ts");
type Message = { kind: string; [key: string]: unknown };

async function loadPure(): Promise<Fanout & Pick<Gig, "startGig" | "reduce" | "position">> {
  const bundled = await build({
    stdin: { contents: `export * from "./src/leader-fanout.ts"; export { startGig, reduce, position } from "./src/gig-state.ts";`, resolveDir: root, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    logLevel: "silent",
  });
  const file = join(mkdtempSync(join(tmpdir(), "check-fanout-")), "fanout.mjs");
  writeFileSync(file, bundled.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

/** A link that is open until closed, keeps what was sent on it, and hands `deliver`ed messages to its listeners. */
function fakeLink(route: "wifi" | "internet" | "server") {
  const listeners = new Set<(message: unknown) => void>();
  const link = {
    route,
    state: "open" as "open" | "closed",
    reason: null,
    sent: [] as Message[],
    listeners,
    send(message: unknown) {
      if (link.state === "open") link.sent.push(message as Message);
    },
    onMessage(cb: (message: unknown) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    ping: () => Promise.reject(new Error("no-pong")),
    close() {
      link.state = "closed";
      listeners.clear();
    },
    deliver(message: unknown) {
      for (const cb of [...listeners]) cb(message);
    },
  };
  return link;
}

/** The room's socket as `src/links/server-link.ts` `roomLine` shows it: a state, a send that fails while down, and listeners. */
function fakeRoom() {
  const listeners = new Set<(message: Message) => void>();
  const room = {
    state: "open" as "connecting" | "open" | "down" | "refused",
    sent: [] as Message[],
    listeners,
    send(message: object) {
      if (room.state !== "open") return false;
      room.sent.push(message as Message);
      return true;
    },
    listen(cb: (message: Message) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close() {
      listeners.clear();
    },
    deliver(message: Message) {
      for (const cb of [...listeners]) cb(message);
    },
  };
  return room;
}

type Body = Op extends infer O ? (O extends Op ? Omit<O, "opId" | "epoch"> : never) : never;

async function pureChecks() {
  const F = await loadPure();
  const clock = { now: 10_000 };
  const plan = { gigId: "gig-pure", order: ["a", "b", "c", "d"], leader: "lee", admin: "lee", backup: "sam", lineup: ["lee", "fran", "gus", "sam"], route: "auto" as const, scrollAlong: true };
  const base = () => F.startGig({ ...plan, now: band(clock.now) });
  let ops = 0;
  const op = (state: GigState, body: Body, epoch = state.epoch) => ({ ...body, opId: `pure-${(ops += 1)}`, epoch }) as Op;
  const copy = (state: GigState | null, at: number | null = state ? clock.now : null) => ({ kind: "gig-state", state, at });

  function phone(me: string, links: ReturnType<typeof fakeLink>[] = [], room = fakeRoom()) {
    let changes = 0;
    const sync = F.gigSync({ me, gigId: plan.gigId, room, links: () => links, bandNow: () => band(clock.now), lead: () => LEAD, onChange: () => (changes += 1) });
    sync.relink();
    return { sync, room, links, changes: () => changes };
  }
  const sentKinds = (messages: Message[], kind: string) => messages.filter((m) => m.kind === kind);

  const timers = { made: 0 };
  const [realTimeout, realInterval] = [globalThis.setTimeout, globalThis.setInterval];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => ((timers.made += 1), realTimeout(...args))) as typeof setTimeout;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => ((timers.made += 1), realInterval(...args))) as typeof setInterval;

  try {
    await check("pure: the leader applies a tap, then sends it once on every direct link, none on a server link, and once to the room", () => {
      const [wifi, internet, server] = [fakeLink("wifi"), fakeLink("internet"), fakeLink("server")];
      const leader = phone("lee", [wifi, internet, server]);
      leader.sync.start(base());
      clock.now += 1000;
      const tapped = leader.sync.tap(op(leader.sync.state()!, { kind: "goTo", key: "b" }));
      assert.ok(tapped.ok, `the leader's own reduce takes the tap (${js(tapped)})`);
      const rev = leader.sync.state()!.rev;
      assert.equal(rev, 1);
      for (const link of [wifi, internet]) {
        const copies = link.sent.filter((m) => m.kind === "gig-state" && (m.state as GigState).rev === rev);
        assert.equal(copies.length, 1, `one copy of rev ${rev} on the ${link.route} link`);
        assert.equal((copies[0].state as GigState).last?.at, leader.sync.state()!.last?.at, "the copy is the leader's whole state");
      }
      assert.equal(server.sent.length, 0, "nothing on the server link: the room's forward carries that follower");
      const toRoom = sentKinds(leader.room.sent, "gig-op").filter((m) => (m.state as GigState).rev === rev);
      assert.equal(toRoom.length, 1, "one gig-op for rev 1 to the room");
      assert.equal((toRoom[0].op as Op).opId, `pure-${ops}`, "the room gets the op id it dedupes by");
    });

    await check("pure: the same rev on two links and the room copy applies once (make-before-break overlap)", () => {
      const state = F.reduce(base(), op(base(), { kind: "goTo", key: "c" }), { by: "lee", now: band(clock.now), lead: LEAD });
      assert.ok(state.ok);
      const [wifi, internet] = [fakeLink("wifi"), fakeLink("internet")];
      const follower = phone("fran", [wifi, internet]);
      wifi.deliver(copy(state.state));
      internet.deliver(copy(state.state));
      follower.room.deliver(copy(state.state));
      const results = follower.sync.heard().filter((h) => h.rev === state.state.rev).map((h) => h.result);
      assert.deepEqual(results, ["applied", "duplicate", "duplicate"], "applied on the first copy, dropped after");
      assert.equal(follower.sync.state()?.rev, state.state.rev);
      assert.equal(follower.changes(), 1, "the screen is told once");
    });

    await check("pure: a change from an old epoch is refused on a follower and on the leader who was taken over", () => {
      const start = base();
      const took = F.reduce(start, op(start, { kind: "takeOver" }), { by: "sam", now: band(clock.now), lead: LEAD });
      assert.ok(took.ok);
      let old = start;
      for (const key of ["b", "c", "d"]) {
        const next = F.reduce(old, op(old, { kind: "goTo", key }), { by: "lee", now: band((clock.now += 1000)), lead: LEAD });
        assert.ok(next.ok);
        old = next.state;
      }
      const wifi = fakeLink("wifi");
      const follower = phone("fran", [wifi]);
      follower.room.deliver(copy(took.state));
      wifi.deliver(copy(old));
      const last = follower.sync.heard().at(-1)!;
      assert.equal(last.result, "old-epoch", "the cut-off leader's higher rev at epoch 0 loses to epoch 1");
      assert.equal(follower.sync.state()?.leader, "sam");
      assert.equal(follower.sync.state()?.epoch, 1);

      const leader = phone("lee");
      leader.sync.start(start);
      leader.room.deliver(copy(took.state));
      assert.equal(leader.sync.state()?.leader, "sam", "the old leader hears the take-over and steps down");
      const sent = leader.room.sent.length;
      const stale = leader.sync.tap(op(start, { kind: "goTo", key: "b" }, 0));
      assert.deepEqual(stale, { ok: false, refused: "stale-epoch" }, "its own phone refuses an epoch-0 tap");
      assert.equal(leader.room.sent.length, sent, "and sends nothing");
    });

    await check("pure: a change heard 200 ms after its at is applied and logged 200 ms late", () => {
      const start = base();
      const moved = F.reduce(start, op(start, { kind: "goTo", key: "d" }), { by: "lee", now: band(clock.now), lead: LEAD });
      assert.ok(moved.ok);
      const follower = phone("gus", [fakeLink("wifi")]);
      follower.room.deliver(copy(start));
      clock.now = moved.state.last!.at + 200;
      follower.links[0].deliver(copy(moved.state));
      const heard = follower.sync.heard().at(-1)!;
      assert.equal(heard.result, "applied");
      assert.equal(heard.lateMs, 200, "logged 200 ms late");
      assert.equal(F.position(follower.sync.state()!, band(clock.now)).song.key, "d", "the next frame shows it");
      const onTime = F.reduce(moved.state, op(moved.state, { kind: "goTo", key: "a" }), { by: "lee", now: band(clock.now), lead: LEAD });
      assert.ok(onTime.ok);
      follower.links[0].deliver(copy(onTime.state));
      assert.ok(follower.sync.heard().at(-1)!.lateMs! <= 0, "a change heard before its at is not late");
    });

    await check("pure: a repeat opId changes nothing on the leader and sends nothing", () => {
      const wifi = fakeLink("wifi");
      const leader = phone("lee", [wifi]);
      leader.sync.start(base());
      const tap = op(leader.sync.state()!, { kind: "goTo", key: "b" });
      assert.ok(leader.sync.tap(tap).ok);
      const [rev, onLink, onRoom] = [leader.sync.state()!.rev, wifi.sent.length, leader.room.sent.length];
      assert.deepEqual(leader.sync.tap(tap), { ok: false, refused: "repeat" });
      assert.deepEqual([leader.sync.state()!.rev, wifi.sent.length, leader.room.sent.length], [rev, onLink, onRoom]);
    });

    await check("pure: a follower with no link and no room keeps the last state and says 'No signal · keeping the beat'", () => {
      const start = base();
      const wifi = fakeLink("wifi");
      const follower = phone("fran", [wifi]);
      follower.room.deliver(copy(start));
      assert.equal(follower.sync.words(), null, "nothing to say while linked");
      wifi.close();
      follower.room.state = "down";
      follower.room.deliver({ kind: "room-down" });
      assert.equal(follower.sync.words(), KEEPING_WORDS);
      assert.equal(follower.sync.state()?.rev, start.rev, "the last state is kept");
      follower.room.state = "open";
      assert.equal(follower.sync.words(), null, "back to nothing once the room is up");
    });

    await check("pure: the room's answer with no state reads 'Waiting for the leader'", () => {
      const follower = phone("fran");
      assert.deepEqual(sentKinds(follower.room.sent, "gig-state"), [{ kind: "gig-state", gigId: plan.gigId }], "the phone asks the room for its copy");
      follower.room.deliver(copy(null));
      assert.equal(follower.sync.state(), null);
      assert.equal(follower.sync.words(), WAITING_WORDS);
    });

    await check("pure: a leader cut off from the room sends its latest once when the room answers older, and nothing when the room is current", () => {
      const wifi = fakeLink("wifi");
      const leader = phone("lee", [wifi]);
      const start = base();
      leader.sync.start(start);
      leader.room.state = "down";
      for (const key of ["b", "c"]) assert.ok(leader.sync.tap(op(leader.sync.state()!, { kind: "goTo", key })).ok);
      const latest = leader.sync.state()!;
      assert.equal(wifi.sent.filter((m) => (m.state as GigState)?.rev === latest.rev).length, 1, "the links still carry it while the room is down");
      leader.room.state = "open";
      leader.room.sent.length = 0;
      leader.room.deliver({ kind: "hello", you: "s1", peers: [] });
      assert.equal(sentKinds(leader.room.sent, "gig-state").length, 1, "it asks the room for its copy on reconnect");
      leader.room.deliver(copy(start));
      const caughtUp = sentKinds(leader.room.sent, "gig-op");
      assert.equal(caughtUp.length, 1, "one catch-up send");
      assert.equal((caughtUp[0].state as GigState).rev, latest.rev, "carrying the latest state");
      leader.room.deliver(copy(latest));
      assert.equal(sentKinds(leader.room.sent, "gig-op").length, 1, "nothing more once the room is current");
    });

    await check("pure: closing stops listening on every link and the room", () => {
      const wifi = fakeLink("wifi");
      const follower = phone("gus", [wifi]);
      follower.sync.close();
      assert.equal(wifi.listeners.size, 0, "no listener left on the link");
      assert.equal(follower.room.listeners.size, 0, "no listener left on the room");
      wifi.deliver(copy(base()));
      assert.equal(follower.sync.state(), null);
      assert.equal(follower.changes(), 0);
    });

    await check("pure: the fan-out holds no timers, for 3 links and 200 changes", () => {
      const before = timers.made;
      const links = [fakeLink("wifi"), fakeLink("wifi"), fakeLink("internet")];
      const leader = phone("lee", links);
      const followers = links.map((link) => phone("fran", [link]));
      leader.sync.start(base());
      for (let i = 0; i < 200; i += 1) {
        clock.now += 50;
        assert.ok(leader.sync.tap(op(leader.sync.state()!, { kind: "section", index: i })).ok);
        for (const link of links) for (const message of link.sent.splice(0)) link.deliver(message);
      }
      assert.ok(followers.every((f) => f.sync.state()?.rev === 200), "every follower applied all 200");
      assert.equal(timers.made - before, 0, `timers started: ${timers.made - before}`);
    });
  } finally {
    globalThis.setTimeout = realTimeout;
    globalThis.setInterval = realInterval;
  }
}

// ---------------------------------------------------------------- the network pieces this machine plays

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((net) => net?.family === "IPv4" && !net.internal)?.address;

/** A STUN binding responder (RFC 5389), the free public STUN server a direct internet link finds its address with. */
async function startStun() {
  const socket = createSocket("udp4");
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
  });
  await new Promise<void>((done) => socket.bind(0, "0.0.0.0", done));
  return { url: `stun:${lanAddress}:${socket.address().port}`, close: () => socket.close() };
}

// ---------------------------------------------------------------- the harness page each phone opens

/**
 * Runs before any app code: counts live timers, keeps every peer connection and data channel, drops host candidates
 * while `__blockLocal` is on (a Wi-Fi that keeps phones apart), and holds every inbound socket and channel message
 * for `__delayMs` (a slow network). The hold uses the browser's own timer, so it is not counted as the app's.
 */
const PAGE_HOOKS = `
window.__timers = new Set();
const setT = window.setTimeout, clearT = window.clearTimeout, setI = window.setInterval, clearI = window.clearInterval;
window.setTimeout = (fn, ms, ...args) => { const id = setT(() => { window.__timers.delete("t" + id); typeof fn === "function" ? fn(...args) : 0; }, ms); window.__timers.add("t" + id); return id; };
window.clearTimeout = (id) => { window.__timers.delete("t" + id); clearT(id); };
window.setInterval = (fn, ms, ...args) => { const id = setI(fn, ms, ...args); window.__timers.add("i" + id); return id; };
window.clearInterval = (id) => { window.__timers.delete("i" + id); clearI(id); };
window.__pcs = []; window.__dcs = []; window.__blockLocal = false; window.__delayMs = 0;
const Peer = window.RTCPeerConnection;
window.RTCPeerConnection = class extends Peer {
  constructor(config) { super(config); window.__pcs.push(this); }
  createDataChannel(...args) { const dc = super.createDataChannel(...args); window.__dcs.push(dc); return dc; }
  addEventListener(type, listener, options) {
    if (type === "datachannel") return super.addEventListener(type, (event) => { window.__dcs.push(event.channel); listener(event); }, options);
    if (type !== "icecandidate") return super.addEventListener(type, listener, options);
    return super.addEventListener(type, (event) => { if (window.__blockLocal && event.candidate && event.candidate.type === "host") return; listener(event); }, options);
  }
  set onicecandidate(listener) { this.addEventListener("icecandidate", listener); }
};
const held = (proto) => { const add = proto.addEventListener; proto.addEventListener = function (type, listener, options) {
  if (type !== "message") return add.call(this, type, listener, options);
  return add.call(this, type, (event) => (window.__delayMs > 0 ? setT(() => listener.call(this, event), window.__delayMs) : listener.call(this, event)), options);
}; };
held(RTCDataChannel.prototype); held(WebSocket.prototype);
`;

function harnessEntry(dir: string) {
  const from = (file: string) => relative(dir, join(root, file)).replaceAll("\\", "/");
  return `
import { linkToLeader } from ${js(from("src/links/attempt.ts"))};
import { roomLine } from ${js(from("src/links/server-link.ts"))};
import { gigSync } from ${js(from("src/leader-fanout.ts"))};
import { startGig, reduce, position } from ${js(from("src/gig-state.ts"))};
import { bandNow, beatTime } from ${js(from("src/band-time.ts"))};

const LEAD = ${LEAD};
let room = null, links = null, sync = null, me = null, gigId = null, taps = 0, frame = 0, raf = 0;
let applied = [], shown = [], clicks = [], lastTap = null, saved = null, shownKey = null, lastBeat = null, appliedRev = -1;
const localNow = () => performance.timeOrigin + performance.now();
const now = () => (!links || links.leading() ? localNow() : bandNow(links.clock(), localNow()) ?? localNow());
const openLinks = () => (links ? [links.attempt().chosen, ...links.followers()].filter(Boolean) : []);
const gridAt = (state, t) => { let grid = null; for (const step of state.click) if (step.at <= t) grid = step.value; return grid; };
const keep = (list, entry) => { list.push(entry); if (list.length > 2000) list.shift(); };

/** Every frame shows position(state, band now), as the gig screen does, and logs each song shown and each click. */
function frameLoop() {
  raf = requestAnimationFrame(frameLoop);
  frame += 1;
  const state = sync?.state();
  if (!state) return;
  const t = now();
  const p = position(state, t);
  if (p.song.key !== shownKey) { shownKey = p.song.key; keep(shown, { frame, key: p.song.key, rev: state.rev }); }
  const beat = p.beat ? p.beat.bar + ":" + p.beat.beat : null;
  if (beat === lastBeat) return;
  lastBeat = beat;
  if (!p.beat) return;
  const grid = gridAt(state, t);
  const index = (p.beat.bar - grid.firstBar) * grid.beatsPerBar + p.beat.beat;
  keep(clicks, { index, bar: p.beat.bar, beat: p.beat.beat, at: beatTime(grid, index), shownAt: t, rev: state.rev });
}

const copyOn = (state) => { for (const link of openLinks()) if (link.state === "open" && link.route !== "server") link.send({ kind: "gig-state", state, at: now() }); };

window.harness = {
  start({ bandId, gigId: gig, me: who, stun, rows }) {
    me = who; gigId = gig; taps = 0; applied = []; shown = []; clicks = []; lastTap = null; shownKey = null; lastBeat = null; appliedRev = -1;
    room = roomLine(location.origin.replace(/^http/, "ws") + "/api/rooms/" + bandId);
    links = linkToLeader({ room, gigId, stun, rows, onChange: () => sync?.relink() });
    sync = gigSync({ me, gigId, room, links: openLinks, bandNow: now, lead: () => LEAD, onChange: () => {
      const state = sync.state();
      if (state && state.rev !== appliedRev) { appliedRev = state.rev; keep(applied, { frame, rev: state.rev, epoch: state.epoch }); }
    } });
    if (!raf) frameLoop();
  },
  begin(plan) { sync.start(startGig({ ...plan, gigId, leader: me, route: "auto", scrollAlong: true, now: now() })); },
  tap(body) {
    const state = sync.state();
    const op = { ...body, opId: me + "-" + (taps += 1), epoch: body.epoch ?? state.epoch };
    const out = sync.tap(op);
    if (!out.ok) return { ok: false, refused: out.refused, opId: op.opId };
    lastTap = { op, state: out.state };
    return { ok: true, opId: op.opId, rev: out.state.rev, at: out.state.last ? out.state.last.at : null };
  },
  tapAgain() { const out = sync.tap(lastTap.op); return out.ok ? { ok: true } : { ok: false, refused: out.refused }; },
  resendLast(changed) {
    const state = changed ? { ...lastTap.state, rev: lastTap.state.rev + 1 } : lastTap.state;
    room.send({ kind: "gig-op", op: lastTap.op, state, at: now() });
    if (!changed) copyOn(state);
  },
  raw(message) { return room.send(message); },
  save() { saved = sync.state(); },
  /** The old leader who never heard the take-over: its own reduce on the state it last had, sent the way the fan-out sends. */
  staleTap(body) {
    const op = { ...body, opId: me + "-" + (taps += 1), epoch: saved.epoch };
    const out = reduce(saved, op, { by: me, now: now(), lead: LEAD });
    if (!out.ok) return { ok: false, refused: out.refused };
    saved = out.state;
    room.send({ kind: "gig-op", op, state: out.state, at: now() });
    copyOn(out.state);
    return { ok: true, opId: op.opId, rev: out.state.rev, epoch: out.state.epoch };
  },
  switchToInternet() { window.__blockLocal = true; for (const dc of window.__dcs) dc.close(); },
  delay(ms) { window.__delayMs = ms; },
  view() {
    const state = sync ? sync.state() : null;
    const chosen = links ? links.attempt().chosen : null;
    return {
      leading: links ? links.leading() : false,
      chosen: chosen && { route: chosen.route, state: chosen.state },
      followers: links ? links.followers().map((link) => ({ route: link.route, state: link.state })) : [],
      state: state && { gigId: state.gigId, rev: state.rev, epoch: state.epoch, leader: state.leader, lastAt: state.last ? state.last.at : null, key: state.current[state.current.length - 1].value, click: state.click[state.click.length - 1].value },
      words: sync ? sync.words() : null,
      heard: sync ? sync.heard().map((h) => ({ ...h })) : [],
      refused: sync ? sync.refused().map((r) => ({ ...r })) : [],
      applied, shown, clicks, frame,
      timers: window.__timers.size,
    };
  },
  close() { sync?.close(); links?.close(); room?.close(); sync = links = room = null; if (raf) cancelAnimationFrame(raf); raf = 0; window.__blockLocal = false; window.__delayMs = 0; },
};
`;
}

function writeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "check-fanout-page-"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><title>fanout</title><script>${PAGE_HOOKS}</script><script type="module" src="./harness.ts"></script>`);
  writeFileSync(join(dir, "harness.ts"), harnessEntry(dir));
  return dir;
}

// ---------------------------------------------------------------- the band, the gig, the phones

type Summary = { gigId: string; rev: number; epoch: number; leader: string; lastAt: number | null; key: string; click: { bpm: number; beatsPerBar: number; startAt: number; firstBar: number } | null };
type HeardEntry = { rev: number; epoch: number; result: string; via: string; heardAt: number | null; lateMs: number | null };
type View = {
  leading: boolean;
  chosen: { route: string; state: string } | null;
  followers: { route: string; state: string }[];
  state: Summary | null;
  words: string | null;
  heard: HeardEntry[];
  refused: { opId: string | null; refused: string }[];
  applied: { frame: number; rev: number; epoch: number }[];
  shown: { frame: number; key: string; rev: number }[];
  clicks: { index: number; bar: number; beat: number; at: number; shownAt: number; rev: number }[];
  frame: number;
  timers: number;
};
type Tap = { ok: boolean; refused?: string; opId: string; rev?: number; at?: number | null; epoch?: number };

const view = (site: Site) => site.evaluate<View>("window.harness.view()");
const call = <T>(site: Site, expression: string) => site.evaluate<T>(`window.harness.${expression}`);

async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await read().catch(() => null);
    if (seen !== null && ok(seen)) return seen;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${String(js(seen)).slice(0, 1500)}`);
    await sleep(50);
  }
}

const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: (SongContent & { id: number })[] };
const song = (({ id: _id, ...content }) => content)(seed.songs[0]);

await check("pure part loads", async () => {
  await pureChecks();
});

const pageDir = writeHarness();
const sockets: WebSocket[] = [];
const stun = await startStun();
let apiBase = "";
let origin = "";
const sites: Site[] = [];
let stopWorker = async () => {};

type Player = Awaited<ReturnType<typeof passwordPlayer>>;
type Opened = { ws: WebSocket; hello: Record<string, unknown> | null; received: Record<string, any>[]; closed: Promise<number> };

/** A phone's room socket from Node, sending the app's Origin and the player's cookie. */
function socket(player: Player, bandId: string): Promise<Opened> {
  const ws = new WebSocket(player.socketUrl(bandId), { headers: { origin, cookie: player.cookie } } as unknown as string[]);
  sockets.push(ws);
  const received: Record<string, any>[] = [];
  const closed = new Promise<number>((done) => ws.addEventListener("close", (event) => done(event.code)));
  ws.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))));
  return new Promise((done) => {
    const timer = setTimeout(() => done({ ws, hello: null, received, closed }), 5000);
    ws.addEventListener("message", () => (clearTimeout(timer), done({ ws, hello: received[0] ?? null, received, closed })), { once: true });
    ws.addEventListener("close", () => (clearTimeout(timer), done({ ws, hello: null, received, closed })), { once: true });
  });
}

const message = (opened: Opened, what: string, ok: (m: Record<string, any>) => boolean, timeoutMs = 5000) =>
  until(what, async () => opened.received.find(ok) ?? null, (m) => m !== null, timeoutMs);

/** The close code the server sent. The local dev proxy holds TCP open after a server close, so the client finishes it. */
async function serverClose(opened: Opened, label: string): Promise<number> {
  for (const end = Date.now() + 5000; opened.ws.readyState === WebSocket.OPEN; await sleep(50)) {
    if (Date.now() > end) throw new Error(`timed out waiting for the room to close ${label}`);
  }
  opened.ws.close();
  return opened.closed;
}

async function signIn(site: Site, player: Player) {
  const cut = player.cookie.indexOf("=");
  const [name, value] = [player.cookie.slice(0, cut), player.cookie.slice(cut + 1)];
  await site.send("Network.setCookie", { name, value, url: origin, httpOnly: true, secure: true, sameSite: "Lax" });
  await site.send("Page.navigate", { url: `${origin}/` });
  for (const end = Date.now() + 15_000; !(await site.evaluate<boolean>("!!window.harness").catch(() => false)); await sleep(100)) {
    if (Date.now() > end) throw new Error("the harness page never loaded");
  }
}

try {
  assert.ok(lanAddress, "this machine has a network address for host candidates");
  const names = ["leader", "fran", "gus", "sam"];
  for (const name of names) sites.push(await openSite(pageDir, `check-fanout-${name}`, () => apiBase));
  const [leaderSite, franSite, gusSite, samSite] = sites;
  origin = leaderSite.origin;
  const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
  apiBase = base;
  stopWorker = () => worker.dispose();

  const lee = await passwordPlayer(base, origin, "Lee Leader", "leeleader");
  const fran = await passwordPlayer(base, origin, "Fran Wifi", "franwifi");
  const gus = await passwordPlayer(base, origin, "Gus Wifi", "guswifi");
  const sam = await passwordPlayer(base, origin, "Sam Server", "samserver");
  const ben = await passwordPlayer(base, origin, "Ben Bench", "benbench");
  const bandId = (await lee.call("/api/bands/create", { name: "The Fan-out Testers" })).body.bandId as string;
  const invite = (await lee.call("/api/codes", { kind: "band", bandId })).body.code as string;
  for (const member of [fran, gus, sam, ben]) assert.equal((await member.call("/api/bands/join", { code: invite })).status, 200, `${member.name} joins`);
  const shared = await lee.call("/api/bands/library/share-song", { bandId, song, choice: "public", localId: null });
  const setlist = await lee.call("/api/bands/library/share-setlist", { bandId, name: "Fan-out set", songIds: [shared.body.songId], tags: [], choice: "public", localId: null });
  const lineup = [lee, fran, gus, sam].map((p) => p.userId);
  const planGig = async (name: string, leader: Player, backup: Player, people: string[]) => {
    const planned = await lee.call("/api/bands/gig/plan", { bandId, setlistId: setlist.body.setlistId, name, date: "2026-11-27", lineup: people, leader: leader.userId, backup: backup.userId });
    assert.equal(planned.status, 200, `Lee plans ${name} (${js(planned.body)})`);
    return planned.body.gig.gigId as string;
  };
  const gigId = await planGig("Friday fan-out", lee, sam, lineup);
  const order = ["s1", "s2", "s3", "s4", "s5", "s6"];

  for (const [site, player] of [[leaderSite, lee], [franSite, fran], [gusSite, gus], [samSite, sam]] as const) await signIn(site, player);

  type Start = { me: string; rows?: string[] };
  const start = (site: Site, options: Start) => call(site, `start(${js({ bandId, gigId, stun: [stun.url], ...options })})`);
  const tap = (body: object) => call<Tap>(leaderSite, `tap(${js(body)})`);
  const followers = [franSite, gusSite, samSite];
  const leaderState = async () => (await view(leaderSite)).state!;
  /** What the room holds now, read the way a late joiner reads it: a lineup socket asks and the room answers. */
  const roomCopy = async () => {
    const probe = await socket(gus, bandId);
    probe.ws.send(js({ kind: "gig-state", gigId }));
    const answer = await message(probe, "the room's copy", (m) => m.kind === "gig-state");
    probe.ws.close();
    return answer.state as GigState | null;
  };
  const allAt = (rev: number, sitesToRead = followers) =>
    until(`rev ${rev} on every follower`, () => Promise.all(sitesToRead.map(view)), (views) => views.every((v) => v.state?.rev === rev), 10_000);

  // Sockets that must never be forwarded a change: a member off the lineup, and a lineup player who never joined the gig.
  const bench = await socket(ben, bandId);
  const idle = await socket(gus, bandId);

  await check("empty state: before the leader starts, the room answers with no state and the phone says 'Waiting for the leader'", async () => {
    await start(franSite, { me: fran.userId });
    const waiting = await until("the waiting words", () => view(franSite), (v) => v.words === WAITING_WORDS);
    assert.equal(waiting.state, null);
    assert.equal(await roomCopy(), null, "the room answers gig-state with null");
  });

  await start(leaderSite, { me: lee.userId });
  await start(gusSite, { me: gus.userId });
  await until("the leader in the room", () => view(leaderSite), (v) => v.leading);
  await call(leaderSite, `begin(${js({ order, admin: lee.userId, backup: sam.userId, lineup })})`);
  await until("two Wi-Fi links at the leader", () => view(leaderSite), (v) => v.followers.filter((f) => f.route === "wifi" && f.state === "open").length === 2, 15_000);
  await allAt(0, [franSite, gusSite]);

  const firstTaps: Tap[] = [];
  for (const body of [{ kind: "goTo", key: "s2" }, { kind: "section", index: 1 }, { kind: "goTo", key: "s3" }]) {
    firstTaps.push(await tap(body));
    await sleep(300);
  }

  await check("5. a late joiner through the room is current within 2 s", async () => {
    assert.ok(firstTaps.every((t) => t.ok), `the leader's taps go through (${js(firstTaps)})`);
    const rev = (await leaderState()).rev;
    const t0 = Date.now();
    await start(samSite, { me: sam.userId, rows: ["server"] });
    const current = await until("the late joiner current", () => view(samSite), (v) => v.state?.rev === rev, 2000);
    assert.ok(Date.now() - t0 <= 2000, `current in ${Date.now() - t0} ms`);
    assert.equal(current.heard.at(-1)?.via, "room", "it came through the room");
    assert.equal(current.state!.lastAt, (await leaderState()).lastAt);
  });

  const revsOneToThree = (await leaderState()).rev;
  const later: Tap[] = [];
  await check("1. every change reaches all three followers with one at", async () => {
    await until("Sam's server link", () => view(samSite), (v) => v.chosen?.route === "server" && v.chosen.state === "open", 15_000);
    for (const body of [{ kind: "goTo", key: "s4" }, { kind: "section", index: 2 }, { kind: "reorder", order: ["s1", "s2", "s3", "s4", "s6", "s5"] }, { kind: "goTo", key: "s5" }]) {
      const done = await tap(body);
      assert.ok(done.ok, `tap ${js(body)} goes through (${js(done)})`);
      later.push(done);
      const views = await allAt(done.rev!);
      const leader = await leaderState();
      for (const [i, seen] of views.entries()) {
        assert.equal(seen.state!.rev, leader.rev, `${names[i + 1]} has rev ${leader.rev}`);
        assert.equal(seen.state!.lastAt, leader.lastAt, `${names[i + 1]} has the one at ${leader.lastAt}`);
        assert.equal(seen.state!.key, leader.key);
      }
      await sleep(250);
    }
  });

  await check("2. the same rev on two links applies once", async () => {
    for (const [i, site] of followers.entries()) {
      const seen = await view(site);
      for (const done of later) {
        const copies = seen.heard.filter((h) => h.rev === done.rev);
        assert.equal(copies.filter((h) => h.result === "applied").length, 1, `${names[i + 1]} applies rev ${done.rev} once (${js(copies)})`);
        if (site !== samSite) {
          assert.ok(copies.length >= 2, `${names[i + 1]} hears rev ${done.rev} on its link and from the room (${js(copies)})`);
          assert.ok(copies.some((h) => h.via === "wifi") && copies.some((h) => h.via === "room"), `${names[i + 1]} rev ${done.rev}: both carriers (${js(copies)})`);
        } else {
          assert.ok(copies.every((h) => h.via === "room"), `Sam hears only the room (${js(copies)})`);
        }
      }
      assert.deepEqual(seen.applied.map((a) => a.rev), [...new Set(seen.applied.map((a) => a.rev))], `${names[i + 1]} never shows a rev twice`);
    }
    assert.ok(revsOneToThree < later[0].rev!);
  });

  await check("7. a repeat opId changes nothing on the room or any phone", async () => {
    const before = await Promise.all(followers.map(view));
    const room = (await roomCopy())!;
    assert.deepEqual(await call(leaderSite, "tapAgain()"), { ok: false, refused: "repeat" }, "the leader's own phone refuses its repeat");
    await call(leaderSite, "resendLast(false)");
    await call(leaderSite, "resendLast(true)");
    const told = await until("the room's refusals", () => view(leaderSite), (v) => v.refused.filter((r) => r.refused === "repeat").length >= 2);
    assert.ok(told.refused.slice(-2).every((r) => r.opId === later.at(-1)!.opId), `the room names the repeated op (${js(told.refused)})`);
    await sleep(500);
    const after = await Promise.all(followers.map(view));
    for (const [i, seen] of after.entries()) assert.equal(seen.state!.rev, before[i].state!.rev, `${names[i + 1]} still at rev ${before[i].state!.rev}`);
    assert.equal(after[2].heard.length, before[2].heard.length, "the room forwarded nothing to Sam");
    for (const i of [0, 1]) assert.ok(after[i].heard.slice(before[i].heard.length).every((h) => h.result === "duplicate"), `${names[i + 1]} dropped the link copy`);
    const roomAfter = (await roomCopy())!;
    assert.deepEqual([roomAfter.rev, roomAfter.recentOps], [room.rev, room.recentOps], "the room's copy is unchanged");
  });

  await check("8. a non-leader's op is refused by the room and never forwarded", async () => {
    const before = await Promise.all(followers.map(view));
    const room = (await roomCopy())!;
    const franTap = await call<Tap>(franSite, `tap(${js({ kind: "goTo", key: "s1" })})`);
    assert.deepEqual([franTap.ok, franTap.refused], [false, "not-allowed"], "Fran's own phone refuses her tap");
    const forged = (opId: string, leader: string) => ({ ...room, rev: room.rev + 1, leader, recentOps: [...room.recentOps, opId] });
    for (const [opId, leader] of [["fran-forged-1", fran.userId], ["fran-forged-2", lee.userId]]) {
      await call(franSite, `raw(${js({ kind: "gig-op", op: { kind: "goTo", key: "s1", opId, epoch: room.epoch }, state: forged(opId, leader), at: Date.now() })})`);
    }
    const told = await until("Fran's refusals", () => view(franSite), (v) => v.refused.filter((r) => r.refused === "not-allowed").length >= 2);
    assert.deepEqual(told.refused.slice(-2).map((r) => r.opId), ["fran-forged-1", "fran-forged-2"]);
    await sleep(500);
    const after = await Promise.all(followers.map(view));
    for (const i of [1, 2]) assert.equal(after[i].heard.length, before[i].heard.length, `nothing reached ${names[i + 1]}`);
    assert.equal(after[0].state!.rev, room.rev, "Fran's own state is unchanged");
    assert.equal((await roomCopy())!.rev, room.rev, "the room's copy is unchanged");
  });

  await check("9. the room forwards nothing to a socket that is not on the lineup", async () => {
    const done = await tap({ kind: "goTo", key: "s6" });
    assert.ok(done.ok);
    await allAt(done.rev!);
    await sleep(500);
    assert.equal(bench.hello?.kind, "hello", "Ben's socket is open in the band room");
    assert.deepEqual(bench.received.filter((m) => m.kind === "gig-state"), [], "no change reached Ben");
    assert.deepEqual(idle.received.filter((m) => m.kind === "gig-state"), [], "no change reached a lineup socket that never joined the gig");
    bench.ws.send(js({ kind: "gig-op", op: { kind: "goTo", key: "s1", opId: "ben-1", epoch: 0 }, state: { ...(await roomCopy())!, leader: ben.userId }, at: Date.now() }));
    const refusedBen = await message(bench, "Ben's refusal", (m) => m.kind === "gig-refused");
    assert.equal(refusedBen.refused, "not-on-lineup");
    bench.ws.send(js({ kind: "gig-state", gigId }));
    assert.equal(await serverClose(bench, "Ben's socket"), 4404, "asking for the gig off the lineup closes with not-on-lineup");
    assert.deepEqual(bench.received.filter((m) => m.kind === "gig-state"), [], "and Ben never got a copy");
  });

  await check("6. a change arriving 200 ms late shows on the next frame and is logged late", async () => {
    await call(gusSite, "delay(350)");
    const done = await tap({ kind: "goTo", key: "s2" });
    assert.ok(done.ok);
    const seen = await until("Gus showing s2", () => view(gusSite), (v) => v.shown.at(-1)?.key === "s2" && v.state?.rev === done.rev, 5000);
    await call(gusSite, "delay(0)");
    const entry = seen.heard.find((h) => h.rev === done.rev && h.result === "applied")!;
    assert.ok(entry.lateMs !== null && entry.lateMs >= 150 && entry.lateMs <= 450, `logged late by ${entry.lateMs} ms`);
    const appliedAt = seen.applied.find((a) => a.rev === done.rev)!.frame;
    const shownAt = seen.shown.find((s) => s.key === "s2" && s.rev === done.rev)!.frame;
    assert.equal(shownAt - appliedAt, 1, `shown on the next frame (applied after frame ${appliedAt}, shown at frame ${shownAt})`);
    const onTime = (await view(franSite)).heard.find((h) => h.rev === done.rev && h.result === "applied")!;
    assert.ok(onTime.lateMs !== null && onTime.lateMs <= 0, `Fran, with no delay, heard it before its at (${onTime.lateMs} ms)`);
  });

  await check("4. a route switch mid-click leaves the logged click times unchanged", async () => {
    const counted = await tap({ kind: "countIn", bpm: 120, beatsPerBar: 4, bars: 1, version: null, rate: 1 });
    assert.ok(counted.ok);
    await allAt(counted.rev!);
    const grid = (await leaderState()).click!;
    const fromClick = (await view(franSite)).clicks.length;
    await until("four clicks on Fran's phone", () => view(franSite), (v) => v.clicks.length - fromClick >= 4, 5000);
    await call(franSite, "switchToInternet()");
    await until("Fran's link over the internet", () => view(franSite), (v) => v.chosen?.route === "internet" && v.chosen.state === "open", 20_000);
    await sleep(2000);
    const fran = await view(franSite);
    const log = fran.clicks.slice(fromClick).filter((c) => c.rev === counted.rev);
    assert.ok(log.length >= 8, `clicks logged across the switch (${log.length})`);
    log.forEach((c, i) => i > 0 && assert.equal(c.index, log[i - 1].index + 1, `click ${c.index} follows ${log[i - 1].index}, none skipped or repeated`));
    for (const c of log) {
      assert.equal(c.at, grid.startAt + (c.index * 60_000) / grid.bpm, `click ${c.index} is at the leader's grid time`);
      assert.ok(Math.abs(c.shownAt - c.at) < 60, `click ${c.index} shown ${Math.round(c.shownAt - c.at)} ms from its time`);
    }
    assert.ok(!fran.heard.some((h) => h.result === "applied" && h.rev > counted.rev), "no new state came with the switch");
    const stopped = await tap({ kind: "stop" });
    assert.ok(stopped.ok);
    await allAt(stopped.rev!);
  });

  await check("timers: the leader's timers stay flat across 10 changes to three followers, and so do each follower's", async () => {
    const before = await Promise.all(sites.map(view));
    let last: Tap | null = null;
    for (let i = 0; i < 10; i += 1) {
      last = await tap({ kind: "section", index: 10 + i });
      assert.ok(last.ok);
      await sleep(100);
    }
    await allAt(last!.rev!);
    const after = await Promise.all(sites.map(view));
    const links = after[0].followers.length;
    assert.ok(after[0].timers <= before[0].timers + 1, `leader: ${before[0].timers} timers before, ${after[0].timers} after, over ${links} links`);
    for (const i of [1, 2, 3]) assert.ok(after[i].timers <= before[i].timers + 2, `${names[i]}: ${before[i].timers} timers before, ${after[i].timers} after`);
  });

  await check("3. a change from an old epoch is refused on every phone", async () => {
    await call(leaderSite, "save()");
    const took = await call<Tap>(samSite, `tap(${js({ kind: "takeOver" })})`);
    assert.ok(took.ok, `Sam, the backup, takes over (${js(took)})`);
    await until("epoch 1 everywhere", () => Promise.all(sites.map(view)), (views) => views.every((v) => v.state?.epoch === 1 && v.state.leader === sam.userId), 10_000);
    const before = await Promise.all(sites.map(view));
    const stale = await call<Tap>(leaderSite, `staleTap(${js({ kind: "goTo", key: "s4" })})`);
    assert.ok(stale.ok && stale.epoch === 0, `Lee, cut off, taps at epoch 0 (${js(stale)})`);
    const told = await until("the room's refusal", () => view(leaderSite), (v) => v.refused.some((r) => r.opId === stale.opId));
    assert.equal(told.refused.find((r) => r.opId === stale.opId)!.refused, "stale-epoch", "the room refuses it");
    for (const site of [franSite, gusSite]) {
      const seen = await until("the stale copy on the link", () => view(site), (v) => v.heard.some((h) => h.rev === stale.rev && h.epoch === 0));
      assert.equal(seen.heard.find((h) => h.rev === stale.rev && h.epoch === 0)!.result, "old-epoch", "the follower refuses it");
      assert.deepEqual([seen.state!.epoch, seen.state!.leader], [1, sam.userId]);
    }
    await sleep(500);
    const samAfter = await view(samSite);
    assert.equal(samAfter.heard.length, before[3].heard.length, "the room forwarded nothing to Sam");
    const own = await call<Tap>(leaderSite, `tap(${js({ kind: "goTo", key: "s4", epoch: 0 })})`);
    assert.deepEqual([own.ok, own.refused], [false, "stale-epoch"], "Lee's own phone refuses an epoch-0 tap now");
    const room = (await roomCopy())!;
    assert.deepEqual([room.epoch, room.leader], [1, sam.userId], "the room keeps Sam's epoch");
  });

  await check("tie: two take-overs reach the room in either order and the admin leads", async () => {
    const pure = await loadPure();
    const tieLineup = [lee.userId, gus.userId, sam.userId];
    for (const adminFirst of [false, true]) {
      const tieGig = await planGig(`Tie ${adminFirst ? "admin first" : "backup first"}`, gus, sam, tieLineup);
      const [gusWs, samWs, leeWs] = await Promise.all([socket(gus, bandId), socket(sam, bandId), socket(lee, bandId)]);
      for (const opened of [gusWs, samWs, leeWs]) {
        opened.ws.send(js({ kind: "gig-state", gigId: tieGig }));
        await message(opened, "the empty copy", (m) => m.kind === "gig-state");
      }
      const t = Date.now();
      const opening = pure.startGig({ gigId: tieGig, order, leader: gus.userId, admin: lee.userId, backup: sam.userId, lineup: tieLineup, route: "auto", scrollAlong: true, now: band(t) });
      gusWs.ws.send(js({ kind: "gig-start", state: opening, at: t }));
      await message(samWs, "the opening state", (m) => m.kind === "gig-state" && m.state?.rev === 0);
      const takeOver = (by: Player) => {
        const op = { kind: "takeOver", opId: `${by.handle}-take-${tieGig}`, epoch: 0 } as Op;
        const out = pure.reduce(opening, op, { by: by.userId, now: band(t + 1000), lead: LEAD });
        assert.ok(out.ok, `${by.name} may take over`);
        return { op, state: out.state };
      };
      const [first, second] = adminFirst ? [[leeWs, takeOver(lee)], [samWs, takeOver(sam)]] as const : [[samWs, takeOver(sam)], [leeWs, takeOver(lee)]] as const;
      first[0].ws.send(js({ kind: "gig-op", ...first[1], at: t + 1000 }));
      await message(gusWs, "the first take-over", (m) => m.kind === "gig-state" && m.state?.epoch === 1);
      second[0].ws.send(js({ kind: "gig-op", ...second[1], at: t + 1001 }));
      await sleep(500);
      const latest = gusWs.received.filter((m) => m.kind === "gig-state").at(-1)!;
      assert.deepEqual([latest.state.epoch, latest.state.leader], [1, lee.userId], `${adminFirst ? "admin first" : "backup first"}: Gus ends on the admin`);
      if (adminFirst) {
        const refusal = await message(samWs, "Sam's refusal", (m) => m.kind === "gig-refused");
        assert.equal(refusal.refused, "stale-epoch", "the backup's later take-over loses the tie at the room");
      } else {
        assert.ok(samWs.received.some((m) => m.kind === "gig-state" && m.state?.leader === lee.userId), "the backup hears the admin won");
      }
      const probe = await socket(gus, bandId);
      probe.ws.send(js({ kind: "gig-state", gigId: tieGig }));
      const kept = await message(probe, "the room's copy", (m) => m.kind === "gig-state");
      assert.deepEqual([kept.state.epoch, kept.state.leader, kept.state.claim], [1, lee.userId, "admin"], "the room keeps the admin's take-over");
      for (const opened of [gusWs, samWs, leeWs, probe]) opened.ws.close();
    }
  });

  await check("closing: every tab ends with no timer", async () => {
    for (const site of [...followers, leaderSite]) await call(site, "close()");
    await sleep(1500);
    for (const [i, site] of sites.entries()) assert.equal((await view(site)).timers, 0, `${names[i]} has no timer left`);
  });
} catch (error) {
  failures += 1;
  console.log(`FAIL setup\n     ${String((error as Error)?.stack ?? error)}`);
} finally {
  for (const ws of sockets) ws.close();
  stun.close();
  await Promise.all(sites.map((site) => site.close()));
  await stopWorker();
  rmSync(pageDir, { recursive: true, force: true });
}

console.log(failures ? `check:fanout: ${failures} failed` : "check:fanout ok");
process.exit(failures ? 1 : 0);
