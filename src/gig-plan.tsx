import { useId, useReducer, useState, type FormEvent } from "react";
import { bandSongRef } from "./band-library-model";
import type { BandView } from "./bands-model";
import type { GigPack, GigPackSong } from "./gig-pack";
import { downloaded, draftProblem, draftReducer, newDraft, type GigDraft, type GigView } from "./gig-plan-model";
import { useMetronome } from "./metronome-view";
import { toBase64Url } from "./password";
import { CHOICE_WORDS, type RouteChoice } from "./routes";
import { LeadSheet } from "./sheet";
import { TEXT_SCALES, loadTextScaleIndex } from "./storage";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A gig id made on the phone, so pressing Send to band again after a lost reply finds the gig already made. */
export const newGigId = () => `gig_${toBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`;

const dayOf = (date: string) => new Date(`${date}T00:00:00`);
const daysUntil = (date: string) => Math.round((dayOf(date).getTime() - new Date().setHours(0, 0, 0, 0)) / DAY_MS);
const shownDate = (date: string) => dayOf(date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/** Plan a gig: name and date, who's playing, the leader and backup, and the admin's Connection for tonight. */
export function GigPlanForm({ band, me, setlistName, busy, onSend, onCancel }: { band: BandView; me: string; setlistName: string; busy: boolean; onSend: (draft: GigDraft) => void; onCancel: () => void }) {
  const nameId = useId();
  const dateId = useId();
  const leaderId = useId();
  const backupId = useId();
  const [draft, dispatch] = useReducer(draftReducer, undefined, () => newDraft(band.members.map((member) => member.userId), me));
  const nameOf = (userId: string) => band.members.find((member) => member.userId === userId)?.name ?? "";
  const problem = draftProblem(draft);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!problem) onSend(draft);
  };

  return (
    <form className="account-form gig-plan" onSubmit={submit}>
      <p className="account-note">From {setlistName}</p>
      <label className="account-field" htmlFor={nameId}>
        Gig name
      </label>
      <input id={nameId} className="account-input" maxLength={60} placeholder="Friday at the Elks" value={draft.name} onChange={(event) => dispatch({ type: "name", name: event.target.value })} />
      <label className="account-field" htmlFor={dateId}>
        Date
      </label>
      <input id={dateId} className="account-input" type="date" value={draft.date} onChange={(event) => dispatch({ type: "date", date: event.target.value })} />

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
      <button type="submit" className="account-primary" disabled={busy || problem !== null}>
        Send to band
      </button>
      <button type="button" className="account-link" onClick={onCancel}>
        Back
      </button>
    </form>
  );
}

/** The gig card on the band screen: who's playing with Downloaded ✓ or Not yet, Get ready, and tonight's songs once the pack is on this phone. */
export function GigCard({
  view,
  band,
  me,
  pack,
  busy,
  onGetReady,
  onSong,
}: {
  view: GigView;
  band: BandView;
  me: string;
  pack: GigPack | undefined;
  busy: boolean;
  onGetReady: () => void;
  onSong: (index: number) => void;
}) {
  const { gig } = view;
  const playing = gig.lineup.includes(me);
  const days = daysUntil(gig.date);
  const nameOf = (userId: string) => band.members.find((member) => member.userId === userId)?.name ?? "Not in the band now";
  const role = (userId: string) => (userId === gig.leader ? " · Leading" : userId === gig.backup ? " · Backup" : "");

  return (
    <section className="gig-card" data-gig={gig.gigId} aria-label={gig.name}>
      <h3>
        {gig.name} <small>{shownDate(gig.date)}</small>
      </h3>
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
      {playing || band.role === "admin" ? (
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
      ) : null}
    </section>
  );
}

/** One song of the pack, read from this phone, so it opens with no signal. */
export function GigSong({ bandId, item, onBack }: { bandId: string; item: GigPackSong; onBack: () => void }) {
  const metronome = useMetronome(null, item.song.tempo);
  const [scale] = useState(() => TEXT_SCALES[loadTextScaleIndex()]);
  return (
    <>
      <button type="button" className="account-link" onClick={onBack}>
        Back
      </button>
      <LeadSheet song={{ ...item.song, ref: bandSongRef(bandId, item.songId), id: 0 }} scale={scale} semitones={0} notation="notes" metronome={metronome} />
    </>
  );
}
