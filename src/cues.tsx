import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { shortHeading } from "./learn-analyze";
import { startMetronome, stopMetronome } from "./metronome-audio";
import type { Learned } from "./scroll-timing";
import "./learn.css";

export const CUE_BARS = 4;

export interface Cue {
  /** Index of the chart section that starts next. */
  section: number;
  heading: string;
  bars: number;
}

/** The next section change, when it is at most CUE_BARS bars of learned beats after `clock`. */
export function cueAt(learned: Learned, clock: number): Cue | null {
  const section = learned.sections.findIndex((each, i) => i > 0 && each.at > clock);
  if (section < 0) return null;
  const { heading, at } = learned.sections[section];
  const beats = learned.beats.filter((beat) => beat > clock && beat <= at).length;
  const bars = Math.ceil(beats / learned.beatsPerBar);
  return bars >= 1 && bars <= CUE_BARS ? { section, heading: shortHeading(heading), bars } : null;
}

export function cueText({ heading, bars }: Cue): string {
  return `${heading} in ${bars} ${bars === 1 ? "bar" : "bars"}`;
}

/** One bar of clicks at the opening tempo, sped up or slowed like the scroll, ending as the clock reaches bar 1. */
export function countIn(learned: Learned, rate: number): { bpm: number; seconds: number } {
  return { bpm: ((60 * learned.beatsPerBar) / learned.downbeat) * rate, seconds: learned.downbeat / rate };
}

let playing: Learned | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const play = (learned: Learned | null) => {
  playing = learned;
  listeners.forEach((listener) => listener());
};

/** The learned version scrolling now, while LearnedCues is mounted; otherwise null. */
export function usePlayingLearned(): Learned | null {
  return useSyncExternalStore(subscribe, () => playing);
}

function chartSections(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("#chord-section .chart-section")];
}

/**
 * Mount while a learned version scrolls. A start from the top counts in one bar on the metronome once the
 * scroll clock starts moving, unless the metronome is already playing. Before each section change it shows
 * "Chorus in 4 bars" and lights the next section's heading for the last bar.
 */
export function LearnedCues({
  learned,
  clock,
  rate,
  metronomeOn,
}: {
  learned: Learned;
  clock: RefObject<number>;
  rate: number;
  metronomeOn: boolean;
}) {
  const [text, setText] = useState("");
  const metronome = useRef(metronomeOn);
  metronome.current = metronomeOn;
  const speed = useRef(rate);
  speed.current = rate;

  useEffect(() => {
    play(learned);
    return () => play(null);
  }, [learned]);

  useEffect(() => {
    let counting = false;
    let timer = 0;
    let lit: HTMLElement | undefined;
    const endCountIn = () => {
      if (counting && !metronome.current) stopMetronome();
      counting = false;
    };
    const light = (section: HTMLElement | undefined) => {
      if (section === lit) return;
      lit?.removeAttribute("data-next");
      section?.setAttribute("data-next", "");
      lit = section;
    };
    const draw = () => {
      const cue = cueAt(learned, clock.current);
      setText(cue ? cueText(cue) : "");
      light(cue?.bars === 1 ? chartSections()[cue.section] : undefined);
      frame = requestAnimationFrame(draw);
    };
    const startCountIn = () => {
      const { bpm, seconds } = countIn(learned, speed.current);
      counting = true;
      startMetronome(bpm, () => {});
      timer = window.setTimeout(endCountIn, (seconds - 30 / bpm) * 1000);
    };
    const waitForClock = (from: number) => {
      if (clock.current === from) {
        frame = requestAnimationFrame(() => waitForClock(from));
        return;
      }
      if (from < learned.downbeat && !metronome.current) startCountIn();
      draw();
    };
    let frame = requestAnimationFrame(() => waitForClock(clock.current));
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      endCountIn();
      light(undefined);
    };
  }, [learned, clock]);

  return (
    <div className="cue-anchor">
      {text ? (
        <p className="cue" role="status">
          {text}
        </p>
      ) : null}
    </div>
  );
}
