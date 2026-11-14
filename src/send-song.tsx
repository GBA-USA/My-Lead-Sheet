import { useState } from "react";
import { fixtureSong, canSend, buildMessage, addToMySongs, applyUpdate, type SendPick, type UpdateChoice, type SongPayload } from "./send-song-model";
import type { ShareChoice } from "./share-rule";

export function SendSongSheet() {
  const [pick, setPick] = useState<SendPick>({ chart: false, versionIds: [], data: false, choice: null });
  const [sent, setSent] = useState<{ payload: SongPayload; reshareable: boolean } | null>(null);
  const [showUpdate, setShowUpdate] = useState(false);

  const handleChartToggle = () => {
    setPick({ ...pick, chart: !pick.chart });
  };

  const handleVersionToggle = (versionId: string) => {
    setPick({
      ...pick,
      versionIds: pick.versionIds.includes(versionId)
        ? pick.versionIds.filter((id) => id !== versionId)
        : [...pick.versionIds, versionId],
    });
  };

  const handleDataToggle = () => {
    setPick({ ...pick, data: !pick.data });
  };

  const handleChoiceChange = (choice: ShareChoice) => {
    setPick({ ...pick, choice });
  };

  const handleSend = () => {
    const result = buildMessage(fixtureSong, pick, true);
    if (result.ok) {
      setSent(result);
      setPick({ chart: false, versionIds: [], data: false, choice: null });
    }
  };

  const handleAddToMySongs = () => {
    if (sent) {
      addToMySongs(sent.payload, sent.reshareable, "Mike");
      setSent(null);
    }
  };

  const handleUpdate = (choice: UpdateChoice) => {
    if (sent) {
      applyUpdate(fixtureSong, sent.payload, choice);
      setShowUpdate(false);
      setSent(null);
    }
  };

  return (
    <div className="SendSongSheet">
      {!sent && !showUpdate && (
        <div className="SendSongSheet__form">
          <h2>Send "{fixtureSong.title}" to Mike</h2>

          <div className="SendSongSheet__checkboxes">
            <label>
              <input type="checkbox" checked={pick.chart} onChange={handleChartToggle} />
              Chart
            </label>

            {fixtureSong.versions.map((version) => (
              <label key={version.id}>
                <input
                  type="checkbox"
                  checked={pick.versionIds.includes(version.id)}
                  onChange={() => handleVersionToggle(version.id)}
                />
                {version.label}
              </label>
            ))}

            <label>
              <input type="checkbox" checked={pick.data} onChange={handleDataToggle} />
              Song data
            </label>
          </div>

          <fieldset className="SendSongSheet__sharing">
            <legend>Sharing</legend>
            <label>
              <input type="radio" name="sharing" value="private" onChange={() => handleChoiceChange("private")} checked={pick.choice === "private"} />
              Private (they can't share it on)
            </label>
            <label>
              <input type="radio" name="sharing" value="public" onChange={() => handleChoiceChange("public")} checked={pick.choice === "public"} />
              Public (they can share it on)
            </label>
          </fieldset>

          <button onClick={handleSend} disabled={!canSend(pick)}>
            Send
          </button>
        </div>
      )}

      {sent && !showUpdate && (
        <div className="SendSongSheet__card">
          <h3>{sent.payload.title}</h3>
          <p>From you</p>
          <ul>
            {sent.payload.chart && <li>Chart</li>}
            {sent.payload.versions.map((v) => (
              <li key={v.id}>{v.label}</li>
            ))}
            {sent.payload.data && <li>Song data</li>}
          </ul>
          <button onClick={handleAddToMySongs}>Add to My Songs</button>
        </div>
      )}

      {showUpdate && (
        <div className="SendSongSheet__update">
          <h3>Update received for "{sent?.payload.title}"</h3>
          <button onClick={() => handleUpdate("keep-mine")}>Keep mine</button>
          <button onClick={() => handleUpdate("take-theirs")}>Take theirs</button>
          <button onClick={() => handleUpdate("keep-both")}>Keep both</button>
        </div>
      )}
    </div>
  );
}
