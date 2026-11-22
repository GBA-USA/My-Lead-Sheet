import type { BandMs } from "../band-time";
import { NOT_A_MEMBER_CLOSE } from "../chat-model";
import { NOT_ON_LINEUP_CLOSE } from "./link";
import { LINK_LOST, WiredLink, asWire } from "./wire";

export const WAITING_FOR_LEADER = "Waiting for the leader";
export const NO_SIGNAL = "No signal";

/** The room's own close codes (4000 and up) mean it refused this phone, so the line stops trying. */
const REFUSED_WORDS: Record<number, string> = {
  4401: "Sign in to join the gig",
  [NOT_A_MEMBER_CLOSE]: "You're not in this band",
  [NOT_ON_LINEUP_CLOSE]: "You're not on tonight's lineup",
};
export const refusedWords = (code: number) => REFUSED_WORDS[code] ?? NO_SIGNAL;

const ROOM_RETRY_MS = 3000;

/** A message from the room, or the line's own `room-down` (no network, it retries) and `room-refused` (it stopped). */
export type RoomIn = { kind: string; [key: string]: unknown };
export type RoomState = "connecting" | "open" | "down" | "refused";

/** The band room's socket, kept up across drops. Links ride on it: introductions for data channels, and the server route itself. */
export interface RoomLine {
  readonly state: RoomState;
  send(message: object): boolean;
  listen(cb: (message: RoomIn) => void): () => void;
  close(): void;
}

export function roomLine(url: string): RoomLine {
  let ws: WebSocket | null = null;
  let state: RoomState = "connecting";
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const listeners = new Set<(message: RoomIn) => void>();
  const tell = (message: RoomIn) => [...listeners].forEach((cb) => cb(message));

  const lost = (socket: WebSocket | null, code: number) => {
    if (stopped || ws !== socket) return;
    ws = null;
    if (code >= 4000) {
      state = "refused";
      return tell({ kind: "room-refused", code });
    }
    state = "down";
    retry = setTimeout(connect, ROOM_RETRY_MS);
    tell({ kind: "room-down" });
  };

  function connect() {
    if (retry) clearTimeout(retry);
    retry = null;
    if (stopped) return;
    state = "connecting";
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      ws = null;
      return lost(null, 1006);
    }
    ws = socket;
    socket.addEventListener("message", (event) => {
      if (ws !== socket || typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null || typeof (message as RoomIn).kind !== "string") return;
      if ((message as RoomIn).kind === "hello") state = "open";
      tell(message as RoomIn);
    });
    socket.addEventListener("close", (event) => lost(socket, event.code));
  }
  connect();

  return {
    get state() {
      return state;
    },
    send(message) {
      if (state !== "open" || ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(message));
      return true;
    },
    listen(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close() {
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = null;
      ws?.close();
      ws = null;
      listeners.clear();
    },
  };
}

/** The server route: the same link, carried by the room to one socket (`peer`). It is open whenever the room is. */
export function serverLink(room: RoomLine, peer: string, bandNow: (() => BandMs) | null): WiredLink {
  let stop = () => {};
  const link = new WiredLink("server", (wire) => room.send({ kind: "link", to: peer, body: wire }), () => stop(), bandNow);
  stop = room.listen((message) => {
    if (message.kind === "link" && message.from === peer) {
      const wire = asWire(message.body);
      if (wire) link.receive(wire);
    } else if ((message.kind === "error" && message.to === peer) || message.kind === "room-down" || message.kind === "room-refused") {
      link.end(LINK_LOST);
    }
  });
  if (room.state === "open") link.opened();
  else link.end(NO_SIGNAL);
  return link;
}
