import { useLayoutEffect, useRef } from "react";

/** The chart row at the top of what shows of the sheet, and how far below that top it sits. */
type Held = { row: Element; offset: number };

const ROWS = "#chord-section .chart-section > :not(.chart-heading)";

/** The top of what shows of the sheet: below the open bar at rest, below the bar that hangs over it while it scrolls. */
function shownTop(el: HTMLElement): number {
  return el.getBoundingClientRect().top + (parseFloat(el.style.getPropertyValue("--chrome-over")) || 0);
}

function readRow(): Held | null {
  const el = document.getElementById("sheet-scroll");
  if (!el || el.scrollTop <= 0) return null;
  const top = shownTop(el);
  for (const row of document.querySelectorAll(ROWS)) {
    const at = row.getBoundingClientRect().top - top;
    if (at >= -1) return { row, offset: at };
  }
  return null;
}

/**
 * The scroll that puts the row back is the sheet keeping its place, not the player's hand, so it reaches no scroll
 * listener: the top bar does not fold for it and auto-scroll does not stop for it.
 */
function unheard(el: HTMLElement) {
  let frame = 0;
  const hush = (event: Event) => {
    if (event.target !== el) return;
    event.stopImmediatePropagation();
    done();
  };
  const done = () => {
    window.removeEventListener("scroll", hush, true);
    cancelAnimationFrame(frame);
  };
  window.addEventListener("scroll", hush, true);
  frame = requestAnimationFrame(() => (frame = requestAnimationFrame(done)));
}

/**
 * Keeps the chart row being read where it was when the text size changes: the row at the top of the shown sheet is read
 * while the old size is still laid out, and the sheet is scrolled to put it back once the new size is. A sheet at its
 * top stays at its top.
 */
export function useReadingRow(scale: number) {
  const held = useRef<Held | null>(null);
  const last = useRef(scale);
  if (scale !== last.current) {
    last.current = scale;
    held.current = readRow();
  }

  useLayoutEffect(() => {
    const was = held.current;
    held.current = null;
    const el = document.getElementById("sheet-scroll");
    if (!was || !el || !was.row.isConnected) return;
    const by = was.row.getBoundingClientRect().top - shownTop(el) - was.offset;
    if (Math.abs(by) < 1) return;
    unheard(el);
    el.scrollTop += by;
  }, [scale]);
}
