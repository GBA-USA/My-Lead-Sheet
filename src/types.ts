/** Types taken from lead-sheets-data-export.json. Do not add a parallel model. */

export type KeyMode = "major" | "minor";

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

/** Which library a song lives in: `local/<id>` for this phone's own songs, `<room_id>/<song_id>` for a band's or a friend's copy. */
export type SongRef = `${string}/${string}`;

export interface Song {
  ref: SongRef;
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
  body: ChartSection[];
  copy?: CopyMark;
  kept?: string[];
}

/** Set on a song or setlist added from a band or a friend: the server's record of the copy, which a later share names so the server can check it. `from` names the friend who sent it. */
export type CopyMark = { id: string; canSendOn: boolean; from?: { name: string } };

/** Values entered on this device that replace the library's for one song. A missing field keeps the library's. */
export type SongData = Partial<Pick<Song, "officialRuntimeSec" | "tempo" | "timeSignature">>;

export interface Setlist {
  id: number;
  name: string;
  songRefs: SongRef[];
  copy?: CopyMark;
}

export interface Library {
  songs: Song[];
  setlists: Setlist[];
}

/** The export file, and this phone's stored library, which keeps the same shape. Refs are added on load. */
export interface LibraryFile {
  exportedFrom: string;
  exportedFor: string;
  exportedAt: string;
  songCount: number;
  songs: Omit<Song, "ref">[];
  setlists: (Omit<Setlist, "songRefs"> & { songIds: number[] })[];
}
