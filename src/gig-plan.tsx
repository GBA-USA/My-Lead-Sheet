import { Fragment, useEffect, useId, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import { plural, titleOf } from "./band-library";
import type { BandLibrary } from "./band-library-model";
import { bandSong } from "./band-setlist-view";
import type { BandView } from "./bands-model";
import type { GigPack, GigPackSong } from "./gig-pack";
import {
  againDraft,
  DETAIL_LIMITS,
  downloaded,
  draftChanged,
  draftProblem,
  draftReducer,
  gigDraftKey,
  GIG_DRAFT_KEY,
  gigLine,
  keptDraftOf,
  KIND_WORDS,
  newDraft,
  type DetailField,
  type GigDraft,
  type GigKind,
  type GigPlan,
  type GigView,
  type KeptDraft,
} from "./gig-plan-model";
import { useMetronome } from "./metronome-view";
import { toBase64Url } from "./password";
import { bandPlanHref } from "./route";
import { CHOICE_WORDS, type RouteChoice } from "./routes";
import { LeadSheet } from "./sheet";
import { TEXT_SCALES, loadTextScaleIndex, readRaw, removeRaw, writeRaw } from "./storage";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A gig id made on the phone, so pressing Send to band again after a lost reply finds the gig already made. */
export const newGigId = () => `gig_${toBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`;

const dayOf = (date: string) => new Date(`${date}T00:00:00`);
const daysUntil = (date: string) => Math.round((dayOf(date).getTime() - new Date().setHours(0, 0, 0, 0)) / DAY_MS);
export const shownDate = (date: string) => dayOf(date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/** Keeps an unsent plan on this phone for this account, or drops it. A refused write leaves the form as it is. */
export const keepDraft = (owner: string, kept: KeptDraft) => writeRaw(gigDraftKey(owner, kept.gigId), JSON.stringify(kept));
export const dropDraft = (owner: string, gigId: string) => removeRaw(gigDraftKey(owner, gigId));
export const readDraft = (owner: string, gigId: string) => keptDraftOf(readRaw(gigDraftKey(owner, gigId)));

/** This account's unsent plans for one band, newest first. */
export function draftsIn(owner: string, bandId: string): KeptDraft[] {
  let keys: string[];
  try {
    keys = Object.keys(localStorage).filter((key) => key.startsWith(`${GIG_DRAFT_KEY}.${owner}.`));
  } catch {
    return [];
  }
  return keys
    .map((key) => keptDraftOf(readRaw(key)))
    .filter((kept): kept is KeptDraft => kept !== null && kept.bandId === bandId)
    .sort((a, b) => b.savedAt - a.savedAt);
}

/** Plan again: the past gig's plan kept as the draft of a new gig, and the Plan gig route that opens it. */
export function planAgainHref(owner: string, past: GigPlan): string {
  const gigId = newGigId();
  keepDraft(owner, { bandId: past.bandId, gigId, setlistId: past.setlistId, savedAt: Date.now(), draft: againDraft(past) });
  return bandPlanHref(past.bandId, gigId, past.setlistId);
}

/** Why the last Send to band did not go, shown beside the button. `reload` offers Reload, for a tab whose account changed. */
export type SendFailure = { words: string; reload: boolean };

const DETAIL_FIELDS: { field: DetailField; label: string; input: "time" | "text" | "notes"; placeholder?: string }[] = [
  { field: "startTime", label: "Start time", input: "time" },
  { field: "callTime", label: "Call time", input: "time" },
  { field: "venue", label: "Venue", input: "text", placeholder: "Elks Lodge" },
  { field: "address", label: "Address", input: "text", placeholder: "12 Main St, Springfield" },
  { field: "notes", label: "Notes", input: "notes", placeholder: "Load in by the side door." },
];

/**
 * Plan a gig or a rehearsal: Gig or Rehearsal, name and date, when and where, who's playing, the leader and backup, and
 * the admin's Connection for tonight. It starts from `start` and hands each change to `onDraft` with whether the form
 * differs from a new one, so the plan is kept on the phone. While it differs, reloading or closing the tab asks first.
 */
export function GigPlanForm({
  band,
  me,
  setlistName,
  start,
  busy,
  failure,
  onDraft,
  onSend,
  onCancel,
}: {
  band: BandView;
  me: string;
  setlistName: string;
  start: GigDraft;
  busy: boolean;
  failure: SendFailure | null;
  onDraft: (draft: GigDraft, changed: boolean) => void;
  onSend: (draft: GigDraft) => void;
  onCancel: () => void;
}) {
  const formId = useId();
  const nameId = `${formId}-name`;
  const dateId = `${formId}-date`;
  const leaderId = `${formId}-leader`;
  const backupId = `${formId}-backup`;
  const [draft, dispatch] = useReducer(draftReducer, start);
  const fresh = useMemo(() => newDraft(band.members.map((member) => member.userId), me), [band.members, me]);
  const changed = draftChanged(draft, fresh);
  const reloading = useRef(false);
  const nameOf = (userId: string) => band.members.find((member) => member.userId === userId)?.name ?? "";
  const problem = draftProblem(draft);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!problem) onSend(draft);
  };

  useEffect(() => {
    onDraft(draft, changed);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keep the plan on each change; onDraft is a new closure each render and changed follows draft
  }, [draft]);

  useEffect(() => {
    if (!changed) return;
    const warn = (event: Event) => {
      if (!reloading.current) event.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [changed]);

  /** Reload was asked for, and the plan is kept, so it goes without the browser asking. */
  const reload = () => {
    reloading.current = true;
    location.reload();
  };

  return (
    <form className="account-form gig-plan" onSubmit={submit}>
      <p className="account-note">From {setlistName}</p>
      <div className="gig-plan-kind" role="radiogroup" aria-label="Gig or rehearsal">
        {(Object.keys(KIND_WORDS) as GigKind[]).map((kind) => (
          <label key={kind}>
            <input type="radio" name="gig-kind" checked={draft.kind === kind} onChange={() => dispatch({ type: "kind", kind })} />
            {KIND_WORDS[kind]}
          </label>
        ))}
      </div>
      <label className="account-field" htmlFor={nameId}>
        Gig name
      </label>
      <input
        id={nameId}
        className="account-input"
        maxLength={60}
        placeholder={draft.kind === "rehearsal" ? "Thursday rehearsal" : "Friday at the Elks"}
        value={draft.name}
        onChange={(event) => dispatch({ type: "name", name: event.target.value })}
      />
      <label className="account-field" htmlFor={dateId}>
        Date
      </label>
      <input id={dateId} className="account-input" type="date" value={draft.date} onChange={(event) => dispatch({ type: "date", date: event.target.value })} />
      {DETAIL_FIELDS.map(({ field, label, input, placeholder }) => {
        const id = `${formId}-${field}`;
        const props = { id, className: "account-input", value: draft[field], placeholder, onChange: (event: { target: { value: string } }) => dispatch({ type: "detail", field, value: event.target.value }) };
        return (
          <Fragment key={field}>
            <label className="account-field" htmlFor={id}>
              {label}
            </label>
            {input === "notes" ? <textarea {...props} rows={3} maxLength={DETAIL_LIMITS.notes} /> : input === "time" ? <input {...props} type="time" /> : <input {...props} maxLength={DETAIL_LIMITS[field as "venue" | "address"]} />}
          </Fragment>
        );
      })}

      <h3 className="account-field">Who's playing tonight</h3>
      <ul className="friends-list gig-plan-lineup">
        {band.members.map((member) => (
          <li key={member.userId}>
            <label>
              <input type="checkbox" role="switch" checked={draft.lineup.includes(member.userId)} onChange={() => dispatch({ type: "toggleLineup", userId: member.userId })} />
              {member.name}
            </label>
          </li>
        ))}
      </ul>
      {draft.lineup.length === 1 && draft.lineup[0] === me ? <p className="account-note">You're the only one playing.</p> : null}

      <label className="account-field" htmlFor={leaderId}>
        Leader
      </label>
      <select id={leaderId} className="account-input" value={draft.leader ?? ""} onChange={(event) => dispatch({ type: "setLeader", userId: event.target.value })}>
        {draft.leader === null ? <option value="">Pick a leader</option> : null}
        {draft.lineup.map((userId) => (
          <option key={userId} value={userId}>
            {nameOf(userId)}
          </option>
        ))}
      </select>
      <label className="account-field" htmlFor={backupId}>
        Backup leader
      </label>
      <select id={backupId} className="account-input" value={draft.backup ?? ""} onChange={(event) => dispatch({ type: "setBackup", userId: event.target.value || null })}>
        <option value="">Nobody</option>
        {draft.lineup
          .filter((userId) => userId !== draft.leader)
          .map((userId) => (
            <option key={userId} value={userId}>
              {nameOf(userId)}
            </option>
          ))}
      </select>
      <p className="account-note">{draft.backup === null ? "Only the admin can take over if your phone dies." : "Takes over if your phone dies."}</p>

      <fieldset className="gig-plan-route">
        <legend className="account-field">Connection for tonight</legend>
        {(Object.keys(CHOICE_WORDS) as RouteChoice[]).map((route) => (
          <label key={route}>
            <input type="radio" name="gig-route" checked={draft.route === route} onChange={() => dispatch({ type: "setRoute", route })} />
            {CHOICE_WORDS[route].name}
            <small>{CHOICE_WORDS[route].line}</small>
          </label>
        ))}
      </fieldset>

      {problem ? <p className="account-note">{problem}</p> : null}
      {failure ? (
        <p className="account-error" role="alert">
          {failure.words}
        </p>
      ) : null}
      {failure?.reload ? (
        <button type="button" className="account-secondary" onClick={reload}>
          Reload
        </button>
      ) : null}
      <button type="submit" className="account-primary" disabled={busy || problem !== null}>
        Send to band
      </button>
      <button type="button" className="account-link" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

/** Asks whether to go on with an unsent plan for this band before starting a new one. */
export function DraftOffer({ kept, setlistName, onKeep, onStartOver }: { kept: KeptDraft; setlistName: string; onKeep: () => void; onStartOver: () => void }) {
  return (
    <div className="account-form gig-plan">
      <p className="account-field">Keep editing your draft?</p>
      <p className="account-note">
        {kept.draft.name.trim() || `A ${KIND_WORDS[kept.draft.kind].toLowerCase()} with no name yet`} · from {setlistName}
      </p>
      <button type="button" className="account-primary" onClick={onKeep}>
        Keep editing
      </button>
      <button type="button" className="account-secondary" onClick={onStartOver}>
        Start over
      </button>
    </div>
  );
}

/**
 * The gig card on the band screen: who's playing with Downloaded ✓ or Not yet, and Get ready, which downloads the whole
 * pack. Tonight's songs open on the gig-mode sheet once the pack is on this phone; before that each song offers
 * Download, the same one pack call, for whoever may fetch it.
 */
export function GigCard({
  view,
  band,
  me,
  pack,
  library,
  busy,
  onGetReady,
  onSong,
}: {
  view: GigView;
  band: BandView;
  me: string;
  pack: GigPack | undefined;
  library: BandLibrary | null;
  busy: boolean;
  onGetReady: () => void;
  onSong: (index: number) => void;
}) {
  const { gig } = view;
  const playing = gig.lineup.includes(me);
  const days = daysUntil(gig.date);
  const nameOf = (userId: string) => band.members.find((member) => member.userId === userId)?.name ?? "Not in the band now";
  const role = (userId: string) => (userId === gig.leader ? " · Leading" : userId === gig.backup ? " · Backup" : "");
  const mayFetch = playing || band.role === "admin";
  const planned = library?.setlists.find((setlist) => setlist.setlistId === gig.setlistId)?.songIds ?? [];

  return (
    <section className="gig-card" data-gig={gig.gigId} aria-label={gig.name}>
      <h3>
        {gig.name} <small>{gigLine(gig)}</small>
      </h3>
      {gig.address ? <p className="account-note">{gig.address}</p> : null}
      {gig.notes ? <p className="gig-card-notes">{gig.notes}</p> : null}
      {playing && days >= 0 && days <= 1 ? <p className="account-note">Open the app once on Wi-Fi before you leave.</p> : null}
      <ul className="friends-list gig-card-lineup">
        {gig.lineup.map((userId) => (
          <li key={userId}>
            <span>
              {nameOf(userId)}
              {role(userId)}
            </span>
            <small>{downloaded(view, userId) ? "Downloaded ✓" : "Not yet"}</small>
          </li>
        ))}
      </ul>
      {mayFetch ? (
        <button type="button" className="account-primary" disabled={busy} onClick={onGetReady}>
          Get ready
        </button>
      ) : (
        <p className="account-note">You're not playing this one.</p>
      )}
      {pack ? (
        <ol className="gig-card-songs">
          {pack.songs.map((item, index) => (
            <li key={item.songId}>
              <button type="button" className="account-secondary" onClick={() => onSong(index)}>
                {item.song.title} <small>{item.song.artist}</small>
              </button>
            </li>
          ))}
        </ol>
      ) : mayFetch && planned.length > 0 ? (
        <ol className="gig-card-songs">
          {planned.map((songId) => (
            <li key={songId}>
              <span>{titleOf(library?.songs.find((song) => song.songId === songId))}</span>
              <button type="button" className="account-secondary" disabled={busy} onClick={onGetReady}>
                Download
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/** An ended gig in Past: its line, the set size and who played, and Plan again for an admin. */
export function PastGigCard({ view, band, onPlanAgain }: { view: GigView; band: BandView; onPlanAgain?: () => void }) {
  const { gig } = view;
  const nameOf = (userId: string) => band.members.find((member) => member.userId === userId)?.name ?? "Not in the band now";
  return (
    <section className="gig-card gig-card-past" data-gig={gig.gigId} aria-label={gig.name}>
      <h3>
        {gig.name} <small>{gigLine(gig)}</small>
      </h3>
      <p className="account-note">
        {plural(view.songCount, "song")} · {gig.lineup.map(nameOf).join(", ")}
      </p>
      {onPlanAgain ? (
        <button type="button" className="account-secondary" onClick={onPlanAgain}>
          Plan again
        </button>
      ) : null}
    </section>
  );
}

/** A band song read from this phone, opened from a search result, so it shows with no signal. The gig routes render through `src/App.tsx` instead. */
export function GigSong({ bandId, item, onBack }: { bandId: string; item: GigPackSong; onBack: () => void }) {
  const metronome = useMetronome(null, item.song.tempo);
  const [scale] = useState(() => TEXT_SCALES[loadTextScaleIndex()]);
  return (
    <>
      <button type="button" className="account-link" onClick={onBack}>
        Back
      </button>
      <LeadSheet song={bandSong(bandId, item.songId, item.song)} scale={scale} semitones={0} notation="notes" metronome={metronome} />
    </>
  );
}
