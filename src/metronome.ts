/** Performance-only metronome. Never a substitute for song.tempo, and never an input to auto-scroll. */

export const METRONOME_MIN = 30;
export const METRONOME_MAX = 300;
/** Window for a second tap to count as a double tap. */
export const METRONOME_DOUBLE_TAP_MS = 350;

/**
 * Songs with a stored tempo open the metronome on that BPM.
 * A null tempo stays unset — do not borrow the 90 BPM scroll fallback.
 */
export function initialMetronomeBpm(tempo: number | null): number | null {
  if (tempo == null || !Number.isFinite(tempo)) return null;
  return clampMetronomeBpm(tempo);
}

export function clampMetronomeBpm(bpm: number): number {
  const rounded = Math.round(bpm);
  return Math.min(METRONOME_MAX, Math.max(METRONOME_MIN, rounded));
}

export function metronomeBeatSeconds(bpm: number): number {
  return 60 / clampMetronomeBpm(bpm);
}

/**
 * The metronome pad: a single tap edits speed, a double tap toggles playback.
 * With no BPM set, even a double tap only opens the editor — it does not invent one.
 */
export function metronomePadAction(
  detail: number,
  msSincePrevious: number | null,
  hasBpm: boolean,
): "edit" | "toggle" {
  const rapid =
    msSincePrevious != null && msSincePrevious >= 0 && msSincePrevious < METRONOME_DOUBLE_TAP_MS;
  const double = detail > 1 || rapid;
  if (double && hasBpm) return "toggle";
  return "edit";
}
