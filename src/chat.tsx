import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NOT_A_MEMBER_CLOSE, firstUnreadSeq, isMuted, newMsgId, previewText, unread, withMessages, type ChatEntry, type ChatMessage } from "./chat-model";
import { onDelivery, onQueueChange, queueMessage, queuedMessages, sendQueued, type Delivery } from "./chat-queue";
export { queueOwner } from "./chat-queue";
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
};

export const chatMessage = (error: unknown) => {
  const reason = error instanceof ApiError ? (error.status >= 500 ? "offline" : error.reason) : "";
  return MESSAGES[reason] ?? "Something went wrong. Try again.";
};

/** A refusal that means the room is closed to this player for good. */
export const closedRoom = (error: unknown) => error instanceof ApiError && ["not-a-member", "no-band", "not-friends"].includes(error.reason);

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

/** The signed-in player's rooms, one copy for the Messages list, a room, the gear and the band page's Chat tab. */
export type Inbox = { chats: ChatEntry[] | null; failed: boolean; unread: number; change: ChangeEntry };

export function useInbox(me: string | null, screen: Route["name"], onSignedOut: () => void): Inbox {
  const [chats, setChats] = useState<ChatEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  const listed = INBOX_SCREENS.has(screen);

  useEffect(() => {
    setChats(null);
    setFailed(false);
  }, [me]);

  useEffect(() => {
    if (!me || !listed) return;
    let stopped = false;
    api<{ chats: ChatEntry[] }>("/api/chat").then(
      (reply) => {
        if (stopped) return;
        setFailed(false);
        setChats((held) => merged(held, reply.chats));
      },
      (caught) => {
        if (stopped) return;
        if (caught instanceof ApiError && caught.status === 401) return onSignedOut();
        setFailed(true);
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

  const change = useCallback<ChangeEntry>((roomId, update) => setChats((current) => current?.map((c) => (c.roomId === roomId ? update(c) : c)) ?? null), []);

  useEffect(() => onDelivery((item, outcome) => "message" in outcome && change(item.roomId, (c) => withLast(c, outcome.message))), []);

  const now = Date.now();
  return { chats, failed, unread: chats?.reduce((total, c) => total + (isMuted(c, now) ? 0 : unread(c)), 0) ?? 0, change };
}

/** The DM room with a friend or bandmate, made on the server if it is not there yet. */
export const openDm = (userId: string) => api<{ roomId: string }>("/api/chat/dm", { userId }).then((reply) => reply.roomId);

/**
 * One room's messages, the messages waiting for signal, read marking and the live socket. `entry` is the room's row on
 * the Messages list, `onEntry` keeps that row in step. `onGone` hears a refusal that means the room is closed to this player.
 */
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
    const fetchNew = () =>
      api<{ messages: ChatMessage[] }>("/api/chat/open", { roomId, after: lastSeq }).then((reply) => {
        if (stopped) return;
        setError("");
        lastSeq = Math.max(lastSeq, ...reply.messages.map((m) => m.seq));
        setMessages((current) => current ?? []);
        arrived(reply.messages);
      }, failed);
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(socketUrl(roomId));
      socket.onmessage = (event) => {
        const inbound = JSON.parse(String(event.data)) as { kind: string; message?: ChatMessage };
        if (inbound.kind === "hello") fetchNew().then(sendQueued);
        if (inbound.kind === "message" && inbound.message) {
          lastSeq = Math.max(lastSeq, inbound.message.seq);
          arrived([inbound.message]);
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

  const last = messages?.[messages.length - 1];
  useEffect(() => {
    if (entry && last && entry.lastReadSeq < last.seq) markRead(last.seq);
  }, [entry?.lastReadSeq, last?.seq]);

  const send = (text: string) => queueMessage({ msgId: newMsgId(), roomId, text, at: Date.now(), from: me });

  return { messages, waiting: queue.filter((item) => item.roomId === roomId), newLineAt, error, failed, send };
}
