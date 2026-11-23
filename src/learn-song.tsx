import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type FieldBpm, addTap, fieldBpm, tapBpm } from "./bpm-detect";
import { beatsPerBar, learnedVersion, placeHeadings, shortHeading } from "./learn-analyze";
import { chartChords, chartForm, heardBars, type HeardBar } from "./learn-chords";
import { FileRefused, type Mic, type MicStop, type WorkerListen, fromFile, fromMic, holdScreen, listenInWorker } from "./learn-input";
import type { Analysis, Band, Coverage, Listen, Source } from "./learn-result";
import type { ScrollVersion, Span } from "./scroll-timing";
import { formatRuntime, songDataFromForm } from "./song-data-editor";
import type { Song, SongData } from "./types";
import "./learn.css";

/** Why the sheet is back at its two ways in, in the words the player sees. */
const NOTES = {
  "no-mic": "The mic isn't available.",
  "not-heard": "No song with a steady beat heard. Try again closer to the phone.",
  "file-not-heard": "No song with a steady beat heard. Try another file.",
  unreadable: "Can't read this file. Try an MP3, M4A or WAV. Protected music can't be read.",
  "too-long": "That's longer than a song. Pick a file under twenty minutes.",
  failed: "Listening failed. Try again.",
};
type Note = keyof typeof NOTES;

const SPEAKER = "Play the song from a speaker or another device and stay on this screen.";

/** Why the mic stopped: in the stopped message, and in the Review's coverage line. */
const STOPPED: Record<MicStop, { said: string; line: string }> = {
  "page-hidden": { said: "This app was left while listening.", line: "the app was left" },
  "mic-ended": { said: "The mic was turned off.", line: "the mic was turned off" },
  "mic-muted": { said: "The mic went quiet, maybe for a call or another app.", line: "the mic went quiet" },
  "audio-suspended": { said: "The phone paused the sound.", line: "the sound was paused" },
};

const FROM: Record<Source["kind"], string> = { file: "From a file", mic: "From the mic", tab: "From a tab" };

/** The opening tempo the Review would save: as the listen heard it, in its band, or as the player set it, drawn black. */
type TempoPick = { bpm: number; band: Band } | { bpm: FieldBpm; band: "set" };

type Step =
  | { kind: "choose"; note: Note | null }
  | { kind: "listening"; from: Source["kind"]; name: string | null; heard: number; expected: number | null }
  | { kind: "stopped"; heard: number; why: MicStop }
  | { kind: "working"; from: Source["kind"] }
  | {
      kind: "review";
      heard: Listen;
      boundaries: number[];
      vocals: boolean[];
      keepHeard: boolean[];
      useForSong: boolean;
      tempo: TempoPick;
      taps: number[];
    };

/** The listen under way: its worker, where its sound comes from, and the mic while one is open. */
interface Session {
  worker: WorkerListen;
  source: Source;
  expectedSeconds: number | null;
  mic: Mic | null;
}

const clockText = (seconds: number) => formatRuntime(Math.max(0, Math.floor(seconds)));

/** The Review's first line: where the sound came from, how much of it was heard and why it ended, and how clean it was. */
function coverageLine({ source, coverage }: Listen): string {
  const { heardSeconds, expectedSeconds, stopped, quality } = coverage;
  const whole = expectedSeconds === null ? source.kind === "file" : heardSeconds >= expectedSeconds - 0.5;
  const heard = whole ? clockText(heardSeconds) : `heard ${clockText(heardSeconds)}${expectedSeconds ? ` of ${clockText(expectedSeconds)}` : ""}`;
  const why = stopped === "finished" || stopped === "player" ? [] : [STOPPED[stopped].line];
  return [FROM[source.kind], heard, ...why, quality].join(" · ");
}

function barText(beat: number, bar: number): string {
  const inBar = beat % bar;
  return inBar === 0 ? `bar ${beat / bar + 1}` : `bar ${Math.floor(beat / bar) + 1}, beat ${inBar + 1}`;
}

/** Each section's bars as heard, from its first beat to the next section's. None when the chart names no chords. */
function heardSections(song: Song, analysis: Analysis, boundaries: number[], bar: number): HeardBar[][] {
  const chords = chartChords(song.body);
  if (chords.length === 0) return [];
  return song.body.map((_, i) => heardBars(analysis.chroma, i === 0 ? 0 : boundaries[i - 1], boundaries[i] ?? analysis.beats.length, bar, chords));
}

const anySure = (bars: HeardBar[]) => bars.some((bar) => bar.chord !== null);

/** Four bars to a group, each cell padded to `width` so a chart row and a heard row line up. */
function barGroups(cells: string[], width: number): string[] {
  const groups: string[] = [];
  for (let i = 0; i < cells.length; i += 4) groups.push(cells.slice(i, i + 4).map((cell) => cell.padEnd(width)).join(" ").trimEnd());
  return groups;
}

/**
 * The Learn this song sheet: hear the whole song from a picked file or the mic, then review the length, tempo,
 * sections, heard chords and suggested vocals, and save them as a new timing version. The analysis runs in its own
 * worker; this sheet only decodes, taps the mic and shows how much was heard.
 */
export function LearnSong({
  song,
  original,
  metronomeBpm,
  onSave,
  onClose,
}: {
  song: Song;
  original: Song;
  metronomeBpm: number | null;
  onSave: (version: Omit<ScrollVersion, "name">, data: SongData | null) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "choose", note: null });
  const session = useRef<Session | null>(null);
  const screen = useRef<(() => void) | null>(null);
  const titleId = useId();
  const headings = song.body.map((section) => section.heading);
  const bar = beatsPerBar(song.timeSignature);
  const runtime = song.officialRuntimeSec ?? null;

  /** Asked for inside the tap that starts listening, let go when the listen ends or the sheet closes. */
  const keepScreenOn = () => void (screen.current ??= holdScreen());
  const letScreenOff = () => {
    screen.current?.();
    screen.current = null;
  };
  const end = () => {
    session.current?.mic?.stop();
    session.current?.worker.close();
    session.current = null;
    letScreenOff();
  };
  useEffect(() => end, []);
  const cancel = () => {
    end();
    onClose();
  };
  const choose = (note: Note) => {
    end();
    setStep({ kind: "choose", note });
  };

  const finish = async (stopped: Coverage["stopped"]) => {
    const mine = session.current;
    if (!mine) return;
    mine.mic?.stop();
    setStep({ kind: "working", from: mine.source.kind });
    const heard = await mine.worker.finish({ beatsPerBar: bar, lyrics: null, source: mine.source, expectedSeconds: mine.expectedSeconds, stopped }).catch(() => undefined);
    if (session.current !== mine) return;
    if (heard === undefined) return choose("failed");
    const boundaries = heard && placeHeadings(heard.analysis, headings.length, bar);
    if (!heard || !boundaries) return choose(mine.source.kind === "file" ? "file-not-heard" : "not-heard");
    session.current = null;
    letScreenOff();
    setStep({
      kind: "review",
      heard,
      boundaries,
      vocals: heard.analysis.vocals.map(() => true),
      keepHeard: headings.map(() => false),
      useForSong: false,
      tempo: { bpm: heard.tempo.bpm, band: heard.tempo.band },
      taps: [],
    });
  };

  /** Opens the mic inside this tap. Keep listening opens it again into the same listen. */
  const listenWithMic = () => {
    keepScreenOn();
    const worker = session.current?.worker ?? listenInWorker();
    const mic = fromMic({
      chunk: (samples) => {
        void worker.send(samples, mic.source.sampleRate);
        setStep((now) => (now.kind === "listening" ? { ...now, heard: worker.seconds } : now));
      },
      stopped: (why) => {
        letScreenOff();
        setStep({ kind: "stopped", heard: worker.seconds, why });
      },
      failed: () => choose("no-mic"),
    });
    session.current = { worker, source: mic.source, expectedSeconds: runtime, mic };
    setStep({ kind: "listening", from: "mic", name: null, heard: worker.seconds, expected: runtime });
  };

  /** Picked from the sheet's two ways in, where no listen is under way; the screen is held from the tap on the picker. */
  const listenToFile = async (file: File) => {
    keepScreenOn();
    const mine: Session = { worker: listenInWorker(), source: { kind: "file", name: file.name, stereo: false, sampleRate: 0 }, expectedSeconds: null, mic: null };
    session.current = mine;
    setStep({ kind: "listening", from: "file", name: file.name, heard: 0, expected: null });
    const sound = await fromFile(file).catch((error: unknown) => (error instanceof FileRefused ? error.reason : "unreadable"));
    if (session.current !== mine) return;
    if (typeof sound === "string") return choose(sound);
    Object.assign(mine, { source: sound.source, expectedSeconds: sound.expectedSeconds });
    for (const chunk of sound.chunks) {
      await mine.worker.send(chunk, sound.source.sampleRate);
      if (session.current !== mine) return;
      setStep({ kind: "listening", from: "file", name: file.name, heard: mine.worker.seconds, expected: sound.expectedSeconds });
    }
    await finish("finished");
  };

  return createPortal(
    <div className="learn-backdrop">
      <div className="learn" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>Learn this song</h2>
        {step.kind === "choose" ? (
          <WaysIn note={step.note} onFile={listenToFile} onFileTap={keepScreenOn} onFileCancel={letScreenOff} onMic={listenWithMic} onCancel={cancel} />
        ) : null}
        {step.kind === "listening" ? <Listening step={step} onStop={() => void finish("player")} onCancel={cancel} /> : null}
        {step.kind === "stopped" ? (
          <>
            <p role="status">
              Listening stopped at {clockText(step.heard)}. {STOPPED[step.why].said} {SPEAKER}
            </p>
            <div className="learn-actions">
              <button type="button" onClick={cancel}>
                Cancel
              </button>
              <button type="button" onClick={() => void finish(step.why)}>
                Use what was heard
              </button>
              <button type="button" className="is-primary" onClick={listenWithMic}>
                Keep listening
              </button>
            </div>
          </>
        ) : null}
        {step.kind === "working" ? (
          <>
            <p role="status">Working out the beat and the chords…</p>
            {step.from === "file" ? (
              <div className="learn-progress">
                <progress aria-label="Song heard" max={1} value={1} />
              </div>
            ) : null}
            <div className="learn-actions">
              <button type="button" onClick={cancel}>
                Cancel
              </button>
            </div>
          </>
        ) : null}
        {step.kind === "review" ? (
          <Review
            step={step}
            headings={headings}
            bar={bar}
            song={song}
            onChange={setStep}
            onCancel={cancel}
            onSave={() => {
              const { heard: { analysis }, boundaries, useForSong } = step;
              const tempo = Math.round(step.tempo.bpm);
              const vocals = analysis.vocals.filter((_, i) => step.vocals[i]);
              const heard = heardSections(song, analysis, boundaries, bar).map((bars, i) =>
                step.keepHeard[i] && anySure(bars) ? bars.map((each) => each.chord) : undefined,
              );
              const runtime = formatRuntime(Math.round(analysis.sound.end - analysis.sound.start));
              const data = useForSong
                ? songDataFromForm(original, { runtime, bpm: String(tempo), timeSignature: song.timeSignature })
                : null;
              const bpm = useForSong ? tempo : (metronomeBpm ?? tempo);
              onSave(learnedVersion(analysis, { boundaries, vocals, heard }, headings, bar, bpm), data);
            }}
          />
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/** The two ways in, the file first because it hears the song best, and why the last try ended, if it did. */
function WaysIn({
  note,
  onFile,
  onFileTap,
  onFileCancel,
  onMic,
  onCancel,
}: {
  note: Note | null;
  onFile: (file: File) => void;
  onFileTap: () => void;
  onFileCancel: () => void;
  onMic: () => void;
  onCancel: () => void;
}) {
  const fileLine = useId();
  const micLine = useId();
  /** React binds `cancel` only on a dialog, so the picker closed with no file is heard here. */
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = picker.current;
    input?.addEventListener("cancel", onFileCancel);
    return () => input?.removeEventListener("cancel", onFileCancel);
  }, [onFileCancel]);
  return (
    <>
      {note ? <p role="alert">{NOTES[note]}</p> : null}
      <p>Pick the song's file for the best result, or play it from a speaker near the phone.</p>
      <div className="learn-ways">
        <label className="learn-way is-primary" onClick={onFileTap}>
          <input
            ref={picker}
            type="file"
            accept="audio/*"
            className="learn-file"
            aria-label="Pick the song's file"
            aria-describedby={fileLine}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onFile(file);
            }}
          />
          <span className="learn-way-title">Pick the song's file</span>{" "}
          <span className="learn-way-line" id={fileLine}>
            Best result. From Files, Downloads or a Voice Memos share.
          </span>
        </label>
        <button type="button" className="learn-way" aria-label="Listen with the mic" aria-describedby={micLine} onClick={onMic}>
          <span className="learn-way-title">Listen with the mic</span>{" "}
          <span className="learn-way-line" id={micLine}>
            Play it from a speaker or another device, and stay on this screen.
          </span>
        </button>
      </div>
      <div className="learn-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

function Listening({ step, onStop, onCancel }: { step: Extract<Step, { kind: "listening" }>; onStop: () => void; onCancel: () => void }) {
  const { from, name, heard, expected } = step;
  return (
    <>
      <p>{from === "file" ? `Listening to ${name}.` : "Play the whole song near the phone from a speaker or another device, and stay on this screen. Tap Stop when it ends."}</p>
      {"wakeLock" in navigator ? null : <p>Keep this screen on while it listens.</p>}
      <div className="learn-progress">
        {expected ? <progress aria-label="Song heard" max={1} value={Math.min(1, heard / expected)} /> : from === "file" ? <progress aria-label="Song heard" /> : null}
        <span>{expected ? `${clockText(heard)} of ${clockText(expected)}` : clockText(heard)}</span>
      </div>
      <div className="learn-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        {from === "mic" ? (
          <button type="button" className="is-primary" onClick={onStop}>
            Stop
          </button>
        ) : null}
      </div>
    </>
  );
}

function Review({
  step,
  headings,
  bar,
  song,
  onChange,
  onCancel,
  onSave,
}: {
  step: Extract<Step, { kind: "review" }>;
  headings: string[];
  bar: number;
  song: Song;
  onChange: (next: Step) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { heard: { analysis }, boundaries } = step;
  const { sound, beats, tempos } = analysis;
  const songTime = (seconds: number) => clockText(seconds - sound.start);
  const length = Math.round(sound.end - sound.start);
  const tempo = Math.round(step.tempo.bpm);
  /**
   * Half or double time, once chosen, holds for every tempo heard after the opening one too. A pick within a tenth of
   * an octave of the heard tempo is that octave; any other tempo the player sets leaves the later tempos as heard.
   */
  const ratio = step.tempo.bpm / tempos[0].bpm;
  const nearest = 2 ** Math.round(Math.log2(ratio));
  const octave = Math.abs(ratio / nearest - 1) <= 0.1 ? nearest : 1;
  const [best, next] = step.heard.tempo.choices;
  const closeCall = step.heard.tempo.band === "likely" && next ? [Math.round(best.bpm), Math.round(next.bpm)] : [];
  const other = closeCall.includes(tempo) ? closeCall.map(fieldBpm).find((bpm) => bpm != null && bpm !== tempo) : undefined;
  const setTempo = (bpm: FieldBpm, taps: number[] = []) => onChange({ ...step, tempo: { bpm, band: "set" }, taps });
  const tap = () => {
    const taps = addTap(step.taps, performance.now());
    const tapped = fieldBpm(tapBpm(taps));
    if (tapped == null) onChange({ ...step, taps });
    else setTempo(tapped, taps);
  };
  const span = (each: Span) => `${songTime(each.start)}–${songTime(each.end)}`;
  /** A boundary moves a beat at a time and never onto or past its neighbours. */
  const limits = (index: number) => ({ earliest: (boundaries[index - 1] ?? 0) + 1, latest: (boundaries[index + 1] ?? beats.length) - 1 });
  const nudge = (index: number, by: number) => {
    const { earliest, latest } = limits(index);
    const next = boundaries.map((beat, i) => (i === index ? Math.min(latest, Math.max(earliest, beat + by)) : beat));
    onChange({ ...step, boundaries: next });
  };
  const heard = heardSections(song, analysis, boundaries, bar);

  return (
    <>
      <p className="learn-coverage">{coverageLine(step.heard)}</p>
      <p>
        {formatRuntime(length)} · <span data-band={step.tempo.band}>{tempo} BPM</span>
        {other ? (
          <>
            {" "}· or{" "}
            <button type="button" className="learn-or" aria-label={`Use ${other} BPM`} onClick={() => setTempo(other)}>
              {other}
            </button>
          </>
        ) : null}
        {tempos
          .slice(1)
          .map((each) => `, ${Math.round(each.bpm * octave)} BPM at ${songTime(each.at)}`)
          .join("")}
      </p>
      <div className="learn-actions">
        <button type="button" onClick={tap}>
          Tap the beat
        </button>
      </div>
      <ol className="learn-sections">
        {headings.map((heading, i) => {
          const name = shortHeading(heading);
          const beat = i === 0 ? 0 : boundaries[i - 1];
          return (
            <li key={i}>
              <span className="learn-heading">{name}</span>
              <span className="learn-at">
                {songTime(i === 0 ? sound.start : beats[beat])} · {barText(beat, bar)}
              </span>
              {i > 0 ? (
                <span className="learn-nudge">
                  <button type="button" aria-label={`${name} earlier`} disabled={beat <= limits(i - 1).earliest} onClick={() => nudge(i - 1, -1)}>
                    −
                  </button>
                  <button type="button" aria-label={`${name} later`} disabled={beat >= limits(i - 1).latest} onClick={() => nudge(i - 1, 1)}>
                    +
                  </button>
                </span>
              ) : null}
              {heard[i] ? (
                <HeardChords
                  name={name}
                  form={chartForm(song.body[i])}
                  heard={heard[i]}
                  kept={step.keepHeard[i]}
                  onKeep={() => onChange({ ...step, keepHeard: step.keepHeard.map((kept, k) => (k === i ? !kept : kept)) })}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {analysis.vocals.length > 0 ? (
        <fieldset className="learn-vocals">
          <legend>Suggested vocals</legend>
          {analysis.vocals.map((each, i) => (
            <label key={i}>
              <input
                type="checkbox"
                checked={step.vocals[i]}
                onChange={() => onChange({ ...step, vocals: step.vocals.map((kept, k) => (k === i ? !kept : kept)) })}
              />
              {span(each)}
            </label>
          ))}
        </fieldset>
      ) : null}
      {length !== song.officialRuntimeSec || tempo !== song.tempo ? (
        <label className="learn-use">
          <input type="checkbox" checked={step.useForSong} onChange={() => onChange({ ...step, useForSong: !step.useForSong })} />
          Use {formatRuntime(length)} and {tempo} BPM for this song
        </label>
      ) : null}
      <div className="learn-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="is-primary" onClick={onSave}>
          Save
        </button>
      </div>
    </>
  );
}

/** The chart's bars over the bars as heard, `?` where not sure, with a box to keep the heard ones. */
function HeardChords({ name, form, heard, kept, onKeep }: { name: string; form: string[]; heard: HeardBar[]; kept: boolean; onKeep: () => void }) {
  const cells = heard.map((each) => each.chord ?? "?");
  const sure = anySure(heard);
  const width = Math.max(...form.map((cell) => cell.length), ...cells.map((cell) => cell.length));
  const row = (groups: string[]) => (
    <span className="learn-bars">
      {groups.map((group, k) => (
        <span key={k}>
          {k > 0 ? " | " : ""}
          <span>{group}</span>
        </span>
      ))}
    </span>
  );
  return (
    <div className="learn-chords">
      {form.length > 0 ? (
        <>
          <span>Chart</span>
          {row(barGroups(form, width))}
        </>
      ) : null}
      <label>
        <input type="checkbox" aria-label={`Keep ${name} heard chords`} checked={kept && sure} disabled={!sure} onChange={onKeep} />
        Heard
      </label>
      {row(barGroups(cells, width))}
    </div>
  );
}
