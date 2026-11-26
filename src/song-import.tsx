import { useCallback, useEffect, useId, useReducer, useRef, useState, type ReactNode } from "react";
import { useEscape } from "./hooks";
import { pickedFile, readFiles, type ReadEvent } from "./import-read";
import { useMetronome } from "./metronome-view";
import { LeadSheet } from "./sheet";
import {
  EMPTY_PILE,
  leftOver,
  pileReducer,
  saveable,
  songOf,
  unsaved,
  warningCount,
  type CheckReason,
  type Draft,
  type Duplicate,
  type ImportRow,
  type ReadyState,
  type UnreadReason,
} from "./song-import.js";
import { addOwnSongs, loadLibrary, replaceOwnSong } from "./storage";
import type { Song } from "./types";
import "./song-import.css";

/** The words of each reason a file gave no sheet. No reason shows any part of the file. */
export const MESSAGES: Record<UnreadReason, string> = {
  unsupported: "This kind of file can't be read yet.",
  "old-word": "This is an old Word file. Save it as .docx or PDF and try again.",
  empty: "This file is empty.",
  "no-text": "No words or chords were found in this file.",
  damaged: "This file is damaged, or it is not the kind its name says.",
  locked: "This PDF needs a password. Save a copy without one and try again.",
  scan: "This PDF is a scan with no text inside. Scans can't be read yet.",
  "no-reader": "The PDF reader could not be loaded. Check your connection and try again.",
  "too-big": "This file is larger than 20 MB.",
  "too-many": "Only the first 200 files were read. Import the rest in a second pile.",
  slow: "Reading this file took too long.",
};

/** The words of each reason a row wants a look. A duplicate has its own line. */
export const CHECK_MESSAGES: Record<Exclude<CheckReason, "duplicate">, (draft: Draft) => string> = {
  "no-title": () => "Add a title.",
  "no-chords": () => "No chords were found. It will be saved as words.",
  warnings: (draft) => (warningCount(draft) === 1 ? "1 line may have a chord in the wrong place." : `${warningCount(draft)} lines may have a chord in the wrong place.`),
  fonts: () => "Chords may sit over the wrong word. A PDF of this document keeps them in place.",
  "two-readings": () => "This page can be read two ways.",
  "many-pages": () => "This file has many pages. It may hold more than one song.",
  photo: () => "Read from a photo. Compare it with the page.",
};

const SAME: Record<Duplicate["by"], (duplicate: Duplicate) => string> = {
  library: (duplicate) => `You already have ${"title" in duplicate ? duplicate.title : ""}.`,
  pile: (duplicate) => `Same song as ${"name" in duplicate ? duplicate.name : ""} in this pile.`,
  file: (duplicate) => `The same file as ${"name" in duplicate ? duplicate.name : ""}.`,
};

const NOT_SAVED = "This phone couldn't save the song. Free some space and try again.";
const songs = (count: number) => `${count} ${count === 1 ? "song" : "songs"}`;

/** The mark a row shows, in the player's words. */
function markOf(row: ImportRow): string {
  switch (row.state.is) {
    case "waiting":
      return "Waiting";
    case "reading":
      return "Reading…";
    case "unread":
      return "Couldn't read";
    case "saved":
      return "Saved";
    case "ready":
      return row.state.skipped ? "Set aside" : row.state.verdict === "good" ? "Looks good" : "Check this";
  }
}

type RowActions = {
  onOpen: (id: string) => void;
  onTitle: (id: string, title: string) => void;
  onSkip: (id: string, skipped: boolean) => void;
  onKeep: (id: string) => void;
  onReplace: (id: string) => void;
  onOther: (id: string) => void;
};

/** One file's row: its name, its mark, and what the player can do about it. */
export function PileRow({ row, actions }: { row: ImportRow; actions: RowActions }) {
  const titleId = useId();
  const { state } = row;
  const mark = state.is === "ready" && !state.skipped ? state.verdict : state.is;
  return (
    <li className="song-import-row" data-mark={mark}>
      <div className="song-import-head">
        {state.is === "ready" && !state.skipped ? (
          <button type="button" className="song-import-open" aria-label={`See the sheet of ${row.name}`} onClick={() => actions.onOpen(row.id)}>
            {row.name}
          </button>
        ) : (
          <span className="song-import-name">{row.name}</span>
        )}
        <span className="song-import-mark">{markOf(row)}</span>
      </div>
      {state.is === "unread" ? <p className="song-import-why">{MESSAGES[state.why]}</p> : null}
      {state.is === "ready" && state.skipped ? (
        <div className="song-import-actions">
          <button type="button" onClick={() => actions.onSkip(row.id, false)}>
            Undo
          </button>
        </div>
      ) : null}
      {state.is === "ready" && !state.skipped ? <ReadyRow id={row.id} titleId={titleId} state={state} actions={actions} /> : null}
    </li>
  );
}

function ReadyRow({ id, titleId, state, actions }: { id: string; titleId: string; state: ReadyState; actions: RowActions }) {
  const { draft, duplicate } = state;
  const untitled = !draft.title.trim();
  const choosing = duplicate && !duplicate.keep;
  const lines = state.reasons.flatMap((reason) => (reason === "duplicate" || reason === "no-title" ? [] : [CHECK_MESSAGES[reason](draft)]));
  return (
    <>
      <div className="song-import-title">
        <label htmlFor={titleId}>Title</label>
        <input id={titleId} autoComplete="off" aria-invalid={untitled || undefined} placeholder="Needed to save" value={draft.title} onChange={(event) => actions.onTitle(id, event.target.value)} />
      </div>
      {untitled ? <p className="song-import-need">Add a title</p> : null}
      {draft.artist.trim() ? <p className="song-import-artist">{draft.artist}</p> : null}
      {lines.length > 0 ? (
        <ul className="song-import-reasons">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {duplicate ? <p className="song-import-same">{duplicate.keep ? `${SAME[duplicate.by](duplicate)} It will be saved as a second song.` : SAME[duplicate.by](duplicate)}</p> : null}
      <div className="song-import-actions">
        {choosing ? (
          <button type="button" onClick={() => actions.onKeep(id)}>
            Keep both
          </button>
        ) : null}
        {choosing && duplicate.by === "library" && duplicate.canReplace ? (
          <button type="button" onClick={() => actions.onReplace(id)}>
            Replace
          </button>
        ) : null}
        {state.other ? (
          <button type="button" onClick={() => actions.onOther(id)}>
            Try the other reading
          </button>
        ) : null}
        <button type="button" onClick={() => actions.onSkip(id, true)}>
          Skip
        </button>
      </div>
    </>
  );
}

/** A row's sheet as it would be saved, drawn by the one sheet renderer. */
function RowSheet({ draft }: { draft: Draft }) {
  const song = songOf(draft);
  const metronome = useMetronome(null, song.tempo);
  return <LeadSheet song={{ ...song, title: draft.title.trim() || "Untitled", ref: "import/row", id: 0 }} scale={1} semitones={0} notation="notes" metronome={metronome} />;
}

/**
 * Import files: a pile of text files and documents, picked or dropped, read on this phone into a list with one row
 * for each file, and saved to My Songs with one tap. The list lives in this sheet alone, so it goes when the sheet
 * does. `editor` draws the song editor over a row, and says the id it saved, or null when it was closed.
 */
export function SongImport({
  songs: library,
  files,
  editor,
  onClose,
}: {
  songs: Song[];
  files: File[];
  editor: (draft: Draft, done: (songId: number | null) => void) => ReactNode;
  onClose: () => void;
}) {
  const headingId = useId();
  const [pile, dispatch] = useReducer(pileReducer, EMPTY_PILE);
  const [reading, setReading] = useState<{ at: number; of: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const known = useRef(library);
  known.current = library;
  const current = useRef(pile);
  current.current = pile;
  const stop = useRef(false);
  const queue = useRef(Promise.resolve());
  const batches = useRef(0);
  const taken = useRef(new Set<File[]>());
  /** Rows already written, so a second tap before the list redraws writes none of them again. */
  const written = useRef(new Set<string>());

  const act = useCallback((event: ReadEvent) => {
    if (event.do === "reading") setReading((now) => (now ? { ...now, at: now.at + 1 } : now));
    dispatch(event.do === "read" ? { ...event, songs: known.current } : event);
  }, []);

  /** Reads a pick after any pick before it, so two piles never read at once. */
  const read = useCallback(
    (picked: File[]) => {
      if (picked.length === 0) return;
      queue.current = queue.current.then(async () => {
        if (stop.current) return;
        batches.current += 1;
        setSaved(null);
        setReading({ at: 0, of: picked.length });
        await readFiles(picked.map(pickedFile), act, { prefix: `${batches.current}-`, counted: current.current.rows.length, stopped: () => stop.current });
        setReading(null);
      });
    },
    [act],
  );

  useEffect(() => {
    if (taken.current.has(files)) return;
    taken.current.add(files);
    read(files);
  }, [files, read]);
  useEffect(() => dispatch({ do: "songs", songs: library }), [library]);
  useEffect(
    () => () => {
      stop.current = true;
    },
    [],
  );

  const ready = pile.rows.filter(saveable);
  const left = unsaved(pile.rows).length;
  const row = (id: string | null) => pile.rows.find((each) => each.id === id && each.state.is === "ready") as (ImportRow & { state: ReadyState }) | undefined;
  const opened = row(open);
  const fixed = row(fixing);
  const replaced = row(replacing);

  const close = () => {
    if (left > 0 && !asking) return setAsking(true);
    stop.current = true;
    onClose();
  };
  useEscape(() => {
    if (fixing) return;
    if (replacing) return setReplacing(null);
    if (asking) return setAsking(false);
    close();
  });

  const actions: RowActions = {
    onOpen: setOpen,
    onTitle: (id, title) => dispatch({ do: "title", id, title, songs: library }),
    onSkip: (id, skipped) => {
      dispatch({ do: "skip", id, skipped, songs: library });
      if (skipped && open === id) setOpen(null);
    },
    onKeep: (id) => dispatch({ do: "keep", id, songs: library }),
    onReplace: setReplacing,
    onOther: (id) => dispatch({ do: "other", id, songs: library }),
  };

  /**
   * Saves every row that can be saved in one write. A phone that refuses it is asked one song at a time, until it
   * refuses one: the rows before that one are saved, the rest stay as they are, and none is written twice.
   */
  const save = () => {
    const rows = ready.filter((each) => !written.current.has(each.id));
    if (rows.length === 0) return;
    const made = rows.map((each) => songOf(each.state.draft));
    let ids = addOwnSongs(made);
    let refused = false;
    if (ids === null) {
      ids = [];
      for (const song of made) {
        const one = addOwnSongs([song]);
        if (one === null) {
          refused = true;
          break;
        }
        ids.push(one[0]);
      }
    }
    const done = rows.flatMap((each, at) => (ids[at] == null ? [] : [{ id: each.id, songId: ids[at]! }]));
    for (const each of done) written.current.add(each.id);
    dispatch({ do: "saved", saved: done, songs: loadLibrary().songs });
    setNotice(refused ? NOT_SAVED : "");
    setSaved(refused ? null : done.length);
    setOpen(null);
  };

  const replace = (target: ImportRow & { state: ReadyState }) => {
    const { duplicate } = target.state;
    const have = duplicate?.by === "library" ? library.find((song) => song.id === duplicate.songId) : undefined;
    setReplacing(null);
    if (!have || duplicate?.by !== "library" || written.current.has(target.id)) return;
    const song = songOf(target.state.draft);
    if (!replaceOwnSong(have.id, { ...song, title: have.title, artist: have.artist, keyNote: song.keyNote || have.keyNote })) return setNotice(NOT_SAVED);
    written.current.add(target.id);
    setNotice("");
    dispatch({ do: "saved", saved: [{ id: target.id, songId: have.id }], songs: loadLibrary().songs });
  };

  const counts = leftOver(pile.rows);
  const after = [
    ...(counts.untitled ? [`${counts.untitled} ${counts.untitled === 1 ? "needs" : "need"} a title`] : []),
    ...(counts.choosing ? [`${songs(counts.choosing)} you already have ${counts.choosing === 1 ? "waits" : "wait"} for Keep both, Replace or Skip`] : []),
    ...(counts.unread ? [`${counts.unread} couldn't be read`] : []),
    ...(counts.skipped ? [`${counts.skipped} set aside`] : []),
  ];

  return (
    <div className="song-import-backdrop">
      <section className="song-import" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <h2 id={headingId}>Import files</h2>
        {pile.rows.length === 0 && !reading ? (
          <>
            <p className="song-import-hint">Pick text files, ChordPro files, web pages, RTF or Word documents, or a .zip of them. Each one is read on this phone, and you check it before it is saved.</p>
            <button type="button" className="song-import-choose" onClick={() => input.current?.click()}>
              Choose files
            </button>
          </>
        ) : null}
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const picked = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            read(picked);
          }}
        />
        {reading ? (
          <div className="song-import-reading">
            <p role="status">
              Reading {Math.max(1, reading.at)} of {reading.of}
            </p>
            <button
              type="button"
              onClick={() => {
                stop.current = true;
                queue.current = queue.current.then(() => {
                  stop.current = false;
                });
              }}
            >
              Stop
            </button>
          </div>
        ) : null}
        {pile.past > 0 ? <p className="song-import-note">{MESSAGES["too-many"]}</p> : null}
        {notice ? (
          <p className="song-import-problem" role="alert">
            {notice}
          </p>
        ) : null}
        {saved !== null ? (
          <div className="song-import-done" role="status">
            <p>{saved === 1 ? "1 song saved" : `${saved} songs saved`}</p>
            {after.length > 0 ? (
              <ul>
                {after.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {opened ? (
          <div className="song-import-preview">
            <div className="song-import-actions">
              <button type="button" onClick={() => setOpen(null)}>
                Back to the list
              </button>
              <button type="button" onClick={() => setFixing(opened.id)}>
                Edit
              </button>
              <button type="button" onClick={() => actions.onSkip(opened.id, true)}>
                Skip
              </button>
            </div>
            <p className="song-import-name">{opened.name}</p>
            <RowSheet draft={opened.state.draft} />
          </div>
        ) : pile.rows.length > 0 ? (
          <ul className="song-import-rows" aria-label="Files">
            {pile.rows.map((each) => (
              <PileRow key={each.id} row={each} actions={actions} />
            ))}
          </ul>
        ) : null}

        {replaced && replaced.state.duplicate?.by === "library" ? (
          <div className="song-import-ask" role="alertdialog" aria-label="Replace">
            <p>Replace the chart of {replaced.state.duplicate.title}? This can't be undone.</p>
            <div className="song-import-actions">
              <button type="button" onClick={() => setReplacing(null)}>
                Cancel
              </button>
              <button type="button" className="is-danger" onClick={() => replace(replaced)}>
                Replace
              </button>
            </div>
          </div>
        ) : null}
        {asking ? (
          <div className="song-import-ask" role="alertdialog" aria-label="Leave">
            <p>Leave without saving {songs(left)}?</p>
            <div className="song-import-actions">
              <button type="button" onClick={() => setAsking(false)}>
                Stay
              </button>
              <button type="button" className="is-danger" onClick={close}>
                Leave
              </button>
            </div>
          </div>
        ) : null}

        <div className="song-import-bottom">
          <button type="button" onClick={close}>
            Close
          </button>
          {pile.rows.length > 0 ? (
            <button type="button" className="is-primary" disabled={ready.length === 0} onClick={save}>
              {ready.length === 0 ? "Nothing to save" : `Save ${songs(ready.length)}`}
            </button>
          ) : null}
        </div>
      </section>
      {fixed
        ? editor(fixed.state.draft, (songId) => {
            setFixing(null);
            if (songId === null) return;
            written.current.add(fixed.id);
            dispatch({ do: "saved", saved: [{ id: fixed.id, songId }], songs: loadLibrary().songs });
            setOpen(null);
          })
        : null}
    </div>
  );
}
