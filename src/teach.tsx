import { useEffect, useId, useRef, useState } from "react";
import { Menu } from "./controls";
import {
  clockAt,
  finishTake,
  heardAt,
  nextVersionName,
  takeProgress,
  tempoAt,
  toggleHold,
  withTempo,
  type ScrollPlan,
  type ScrollVersion,
  type Take,
  type Tempo,
} from "./scroll-timing";
import { formatRuntime, parseBpm, parseRuntime } from "./song-data-editor";
import { useStored } from "./hooks";
import { loadScrollVersions, updateScrollVersions, type ScrollVersions } from "./storage";
import type { SongRef } from "./types";
import "./teach.css";

const NONE: ScrollVersions = { versions: [], selected: null };

/** The current song's taught versions. Each change applies to the stored versions and is saved at once. */
export function useScrollVersions(songRef: SongRef | null) {
  const [state, setState] = useStored(() => (songRef == null ? NONE : loadScrollVersions(songRef)), songRef);

  const update = (change: (current: ScrollVersions) => ScrollVersions) => {
    if (songRef != null) setState(updateScrollVersions(songRef, change));
  };
  const edit = (index: number, change: (version: ScrollVersion) => ScrollVersion) =>
    update((current) => ({ ...current, versions: current.versions.map((version, i) => (i === index ? change(version) : version)) }));

  return {
    ...state,
    select: (selected: number | null) => update((current) => ({ ...current, selected })),
    rename: (index: number, name: string) => edit(index, (version) => ({ ...version, name })),
    retime: (index: number, tempo: Tempo[]) => edit(index, (version) => withTempo(version, tempo)),
    add: (plan: Omit<ScrollVersion, "name">, name?: string) =>
      update((current) => ({ versions: [...current.versions, { name: name ?? nextVersionName(current.versions), ...plan }], selected: current.versions.length })),
    /** Deletes the chosen version and goes back to the even pace. */
    remove: () => update((current) => ({ versions: current.versions.filter((_, i) => i !== current.selected), selected: null })),
  };
}

/** What a take taught when it ends at `at`: a hold still on ends there, and the rest of the song runs at the take's pace. */
export function taughtPlan(take: Take, at: number): ScrollPlan {
  const moving = take.holding ? toggleHold(take, at) : take;
  return finishTake(moving, at + (1 - takeProgress(moving, at)) / take.slope);
}

/** While a version with a tempo map plays, the metronome moves to each change as the clock reaches it. */
export function useFollowTempo(tempo: Tempo[] | undefined, clock: { current: number }, setBpm: (bpm: number) => void) {
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
    return () => cancelAnimationFrame(frame);
  }, [tempo, clock]);
}

export type BarMenu = "timing" | "scroll";

const versionLabel = (version: ScrollVersion) => (version.learned ? `${version.name} · learned` : version.name);

export function TeachBar({
  versions,
  selected,
  canTeach,
  teaching,
  holding,
  bpm,
  menu,
  onToggleMenu,
  onCloseMenu,
  onSelect,
  onRename,
  onRetime,
  onDelete,
  onTeach,
  onListen,
  onHold,
  onBpm,
  onDone,
  onDiscard,
}: {
  versions: ScrollVersion[];
  selected: number | null;
  canTeach: boolean;
  teaching: boolean;
  holding: boolean;
  bpm: number | null;
  menu: string | null;
  onToggleMenu: (menu: BarMenu) => void;
  onCloseMenu: () => void;
  onSelect: (index: number | null) => void;
  onRename: (index: number, name: string) => void;
  onRetime: (index: number, tempo: Tempo[]) => void;
  onDelete: () => void;
  onTeach: () => void;
  /** Missing in a live setlist, where Learn by listen is not offered. */
  onListen?: () => void;
  onHold: () => void;
  onBpm: (bpm: number) => void;
  onDone: () => void;
  onDiscard: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [retiming, setRetiming] = useState(false);
  const reasonId = useId();

  if (teaching) return <TakeBar holding={holding} bpm={bpm} onHold={onHold} onBpm={onBpm} onDone={onDone} onDiscard={onDiscard} />;

  const chosen = selected == null ? null : versions[selected];

  if (deleting && chosen) {
    return (
      <div className="teach-bar">
        <Confirm
          question={`Delete ${chosen.name}?`}
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
  const pick = (run: () => void) => () => {
    onCloseMenu();
    run();
  };
  const choice = (label: string, checked: boolean, index: number | null) => (
    <button key={index ?? "default"} type="button" role="menuitemradio" aria-checked={checked} onClick={pick(() => onSelect(index))}>
      {checked ? <span aria-hidden="true">✓ </span> : null}
      {label}
    </button>
  );

  return (
    <div className="teach-bar">
      {retiming && chosen && selected != null ? (
        <TempoSheet
          version={chosen}
          onSave={(tempo) => {
            setRetiming(false);
            onRetime(selected, tempo);
          }}
          onClose={() => setRetiming(false)}
        />
      ) : null}
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
      ) : (
        <Menu
          button={
            <>
              <span className="teach-dim">Timing:</span> {chosen ? versionLabel(chosen) : "Default"}
              <Caret />
            </>
          }
          className="teach-btn"
          open={menu === "timing"}
          onToggle={() => onToggleMenu("timing")}
          onClose={onCloseMenu}
        >
          {versions.map((version, index) => choice(versionLabel(version), index === selected, index))}
          {choice("Default (even pace)", chosen == null, null)}
          {chosen ? (
            <>
              <div className="menu-divider" role="separator" />
              <button type="button" role="menuitem" onClick={pick(() => setDraft(chosen.name))}>
                Rename {chosen.name}…
              </button>
              <button type="button" role="menuitem" onClick={pick(() => setRetiming(true))}>
                Edit tempo…
              </button>
              <button type="button" role="menuitem" onClick={pick(() => setDeleting(true))}>
                Delete {chosen.name}…
              </button>
            </>
          ) : null}
        </Menu>
      )}
      <Menu
        button={
          <>
            Customize scroll
            <Caret />
          </>
        }
        className="teach-btn"
        open={menu === "scroll"}
        onToggle={() => onToggleMenu("scroll")}
        onClose={onCloseMenu}
      >
        <button
          type="button"
          role="menuitem"
          disabled={!canTeach}
          aria-describedby={canTeach ? undefined : reasonId}
          onClick={pick(onTeach)}
        >
          Learn by user (scroll it yourself)
        </button>
        {canTeach ? null : (
          <p className="menu-note" id={reasonId}>
            Needs the song's length and BPM
          </p>
        )}
        {onListen ? (
          <button type="button" role="menuitem" onClick={pick(onListen)}>
            Learn by listen (play the song)
          </button>
        ) : null}
      </Menu>
    </div>
  );
}

function Caret() {
  return <span aria-hidden="true"> ▾</span>;
}

function TakeBar({
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
function TempoSheet({ version, onSave, onClose }: { version: ScrollVersion; onSave: (tempo: Tempo[]) => void; onClose: () => void }) {
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
