import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { fakeDom, type FakeElement } from "./fake-dom.ts";
import type { Song, SongData } from "../src/types.ts";

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
}

const entry = `
  export * from "./src/bpm-detect.ts";
  export { LISTEN_SECONDS } from "./src/bpm-finder.tsx";
  export { SongDataEditor } from "./src/song-data-editor.tsx";
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
const bundle = join(mkdtempSync(join(tmpdir(), "check-bpm-")), "bpm.mjs");
writeFileSync(bundle, bundled.outputFiles[0].text);

type Ui = typeof import("../src/bpm-detect.ts") & {
  LISTEN_SECONDS: number;
  SongDataEditor: unknown;
  createElement: (type: unknown, props?: object) => unknown;
  createRoot: (container: unknown) => { render: (element: unknown) => void; unmount: () => void };
};

let seed = 20261113;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

/** A 1.5 kHz click on every beat over hiss and mains hum, with some beats left out. */
function clickTrack(bpm: number, seconds: number, sampleRate: number, dropped: number[]): Float32Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.15 * (random() * 2 - 1) + 0.05 * Math.sin((2 * Math.PI * 60 * i) / sampleRate);
  }
  for (let beat = 0; ; beat++) {
    const start = Math.round((0.21 + (beat * 60) / bpm) * sampleRate);
    if (start >= samples.length) break;
    if (dropped.includes(beat)) continue;
    for (let k = 0; k < 0.03 * sampleRate && start + k < samples.length; k++) {
      samples[start + k] += 0.6 * Math.sin((2 * Math.PI * 1500 * k) / sampleRate) * Math.exp(-k / (0.006 * sampleRate));
    }
  }
  return samples;
}

const ui: Ui = await import(pathToFileURL(bundle).href);
const DROPPED = [4, 13, 14, 25];

for (const sampleRate of [44_100, 48_000]) {
  for (const bpm of [68, 78, 101, 120, 149, 162]) {
    const detector = new ui.TempoDetector(sampleRate);
    const track = clickTrack(bpm, ui.LISTEN_SECONDS, sampleRate, DROPPED);
    for (let at = 0; at < track.length; at += 4096) detector.push(track.subarray(at, at + 4096));
    const found = detector.tempo();
    const choices = found == null ? [] : ui.tempoChoices(found);
    const hit = choices.find((choice) => Math.abs(choice.bpm - bpm) <= 1);
    check(!!hit, `${bpm} BPM clicks at ${sampleRate} Hz, 4 beats dropped: heard ${found?.toFixed(2)}, ${hit?.feel ?? "no choice"} ${hit?.bpm ?? ""}`);
  }
}

const hiss = new ui.TempoDetector(48_000);
hiss.push(clickTrack(120, ui.LISTEN_SECONDS, 48_000, Array.from({ length: 40 }, (_, beat) => beat)));
check(hiss.tempo() === null, "hiss and hum with no beat suggest nothing");
const short = new ui.TempoDetector(48_000);
short.push(clickTrack(120, 3, 48_000, []));
check(short.tempo() === null, "three seconds is too short to suggest anything");

const tapsAt = (intervals: number[], start = 1000) => intervals.reduce((taps, gap) => ui.addTap(taps, taps[taps.length - 1] + gap), [start]);
check(ui.tapBpm([1000]) === null, "one tap shows no BPM");
check(ui.tapBpm(tapsAt([500, 500, 500])) === 120, "taps 500 ms apart read 120 BPM");
check(Math.abs(ui.tapBpm(tapsAt([620, 580, 610, 590]))! - 100) < 0.01, "uneven taps averaging 600 ms read 100 BPM");
check(ui.addTap(tapsAt([500, 500]), 2000 + ui.TAP_RESET_MS + 1).length === 1, "a pause longer than the reset starts over");
check(ui.addTap(tapsAt([500, 500]), 2000 + ui.TAP_RESET_MS).length === 4, "a tap right at the reset still counts (30 BPM)");
check(Math.round(ui.tapBpm(tapsAt([1000, 1000, 1000, 400, 400, 400, 400, 400, 400, 400]))!) === 150, "only recent taps count when the tempo changes");
check(JSON.stringify(ui.tempoChoices(120.4).map((c) => c.bpm)) === "[60,120,241]", "120.4 offers 60, 120 and 241");
check(JSON.stringify(ui.tempoChoices(162).map((c) => c.feel)) === '["Half time","Suggested"]', "double time past 300 BPM is not offered");

const dom = fakeDom();
const tracks: { stopped: boolean; stop: () => void }[] = [];
let micAsks = 0;
let micAllowed = true;
let micAnswer: Promise<void> = Promise.resolve();
let micAudio: MediaTrackConstraints | undefined;
let now = 0;

class FakeAudioContext {
  static last: FakeAudioContext;
  sampleRate = 48_000;
  state = "suspended";
  destination = {};
  processor = { onaudioprocess: null as null | ((event: object) => void), connect() {} };
  constructor() {
    FakeAudioContext.last = this;
  }
  createScriptProcessor() {
    return this.processor;
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

Object.assign(globalThis, {
  window: { document: dom.document, HTMLIFrameElement: class {}, setTimeout, clearTimeout },
  document: dom.document,
  AudioContext: FakeAudioContext,
});
Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now } });
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: async (constraints: { audio: MediaTrackConstraints }) => {
        micAsks += 1;
        await micAnswer;
        if (!micAllowed) throw new DOMException("Permission denied", "NotAllowedError");
        micAudio = constraints.audio;
        const track = { stopped: false, stop: () => (track.stopped = true) };
        tracks.push(track);
        return { getTracks: () => [track] };
      },
    },
  },
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((done) => setImmediate(done));
};
const elements = () => dom.container.elements;
const button = (name: string) =>
  elements().find((el) => el.nodeName === "BUTTON" && (el.getAttribute("aria-label") ?? el.textContent) === name);
const tap = async (name: string) => {
  const target = button(name);
  if (!target) throw new Error(`no "${name}" button in: ${dom.container.textContent}`);
  dom.click(target);
  await settle();
};
const bpmInput = () => elements().find((el) => el.nodeName === "INPUT" && el.parentNode?.getAttribute("class") === "bpm-entry")!;
const status = () => elements().find((el) => el.getAttribute("role") === "status")?.textContent ?? "";
const latest = () => tracks[tracks.length - 1];

/** Plays audio into the open mic the way a ScriptProcessorNode hands it over: 4096 samples at a time. */
async function play(samples: Float32Array) {
  for (let at = 0; at < samples.length; at += 4096) {
    const chunk = samples.subarray(at, at + 4096);
    FakeAudioContext.last.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => chunk } });
  }
  await settle();
}

function submit(form: FakeElement) {
  const path: FakeElement[] = [];
  for (let node: FakeElement | null = form; node; node = node.parentNode) path.push(node);
  const event = { type: "submit", target: form, bubbles: true, cancelable: true, defaultPrevented: false, preventDefault() {}, stopPropagation() {} };
  for (const [nodes, capture] of [[[...path].reverse(), true], [path, false]] as const) {
    for (const node of nodes) node.listeners.filter((l) => l.type === "submit" && l.capture === capture).forEach((l) => l.run(event));
  }
}

const library = JSON.parse(readFileSync(new URL("../data/library.json", import.meta.url), "utf8")) as { songs: Song[] };
const song = library.songs.find((each) => each.tempo != null && each.tempo !== 120)!;
const saved: SongData[] = [];
let closed = 0;
let root = ui.createRoot(dom.container);
const mount = async () => {
  root.render(ui.createElement(ui.SongDataEditor, { song, original: song, onSave: (data: SongData) => saved.push(data), onClose: () => (closed += 1) }));
  await settle();
};
await mount();

await tap("Find BPM");
check(button("Find BPM")?.getAttribute("aria-expanded") === "true", "Find BPM opens the finder beside the BPM field");
check(micAsks === 0, "opening the finder does not ask for the mic");

await tap("Listen");
check(micAsks === 1, "tapping Listen asks for the mic");
check(micAudio?.noiseSuppression === false && micAudio.echoCancellation === false, "the mic opens without voice noise suppression or echo cancelling");
check(/Play the song nearby/.test(dom.container.textContent), "listening tells the player to play the song");
await play(clickTrack(120, ui.LISTEN_SECONDS / 2, 48_000, []));
const progress = elements().find((el) => el.nodeName === "PROGRESS");
check(Math.abs(Number(progress?.getAttribute("value") ?? progress?.value) - 0.5) < 0.05, `progress shows half way after half the audio (${progress?.getAttribute("value") ?? progress?.value})`);
check(!latest().stopped, "the mic stays open while listening");
await play(clickTrack(120, ui.LISTEN_SECONDS / 2 + 0.2, 48_000, [3, 9]));
check(latest().stopped, "the mic track stops as soon as listening finishes");
check(FakeAudioContext.last.state === "closed", "the audio context closes when listening finishes");
check(!!button("Use 120 BPM") && !!button("Use 60 BPM, half time") && !!button("Use 240 BPM, double time"), "120 BPM clicks suggest 120 with 60 and 240");
check(bpmInput().value === String(song.tempo) && saved.length === 0, "a suggestion changes nothing until it is picked");

await tap("Use 60 BPM, half time");
check(bpmInput().value === "60", "picking half time fills the BPM field with 60");
check(saved.length === 0 && closed === 0, "picking a choice does not save or close the editor");
check(button("Find BPM")?.getAttribute("aria-expanded") === "false", "picking a choice closes the finder");
submit(elements().find((el) => el.nodeName === "FORM")!);
check(saved.length === 1 && saved[0].tempo === 60, `Save stores the picked BPM through the editor (${JSON.stringify(saved[0])})`);

await tap("Find BPM");
await tap("Listen");
await play(clickTrack(120, 2, 48_000, []));
await tap("Cancel Find BPM");
check(latest().stopped && FakeAudioContext.last.state === "closed", "Cancel while listening stops the mic track");
check(button("Find BPM")?.getAttribute("aria-expanded") === "false" && bpmInput().value === "60", "Cancel closes the finder and leaves the field alone");

await tap("Find BPM");
await tap("Listen");
await play(clickTrack(120, 2, 48_000, []));
await tap("Find BPM");
check(latest().stopped, "closing the finder with Find BPM while listening stops the mic track");

await tap("Find BPM");
let answer = () => {};
micAnswer = new Promise((done) => (answer = done));
await tap("Listen");
const asked = tracks.length;
root.unmount();
answer();
await settle();
check(tracks.length === asked + 1 && latest().stopped, "closing the editor before the mic answers stops the track once it arrives");
root = ui.createRoot(dom.container);
await mount();

await tap("Find BPM");
await tap("Listen");
await play(new Float32Array(48_000 * (ui.LISTEN_SECONDS + 1)));
check(latest().stopped && /No steady beat/.test(status()), `silence ends with a short note (${status()})`);

micAllowed = false;
await tap("Listen");
check(/mic isn't available/i.test(status()), `a denied mic shows a short note (${status()})`);
check(!!button("Tap tempo"), "tap tempo stays usable after the mic is denied");

await tap("Tap tempo");
check(button("Tap the beat")?.textContent === "Tap along", "tap tempo waits for taps");
for (const at of [0, 400, 800, 1200]) {
  now = at;
  await tap("Tap the beat");
}
check(button("Tap the beat")?.textContent === "150 BPM", `taps 400 ms apart show 150 BPM (${button("Tap the beat")?.textContent})`);
check(!!button("Use 150 BPM") && !!button("Use 75 BPM, half time") && !!button("Use 300 BPM, double time"), "tapped tempo offers 75, 150 and 300");
now = 1200 + ui.TAP_RESET_MS + 500;
await tap("Tap the beat");
check(button("Tap the beat")?.textContent === "Tap along", "a pause in tapping starts over");
for (let i = 0; i < 3; i++) {
  now += 500;
  await tap("Tap the beat");
}
await tap("Use 120 BPM");
check(bpmInput().value === "120" && saved.length === 1, "picking a tapped tempo fills the field without saving");
check(micAsks === 6, `the mic was only asked for on each Listen (${micAsks})`);

root.unmount();
if (failures) {
  console.error(`${failures} BPM check(s) failed`);
  process.exit(1);
}
console.log("BPM finder checks passed");
