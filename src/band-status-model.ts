import type { BandView } from "./bands-model";
import { downloaded, type GigView } from "./gig-plan-model";
import { CHOICE_WORDS, type RouteChoice } from "./routes";
import { rateRoute, type Rating } from "./sync-rating";

/** One lineup player as the status strip shows them. The sync fields stay undefined until a live gig feeds them (C23). */
export type Player = {
  id: string;
  name: string;
  leader: boolean;
  you: boolean;
  route: RouteChoice;
  downloaded: boolean;
  spreadMs?: number;
  p99Ms?: number;
  lateRate?: number;
  inTime?: boolean;
  heardMsAgo?: number;
};

/** The gig's lineup in order, named from the band's members. A lineup id that is no longer a member has no name to show, so it has no face. */
export function playersFrom(gig: GigView, band: BandView, me: string): Player[] {
  const names = new Map(band.members.map((member) => [member.userId, member.name]));
  return gig.gig.lineup.flatMap((id) => {
    const name = names.get(id);
    if (name === undefined) return [];
    return [{ id, name, leader: id === gig.gig.leader, you: id === me, route: gig.gig.route, downloaded: downloaded(gig, id) }];
  });
}

export function liveRating(p: Player): Rating {
  return rateRoute({
    spreadMs: p.spreadMs,
    p99Ms: p.p99Ms,
    lateRate: p.lateRate,
    ageDays: 0,
    tries: [true],
  });
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

export function isAmber(p: Player): boolean {
  return p.spreadMs !== undefined && (syncBars(p.spreadMs) === 0 || liveRating(p) === "Not steady");
}

export function heardText(ms: number): string {
  return `Heard ${Math.round(ms / 1000)} s ago`;
}

/** One panel row. `bars` is null until a live gig measures the player's sync. */
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
  amber: boolean;
};

export function statusRows(players: Player[]): StatusRow[] {
  return players.map((p) => {
    const word = CHOICE_WORDS[p.route].name;
    const spread = p.spreadMs;
    return {
      id: p.id,
      name: p.name,
      leader: p.leader,
      you: p.you,
      routeText: spread === undefined ? word : `${word} · ${liveRating(p)}`,
      bars: spread === undefined ? null : syncBars(spread),
      barsText: spread === undefined ? "" : barsText(spread),
      downloaded: p.downloaded ? "Downloaded ✓" : "Not yet",
      inTime: p.inTime ? "In time ✓" : "",
      heard: p.heardMsAgo === undefined ? "Heard —" : heardText(p.heardMsAgo),
      amber: isAmber(p),
    };
  });
}
