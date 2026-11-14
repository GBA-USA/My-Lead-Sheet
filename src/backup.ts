import { BACKUP_KINDS, MAX_VALUE_CHARS, backupKindOf, validBackupKey, type BackupKind } from "./backup-keys";
import { ApiError, api } from "./sign-in-methods";
import {
  LIBRARY_KEY,
  NOTATION_KEY,
  SCROLL_PERCENT_KEY,
  SCROLL_VERSIONS_KEY,
  SETLIST_ROW,
  SONG_DATA_KEY,
  SONG_ROW,
  copiedOwnItem,
  freeOwnId,
  ownLibraryItems,
  setlistWithSongMoved,
  storageChanged,
  withOwnLibraryItems,
} from "./storage";

/** This phone's sync state for the signed-in account. Present only while signed in, so a signed-out phone never syncs. */
export const BACKUP_KEY = "leadSheetsBackup";

type Value = string | null;
/** How two values of one key combine when both phones changed it since they last synced. */
type Merge = (server: Value, phone: Value, phoneLabel: string) => Value;

const lastSyncWins: Merge = (_server, phone) => phone;

/** Both phones' timing versions, the server's first. A version with a name already taken becomes "<name> · <phone>". */
const combineVersions: Merge = (server, phone, phoneLabel) => {
  const parse = (raw: Value) => {
    try {
      const value = JSON.parse(raw ?? "null");
      return Array.isArray(value?.versions) ? (value as { versions: { name: string }[]; selected: number | null }) : null;
    } catch {
      return null;
    }
  };
  const ours = parse(server);
  const theirs = parse(phone);
  if (!ours || !theirs) return phone ?? server;
  const versions = [...ours.versions];
  const at = theirs.versions.map((version) => {
    const same = versions.findIndex((item) => JSON.stringify(item) === JSON.stringify(version));
    if (same >= 0) return same;
    let name = version.name;
    for (let n = 2; versions.some((item) => item.name === name); n += 1) name = `${version.name} · ${phoneLabel}${n > 2 ? ` ${n - 1}` : ""}`;
    return versions.push({ ...version, name }) - 1;
  });
  const selected = theirs.selected === null ? null : (at[theirs.selected] ?? null);
  if (versions.length === ours.versions.length && selected === ours.selected) return server;
  return JSON.stringify({ versions, selected });
};

const keepServer: Merge = (server) => server;

/**
 * How each kind merges (PLAN.md section 10). A song or setlist both phones changed keeps the server's copy under its
 * id, and the phone's copy moves to a new id (`keepBoth`). Timing versions are combined. For a single value the
 * phone that syncs last wins. `leadSheetsMetronome` stays on each phone, because its Bluetooth delay belongs to that
 * phone's speaker.
 */
const MERGE: Record<BackupKind, Merge> = {
  song: keepServer,
  setlist: keepServer,
  timing: combineVersions,
  "song-data": lastSyncWins,
  scroll: lastSyncWins,
  notation: lastSyncWins,
  settings: lastSyncWins,
};

/** What a song's own settings are stored under, `<key>.<song id>`. They move with the song when it gets a new id. */
const PER_SONG_KEYS = [SCROLL_VERSIONS_KEY, SONG_DATA_KEY, SCROLL_PERCENT_KEY, NOTATION_KEY];

interface State {
  account: string;
  /** The highest server rev this phone has pulled. */
  pulled: number;
  /** Per key, the server rev and a print of the value this phone last agreed on with the server. */
  synced: Record<string, [rev: number, print: string]>;
  /** When every kind's count on the server last matched this phone. */
  at: number | null;
}

interface Row {
  key: string;
  value: Value;
  rev: number;
}

interface Reply {
  rev: number;
  rows: Row[];
  counts: Record<string, number>;
}

export interface BackupResult {
  /** Keys this sync wrote on this phone. */
  changed: string[];
  /** When this phone was last fully backed up, or null if never. */
  at: number | null;
  /** False when the sync failed, so `at` may be old. */
  ok: boolean;
  /** Why it failed: no answer from the server, the account's backup is full, or the server turned the sync down. */
  problem?: "offline" | "full" | "failed";
  /** Values this phone holds back because the room can't store them: a key it can't name, or a value too long. */
  heldBack: number;
  signedOut?: true;
}

const ROUNDS = 3;
const BATCH_CHARS = 1_000_000;
const BATCH_ITEMS = 500;

function print(value: Value): string {
  if (value === null) return "-";
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return `${value.length}:${(hash >>> 0).toString(36)}`;
}

function readState(): State | null {
  try {
    const state = JSON.parse(localStorage.getItem(BACKUP_KEY) ?? "null") as State | null;
    return state && typeof state.account === "string" ? state : null;
  } catch {
    return null;
  }
}

const writeState = (state: State) => localStorage.setItem(BACKUP_KEY, JSON.stringify(state));

/** This phone's backed-up values by key: its localStorage entries, with the library as one entry per own song and setlist. */
type Local = Map<string, string>;

function readLocal(): Local {
  const local: Local = new Map();
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    const value = key === null ? null : localStorage.getItem(key);
    if (key !== null && value !== null && backupKindOf(key)) local.set(key, value);
  }
  for (const [key, value] of ownLibraryItems(localStorage.getItem(LIBRARY_KEY))) local.set(key, value);
  return local;
}

const isLibraryItem = (key: string) => key.startsWith(`${SONG_ROW}.`) || key.startsWith(`${SETLIST_ROW}.`);

/** Writes one reply's changes, the songs and setlists as one library write, then tells every screen to read again. */
function writeLocal(writes: Map<string, Value>) {
  if (writes.size === 0) return;
  const items = new Map([...writes].filter(([key]) => isLibraryItem(key)));
  for (const [key, value] of writes) {
    if (items.has(key)) continue;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
  if (items.size > 0) localStorage.setItem(LIBRARY_KEY, withOwnLibraryItems(localStorage.getItem(LIBRARY_KEY), items));
  storageChanged();
}

const syncedPrint = (state: State, key: string) => state.synced[key]?.[1] ?? print(null);

/**
 * Keys whose value here differs from the last one agreed with the server, removed keys included. A key the room
 * can't take is held back rather than sent, so it can't make the rest of the sync fail.
 */
function pending(state: State, local: Local) {
  const changes = new Map<string, Value>();
  const held = new Set<string>();
  for (const key of new Set([...local.keys(), ...Object.keys(state.synced)])) {
    const value = local.get(key) ?? null;
    if (print(value) === syncedPrint(state, key)) continue;
    if (validBackupKey(key) && (value?.length ?? 0) <= MAX_VALUE_CHARS) changes.set(key, value);
    else held.add(key);
  }
  return { changes, held };
}

/** The song id when `key` is a song's row or one of its settings, `<key>.<song id>`. */
function songOf(key: string): number | null {
  for (const prefix of [SONG_ROW, ...PER_SONG_KEYS]) {
    const id = key.startsWith(`${prefix}.`) ? Number(key.slice(prefix.length + 1)) : NaN;
    if (Number.isInteger(id)) return id;
  }
  return null;
}

/**
 * The changes for the next request. Each song goes with its own settings, and setlists after every song, so a song
 * that moves to a new id takes its settings and setlists along before any of them is stored under the old id.
 */
function nextBatch(changes: Map<string, Value>): Map<string, Value> {
  const groupOf = (key: string) => {
    const song = songOf(key);
    return song !== null ? `0:${String(song).padStart(16, "0")}` : `${key.startsWith(`${SETLIST_ROW}.`) ? 1 : 2}:${key}`;
  };
  const groups = new Map<string, [string, Value][]>();
  for (const entry of changes) groups.set(groupOf(entry[0]), [...(groups.get(groupOf(entry[0])) ?? []), entry]);
  const batch = new Map<string, Value>();
  let size = 0;
  for (const name of [...groups.keys()].sort()) {
    const group = groups.get(name)!;
    const length = group.reduce((sum, [key, value]) => sum + key.length + (value?.length ?? 0), 0);
    if (batch.size > 0 && (size + length > BATCH_CHARS || batch.size + group.length > BATCH_ITEMS)) break;
    for (const [key, value] of group) batch.set(key, value);
    size += length;
  }
  return batch;
}

/** How many values of each kind the server should hold for this phone. A held-back key counts only if the server has an older value of it. */
function counts(state: State, local: Local, held: Set<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of local.keys()) {
    const kind = backupKindOf(key);
    if (kind && !(held.has(key) && syncedPrint(state, key) === print(null))) out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

const KIND_NAMES = [...new Set(BACKUP_KINDS.map((kind) => kind.name))];
const sameCounts = (a: Record<string, number>, b: Record<string, number>) => KIND_NAMES.every((name) => (a[name] ?? 0) === (b[name] ?? 0));

/** A short name for this phone, used in "· from iPhone" when both phones changed the same song. */
function phoneLabel(): string {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return ["iPhone", "iPad", "Android", "Mac", "Windows"].find((name) => agent.includes(name)) ?? "another phone";
}

/** A print no value has, so the key counts as changed here and goes out next round, where the server's row meets it. */
const UNSETTLED = "?";

const itemText = (value: string) => {
  try {
    return JSON.stringify(JSON.parse(value).item);
  } catch {
    return value;
  }
};

/**
 * Applies one reply. A key this phone sent comes back either as sent (stored) or as the server's newer value, which
 * is merged with this phone's and sent again next round. A key it didn't send is pulled, unless it changed here
 * meanwhile. A song or setlist both phones changed stays the server's under its id, and this phone's copy moves to a
 * new id with its per-song settings and this phone's unsent setlists. Returns how many keys still need another round.
 */
function apply(state: State, sent: Map<string, Value>, reply: Reply, changed: Set<string>): number {
  const local = readLocal();
  const writes = new Map<string, Value>();
  const write = (key: string, value: Value) => {
    if ((local.get(key) ?? null) === value) return;
    if (value === null) local.delete(key);
    else local.set(key, value);
    writes.set(key, value);
    changed.add(key);
  };
  const rows = new Map(reply.rows.map((row) => [row.key, row]));
  const settled = new Set<string>();
  const unsent = (key: string) => print(local.get(key) ?? null) !== syncedPrint(state, key);
  const idsIn = (prefix: string) => reply.rows.filter((row) => row.key.startsWith(`${prefix}.`)).map((row) => Number(row.key.slice(prefix.length + 1))).filter(Number.isInteger);
  const taken = { [SONG_ROW]: idsIn(SONG_ROW), [SETLIST_ROW]: idsIn(SETLIST_ROW) };

  const moveSetting = (from: string, to: string) => {
    const mine = local.get(from) ?? null;
    if (mine !== null) write(to, mine);
    const there = rows.get(from);
    if (there) {
      write(from, sent.has(from) && there.value === sent.get(from) ? null : there.value);
      state.synced[from] = [there.rev, print(there.value)];
      settled.add(from);
    } else if (!state.synced[from]) write(from, null);
  };
  const keepBoth = (prefix: typeof SONG_ROW | typeof SETLIST_ROW, key: string) => {
    const id = Number(key.slice(prefix.length + 1));
    const to = freeOwnId(localStorage.getItem(LIBRARY_KEY), prefix, taken[prefix]);
    taken[prefix].push(to);
    write(`${prefix}.${to}`, copiedOwnItem(local.get(key)!, to, phoneLabel()));
    if (prefix !== SONG_ROW) return;
    for (const songKey of PER_SONG_KEYS) moveSetting(`${songKey}.${id}`, `${songKey}.${to}`);
    for (const [other, value] of [...local]) if (other.startsWith(`${SETLIST_ROW}.`) && unsent(other)) write(other, setlistWithSongMoved(value, id, to));
  };

  let conflicts = 0;
  for (const prefix of [SONG_ROW, SETLIST_ROW] as const) {
    for (const row of reply.rows) {
      const mine = local.get(row.key);
      if (!row.key.startsWith(`${prefix}.`) || !sent.has(row.key) || row.value === null || mine === undefined) continue;
      if (itemText(row.value) !== itemText(mine)) {
        keepBoth(prefix, row.key);
        conflicts += 1;
      }
    }
  }
  for (const row of reply.rows) {
    const kind = backupKindOf(row.key);
    if (!kind || settled.has(row.key)) continue;
    const mine = local.get(row.key) ?? null;
    let next = row.value;
    if (sent.has(row.key)) next = row.value === sent.get(row.key) ? mine : MERGE[kind](row.value, mine, phoneLabel());
    else if (unsent(row.key)) {
      state.synced[row.key] = [state.synced[row.key]?.[0] ?? 0, UNSETTLED];
      continue;
    }
    write(row.key, next);
    if (next !== row.value) conflicts += 1;
    state.synced[row.key] = [row.rev, print(row.value)];
  }
  state.pulled = Math.max(state.pulled, reply.rev);
  writeLocal(writes);
  return conflicts;
}

/** False once this phone signed out, or signed in to another account, while a sync was on its way. */
const stillOn = (state: State) => readState()?.account === state.account;

function save(state: State) {
  if (stillOn(state)) writeState(state);
}

async function syncOnce(state: State): Promise<BackupResult> {
  const changed = new Set<string>();
  let serverCounts: Record<string, number> = {};
  for (let round = 0; round < ROUNDS; round += 1) {
    let conflicts = 0;
    const sentThisRound = new Set<string>();
    for (;;) {
      const left = new Map([...pending(state, readLocal()).changes].filter(([key]) => !sentThisRound.has(key)));
      const batch = nextBatch(left);
      const changes = [...batch].map(([key, value]) => ({ key, kind: backupKindOf(key), value, base: state.synced[key]?.[0] ?? 0 }));
      const reply = await api<Reply>("/api/backup", { since: state.pulled, changes });
      conflicts += apply(state, batch, reply, changed);
      serverCounts = reply.counts;
      save(state);
      for (const key of batch.keys()) sentThisRound.add(key);
      if (batch.size === left.size) break;
    }
    if (conflicts === 0) break;
  }
  const local = readLocal();
  const { changes, held } = pending(state, local);
  if (changes.size === 0 && sameCounts(serverCounts, counts(state, local, held))) state.at = Date.now();
  save(state);
  return { changed: [...changed], at: state.at, ok: true, heldBack: held.size };
}

let running: Promise<BackupResult> | null = null;

/**
 * Sends this phone's changes to the account's backup and pulls the other phones'. Signed out it returns at once
 * without calling the server. The first sync uploads everything and changes nothing on this phone. With
 * `onlyIfChanged`, a phone with nothing new to send skips the call, so an idle open app costs no requests.
 */
export function syncBackup({ onlyIfChanged = false } = {}): Promise<BackupResult> {
  const state = readState();
  if (!state || running) return running ?? Promise.resolve({ changed: [], at: null, ok: true, heldBack: 0 });
  if (onlyIfChanged && pending(state, readLocal()).changes.size === 0) return Promise.resolve({ changed: [], at: state.at, ok: true, heldBack: 0 });
  running = syncOnce(state)
    .catch((error): BackupResult => {
      if (error instanceof ApiError && error.status === 401 && stillOn(state)) {
        backupOff();
        return { changed: [], at: null, ok: false, heldBack: 0, signedOut: true };
      }
      const problem = !(error instanceof ApiError) ? "failed" : error.status === 0 ? "offline" : error.reason === "backup-full" ? "full" : "failed";
      return { changed: [], at: state.at, ok: false, heldBack: 0, problem };
    })
    .finally(() => (running = null));
  return running;
}

/** Turns backup on for this account. Another account on this phone starts over, so this phone's data goes to it too. */
export function backupOn(account: string) {
  if (readState()?.account !== account) writeState({ account, pulled: 0, synced: {}, at: null });
}

/** Signing out stops backup. Nothing else on the phone is removed. */
export function backupOff() {
  localStorage.removeItem(BACKUP_KEY);
}
