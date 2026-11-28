import type { BandView } from "./bands-model";
import type { CheckIn } from "./gig-check-in-model";
import { downloaded, type GigStatus, type GigView } from "./gig-plan-model";
import { LOST_AFTER_MS } from "./links/attempt";
import { CHOICE_WORDS, ROUTE_WORDS, type LinkRoute, type RouteChoice } from "./routes";
import { rateRoute, type Rating } from "./sync-rating";

/**
 * What the leader's phone will hear from one follower's ping replies (PLAN.md 7.5, 7.6). Nothing produces this list
 * yet, so a feed passes an empty one. `heardAt` is on the clock the strip's `now` reads.
 */
export type PlayerStatus = { id: string; route: LinkRoute; spreadMs: number; p99Ms: number; lateRate: number; inTime: boolean; heardAt: number };

/**
 * Where one lineup player stands in a live gig: waiting (this phone has no feed yet, so nothing is known), leading it,
 * never heard yet, or heard over a route. A phone holding the Room's roster has a feed, and its players are never `waiting`.
 */
export type Live =
  | { kind: "waiting" }
  | { kind: "leading" }
  | { kind: "not-joined" }
  | { kind: "heard"; route: LinkRoute; spreadMs: number; p99Ms: number; lateRate: number; inTime: boolean; heardMsAgo: number };
type Heard = Extract<Live, { kind: "heard" }>;

/**
 * One lineup player as the status strip shows them. `live` is null until a live gig feeds it. `checkIn` is what the
 * Room's roster says of them tonight; a player without one is drawn exactly as before.
 */
export type Player = { id: string; name: string; leader: boolean; you: boolean; route: RouteChoice; downloaded: boolean; live: Live | null; checkIn?: CheckIn };

/** The roster's words for a player not heard over a route yet, and why one is Not synced. */
export const CHECK_IN_WORDS: Record<CheckIn["kind"], string> = { connected: "Connected", "not-connected": "Not connected", "not-synced": "Not synced" };
export const NOT_SYNCED_WHY: Record<Extract<CheckIn, { kind: "not-synced" }>["why"], string> = {
  never: "Has not downloaded tonight's set",
  older: "Has an older set. They need to download again.",
};

/** The gig's lineup in order, named from the band's members. A lineup id that is no longer a member has no name to show, so it has no face. */
export function playersFrom(gig: GigView, band: BandView, me: string): Player[] {
  const names = new Map(band.members.map((member) => [member.userId, member.name]));
  return gig.gig.lineup.flatMap((id) => {
    const name = names.get(id);
    if (name === undefined) return [];
    return [{ id, name, leader: id === gig.gig.leader, you: id === me, route: gig.gig.route, downloaded: downloaded(gig, id), live: null }];
  });
}

/** The lineup joined with what the live leader heard. The newest status per player wins, so a re-add during a reconnect makes no second row. */
export function livePlayers(players: readonly Player[], leader: string, statuses: readonly PlayerStatus[], now: number): Player[] {
  const newest = new Map<string, PlayerStatus>();
  for (const status of statuses) if ((newest.get(status.id)?.heardAt ?? -Infinity) < status.heardAt) newest.set(status.id, status);
  return players.map((p): Player => {
    const status = newest.get(p.id);
    const live: Live =
      p.id === leader
        ? { kind: "leading" }
        : status === undefined
          ? { kind: "not-joined" }
          : { kind: "heard", route: status.route, spreadMs: status.spreadMs, p99Ms: status.p99Ms, lateRate: status.lateRate, inTime: status.inTime, heardMsAgo: Math.max(0, now - status.heardAt) };
    return { ...p, leader: p.id === leader, live };
  });
}

/** A live gig this phone has no feed for yet: the same lineup, each player waiting, so no route, sync or Heard is made up. */
export function waitingPlayers(players: readonly Player[]): Player[] {
  return players.map((p) => ({ ...p, live: { kind: "waiting" } }));
}

/** During a live gig only the admin and the leader see every player's route and sync (PLAN.md 6). No one leads a gig with no leader. */
export const seesBandStatus = (admin: boolean, me: string | undefined, leader: string | undefined) => admin || (me !== undefined && me === leader);

/**
 * Whether this phone may open Band status. Before or after a gig, anyone in the band may. During one, only the band's
 * admin and the gig's leader. Both come from the band and the gig, not from a live feed, so a missing feed shuts no one out.
 */
export function opensBandStatus(status: GigStatus, me: string | undefined, roles: { admin: boolean; leader: string | undefined }): boolean {
  return status !== "live" || seesBandStatus(roles.admin, me, roles.leader);
}

export function liveRating(live: Heard): Rating {
  return rateRoute({ spreadMs: live.spreadMs, p99Ms: live.p99Ms, lateRate: live.lateRate, ageDays: 0, tries: [true] });
}

export function syncBars(spreadMs: number): 4 | 3 | 2 | 0 {
  if (spreadMs <= 2) return 4;
  if (spreadMs <= 5) return 3;
  if (spreadMs <= 8) return 2;
  return 0;
}

export function barsText(spreadMs: number): string {
  if (syncBars(spreadMs) === 0) return "Out of sync";
  return "";
}

/** Out of sync, not steady, or not heard for as long as the leader keeps a quiet link (PLAN.md 7.5, 7.13). */
export function isAmber(p: Player): boolean {
  const live = p.live;
  return live?.kind === "heard" && (syncBars(live.spreadMs) === 0 || liveRating(live) === "Not steady" || live.heardMsAgo >= LOST_AFTER_MS);
}

export function heardText(ms: number): string {
  return `Heard ${Math.round(ms / 1000)} s ago`;
}

export type Tone = "steady" | "amber" | "grey";

export type StatusRow = {
  id: string;
  name: string;
  leader: boolean;
  you: boolean;
  routeText: string;
  bars: number | null;
  barsText: string;
  downloaded: string;
  inTime: string;
  heard: string;
  tone: Tone;
  /** Why a player reads Not synced. Present only on such a row. */
  checkInWhy?: string;
};

function liveText(p: Player): Pick<StatusRow, "routeText" | "bars" | "barsText" | "inTime" | "heard" | "tone" | "checkInWhy"> {
  const live = p.live;
  if (live === null) return { routeText: CHOICE_WORDS[p.route].name, bars: null, barsText: "", inTime: "", heard: "Heard —", tone: "steady" };
  if (live.kind === "waiting" || live.kind === "leading") return { routeText: "", bars: null, barsText: "", inTime: "", heard: "", tone: "steady" };
  if (live.kind === "not-joined" && p.checkIn) {
    const checkIn = p.checkIn;
    const row = { routeText: CHECK_IN_WORDS[checkIn.kind], bars: null, barsText: "", inTime: "", heard: "", tone: checkIn.kind === "connected" ? ("steady" as const) : ("amber" as const) };
    return checkIn.kind === "not-synced" ? { ...row, checkInWhy: NOT_SYNCED_WHY[checkIn.why] } : row;
  }
  if (live.kind === "not-joined") return { routeText: "Not joined", bars: null, barsText: "", inTime: "", heard: "", tone: "grey" };
  return {
    routeText: `${ROUTE_WORDS[live.route]} · ${liveRating(live)}`,
    bars: syncBars(live.spreadMs),
    barsText: barsText(live.spreadMs),
    inTime: live.inTime ? "In time ✓" : "",
    heard: heardText(live.heardMsAgo),
    tone: isAmber(p) ? "amber" : "steady",
  };
}

export function statusRows(players: readonly Player[]): StatusRow[] {
  return players.map((p) => ({ id: p.id, name: p.name, leader: p.leader, you: p.you, downloaded: p.downloaded ? "Downloaded ✓" : "Not yet", ...liveText(p) }));
}

/**
 * The panel's one line under the rows: before the gig, sync waits for it; live with no feed yet, it waits for the players;
 * live with no one heard, the leader is alone.
 */
export function panelLine(players: readonly Player[]): string | null {
  if (players.every((p) => p.live === null)) return "Sync and timing show during a live gig.";
  if (players.every((p) => p.live?.kind === "waiting")) return "Live sync and timing will show once players are connected.";
  const leading = players.find((p) => p.live?.kind === "leading");
  const here = (p: Player) => p.live?.kind === "heard" || (p.live?.kind === "not-joined" && p.checkIn !== undefined && p.checkIn.kind !== "not-connected");
  if (leading?.you && !players.some(here)) return "Just you so far";
  return null;
}
