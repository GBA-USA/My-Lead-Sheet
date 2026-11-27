import bands from "../scripts/learn-bands.json";
import { SongListener } from "./learn-analyze";
import type { Coverage, FromWorker, ToWorker, WorkerHandle } from "./learn-result";

/** The sound's level is read in frames this long. */
const LEVEL_FRAMES_PER_SECOND = 20;
/** A frame this quiet is digital silence, not the room, so it does not set the room's floor. */
const SILENCE_DB = -90;
/** A sample this close to full scale clipped. */
const FULL_SCALE = 0.999;

/** How far the song stands over the room's quietest frame, and how much of it clipped. */
class Quality {
  private readonly frameSize: number;
  private readonly levels: number[] = [];
  private energy = 0;
  private filled = 0;
  private clipped = 0;
  private samples = 0;

  constructor(sampleRate: number) {
    this.frameSize = Math.round(sampleRate / LEVEL_FRAMES_PER_SECOND);
  }

  push(chunk: Float32Array) {
    this.samples += chunk.length;
    for (const x of chunk) {
      if (Math.abs(x) >= FULL_SCALE) this.clipped += 1;
      this.energy += x * x;
      if (++this.filled < this.frameSize) continue;
      this.levels.push(10 * Math.log10(this.energy / this.frameSize + 1e-20));
      this.energy = 0;
      this.filled = 0;
    }
  }

  /** The median frame over the quietest one, against the floors in scripts/learn-bands.json. */
  word(): Coverage["quality"] {
    const heard = this.levels.filter((level) => level > SILENCE_DB).sort((a, b) => a - b);
    const overFloor = heard.length ? heard[heard.length >> 1] - heard[0] : 0;
    if (overFloor < bands.quality.someNoiseDb) return "noisy";
    return overFloor < bands.quality.clearDb || this.clipped > bands.quality.clippedShare * this.samples ? "some noise" : "clear";
  }
}

let listen: { ear: SongListener; quality: Quality; samples: number; sampleRate: number } | null = null;

/** One message from the phone. The samples of one listen build up until `finish`; the next samples start a new listen. */
export const handle: WorkerHandle = (message, post) => {
  if (message.kind === "stereo") return;
  if (message.kind === "samples") {
    const { chunk, sampleRate } = message;
    listen ??= { ear: new SongListener(sampleRate), quality: new Quality(sampleRate), samples: 0, sampleRate };
    listen.ear.push(chunk);
    listen.quality.push(chunk);
    listen.samples += chunk.length;
    post({ kind: "heard", seconds: listen.samples / listen.sampleRate });
    return;
  }
  const ended = listen;
  listen = null;
  const heard = ended?.ear.analyze(message.beatsPerBar, message.lyrics) ?? null;
  const { source, expectedSeconds, stopped } = message;
  const coverage = ended && { heardSeconds: ended.samples / ended.sampleRate, expectedSeconds, stopped, quality: ended.quality.word() };
  post({ kind: "done", listen: heard && coverage && { source, coverage, ...heard } });
};

const scope = globalThis as unknown as {
  WorkerGlobalScope?: abstract new () => object;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage: (reply: FromWorker, transfer: Transferable[]) => void;
};
if (scope.WorkerGlobalScope && globalThis instanceof scope.WorkerGlobalScope) {
  scope.onmessage = (event) => handle(event.data, (reply, transfer = []) => scope.postMessage(reply, transfer));
}
