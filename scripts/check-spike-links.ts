import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClock, estimate } from "../spike/lan/clock.js";
import { ROUTES, countCandidates, iceFor, synthesizeAnswer } from "../spike/lan/links.js";
import { startLocalTurn } from "../spike/cell/local-turn.mjs";
import { readTurnConfig } from "../spike/cell/turn.mjs";
import { createRelay } from "../spike/lan/relay.mjs";

const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const TURN_USER = "spike-user";
const SECRET = "spike-check-not-a-real-credential";
const ANSWER_SCAN_DELAY_MS = ROUTES.auto.deadlineMs + 2_000;

function checkClockFilter() {
  const clock = createClock();
  for (let i = 0; i < 8; i++) clock.add(1000 * i, 1000 * i + 50 + 5 + i * 0.1, 1000 * i + 10);
  for (let i = 8; i < 32; i++) clock.add(1000 * i, 1000 * i + 500, 1000 * i + 40);
  const summary = clock.summary();
  assert.equal(summary.samples, 32);
  assert.equal(summary.spreadMaxMs, 0.7, "spread is the range of the 8 fastest offsets (50.0..50.7)");
  assert.equal(summary.offsetMs, 50.35, "offset is the median of the 8 fastest");
  assert.equal(summary.rttP50Ms, 40);
  assert.equal(summary.oneWayP99Ms, 20);

  assert.equal(estimate([{ offset: 1, rtt: 1 }]), null, "fewer than 8 samples gives no estimate");
  const old = Array.from({ length: 8 }, (_, i) => ({ offset: i * 10, rtt: 1 }));
  const fresh = Array.from({ length: 32 }, () => ({ offset: 3, rtt: 5 }));
  const rolling = createClock();
  for (const s of [...old, ...fresh]) rolling.add(0, s.offset + s.rtt / 2, s.rtt);
  assert.equal(rolling.summary().offsetMs, 3, "only the last 32 samples count");
}

function checkTurnStub() {
  const none = readTurnConfig({ SPIKE_TURN_FILE: "/nonexistent" });
  assert.deepEqual(none, { stun: ["stun:stun.cloudflare.com:3478"], turn: null }, "no config means STUN only");
  const cloudflareShape = JSON.stringify({
    iceServers: [
      { urls: ["stun:stun.example.test:3478"] },
      {
        urls: ["turn:relay.example.test:3478?transport=udp", "turn:relay.example.test:3478?transport=tcp", "turn:relay.example.test:80?transport=tcp", "turns:relay.example.test:5349?transport=tcp", "turns:relay.example.test:443?transport=tcp"],
        username: "u",
        credential: "c",
      },
    ],
  });
  const ice = readTurnConfig({ SPIKE_TURN_ICE_SERVERS: cloudflareShape, SPIKE_STUN_URLS: "stun:a.test:3478" });
  assert.deepEqual(ice.stun, ["stun:a.test:3478"]);
  assert.equal(ice.turn.username, "u");
  assert.equal(readTurnConfig({ SPIKE_TURN_ICE_SERVERS: JSON.stringify({ iceServers: { urls: "turn:x.test:3478", username: "a", credential: "b" } }) }).turn.urls[0], "turn:x.test:3478", "the older single-object shape is read too");

  const urls = (route: string) => iceFor(route, ice).urls;
  assert.deepEqual(urls("wifi"), [], "Wi-Fi link uses no servers");
  assert.deepEqual(urls("direct"), ["stun:a.test:3478"]);
  assert.equal(urls("auto").length, 6, "Auto offers STUN and every relay address at once");
  assert.deepEqual(urls("relay-udp"), ["turn:relay.example.test:3478?transport=udp"]);
  assert.deepEqual(urls("relay-tcp"), ["turn:relay.example.test:3478?transport=tcp", "turn:relay.example.test:80?transport=tcp"]);
  assert.deepEqual(urls("relay-tls443"), ["turns:relay.example.test:443?transport=tcp"]);
  assert.equal(iceFor("relay-udp", { stun: [], turn: null }).usable, false, "a relay route without TURN is skipped");
}

function checkSdpHelpers() {
  const offer = [
    "v=0", "a=ice-ufrag:abcd", "a=ice-pwd:0123456789012345678901", "a=fingerprint:sha-256 AA:BB", "a=setup:actpass", "a=mid:0",
    "a=candidate:1 1 udp 2122260223 4f3c1e2a-0000-4000-8000-000000000000.local 50000 typ host generation 0",
    "a=candidate:2 1 tcp 1518280447 192.168.1.20 9 typ host tcptype passive",
    "a=candidate:3 1 udp 1686052607 203.0.113.9 50001 typ srflx raddr 0.0.0.0 rport 0",
    "a=end-of-candidates", "",
  ].join("\r\n");
  assert.deepEqual(countCandidates(offer), { host: 2, hostNames: 1, srflx: 1, prflx: 0, relay: 0, tcp: 1 });
  const answer = synthesizeAnswer(offer, "CC:DD", "u1u1", "p".repeat(24));
  assert.match(answer, /a=ice-ufrag:u1u1\r\n/);
  assert.match(answer, /a=fingerprint:sha-256 CC:DD\r\n/);
  assert.match(answer, /a=setup:active\r\n/);
  assert.doesNotMatch(answer, /a=candidate|AA:BB|abcd/);
}

type Tab = { evaluate<T>(expression: string): Promise<T>; send(method: string, params?: object): Promise<any> };

async function openChrome() {
  const profile = mkdtempSync(join(tmpdir(), "spike-links-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise<string>((resolve, reject) => {
    let log = "";
    chrome.stderr.on("data", (chunk) => {
      log += chunk;
      const found = log.match(/DevTools listening on (ws:\S+)/);
      if (found) resolve(found[1]);
    });
    chrome.on("exit", () => reject(new Error(`Chrome exited before DevTools was up:\n${log}`)));
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  let nextId = 0;
  const raw = (method: string, params: object = {}, sessionId?: string): Promise<any> => {
    const id = (nextId += 1);
    socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const tab = async (url: string): Promise<Tab> => {
    const { targetId } = await raw("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await raw("Target.attachToTarget", { targetId, flatten: true });
    const send = (method: string, params: object = {}) => raw(method, params, sessionId);
    await send("Page.navigate", { url });
    const evaluate = async <T>(expression: string): Promise<T> => {
      const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value as T;
    };
    return { send, evaluate };
  };
  const close = async () => {
    socket.close();
    chrome.kill();
    await new Promise((resolve) => (chrome.exitCode === null ? chrome.once("exit", resolve) : resolve(null)));
    rmSync(profile, { recursive: true, force: true });
  };
  return { tab, close };
}

const browsers: Awaited<ReturnType<typeof openChrome>>[] = [];
async function phone(url: string) {
  const browser = await openChrome();
  browsers.push(browser);
  return browser.tab(url);
}

async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined as T);
    if (value !== undefined && ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)?.slice(0, 600)}\n${JSON.stringify((value as any)?.links?.map(({ events, route, openMs, noticeMs, closedMs, closeReason, error }: any) => ({ route, openMs, noticeMs, closedMs, closeReason, error, events })))}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const result = (tab: Tab) => tab.evaluate<any>("window.spike.result()");

function assertWellFormed(json: any, spike: string, role: string) {
  assert.equal(json.kind, "mls-spike-links");
  assert.equal(json.version, 1);
  assert.equal(json.spike, spike);
  assert.equal(json.role, role);
  for (const key of ["setup", "startedAt", "page"]) assert.equal(typeof json[key], "string", key);
  assert.equal(typeof json.durationS, "number");
  assert.ok(Array.isArray(json.health) && json.health[0]?.state === "ok", "health check reached the relay");
  assert.ok(json.room.polls > 0, "room mailbox answered");
  assert.ok("loopLagP95Ms" in json.power && "battery" in json.power && "cores" in json.power, "CPU and battery hints present");
  assert.ok(Array.isArray(json.links) && Array.isArray(json.locks) && Array.isArray(json.sessions));
  for (const link of json.links) {
    for (const key of ["id", "intro", "route", "atMs", "events", "localNames", "servers"]) assert.ok(key in link, `link has ${key}`);
    assert.ok(Array.isArray(link.servers) && link.servers.every((s: unknown) => typeof s === "string"), "servers are plain URLs");
  }
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(json))), JSON.stringify(json), "result survives a JSON round trip");
  assert.ok(!JSON.stringify(json).includes(SECRET), "TURN credential never appears in the export");
}

async function runLan(origin: string) {
  const leader = await phone(`${origin}/lan/?role=leader&room=lan&plan=auto`);
  const follower = await phone(`${origin}/lan/?role=follower&room=lan`);

  const opened = await until("Wi-Fi link opens and the clock fills", () => result(follower), (r) => r.links[0]?.openMs !== null && r.links[0]?.clock?.samples >= 16);
  const link = opened.links[0];
  assert.equal(link.route, "auto");
  assert.equal(link.intro, "room");
  assert.ok(["Wi-Fi link", "Through the relay"].includes(link.path), `loopback path named ${link.path}`);
  assert.ok(link.openMs < 5000, `linked in ${link.openMs} ms`);
  assert.ok(Math.abs(link.clock.offsetMs) <= link.clock.rttP50Ms / 2 + 0.2, `two tabs share one clock, so offset ${link.clock.offsetMs} ms stays within half the median round trip ${link.clock.rttP50Ms} ms`);
  assert.ok(link.clock.spreadMaxMs <= link.clock.rttP99Ms, `spread ${link.clock.spreadMaxMs} ms never exceeds the slowest round trip ${link.clock.rttP99Ms} ms`);
  assert.deepEqual(opened.bars.clockSpreadP95Ms, { target: 1, worst: link.clock.spreadP95Ms, pass: link.clock.spreadP95Ms <= 1 });
  assert.equal(opened.bars.settleMs.pass, true);

  await follower.send("Page.setWebLifecycleState", { state: "frozen" });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await follower.send("Page.setWebLifecycleState", { state: "active" });
  const afterLock = await until("lock record", () => result(follower), (r) => r.locks.length === 1 && r.locks[0].links[0]?.heardAfterMs !== null);
  assert.ok(afterLock.locks[0].hiddenMs >= 1900, `frozen for ${afterLock.locks[0].hiddenMs} ms`);
  assert.equal(afterLock.locks[0].survived, true, "link survives a short freeze");

  const leaderView = await until("leader sees follower clock", () => result(leader), (r) => r.links[0]?.clock?.samples >= 16);
  assert.equal(leaderView.links[0].route, "auto");
  assertWellFormed(leaderView, "lan", "leader");
  assertWellFormed(afterLock, "lan", "follower");

  await leader.evaluate(`window.spike.press("QR join (two scans)")`);
  const offerCode = await until("leader QR offer", () => leader.evaluate<string>("window.spike.lastCode()"), (code) => typeof code === "string");
  assert.match(offerCode, new RegExp(`^${origin}/lan/\\?role=follower#qr=`), "offer code is a link the Camera app can open");
  await follower.evaluate(`window.spike.accept(${JSON.stringify(offerCode)})`);
  const answerCode = await until("follower QR answer", () => follower.evaluate<string>("window.spike.lastCode()"), (code) => typeof code === "string");
  assert.match(answerCode, /\?role=handback#qr=/);
  await new Promise((resolve) => setTimeout(resolve, ANSWER_SCAN_DELAY_MS));
  await leader.evaluate(`window.spike.accept(${JSON.stringify(answerCode)})`);
  const qr2 = await until(`two-scan link opens with the answer scanned ${ANSWER_SCAN_DELAY_MS} ms late`, () => result(leader), (r) => r.links.some((l: any) => l.intro === "qr2" && l.openMs !== null));
  assert.ok(qr2.links.find((l: any) => l.intro === "qr2").qrChars > 0, "QR size recorded");
  const followerQr2 = (await until("follower's two-scan link settles", () => result(follower), (r) => r.links.some((l: any) => l.intro === "qr2" && (l.openMs !== null || l.closedMs !== null)))).links.find((l: any) => l.intro === "qr2");
  assert.ok(followerQr2.openMs !== null && followerQr2.closedMs === null, `follower keeps the two-scan link while the person scans the answer (closed ${followerQr2.closedMs} ms, ${followerQr2.closeReason})`);

  await follower.evaluate(`window.spike.press("Show my link certificate")`);
  const certCode = await until("certificate code", () => follower.evaluate<string>("window.spike.lastCode()"), (code) => code !== answerCode);
  await leader.evaluate(`window.spike.accept(${JSON.stringify(certCode)})`);
  await leader.evaluate(`window.spike.press("One-scan QR")`);
  const oneScanCode = await until("one-scan code", () => leader.evaluate<string>("window.spike.lastCode()"), (code) => code !== offerCode);
  await follower.evaluate(`window.spike.accept(${JSON.stringify(oneScanCode)})`);
  const qr1 = await until("one-scan outcome", () => result(follower), (r) => r.links.some((l: any) => l.intro === "qr1" && (l.openMs !== null || l.noticeMs !== null || l.error)));
  const oneScan = qr1.links.find((l: any) => l.intro === "qr1");
  assert.ok(qr1.certificate.fingerprint, "follower certificate fingerprint recorded");
  console.log(`one-scan QR in headless Chrome: ${oneScan.openMs !== null ? `linked in ${oneScan.openMs} ms` : `did not link (${oneScan.error ?? "no path"})`}`);
  return { link, oneScan };
}

async function runIsolation(origin: string) {
  const leader = await phone(`${origin}/lan/?role=leader&room=iso&simulate=isolation`);
  const follower = await phone(`${origin}/lan/?role=follower&room=iso`);
  const fell = await until("fallback after simulated isolation", () => result(leader), (r) => r.links.length === 2 && r.links[1].openMs !== null, 30_000);
  const [wifi, fallback] = fell.links;
  assert.equal(wifi.route, "wifi");
  assert.equal(wifi.openMs, null);
  assert.ok(wifi.noticeMs >= 5000 && wifi.noticeMs < 5500, `noticed isolation at ${wifi.noticeMs} ms`);
  assert.equal(fallback.route, "auto");
  assert.equal(fell.sessions[0].settleMs > 5000, true, "settle time counts from the first attempt");
  assert.equal(fell.bars.settleMs.pass, false, "route-by-route fallback misses the 5 s bar, which Auto must meet");
  const seen = await until("follower records the fallback", () => result(follower), (r) => r.links.length === 2 && r.links[1].openMs !== null);
  assert.ok(seen.links[0].noticeMs !== null, "follower notes when the leader gave up on the Wi-Fi link");
  return { noticeMs: wifi.noticeMs, settleMs: fell.sessions[0].settleMs };
}

async function runCell(origin: string) {
  const leader = await phone(`${origin}/cell/?role=leader&room=cell&secs=3`);
  const follower = await phone(`${origin}/cell/?role=follower&room=cell`);
  const done = await until("cell plan runs every route", () => result(leader), (r) => r.links.length === 4 && r.links[2].closedMs !== null, 40_000);
  const [direct, udp, tcp, tls] = done.links;
  assert.equal(direct.route, "direct");
  assert.ok(direct.openMs !== null || direct.noticeMs >= 8000, "direct attempt either links or gives up at its 8 s deadline");
  assert.equal(udp.error, "skipped: no TURN addresses for this route");
  assert.equal(tcp.route, "relay-tcp");
  assert.deepEqual(tcp.servers, [turnUrl], "relay attempt names its server");
  assert.ok(tcp.openMs !== null, "forced relay over TCP links");
  assert.equal(tcp.selected.path, "relay");
  assert.equal(tcp.selected.local.relayProtocol, "tcp");
  assert.equal(tcp.path, "Through the relay");
  assert.equal(typeof tcp.bytes.mbPerHour, "number", "relay MB per hour recorded");
  assert.ok(tcp.bytes.total > 0, "relay bytes counted");
  assert.equal(tcp.closeReason, "next route");
  assert.equal(tls.error, "skipped: no TURN addresses for this route");
  assert.equal(done.turnConfigured, true);
  assertWellFormed(done, "cell", "leader");
  const followerView = await result(follower);
  assertWellFormed(followerView, "cell", "follower");
  const relayed = followerView.links.find((l: any) => l.route === "relay-tcp");
  assert.ok(relayed.clock.samples >= 8, "clock pings ran over the relay");
  assert.equal(followerView.bars.clockSpreadP95Ms.target, 6);
  assert.equal(followerView.bars.settleMs, null);
  return { spreadP95Ms: relayed.clock.spreadP95Ms, mbPerHour: tcp.bytes.mbPerHour, direct: direct.openMs !== null };
}

checkClockFilter();
checkTurnStub();
checkSdpHelpers();
console.log("clock filter, TURN stub, route filters and SDP helpers ok");

const turn = await startLocalTurn({ username: TURN_USER, credential: SECRET });
const turnUrl = turn.url;
const iceServers = JSON.stringify({ iceServers: [{ urls: [turnUrl], username: TURN_USER, credential: SECRET }] });
const relays: ReturnType<typeof createRelay>[] = [];
async function startRelay() {
  const relay = createRelay({ env: { SPIKE_TURN_ICE_SERVERS: iceServers, SPIKE_STUN_URLS: "" } });
  relays.push(relay);
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
}
const origin = await startRelay();
const health = await fetch(`${origin}/health`).then((r) => r.json());
assert.deepEqual(health, { service: "mls-spike-links" });
const served = await fetch(`${origin}/turn`).then((r) => r.json());
assert.deepEqual(served.turn.urls, [turnUrl]);
assert.equal((await fetch(`${origin}/cell/turn.mjs`)).status, 404, "server-side files are not served");
assert.equal((await fetch(`${origin}/lan/relay.mjs`)).status, 404, "server-side files are not served");

try {
  const [lan, isolation, cell] = await Promise.all([runLan(origin), runIsolation(await startRelay()), runCell(await startRelay())]);
  console.log(`Auto over loopback: ${lan.link.path} in ${lan.link.openMs} ms, spread p95 ${lan.link.clock.spreadP95Ms} ms, .local names sent ${lan.link.localNames.sent}`);
  console.log(`local relay dropped ${turn.stats.droppedNoPermission} packets from peers it had no permission for`);
  console.log(`simulated isolation: noticed at ${isolation.noticeMs} ms, settled over the internet at ${isolation.settleMs} ms`);
  console.log(`cell plan loopback: direct ${cell.direct ? "linked" : "gave up at 8 s"}, relay over TCP spread p95 ${cell.spreadP95Ms} ms, ${cell.mbPerHour} MB/hour, ${turn.stats.relayedBytes} bytes through the local relay`);
  console.log("check:spike-links ok");
} finally {
  await Promise.all(browsers.map((browser) => browser.close()));
  await turn.close();
  for (const relay of relays) {
    relay.closeAllConnections();
    relay.close();
  }
}
