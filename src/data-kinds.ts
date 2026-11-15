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
  { key: "leadSheetsSignedIn", place: "phone", what: "That this phone signed in before, so the app checks your account when it opens. Signing out removes it." },
  {
    key: "leadSheetsBackup",
    place: "phone",
    what: "While you are signed in: which account this phone backs up to, and what it last sent and received, so it only sends changes. Removed when you sign out.",
  },
  { key: "users", place: "server", what: "Your account: the name bandmates see, your handle (the name others find you by), when you joined, and a number that goes up when you sign out everywhere." },
  {
    key: "passkeys",
    place: "server",
    what: "One row per phone you sign in with Face ID or fingerprint: the passkey id and public key, a use counter, and when it was added and last used. Your face and fingerprint never leave your phone.",
  },
  { key: "backup_codes", place: "server", what: "Your 8 backup codes, kept only as one-way hashes, and when each was used." },
  { key: "challenges", place: "server", what: "A random value for a sign-in in progress, with the name you typed, deleted when you finish or after 5 minutes." },
  { key: "open_rooms", place: "server", what: "Which bands and chats you have opened since you last signed out everywhere, so signing out everywhere can close them." },
  { key: "room_closes", place: "server", what: "Rooms still to be told you signed out everywhere, deleted once each one is told." },
  {
    key: "google_logins",
    place: "server",
    what: "If you connect Google: the account number Google uses for you, the email address it gave, and when it was connected and last used.",
  },
  {
    key: "passwords",
    place: "server",
    what: "If you make a password: a random salt and a one-way code made from what your phone worked out from your password. Your password itself never leaves your phone.",
  },
  {
    key: "password_misses",
    place: "server",
    what: "Each wrong password try, kept as one-way codes of the username typed and of the network address it came from, with the time, so waits can grow. A try stops counting after a day and is cleared out at the next wrong try.",
  },
  {
    key: "codes",
    place: "server",
    what: "Each code or share link you make: its kind, who it adds or what it opens, when it ends, and whether you stopped it. Ended codes are cleared out when the next code is made.",
  },
  {
    key: "friendships",
    place: "server",
    what: "For each person you asked, who asked you, or you blocked: whether it is a request, a friendship or a block, who asked or blocked, and when it last changed.",
  },
  {
    key: "backup_items",
    place: "server",
    what: "Your backup, in a room only your account can open: the songs and setlists you added or changed, your timing versions, the runtime, tempo and time signature you entered, the scroll speed and Notes or Nashville choice for each song, and your text size and Screen on choice. Your phones sync it when you are signed in.",
  },
  { key: "session_floors", place: "server", what: "In each band or chat room, the oldest sign-in it still lets in for each person, after they signed out everywhere." },
  { key: "meta", place: "server", what: "For each band: its name, who made it and when, and whether Scroll with the leader is on." },
  {
    key: "members",
    place: "server",
    what: "For each band: everyone who joined, with the name bandmates see, whether they are an admin, whether they are still in the band, left or were removed, and when that last changed.",
  },
  { key: "band_rooms", place: "server", what: "Which bands you are in, so your Bands list can find them. A band you left or were removed from is dropped the next time the list loads." },
  {
    key: "band_songs",
    place: "server",
    what: "For each band: every song a member shared into it, as a copy of the whole chart, with who shared it, when, who last changed it, and a one-way code of the chart so a Private song is not passed on as if it were new.",
  },
  { key: "band_setlists", place: "server", what: "For each band: every setlist a member shared into it, with its name, songs in order, tags, who shared it, and when it last changed." },
  {
    key: "shares",
    place: "server",
    what: "For every song or setlist copy, in the band or your own room that holds it: who it came from and whether it was shared Private or Public, so the server can refuse to pass on a Private copy.",
  },
  { key: "song_copies", place: "server", what: "In a room only your account can open: each band song you added to My Songs, with a one-way code of its chart, so its Private or Public rule goes with your copy." },
  {
    key: "leadSheetsChatQueue",
    place: "phone",
    what: "Messages you wrote with no signal, kept until they are sent, each marked with the account that wrote it so nobody else signed in on this phone sends it. Each is removed as soon as the room confirms it.",
  },
  {
    key: "messages",
    place: "server",
    what: "In each band or DM room: every message posted, with who wrote it, their name at the time, the text, when it was sent, and the id your phone gave it so a resend is stored once.",
  },
  {
    key: "inbox",
    place: "server",
    what: "Your Messages list: for each band thread and DM, its name, the number and a one-line preview of the newest message, the last message you read, and until when you muted it.",
  },
  { key: "dm_index", place: "server", what: "For each pair of people who message each other, which room holds their one DM thread." },
];
