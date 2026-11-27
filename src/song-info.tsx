import { createContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { displayChordLine, originalKey, type Notation } from "./music";
import type { Song } from "./types";
import "./song-info.css";

/** What a song's band notes strip draws: how many notes, and whether it shows anything at all (a note, or an admin's Add a note). */
export type NotesSeen = { count: number; shown: boolean };

/** The notes strip tells the Song info row what it has, since the strip draws nothing until its reply lands. */
export const NotesReport = createContext<(seen: NotesSeen) => void>(() => {});

const NOTHING: NotesSeen = { count: 0, shown: false };

/**
 * A scroll this recent means the chart is moving under the player, so a toggle keeps the chart where it is. scrollTop
 * moves in whole pixels, so the slowest auto-scroll (about 1 px a second) is heard at least this often.
 */
const MOVING_MS = 1000;

const filled = (text: string) => text.trim().length > 0;

export function OriginalKeyHint({ song, semitones }: { song: Song; semitones: number }) {
  const original = originalKey(song, semitones);
  return original ? <span className="hint"> · original key ({original})</span> : null;
}

/**
 * The Song info row under the Key / Time / Tempo line, closed, and the panel it opens: the source line, Feel, How to
 * play, At a glance, Practice tip, Key & tempo notes, then the band's `notes`. The notes stay mounted while closed, so
 * the row can name how many there are. With nothing to show there is no row. Mount it keyed by the song's ref, so a new
 * song starts closed. While the chart scrolls, opening or closing keeps the chart still and the panel grows upward;
 * at rest it opens in place.
 */
export function SongInfo({ song, semitones, notation, notes }: { song: Song; semitones: number; notation: Notation; notes?: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<NotesSeen>(NOTHING);
  const scrolledAt = useRef(-Infinity);
  const held = useRef<{ scroller: HTMLElement; chart: Element; top: number } | null>(null);

  // A scroll does not bubble, but it passes the document on the capture way down. Listening there touches no element
  // at mount, so a sheet drawn in a stand-in DOM (check:metronome, check:teach) mounts as it does in a browser.
  useEffect(() => {
    const heard = (event: Event) => {
      if ((event.target as HTMLElement | null)?.id === "sheet-scroll") scrolledAt.current = performance.now();
    };
    document.addEventListener("scroll", heard, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", heard, { capture: true });
  }, []);

  useLayoutEffect(() => {
    const hold = held.current;
    held.current = null;
    if (hold) hold.scroller.scrollTop += hold.chart.getBoundingClientRect().top - hold.top;
  }, [open]);

  const tempoNotes = [song.keyNote, song.tempoNote].filter(filled);
  const hasFields = [song.sourceNote, song.feel, song.howToPlay, song.atAGlance, song.practiceTip].some(filled) || tempoNotes.length > 0;
  const shows = hasFields || seen.shown;
  const hint = <OriginalKeyHint song={song} semitones={semitones} />;

  const toggle = () => {
    const scroller = document.getElementById("sheet-scroll");
    const chart = document.getElementById("chord-section");
    if (scroller && chart && performance.now() - scrolledAt.current < MOVING_MS) {
      held.current = { scroller, chart, top: chart.getBoundingClientRect().top };
    }
    setOpen((now) => !now);
  };

  return (
    <div className="song-info" hidden={!shows}>
      {shows ? (
        <button
          type="button"
          className="song-info-row"
          aria-expanded={open}
          aria-controls={id}
          onClick={toggle}
          // React's capture listener sits on the root, above #sheet-scroll, so stopping the pointerdown here keeps a tap from pausing auto-scroll.
          onPointerDownCapture={(event) => event.stopPropagation()}
        >
          <span>{seen.count > 0 ? `Song info · ${seen.count} band ${seen.count === 1 ? "note" : "notes"}` : "Song info"}</span>
          <span className="song-info-mark" aria-hidden="true" />
        </button>
      ) : null}
      <div className="song-info-panel" id={id} hidden={!open || !shows}>
        {filled(song.sourceNote) ? <p className="source">{song.sourceNote}</p> : null}
        {filled(song.feel) ? <p className="feel">Feel: {song.feel}</p> : null}
        {filled(song.howToPlay) ? (
          <>
            <h2 className="sheet-label">How to play{hint}</h2>
            <p className="prose">{song.howToPlay}</p>
          </>
        ) : null}
        {filled(song.atAGlance) ? (
          <>
            <h2 className="sheet-label">At a glance</h2>
            <p className="prose">{displayChordLine(song.atAGlance, song, semitones, notation)}</p>
          </>
        ) : null}
        {filled(song.practiceTip) ? (
          <>
            <h2 className="sheet-label">Practice tip{hint}</h2>
            <p className="prose">{song.practiceTip}</p>
          </>
        ) : null}
        {tempoNotes.length > 0 ? (
          <>
            <h2 className="sheet-label">Key &amp; tempo notes</h2>
            {tempoNotes.map((note, index) => (
              <p key={index} className="prose note-line">
                {note}
              </p>
            ))}
          </>
        ) : null}
        <NotesReport.Provider value={setSeen}>{notes}</NotesReport.Provider>
      </div>
    </div>
  );
}
