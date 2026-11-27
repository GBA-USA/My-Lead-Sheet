import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { BandStatusPanel, type LiveFeed } from "./band-status";
import { livePlayers, playersFrom, type Player } from "./band-status-model";
import type { BandView } from "./bands-model";
import { checkInOf, notReady, QUIET_AFTER_MS, type RosterRow } from "./gig-check-in-model";
import type { GigView } from "./gig-plan-model";
import { useEscape } from "./hooks";
import type { LOST_AFTER_MS } from "./links/attempt";
import type { RoomState } from "./links/server-link";
import { ApiError, api } from "./sign-in-methods";
import "./gig-check-in.css";

/** The Room's quiet limit is the phone's lost-link limit: one number, one meaning. This fails to compile if they part. */
const SAME_LIMIT: typeof LOST_AFTER_MS = QUIET_AFTER_MS;
void SAME_LIMIT;

const MESSAGES: Record<string, string> = {
  "not-allowed": "Only an admin can change the lineup once the gig is live.",
  "gig-ended": "That gig is over.",
  offline: "Can't reach the server. Check your connection and try again.",
};
const LIVE_LINE = MESSAGES["not-allowed"];
const SOMETHING_WRONG = "Something went wrong. Try again.";
const CANT_REACH_BAND = "Can't reach the band. These are the last statuses this phone heard.";
const notReadyWords = (count: number) => `${count} not ready`;

const message = (error: unknown) => {
  const reason = error instanceof ApiError ? (error.reason === "offline" || error.status >= 500 ? "offline" : error.reason) : "";
  return MESSAGES[reason] ?? SOMETHING_WRONG;
};

// ---- The leader's copy of the roster: kept in memory per account and gig, never stored ----------------------------

/** The last roster this phone heard for a gig, who led when it heard it, and whether its room line is up now. */
export type RosterCopy = { rows: RosterRow[]; packRev: number; at: number; leader: string | null; line: RoomState };

const copies = new Map<string, RosterCopy>();
const copyListeners = new Set<() => void>();
const copyKey = (me: string, gigId: string) => `${me}/${gigId}`;
const tellCopies = () => copyListeners.forEach((listener) => listener());
const onCopies = (listener: () => void) => {
  copyListeners.add(listener);
  return () => void copyListeners.delete(listener);
};

export const rosterStore = {
  put(me: string, gigId: string, copy: Omit<RosterCopy, "at" | "line">) {
    copies.set(copyKey(me, gigId), { ...copy, at: Date.now(), line: "open" });
    tellCopies();
  },
  /** The room line went down or came back. A copy is kept and marked old, never thrown away, so no one turns Not connected for it. */
  line(me: string, gigId: string, line: RoomState) {
    const copy = copies.get(copyKey(me, gigId));
    if (!copy || copy.line === line) return;
    copies.set(copyKey(me, gigId), { ...copy, line });
    tellCopies();
  },
  leader(me: string, gigId: string, leader: string | null) {
    const copy = copies.get(copyKey(me, gigId));
    if (!copy || copy.leader === leader) return;
    copies.set(copyKey(me, gigId), { ...copy, leader });
    tellCopies();
  },
  drop(me: string, gigId: string) {
    if (copies.delete(copyKey(me, gigId))) tellCopies();
  },
};

export function useRosterCopy(me: string | null, gigId: string | null): RosterCopy | null {
  const read = () => (me && gigId ? (copies.get(copyKey(me, gigId)) ?? null) : null);
  return useSyncExternalStore(onCopies, read, read);
}

/**
 * Each player with their check-in from the copy, and Downloaded read from the same row, so a player who fetched tonight's
 * pack after this screen read the gig does not read Connected beside Not yet. A player the copy has no row for is left
 * as C23 draws them.
 */
export function withCheckIn(players: readonly Player[], copy: RosterCopy | null): Player[] {
  if (!copy) return [...players];
  const rows = new Map(copy.rows.map((row) => [row.userId, row]));
  return players.map((p) => {
    const row = rows.get(p.id);
    return row ? { ...p, checkIn: checkInOf(row, copy.packRev), downloaded: row.packRev === copy.packRev } : p;
  });
}

const NO_STATUSES: never[] = [];
/** The feed Band status reads on a live gig: who leads, and no timing figures yet. */
export const feedOf = (copy: RosterCopy, plannedLeader: string): LiveFeed => ({ leader: copy.leader ?? plannedLeader, statuses: () => NO_STATUSES, now: Date.now });

/** The line Band status shows while the copy is old. */
export const staleNote = (copy: RosterCopy | null) => (copy && copy.line !== "open" ? CANT_REACH_BAND : null);

// ---- The warning on the leader's strip -----------------------------------------------------------------------------

/** Warnings dismissed for tonight, by account and gig. In memory only: a new day or a reload brings it back. */
const dismissed = new Set<string>();

type WarningProps = { me: string; bandId: string; gigId: string };

/**
 * While anyone on the lineup is not connected and synced, the leader's strip says how many, with the roster one tap
 * away. It clears by itself when everyone is ready. Dismissed, it stays down for this gig on this phone and account.
 */
export function CheckInWarning({ me, bandId, gigId }: WarningProps) {
  const copy = useRosterCopy(me, gigId);
  const [, setGone] = useState(false);
  const [sheetHost, setSheetHost] = useState<Element | null>(null);
  const [named, setNamed] = useState<{ view: GigView; band: BandView } | null>(null);
  const leading = copy !== null && copy.leader === me;
  const count = copy ? notReady(copy.rows, copy.packRev, me) : 0;
  const key = copyKey(me, gigId);

  useEffect(() => {
    if (!leading) return;
    let live = true;
    Promise.all([api<GigView>("/api/bands/gig/open", { bandId, gigId }), api<BandView>("/api/bands/open", { bandId })]).then(
      ([view, band]) => live && setNamed({ view, band }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [leading, bandId, gigId, copy?.packRev, copy?.rows.length]);

  const players = copy && named ? livePlayers(withCheckIn(playersFrom(named.view, named.band, me), copy), me, NO_STATUSES, Date.now()) : null;
  const panel = sheetHost && players ? createPortal(<BandStatusPanel players={players} note={staleNote(copy)} onClose={() => setSheetHost(null)} />, sheetHost) : null;
  if (!leading || count === 0 || dismissed.has(key)) return panel;

  return (
    <>
      <div className="check-in-warning" role="status">
        <span className="check-in-count">{notReadyWords(count)}</span>
        {players ? (
          <button type="button" className="check-in-see" onClick={(event) => setSheetHost(event.currentTarget.closest(".app") ?? document.body)}>
            See who
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn check-in-dismiss"
          aria-label="Dismiss for tonight"
          onClick={() => {
            dismissed.add(key);
            setGone(true);
          }}
        >
          ✕
        </button>
      </div>
      {panel}
    </>
  );
}

// ---- Tonight's players ---------------------------------------------------------------------------------------------

type TonightProps = { me: string; band: BandView; view: GigView; status: GigView["gig"]["status"]; onSaved(view: GigView): void };

/** Who may open Tonight's players: the leader and the band's admins, until the gig ends. The server decides who may save. */
export const opensTonight = (me: string, band: BandView, view: GigView, status: GigView["gig"]["status"]) => status !== "ended" && (band.role === "admin" || view.gig.leader === me);

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** The button on the gig's screen and its sheet. */
export function TonightsPlayers(props: TonightProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="account-secondary tonight-open" onClick={() => setOpen(true)}>
        Tonight's players
      </button>
      {open ? <TonightSheet {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * Every current band member, the lineup ticked, the leader's own row fixed. Save sends the lineup only when the ticks
 * differ from the gig's, once, so a retry or a re-tick sends nothing new. Once the gig is live only an admin may change
 * it, so the leader reads the list with the line that says so. A failed save keeps the sheet open, says why and goes back
 * to the stored lineup.
 */
function TonightSheet({ me, band, view, status, onSaved, onClose }: TonightProps & { onClose(): void }) {
  const titleId = useId();
  useEscape(onClose);
  const [stored, setStored] = useState(view.gig.lineup);
  const [ticks, setTicks] = useState<string[]>(view.gig.lineup);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const fixed = view.gig.leader;
  const changes = band.role === "admin" || (view.gig.leader === me && status === "planned");
  const members = band.members;

  const toggle = (userId: string) => setTicks((now) => (now.includes(userId) ? now.filter((id) => id !== userId) : [...now, userId]));

  const save = async () => {
    if (saving.current) return;
    const lineup = [...stored.filter((id) => ticks.includes(id)), ...members.map((member) => member.userId).filter((id) => ticks.includes(id) && !stored.includes(id))];
    if (!lineup.includes(fixed)) lineup.unshift(fixed);
    if (sameSet(lineup, stored)) return onClose();
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await api<GigView>("/api/bands/gig/lineup", { bandId: view.gig.bandId, gigId: view.gig.gigId, lineup });
      onSaved(saved);
      onClose();
    } catch (caught) {
      setError(message(caught));
      const again = await api<GigView>("/api/bands/gig/open", { bandId: view.gig.bandId, gigId: view.gig.gigId }).catch(() => null);
      const back = again?.gig.lineup ?? stored;
      setStored(back);
      setTicks(back);
      if (again) onSaved(again);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="bottom-backdrop" onClick={onClose}>
      <section className="bottom-sheet tonight-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className="bottom-sheet-top">
          <h2 id={titleId}>Tonight's players</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        {changes ? null : <p className="account-note tonight-line">{LIVE_LINE}</p>}
        <ul className="tonight-rows">
          {members.map((member) => {
            const on = ticks.includes(member.userId);
            if (member.userId === fixed || !changes) {
              const playing = member.userId === fixed || stored.includes(member.userId);
              const label = `${member.name}, ${member.userId === fixed ? "leading tonight" : playing ? "playing tonight" : "not playing tonight"}`;
              return (
                <li key={member.userId} className={`tonight-row ${member.userId === fixed ? "is-fixed" : "is-read"}`} aria-label={label}>
                  <span className={`tonight-mark ${playing ? "is-on" : ""}`} aria-hidden="true">
                    {playing ? "✓" : ""}
                  </span>
                  <span className="tonight-name">{member.name}</span>
                  {member.userId === fixed ? <span className="tonight-tag">Leader</span> : null}
                </li>
              );
            }
            return (
              <li key={member.userId} className="tonight-row">
                <label className="tonight-pick">
                  <input type="checkbox" checked={on} onChange={() => toggle(member.userId)} />
                  <span className="tonight-name">{member.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
        {error ? (
          <p className="account-note tonight-error" role="alert">
            {error}
          </p>
        ) : null}
        {changes ? (
          <button type="button" className="account-primary tonight-save" aria-busy={busy} onClick={save}>
            Save
          </button>
        ) : null}
      </section>
    </div>
  );
}
