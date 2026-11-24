/**
 * The browser's Worker for node checks: `new FakeWorker(url)` runs src/learn-worker.ts `handle` in this process, so a
 * check drives the same messages the phone and the analysis worker trade in the app.
 * - Each worker loads its own copy of the worker module, as each real worker starts fresh.
 * - Every message crosses through structuredClone with its transfer list, so a transferred chunk is detached on the
 *   sending side as it is in a browser, and only data a worker could receive arrives.
 * - Messages are delivered in order, each in its own task. A throw in `handle` reaches the phone as an "error" event.
 * The phone makes its worker with `new Worker(new URL("./learn-worker.ts", import.meta.url), { type: "module" })`, the
 * form Vite builds and esbuild leaves alone. `workerLog` keeps every message both ways, how long `handle` ran, how many
 * workers were stopped, and how many messages were posted to a worker after it was stopped, which a browser drops.
 * `workerIdle` waits for the worker to catch up, `workerReplies.rewrite` changes what the phone is told, and
 * `workerFaults.failOn` makes the worker throw.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { FromWorker, Listen, ToWorker, WorkerHandle } from "../src/learn-result.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
let bundled: Promise<string> | undefined;

/** src/learn-worker.ts built once. Each worker imports it under its own query, so its module state is its own. */
function workerModule(): Promise<string> {
  bundled ??= build({
    entryPoints: [join(root, "src", "learn-worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  }).then((out) => {
    const file = join(mkdtempSync(join(tmpdir(), "fake-worker-")), "learn-worker.mjs");
    writeFileSync(file, out.outputFiles[0].text);
    return pathToFileURL(file).href;
  });
  return bundled;
}

/** Since the last clear: workers started and stopped, every message each way, messages posted to a stopped worker, errors, and real milliseconds spent inside `handle`. */
export const workerLog = { started: 0, stopped: 0, toWorker: [] as ToWorker[], toStopped: 0, fromWorker: [] as FromWorker[], errors: [] as unknown[], busyMs: 0 };

/** Set `rewrite` to change each reply on its way to the phone, so a check can show the phone a result it chose. */
export const workerReplies: { rewrite: ((reply: FromWorker) => FromWorker) | null } = { rewrite: null };

/** Set `failOn` to a message kind, and the worker throws on the next one it gets, as a worker that breaks does. */
export const workerFaults: { failOn: ToWorker["kind"] | null } = { failOn: null };

export function clearWorkerLog() {
  Object.assign(workerLog, { started: 0, stopped: 0, toWorker: [], toStopped: 0, fromWorker: [], errors: [], busyMs: 0 });
}

type Listener = (event: { type: string; data?: unknown; message?: string; error?: unknown }) => void;
const nextTask = () => new Promise<void>((done) => setImmediate(done));
let instances = 0;
const inFlight = new Set<Promise<void>>();

/**
 * Resolves once every message posted so far has been handled and its replies delivered. A check that awaits it after
 * each mic callback paces the worker the way real time does, where it finishes a chunk long before the next arrives.
 */
export async function workerIdle() {
  while (inFlight.size) await Promise.all([...inFlight]);
}

export class FakeWorker {
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  onmessageerror: Listener | null = null;
  private readonly listeners: { type: string; run: Listener }[] = [];
  private queue: Promise<WorkerHandle | null>;
  private terminated = false;

  constructor(url: string | URL, _options?: { type?: string; name?: string }) {
    if (!/learn-worker\.[jt]s(\?.*)?$/.test(String(url))) throw new Error(`FakeWorker runs src/learn-worker.ts, not ${String(url)}`);
    workerLog.started += 1;
    const instance = (instances += 1);
    this.queue = workerModule()
      .then((href) => import(`${href}?worker=${instance}`))
      .then((module: { handle?: WorkerHandle }) => {
        if (typeof module.handle !== "function") throw new Error("src/learn-worker.ts exports no handle");
        return module.handle;
      })
      .catch((error: unknown) => {
        this.fail(error);
        return null;
      });
  }

  postMessage(message: ToWorker, transfer: Transferable[] | { transfer?: Transferable[] } = []) {
    if (this.terminated) return void (workerLog.toStopped += 1);
    const copy = structuredClone(message, { transfer: Array.isArray(transfer) ? transfer : (transfer.transfer ?? []) });
    workerLog.toWorker.push(copy);
    this.queue = this.queue.then(async (handle) => {
      await nextTask();
      if (!handle || this.terminated) return handle;
      const started = process.hrtime.bigint();
      try {
        if (workerFaults.failOn === copy.kind) throw new Error(`the worker broke on ${copy.kind}`);
        handle(copy, (reply, back = []) => this.reply(reply, back));
      } catch (error) {
        this.fail(error);
      } finally {
        workerLog.busyMs += Number(process.hrtime.bigint() - started) / 1e6;
      }
      return handle;
    });
    const delivered = this.queue.then(nextTask, nextTask);
    inFlight.add(delivered);
    void delivered.then(() => inFlight.delete(delivered));
  }

  addEventListener(type: string, run: Listener) {
    this.listeners.push({ type, run });
  }

  removeEventListener(type: string, run: Listener) {
    const at = this.listeners.findIndex((each) => each.type === type && each.run === run);
    if (at >= 0) this.listeners.splice(at, 1);
  }

  terminate() {
    if (!this.terminated) workerLog.stopped += 1;
    this.terminated = true;
  }

  private reply(reply: FromWorker, transfer: Transferable[]) {
    if (this.terminated) return;
    const copy = structuredClone(workerReplies.rewrite?.(reply) ?? reply, { transfer });
    workerLog.fromWorker.push(copy);
    setImmediate(() => this.dispatch({ type: "message", data: copy }));
  }

  private fail(error: unknown) {
    workerLog.errors.push(error);
    setImmediate(() => this.dispatch({ type: "error", message: error instanceof Error ? error.message : String(error), error }));
  }

  private dispatch(event: Parameters<Listener>[0]) {
    if (this.terminated) return;
    const own = event.type === "message" ? this.onmessage : this.onerror;
    own?.call(this, event);
    for (const { type, run } of [...this.listeners]) if (type === event.type) run.call(this, event);
  }
}

/**
 * Plays samples through a fresh worker in one-second chunks, the way the phone posts a decoded file, then `finish`.
 * Gives back the Listen and each `heard` the worker sent.
 */
export function listenThrough(
  samples: Float32Array,
  sampleRate: number,
  finish: Omit<Extract<ToWorker, { kind: "finish" }>, "kind">,
): Promise<{ listen: Listen | null; heard: number[] }> {
  return new Promise((resolve, reject) => {
    const worker = new FakeWorker("learn-worker.ts");
    const heard: number[] = [];
    worker.onerror = (event) => (worker.terminate(), reject(event.error));
    worker.onmessage = ({ data }) => {
      const reply = data as FromWorker;
      if (reply.kind === "heard") heard.push(reply.seconds);
      if (reply.kind !== "done") return;
      worker.terminate();
      resolve({ listen: reply.listen, heard });
    };
    for (let at = 0; at < samples.length; at += sampleRate) {
      const chunk = samples.slice(at, at + sampleRate);
      worker.postMessage({ kind: "samples", chunk, sampleRate }, [chunk.buffer]);
    }
    worker.postMessage({ kind: "finish", ...finish });
  });
}
