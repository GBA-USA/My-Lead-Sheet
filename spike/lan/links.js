import { createClock } from "./clock.js";

export const ROUTES = {
  wifi: { words: "Wi-Fi link", deadlineMs: 5000, pingMs: 2000, policy: "all", stun: false, turn: null, fail: "This Wi-Fi keeps phones apart. Going over the internet." },
  auto: { words: "Auto", deadlineMs: 10000, pingMs: 2000, policy: "all", stun: true, turn: () => true, fail: "Nothing connected in 10 s. The app would use the server." },
  direct: { words: "Over the internet", deadlineMs: 8000, pingMs: 3000, policy: "all", stun: true, turn: null, fail: "No direct path over the internet." },
  "relay-udp": { words: "Through the relay (UDP)", deadlineMs: 8000, pingMs: 3000, policy: "relay", stun: false, turn: (url) => /^turn:[^?]*\?transport=udp/.test(url), fail: "Relay over UDP failed." },
  "relay-tcp": { words: "Through the relay (TCP)", deadlineMs: 8000, pingMs: 3000, policy: "relay", stun: false, turn: (url) => /^turn:[^?]*\?transport=tcp/.test(url), fail: "Relay over TCP failed." },
  "relay-tls443": { words: "Through the relay (TLS 443)", deadlineMs: 15000, pingMs: 3000, policy: "relay", stun: false, turn: (url) => /^turns:[^?]*:443(\?|$)/.test(url), fail: "Relay over TLS on 443 failed." },
};

export const PLANS = {
  fallback: { routes: ["wifi", "auto"], each: false },
  auto: { routes: ["auto"], each: false },
  each: { routes: ["direct", "relay-udp", "relay-tcp", "relay-tls443"], each: true },
};

const QR_ROUTE = "auto";
const GATHER_CAP_MS = 4000;
const HEARD_AFTER_RESUME_MS = 5000;
const SETTLE_TARGET_MS = 5000;
const SCAN_WAIT_MS = 120_000;
const HEALTH_EVERY_MS = 30_000;
const POWER_EVERY_MS = 60_000;
const CHANNEL = "mls-spike-links";

const now = () => performance.now();
const bandNow = () => performance.timeOrigin + performance.now();
const since = (from) => Math.round(now() - from);
const sleep = (time) => new Promise((resolve) => setTimeout(resolve, time));
const hex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const worst = (values) => (values.length ? Math.max(...values) : null);
const bar = (target, value) => ({ target, worst: value, pass: value === null ? null : value <= target });

export function iceFor(route, ice) {
  const { stun, turn, policy } = ROUTES[route];
  const servers = [];
  if (stun && ice.stun.length) servers.push({ urls: ice.stun });
  const turnUrls = turn && ice.turn ? ice.turn.urls.filter(turn) : [];
  if (turnUrls.length) servers.push({ urls: turnUrls, username: ice.turn.username, credential: ice.turn.credential });
  return { servers, urls: servers.flatMap((server) => server.urls), usable: policy !== "relay" || turnUrls.length > 0 };
}

export function countCandidates(sdp) {
  const counts = { host: 0, hostNames: 0, srflx: 0, prflx: 0, relay: 0, tcp: 0 };
  for (const line of sdp.split(/\r?\n/)) {
    const found = line.match(/^a=candidate:\S+ \d+ (\S+) \d+ (\S+) \d+ typ (\S+)/);
    if (!found) continue;
    counts[found[3]] = (counts[found[3]] ?? 0) + 1;
    if (found[1].toLowerCase() === "tcp") counts.tcp++;
    if (found[3] === "host" && found[2].endsWith(".local")) counts.hostNames++;
  }
  return counts;
}

export function synthesizeAnswer(offer, fingerprint, ufrag, pwd) {
  return offer
    .split("\r\n")
    .filter((line) => !line.startsWith("a=candidate:") && line !== "a=end-of-candidates")
    .map((line) =>
      line.startsWith("a=ice-ufrag:") ? `a=ice-ufrag:${ufrag}`
      : line.startsWith("a=ice-pwd:") ? `a=ice-pwd:${pwd}`
      : line.startsWith("a=fingerprint:") ? `a=fingerprint:sha-256 ${fingerprint}`
      : line.startsWith("a=setup:") ? "a=setup:active"
      : line,
    )
    .join("\r\n");
}

const setIce = (sdp, ufrag, pwd) => sdp.replace(/a=ice-ufrag:[^\r\n]*/g, `a=ice-ufrag:${ufrag}`).replace(/a=ice-pwd:[^\r\n]*/g, `a=ice-pwd:${pwd}`);
const stripCandidates = (sdp) => sdp.replace(/a=candidate:[^\r\n]*\r\n/g, "");

function addressKind(address) {
  if (!address) return "hidden";
  if (address.endsWith(".local")) return "local-name";
  return address.includes(":") ? "ipv6" : "ipv4";
}

function pathWords(selected) {
  if (!selected) return null;
  if (selected.path === "relay") return "Through the relay";
  return selected.local.type === "host" && ["host", "prflx"].includes(selected.remote.type) ? "Wi-Fi link" : "Over the internet";
}

async function selectedPair(pc) {
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach((s) => {
    if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId) ?? pair;
  });
  if (!pair) stats.forEach((s) => {
    if (!pair && s.type === "candidate-pair" && (s.selected || (s.nominated && s.state === "succeeded"))) pair = s;
  });
  if (!pair) return null;
  const side = (id) => {
    const c = stats.get(id);
    return c ? { type: c.candidateType, protocol: c.protocol, relayProtocol: c.relayProtocol ?? null, address: addressKind(c.address ?? c.ip) } : null;
  };
  const local = side(pair.localCandidateId);
  const remote = side(pair.remoteCandidateId);
  return {
    local,
    remote,
    path: local?.type === "relay" || remote?.type === "relay" ? "relay" : "direct",
    bytesSent: pair.bytesSent ?? 0,
    bytesReceived: pair.bytesReceived ?? 0,
  };
}

function gathered(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && resolve());
    setTimeout(resolve, GATHER_CAP_MS);
  });
}

async function pack(message) {
  const stream = new Blob([JSON.stringify(message)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function unpack(text) {
  const packed = (text.includes("#qr=") ? text.split("#qr=")[1] : text).trim();
  const binary = atob(packed.replaceAll("-", "+").replaceAll("_", "/"));
  const stream = new Blob([Uint8Array.from(binary, (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return JSON.parse(await new Response(stream).text());
}

async function myCertificate() {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open(CHANNEL, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("certs");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const run = (mode, act) =>
    new Promise((resolve, reject) => {
      const request = act(db.transaction("certs", mode).objectStore("certs"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const saved = await run("readonly", (store) => store.get("mine")).catch(() => null);
  if (saved && saved.expires > Date.now()) return { cert: saved, stored: "reused from an earlier visit" };
  const cert = await RTCPeerConnection.generateCertificate({ name: "ECDSA", namedCurve: "P-256" });
  const stored = await run("readwrite", (store) => store.put(cert, "mine")).then(() => "saved", (error) => `not saved: ${error.message}`);
  return { cert, stored };
}

function createLink({ rec, role, servers, certificate, onBand, onRecord }) {
  const started = now();
  const route = ROUTES[rec.route];
  const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: route.policy, ...(certificate ? { certificates: [certificate] } : {}) });
  const clock = role === "follower" ? createClock() : null;
  const timers = [];
  let channel = null;
  let lastHeard = null;
  let watch = null;
  let resolveOpen;
  const opened = new Promise((resolve) => (resolveOpen = resolve));
  const event = (what) => rec.events.push([since(started), what]);
  const send = (message) => channel?.readyState === "open" && channel.send(JSON.stringify(message));
  const ping = () => send({ k: "ping", t0: bandNow(), clock: rec.clock });
  const burst = () => {
    for (let i = 0; i < 16; i++) timers.push(setTimeout(ping, i * 100));
  };

  pc.addEventListener("iceconnectionstatechange", () => event(`ice ${pc.iceConnectionState}`));
  pc.addEventListener("connectionstatechange", () => {
    event(`link ${pc.connectionState}`);
    if (pc.connectionState === "failed") resolveOpen(false);
  });

  const refresh = async () => {
    if (rec.openMs === null || pc.signalingState === "closed") return;
    rec.selected = await selectedPair(pc).catch(() => rec.selected);
    rec.path = pathWords(rec.selected);
    const openSeconds = ((rec.closedMs ?? since(started)) - rec.openMs) / 1000;
    const bytes = (rec.selected?.bytesSent ?? 0) + (rec.selected?.bytesReceived ?? 0);
    rec.bytes = { total: bytes, openSeconds: Math.round(openSeconds), mbPerHour: openSeconds > 0 ? Math.round((bytes / 1e6 / (openSeconds / 3600)) * 1000) / 1000 : null };
  };

  const handle = (message) => {
    const at = now();
    if (lastHeard !== null) rec.maxSilenceMs = Math.max(rec.maxSilenceMs, Math.round(at - lastHeard));
    lastHeard = at;
    if (watch) {
      watch.entry.heardAfterMs = since(watch.at);
      watch = null;
    }
    if (message.k === "ping") {
      send({ k: "pong", t0: message.t0, band: bandNow() });
      rec.clock = message.clock;
    } else if (message.k === "pong" && clock) {
      clock.add(message.t0, message.band, bandNow());
      rec.clock = clock.summary();
      onBand?.();
    }
  };

  const wire = (dc) => {
    channel = dc;
    dc.addEventListener("open", () => {
      rec.openMs = since(started);
      event("channel open");
      resolveOpen(true);
      refresh().then(onRecord);
      if (clock) {
        burst();
        timers.push(setInterval(ping, route.pingMs));
      }
    });
    dc.addEventListener("close", () => {
      rec.closedMs ??= since(started);
      event("channel closed");
      resolveOpen(false);
      onRecord?.();
    });
    dc.addEventListener("message", (e) => handle(JSON.parse(e.data)));
  };
  if (role === "leader") wire(pc.createDataChannel("mls"));
  else pc.addEventListener("datachannel", (e) => wire(e.channel));

  return {
    rec,
    opened,
    age: () => since(started),
    isOpen: () => channel?.readyState === "open",
    refresh,
    async offer() {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      rec.gatherMs = since(started);
      rec.local = countCandidates(pc.localDescription.sdp);
      return pc.localDescription.sdp;
    },
    async answer(offerSdp, ice) {
      await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
      rec.remote = countCandidates(offerSdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription({ type: "answer", sdp: ice ? setIce(answer.sdp, ice.u, ice.p) : answer.sdp });
      await gathered(pc);
      rec.gatherMs = since(started);
      rec.local = countCandidates(pc.localDescription.sdp);
      return pc.localDescription.sdp;
    },
    async accept(answerSdp) {
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      rec.remote = countCandidates(answerSdp);
    },
    within: (ms, from = started) => Promise.race([opened, sleep(Math.max(0, ms - since(from))).then(() => false)]),
    resume(entry) {
      const linkEntry = { peer: rec.peer, attempt: rec.attempt, channel: channel?.readyState ?? "none", heardAfterMs: null };
      entry.links.push(linkEntry);
      watch = { entry: linkEntry, at: now() };
      if (clock) burst();
    },
    async close(reason) {
      await refresh();
      timers.forEach(clearTimeout);
      rec.closedMs ??= since(started);
      rec.closeReason ??= reason;
      channel?.close();
      pc.close();
      onRecord?.();
    },
  };
}

function finishRecord(rec) {
  const received = rec.remote?.hostNames ?? 0;
  return {
    ...rec,
    localNames: {
      sent: rec.local?.hostNames ?? 0,
      received,
      resolved: received === 0 ? null : rec.selected?.remote?.type === "host",
    },
  };
}

function finishLock(lock) {
  return {
    ...lock,
    survived: lock.links.length > 0 && lock.links.every((l) => l.channel === "open" && l.heardAfterMs !== null && l.heardAfterMs <= HEARD_AFTER_RESUME_MS),
  };
}

function settled(records) {
  const sessions = new Map();
  for (const rec of records) {
    const s = sessions.get(rec.session) ?? { session: rec.session, peer: rec.peer, intro: rec.intro, firstAtMs: rec.atMs, settleMs: null, path: null };
    if (rec.openMs !== null && s.settleMs === null) {
      s.settleMs = rec.atMs + rec.openMs - s.firstAtMs;
      s.path = rec.path ?? ROUTES[rec.route].words;
    }
    sessions.set(rec.session, s);
  }
  return [...sessions.values()].map(({ firstAtMs, ...s }) => s);
}

async function checkHealth() {
  const started = now();
  try {
    const response = await fetch(`/health?t=${Date.now()}`, { redirect: "manual", cache: "no-store" });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) return { state: "sign-in page", ms: since(started) };
    const body = await response.text();
    return { state: body.includes('"mls-spike-links"') ? "ok" : "sign-in page", ms: since(started) };
  } catch {
    return { state: "unreachable", ms: since(started) };
  }
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function buildUi(config, role) {
  const status = el("p", { className: "status", textContent: "Starting" });
  const numbers = el("p", { className: "numbers" });
  const setup = el("select", {}, ...config.setups.map((s) => el("option", { value: s, textContent: s })));
  const note = el("input", { placeholder: "Note (phone model, carrier, anything odd)" });
  const actions = el("div", { className: "actions" });
  const qr = el("div", { className: "qr" });
  const video = el("video", { playsInline: true, muted: true, hidden: true });
  const paste = el("textarea", { placeholder: "Paste a code here" });
  const log = el("ol", { className: "log" });
  document.body.append(
    el("h1", { textContent: `${config.title} · ${role}` }),
    status,
    numbers,
    el("label", {}, "Setup ", setup),
    note,
    actions,
    qr,
    video,
    paste,
    log,
  );
  const say = (text) => {
    status.textContent = text;
    log.prepend(el("li", { textContent: `${(now() / 1000).toFixed(1)} s · ${text}` }));
    while (log.children.length > 60) log.lastChild.remove();
  };
  const button = (text, onClick) => {
    const b = el("button", { type: "button", textContent: text });
    b.addEventListener("click", () => Promise.resolve(onClick()).catch((error) => say(`${text} failed: ${error.message}`)));
    actions.append(b);
    return b;
  };
  const showCode = (text) => {
    qr.replaceChildren();
    try {
      const code = qrcode(0, "L");
      code.addData(text);
      code.make();
      qr.innerHTML = code.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    } catch (error) {
      qr.append(el("p", { textContent: `Too long for one QR code (${text.length} characters): ${error}` }));
    }
    qr.append(el("textarea", { readOnly: true, value: text, className: "code-text" }));
  };
  return { say, button, showCode, numbers, setup, note, video, paste, qr };
}

function handback(config) {
  const text = location.href;
  new BroadcastChannel(CHANNEL).postMessage(text);
  document.body.append(
    el("h1", { textContent: `${config.title} · code scanned` }),
    el("p", { textContent: "Sent to the leader tab. Switch back to it. If nothing happens there, copy this and paste it into the leader page." }),
    el("textarea", { readOnly: true, value: text }),
  );
}

function chooseRole(config) {
  document.body.append(
    el("h1", { textContent: config.title }),
    ...["leader", "follower"].map((role) => el("p", {}, el("a", { href: `?role=${role}${location.search.replace(/^\?/, "&")}`, textContent: `Open as ${role}` }))),
  );
}

export async function startDrill(config) {
  const params = new URLSearchParams(location.search);
  const role = params.get("role");
  if (role === "handback") return handback(config);
  if (role !== "leader" && role !== "follower") return chooseRole(config);

  const room = `${config.spike}-${params.get("room") ?? "band"}`;
  const planName = PLANS[params.get("plan")] ? params.get("plan") : config.plans[0];
  const plan = PLANS[planName];
  const holdMs = Number(params.get("secs") ?? 120) * 1000;
  const linkCount = Math.max(1, Math.min(8, Number(params.get("links") ?? 1)));
  const simulateIsolation = params.get("simulate") === "isolation";
  const ui = buildUi(config, role);
  const pageStart = now();
  const ice = await fetch("/turn").then((r) => r.json()).catch(() => ({ stun: [], turn: null }));
  const records = [];
  const links = [];
  const locks = [];
  const health = [];
  const roomStats = { polls: 0, failed: 0, lastOkMs: null };
  const certs = [];
  let camera = "not asked";
  let certificate = null;
  let lastCode = null;
  let nextId = 0;

  const record = (fields) => {
    const rec = {
      id: `${role[0]}${++nextId}`, attempt: null, session: null, peer: null, intro: null, route: null, servers: [],
      atMs: since(pageStart), gatherMs: null, openMs: null, noticeMs: null, closedMs: null, closeReason: null, error: null,
      local: null, remote: null, selected: null, path: null, clock: null, bytes: null, maxSilenceMs: 0, qrChars: null, events: [],
      ...fields,
    };
    records.push(rec);
    return rec;
  };

  const showNumbers = () => {
    const open = links.filter((l) => l.isOpen());
    const spreads = records.map((r) => r.clock?.spreadP95Ms).filter((v) => typeof v === "number");
    const rtts = records.map((r) => r.clock?.rttP99Ms).filter((v) => typeof v === "number");
    ui.numbers.textContent = `Links open ${open.length} · spread p95 ${worst(spreads) ?? "-"} ms · round trip p99 ${worst(rtts) ?? "-"} ms`;
  };

  const newLink = (rec, servers, extra = {}) => {
    const link = createLink({ rec, role, servers, onBand: showNumbers, onRecord: showNumbers, ...extra });
    links.push(link);
    return link;
  };

  const power = { cores: navigator.hardwareConcurrency ?? null, memoryGb: navigator.deviceMemory ?? null, battery: null, lag: [], longTasks: null, samples: [] };
  let battery = null;
  let batteryStart = null;
  navigator.getBattery?.().then((b) => {
    battery = b;
    batteryStart = { level: b.level, atMs: now() };
  });
  if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    power.longTasks = 0;
    new PerformanceObserver((list) => (power.longTasks += list.getEntries().length)).observe({ type: "longtask" });
  }
  let expected = now() + 250;
  setInterval(() => {
    const late = now() - expected;
    expected = now() + 250;
    if (!document.hidden && late < 1000) power.lag.push(Math.max(0, late));
  }, 250);
  setInterval(() => {
    power.samples.push({ minute: Math.round(since(pageStart) / 60000), linksOpen: links.filter((l) => l.isOpen()).length, batteryPct: battery ? Math.round(battery.level * 100) : null, charging: battery?.charging ?? null });
  }, POWER_EVERY_MS);

  const powerSummary = () => {
    const sorted = [...power.lag].sort((a, b) => a - b);
    const hours = batteryStart ? (now() - batteryStart.atMs) / 3_600_000 : 0;
    return {
      cores: power.cores,
      memoryGb: power.memoryGb,
      battery: battery
        ? { startPct: Math.round(batteryStart.level * 100), nowPct: Math.round(battery.level * 100), charging: battery.charging, dropPctPerHour: !battery.charging && hours >= 0.05 ? Math.round(((batteryStart.level - battery.level) * 100) / hours * 10) / 10 : null }
        : "not readable in this browser",
      loopLagP95Ms: sorted.length ? Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 10) / 10 : null,
      longTasks: power.longTasks,
      samples: power.samples,
    };
  };

  let hiddenAt = null;
  const pause = () => (hiddenAt ??= now());
  const resume = () => {
    if (hiddenAt === null) return;
    const entry = { hiddenMs: since(hiddenAt), links: [] };
    hiddenAt = null;
    locks.push(entry);
    for (const link of links) if (link.rec.openMs !== null && link.rec.closeReason === null) link.resume(entry);
    ui.say(`Back after ${(entry.hiddenMs / 1000).toFixed(1)} s hidden`);
  };
  document.addEventListener("visibilitychange", () => (document.hidden ? pause() : resume()));
  document.addEventListener("freeze", pause);
  document.addEventListener("resume", resume);

  const probe = async () => {
    const result = await checkHealth();
    health.push({ atMs: since(pageStart), ...result });
    if (result.state === "sign-in page") ui.say("This Wi-Fi wants you to sign in first. Open Safari to accept it, or turn Wi-Fi off.");
  };
  probe();
  setInterval(probe, HEALTH_EVERY_MS);

  const signal = (to, message) => fetch(`/signal/${room}/${to}`, { method: "POST", body: JSON.stringify(message) });
  const listen = async (me, onMessage) => {
    let after = (await fetch(`/signal/${room}/${me}`).then((r) => r.json())).cursor;
    (async () => {
      for (;;) {
        try {
          const { messages } = await fetch(`/signal/${room}/${me}?after=${after}`).then((r) => r.json());
          roomStats.polls++;
          roomStats.lastOkMs = since(pageStart);
          for (const m of messages) {
            after = m.seq;
            onMessage(m.message).catch((error) => ui.say(`Room message failed: ${error.message}`));
          }
        } catch {
          roomStats.failed++;
          await sleep(2000);
        }
      }
    })();
  };

  const refreshAll = () => Promise.all(links.map((l) => l.refresh()));
  const snapshot = () => {
    const finished = records.map(finishRecord);
    const finishedLocks = locks.map(finishLock);
    const sessions = settled(records);
    const roomSettles = sessions.filter((s) => s.intro === "room" && s.settleMs !== null).map((s) => s.settleMs);
    return {
      kind: "mls-spike-links",
      version: 1,
      spike: config.spike,
      role,
      plan: role === "leader" ? planName : null,
      setup: ui.setup.value,
      note: ui.note.value,
      page: location.pathname + location.search,
      startedAt: new Date(performance.timeOrigin).toISOString(),
      durationS: Math.round(since(pageStart) / 1000),
      device: { userAgent: navigator.userAgent, camera, standalone: matchMedia("(display-mode: standalone)").matches },
      turnConfigured: Boolean(ice.turn),
      certificate: certificate && { stored: certificate.stored, fingerprint: certificate.fingerprint },
      health,
      room: roomStats,
      power: powerSummary(),
      locks: finishedLocks,
      sessions,
      links: finished,
      bars: {
        clockSpreadP95Ms: bar(config.spreadTargetMs, worst(finished.map((r) => r.clock?.spreadP95Ms).filter((v) => typeof v === "number"))),
        settleMs: config.spike === "lan" ? bar(SETTLE_TARGET_MS, worst(roomSettles)) : null,
        lockSurvived: finishedLocks.length ? finishedLocks.every((l) => l.survived) : null,
      },
    };
  };
  let latest = snapshot();
  showNumbers();
  setInterval(() => refreshAll().then(() => (latest = snapshot())), 5000);

  const exportName = () => `mls-spike-${config.spike}-${role}-${ui.setup.value}-${new Date().toISOString().slice(0, 16).replace(":", "")}.json`;
  ui.button("Share results", async () => {
    const file = new File([JSON.stringify(latest, null, 2)], exportName(), { type: "application/json" });
    if (navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file], title: file.name });
    const a = el("a", { href: URL.createObjectURL(file), download: file.name });
    a.click();
  });
  ui.button("Copy results", async () => {
    await refreshAll();
    latest = snapshot();
    await navigator.clipboard.writeText(JSON.stringify(latest, null, 2));
    ui.say("Results copied");
  });

  const showCode = async (target, message) => {
    const text = `${location.origin}${location.pathname}?role=${target}#qr=${await pack(message)}`;
    lastCode = text;
    ui.showCode(text);
    return text.length;
  };

  const scan = async () => {
    if (!("BarcodeDetector" in window)) return ui.say("This browser can't read codes in the page. Use the Camera app, or paste the code.");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    camera = "granted";
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    ui.video.hidden = false;
    ui.video.srcObject = stream;
    await ui.video.play();
    try {
      for (;;) {
        const codes = await detector.detect(ui.video).catch(() => []);
        if (codes.length) return await accept(codes[0].rawValue);
        await sleep(200);
      }
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      ui.video.hidden = true;
    }
  };

  const waiting = new Map();
  const finishOpen = async (link, fail, { from, ms = ROUTES[link.rec.route].deadlineMs } = {}) => {
    const ok = await link.within(ms, from);
    if (!ok) {
      link.rec.noticeMs = link.age();
      ui.say(fail);
      await link.close("no path");
      return false;
    }
    ui.say(`● ${link.rec.peer} · ${link.rec.path ?? ROUTES[link.rec.route].words} in ${(link.rec.openMs / 1000).toFixed(2)} s`);
    return true;
  };

  async function accept(text) {
    const message = await unpack(text);
    if (role === "leader" && message.m === "qr2-answer") {
      const link = waiting.get(message.a);
      if (!link) return ui.say("That answer is for a code this page didn't make");
      waiting.delete(message.a);
      await link.accept(message.s);
      finishOpen(link, "The QR link didn't connect", { from: now() });
      return ui.say("Answer scanned. Linking.");
    }
    if (role === "leader" && message.m === "cert") {
      certs.push(message.f);
      return ui.say(`Saved a link certificate (${certs.length} so far). One-scan QR is ready.`);
    }
    if (role === "follower" && (message.m === "qr2" || message.m === "qr1")) {
      const intro = message.m;
      if (intro === "qr1") certificate ??= await loadCertificate();
      const { servers, urls } = iceFor(message.r, ice);
      const rec = record({ attempt: message.a, session: `${intro}-${message.a}`, peer: "leader", intro, route: message.r, servers: urls });
      const link = newLink(rec, servers, intro === "qr1" ? { certificate: certificate.cert } : {});
      try {
        const sdp = await link.answer(message.s, intro === "qr1" ? { u: message.u, p: message.p } : null);
        if (intro === "qr2") rec.qrChars = await showCode("handback", { m: "qr2-answer", a: message.a, s: sdp });
      } catch (error) {
        rec.error = `${intro} answer refused: ${error.message}`;
        return ui.say(rec.error);
      }
      ui.say(intro === "qr2" ? "Show this code to the leader" : "Linking with one scan");
      finishOpen(link, "The QR link didn't connect");
      return;
    }
    ui.say(`This page can't use a "${message.m}" code`);
  }

  async function loadCertificate() {
    const loaded = await myCertificate();
    return { ...loaded, fingerprint: loaded.cert.getFingerprints().find((f) => f.algorithm === "sha-256")?.value ?? null };
  }

  new BroadcastChannel(CHANNEL).addEventListener("message", (e) => accept(e.data).catch((error) => ui.say(`Code failed: ${error.message}`)));
  ui.button("Scan a code", scan);
  ui.paste.addEventListener("change", () => accept(ui.paste.value).catch((error) => ui.say(`Code failed: ${error.message}`)));

  if (role === "leader") {
    const generations = new Map();
    const current = new Map();
    const boxes = new Map();
    const lead = async (peer) => {
      const generation = (generations.get(peer) ?? 0) + 1;
      generations.set(peer, generation);
      await current.get(peer)?.close("joined again");
      const session = `${peer}#${generation}`;
      for (const route of plan.routes) {
        if (generations.get(peer) !== generation) return;
        const { servers, urls, usable } = iceFor(route, ice);
        const rec = record({ session, peer, intro: "room", route, servers: urls });
        rec.attempt = rec.id;
        if (!usable) {
          rec.error = "skipped: no TURN addresses for this route";
          continue;
        }
        const link = newLink(rec, servers);
        current.set(peer, link);
        const sdp = await link.offer();
        waiting.set(rec.id, link);
        await signal(boxes.get(peer), { k: "offer", to: peer, a: rec.id, session, r: route, s: simulateIsolation && route === "wifi" ? stripCandidates(sdp) : sdp });
        const ok = await finishOpen(link, ROUTES[route].fail);
        waiting.delete(rec.id);
        if (!ok) {
          await signal(boxes.get(peer), { k: "bye", to: peer, a: rec.id, why: "no path" });
          continue;
        }
        if (!plan.each) return;
        await sleep(holdMs);
        await link.close("next route");
        await signal(boxes.get(peer), { k: "bye", to: peer, a: rec.id, why: "next route" });
      }
    };
    await listen("leader", async (message) => {
      if (message.k === "hello") boxes.set(message.from, message.box);
      if (message.k === "hello" && (message.again || !generations.has(message.from))) lead(message.from).catch((error) => ui.say(`Link to ${message.from} failed: ${error.message}`));
      if (message.k === "answer") {
        const link = waiting.get(message.a);
        if (link) await link.accept(simulateIsolation && link.rec.route === "wifi" ? stripCandidates(message.s) : message.s);
      }
    });
    ui.button("QR join (two scans)", async () => {
      const rec = record({ session: `qr2-${nextId + 1}`, peer: "qr", intro: "qr2", route: QR_ROUTE });
      rec.attempt = rec.id;
      const link = newLink(rec, iceFor(QR_ROUTE, ice).servers);
      const sdp = await link.offer();
      waiting.set(rec.id, link);
      rec.qrChars = await showCode("follower", { m: "qr2", a: rec.id, r: QR_ROUTE, s: sdp });
      ui.say("Scan this with the follower phone, then scan its answer");
    });
    ui.button("One-scan QR", async () => {
      const fingerprint = certs.at(-1);
      if (!fingerprint) return ui.say("Scan the follower's link certificate first");
      const rec = record({ session: `qr1-${nextId + 1}`, peer: "qr", intro: "qr1", route: QR_ROUTE });
      rec.attempt = rec.id;
      const link = newLink(rec, iceFor(QR_ROUTE, ice).servers);
      const sdp = await link.offer();
      const u = hex(4);
      const p = hex(12);
      try {
        await link.accept(synthesizeAnswer(sdp, fingerprint, u, p));
      } catch (error) {
        rec.error = `made-up answer refused: ${error.message}`;
        return ui.say(rec.error);
      }
      rec.qrChars = await showCode("follower", { m: "qr1", a: rec.id, r: QR_ROUTE, s: sdp, u, p });
      ui.say("Scan this with the follower phone. No answer code is needed.");
      await finishOpen(link, "The one-scan link didn't connect", { ms: SCAN_WAIT_MS });
    });
    ui.say(`Leading room "${room}", plan ${planName}. Waiting for followers.`);
  } else {
    const box = `p${hex(4)}`;
    const identities = Array.from({ length: linkCount }, () => `f${hex(4)}`);
    const attempts = new Map();
    const offered = new Set();
    await listen(box, async (message) => {
      const me = message.to;
      if (message.k === "offer") {
        offered.add(me);
        const rec = record({ attempt: message.a, session: message.session, peer: me, intro: "room", route: message.r });
        const { servers, urls } = iceFor(message.r, ice);
        rec.servers = urls;
        const link = newLink(rec, servers);
        attempts.set(message.a, link);
        const sdp = await link.answer(message.s);
        await signal("leader", { k: "answer", from: me, a: message.a, s: sdp });
        link.opened.then((ok) => ok && ui.say(`● ${me} · ${rec.path ?? ROUTES[rec.route].words}`));
      }
      if (message.k === "bye") {
        const link = attempts.get(message.a);
        if (!link) return;
        if (link.rec.openMs === null) link.rec.noticeMs = link.age();
        await link.close(message.why);
        if (message.why === "no path") ui.say(ROUTES[link.rec.route].fail);
      }
    });
    for (const me of identities) {
      (async () => {
        while (!offered.has(me)) {
          await signal("leader", { k: "hello", from: me, box }).catch(() => roomStats.failed++);
          await sleep(5000);
        }
      })();
    }
    ui.button("Join again", () => Promise.all(identities.map((me) => signal("leader", { k: "hello", from: me, box, again: true }))));
    ui.button("Show my link certificate", async () => {
      certificate = await loadCertificate();
      if (!certificate.fingerprint) return ui.say("This browser can't read its link certificate");
      await showCode("handback", { m: "cert", f: certificate.fingerprint });
      ui.say(`Certificate ${certificate.stored}. Show this to the leader once, before the gig.`);
    });
    ui.say(`Joining room "${room}" as ${identities.join(", ")}`);
    if (location.hash.startsWith("#qr=")) {
      const text = location.href;
      history.replaceState(null, "", location.pathname + location.search);
      accept(text).catch((error) => ui.say(`Code failed: ${error.message}`));
    }
  }

  window.spike = {
    result: async () => {
      await refreshAll();
      latest = snapshot();
      return latest;
    },
    accept,
    lastCode: () => lastCode,
    press: (text) => [...document.querySelectorAll("button")].find((b) => b.textContent === text)?.click(),
  };
}
