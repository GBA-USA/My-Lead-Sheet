import { RAW_MIC } from "./bpm-finder";
import type { Coverage, FromWorker, Listen, Source, ToWorker } from "./learn-result";

/**
 * Where a listen's sound comes from and how it reaches the analysis worker. A file is decoded once to mono at
 * 22050 Hz; the mic is read through a ScriptProcessorNode. Both hand over one second of samples at a time, each in a
 * buffer of its own that is transferred to the worker, never copied.
 */

/** A file's decode rate. Every learn constant holds at it, and the highest pitch tracked, 988 Hz, is far under its 11 kHz top. */
export const FILE_RATE = 22_050;
/** A file longer than this is not a song. Its length is read before decode, because decode is the expensive step. */
const LONGEST_FILE_SECONDS = 20 * 60;
/** How long a browser gets to read a file's length before the file is decoded without it. */
const METADATA_WAIT_MS = 5000;

export type FileRefusal = "unreadable" | "too-long";

export class FileRefused extends Error {
  readonly reason: FileRefusal;
  constructor(reason: FileRefusal) {
    super(reason);
    this.reason = reason;
  }
}

/** A decoded file: where it came from, how long it says it is, and its samples a second at a time. */
export interface FileSound {
  source: Source;
  expectedSeconds: number;
  chunks: Iterable<Float32Array>;
}

/** The file's length from its metadata, or null when the browser does not say in time. Refuses a file no <audio> can open. */
function fileSeconds(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  const audio = document.createElement("audio");
  return new Promise<number | null>((resolve, reject) => {
    const timer = window.setTimeout(() => resolve(null), METADATA_WAIT_MS);
    audio.onloadedmetadata = () => {
      window.clearTimeout(timer);
      resolve(Number.isFinite(audio.duration) ? audio.duration : null);
    };
    audio.onerror = () => {
      window.clearTimeout(timer);
      reject(new FileRefused("unreadable"));
    };
    audio.preload = "metadata";
    audio.src = url;
  }).finally(() => {
    audio.onloadedmetadata = audio.onerror = null;
    audio.removeAttribute("src");
    URL.revokeObjectURL(url);
  });
}

/** Channel 0 of `decoded` with every other channel averaged into it, in place, so no second copy of the song is made. */
function mono(decoded: AudioBuffer): Float32Array {
  const out = decoded.getChannelData(0);
  const count = decoded.numberOfChannels;
  for (let channel = 1; channel < count; channel++) {
    const other = decoded.getChannelData(channel);
    for (let i = 0; i < out.length; i++) out[i] += other[i];
  }
  if (count > 1) for (let i = 0; i < out.length; i++) out[i] /= count;
  return out;
}

function* seconds(samples: Float32Array, rate: number): Generator<Float32Array> {
  for (let at = 0; at < samples.length; at += rate) yield samples.slice(at, at + rate);
}

/**
 * Reads a picked file's length, refuses one over twenty minutes, then decodes it to mono at 22050 Hz. Throws
 * FileRefused before decode for a file too long or one the browser cannot open, and after it for one it cannot decode.
 */
export async function fromFile(file: File): Promise<FileSound> {
  const said = await fileSeconds(file);
  if (said !== null && said > LONGEST_FILE_SECONDS) throw new FileRefused("too-long");
  const decoded = await new OfflineAudioContext(1, 1, FILE_RATE).decodeAudioData(await file.arrayBuffer()).catch(() => {
    throw new FileRefused("unreadable");
  });
  if (decoded.duration > LONGEST_FILE_SECONDS) throw new FileRefused("too-long");
  return {
    source: { kind: "file", name: file.name, stereo: false, sampleRate: decoded.sampleRate },
    expectedSeconds: said ?? decoded.duration,
    chunks: seconds(mono(decoded), decoded.sampleRate),
  };
}

/** What ended a mic listen when the player did not. */
export type MicStop = Exclude<Coverage["stopped"], "finished" | "player">;

export interface Mic {
  source: Source;
  /** Hands over what is left of the last second, stops every mic track and closes the audio. A second call does nothing. */
  stop(): void;
}

/**
 * Opens the mic. Call it inside the tap that starts listening: the AudioContext is made and resumed here, where iOS
 * allows it. Leaving the app, the track ending or going mute, and the audio being suspended each stop the listen and
 * say which; the mic denied or missing calls `failed`. Audio is never kept or sent anywhere but `chunk`.
 */
export function fromMic(on: { chunk: (samples: Float32Array) => void; stopped: (why: MicStop) => void; failed: () => void }): Mic {
  const audio = new AudioContext();
  const rate = audio.sampleRate;
  let second = new Float32Array(rate);
  let filled = 0;
  let tracks: MediaStreamTrack[] = [];
  let open = true;
  let running = false;

  const close = () => {
    if (!open) return false;
    open = false;
    if (filled) on.chunk(second.slice(0, filled));
    document.removeEventListener("visibilitychange", onVisibility);
    audio.onstatechange = null;
    for (const track of tracks) {
      track.onended = track.onmute = null;
      track.stop();
    }
    if (audio.state !== "closed") void audio.close();
    return true;
  };
  const end = (why: MicStop) => {
    if (close()) on.stopped(why);
  };
  function onVisibility() {
    if (document.visibilityState === "hidden") end("page-hidden");
  }
  document.addEventListener("visibilitychange", onVisibility);
  audio.onstatechange = () => {
    if (audio.state === "running") running = true;
    else if (running && audio.state !== "closed") end("audio-suspended");
  };
  void audio.resume();

  new Promise<MediaStream>((resolve) => resolve(navigator.mediaDevices.getUserMedia({ audio: RAW_MIC })))
    .then((stream) => {
      tracks = stream.getTracks();
      if (!open) return void tracks.forEach((track) => track.stop());
      for (const track of tracks) {
        track.onended = () => end("mic-ended");
        track.onmute = () => end("mic-muted");
      }
      const processor = audio.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        if (!open) return;
        const input = event.inputBuffer.getChannelData(0);
        for (let at = 0; at < input.length; ) {
          const take = Math.min(rate - filled, input.length - at);
          second.set(input.subarray(at, at + take), filled);
          filled += take;
          at += take;
          if (filled < rate) continue;
          on.chunk(second);
          second = new Float32Array(rate);
          filled = 0;
        }
      };
      audio.createMediaStreamSource(stream).connect(processor);
      processor.connect(audio.destination);
    })
    .catch(() => {
      if (close()) on.failed();
    });

  return { source: { kind: "mic", name: null, stereo: false, sampleRate: rate }, stop: () => void close() };
}

/** Asks to keep the screen on, inside a tap where every phone allows it, and gives back the release. Nothing where there is no wake lock. */
export function holdScreen(): () => void {
  if (!("wakeLock" in navigator)) return () => {};
  let held: WakeLockSentinel | null = null;
  let released = false;
  navigator.wakeLock.request("screen").then(
    (lock) => (released ? void lock.release().catch(() => {}) : (held = lock)),
    () => {},
  );
  return () => {
    released = true;
    void held?.release().catch(() => {});
    held = null;
  };
}

export interface WorkerListen {
  /** Seconds handed to the worker so far. */
  readonly seconds: number;
  /** Hands one chunk over, transferred; resolves once the worker has heard it, so a file goes no faster than it can listen. */
  send(chunk: Float32Array, sampleRate: number): Promise<void>;
  /** Ends the listen with what only the phone knows; resolves with what was heard, or null when no song was. */
  finish(ending: Omit<Extract<ToWorker, { kind: "finish" }>, "kind">): Promise<Listen | null>;
  /** Stops the worker without a result. */
  close(): void;
}

/** One listen in its own analysis worker, the only place a SongListener runs. */
export function listenInWorker(): WorkerListen {
  const worker = new Worker(new URL("./learn-worker.ts", import.meta.url), { type: "module" });
  const heard: (() => void)[] = [];
  let ended: { resolve: (listen: Listen | null) => void; reject: (error: Error) => void } | null = null;
  let broken: Error | null = null;
  let samples = 0;
  let rate = 1;
  worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
    if (data.kind === "heard") heard.shift()?.();
    if (data.kind !== "done") return;
    worker.terminate();
    ended?.resolve(data.listen);
  };
  worker.onerror = (event) => {
    worker.terminate();
    broken = new Error(event.message || "the listening worker failed");
    heard.splice(0).forEach((done) => done());
    ended?.reject(broken);
  };
  return {
    get seconds() {
      return samples / rate;
    },
    send(chunk, sampleRate) {
      if (broken) return Promise.resolve();
      samples += chunk.length;
      rate = sampleRate;
      worker.postMessage({ kind: "samples", chunk, sampleRate } satisfies ToWorker, [chunk.buffer]);
      return new Promise((done) => heard.push(done));
    },
    finish(ending) {
      if (broken) return Promise.reject(broken);
      worker.postMessage({ kind: "finish", ...ending } satisfies ToWorker);
      return new Promise((resolve, reject) => (ended = { resolve, reject }));
    },
    close: () => worker.terminate(),
  };
}
