import { rateRoute, type Rating } from "./sync-rating";

export type LiveRoute = "wifi" | "internet" | "relay" | "server";

export const LIVE_ROUTE_WORDS: Record<LiveRoute, string> = {
  wifi: "Wi-Fi link",
  internet: "Over the internet",
  relay: "Through the relay",
  server: "Through the server",
};

export type Player = {
  id: string;
  name: string;
  route: LiveRoute;
  spreadMs: number;
  p99Ms: number;
  lateRate: number;
  downloaded: boolean;
  inTime: boolean;
  heardMsAgo: number;
};

export const fixturePlayers: Player[] = [
  {
    id: "alex",
    name: "Alex",
    route: "wifi",
    spreadMs: 1.5,
    p99Ms: 3,
    lateRate: 0,
    downloaded: true,
    inTime: true,
    heardMsAgo: 500,
  },
  {
    id: "mike",
    name: "Mike",
    route: "wifi",
    spreadMs: 2,
    p99Ms: 4,
    lateRate: 0,
    downloaded: true,
    inTime: true,
    heardMsAgo: 1000,
  },
  {
    id: "dana",
    name: "Dana",
    route: "internet",
    spreadMs: 3,
    p99Ms: 5,
    lateRate: 0,
    downloaded: true,
    inTime: true,
    heardMsAgo: 2000,
  },
  {
    id: "sam",
    name: "Sam",
    route: "relay",
    spreadMs: 4,
    p99Ms: 6,
    lateRate: 0,
    downloaded: false,
    inTime: true,
    heardMsAgo: 1500,
  },
  {
    id: "jo",
    name: "Jo",
    route: "server",
    spreadMs: 11,
    p99Ms: 15,
    lateRate: 0.05,
    downloaded: true,
    inTime: false,
    heardMsAgo: 5000,
  },
];

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
  return syncBars(p.spreadMs) === 0 || liveRating(p) === "Not steady";
}

export function heardText(ms: number): string {
  return `Heard ${Math.round(ms / 1000)} s ago`;
}

export type StatusRow = {
  id: string;
  name: string;
  routeText: string;
  bars: number;
  barsText: string;
  downloaded: string;
  inTime: string;
  heard: string;
  amber: boolean;
};

export function statusRows(players: Player[]): StatusRow[] {
  return players.map((p) => {
    const bars = syncBars(p.spreadMs);
    const rating = liveRating(p);
    return {
      id: p.id,
      name: p.name,
      routeText: `${LIVE_ROUTE_WORDS[p.route]} · ${rating}`,
      bars,
      barsText: barsText(p.spreadMs),
      downloaded: p.downloaded ? "Downloaded ✓" : "",
      inTime: p.inTime ? "In time ✓" : "",
      heard: heardText(p.heardMsAgo),
      amber: isAmber(p),
    };
  });
}

export const BAND_STATUS_FONT_PX = 16;
