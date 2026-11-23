import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { livePlayers, opensBandStatus, panelLine, statusRows, type Player, type PlayerStatus, type StatusRow } from "./band-status-model";
import type { GigStatus } from "./gig-plan-model";
import { useEscape } from "./hooks";
import "./band-status.css";

/** A live gig's feed: who leads now, whether this phone's player is the band's admin, and the leader's statuses on the clock `now` reads. */
export type LiveFeed = { leader: string; admin: boolean; statuses: () => readonly PlayerStatus[]; now: () => number };

/** "Heard 2 s ago" counts up between pings, so a live strip reads its feed again every second. */
const TICK_MS = 1000;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0].toUpperCase())
    .join("");

const ROW_TONE: Record<StatusRow["tone"], string> = { steady: "band-status-row", amber: "band-status-row band-status-amber", grey: "band-status-row band-status-grey" };

function faceClass(row: StatusRow, live: boolean): string {
  const status = !live || row.leader ? null : row.tone === "grey" ? "band-status-face-grey" : row.tone === "amber" ? "band-status-face-amber" : "band-status-face-steady";
  return ["band-status-face", row.leader && "band-status-face-leader", status].filter(Boolean).join(" ");
}

export function BandStatusPanel({ players, onClose }: { players: Player[]; onClose: () => void }) {
  const titleId = useId();
  useEscape(onClose);
  const line = panelLine(players);

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
            <li key={row.id} className={ROW_TONE[row.tone]}>
              <span className="band-status-name">{row.name}</span>
              {row.leader ? <span className="band-status-tag">Leader</span> : null}
              {row.you ? <span className="band-status-tag">You</span> : null}
              {row.routeText ? <span className="band-status-route">{row.routeText}</span> : null}
              {row.bars === null ? null : (
                <span className="band-status-bars">
                  {row.barsText || (
                    <span className="band-status-bars-boxes" role="img" aria-label={`Sync: ${row.bars} of 4 bars`}>
                      {[0, 1, 2, 3].map((i) =>
                        i < (row.bars ?? 0) ? (
                          <span key={i} className="band-status-bar-filled">
                            ■
                          </span>
                        ) : (
                          <span key={i} className="band-status-bar-empty">
                            □
                          </span>
                        ),
                      )}
                    </span>
                  )}
                </span>
              )}
              <span className="band-status-downloaded">{row.downloaded}</span>
              {row.inTime ? <span className="band-status-in-time">{row.inTime}</span> : null}
              {row.heard ? <span className="band-status-heard">{row.heard}</span> : null}
            </li>
          ))}
        </ul>
        {line ? <p className="account-note band-status-line">{line}</p> : null}
      </section>
    </div>
  );
}

function useTick(on: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [on]);
}

/**
 * The faces strip for a gig in `status`. Before a gig goes live anyone in the band may open the panel. During one,
 * `live` feeds it and only the admin and the leader may (PLAN.md 6), so for anyone else, and for everyone on a phone
 * with no feed, the faces are pictures, not buttons, with no status rings. A feed on a gig that is not live is not
 * read. Losing the lead shuts an open panel, and getting it back does not reopen it. The panel mounts on `.app`,
 * because `.scroll` is its own stacking context under the shell header.
 */
export function BandStatusFaces({ players, status, live }: { players: Player[]; status: GigStatus; live?: LiveFeed }) {
  const [sheetHost, setSheetHost] = useState<Element | null>(null);
  const feed = status === "live" ? live : undefined;
  useTick(!!feed);
  if (players.length === 0) return null;

  const shown = feed ? livePlayers(players, feed.leader, feed.statuses(), feed.now()) : players;
  const me = players.find((p) => p.you)?.id ?? "";
  const opens = opensBandStatus(status, me, feed);
  if (!opens && sheetHost) setSheetHost(null);

  return (
    <>
      <div className="band-status-faces" role="group" aria-label="Band status">
        {statusRows(shown).map((row) => {
          const label = row.leader ? `${row.name}, leader` : row.name;
          return opens ? (
            <button key={row.id} type="button" className={faceClass(row, !!feed)} aria-label={label} onClick={(event) => setSheetHost(event.currentTarget.closest(".app") ?? document.body)}>
              {initials(row.name)}
            </button>
          ) : (
            <span key={row.id} className={faceClass(row, false)} role="img" aria-label={label}>
              {initials(row.name)}
            </span>
          );
        })}
      </div>
      {sheetHost ? createPortal(<BandStatusPanel players={shown} onClose={() => setSheetHost(null)} />, sheetHost) : null}
    </>
  );
}
