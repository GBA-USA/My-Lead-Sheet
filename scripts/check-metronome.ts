import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { fakeDom, type FakeElement } from "./fake-dom.ts";
import type { Song } from "../src/types.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const entry = `
  export * as audio from "./src/metronome-audio.ts";
  export * as model from "./src/metronome.ts";
  export { METRONOME_PREFS_KEY } from "./src/storage.ts";
  export { LeadSheet } from "./src/sheet.tsx";
  export { useMetronome } from "./src/metronome-view.tsx";
  export { createElement } from "react";
  export { createRoot } from "react-dom/client";
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: new URL("..", import.meta.url).pathname, loader: "tsx" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"production"' },
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "silent",
});
const bundle = join(mkdtempSync(join(tmpdir(), "check-metronome-")), "metronome.mjs");
writeFileSync(bundle, bundled.outputFiles[0].text);

const FRAME = 1 / 60;
const EPSILON = 1e-9;
let now = 0;
let resumeRejects = false;
const started: number[] = [];
const timers = new Map<number, { at: number; every: number | null; run: () => void }>();
let nextTimer = 1;
let frames: (() => void)[] = [];

const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
const node = { connect() {}, disconnect() {} };

class FakeAudioContext {
  static last: FakeAudioContext;
  static made = 0;
  state: AudioContextState = "suspended";
  outputLatency: number | undefined = 0.01;
  baseLatency: number | undefined = 0.005;
  constructor() {
    FakeAudioContext.last = this;
    FakeAudioContext.made += 1;
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

const addTimer = (run: () => void, ms: number, every: boolean) => {
  const id = nextTimer++;
  timers.set(id, { at: now + ms / 1000, every: every ? ms / 1000 : null, run });
  return id;
};
const dom = fakeDom();
const fakeWindow: Record<string, unknown> = {
  document: dom.document,
  HTMLIFrameElement: class {},
  setTimeout: (run: () => void, ms: number) => addTimer(run, ms, false),
  setInterval: (run: () => void, ms: number) => addTimer(run, ms, true),
  clearTimeout: (id: number) => timers.delete(id),
  clearInterval: (id: number) => timers.delete(id),
};
const store = new Map<string, string>();
let outputs: { kind: string; deviceId: string; label: string }[] = [];
let permissionAsks = 0;
Object.assign(globalThis, {
  window: fakeWindow,
  document: dom.document,
  localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  requestAnimationFrame: (run: () => void) => frames.push(run),
  cancelAnimationFrame() {},
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      enumerateDevices: async () => outputs,
      getUserMedia: async () => {
        permissionAsks += 1;
        throw new Error("never ask");
      },
    },
  },
});

type Ui = {
  audio: typeof import("../src/metronome-audio.ts");
  model: typeof import("../src/metronome.ts");
  METRONOME_PREFS_KEY: string;
  LeadSheet: unknown;
  useMetronome: typeof import("../src/metronome-view.tsx").useMetronome;
  createElement: (type: unknown, props?: object) => unknown;
  createRoot: (container: unknown) => { render: (element: unknown) => void; unmount: () => void };
};
const ui: Ui = await import(pathToFileURL(bundle).href);
const { audio, model } = ui;
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((done) => setImmediate(done));
};

const elements = () => dom.container.elements;
const hasClass = (el: FakeElement, name: string) => (el.getAttribute("class") ?? "").split(" ").includes(name);
const byClass = (name: string) => elements().find((el) => hasClass(el, name));
const byLabel = (label: string) => elements().find((el) => el.getAttribute("aria-label") === label);
const buttonIn = (within: FakeElement | undefined, text: string) =>
  within?.elements.find((el) => el.nodeName === "BUTTON" && el.textContent === text) ?? fail(`no ${text} button`);
const choice = (group: string, option: string) =>
  buttonIn(elements().find((el) => el.getAttribute("role") === "group" && el.getAttribute("aria-label") === group), option);
const tap = async (el: FakeElement | undefined) => {
  dom.click(el ?? fail("nothing to tap"));
  await settle();
};
const pad = () => byClass("metro-pad") ?? fail("no metronome pad");
const sheetDot = () => byClass("beat-dot")?.getAttribute("data-beat") ?? "none";
const syncShown = () => !!byClass("metro-sync");
const savedPrefs = () => JSON.parse(store.get(ui.METRONOME_PREFS_KEY) ?? "null");

/** Advances the clock, firing timers and one animation frame per 60 Hz tick. Returns each frame's dot state. */
function run(seconds: number, read: () => string): { at: number; state: string }[] {
  const end = now + seconds;
  const seen: { at: number; state: string }[] = [];
  let frameAt = Math.ceil(now / FRAME + EPSILON) * FRAME;
  while (frameAt <= end) {
    const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (due && due[1].at <= frameAt) {
      now = due[1].at;
      if (due[1].every == null) timers.delete(due[0]);
      else due[1].at += due[1].every;
      due[1].run();
      continue;
    }
    now = frameAt;
    const queued = frames;
    frames = [];
    queued.forEach((draw) => draw());
    seen.push({ at: now, state: read() });
    frameAt += FRAME;
  }
  now = end;
  return seen;
}

const flashStarts = (seen: { at: number; state: string }[]) =>
  seen.filter((frame, index) => index > 0 && frame.state === "on" && seen[index - 1].state !== "on").map((frame) => frame.at);

/** Every flash lands within one frame after a heard click, and every click heard in the window flashes. */
function inSync(label: string, seen: { at: number; state: string }[], heard: number[]) {
  const flashes = flashStarts(seen);
  const lag = (flash: number) => Math.min(...heard.map((time) => (flash - time >= -EPSILON ? flash - time : Infinity)));
  const from = seen[0].at;
  const to = seen[seen.length - 1].at - FRAME;
  const due = heard.filter((time) => time >= from && time <= to);
  const stray = flashes.filter((flash) => lag(flash) > FRAME + EPSILON);
  const missed = due.filter((time) => !flashes.some((flash) => flash - time >= -EPSILON && flash - time <= FRAME + EPSILON));
  if (!due.length) fail(`${label}: no heard clicks in the window`);
  if (stray.length || missed.length) {
    fail(`${label}: ${stray.length} flashes off any heard click (first at ${stray[0]?.toFixed(4)}), ${missed.length} heard clicks never flashed (first at ${missed[0]?.toFixed(4)})`);
  }
  const worst = Math.max(...flashes.map(lag));
  console.log(`${label}: ${due.length} heard clicks, ${flashes.length} flashes, each 0..${(worst * 1000).toFixed(2)} ms after the heard click`);
}

const moduleDot = () => model.beatDotState(audio.secondsSinceHeardClick(0));
let failures = 0;
const startOrFail = (bpm: number) => audio.startMetronome(bpm, () => failures++);

fakeWindow.AudioContext = FakeAudioContext;
outputs = [{ kind: "audiooutput", deviceId: "default", label: "" }];
if ((await audio.highLatencyOutput()) || FakeAudioContext.made) fail("detection before any start must neither detect nor create an AudioContext");
delete fakeWindow.AudioContext;

if (moduleDot() !== "off") fail("dot shows before the metronome ever starts");
startOrFail(120);
if (failures !== 1) fail(`no AudioContext must report a failure (got ${failures})`);
if (run(1, moduleDot).some((frame) => frame.state !== "off")) fail("dot shows with no AudioContext");
fakeWindow.AudioContext = FakeAudioContext;

failures = 0;
resumeRejects = true;
startOrFail(120);
await settle();
if (failures !== 1) fail(`rejected resume must report a failure (got ${failures})`);
if (started.length || run(2, moduleDot).some((frame) => frame.state !== "off")) fail("rejected resume still scheduled clicks or showed the dot");
console.log("rejected resume: onFail ran once, 0 clicks scheduled, dot off for 2 s");

failures = 0;
resumeRejects = false;
startOrFail(0);
await settle();
if (started.length || moduleDot() !== "off") fail("bpm 0 (unset) started the click or showed the dot");

startOrFail(90);
await settle();
if (failures) fail("a resumed context reported a failure");
FakeAudioContext.last.outputLatency = 0;
FakeAudioContext.last.baseLatency = 0;
const firstClick = now;
const at90 = run(3, moduleDot);
audio.setMetronomeBpm(180);
const at180 = run(3, moduleDot);
inSync("sync, 90 then 180 bpm, no latency", [...at90, ...at180], started);
const gap = (times: number[]) => times[times.length - 1] - times[times.length - 2];
const late90 = started.filter((time) => time <= firstClick + 3);
if (Math.abs(gap(late90) - model.metronomeBeatSeconds(90)) > 1e-6) fail("clicks at 90 bpm are not 0.667 s apart");
if (Math.abs(gap(started.filter((time) => time <= now)) - model.metronomeBeatSeconds(180)) > 1e-6) fail("clicks after the change to 180 bpm are not 0.333 s apart");
if (model.BEAT_FLASH_SECONDS >= model.metronomeBeatSeconds(300)) fail("flash outlasts the beat at 300 bpm");

audio.stopMetronome();
if (run(2, moduleDot).some((frame) => frame.state !== "off")) fail("dot not hidden after stop");
console.log("stop: dot off for every frame of the next 2 s");

failures = 0;
startOrFail(120);
await settle();
if (run(1, moduleDot).every((frame) => frame.state === "off")) fail("dot never lights while the click plays");
FakeAudioContext.last.state = "suspended";
resumeRejects = true;
dom.document.listeners.filter((listener) => listener.type === "visibilitychange").forEach((listener) => listener.run({}));
await settle();
if (failures !== 1) fail(`a refused resume on return to the page must report a failure (got ${failures})`);
const clicksBefore = started.length;
if (run(2, moduleDot).some((frame) => frame.state !== "off") || started.length !== clicksBefore) fail("click or dot kept going after a refused resume on return");
console.log("return to page, resume refused: onFail ran once, clicks stopped, dot off");
resumeRejects = false;
FakeAudioContext.last.outputLatency = 0.01;
FakeAudioContext.last.baseLatency = 0.005;

const library = JSON.parse(readFileSync(new URL("../data/library.json", import.meta.url), "utf8")) as { songs: Song[] };
const song = library.songs.find((each) => each.tempo === 90) ?? fail("no 90 bpm seed song");
const beat = model.metronomeBeatSeconds(90);
function Sheet() {
  const metronome = ui.useMetronome(song.id, song.tempo);
  return ui.createElement(ui.LeadSheet, { song, scale: 1, semitones: 0, notation: "notes", metronome });
}
let root = ui.createRoot(dom.container);
root.render(ui.createElement(Sheet));
await settle();

if (sheetDot() !== "none" || pad().getAttribute("aria-pressed") !== "false" || !pad().textContent.endsWith("Off")) fail("the sheet must open with the metronome off and no dot");
if (/double/i.test(dom.container.textContent + (pad().getAttribute("aria-label") ?? ""))) fail("the sheet still mentions a double tap");

const heardFrom = (shift: number) => started.map((time) => time + shift);
const sinceTap = started.length;
await tap(pad());
if (pad().getAttribute("aria-pressed") !== "true" || !pad().textContent.endsWith("On")) fail("one tap on Metronome must turn it on");
const playing = run(3, sheetDot);
if (started.length <= sinceTap) fail("one tap on Metronome scheduled no clicks");
inSync("one tap on: sheet dot", playing, heardFrom(0.01));
const states = new Set(playing.map((frame) => frame.state));
if ([...states].some((state) => state !== "on" && state !== "off")) fail(`dot shows a state other than fully on or off: ${[...states]}`);
const runs = playing.reduce<number[]>((lengths, frame, index) => {
  if (frame.state === "on") playing[index - 1]?.state === "on" ? lengths[lengths.length - 1]++ : lengths.push(1);
  return lengths;
}, []);
const flashFrames = Math.round(model.BEAT_FLASH_SECONDS / FRAME);
if (runs.slice(1).some((length) => Math.abs(length - flashFrames) > 1)) fail(`a flash should stay lit ${flashFrames} frames, got ${runs}`);
console.log(`hard flash: only on and off in ${playing.length} frames, each flash lit ${Math.min(...runs.slice(1))}-${Math.max(...runs.slice(1))} frames, off in between`);

await tap(pad());
const offClicks = started.length;
const afterOff = run(2, sheetDot);
if (pad().getAttribute("aria-pressed") !== "false" || afterOff.some((frame) => frame.state !== "none") || started.length !== offClicks) {
  fail("a second single tap must turn the metronome off: no clicks, no dot");
}
console.log("on/off: one tap starts, the next single tap stops; no double tap involved");

await tap(pad());
await tap(buttonIn(byClass("metronome"), "Settings"));
if (!byClass("metro-panel")) fail("Settings must open the metronome settings panel");

await tap(choice("Beat dot", "Off"));
const quietDot = started.length;
if (run(2, sheetDot).some((frame) => frame.state !== "none")) fail("beat dot off must remove the dot");
if (started.length <= quietDot) fail("beat dot off must not stop the click");
if (savedPrefs()?.indicator !== false) fail("beat dot off was not saved");
console.log(`beat dot off: no dot for 2 s while ${started.length - quietDot} clicks still sounded; saved`);
await tap(choice("Beat dot", "On"));

await tap(choice("Sound", "Off"));
run(0.2, sheetDot);
const lastAudible = started[started.length - 1];
const audible = started.length;
const silent = run(3, sheetDot);
if (started.length !== audible) fail(`sound off still scheduled ${started.length - audible} audible clicks`);
const grid = Array.from({ length: 12 }, (_, index) => lastAudible + (index + 1) * beat + 0.01);
inSync("sound off: no click scheduled, dot still on the beat", silent, grid);
if (savedPrefs()?.sound !== false) fail("sound off was not saved");
await tap(choice("Sound", "On"));
run(0.5, sheetDot);
if (started.length === audible) fail("sound on did not bring the click back");

const context = FakeAudioContext.last;
run(1.1, sheetDot);
await settle();
if (syncShown()) fail("Auto must hide dot sync at a 10 ms wired output latency");
context.outputLatency = 0.2;
inSync("outputLatency 200 ms, read live", run(3, sheetDot), heardFrom(0.2));
await settle();
if (!syncShown()) fail("Auto must show dot sync once outputLatency passes the threshold");
console.log(`auto: dot sync hidden at 10 ms, shown at 200 ms (threshold ${model.HIGH_OUTPUT_LATENCY_SECONDS * 1000} ms)`);

for (let i = 0; i < 5; i++) await tap(byLabel("Dot later"));
if (byLabel("Dot sync offset")?.textContent !== "+50 ms") fail(`dot sync should read +50 ms, got ${byLabel("Dot sync offset")?.textContent}`);
if (savedPrefs()?.syncOffsetMs !== 50) fail("dot sync offset was not saved");
inSync("outputLatency 200 ms + manual +50 ms", run(3, sheetDot), heardFrom(0.25));

context.outputLatency = undefined;
context.baseLatency = 0.03;
inSync("no outputLatency, baseLatency 30 ms + manual +50 ms", run(3, sheetDot), heardFrom(0.08));
await settle();
if (syncShown()) fail("Auto must hide dot sync when the browser reports no outputLatency");

const detected = async (devices: typeof outputs) => {
  outputs = devices;
  run(1.1, sheetDot);
  await settle();
  return syncShown();
};
const output = (deviceId: string, label: string) => ({ kind: "audiooutput", deviceId, label });
if (!(await detected([output("default", "Default - AirPods Pro (Bluetooth)"), output("a1", "AirPods Pro (Bluetooth)")]))) fail("Auto must show dot sync for a Bluetooth output label");
if (await detected([output("default", "Default - MacBook Pro Speakers"), output("a1", "AirPods Pro")])) fail("Auto must follow the current output, not any paired one");
if (await detected([output("", ""), output("", "")])) fail("Auto must hide dot sync when labels are hidden");
if (permissionAsks) fail("detection asked for a permission");
console.log("auto: shown for a Bluetooth label on the current output, hidden for speakers or hidden labels, never asked for a permission");

await tap(choice("Dot sync", "On"));
if (!syncShown()) fail("On must show dot sync with no detection");
context.outputLatency = 0.2;
await tap(choice("Dot sync", "Off"));
run(1.1, sheetDot);
await settle();
if (syncShown()) fail("Off must hide dot sync even at 200 ms");
await tap(choice("Dot sync", "On"));
await tap(choice("Beat dot", "Off"));
if (syncShown()) fail("dot sync must hide while the beat dot is off");
await tap(choice("Beat dot", "On"));
console.log("on and off: On shows dot sync without detection, Off hides it at 200 ms");

root.unmount();
root = ui.createRoot(dom.container);
root.render(ui.createElement(Sheet));
await settle();
if (byLabel("Dot sync offset")?.textContent !== "+50 ms") fail("dot sync offset did not persist across a reload");
await tap(buttonIn(byClass("metronome"), "Settings"));
const pressed = (group: string) => elements().find((el) => el.getAttribute("aria-label") === group)?.elements.find((el) => el.getAttribute("aria-pressed") === "true")?.textContent;
if (pressed("Beat dot") !== "On" || pressed("Sound") !== "On" || pressed("Dot sync") !== "On") fail("settings did not reload as saved");
store.set(ui.METRONOME_PREFS_KEY, JSON.stringify({ indicator: false, sound: "loud", syncMode: "maybe", syncOffsetMs: 9999 }));
const parsed = model.parseMetronomePrefs(JSON.parse(store.get(ui.METRONOME_PREFS_KEY)!));
if (parsed.indicator !== false || parsed.sound !== true || parsed.syncMode !== "auto" || parsed.syncOffsetMs !== model.SYNC_OFFSET_MAX_MS) fail("bad saved fields must fall back one by one");
console.log(`persist: +50 ms and the switches reload; bad fields fall back alone; offset ${model.SYNC_OFFSET_MIN_MS}..+${model.SYNC_OFFSET_MAX_MS} ms in ${model.SYNC_OFFSET_STEP_MS} ms steps`);
root.unmount();

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const dotRule = css.match(/\.beat-dot \{[^}]*\}/)?.[0] ?? fail("no .beat-dot rule");
if (!/width: 12px/.test(dotRule) || !/height: 12px/.test(dotRule)) fail("the beat dot must be 12 px");
if (/\.beat-dot[^{]*\{[^}]*(opacity|transition|animation)/.test(css)) fail("the beat dot must flash hard: no dim, fade or animation");
console.log("dot style: 12 px, no dim, fade or animation");

console.log("metronome checks passed");
process.exit(0);
