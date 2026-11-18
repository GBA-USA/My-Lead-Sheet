import { useState } from "react";
import { isMuted, sortChats, unread, type ChatEntry } from "./chat-model";
import type { Inbox } from "./chat";
import { DAY_MS, dayOf } from "./room";
import { roomHref } from "./route";
import { SearchBox } from "./search-box";

const SEARCH_ABOVE = 8;

function rowTime(at: number, now: number): string {
  const when = new Date(at);
  if (dayOf(at) === dayOf(now)) return when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (dayOf(at) === dayOf(now - DAY_MS)) return "Yesterday";
  if (now - at < 6 * DAY_MS) return when.toLocaleDateString(undefined, { weekday: "short" });
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function RoomRow({ chat, now }: { chat: ChatEntry; now: number }) {
  const count = unread(chat);
  return (
    <li>
      <button type="button" className={`chat-row ${count > 0 ? "chat-row-unread" : ""}`} onClick={() => (window.location.hash = roomHref(chat.roomId))}>
        <span className="chat-row-initial" aria-hidden="true">
          {[...chat.title.trim()][0]?.toUpperCase() ?? "?"}
        </span>
        <span className="chat-row-title">{chat.title}</span>
        <span className="chat-row-side">
          {chat.preview ? <span className="chat-row-time">{rowTime(chat.lastAt, now)}</span> : null}
          {isMuted(chat, now) ? <span className="chat-muted">Muted</span> : null}
          {count > 0 ? <span className="chat-badge">{count}</span> : null}
        </span>
        <span className="chat-row-preview">{chat.preview || (chat.kind === "band" ? "Say hello to the band" : "Say hello")}</span>
      </button>
    </li>
  );
}

export function MessagesScreen({ me, inbox, notice, onSignIn }: { me: string | null; inbox: Inbox; notice: string; onSignIn: () => void }) {
  const [query, setQuery] = useState("");

  if (!me) {
    return (
      <div className="messages">
        <p className="account-note">Sign in to see your messages.</p>
        <button type="button" className="account-primary messages-signin" onClick={onSignIn}>
          Sign in
        </button>
      </div>
    );
  }

  const { chats } = inbox;
  const now = Date.now();
  const words = query.trim().toLowerCase();
  const shown = chats ? sortChats(chats).filter((c) => c.title.toLowerCase().includes(words)) : [];

  return (
    <div className="messages">
      {notice ? (
        <p className="messages-notice" role="status">
          {notice}
        </p>
      ) : null}
      {!chats ? (
        <p className="account-note">{inbox.failed ? "Can't reach the server. Check your connection and try again." : "Loading…"}</p>
      ) : chats.length === 0 ? (
        <p className="account-note">No messages yet. Join a band, or tap Message on a friend or bandmate.</p>
      ) : (
        <>
          {chats.length > SEARCH_ABOVE ? <SearchBox label="Search messages" value={query} onChange={setQuery} /> : null}
          {shown.length === 0 ? <p className="account-note">No rooms match {query.trim()}.</p> : null}
          <ul className="chat-list">
            {shown.map((chat) => (
              <RoomRow key={chat.roomId} chat={chat} now={now} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
