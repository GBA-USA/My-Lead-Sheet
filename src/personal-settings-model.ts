import type { ClickPrefs } from "./metronome";
import type { Notation } from "./music";

/** What the player set for themselves. `textSize` is an index into `TEXT_SCALES`. */
export type PersonalSettings = ClickPrefs & { textSize: number; chordStyle: Notation; transpose: number };
/** The part of the player's settings kept per account. Sound and Dot live in the metronome prefs, text size in `leadSheetsTextScale`. */
export type PersonalDefaults = Pick<PersonalSettings, "chordStyle" | "transpose">;
export type GigImposed = { connectionRoute: "wifi" | "hotspot" | "internet"; scrollWithLeader: boolean };
export type GigJoin = { gigId: string; imposed: GigImposed; attempted?: Partial<PersonalSettings> };

export const TRANSPOSE_LIMIT = 11;
export const clampTranspose = (semitones: number) => Math.max(-TRANSPOSE_LIMIT, Math.min(TRANSPOSE_LIMIT, Math.round(semitones)));

export function parsePersonal(value: unknown): PersonalDefaults {
  const { chordStyle, transpose } = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    chordStyle: chordStyle === "nashville" ? "nashville" : "notes",
    transpose: typeof transpose === "number" && Number.isFinite(transpose) ? clampTranspose(transpose) : 0,
  };
}

export function joinGig(personal: PersonalSettings, join: GigJoin): { personal: PersonalSettings; imposed: GigImposed } {
  return {
    personal: { ...personal },
    imposed: {
      connectionRoute: join.imposed.connectionRoute,
      scrollWithLeader: join.imposed.scrollWithLeader,
    },
  };
}
