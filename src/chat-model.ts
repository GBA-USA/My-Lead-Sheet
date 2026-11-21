export type ChatKind = "dm" | "band";

/** One row of the Messages list, as the Directory's inbox keeps it (PLAN.md 5). Unread is `lastSeq - lastReadSeq`. */
export type ChatEntry = { roomId: string; kind: ChatKind; title: string; lastSeq: number; lastReadSeq: number; mutedUntil: number | null; preview: string; lastAt: number };

/**
 * What a message is: words, a note from the app, or a card for a song, setlist or gig (PLAN.md 5). A `band-song` card
 * points at a song in the band's library and carries only its one-line `text`, never the chart, so a phone that does not
 * know the kind shows the line.
 */
export type MessageKind = "text" | "system" | "song" | "setlist" | "gig" | "band-song";

/**
 * `ref` is what a card points at (a song share id, a setlist id, a gig id or a band song id) and null for words.
 * `mentions` are the ids of the band members the words name with `@`, found by the room when it stored them.
 */
export type ChatMessage = { seq: number; msgId: string; fromId: string; fromName: string; text: string; at: number; kind: MessageKind; ref: string | null; mentions: string[] };

/** A card a player posts into a band thread with `POST /api/chat/send`, pointing at one of the band's songs. */
export type BandSongCard = { kind: "band-song"; songId: string };

export const bandSongLine = (song: { title: string; artist: string }) => `🎵 ${song.title}${song.artist ? ` · ${song.artist}` : ""}`;

/**
 * A message written on this phone that the room has not confirmed yet. `msgId` is made here, so a resend stores nothing
 * twice, and `from` is the account that wrote it, so another account on the same phone never sends it. A song waits
 * with its whole send in `song` and its title in `text`; a band song waits with its `card` and its line in `text`.
 */
export type Queued = { msgId: string; roomId: string; text: string; at: number; from: string; song?: Record<string, unknown>; card?: BandSongCard };

/** A message as one line, for the Messages list: a card shows what it holds, never its JSON. */
export function previewText(m: Pick<ChatMessage, "kind" | "text">): string {
  if (m.kind === "setlist") {
    try {
      return `📋 ${String(JSON.parse(m.text).name)}`;
    } catch {
      return "📋 A setlist";
    }
  }
  if (m.kind !== "song") return m.text;
  try {
    return `🎵 ${String(JSON.parse(m.text).song.title)}`;
  } catch {
    return "🎵 A song";
  }
}

/** A run of a message's words, or a link in it. Only http and https become links; `external` is another site. */
export type TextPart = { text: string } | { text: string; href: string; external: boolean };

const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?'")\]}]+$/;

/** The message as words and links, in order. Joined, the parts' text is the message unchanged. */
export function linkify(text: string, origin: string): TextPart[] {
  const parts: TextPart[] = [];
  let done = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const start = match.index;
    const raw = match[0].replace(TRAILING_PUNCTUATION, "");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (start > done) parts.push({ text: text.slice(done, start) });
    parts.push({ text: raw, href: url.href, external: url.origin !== origin });
    done = start + raw.length;
  }
  if (done < text.length) parts.push({ text: text.slice(done) });
  return parts;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * The ids of the members the words name as `@<name>`, once each, in order. At each `@` the longest name that fits wins,
 * and a name has to end where a word ends. An `@` inside a word, as in an email address, names nobody.
 */
export function parseMentions(text: string, members: { userId: string; name: string }[]): string[] {
  const longestFirst = members.filter((member) => member.name).map((member) => ({ userId: member.userId, name: member.name.toLowerCase() })).sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const named = new Set<string>();
  for (let at = lower.indexOf("@"); at !== -1; at = lower.indexOf("@", at + 1)) {
    if (at > 0 && WORD_CHAR.test(lower[at - 1])) continue;
    const rest = lower.slice(at + 1);
    const hit = longestFirst.find((member) => rest.startsWith(member.name) && !WORD_CHAR.test(rest.charAt(member.name.length)));
    if (hit) named.add(hit.userId);
  }
  return [...named];
}

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
