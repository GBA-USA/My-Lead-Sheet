import bands from "../scripts/learn-bands.json";
import type { Span } from "./scroll-timing";

/**
 * What one listen to a recording gives, and the messages the phone and the analysis worker trade. The learn cooks
 * all read these shapes and each fills its own part; none of them changes a shape here.
 */

/** How sure a heard thing is, drawn green, yellow and red. */
export type Band = "sure" | "likely" | "check";

/** The band a confidence from 0 to 100 falls in, by the floors the scorecard fits into scripts/learn-bands.json. */
export function bandOf(confidence: number): Band {
  if (confidence >= bands.sure) return "sure";
  return confidence >= bands.likely ? "likely" : "check";
}

/** Where the sound came from. `sampleRate` is the rate the listen ran at. */
export interface Source {
  kind: "file" | "mic" | "tab";
  /** The file's name; null for the mic and a tab. */
  name: string | null;
  stereo: boolean;
  sampleRate: number;
}

export interface Coverage {
  heardSeconds: number;
  /** The file's duration, or the song's officialRuntimeSec for the mic; null when neither is known. */
  expectedSeconds: number | null;
  /** What ended the listen: the file ran out, the player stopped it, the page was hidden, the mic track ended or went mute, or the audio was suspended. */
  stopped: "finished" | "player" | "page-hidden" | "mic-ended" | "mic-muted" | "audio-suspended";
  /** From how far the song stands over the room's floor and how much of it clipped, by the floors in scripts/learn-bands.json. */
  quality: "clear" | "some noise" | "noisy";
}

/** One reading of the song's tempo: a tempo, its half or its double, and how well the song fits it. */
export interface TempoGuess {
  bpm: number;
  feel: "half" | "as heard" | "double";
  score: number;
}

/** A chord as heard, from the beat it starts on. */
export interface HeardChange {
  /** Index into `analysis.beats` where this chord starts. */
  beat: number;
  /** Seconds into the audio. */
  at: number;
  /** Null shows as "?". */
  chord: string | null;
  /** 0 to 100. */
  confidence: number;
  alternatives: { chord: string; score: number }[];
  evidence: { bass: number | null; tones: number[]; stable: number };
}

export type SectionLabel = "INTRO" | "VERSE" | "PRE-CHORUS" | "CHORUS" | "BRIDGE" | "SOLO" | "INSTRUMENTAL" | "OUTRO";

export interface HeardSection {
  fromBeat: number;
  toBeat: number;
  /** "A", "B", ...; repeats share a letter. */
  group: string;
  /** VERSE 2 is { label: "VERSE", number: 2 }. */
  label: SectionLabel;
  number: number | null;
  /** How sure the label is. */
  band: Band;
}

/** When one lyric line is sung, and the column and word of each syllable in it. */
export interface HeardLine {
  line: number;
  start: number;
  end: number;
  syllables: { at: number; word: number; column: number; band: Band }[];
}

/** What the listen heard, in seconds from when the audio began. */
export interface Analysis {
  /** First note to last note. */
  sound: Span;
  beats: number[];
  /** The opening tempo, then each change. */
  tempos: { at: number; bpm: number }[];
  /** `beats[downbeatPhase]` is the first downbeat; 0 to beatsPerBar - 1, and 0 until bars are found. */
  downbeatPhase: number;
  /** Where the voice band stands out. Only suggestions. */
  vocals: Span[];
  /** Per beat, the strength of each pitch class from C to B. */
  chroma: number[][];
  /** The voice band's onset strength, 100 frames a second. Empty until the words are timed. */
  voiceOnsets: Float32Array;
  /**
   * Per beat, how different the two bars after it sound from the two bars before. A chart's headings are placed on
   * its peaks until the listen hears sections of its own.
   */
  novelty: number[];
}

export interface Listen {
  source: Source;
  coverage: Coverage;
  analysis: Analysis;
  /** `choices` in score order, best first. */
  tempo: { bpm: number; choices: TempoGuess[]; band: Band };
  /** Empty until chords are heard. */
  changes: HeardChange[];
  /** Empty until sections are heard. */
  sections: HeardSection[];
  /** One per lyric line given; empty until the words are timed. */
  lines: HeardLine[];
}

/** What the samples alone give. The worker adds where they came from and how much of the song they were. */
export type Heard = Omit<Listen, "source" | "coverage">;

/**
 * Phone to worker. Chunks go as transferables. `stereo` is sent beside `samples`, never instead, and only while the
 * stereo side view is being tried. `finish` ends a listen with what only the phone knows.
 */
export type ToWorker =
  | { kind: "samples"; chunk: Float32Array; sampleRate: number }
  | { kind: "stereo"; left: Float32Array; right: Float32Array }
  | {
      kind: "finish";
      beatsPerBar: number;
      lyrics: string | null;
      source: Source;
      expectedSeconds: Coverage["expectedSeconds"];
      stopped: Coverage["stopped"];
    };

/** Worker to phone: `heard` after each chunk, `progress` while a finished listen is analyzed, then `done` once. */
export type FromWorker =
  | { kind: "heard"; seconds: number }
  | { kind: "progress"; fraction: number }
  | { kind: "done"; listen: Listen | null };

/**
 * src/learn-worker.ts exports `handle` of this type. In a worker it answers through postMessage; a node check runs it
 * in its own thread through scripts/fake-worker.ts.
 */
export type WorkerHandle = (message: ToWorker, post: (reply: FromWorker, transfer?: Transferable[]) => void) => void;
