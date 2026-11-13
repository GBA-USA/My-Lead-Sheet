import type { Setlist, Song } from "./types";

/** Spaces go too, so "aint", "ain t" and "Ain't" all fold to the same key. */
function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[^\p{L}\p{N}]/gu, "");
}

export function matchingSongs(songs: Song[], query: string): Song[] {
  const key = fold(query);
  return songs.filter((song) => fold(song.title).includes(key) || fold(song.artist).includes(key));
}

export function matchingSetlists(setlists: Setlist[], songs: Song[], query: string): Setlist[] {
  const key = fold(query);
  const hits = new Set(matchingSongs(songs, query).map((song) => song.id));
  return setlists.filter((setlist) => fold(setlist.name).includes(key) || setlist.songIds.some((id) => hits.has(id)));
}
