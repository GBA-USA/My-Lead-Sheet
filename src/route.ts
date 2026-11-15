export type TabName = "songs" | "setlists";

export type Route =
  | { name: "songs" }
  | { name: "setlists" }
  | { name: "song"; id: number; from: TabName }
  | { name: "live"; setlistId: number; index: number };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const path = (raw.split("?")[0] || "/songs").replace(/\/$/, "") || "/songs";
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
  const live = path.match(/^\/live\/(\d+)(?:\/(\d+))?$/);
  if (live) return { name: "live", setlistId: Number(live[1]), index: Number(live[2] ?? 0) };
  const match = path.match(/^\/song\/(\d+)$/);
  if (match) {
    const from = new URLSearchParams(query).get("from") === "setlists" ? "setlists" : "songs";
    return { name: "song", id: Number(match[1]), from };
  }
  if (path === "/setlists") return { name: "setlists" };
  return { name: "songs" };
}

export function songHref(id: number, from: TabName): string {
  return from === "setlists" ? `#/song/${id}?from=setlists` : `#/song/${id}`;
}
