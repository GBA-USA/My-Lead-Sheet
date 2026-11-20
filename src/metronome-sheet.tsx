import { useId } from "react";
import { useEscape } from "./hooks";
import { MetronomeControl, type MetronomeState } from "./metronome-view";

/** The Metronome pill's sheet: On/Off, − bpm +, Sound, Dot and Dot sync. The beat dot stays on the card. */
export function MetronomeSheet({ songTempo, metronome, onClose }: { songTempo: number | null; metronome: MetronomeState; onClose: () => void }) {
  const titleId = useId();
  useEscape(onClose);

  return (
    <div
      className="bottom-backdrop"
      // Opened from the song chrome, whose bar unfolds on a tap that reaches it.
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <section className="bottom-sheet metronome-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className="bottom-sheet-top">
          <h2 id={titleId}>Metronome</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <MetronomeControl songTempo={songTempo} metronome={metronome} />
      </section>
    </div>
  );
}
