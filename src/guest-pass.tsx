import { useEffect, useId, useState } from "react";
import { CODE_REFUSED } from "./code-link";
import { shareLink } from "./codes";
import type { GigPlan } from "./gig-plan-model";
import { useEscape } from "./hooks";
import { toBase64Url } from "./password";
import { qrSvg } from "./qr-svg";
import { gigHref } from "./route";
import { ApiError, api } from "./sign-in-methods";

/**
 * Guest passes (PLAN.md 7.14): the admin's Guests panel on a gig card, and the sheet a fill-in player lands on from a
 * pass link. Every limit on a guest is the Worker's (worker/room-guest.ts); these screens only say what it answered.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The pass screen says plainly what a pass can't do. */
export const SCREENSHOT_LINE = "A pass ends on the band's terms, but a phone that never opens the app again keeps its copy, and nothing can stop a screenshot.";

/** A pass as the Worker lists it, the shape `GuestPassView` in worker/room-guest.ts. */
type GuestPass = {
  passId: string;
  gigId: string;
  name: string;
  expiresAt: number;
  revoked: boolean;
  claimedBy: string | null;
  claimedName: string | null;
  canSeeChat: boolean;
  canSeeSetlists: boolean;
};
type MadePass = { pass: GuestPass; code: string; link: string; expiresAt: number };
type PassOpening = { bandId: string; gigId: string; gigName: string; bandName: string; expiresAt: number };
/** What a guest's passes open beyond their gig, the shape `GuestOpens` in worker/room-guest.ts. `gig/open` sends it to a guest only. */
export type GuestOpens = { canSeeChat: boolean; canSeeSetlists: boolean };

export type PassLength = { length: "tonight" } | { length: "week" } | { length: "date"; date: string };

/** 6 AM on the morning after a `YYYY-MM-DD` day, on this phone's clock. */
function morningAfter(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date + 1, 6, 0).getTime();
}

/** When a pass of this length ends: Tonight only at 6 AM after the gig, One week seven days on but never before that, a picked date at 6 AM after it. */
export function passEnds(choice: PassLength, gigDate: string, now: number): number {
  const tonight = morningAfter(gigDate);
  if (choice.length === "tonight") return tonight;
  if (choice.length === "week") return Math.max(now + 7 * DAY_MS, tonight);
  return morningAfter(choice.date);
}

const endLine = (ms: number) => `Ends ${new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
const newPassId = () => `pass_${toBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`;

const OFFLINE = "Can't reach the server. Check your connection and try again.";
const MESSAGES: Record<string, string> = {
  "pass-claimed": "This pass belongs to another account. Ask the band for a new one.",
  "in-band": "You're in this band already, so this pass is for someone else. Open the gig from your band.",
  "pass-revoked": "This pass was ended by the band. Ask the band for a new one.",
  "code-stopped": "This pass was ended by the band. Ask the band for a new one.",
  "pass-ended": "This pass has ended. Ask the band for a new one.",
  "code-ended": "This pass has ended. Ask the band for a new one.",
  "bad-code": CODE_REFUSED["bad-code"],
  "code-replaced": CODE_REFUSED["code-replaced"],
  "not-a-guest-code": "That isn't a guest pass.",
  "not-found": "This pass isn't there any more. Ask the band for a new one.",
  "not-admin": "Only the band's admin makes guest passes.",
  "gig-ended": "That gig is over.",
  guest: "Your guest pass doesn't open that any more.",
};
export const unreachable = (error: unknown) => error instanceof ApiError && (error.reason === "offline" || error.status === 0 || error.status >= 500);
/** The words a guest or the admin sees for what the server answered about a pass. */
export const words = (error: unknown) => (unreachable(error) ? OFFLINE : (error instanceof ApiError && MESSAGES[error.reason]) || "Something went wrong. Try again.");

/**
 * The sheet a pass link opens on, once signed in: "Join Friday at the Elks as a guest", then the gig card. Joining binds
 * the pass to this account for good, so it asks once. A pass that ended or was ended says so, with nothing of the gig.
 */
export function GuestPassSheet({ code, onSignedOut, onClose }: { code: string; onSignedOut: () => void; onClose: () => void }) {
  useEscape(onClose);
  const titleId = useId();
  const [opening, setOpening] = useState<PassOpening | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);

  const failed = (error: unknown) => (error instanceof ApiError && error.status === 401 ? onSignedOut() : setProblem(error));

  useEffect(() => {
    let live = true;
    setProblem(null);
    api<PassOpening>("/api/guest/open", { code }).then(
      (found) => live && setOpening(found),
      (error) => live && failed(error),
    );
    return () => {
      live = false;
    };
  }, [code, round]);

  const join = () => {
    setBusy(true);
    api<PassOpening>("/api/guest/claim", { code })
      .then((joined) => {
        onClose();
        window.location.hash = gigHref(joined.bandId, joined.gigId);
      }, failed)
      .finally(() => setBusy(false));
  };

  return (
    <div className="account-backdrop" onClick={onClose}>
      <section className="account-sheet guest-pass-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className="account-top">
          <h2 id={titleId}>Guest pass</h2>
          <button type="button" className="account-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        {problem ? (
          <>
            <p className="account-error" role="alert">
              {words(problem)}
            </p>
            {unreachable(problem) ? (
              <button type="button" className="account-secondary" onClick={() => setRound((n) => n + 1)}>
                Try again
              </button>
            ) : null}
          </>
        ) : opening ? (
          <div className="account-form">
            <p className="account-field">
              Join {opening.gigName} as a guest
            </p>
            <p className="account-note">
              {opening.bandName} · {endLine(opening.expiresAt)}
            </p>
            <p className="account-note">You get tonight's songs on this phone and can follow the gig. When the pass ends they are deleted from this phone.</p>
            <button type="button" className="account-primary" disabled={busy} onClick={join}>
              Join as a guest
            </button>
          </div>
        ) : (
          <p className="account-note">Opening the pass…</p>
        )}
        <button type="button" className="account-link" onClick={onClose}>
          Not now
        </button>
      </section>
    </div>
  );
}

/** The pass just made: its QR code for the guest to scan, and the link to send. */
function PassCode({ made, gig, onDone }: { made: MadePass; gig: GigPlan; onDone: () => void }) {
  const title = `Guest pass for ${gig.name}`;
  return (
    <div className="account-form guest-pass-code">
      <div className="codes-qr" role="img" aria-label={title} dangerouslySetInnerHTML={{ __html: qrSvg(made.link) }} />
      <p className="codes-words">{title}</p>
      <p className="account-note">{endLine(made.expiresAt)}</p>
      <p className="codes-link">{made.link}</p>
      <button type="button" className="account-primary" onClick={() => shareLink(made.link, title)}>
        Share link
      </button>
      <p className="account-note">{SCREENSHOT_LINE}</p>
      <button type="button" className="account-link" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

/**
 * + Guest pass: an optional name, how long (Tonight only, One week, Pick a date), the two switches, both off, then Show
 * my code. The pass id is made here once, so a retry after a lost reply hands back the same pass and code.
 */
function PassForm({ bandId, gig, onMade, onCancel }: { bandId: string; gig: GigPlan; onMade: (made: MadePass) => void; onCancel: () => void }) {
  const formId = useId();
  const [passId] = useState(newPassId);
  const [name, setName] = useState("");
  const [length, setLength] = useState<PassLength["length"]>("tonight");
  const [date, setDate] = useState(gig.date);
  const [canSeeChat, setCanSeeChat] = useState(false);
  const [canSeeSetlists, setCanSeeSetlists] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choice: PassLength = length === "date" ? { length, date } : { length };
  const ends = passEnds(choice, gig.date, Date.now());

  const make = () => {
    setBusy(true);
    setError("");
    api<MadePass>("/api/bands/guests/create", { bandId, gigId: gig.gigId, passId, name: name.trim(), expiresAt: ends, canSeeChat, canSeeSetlists })
      .then(onMade, (caught) => setError(words(caught)))
      .finally(() => setBusy(false));
  };

  const lengths: [PassLength["length"], string][] = [
    ["tonight", "Tonight only"],
    ["week", "One week"],
    ["date", "Pick a date"],
  ];
  return (
    <div className="account-form guest-pass-form">
      <label className="account-field" htmlFor={`${formId}-name`}>
        Name (optional)
      </label>
      <input id={`${formId}-name`} className="account-input" maxLength={40} placeholder="Jo on keys" value={name} onChange={(event) => setName(event.target.value)} />
      <div role="radiogroup" aria-label="How long">
        {lengths.map(([value, label]) => (
          <label key={value}>
            <input type="radio" name={`${formId}-length`} checked={length === value} onChange={() => setLength(value)} />
            {label}
          </label>
        ))}
      </div>
      {length === "date" ? <input type="date" className="account-input" aria-label="Last day" value={date} min={new Date().toLocaleDateString("en-CA")} onChange={(event) => setDate(event.target.value)} /> : null}
      <p className="account-note">{ends > Date.now() ? endLine(ends) : "Pick a day from today on."}</p>
      <label>
        <input type="checkbox" role="switch" checked={canSeeChat} onChange={() => setCanSeeChat((on) => !on)} />
        Can see band chat
      </label>
      <label>
        <input type="checkbox" role="switch" checked={canSeeSetlists} onChange={() => setCanSeeSetlists((on) => !on)} />
        Can see other setlists
      </label>
      <p className="account-note">A guest needs an account, made in one or two taps. The pass works for the first account that opens it.</p>
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" className="account-primary" disabled={busy || ends <= Date.now()} onClick={make}>
        Show my code
      </button>
      <button type="button" className="account-link" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** Guests, on a gig card for the admin: each pass with its end, who holds it and Revoke, and + Guest pass. A pass just made shows its code above the list. */
export function GuestPasses({ bandId, gig }: { bandId: string; gig: GigPlan }) {
  const [passes, setPasses] = useState<GuestPass[] | null>(null);
  const [view, setView] = useState<"list" | "form" | MadePass>("list");
  const [error, setError] = useState("");
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    api<{ passes: GuestPass[] }>("/api/bands/guests/list", { bandId, gigId: gig.gigId }).then(
      (reply) => live && (setPasses(reply.passes), setError("")),
      (caught) => live && setError(words(caught)),
    );
    return () => {
      live = false;
    };
  }, [bandId, gig.gigId, round]);

  const revoke = (passId: string) =>
    api("/api/bands/guests/revoke", { bandId, passId }).then(
      () => setRound((n) => n + 1),
      (caught) => setError(words(caught)),
    );

  if (view === "form") return <PassForm bandId={bandId} gig={gig} onMade={(made) => (setView(made), setRound((n) => n + 1))} onCancel={() => setView("list")} />;
  return (
    <div className="guest-passes">
      {typeof view === "object" ? <PassCode made={view} gig={gig} onDone={() => setView("list")} /> : null}
      <h4 className="account-field">Guests</h4>
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
      {passes && passes.length === 0 ? <p className="account-note">No guest passes yet. A guest pass lets a fill-in player follow this gig.</p> : null}
      {passes && passes.length > 0 ? (
        <ul className="friends-list">
          {passes.map((pass) => (
            <li key={pass.passId}>
              <span>
                {pass.name || "Guest pass"} <small>{pass.revoked ? "Ended by the band" : endLine(pass.expiresAt)}</small>
              </span>
              <small>{pass.claimedName ? `Held by ${pass.claimedName}` : "Not opened yet"}</small>
              {pass.revoked ? null : (
                <button type="button" className="account-secondary" onClick={() => revoke(pass.passId)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" className="account-secondary" onClick={() => setView("form")}>
        + Guest pass
      </button>
      <p className="account-note">{SCREENSHOT_LINE}</p>
    </div>
  );
}
