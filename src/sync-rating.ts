export type Route = "wifi" | "internet" | "server";
export type SettingChoice = "auto" | Route;
export type Rating = "Best" | "Better" | "Good" | "Not steady" | "Not tried yet" | "Can't connect here";
export type RouteSummary = { spreadMs?: number; p99Ms?: number; lateRate?: number; ageDays?: number; source?: string; tries: boolean[] };

export const ROUTE_WORDS: Record<Route, string> = {
  wifi: "Wi-Fi link",
  internet: "Over the internet",
  server: "Server",
};

export function rateRoute(s: RouteSummary | undefined): Rating {
  if (s === undefined) return "Not tried yet";

  const lastTwo = s.tries.slice(-2);
  if (lastTwo.length === 2 && !lastTwo[0] && !lastTwo[1]) return "Can't connect here";

  if (s.spreadMs === undefined || (s.ageDays ?? 0) > 30) return "Not tried yet";

  const spread = s.spreadMs;
  const lateRate = s.lateRate ?? 0;

  if (spread > 8 || lateRate > 0.01) return "Not steady";

  const p99 = s.p99Ms ?? 0;

  if (spread <= 2 && p99 <= 120) return "Best";
  if (spread <= 5 && p99 <= 250) return "Better";
  if (spread <= 8 && p99 <= 370) return "Good";

  return "Not steady";
}

export function autoRoute(m: Partial<Record<Route, RouteSummary>>): Route | null {
  const routes: Route[] = ["wifi", "internet", "server"];

  for (const route of routes) {
    const rating = rateRoute(m[route]);
    if (rating === "Best" || rating === "Better" || rating === "Good") {
      return route;
    }
  }

  for (const route of routes) {
    const rating = rateRoute(m[route]);
    if (rating === "Not steady") {
      return route;
    }
  }

  return null;
}

export function rowText(choice: SettingChoice, m: Partial<Record<Route, RouteSummary>>): string {
  if (choice === "auto") {
    const route = autoRoute(m);
    if (route === null) return "Not tried yet";
    const rating = rateRoute(m[route]);
    return `${rating} · ${ROUTE_WORDS[route]}`;
  }

  const summary = m[choice];
  const rating = rateRoute(summary);

  if (choice === "wifi" && rating === "Not tried yet") {
    return "Not tried yet · test with a bandmate";
  }

  if (summary && summary.source && (rating === "Best" || rating === "Better" || rating === "Good" || rating === "Not steady")) {
    return `${rating} · ${summary.source}`;
  }

  return rating;
}

export function applyTestNow(
  m: Partial<Record<Route, RouteSummary>>,
  server: RouteSummary,
  internet: RouteSummary,
): Partial<Record<Route, RouteSummary>> {
  return {
    ...m,
    server: { ...server, source: "Test now" },
    internet: { ...internet, source: "Test now" },
  };
}
