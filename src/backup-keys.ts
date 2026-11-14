/**
 * Every value a phone backs up, by kind. The phone and the self room both read this table, so the room accepts
 * exactly what a phone sends. A kind without `exact` also owns every `<key>.<suffix>` entry. Songs and setlists are
 * not localStorage keys: each own song and setlist is its own entry, `leadSheetsSong.<id>` or `leadSheetsSetlist.<id>`.
 */
export const BACKUP_KINDS = [
  { name: "song", key: "leadSheetsSong" },
  { name: "setlist", key: "leadSheetsSetlist" },
  { name: "timing", key: "leadSheetsScrollVersions" },
  { name: "song-data", key: "leadSheetsSongData" },
  { name: "scroll", key: "leadSheetsScrollPercent" },
  { name: "notation", key: "leadSheetsNotation" },
  { name: "settings", key: "leadSheetsTextScale", exact: true },
  { name: "settings", key: "leadSheetsKeepAwake", exact: true },
] as const satisfies readonly { name: string; key: string; exact?: true }[];

export type BackupKind = (typeof BACKUP_KINDS)[number]["name"];

/** The longest single value the room stores. A phone holds a longer one back instead of sending it. */
export const MAX_VALUE_CHARS = 1_000_000;

const SUFFIX = /^[A-Za-z0-9/_-]{1,130}$/;

const entryOf = (key: string) => BACKUP_KINDS.find((kind) => key === kind.key || (!("exact" in kind) && key.startsWith(`${kind.key}.`)));

/** The kind a key backs up as, or undefined when it is not backup data. */
export const backupKindOf = (key: string): BackupKind | undefined => entryOf(key)?.name;

/** Whether the room takes this key: backup data whose `.<suffix>`, if any, is one the room can store. */
export function validBackupKey(key: string): boolean {
  const kind = entryOf(key);
  return !!kind && (key === kind.key || SUFFIX.test(key.slice(kind.key.length + 1)));
}
