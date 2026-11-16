import type { SongContent } from "./band-library-model";
import type { RouteChoice } from "./routes";
import type { ScrollVersion } from "./scroll-timing";

export type GigStatus = "planned" | "live" | "ended";

/**
 * A gig as the band Room keeps it (PLAN.md 5 `gigs`). `date` is the calendar day as `YYYY-MM-DD`. `lineup`, `leader` and
 * `backup` are user ids. `route` is the admin's choice for the night, `auto` unless they picked one.
 */
export type GigPlan = {
  gigId: string;
  bandId: string;
  setlistId: string;
  name: string;
  date: string;
  lineup: string[];
  leader: string;
  backup: string | null;
  route: RouteChoice;
  status: GigStatus;
};

/** One song of the pack: the band's chart as frozen at plan time, with the band's timing for it when the band has one. */
export type GigPackSong = { songId: string; song: SongContent; bandTiming: ScrollVersion | null };

/**
 * What a lineup phone downloads before the gig and keeps in IndexedDB (PLAN.md 7.3, 10). `secret` is in a lineup
 * player's pack only and proves the phone is on the lineup when it joins by QR; anyone else who may read the pack gets
 * null. `packRev` goes up when the plan changes, so a phone knows its pack is stale. `expiresAt` is set on a guest's pack.
 */
export type GigPack = {
  gig: GigPlan;
  songs: GigPackSong[];
  scrollWithLeader: boolean;
  secret: string | null;
  packRev: number;
  expiresAt: number | null;
};
