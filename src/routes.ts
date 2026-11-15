import type { LinkRoute } from "./band-time";
import type { RouteChoice } from "./gig-state";

/** The admin's or the phone's choice of how to connect for a gig (PLAN.md 7.5). */
export type { RouteChoice } from "./gig-state";
/** What a live link turned out to be once it was made (PLAN.md 7.2). */
export type { LinkRoute } from "./band-time";

/** The words a screen uses for each kind of live link (PLAN.md 7.5). Every screen reads this table and no other. */
export const ROUTE_WORDS: Record<LinkRoute, string> = {
  wifi: "Wi-Fi link",
  internet: "Over the internet",
  relay: "Through the relay",
  server: "Through the server",
};

/** The four choices for how a gig connects, as Settings and Plan a gig show them (PLAN.md 7.5, 8.1, 8.2). */
export const CHOICE_WORDS: Record<RouteChoice, { name: string; line: string }> = {
  auto: { name: "Auto", line: "Works with any Wi-Fi, or none. The app figures it out." },
  band_wifi: { name: ROUTE_WORDS.wifi, line: "Phones on the same Wi-Fi talk directly, whether it's the venue's, a router, or the leader's hotspot. Works with no internet." },
  direct_cell: { name: ROUTE_WORDS.internet, line: "Phones talk over cell data or the venue's internet, through a relay if needed." },
  server: { name: "Server", line: "Everything goes through the internet. Use if the others fail." },
};
