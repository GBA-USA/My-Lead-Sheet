export type Viewer = { handle: string; bandIds: string[]; guestGigIds: string[] };
export type BandSetlist = { id: string; bandId: string; gigId: string; title: string; songIds: string[] };
export type MySetlistSong = { songId: string; title: string; ticked: boolean };

export const fixtureSetlist: BandSetlist = {
  id: "sl1",
  bandId: "b1",
  gigId: "g1",
  title: "Friday set",
  songIds: ["s1", "s2", "s3"],
};

export const fixtureViewers = {
  member: {
    handle: "Alex",
    bandIds: ["b1"],
    guestGigIds: [],
  },
  guest: {
    handle: "Mike",
    bandIds: [],
    guestGigIds: ["g1"],
  },
  stranger: {
    handle: "Dana",
    bandIds: [],
    guestGigIds: [],
  },
};

export const fixtureMySetlist: MySetlistSong[] = [
  { songId: "s1", title: "First Song", ticked: true },
  { songId: "s2", title: "Second Song", ticked: false },
  { songId: "s3", title: "Third Song", ticked: true },
  { songId: "s4", title: "Fourth Song", ticked: false },
];

export function canShowBandCode(v: Viewer, s: BandSetlist): boolean {
  return v.bandIds.includes(s.bandId) || v.guestGigIds.includes(s.gigId);
}

export function bandSetlistPayload(s: BandSetlist): string {
  return JSON.stringify({ kind: "setlist", id: s.id });
}

export function mySetlistPayload(songs: MySetlistSong[]): string | null {
  const tickedIds = songs.filter((song) => song.ticked).map((song) => song.songId);
  if (tickedIds.length === 0) {
    return null;
  }
  return JSON.stringify({ kind: "my-setlist", songs: tickedIds });
}
