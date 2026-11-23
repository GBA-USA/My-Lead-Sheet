import { bandSongRef, type BandSong, type SongContent } from "./band-library-model";
import type { GigPack } from "./gig-pack";
import type { ShareChoice } from "./share-rule";
import type { HistoryStore, SyncRecord } from "./sync-history";
import type { SongRef } from "./types";

/** A band song cached on this phone so search and the gig pack can read it with no signal (PLAN.md 10). */
export type CachedBandSong = { bandId: string; bandName: string; songId: string; song: SongContent; sharedAs: ShareChoice; updatedAt: number };

/**
 * The stores of this phone's `mls-phone` database, each with its key and value. `bandSongs` is keyed
 * `"<bandId>/<songId>"`, the song's `SongRef` from `bandSongRef`. `gigPacks` is keyed by gig id. `syncHistory` is keyed
 * `"<route>/<day>"` (src/sync-history.ts) and belongs to this phone, not to an account.
 */
export type PhoneStores = {
  bandSongs: { key: SongRef; value: CachedBandSong };
  gigPacks: { key: string; value: GigPack };
  syncHistory: { key: string; value: SyncRecord };
};

export type PhoneStore = keyof PhoneStores;

/** Band data: cleared when another account takes the phone. */
export const PHONE_STORES: readonly Exclude<PhoneStore, "syncHistory">[] = ["bandSongs", "gigPacks"];

/** The store of the sync history, which `check:privacy` finds by this name. */
const SYNC_HISTORY_KEY = "syncHistory" satisfies PhoneStore;

/** Every store the database has. The sync history is numbers about this phone and its routes, so it stays when the account changes. */
const ALL_STORES: readonly PhoneStore[] = [...PHONE_STORES, SYNC_HISTORY_KEY];

const PHONE_DB_VERSION = 2;

const settled = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Opens this phone's database, making its stores the first time. The caller closes it. */
export function openPhoneDb(): Promise<IDBDatabase> {
  const request = indexedDB.open("mls-phone", PHONE_DB_VERSION);
  request.onupgradeneeded = () => {
    for (const store of ALL_STORES) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
  };
  return settled(request);
}

async function inStore<T>(store: PhoneStore, mode: IDBTransactionMode, work: (objects: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openPhoneDb();
  try {
    return await settled(work(db.transaction(store, mode).objectStore(store)));
  } finally {
    db.close();
  }
}

export function getFromPhone<S extends PhoneStore>(store: S, key: PhoneStores[S]["key"]): Promise<PhoneStores[S]["value"] | undefined> {
  return inStore(store, "readonly", (objects) => objects.get(key) as IDBRequest<PhoneStores[S]["value"] | undefined>);
}

export async function putOnPhone<S extends PhoneStore>(store: S, key: PhoneStores[S]["key"], value: PhoneStores[S]["value"]): Promise<void> {
  await inStore(store, "readwrite", (objects) => objects.put(value, key));
}

export function allOnPhone<S extends PhoneStore>(store: S): Promise<PhoneStores[S]["value"][]> {
  return inStore(store, "readonly", (objects) => objects.getAll() as IDBRequest<PhoneStores[S]["value"][]>);
}

async function written(stores: readonly PhoneStore[], work: (transaction: IDBTransaction) => void): Promise<void> {
  const db = await openPhoneDb();
  try {
    const writing = db.transaction(stores, "readwrite");
    work(writing);
    await new Promise<void>((resolve, reject) => {
      writing.oncomplete = () => resolve();
      writing.onerror = () => reject(writing.error);
    });
  } finally {
    db.close();
  }
}

let generation = 0;
const listeners = new Set<() => void>();

/** Goes up each time this phone's band data is cleared or written, so a screen holding a copy reads it again. */
export const phoneGeneration = () => generation;

export function onPhoneChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function phoneChanged() {
  generation += 1;
  for (const listener of listeners) listener();
}

const PHONE_OWNER_KEY = "leadSheetsPhoneOwner";

/** Empties every store, so band data leaves the phone with the account that downloaded it (PLAN.md 10). */
export async function clearPhone(): Promise<void> {
  await written(PHONE_STORES, (clearing) => {
    for (const store of PHONE_STORES) clearing.objectStore(store).clear();
  });
  localStorage.removeItem(PHONE_OWNER_KEY);
  phoneChanged();
}

const bandKeys = (bandId: string) => IDBKeyRange.bound(`${bandId}/`, `${bandId}/\uffff`);

/** Empties one band's songs and gig packs, so nothing of a band stays on this phone once the player is out of it (SCREEN-MAP 4, band-only rule). */
export async function clearBand(bandId: string): Promise<void> {
  await written(["bandSongs", "gigPacks"], (clearing) => {
    clearing.objectStore("bandSongs").delete(bandKeys(bandId));
    const packs = clearing.objectStore("gigPacks").openCursor();
    packs.onsuccess = () => {
      const cursor = packs.result;
      if (!cursor) return;
      if ((cursor.value as GigPack).gig.bandId === bandId) cursor.delete();
      cursor.continue();
    };
  });
  phoneChanged();
}

/** Whether this phone's band data is `userId`'s. Unlike `claimPhone` it writes nothing, so a reader cannot clear the phone and wake itself again. */
export function heldFor(userId: string): boolean {
  try {
    return localStorage.getItem(PHONE_OWNER_KEY) === userId;
  } catch {
    return false;
  }
}

/** Marks this phone's band data as `userId`'s. Anything another account left here is cleared first, so a shared phone never shows it. */
export async function claimPhone(userId: string): Promise<void> {
  if (localStorage.getItem(PHONE_OWNER_KEY) === userId) return;
  await clearPhone();
  localStorage.setItem(PHONE_OWNER_KEY, userId);
}

/** Replaces one band's songs on this phone with the list its band screen just loaded, so search finds them with no signal (PLAN.md 9.2). */
export async function holdBandSongs(userId: string, bandId: string, bandName: string, songs: BandSong[]): Promise<void> {
  await claimPhone(userId);
  await written(["bandSongs"], (writing) => {
    const store = writing.objectStore("bandSongs");
    store.delete(bandKeys(bandId));
    for (const { songId, song, sharedAs, updatedAt } of songs) store.put({ bandId, bandName, songId, song, sharedAs, updatedAt }, bandSongRef(bandId, songId));
  });
  phoneChanged();
}

/** Drops the songs of every band missing from `bandIds`, the list the server just gave this account, so a band left or removed from leaves search too. */
export async function keepBandsOnPhone(bandIds: string[]): Promise<void> {
  await written(["bandSongs"], (writing) => {
    const store = writing.objectStore("bandSongs");
    const keys = store.getAllKeys();
    keys.onsuccess = () => {
      for (const key of keys.result) if (!bandIds.includes(String(key).split("/")[0])) store.delete(key);
    };
  });
  phoneChanged();
}

/** The phone's sync history in the shape `src/sync-history.ts` reads and writes. */
export const syncHistoryStore: HistoryStore = {
  get: (key) => getFromPhone("syncHistory", key),
  put: (key, value) => putOnPhone("syncHistory", key, value),
  remove: (key) => inStore("syncHistory", "readwrite", (objects) => objects.delete(key)).then(() => undefined),
  async entries() {
    const db = await openPhoneDb();
    try {
      const objects = db.transaction("syncHistory", "readonly").objectStore("syncHistory");
      const [keys, values] = await Promise.all([settled(objects.getAllKeys()), settled(objects.getAll() as IDBRequest<SyncRecord[]>)]);
      return keys.map((key, i): [string, SyncRecord] => [String(key), values[i]]);
    } finally {
      db.close();
    }
  },
};
