import type { SongContent } from "./band-library-model";
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
