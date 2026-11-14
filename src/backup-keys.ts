/**
 * Every value a phone backs up, by kind. The phone and the self room both read this table, so the room accepts
 * exactly what a phone sends. A kind without `exact` also owns every `<key>.<suffix>` entry. Songs and setlists are
 * not localStorage keys: each own song and setlist is its own entry, `leadSheetsSong.<id>` or `leadSheetsSetlist.<id>`.
 * A `perSong` kind is one song's setting, `<key>.<song id>`, and goes wherever that song's row goes.
 */
export const BACKUP_KINDS = [
  { name: "song", key: "leadSheetsSong" },
  { name: "setlist", key: "leadSheetsSetlist" },
  { name: "timing", key: "leadSheetsScrollVersions", perSong: true },
  { name: "song-data", key: "leadSheetsSongData", perSong: true },
  { name: "scroll", key: "leadSheetsScrollPercent", perSong: true },
  { name: "notation", key: "leadSheetsNotation", perSong: true },
  { name: "settings", key: "leadSheetsTextScale", exact: true },
  { name: "settings", key: "leadSheetsKeepAwake", exact: true },
] as const satisfies readonly { name: string; key: string; exact?: true; perSong?: true }[];

export const SONG_SETTING_KEYS = BACKUP_KINDS.filter((kind) => "perSong" in kind).map((kind) => kind.key);

export type BackupKind = (typeof BACKUP_KINDS)[number]["name"];

/** The longest single value the room stores. A phone holds a longer one back instead of sending it. */
export const MAX_VALUE_CHARS = 1_000_000;

const SUFFIX = /^[A-Za-z0-9/_-]{1,130}$/;

const entryOf = (key: string) => BACKUP_KINDS.find((kind) => key === kind.key || (!("exact" in kind) && key.startsWith(`${kind.key}.`)));

/** The kind a key backs up as, or undefined when it is not backup data. */
export const backupKindOf = (key: string): BackupKind | undefined => entryOf(key)?.name;

export function songIdOf(key: string): string | undefined {
  const kind = entryOf(key);
  return kind && key !== kind.key && (kind.name === "song" || "perSong" in kind) ? key.slice(kind.key.length + 1) : undefined;
}

/** Whether the room takes this key: backup data whose `.<suffix>`, if any, is one the room can store. */
export function validBackupKey(key: string): boolean {
  const kind = entryOf(key);
  return !!kind && (key === kind.key || SUFFIX.test(key.slice(kind.key.length + 1)));
}
