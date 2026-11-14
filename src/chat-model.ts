export type ChatKind = "self" | "dm" | "band";
export type ChatEntry = { roomId: string; kind: ChatKind; title: string; lastSeq: number; lastReadSeq: number; mutedUntil: number | null; preview: string; lastAt: number };
export type ChatMessage = { seq: number; fromId: string; fromName: string; text: string; at: number };
export type Outgoing = { localId: string; roomId: string; text: string; state: "waiting" | "sent" };

export const ME = { id: "u-alex", name: "Alex" };

export const fixtureChats: ChatEntry[] = [
  { roomId: "r-self", kind: "self", title: "Notes to self", lastSeq: 1, lastReadSeq: 1, mutedUntil: null, preview: "Remember the gig", lastAt: 1699998000000 },
  { roomId: "r-band-1", kind: "band", title: "The Porch Cats", lastSeq: 12, lastReadSeq: 9, mutedUntil: null, preview: "Dana: sounds good", lastAt: 1700000000000 },
  { roomId: "r-dm-mike", kind: "dm", title: "Mike", lastSeq: 5, lastReadSeq: 5, mutedUntil: null, preview: "Mike: thanks!", lastAt: 1699999000000 },
];

export const fixtureMessages: ChatMessage[] = [
  { seq: 1, fromId: "u-alex", fromName: "Alex", text: "Hey everyone!", at: 1700000100000 },
  { seq: 2, fromId: "u-mike", fromName: "Mike", text: "hi alex", at: 1700000200000 },
  { seq: 3, fromId: "u-dana", fromName: "Dana", text: "what's up", at: 1700000300000 },
  { seq: 4, fromId: "u-alex", fromName: "Alex", text: "ready for rehearsal?", at: 1700000400000 },
  { seq: 5, fromId: "u-mike", fromName: "Mike", text: "yep let's go", at: 1700000500000 },
  { seq: 6, fromId: "u-dana", fromName: "Dana", text: "I'll bring snacks", at: 1700000600000 },
  { seq: 7, fromId: "u-alex", fromName: "Alex", text: "awesome", at: 1700000700000 },
  { seq: 8, fromId: "u-mike", fromName: "Mike", text: "see you soon", at: 1700000800000 },
  { seq: 9, fromId: "u-dana", fromName: "Dana", text: "heading over now", at: 1700000900000 },
  { seq: 10, fromId: "u-alex", fromName: "Alex", text: "great, door's open", at: 1700001000000 },
  { seq: 11, fromId: "u-dana", fromName: "Dana", text: "sounds good", at: 1700001100000 },
  { seq: 12, fromId: "u-mike", fromName: "Mike", text: "almost there", at: 1700001200000 },
];

export function unread(c: ChatEntry): number {
  return Math.max(0, c.lastSeq - c.lastReadSeq);
}

export function sortChats(list: ChatEntry[]): ChatEntry[] {
  return [...list].sort((a, b) => b.lastAt - a.lastAt);
}

export function isBold(c: ChatEntry): boolean {
  return unread(c) > 0;
}

export const MUTE_8H = 8 * 3600 * 1000;
export const MUTE_1W = 7 * 24 * 3600 * 1000;

export function mute(c: ChatEntry, choice: "8h" | "1w" | "always", now: number): ChatEntry {
  let mutedUntil: number | null;
  if (choice === "8h") {
    mutedUntil = now + MUTE_8H;
  } else if (choice === "1w") {
    mutedUntil = now + MUTE_1W;
  } else {
    mutedUntil = Infinity;
  }
  return { ...c, mutedUntil };
}

export function isMuted(c: ChatEntry, now: number, gigLive: boolean): boolean {
  if (gigLive && c.kind === "band") {
    return true;
  }
  return c.mutedUntil !== null && now < c.mutedUntil;
}

export function firstUnreadSeq(c: ChatEntry): number | null {
  if (unread(c) > 0) {
    return c.lastReadSeq + 1;
  }
  return null;
}

export function side(m: ChatMessage): "mine" | "theirs" {
  return m.fromId === ME.id ? "mine" : "theirs";
}

export function nameAbove(m: ChatMessage): string {
  return m.fromId === ME.id ? "You" : m.fromName;
}

export function queueSend(q: Outgoing[], roomId: string, text: string, online: boolean, localId: string): Outgoing[] {
  if (!text || !text.trim()) {
    return q;
  }
  return [...q, { localId, roomId, text, state: online ? "sent" : "waiting" }];
}

export function flush(q: Outgoing[]): Outgoing[] {
  return q.map(m => ({ ...m, state: "sent" as const }));
}
