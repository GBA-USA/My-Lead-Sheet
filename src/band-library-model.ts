import { chordProToSong, normalizeChordPro, type SentSong, type SongContent } from "./chordpro";
import { matchingSongs } from "./search";
import type { ShareChoice } from "./share-rule";
import type { Song, SongRef } from "./types";

export type { SentSong, SongContent } from "./chordpro";

/** A song as a reply, a phone store or a card may hold it. A store filled before the update, and a card from an old build, hold the old object. */
export type WireSong = SentSong | SongContent;

const sentCache = new Map<string, SongContent>();

function freezeSent(song: SongContent): SongContent {
  for (const section of song.body) {
    for (const line of section.lines) Object.freeze(line);
    Object.freeze(section.lines);
    Object.freeze(section);
  }
  Object.freeze(song.body);
  if (song.kept) Object.freeze(song.kept);
  return Object.freeze(song);
}

/** The door. Text is normalized for CRLF/BOM and parsed once per text. The old object comes back as it is. */
export function songFromSent(song: WireSong): SongContent {
  if (typeof (song as SentSong).chordpro === "string") {
    const text = normalizeChordPro((song as SentSong).chordpro);
    let parsed = sentCache.get(text);
    if (!parsed) {
      parsed = freezeSent(chordProToSong(text));
      sentCache.set(text, parsed);
    }
    return parsed;
  }
  return song as SongContent;
}

/** What every band item says about how it arrived. `canSendOn` is the server's answer for the caller, so the phone only hides buttons with it. */
type Shared = { sharedBy: string; sharedByName: string; sharedAt: number; updatedAt: number; rev: number; sharedAs: ShareChoice; canSendOn: boolean; localId: number | null };

export type BandSong = Shared & { songId: string; song: SongContent };
export type WireBandSong = Shared & { songId: string; song: WireSong };
export type BandSetlist = Shared & { setlistId: string; name: string; songIds: string[]; tags: string[] };
export type BandLibrary = { songs: BandSong[]; setlists: BandSetlist[] };
export type WireBandLibrary = { songs: WireBandSong[]; setlists: BandSetlist[] };

export type CopiedSong = { song: SongContent; copy: { id: string; canSendOn: boolean } };

export const SONG_SORTS = { title: "A-Z", artist: "Artist", newest: "Newest" } as const;
export type SongSort = keyof typeof SONG_SORTS;
export const SETLIST_SORTS = { newest: "Newest", name: "A-Z" } as const;
export type SetlistSort = keyof typeof SETLIST_SORTS;

export const bandSongRef = (bandId: string, songId: string): SongRef => `${bandId}/${songId}`;

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

export function visibleSongs(bandId: string, songs: BandSong[], query: string, sort: SongSort): BandSong[] {
  const asSongs = songs.map((item): Song => ({ ...item.song, ref: bandSongRef(bandId, item.songId), id: 0 }));
  const hits = new Set(matchingSongs(asSongs, query).map((song) => song.ref));
  const order: Record<SongSort, (a: BandSong, b: BandSong) => number> = {
    title: (a, b) => byText(a.song.title, b.song.title),
    artist: (a, b) => byText(a.song.artist, b.song.artist) || byText(a.song.title, b.song.title),
    newest: (a, b) => b.sharedAt - a.sharedAt,
  };
  return songs.filter((item) => hits.has(bandSongRef(bandId, item.songId))).sort((a, b) => order[sort](a, b) || byText(a.songId, b.songId));
}

export function visibleSetlists(setlists: BandSetlist[], filter: { mine: boolean; tag: string | null }, me: string, sort: SetlistSort): BandSetlist[] {
  const order: Record<SetlistSort, (a: BandSetlist, b: BandSetlist) => number> = {
    newest: (a, b) => b.sharedAt - a.sharedAt,
    name: (a, b) => byText(a.name, b.name),
  };
  return setlists
    .filter((item) => (!filter.mine || item.sharedBy === me) && (filter.tag === null || item.tags.includes(filter.tag)))
    .sort((a, b) => order[sort](a, b) || byText(a.setlistId, b.setlistId));
}

export const setlistTags = (setlists: BandSetlist[]) => [...new Set(setlists.flatMap((item) => item.tags))].sort(byText);

export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ]
    .slice(0, 8)
    .map((tag) => tag.slice(0, 24));
}
