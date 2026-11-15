import { useEffect, useId, useState } from "react";
import { CHOICES, content } from "./band-library";
import { newMsgId, type ChatMessage, type Queued } from "./chat-model";
import { onDelivery, queueMessage, sendQueued, type Delivery } from "./chat-queue";
import { useEscape, useStored } from "./hooks";
import { applyUpdate, canSend, cardLine, received, songMessageIn, type Received, type SendPick, type SongSend, type UpdateChoice } from "./send-song-model";
import type { ShareChoice } from "./share-rule";
import { ApiError, api, type Account } from "./sign-in-methods";
import { addOwnSong, loadLibrary, loadScrollVersions, loadSongData, localRef, replaceOwnSong, saveScrollVersions, saveSongData, songByRef, storageChanged } from "./storage";
import type { Song } from "./types";
import "./friends.css";
import "./band-library.css";
import "./send-song.css";

type Friend = { userId: string; handle: string; name: string };
type Step = { name: "friends" } | { name: "what"; friend: Friend; roomId: string };

export const SEND_MESSAGES: Record<string, string> = {
  offline: "Can't reach the server. Check your connection and try again.",
  "signed-out": "Sign in again to send songs.",
  "not-friends": "You can only send songs to friends.",
  private_copy: "This was shared with you privately, so it can't be passed on.",
  private_ancestor: "This was shared with you privately, so it can't be passed on.",
  not_found: "This copy belongs to another account on this phone.",
  not_yours: "This copy belongs to another account on this phone.",
  lineage_broken: "The server can't tell where this copy came from, so it can't be passed on.",
  choice_required: "Pick Private or Public first.",
  "too-large": "This song is too big to send. Try fewer timing versions.",
  "not-found": "That earlier send isn't in this chat any more. Send it again.",
};

const messageFor = (error: unknown) => {
  const reason = error instanceof ApiError ? (error.status >= 500 ? "offline" : error.reason) : "";
  return SEND_MESSAGES[reason] ?? "Something went wrong. Try again.";
};

/** Per account, per song, per friend: the share id last sent, so sending the same song again is an update. */
const SENT_KEY = "leadSheetsSentSongs";
type SentSongs = Record<string, Record<string, Record<string, string>>>;

function readSent(): SentSongs {
  try {
    const sent = JSON.parse(localStorage.getItem(SENT_KEY) ?? "{}");
    return sent && typeof sent === "object" && !Array.isArray(sent) ? sent : {};
  } catch {
    return {};
  }
}

function rememberSent(me: string, song: Song, friendId: string, shareId: string) {
  const sent = readSent();
  sent[me] = { ...sent[me], [song.ref]: { ...sent[me]?.[song.ref], [friendId]: shareId } };
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify(sent));
  } catch {}
}

/** Keeps a song from a friend in My Songs, as a new song or in place of the copy `replaceId`, with what came with it. */
function keepReceived(kept: Received, replaceId: number | null): boolean {
  const id = replaceId === null ? addOwnSong(kept.song) : replaceOwnSong(replaceId, kept.song) ? replaceId : null;
  if (id === null) return false;
  if (kept.versions.length > 0) saveScrollVersions(localRef(id), { versions: kept.versions, selected: null });
  if (kept.data) saveSongData(localRef(id), kept.data);
  storageChanged();
  return true;
}

/**
 * Send to a friend…: pick a friend, tick timing versions and My song data (the chart always goes), then Private or
 * Public. The send waits in the chat queue like a message, so with no signal it goes later, once. `song` is the song as
 * stored, without the song data this phone entered, which goes only when ticked.
 */
export function SendSongSheet({ account, song, onFriends, onSent, onClose }: { account: Account; song: Song; onFriends: () => void; onSent: (roomId: string) => void; onClose: () => void }) {
  const titleId = useId();
  const [step, setStep] = useState<Step>({ name: "friends" });
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [pick, setPick] = useState<SendPick>({ versions: [], data: false, choice: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const versions = loadScrollVersions(song.ref).versions;
  const data = loadSongData(song.ref);
  const hasData = Object.keys(data).length > 0;

  useEscape(onClose);

  const loadFriends = () => {
    setError("");
    api<{ friends: Friend[] }>("/api/friends").then(
      (reply) => setFriends(reply.friends),
      (caught) => setError(messageFor(caught)),
    );
  };
  useEffect(loadFriends, []);

  const choose = (friend: Friend) => {
    setBusy(true);
    setError("");
    api<{ roomId: string }>("/api/chat/dm", { userId: friend.userId })
      .then(
        (reply) => {
          setPick({ versions: [], data: false, choice: null });
          setStep({ name: "what", friend, roomId: reply.roomId });
        },
        (caught) => setError(messageFor(caught)),
      )
      .finally(() => setBusy(false));
  };

  const tick = (index: number) => setPick((current) => ({ ...current, versions: current.versions.includes(index) ? current.versions.filter((i) => i !== index) : [...current.versions, index] }));

  const send = async () => {
    if (step.name !== "what" || !canSend(pick)) return;
    const { friend, roomId } = step;
    const shareId = newMsgId();
    const request: SongSend = {
      userId: friend.userId,
      shareId,
      song: content(song),
      versions: versions.filter((_, index) => pick.versions.includes(index)),
      data: pick.data && hasData ? data : null,
      choice: pick.choice,
      copyId: song.copy?.id ?? null,
      updateOf: readSent()[account.userId]?.[song.ref]?.[friend.userId] ?? null,
    };
    const item: Queued = { msgId: newMsgId(), roomId, text: song.title, at: Date.now(), from: account.userId, song: request };
    const heard: { outcome?: Parameters<Delivery>[1] } = {};
    const stop = onDelivery((done, outcome) => {
      if (done.msgId === item.msgId) heard.outcome = outcome;
    });
    setBusy(true);
    setError("");
    queueMessage(item);
    await sendQueued();
    stop();
    setBusy(false);
    if (heard.outcome && "error" in heard.outcome) return setError(messageFor(heard.outcome.error));
    if (heard.outcome) rememberSent(account.userId, song, friend.userId, shareId);
    onSent(roomId);
  };

  const title = step.name === "friends" ? `Send ${song.title}` : `Send ${song.title} to ${step.friend.name}`;

  if (!friends && !error) {
    return (
      <div className="account-backdrop" onClick={onClose}>
        <p className="account-sheet account-note" aria-busy="true">
          Loading…
        </p>
      </div>
    );
  }

  return (
    <div className="account-backdrop" onClick={onClose}>
      <section className="account-sheet send-song-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className="account-top">
          {step.name === "what" ? (
            <button type="button" className="account-link" onClick={() => setStep({ name: "friends" })}>
              Back
            </button>
          ) : null}
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="account-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        {error ? (
          <p className="account-error" role="alert">
            {error}
          </p>
        ) : null}

        {step.name === "friends" ? (
          !friends ? (
            <button type="button" className="account-secondary" onClick={loadFriends}>
              Try again
            </button>
          ) : friends.length === 0 ? (
            <>
              <p className="account-note">Add a friend first.</p>
              <button type="button" className="account-primary" onClick={onFriends}>
                Friends
              </button>
            </>
          ) : (
            <ul className="friends-list">
              {friends.map((friend) => (
                <li key={friend.userId}>
                  <button type="button" className="band-library-pick-row" disabled={busy} onClick={() => choose(friend)}>
                    {friend.name}
                    <small>@{friend.handle}</small>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="account-form">
            <ul className="send-song-ticks">
              <li>
                <label>
                  <input type="checkbox" checked disabled /> Chart <small>always sent</small>
                </label>
              </li>
              {versions.map((version, index) => (
                <li key={index}>
                  <label>
                    <input type="checkbox" checked={pick.versions.includes(index)} onChange={() => tick(index)} /> {version.name}
                    {version.learned ? <small>learned</small> : null}
                  </label>
                </li>
              ))}
              {hasData ? (
                <li>
                  <label>
                    <input type="checkbox" checked={pick.data} onChange={() => setPick((current) => ({ ...current, data: !current.data }))} /> My song data <small>BPM, runtime, time signature</small>
                  </label>
                </li>
              ) : null}
            </ul>
            <div className="band-library-choices">
              {(Object.keys(CHOICES) as ShareChoice[]).map((key) => (
                <div key={key}>
                  <button type="button" className="band-library-choice" aria-pressed={pick.choice === key} onClick={() => setPick((current) => ({ ...current, choice: key }))}>
                    {CHOICES[key].label}
                  </button>
                  <small>{CHOICES[key].line}</small>
                </div>
              ))}
            </div>
            <p className="account-note">{step.friend.name} gets a copy. Your later changes won't change it.</p>
            <button type="button" className="account-primary" disabled={busy || !canSend(pick)} onClick={send}>
              Send
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

/** The song page's "Send to a friend…" entry and the sheet it opens. A signed-out phone or a Private copy gets no entry. The sheet is sent the song as stored. */
export function useSendSong(account: Account | null, songs: Song[], open: { friends: () => void; chat: (roomId: string) => void }) {
  const [sending, setSending] = useState<Song | null>(null);
  const item = (song: Song, closeMenu: () => void) =>
    account && song.copy?.canSendOn !== false ? (
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          closeMenu();
          setSending(songByRef(songs, song.ref) ?? null);
        }}
      >
        Send to a friend…
      </button>
    ) : null;
  const close = () => setSending(null);
  const sheet =
    sending && account ? (
      <SendSongSheet
        key={account.userId}
        account={account}
        song={sending}
        onFriends={() => {
          close();
          open.friends();
        }}
        onSent={(roomId) => {
          close();
          open.chat(roomId);
        }}
        onClose={close}
      />
    ) : null;
  return { item, sheet };
}

/** A song card in a DM thread. The friend adds it to My Songs, or, for an update of a copy they hold, picks what to keep. */
export function SongCard({ message, me }: { message: ChatMessage; me: string }) {
  const [library] = useStored(loadLibrary);
  const [note, setNote] = useState("");
  const sent = songMessageIn(message.text);
  if (!sent) return <span className="chat-bubble">A song this app can't show.</span>;
  const mine = message.fromId === me;
  const holding = (shareId: string | null) => (shareId === null ? undefined : library.songs.find((song) => song.copy?.id === shareId));
  const earlier = holding(sent.updateOf);

  const keep = (kept: Received, replaceId: number | null) => setNote(keepReceived(kept, replaceId) ? `${kept.song.title} is in My Songs.` : `This phone couldn't add ${kept.song.title}.`);

  const update = (choice: UpdateChoice) => {
    const { replace, add } = applyUpdate(sent, message.fromName, choice);
    if (replace) return keep(replace, loadLibrary().songs.find((song) => song.copy?.id === sent.updateOf)?.id ?? null);
    if (add) return keep(add, null);
    setNote("Kept yours.");
  };

  return (
    <span className="chat-bubble song-card">
      <span className="song-card-title">
        🎵 {sent.song.title}
        {sent.sharedAs === "private" ? (
          <span role="img" aria-label="Private" className="band-library-lock">
            🔒
          </span>
        ) : null}
      </span>
      <small>{sent.song.artist}</small>
      <small>{cardLine(sent, mine ? "you" : message.fromName)}</small>
      {sent.updateOf ? <small>{mine ? "You sent an update." : `${message.fromName} sent an update. Update your copy?`}</small> : null}
      {mine ? (
        <small className="song-card-sent">✓ Sent</small>
      ) : holding(sent.shareId) ? (
        <small>In My Songs</small>
      ) : note ? (
        <small role="status">{note}</small>
      ) : earlier ? (
        <span className="song-card-actions">
          <button type="button" className="account-secondary" onClick={() => update("keep-mine")}>
            Keep mine
          </button>
          <button type="button" className="account-secondary" onClick={() => update("take-theirs")}>
            Take {message.fromName}'s
          </button>
          <button type="button" className="account-secondary" onClick={() => update("keep-both")}>
            Keep both
          </button>
        </span>
      ) : (
        <button type="button" className="account-secondary" onClick={() => keep(received(sent, message.fromName), null)}>
          Add to My Songs
        </button>
      )}
    </span>
  );
}
