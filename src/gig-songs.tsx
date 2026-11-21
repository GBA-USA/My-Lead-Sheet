import { useState } from "react";
import { titleOf } from "./band-library";
import type { BandSong } from "./band-library-model";
import { candidates, reorder, type GigView } from "./gig-plan-model";
import { api, ApiError } from "./sign-in-methods";

export const SET_LOCKED = "Set is locked once the gig starts.";

const MESSAGES: Record<string, string> = {
  offline: "Can't reach the server. Check your connection and try again.",
  "signed-out": "You're signed out. Sign in again to save the set.",
  "set-locked": SET_LOCKED,
  "gig-ended": "That gig is over.",
  "not-allowed": "Only a band admin can change the set.",
  "not-a-member": "You're not in this band any more.",
  "not-found": "That gig isn't in the band any more.",
  "not-a-band-song": "A song here has left the band. Remove it and save again.",
};

const wordsFor = (error: unknown) => {
  const reason = error instanceof ApiError ? (error.status >= 500 ? "offline" : error.reason) : "";
  return MESSAGES[reason] ?? "Something went wrong. Try again.";
};

/**
 * Edit songs on a planned gig's card: Move up, Move down, Remove, and the band songs not yet in the set to add. Save sets
 * the gig's own order and never the setlist's. A failed Save keeps the edited list here for another try; saving the same
 * list twice changes nothing on the server.
 */
export function GigSongs({ view, songs, onSaved, onCancel }: { view: GigView; songs: BandSong[]; onSaved: (view: GigView) => void; onCancel: () => void }) {
  const [songIds, setSongIds] = useState(view.songIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const byId = new Map(songs.map((item) => [item.songId, item]));
  const addable = candidates(songs, songIds);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      onSaved(await api<GigView>("/api/bands/gig/songs", { bandId: view.gig.bandId, gigId: view.gig.gigId, songIds }));
    } catch (caught) {
      setError(wordsFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="account-form gig-songs"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <ol className="friends-list">
        {songIds.map((id, index) => (
          <li key={id}>
            <span>{titleOf(byId.get(id))}</span>
            <span className="friends-actions">
              <button type="button" className="account-link" disabled={index === 0} onClick={() => setSongIds(reorder(songIds, index, index - 1))}>
                Move up
              </button>
              <button type="button" className="account-link" disabled={index === songIds.length - 1} onClick={() => setSongIds(reorder(songIds, index, index + 1))}>
                Move down
              </button>
              <button type="button" className="account-link" onClick={() => setSongIds(songIds.filter((other) => other !== id))}>
                Remove
              </button>
            </span>
          </li>
        ))}
      </ol>
      {addable.length > 0 ? (
        <select className="account-input" aria-label="Add a band song" value="" onChange={(event) => setSongIds([...songIds, event.target.value])}>
          <option value="">Add a band song…</option>
          {addable.map((item) => (
            <option key={item.songId} value={item.songId}>
              {item.song.title}
            </option>
          ))}
        </select>
      ) : null}
      <p className="account-note">To add one of your own songs, share it with the band from the Songs tab first.</p>
      {songIds.length === 0 ? <p className="account-note">Keep at least one song in the set.</p> : null}
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="account-row">
        <button type="submit" className="account-primary" disabled={busy || songIds.length === 0}>
          Save
        </button>
        <button type="button" className="account-link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
