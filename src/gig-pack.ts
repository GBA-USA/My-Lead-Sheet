import type { SongContent } from "./band-library-model";
import type { GigPlan } from "./gig-plan-model";
import { getFromPhone, putOnPhone } from "./phone-db";
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

/** Downloads the pack and keeps it on this phone under the gig's id, so a second download replaces the first. An older rev never replaces a newer one. */
export async function downloadPack(bandId: string, gigId: string): Promise<GigPack> {
  const fresh = await api<GigPack>("/api/bands/gig/pack", { bandId, gigId });
  const kept = await getFromPhone("gigPacks", gigId);
  if (kept && kept.packRev > fresh.packRev) return kept;
  await putOnPhone("gigPacks", gigId, fresh);
  return fresh;
}

/** The packs on this phone for these gigs. A phone that can't open its database has none. */
export async function packsOnPhone(gigIds: string[]): Promise<Record<string, GigPack>> {
  const found = await Promise.all(gigIds.map((gigId) => getFromPhone("gigPacks", gigId).catch(() => undefined)));
  return Object.fromEntries(found.flatMap((pack) => (pack ? [[pack.gig.gigId, pack]] : [])));
}
