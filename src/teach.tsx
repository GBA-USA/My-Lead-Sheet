import { useId, useState, type ReactNode } from "react";
import { finishTake, nextVersionName, takeProgress, toggleHold, type ScrollPlan, type ScrollVersion, type Take } from "./scroll-timing";
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
    add: (plan: Omit<ScrollVersion, "name">, name = nextVersionName(state.versions)) =>
      update({ versions: [...state.versions, { name, ...plan }], selected: state.versions.length }),
    /** Deletes the chosen version and goes back to the even pace. */
    remove: () => update({ versions: state.versions.filter((_, i) => i !== state.selected), selected: null }),
  };
}

/** What a take taught when it ends at `at`: a hold still on ends there, and the rest of the song runs at the take's pace. */
export function taughtPlan(take: Take, at: number): ScrollPlan {
  const moving = take.holding ? toggleHold(take, at) : take;
  return finishTake(moving, at + (1 - takeProgress(moving, at)) / take.slope);
}

export function TeachBar({
  names,
  selected,
  canTeach,
  teaching,
  holding,
  onSelect,
  onRename,
  onDelete,
  onTeach,
  onHold,
  onDone,
  onDiscard,
  children,
}: {
  names: string[];
  selected: number | null;
  canTeach: boolean;
  teaching: boolean;
  holding: boolean;
  onSelect: (index: number | null) => void;
  onRename: (index: number, name: string) => void;
  onDelete: () => void;
  onTeach: () => void;
  onHold: () => void;
  onDone: () => void;
  onDiscard: () => void;
  /** More buttons after Teach. */
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  if (teaching) return <TakeBar holding={holding} onHold={onHold} onDone={onDone} onDiscard={onDiscard} />;

  if (deleting && selected != null) {
    return (
      <div className="teach-bar">
        <Confirm
          question={`Delete ${names[selected]}?`}
          action="Delete"
          onConfirm={() => {
            setDeleting(false);
            onDelete();
          }}
          onCancel={() => setDeleting(false)}
        />
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
          <button type="button" className="teach-btn" onClick={() => setDeleting(true)}>
            Delete
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

function TakeBar({
  holding,
  onHold,
  onDone,
  onDiscard,
}: {
  holding: boolean;
  onHold: () => void;
  onDone: () => void;
  onDiscard: () => void;
}) {
  const [discarding, setDiscarding] = useState(false);

  return (
    <div className="teach-bar">
      {discarding ? (
        <Confirm question="Discard this take?" action="Discard" onConfirm={onDiscard} onCancel={() => setDiscarding(false)} />
      ) : (
        <>
          <span className="teach-status">Teaching</span>
          <button type="button" className="teach-btn" onClick={() => setDiscarding(true)}>
            Discard
          </button>
          <button type="button" className="teach-btn" onClick={onDone}>
            Done
          </button>
          <button type="button" className={holding ? "teach-btn is-on" : "teach-btn"} onClick={onHold}>
            {holding ? "Continue" : "Hold"}
          </button>
        </>
      )}
    </div>
  );
}

/** The second tap before throwing work away. Cancel sits where Hold was, so a quick double tap keeps the work. */
function Confirm({
  question,
  action,
  onConfirm,
  onCancel,
}: {
  question: string;
  action: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <span className="teach-question">{question}</span>
      <button type="button" className="teach-btn is-danger" onClick={onConfirm}>
        {action}
      </button>
      <button type="button" className="teach-btn" onClick={onCancel}>
        Cancel
      </button>
    </>
  );
}

/** Shown when a take ends: nothing is saved until Save. */
export function SaveTake({ name, onSave, onDiscard }: { name: string; onSave: (name: string) => void; onDiscard: () => void }) {
  const [draft, setDraft] = useState(name);
  const titleId = useId();
  const save = () => onSave(draft.trim() || name);

  return (
    <div className="teach-backdrop">
      <div className="teach-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>Save this take</h2>
        <input
          aria-label="Version name"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
        />
        <div className="teach-actions">
          <button type="button" onClick={onDiscard}>
            Discard
          </button>
          <button type="button" className="is-primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
