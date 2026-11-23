export type DataPlace = "phone" | "server";

export interface DataKind {
  /** The localStorage key (per-song keys add `.<song id>`), IndexedDB database, table name, or Durable Object storage key. */
  readonly key: string;
  readonly place: DataPlace;
  readonly what: string;
}

export const PRIVACY_HREF = "privacy.html";
export const APP_NAME = "Groovist";

export const DATA_KINDS: readonly DataKind[] = [
  { key: "leadSheetsLibrary", place: "phone", what: "Your songs and setlists, including any changes you make to them." },
  { key: "leadSheetsTheme", place: "phone", what: "The look you picked: stage, day, one of the two colorblind-safe looks, or high contrast." },
  { key: "leadSheetsTextScale", place: "phone", what: "The text size you picked for sheets." },
  {
    key: "leadSheetsPersonal",
    place: "phone",
    what: "For each account on this phone, the Chords and Transpose defaults you set in Settings, so each account opens songs its own way.",
  },
  { key: "leadSheetsScrollPercent", place: "phone", what: "The scroll speed you set for each song." },
  { key: "leadSheetsNotation", place: "phone", what: "Whether each song shows note names or Nashville numbers." },
  {
    key: "leadSheetsMetronome",
    place: "phone",
    what: "Your metronome settings: sound, the beat dot, the delay nudge for Bluetooth speakers, and the speaker delay set for this phone in Line up with the band. They belong to this phone, not to an account.",
  },
  { key: "leadSheetsSongData", place: "phone", what: "The runtime, tempo and time signature you entered for each song." },
  {
    key: "leadSheetsScrollVersions",
    place: "phone",
    what: "The versions you saved of each song, and which one is in use: for each, its name, key, metronome speed, scroll speed, Notes or Nashville, and the scroll timing you taught or learned (tap times, beat times, section times and chord names heard). No sound is kept.",
  },
  {
    key: "leadSheetsSongDraft",
    place: "phone",
    what: "For each account on this phone, the changes you made to a song and have not saved yet: key, metronome speed, scroll speed, Notes or Nashville, and a timing you taught or learned. Removed when you save or revert. Never backed up.",
  },
  {
    key: "leadSheetsGigDraft",
    place: "phone",
    what: "For each account on this phone, a gig or rehearsal plan you started and have not sent yet, with the band and setlist it is for: everything you typed or picked on the form. Removed when you send it or tap Cancel. Never backed up.",
  },
  {
    key: "leadSheetsSignedIn",
    place: "phone",
    what: "Which account this phone signed in to, so the app checks your account when it opens and, with no signal, keeps your settings and unsaved changes with that account. Signing out removes it.",
  },
  {
    key: "leadSheetsPendingInvite",
    place: "phone",
    what: "A link you opened while signed out, such as a friend or band invite, with the time it arrived, kept so it can finish once you sign in or create an account. Removed when it is used or refused, when you close the sign-in screen, or after a day.",
  },
  {
    key: "leadSheetsBackup",
    place: "phone",
    what: "While you are signed in: which account this phone backs up to, and what it last sent and received, so it only sends changes. Removed when you sign out.",
  },
  {
    key: "leadSheetsLeftBy",
    place: "phone",
    what: "Which account left each of your songs, setlists and song settings on this phone when it signed out, so another account signing in here never backs them up as its own.",
  },
  {
    key: "leadSheetsSetAside",
    place: "phone",
    what: "For each account on this phone, its songs and song settings moved aside while the backup of another account used the same place, put back when that account signs in here again.",
  },
  { key: "leadSheetsLibraryMode", place: "phone", what: "Whether this server keeps My Songs per account, so My Songs shows only the songs of the account signed in." },
  { key: "leadSheetsConnection", place: "phone", what: "How this phone connects to the band outside a gig: Auto, Wi-Fi link, Over the internet or Server. In a gig the admin picks the route for everyone, and this stays as you set it." },
  { key: "users", place: "server", what: "Your account: the name bandmates see, your handle (the name others find you by), when you joined, and a number that goes up when you sign out everywhere." },
  {
    key: "passkeys",
    place: "server",
    what: "One row per phone you sign in with Face ID or fingerprint: the passkey id and public key, a use counter, and when it was added and last used. Your face and fingerprint never leave your phone.",
  },
  { key: "backup_codes", place: "server", what: "Backup codes made by an older version of the app, kept only as one-way hashes. No new ones are made and none are read." },
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
    what: "Your backup, in a room only your account can open: the songs and setlists you added or changed, your timing versions, the runtime, tempo and time signature you entered, the scroll speed and Notes or Nashville choice for each song, and your text size, plus the Screen on choice an older version of the app kept. Your phones sync it when you are signed in.",
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
  {
    key: "song_notes",
    place: "server",
    what: "For each band: every note an admin pinned to a band song, with the words, who wrote it, their name at the time, and when, and for a note that came in a band file, which band and note it came from so importing that file again adds it once. A deleted note is kept marked as deleted and never shown or exported. Notes stay in the band: they are never part of a chart or a share.",
  },
  { key: "band_setlists", place: "server", what: "For each band: every setlist a member shared into it, with its name, songs in order, tags, who shared it, and when it last changed." },
  {
    key: "shares",
    place: "server",
    what: "For every song or setlist copy, in the band or your own room that holds it: who it came from and whether it was shared Private or Public, so the server can refuse to pass on a Private copy.",
  },
  {
    key: "song_copies",
    place: "server",
    what: "In a room only your account can open: each band song you added to My Songs and each song a friend sent you, with a one-way code of its chart, so its Private or Public rule goes with your copy.",
  },
  {
    key: "setlist_sends",
    place: "server",
    what: "In a room only your account can open: each setlist copy code you made, with the setlist name and a copy of each song you ticked, so a friend who scans it gets those songs and nothing else.",
  },
  {
    key: "leadSheetsSentSongs",
    place: "phone",
    what: "For each account on this phone, which send of each song went to which friend last, so sending it again shows them an update. No chart is kept here.",
  },
  {
    key: "leadSheetsChatQueue",
    place: "phone",
    what: "Messages you wrote with no signal, kept until they are sent, each marked with the account that wrote it so nobody else signed in on this phone sends it. Each is removed as soon as the room confirms it.",
  },
  {
    key: "messages",
    place: "server",
    what: "In each band or DM room: every message posted, with who wrote it, their name at the time, the text, when it was sent, the id your phone gave it so a resend is stored once, what kind of message it is (words, a note from the app, or a song, setlist, gig or band song card), which song share, setlist, gig or band song a card points at, and in a band the ids of the members its words mention by name. A band song card holds only the title and artist of the song, never its chart. A song card holds the chart and only the timing versions and song data the sender ticked.",
  },
  {
    key: "mls-phone",
    place: "phone",
    what: "Copies of the songs in your bands, and the gig packs you downloaded: the setlist for the night with its charts, the band timing for those songs, and the gig secret that proves your phone is on the lineup. Kept so they open with no signal. Removed when you sign out, or when another account signs in on this phone. A pack that came with a guest pass also holds when the pass ends, and is deleted the next time the app opens after that, even with no signal.",
  },
  {
    key: "syncHistory",
    place: "phone",
    what: "For each route (Wi-Fi link, Over the internet, Server) and each of the last 30 days: how steady the clock was, how long the slowest message took, how many timing changes came late, whether the tries to connect worked, and whether a gig, Test now or a test with a bandmate measured it. Kept for the sync rating under Settings, then Connection. It is about this phone and the route, never a Wi-Fi network name or a venue, and it stays when another account signs in.",
  },
  { key: "leadSheetsPhoneOwner", place: "phone", what: "Which account the band data on this phone belongs to, so another account signing in here never sees it." },
  {
    key: "gigs",
    place: "server",
    what: "For each band: every gig and rehearsal planned, with its name and date, start and call times, venue, address and notes, the setlist and its song order at the time, who is playing, the leader and backup leader, the connection the admin picked, whether it is planned, live or over, and a number that changes the gig secret when the lineup changes.",
  },
  {
    key: "guest_passes",
    place: "server",
    what: "For each band: every guest pass the admin made for a gig, with the name the admin gave it, who made it, when it ends, whether it was revoked, which code opens it, the account that first opened it, and whether the guest may see the band chat and the other setlists.",
  },
  {
    key: "guest_gigs",
    place: "server",
    what: "Which gigs you hold a guest pass for, so your phone can offer Join gig for them, and so the songs of that band are never passed on from your account.",
  },
  { key: "pack_receipts", place: "server", what: "For each gig: who on the lineup downloaded the gig to their phone, which version of it, and when, so the gig card can show Downloaded." },
  { key: "gig_ops", place: "server", what: "For each live gig: the id of each change the leader makes and when, so a change sent twice counts once. Nothing is written here until live gigs are built." },
  {
    key: "inbox",
    place: "server",
    what: "Your Messages list: for each band thread and DM, its name, the number and a one-line preview of the newest message, the last message you read, and until when you muted it.",
  },
  { key: "dm_index", place: "server", what: "For each pair of people who message each other, which room holds their one DM thread." },
  {
    key: "sync_runs",
    place: "server",
    what: "For each band: each Sync check run an admin started, with who started it and when it starts and ends. Kept so the report for the run can be read later.",
  },
  {
    key: "sync_log",
    place: "server",
    what: "For each band: during a Sync check run only, one row per beat per phone, with who it was, the route (Wi-Fi link, Over the internet or the server), the carrier you picked, when the beat was due, flashed and was heard, and how steady the clock was. Feeds the sync report. Nothing is written outside a run.",
  },
];
