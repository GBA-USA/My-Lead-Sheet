import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { statusRows, type Player } from "./band-status-model";
import { useEscape } from "./hooks";
import "./band-status.css";

const LIVE_LINE = "Sync and timing show during a live gig.";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0].toUpperCase())
    .join("");

export function BandStatusPanel({ players, onClose }: { players: Player[]; onClose: () => void }) {
  const titleId = useId();
  useEscape(onClose);

  return (
    <div className="bottom-backdrop" onClick={onClose}>
      <section className="bottom-sheet band-status-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className="bottom-sheet-top">
          <h2 id={titleId}>Band status</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <ul className="band-status-rows">
          {statusRows(players).map((row) => (
            <li key={row.id} className={row.amber ? "band-status-row band-status-amber" : "band-status-row"}>
              <span className="band-status-name">{row.name}</span>
              {row.leader ? <span className="band-status-tag">Leader</span> : null}
              {row.you ? <span className="band-status-tag">You</span> : null}
              <span className="band-status-route">{row.routeText}</span>
              {row.bars === null ? null : (
                <span className="band-status-bars">
                  {row.barsText || (
                    <span className="band-status-bars-boxes">
                      {[0, 1, 2, 3].map((i) => (
                        <span key={i} className={i < (row.bars ?? 0) ? "band-status-bar-filled" : "band-status-bar-empty"}>
                          □
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              )}
              <span className="band-status-downloaded">{row.downloaded}</span>
              {row.inTime ? <span className="band-status-in-time">{row.inTime}</span> : null}
              <span className="band-status-heard">{row.heard}</span>
            </li>
          ))}
        </ul>
        <p className="account-note band-status-line">{LIVE_LINE}</p>
      </section>
    </div>
  );
}

/** The panel mounts on `.app`, because `.scroll` is its own stacking context under the shell header. */
export function BandStatusFaces({ players }: { players: Player[] }) {
  const [sheetHost, setSheetHost] = useState<Element | null>(null);
  if (players.length === 0) return null;

  return (
    <>
      <div className="band-status-faces" role="group" aria-label="Band status">
        {statusRows(players).map((row) => (
          <button
            key={row.id}
            type="button"
            className={["band-status-face", row.leader && "band-status-face-leader", row.amber && "band-status-face-amber"].filter(Boolean).join(" ")}
            aria-label={row.leader ? `${row.name}, leader` : row.name}
            onClick={(event) => setSheetHost(event.currentTarget.closest(".app") ?? document.body)}
          >
            {initials(row.name)}
          </button>
        ))}
      </div>
      {sheetHost ? createPortal(<BandStatusPanel players={players} onClose={() => setSheetHost(null)} />, sheetHost) : null}
    </>
  );
}
