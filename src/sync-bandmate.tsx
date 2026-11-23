import { useEffect, useRef, useState } from "react";
import type { BandMs, LinkRoute, Ping } from "./band-time";
import { codeInText } from "./code-link";
import { ScanCode, useCode } from "./codes";
import { useEscape } from "./hooks";
import { internetRow } from "./links/internet-link";
import { answerPeer, dialPeer, type Intro, type Peer, type PeerRow } from "./links/peer-link";
import { roomLine, serverLink, type RoomIn, type RoomLine } from "./links/server-link";
import { WIFI_ROW } from "./links/wifi-link";
import { asWire, localNow, type WiredLink } from "./links/wire";
import { qrSvg } from "./qr-svg";
import { ApiError, api, type SignedIn } from "./sign-in-methods";
import { syncHistoryStore } from "./phone-db";
import { measureFromPings, saveRun, type Run } from "./sync-history";

/** What the two phones agree to: free public STUN (no TURN anywhere), how long the whole test runs, and how long to wait for an answer. */
export type BandmateConfig = { stun: readonly string[]; testMs: number; timeoutMs: number };

type Result = { ok: boolean; spreadMs?: number; p99Ms?: number; lateRate?: number };
type Results = Partial<Record<LinkRoute, Result>>;
export type Status = { phase: "waiting" | "testing" | "done" | "failed"; words: string };

export const NO_ANSWER = "Your bandmate's phone didn't answer";
const DONE = "Done. Both phones have new ratings.";
const ORDER: readonly LinkRoute[] = ["wifi", "internet", "server"];
const TESTING: Record<LinkRoute, string> = { wifi: "Testing the Wi-Fi link…", internet: "Testing over the internet…", server: "Testing the server…" };
/** Fewer pings than the clock's own window of 8 can't give a spread, so the route counts as a failed try. */
const ENOUGH_PINGS = 8;
const BEAT_MS = 1000;

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const bandNow = () => localNow() as number as BandMs;
const roomUrl = (room: string) => `${location.origin.replace(/^http/, "ws")}/api/rooms/${room}`;
const rowFor = (route: Exclude<LinkRoute, "server">, stun: readonly string[]): PeerRow => (route === "wifi" ? WIFI_ROW : internetRow(stun));

/** A message that is the test talking to itself, not an introduction. It rides in an `intro` body, so the room relays it as it does any other. */
type Control = { a: "ctl"; ctl: "beat" } | { a: "ctl"; ctl: "result"; results: Results };
const isControl = (body: unknown): body is Control => typeof body === "object" && body !== null && (body as Control).a === "ctl";
const isIntro = (body: unknown): body is Intro => typeof body === "object" && body !== null && typeof (body as Intro).a === "string";

async function save(results: Results) {
  for (const route of ORDER) {
    const result = results[route];
    if (!result) continue;
    const run: Run = result.ok ? { spreadMs: result.spreadMs, p99Ms: result.p99Ms, lateRate: result.lateRate, tries: [true], source: "bandmate" } : { tries: [false], source: "bandmate" };
    await saveRun(syncHistoryStore, route, run, Date.now());
  }
}

function helloOf(room: RoomLine, ms: number): Promise<{ you: string; peers: string[] } | null> {
  return new Promise((done) => {
    const timer = setTimeout(() => (off(), done(null)), ms);
    const off = room.listen((message) => {
      if (message.kind === "hello") (clearTimeout(timer), off(), done({ you: String(message.you), peers: Array.isArray(message.peers) ? message.peers.map(String) : [] }));
      if (message.kind === "room-refused") (clearTimeout(timer), off(), done(null));
    });
  });
}

/**
 * The phone showing its code: it waits in the room with no clock running, since the scan can take as long as the person
 * takes, and answers whatever the scanning phone dials. The scanning phone measures and sends the numbers back, so
 * both phones keep the same ones. Silence from the scanning phone once the test has begun fails it, but the code stays
 * on screen, so the next word from a phone that scans it starts the test over.
 */
export function showSide(options: { room: RoomLine; config: BandmateConfig; onStatus: (status: Status) => void; onDone: () => void }): () => void {
  const { room, config } = options;
  const peers = new Map<string, Peer>();
  const links: WiredLink[] = [];
  const serving = new Map<string, WiredLink>();
  let begun = false;
  let state: "live" | "failed" | "over" = "live";
  let stall: ReturnType<typeof setTimeout> | null = null;

  const fail = () => {
    if (state !== "live") return;
    state = "failed";
    options.onStatus({ phase: "failed", words: NO_ANSWER });
  };
  const restart = () => {
    for (const link of links) link.close();
    links.length = 0;
    peers.clear();
    serving.clear();
    begun = false;
    state = "live";
  };
  const heard = () => {
    if (state !== "live") return;
    if (!begun) options.onStatus({ phase: "testing", words: "Testing with your bandmate…" });
    begun = true;
    if (stall) clearTimeout(stall);
    stall = setTimeout(fail, config.timeoutMs);
  };

  options.onStatus({ phase: "waiting", words: "Waiting for your bandmate to scan this code…" });
  const unlisten = room.listen((message: RoomIn) => {
    if (state === "over" || typeof message.from !== "string") return;
    if (state === "failed") restart();
    const from = message.from;
    if (message.kind === "intro" && isControl(message.body)) {
      heard();
      if (message.body.ctl === "result") {
        state = "over";
        if (stall) clearTimeout(stall);
        void save(message.body.results).then(() => {
          options.onStatus({ phase: "done", words: DONE });
          options.onDone();
        });
      }
      return;
    }
    if (message.kind === "intro" && isIntro(message.body)) {
      heard();
      const intro = message.body;
      const route = intro.a.split(":")[0];
      if (intro.sdp && !peers.has(intro.a) && (route === "wifi" || route === "internet")) {
        const peer = answerPeer(intro.a, [rowFor(route, config.stun)], (reply) => room.send({ kind: "intro", to: from, body: reply }), bandNow);
        peers.set(intro.a, peer);
        links.push(peer.link);
      }
      peers.get(intro.a)?.hear(intro);
      return;
    }
    if (message.kind === "link") {
      heard();
      const wire = asWire(message.body);
      if (wire && !serving.has(from)) {
        const link = serverLink(room, from, bandNow);
        serving.set(from, link);
        links.push(link);
        link.receive(wire);
      }
    }
  });
  return () => {
    state = "over";
    if (stall) clearTimeout(stall);
    unlisten();
    for (const link of links) link.close();
    room.close();
  };
}

const openWithin = (link: WiredLink, ms: number) =>
  new Promise<boolean>((done) => {
    if (link.state === "open") return done(true);
    const timer = setTimeout(() => (off(), done(false)), ms);
    const off = link.onState((state) => {
      if (state === "open" || state === "closed") (clearTimeout(timer), off(), done(state === "open"));
    });
  });

async function pingFor(link: WiredLink, ms: number, signal: AbortSignal): Promise<Ping[]> {
  const pings: Ping[] = [];
  for (const end = performance.now() + ms; performance.now() < end && !signal.aborted && link.state === "open"; await pause(100)) {
    await link.ping().then((ping) => pings.push(ping), () => {});
  }
  return pings;
}

/**
 * The phone that scanned: finds the other phone in the room, then tries the Wi-Fi link, the internet and the server one
 * after another, each for its share of the test, and keeps the numbers. The wait for the scan is over by now and is
 * never counted: the answer clock starts here, and stops at the first word from the other phone.
 */
export async function scanSide(options: { room: RoomLine; roomName: string; config: BandmateConfig; onStatus: (status: Status) => void; signal: AbortSignal }): Promise<Results | null> {
  const { config, signal } = options;
  const scannedAt = Date.now();
  let room = options.room;
  let hello = await helloOf(room, Math.min(3000, config.timeoutMs));
  while (!hello?.peers.length && Date.now() - scannedAt < config.timeoutMs && !signal.aborted) {
    room.close();
    await pause(1000);
    room = roomLine(roomUrl(options.roomName));
    hello = await helloOf(room, Math.min(3000, Math.max(500, config.timeoutMs - (Date.now() - scannedAt))));
  }
  const peer = hello?.peers[0];
  if (!peer || signal.aborted) {
    room.close();
    if (!signal.aborted) options.onStatus({ phase: "failed", words: NO_ANSWER });
    return null;
  }

  const controller = new AbortController();
  signal.addEventListener("abort", () => controller.abort(), { once: true });
  let heardFrom = false;
  const stopListening = room.listen((message) => {
    if (message.from === peer) heardFrom = true;
  });
  let silenceTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (!heardFrom) options.onStatus({ phase: "failed", words: NO_ANSWER }), controller.abort();
  }, config.timeoutMs);
  const quiet = controller.signal;
  const beat = setInterval(() => room.send({ kind: "intro", to: peer, body: { a: "ctl", ctl: "beat" } satisfies Control }), BEAT_MS);
  const perRoute = Math.max(1500, Math.round(config.testMs / ORDER.length));
  const results: Results = {};

  try {
    for (const route of ORDER) {
      if (quiet.aborted) return null;
      options.onStatus({ phase: "testing", words: TESTING[route] });
      let link: WiredLink | null = null;
      let held: Peer | null = null;
      if (route === "server") {
        link = serverLink(room, peer, bandNow);
      } else {
        const row = rowFor(route, config.stun);
        held = dialPeer(`${route}:${crypto.randomUUID()}`, [row], (intro) => room.send({ kind: "intro", to: peer, body: intro }));
        const dialed = held;
        const unhear = room.listen((message) => {
          if (message.kind === "intro" && message.from === peer && isIntro(message.body) && message.body.a === dialed.a) dialed.hear(message.body);
        });
        link = (await openWithin(dialed.link, row.deadlineMs)) ? dialed.link : null;
        unhear();
        if (link) await held.relabel();
        else dialed.link.close();
      }
      const pings = link && (await openWithin(link, 1000)) ? await pingFor(link, perRoute, quiet) : [];
      const measured = link?.route ?? route;
      link?.close();
      if (quiet.aborted) return null;
      if (pings.length >= ENOUGH_PINGS) {
        const run = measureFromPings(pings);
        // A link that came up as another route (a Wi-Fi attempt that only the internet could carry) is that route's measurement.
        results[measured] = { ok: run.spreadMs !== undefined, ...run };
        if (measured !== route && !results[route]) results[route] = { ok: false };
      } else if (!results[route]) results[route] = { ok: false };
    }
    if (quiet.aborted) return null;
    if (!Object.values(results).some((result) => result?.ok)) {
      options.onStatus({ phase: "failed", words: NO_ANSWER });
      return null;
    }
    room.send({ kind: "intro", to: peer, body: { a: "ctl", ctl: "result", results } satisfies Control });
    await save(results);
    options.onStatus({ phase: "done", words: DONE });
    return results;
  } finally {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;
    clearInterval(beat);
    stopListening();
    await pause(300);
    room.close();
  }
}

/** Whether this phone is signed in, read once when Connection opens so Test with a bandmate knows before it is tapped. */
export type Who = "signed-out" | "offline" | "in";

export async function whoAmI(): Promise<Who> {
  return api<SignedIn>("/api/me").then(
    () => "in" as const,
    (error) => (error instanceof ApiError && error.status === 401 ? ("signed-out" as const) : ("offline" as const)),
  );
}
type View = { name: "start" } | { name: "show" } | { name: "scan"; code?: string };

const failedWords = (error: unknown) => (error instanceof ApiError && error.status < 500 && error.status !== 0 ? "This code can't be used. Ask your bandmate to show a new one." : "Can't reach the server. Check your connection and try again.");

/** The show side's code and room, from the Worker. */
function ShowView({ config, onStatus, onStopped, onSaved }: { config: BandmateConfig; onStatus: (status: Status) => void; onStopped: () => void; onSaved: () => void }) {
  const [problem, setProblem] = useState("");
  const request = useRef({ kind: "sync-check" as const }).current;
  const { shown } = useCode(request, (error) => setProblem(failedWords(error)));
  const started = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!shown || started.current) return;
    started.current = true;
    let live = true;
    api<{ room: string }>("/api/codes/sync-check", { code: shown.code }).then(
      ({ room }) => {
        if (live) stop.current = showSide({ room: roomLine(roomUrl(room)), config, onStatus, onDone: () => (setDone(true), onSaved()) });
      },
      (error) => live && setProblem(failedWords(error)),
    );
    return () => {
      live = false;
    };
  }, [shown]);
  useEffect(() => () => stop.current?.(), []);

  if (problem) return <p className="account-error" role="alert">{problem}</p>;
  if (!shown) return <p className="account-note">Making your code…</p>;
  return (
    <>
      {done ? null : <div className="codes-qr" role="img" aria-label="Test your connection with a bandmate" dangerouslySetInnerHTML={{ __html: qrSvg(shown.link) }} />}
      {done ? null : <p className="codes-link">{shown.link}</p>}
      {done ? null : (
        <button
          type="button"
          className="account-secondary"
          onClick={() => api("/api/codes/stop", { code: shown.code }).then(onStopped, onStopped)}
        >
          Stop this code
        </button>
      )}
    </>
  );
}

/** The scan side: the code scanned or pasted, the room it opens to, and the test. */
function ScanView({ config, code, failed, onStatus, onSaved }: { config: BandmateConfig; code?: string; failed: boolean; onStatus: (status: Status) => void; onSaved: () => void }) {
  const [problem, setProblem] = useState("");
  const [picked, setPicked] = useState<string | undefined>(code);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!picked) return;
    const controller = new AbortController();
    setProblem("");
    onStatus({ phase: "waiting", words: "Looking for your bandmate…" });
    api<{ room: string }>("/api/codes/sync-check", { code: picked }).then(
      async ({ room }) => {
        if (controller.signal.aborted) return;
        const results = await scanSide({ room: roomLine(roomUrl(room)), roomName: room, config, onStatus, signal: controller.signal });
        if (results && !controller.signal.aborted) onSaved();
      },
      (error) => {
        if (controller.signal.aborted) return;
        const words = error instanceof ApiError && error.reason in CODE_WORDS ? CODE_WORDS[error.reason] : failedWords(error);
        setProblem(words);
        onStatus({ phase: "failed", words });
      },
    );
    return () => controller.abort();
  }, [picked, round]);

  if (!picked) return <ScanCode onCode={setPicked} />;
  return (
    <>
      {failed ? null : <p className="account-note">Keep both phones open until it says Done.</p>}
      {failed ? (
        <button type="button" className="account-secondary" onClick={() => (problem ? setPicked(undefined) : setRound((n) => n + 1))}>
          {problem ? "Scan a different code" : "Try again"}
        </button>
      ) : null}
    </>
  );
}

const CODE_WORDS: Record<string, string> = {
  "bad-code": "This code is incomplete or out of date. Ask your bandmate to show a new one.",
  "code-replaced": "This code was replaced. Ask your bandmate to show a new one.",
  "code-ended": "This code has ended. Ask your bandmate to show a new one.",
  "code-stopped": "This code was stopped. Ask your bandmate to show a new one.",
  "not-a-sync-code": "That code is for something else. Ask your bandmate to show the Test with a bandmate code.",
};

/**
 * Test with a bandmate: one phone shows a code and the other scans it. They meet in one room, and the scanning phone tries
 * every route between them and keeps what it measured on both. A phone that is signed out is told so and can close this.
 */
export function BandmateSheet({ who, landed, config, onClose, onSaved }: { who: Who | null; landed?: string; config: BandmateConfig; onClose: () => void; onSaved: () => void }) {
  useEscape(onClose);
  const [view, setView] = useState<View>(landed && codeInText(landed) ? { name: "scan", code: landed } : { name: "start" });
  const [status, setStatus] = useState<Status | null>(null);

  const body = () => {
    if (who === null) return <p className="account-note">Checking…</p>;
    if (who === "signed-out") return <p className="account-note" role="status">Sign in to test with a bandmate. Close this to go on without it.</p>;
    if (who === "offline") return <p className="account-error" role="alert">Can't reach the server. Check your connection and try again.</p>;
    if (view.name === "start") {
      return (
        <>
          <p className="account-note">Two phones, one test. One of you shows a code and the other scans it. It rates every route between you.</p>
          <div className="account-row">
            <button type="button" className="account-secondary" onClick={() => setView({ name: "show" })}>
              Show my code
            </button>
            <button type="button" className="account-primary" onClick={() => setView({ name: "scan" })}>
              Scan a code
            </button>
          </div>
        </>
      );
    }
    return view.name === "show" ? (
      <ShowView config={config} onStatus={setStatus} onSaved={onSaved} onStopped={() => (setStatus(null), setView({ name: "start" }))} />
    ) : (
      <ScanView config={config} code={view.code} failed={status?.phase === "failed"} onStatus={setStatus} onSaved={onSaved} />
    );
  };

  return (
    <div className="account-backdrop" onClick={(event) => (event.stopPropagation(), onClose())}>
      <section className="account-sheet" role="dialog" aria-modal="true" aria-label="Test with a bandmate" onClick={(event) => event.stopPropagation()}>
        <header className="account-top">
          <h2>Test with a bandmate</h2>
          <button type="button" className="account-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        {status ? (
          <p className={status.phase === "failed" ? "account-error" : "account-note"} role={status.phase === "failed" ? "alert" : "status"} data-slot="bandmate-status">
            {status.words}
          </p>
        ) : null}
        {body()}
      </section>
    </div>
  );
}
