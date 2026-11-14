export type LibSong = { id: string; title: string; artist: string; key: string; addedBy: string; addedAt: number; tags: string[] };
export type BandTab = { bandId: string; name: string; songs: LibSong[] };

export const fixtureBandTabs: BandTab[] = [
  {
    bandId: "b1",
    name: "Back Porch",
    songs: [
      {
        id: "s1",
        title: "Golden Hour",
        artist: "Alex Chen",
        key: "G",
        addedBy: "@alex",
        addedAt: 1700000000,
        tags: ["ballad"],
      },
      {
        id: "s2",
        title: "Midnight Run",
        artist: "Mike Taylor",
        key: "Em",
        addedBy: "@mike",
        addedAt: 1700100000,
        tags: ["fast", "cover"],
      },
      {
        id: "s3",
        title: "Summer Breeze",
        artist: "Dana Lee",
        key: "D",
        addedBy: "@alex",
        addedAt: 1700200000,
        tags: ["ballad"],
      },
      {
        id: "s4",
        title: "Electric Dreams",
        artist: "Alex Chen",
        key: "Am",
        addedBy: "@mike",
        addedAt: 1700300000,
        tags: ["fast"],
      },
    ],
  },
  {
    bandId: "b2",
    name: "Night Owls",
    songs: [
      {
        id: "s5",
        title: "Neon Lights",
        artist: "Jordan Park",
        key: "F#m",
        addedBy: "@alex",
        addedAt: 1700400000,
        tags: ["cover"],
      },
      {
        id: "s6",
        title: "Starlight Serenade",
        artist: "Casey Morgan",
        key: "Bb",
        addedBy: "@mike",
        addedAt: 1700500000,
        tags: ["ballad", "fast"],
      },
    ],
  },
];

export type SortBy = "title" | "artist" | "recent";
export type LibView = { tab: string; sort: SortBy; filter: string; tag: string | null };

export function visibleSongs(tabs: BandTab[], view: LibView): LibSong[] {
  const tab = tabs.find((t) => t.bandId === view.tab);
  if (!tab) return [];

  let songs = [...tab.songs];

  // Filter by substring (case-insensitive)
  if (view.filter.trim()) {
    const filterLower = view.filter.trim().toLowerCase();
    songs = songs.filter(
      (s) =>
        s.title.toLowerCase().includes(filterLower) ||
        s.artist.toLowerCase().includes(filterLower)
    );
  }

  // Filter by tag
  if (view.tag) {
    songs = songs.filter((s) => s.tags.includes(view.tag!));
  }

  // Sort
  if (view.sort === "title") {
    songs.sort((a, b) => {
      const cmp = a.title.localeCompare(b.title);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });
  } else if (view.sort === "artist") {
    songs.sort((a, b) => {
      const cmp = a.artist.localeCompare(b.artist);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });
  } else if (view.sort === "recent") {
    songs.sort((a, b) => b.addedAt - a.addedAt);
  }

  return songs;
}

export type MySong = { id: string; title: string; artist: string; key: string; fromBand: string };

export function addToMySongs(
  mine: MySong[],
  band: BandTab,
  songId: string
): { mine: MySong[]; notice: string } {
  const song = band.songs.find((s) => s.id === songId);
  if (!song) {
    return { mine, notice: "Song not found" };
  }

  const alreadyThere = mine.some((s) => s.id === "my-" + songId);
  if (alreadyThere) {
    return { mine, notice: "Already in My Songs" };
  }

  const newSong: MySong = {
    id: "my-" + songId,
    title: song.title,
    artist: song.artist,
    key: song.key,
    fromBand: band.bandId,
  };

  return { mine: [...mine, newSong], notice: `Added ${song.title} to My Songs` };
}

export function shareLink(bandId: string, songId: string): string {
  return `/band/${encodeURIComponent(bandId)}/song/${encodeURIComponent(songId)}`;
}
