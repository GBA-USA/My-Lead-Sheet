import { useId, useMemo, useRef, useState } from "react";
import { content } from "./band-library";
import { useEscape } from "./hooks";
import { useMetronome } from "./metronome-view";
import { songHref } from "./route";
import { songYouHave } from "./search";
import { YouHaveIt } from "./search-box";
import { LeadSheet } from "./sheet";
import { BpmField, parseBpm, SongDataEditor } from "./song-data-editor";
import { KEY_ROOTS, ownSong, parseSheet, sectionsToText, sheetProblem, type SongMeta } from "./song-text";
import { addOwnSong, removeOwnSong, replaceOwnSong, saveSongData, songByRef, withSongData } from "./storage";
import type { KeyMode, Song, SongData } from "./types";
import "./song-editor.css";

/** Which song sheet is open over the page: timing, a new song, the open song's chart, or the Delete question. */
export type SongEdit = "timing" | "new" | "chart" | "delete";

const NOT_SAVED = "This phone couldn't save the song. Free some space and try again.";
const SECTION_BUTTONS = ["Verse", "Chorus", "Bridge"] as const;

type Form = { title: string; artist: string; keyRoot: string; keyMode: KeyMode; bpm: string; timeSignature: string; chart: string };

const formOf = (song?: Song): Form => ({
  title: song?.title ?? "",
  artist: song?.artist ?? "",
  keyRoot: song?.keyRoot ?? "C",
  keyMode: song?.keyMode ?? "major",
  bpm: song?.tempo == null ? "" : String(song.tempo),
  timeSignature: song?.timeSignature ?? "4/4",
  chart: song ? sectionsToText(song.body) : "",
});

/** The sheets App opens over a song or My Songs. `song` is the open song, as shown. */
export function SongEditors({
  editing,
  song,
  songs,
  onSongData,
  onTempo,
  onClose,
}: {
  editing: SongEdit | null;
  song: Song | undefined;
  songs: Song[];
  onSongData: (song: Song, data: SongData) => void;
  /** The open song's tempo was saved; `song` is the song as it was. */
  onTempo: (song: Song, tempo: number | null) => void;
  onClose: () => void;
}) {
  if (editing === "new") return <SongEditor songs={songs} onClose={onClose} />;
  if (!song) return null;
  if (editing === "chart") return <SongEditor song={song} songs={songs} onTempo={(tempo) => onTempo(song, tempo)} onClose={onClose} />;
  if (editing === "delete") return <DeleteSong song={song} onClose={onClose} />;
  if (editing === "timing") return <SongDataEditor song={song} original={withSongData(songByRef(songs, song.ref)!, {})} onSave={(data) => onSongData(song, data)} onClose={onClose} />;
  return null;
}

/**
 * One screen to write a song or change one the player made: the details, then the chart as text, typed or pasted,
 * drawn below by the normal chart as it is typed. Nothing here talks to the server.
 */
function SongEditor({ song, songs, onTempo, onClose }: { song?: Song; songs: Song[]; onTempo?: (tempo: number | null) => void; onClose: () => void }) {
  const titleId = useId();
  const ids = { title: useId(), artist: useId(), key: useId(), mode: useId(), time: useId(), chart: useId(), hint: useId() };
  const [form, setForm] = useState(() => formOf(song));
  const [problem, setProblem] = useState("");
  const [pasteNote, setPasteNote] = useState("");
  const [have, setHave] = useState<Song | null>(null);
  const chartRef = useRef<HTMLTextAreaElement>(null);
  const parsed = useMemo(() => parseSheet(form.chart), [form.chart]);
  const tempo = parseBpm(form.bpm);
  const meta: SongMeta = { title: form.title, artist: form.artist, keyRoot: form.keyRoot, keyMode: form.keyMode, tempo, timeSignature: form.timeSignature };
  const preview: Song = { ...ownSong(meta, parsed.sections, song && content(song)), title: form.title.trim() || "Untitled", ref: "draft/song", id: 0 };
  const metronome = useMetronome(null, tempo);

  useEscape(onClose);

  const set = <K extends keyof Form>(field: K) => (next: Form[K]) => {
    setForm((current) => ({ ...current, [field]: next }));
    setProblem("");
    setHave(null);
  };

  const addText = (text: string) => {
    set("chart")(form.chart.trim() ? `${form.chart.trimEnd()}\n\n${text}` : text);
    chartRef.current?.focus();
  };

  const addSection = (name: (typeof SECTION_BUTTONS)[number]) => {
    const count = parsed.sections.filter((section) => section.heading.toLowerCase().startsWith(name.toLowerCase())).length;
    addText(`${name.toUpperCase()}${name === "Verse" ? ` ${count + 1}` : ""}\n`);
  };

  const paste = async () => {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      /* No clipboard, or the player said no: the box takes a paste instead. */
    }
    if (text.trim()) {
      setPasteNote("");
      return addText(text);
    }
    setPasteNote("Paste your sheet into the box.");
    chartRef.current?.focus();
  };

  const save = (anyway = false) => {
    const refusal = sheetProblem(meta, parsed.sections) ?? (form.bpm.trim() && tempo == null ? "BPM must be a whole number the metronome can play" : null);
    if (refusal) return setProblem(refusal);
    const same = song || anyway ? undefined : songYouHave(songs, meta);
    if (same) return setHave(same);
    if (!song) {
      const id = addOwnSong(ownSong(meta, parsed.sections));
      if (id === null) return setProblem(NOT_SAVED);
      window.location.hash = songHref(id, "songs");
      return;
    }
    // What Song timing held is now part of the song itself, so it no longer sits over the edit.
    saveSongData(song.ref, {});
    if (!replaceOwnSong(song.id, ownSong(meta, parsed.sections, content(song)))) return setProblem(NOT_SAVED);
    onTempo?.(tempo);
    onClose();
  };

  return (
    <div className="song-editor-backdrop">
      <form
        className="song-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <h2 id={titleId}>{song ? "Edit song" : "New song"}</h2>
        <div className="song-editor-fields">
          <div className="song-data-field">
            <label htmlFor={ids.title}>Title</label>
            <input id={ids.title} autoComplete="off" value={form.title} onChange={(event) => set("title")(event.target.value)} />
          </div>
          <div className="song-data-field">
            <label htmlFor={ids.artist}>Artist</label>
            <input id={ids.artist} autoComplete="off" value={form.artist} onChange={(event) => set("artist")(event.target.value)} />
          </div>
          <div className="song-data-field">
            <label htmlFor={ids.key}>Key</label>
            <span className="song-editor-key">
              <select id={ids.key} value={form.keyRoot} onChange={(event) => set("keyRoot")(event.target.value)}>
                {[...new Set([...KEY_ROOTS, form.keyRoot])].map((root) => (
                  <option key={root}>{root}</option>
                ))}
              </select>
              <select id={ids.mode} aria-label="Major or minor" value={form.keyMode} onChange={(event) => set("keyMode")(event.target.value === "minor" ? "minor" : "major")}>
                <option value="major">major</option>
                <option value="minor">minor</option>
              </select>
            </span>
          </div>
          <BpmField value={form.bpm} placeholder="bpm" onChange={set("bpm")} />
          <div className="song-data-field">
            <label htmlFor={ids.time}>Time signature</label>
            <input id={ids.time} autoComplete="off" value={form.timeSignature} onChange={(event) => set("timeSignature")(event.target.value)} />
          </div>
        </div>

        <div className="song-editor-chart">
          <label htmlFor={ids.chart}>Chart</label>
          <p className="song-editor-hint" id={ids.hint}>
            A blank line starts a section, and a line like VERSE 1 or Chorus: names it. Put chords on the line above the words, or in brackets: [A]Honey, load [E]up.
          </p>
          <div className="song-editor-tools">
            {SECTION_BUTTONS.map((name) => (
              <button key={name} type="button" onClick={() => addSection(name)}>
                + {name}
              </button>
            ))}
            <button type="button" onClick={paste}>
              Paste a sheet
            </button>
          </div>
          {pasteNote ? <p className="song-editor-hint" role="status">{pasteNote}</p> : null}
          <textarea
            id={ids.chart}
            ref={chartRef}
            className="song-editor-text"
            aria-describedby={ids.hint}
            spellCheck={false}
            autoCapitalize="off"
            wrap="off"
            rows={12}
            placeholder={"VERSE 1\nA               E\nHoney, load up your questions"}
            value={form.chart}
            onChange={(event) => set("chart")(event.target.value)}
          />
          {parsed.warnings.length > 0 ? (
            <ul className="song-editor-warnings">
              {parsed.warnings.map((warning) => (
                <li key={warning.line}>
                  Line {warning.line}: {warning.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <section className="song-editor-preview" aria-label="Preview">
          <h3>Preview</h3>
          {parsed.sections.length > 0 ? (
            <LeadSheet song={preview} scale={1} semitones={0} notation="notes" metronome={metronome} />
          ) : (
            <p className="song-editor-hint">The chart shows here as you type.</p>
          )}
        </section>

        {problem ? <p className="song-editor-problem" role="alert">{problem}</p> : null}
        {have ? <YouHaveIt have={have} onAdd={() => save(true)} /> : null}
        <div className="song-data-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="is-primary">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

/** Delete asks first. The song leaves My Songs and this player's setlists; bands and friends keep the copies they were sent. */
function DeleteSong({ song, onClose }: { song: Song; onClose: () => void }) {
  const titleId = useId();
  const [failed, setFailed] = useState(false);
  useEscape(onClose);
  const remove = () => {
    if (!removeOwnSong(song.id)) return setFailed(true);
    window.location.hash = "#/songs";
  };
  return (
    <div className="song-data-backdrop" onClick={onClose}>
      <div className="song-data" role="alertdialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <h2 id={titleId}>Delete {song.title}?</h2>
        <p className="song-editor-hint">It leaves My Songs and your setlists. Bands and friends you shared it with keep their copies.</p>
        {failed ? <p className="song-editor-problem" role="alert">This phone couldn&apos;t delete the song. Try again.</p> : null}
        <div className="song-data-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="is-danger" onClick={remove}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
