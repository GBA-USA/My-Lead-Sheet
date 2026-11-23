/**
 * check:mirror (C21): following the gig live. Three parts, in this order because the later ones replace globals.
 *
 * 1. Real tabs: a leader, a backup on the Wi-Fi link, a member on the server route and a player off the lineup, each a
 *    headless browser tab running `src/gig-live.ts` against the Worker under Miniflare. The leader's band clock runs
 *    an offset from the machine clock, so every other tab has to measure it. There is no TURN server and no paid relay
 *    anywhere (Terry t28u): the server route is our own Worker's room socket.
 * 2. Fake clock: one phone's `liveGig` in Node against a stand-in room that plays the leader, on a clock the check
 *    moves, for the 10 s and 30 s detectors, 5 idle minutes, a 30 s freeze, a 200 ms late change and the hand-off.
 * 3. Fake DOM: the strip, Join gig and the click question as React renders them.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { SongContent } from "../src/band-library-model.ts";
import { startApi } from "./api-session.ts";
import { PASSWORD_PEPPER, passwordPlayer } from "./app-page.ts";
import { openSite, type Site } from "./chrome.ts";
import { fakeDom, type FakeElement } from "./fake-dom.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const js = (value: unknown) => JSON.stringify(value);
const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, performance: globalThis.performance };
const realSetTimeout = real.setTimeout;
const sleep = (ms: number) => new Promise((done) => realSetTimeout(done, ms));

const OFFSET = 98_765.4;
const BEAT = 500;
const FRAME = 1000 / 60;

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

const scratch = mkdtempSync(join(tmpdir(), "check-mirror-"));
async function bundle(name: string, contents: string, platform: "browser" | "node" = "browser"): Promise<any> {
  const out = await build({
    stdin: { contents, resolveDir: root, loader: "tsx" },
    bundle: true,
    write: false,
    format: "esm",
    platform,
    jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
    ...(platform === "node" ? { banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } } : {}),
    logLevel: "silent",
  });
  const file = join(scratch, `${name}.mjs`);
  writeFileSync(file, out.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await read().catch(() => null);
    if (seen !== null && ok(seen)) return seen;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${String(js(seen)).slice(0, 1500)}`);
    await sleep(50);
  }
}

// ================================================================ part 1: real tabs on the Worker

/**
 * Runs before any app code: holds every peer connection and data channel, and while `__deaf` is on drops every gig
 * state that arrives on a socket or a channel, the way a phone cut off from the band would miss them. The room's first
 * refusal turns the deafness off, so the phone hears the room's answer to it.
 */
const PAGE_HOOKS = `
window.__deaf = false; window.__dcs = [];
const Peer = window.RTCPeerConnection;
window.RTCPeerConnection = class extends Peer {
  createDataChannel(...args) { const dc = super.createDataChannel(...args); window.__dcs.push(dc); return dc; }
  addEventListener(type, listener, options) {
    if (type === "datachannel") return super.addEventListener(type, (event) => { window.__dcs.push(event.channel); listener(event); }, options);
    return super.addEventListener(type, listener, options);
  }
};
const deaf = (proto) => { const add = proto.addEventListener; proto.addEventListener = function (type, listener, options) {
  if (type !== "message") return add.call(this, type, listener, options);
  return add.call(this, type, (event) => {
    const data = typeof event.data === "string" ? event.data : "";
    if (window.__deaf && data.includes("gig-refused")) window.__deaf = false;
    else if (window.__deaf && data.includes("gig-state")) return;
    listener.call(this, event);
  }, options);
}; };
deaf(RTCDataChannel.prototype); deaf(WebSocket.prototype);
`;

function harnessEntry(dir: string) {
  const from = (file: string) => relative(dir, join(root, file)).replaceAll("\\", "/");
  return `
import { liveGig, stripOf } from ${js(from("src/gig-live.ts"))};
import { roomLine } from ${js(from("src/links/server-link.ts"))};
import { position } from ${js(from("src/gig-state.ts"))};
import { beatAt, beatTime } from ${js(from("src/band-time.ts"))};

let live = null, room = null, opts = null, raf = 0, frame = 0, taps = 0;
let flips = [], strips = [], beats = [], backwards = 0, lastBand = -Infinity, lastKey = null, lastStrip = null, lastBeat = null;
const localNow = () => performance.timeOrigin + performance.now();
const keep = (list, entry) => { list.push(entry); if (list.length > 4000) list.shift(); };
const gridAt = (click, t) => { let grid = null; for (const step of click) if (step.at <= t) grid = step.value; return grid; };
const strip = () => stripOf({ me: opts.me, gigName: opts.gigName, plannedLeader: opts.planned, names: opts.names, phase: "joined", view: live.view(), bandNow: live.bandNow() });

function frameLoop() {
  raf = requestAnimationFrame(frameLoop);
  frame += 1;
  if (!live) return;
  const t = live.bandNow();
  if (t !== null) { if (t < lastBand) backwards += 1; lastBand = t; }
  const s = strip();
  if (s.key !== lastStrip) { lastStrip = s.key; keep(strips, { frame, key: s.key, words: s.words, local: localNow(), heardAt: live.view().heardAt }); }
  const state = live.view().state;
  if (!state || t === null) return;
  const p = position(state, t);
  if (p.song.key !== lastKey) { keep(flips, { frame, from: lastKey, key: p.song.key, band: t, at: state.last ? state.last.at : null, err: t - (localNow() + opts.offset) }); lastKey = p.song.key; }
  const click = live.click();
  const grid = click && gridAt(click, t);
  const beat = grid ? beatAt(grid, t) : null;
  const id = beat ? beat.bar + ":" + beat.beat : null;
  if (id === lastBeat) return;
  lastBeat = id;
  if (!beat) return;
  const index = (beat.bar - grid.firstBar) * grid.beatsPerBar + beat.beat;
  keep(beats, { bar: beat.bar, beat: beat.beat, at: beatTime(grid, index), local: localNow() });
}

window.harness = {
  start(options) {
    opts = options;
    room = roomLine(location.origin.replace(/^http/, "ws") + "/api/rooms/" + options.bandId);
    live = liveGig({ me: options.me, gigId: options.gigId, room, stun: [], rows: options.rows, clock: () => localNow() + options.offset });
    if (!raf) frameLoop();
  },
  begin(plan) { live.start(plan); },
  tap(body) { const out = live.tap(body); return out.ok ? { ok: true, rev: out.state.rev, at: out.state.last ? out.state.last.at : null } : { ok: false, refused: out.refused }; },
  deafen() { window.__deaf = true; },
  view() {
    const v = live.view();
    const t = live.bandNow();
    return {
      leading: v.leading, route: v.route, confidence: v.confidence, heard: v.heard, steppedDown: v.steppedDown, offLineup: v.offLineup, refused: v.refused,
      state: v.state && { rev: v.state.rev, epoch: v.state.epoch, leader: v.state.leader, backup: v.state.backup, key: v.state.current[v.state.current.length - 1].value, status: v.state.status },
      strip: strip(), flips, strips, beats, backwards, frame, bandErr: t === null ? null : t - (localNow() + opts.offset),
    };
  },
  close() { live?.close(); room?.close(); live = room = null; if (raf) cancelAnimationFrame(raf); raf = 0; },
};
`;
}

function writeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "check-mirror-page-"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><title>mirror</title><script>${PAGE_HOOKS}</script><script type="module" src="./harness.ts"></script>`);
  writeFileSync(join(dir, "harness.ts"), harnessEntry(dir));
  return dir;
}

type Flip = { frame: number; from: string | null; key: string; band: number; at: number | null; err: number };
type StripLog = { frame: number; key: string; words: string; local: number; heardAt: number | null };
type BeatLog = { bar: number; beat: number; at: number; local: number };
type StripOut = { key: string; words: string; tone: string; flash: boolean; bars: number | null; quiet: boolean; takeOver: boolean; askToLead: boolean; waiting: string | null };
type View = {
  leading: boolean;
  route: string | null;
  confidence: string;
  heard: string;
  steppedDown: boolean;
  offLineup: boolean;
  refused: string | null;
  state: { rev: number; epoch: number; leader: string; backup: string | null; key: string; status: string } | null;
  strip: StripOut;
  flips: Flip[];
  strips: StripLog[];
  beats: BeatLog[];
  backwards: number;
  frame: number;
  bandErr: number | null;
};

const view = (site: Site) => site.evaluate<View>("window.harness.view()");
const call = <T>(site: Site, expression: string) => site.evaluate<T>(`window.harness.${expression}`);

async function signIn(site: Site, origin: string, cookie: string) {
  const cut = cookie.indexOf("=");
  await site.send("Network.setCookie", { name: cookie.slice(0, cut), value: cookie.slice(cut + 1), url: origin, httpOnly: true, secure: true, sameSite: "Lax" });
  await site.send("Page.navigate", { url: `${origin}/` });
  for (const end = Date.now() + 15_000; !(await site.evaluate<boolean>("!!window.harness").catch(() => false)); await sleep(100)) {
    if (Date.now() > end) throw new Error("the harness page never loaded");
  }
}

async function realTabs() {
  const sites: Site[] = [];
  const sockets: WebSocket[] = [];
  let apiBase = "";
  let stopWorker = async () => {};
  const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: (SongContent & { id: number })[] };
  try {
    const pageDir = writeHarness();
    for (const name of ["terry", "mike", "sam", "ben"]) sites.push(await openSite(pageDir, `check-mirror-${name}`, () => apiBase));
    const [terrySite, mikeSite, samSite, benSite] = sites;
    const origin = terrySite.origin;
    const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
    apiBase = base;
    stopWorker = () => worker.dispose();

    const terry = await passwordPlayer(base, origin, "Terry", "terrylead");
    const mike = await passwordPlayer(base, origin, "Mike", "mikebackup");
    const sam = await passwordPlayer(base, origin, "Sam", "samserver");
    const ben = await passwordPlayer(base, origin, "Ben", "benbench");
    const bandId = (await terry.call("/api/bands/create", { name: "The Mirror Testers" })).body.bandId as string;
    const invite = (await terry.call("/api/codes", { kind: "band", bandId })).body.code as string;
    for (const member of [mike, sam, ben]) assert.equal((await member.call("/api/bands/join", { code: invite })).status, 200, `${member.name} joins`);
    const songIds: string[] = [];
    for (const song of seed.songs.slice(0, 8)) {
      const { id: _id, ...content } = song;
      songIds.push((await terry.call("/api/bands/library/share-song", { bandId, song: content, choice: "public", localId: null })).body.songId);
    }
    const setlist = await terry.call("/api/bands/library/share-setlist", { bandId, name: "Elks set", songIds, tags: [], choice: "public", localId: null });
    const lineup = [terry, mike, sam].map((p) => p.userId);
    const planned = await terry.call("/api/bands/gig/plan", { bandId, setlistId: setlist.body.setlistId, name: "Friday at the Elks", date: "2026-11-27", lineup, leader: terry.userId, backup: mike.userId });
    assert.equal(planned.status, 200, `Terry plans the gig (${js(planned.body)})`);
    const gigId = planned.body.gig.gigId as string;
    const names = { [terry.userId]: "Terry", [mike.userId]: "Mike", [sam.userId]: "Sam", [ben.userId]: "Ben" };
    const common = { bandId, gigId, names, planned: terry.userId, gigName: "Friday at the Elks", offset: OFFSET };

    for (const [site, player] of [[terrySite, terry], [mikeSite, mike], [samSite, sam], [benSite, ben]] as const) await signIn(site, origin, player.cookie);
    await call(terrySite, `start(${js({ ...common, me: terry.userId })})`);
    await until("Terry leads", () => view(terrySite), (v) => v.leading);
    await call(mikeSite, `start(${js({ ...common, me: mike.userId })})`);
    await call(samSite, `start(${js({ ...common, me: sam.userId, rows: ["server"] })})`);
    await call(benSite, `start(${js({ ...common, me: ben.userId })})`);
    const order = songIds;
    await call(terrySite, `begin(${js({ order, admin: terry.userId, backup: mike.userId, lineup, route: "auto", scrollAlong: true })})`);

    const followers = [mikeSite, samSite];
    await until("Mike and Sam synced on rev 0", () => Promise.all(followers.map(view)), (vs) => vs.every((v) => v.confidence === "synced" && v.state?.rev === 0), 20_000);

    await check("lineup: the room marks the gig live once the leader starts it, and lists it for the lineup only", async () => {
      const listed = await until("the gig listed live", () => terry.call("/api/bands/gig/list", { bandId }), (r) => r.body.gigs?.[0]?.gig.status === "live");
      assert.equal(listed.body.gigs[0].gig.gigId, gigId);
      const samLive = await sam.call("/api/bands/gig/live", {});
      assert.equal(samLive.status, 200, js(samLive.body));
      assert.deepEqual(samLive.body.gigs.map((g: { gigId: string; status: string }) => [g.gigId, g.status]), [[gigId, "live"]], "Sam's phone hears the gig is live");
      const benLive = await ben.call("/api/bands/gig/live", {});
      assert.deepEqual(benLive.body.gigs, [], "Ben, off the lineup, hears of no live gig");
      const benPack = await ben.call("/api/bands/gig/pack", { bandId, gigId });
      assert.equal(benPack.status, 403);
      assert.equal(benPack.body.error, "not-on-lineup");
      const locked = await terry.call("/api/bands/gig/songs", { bandId, gigId, songIds: [...songIds].reverse() });
      assert.equal(locked.body.error, "set-locked", "a live gig's set is locked");
    });

    await check("4. an off-lineup member gets 'This gig is for tonight's lineup' and no state (socket 4404)", async () => {
      const benView = await until("Ben refused", () => view(benSite), (v) => v.offLineup);
      assert.equal(benView.state, null, "Ben's phone has no gig state");
      assert.equal(benView.strip.words, "This gig is for tonight's lineup");
      const ws = new WebSocket(ben.socketUrl(bandId), { headers: { origin, cookie: ben.cookie } } as unknown as string[]);
      sockets.push(ws);
      const received: { kind: string }[] = [];
      ws.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))));
      const closed = new Promise<number>((done) => ws.addEventListener("close", (event) => done(event.code)));
      await until("Ben's hello", async () => received.length, (n) => n > 0, 5000);
      ws.send(js({ kind: "gig-state", gigId }));
      for (const end = Date.now() + 5000; ws.readyState === WebSocket.OPEN && Date.now() < end; ) await sleep(50);
      ws.close();
      assert.equal(await closed, 4404, "the room closes Ben's socket with 4404");
      assert.ok(!received.some((m) => m.kind === "gig-state"), "the room sent Ben no state");
    });

    await check("1. Next lands at one at within 1 ms in the log on three tabs", async () => {
      const tapped = await call<{ ok: boolean; at: number | null }>(terrySite, `tap(${js({ kind: "countIn", bpm: 120, beatsPerBar: 4, bars: 1, version: null, rate: 1 })})`);
      assert.ok(tapped.ok, js(tapped));
      await sleep(2500);
      const next = await call<{ ok: boolean; at: number | null }>(terrySite, `tap(${js({ kind: "goTo", key: order[1] })})`);
      assert.ok(next.ok && next.at !== null, js(next));
      const sitesAll = [terrySite, mikeSite, samSite];
      const views = await until("all three flipped to song 2", () => Promise.all(sitesAll.map(view)), (vs) => vs.every((v) => v.flips.some((f) => f.key === order[1])), 10_000);
      const flips = views.map((v) => v.flips.find((f) => f.key === order[1])!);
      for (const flip of flips) assert.ok(Math.abs(flip.at! - next.at!) <= 1, `the flip's logged at ${flip.at} is the leader's ${next.at}`);
      for (const flip of flips) assert.ok(flip.band >= next.at! - FRAME / 2 - 1 && flip.band <= next.at! + 2 * FRAME, `the flip shows on the frame at its at (${(flip.band - next.at!).toFixed(1)} ms)`);
      for (const flip of flips.slice(1)) assert.ok(Math.abs(flip.err) <= 8, `each tab's band clock is within 8 ms of the leader's (${flip.err.toFixed(2)} ms)`);
      console.log(`     measured clock error at the flip: ${flips.map((f) => f.err.toFixed(2)).join(", ")} ms; flip minus at: ${flips.map((f) => (f.band - next.at!).toFixed(1)).join(", ")} ms`);
      const [mikeNow, samNow] = await Promise.all(followers.map(view));
      assert.equal(mikeNow.route, "wifi", "Mike is on the Wi-Fi link");
      assert.equal(samNow.route, "server", "Sam is on the server route");
    });

    await check("9. the strip says who is leading, the route word and the bars, and no tab's text says 'follower'", async () => {
      const [mikeNow, samNow, terryNow] = await Promise.all([mikeSite, samSite, terrySite].map(view));
      assert.equal(mikeNow.strip.words, "● Terry is leading · Wi-Fi link");
      assert.equal(samNow.strip.words, "● Terry is leading · Through the server");
      assert.ok((mikeNow.strip.bars ?? 0) >= 1 && (samNow.strip.bars ?? 0) >= 1, "both strips show sync bars");
      assert.equal(mikeNow.strip.tone, "gold", "gold while the planned leader leads");
      for (const v of [mikeNow, samNow, terryNow]) assert.ok(!/follower/i.test(js(v.strip) + js(v.strips.map((s) => s.words))), "no strip words say follower");
    });

    await check("3. an old leader's op is refused and its phone shows 'Mike is leading' with Ask to lead", async () => {
      await call(terrySite, "deafen()");
      const took = await call<{ ok: boolean }>(mikeSite, `tap(${js({ kind: "takeOver" })})`);
      assert.ok(took.ok, `Mike takes the lead (${js(took)})`);
      await until("Sam follows Mike", () => view(samSite), (v) => v.state?.leader === mike.userId && v.state.epoch === 1);
      const stale = await call<{ ok: boolean }>(terrySite, `tap(${js({ kind: "goTo", key: order[2] })})`);
      assert.ok(stale.ok, "Terry's phone, cut off, still applies its own tap");
      const terryNow = await until("Terry steps down", () => view(terrySite), (v) => v.steppedDown && v.state?.leader === mike.userId, 15_000);
      assert.equal(terryNow.refused, "stale-epoch", "the room refused Terry's op as stale-epoch");
      assert.equal(terryNow.strip.words, "Mike is leading");
      assert.ok(terryNow.strip.askToLead, "Terry's strip has Ask to lead");
      const again = await call<{ ok: boolean; refused?: string }>(terrySite, `tap(${js({ kind: "goTo", key: order[3] })})`);
      assert.equal(again.ok, false, "Terry's later taps are refused");
      const samNow = await until("Sam's strip turns blue", () => view(samSite), (v) => v.strip.tone === "blue", 10_000);
      assert.equal(samNow.state?.key, order[1], "Sam never showed Terry's stale song");
      assert.ok(!samNow.flips.some((f) => f.key === order[2]), "Sam never flipped to Terry's stale song");
    });

    await check("2. a tab off for 30 s rejoins on the right bar with no backward jump and no double flip", async () => {
      const count = await call<{ ok: boolean }>(mikeSite, `tap(${js({ kind: "countIn", bpm: 120, beatsPerBar: 4, bars: 1, version: null, rate: 1 })})`);
      assert.ok(count.ok, js(count));
      await sleep(3000);
      const before = await view(samSite);
      await samSite.send("Page.setWebLifecycleState", { state: "frozen" });
      const frozenAt = Date.now();
      await sleep(5000);
      const moved = await call<{ ok: boolean; at: number | null }>(mikeSite, `tap(${js({ kind: "goTo", key: order[4] })})`);
      assert.ok(moved.ok, js(moved));
      await sleep(3000);
      const counted = await call<{ ok: boolean }>(mikeSite, `tap(${js({ kind: "countIn", bpm: 120, beatsPerBar: 4, bars: 1, version: null, rate: 1 })})`);
      assert.ok(counted.ok, js(counted));
      await sleep(Math.max(0, 30_000 - (Date.now() - frozenAt)));
      await samSite.send("Page.setWebLifecycleState", { state: "active" });
      await samSite.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      const back = await until("Sam synced again on Mike's song", () => view(samSite), (v) => v.confidence === "synced" && v.state?.key === order[4] && v.beats.length > before.beats.length + 2, 30_000);
      const after = back.strips.filter((s) => s.frame > before.frame);
      assert.ok(after.some((s) => s.key === "syncing"), `the strip said Syncing on the way back (${js(after.map((s) => s.key))})`);
      assert.equal(back.backwards, 0, "band time never went backward on Sam's tab");
      const newFlips = back.flips.filter((f) => f.frame > before.frame);
      assert.deepEqual(newFlips.map((f) => f.key), [order[4]], `one flip, straight to the band's song (${js(newFlips)})`);
      const rejoined = back.beats.filter((b) => b.local > (newFlips[0]?.band ?? 0) - OFFSET);
      assert.ok(rejoined.length > 0, "Sam clicks again");
      assert.equal(rejoined[0].beat, 0, `the click comes back on a bar line (${js(rejoined[0])})`);
    });

    await check("10. 'isn't answering' at 10 s and 'dropped · still on N' at 30 s with the beat continuing (leader tab closed)", async () => {
      const playing = await until("Sam clicking with Mike", () => view(samSite), (v) => v.confidence === "synced" && v.beats.length > 0);
      const songNumber = order.indexOf(playing.state!.key) + 1;
      const closedAt = Date.now();
      await call(mikeSite, "close()");
      await mikeSite.close();
      sites.splice(sites.indexOf(mikeSite), 1);
      const quiet = await until("isn't answering", () => view(samSite), (v) => v.strips.some((s) => s.key === "quiet"), 25_000);
      const quietLog = quiet.strips.filter((s) => s.key === "quiet").pop()!;
      const quietAfter = (quietLog.local - quietLog.heardAt!) / 1000;
      assert.equal(quiet.strip.words, "Mike's phone isn't answering");
      assert.ok(quietAfter >= 9.9 && quietAfter <= 11, `isn't answering 10 s after the last answer (${quietAfter.toFixed(2)} s)`);
      assert.ok(quietLog.local - closedAt <= 15_000, "and within 15 s of the tab closing");
      const dropped = await until("dropped", () => view(samSite), (v) => v.strips.some((s) => s.key === "dropped"), 40_000);
      const droppedLog = dropped.strips.filter((s) => s.key === "dropped").pop()!;
      const droppedAfter = (droppedLog.local - droppedLog.heardAt!) / 1000;
      assert.equal(dropped.strip.words, `Mike's phone dropped · still on ${songNumber}`);
      assert.ok(droppedAfter >= 29.9 && droppedAfter <= 31, `dropped 30 s after the last answer (${droppedAfter.toFixed(2)} s)`);
      const lastBeat = dropped.beats[dropped.beats.length - 1];
      assert.ok(Date.now() - lastBeat.local < 2000, "the beat is still going on Sam's tab");
      assert.equal(dropped.strip.takeOver, false, "Sam, a member, has no take-over button");
      assert.equal(dropped.strip.waiting, "Waiting for the admin", "Sam is told who can take the lead");
      const terryNow = await until("Terry hears the drop", () => view(terrySite), (v) => v.strip.key === "dropped" || v.strip.takeOver, 10_000);
      assert.ok(terryNow.strip.takeOver, "Terry, the admin, has the take-over button");
    });
  } catch (error) {
    failures += 1;
    console.log(`FAIL the real tabs could not run\n     ${String((error as Error)?.stack ?? error).split("\n").slice(0, 8).join("\n     ")}`);
  } finally {
    for (const ws of sockets) ws.close();
    for (const site of sites) {
      await site.evaluate("window.harness && window.harness.close()").catch(() => {});
      await site.close().catch(() => {});
    }
    await stopWorker().catch(() => {});
  }
}

// ================================================================ part 2: one phone on a clock the check moves

type L = any;

async function fakeClock() {
  const ORIGIN = 1_763_000_000_000;
  const L: L = await bundle(
    "live",
    `export * from "./src/gig-live.ts";
     export { startGig, reduce, receive, position } from "./src/gig-state.ts";
     export * as bandTime from "./src/band-time.ts";
     export { isMuted } from "./src/chat-model.ts";`,
  );
  const clock = { now: 0 };
  const timers = new Map<number, { at: number; run: () => void; every: number | null }>();
  let ids = 0;
  Object.assign(globalThis, {
    setTimeout: (run: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) => {
      const id = (ids += 1);
      timers.set(id, { at: clock.now + Math.max(0, ms), run: () => run(...args), every: null });
      return id;
    },
    clearTimeout: (id: number) => void timers.delete(id),
    setInterval: (run: () => void, ms: number) => {
      const id = (ids += 1);
      timers.set(id, { at: clock.now + ms, run, every: ms });
      return id;
    },
    clearInterval: (id: number) => void timers.delete(id),
  });
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { timeOrigin: ORIGIN, now: () => clock.now } });
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((done) => setImmediate(done));
  };
  /** Moves the clock, firing each timer at its time, and calls `onFrame` on every 60 Hz frame. */
  async function advance(ms: number, onFrame?: (local: number) => void) {
    const end = clock.now + ms;
    let frameAt = onFrame ? (Math.floor(clock.now / FRAME) + 1) * FRAME : Infinity;
    for (;;) {
      const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      const next = Math.min(due ? due[1].at : Infinity, frameAt);
      if (next > end) break;
      clock.now = Math.max(clock.now, next);
      if (due && due[1].at <= frameAt) {
        if (due[1].every === null) timers.delete(due[0]);
        else due[1].at += due[1].every;
        due[1].run();
        await flush();
      } else {
        onFrame!(clock.now);
        frameAt += FRAME;
      }
    }
    clock.now = end;
    await flush();
  }
  const local = () => ORIGIN + clock.now;
  const truth = () => local() + OFFSET;
  const GIG = "gig_mirror_fake";
  const order = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];
  const lineup = ["terry", "mike", "sam"];
  const names = { terry: "Terry", mike: "Mike", sam: "Sam", ann: "Ann" };
  let opCount = 0;
  const op = (state: any, body: object) => ({ ...body, opId: `t-${(opCount += 1)}`, epoch: state.epoch });
  const lead = (state: any, body: object, by = "terry") => {
    const out = L.reduce(state, op(state, body), { by, now: truth(), lead: 150 });
    assert.ok(out.ok, `the leader's ${js(body)} applies (${js(out)})`);
    return out.state;
  };

  /** The band room and the leader's phone behind it, as one phone's room socket sees them. */
  function stage(me: string, oneWayMs = 20, jitter: () => number = () => 0) {
    const listeners = new Set<(m: any) => void>();
    const room = {
      state: "open" as "connecting" | "open" | "down" | "refused",
      held: null as any,
      leaderOn: true,
      lastPong: 0,
      sent: [] as any[],
      tell: (m: any) => [...listeners].forEach((cb) => cb(m)),
      send(m: any) {
        if (room.state !== "open") return false;
        room.sent.push(m);
        const later = (ms: number, run: () => void) => globalThis.setTimeout(run, ms);
        if (m.kind === "join-gig") later(1, () => room.tell({ kind: "gig", gigId: GIG, you: `${me}-sock`, leader: room.held?.leader === me ? `${me}-sock` : room.leaderOn ? "lead-sock" : null, openedAt: 0 }));
        if (m.kind === "gig-state") later(1, () => room.tell(room.held ? { kind: "gig-state", state: room.held, at: room.held.changedAt } : { kind: "gig-state", state: null, at: null }));
        if (m.kind === "link" && m.body?.k === "ping") {
          if (!room.leaderOn) later(1, () => room.tell({ kind: "error", error: "no-peer", to: m.to }));
          else later(oneWayMs, () => {
            const band = truth() + jitter();
            later(oneWayMs, () => {
              room.lastPong = clock.now;
              room.tell({ kind: "link", from: "lead-sock", body: { k: "pong", n: m.body.n, t0: m.body.t0, band }, rx: 0, tx: 0 });
            });
          });
        }
        if (m.kind === "gig-op" || m.kind === "gig-start") room.held = m.state;
        return true;
      },
      listen(cb: (m: any) => void) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      close() {
        listeners.clear();
      },
      push(state: any, delayMs = oneWayMs) {
        room.held = state;
        globalThis.setTimeout(() => room.tell({ kind: "gig-state", state, at: state.changedAt }), delayMs);
      },
      down() {
        room.state = "down";
        room.tell({ kind: "room-down" });
      },
      up() {
        room.state = "open";
        room.tell({ kind: "hello", you: `${me}-sock`, peers: [], lineups: [GIG] });
      },
    };
    return room;
  }

  const begin = (extra: object = {}) => L.startGig({ gigId: GIG, order, leader: "terry", admin: "terry", backup: "mike", lineup, route: "auto", scrollAlong: true, now: truth(), ...extra });
  const phone = (me: string, room: ReturnType<typeof stage>) => {
    let changes = 0;
    const live = L.liveGig({ me, gigId: GIG, room, stun: [], rows: ["server"], onChange: () => (changes += 1) });
    return { live, changes: () => changes };
  };
  const strip = (live: any, me: string, phase = "joined") => L.stripOf({ me, gigName: "Friday at the Elks", plannedLeader: "terry", names, phase, view: live.view(), bandNow: live.bandNow() });
  const gridAt = (click: any[], t: number) => {
    let grid = null;
    for (const step of click) if (step.at <= t) grid = step.value;
    return grid;
  };

  await check("timer: one owner for the 10 s and 30 s detectors, so 200 pings and 50 states leave the pending timers flat", async () => {
    const room = stage("sam");
    room.push(begin(), 0);
    const { live } = phone("sam", room);
    await advance(5_000);
    const settled = timers.size;
    for (let i = 0; i < 50; i += 1) {
      room.push(lead(room.held, { kind: "section", index: i }));
      await advance(4_000);
    }
    assert.ok(timers.size <= settled + 1, `pending timers ${settled} at the start, ${timers.size} after 200 s of pings and 50 states`);
    live.close();
    await advance(100);
    assert.equal(timers.size, 0, "closing stops every timer");
  });

  await check("10. (fake clock) 'isn't answering' at 10 s and 'dropped · still on 7' at 30 s, the beat continuing", async () => {
    const room = stage("sam");
    let state = begin();
    state = lead(state, { kind: "goTo", key: "s7" });
    room.push(state, 0);
    const { live } = phone("sam", room);
    await advance(3_000);
    room.push(lead(room.held, { kind: "countIn", bpm: 120, beatsPerBar: 4, bars: 1, version: null, rate: 1 }));
    await advance(3_000);
    assert.equal(strip(live, "sam").words, "● Terry is leading · Through the server");
    room.leaderOn = false;
    const dropAt = clock.now;
    let quietAt: number | null = null;
    let droppedAt: number | null = null;
    const beatsSeen = new Set<string>();
    await advance(35_000, () => {
      const s = strip(live, "sam");
      if (s.key === "quiet" && quietAt === null) quietAt = clock.now - room.lastPong;
      if (s.key === "dropped" && droppedAt === null) droppedAt = clock.now - room.lastPong;
      const click = live.click();
      const t = live.bandNow();
      const grid = click && gridAt(click, t);
      if (grid && clock.now - dropAt > 31_000) beatsSeen.add(js(L.bandTime.beatAt(grid, t)));
    });
    assert.ok(quietAt !== null && quietAt >= 10_000 - 1 && quietAt < 10_000 + 100, `isn't answering 10 s after the last answer (${quietAt})`);
    assert.ok(droppedAt !== null && droppedAt >= 30_000 - 1 && droppedAt < 30_000 + 100, `dropped 30 s after the last answer (${droppedAt})`);
    assert.ok(dropAt - room.lastPong <= 5_000, "the leader answered within one server ping of going quiet");
    const now = strip(live, "sam");
    assert.equal(now.words, "Terry's phone dropped · still on 7");
    assert.equal(now.waiting, "Waiting for Mike (backup) or the admin");
    assert.ok(beatsSeen.size >= 6, `the beat goes on after the drop (${beatsSeen.size} beats in 4 s)`);
    live.close();
  });

  await check("5. a non-backup member has no take-over button and the backup and admin do (PLAN 6 and 7.13)", () => {
    const state = begin();
    const at = (me: string, heard: string) => L.mayTakeOver(state, me, heard);
    assert.equal(at("sam", "dropped"), false, "a member never");
    assert.equal(at("mike", "answering"), false, "the backup not while the leader answers");
    assert.equal(at("mike", "dropped"), true, "the backup after the leader drops");
    const admin = { ...state, admin: "ann", lineup: [...lineup, "ann"] };
    assert.equal(L.mayTakeOver(admin, "ann", "answering"), true, "the admin any time");
    assert.equal(L.mayTakeOver(state, "terry", "dropped"), false, "not the leader itself");
  });

  await check("drill: the leader changes the backup mid-gig, so the new backup gets the button and the old one loses it", () => {
    const state = lead(begin(), { kind: "setBackup", userId: "sam" });
    assert.equal(L.mayTakeOver(state, "sam", "dropped"), true);
    assert.equal(L.mayTakeOver(state, "mike", "dropped"), false);
  });

  await check("drill: handoff mid-song with the click running, the new leader adopts band time and steps under the click max", async () => {
    const room = stage("mike", 15);
    let state = begin();
    state = lead(state, { kind: "countIn", bpm: 120, beatsPerBar: 4, bars: 1, version: null, rate: 1 });
    room.push(state, 0);
    const { live } = phone("mike", room);
    await advance(4_000);
    assert.equal(live.view().confidence, "synced");
    const before = live.bandNow() - truth();
    const took = live.tap({ kind: "takeOver" });
    assert.ok(took.ok, js(took));
    assert.ok(live.view().leading || room.held.leader === "mike", "Mike leads");
    await advance(3_000);
    const after = live.bandNow() - truth();
    assert.ok(Math.abs(after - before) < 10, `the step on Mike's phone is ${(after - before).toFixed(3)} ms, under the 10 ms click max`);
    assert.equal(room.held.leader, "mike");
    assert.equal(room.held.epoch, 1);
    const s = strip(live, "mike");
    assert.equal(s.key, "leading");
    live.close();
  });

  await check("drill: two people take the lead offline at once, the admin wins and the backup steps down when it hears the admin", async () => {
    const plan = { admin: "ann", lineup: [...lineup, "ann"] };
    const start = begin(plan);
    const byAdmin = L.reduce(start, op(start, { kind: "takeOver" }), { by: "ann", now: truth(), lead: 150 }).state;
    const byBackup = L.reduce(start, op(start, { kind: "takeOver" }), { by: "mike", now: truth(), lead: 150 }).state;
    assert.equal(L.receive(byAdmin, byBackup).state.leader, "ann");
    assert.equal(L.receive(byBackup, byAdmin).state.leader, "ann");
    const room = stage("mike");
    room.push(start, 0);
    const { live } = phone("mike", room);
    await advance(4_000);
    room.down();
    assert.ok(live.tap({ kind: "takeOver" }).ok, "Mike takes the lead with no room");
    assert.equal(live.view().state.leader, "mike");
    room.state = "open";
    room.push(byAdmin, 0);
    await advance(500);
    assert.equal(live.view().state.leader, "ann", "Mike's phone follows Ann");
    assert.equal(live.view().leading, false, "Mike steps down");
    live.close();
  });

  await check("8. nothing moves in 5 idle minutes (fake clock)", async () => {
    const room = stage("sam");
    let state = lead(begin(), { kind: "goTo", key: "s3" });
    state = lead(state, { kind: "section", index: 2 });
    room.push(state, 0);
    const { live } = phone("sam", room);
    await advance(5_000);
    const first = L.position(live.view().state, live.bandNow());
    const seen = new Set<string>();
    let clicks = 0;
    await advance(300_000, () => {
      const p = L.position(live.view().state, live.bandNow());
      seen.add(js({ song: p.song, section: p.section, beat: p.beat, scroll: p.scroll }));
      const click = live.click();
      if (click && gridAt(click, live.bandNow())) clicks += 1;
    });
    assert.deepEqual([...seen], [js({ song: first.song, section: first.section, beat: null, scroll: null })], `one picture for 5 minutes (${seen.size})`);
    assert.equal(clicks, 0, "no click between songs");
    assert.equal(live.view().state.rev, state.rev, "no change arrived");
    live.close();
  });

  await check("drill: spread above 8 ms for 10 s says 'Out of sync · fixing' with click and dot quiet", async () => {
    let flip = 1;
    const room = stage("sam", 20, () => (flip = -flip) * 9);
    room.push(lead(begin(), { kind: "countIn", bpm: 120, beatsPerBar: 4, bars: 1, version: null, rate: 1 }), 0);
    const { live } = phone("sam", room);
    await advance(16_000);
    const s = strip(live, "sam");
    assert.equal(s.words, "Out of sync · fixing");
    assert.equal(s.tone, "amber");
    assert.ok(s.quiet, "the strip says click and dot are quiet");
    assert.equal(live.click(), null, "no click while out of sync");
    live.close();
  });

  await check("drill: a change arriving 200 ms late shows on the next frame, and the click stays on the grid", async () => {
    const room = stage("sam");
    room.push(lead(begin(), { kind: "countIn", bpm: 120, beatsPerBar: 4, bars: 1, version: null, rate: 1 }), 0);
    const { live } = phone("sam", room);
    await advance(4_000);
    const gridBefore = js(live.click()?.filter((s: any) => s.value));
    const turned = lead(room.held, { kind: "section", index: 3 });
    const at = turned.last.at;
    room.push(turned, at - truth() + 200);
    let shownAt: number | null = null;
    await advance(at - truth() + 1_000, () => {
      if (shownAt === null && L.position(live.view().state, live.bandNow()).section === 3) shownAt = live.bandNow();
    });
    assert.ok(shownAt !== null && shownAt - at >= 199 && shownAt - at <= 200 + FRAME + 1, `the page turn shows on the first frame after it arrives (${shownAt! - at} ms after its at)`);
    assert.equal(js(live.click()?.filter((s: any) => s.value)), gridBefore, "the click grid is the same grid");
    live.close();
  });

  await check("2. (fake clock) a phone locked 30 s rejoins on the next bar, never backward, flipping once", async () => {
    const room = stage("sam");
    room.push(lead(begin(), { kind: "countIn", bpm: 120, beatsPerBar: 4, bars: 1, version: null, rate: 1 }), 0);
    const { live } = phone("sam", room);
    await advance(4_000);
    room.down();
    clock.now += 10_000;
    room.held = lead(room.held, { kind: "goTo", key: "s5" });
    clock.now += 2_000;
    room.held = lead(room.held, { kind: "countIn", bpm: 120, beatsPerBar: 4, bars: 1, version: null, rate: 1 });
    clock.now += 18_000;
    live.wake();
    room.up();
    let last = -Infinity;
    let backwards = 0;
    const keys: string[] = [];
    const syncingSeen: string[] = [];
    let firstClick: any = null;
    await advance(6_000, () => {
      const t = live.bandNow();
      if (t === null) return;
      if (t < last) backwards += 1;
      last = t;
      syncingSeen.push(strip(live, "sam").key);
      const key = L.position(live.view().state, t).song.key;
      if (keys[keys.length - 1] !== key) keys.push(key);
      const click = live.click();
      const grid = click && gridAt(click, t);
      if (grid && !firstClick) firstClick = L.bandTime.beatAt(grid, t);
    });
    assert.equal(backwards, 0, "band time never went backward");
    assert.ok(syncingSeen.includes("syncing"), "Syncing shows on the way back");
    assert.deepEqual(keys, ["s1", "s5"], `one flip, straight to the band's song (${js(keys)})`);
    assert.ok(firstClick && firstClick.beat === 0, `the click comes back on the 1 (${js(firstClick)})`);
    live.close();
  });

  await check("11. with Scroll with the leader off the charts don't scroll but clicks and page turns still mirror", () => {
    let state = L.startGig({ gigId: GIG, order, leader: "terry", admin: "terry", backup: "mike", lineup, route: "auto", scrollAlong: false, now: truth() });
    state = lead(state, { kind: "countIn", bpm: 120, beatsPerBar: 4, bars: 1, version: null, rate: 1 });
    state = lead(state, { kind: "section", index: 2 });
    const refused = L.reduce(state, op(state, { kind: "scrollStart", version: null, rate: 1, fromSec: 0 }), { by: "terry", now: truth(), lead: 150 });
    assert.equal(refused.refused, "scroll-off");
    const p = L.position(state, truth() + 5_000);
    assert.equal(p.scroll, null, "no band scroll");
    assert.ok(p.beat, "the click runs");
    assert.equal(p.section, 2, "the page turn lands");
    assert.equal(L.scrollsWithLeader(state), false);
    assert.equal(L.scrollsWithLeader({ ...state, scrollAlong: true }), true);
  });

  await check("12. band chat is muted on stage during a live gig", () => {
    const chats = [
      { roomId: "band_1", kind: "band", lastSeq: 5, lastReadSeq: 1, mutedUntil: null, lastAt: 1 },
      { roomId: "dm_1", kind: "dm", lastSeq: 3, lastReadSeq: 1, mutedUntil: null, lastAt: 1 },
      { roomId: "band_2", kind: "band", lastSeq: 2, lastReadSeq: 1, mutedUntil: null, lastAt: 1 },
    ];
    assert.equal(L.unreadOnStage(chats, 0, null), 7, "off stage every unread counts");
    assert.equal(L.unreadOnStage(chats, 0, "band_1"), 2, "on stage the gig's band thread is quiet, and only it");
    assert.equal(L.isMuted(chats[0], 0, true), true);
  });

  await check("14. the strip is gold while the primary leads, blue once the backup takes over, flashing on the beat for 2 bars, then settling", () => {
    const base = begin();
    const viewOf = (state: any, extra: object = {}) => ({ state, leading: false, confidence: "synced", spread: 1, route: "wifi", heard: "answering", signal: true, offLineup: false, steppedDown: false, refused: null, handoffAt: null, asks: [], ...extra });
    const input = (view: any, bandNow: number) => ({ me: "sam", gigName: "Friday at the Elks", plannedLeader: "terry", names, phase: "joined", view, bandNow });
    const gold = L.stripOf(input(viewOf(base), truth()));
    assert.equal(gold.tone, "gold");
    assert.equal(gold.flash, false);
    let running = L.reduce(base, op(base, { kind: "countIn", bpm: 120, beatsPerBar: 4, bars: 1, version: null, rate: 1 }), { by: "terry", now: truth(), lead: 150 }).state;
    const handoffAt = truth() + 2_000;
    running = L.reduce(running, op(running, { kind: "takeOver" }), { by: "mike", now: handoffAt, lead: 150 }).state;
    const grid = running.click[running.click.length - 1].value;
    const firstBeat = Math.ceil((handoffAt - grid.startAt) / BEAT) * BEAT + grid.startAt;
    const on: number[] = [];
    let lit = false;
    for (let t = handoffAt; t < handoffAt + 8_000; t += 5) {
      const s = L.stripOf(input(viewOf(running, { handoffAt }), t));
      assert.equal(s.tone, "blue", "blue while the backup leads");
      if (s.flash && !lit) on.push(t);
      lit = s.flash;
    }
    assert.equal(L.FLASH_BARS, 2);
    const expected = Array.from({ length: 8 }, (_, i) => firstBeat + i * BEAT);
    assert.equal(on.length, 8, `one flash on each of the 8 beats of 2 bars, then none (${on.length} flashes)`);
    on.forEach((t, i) => assert.ok(t >= expected[i] - 1 && t - expected[i] <= 6, `flash ${i + 1} starts on its beat (${(t - expected[i]).toFixed(2)} ms)`));
    const settled = L.stripOf(input(viewOf(running, { handoffAt }), handoffAt + 6_000));
    assert.equal(settled.flash, false, "settled after 2 bars");
    assert.equal(L.handoffFlash(handoffAt, null, handoffAt + 10), true, "between songs it still flashes, on a 120 bpm beat");
    assert.equal(L.handoffFlash(handoffAt, null, handoffAt + 4_100), false);
  });

  await check("9. the strip words table: who leads, the route word, the bars, every state, and no 'follower'", () => {
    const facts = { gig: "Friday at the Elks", leader: "Terry", route: "Wi-Fi link", backup: "Mike", songNumber: 7 };
    const words = Object.fromEntries(Object.entries(L.STRIP_WORDS).map(([key, say]: [string, any]) => [key, say(facts)]));
    assert.equal(words.join, "Friday at the Elks is live · Join gig");
    assert.equal(words.getting, "Getting the setlist…");
    assert.equal(words.syncing, "Syncing");
    assert.equal(words.synced, "● Terry is leading · Wi-Fi link");
    assert.equal(words["out-of-sync"], "Out of sync · fixing");
    assert.equal(words.quiet, "Terry's phone isn't answering");
    assert.equal(words.dropped, "Terry's phone dropped · still on 7");
    assert.equal(words["no-signal"], "No signal · keeping the beat");
    assert.equal(words["stepped-down"], "Terry is leading");
    assert.equal(words.ended, "That's the gig. Nice playing.");
    assert.equal(words["off-lineup"], "This gig is for tonight's lineup");
    for (const [key, said] of Object.entries(words)) assert.ok(!/follower/i.test(String(said)), `${key} has no 'follower'`);
    const tsx = readdirSync(join(root, "src")).filter((file) => file.endsWith(".tsx"));
    const said = tsx.filter((file) => {
      const text = readFileSync(join(root, "src", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      return /follower/i.test(text);
    });
    assert.deepEqual(said, [], "no screen file says 'follower' outside a comment");
  });

  await check("7. the click question stores into MetronomePrefs sound and indicator, and asks once per account", () => {
    const fresh = { chordStyle: "notes", transpose: 0, clickAsked: false };
    assert.equal(L.CLICK_QUESTION, "Click out loud on this phone, or dot only?");
    assert.equal(L.asksClick(fresh), true);
    const dot = L.answerClick(fresh, "dot");
    assert.deepEqual(dot.prefs, { sound: false, indicator: true });
    assert.deepEqual(dot.personal, { ...fresh, clickAsked: true });
    assert.equal(L.asksClick(dot.personal), false, "never again for that account");
    assert.deepEqual(L.answerClick(fresh, "loud").prefs, { sound: true });
  });

  await check("drill: a 'Take it' offer and Ask to lead show only to the right phone", () => {
    const base = begin();
    const offered = L.reduce(base, op(base, { kind: "handOff", to: "sam" }), { by: "terry", now: truth(), lead: 150 }).state;
    const viewOf = (state: any, extra: object = {}) => ({ state, leading: false, confidence: "synced", spread: 1, route: "wifi", heard: "answering", signal: true, offLineup: false, steppedDown: false, refused: null, handoffAt: null, asks: [], ...extra });
    const at = (me: string, view: any) => L.stripOf({ me, gigName: "Friday at the Elks", plannedLeader: "terry", names, phase: "joined", view, bandNow: truth() });
    assert.equal(at("sam", viewOf(offered)).accept, true, "Sam is offered the lead");
    assert.equal(at("mike", viewOf(offered)).accept, false, "Mike is not");
    const took = L.reduce(base, op(base, { kind: "takeOver" }), { by: "mike", now: truth(), lead: 150 }).state;
    const terry = at("terry", viewOf(took, { steppedDown: true }));
    assert.equal(terry.words, "Mike is leading");
    assert.equal(terry.askToLead, true);
  });
}

// ================================================================ part 3: the strip and Join gig in a fake DOM

async function fakeScreens() {
  const ui = await bundle(
    "screen",
    `export { GigStrip, LiveGigStrip, useLiveGig } from "./src/gig-live.tsx";
     export { useMetronome } from "./src/metronome-view.tsx";
     export * as storage from "./src/storage.ts";
     export { createElement, useState } from "react";
     export { createRoot } from "react-dom/client";`,
    "node",
  );
  const dom = fakeDom();
  const store = new Map<string, string>();
  Object.assign(globalThis, { setTimeout: real.setTimeout, clearTimeout: real.clearTimeout, setInterval: real.setInterval, clearInterval: real.clearInterval });
  Object.defineProperty(globalThis, "performance", { configurable: true, value: real.performance });
  Object.assign(globalThis, {
    window: { document: dom.document, setTimeout: real.setTimeout, clearTimeout: real.clearTimeout, setInterval: real.setInterval, clearInterval: real.clearInterval, addEventListener() {}, removeEventListener() {}, location: { hash: "#/songs" }, HTMLIFrameElement: class {} },
    document: dom.document,
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
    requestAnimationFrame: (run: (at: number) => void) => realSetTimeout(() => run(performance.now()), 16),
    cancelAnimationFrame: (id: number) => real.clearTimeout(id),
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
  const settle = async (ms = 0) => {
    if (ms) await sleep(ms);
    for (let i = 0; i < 10; i += 1) await new Promise((done) => setImmediate(done));
  };
  const elements = () => dom.container.elements;
  const text = () => dom.container.textContent ?? "";
  const button = (name: string) => elements().find((el: FakeElement) => el.nodeName === "BUTTON" && (el.textContent === name || el.getAttribute("aria-label") === name));
  const tap = async (name: string) => {
    const el = button(name);
    if (!el) throw new Error(`no ${name} button in: ${text()}`);
    dom.click(el);
    await settle();
  };

  /** What the hook reaches outside the phone, each a stand-in the case sets. */
  let gigs: object[] = [];
  let packWait: Promise<void> = Promise.resolve();
  let lock: "ok" | "refused" = "ok";
  let released = 0;
  const rooms: { state: string }[] = [];
  const deps = {
    gigs: async () => gigs,
    pack: async () => {
      await packWait;
      return { gig: { gigId: "gig_1", bandId: "band_1", leader: "terry", backup: "mike", lineup: ["terry", "mike", "sam"] }, songs: [], scrollWithLeader: true, secret: "s", packRev: 1, expiresAt: null };
    },
    room: () => {
      const room = { state: "connecting", send: () => false, listen: () => () => {}, close() {} };
      rooms.push(room);
      return room;
    },
    names: async () => ({ terry: "Terry", mike: "Mike", sam: "Sam" }),
    screenOn: async () => (lock === "ok" ? () => void (released += 1) : null),
  };
  const liveRow = (status = "live") => ({ bandId: "band_1", gigId: "gig_1", name: "Friday at the Elks", status, leader: "terry", backup: "mike", lineup: ["terry", "mike", "sam"] });

  let root = ui.createRoot(dom.container);
  function Phone({ me }: { me: string }) {
    const metronome = ui.useMetronome(null, 120);
    const [personal, setPersonal] = ui.useState(() => ui.storage.loadPersonal(me));
    const live = ui.useLiveGig({ me, route: { name: "songs" }, metronome, personal, onPersonal: (next: object) => (setPersonal(next), ui.storage.savePersonal(me, next)), deps });
    return ui.createElement(ui.LiveGigStrip, { live });
  }
  const open = async (me: string) => {
    root.unmount();
    root = ui.createRoot(dom.container);
    root.render(ui.createElement(Phone, { me, key: me }));
    await settle(30);
  };

  await check("flow: a lineup member on any screen sees 'Friday at the Elks is live · Join gig'", async () => {
    gigs = [liveRow()];
    await open("sam");
    assert.ok(text().includes("Friday at the Elks is live · Join gig"), text());
    assert.ok(button("Join gig"), "a Join gig button");
    assert.ok(/is-gold/.test(js(elements().map((el: FakeElement) => el.getAttribute("class")))), "the strip is gold");
  });

  await check("flow: no pack yet means Join gig downloads first with 'Getting the setlist…'", async () => {
    let done = () => {};
    packWait = new Promise((resolve) => (done = resolve));
    await tap("Join gig");
    assert.ok(text().includes("Getting the setlist…"), text());
    done();
    packWait = Promise.resolve();
    await settle(30);
  });

  await check("7. the first join asks once 'Click out loud on this phone, or dot only?' and never again", async () => {
    assert.ok(text().includes("Click out loud on this phone, or dot only?"), text());
    await tap("Dot only");
    const prefs = JSON.parse(store.get(ui.storage.METRONOME_PREFS_KEY) ?? "{}");
    assert.equal(prefs.sound, false, "Dot only turns the sound off");
    assert.equal(prefs.indicator, true, "and keeps the dot");
    assert.ok(text().includes("Syncing"), `then Syncing (${text()})`);
    assert.ok(!text().includes("Click out loud"), "the question is gone");
    await open("sam");
    await tap("Join gig");
    await settle(30);
    assert.ok(!text().includes("Click out loud on this phone"), `the same account is not asked again (${text()})`);
  });

  await check("shared phone: a second account on the same phone is asked for itself", async () => {
    await open("mike");
    await tap("Join gig");
    await settle(30);
    assert.ok(text().includes("Click out loud on this phone, or dot only?"), text());
    await tap("Click out loud");
  });

  await check("6. each tab's text size and click choice are unchanged after joining", async () => {
    store.set(ui.storage.TEXT_SCALE_KEY, "3");
    store.set(ui.storage.METRONOME_PREFS_KEY, js({ indicator: false, sound: true, syncMode: "auto", syncOffsetMs: 20, speakerDelayMs: 35 }));
    const before = [store.get(ui.storage.TEXT_SCALE_KEY), store.get(ui.storage.METRONOME_PREFS_KEY)];
    await open("sam");
    await tap("Join gig");
    await settle(30);
    assert.deepEqual([store.get(ui.storage.TEXT_SCALE_KEY), store.get(ui.storage.METRONOME_PREFS_KEY)], before);
  });

  await check("13. Screen on is switched on for everyone and a refused wake lock says 'Your screen may sleep'", async () => {
    assert.ok(!text().includes("Your screen may sleep"), "a granted lock says nothing");
    lock = "refused";
    await open("sam");
    await tap("Join gig");
    await settle(30);
    assert.ok(text().includes("Your screen may sleep"), text());
    lock = "ok";
  });

  await check("flow: a gig that ended shows 'That's the gig. Nice playing.' and Screen on goes back to the player's own choice", async () => {
    await open("sam");
    await tap("Join gig");
    await settle(30);
    const held = released;
    gigs = [liveRow("ended")];
    await until("the ended words", async () => text(), (t) => t.includes("That's the gig. Nice playing."), 40_000);
    assert.ok(released > held, "the gig's screen lock is let go");
  });

  await check("5. (screen) the take-over button only for the backup after a drop and for the admin", async () => {
    const strip = (extra: object) => ({ key: "dropped", words: "Terry's phone dropped · still on 7", tone: "amber", flash: false, bars: 2, quiet: false, takeOver: false, askToLead: false, accept: false, waiting: null, join: false, start: false, ...extra });
    root.unmount();
    root = ui.createRoot(dom.container);
    root.render(ui.createElement(ui.GigStrip, { strip: strip({ takeOver: true }), sleepy: false, on: {} }));
    await settle();
    assert.ok(button("Hold to take the lead"), text());
    root.render(ui.createElement(ui.GigStrip, { strip: strip({ waiting: "Waiting for Mike (backup) or the admin" }), sleepy: false, on: {} }));
    await settle();
    assert.ok(!button("Hold to take the lead"), "no button for a member");
    assert.ok(text().includes("Waiting for Mike (backup) or the admin"), text());
    assert.ok(!/follower/i.test(text()));
    root.unmount();
  });
}

await realTabs();
await fakeClock();
await fakeScreens();

if (failures) {
  console.log(`check:mirror: ${failures} failed`);
  process.exit(1);
}
console.log("check:mirror passed");
process.exit(0);
