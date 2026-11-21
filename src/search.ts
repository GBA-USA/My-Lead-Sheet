import type { Setlist, Song, SongRef } from "./types";

/** Spaces go too, so "aint", "ain t" and "Ain't" all fold to the same key. */
export function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[^\p{L}\p{N}]/gu, "");
}

export function matchingSongs(songs: Song[], query: string): Song[] {
  const key = fold(query);
  return songs.filter((song) => fold(song.title).includes(key) || fold(song.artist).includes(key));
}

export function matchingSetlists(setlists: Setlist[], songs: Song[], query: string): Setlist[] {
  const key = fold(query);
  const hits = new Set(matchingSongs(songs, query).map((song) => song.ref));
  return setlists.filter((setlist) => fold(setlist.name).includes(key) || setlist.songRefs.some((ref) => hits.has(ref)));
}

/** The chips under the box. `band` is a band id. */
export type SongChips = { key: string | null; band: string | null; timed: boolean };

export const NO_CHIPS: SongChips = { key: null, band: null, timed: false };

export type SongGroup = { label: string; songs: Song[] };

export const keyName = (song: Song) => `${song.keyRoot}${song.keyMode === "minor" ? "m" : ""}`;

/**
 * The hits grouped by where they live, judged by ref and copy mark and never by content, since two players can hold
 * the same chart: My Songs, then one group per band in `bands` (band id to name), then one per friend who sent a copy.
 * A band ref outside `bands` is never shown.
 */
export function groupedSongs(songs: Song[], bands: ReadonlyMap<string, string>, query: string, chips: SongChips, timed: (ref: SongRef) => boolean): SongGroup[] {
  const groups = new Map<string, SongGroup>([["local", { label: "My Songs", songs: [] }], ...[...bands].map(([bandId, name]): [string, SongGroup] => [bandId, { label: name, songs: [] }])]);
  for (const song of matchingSongs(songs, query)) {
    const room = song.ref.slice(0, song.ref.indexOf("/"));
    if (room !== "local" && !bands.has(room)) continue;
    if ((chips.band !== null && room !== chips.band) || (chips.key !== null && keyName(song) !== chips.key) || (chips.timed && !timed(song.ref))) continue;
    const friend = room === "local" ? song.copy?.from?.name : undefined;
    const place = friend === undefined ? room : `from ${friend}`;
    if (!groups.has(place)) groups.set(place, { label: `From ${friend}`, songs: [] });
    groups.get(place)!.songs.push(song);
  }
  return [...groups.values()].filter((group) => group.songs.length > 0);
}

/** The song in `songs` with the same folded title and artist, so adding a copy can offer to open it instead. */
export function songYouHave(songs: Song[], adding: Pick<Song, "title" | "artist">): Song | undefined {
  return songs.find((song) => fold(song.title) === fold(adding.title) && fold(song.artist) === fold(adding.artist));
}

export const youHaveLine = (song: Song) => `You already have ${song.title} · Open it?`;
