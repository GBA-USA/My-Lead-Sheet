import { useEffect, useId, useState, type ReactNode } from "react";
import { CHOICES, content } from "./band-library";
import type { BandSetlist } from "./band-library-model";
import type { ChatMessage } from "./chat-model";
import { CODE_REFUSED } from "./code-link";
import { ShowCode } from "./codes";
import { useEscape, useStored } from "./hooks";
import { MAX_CODE_SONGS, setlistCardIn, type CodeOffer, type SetlistCard as Card, type SetlistCopy } from "./setlist-code-model";
import type { ShareChoice } from "./share-rule";
import { ApiError, api } from "./sign-in-methods";
import { addOwnSetlist, addOwnSong, loadLibrary, songByRef } from "./storage";
import type { Setlist, SongRef } from "./types";
import "./friends.css";
import "./band-library.css";

export const SETLIST_CODE_MESSAGES: Record<string, string> = {
  ...CODE_REFUSED,
  offline: "Can't reach the server. Check your connection and try again.",
  "signed-out": "Sign in again to share setlists.",
  "not-in-band": "This setlist belongs to a band you're not in.",
  "not-a-setlist-code": "That isn't a setlist code.",
  "not-friends": "You can get a setlist copy only from a friend or a bandmate. Add them as a friend first.",
  yourself: "This is the code for your own setlist.",
  private_copy: "This was shared with you privately, so it can't be passed on.",
  private_ancestor: "This was shared with you privately, so it can't be passed on.",
  not_found: "This copy belongs to another account on this phone.",
  not_yours: "This copy belongs to another account on this phone.",
  "not-found": "This copy belongs to another account on this phone.",
  lineage_broken: "The server can't tell where this copy came from, so it can't be passed on.",
  choice_required: "Pick Private or Public first.",
  "too-large": "That is too much for one code. Tick fewer songs.",
};

export const setlistCodeMessage = (error: unknown) => {
  const reason = error instanceof ApiError ? (error.status >= 500 ? "offline" : error.reason) : "";
  return SETLIST_CODE_MESSAGES[reason] ?? "Something went wrong. Try again.";
};

const signedOut = (error: unknown) => error instanceof ApiError && error.status === 401;

/** Show code on a setlist row, or the note that an empty setlist needs a song first. */
export function CodeOfferButton({ offer, busy, onShow }: { offer: CodeOffer; busy?: boolean; onShow: () => void }) {
  if (offer === "none") return null;
  if (offer === "add-a-song") return <small className="setlist-code-empty">Add a song first</small>;
  return (
    <button type="button" className="account-secondary setlist-code-show" disabled={busy} onClick={onShow}>
      Show code
    </button>
  );
}

/** Show my code for a band setlist. It opens only for the band's members, which the server checks each time. */
export function BandSetlistCode({ bandId, bandName, setlist, onBack, onError }: { bandId: string; bandName: string; setlist: BandSetlist; onBack: () => void; onError: (error: unknown) => void }) {
  return (
    <>
      <ShowCode
        request={{ kind: "band-setlist", bandId, setlistId: setlist.setlistId }}
        words={`${setlist.name} · ${bandName}`}
        share
        onStopped={onBack}
        onError={onError}
      />
      <p className="account-note">Only members of {bandName} can open it.</p>
      <button type="button" className="account-link" onClick={onBack}>
        Back
      </button>
    </>
  );
}

function Sheet({ title, className, onClose, children }: { title: string; className: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  useEscape(onClose);
  return (
    <div className="account-backdrop" onClick={onClose}>
      <section className={`account-sheet ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className="account-top">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="account-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

/**
 * Show code for one of my setlists: tick the songs the friend gets, pick Private or Public, then the QR code. Every
 * song starts ticked except a Private copy, which can't be passed on. A refused or offline code goes back to the
 * ticks with the reason, so no QR from an earlier try stays on screen.
 */
export function MySetlistCodeSheet({ setlist, onSignedOut, onClose }: { setlist: Setlist; onSignedOut: () => void; onClose: () => void }) {
  const [songs] = useState(() => {
    const stored = loadLibrary().songs;
    return setlist.songRefs.flatMap((ref) => songByRef(stored, ref) ?? []);
  });
  const sendable = (ref: SongRef) => songs.find((song) => song.ref === ref)?.copy?.canSendOn !== false;
  const [ticked, setTicked] = useState(() => new Set(songs.filter((song) => sendable(song.ref)).map((song) => song.ref)));
  const [choice, setChoice] = useState<ShareChoice | null>(null);
  const [showing, setShowing] = useState(false);
  const [error, setError] = useState("");
  const picked = songs.filter((song) => ticked.has(song.ref));

  const toggle = (ref: SongRef) =>
    setTicked((current) => {
      const next = new Set(current);
      if (!next.delete(ref)) next.add(ref);
      return next;
    });

  const failed = (caught: unknown) => {
    if (signedOut(caught)) {
      onClose();
      return onSignedOut();
    }
    setShowing(false);
    setError(setlistCodeMessage(caught));
  };

  return (
    <Sheet title={setlist.name} className="setlist-code-sheet" onClose={onClose}>
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
      {showing && choice ? (
        <ShowCode
          request={{ kind: "my-setlist", choice, name: setlist.name, songs: picked.map((song) => ({ song: content(song), copyId: song.copy?.id ?? null })), setlistCopyId: setlist.copy?.id ?? null }}
          words={`${setlist.name} · ${picked.length === 1 ? "1 song" : `${picked.length} songs`}`}
          share
          onStopped={() => setShowing(false)}
          onError={failed}
        />
      ) : (
        <>
          <p className="account-note">A friend who scans this gets a copy of the songs you tick.</p>
          <ul className="friends-list setlist-code-songs">
            {songs.map((song) => (
              <li key={song.ref}>
                <label>
                  <input type="checkbox" checked={ticked.has(song.ref)} disabled={!sendable(song.ref)} onChange={() => toggle(song.ref)} /> {song.title}
                  {sendable(song.ref) ? null : <small> Shared with you privately</small>}
                </label>
              </li>
            ))}
          </ul>
          <div className="band-library-choices">
            {(Object.keys(CHOICES) as ShareChoice[]).map((key) => (
              <div key={key}>
                <button type="button" className="band-library-choice" aria-pressed={choice === key} onClick={() => setChoice(key)}>
                  {CHOICES[key].label}
                </button>
                <small>{CHOICES[key].line}</small>
              </div>
            ))}
          </div>
          {picked.length > MAX_CODE_SONGS ? <p className="account-note">Tick {MAX_CODE_SONGS} songs or fewer for one code.</p> : null}
          <button
            type="button"
            className="account-primary"
            disabled={choice === null || picked.length === 0 || picked.length > MAX_CODE_SONGS}
            onClick={() => {
              setError("");
              setShowing(true);
            }}
          >
            Show code
          </button>
        </>
      )}
    </Sheet>
  );
}

/** A landed setlist copy code: the server puts the copy in the DM with its owner, and the DM opens on it. */
export function SetlistCopySheet({ code, onChat, onSignedOut, onClose }: { code: string; onChat: (roomId: string) => void; onSignedOut: () => void; onClose: () => void }) {
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ roomId: string }>("/api/chat/setlist-code", { code }).then(
      (reply) => onChat(reply.roomId),
      (caught) => {
        if (!signedOut(caught)) return setError(setlistCodeMessage(caught));
        onClose();
        onSignedOut();
      },
    );
  }, [code]);
  return (
    <Sheet title="Setlist copy" className="setlist-copy-sheet" onClose={onClose}>
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="account-note">Getting the setlist…</p>
      )}
      <button type="button" className="account-link" onClick={onClose}>
        Close
      </button>
    </Sheet>
  );
}

/** Keeps a setlist copy in My Songs and Setlists. A song or setlist already kept under its copy id is not kept twice. */
function keepCopy(card: Card, copy: SetlistCopy, from: string): boolean {
  const library = loadLibrary();
  if (library.setlists.some((setlist) => setlist.copy?.id === card.copyId)) return true;
  const mark = (id: string) => ({ id, canSendOn: copy.reshareable, from: { name: from } });
  const songIds: number[] = [];
  for (const item of copy.songs) {
    const id = library.songs.find((song) => song.copy?.id === item.copyId)?.id ?? addOwnSong({ ...item.song, copy: mark(item.copyId) });
    if (id === null) return false;
    songIds.push(id);
  }
  return addOwnSetlist({ name: copy.name, songIds, copy: mark(card.copyId) }) !== null;
}

/** A setlist copy in a DM. The friend who scanned the code gets the card and Add to My Songs; the owner sees a line saying what went. */
export function SetlistCard({ message, me }: { message: ChatMessage; me: string }) {
  const card = setlistCardIn(message.text);
  const [library] = useStored(loadLibrary);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  if (!card) return <span className="chat-bubble">📋 A setlist</span>;
  if (message.fromId === me) return <span className="chat-bubble">📋 Shared a copy of {card.name} ({card.titles.length === 1 ? "1 song" : `${card.titles.length} songs`})</span>;
  const held = library.setlists.some((setlist) => setlist.copy?.id === card.copyId);

  const add = async () => {
    setBusy(true);
    try {
      const copy = await api<SetlistCopy>("/api/chat/setlist-copy", { copyId: card.copyId });
      if (!keepCopy(card, copy, message.fromName)) setNote(`This phone couldn't add ${card.name}.`);
    } catch (caught) {
      setNote(setlistCodeMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="chat-bubble song-card setlist-card">
      <span className="song-card-title">
        📋 {card.name}
        {card.sharedAs === "private" ? (
          <span role="img" aria-label="Private" className="band-library-lock">
            🔒
          </span>
        ) : null}
      </span>
      <small>{card.titles.join(", ")}</small>
      {held ? (
        <small>In your Setlists</small>
      ) : note ? (
        <small role="status">{note}</small>
      ) : (
        <button type="button" className="account-secondary" disabled={busy} onClick={add}>
          Add to My Songs
        </button>
      )}
    </span>
  );
}
