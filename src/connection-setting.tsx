import { useId, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useEscape, useStored } from "./hooks";
import { tonightLine } from "./route-policy";
import { CHOICE_WORDS, type RouteChoice } from "./routes";
import { loadConnection, saveConnection } from "./storage";
import "./account.css";
import "./band-library.css";
import "./settings.css";

/** The gig this phone is in right now: the admin's route and the strip's line for it. Held in memory, so a reload or the gig's end clears it. */
export type Tonight = { route: RouteChoice; line: string | null };

let tonight: Tonight | null = null;
const tonightListeners = new Set<() => void>();

/** Join gig sets this with the gig's route, and sets null when the phone leaves the gig. The phone's own setting is never written. */
export function setTonight(next: Tonight | null) {
  tonight = next;
  for (const listener of tonightListeners) listener();
}

const onTonight = (listener: () => void) => {
  tonightListeners.add(listener);
  return () => tonightListeners.delete(listener);
};
const useTonight = () => useSyncExternalStore(onTonight, () => tonight, () => null);

const MESSAGES: Record<string, string> = {
  "not-saved": "This phone did not keep that change. It lasts until you close the app.",
};

const CHOICES = Object.keys(CHOICE_WORDS) as RouteChoice[];

const ROW: CSSProperties = { gridTemplateColumns: "auto minmax(0, 1fr) auto" };
const RATING: CSSProperties = { gridColumn: 3, gridRow: "1 / span 2", color: "var(--text-dim)", fontSize: 13, textAlign: "right" };
const GREYED: CSSProperties = { opacity: 0.5 };

/** Settings > Connection: four choices as rows of name, line and rating. During a gig the admin's choice shows and the rows are greyed out. */
function ConnectionSheet({ choice, onChoose, onClose }: { choice: RouteChoice; onChoose: (next: RouteChoice) => void; onClose: () => void }) {
  useEscape(onClose);
  const titleId = useId();
  const gig = useTonight();
  const [error, setError] = useState("");
  const shown = gig?.route ?? choice;

  const pick = (next: RouteChoice) => {
    onChoose(next);
    setError(saveConnection(next) ? "" : MESSAGES["not-saved"]);
  };

  return (
    <div className="account-backdrop" onClick={onClose}>
      <section className="account-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className="account-top">
          <h2 id={titleId}>Connection</h2>
          <button type="button" className="account-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        {error ? (
          <p className="account-error" role="alert">
            {error}
          </p>
        ) : null}
        {gig ? (
          <>
            <p className="account-note" role="status">
              {tonightLine(gig.route)}
            </p>
            {gig.line ? <p className="account-note">{gig.line}</p> : null}
          </>
        ) : (
          <p className="account-note">How this phone reaches the band. In a gig, the admin's choice is used.</p>
        )}
        <fieldset className="gig-plan-route" disabled={!!gig} style={gig ? GREYED : undefined}>
          <legend className="account-field">Connect by</legend>
          {CHOICES.map((route) => (
            <label key={route} style={ROW}>
              <input type="radio" name="connection" checked={shown === route} onChange={() => pick(route)} />
              <span data-slot="name">{CHOICE_WORDS[route].name}</span>
              <small data-slot="line">{CHOICE_WORDS[route].line}</small>
              <span data-slot="rating" style={RATING} />
            </label>
          ))}
        </fieldset>
      </section>
    </div>
  );
}

/** The Connection row in Settings, naming the choice in use, and the screen it opens. */
export function ConnectionEntry() {
  const [choice, setChoice] = useStored(loadConnection);
  const [open, setOpen] = useState(false);
  const gig = useTonight();
  return (
    <section className="settings-group" aria-label="Connection">
      <button type="button" className="settings-row" onClick={() => setOpen(true)}>
        Connection · {CHOICE_WORDS[gig?.route ?? choice].name}
      </button>
      {open ? <ConnectionSheet choice={choice} onChoose={setChoice} onClose={() => setOpen(false)} /> : null}
    </section>
  );
}
