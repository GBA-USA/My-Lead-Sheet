import { useReducer, useState } from "react";
import { bandsReducer, fixtureBands, isAdmin } from "./bands-model";

export function BandsScreen() {
  const [state, dispatch] = useReducer(bandsReducer, fixtureBands);
  const [createInput, setCreateInput] = useState("");
  const [joinInput, setJoinInput] = useState("");
  const [selectedBandId, setSelectedBandId] = useState<string | null>(null);

  const handleCreate = () => {
    dispatch({ type: "create", name: createInput });
    setCreateInput("");
  };

  const handleJoin = () => {
    dispatch({ type: "join", code: joinInput });
    setJoinInput("");
  };

  const handleRemove = (bandId: string, handle: string) => {
    dispatch({ type: "remove", bandId, handle });
  };

  const handlePromote = (bandId: string, handle: string) => {
    dispatch({ type: "promote", bandId, handle });
  };

  const handleLeave = (bandId: string) => {
    dispatch({ type: "leave", bandId });
    setSelectedBandId(null);
  };

  const selectedBand = selectedBandId
    ? state.bands.find((b) => b.id === selectedBandId)
    : null;

  if (selectedBand && isAdmin(selectedBand, state.me)) {
    return (
      <div className="bands-screen-members">
        <button onClick={() => setSelectedBandId(null)}>← Back</button>
        <h2>{selectedBand.name}</h2>
        <div className="bands-screen-members-list">
          {selectedBand.members.map((member) => (
            <div key={member.handle} className="bands-screen-member-row">
              <div>
                <strong>{member.name}</strong> ({member.handle}) — {member.role}
              </div>
              {member.handle !== state.me && (
                <>
                  <button onClick={() => handleRemove(selectedBand.id, member.handle)}>
                    Remove
                  </button>
                  {member.role === "member" && (
                    <button onClick={() => handlePromote(selectedBand.id, member.handle)}>
                      Make admin
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
        <button onClick={() => handleLeave(selectedBand.id)}>Leave band</button>
      </div>
    );
  }

  if (selectedBand) {
    return (
      <div className="bands-screen-members">
        <button onClick={() => setSelectedBandId(null)}>← Back</button>
        <h2>{selectedBand.name}</h2>
        <div className="bands-screen-members-list">
          {selectedBand.members.map((member) => (
            <div key={member.handle} className="bands-screen-member-row">
              <div>
                <strong>{member.name}</strong> ({member.handle}) — {member.role}
              </div>
            </div>
          ))}
        </div>
        <button onClick={() => handleLeave(selectedBand.id)}>Leave band</button>
      </div>
    );
  }

  return (
    <div className="bands-screen">
      <h1>My bands</h1>

      <div className="bands-screen-list">
        {state.bands.map((band) => (
          <button
            key={band.id}
            onClick={() => setSelectedBandId(band.id)}
            className="bands-screen-band-item"
          >
            {band.name}
          </button>
        ))}
      </div>

      <div className="bands-screen-create">
        <input
          type="text"
          value={createInput}
          onChange={(e) => setCreateInput(e.target.value)}
          placeholder="Band name"
        />
        <button onClick={handleCreate}>Create band</button>
      </div>

      <div className="bands-screen-join">
        <input
          type="text"
          value={joinInput}
          onChange={(e) => setJoinInput(e.target.value)}
          placeholder="Code or link"
        />
        <button onClick={handleJoin}>Join by code or link</button>
      </div>

      <p role="status" className="bands-screen-notice">
        {state.notice}
      </p>
    </div>
  );
}
