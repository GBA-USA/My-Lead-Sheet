import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import {
  highLatencyOutput,
  secondsSinceHeardClick,
  setMetronomeBpm,
  setMetronomeSound,
  startMetronome,
  stopMetronome,
} from "./metronome-audio";
import {
  METRONOME_MAX,
  METRONOME_MIN,
  SYNC_OFFSET_MAX_MS,
  SYNC_OFFSET_MIN_MS,
  SYNC_OFFSET_STEP_MS,
  beatDotState,
  clampMetronomeBpm,
  clampSyncOffsetMs,
  initialMetronomeBpm,
  parseMetronomePrefs,
  type MetronomePrefs,
  type SyncMode,
} from "./metronome";
import { loadMetronomePrefs, saveMetronomePrefs } from "./storage";
import "./metronome.css";

/**
 * Performance tempo for the current song. A song change restores song.tempo
 * (or leaves the metronome unset when that tempo is null). Nothing here is
 * written back to the song, and nothing here feeds auto-scroll.
 */
export function useMetronome(songId: number | null, tempo: number | null) {
  const [bpm, setBpmState] = useState<number | null>(() => initialMetronomeBpm(tempo));
  const [playing, setPlaying] = useState(false);
  const [boundId, setBoundId] = useState<number | null>(songId);
  const [prefs, setPrefsState] = useState(() => parseMetronomePrefs(loadMetronomePrefs()));
  const bpmRef = useRef(bpm);
  const playingRef = useRef(playing);
  bpmRef.current = bpm;
  playingRef.current = playing;

  if (songId !== boundId) {
    const next = initialMetronomeBpm(tempo);
    bpmRef.current = next;
    playingRef.current = false;
    setBoundId(songId);
    setBpmState(next);
    setPlaying(false);
  }

  const unset = bpm == null;

  useEffect(() => {
    if (bpm != null) setMetronomeBpm(bpm);
  }, [bpm]);

  useEffect(() => setMetronomeSound(prefs.sound), [prefs.sound]);

  useEffect(() => {
    if (!playing || bpm == null) {
      stopMetronome();
      return;
    }
    startMetronome(bpmRef.current ?? bpm, stop);
    return () => stopMetronome();
  }, [playing, songId, unset]);

  const setBpm = (next: number | null) => {
    if (next == null) {
      bpmRef.current = null;
      playingRef.current = false;
      setBpmState(null);
      setPlaying(false);
      return;
    }
    const clamped = clampMetronomeBpm(next);
    bpmRef.current = clamped;
    setBpmState(clamped);
  };

  const nudge = (delta: number) => {
    if (bpmRef.current == null) return;
    setBpm(bpmRef.current + delta);
  };

  const stop = () => {
    playingRef.current = false;
    setPlaying(false);
  };

  const toggle = () => {
    const current = bpmRef.current;
    if (current == null) return;
    if (playingRef.current) {
      stop();
      return;
    }
    playingRef.current = true;
    setPlaying(true);
    startMetronome(current, stop);
  };

  const setPrefs = (patch: Partial<MetronomePrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefsState(next);
    saveMetronomePrefs(next);
  };

  return { bpm, playing, setBpm, nudge, toggle, stop, prefs, setPrefs };
}

export type MetronomeState = ReturnType<typeof useMetronome>;

/** Mount only while the metronome plays. Each frame reads the audio clock, so the dot never re-renders React. */
export function BeatDot({ offsetMs }: { offsetMs: number }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const el = ref.current;
      const state = beatDotState(secondsSinceHeardClick(offsetMs / 1000));
      if (el && el.dataset.beat !== state) el.dataset.beat = state;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [offsetMs]);

  return (
    <div className="beat-rail" aria-hidden="true">
      <span ref={ref} className="beat-dot" data-beat="off" />
    </div>
  );
}

/** Auto polls because the browser fires no event when outputLatency changes. */
function useHighLatencyOutput(watch: boolean): boolean {
  const [high, setHigh] = useState(false);
  useEffect(() => {
    if (!watch) return;
    let live = true;
    const check = () => {
      highLatencyOutput().then((next) => {
        if (live) setHigh(next);
      });
    };
    check();
    const timer = window.setInterval(check, 1000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [watch]);
  return high;
}

const ON_OFF = [
  { value: true, label: "On" },
  { value: false, label: "Off" },
];
const SYNC_MODES: { value: SyncMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

function Choice<T>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="metro-choice" role="group" aria-label={label}>
      <span className="metro-choice-label">{label}</span>
      <span className="metro-segments">
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </span>
    </div>
  );
}

function offsetText(ms: number): string {
  return `${ms > 0 ? "+" : ms < 0 ? "−" : ""}${Math.abs(ms)} ms`;
}

export function MetronomeControl({ songTempo, metronome }: { songTempo: number | null; metronome: MetronomeState }) {
  const { bpm, playing, prefs, setPrefs } = metronome;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const panelId = useId();
  const highLatency = useHighLatencyOutput(prefs.syncMode === "auto");
  const syncShown = prefs.indicator && (prefs.syncMode === "on" || (prefs.syncMode === "auto" && highLatency));
  const offset = prefs.syncOffsetMs;

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // #sheet-scroll pauses auto-scroll on pointerdown. React's listener runs
    // too late to stop that, so block the native event here. Speed changes
    // and start/stop must not pause or retune the scroll.
    const block = (event: Event) => event.stopPropagation();
    el.addEventListener("pointerdown", block);
    return () => el.removeEventListener("pointerdown", block);
  }, []);

  const shown = draft != null ? draft : bpm == null ? "" : String(bpm);

  const commit = () => {
    const text = draftRef.current;
    if (text == null) return;
    draftRef.current = null;
    setDraft(null);
    if (!text.trim()) {
      metronome.setBpm(initialMetronomeBpm(songTempo));
      return;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return;
    metronome.setBpm(clampMetronomeBpm(parsed));
  };

  const openSpeed = () => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    requestAnimationFrame(() => input.select());
  };

  const onPadClick = () => {
    if (bpm == null) {
      openSpeed();
      return;
    }
    inputRef.current?.blur();
    metronome.toggle();
  };

  const status = playing ? "On" : "Off";
  const hint =
    bpm == null
      ? "No tempo stored. Tap the number to set a speed."
      : "Tap Metronome to turn it on or off. Tap the number to change speed.";

  return (
    <div
      ref={rootRef}
      className="metronome"
      data-bpm={bpm ?? ""}
      data-playing={playing ? "true" : "false"}
    >
      <div className="metro-top">
        <button
          type="button"
          className={playing ? "metro-pad is-on" : "metro-pad"}
          style={bpm != null ? ({ "--metro-bpm": String(bpm) } as CSSProperties) : undefined}
          aria-pressed={playing}
          aria-label={
            bpm == null
              ? "Metronome off. No tempo stored. Tap to set a speed."
              : playing
                ? `Metronome on at ${bpm} bpm. Tap to turn off.`
                : `Metronome off, ${bpm} bpm. Tap to turn on.`
          }
          onClick={onPadClick}
        >
          <span className="metro-name">Metronome</span>
          <span className="metro-status">
            <span className="metro-lamp" aria-hidden="true" />
            {status}
          </span>
        </button>
        <button
          type="button"
          className="metro-settings"
          aria-expanded={settingsOpen}
          aria-controls={settingsOpen ? panelId : undefined}
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          Settings
        </button>
      </div>
      <div className="metronome-controls">
        <button
          type="button"
          className="metro-step"
          aria-label="Slower metronome"
          disabled={bpm == null || bpm <= METRONOME_MIN}
          onClick={() => metronome.nudge(-1)}
        >
          −
        </button>
        <input
          ref={inputRef}
          className="metro-input"
          inputMode="numeric"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          aria-label="Metronome speed in bpm"
          placeholder="bpm"
          value={shown}
          onFocus={(event) => {
            const next = bpm == null ? "" : String(bpm);
            draftRef.current = next;
            setDraft(next);
            const input = event.currentTarget;
            requestAnimationFrame(() => input.select());
          }}
          onChange={(event) => {
            const next = event.target.value.replace(/\D/g, "").slice(0, 3);
            draftRef.current = next;
            setDraft(next);
          }}
          onBlur={() => commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
              inputRef.current?.blur();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              draftRef.current = null;
              setDraft(null);
              inputRef.current?.blur();
            }
          }}
        />
        {bpm == null && draft == null ? null : (
          <span className="metro-unit" aria-hidden="true">
            bpm
          </span>
        )}
        <button
          type="button"
          className="metro-step"
          aria-label="Faster metronome"
          disabled={bpm == null || bpm >= METRONOME_MAX}
          onClick={() => metronome.nudge(1)}
        >
          +
        </button>
      </div>
      {syncShown ? (
        <div className="metro-sync">
          <span className="metro-choice-label">Dot sync</span>
          <button
            type="button"
            className="metro-step"
            aria-label="Dot earlier"
            disabled={offset <= SYNC_OFFSET_MIN_MS}
            onClick={() => setPrefs({ syncOffsetMs: clampSyncOffsetMs(offset - SYNC_OFFSET_STEP_MS) })}
          >
            −
          </button>
          <output className="metro-sync-value" aria-label="Dot sync offset">
            {offsetText(offset)}
          </output>
          <button
            type="button"
            className="metro-step"
            aria-label="Dot later"
            disabled={offset >= SYNC_OFFSET_MAX_MS}
            onClick={() => setPrefs({ syncOffsetMs: clampSyncOffsetMs(offset + SYNC_OFFSET_STEP_MS) })}
          >
            +
          </button>
        </div>
      ) : null}
      <p className="metro-hint">{hint}</p>
      {settingsOpen ? (
        <div className="metro-panel" id={panelId}>
          <Choice label="Beat dot" value={prefs.indicator} options={ON_OFF} onChange={(indicator) => setPrefs({ indicator })} />
          <Choice label="Sound" value={prefs.sound} options={ON_OFF} onChange={(sound) => setPrefs({ sound })} />
          <Choice label="Dot sync" value={prefs.syncMode} options={SYNC_MODES} onChange={(syncMode) => setPrefs({ syncMode })} />
          <p className="metro-hint">Auto shows Dot sync when the browser reports a delayed output, like Bluetooth.</p>
        </div>
      ) : null}
    </div>
  );
}
