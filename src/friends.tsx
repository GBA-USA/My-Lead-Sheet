import { useReducer, useState } from "react";
import { friendsReducer, fixtureFriends } from "./friends-model";

export function FriendsScreen() {
  const [state, dispatch] = useReducer(friendsReducer, fixtureFriends);
  const [handle, setHandle] = useState("");

  const handleAdd = () => {
    dispatch({ type: "add", handle });
    setHandle("");
  };

  const handleScan = () => {
    dispatch({ type: "scanned", handle: "@lee" });
  };

  return (
    <div className="friends-container">
      <section className="friends-section">
        <h2 className="friends-heading">Friends</h2>
        <ul className="friends-list">
          {state.friends.map((friend) => (
            <li key={friend.handle} className="friends-item">
              <span className="friends-name">{friend.name}</span>
              <span className="friends-handle">{friend.handle}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="friends-section">
        <h2 className="friends-heading">Requests</h2>
        <ul className="friends-requests">
          {state.incoming.map((request) => (
            <li key={request.id} className="friends-request-item">
              <span className="friends-request-name">{request.from.name}</span>
              <span className="friends-request-handle">{request.from.handle}</span>
              <button
                className="friends-button friends-accept-button"
                onClick={() => dispatch({ type: "accept", id: request.id })}
              >
                Accept
              </button>
              <button
                className="friends-button friends-ignore-button"
                onClick={() => dispatch({ type: "ignore", id: request.id })}
              >
                Ignore
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="friends-section">
        <h2 className="friends-heading">Add by Handle</h2>
        <div className="friends-input-group">
          <input
            type="text"
            className="friends-input"
            placeholder="Enter handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
          />
          <button
            className="friends-button friends-send-button"
            onClick={handleAdd}
          >
            Send Request
          </button>
        </div>
      </section>

      <section className="friends-section">
        <button
          className="friends-button friends-scan-button"
          onClick={handleScan}
        >
          Scan Code
        </button>
      </section>

      <p role="status" className="friends-notice">
        {state.notice}
      </p>
    </div>
  );
}
