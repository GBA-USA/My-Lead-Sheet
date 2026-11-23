import type { ClickPrefs } from "./metronome";
import type { Notation } from "./music";
import type { RouteChoice } from "./routes";

/**
 * What the player set for themselves. `textSize` is an index into `TEXT_SCALES`. `clickAsked` says this account has
 * answered "Click out loud on this phone, or dot only?" once; the answer itself is the metronome's Sound and Dot.
 */
export type PersonalSettings = ClickPrefs & { textSize: number; chordStyle: Notation; transpose: number; clickAsked: boolean };
/** The part of the player's settings kept per account. Sound and Dot live in the metronome prefs, text size in `leadSheetsTextScale`. */
export type PersonalDefaults = Pick<PersonalSettings, "chordStyle" | "transpose" | "clickAsked">;
/** All a gig changes on a phone (PLAN.md 8.3 rule 11): the admin's route, and the band's Scroll with the leader. */
export type GigImposed = { route: RouteChoice; scrollWithLeader: boolean };
export type GigJoin = { gigId: string; imposed: GigImposed };

export const TRANSPOSE_LIMIT = 11;
export const clampTranspose = (semitones: number) => Math.max(-TRANSPOSE_LIMIT, Math.min(TRANSPOSE_LIMIT, Math.round(semitones)));

export function parsePersonal(value: unknown): PersonalDefaults {
  const { chordStyle, transpose, clickAsked } = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    chordStyle: chordStyle === "nashville" ? "nashville" : "notes",
    transpose: typeof transpose === "number" && Number.isFinite(transpose) ? clampTranspose(transpose) : 0,
    clickAsked: clickAsked === true,
  };
}

export function joinGig(personal: PersonalSettings, join: GigJoin): { personal: PersonalSettings; imposed: GigImposed } {
  return { personal: { ...personal }, imposed: { route: join.imposed.route, scrollWithLeader: join.imposed.scrollWithLeader } };
}
