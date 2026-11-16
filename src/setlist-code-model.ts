import type { SongContent } from "./band-library-model";
import type { ShareChoice } from "./share-rule";

/** A setlist card's text in a DM: the setlist's name, the ticked songs' titles, and the scanner's copy. No chart travels in a card. */
export type SetlistCard = { name: string; titles: string[]; copyId: string; sharedAs: ShareChoice; reshareable: boolean };

/** The copy behind a card, which only the scanner holding it can fetch: each ticked chart with the id of their copy of it. */
export type SetlistCopy = { name: string; songs: { song: SongContent; copyId: string }[]; reshareable: boolean };

export function setlistCardIn(text: string): SetlistCard | null {
  try {
    const card = JSON.parse(text);
    return typeof card?.name === "string" && Array.isArray(card.titles) && typeof card.copyId === "string" ? card : null;
  } catch {
    return null;
  }
}

/** What a setlist row offers: a code, a note that an empty setlist needs a song first, or nothing for a copy that can't be passed on. */
export type CodeOffer = "show" | "add-a-song" | "none";

export const codeOffer = (songCount: number, canSendOn: boolean): CodeOffer => (!canSendOn ? "none" : songCount === 0 ? "add-a-song" : "show");

/** The most songs one copy code carries, the same cap the server keeps. */
export const MAX_CODE_SONGS = 40;
