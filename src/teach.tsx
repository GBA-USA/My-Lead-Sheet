import { useEffect, useId, useRef, useState } from "react";
import { Menu } from "./controls";
import {
  clockAt,
  finishTake,
  heardAt,
  takeProgress,
  tempoAt,
  toggleHold,
  type ScrollPlan,
  type Take,
  type Tempo,
} from "./scroll-timing";
import { formatRuntime, parseBpm, parseRuntime } from "./song-data-editor";
import { SAVE_REFUSED, type SongVersion, type SongVersionState } from "./song-version";
import "./teach.css";

/** What a take taught when it ends at `at`: a hold still on ends there, and the rest of the song runs at the take's pace. */
export function taughtPlan(take: Take, at: number): ScrollPlan {
  const moving = take.holding ? toggleHold(take, at) : take;
  return finishTake(moving, at + (1 - takeProgress(moving, at)) / take.slope);
}

/** While a version with a tempo map plays, the metronome follows each change as the clock reaches it, and lets go when it stops. */
export function useFollowTempo(tempo: Tempo[] | undefined, clock: { current: number }, setBpm: (bpm: number | null) => void) {
  const set = useRef(setBpm);
  set.current = setBpm;

  useEffect(() => {
    if (!tempo) return;
    let playing: Tempo | null = null;
    let frame = 0;
    const follow = () => {
      const change = tempoAt(tempo, clock.current);
      if (change !== playing) set.current(change.bpm);
      playing = change;
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => {
      cancelAnimationFrame(frame);
      set.current(null);
    };
  }, [tempo, clock]);
}

export type LineMenu = "versions" | "save";

const versionLabel = (version: SongVersion) => (version.learned ? `${version.name} · learned` : version.name);

/**
 * The header's second line: the lock on a locked song, the version chip when the song has versions, and Revert and
 * Save while the draft differs from the version in use. Rename and Delete take the line over until they finish. Save as
 * stands only while that draft does: a Save, Revert, a pick or an owner change closes it.
 */
export function SongLine({
  state,
  menu,
  onToggleMenu,
  onCloseMenu,
}: {
  state: SongVersionState;
  menu: string | null;
  onToggleMenu: (menu: LineMenu) => void;
  onCloseMenu: () => void;
}) {
  const [naming, setNaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [retiming, setRetiming] = useState(false);
  const [savingAs, setSavingAs] = useState(false);
  const { versions, selected, version, refused } = state;
  if (savingAs && !state.changed) setSavingAs(false);

  if (!state.locked && versions.length === 0 && !state.changed && !refused) return null;

  const pick = (run: () => void) => () => {
    onCloseMenu();
    run();
  };
  const commitName = () => {
    const name = naming?.trim();
    if (name && selected != null) state.rename(selected, name);
    setNaming(null);
  };
  const choice = (label: string, checked: boolean, index: number | null) => (
    <button key={index ?? "default"} type="button" role="menuitemradio" aria-checked={checked} onClick={pick(() => state.select(index))}>
      {checked ? <span aria-hidden="true">✓ </span> : null}
      {label}
    </button>
  );
  if (deleting && version && selected != null) {
    return (
      <div className="song-line">
        <Confirm
          question={`Delete ${version.name}?`}
          action="Delete"
          onConfirm={() => {
            setDeleting(false);
            state.remove(selected);
          }}
          onCancel={() => setDeleting(false)}
        />
      </div>
    );
  }

  return (
    <>
      <div className="song-line">
        {state.locked ? (
          <span className="song-lock" role="img" aria-label="Locked">
            🔒
          </span>
        ) : null}
        {retiming && version?.plan && selected != null ? (
          <TempoSheet
            version={{ name: version.name, ...version.plan }}
            onSave={(tempo) => {
              setRetiming(false);
              state.retime(selected, tempo);
            }}
            onClose={() => setRetiming(false)}
          />
        ) : null}
        {naming != null ? (
          <input
            className="teach-name"
            aria-label="Version name"
            autoFocus
            value={naming}
            onChange={(event) => setNaming(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitName();
              if (event.key === "Escape") setNaming(null);
            }}
          />
        ) : versions.length > 0 ? (
          <Menu
            button={
              <>
                <span className="chip-name">{version ? versionLabel(version) : "Default"}</span>
                <Caret />
              </>
            }
            className="version-chip"
            open={menu === "versions"}
            onToggle={() => onToggleMenu("versions")}
            onClose={onCloseMenu}
            align="start"
          >
            {versions.map((each, index) => choice(versionLabel(each), index === selected, index))}
            {choice("Default (even pace)", version == null, null)}
            {version && !state.locked ? (
              <>
                <div className="menu-divider" role="separator" />
                <button type="button" role="menuitem" onClick={pick(() => setNaming(version.name))}>
                  Rename {version.name}…
                </button>
                {version.plan ? (
                  <button type="button" role="menuitem" onClick={pick(() => setRetiming(true))}>
                    Edit tempo…
                  </button>
                ) : null}
                <button type="button" role="menuitem" onClick={pick(() => setDeleting(true))}>
                  Delete {version.name}…
                </button>
              </>
            ) : null}
          </Menu>
        ) : null}
        {state.changed ? (
          <span className="song-save">
            <button type="button" className="revert-btn" onClick={state.revert}>
              Revert
            </button>
            <Menu button="Save" className="save-btn" open={menu === "save"} onToggle={() => onToggleMenu("save")} onClose={onCloseMenu}>
              <button type="button" role="menuitem" disabled={version == null} onClick={pick(state.saveToVersion)}>
                Save to this version
              </button>
              <button type="button" role="menuitem" onClick={pick(() => setSavingAs(true))}>
                Save as…
              </button>
            </Menu>
          </span>
        ) : null}
      </div>
      {refused && !savingAs ? (
        <p className="song-line-error" role="alert">
          {SAVE_REFUSED}
        </p>
      ) : null}
      {savingAs ? (
        <SaveAs name={state.nextName} refused={refused} onSave={state.saveAs} onCancel={() => setSavingAs(false)} />
      ) : null}
    </>
  );
}

function Caret() {
  return <span aria-hidden="true"> ▾</span>;
}

/** The name for a new version. Nothing is saved until Save. */
function SaveAs({ name, refused, onSave, onCancel }: { name: string; refused: boolean; onSave: (name: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(name);
  const titleId = useId();
  const save = () => onSave(draft.trim() || name);

  return (
    <div className="teach-backdrop">
      <div className="teach-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>Save as</h2>
        <input
          aria-label="Version name"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
            if (event.key === "Escape") onCancel();
          }}
        />
        {refused ? (
          <p className="teach-error" role="alert">
            {SAVE_REFUSED}
          </p>
        ) : null}
        <div className="teach-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="is-primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export function TakeBar({
  holding,
  bpm,
  onHold,
  onBpm,
  onDone,
  onDiscard,
}: {
  holding: boolean;
  bpm: number | null;
  onHold: () => void;
  onBpm: (bpm: number) => void;
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
          <label className="teach-tempo">
            <span className="teach-dim">BPM</span>
            <DraftInput
              label="BPM"
              shown={bpm == null ? "" : String(bpm)}
              onDraft={(text) => text.replace(/\D/g, "").slice(0, 3)}
              onCommit={(text) => {
                const next = parseBpm(text);
                if (next != null) onBpm(next);
              }}
            />
          </label>
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

/** A field that shows `shown` until tapped, then edits a draft that commits on Enter or on leaving the field. */
function DraftInput({
  label,
  shown,
  invalid = false,
  onDraft,
  onCommit,
}: {
  label: string;
  shown: string;
  invalid?: boolean;
  onDraft: (text: string) => string;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraftState] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const setDraft = (next: string | null) => {
    pending.current = next;
    setDraftState(next);
  };

  return (
    <input
      aria-label={label}
      aria-invalid={invalid}
      inputMode="numeric"
      enterKeyHint="done"
      autoComplete="off"
      value={draft ?? shown}
      onFocus={(event) => {
        setDraft(shown);
        event.currentTarget.select();
      }}
      onChange={(event) => setDraft(onDraft(event.target.value))}
      onBlur={() => {
        if (pending.current != null) onCommit(pending.current);
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

interface TempoRow {
  at: number;
  bpm: string;
}

/**
 * A version's tempo map: each change's start as heard at 100%, and its BPM. A start is kept as its spot on the
 * version's clock, so a BPM edit leaves the later changes on the same spot in the chart.
 */
function TempoSheet({ version, onSave, onClose }: { version: ScrollPlan & { name: string }; onSave: (tempo: Tempo[]) => void; onClose: () => void }) {
  const titleId = useId();
  const end = version.marks[version.marks.length - 1].at;
  const [rows, setRows] = useState<TempoRow[]>(() =>
    (version.tempo ?? [{ at: 0, bpm: version.bpm }]).map(({ at, bpm }) => ({ at, bpm: String(bpm) })),
  );
  const tempo = rows.map((row) => ({ at: row.at, bpm: parseBpm(row.bpm) ?? version.bpm }));
  const heard = (at: number) => formatRuntime(Math.round(heardAt(tempo, version.bpm, at)));
  const placed = (row: TempoRow, i: number) => i === 0 || (row.at > rows[i - 1].at && row.at < end);
  const valid = rows.every((row, i) => placed(row, i) && parseBpm(row.bpm) != null);
  const set = (index: number, patch: Partial<TempoRow>) => setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const last = rows[rows.length - 1];

  return (
    <div className="teach-backdrop">
      <div className="teach-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>Tempo for {version.name}</h2>
        <div className="teach-tempo-rows">
          <div className="teach-tempo-row teach-dim" aria-hidden="true">
            <span>Starts</span>
            <span>BPM</span>
          </div>
          {rows.map((row, i) => {
            const others = tempo.filter((_, j) => j !== i);
            return (
              <div key={i} className="teach-tempo-row">
                {i === 0 ? (
                  <span className="teach-tempo-start">0:00</span>
                ) : (
                  <DraftInput
                    label={`Start of change ${i}`}
                    shown={heard(row.at)}
                    invalid={!placed(row, i)}
                    onDraft={(text) => text.replace(/[^\d:]/g, "").slice(0, 5)}
                    onCommit={(text) => {
                      const seconds = parseRuntime(text);
                      if (seconds != null) set(i, { at: clockAt(others, version.bpm, seconds) });
                    }}
                  />
                )}
                <input
                  aria-label={i === 0 ? "Opening BPM" : `BPM of change ${i}`}
                  aria-invalid={parseBpm(row.bpm) == null}
                  inputMode="numeric"
                  autoComplete="off"
                  value={row.bpm}
                  onChange={(event) => set(i, { bpm: event.target.value.replace(/\D/g, "").slice(0, 3) })}
                />
                {i === 0 ? (
                  <span />
                ) : (
                  <button type="button" aria-label={`Remove change ${i}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button type="button" onClick={() => setRows([...rows, { at: (last.at + end) / 2, bpm: last.bpm }])}>
          Add change
        </button>
        <div className="teach-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="is-primary"
            disabled={!valid}
            onClick={() => onSave(rows.map((row) => ({ at: row.at, bpm: parseBpm(row.bpm)! })))}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
