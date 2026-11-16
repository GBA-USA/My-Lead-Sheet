import { bandSongRef, type BandSong, type SongContent } from "./band-library-model";
import type { GigPack } from "./gig-pack";
import type { ShareChoice } from "./share-rule";
import type { SongRef } from "./types";

/** A band song cached on this phone so search and the gig pack can read it with no signal (PLAN.md 10). */
export type CachedBandSong = { bandId: string; bandName: string; songId: string; song: SongContent; sharedAs: ShareChoice; updatedAt: number };

/**
 * The stores of this phone's `mls-phone` database, each with its key and value. `bandSongs` is keyed
 * `"<bandId>/<songId>"`, the song's `SongRef` from `bandSongRef`. `gigPacks` is keyed by gig id.
 */
export type PhoneStores = {
  bandSongs: { key: SongRef; value: CachedBandSong };
  gigPacks: { key: string; value: GigPack };
};

export type PhoneStore = keyof PhoneStores;

export const PHONE_STORES: readonly PhoneStore[] = ["bandSongs", "gigPacks"];

const PHONE_DB_VERSION = 1;

const settled = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Opens this phone's database, making its stores the first time. The caller closes it. */
export function openPhoneDb(): Promise<IDBDatabase> {
  const request = indexedDB.open("mls-phone", PHONE_DB_VERSION);
  request.onupgradeneeded = () => {
    for (const store of PHONE_STORES) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
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

const PHONE_OWNER_KEY = "leadSheetsPhoneOwner";

/** Empties every store, so band data leaves the phone with the account that downloaded it (PLAN.md 10). */
export async function clearPhone(): Promise<void> {
  await written(PHONE_STORES, (clearing) => {
    for (const store of PHONE_STORES) clearing.objectStore(store).clear();
  });
  localStorage.removeItem(PHONE_OWNER_KEY);
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
    store.delete(IDBKeyRange.bound(`${bandId}/`, `${bandId}/\uffff`));
    for (const { songId, song, sharedAs, updatedAt } of songs) store.put({ bandId, bandName, songId, song, sharedAs, updatedAt }, bandSongRef(bandId, songId));
  });
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
}
