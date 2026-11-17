import { useId } from "react";
import { BpmFinder } from "./bpm-finder";
import { useEscape } from "./hooks";

/** Learn this song: listen to the song, scroll it yourself, or find its BPM. A live setlist leaves out `onListen`. */
export function LearnChooser({
  canTeach,
  onListen,
  onTeach,
  onBpm,
  onClose,
}: {
  canTeach: boolean;
  onListen?: () => void;
  onTeach: () => void;
  onBpm: (bpm: number) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  useEscape(onClose);

  return (
    <div className="bottom-backdrop" onClick={onClose}>
      <section className="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className="bottom-sheet-top">
          <h2 id={titleId}>Learn this song</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        {onListen ? <Row label="Learn by listen" line="Play the whole song near the phone, then tap Stop." onClick={onListen} /> : null}
        <Row label="Learn by user" line={canTeach ? "Scroll it yourself." : "Needs the song's length and BPM"} disabled={!canTeach} onClick={onTeach} />
        <div className="learn-row">
          <BpmFinder onAccept={onBpm}>
            <span className="learn-row-line">Listen or tap tempo.</span>
          </BpmFinder>
        </div>
      </section>
    </div>
  );
}

function Row({ label, line, disabled = false, onClick }: { label: string; line: string; disabled?: boolean; onClick: () => void }) {
  const lineId = useId();
  return (
    <div className="learn-row">
      <button type="button" aria-label={label} aria-describedby={lineId} disabled={disabled} onClick={onClick}>
        <span className="learn-row-title">{label}</span>
        <span className="learn-row-line" id={lineId}>
          {line}
        </span>
      </button>
    </div>
  );
}
