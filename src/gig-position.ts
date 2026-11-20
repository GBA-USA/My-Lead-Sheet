import { useEffect, useReducer } from "react";
import type { GigPlan } from "./gig-plan-model";
import { gigHref } from "./route";

/**
 * Where the band is in the set, and whether this phone may move it. The gig view and the gig-mode sheet read only this.
 * C21 owns the inside: it replaces the local index with the live feed (`src/gig-state.ts` `current`, moved by a `goTo`
 * op) and changes nothing on the screens. Today the leader's or backup's index is this phone's own, mirrored in the
 * sheet's hash; a member's is the song they opened, else the first, since `gig/open` carries no `current` yet.
 */
export type GigPosition = { index: number; canMove: boolean; goTo: (index: number) => void };

/** The index each gig was last at for each account on this phone, kept across the gig view and the sheet until the app reloads. */
const lastIndex = new Map<string, number>();

export function useGigPosition(gig: GigPlan | undefined, me: string | null, count: number, hashIndex: number | null): GigPosition {
  const key = `${me}/${gig?.gigId}`;
  const canMove = gig !== undefined && me !== null && (gig.leader === me || gig.backup === me);
  const clamp = (index: number) => Math.max(0, Math.min(Math.max(count - 1, 0), index));
  const [, moved] = useReducer((n: number) => n + 1, 0);
  const index = clamp(hashIndex ?? (canMove ? (lastIndex.get(key) ?? 0) : 0));

  useEffect(() => {
    if (canMove && hashIndex !== null) lastIndex.set(key, clamp(hashIndex));
  }, [key, canMove, hashIndex, count]);

  const goTo = (next: number) => {
    if (!canMove || !gig) return;
    lastIndex.set(key, clamp(next));
    if (hashIndex === null) moved();
    else window.location.replace(gigHref(gig.bandId, gig.gigId, clamp(next)));
  };

  return { index, canMove, goTo };
}
