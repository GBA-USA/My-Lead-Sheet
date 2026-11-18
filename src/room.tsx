import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { MAX_MESSAGE_CHARS, MUTE_LABELS, isMuted, mutedUntilFor, nameAbove, type ChatEntry, type ChatMessage, type MuteChoice, type Queued } from "./chat-model";
import { useRoomSocket, type ChangeEntry } from "./chat";
import { DotsIcon, Menu } from "./controls";
import { bandHref } from "./route";
import { SongCard } from "./send-song";
import { SetlistCard } from "./setlist-code";
import { api } from "./sign-in-methods";

const MUTE_CHOICES: MuteChoice[] = ["8h", "1w", "always"];
export const DAY_MS = 24 * 3600 * 1000;
const COMPOSER_LINES = 4;

type Line = { key: string; day: string | null; newLine: boolean; name: string | null; mine: boolean } & ({ message: ChatMessage } | { waiting: Queued });

export const dayOf = (at: number) => new Date(at).toDateString();

function dayLabel(at: number, now: number): string {
  if (dayOf(at) === dayOf(now)) return "Today";
  if (dayOf(at) === dayOf(now - DAY_MS)) return "Yesterday";
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

function threadLines(messages: ChatMessage[], waiting: Queued[], me: string, newLineAt: number | null, now: number): Line[] {
  const items = [
    ...messages.map((message) => ({ key: `m${message.seq}`, from: message.fromId, at: message.at, name: nameAbove(message, me), newLine: message.seq === newLineAt, message })),
    ...waiting.map((item) => ({ key: item.msgId, from: item.from, at: item.at, name: "You", newLine: false, waiting: item })),
  ];
  return items.map(({ from, at, name, ...item }, index) => {
    const before = items[index - 1];
    const newDay = !before || dayOf(before.at) !== dayOf(at);
    const newRun = newDay || item.newLine || before.from !== from;
    return { ...item, day: newDay ? dayLabel(at, now) : null, name: newRun ? name : null, mine: from === me };
  });
}

/** How far the on-screen keyboard reaches up over the page. iOS Safari keeps the layout viewport and shrinks only the visual one. */
function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const measure = () => setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
    measure();
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    return () => {
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
    };
  }, []);
  return inset;
}

const hardwareKeyboard = () => matchMedia("(hover: hover) and (pointer: fine)").matches;

function Composer({ onSend }: { onSend: (text: string) => void }) {
  const inputId = useId();
  const [text, setText] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const style = getComputedStyle(box);
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, COMPOSER_LINES * parseFloat(style.lineHeight) + padding) + box.offsetHeight - box.clientHeight}px`;
  }, [text]);

  const send = () => {
    if (!text.trim()) return;
    onSend(text);
    setText("");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };
  const enter = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || !hardwareKeyboard()) return;
    event.preventDefault();
    send();
  };

  return (
    <form className="chat-composer" onSubmit={submit}>
      <label htmlFor={inputId} hidden>
        Message
      </label>
      <textarea id={inputId} ref={boxRef} className="account-input" rows={1} maxLength={MAX_MESSAGE_CHARS} placeholder="Message" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={enter} />
      <button type="submit" className="account-primary" disabled={!text.trim()}>
        Send
      </button>
    </form>
  );
}

export function Room({
  me,
  roomId,
  entry,
  inline,
  onEntry,
  onGone,
  onSignedOut,
}: {
  me: string;
  roomId: string;
  entry: ChatEntry | undefined;
  inline?: boolean;
  onEntry: ChangeEntry;
  onGone: (error: unknown) => void;
  onSignedOut: () => void;
}) {
  const { messages, waiting, newLineAt, error, failed, send } = useRoomSocket({ me, roomId, entry, onEntry, onGone, onSignedOut });
  const [menu, setMenu] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const keyboard = useKeyboardInset();
  const now = Date.now();
  const muted = entry ? isMuted(entry, now) : false;

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages?.length, waiting.length, keyboard]);

  const mute = (choice: MuteChoice) => {
    const mutedUntil = mutedUntilFor(choice, Date.now());
    setMenu(false);
    api("/api/chat/mute", { roomId, mutedUntil }).then(() => onEntry(roomId, (c) => ({ ...c, mutedUntil })), failed);
  };

  return (
    <section className="room" data-room={roomId} data-inline={inline ? "" : undefined} style={{ "--keyboard": `${keyboard}px` } as CSSProperties}>
      {inline ? null : (
        <header className="room-top">
          <h2>{entry?.title ?? "Chat"}</h2>
          {muted ? <small>Muted</small> : null}
          <Menu button={<DotsIcon />} label="More" className="more-btn room-more" open={menu} onToggle={() => setMenu((open) => !open)} onClose={() => setMenu(false)}>
            {MUTE_CHOICES.map((choice) => (
              <button key={choice} type="button" role="menuitem" onClick={() => mute(choice)}>
                {MUTE_LABELS[choice]}
              </button>
            ))}
            {muted ? (
              <button type="button" role="menuitem" onClick={() => mute("off")}>
                {MUTE_LABELS.off}
              </button>
            ) : null}
            {entry?.kind === "band" ? (
              <button type="button" role="menuitem" onClick={() => (window.location.hash = bandHref(roomId, "chat"))}>
                Open band
              </button>
            ) : null}
          </Menu>
        </header>
      )}
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
      <ol className="chat-messages" ref={listRef}>
        {messages === null && !error ? <li className="account-note">Loading…</li> : null}
        {messages?.length === 0 && waiting.length === 0 ? <li className="account-note">No messages yet. Say hello.</li> : null}
        {threadLines(messages ?? [], waiting, me, newLineAt, now).map((line) => (
          <li key={line.key} className={`chat-line chat-line-${line.mine ? "mine" : "theirs"}`}>
            {line.day ? <div className="chat-day">{line.day}</div> : null}
            {line.newLine ? <div className="chat-new-line">New messages</div> : null}
            {line.name ? <span className="chat-name">{line.name}</span> : null}
            {"waiting" in line ? (
              <>
                <span className="chat-bubble">{line.waiting.song ? `🎵 ${line.waiting.text}` : line.waiting.text}</span>
                <span className="chat-waiting">⏱ Waiting for signal</span>
              </>
            ) : line.message.kind === "song" ? (
              <SongCard message={line.message} me={me} />
            ) : line.message.kind === "setlist" ? (
              <SetlistCard message={line.message} me={me} />
            ) : (
              <span className="chat-bubble">{line.message.text}</span>
            )}
          </li>
        ))}
      </ol>
      <Composer onSend={send} />
    </section>
  );
}
