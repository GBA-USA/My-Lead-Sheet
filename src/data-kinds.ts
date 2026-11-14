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
  { key: "users", place: "server", what: "Your account: the name bandmates see, your @handle, when you joined, and a number that goes up when you sign out everywhere." },
  {
    key: "passkeys",
    place: "server",
    what: "One row per phone you sign in with Face ID or fingerprint: the passkey's id and public key, a use counter, and when it was added and last used. Your face and fingerprint never leave your phone.",
  },
  { key: "backup_codes", place: "server", what: "Your 8 backup codes, kept only as one-way hashes, and when each was used." },
  { key: "challenges", place: "server", what: "A random value for a sign-in in progress, with the name you typed, deleted when you finish or after 5 minutes." },
  { key: "open_rooms", place: "server", what: "Which bands and chats you have opened since you last signed out everywhere, so signing out everywhere can close them." },
  { key: "room_closes", place: "server", what: "Rooms still to be told you signed out everywhere, deleted once each one is told." },
  { key: "session_floors", place: "server", what: "In each band or chat room, the oldest sign-in it still lets in for each person, after they signed out everywhere." },
];
