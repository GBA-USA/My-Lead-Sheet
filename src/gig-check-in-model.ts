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

/**
 * One open socket in the gig. `lastBeat` is null for a phone that has sent no beat, as a build from before the heartbeat.
 * `build` is the version id the phone reported when it joined, null for one that reported none.
 */
export type RosterSocket = { userId: string; lastBeat: number | null; build?: string | null };
export type Receipt = { userId: string; packRev: number; at: number };
/** `builds` holds one entry per fresh socket of the player: the id that phone reported, or null. */
export type RosterRow = { userId: string; connected: boolean; packRev: number | null; builds: (string | null)[] };
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
    const fresh = sockets.filter((socket) => socket.userId === userId && isFresh(socket, now));
    rows.push({ userId, connected: fresh.length > 0, packRev: newest === null ? null : newest.packRev, builds: fresh.map((socket) => socket.build ?? null) });
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

/** A phone that beats sends its first beat as it joins, so a socket with none this long after its join is a build without the heartbeat. */
export const FIRST_BEAT_WITHIN_MS = 2 * BEAT_EVERY_MS;

/** A socket as the Room's timer sees it: when it joined the gig, if it has. */
export type LookSocket = RosterSocket & { joinedAt: number | null };

/** Whether any socket in the gig has beaten, the only thing the timer can learn that a join, a close or a receipt does not tell the Room. */
export const anyBeat = (sockets: readonly RosterSocket[]) => sockets.some((socket) => socket.lastBeat !== null);

/**
 * When the Room should look at the gig's sockets again: the moment a beating socket would go quiet, at most
 * `LOOK_EVERY_MS` away while any socket has beaten (so beats that stop or start again are noticed), and once just after a
 * new join's first beat is due. A gig whose sockets never beat needs no more looks: a close tells the Room itself.
 */
export function nextLookAt(sockets: readonly LookSocket[], now: number): number | null {
  let next: number | null = null;
  const look = (at: number) => (next = next === null ? at : Math.min(next, at));
  for (const socket of sockets) {
    if (socket.lastBeat !== null) look(isFresh(socket, now) ? Math.min(socket.lastBeat + QUIET_AFTER_MS + 1, now + LOOK_EVERY_MS) : now + LOOK_EVERY_MS);
    else if (socket.joinedAt !== null && now < socket.joinedAt + FIRST_BEAT_WITHIN_MS) look(socket.joinedAt + FIRST_BEAT_WITHIN_MS);
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

const isBuilds = (builds: unknown) => Array.isArray(builds) && builds.every((build) => build === null || asBuildId(build) !== null);

/** A roster message from the room line, checked, or null. */
export function asRoster(message: { kind: string; [key: string]: unknown }): Roster | null {
  const { gigId, packRev, rows } = message;
  if (message.kind !== "roster" || typeof gigId !== "string" || typeof packRev !== "number" || !Array.isArray(rows)) return null;
  const good = rows.every(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      typeof row.userId === "string" &&
      typeof row.connected === "boolean" &&
      (row.packRev === null || typeof row.packRev === "number") &&
      isBuilds(row.builds),
  );
  return good ? { kind: "roster", gigId, packRev, rows: rows as RosterRow[] } : null;
}

// ---- Which version each phone runs ---------------------------------------------------------------------------------

/**
 * A version id: compiled into the page and published beside it as build.json. Anything else a phone reports, or the
 * published file holds, counts as no id. Two versions are the same only when their ids are equal; ids are never ranked.
 */
export const BUILD_ID_MAX = 64;
export const asBuildId = (value: unknown): string | null => (typeof value === "string" && value.length <= BUILD_ID_MAX ? value : null);

/**
 * Where one player's phones stand against the published id: current when every phone runs it, needing the update when
 * any differs, and out of reach when every phone that differs reported no id, since that code cannot show a prompt.
 */
export type VersionStand = "current" | "needs-update" | "cannot-be-reached";
export function versionOf(published: string, builds: readonly (string | null)[]): VersionStand {
  const differing = builds.filter((build) => build !== published);
  if (differing.length === 0) return "current";
  return differing.every((build) => build === null) ? "cannot-be-reached" : "needs-update";
}

/** The leader's ask, phone to Room, and the Room's prompt, Room to phone: the same kind both ways. */
export type UpdateNow = { kind: "update-now"; gigId: string };
/** The Room turns down an ask from a socket whose player is not leading the gig now. */
export type UpdateRefused = { kind: "update-refused"; gigId: string; refused: "not-leading" };
