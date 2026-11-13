import { useState, type ReactNode } from "react";
import { nextVersionName, type ScrollVersion } from "./scroll-timing";
import { loadScrollVersions, saveScrollVersions, type ScrollVersions } from "./storage";
import "./teach.css";

const NONE: ScrollVersions = { versions: [], selected: null };

/** The current song's taught versions, saved on every change. */
export function useScrollVersions(songId: number | null) {
  const [state, setState] = useState<ScrollVersions>(NONE);
  const [boundId, setBoundId] = useState<number | null>(null);

  if (songId !== boundId) {
    setBoundId(songId);
    setState(songId == null ? NONE : loadScrollVersions(songId));
  }

  const update = (next: ScrollVersions) => {
    setState(next);
    if (songId != null) saveScrollVersions(songId, next);
  };

  return {
    ...state,
    select: (selected: number | null) => update({ ...state, selected }),
    rename: (index: number, name: string) =>
      update({ ...state, versions: state.versions.map((version, i) => (i === index ? { ...version, name } : version)) }),
    add: (plan: Omit<ScrollVersion, "name">) =>
      update({
        versions: [...state.versions, { name: nextVersionName(state.versions), ...plan }],
        selected: state.versions.length,
      }),
  };
}

export function TeachBar({
  names,
  selected,
  canTeach,
  teaching,
  holding,
  onSelect,
  onRename,
  onTeach,
  onHold,
  children,
}: {
  names: string[];
  selected: number | null;
  canTeach: boolean;
  teaching: boolean;
  holding: boolean;
  onSelect: (index: number | null) => void;
  onRename: (index: number, name: string) => void;
  onTeach: () => void;
  onHold: () => void;
  /** More buttons after Teach. */
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  if (teaching) {
    return (
      <div className="teach-bar">
        <span className="teach-status">Teaching</span>
        <button type="button" className={holding ? "teach-btn is-on" : "teach-btn"} onClick={onHold}>
          {holding ? "Continue" : "Hold"}
        </button>
      </div>
    );
  }

  const commit = () => {
    const name = draft?.trim();
    if (name && selected != null) onRename(selected, name);
    setDraft(null);
  };

  return (
    <div className="teach-bar">
      {draft != null ? (
        <input
          className="teach-name"
          aria-label="Version name"
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setDraft(null);
          }}
        />
      ) : names.length > 0 ? (
        <select
          className="teach-select"
          aria-label="Scroll version"
          value={selected ?? ""}
          onChange={(event) => onSelect(event.target.value === "" ? null : Number(event.target.value))}
        >
          <option value="">Default</option>
          {names.map((name, index) => (
            <option key={index} value={index}>
              {name}
            </option>
          ))}
        </select>
      ) : null}
      {selected != null && draft == null ? (
        <>
          <button type="button" className="teach-btn" onClick={() => setDraft(names[selected])}>
            Rename
          </button>
          <button type="button" className="teach-btn" onClick={() => onSelect(null)}>
            Reset
          </button>
        </>
      ) : null}
      <button type="button" className="teach-btn" disabled={!canTeach} onClick={onTeach}>
        Teach
      </button>
      {children}
    </div>
  );
}
