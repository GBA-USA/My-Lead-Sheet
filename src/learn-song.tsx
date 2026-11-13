import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RAW_MIC } from "./bpm-finder";
import { SongListener, beatsPerBar, learnedVersion, shortHeading, type Analysis } from "./learn-analyze";
import type { ScrollVersion, Span } from "./scroll-timing";
import { formatRuntime, songDataFromForm } from "./song-data-editor";
import type { Song, SongData } from "./types";
import "./learn.css";

const NO_MIC = "The mic isn't available.";
const NOT_HEARD = "No song with a steady beat heard. Try again closer to the phone.";

/**
 * Asks for the mic and feeds it to a SongListener until the returned stop() is called. stop() stops every
 * mic track and gives back what was heard, or null if the mic never opened. Audio is never kept or sent.
 */
export function listenToSong(on: { heard: (seconds: number) => void; noMic: () => void }): () => SongListener | null {
  let audio: AudioContext | undefined;
  let mic: MediaStream | undefined;
  let listener: SongListener | null = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    mic?.getTracks().forEach((track) => track.stop());
    if (audio && audio.state !== "closed") void audio.close();
    return listener;
  };
  new Promise<MediaStream>((resolve) => {
    audio = new AudioContext();
    resolve(navigator.mediaDevices.getUserMedia({ audio: RAW_MIC }));
  })
    .then((stream) => {
      mic = stream;
      if (stopped || !audio) return void stop();
      const song = new SongListener(audio.sampleRate);
      listener = song;
      const processor = audio.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        if (stopped) return;
        song.push(event.inputBuffer.getChannelData(0));
        on.heard(song.seconds);
      };
      audio.createMediaStreamSource(stream).connect(processor);
      processor.connect(audio.destination);
      void audio.resume();
    })
    .catch(() => {
      if (stopped) return;
      stop();
      on.noMic();
    });
  return stop;
}

type Step =
  | { kind: "listening"; heard: number }
  | { kind: "note"; text: string }
  | { kind: "review"; analysis: Analysis; boundaries: number[]; vocals: boolean[]; useForSong: boolean };

const clockText = (seconds: number) => formatRuntime(Math.max(0, Math.floor(seconds)));

function barText(beat: number, bar: number): string {
  const inBar = beat % bar;
  return inBar === 0 ? `bar ${beat / bar + 1}` : `bar ${Math.floor(beat / bar) + 1}, beat ${inBar + 1}`;
}

/**
 * The Learn this song button and its sheet: listen to the whole song, then review the length, tempo,
 * sections and suggested vocals, and save them as a new timing version.
 */
export function LearnSong({
  song,
  original,
  metronomeBpm,
  onSave,
}: {
  song: Song;
  original: Song;
  metronomeBpm: number | null;
  onSave: (version: Omit<ScrollVersion, "name">, data: SongData | null) => void;
}) {
  const [step, setStep] = useState<Step | null>(null);
  const stopListening = useRef<() => SongListener | null>(() => null);
  const titleId = useId();
  const headings = song.body.map((section) => section.heading);
  const bar = beatsPerBar(song.timeSignature);
  useEffect(() => () => void stopListening.current(), []);

  const listen = () => {
    setStep({ kind: "listening", heard: 0 });
    stopListening.current = listenToSong({
      heard: (heard) => setStep({ kind: "listening", heard }),
      noMic: () => setStep({ kind: "note", text: NO_MIC }),
    });
  };
  const cancel = () => {
    stopListening.current();
    setStep(null);
  };
  const finish = () => {
    const analysis = stopListening.current()?.analyze(headings.length, bar);
    setStep(
      analysis
        ? { kind: "review", analysis, boundaries: analysis.boundaries, vocals: analysis.vocals.map(() => true), useForSong: false }
        : { kind: "note", text: NOT_HEARD },
    );
  };

  return (
    <>
      <button type="button" className="teach-btn" onClick={listen}>
        Learn this song
      </button>
      {step
        ? createPortal(
            <div className="learn-backdrop">
              <div className="learn" role="dialog" aria-modal="true" aria-labelledby={titleId}>
                <h2 id={titleId}>Learn this song</h2>
                {step.kind === "listening" ? (
                  <Listening heard={step.heard} runtime={song.officialRuntimeSec} onStop={finish} onCancel={cancel} />
                ) : null}
                {step.kind === "note" ? (
                  <>
                    <p role="status">{step.text}</p>
                    <div className="learn-actions">
                      <button type="button" onClick={cancel}>
                        Cancel
                      </button>
                      <button type="button" className="is-primary" onClick={listen}>
                        Try again
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
                      const { analysis, boundaries, useForSong } = step;
                      const tempo = Math.round(analysis.tempos[0].bpm);
                      const vocals = analysis.vocals.filter((_, i) => step.vocals[i]);
                      const runtime = formatRuntime(Math.round(analysis.sound.end - analysis.sound.start));
                      const data = useForSong
                        ? songDataFromForm(original, { runtime, bpm: String(tempo), timeSignature: song.timeSignature })
                        : null;
                      const bpm = useForSong ? tempo : (metronomeBpm ?? tempo);
                      onSave(learnedVersion(analysis, { boundaries, vocals }, headings, bar, bpm), data);
                      setStep(null);
                    }}
                  />
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function Listening({
  heard,
  runtime,
  onStop,
  onCancel,
}: {
  heard: number;
  runtime: number | null;
  onStop: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <p>Play the whole song near the phone, then tap Stop.</p>
      <div className="learn-progress">
        {runtime ? <progress aria-label="Song heard" max={1} value={Math.min(1, heard / runtime)} /> : null}
        <span>{clockText(heard)}</span>
      </div>
      <div className="learn-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="is-primary" onClick={onStop}>
          Stop
        </button>
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
  const { analysis, boundaries } = step;
  const { sound, beats, tempos } = analysis;
  const songTime = (seconds: number) => clockText(seconds - sound.start);
  const length = Math.round(sound.end - sound.start);
  const tempo = Math.round(tempos[0].bpm);
  const span = (each: Span) => `${songTime(each.start)}–${songTime(each.end)}`;
  /** A boundary moves a beat at a time and never onto or past its neighbours. */
  const limits = (index: number) => ({ earliest: (boundaries[index - 1] ?? 0) + 1, latest: (boundaries[index + 1] ?? beats.length) - 1 });
  const nudge = (index: number, by: number) => {
    const { earliest, latest } = limits(index);
    const next = boundaries.map((beat, i) => (i === index ? Math.min(latest, Math.max(earliest, beat + by)) : beat));
    onChange({ ...step, boundaries: next });
  };

  return (
    <>
      <p>
        {formatRuntime(length)} ·{" "}
        {tempos.map((each, i) => (i === 0 ? `${tempo} BPM` : `, ${Math.round(each.bpm)} BPM at ${songTime(each.at)}`)).join("")}
      </p>
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
