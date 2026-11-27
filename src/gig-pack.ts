import { songFromSent, type SongContent, type WireSong } from "./band-library-model";
import type { GigPlan } from "./gig-plan-model";
import { claimPhone, dropGigPacks, getFromPhone, putOnPhone } from "./phone-db";
import type { ScrollVersion } from "./scroll-timing";
import { ApiError, api } from "./sign-in-methods";

export type { GigPlan, GigStatus } from "./gig-plan-model";

/** One song of the pack: the band's chart as frozen at plan time, with the band's timing for it when the band has one. */
export type GigPackSong = { songId: string; song: SongContent; bandTiming: ScrollVersion | null };
export type StoredGigPackSong = Omit<GigPackSong, "song"> & { song: WireSong };

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
export type StoredGigPack = Omit<GigPack, "songs"> & { songs: StoredGigPackSong[] };

const packFromStored = (pack: StoredGigPack): GigPack => ({
  ...pack,
  songs: pack.songs.map((item) => ({ ...item, song: songFromSent(item.song) })),
});

/** Whether the guest pass a pack came with has ended. A lineup player's pack has no end. */
export const packEnded = (pack: Pick<GigPack, "expiresAt">, now = Date.now()) => pack.expiresAt !== null && pack.expiresAt <= now;

/** setTimeout fires at once when asked to wait longer than this, about 24.8 days. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

/** Runs `then` the moment a guest pass ends, by the end its pack or its gig view carries, and returns what cancels it. A lineup player's pack never ends. */
export function atPassEnd(held: { expiresAt: number | null } | null | undefined, then: () => void): () => void {
  const ends = held?.expiresAt;
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

/** Whether `error` is the server calling the gig's guest pass revoked or ended. If so the gig's pack is off this phone before this answers, whichever screen heard it. */
export async function passGone(gigId: string, error: unknown): Promise<boolean> {
  if (!(error instanceof ApiError) || !PASS_GONE.includes(error.reason)) return false;
  await dropGigPacks((held) => held.gig.gigId === gigId);
  return true;
}

/** How long a guest's phone waits for the server's word on the pass. A weak venue signal can leave a request hanging. */
const ASK_PASS_MS = 4000;

/**
 * Deletes every pack whose guest pass has ended. The end is in the pack, so this needs no signal. `src/main.tsx` awaits
 * it before the first render, so an ended pass's charts never show, not even for one frame (PLAN.md 7.14).
 */
export const dropEndedPacks = (now = Date.now()) => dropGigPacks((pack) => packEnded(pack, now));

/**
 * The pack this phone may show for the gig, or null. A lineup player's pack shows at once, with or without a signal. A
 * guest's pack shows once the server says the pass still opens the gig, so a revoked pass's charts don't flash up. With
 * no signal, or no answer within ASK_PASS_MS, the pack's own end decides. A pass the server calls revoked or ended
 * takes its pack off the phone even when the answer comes late, and the screens showing it read again.
 */
export async function packToShow(gigId: string): Promise<GigPack | null> {
  const stored = await getFromPhone("gigPacks", gigId);
  if (!stored) return null;
  if (packEnded(stored)) return dropEndedPacks().then(() => null);
  const pack = packFromStored(stored);
  if (pack.expiresAt === null) return pack;
  const verdict = api("/api/bands/gig/open", { bandId: pack.gig.bandId, gigId }).then(
    () => pack,
    async (error) => {
      if (!(error instanceof ApiError)) throw error;
      if (await passGone(gigId, error)) return null;
      return error.reason === "offline" || error.status >= 500 ? pack : null;
    },
  );
  return Promise.race([verdict, new Promise<GigPack>((resolve) => setTimeout(resolve, ASK_PASS_MS, pack))]);
}

/** Downloads the pack and keeps it on this phone under the gig's id, so a second download replaces the first. An older rev never replaces a newer one. */
export async function downloadPack(userId: string, bandId: string, gigId: string): Promise<GigPack> {
  const fresh = await api<StoredGigPack>("/api/bands/gig/pack", { bandId, gigId });
  await claimPhone(userId);
  const kept = await getFromPhone("gigPacks", gigId);
  if (kept && kept.packRev > fresh.packRev) return packFromStored(kept);
  await putOnPhone("gigPacks", gigId, fresh);
  return packFromStored(fresh);
}

/** The packs on this phone for these gigs that `userId` downloaded. A phone that can't open its database has none. */
export async function packsOnPhone(userId: string, gigIds: string[]): Promise<Record<string, GigPack>> {
  const claimed = await claimPhone(userId).then(
    () => true,
    () => false,
  );
  if (!claimed) return {};
  const found = await Promise.all(gigIds.map((gigId) => getFromPhone("gigPacks", gigId).catch(() => undefined)));
  return Object.fromEntries(found.flatMap((pack) => (pack && !packEnded(pack) ? [[pack.gig.gigId, packFromStored(pack)]] : [])));
}
