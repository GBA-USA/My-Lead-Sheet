import { useEffect, useState } from "react";
import { newMsgId } from "./chat-model";
import type { GigPack } from "./gig-pack";
import { useEscape } from "./hooks";
import type { Route } from "./route";
import { api, ApiError } from "./sign-in-methods";
import { NOTE_MAX_CHARS, visibleNotes, type NoteList, type SongNote } from "./song-notes-model";
import "./song-notes.css";

const MESSAGES: Record<string, string> = {
  offline: "Can't reach the server. Check your connection and try again.",
  "not-admin": "Only band admins can add or delete notes.",
  "not-a-member": "You're not in this band any more.",
  "not-found": "That song or note isn't in the band any more.",
  "bad-request": `A note needs words, up to ${NOTE_MAX_CHARS} characters.`,
  "signed-out": "Sign in again to change notes.",
};

const message = (error: unknown) => {
  const reason = error instanceof ApiError ? (error.status >= 500 ? "offline" : error.reason) : "";
  return MESSAGES[reason] ?? "Something went wrong. Try again.";
};

const dayOf = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

type Target = { bandId: string; songId: string; onStage: boolean };

/** The band song a route shows: the band song screen's, or the gig pack's song at the gig-mode sheet's index. */
function targetOf(route: Route, pack: GigPack | null | undefined): Target | null {
  if (route.name === "band-song") return { bandId: route.bandId, songId: route.songId, onStage: false };
  if (route.name !== "gig" || route.index === null || !pack || pack.songs.length === 0) return null;
  const song = pack.songs[Math.min(Math.max(route.index, 0), pack.songs.length - 1)];
  return { bandId: route.bandId, songId: song.songId, onStage: true };
}

/**
 * Band notes above a band song's chart, on the band song screen and in gig mode. Keyed by account and song, so another
 * account on the phone starts with nothing. Notes are never kept on the phone: with no signal, or for a song the band no
 * longer has, the strip is absent.
 */
export function BandSongNotes({ route, me, pack }: { route: Route; me: string | null; pack: GigPack | null | undefined }) {
  const target = targetOf(route, pack);
  if (!me || !target) return null;
  return <NotesStrip key={`${me}/${target.bandId}/${target.songId}`} {...target} />;
}

/** The Add a note form, while it is open. `noteId` is made when it opens, so Save again after a lost reply stores the note once. */
type Draft = { noteId: string; text: string };

function NotesStrip({ bandId, songId, onStage }: Target) {
  const [list, setList] = useState<NoteList | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api<NoteList>("/api/bands/notes/list", { bandId, songId }).then(
      (reply) => live && setList(reply),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [bandId, songId]);

  if (!list) return null;
  const canWrite = list.canWrite && !onStage;
  if (list.notes.length === 0 && !canWrite) return null;
  const { shown, more } = visibleNotes(list.notes, expanded);

  const run = async (call: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await call();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };
  const save = (open: Draft) =>
    run(async () => {
      const note = await api<SongNote>("/api/bands/notes/add", { bandId, songId, body: open.text, noteId: open.noteId });
      setList((current) => current && { ...current, notes: [note, ...current.notes.filter((each) => each.noteId !== note.noteId)] });
      setDraft(null);
    });
  const remove = (noteId: string) =>
    run(async () => {
      await api("/api/bands/notes/delete", { bandId, noteId });
      setList((current) => current && { ...current, notes: current.notes.filter((each) => each.noteId !== noteId) });
      setConfirming(null);
    });
  const cancel = () => {
    setDraft(null);
    setError("");
  };

  return (
    <section className={onStage ? "song-notes song-notes-stage" : "song-notes"} aria-label="Band notes">
      <div className="song-notes-top">
        <h2 className="song-notes-title">Band notes</h2>
        {canWrite && !draft ? (
          <button type="button" className="account-secondary" onClick={() => setDraft({ noteId: newMsgId(), text: "" })}>
            Add a note
          </button>
        ) : null}
      </div>
      {draft ? <NoteForm draft={draft} busy={busy} onText={(text) => setDraft({ ...draft, text })} onSave={() => save(draft)} onCancel={cancel} /> : null}
      {shown.length > 0 ? (
        <ul className="song-notes-list">
          {shown.map((note) => (
            <li key={note.noteId} className="song-note">
              <p className="song-note-body">{note.body}</p>
              <div className="song-note-foot">
                <small>
                  {note.authorName} · <time dateTime={new Date(note.createdAt).toISOString()}>{dayOf(note.createdAt)}</time>
                </small>
                {!canWrite ? null : confirming === note.noteId ? (
                  <span className="song-note-confirm">
                    <button type="button" className="account-secondary" disabled={busy} onClick={() => remove(note.noteId)}>
                      Yes, delete
                    </button>
                    <button type="button" className="account-link" disabled={busy} onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <button type="button" className="account-link" onClick={() => setConfirming(note.noteId)}>
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {more > 0 || (expanded && list.notes.length > 1) ? (
        <button type="button" className="account-link song-notes-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `${more} more`}
        </button>
      ) : null}
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function NoteForm({ draft, busy, onText, onSave, onCancel }: { draft: Draft; busy: boolean; onText: (text: string) => void; onSave: () => void; onCancel: () => void }) {
  useEscape(onCancel);
  return (
    <div className="song-notes-form">
      <textarea aria-label="Note for the band" maxLength={NOTE_MAX_CHARS} rows={3} value={draft.text} placeholder="A pointer or an assignment for the band" onChange={(event) => onText(event.target.value)} />
      <div className="song-notes-actions">
        <small className="account-note">
          {draft.text.length} / {NOTE_MAX_CHARS}
        </small>
        <button type="button" className="account-primary" disabled={busy || draft.text.trim().length === 0} onClick={onSave}>
          Save note
        </button>
        <button type="button" className="account-secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
