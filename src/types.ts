/** Types taken from lead-sheets-data-export.json. Do not add a parallel model. */

export type KeyMode = "major" | "minor";

export interface BassNote {
  chord: string;
  nashville: string;
  bassNote: string;
  position: string;
}

/** A chart line carries whichever of these the export stored. Spacing in `chords` / `lyrics` is the alignment. */
export interface ChartLine {
  chords?: string;
  lyrics?: string;
  bars?: string;
  note?: string;
}

export interface ChartSection {
  heading: string;
  lines: ChartLine[];
}

export interface Song {
  id: number;
  title: string;
  artist: string;
  keyLabel: string;
  keyRoot: string;
  keyMode: KeyMode;
  keyNote: string;
  tempo: number | null;
  tempoNote: string;
  timeSignature: string;
  /** The recording's length. With `tempo`, it sets the even auto-scroll pace through the chart. */
  officialRuntimeSec: number | null;
  feel: string;
  sourceNote: string;
  atAGlance: string;
  howToPlay: string;
  practiceTip: string;
  bassNotes: BassNote[];
  body: ChartSection[];
}

/** Values entered on this device that replace the library's for one song. A missing field keeps the library's. */
export type SongData = Partial<Pick<Song, "officialRuntimeSec" | "tempo" | "timeSignature">>;

export interface Setlist {
  id: number;
  name: string;
  songIds: number[];
}

export interface LibraryFile {
  exportedFrom: string;
  exportedFor: string;
  exportedAt: string;
  songCount: number;
  songs: Song[];
  setlists: Setlist[];
}
