import { useId, useState } from "react";
import { StepButton } from "./controls";
import { useEscape } from "./hooks";
import { LearnChooser } from "./learn-chooser";
import { SCROLL_MAX, SCROLL_MIN, SCROLL_STEP } from "./music";

/**
 * The Scroll pill's caret: the scroll speed for this song, and Learn this song, which turns the sheet into the Learn
 * chooser. Each learn choice closes the sheet first. A live setlist leaves out `onListen`.
 */
export function ScrollSheet({
  percent,
  onPercent,
  canTeach,
  onListen,
  onTeach,
  onBpm,
  onClose,
  initial = "speed",
}: {
  percent: number;
  onPercent: (next: number) => void;
  canTeach: boolean;
  onListen?: () => void;
  onTeach: () => void;
  onBpm: (bpm: number) => void;
  onClose: () => void;
  initial?: "speed" | "learn";
}) {
  const [learning, setLearning] = useState(initial === "learn");
  const closeThen = (run: () => void) => () => {
    onClose();
    run();
  };
  if (learning) {
    return (
      <LearnChooser
        canTeach={canTeach}
        onListen={onListen && closeThen(onListen)}
        onTeach={closeThen(onTeach)}
        onBpm={(bpm) => closeThen(() => onBpm(bpm))()}
        onClose={onClose}
      />
    );
  }
  return <SpeedSheet percent={percent} onPercent={onPercent} onLearn={() => setLearning(true)} onClose={onClose} />;
}

function SpeedSheet({ percent, onPercent, onLearn, onClose }: { percent: number; onPercent: (next: number) => void; onLearn: () => void; onClose: () => void }) {
  const titleId = useId();
  useEscape(onClose);

  return (
    <div className="bottom-backdrop" onClick={onClose}>
      <section className="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className="bottom-sheet-top">
          <h2 id={titleId}>Scroll</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="sheet-row">
          <span className="sheet-row-label">Speed</span>
          <StepButton label="Scroll slower" onClick={() => onPercent(percent - SCROLL_STEP)} disabled={percent <= SCROLL_MIN} />
          <span className="percent">{percent}%</span>
          <StepButton label="Scroll faster" onClick={() => onPercent(percent + SCROLL_STEP)} disabled={percent >= SCROLL_MAX} />
        </div>
        <button type="button" className="sheet-row sheet-row-button" onClick={onLearn}>
          Learn this song
        </button>
      </section>
    </div>
  );
}
