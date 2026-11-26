import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { content } from "./band-library";
import { useEscape } from "./hooks";
import { useMetronome } from "./metronome-view";
import { songHref } from "./route";
import { songYouHave } from "./search";
import { YouHaveIt } from "./search-box";
import { LeadSheet } from "./sheet";
import { BpmField, parseBpm, SongDataEditor } from "./song-data-editor";
// The half with no screen is "./song-search.js", as it is in song-search.tsx.
import { lengthText, pasteLookup, type CatalogSong, type Lookup } from "./song-search.js";
// @ts-expect-error TS5097: song-search.ts holds the same stem, so only ".tsx" names this file in tsc, Vite and esbuild.
import { browserSearcher, FindChords, SongSearch } from "./song-search.tsx";
import type { Draft } from "./song-import.js";
import { CAPO_VIEW, capoNote, readPaste, type CapoView, type LeftOut, type Pasted } from "./song-paste";
import { KEY_ROOTS, ownSong, parseSheet, sectionsToText, sheetProblem, type SongFacts, type SongMeta } from "./song-text";
import { addOwnSong, removeOwnSong, replaceOwnSong, saveSongData, songByRef, withSongData } from "./storage";
import type { KeyMode, Song, SongData } from "./types";
import "./song-editor.css";

/** Which song sheet is open over the page: timing, a new song, the open song's chart, the Delete question, or Import files. */
export type SongEdit = "timing" | "new" | "chart" | "delete" | "import";

/** Import files and its readers load on the first tap, so the main script keeps its size. The service worker holds every built file, so it opens offline too. */
// @ts-expect-error TS5097: song-import.ts holds the same stem, so only ".tsx" names this file in tsc, Vite and esbuild.
const SongImport = lazy(() => import("./song-import.tsx").then((module) => ({ default: module.SongImport })));

const NOT_SAVED = "This phone couldn't save the song. Free some space and try again.";
const BAD_BPM = "BPM must be a whole number the metronome can play";
const SECTION_BUTTONS = ["Verse", "Chorus", "Bridge"] as const;

type Form = { title: string; artist: string; keyRoot: string; keyMode: KeyMode; bpm: string; timeSignature: string; chart: string; keyNote: string };
/** The fields under Song details, which fold away once the song has a title. */
const DETAILS: readonly (keyof Form)[] = ["title", "artist", "keyRoot", "keyMode", "bpm", "timeSignature"];
/** Why a lookup gave no guess, for the part of the song it was looking for. */
const NO_LOOKUP: Record<"offline" | "failed", (missing: string) => string> = {
  offline: (missing) => `You're offline, so the ${missing} can't be looked up. Try again when you're back online.`,
  failed: (missing) => `The song list didn't answer, so the ${missing} can't be looked up. Try again in a moment.`,
};

const formOf = (song?: Song): Form => ({
  title: song?.title ?? "",
  artist: song?.artist ?? "",
  keyRoot: song?.keyRoot ?? "C",
  keyMode: song?.keyMode ?? "major",
  bpm: song?.tempo == null ? "" : String(song.tempo),
  timeSignature: song?.timeSignature ?? "4/4",
  chart: song ? sectionsToText(song.body) : "",
  keyNote: song?.keyNote ?? "",
});

/** One paste: the raw text, what the box held before it, and which reading of it the box shows. */
type Paste = { raw: string; before: string; view: CapoView | "raw"; pasted: Pasted };

const NOTHING = "Nothing here looks like a chart. It is in the box as pasted.";
/** A key note a capo paste wrote, in either view. */
const CAPO_NOTE = /^Capo \d+/;
const LEFT_OUT: Record<LeftOut["what"], string> = { "tab lines": "tab line", "lines above the first section": "line above the first section", directives: "directive", "site lines": "site line" };

const after = (before: string, text: string) => (before.trim() ? `${before.trimEnd()}\n\n${text}` : text);
const shown = (paste: Paste) => after(paste.before, paste.view === "raw" ? paste.raw : paste.pasted.chart);
const bpmOf = (facts: SongFacts) => (facts.tempo != null && parseBpm(String(facts.tempo)) != null ? String(facts.tempo) : null);
const list = (parts: string[]) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/**
 * The form after a paste. The box takes the chart after what it held, and each fact fills a field `open` allows: a blank
 * field, or one the player has not touched in a new song. Any other difference waits as a chip. A paste that opens
 * the editor (the start panel's) goes through here too, by `takePaste`.
 */
function formWithPaste(form: Form, paste: Paste, open: (field: keyof Form) => boolean): Form {
  const { facts } = paste.pasted;
  const next = { ...form, chart: shown(paste) };
  const bpm = bpmOf(facts);
  if (facts.title && open("title")) next.title = facts.title;
  if (facts.artist && open("artist")) next.artist = facts.artist;
  if (facts.keyRoot && facts.keyMode && open("keyRoot") && open("keyMode")) Object.assign(next, { keyRoot: facts.keyRoot, keyMode: facts.keyMode });
  if (bpm && open("bpm")) next.bpm = bpm;
  if (facts.timeSignature && open("timeSignature")) next.timeSignature = facts.timeSignature;
  const capoNoted = CAPO_NOTE.test(form.keyNote);
  if (facts.capo && (open("keyNote") || capoNoted)) next.keyNote = capoNote(facts.capo, paste.view === "raw" ? "shapes" : paste.view);
  // A paste that fills the whole box takes the place of the chart a capo note was about.
  else if (capoNoted && !paste.before.trim()) next.keyNote = "";
  return next;
}

/** A fact that differs from what the form holds, as one tap that takes it. */
function chipsFor(form: Form, facts: SongFacts): { label: string; take: Partial<Form> }[] {
  const bpm = bpmOf(facts);
  return [
    ...(facts.keyRoot && facts.keyMode && (facts.keyRoot !== form.keyRoot || facts.keyMode !== form.keyMode)
      ? [{ label: `Use ${facts.keyRoot} ${facts.keyMode}`, take: { keyRoot: facts.keyRoot, keyMode: facts.keyMode } }]
      : []),
    ...(bpm && bpm !== form.bpm ? [{ label: `Use ${bpm} bpm`, take: { bpm } }] : []),
    ...(facts.timeSignature && facts.timeSignature !== form.timeSignature ? [{ label: `Use ${facts.timeSignature}`, take: { timeSignature: facts.timeSignature } }] : []),
  ];
}

/** What the paste found and what it left out, in the player's words. */
function pasteStatus({ view, pasted }: Paste): string {
  if (view === "raw") return pasted.chart.trim() ? "It is in the box as pasted." : NOTHING;
  const { facts, leftOut } = pasted;
  const found = [
    ...(facts.keyRoot ? [`key ${facts.keyRoot} ${facts.keyMode}`] : []),
    ...(facts.tempo ? [`${facts.tempo} bpm`] : []),
    ...(facts.timeSignature ? [`${facts.timeSignature} time`] : []),
    ...(facts.capo ? [`capo ${facts.capo}`] : []),
  ];
  const left = leftOut.map(({ count, what }) => `${count} ${count === 1 ? LEFT_OUT[what] : what}`);
  const words = [found.length ? `Found ${found.join(", ")}.` : "Taken as words.", ...(left.length ? [`Left out ${list(left)}.`] : [])];
  return words.join(" ");
}

/** The sheets App opens over a song or My Songs. `song` is the open song, as shown. */
export function SongEditors({
  editing,
  song,
  songs,
  userId,
  files = [],
  onSongData,
  onTempo,
  onClose,
}: {
  editing: SongEdit | null;
  song: Song | undefined;
  songs: Song[];
  /** The signed-in account. Import files belongs to it, and closes when it changes. */
  userId: string | null;
  /** Files dropped on the page, for Import files to read first. */
  files?: File[];
  onSongData: (song: Song, data: SongData) => void;
  /** The open song's tempo was saved; `song` is the song as it was. */
  onTempo: (song: Song, tempo: number | null) => void;
  onClose: () => void;
}) {
  // The pile belongs to the account that picked it. Another account, or none, closes the sheet with no question.
  const owner = useRef(userId);
  useEffect(() => {
    if (owner.current === userId) return;
    owner.current = userId;
    if (editing === "import") onClose();
  }, [userId]);
  if (editing === "import") {
    if (!userId || owner.current !== userId) return null;
    const editor = (start: Draft, done: (songId: number | null) => void): ReactNode => <SongEditor songs={songs} start={start} onSaved={done} onClose={() => done(null)} />;
    return (
      <Suspense fallback={null}>
        <SongImport key={userId} songs={songs} files={files} editor={editor} onClose={onClose} />
      </Suspense>
    );
  }
  if (editing === "new") return <SongEditor songs={songs} onClose={onClose} />;
  if (!song) return null;
  if (editing === "chart") return <SongEditor song={song} songs={songs} onTempo={(tempo) => onTempo(song, tempo)} onClose={onClose} />;
  if (editing === "delete") return <DeleteSong song={song} onClose={onClose} />;
  if (editing === "timing") return <SongDataEditor song={song} original={withSongData(songByRef(songs, song.ref)!, {})} onSave={(data) => onSongData(song, data)} onClose={onClose} />;
  return null;
}

/**
 * One screen to write a song or change one the player made: the details, then the chart as text, typed or pasted,
 * drawn below by the normal chart as it is typed. Nothing here talks to the server. A paste that leaves the title or
 * artist blank asks the public song catalog for them, and what it finds waits as guesses the player taps.
 */
function SongEditor({
  song,
  songs,
  start,
  onSaved,
  onTempo,
  onClose,
}: {
  song?: Song;
  songs: Song[];
  /** A new song's fields to start from, such as a row of Import files. */
  start?: Draft;
  /** Takes a new song's id in place of opening it. */
  onSaved?: (id: number) => void;
  onTempo?: (tempo: number | null) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const ids = { title: useId(), artist: useId(), key: useId(), mode: useId(), time: useId(), chart: useId(), hint: useId(), details: useId() };
  const [form, setForm] = useState(() => (start ? { ...start } : formOf(song)));
  /** Whether the player wants the details open. With no title they are open either way. */
  const [detailsWanted, setDetailsWanted] = useState(() => !form.title.trim());
  const [lookup, setLookup] = useState<Lookup>({ kind: "idle" });
  /** The guess the player tapped, as the fields held it then. Its length is stored while they still do. */
  const [took, setTook] = useState<{ title: string; artist: string; lengthSec: number | null } | null>(null);
  const searcher = useMemo(browserSearcher, []);
  const titleRef = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState("");
  const [pasteNote, setPasteNote] = useState("");
  const [have, setHave] = useState<Song | null>(null);
  const [pasting, setPasting] = useState<Paste | null>(null);
  /** How many pastes the editor has taken. Each one brings the preview into view; a switch of the same paste does not. */
  const [taken, setTaken] = useState(0);
  const touched = useRef(new Set<keyof Form>());
  const chartRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const parsed = useMemo(() => parseSheet(form.chart), [form.chart]);
  const tempo = parseBpm(form.bpm);
  const meta: SongMeta = { title: form.title, artist: form.artist, keyRoot: form.keyRoot, keyMode: form.keyMode, tempo, timeSignature: form.timeSignature };
  const guessLength = took && took.title === form.title && took.artist === form.artist ? took.lengthSec : null;
  const stored = (before?: Omit<Song, "ref" | "id">) => ({ ...ownSong(meta, parsed.sections, before), keyNote: form.keyNote, officialRuntimeSec: before?.officialRuntimeSec ?? guessLength });
  const preview: Song = { ...stored(song && content(song)), title: form.title.trim() || "Untitled", ref: "draft/song", id: 0 };
  const metronome = useMetronome(null, tempo);
  /** The paste's switches, while the box still holds what the paste put there. */
  const fresh = pasting && form.chart === shown(pasting) ? pasting : null;
  const untitled = !form.title.trim();
  const detailsOpen = detailsWanted || untitled;
  /** The folded details in one line. */
  const summary = [form.title, form.artist].map((part) => part.trim()).filter(Boolean).join(" · ");
  /** What a lookup is for, in the player's words, or "" when the song has both. */
  const missing = [...(untitled ? ["title"] : []), ...(form.artist.trim() ? [] : ["artist"])].join(" and ");
  /** The lookup, while it has something to say about a part the song still lacks. */
  const looking = missing && lookup.kind !== "idle" && lookup.kind !== "none" ? lookup : null;

  /** Asks the catalog for the title or artist the song still lacks. What comes back is shown, never written. */
  const look = () => {
    if (missing) return pasteLookup(searcher, form, parsed.sections, setLookup);
    searcher.stop();
    setLookup({ kind: "idle" });
  };

  useEscape(onClose);
  useEffect(() => searcher.stop, [searcher]);
  useEffect(() => {
    if (!taken) return;
    previewRef.current?.scrollIntoView({ block: "start" });
    look();
  }, [taken]);

  const set = <K extends keyof Form>(field: K) => (next: Form[K]) => {
    touched.current.add(field);
    setForm((current) => ({ ...current, [field]: next }));
    setProblem("");
    setHave(null);
    // A detail the player is typing stays on the page.
    if (DETAILS.includes(field)) setDetailsWanted(true);
    // Guesses were for the title and artist as they stood. A lookup that never ran keeps its Try again.
    if (field === "title" || field === "artist") {
      searcher.stop();
      setLookup((current) => (current.kind === "offline" || current.kind === "failed" ? current : { kind: "idle" }));
    }
  };

  const pointAtTitle = () => {
    setDetailsWanted(true);
    titleRef.current?.focus();
  };

  /** A field a paste may fill: blank, or not yet touched in a new song. */
  const open = (field: keyof Form) => form[field].trim() === "" || (!song && !touched.current.has(field));

  const show = (next: Paste) => {
    setPasting(next);
    setPasteNote("");
    setProblem("");
    setHave(null);
    setForm((current) => formWithPaste(current, next, open));
  };

  /**
   * Cleans a pasted text into the box after `before`, and gives back what the box now shows. A paste that leaves nothing
   * goes in as pasted and fills no field.
   */
  const takePaste = (raw: string, before: string) => {
    const pasted = readPaste(raw);
    const next: Paste = pasted.chart.trim() ? { raw, before, view: CAPO_VIEW, pasted } : { raw, before, view: "raw", pasted: { facts: {}, chart: "", leftOut: [] } };
    show(next);
    setTaken((count) => count + 1);
    // A paste folds the details away, so the chart it brought has the screen. With no title they stay open.
    setDetailsWanted(false);
    return shown(next);
  };

  const takeChip = (take: Partial<Form>) => {
    for (const field of Object.keys(take) as (keyof Form)[]) touched.current.add(field);
    setForm((current) => ({ ...current, ...take }));
  };

  /** A tapped guess fills the title and artist the song lacks, and nothing the player already wrote. */
  const takeGuess = (guess: CatalogSong) => {
    const filled = { title: untitled ? guess.title : form.title, artist: form.artist.trim() ? form.artist : guess.artist };
    takeChip(filled);
    setTook({ ...filled, lengthSec: guess.lengthSec });
    setLookup({ kind: "idle" });
    setProblem("");
  };

  const switchTo = (paste: Paste, view: Paste["view"]) => show({ ...paste, view, pasted: readPaste(paste.raw, view === "raw" ? "shapes" : view) });

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
    if (text.trim()) return takePaste(text, form.chart);
    setPasting(null);
    setPasteNote("Paste your sheet into the box.");
    chartRef.current?.focus();
  };

  const save = (anyway = false) => {
    const refusal = sheetProblem(meta, parsed.sections) ?? (form.bpm.trim() && tempo == null ? BAD_BPM : null);
    if (refusal) {
      setProblem(refusal);
      // The field the message is about comes into view: the title with the caret in it, or the folded BPM.
      if (untitled) pointAtTitle();
      else if (refusal === BAD_BPM) setDetailsWanted(true);
      return;
    }
    const same = song || anyway ? undefined : songYouHave(songs, meta);
    if (same) return setHave(same);
    if (!song) {
      const id = addOwnSong(stored());
      if (id === null) return setProblem(NOT_SAVED);
      if (onSaved) return onSaved(id);
      window.location.hash = songHref(id, "songs");
      return;
    }
    if (!replaceOwnSong(song.id, stored(content(song)))) return setProblem(NOT_SAVED);
    // What Song timing held is now part of the song itself, so it no longer sits over the edit.
    saveSongData(song.ref, {});
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
        {!song && !form.title && !form.artist && !form.chart ? <SongSearch songs={songs} /> : null}
        <button
          type="button"
          className="song-editor-fold"
          aria-expanded={detailsOpen}
          aria-controls={ids.details}
          aria-label={detailsOpen ? undefined : `Song details: ${summary}`}
          onClick={() => setDetailsWanted(!detailsOpen)}
        >
          <span>{detailsOpen ? "Song details" : summary}</span>
        </button>
        <div className="song-editor-fields" id={ids.details} hidden={!detailsOpen}>
          <div className="song-data-field">
            <label htmlFor={ids.title}>Title</label>
            <input
              id={ids.title}
              ref={titleRef}
              autoComplete="off"
              placeholder="Needed to save"
              aria-required="true"
              aria-invalid={untitled || undefined}
              value={form.title}
              onChange={(event) => set("title")(event.target.value)}
            />
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
          {form.title.trim() || form.artist.trim() ? <FindChords title={form.title} artist={form.artist} /> : null}
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
          {fresh ? (
            <div className="song-editor-paste">
              <p className="song-editor-hint" role="status">
                {pasteStatus(fresh)}
              </p>
              <div className="song-editor-paste-actions">
                {chipsFor(form, fresh.pasted.facts).map(({ label, take }) => (
                  <button key={label} type="button" onClick={() => takeChip(take)}>
                    {label}
                  </button>
                ))}
                {fresh.view !== "raw" && fresh.pasted.facts.capo ? (
                  <button type="button" aria-pressed={fresh.view === "shapes"} onClick={() => switchTo(fresh, fresh.view === "shapes" ? "sounding" : "shapes")}>
                    {fresh.view === "shapes" ? "Show chords as they sound" : "Show guitar shapes"}
                  </button>
                ) : null}
                {fresh.view !== "raw" && fresh.pasted.chart !== fresh.raw ? (
                  <button type="button" onClick={() => switchTo(fresh, "raw")}>
                    Use it as pasted
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {CAPO_NOTE.test(form.keyNote) ? (
            <div className="song-editor-paste-actions song-editor-capo">
              <span className="song-editor-hint">{form.keyNote}</span>
              <button type="button" onClick={() => set("keyNote")("")}>
                Remove capo note
              </button>
            </div>
          ) : null}
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
            onPaste={(event) => {
              const text = event.clipboardData.getData("text/plain");
              const box = event.currentTarget;
              // A paste over the whole box takes its place, as a paste into an empty box does.
              const whole = box.selectionStart === 0 && box.selectionEnd === box.value.length;
              if (!text.trim() || (form.chart.trim() && !whole)) return;
              event.preventDefault();
              const chart = takePaste(text, "");
              // The browser's own edit, so Ctrl+Z brings back what the box held. Where insertText is gone, the state above still shows the chart.
              box.setSelectionRange(0, box.value.length);
              document.execCommand("insertText", false, chart);
            }}
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

        <section className="song-editor-preview" aria-label="Preview" ref={previewRef}>
          <h3>Preview</h3>
          {parsed.sections.length > 0 && (untitled || looking) ? (
            <div className="song-editor-missing">
              {untitled ? (
                <div className="song-editor-paste-actions song-editor-capo">
                  <span className="song-editor-hint">This song needs a title before it can be saved.</span>
                  <button type="button" onClick={pointAtTitle}>
                    Add a title
                  </button>
                </div>
              ) : null}
              {looking?.kind === "searching" ? <p className="song-editor-hint" role="status">Looking up the {missing}…</p> : null}
              {looking?.kind === "offline" || looking?.kind === "failed" ? (
                <div className="song-editor-paste-actions song-editor-capo">
                  <span className="song-editor-hint" role="status">
                    {NO_LOOKUP[looking.kind](missing)}
                  </span>
                  <button type="button" onClick={look}>
                    Try again
                  </button>
                </div>
              ) : null}
              {looking?.kind === "found" ? (
                <>
                  <p className="song-editor-hint">Is it one of these? Tap one to fill in the {missing}.</p>
                  <ul className="song-editor-paste-actions song-editor-guesses" aria-label="Songs this could be">
                    {looking.songs.map((guess) => (
                      <li key={guess.id}>
                        <button type="button" onClick={() => takeGuess(guess)}>
                          {[guess.title, guess.artist, guess.lengthSec === null ? "" : lengthText(guess.lengthSec)].filter(Boolean).join(" · ")}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
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
