import { useEffect, useRef, useState } from "react";
import { clampScrollPercent, type Notation } from "./music";
import { loadNotation, loadScrollPercent, saveNotation, saveScrollPercent } from "./storage";

export function usePerformance(songId: number | null) {
  const [semitones, setSemitones] = useState(0);
  const [notation, setNotation] = useState<Notation>("notes");
  const [percent, setPercent] = useState(100);
  const [scrolling, setScrolling] = useState(false);
  const [boundId, setBoundId] = useState<number | null>(null);

  if (songId !== boundId) {
    setBoundId(songId);
    setSemitones(0);
    setScrolling(false);
    if (songId == null) {
      setNotation("notes");
      setPercent(100);
    } else {
      setNotation(loadNotation(songId));
      setPercent(loadScrollPercent(songId));
    }
  }

  useEffect(() => {
    if (songId == null) return;
    document.getElementById("sheet-scroll")?.scrollTo(0, 0);
  }, [songId]);

  const changeNotation = (next: Notation) => {
    setNotation(next);
    if (songId != null) saveNotation(songId, next);
  };

  const changePercent = (next: number) => {
    const clamped = clampScrollPercent(next);
    setPercent(clamped);
    if (songId != null) saveScrollPercent(songId, clamped);
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

/** Scrolls #sheet-scroll. Grabbing or a manual scroll pauses. Starting at the bottom restarts at the top. */
export function useAutoScroll(active: boolean, pxPerSec: number, onStop: () => void) {
  const pxRef = useRef(pxPerSec);
  pxRef.current = pxPerSec;
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;

  useEffect(() => {
    if (!active) return;
    const el = document.getElementById("sheet-scroll");
    if (!el) return;

    const limit = () => Math.max(0, el.scrollHeight - el.clientHeight);
    // scrollTop is integer on some browsers, and 78 BPM is only ~19px/s,
    // so a per-frame bump of a fraction of a pixel would be rounded away.
    let position = el.scrollTop;
    if (position >= limit() - 2) {
      position = 0;
      el.scrollTop = 0;
    }
    let expected = position;
    let armed = false;

    let frame = 0;
    let last = performance.now();

    const stop = () => onStopRef.current();
    const onScroll = () => {
      if (!armed) return;
      if (Math.abs(el.scrollTop - expected) < 2) return;
      stop();
    };

    el.addEventListener("pointerdown", stop);
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    armed = true;

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const max = limit();
      position = Math.min(max, position + pxRef.current * dt);
      if (position >= max - 0.5) {
        expected = max;
        el.scrollTop = max;
        stop();
        return;
      }
      expected = position;
      el.scrollTop = position;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("pointerdown", stop);
      el.removeEventListener("wheel", stop);
      el.removeEventListener("scroll", onScroll);
    };
  }, [active]);
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
