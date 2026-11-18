import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";

const TRAVEL = 24;

/** Whether the song chrome is folded, and where the sheet's current run of scrolling began: the lowest point while open, the highest while folded. */
type Fold = { folded: boolean; mark: number };

/** It folds only once the `room` above the sheet is out of view, so no gap opens under the bar. */
function foldAfterScroll(fold: Fold, top: number, room: number): Fold {
  if (fold.folded) {
    if (top > fold.mark) return { folded: true, mark: top };
    return fold.mark - top >= TRAVEL ? { folded: false, mark: top } : fold;
  }
  if (top < fold.mark) return { folded: false, mark: top };
  return top - fold.mark >= TRAVEL && top >= room ? { folded: true, mark: top } : fold;
}

/**
 * The top of a scrolling page (a song's chrome, or a list's header and tabs), keyed by `page`, in a slot as tall as
 * the folded bar. `room` is how far the open chrome reaches past the slot. At rest the room sits under the slot, so
 * #sheet-scroll starts below the open chrome. Folded or auto-scrolling (`over`), the room moves into the top of
 * #sheet-scroll and the open chrome hangs over it, so folding never resizes the scroller that auto-scroll plans against. Either way the sheet sits at the same place on screen for the same scrollTop.
 */
export function useSongChrome(page: string | null, scrolling: boolean, holdOpen: boolean, onFold: () => void) {
  const bar = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState(false);
  const [room, setRoom] = useState(0);
  const fold = useRef<Fold>({ folded: false, mark: 0 });
  const latest = useRef({ room, holdOpen, onFold });
  latest.current = { room, holdOpen, onFold };
  const over = page != null && (folded || scrolling);
  const wasOver = useRef(over);
  const keepTop = useRef<number | null>(null);
  if (over !== wasOver.current) {
    wasOver.current = over;
    // Read before the room moves: once it has, Chrome's scroll anchoring shifts scrollTop to follow the sheet.
    keepTop.current = document.getElementById("sheet-scroll")?.scrollTop ?? null;
  }

  useLayoutEffect(() => {
    const el = document.getElementById("sheet-scroll");
    if (el && keepTop.current != null) el.scrollTop = keepTop.current;
    keepTop.current = null;
  }, [over]);

  const open = () => {
    fold.current = { folded: false, mark: document.getElementById("sheet-scroll")?.scrollTop ?? 0 };
    setFolded(false);
  };

  useEffect(() => {
    if (page && holdOpen) open();
  }, [page, holdOpen]);

  useLayoutEffect(() => {
    const el = bar.current;
    const box = slot.current;
    if (!el || !box || folded) return;
    const measure = () => setRoom(Math.max(0, el.offsetHeight - box.offsetHeight));
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [page, folded]);

  useLayoutEffect(() => {
    open();
    const el = document.getElementById("sheet-scroll");
    if (!page || !el) return;
    const onScroll = () => {
      const now = latest.current;
      const next = foldAfterScroll(fold.current, el.scrollTop, now.room);
      if (next.folded && !fold.current.folded && !now.holdOpen) now.onFold();
      fold.current = now.holdOpen ? { ...next, folded: false } : next;
      setFolded(fold.current.folded);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [page]);

  const onBarClick = (event: MouseEvent) => {
    if (fold.current.folded && !(event.target as Element).closest("button, a, input")) open();
  };

  return {
    page,
    bar,
    slot,
    folded,
    onBarClick,
    slotStyle: over ? undefined : { marginBottom: room },
    spacer: over ? room : 0,
    sheetStyle: page ? ({ "--chrome-over": `${over && !folded ? room : 0}px`, scrollPaddingTop: over ? room : 0 } as CSSProperties) : undefined,
  };
}

type SongChrome = ReturnType<typeof useSongChrome>;

/**
 * The same two wrappers on every route, so going between a song and a list keeps the header and tabs mounted, focus
 * included. A `list` top folds to its header row; a song's folds to the two-row playing bar.
 */
export function SongChromeSlot({ chrome, list, children }: { chrome: SongChrome; list: boolean; children: ReactNode }) {
  return (
    <div className={!chrome.page ? "song-chrome is-off" : list ? "song-chrome is-list" : "song-chrome"} ref={chrome.slot} style={chrome.slotStyle}>
      <div className="song-chrome-bar" ref={chrome.bar} data-folded={chrome.folded ? (list ? "list" : "song") : undefined} onClick={chrome.onBarClick}>
        {children}
      </div>
    </div>
  );
}

export function SongChromeRoom({ chrome }: { chrome: SongChrome }) {
  return chrome.page ? <div className="song-chrome-room" style={{ height: chrome.spacer }} /> : null;
}
