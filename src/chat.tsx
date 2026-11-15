import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  MAX_MESSAGE_CHARS,
  MUTE_LABELS,
  NOT_A_MEMBER_CLOSE,
  firstUnreadSeq,
  isMuted,
  mutedUntilFor,
  nameAbove,
  newMsgId,
  side,
  sortChats,
  unread,
  withMessages,
  type ChatEntry,
  type ChatMessage,
  type MuteChoice,
} from "./chat-model";
import { onDelivery, onQueueChange, queueMessage, queuedMessages, sendQueued, type Delivery } from "./chat-queue";
export { queueOwner } from "./chat-queue";
import { useEscape } from "./hooks";
import { ApiError, api, type Account } from "./sign-in-methods";
import "./friends.css";
import "./chat.css";

type View = { name: "list" } | { name: "thread"; roomId: string } | { name: "dm"; userId: string };

/** Where to open: a thread by room, or the DM with a person, found or made on the way in. */
export type ChatTarget = { roomId: string } | { userId: string };

const MESSAGES: Record<string, string> = {
  offline: "Can't reach the server. Check your connection and try again.",
  "not-a-member": "You're not in this band any more.",
  "no-band": "This thread isn't there any more.",
  "not-friends": "You can only message friends and bandmates.",
  "not-found": "That person isn't here any more.",
};

const message = (error: unknown) => {
  const reason = error instanceof ApiError ? (error.status >= 500 ? "offline" : error.reason) : "";
  return MESSAGES[reason] ?? "Something went wrong. Try again.";
};

const SIGNED_OUT_CLOSE = 4401;
const RECONNECT_MS = 3000;
const MUTE_CHOICES: MuteChoice[] = ["8h", "1w", "always"];

const socketUrl = (roomId: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/rooms/${roomId}`;

/** Messages: the list of band threads and DMs, and one thread with its composer, mute and the messages waiting for signal. */
export function ChatSheet({ account, open, onSignedOut, onClose }: { account: Account; open?: ChatTarget; onSignedOut: () => void; onClose: () => void }) {
  const titleId = useId();
  const inputId = useId();
  const [view, setView] = useState<View>(open ? ("roomId" in open ? { name: "thread", roomId: open.roomId } : { name: "dm", userId: open.userId }) : { name: "list" });
  const [chats, setChats] = useState<ChatEntry[] | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const queue = useSyncExternalStore(onQueueChange, queuedMessages, queuedMessages);
  const [newLineAt, setNewLineAt] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [muting, setMuting] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const roomId = view.name === "thread" ? view.roomId : null;
  const roomRef = useRef(roomId);
  roomRef.current = roomId;
  const entry = roomId ? chats?.find((c) => c.roomId === roomId) : undefined;

  const failed = (caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 401) return onSignedOut();
    if (caught instanceof ApiError && (caught.reason === "not-a-member" || caught.reason === "no-band" || caught.reason === "not-friends")) setView({ name: "list" });
    setError(message(caught));
  };

  const go = (next: View) => {
    setError("");
    setMuting(false);
    setView(next);
  };

  useEscape(onClose);

  useEffect(() => {
    if (view.name !== "dm") return;
    api<{ roomId: string }>("/api/chat/dm", { userId: view.userId }).then((reply) => go({ name: "thread", roomId: reply.roomId }), failed);
  }, [view]);

  useEffect(() => {
    if (view.name !== "dm") api<{ chats: ChatEntry[] }>("/api/chat").then((reply) => setChats(reply.chats), failed);
  }, [view.name === "dm" ? "" : view.name]);

  const markRead = (room: string, seq: number) => {
    setChats((current) => current?.map((c) => (c.roomId === room && c.lastReadSeq < seq ? { ...c, lastReadSeq: seq } : c)) ?? null);
    api("/api/chat/read", { roomId: room, seq }).catch(() => {});
  };

  const arrived = (room: string, more: ChatMessage[]) => {
    if (more.length === 0) return;
    const last = more[more.length - 1];
    setChats((current) =>
      current?.map((c) => (c.roomId === room && c.lastSeq < last.seq ? { ...c, lastSeq: last.seq, lastAt: last.at, preview: `${last.fromName}: ${last.text}` } : c)) ?? null,
    );
    if (room !== roomRef.current) return;
    setMessages((current) => withMessages(current, more));
    markRead(room, last.seq);
  };

  const deliveredRef = useRef<Delivery>(() => {});
  deliveredRef.current = (item, outcome) => ("message" in outcome ? arrived(item.roomId, [outcome.message]) : failed(outcome.error));
  useEffect(() => onDelivery((item, outcome) => deliveredRef.current(item, outcome)), []);

  useEffect(() => {
    if (!roomId) return;
    let stopped = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSeq = 0;
    setMessages([]);
    setNewLineAt(null);
    const fetchNew = () =>
      api<{ messages: ChatMessage[] }>("/api/chat/open", { roomId, after: lastSeq }).then((reply) => {
        if (stopped) return;
        lastSeq = Math.max(lastSeq, ...reply.messages.map((m) => m.seq));
        arrived(roomId, reply.messages);
      }, failed);
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(socketUrl(roomId));
      socket.onmessage = (event) => {
        const inbound = JSON.parse(String(event.data)) as { kind: string; message?: ChatMessage };
        if (inbound.kind === "hello") fetchNew().then(sendQueued);
        if (inbound.kind === "message" && inbound.message) {
          lastSeq = Math.max(lastSeq, inbound.message.seq);
          arrived(roomId, [inbound.message]);
        }
      };
      socket.onclose = (event) => {
        if (stopped) return;
        if (event.code === NOT_A_MEMBER_CLOSE) return failed(new ApiError("not-a-member", 403));
        if (event.code === SIGNED_OUT_CLOSE) return onSignedOut();
        timer = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [roomId]);

  useEffect(() => {
    if (entry && newLineAt === null) setNewLineAt(firstUnreadSeq(entry) ?? 0);
  }, [entry, newLineAt]);

  const waiting = roomId ? queue.filter((item) => item.roomId === roomId) : [];

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length, waiting.length]);

  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!roomId) return;
    queueMessage({ msgId: newMsgId(), roomId, text, at: Date.now(), from: account.userId });
    setText("");
  };

  const mute = (choice: MuteChoice) => {
    if (!roomId) return;
    const mutedUntil = mutedUntilFor(choice, Date.now());
    setMuting(false);
    api("/api/chat/mute", { roomId, mutedUntil }).then(() => setChats((current) => current?.map((c) => (c.roomId === roomId ? { ...c, mutedUntil } : c)) ?? null), failed);
  };

  const now = Date.now();
  const muted = entry ? isMuted(entry, now) : false;
  const title = view.name === "list" ? "Messages" : (entry?.title ?? "Messages");

  return (
    <div className="account-backdrop" onClick={onClose}>
      <section className="account-sheet chat-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-view={view.name} onClick={(event) => event.stopPropagation()}>
        <header className="account-top">
          {roomId ? (
            <button type="button" className="account-link" onClick={() => go({ name: "list" })}>
              Back
            </button>
          ) : null}
          <h2 id={titleId}>{title}</h2>
          <span className="chat-top-side">
            {roomId && entry ? (
              <button type="button" className="account-link" aria-expanded={muting} onClick={() => setMuting((on) => !on)}>
                {muted ? "Muted" : "Mute"}
              </button>
            ) : null}
            <button type="button" className="account-close" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </span>
        </header>
        {error ? (
          <p className="account-error" role="alert">
            {error}
          </p>
        ) : null}

        {view.name === "list" ? (
          !chats ? (
            <p className="account-note">Loading…</p>
          ) : chats.length === 0 ? (
            <p className="account-note">No messages yet. Join a band, or tap Message on a friend or bandmate.</p>
          ) : (
            <ul className="chat-list">
              {sortChats(chats).map((c) => (
                <li key={c.roomId}>
                  <button type="button" className={`chat-row ${unread(c) > 0 ? "chat-row-unread" : ""}`} onClick={() => go({ name: "thread", roomId: c.roomId })}>
                    <span className="chat-row-title">{c.title}</span>
                    <span className="chat-row-side">
                      {isMuted(c, now) ? <span className="chat-muted">Muted</span> : null}
                      {unread(c) > 0 ? <span className="chat-badge">{unread(c)}</span> : null}
                    </span>
                    <span className="chat-row-preview">{c.preview || (c.kind === "band" ? "Say hello to the band" : "Say hello")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {view.name === "dm" ? <p className="account-note">Loading…</p> : null}

        {roomId ? (
          <>
            {muting ? (
              <div className="account-row">
                {MUTE_CHOICES.map((choice) => (
                  <button key={choice} type="button" className="account-secondary" onClick={() => mute(choice)}>
                    {MUTE_LABELS[choice]}
                  </button>
                ))}
                {muted ? (
                  <button type="button" className="account-link" onClick={() => mute("off")}>
                    {MUTE_LABELS.off}
                  </button>
                ) : null}
              </div>
            ) : null}
            <ol className="chat-messages" ref={listRef}>
              {messages.length === 0 && waiting.length === 0 ? <li className="account-note">No messages yet. Say hello.</li> : null}
              {messages.map((m) => (
                <li key={m.seq} className={`chat-line chat-line-${side(m, account.userId)}`}>
                  {newLineAt === m.seq ? <div className="chat-new-line">New messages</div> : null}
                  <span className="chat-name">{nameAbove(m, account.userId)}</span>
                  <span className="chat-bubble">{m.text}</span>
                </li>
              ))}
              {waiting.map((item) => (
                <li key={item.msgId} className="chat-line chat-line-mine">
                  <span className="chat-name">You</span>
                  <span className="chat-bubble">{item.text}</span>
                  <span className="chat-waiting">⏱ Waiting for signal</span>
                </li>
              ))}
            </ol>
            <form className="chat-composer" onSubmit={send}>
              <label className="account-field" htmlFor={inputId} hidden>
                Message
              </label>
              <input id={inputId} className="account-input" autoComplete="off" maxLength={MAX_MESSAGE_CHARS} placeholder="Message" value={text} onChange={(event) => setText(event.target.value)} />
              <button type="submit" className="account-primary" disabled={!text.trim()}>
                Send
              </button>
            </form>
          </>
        ) : null}
      </section>
    </div>
  );
}
