import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { secondsSinceClick, setMetronomeBpm, startMetronome, stopMetronome } from "./metronome-audio";
import {
  METRONOME_MAX,
  METRONOME_MIN,
  beatDotState,
  clampMetronomeBpm,
  initialMetronomeBpm,
  metronomePadAction,
} from "./metronome";

/**
 * Performance tempo for the current song. A song change restores song.tempo
 * (or leaves the metronome unset when that tempo is null). Nothing here is
 * written back to the song, and nothing here feeds auto-scroll.
 */
export function useMetronome(songId: number | null, tempo: number | null) {
  const [bpm, setBpmState] = useState<number | null>(() => initialMetronomeBpm(tempo));
  const [playing, setPlaying] = useState(false);
  const [boundId, setBoundId] = useState<number | null>(songId);
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

  return { bpm, playing, setBpm, nudge, toggle, stop };
}

export type MetronomeState = ReturnType<typeof useMetronome>;

/** Mount only while the metronome plays. Each frame reads the audio clock, so the dot never re-renders React. */
export function BeatDot() {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const el = ref.current;
      const state = beatDotState(secondsSinceClick());
      if (el && el.dataset.beat !== state) el.dataset.beat = state;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="beat-rail" aria-hidden="true">
      <span ref={ref} className="beat-dot" data-beat="off" />
    </div>
  );
}

export function MetronomeControl({
  songTempo,
  bpm,
  playing,
  onBpm,
  onNudge,
  onToggle,
  onStop,
}: {
  songTempo: number | null;
  bpm: number | null;
  playing: boolean;
  onBpm: (next: number | null) => void;
  onNudge: (delta: number) => void;
  onToggle: () => void;
  onStop: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<string | null>(null);
  const lastTap = useRef<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

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
      onBpm(initialMetronomeBpm(songTempo));
      return;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return;
    onBpm(clampMetronomeBpm(parsed));
  };

  const openSpeed = () => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    requestAnimationFrame(() => input.select());
  };

  const onPadClick = (event: MouseEvent<HTMLButtonElement>) => {
    const now = performance.now();
    const since = lastTap.current == null ? null : now - lastTap.current;
    const action = metronomePadAction(event.detail, since, bpm != null);
    if (action === "toggle") {
      lastTap.current = null;
      inputRef.current?.blur();
      onToggle();
      return;
    }
    lastTap.current = now;
    // Focus inside the tap so the phone keyboard can open. A following tap
    // still toggles playback and leaves this field without changing speed.
    openSpeed();
  };

  const status = playing ? "Playing" : bpm == null ? "Off" : "Stopped";
  const hint =
    bpm == null
      ? "No tempo stored. Tap the number to set a speed."
      : playing
        ? "Tap the number to change speed. Double-tap Metronome or tap Stop."
        : "Tap the number to change speed. Double-tap Metronome to start.";

  return (
    <div
      ref={rootRef}
      className="metronome"
      data-bpm={bpm ?? ""}
      data-playing={playing ? "true" : "false"}
    >
      <button
        type="button"
        className={playing ? "metro-pad is-on" : "metro-pad"}
        style={bpm != null ? ({ "--metro-bpm": String(bpm) } as CSSProperties) : undefined}
        aria-pressed={playing}
        aria-label={
          bpm == null
            ? "Metronome off. No tempo stored. Tap to set a speed."
            : playing
              ? `Metronome playing at ${bpm} bpm. Tap to change speed. Double-tap to stop.`
              : `Metronome ${bpm} bpm. Tap to change speed. Double-tap to start.`
        }
        onClick={onPadClick}
      >
        <span className="metro-name">Metronome</span>
        <span className="metro-status">
          <span className="metro-lamp" aria-hidden="true" />
          {status}
        </span>
      </button>
      <div className="metronome-controls">
        <button
          type="button"
          className="metro-step"
          aria-label="Slower metronome"
          disabled={bpm == null || bpm <= METRONOME_MIN}
          onClick={() => onNudge(-1)}
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
          onClick={() => onNudge(1)}
        >
          +
        </button>
        {playing ? (
          <button type="button" className="metro-stop" onClick={onStop}>
            Stop
          </button>
        ) : null}
      </div>
      <p className="metro-hint">{hint}</p>
    </div>
  );
}
