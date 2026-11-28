import { StepButton, TextSizeButtons } from "./controls";
import { useScrollSpeed } from "./hooks";
import { SPEED_MAX, SPEED_MIN, stepSpeed } from "./scroll-timing";
import "./gig-corners.css";

export type TextSteps = { index: number; count: number; onChange: (index: number) => void };

/**
 * The leading phone's corners of the chart, as a zero-height layer that sits on the stage bar's top edge: A− A+ at the
 * left, and while the sheet scrolls, Scroll slower and Scroll faster at the right. The speed is this phone's live speed;
 * it goes to no one else and back to 100% on the next song.
 */
export function GigCorners({ text, scrolling }: { text: TextSteps; scrolling: boolean }) {
  const [speed, setSpeed] = useScrollSpeed();
  const percent = Math.round(speed * 100);
  return (
    <div className="gig-corners">
      <div className="gig-corner gig-corner-text" role="group" aria-label="Text size">
        <TextSizeButtons index={text.index} count={text.count} onChange={text.onChange} />
      </div>
      {scrolling ? (
        <div className="gig-corner gig-corner-speed" role="group" aria-label="Scroll speed">
          <span className="gig-corner-percent" role="status">
            {percent === 100 ? "" : `${percent}%`}
          </span>
          <StepButton label="Scroll slower" onClick={() => setSpeed(stepSpeed(speed, -1))} disabled={speed <= SPEED_MIN} />
          <StepButton label="Scroll faster" onClick={() => setSpeed(stepSpeed(speed, 1))} disabled={speed >= SPEED_MAX} />
        </div>
      ) : null}
    </div>
  );
}
