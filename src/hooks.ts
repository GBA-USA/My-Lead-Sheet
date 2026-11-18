import { useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { parseHash } from "./route";
import { READING_LINE, runScroll, type Motion, type Section, type TimeSource } from "./scroll-timing";
import { onStorageChange, storageGeneration } from "./storage";
import type { SongRef } from "./types";

/**
 * A value a screen keeps from storage. It is read again when `key` changes and whenever a sync rewrites storage, so
 * no screen goes on showing, or writing back, a copy older than what is stored.
 */
export function useStored<T>(load: () => T, key: unknown = null): [T, Dispatch<SetStateAction<T>>] {
  const generation = useSyncExternalStore(onStorageChange, storageGeneration, storageGeneration);
  const [held, setHeld] = useState(() => ({ value: load(), key, generation }));
  const set: Dispatch<SetStateAction<T>> = (next) =>
    setHeld((current) => ({ ...current, value: next instanceof Function ? next(current.value) : next }));
  if (held.key === key && held.generation === generation) return [held.value, set];
  const fresh = { value: load(), key, generation };
  setHeld(fresh);
  return [fresh.value, set];
}

/** Whether the current song's timed scroll runs. A song change stops it and puts the sheet back at the top. */
export function useScrolling(songRef: SongRef | null) {
  const [scrolling, setScrolling] = useState(false);
  const [bound, setBound] = useState(songRef);

  if (songRef !== bound) {
    setBound(songRef);
    setScrolling(false);
  }

  useEffect(() => {
    if (songRef == null) return;
    document.getElementById("sheet-scroll")?.scrollTo(0, 0);
  }, [songRef]);

  return { scrolling, setScrolling, stopScroll: () => setScrolling(false) };
}

const playheads = new Set<(at: number) => void>();

/** Hears, every timed frame of auto-scroll, how far down the chart the song is, in pixels. */
export function onPlayhead(listener: (at: number) => void): () => void {
  playheads.add(listener);
  return () => void playheads.delete(listener);
}

/**
 * Scrolls #sheet-scroll by `motion`. A timed motion moves #chord-section only: from its top at the top of the
 * view to its bottom at the bottom. A learned one brings each heading, then the chart's end, to the reading line.
 * Grabbing or a manual scroll pauses. A new `plan` re-syncs from where the sheet is. Returns the timed clock, in
 * seconds at the plan's BPM. `time` is band time in a gig; solo leaves it out.
 */
export function useAutoScroll(
  active: boolean,
  motion: Motion,
  plan: string,
  onStop: (reason: "user" | "end") => void,
  time?: TimeSource,
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
    const playhead = (at: number) => playheads.forEach((listener) => listener(at));
    return scrollChart(el, () => document.getElementById("chord-section"), motionRef, clock, (reason) => onStopRef.current(reason), time, playhead);
  }, [active, plan, time]);

  return clock;
}

/**
 * Runs `runScroll` over the chord section, measured afresh every frame so a text size or window change keeps the
 * same progress. When the section has moved since the last frame, the browser shifted or clamped the scroll for
 * the new layout, so that scroll event is not passed on as the player scrolling.
 * Each timed frame tells `onPlayhead` how far down the chart, in pixels, the song is. A timed motion goes down the
 * chart with its progress; a learned one is at the reading line, where each heading arrives as its section starts.
 */
export function scrollChart(
  el: HTMLElement,
  chart: () => HTMLElement | null,
  motion: { current: Motion },
  clock: { current: number },
  onStop: (reason: "user" | "end") => void,
  time?: TimeSource,
  onPlayhead?: (at: number) => void,
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
  const playhead = (progress: number) => {
    const found = chart();
    if (!found || !last || !onPlayhead) return;
    onPlayhead(motion.current.kind === "learned" ? el.scrollTop + READING_LINE - last.start : progress * found.offsetHeight);
  };
  const stop = runScroll(el, motion, section, clock, onStop, time, playhead);
  return () => {
    stop();
    el.removeEventListener("scroll", relaid);
  };
}

/** Screen Wake Lock, held while the app is open. Missing support and rejected requests are silent. The OS drops the lock when the page hides, so it is requested again on return. */
export function useWakeLock() {
  const sentinel = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      if (!("wakeLock" in navigator)) return;
      try {
        sentinel.current = await navigator.wakeLock.request("screen");
      } catch {
        sentinel.current = null;
      }
    };

    void acquire();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      const current = sentinel.current;
      sentinel.current = null;
      if (current) void current.release().catch(() => {});
    };
  }, []);
}

export function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/**
 * Closes a sheet when the page goes to a song, so a song link inside it, such as Open on the duplicate offer, shows the
 * song. It subscribes once: App's own hashchange listener re-renders the sheet during the same event, and a listener
 * removed and re-added mid-dispatch is never called for that event.
 */
export function useCloseOnSong(onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onHash = () => {
      if (parseHash(window.location.hash).name === "song") close.current();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
}
