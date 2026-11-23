import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import type { Member } from "./bands-model";
import { MAX_MESSAGE_CHARS, MUTE_LABELS, bandSongLine, isMuted, linkify, mutedUntilFor, nameAbove, type BandSongCard, type ChatEntry, type ChatMessage, type MuteChoice, type Queued } from "./chat-model";
import { useRoomSocket, type ChangeEntry } from "./chat";
import { DotsIcon, Menu } from "./controls";
import { useEscape, useKeyboardInset } from "./hooks";
import { bandHref, bandSongHref } from "./route";
import { fold } from "./search";
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

const hardwareKeyboard = () => matchMedia("(hover: hover) and (pointer: fine)").matches;

/** A band song as the band page holds it, from the server's library or this phone's copy of it. */
type RoomSong = { songId: string; song: { title: string; artist: string } };

/** What a band thread knows of its band: the other members to @mention, its songs (null until they load), and a way to fetch them again. */
export type RoomBand = { members: Member[]; songs: RoomSong[] | null; reload: () => Promise<unknown> };

/** A message's words, with each http(s) link tappable. A link to this app opens in place; another site opens in a new tab. */
function Words({ text }: { text: string }) {
  return linkify(text, location.origin).map((part, index) =>
    "href" in part ? (
      <a key={index} href={part.href} {...(part.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        {part.text}
      </a>
    ) : (
      part.text
    ),
  );
}

/** A band song someone pointed at. It opens the band's copy, says the band no longer has it, or for a guest, who has no band page to open it on, only names it. */
function BandSongLink({ message, bandId, gone, guest }: { message: ChatMessage; bandId: string; gone: boolean; guest: boolean }) {
  const songId = message.ref ?? "";
  if (gone || guest) {
    return (
      <span className="chat-bubble chat-band-song">
        {message.text}
        {gone ? <small>No longer in this band</small> : null}
      </span>
    );
  }
  return (
    <a className="chat-bubble chat-band-song" href={bandSongHref(bandId, songId)}>
      {message.text}
    </a>
  );
}

/**
 * The name being typed after an `@` just before the caret, or null when no @ list should show. One word is a query
 * even when nobody matches, so the list can say so. Past a space it stays one only while it still starts a member's
 * name, so the list closes once a name is written out and the message goes on.
 */
function mentionQuery(before: string, members: Member[]): string | null {
  const typed = /(?:^|\s)@([^@\n]*)$/.exec(before)?.[1];
  if (typed === undefined || /\s$/.test(typed)) return null;
  if (!/\s/.test(typed)) return typed;
  return members.some((member) => fold(member.name).startsWith(fold(typed))) ? typed : null;
}

function SongPicker({ songs, onPick, onClose }: { songs: RoomSong[] | null; onPick: (item: RoomSong) => void; onClose: () => void }) {
  useEscape(onClose);
  const sorted = songs && [...songs].sort((a, b) => a.song.title.localeCompare(b.song.title, undefined, { sensitivity: "base" }));
  return (
    <ul className="friends-list chat-song-picker" aria-label="Band songs">
      {sorted === null ? <li className="account-note">Loading band songs…</li> : null}
      {sorted?.length === 0 ? <li className="account-note">No songs in this band yet.</li> : null}
      {sorted?.map((item) => (
        <li key={item.songId}>
          <button type="button" className="band-library-row" onClick={() => onPick(item)}>
            <span className="band-library-name">{item.song.title}</span>
            <small>{item.song.artist}</small>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Composer({ onSend, band }: { onSend: (text: string, card?: BandSongCard) => void; band?: RoomBand }) {
  const inputId = useId();
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [picking, setPicking] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const query = band ? mentionQuery(text.slice(0, caret), band.members) : null;
  const matches = query === null || !band ? [] : band.members.filter((member) => fold(member.name).includes(fold(query)));

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
  const typed = (box: HTMLTextAreaElement) => {
    setText(box.value);
    setCaret(box.selectionStart);
  };
  const mention = (member: Member) => {
    const start = caret - (query ?? "").length - 1;
    const written = `@${member.name} `;
    setText(text.slice(0, start) + written + text.slice(caret));
    setCaret(start + written.length);
    requestAnimationFrame(() => {
      boxRef.current?.focus();
      boxRef.current?.setSelectionRange(start + written.length, start + written.length);
    });
  };
  const pickSong = (item: RoomSong) => {
    setPicking(false);
    onSend(bandSongLine(item.song), { kind: "band-song", songId: item.songId });
  };

  return (
    <form className="chat-composer" onSubmit={submit}>
      {picking && band ? <SongPicker songs={band.songs} onPick={pickSong} onClose={() => setPicking(false)} /> : null}
      {query !== null && !picking ? (
        <ul className="friends-list chat-mentions" aria-label="Band members">
          {matches.length === 0 ? <li className="account-note">No band members match</li> : null}
          {matches.map((member) => (
            <li key={member.userId}>
              <button type="button" className="band-library-row" onClick={() => mention(member)}>
                {member.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {band ? (
        <button type="button" className="account-secondary" aria-expanded={picking} onClick={() => setPicking((open) => !open)}>
          + Song
        </button>
      ) : null}
      <label htmlFor={inputId} hidden>
        Message
      </label>
      <textarea
        id={inputId}
        ref={boxRef}
        className="account-input"
        rows={1}
        maxLength={MAX_MESSAGE_CHARS}
        placeholder="Message"
        value={text}
        onChange={(event) => typed(event.target)}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={enter}
      />
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
  guest = false,
  band,
  onEntry,
  onGone,
  onSignedOut,
}: {
  me: string;
  roomId: string;
  entry: ChatEntry | undefined;
  inline?: boolean;
  /** A guest's Band chat on the gig view. Its band-song cards name the song and open nothing, since every band route is a member's. */
  guest?: boolean;
  /** A band thread on its band page. A DM, or a band thread opened from Messages, has no + Song or @ list. */
  band?: RoomBand;
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

  /** Card songs the band's songs lack. A miss may be a song shared since they loaded, so each one asks for them once, and reads as gone only if that fetch lacks it too. */
  const songIds = band?.songs && new Set(band.songs.map((item) => item.songId));
  const missing = songIds ? [...new Set((messages ?? []).flatMap((m) => (m.kind === "band-song" && m.ref && !songIds.has(m.ref) ? [m.ref] : [])))] : [];
  const asked = useRef(new Set<string>());
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const fresh = missing.filter((ref) => !asked.current.has(ref));
    if (!band || fresh.length === 0) return;
    for (const ref of fresh) asked.current.add(ref);
    band.reload().then(() => setChecked((was) => new Set([...was, ...fresh])), () => {});
  }, [missing.join(" ")]);

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
          <li key={line.key} className={`chat-line chat-line-${line.mine ? "mine" : "theirs"}${"message" in line && !line.mine && line.message.mentions.includes(me) ? " chat-line-mention" : ""}`}>
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
            ) : line.message.kind === "band-song" ? (
              <BandSongLink message={line.message} bandId={roomId} guest={guest} gone={!!line.message.ref && missing.includes(line.message.ref) && checked.has(line.message.ref)} />
            ) : (
              <span className="chat-bubble">
                <Words text={line.message.text} />
              </span>
            )}
          </li>
        ))}
      </ol>
      <Composer onSend={send} band={band ? { ...band, members: band.members.filter((member) => member.userId !== me) } : undefined} />
    </section>
  );
}
