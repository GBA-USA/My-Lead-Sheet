/**
 * Gig check-in, the rule the Room and the leader's phone share: which lineup players are connected tonight and which
 * pack they hold. Pure functions only, with no imports, so the Worker, the phone and a check all load this one file.
 */

/** The heartbeat a phone in a gig sends on the room socket: one fixed text frame, answered with the same bytes. */
export const BEAT = "beat";
export const BEAT_EVERY_MS = 3000;
/**
 * A socket that has beaten and then stays quiet this long counts as gone. It is the phone's `LOST_AFTER_MS`, the same
 * 10 s the leader already waits before a quiet link reads "not heard"; the phone ties the two at compile time.
 */
export const QUIET_AFTER_MS = 10_000;
/** While any socket beats, the Room looks again at least this often, so a quiet one is noticed and a resumed one too. */
export const LOOK_EVERY_MS = 5000;

/** One open socket in the gig. `lastBeat` is null for a phone that has sent no beat, as a build from before the heartbeat. */
export type RosterSocket = { userId: string; lastBeat: number | null };
export type Receipt = { userId: string; packRev: number; at: number };
export type RosterRow = { userId: string; connected: boolean; packRev: number | null };
export type Roster = { kind: "roster"; gigId: string; packRev: number; rows: RosterRow[] };
export type RosterAsk = { kind: "roster-ask"; gigId: string };

/** Where one lineup player stands tonight, as the leader's phone shows them. */
export type CheckIn = { kind: "connected" } | { kind: "not-connected" } | { kind: "not-synced"; why: "never" | "older" };

export const isFresh = (socket: RosterSocket, now: number) => socket.lastBeat === null || now - socket.lastBeat <= QUIET_AFTER_MS;

/**
 * One row per lineup player, in lineup order and each once: connected when any of their sockets is fresh, and the pack
 * rev of their newest receipt. A socket or a receipt of someone off the lineup makes no row.
 */
export function rosterRows(lineup: readonly string[], sockets: readonly RosterSocket[], receipts: readonly Receipt[], now: number): RosterRow[] {
  const rows: RosterRow[] = [];
  const seen = new Set<string>();
  for (const userId of lineup) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    let newest: Receipt | null = null;
    for (const receipt of receipts) {
      if (receipt.userId !== userId) continue;
      if (newest === null || receipt.at > newest.at || (receipt.at === newest.at && receipt.packRev > newest.packRev)) newest = receipt;
    }
    rows.push({ userId, connected: sockets.some((socket) => socket.userId === userId && isFresh(socket, now)), packRev: newest === null ? null : newest.packRev });
  }
  return rows;
}

/** A row on the leader's phone: not connected, connected without tonight's pack (never downloaded, or an older one), or connected. */
export function checkInOf(row: RosterRow, packRev: number): CheckIn {
  if (!row.connected) return { kind: "not-connected" };
  if (row.packRev === null) return { kind: "not-synced", why: "never" };
  if (row.packRev !== packRev) return { kind: "not-synced", why: "older" };
  return { kind: "connected" };
}

/** How many players are not connected and synced, leaving out `except`, the phone's own player who leads. */
export const notReady = (rows: readonly RosterRow[], packRev: number, except: string | null) =>
  rows.filter((row) => row.userId !== except && checkInOf(row, packRev).kind !== "connected").length;

/**
 * When the Room should look at the gig's sockets again: the moment the freshest-looking beating socket would go quiet,
 * and at most `LOOK_EVERY_MS` away while any socket has beaten, so beats that stop or start again are noticed. A gig whose
 * sockets have never beaten needs no look: a close tells the Room itself.
 */
export function nextLookAt(sockets: readonly RosterSocket[], now: number): number | null {
  let next: number | null = null;
  for (const socket of sockets) {
    if (socket.lastBeat === null) continue;
    const at = isFresh(socket, now) ? Math.min(socket.lastBeat + QUIET_AFTER_MS + 1, now + LOOK_EVERY_MS) : now + LOOK_EVERY_MS;
    next = next === null ? at : Math.min(next, at);
  }
  return next;
}

/** A short fingerprint of what a roster says, so the Room sends a socket a roster only when it differs from the last one it sent there. */
export function rosterKey(roster: Roster): string {
  const text = JSON.stringify([roster.gigId, roster.packRev, roster.rows]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}:${hash.toString(36)}`;
}

/** A roster message from the room line, checked, or null. */
export function asRoster(message: { kind: string; [key: string]: unknown }): Roster | null {
  const { gigId, packRev, rows } = message;
  if (message.kind !== "roster" || typeof gigId !== "string" || typeof packRev !== "number" || !Array.isArray(rows)) return null;
  const good = rows.every(
    (row) => typeof row === "object" && row !== null && typeof row.userId === "string" && typeof row.connected === "boolean" && (row.packRev === null || typeof row.packRev === "number"),
  );
  return good ? { kind: "roster", gigId, packRev, rows: rows as RosterRow[] } : null;
}
