import type { SongContent } from "./band-library-model";
import type { GigPlan } from "./gig-plan-model";
import { claimPhone, getFromPhone, openPhoneDb, putOnPhone } from "./phone-db";
import type { ScrollVersion } from "./scroll-timing";
import { ApiError, api } from "./sign-in-methods";

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

/** setTimeout fires at once when asked to wait longer than this, about 24.8 days. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

/** Runs `then` the moment the guest pass a pack came with ends, and returns what cancels it. A lineup player's pack never ends. */
export function atPassEnd(pack: GigPack | null | undefined, then: () => void): () => void {
  const ends = pack?.expiresAt;
  if (ends == null) return () => {};
  let timer: ReturnType<typeof setTimeout>;
  const wait = () => {
    const left = ends - Date.now();
    timer = left > LONGEST_TIMER_MS ? setTimeout(wait, LONGEST_TIMER_MS) : setTimeout(then, left);
  };
  wait();
  return () => clearTimeout(timer);
}

/** The server's words for a guest pass that no longer opens its gig. Its pack leaves the phone as soon as the phone hears one. */
const PASS_GONE: readonly string[] = ["pass-revoked", "pass-ended"];

/**
 * Deletes every pack whose guest pass has ended. The end is in the pack, so this needs no signal. `src/main.tsx` awaits
 * it before the first render, so an ended pass's charts never show, not even for one frame (PLAN.md 7.14).
 */
export const dropEndedPacks = (now = Date.now()) => dropPacks((pack) => packEnded(pack, now));

async function dropPacks(gone: (pack: GigPack) => boolean): Promise<void> {
  const db = await openPhoneDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const sweeping = db.transaction("gigPacks", "readwrite");
      const cursor = sweeping.objectStore("gigPacks").openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        if (gone(at.value as GigPack)) at.delete();
        at.continue();
      };
      sweeping.oncomplete = () => resolve();
      sweeping.onerror = () => reject(sweeping.error);
    });
  } finally {
    db.close();
  }
}

/**
 * The pack this phone may show for the gig, or null. A lineup player's pack shows at once, with or without a signal. A
 * guest's pack shows only once the server says the pass still opens the gig, so a revoked pass's charts never flash up;
 * a pass the server calls revoked or ended takes its pack off the phone. With no signal the pack's own end decides.
 */
export async function packToShow(gigId: string): Promise<GigPack | null> {
  const pack = await getFromPhone("gigPacks", gigId);
  if (!pack) return null;
  if (packEnded(pack)) return dropEndedPacks().then(() => null);
  if (pack.expiresAt === null) return pack;
  try {
    await api("/api/bands/gig/open", { bandId: pack.gig.bandId, gigId });
    return pack;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (PASS_GONE.includes(error.reason)) return dropPacks((held) => held.gig.gigId === gigId).then(() => null);
    return error.reason === "offline" || error.status >= 500 ? pack : null;
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
