import { useState } from "react";
import { type LibView, type MySong, fixtureBandTabs, visibleSongs, addToMySongs, shareLink } from "./band-library-model";

export function BandLibraryScreen() {
  const [mySongs, setMySongs] = useState<MySong[]>([]);
  const [view, setView] = useState<LibView>({
    tab: fixtureBandTabs[0]?.bandId || "",
    sort: "title",
    filter: "",
    tag: null,
  });
  const [notice, setNotice] = useState("");

  const currentBand = fixtureBandTabs.find((b) => b.bandId === view.tab);
  const visible = visibleSongs(fixtureBandTabs, view);

  const allTags = Array.from(
    new Set(
      fixtureBandTabs
        .flatMap((b) => b.songs)
        .flatMap((s) => s.tags)
    )
  ).sort();

  const handleAddToMySongs = (songId: string) => {
    if (!currentBand) return;
    const { mine, notice: msg } = addToMySongs(mySongs, currentBand, songId);
    setMySongs(mine);
    setNotice(msg);
  };

  return (
    <div className="band-library-screen">
      <div className="band-library-tabs">
        {fixtureBandTabs.map((band) => (
          <button
            key={band.bandId}
            className="band-library-tab-btn"
            aria-pressed={view.tab === band.bandId}
            onClick={() => setView({ ...view, tab: band.bandId })}
          >
            {band.name}
          </button>
        ))}
      </div>

      <input
        className="band-library-search"
        type="text"
        placeholder="Filter songs"
        value={view.filter}
        onChange={(e) => setView({ ...view, filter: e.target.value })}
      />

      <select
        className="band-library-sort"
        value={view.sort}
        onChange={(e) => setView({ ...view, sort: e.target.value as "title" | "artist" | "recent" })}
      >
        <option value="title">Title</option>
        <option value="artist">Artist</option>
        <option value="recent">Recently added</option>
      </select>

      <div className="band-library-tags">
        {allTags.map((tag) => (
          <button
            key={tag}
            className="band-library-tag-chip"
            aria-pressed={view.tag === tag}
            onClick={() => setView({ ...view, tag: view.tag === tag ? null : tag })}
          >
            {tag}
          </button>
        ))}
      </div>

      <ul className="band-library-songs">
        {visible.map((song) => (
          <li key={song.id} className="band-library-song-row">
            <div className="band-library-song-info">
              <span className="band-library-song-title">{song.title}</span>
              <span className="band-library-song-artist">{song.artist}</span>
              <span className="band-library-song-key">{song.key}</span>
            </div>
            <button
              className="band-library-share-btn"
              onClick={() => {
                setNotice(shareLink(view.tab, song.id));
              }}
            >
              Share
            </button>
            <button
              className="band-library-add-btn"
              onClick={() => handleAddToMySongs(song.id)}
            >
              Add to My Songs
            </button>
          </li>
        ))}
      </ul>

      <p role="status" className="band-library-notice">
        {notice}
      </p>
    </div>
  );
}
