import type { SongContent } from "./band-library-model";
import type { ScrollVersion } from "./scroll-timing";
import type { ShareChoice } from "./share-rule";
import type { Song, SongData } from "./types";

/** A song card's body in a DM, as the server stored it. `reshareable` is the server's answer for the friend who got it. */
export type SongMessage = { song: SongContent; versions: ScrollVersion[]; data: SongData | null; shareId: string; updateOf: string | null; sharedAs: ShareChoice; reshareable: boolean };

/** What the phone asks the server to send. `copyId` names the copy the sender holds, if the song came from someone. */
export type SongSend = { userId: string; shareId: string; song: SongContent; versions: ScrollVersion[]; data: SongData | null; choice: ShareChoice; copyId: string | null; updateOf: string | null };

/** What the sender ticked: timing versions by their place in the song's list, and whether My song data goes too. The chart always goes. */
export type SendPick = { versions: number[]; data: boolean; choice: ShareChoice | null };

export const canSend = (pick: SendPick): pick is SendPick & { choice: ShareChoice } => pick.choice !== null;

/** A song from a friend as this phone keeps it: the chart in My Songs, marked with who sent it, and what came with it. */
export type Received = { song: Omit<Song, "ref" | "id">; versions: ScrollVersion[]; data: SongData | null };

export function received(message: SongMessage, fromName: string, title = message.song.title): Received {
  return {
    song: { ...message.song, title, copy: { id: message.shareId, canSendOn: message.reshareable, from: { name: fromName } } },
    versions: message.versions,
    data: message.data,
  };
}

export type UpdateChoice = "keep-mine" | "take-theirs" | "keep-both";

/** What an update does to the copy this phone holds now: nothing, replace it (its versions stay when the update has none), or add a second song. */
export function applyUpdate(update: SongMessage, fromName: string, choice: UpdateChoice): { replace: Received | null; add: Received | null } {
  if (choice === "keep-mine") return { replace: null, add: null };
  if (choice === "take-theirs") return { replace: received(update, fromName), add: null };
  return { replace: null, add: received(update, fromName, `${update.song.title} (update)`) };
}

/** The line under a song card: "from Mike · Private · includes V2 · learned". */
export function cardLine(message: SongMessage, fromName: string): string {
  const parts = [`from ${fromName}`, message.sharedAs === "private" ? "Private" : "Public"];
  if (message.versions.length > 0) parts.push(`includes ${message.versions.map((v) => (v.learned ? `${v.name} · learned` : v.name)).join(", ")}`);
  if (message.data) parts.push("song data");
  return parts.join(" · ");
}

export function songMessageIn(text: string): SongMessage | null {
  try {
    const message = JSON.parse(text) as SongMessage;
    return typeof message?.song?.title === "string" && typeof message.shareId === "string" && Array.isArray(message.versions) ? message : null;
  } catch {
    return null;
  }
}
