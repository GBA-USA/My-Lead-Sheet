"use client";

import {
  statusRows,
  fixturePlayers,
  BAND_STATUS_FONT_PX,
} from "./band-status-model";

export function BandStatusPanel() {
  const rows = statusRows(fixturePlayers);

  return (
    <div className="band-status-panel">
      {rows.map((row) => (
        <div
          key={row.id}
          className={row.amber ? "band-status-row band-status-amber" : "band-status-row"}
          style={row.amber ? { color: "amber" } : undefined}
        >
          <div style={{ fontSize: BAND_STATUS_FONT_PX }}>
            <span className="band-status-name">{row.name}</span>
            <span className="band-status-route">{row.routeText}</span>
            <span className="band-status-bars">
              {row.barsText ? (
                row.barsText
              ) : (
                <span className="band-status-bars-boxes">
                  {[...Array(4)].map((_, i) => (
                    <span
                      key={i}
                      className={
                        i < row.bars
                          ? "band-status-bar-filled"
                          : "band-status-bar-empty"
                      }
                    >
                      □
                    </span>
                  ))}
                </span>
              )}
            </span>
            {row.downloaded && (
              <span className="band-status-downloaded">{row.downloaded}</span>
            )}
            {row.inTime && (
              <span className="band-status-in-time">{row.inTime}</span>
            )}
            <span className="band-status-heard">{row.heard}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function BandStatusFaces() {
  return (
    <div className="band-status-faces">
      {fixturePlayers.map((p) => (
        <div
          key={p.id}
          className={
            statusRows([p])[0].amber
              ? "band-status-face band-status-face-amber"
              : "band-status-face"
          }
          style={
            statusRows([p])[0].amber
              ? { borderColor: "amber" }
              : undefined
          }
        >
          {p.name.charAt(0)}
        </div>
      ))}
    </div>
  );
}
