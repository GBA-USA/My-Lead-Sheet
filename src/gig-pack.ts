import type { SongContent } from "./band-library-model";
import type { GigPlan } from "./gig-plan-model";
import { claimPhone, getFromPhone, openPhoneDb, putOnPhone } from "./phone-db";
import type { ScrollVersion } from "./scroll-timing";
import { api } from "./sign-in-methods";

export type { GigPlan, GigStatus } from "./gig-plan-model";

/** One song of the pack: the band's chart as frozen at plan time, with the band's timing for it when the band has one. */
export type GigPackSong = { songId: string; song: SongContent; bandTiming: ScrollVersion | null };

/**
 * What a lineup phone downloads before the gig and keeps in IndexedDB (PLAN.md 7.3, 10). `secret` is in a lineup
 * player's pack only and proves the phone is on the lineup when it joins by QR; anyone else who may read the pack gets
 * null. `packRev` goes up when the plan changes, so a phone knows its pack is stale. `expiresAt` is set on a guest's pack.
 */
export type GigPack = {
  gig: GigPlan;
  songs: GigPackSong[];
  scrollWithLeader: boolean;
  secret: string | null;
  packRev: number;
  expiresAt: number | null;
};

/** Whether the guest pass a pack came with has ended. A lineup player's pack has no end. */
export const packEnded = (pack: GigPack, now = Date.now()) => pack.expiresAt !== null && pack.expiresAt <= now;

/**
 * Deletes every pack whose guest pass has ended. The end is in the pack, so this needs no signal. `src/main.tsx` awaits
 * it before the first render, so an ended pass's charts never show, not even for one frame (PLAN.md 7.14).
 */
export async function dropEndedPacks(now = Date.now()): Promise<void> {
  const db = await openPhoneDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const sweeping = db.transaction("gigPacks", "readwrite");
      const cursor = sweeping.objectStore("gigPacks").openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        if (packEnded(at.value as GigPack, now)) at.delete();
        at.continue();
      };
      sweeping.oncomplete = () => resolve();
      sweeping.onerror = () => reject(sweeping.error);
    });
  } finally {
    db.close();
  }
}

/** Downloads the pack and keeps it on this phone under the gig's id, so a second download replaces the first. An older rev never replaces a newer one. */
export async function downloadPack(userId: string, bandId: string, gigId: string): Promise<GigPack> {
  const fresh = await api<GigPack>("/api/bands/gig/pack", { bandId, gigId });
  await claimPhone(userId);
  const kept = await getFromPhone("gigPacks", gigId);
  if (kept && kept.packRev > fresh.packRev) return kept;
  await putOnPhone("gigPacks", gigId, fresh);
  return fresh;
}

/** The packs on this phone for these gigs that `userId` downloaded. A phone that can't open its database has none. */
export async function packsOnPhone(userId: string, gigIds: string[]): Promise<Record<string, GigPack>> {
  const claimed = await claimPhone(userId).then(
    () => true,
    () => false,
  );
  if (!claimed) return {};
  const found = await Promise.all(gigIds.map((gigId) => getFromPhone("gigPacks", gigId).catch(() => undefined)));
  return Object.fromEntries(found.flatMap((pack) => (pack && !packEnded(pack) ? [[pack.gig.gigId, pack]] : [])));
}
