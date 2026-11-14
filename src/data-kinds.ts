export type DataPlace = "phone" | "server";

export interface DataKind {
  /** The localStorage key (per-song keys add `.<song id>`), IndexedDB database, table name, or Durable Object storage key. */
  readonly key: string;
  readonly place: DataPlace;
  readonly what: string;
}

export const PRIVACY_HREF = "privacy.html";

export const DATA_KINDS: readonly DataKind[] = [
  { key: "leadSheetsLibrary", place: "phone", what: "Your songs and setlists, including any changes you make to them." },
  { key: "leadSheetsKeepAwake", place: "phone", what: "Whether the Screen on switch is on." },
  { key: "leadSheetsTextScale", place: "phone", what: "The text size you picked for sheets." },
  { key: "leadSheetsScrollPercent", place: "phone", what: "The scroll speed you set for each song." },
  { key: "leadSheetsNotation", place: "phone", what: "Whether each song shows note names or Nashville numbers." },
  { key: "leadSheetsMetronome", place: "phone", what: "Your metronome settings: sound, the beat dot, and the delay nudge for Bluetooth speakers." },
  { key: "leadSheetsSongData", place: "phone", what: "The runtime, tempo and time signature you entered for each song." },
  {
    key: "leadSheetsScrollVersions",
    place: "phone",
    what: "The scroll timings you taught or learned for each song: tap times, beat times, section times and chord names heard. No sound is kept.",
  },
];
