import { ApiError, api } from "./sign-in-methods";
import { AWAKE_KEY, LIBRARY_KEY, NOTATION_KEY, SCROLL_PERCENT_KEY, SCROLL_VERSIONS_KEY, SONG_DATA_KEY, TEXT_SCALE_KEY, mergeOwnLibraries, ownLibrary } from "./storage";

/** This phone's sync state for the signed-in account. Present only while signed in, so a signed-out phone never syncs. */
export const BACKUP_KEY = "leadSheetsBackup";

type Value = string | null;
/** How two values of one key combine when both phones changed it since they last synced. */
type Merge = (server: Value, phone: Value, phoneLabel: string) => Value;

interface Kind {
  name: string;
  key: string;
  /** False when `key.<song ref>` entries belong to this kind too. */
  exact?: true;
  /** What this phone backs up for the key, from the raw localStorage text. */
  read?: (raw: Value) => Value;
  merge: Merge;
}

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

/**
 * Everything a phone backs up, one entry per localStorage key. Conflict rule (PLAN.md section 10): songs and setlists
 * keep both copies, timing versions are combined, and for a single value the phone that syncs last wins.
 * `leadSheetsMetronome` stays on each phone, because its Bluetooth delay belongs to that phone's speaker.
 */
const KINDS: readonly Kind[] = [
  { name: "library", key: LIBRARY_KEY, exact: true, read: ownLibrary, merge: mergeOwnLibraries },
  { name: "timing", key: SCROLL_VERSIONS_KEY, merge: combineVersions },
  { name: "song-data", key: SONG_DATA_KEY, merge: lastSyncWins },
  { name: "scroll", key: SCROLL_PERCENT_KEY, merge: lastSyncWins },
  { name: "notation", key: NOTATION_KEY, merge: lastSyncWins },
  { name: "settings", key: TEXT_SCALE_KEY, exact: true, merge: lastSyncWins },
  { name: "settings", key: AWAKE_KEY, exact: true, merge: lastSyncWins },
];

const kindOf = (key: string) => KINDS.find((kind) => key === kind.key || (!kind.exact && key.startsWith(`${kind.key}.`)));

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
  /** Keys this sync wrote on this phone. The app reloads what it shows from them. */
  changed: string[];
  /** When this phone was last fully backed up, or null if never. */
  at: number | null;
  /** False when the server could not be reached or refused, so `at` may be old. */
  ok: boolean;
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

function readValue(key: string): Value {
  const raw = localStorage.getItem(key);
  return kindOf(key)?.read?.(raw) ?? raw;
}

function writeValue(key: string, value: Value) {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

function localKeys(): string[] {
  return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => key !== null && !!kindOf(key));
}

const syncedPrint = (state: State, key: string) => state.synced[key]?.[1] ?? print(null);

/** Keys whose value here differs from the last one agreed with the server, removed keys included. */
function pending(state: State): Map<string, Value> {
  const changes = new Map<string, Value>();
  for (const key of new Set([...localKeys(), ...Object.keys(state.synced)])) {
    const value = readValue(key);
    if (print(value) !== syncedPrint(state, key)) changes.set(key, value);
  }
  return changes;
}

function batches(changes: Map<string, Value>): Map<string, Value>[] {
  const out: Map<string, Value>[] = [new Map()];
  let size = 0;
  for (const [key, value] of changes) {
    const length = (value?.length ?? 0) + key.length;
    const last = out[out.length - 1];
    if (last.size > 0 && (size + length > BATCH_CHARS || last.size >= BATCH_ITEMS)) {
      out.push(new Map());
      size = 0;
    }
    out[out.length - 1].set(key, value);
    size += length;
  }
  return out;
}

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of localKeys()) {
    const name = kindOf(key)?.name;
    if (name && readValue(key) !== null) out[name] = (out[name] ?? 0) + 1;
  }
  return out;
}

const sameCounts = (a: Record<string, number>, b: Record<string, number>) => KINDS.every(({ name }) => (a[name] ?? 0) === (b[name] ?? 0));

/** A short name for this phone, used in "· from iPhone" when both phones changed the same song. */
function phoneLabel(): string {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return ["iPhone", "iPad", "Android", "Mac", "Windows"].find((name) => agent.includes(name)) ?? "another phone";
}

/** A print no value has, so the key counts as changed here and goes out next round, where the server's row meets it. */
const UNSETTLED = "?";

/**
 * Applies one reply. A key this phone sent comes back either as sent (stored) or as the server's newer value, which
 * is merged with this phone's and sent again next round. A key it didn't send is pulled, unless it changed here
 * meanwhile. Returns how many keys still need another round.
 */
function apply(state: State, sent: Map<string, Value>, reply: Reply, changed: Set<string>): number {
  let conflicts = 0;
  for (const row of reply.rows) {
    const kind = kindOf(row.key);
    if (!kind) continue;
    const local = readValue(row.key);
    let next = row.value;
    if (sent.has(row.key)) next = row.value === sent.get(row.key) ? local : kind.merge(row.value, local, phoneLabel());
    else if (print(local) !== syncedPrint(state, row.key)) {
      state.synced[row.key] = [state.synced[row.key]?.[0] ?? 0, UNSETTLED];
      continue;
    }
    if (next !== local) {
      writeValue(row.key, next);
      changed.add(row.key);
    }
    if (next !== row.value) conflicts += 1;
    state.synced[row.key] = [row.rev, print(row.value)];
  }
  state.pulled = Math.max(state.pulled, reply.rev);
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
    for (const batch of batches(pending(state))) {
      const changes = [...batch].map(([key, value]) => ({ key, kind: kindOf(key)!.name, value, base: state.synced[key]?.[0] ?? 0 }));
      const reply = await api<Reply>("/api/backup", { since: state.pulled, changes });
      conflicts += apply(state, batch, reply, changed);
      serverCounts = reply.counts;
      save(state);
    }
    if (conflicts === 0) break;
  }
  if (pending(state).size === 0 && sameCounts(serverCounts, counts())) state.at = Date.now();
  save(state);
  return { changed: [...changed], at: state.at, ok: true };
}

let running: Promise<BackupResult> | null = null;

/**
 * Sends this phone's changes to the account's backup and pulls the other phones'. Signed out it returns at once
 * without calling the server. The first sync uploads everything and changes nothing on this phone. With
 * `onlyIfChanged`, a phone with nothing new to send skips the call, so an idle open app costs no requests.
 */
export function syncBackup({ onlyIfChanged = false } = {}): Promise<BackupResult> {
  const state = readState();
  if (!state || running) return running ?? Promise.resolve({ changed: [], at: null, ok: true });
  if (onlyIfChanged && pending(state).size === 0) return Promise.resolve({ changed: [], at: state.at, ok: true });
  running = syncOnce(state)
    .catch((error): BackupResult => {
      if (error instanceof ApiError && error.status === 401 && stillOn(state)) {
        backupOff();
        return { changed: [], at: null, ok: false, signedOut: true };
      }
      return { changed: [], at: state.at, ok: false };
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
