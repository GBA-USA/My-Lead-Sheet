import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NOT_A_MEMBER_CLOSE, firstUnreadSeq, isMuted, newMsgId, previewText, unread, withMessages, type BandSongCard, type ChatEntry, type ChatMessage } from "./chat-model";
import { onDelivery, onQueueChange, queueMessage, queuedMessages, sendQueued, type Delivery } from "./chat-queue";
export { queueOwner } from "./chat-queue";
import { NOT_ON_LINEUP_CLOSE } from "./links/link";
import type { Route } from "./route";
import { SEND_MESSAGES } from "./send-song";
import { ApiError, api } from "./sign-in-methods";
import "./friends.css";
import "./chat.css";

export const MESSAGES: Record<string, string> = {
  ...SEND_MESSAGES,
  offline: "Can't reach the server. Check your connection and try again.",
  "not-a-member": "You're not in this band any more.",
  "no-band": "This thread isn't there any more.",
  "not-friends": "You can only message friends and bandmates.",
  "not-found": "That person isn't here any more.",
  "bad-request": "That conversation isn't here.",
  guest: "This pass has ended.",
  "pass-revoked": "This pass was ended by the band.",
  "pass-ended": "This pass has ended.",
};

export const chatMessage = (error: unknown) => {
  const reason = error instanceof ApiError ? (error.status >= 500 ? "offline" : error.reason) : "";
  return MESSAGES[reason] ?? "Something went wrong. Try again.";
};

/** What a guest hears once no pass of theirs opens the chat: `guest` from a chat call, or the room's own word when it closes their socket. */
const PASS_OVER = ["guest", "pass-revoked", "pass-ended"];

export const closedRoom = (error: unknown) => error instanceof ApiError && ["not-a-member", "no-band", "not-friends", ...PASS_OVER].includes(error.reason);

/** A refusal that no retry can change, so the phone stops asking: the room is closed to this account, the session ended, or the request names no room. */
const final = (error: unknown) => closedRoom(error) || (error instanceof ApiError && (error.status === 400 || error.status === 401));

const SIGNED_OUT_CLOSE = 4401;
const RECONNECT_MS = 3000;

const socketUrl = (roomId: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/rooms/${roomId}`;

export type ChangeEntry = (roomId: string, change: (entry: ChatEntry) => ChatEntry) => void;

const withLast = (c: ChatEntry, last: ChatMessage): ChatEntry => (c.lastSeq < last.seq ? { ...c, lastSeq: last.seq, lastAt: last.at, preview: `${last.fromName}: ${previewText(last)}` } : c);

/** The server's list over the phone's: a read mark or a message the phone saw never goes back, whichever answer came first. */
const merged = (held: ChatEntry[] | null, got: ChatEntry[]) =>
  got.map((c) => {
    const mine = held?.find((h) => h.roomId === c.roomId);
    if (!mine) return c;
    const newer = mine.lastSeq > c.lastSeq ? { lastSeq: mine.lastSeq, lastAt: mine.lastAt, preview: mine.preview } : {};
    return { ...c, ...newer, lastReadSeq: Math.max(c.lastReadSeq, mine.lastReadSeq) };
  });

/** Screens that show the list or a badge from it. A song or the stage makes no call. */
const INBOX_SCREENS: ReadonlySet<Route["name"]> = new Set(["songs", "setlists", "bands", "settings", "messages", "room", "band"]);

export type Inbox = { chats: ChatEntry[] | null; failed: boolean; unread: number; change: ChangeEntry };

export function useInbox(me: string | null, screen: Route["name"], onSignedOut: () => void): Inbox {
  const [held, setHeld] = useState<{ me: string | null; chats: ChatEntry[] | null; failed: boolean }>({ me, chats: null, failed: false });
  const [round, setRound] = useState(0);
  const listed = INBOX_SCREENS.has(screen);
  const { chats, failed } = held.me === me ? held : { chats: null, failed: false };

  useEffect(() => {
    if (!me || !listed) return;
    let stopped = false;
    api<{ chats: ChatEntry[] }>("/api/chat").then(
      (reply) => {
        if (stopped) return;
        setHeld((current) => ({ me, chats: merged(current.me === me ? current.chats : null, reply.chats), failed: false }));
      },
      (caught) => {
        if (stopped) return;
        if (caught instanceof ApiError && caught.status === 401) return onSignedOut();
        setHeld((current) => (current.me === me ? { ...current, failed: true } : { me, chats: null, failed: true }));
      },
    );
    return () => {
      stopped = true;
    };
  }, [me, screen, listed, round]);

  useEffect(() => {
    const onShow = () => document.visibilityState === "visible" && setRound((n) => n + 1);
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, []);

  const change = useCallback<ChangeEntry>((roomId, update) => setHeld((current) => ({ ...current, chats: current.chats?.map((c) => (c.roomId === roomId ? update(c) : c)) ?? null })), []);

  useEffect(() => onDelivery((item, outcome) => "message" in outcome && change(item.roomId, (c) => withLast(c, outcome.message))), []);

  const now = Date.now();
  return { chats, failed, unread: chats?.reduce((total, c) => total + (isMuted(c, now) ? 0 : unread(c)), 0) ?? 0, change };
}

export const goneWords = (roomId: string, error: unknown) =>
  roomId.startsWith("dm_") && error instanceof ApiError && error.reason === "not-a-member" ? MESSAGES["not-friends"] : chatMessage(error);

export const openDm = (userId: string) => api<{ roomId: string }>("/api/chat/dm", { userId }).then((reply) => reply.roomId);

export function useRoomSocket({
  me,
  roomId,
  entry,
  onEntry,
  onGone,
  onSignedOut,
}: {
  me: string;
  roomId: string;
  entry: ChatEntry | undefined;
  onEntry: ChangeEntry;
  onGone: (error: unknown) => void;
  onSignedOut: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const queue = useSyncExternalStore(onQueueChange, queuedMessages, queuedMessages);
  const [newLineAt, setNewLineAt] = useState<number | null>(null);
  const [error, setError] = useState("");

  const failed = (caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 401) return onSignedOut();
    if (closedRoom(caught)) return onGone(caught);
    setError(chatMessage(caught));
  };

  const markRead = (seq: number) => {
    onEntry(roomId, (c) => (c.lastReadSeq < seq ? { ...c, lastReadSeq: seq } : c));
    api("/api/chat/read", { roomId, seq }).catch(() => {});
  };

  const arrived = (more: ChatMessage[]) => {
    if (more.length === 0) return;
    const last = more[more.length - 1];
    onEntry(roomId, (c) => withLast(c, last));
    setMessages((current) => withMessages(current ?? [], more));
    markRead(last.seq);
  };

  const deliveredRef = useRef<Delivery>(() => {});
  deliveredRef.current = (item, outcome) => {
    if (item.roomId !== roomId) return;
    if ("message" in outcome) arrived([outcome.message]);
    else failed(outcome.error);
  };
  useEffect(() => onDelivery((item, outcome) => deliveredRef.current(item, outcome)), []);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSeq = 0;
    setMessages(null);
    setNewLineAt(null);
    setError("");
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
    /** What the room refused, from a chat call or a socket close. A final refusal stops the socket first, so the screen hears it once and nothing asks again. */
    const refused = (caught: unknown) => {
      if (stopped) return;
      if (final(caught)) stop();
      return caught instanceof ApiError && caught.status === 400 ? onGone(caught) : failed(caught);
    };
    const read = () => api<{ messages: ChatMessage[] }>("/api/chat/open", { roomId, after: lastSeq });
    const fetchNew = () =>
      read().then((reply) => {
        if (stopped) return;
        setError("");
        lastSeq = Math.max(lastSeq, ...reply.messages.map((m) => m.seq));
        setMessages((current) => current ?? []);
        arrived(reply.messages);
      }, refused);
    const connect = () => {
      if (stopped) return;
      let greeted = false;
      socket = new WebSocket(socketUrl(roomId));
      socket.onmessage = (event) => {
        const inbound = JSON.parse(String(event.data)) as { kind: string; message?: ChatMessage };
        if (inbound.kind === "hello") {
          greeted = true;
          fetchNew().then(sendQueued);
        }
        if (inbound.kind === "message" && inbound.message) {
          lastSeq = Math.max(lastSeq, inbound.message.seq);
          arrived([inbound.message]);
        }
      };
      socket.onclose = (event) => {
        if (stopped) return;
        if (event.code === NOT_A_MEMBER_CLOSE) return refused(new ApiError("not-a-member", 403));
        // The room closes a chat socket with this code only when the band revokes a guest's last live pass. The close reason is the room's word for it.
        if (event.code === NOT_ON_LINEUP_CLOSE) return refused(new ApiError(PASS_OVER.includes(event.reason) ? event.reason : "guest", 410));
        if (event.code === SIGNED_OUT_CLOSE) return onSignedOut();
        timer = setTimeout(connect, RECONNECT_MS);
        // A browser reports a refused upgrade only as close 1006, the same as no network. The chat's own call gives the refusal back, so a phone the room shut out stops asking.
        if (!greeted) read().catch((caught) => final(caught) && refused(caught));
      };
    };
    fetchNew();
    connect();
    return stop;
  }, [roomId]);

  useEffect(() => {
    if (entry && newLineAt === null) setNewLineAt(firstUnreadSeq(entry) ?? 0);
  }, [entry, newLineAt]);

  const last = messages?.[messages.length - 1];
  useEffect(() => {
    if (entry && last && entry.lastReadSeq < last.seq) markRead(last.seq);
  }, [entry?.lastReadSeq, last?.seq]);

  const send = (text: string, card?: BandSongCard) => queueMessage({ msgId: newMsgId(), roomId, text, at: Date.now(), from: me, card });

  return { messages, waiting: queue.filter((item) => item.roomId === roomId), newLineAt, error, failed, send };
}
