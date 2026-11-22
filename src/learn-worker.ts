import { SongListener } from "./learn-analyze";
import type { FromWorker, ToWorker, WorkerHandle } from "./learn-result";

let listener: SongListener | null = null;
let samples = 0;
let sampleRate = 0;

/** One message from the phone. The samples of one listen build up until `finish`; the next samples start a new listen. */
export const handle: WorkerHandle = (message, post) => {
  if (message.kind === "samples") {
    if (!listener) {
      listener = new SongListener(message.sampleRate);
      samples = 0;
      sampleRate = message.sampleRate;
    }
    listener.push(message.chunk);
    samples += message.chunk.length;
    post({ kind: "heard", seconds: samples / sampleRate });
    return;
  }
  if (message.kind === "stereo") return;
  const heard = listener?.analyze(message.beatsPerBar) ?? null;
  const heardSeconds = listener ? samples / sampleRate : 0;
  listener = null;
  const { source, expectedSeconds, stopped } = message;
  // The sound's quality is not measured yet, so every listen reads clear.
  post({ kind: "done", listen: heard && { source, coverage: { heardSeconds, expectedSeconds, stopped, quality: "clear" }, ...heard } });
};

const scope = globalThis as unknown as {
  WorkerGlobalScope?: abstract new () => object;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage: (reply: FromWorker, transfer: Transferable[]) => void;
};
if (scope.WorkerGlobalScope && globalThis instanceof scope.WorkerGlobalScope) {
  scope.onmessage = (event) => handle(event.data, (reply, transfer = []) => scope.postMessage(reply, transfer));
}
