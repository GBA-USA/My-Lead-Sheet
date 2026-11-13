import { useEffect, useRef, useState, type ReactNode } from "react";
import { TempoDetector, addTap, tapBpm, tempoChoices } from "./bpm-detect";
import "./bpm-finder.css";

export const LISTEN_SECONDS = 15;
const NO_MIC = "The mic isn't available. You can tap along instead.";
const NO_BEAT = "No steady beat heard. Try again or tap along.";
/** Music, not speech: the browser's voice cleanup would flatten the beats. */
const RAW_MIC: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

interface Listener {
  progress: (heard: number) => void;
  tempo: (bpm: number | null) => void;
  noMic: () => void;
}

/**
 * Asks for the mic, feeds it to a TempoDetector for `seconds` of audio, and returns a stop function.
 * Every mic track stops when listening ends or stop() is called. Audio is never kept or sent anywhere.
 */
export function listenForTempo(seconds: number, on: Listener): () => void {
  let audio: AudioContext | undefined;
  let mic: MediaStream | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    mic?.getTracks().forEach((track) => track.stop());
    if (audio && audio.state !== "closed") void audio.close();
  };
  new Promise<MediaStream>((resolve) => {
    audio = new AudioContext();
    resolve(navigator.mediaDevices.getUserMedia({ audio: RAW_MIC }));
  })
    .then((stream) => {
      mic = stream;
      if (stopped || !audio) return stop();
      const detector = new TempoDetector(audio.sampleRate);
      const processor = audio.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        if (stopped) return;
        detector.push(event.inputBuffer.getChannelData(0));
        if (detector.seconds < seconds) return on.progress(detector.seconds / seconds);
        stop();
        on.tempo(detector.tempo());
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
  | { kind: "choose"; note: string | null }
  | { kind: "listening"; heard: number }
  | { kind: "tapping"; taps: number[] }
  | { kind: "found"; bpm: number };

/** Wraps the BPM input with a Find BPM button; picking a choice fills the input and nothing else. */
export function BpmFinder({ children, onAccept }: { children: ReactNode; onAccept: (bpm: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="bpm-entry">
        {children}
        <button type="button" className="bpm-find" aria-expanded={open} onClick={() => setOpen(!open)}>
          Find BPM
        </button>
      </div>
      {open ? (
        <FinderPanel
          onAccept={(bpm) => {
            onAccept(bpm);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function FinderPanel({ onAccept, onCancel }: { onAccept: (bpm: number) => void; onCancel: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "choose", note: null });
  const stopListening = useRef(() => {});
  useEffect(() => () => stopListening.current(), []);

  const listen = () => {
    setStep({ kind: "listening", heard: 0 });
    stopListening.current = listenForTempo(LISTEN_SECONDS, {
      progress: (heard) => setStep({ kind: "listening", heard }),
      tempo: (bpm) => setStep(bpm == null ? { kind: "choose", note: NO_BEAT } : { kind: "found", bpm }),
      noMic: () => setStep({ kind: "choose", note: NO_MIC }),
    });
  };
  const tapped = step.kind === "tapping" ? tapBpm(step.taps) : null;
  const found = step.kind === "found" ? step.bpm : tapped;

  return (
    <div className="bpm-finder" role="group" aria-label="Find BPM">
      {step.kind === "choose" ? (
        <>
          {step.note ? <p role="status">{step.note}</p> : null}
          <div className="bpm-modes">
            <button type="button" onClick={listen}>
              Listen
            </button>
            <button type="button" onClick={() => setStep({ kind: "tapping", taps: [] })}>
              Tap tempo
            </button>
          </div>
        </>
      ) : null}
      {step.kind === "listening" ? (
        <>
          <p>Play the song nearby.</p>
          <progress aria-label="Listening" max={1} value={step.heard} />
        </>
      ) : null}
      {step.kind === "tapping" ? (
        <button
          type="button"
          className="bpm-tap"
          aria-label="Tap the beat"
          onClick={() => setStep({ kind: "tapping", taps: addTap(step.taps, performance.now()) })}
        >
          {tapped == null ? "Tap along" : `${Math.round(tapped)} BPM`}
        </button>
      ) : null}
      {found != null ? (
        <div className="bpm-choices">
          {tempoChoices(found).map(({ bpm, feel }) => (
            <button
              key={feel}
              type="button"
              className={feel === "Suggested" ? "is-suggested" : undefined}
              aria-label={feel === "Suggested" ? `Use ${bpm} BPM` : `Use ${bpm} BPM, ${feel.toLowerCase()}`}
              onClick={() => onAccept(bpm)}
            >
              <strong>{bpm}</strong>
              <span>{feel}</span>
            </button>
          ))}
        </div>
      ) : null}
      <button type="button" className="bpm-cancel" aria-label="Cancel Find BPM" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
