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

export const BEAT_FLASH_SECONDS = 0.1;

/** The sheet's beat dot is a hard flash: fully lit just after a heard click, hidden otherwise. */
export function beatDotState(secondsSinceHeardClick: number | null): "on" | "off" {
  return secondsSinceHeardClick != null && secondsSinceHeardClick < BEAT_FLASH_SECONDS ? "on" : "off";
}

/** When the dot-sync +/- shows: Auto only on a detected high-latency output. */
export type SyncMode = "auto" | "on" | "off";

/**
 * Device-wide metronome settings. The offset moves the dot later (+) or earlier (−) than the heard click.
 * The speaker delay is this phone's own, from Line up with the band: a band click goes out that much early so it is
 * heard on the beat. It is apart from the dot nudge, which is for Bluetooth (PLAN.md 5, 7.8).
 */
export interface MetronomePrefs {
  indicator: boolean;
  sound: boolean;
  syncMode: SyncMode;
  syncOffsetMs: number;
  speakerDelayMs: number;
}

export const DEFAULT_METRONOME_PREFS: MetronomePrefs = { indicator: true, sound: true, syncMode: "auto", syncOffsetMs: 0, speakerDelayMs: 0 };

/** Sound and Dot, the two switches Settings, the Metronome sheet and the beat pill share. Both may be off. */
export type ClickPrefs = Pick<MetronomePrefs, "sound" | "indicator">;

/** The beat pill's tap order (t162u): both on, sound only, dot only, both off, then round again. */
const CLICK_CYCLE: readonly ClickPrefs[] = [
  { sound: true, indicator: true },
  { sound: true, indicator: false },
  { sound: false, indicator: true },
  { sound: false, indicator: false },
];

export function nextClick({ sound, indicator }: ClickPrefs): ClickPrefs {
  const at = CLICK_CYCLE.findIndex((each) => each.sound === sound && each.indicator === indicator);
  return CLICK_CYCLE[(at + 1) % CLICK_CYCLE.length];
}

/**
 * +400 ms covers a Bluetooth delay the browser does not report at all (Safari has no outputLatency).
 * −50 ms trims an over-report; clicks are scheduled only about 100 ms ahead, so the dot cannot lead by much more.
 */
export const SYNC_OFFSET_STEP_MS = 10;
export const SYNC_OFFSET_MIN_MS = -50;
export const SYNC_OFFSET_MAX_MS = 400;

export function clampSyncOffsetMs(ms: number): number {
  const stepped = Math.round(ms / SYNC_OFFSET_STEP_MS) * SYNC_OFFSET_STEP_MS;
  return Math.min(SYNC_OFFSET_MAX_MS, Math.max(SYNC_OFFSET_MIN_MS, stepped));
}

/** Line up with the band moves the speaker delay 5 ms a tap. A phone speaker is tens of ms, Bluetooth is the dot nudge's. */
export const SPEAKER_DELAY_STEP_MS = 5;
export const SPEAKER_DELAY_MIN_MS = 0;
export const SPEAKER_DELAY_MAX_MS = 300;

export function clampSpeakerDelayMs(ms: number): number {
  const stepped = Math.round(ms / SPEAKER_DELAY_STEP_MS) * SPEAKER_DELAY_STEP_MS;
  return Math.min(SPEAKER_DELAY_MAX_MS, Math.max(SPEAKER_DELAY_MIN_MS, stepped));
}

/** Saved prefs come back field by field, so one bad value never resets the others. */
export function parseMetronomePrefs(stored: unknown): MetronomePrefs {
  const { indicator, sound, syncMode, syncOffsetMs, speakerDelayMs } = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const fallback = DEFAULT_METRONOME_PREFS;
  return {
    indicator: typeof indicator === "boolean" ? indicator : fallback.indicator,
    sound: typeof sound === "boolean" ? sound : fallback.sound,
    syncMode: syncMode === "auto" || syncMode === "on" || syncMode === "off" ? syncMode : fallback.syncMode,
    syncOffsetMs: typeof syncOffsetMs === "number" && Number.isFinite(syncOffsetMs) ? clampSyncOffsetMs(syncOffsetMs) : fallback.syncOffsetMs,
    speakerDelayMs: typeof speakerDelayMs === "number" && Number.isFinite(speakerDelayMs) ? clampSpeakerDelayMs(speakerDelayMs) : fallback.speakerDelayMs,
  };
}

/** Wired outputs report tens of milliseconds. Bluetooth reports well above this. */
export const HIGH_OUTPUT_LATENCY_SECONDS = 0.1;
const WIRELESS_OUTPUT = /bluetooth|airpods|beats|buds/i;

/** labels are the current audio outputs' names. Browsers leave them empty until a permission is granted. */
export function isHighLatencyOutput(outputLatency: number, labels: string[]): boolean {
  return outputLatency > HIGH_OUTPUT_LATENCY_SECONDS || labels.some((label) => WIRELESS_OUTPUT.test(label));
}
