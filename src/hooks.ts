import { useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { clampScrollPercent, type Notation } from "./music";
import { READING_LINE, runScroll, type Motion, type Section } from "./scroll-timing";
import { loadNotation, loadScrollPercent, onStorageChange, saveNotation, saveScrollPercent, storageGeneration } from "./storage";
import type { SongRef } from "./types";

/**
 * A value a screen keeps from storage. It is read again when `key` changes and whenever a sync rewrites storage, so
 * no screen goes on showing, or writing back, a copy older than what is stored.
 */
export function useStored<T>(load: () => T, key: unknown = null): [T, Dispatch<SetStateAction<T>>] {
  const generation = useSyncExternalStore(onStorageChange, storageGeneration);
  const [held, setHeld] = useState(() => ({ value: load(), key, generation }));
  const set: Dispatch<SetStateAction<T>> = (next) =>
    setHeld((current) => ({ ...current, value: next instanceof Function ? next(current.value) : next }));
  if (held.key === key && held.generation === generation) return [held.value, set];
  const fresh = { value: load(), key, generation };
  setHeld(fresh);
  return [fresh.value, set];
}

export function usePerformance(songRef: SongRef | null) {
  const [semitones, setSemitones] = useState(0);
  const [notation, setNotation] = useStored<Notation>(() => (songRef == null ? "notes" : loadNotation(songRef)), songRef);
  const [percent, setPercent] = useStored(() => (songRef == null ? 100 : loadScrollPercent(songRef)), songRef);
  const [scrolling, setScrolling] = useState(false);
  const [boundRef, setBoundRef] = useState<SongRef | null>(null);

  if (songRef !== boundRef) {
    setBoundRef(songRef);
    setSemitones(0);
    setScrolling(false);
  }

  useEffect(() => {
    if (songRef == null) return;
    document.getElementById("sheet-scroll")?.scrollTo(0, 0);
  }, [songRef]);

  const changeNotation = (next: Notation) => {
    setNotation(next);
    if (songRef != null) saveNotation(songRef, next);
  };

  const changePercent = (next: number) => {
    const clamped = clampScrollPercent(next);
    setPercent(clamped);
    if (songRef != null) saveScrollPercent(songRef, clamped);
  };

  const stopScroll = () => setScrolling(false);

  return {
    semitones,
    setSemitones,
    notation,
    changeNotation,
    percent,
    changePercent,
    scrolling,
    setScrolling,
    stopScroll,
  };
}

/**
 * Scrolls #sheet-scroll by `motion`. A timed motion moves #chord-section only: from its top at the top of the
 * view to its bottom at the bottom. A learned one brings each heading, then the chart's end, to the reading line.
 * Grabbing or a manual scroll pauses. A new `plan` re-syncs from where the sheet is. Returns the timed clock, in
 * seconds at the plan's BPM.
 */
export function useAutoScroll(
  active: boolean,
  motion: Motion,
  plan: string,
  onStop: (reason: "user" | "end") => void,
) {
  const motionRef = useRef(motion);
  motionRef.current = motion;
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;
  const clock = useRef(0);

  useEffect(() => {
    if (!active) return;
    const el = document.getElementById("sheet-scroll");
    if (!el) return;
    return scrollChart(el, () => document.getElementById("chord-section"), motionRef, clock, (reason) => onStopRef.current(reason));
  }, [active, plan]);

  return clock;
}

/**
 * Runs `runScroll` over the chord section, measured afresh every frame so a text size or window change keeps the
 * same progress. When the section has moved since the last frame, the browser shifted or clamped the scroll for
 * the new layout, so that scroll event is not passed on as the player scrolling.
 */
export function scrollChart(
  el: HTMLElement,
  chart: () => HTMLElement | null,
  motion: { current: Motion },
  clock: { current: number },
  onStop: (reason: "user" | "end") => void,
): () => void {
  let last: Section | null = null;
  const section = (): Section | null => {
    const found = chart();
    if (!found) return null;
    const origin = el.getBoundingClientRect().top - el.scrollTop;
    const start = found.getBoundingClientRect().top - origin;
    last = { start, end: start + found.offsetHeight - el.clientHeight };
    const tops = () => [...found.querySelectorAll(".chart-heading")].map((heading) => heading.getBoundingClientRect().top - origin);
    return { ...last, lines: () => [...tops(), start + found.offsetHeight].map((top) => top - READING_LINE) };
  };
  const relaid = (event: Event) => {
    const before = last;
    const now = section();
    if (before && now && (Math.abs(now.start - before.start) >= 1 || Math.abs(now.end - before.end) >= 1)) {
      event.stopImmediatePropagation();
    }
  };
  el.addEventListener("scroll", relaid, { passive: true });
  const stop = runScroll(el, motion, section, clock, onStop);
  return () => {
    stop();
    el.removeEventListener("scroll", relaid);
  };
}

/** Screen Wake Lock. Missing support and rejected requests are silent. The OS drops the lock when the page hides, so it is requested again on return. */
export function useWakeLock(enabled: boolean) {
  const sentinel = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    let cancelled = false;

    const release = () => {
      const current = sentinel.current;
      sentinel.current = null;
      if (current) void current.release().catch(() => {});
    };

    const acquire = async () => {
      if (!enabled || cancelled || document.visibilityState !== "visible") return;
      if (!("wakeLock" in navigator)) return;
      try {
        sentinel.current = await navigator.wakeLock.request("screen");
      } catch {
        sentinel.current = null;
      }
    };

    if (enabled) void acquire();
    else release();

    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, [enabled]);
}
