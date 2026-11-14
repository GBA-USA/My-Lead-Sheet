import { useState } from "react";
import { fixtureChats, fixtureMessages, sortChats, unread, isBold, isMuted, firstUnreadSeq, nameAbove, side, queueSend, flush } from "./chat-model";

export function ChatList() {
  const sorted = sortChats(fixtureChats);

  return (
    <div className="chat-list">
      {sorted.map(c => (
        <div key={c.roomId} className={`chat-list-row ${isBold(c) ? "chat-list-bold" : ""}`}>
          <div className="chat-list-title">{c.title}</div>
          <div className="chat-list-preview">{c.preview}</div>
          {unread(c) > 0 && <span className="chat-list-badge">{unread(c)}</span>}
          {isMuted(c, Date.now(), false) && <span className="chat-list-muted">🔇</span>}
        </div>
      ))}
    </div>
  );
}

export function ChatThread() {
  const bandChat = fixtureChats[0];
  const bandMessages = fixtureMessages;
  const unreadSeq = firstUnreadSeq(bandChat);

  const [offline, setOffline] = useState(false);
  const [queue, setQueue] = useState<{ localId: string; roomId: string; text: string; state: "waiting" | "sent" }[]>([]);
  const [composerText, setComposerText] = useState("");

  const handleSend = () => {
    const newQueue = queueSend(queue, bandChat.roomId, composerText, !offline, `local-${Date.now()}`);
    setQueue(newQueue);
    setComposerText("");
  };

  const handleOfflineToggle = () => {
    setOffline(!offline);
    if (!offline) {
      const flushed = flush(queue);
      setQueue(flushed);
    }
  };

  return (
    <div className="chat-thread">
      <div className="chat-thread-header">
        <h2>{bandChat.title}</h2>
        <button onClick={handleOfflineToggle} className="chat-thread-offline-btn">
          {offline ? "Offline" : "Online"}
        </button>
      </div>

      <div className="chat-thread-messages">
        {bandMessages.map(m => (
          <div key={m.seq}>
            {unreadSeq === m.seq && <div className="chat-thread-newline">New messages</div>}
            <div className={`chat-thread-bubble-wrapper chat-thread-${side(m)}`}>
              <div className="chat-thread-name">{nameAbove(m)}</div>
              <div className="chat-thread-bubble" style={{ maxWidth: "75%" }}>
                {m.text}
              </div>
            </div>
          </div>
        ))}
        {queue.map(m => (
          <div key={m.localId} className={`chat-thread-bubble-wrapper chat-thread-mine`}>
            <div className="chat-thread-name">You</div>
            <div className="chat-thread-bubble" style={{ maxWidth: "75%" }}>
              {m.text}
              {m.state === "waiting" && <span className="chat-thread-waiting"> (Waiting to send)</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="chat-thread-composer">
        <input
          type="text"
          value={composerText}
          onChange={e => setComposerText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSend()}
          placeholder="Type a message..."
          className="chat-thread-input"
        />
        <button onClick={handleSend} className="chat-thread-send-btn">
          Send
        </button>
      </div>

      <div className="chat-thread-mute-menu">
        <button onClick={() => {}} className="chat-thread-mute-btn">8 hours</button>
        <button onClick={() => {}} className="chat-thread-mute-btn">1 week</button>
        <button onClick={() => {}} className="chat-thread-mute-btn">Always</button>
      </div>
    </div>
  );
}
