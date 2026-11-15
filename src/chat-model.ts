export type ChatKind = "dm" | "band";

/** One row of the Messages list, as the Directory's inbox keeps it (PLAN.md 5). Unread is `lastSeq - lastReadSeq`. */
export type ChatEntry = { roomId: string; kind: ChatKind; title: string; lastSeq: number; lastReadSeq: number; mutedUntil: number | null; preview: string; lastAt: number };

export type ChatMessage = { seq: number; msgId: string; fromId: string; fromName: string; text: string; at: number };

/**
 * A message written on this phone that the room has not confirmed yet. `msgId` is made here, so a resend stores nothing
 * twice, and `from` is the account that wrote it, so another account on the same phone never sends it.
 */
export type Queued = { msgId: string; roomId: string; text: string; at: number; from: string };

export const MAX_MESSAGE_CHARS = 2000;
/** The close code a room gives a socket whose player is no longer an active member. */
export const NOT_A_MEMBER_CLOSE = 4403;
export const MUTE_8H = 8 * 3600 * 1000;
export const MUTE_1W = 7 * 24 * 3600 * 1000;
/** "Always" has to survive JSON, so it is the largest safe integer rather than Infinity. */
export const MUTE_ALWAYS = Number.MAX_SAFE_INTEGER;

export type MuteChoice = "8h" | "1w" | "always" | "off";

export const MUTE_LABELS: Record<MuteChoice, string> = { "8h": "8 hours", "1w": "1 week", always: "Always", off: "Unmute" };

export function mutedUntilFor(choice: MuteChoice, now: number): number | null {
  if (choice === "8h") return now + MUTE_8H;
  if (choice === "1w") return now + MUTE_1W;
  if (choice === "always") return MUTE_ALWAYS;
  return null;
}

/** A band's thread is quiet on stage during a live gig, whatever its mute says (PLAN.md 8.3). */
export function isMuted(c: ChatEntry, now: number, gigLive = false): boolean {
  if (gigLive && c.kind === "band") return true;
  return c.mutedUntil !== null && now < c.mutedUntil;
}

export const unread = (c: ChatEntry) => Math.max(0, c.lastSeq - c.lastReadSeq);

export const sortChats = (list: ChatEntry[]) => [...list].sort((a, b) => b.lastAt - a.lastAt);

/** The seq the "New messages" line goes above, or null when nothing is unread. */
export const firstUnreadSeq = (c: ChatEntry) => (unread(c) > 0 ? c.lastReadSeq + 1 : null);

export const side = (m: ChatMessage, me: string) => (m.fromId === me ? "mine" : "theirs");

export const nameAbove = (m: ChatMessage, me: string) => (m.fromId === me ? "You" : m.fromName);

/** Both lists as one thread, in seq order, with a message that arrived twice kept once. */
export function withMessages(have: ChatMessage[], more: ChatMessage[]): ChatMessage[] {
  const bySeq = new Map(have.map((m) => [m.seq, m]));
  for (const m of more) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export const newMsgId = () => crypto.randomUUID().replace(/-/g, "");

export function enqueue(queue: Queued[], item: Queued): Queued[] {
  const text = item.text.trim();
  if (!text) return queue;
  return [...queue, { ...item, text }];
}

export const withoutQueued = (queue: Queued[], msgId: string) => queue.filter((item) => item.msgId !== msgId);

/**
 * Sends the queue in order, oldest first. A send the server never answered stops the run, so the rest wait for the
 * next try and arrive in order. A send the server refused is dropped, since trying again can't change its answer.
 */
export async function flushQueue(
  queue: Queued[],
  send: (item: Queued) => Promise<ChatMessage>,
  unanswered: (error: unknown) => boolean,
  report: { sent(item: Queued, message: ChatMessage): void; dropped(item: Queued, error: unknown): void },
): Promise<Queued[]> {
  let left = queue;
  for (const item of queue) {
    try {
      report.sent(item, await send(item));
    } catch (error) {
      if (unanswered(error)) break;
      report.dropped(item, error);
    }
    left = withoutQueued(left, item.msgId);
  }
  return left;
}
