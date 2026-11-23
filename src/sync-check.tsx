import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { barsText, syncBars } from "./band-status-model";
import { flipNow, type BandMs, type Grid } from "./band-time";
import type { Timeline } from "./gig-state";
import { useEscape } from "./hooks";
import { followBand, secondsSinceHeardClick, setMetronomeSound, stopMetronome } from "./metronome-audio";
import { BEAT_FLASH_SECONDS, SPEAKER_DELAY_MAX_MS, SPEAKER_DELAY_MIN_MS, SPEAKER_DELAY_STEP_MS, clampSpeakerDelayMs } from "./metronome";
import type { MetronomeState } from "./metronome-view";
import { ROUTE_WORDS } from "./routes";
import type { TimeSource } from "./scroll-timing";
import { ApiError, api } from "./sign-in-methods";
import { SYNC_BEAT_MS, syncLogQueue, syncReport, type RunReport, type SyncBeat, type SyncRoute, type SyncRow, type SyncRun } from "./sync-log";

/** This phone's link to the leader as the Sync check reads it: the route, band time, and the clock estimate's numbers. */
export type SyncLink = { route: SyncRoute; bandAt: TimeSource; offsetMs: number; spreadMs: number | null; rttMs: number | null };

/** 120 bpm from band time 0, so every phone on the band clock flashes and clicks together, in a run or not. */
const GRID: Grid = { bpm: 60_000 / SYNC_BEAT_MS, beatsPerBar: 4, startAt: 0 as BandMs, firstBar: 0 };
const CLICK: Timeline<Grid | null> = [{ at: 0 as BandMs, value: GRID }];
/** With no leader, the phone's own clock stands in for band time. */
const OWN_CLOCK: TimeSource = (perfMs) => perfMs;
const FLASH_MS = BEAT_FLASH_SECONDS * 1000;
/** A beat's row is sent once its click has had time to be heard. */
const SETTLED_MS = 400;
const LOOK_EVERY_MS = 3_000;
const SEND_EVERY_MS = 5_000;
const CARRIERS = ["Verizon", "AT&T", "T-Mobile", "Other"];

/** Idle until a run is live. Done keeps the run so a late look for runs can't start it again. */
type RunState =
  | { kind: "idle" }
  | { kind: "live"; run: SyncRun }
  | { kind: "done"; run: SyncRun; logged: number; dropped: number; report: RunReport | null };

const MESSAGES: Record<string, string> = {
  offline: "Can't reach the server. Check your connection and try again.",
  "signed-out": "Sign in to start a run or log one.",
  "not-admin": "Only an admin can start a run.",
  "not-a-member": "You're not in this band anymore.",
  "no-band": "This band is gone.",
};
const message = (error: unknown) => {
  const reason = error instanceof ApiError ? (error.status >= 500 ? "offline" : error.reason) : "";
  return MESSAGES[reason] ?? "Something went wrong. Try again.";
};

const routeWord = (route: SyncRoute) => (route === "leader" ? "Leading" : ROUTE_WORDS[route]);

/** The white block the camera films. Its style is set once; each frame only flips its opacity. */
const FLASH_STYLE: CSSProperties = { height: "38vh", minHeight: 160, borderRadius: 12, background: "#fff", opacity: 0, margin: "8px 0" };

function Bars({ spreadMs }: { spreadMs: number }) {
  const bars = syncBars(spreadMs);
  return (
    <p className="sync-bars" role="img" aria-label={bars === 0 ? "Sync: Out of sync" : `Sync: ${bars} of 4 bars`}>
      {[1, 2, 3, 4].map((bar) => (
        <span key={bar} aria-hidden="true">
          {bar <= bars ? "▮" : "▯"}
        </span>
      ))}
      {bars === 0 ? <span> {barsText(spreadMs)}</span> : null}
    </p>
  );
}

/**
 * Sync check (PLAN.md 7.17): a white flash on every band beat and the click under it, for filming phones side by side.
 * The admin starts a 60 s run; during it every phone logs each beat to the band's `sync_log`. With no `link` to a leader
 * the phone flashes on its own click and logs nothing. Line up with the band sets this phone's speaker delay by ear.
 * The speaker delay lives in the app's one metronome (`useMetronome` in App), so no other metronome setting writes over it.
 */
export function SyncCheckSheet({
  bandId,
  admin,
  link,
  names,
  metronome,
  onClose,
}: {
  bandId: string | null;
  admin: boolean;
  link: SyncLink | null;
  names: Record<string, string>;
  metronome: Pick<MetronomeState, "prefs" | "setPrefs">;
  onClose: () => void;
}) {
  const titleId = useId();
  useEscape(onClose);
  const { prefs, setPrefs } = metronome;
  const sound = useRef(prefs.sound);
  sound.current = prefs.sound;
  const [carrier, setCarrier] = useState("");
  const [runState, setRunState] = useState<RunState>({ kind: "idle" });
  const [error, setError] = useState("");
  const [silent, setSilent] = useState(false);
  const flashRef = useRef<HTMLDivElement>(null);
  const live = useRef({ link, carrier, runState });
  live.current = { link, carrier, runState };
  const bandAt = link?.bandAt ?? OWN_CLOCK;
  const linked = link !== null;
  const speakerDelayMs = prefs.speakerDelayMs;

  const startClick = () => {
    setSilent(false);
    setMetronomeSound(true);
    followBand(CLICK, bandAt, speakerDelayMs, () => setSilent(true));
  };
  useEffect(startClick, [bandAt, speakerDelayMs]);
  useEffect(
    () => () => {
      stopMetronome();
      setMetronomeSound(sound.current);
    },
    [],
  );

  const nudge = (ms: number) => setPrefs({ speakerDelayMs: clampSpeakerDelayMs(speakerDelayMs + ms) });

  // Look for the admin's run while linked to a band and no run is live. Alone, nothing is asked of the server.
  const looking = bandId !== null && linked && runState.kind !== "live";
  const doneRun = runState.kind === "done" ? runState.run.runId : null;
  useEffect(() => {
    if (!looking) return;
    let stopped = false;
    const look = () =>
      api<{ run: SyncRun | null }>("/api/bands/sync/current", { bandId }).then(
        ({ run }) => {
          if (stopped || !run || run.runId === doneRun) return;
          setError("");
          setRunState({ kind: "live", run });
        },
        (caught) => !stopped && setError(message(caught)),
      );
    look();
    const timer = window.setInterval(look, LOOK_EVERY_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [looking, bandId, doneRun]);

  // During a run: one queue for its rows, sent every few seconds, and the run's end noticed on band time.
  const liveRun = runState.kind === "live" ? runState.run : null;
  const queue = useRef<ReturnType<typeof syncLogQueue> | null>(null);
  useEffect(() => {
    if (!liveRun || bandId === null) return;
    const rows = syncLogQueue((beats) => api("/api/bands/sync/log", { bandId, runId: liveRun.runId, beats }));
    queue.current = rows;
    const timer = window.setInterval(() => void rows.flush(), SEND_EVERY_MS);
    return () => {
      window.clearInterval(timer);
      void rows.flush();
      if (queue.current === rows) queue.current = null;
    };
  }, [liveRun, bandId]);

  const finish = async (run: SyncRun) => {
    const rows = queue.current;
    await rows?.flush();
    const { logged, dropped } = rows?.counts() ?? { logged: 0, dropped: 0 };
    setRunState({ kind: "done", run, logged, dropped, report: null });
    const read = await api<{ rows: SyncRow[] }>("/api/bands/sync/rows", { bandId, runId: run.runId }).catch(() => null);
    const report = read ? (syncReport(read.rows)[0] ?? null) : null;
    setRunState((now) => (now.kind === "done" && now.run.runId === run.runId ? { ...now, report } : now));
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // Each frame: flash on the frame closest to the beat, note when the click was heard, and settle each run beat's row.
  useEffect(() => {
    let frame = 0;
    let last: number | null = null;
    let lastHeard: number | null = null;
    let ending: string | null = null;
    const beats = new Map<number, SyncBeat>();
    const draw = (ts: number) => {
      const { link: now, carrier: picked, runState: state } = live.current;
      const clock = now?.bandAt ?? OWN_CLOCK;
      const frameMs = last === null ? 1000 / 60 : ts - last;
      last = ts;
      const band = clock(ts);
      const n = Math.floor((band + frameMs / 2) / SYNC_BEAT_MS);
      const at = n * SYNC_BEAT_MS;
      const lit = flipNow(at as BandMs, band as BandMs, frameMs) && band - at < FLASH_MS;
      const el = flashRef.current;
      if (el && el.dataset.flash !== (lit ? "on" : "off")) {
        el.dataset.flash = lit ? "on" : "off";
        el.style.opacity = lit ? "1" : "0";
      }

      const run = state.kind === "live" && now ? state.run : null;
      const rowFor = (beatAt: number) => {
        if (!run || !now || beatAt < run.startAt || beatAt >= run.endsAt) return null;
        const beat = Math.round((beatAt - run.startAt) / SYNC_BEAT_MS);
        if (!beats.has(beat)) {
          beats.set(beat, {
            beat, route: now.route, carrier: picked, at: beatAt, shown_at: null, clicked_at: null,
            offset_ms: now.offsetMs, spread_ms: now.spreadMs, rtt_ms: now.rttMs, frame_ms: null,
          });
        }
        return beats.get(beat)!;
      };
      if (lit) {
        const row = rowFor(at);
        if (row && row.shown_at === null) Object.assign(row, { shown_at: band, frame_ms: frameMs });
      }
      const heard = secondsSinceHeardClick(0);
      if (heard !== null && (lastHeard === null || heard < lastHeard)) {
        const clickedAt = clock(performance.now()) - heard * 1000;
        const row = rowFor(Math.round(clickedAt / SYNC_BEAT_MS) * SYNC_BEAT_MS);
        if (row && row.clicked_at === null) row.clicked_at = clickedAt;
      }
      lastHeard = heard;

      for (const [beat, row] of beats) {
        if (band - row.at < SETTLED_MS) continue;
        queue.current?.add(row);
        beats.delete(beat);
      }
      if (run && band >= run.endsAt + SETTLED_MS && ending !== run.runId) {
        ending = run.runId;
        void finishRef.current(run);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  const start = () => {
    setError("");
    api<{ run: SyncRun }>("/api/bands/sync/start", { bandId }).then(
      ({ run }) => setRunState({ kind: "live", run }),
      (caught) => setError(message(caught)),
    );
  };

  const nameOf = (userId: string) => names[userId] ?? userId;
  return (
    <div className="bottom-backdrop" onClick={onClose}>
      <section className="bottom-sheet sync-check" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className="bottom-sheet-top">
          <h2 id={titleId}>Sync check</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div ref={flashRef} className="sync-flash" data-flash="off" aria-hidden="true" style={FLASH_STYLE} />
        <p className="sync-route">{link ? routeWord(link.route) : "Alone · nothing to compare"}</p>
        {link && link.spreadMs !== null ? <Bars spreadMs={link.spreadMs} /> : null}
        {silent ? (
          <button type="button" className="sheet-row sheet-row-button" onClick={startClick}>
            Tap to hear the click
          </button>
        ) : null}

        {linked && bandId !== null ? (
          <div className="sync-run">
            {runState.kind === "live" ? <p className="account-note">Run on · every beat is logged for 60 s.</p> : null}
            {runState.kind === "done" ? (
              <>
                <p className="account-note">
                  Run over · {runState.logged} beats logged
                  {runState.dropped > 0 ? ` · ${runState.dropped} beats not logged (no signal)` : ""}
                </p>
                {runState.report?.pairs.map((pair) => (
                  <p key={`${pair.a} ${pair.b}`} className="account-note">
                    {nameOf(pair.a)} + {nameOf(pair.b)} · {ROUTE_WORDS[pair.route]} · screens p95 {pair.screen ? pair.screen.p95.toFixed(1) : "—"} ms · clicks p95{" "}
                    {pair.click ? pair.click.p95.toFixed(1) : "—"} ms · {pair.pass ? "on target" : "over target"}
                  </p>
                ))}
              </>
            ) : null}
            {runState.kind !== "live" && admin ? (
              <button type="button" className="account-primary" onClick={start}>
                Start a 60 s run
              </button>
            ) : null}
            {runState.kind === "idle" && !admin ? <p className="account-note">Waiting for an admin to start a run.</p> : null}
          </div>
        ) : null}
        {error ? <p className="account-note" role="alert">{error}</p> : null}

        <h3 className="account-section">Line up with the band</h3>
        <p className="account-note">Listen to the other phones. If your click sounds late, tap My click is late until it lands on theirs.</p>
        <div className="sheet-row">
          <button type="button" className="account-secondary" onClick={() => nudge(-SPEAKER_DELAY_STEP_MS)} disabled={speakerDelayMs <= SPEAKER_DELAY_MIN_MS}>
            My click is early
          </button>
          <span className="sheet-row-label">Speaker delay {speakerDelayMs} ms</span>
          <button type="button" className="account-secondary" onClick={() => nudge(SPEAKER_DELAY_STEP_MS)} disabled={speakerDelayMs >= SPEAKER_DELAY_MAX_MS}>
            My click is late
          </button>
        </div>
        <div className="sheet-row" role="group" aria-label="Carrier" style={{ flexWrap: "wrap" }}>
          <span className="sheet-row-label">Carrier</span>
          {CARRIERS.map((name) => (
            <button key={name} type="button" className="account-secondary" aria-pressed={carrier === name} onClick={() => setCarrier(carrier === name ? "" : name)}>
              {name}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
