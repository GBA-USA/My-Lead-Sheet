import { useEffect, useState } from "react";
import type { BandLibrary } from "./band-library-model";
import { unreachable, words, type GuestOpens } from "./guest-pass";
import { Room } from "./room";
import { ApiError, api } from "./sign-in-methods";

/** The band's setlists, read-only, for a guest whose pass has "Can see other setlists" on. */
function GuestSetlists({ bandId, onSignedOut }: { bandId: string; onSignedOut: () => void }) {
  const [library, setLibrary] = useState<BandLibrary | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    setProblem(null);
    api<BandLibrary>("/api/bands/library", { bandId }).then(
      (found) => live && setLibrary(found),
      (error) => live && (error instanceof ApiError && error.status === 401 ? onSignedOut() : setProblem(error)),
    );
    return () => {
      live = false;
    };
  }, [bandId, round]);

  if (problem) {
    return (
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
    );
  }
  if (!library) return <p className="account-note">Opening the band's setlists…</p>;
  if (library.setlists.length === 0) return <p className="account-note">The band has no setlists yet.</p>;
  const titles = new Map(library.songs.map((item) => [item.songId, item.song.title]));
  return library.setlists.map((setlist) => (
    <section key={setlist.setlistId} className="gig-set">
      <h3>{setlist.name}</h3>
      <ol>
        {setlist.songIds.map((songId, index) => (
          <li key={`${songId}-${index}`}>
            <span className="gig-set-number">{index + 1}</span>
            <span>{titles.get(songId) ?? "A song the band took out"}</span>
          </li>
        ))}
      </ol>
    </section>
  ));
}

/**
 * On a guest's gig view, what their pass opens beyond tonight: Band chat and Band setlists, each only when the admin
 * switched it on. The Worker decides both (`guestOpens`); a guest isn't in the band, so neither shows anywhere else.
 */
export function GuestRooms({ me, bandId, opens, onSignedOut }: { me: string; bandId: string; opens: GuestOpens; onSignedOut: () => void }) {
  const [shown, setShown] = useState<"chat" | "setlists" | null>(null);
  const [gone, setGone] = useState<unknown>(null);
  if (!opens.canSeeChat && !opens.canSeeSetlists) return null;
  const toggle = (which: "chat" | "setlists") => setShown((open) => (open === which ? null : which));
  return (
    <section className="guest-rooms">
      <div className="account-row">
        {opens.canSeeChat ? (
          <button type="button" className="account-secondary" aria-expanded={shown === "chat"} onClick={() => toggle("chat")}>
            Band chat
          </button>
        ) : null}
        {opens.canSeeSetlists ? (
          <button type="button" className="account-secondary" aria-expanded={shown === "setlists"} onClick={() => toggle("setlists")}>
            Band setlists
          </button>
        ) : null}
      </div>
      {gone ? (
        <p className="account-error" role="alert">
          {words(gone)}
        </p>
      ) : null}
      {shown === "chat" ? (
        <Room inline guest me={me} roomId={bandId} entry={undefined} onEntry={() => {}} onGone={(error) => (setShown(null), setGone(error))} onSignedOut={onSignedOut} />
      ) : null}
      {shown === "setlists" ? <GuestSetlists bandId={bandId} onSignedOut={onSignedOut} /> : null}
    </section>
  );
}
