import { useReducer } from "react";
import {
  fixtureMembers,
  fixtureGigPlan,
  gigPlanReducer,
  isPackReady,
} from "./gig-plan-model";

export function GigPlanScreen({ me }: { me: string }) {
  const [state, dispatch] = useReducer(gigPlanReducer, {
    plan: structuredClone(fixtureGigPlan),
    notice: "",
  });

  const { plan, notice } = state;
  const isAdmin = me === plan.admin;
  const lineupMinusLeader = plan.lineup.filter((h) => h !== plan.leader);

  return (
    <div className="gig-plan-screen">
      <section className="gig-plan-lineup">
        <h2>Lineup</h2>
        {fixtureMembers.map((player) => (
          <label key={player.handle}>
            <input
              type="checkbox"
              checked={plan.lineup.includes(player.handle)}
              onChange={() =>
                dispatch({ type: "toggleLineup", handle: player.handle })
              }
            />
            {player.name}
          </label>
        ))}
      </section>

      <section className="gig-plan-leader">
        <h2>Leader</h2>
        <select
          value={plan.leader || ""}
          onChange={(e) => {
            if (e.target.value)
              dispatch({ type: "setLeader", handle: e.target.value });
          }}
        >
          <option value="">—</option>
          {plan.lineup.map((handle) => (
            <option key={handle} value={handle}>
              {fixtureMembers.find((p) => p.handle === handle)?.name || handle}
            </option>
          ))}
        </select>
      </section>

      <section className="gig-plan-backup">
        <h2>Backup leader</h2>
        <select
          value={plan.backupLeader || ""}
          onChange={(e) =>
            dispatch({
              type: "setBackup",
              handle: e.target.value || null,
            })
          }
        >
          <option value="">None</option>
          {lineupMinusLeader.map((handle) => (
            <option key={handle} value={handle}>
              {fixtureMembers.find((p) => p.handle === handle)?.name || handle}
            </option>
          ))}
        </select>
      </section>

      <section className="gig-plan-connection">
        <h2>Connection for tonight</h2>
        <label>
          <input
            type="radio"
            name="connection"
            value="wifi"
            checked={plan.connection === "wifi"}
            disabled={!isAdmin}
            onChange={() =>
              dispatch({
                type: "setConnection",
                by: me,
                connection: "wifi",
              })
            }
          />
          Wi-Fi
        </label>
        <label>
          <input
            type="radio"
            name="connection"
            value="hotspot"
            checked={plan.connection === "hotspot"}
            disabled={!isAdmin}
            onChange={() =>
              dispatch({
                type: "setConnection",
                by: me,
                connection: "hotspot",
              })
            }
          />
          Phone hotspot
        </label>
        <label>
          <input
            type="radio"
            name="connection"
            value="internet"
            checked={plan.connection === "internet"}
            disabled={!isAdmin}
            onChange={() =>
              dispatch({
                type: "setConnection",
                by: me,
                connection: "internet",
              })
            }
          />
          Internet
        </label>
      </section>

      <section className="gig-plan-pack">
        <h2>Pack</h2>
        {plan.packSongIds.map((songId) => (
          <div key={songId} className="gig-plan-pack-item">
            <span>{songId}</span>
            {plan.downloaded.includes(songId) ? (
              <span>Downloaded ✓</span>
            ) : (
              <button
                onClick={() =>
                  dispatch({ type: "markDownloaded", songId })
                }
              >
                Download
              </button>
            )}
          </div>
        ))}
      </section>

      {isPackReady(plan) && (
        <div className="gig-plan-ready">Ready for the gig ✓</div>
      )}

      <p role="status">{notice}</p>
    </div>
  );
}
