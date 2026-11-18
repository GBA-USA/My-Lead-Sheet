const TABS = ["songs", "setlists", "bands"] as const;
export type TabName = (typeof TABS)[number];

export const BAND_SECTIONS = ["songs", "setlists", "chat", "gigs", "members"] as const;
export type BandSection = (typeof BAND_SECTIONS)[number];

export type Route =
  | { name: "songs" }
  | { name: "setlists" }
  | { name: "bands" }
  | { name: "song"; id: number; from: TabName }
  | { name: "live"; setlistId: number; index: number }
  | { name: "settings"; from: TabName }
  | { name: "messages" }
  | { name: "room"; roomId: string }
  | { name: "band"; bandId: string; section: BandSection | null }
  | { name: "band-song"; bandId: string; songId: string }
  | { name: "band-plan"; bandId: string; gigId: string; setlistId: string | null }
  | { name: "band-live"; bandId: string; setlistId: string; index: number };

const ID = "([\\w-]+)";

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const path = (raw.split("?")[0] || "/songs").replace(/\/$/, "") || "/songs";
  const query = new URLSearchParams(raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "");
  const bandLive = path.match(new RegExp(`^/live/band/${ID}/${ID}(?:/(\\d+))?$`));
  if (bandLive) return { name: "band-live", bandId: bandLive[1], setlistId: bandLive[2], index: Number(bandLive[3] ?? 0) };
  const live = path.match(/^\/live\/(\d+)(?:\/(\d+))?$/);
  if (live) return { name: "live", setlistId: Number(live[1]), index: Number(live[2] ?? 0) };
  const match = path.match(/^\/song\/(\d+)$/);
  if (match) return { name: "song", id: Number(match[1]), from: query.get("from") === "setlists" ? "setlists" : "songs" };
  const bandSong = path.match(new RegExp(`^/band/${ID}/song/${ID}$`));
  if (bandSong) return { name: "band-song", bandId: bandSong[1], songId: bandSong[2] };
  const bandPlan = path.match(new RegExp(`^/band/${ID}/plan/${ID}$`));
  if (bandPlan) return { name: "band-plan", bandId: bandPlan[1], gigId: bandPlan[2], setlistId: query.get("setlist") || null };
  const band = path.match(new RegExp(`^/band/${ID}$`));
  if (band) return { name: "band", bandId: band[1], section: BAND_SECTIONS.find((section) => section === query.get("s")) ?? null };
  const room = path.match(new RegExp(`^/messages/${ID}$`));
  if (room) return { name: "room", roomId: room[1] };
  if (path === "/messages") return { name: "messages" };
  if (path === "/settings") return { name: "settings", from: TABS.find((tab) => tab === query.get("from")) ?? "songs" };
  if (path === "/setlists") return { name: "setlists" };
  if (path === "/bands") return { name: "bands" };
  return { name: "songs" };
}

export function settingsHref(from: TabName): string {
  return from === "songs" ? "#/settings" : `#/settings?from=${from}`;
}

export function songHref(id: number, from: TabName): string {
  return from === "setlists" ? `#/song/${id}?from=setlists` : `#/song/${id}`;
}

const lastSection = new Map<string, BandSection>();

/** The section a band page opens on: the one its hash names, else the last one opened for that band, else Members. */
export function sectionOf(bandId: string, asked: BandSection | null): BandSection {
  const section = asked ?? lastSection.get(bandId) ?? "members";
  lastSection.set(bandId, section);
  return section;
}

export const bandHref = (bandId: string, section?: BandSection) => (section ? `#/band/${bandId}?s=${section}` : `#/band/${bandId}`);
export const bandSongHref = (bandId: string, songId: string) => `#/band/${bandId}/song/${songId}`;
export const bandPlanHref = (bandId: string, gigId: string, setlistId: string | null) => `#/band/${bandId}/plan/${gigId}${setlistId ? `?setlist=${setlistId}` : ""}`;
export const messagesHref = "#/messages";
export const roomHref = (roomId: string) => `#/messages/${roomId}`;
export const bandLiveHref = (bandId: string, setlistId: string, index: number) => `#/live/band/${bandId}/${setlistId}/${index}`;

/** Where the header's Back goes from each screen, or null on a tab, which has no Back. */
export function backHref(route: Route): string | null {
  if (route.name === "song") return route.from === "setlists" ? "#/setlists" : "#/songs";
  if (route.name === "live") return "#/setlists";
  if (route.name === "settings") return `#/${route.from}`;
  if (route.name === "band") return "#/bands";
  if (route.name === "messages") return "#/settings";
  if (route.name === "room") return messagesHref;
  if (route.name === "band-song" || route.name === "band-live" || route.name === "band-plan") return bandHref(route.bandId);
  return null;
}
