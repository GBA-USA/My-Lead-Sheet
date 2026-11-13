import { registerHooks } from "node:module";
import { BEAT_FLASH_SECONDS, beatDotState, metronomeBeatSeconds } from "../src/metronome.ts";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return next(`${specifier}.ts`, context);
      throw error;
    }
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const FRAME = 1 / 60;
let now = 0;
let resumeRejects = false;
const started: number[] = [];
const timers = new Map<number, { at: number; run: () => void }>();
let nextTimer = 1;

const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
const node = { connect() {}, disconnect() {} };

class FakeAudioContext {
  static last: FakeAudioContext;
  state: AudioContextState = "suspended";
  constructor() {
    FakeAudioContext.last = this;
  }
  destination = {};
  get currentTime() {
    return now;
  }
  resume() {
    if (resumeRejects) return Promise.reject(new Error("NotAllowedError"));
    this.state = "running";
    return Promise.resolve();
  }
  createOscillator() {
    return { ...node, type: "", frequency: param, start: (time: number) => started.push(time), stop() {}, onended: null };
  }
  createGain() {
    return { ...node, gain: param };
  }
}

const fakeWindow: Record<string, unknown> = {
  setTimeout: (run: () => void, ms: number) => {
    const id = nextTimer++;
    timers.set(id, { at: now + ms / 1000, run });
    return id;
  },
  clearTimeout: (id: number) => timers.delete(id),
};
const onVisible: (() => void)[] = [];
Object.assign(globalThis, {
  window: fakeWindow,
  document: { visibilityState: "visible", addEventListener: (_: string, run: () => void) => onVisible.push(run) },
});

const audio = await import("../src/metronome-audio.ts");
const settle = () => new Promise((done) => setImmediate(done));
const dot = () => beatDotState(audio.secondsSinceClick());

/** Advances the clock, firing scheduler timers and one dot read per 60 Hz frame. Returns frame times where the dot lit. */
function run(seconds: number, onFrame?: (state: string) => void): number[] {
  const end = now + seconds;
  const flashes: number[] = [];
  let frameAt = Math.ceil(now / FRAME + 1e-9) * FRAME;
  let previous = dot();
  while (frameAt <= end) {
    const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (due && due[1].at <= frameAt) {
      now = due[1].at;
      timers.delete(due[0]);
      due[1].run();
      continue;
    }
    now = frameAt;
    const state = dot();
    onFrame?.(state);
    if (state === "on" && previous !== "on") flashes.push(now);
    previous = state;
    frameAt += FRAME;
  }
  now = end;
  return flashes;
}

let failures = 0;
const startOrFail = (bpm: number) => {
  audio.startMetronome(bpm, () => failures++);
};

if (dot() !== "off") fail("dot shows before the metronome ever starts");

startOrFail(120);
if (failures !== 1) fail(`no AudioContext must report a failure (got ${failures})`);
if (run(1).length || dot() !== "off") fail("dot shows with no AudioContext");
fakeWindow.AudioContext = FakeAudioContext;

failures = 0;
resumeRejects = true;
startOrFail(120);
await settle();
if (failures !== 1) fail(`rejected resume must report a failure (got ${failures})`);
const lit = new Set<string>();
run(2, (state) => lit.add(state));
if (started.length || lit.has("on") || lit.has("rest")) fail("rejected resume still scheduled clicks or showed the dot");
console.log("rejected resume: onFail ran once, 0 clicks scheduled, dot off for 2 s");

failures = 0;
resumeRejects = false;
startOrFail(0);
await settle();
if (started.length || dot() !== "off") fail("bpm 0 (unset) started the click or showed the dot");

startOrFail(90);
await settle();
if (failures) fail("a resumed context reported a failure");
const firstClick = now;
const flashesAt90 = run(3);
audio.setMetronomeBpm(180);
const flashesAt180 = run(3);
const flashes = [...flashesAt90, ...flashesAt180];
const heard = started.filter((time) => time <= now - FRAME);

if (flashes.length < heard.length || flashes.length > heard.length + 1) fail(`${heard.length} clicks reached the clock but the dot lit ${flashes.length} times`);
let worst = 0;
heard.forEach((click, index) => {
  const lag = flashes[index] - click;
  if (lag < 0 || lag > FRAME + 1e-9) fail(`flash ${index} at ${flashes[index].toFixed(4)} is ${lag * 1000} ms from its click at ${click.toFixed(4)}`);
  worst = Math.max(worst, lag);
});
const gap = (times: number[]) => times[times.length - 1] - times[times.length - 2];
const late90 = heard.filter((time) => time <= firstClick + 3);
if (Math.abs(gap(late90) - metronomeBeatSeconds(90)) > 1e-6) fail("clicks at 90 bpm are not 0.667 s apart");
if (Math.abs(gap(heard) - metronomeBeatSeconds(180)) > 1e-6) fail("clicks after the change to 180 bpm are not 0.333 s apart");
if (BEAT_FLASH_SECONDS >= metronomeBeatSeconds(300)) fail("flash outlasts the beat at 300 bpm");
console.log(
  `sync: ${heard.length} clicks (${late90.length} at 90 bpm, ${heard.length - late90.length} at 180 bpm), every flash 0..${(worst * 1000).toFixed(2)} ms after its scheduled click (frame ${(FRAME * 1000).toFixed(2)} ms)`,
);

audio.stopMetronome();
const afterStop = new Set<string>();
run(2, (state) => afterStop.add(state));
if (afterStop.size !== 1 || !afterStop.has("off")) fail(`dot not hidden after stop: ${[...afterStop]}`);
console.log("stop: dot off for every frame of the next 2 s");

failures = 0;
startOrFail(120);
await settle();
run(1);
if (dot() === "off") fail("dot is off while the click plays");
const context = (fakeWindow.AudioContext as unknown as { last: FakeAudioContext }).last;
context.state = "suspended";
resumeRejects = true;
onVisible.forEach((run) => run());
await settle();
if (failures !== 1) fail(`a refused resume on return to the page must report a failure (got ${failures})`);
const clicksBefore = started.length;
const afterReturn = new Set<string>();
run(2, (state) => afterReturn.add(state));
if (started.length !== clicksBefore || afterReturn.size !== 1 || !afterReturn.has("off")) fail("click or dot kept going after a refused resume on return");
console.log("return to page, resume refused: onFail ran once, clicks stopped, dot off");

console.log("metronome checks passed");
