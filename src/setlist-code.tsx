import { useState } from "react";
import { type Viewer, fixtureSetlist, canShowBandCode, bandSetlistPayload, fixtureMySetlist, mySetlistPayload } from "./setlist-code-model";
import { qrSvg } from "./qr-svg";

export function SetlistCodeButton({ viewer }: { viewer: Viewer }) {
  if (!canShowBandCode(viewer, fixtureSetlist)) {
    return null;
  }

  const [showCode, setShowCode] = useState(false);

  return (
    <div>
      <button onClick={() => setShowCode(!showCode)}>Show code</button>
      {showCode && (
        <div
          className="setlist-code-qr"
          dangerouslySetInnerHTML={{ __html: qrSvg(bandSetlistPayload(fixtureSetlist)) }}
        />
      )}
    </div>
  );
}

export function MySetlistCode() {
  const [songs, setSongs] = useState(fixtureMySetlist);
  const payload = mySetlistPayload(songs);
  const showCodeDisabled = payload === null;

  const handleToggle = (index: number) => {
    setSongs(
      songs.map((song, i) => (i === index ? { ...song, ticked: !song.ticked } : song))
    );
  };

  return (
    <div className="my-setlist-code">
      <ul>
        {songs.map((song, index) => (
          <li key={song.songId}>
            <input
              type="checkbox"
              checked={song.ticked}
              onChange={() => handleToggle(index)}
            />
            {song.title}
          </li>
        ))}
      </ul>
      <button disabled={showCodeDisabled}>Show code</button>
      {!showCodeDisabled && payload && (
        <div
          className="my-setlist-code-qr"
          dangerouslySetInnerHTML={{ __html: qrSvg(payload) }}
        />
      )}
    </div>
  );
}
