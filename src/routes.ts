import type { LinkRoute } from "./band-time";

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
