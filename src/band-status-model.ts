import type { BandView } from "./bands-model";
import { downloaded, type GigStatus, type GigView } from "./gig-plan-model";
import { LOST_AFTER_MS } from "./links/attempt";
import { CHOICE_WORDS, ROUTE_WORDS, type LinkRoute, type RouteChoice } from "./routes";
import { rateRoute, type Rating } from "./sync-rating";

/**
 * What the leader's phone hears from one follower's ping replies (PLAN.md 7.5, 7.6). The leader's fan-out makes the
 * list and copies it to the room every 10 s for the admin. `heardAt` is on the clock the strip's `now` reads.
 */
export type PlayerStatus = { id: string; route: LinkRoute; spreadMs: number; p99Ms: number; lateRate: number; inTime: boolean; heardAt: number };

/** Where one lineup player stands in a live gig: leading it, never heard yet, or heard over a route. */
export type Live =
  | { kind: "leading" }
  | { kind: "not-joined" }
  | { kind: "heard"; route: LinkRoute; spreadMs: number; p99Ms: number; lateRate: number; inTime: boolean; heardMsAgo: number };
type Heard = Extract<Live, { kind: "heard" }>;

/** One lineup player as the status strip shows them. `live` is null until a live gig feeds it. */
export type Player = { id: string; name: string; leader: boolean; you: boolean; route: RouteChoice; downloaded: boolean; live: Live | null };

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

/** During a live gig only the admin and the leader see every player's route and sync (PLAN.md 6). */
export const seesBandStatus = (admin: boolean, me: string, leader: string) => admin || me === leader;

/**
 * Whether this phone may open Band status. Before or after a gig, anyone in the band may. During one, only the admin
 * and the live leader, and only on a phone whose feed says who those are, so a live gig with no feed opens for no one.
 */
export function opensBandStatus(status: GigStatus, me: string, feed: { admin: boolean; leader: string } | undefined): boolean {
  if (status !== "live") return true;
  return feed !== undefined && seesBandStatus(feed.admin, me, feed.leader);
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
};

function liveText(p: Player): Pick<StatusRow, "routeText" | "bars" | "barsText" | "inTime" | "heard" | "tone"> {
  const live = p.live;
  if (live === null) return { routeText: CHOICE_WORDS[p.route].name, bars: null, barsText: "", inTime: "", heard: "Heard —", tone: "steady" };
  if (live.kind === "leading") return { routeText: "", bars: null, barsText: "", inTime: "", heard: "", tone: "steady" };
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

/** The panel's one line under the rows: before the gig, sync waits for it; live with no one heard, the leader is alone. */
export function panelLine(players: readonly Player[]): string | null {
  if (players.every((p) => p.live === null)) return "Sync and timing show during a live gig.";
  const leading = players.find((p) => p.live?.kind === "leading");
  if (leading?.you && !players.some((p) => p.live?.kind === "heard")) return "Just you so far";
  return null;
}
