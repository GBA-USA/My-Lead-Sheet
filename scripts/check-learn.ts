import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { fakeDom, type FakeElement } from "./fake-dom.ts";
import { FakeWorker, clearWorkerLog, listenThrough, workerIdle, workerLog, workerReplies } from "./fake-worker.ts";
import { FORM, HEAD as BLUES_HEAD, blues } from "./blues.ts";
import type { FromWorker, Listen, ToWorker } from "../src/learn-result.ts";
import type { Song, SongData } from "../src/types.ts";

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
}

const entry = `
  export * from "./src/learn-analyze.ts";
  export * from "./src/learn-result.ts";
  export { heardBars } from "./src/learn-chords.ts";
  export * from "./src/scroll-timing.ts";
  export { loadScrollVersions, saveScrollVersions } from "./src/storage.ts";
  export { LearnSong } from "./src/learn-song.tsx";
  export { CUE_BARS, LearnedCues, countIn, cueAt } from "./src/cues.tsx";
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
const bundle = join(mkdtempSync(join(tmpdir(), "check-learn-")), "learn.mjs");
writeFileSync(bundle, bundled.outputFiles[0].text);
type Learn = typeof import("../src/learn-analyze.ts") &
  typeof import("../src/learn-result.ts") &
  Pick<typeof import("../src/learn-chords.ts"), "heardBars"> &
  typeof import("../src/scroll-timing.ts") &
  typeof import("../src/cues.tsx") &
  Pick<typeof import("../src/storage.ts"), "loadScrollVersions" | "saveScrollVersions"> & {
    LearnSong: unknown;
    createElement: (type: unknown, props?: object) => unknown;
    createRoot: (container: unknown) => { render: (element: unknown) => void; unmount: () => void };
  };
const learn: Learn = await import(pathToFileURL(bundle).href);

const SAMPLE_RATE = 48_000;
let seed = 20261113;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

interface Part {
  heading: string;
  bpm: number;
  bars: number;
  kick: number;
  bass: number;
  snare: number;
  hats: number;
  voice: number;
}

const BARS = 36;

/**
 * Three sections over a room's hiss: a quiet intro of kick and bass, a verse that adds a band-limited voice,
 * and a loud, bright chorus with snare and hats that drops from 122 to 104 BPM.
 */
const PARTS: Part[] = [
  { heading: "INTRO", bpm: 122, bars: BARS, kick: 0.25, bass: 0.08, snare: 0, hats: 0, voice: 0 },
  { heading: "VERSE 1", bpm: 122, bars: BARS, kick: 0.3, bass: 0.1, snare: 0, hats: 0, voice: 0.12 },
  { heading: "RIFF / CHORUS 1 (tempo drops to ~104 — chug it)", bpm: 104, bars: BARS, kick: 0.5, bass: 0.18, snare: 0.3, hats: 0.12, voice: 0 },
];
const HEAD = 3;
const TAIL = 3;

function synthesizeSong(rate = SAMPLE_RATE) {
  const beats: number[] = [];
  const starts: number[] = [];
  let at = HEAD;
  for (const part of PARTS) {
    starts.push(at);
    for (let beat = 0; beat < part.bars * 4; beat++, at += 60 / part.bpm) beats.push(at);
  }
  const end = at;
  const samples = new Float32Array(Math.round((end + TAIL) * rate));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.003 * (random() * 2 - 1);
  const add = (from: number, seconds: number, voice: (t: number) => number) => {
    const first = Math.round(from * rate);
    const last = Math.min(Math.round(end * rate), first + Math.round(seconds * rate));
    for (let i = first; i < last; i++) samples[i] += voice((i - first) / rate);
  };
  let previous = 0;
  beats.forEach((beat, index) => {
    const part = PARTS[starts.findLastIndex((start) => start <= beat + 1e-9)];
    const length = (beats[index + 1] ?? end) - beat;
    const inBar = index % 4;
    add(beat, 0.4, (t) => part.kick * Math.sin(2 * Math.PI * (50 * t + 0.9 * (1 - Math.exp(-t / 0.013)))) * Math.exp(-t / 0.12));
    add(beat, length, (t) => part.bass * Math.sin(2 * Math.PI * 55 * t) * Math.min(1, t / 0.01));
    if (part.snare && inBar % 2 === 1) add(beat, 0.25, (t) => part.snare * ((random() * 2 - 1) * 0.8 + 0.4 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t / 0.07));
    for (const half of part.hats ? [0, length / 2] : []) {
      add(beat + half, 0.08, (t) => {
        const noise = random() * 2 - 1;
        const hiss = noise - previous;
        previous = noise;
        return part.hats * hiss * Math.exp(-t / 0.02);
      });
    }
    if (part.voice) {
      add(beat, length, (t) => {
        const time = beat - starts[1] + t;
        const cycles = 196 * (time + (0.02 * (1 - Math.cos(2 * Math.PI * 5 * time))) / (2 * Math.PI * 5));
        let sum = 0;
        for (let k = 2; k <= 13; k++) sum += Math.sin(2 * Math.PI * k * cycles) / k;
        return part.voice * sum;
      });
    }
  });
  return { samples, beats, starts, end, voice: { start: starts[1], end: starts[2] } };
}

const truth = synthesizeSong();
const wav = process.argv.indexOf("--wav");
if (wav > 0) {
  const data = Buffer.alloc(44 + truth.samples.length * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + truth.samples.length * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(SAMPLE_RATE, 24);
  data.writeUInt32LE(SAMPLE_RATE * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(truth.samples.length * 2, 40);
  truth.samples.forEach((sample, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + i * 2));
  writeFileSync(process.argv[wav + 1], data);
  console.log(`wrote ${process.argv[wav + 1]} (${(truth.samples.length / SAMPLE_RATE).toFixed(1)} s)`);
}

const listener = new learn.SongListener(SAMPLE_RATE);
const began = Date.now();
for (let at = 0; at < truth.samples.length; at += 4096) listener.push(truth.samples.subarray(at, at + 4096));
const headings = PARTS.map((part) => part.heading);
const heardSong = listener.analyze(4);
const baselineMs = Date.now() - began;
console.log(`analyzed ${(truth.samples.length / SAMPLE_RATE).toFixed(1)} s of audio in ${baselineMs} ms`);
if (!heardSong) {
  check(false, "the synthesized song is heard");
  process.exit(1);
}
const { analysis } = heardSong;

const heard = analysis.sound.end - analysis.sound.start;
check(Math.abs(analysis.sound.start - HEAD) <= 0.5, `the song starts at the first note after ${HEAD} s of room noise (${analysis.sound.start.toFixed(2)} s)`);
check(Math.abs(heard - (truth.end - HEAD)) <= 0.5, `the real length is first note to last note (${heard.toFixed(2)} s, want ${(truth.end - HEAD).toFixed(2)} s)`);

const nearest = (times: number[], time: number) => Math.min(...times.map((each) => Math.abs(each - time)));
const worst = Math.max(...truth.beats.map((beat) => nearest(analysis.beats, beat)));
check(Math.abs(analysis.beats.length - truth.beats.length) <= 1, `the beat map has every beat (${analysis.beats.length}, want ${truth.beats.length})`);
check(worst <= 0.03, `every beat is on time within 30 ms (worst ${(worst * 1000).toFixed(1)} ms)`);
const tempos = analysis.tempos.map((tempo) => `${tempo.bpm.toFixed(2)} BPM at ${tempo.at.toFixed(2)} s`).join(", ");
check(analysis.tempos.length === 2, `one tempo change is found (${tempos})`);
check(Math.abs(analysis.tempos[0]?.bpm - 122) <= 1 && Math.abs(analysis.tempos[1]?.bpm - 104) <= 1, `the tempos read 122 then 104 BPM (${tempos})`);
check(Math.abs((analysis.tempos[1]?.at ?? 0) - truth.starts[2]) <= 60 / 104, `the change lands on the riff within a beat (${analysis.tempos[1]?.at.toFixed(2)} s, want ${truth.starts[2].toFixed(2)} s)`);

/** What the listener hears in a kick on each beat over room hiss, each beat up to `jitter` of a beat early or late. */
function temposHeard(bars: number, bpmAt: (beat: number) => number, jitter = 0.01, rate = SAMPLE_RATE) {
  const beats: number[] = [];
  for (let k = 0, at = HEAD; k < 4 * bars; at += 60 / bpmAt(k), k++) beats.push(at + (jitter * (random() * 2 - 1) * 60) / bpmAt(k));
  const samples = new Float32Array(Math.round((beats[beats.length - 1] + 0.5 + TAIL) * rate));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.003 * (random() * 2 - 1);
  for (const beat of beats) {
    const first = Math.round(beat * rate);
    for (let i = 0; i < 0.3 * rate; i++) {
      const t = i / rate;
      samples[first + i] += 0.3 * Math.sin(2 * Math.PI * (50 * t + 0.9 * (1 - Math.exp(-t / 0.013)))) * Math.exp(-t / 0.12);
    }
  }
  const ear = new learn.SongListener(rate);
  for (let at = 0; at < samples.length; at += 4096) ear.push(samples.subarray(at, at + 4096));
  const heard = ear.analyze(4);
  const tempos = heard?.analysis.tempos ?? [];
  return {
    heard,
    tempos,
    average: (60 * (beats.length - 1)) / (beats[beats.length - 1] - beats[0]),
    text: tempos.map((tempo) => `${tempo.bpm.toFixed(2)} BPM at ${tempo.at.toFixed(2)} s`).join(", ") || "nothing heard",
  };
}
const studio = temposHeard(64, () => 112, 0.02);
check(studio.tempos.length === 1 && Math.abs(studio.tempos[0].bpm - 112) <= 1, `a steady 112 BPM take with ±2% timing reads as one tempo within 1 BPM (${studio.text})`);
for (const to of [104, 108]) {
  const drift = temposHeard(96, (beat) => 100 + ((to - 100) * beat) / (96 * 4));
  check(
    drift.tempos.length === 1 && Math.abs(drift.tempos[0].bpm - drift.average) <= 1,
    `a live band drifting from 100 to ${to} BPM reads as one tempo, the song's average ${drift.average.toFixed(2)} BPM within 1 BPM (${drift.text})`,
  );
}
for (const { bars, by } of [{ bars: 2, by: 1.08 }, { bars: 2, by: 0.92 }, { bars: 3, by: 1.15 }]) {
  const pushed = temposHeard(64, (beat) => (beat >= 128 && beat < 128 + 4 * bars ? 112 * by : 112));
  const push = `${by > 1 ? "push" : "pull"} to ${by > 1 ? "+" : "−"}${Math.round(Math.abs(by - 1) * 100)}%`;
  check(pushed.tempos.length === 1 && Math.abs(pushed.tempos[0].bpm - 112) <= 1, `a ${bars}-bar ${push} at bar 33 of a 112 BPM take is not a tempo change (${pushed.text})`);
}

const boundaries = learn.placeHeadings(analysis, headings.length, 4) ?? [];
const boundaryTimes = boundaries.map((beat) => analysis.beats[beat]);
check(boundaries.length === 2, `two boundaries for three headings (${boundaries.length})`);
boundaryTimes.forEach((time, i) => {
  const want = truth.starts[i + 1];
  check(Math.abs(time - want) <= 60 / PARTS[i + 1].bpm + 0.01, `${learn.shortHeading(headings[i + 1])} starts within a beat of ${want.toFixed(2)} s (${time.toFixed(2)} s)`);
});

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const voiced = analysis.vocals.reduce((sum, span) => sum + overlap(span, truth.voice), 0);
const suggested = analysis.vocals.reduce((sum, span) => sum + span.end - span.start, 0);
const union = suggested + (truth.voice.end - truth.voice.start) - voiced;
const spans = analysis.vocals.map((span) => `${span.start.toFixed(2)}-${span.end.toFixed(2)} s`).join(", ");
check(voiced / union >= 0.8, `the suggested vocal region overlaps the voice by ${Math.round((100 * voiced) / union)}% (${spans}, voice ${truth.voice.start.toFixed(2)}-${truth.voice.end.toFixed(2)} s)`);


let now = 0;
let timers: { at: number; id: number; run: () => void }[] = [];
let nextId = 1;
const frames = new Map<number, (time: number) => void>();
const clicks: number[] = [];
const tracks: FakeTrack[] = [];
let micAsks = 0;
let micAllowed = true;
const node = { connect() {}, disconnect() {} };
const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };

type Handler = (event: object) => void;
/** An EventTarget's two ways to listen: addEventListener, and the on<type> property. */
class Emitter {
  private readonly handlers: { type: string; run: Handler }[] = [];
  addEventListener(type: string, run: Handler) {
    this.handlers.push({ type, run });
  }
  removeEventListener(type: string, run: Handler) {
    const at = this.handlers.findIndex((each) => each.type === type && each.run === run);
    if (at >= 0) this.handlers.splice(at, 1);
  }
  emit(type: string) {
    const event = { type, target: this, currentTarget: this };
    (this as unknown as Record<string, Handler | null | undefined>)[`on${type}`]?.call(this, event);
    for (const each of this.handlers.filter((handler) => handler.type === type)) each.run.call(this, event);
  }
}

class FakeTrack extends Emitter {
  kind = "audio";
  readyState = "live";
  muted = false;
  enabled = true;
  stopped = false;
  onended: Handler | null = null;
  onmute: Handler | null = null;
  onunmute: Handler | null = null;
  stop() {
    this.stopped = true;
    this.readyState = "ended";
  }
  getSettings() {
    return { sampleRate: SAMPLE_RATE, channelCount: 1 };
  }
}

class FakeAudioContext extends Emitter {
  static last: FakeAudioContext;
  static made = 0;
  sampleRate = SAMPLE_RATE;
  state = "suspended";
  /** Set when a check suspends the audio the way iOS does on an app switch: resume() no longer wakes it. */
  stuck = false;
  onstatechange: Handler | null = null;
  destination = {};
  processor = { ...node, onaudioprocess: null as null | ((event: object) => void) };
  constructor() {
    super();
    FakeAudioContext.last = this;
    FakeAudioContext.made += 1;
  }
  setState(state: string) {
    if (this.state === state) return;
    this.state = state;
    this.emit("statechange");
  }
  get currentTime() {
    return now;
  }
  createScriptProcessor() {
    return this.processor;
  }
  createMediaStreamSource() {
    return node;
  }
  createOscillator() {
    return { ...node, frequency: param, start: (time: number) => clicks.push(time), stop() {} };
  }
  createGain() {
    return { ...node, gain: param };
  }
  resume() {
    if (!this.stuck && this.state !== "closed") this.setState("running");
    return Promise.resolve();
  }
  suspend() {
    this.setState("suspended");
    return Promise.resolve();
  }
  close() {
    this.setState("closed");
    return Promise.resolve();
  }
}

const dom = fakeDom();
const sectionTops = [100, 400, 750];
const chartSections = sectionTops.map((top) => Object.assign(dom.document.createElement("section"), { getBoundingClientRect: () => ({ top }) }));
const chart = { getBoundingClientRect: () => ({ top: 100, height: 1000 }), querySelectorAll: () => chartSections };
const store = new Map<string, string>();
Object.assign(dom.document, {
  getElementById: (id: string) => (id === "chord-section" ? chart : null),
  querySelectorAll: (selector: string) => (selector === "#chord-section .chart-section" ? chartSections : []),
});
const fakeWindow = Object.assign(new Emitter(), {
  document: dom.document,
  HTMLIFrameElement: class {},
  AudioContext: FakeAudioContext,
  setTimeout: (run: () => void, ms: number) => {
    timers.push({ at: now + ms / 1000, id: nextId, run });
    return nextId++;
  },
  clearTimeout: (id: number) => (timers = timers.filter((timer) => timer.id !== id)),
});
Object.assign(globalThis, {
  window: fakeWindow,
  document: dom.document,
  AudioContext: FakeAudioContext,
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
  requestAnimationFrame: (run: (time: number) => void) => {
    frames.set(nextId, run);
    return nextId++;
  },
  cancelAnimationFrame: (id: number) => frames.delete(id),
});
Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now * 1000 } });
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: async () => {
        micAsks += 1;
        if (!micAllowed) throw new DOMException("Permission denied", "NotAllowedError");
        const track = new FakeTrack();
        tracks.push(track);
        return { active: true, getTracks: () => [track], getAudioTracks: () => [track] };
      },
    },
  },
});

// The browser pieces a listen reaches for: files, media metadata, decoding, workers and the wake lock.
/** What a fake audio file holds: its length, and the song a decoder finds in it, or none it can read. */
interface FakeAudio {
  seconds: number;
  channels: number;
  song?: (rate: number) => Float32Array;
}
const fakeAudio = new Map<string, FakeAudio>();
function audioFile(name: string, audio: FakeAudio): File {
  const id = `fake-audio-${fakeAudio.size + 1}`;
  fakeAudio.set(id, audio);
  return new File([id], name, { type: name.endsWith(".wav") ? "audio/wav" : "audio/mp4" });
}
const audioIn = (bytes: ArrayBuffer) => (bytes.byteLength ? fakeAudio.get(new TextDecoder().decode(bytes)) : undefined);

const objectUrls = new Map<string, Blob>();
const makeObjectUrl = URL.createObjectURL.bind(URL);
Object.assign(URL, {
  createObjectURL: (blob: Blob) => {
    const url = makeObjectUrl(blob);
    objectUrls.set(url, blob);
    return url;
  },
  revokeObjectURL: (url: string) => void objectUrls.delete(url),
});

/** Runs the listeners on `el` itself, for events that do not bubble, then its on<type> property. */
function fireOn(el: FakeElement, type: string) {
  const event = { type, target: el, currentTarget: el, bubbles: false, preventDefault() {}, stopPropagation() {} };
  for (const listener of el.listeners.filter((each) => each.type === type)) listener.run(event);
  (el as unknown as Record<string, Handler | null | undefined>)[`on${type}`]?.call(el, event);
}

/** A browser's dispatch: capture listeners down to `target`, bubble listeners back up, then the window. */
function fire(target: FakeElement, type: string) {
  const path: FakeElement[] = [];
  for (let at: FakeElement | null = target; at; at = at.parentNode) path.push(at);
  let stopped = false;
  const event = {
    type,
    target,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    detail: 0,
    timeStamp: now * 1000,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  };
  for (const [nodes, capture] of [[[...path].reverse(), true], [path, false]] as const) {
    for (const each of nodes) {
      for (const listener of each.listeners.filter((one) => one.type === type && one.capture === capture)) listener.run(event);
      if (!capture) (each as unknown as Record<string, Handler | null | undefined>)[`on${type}`]?.call(each, event);
      if (stopped) return;
    }
  }
  if (path[path.length - 1] === (dom.document as unknown as FakeElement)) fakeWindow.emit(type);
}

/** An <audio> or <video> element that reads a fake file's length from its object URL, or fails on one it can't read. */
function makeMedia(el: FakeElement) {
  const media = el as unknown as Record<string, unknown>;
  let src = "";
  const load = () => {
    const blob = objectUrls.get(src);
    if (!src) return;
    void (blob ? blob.arrayBuffer() : Promise.resolve(new ArrayBuffer(0))).then((bytes) => {
      const audio = audioIn(bytes);
      if (!audio?.song) {
        media.error = { code: 4, message: "MEDIA_ERR_SRC_NOT_SUPPORTED" };
        fireOn(el, "error");
        return;
      }
      Object.assign(media, { duration: audio.seconds, readyState: 1 });
      for (const type of ["durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough"]) fireOn(el, type);
    });
  };
  Object.defineProperty(el, "src", {
    configurable: true,
    get: () => src,
    set: (value: string) => {
      src = String(value ?? "");
      load();
    },
  });
  Object.assign(media, { duration: Number.NaN, readyState: 0, error: null, preload: "auto", paused: true, currentTime: 0, load, play: () => Promise.resolve(), pause() {}, canPlayType: () => "maybe" });
  const setAttribute = el.setAttribute.bind(el);
  el.setAttribute = (name: string, value: unknown) => {
    setAttribute(name, value);
    if (name === "src") media.src = String(value);
  };
  const removeAttribute = el.removeAttribute.bind(el);
  el.removeAttribute = (name: string) => {
    removeAttribute(name);
    if (name === "src") src = "";
  };
}
const createElement = dom.document.createElement.bind(dom.document);
dom.document.createElement = (name: string) => {
  const el = createElement(name);
  if (/^(audio|video)$/i.test(name)) makeMedia(el);
  return el;
};
function FakeAudioElement(src?: string) {
  const el = dom.document.createElement("audio") as unknown as Record<string, unknown>;
  if (src) el.src = src;
  return el;
}
Object.defineProperty(dom.document, "hidden", { configurable: true, get: () => dom.document.visibilityState !== "visible" });

class FakeAudioBuffer {
  private readonly data: Float32Array[];
  readonly sampleRate: number;
  constructor(data: Float32Array[], sampleRate: number) {
    this.data = data;
    this.sampleRate = sampleRate;
  }
  get numberOfChannels() {
    return this.data.length;
  }
  get length() {
    return this.data[0].length;
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(channel: number) {
    return this.data[channel];
  }
  copyFromChannel(destination: Float32Array, channel: number, offset = 0) {
    destination.set(this.data[channel].subarray(offset, offset + destination.length));
  }
}
const offline = { made: [] as { channels: number; length: number; sampleRate: number }[], decodes: 0 };
/** Decodes a fake file to the context's rate with the file's own channels, as a browser does, and renders mixes. */
class FakeOfflineAudioContext {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly destination: { channelCount: number };
  private readonly sources: { buffer: FakeAudioBuffer | null }[] = [];
  constructor(channels: number | { numberOfChannels?: number; length: number; sampleRate: number }, length?: number, sampleRate?: number) {
    const options = typeof channels === "object" ? channels : { numberOfChannels: channels, length: length ?? 0, sampleRate: sampleRate ?? 0 };
    this.numberOfChannels = options.numberOfChannels ?? 1;
    this.length = options.length;
    this.sampleRate = options.sampleRate;
    this.destination = { channelCount: this.numberOfChannels };
    offline.made.push({ channels: this.numberOfChannels, length: this.length, sampleRate: this.sampleRate });
  }
  decodeAudioData(bytes: ArrayBuffer, done?: (buffer: FakeAudioBuffer) => void, failed?: (error: unknown) => void): Promise<FakeAudioBuffer> {
    offline.decodes += 1;
    const audio = audioIn(bytes);
    if (bytes.byteLength) structuredClone(bytes, { transfer: [bytes] });
    const decoded = audio?.song
      ? Promise.resolve(audio.song(this.sampleRate)).then((song) => new FakeAudioBuffer(Array.from({ length: audio.channels }, (_, channel) => (channel ? song.slice() : song)), this.sampleRate))
      : Promise.reject(new DOMException("Unable to decode audio data", "EncodingError"));
    decoded.then(done, failed ?? (() => {}));
    return decoded;
  }
  createBuffer(channels: number, length: number, rate: number) {
    return new FakeAudioBuffer(Array.from({ length: channels }, () => new Float32Array(length)), rate);
  }
  createBufferSource() {
    const source = { buffer: null as FakeAudioBuffer | null, connect() {}, disconnect() {}, start() {}, stop() {} };
    this.sources.push(source);
    return source;
  }
  startRendering(): Promise<FakeAudioBuffer> {
    const out = Array.from({ length: this.numberOfChannels }, () => new Float32Array(this.length));
    for (const { buffer } of this.sources) {
      if (!buffer) continue;
      if (buffer.sampleRate !== this.sampleRate) return Promise.reject(new Error("the fake renders only buffers at its own rate"));
      out.forEach((channel, c) => {
        for (let i = 0; i < Math.min(channel.length, buffer.length); i++) {
          let sum = 0;
          if (out.length === 1) for (let k = 0; k < buffer.numberOfChannels; k++) sum += buffer.getChannelData(k)[i] / buffer.numberOfChannels;
          else sum = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1))[i];
          channel[i] += sum;
        }
      });
    }
    return Promise.resolve(new FakeAudioBuffer(out, this.sampleRate));
  }
}
class FakeFileReader extends Emitter {
  result: ArrayBuffer | null = null;
  error: unknown = null;
  readyState = 0;
  onload: Handler | null = null;
  onerror: Handler | null = null;
  onloadend: Handler | null = null;
  readAsArrayBuffer(blob: Blob) {
    void blob.arrayBuffer().then((bytes) => {
      Object.assign(this, { result: bytes, readyState: 2 });
      this.emit("load");
      this.emit("loadend");
    });
  }
}

let clicking = false;
const wakeLocks: { duringClick: boolean; released: boolean }[] = [];
const wakeLock = {
  request: async (type = "screen") => {
    const lock = Object.assign(new Emitter(), {
      type,
      duringClick: clicking,
      released: false,
      onrelease: null,
      release: async () => {
        if (lock.released) return;
        lock.released = true;
        lock.emit("release");
      },
    });
    wakeLocks.push(lock);
    return lock;
  },
};
const ears = { Worker: FakeWorker, OfflineAudioContext: FakeOfflineAudioContext, webkitOfflineAudioContext: FakeOfflineAudioContext, Audio: FakeAudioElement, FileReader: FakeFileReader };
Object.assign(fakeWindow, ears);
Object.assign(globalThis, ears, { addEventListener: fakeWindow.addEventListener.bind(fakeWindow), removeEventListener: fakeWindow.removeEventListener.bind(fakeWindow) });
Object.assign(navigator, { wakeLock });

const songClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const length = songClock(Math.round(truth.end - HEAD));
const verse = songClock(truth.starts[1] - HEAD);
const chorus = songClock(truth.starts[2] - HEAD);
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((done) => setImmediate(done));
};
/** One 60 fps frame: due timers first, then every animation frame callback in the order it was asked for. */
function frame() {
  now += 1 / 60;
  for (const timer of timers.filter((each) => each.at <= now).sort((a, b) => a.at - b.at)) {
    timers = timers.filter((each) => each !== timer);
    timer.run();
  }
  const due = [...frames.entries()];
  frames.clear();
  for (const [, run] of due) run(now * 1000);
}
const elements = () => dom.document.body.elements;
const text = () => dom.document.body.textContent;
const button = (name: string) =>
  elements().find((el) => el.nodeName === "BUTTON" && (el.getAttribute("aria-label") ?? el.textContent) === name);
const checkbox = (label: string) =>
  elements().find((el) => el.nodeName === "LABEL" && el.textContent.includes(label))?.elements.find((el) => el.nodeName === "INPUT");
/** A tap, then time for anything it sent the analysis worker to come back. */
const tap = async (target: FakeElement | undefined, name: string) => {
  if (!target) throw new Error(`no "${name}" in: ${text()}`);
  dom.click(target);
  await settle();
  await workerIdle();
  await settle();
};
/** How the sheet names its two ways in, on a button's aria-label or else its text. */
const MIC_WORD = /\b(mic|microphone)\b/i;
const FILE_WORD = /\bfiles?\b/i;
const latest = () => tracks[tracks.length - 1];
/** Plays audio into the open mic 4096 samples at a time, each in a buffer of its own, with the worker keeping up. */
async function play(samples: Float32Array) {
  for (let at = 0; at < samples.length; at += 4096) {
    const chunk = samples.slice(at, at + 4096);
    FakeAudioContext.last.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => chunk } });
    await workerIdle();
  }
  await settle();
}

const song = {
  id: 5,
  title: "Take Me Out",
  timeSignature: "4/4",
  tempo: null,
  officialRuntimeSec: 237,
  body: PARTS.map((part) => ({ heading: part.heading, lines: [] })),
} as unknown as Song;
const saves: { version: Omit<import("../src/scroll-timing.ts").ScrollVersion, "name">; data: SongData | null }[] = [];
let root = learn.createRoot(dom.container);
let opened = 0;
const close = () => root.render(null);
/**
 * Opens the sheet the way the app does when Learn by listen is picked, and closes it on Save or Cancel. When the sheet
 * offers the mic as a choice instead of listening at once, it taps that choice.
 */
const learnSong = async () => {
  root.render(
    learn.createElement(learn.LearnSong, {
      key: (opened += 1),
      song,
      original: song,
      metronomeBpm: null,
      onSave: (version: never, data: SongData | null) => (saves.push({ version, data }), close()),
      onClose: close,
    }),
  );
  await settle();
  const micChoice = button("Stop") ? undefined : elements().find((el) => el.nodeName === "BUTTON" && MIC_WORD.test(el.getAttribute("aria-label") ?? el.textContent));
  if (micChoice) await tap(micChoice, "the mic choice");
};

check(micAsks === 0, "nothing asks for the mic before the Learn sheet opens");
await learnSong();
check(micAsks === 1, "opening the Learn sheet asks for the mic");
check(text().includes("Play the whole song near the phone"), "listening asks for the whole song");
await play(truth.samples.subarray(0, 20 * SAMPLE_RATE));
const progress = () => elements().find((el) => el.nodeName === "PROGRESS");
check(Math.abs(Number(progress()?.getAttribute("value") ?? progress()?.value) - 20 / 237) < 0.01 && text().includes("0:20"), `progress shows 0:20 of the song's 3:57 (${progress()?.getAttribute("value") ?? progress()?.value})`);
check(!latest().stopped, "the mic stays open while the song plays");
await play(truth.samples.subarray(20 * SAMPLE_RATE));
await tap(button("Stop"), "Stop");
check(latest().stopped && FakeAudioContext.last.state === "closed", "Stop stops the mic track and closes the audio");
const summary = `${length} · 122 BPM, 104 BPM at ${chorus}`;
check(text().includes(summary), `the review shows the length and both tempos (${summary})`);
check(text().includes(`${verse} · bar ${BARS + 1}`) && text().includes(`${chorus} · bar ${2 * BARS + 1}`), `each heading after the first starts on its learned bar (verse ${verse}, riff ${chorus})`);
check(text().includes("Suggested vocals") && !!checkbox(`${verse}–`), `the vocal region is offered as a suggestion (${elements().find((el) => el.nodeName === "FIELDSET")?.textContent})`);
check(saves.length === 0 && store.size === 0, "nothing is saved before the player confirms");

await tap(button("VERSE 1 later"), "VERSE 1 later");
check(text().includes(`bar ${BARS + 1}, beat 2`), "Later moves the verse a beat later");
await tap(button("VERSE 1 earlier"), "VERSE 1 earlier");
await tap(button("VERSE 1 earlier"), "VERSE 1 earlier");
check(text().includes(`bar ${BARS}, beat 4`), "Earlier moves it a beat earlier");
await tap(button("VERSE 1 later"), "VERSE 1 later");
await tap(checkbox(`Use ${length} and 122 BPM`), "Use for song");
await tap(button("Save"), "Save");
check(saves.length === 1 && JSON.stringify(saves[0].data) === JSON.stringify({ officialRuntimeSec: Math.round(truth.end - HEAD), tempo: 122 }), `accepting sends ${length} and 122 BPM through the song data path (${JSON.stringify(saves[0]?.data)})`);
check(!text().includes("Suggested vocals"), "Save closes the sheet");

await learnSong();
await play(truth.samples);
await tap(button("Stop"), "Stop");
await tap(checkbox(`${verse}–`), "vocal suggestion");
await tap(button("Save"), "Save");
check(saves[1]?.data === null, "without accepting, the song's length and BPM are left alone");
check(saves[1]?.version.learned?.vocals.length === 0 && saves[0].version.learned?.vocals.length === 1, "a cleared vocal suggestion is not saved, a kept one is");

await learnSong();
await play(truth.samples.subarray(0, 2 * SAMPLE_RATE));
await tap(button("Cancel"), "Cancel");
check(latest().stopped && FakeAudioContext.last.state === "closed" && saves.length === 2, "Cancel stops the mic track and saves nothing");
await learnSong();
root.unmount();
await settle();
check(latest().stopped, "leaving the song while listening stops the mic track");
root = learn.createRoot(dom.container);
micAllowed = false;
await learnSong();
check(text().includes("The mic isn't available."), "a denied mic says so");
check(micAsks === 5, `the mic was asked for once each time the sheet opened (${micAsks})`);
root.unmount();

const learnedPlan = saves[0].version;
const learned = learnedPlan.learned!;
const bpm = learnedPlan.bpm;
const version = { name: learn.nextVersionName([]), ...learnedPlan };
learn.saveScrollVersions("local/5", { versions: [version], selected: 0 });
const loaded = learn.loadScrollVersions("local/5");
check(version.name === "V1" && learn.nextVersionName(loaded.versions) === "V2", "the learned version takes the next free V-name");
check(JSON.stringify(loaded.versions[0]) === JSON.stringify(version) && loaded.selected === 0, "it saves and reloads as a normal timing version, learned data intact");
store.set("leadSheetsScrollVersions.6", JSON.stringify({ versions: [{ ...version, learned: { ...learned, beats: "x" } }], selected: 0 }));
check(learn.loadScrollVersions("local/6").versions.length === 0, "a broken learned version is dropped instead of breaking the song");
const beat = 60 / analysis.tempos[0].bpm;
check(Math.abs(learned.downbeat - 4 * beat) < 0.002 && learnedPlan.marks[0].at === 0, `the clock opens with one bar of count-in before bar 1 (${learned.downbeat.toFixed(3)} s)`);
const songEnd = learnedPlan.marks[learnedPlan.marks.length - 1];
check(learnedPlan.marks.length === 2 && songEnd.progress === 1 && songEnd.at > learned.sections[2].at, `the saved marks keep only the song's end, at ${songEnd.at.toFixed(2)} s, so no layout is frozen into the version`);
check(bpm === 122, `the version's BPM is the accepted song BPM (${bpm})`);

class Sheet {
  scrollHeight = 5000;
  clientHeight = 800;
  scrollTop = 0;
  addEventListener() {}
  removeEventListener() {}
}
/** The chart from 1000 px to 2000 px of the page, with its headings at 1000, 1300 and 1650 px. */
const HEADINGS = [1000, 1300, 1650];
const RANGE = { start: 1000, end: 2000 - 800, lines: () => [...HEADINGS, 2000].map((top) => top - learn.READING_LINE) };

/** Plays the version the way the app does: the cues mount first, then runScroll drives the sheet at the metronome's BPM. */
async function perform(metronomeBpm: number) {
  clicks.length = 0;
  const motion = learn.scrollMotion(song, version, null, metronomeBpm, 100);
  if (motion.kind !== "learned") throw new Error("a learned version plays by its headings");
  const sheet = new Sheet();
  const clock = { current: 0 };
  let ended = false;
  const cueRoot = learn.createRoot(dom.container);
  cueRoot.render(learn.createElement(learn.LearnedCues, { learned, clock, rate: motion.rate, metronomeOn: false }));
  await settle();
  const cancel = learn.runScroll(sheet, { current: motion }, () => RANGE, clock, () => (ended = true));
  const started = now;
  const seen: { wall: number; clock: number; cue: string; lit: number; progress: number; top: number }[] = [];
  while (!ended) {
    frame();
    await settle();
    seen.push({
      wall: now - started,
      clock: clock.current,
      cue: elements().find((el) => el.getAttribute("role") === "status")?.textContent ?? "",
      lit: chartSections.findIndex((section) => section.hasAttribute("data-next")),
      progress: (sheet.scrollTop - RANGE.start) / (RANGE.end - RANGE.start),
      top: sheet.scrollTop,
    });
  }
  cancel();
  cueRoot.unmount();
  return { seen, clicks: clicks.map((time) => time - started), rate: motion.rate };
}

const at = (clock: number) => learned.beats.reduce((best, each) => (Math.abs(each - clock) < Math.abs(best - clock) ? each : best));
const real = await perform(bpm);
const downbeatWall = real.seen.find((each) => each.clock >= learned.downbeat)!.wall;
const spacing = real.clicks.slice(1).map((time, i) => time - real.clicks[i]);
check(real.clicks.length === 4, `the metronome counts in one bar of 4 and stops (${real.clicks.length} clicks)`);
check(spacing.every((gap) => Math.abs(gap - 60 / 122) < 0.002), `count-in clicks are a beat of the opening tempo apart (${spacing.map((gap) => gap.toFixed(3)).join(", ")} s)`);
const bar1 = real.clicks[0] + 4 * (60 / 122);
check(Math.abs(bar1 - downbeatWall) <= 60 / 122 / 8, `bar 1 after the count-in lands on the first downbeat within a 32nd note (click bar 1 at ${bar1.toFixed(3)} s, scroll at bar 1 at ${downbeatWall.toFixed(3)} s)`);
check(real.seen.filter((each) => each.clock < learned.sections[0].at).every((each) => each.top === HEADINGS[0] - learn.READING_LINE), "the sheet waits with the first heading on the reading line through the count-in");

for (const section of [1, 2]) {
  const { heading, at: change } = learned.sections[section];
  const name = learn.shortHeading(heading);
  const fourBars = learned.beats[learned.beats.indexOf(at(change)) - 4 * learn.CUE_BARS];
  const lastBar = learned.beats[learned.beats.indexOf(at(change)) - 4];
  const first = real.seen.find((each) => each.cue === `${name} in 4 bars`);
  const lit = real.seen.find((each) => each.lit === section);
  check(!!first && first.clock >= fourBars && first.clock - fourBars <= 2 / 60, `"${name} in 4 bars" appears 4 bars before the change, within two frames (clock ${first?.clock.toFixed(3)} s, 4 bars before is ${fourBars.toFixed(3)} s)`);
  check(real.seen.some((each) => each.cue === `${name} in 1 bar`), `the cue counts down to "${name} in 1 bar"`);
  check(!!lit && lit.clock >= lastBar && lit.clock - lastBar <= 2 / 60 && real.seen.filter((each) => each.lit === section).every((each) => each.clock <= change + 2 / 60), `the ${name} heading lights for the last bar before it arrives (from ${lit?.clock.toFixed(3)} s, last bar ${lastBar.toFixed(3)} s, until ${change.toFixed(3)} s)`);
  const arrival = real.seen.find((each) => each.clock >= change)!;
  const line = HEADINGS[section] - arrival.top;
  check(Math.abs(line - learn.READING_LINE) < 1, `${name}'s heading is on the reading line as it starts (${line.toFixed(1)} px down the view, reading line ${learn.READING_LINE} px)`);
}
check(real.seen[real.seen.length - 1].cue === "" && chartSections.every((section) => !section.hasAttribute("data-next")), "cues and the highlight clear when the song ends");

const fast = await perform(2 * bpm);
const fastChange = fast.seen.find((each) => each.clock >= learned.sections[2].at)!.wall;
const realChange = real.seen.find((each) => each.clock >= learned.sections[2].at)!.wall;
check(fast.rate === 2 && Math.abs(fastChange - realChange / 2) <= 2 / 60, `at double the BPM the learned version stretches like any version (chorus at ${fastChange.toFixed(2)} s, ${realChange.toFixed(2)} s at ${bpm})`);
check(fast.clicks.length === 4 && Math.abs(fast.clicks[1] - fast.clicks[0] - 60 / 244) < 0.002, `and the count-in speeds up with it (${(fast.clicks[1] - fast.clicks[0]).toFixed(3)} s a beat)`);

/** A fixed piece of arithmetic that never changes, so a speed budget can scale with the machine it runs on. Best of five, in ms. */
function speedProbe(): number {
  const input = new Float32Array(96_000);
  let state = 1;
  for (let i = 0; i < input.length; i++) input[i] = (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5;
  let best = Infinity;
  for (let round = 0; round < 5; round++) {
    const started = process.hrtime.bigint();
    let [s1, s2, energy] = [0, 0, 0];
    for (let pass = 0; pass < 100; pass++) {
      for (let i = 0; i < input.length; i++) {
        const s = 0.5 * input[i] + 1.9 * s1 - s2;
        [s2, s1] = [s1, s];
        if ((i & 1023) === 1023) [energy, s1, s2] = [energy + s1 * s1 + s2 * s2 - 1.9 * s1 * s2, 0, 0];
      }
    }
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    if (!Number.isFinite(energy)) throw new Error("the speed probe overflowed");
  }
  return best;
}
const probeMs = speedProbe();
console.log(`speed probe ${probeMs.toFixed(1)} ms`);

for (const { bars, heard } of [{ bars: 6, heard: false }, { bars: 10, heard: true }]) {
  const take = temposHeard(bars, () => 112);
  check(!!take.heard === heard, `${bars} bars of a steady beat ${heard ? "are" : "are not"} heard as a song, which needs 8 bars (${take.text})`);
}

const floors = JSON.parse(readFileSync(new URL("./learn-bands.json", import.meta.url), "utf8")) as { sure: number; likely: number };
const drawn = [100, floors.sure, floors.sure - 0.01, floors.likely, floors.likely - 0.01, 0].map((confidence) => learn.bandOf(confidence));
check(JSON.stringify(drawn) === '["sure","sure","likely","likely","check","check"]', `a confidence is drawn by the floors in scripts/learn-bands.json, green from ${floors.sure} and yellow from ${floors.likely} (${drawn.join(", ")})`);

const source = { kind: "file" as const, name: "take-me-out.wav", stereo: false, sampleRate: SAMPLE_RATE };
const expectedSeconds = truth.samples.length / SAMPLE_RATE;
const through = await listenThrough(truth.samples, SAMPLE_RATE, { beatsPerBar: 4, lyrics: null, source, expectedSeconds, stopped: "finished" });
const lastHeard = through.heard[through.heard.length - 1] ?? 0;
check(
  through.heard.length > 0 && through.heard.every((seconds, i) => seconds > (through.heard[i - 1] ?? 0)) && Math.abs(lastHeard - expectedSeconds) <= 0.05,
  `the worker says how much it has heard as the chunks arrive (${through.heard.length} heard messages for ${Math.ceil(truth.samples.length / SAMPLE_RATE)} chunks, last ${lastHeard.toFixed(2)} s)`,
);
const { source: gotSource, coverage, ...workerHeard } = through.listen ?? { source: null, coverage: null };
check(JSON.stringify(workerHeard) === JSON.stringify(heardSong), "the worker's listen holds what the engine heard from the same samples, unchanged by the trip");
check(
  JSON.stringify(gotSource) === JSON.stringify(source) &&
    !!coverage &&
    Math.abs(coverage.heardSeconds - expectedSeconds) <= 0.05 &&
    coverage.expectedSeconds === expectedSeconds &&
    coverage.stopped === "finished" &&
    coverage.quality === "clear",
  `the listen names the phone's source, how much of it was heard and why it ended (${JSON.stringify(coverage)})`,
);
const nothing = await new Promise<FromWorker>((resolve) => {
  const worker = new FakeWorker("learn-worker.ts");
  worker.onmessage = ({ data }) => {
    const reply = data as FromWorker;
    if (reply.kind !== "done") return;
    worker.terminate();
    resolve(reply);
  };
  worker.postMessage({ kind: "finish", beatsPerBar: 4, lyrics: null, source, expectedSeconds: null, stopped: "player" });
});
check(nothing.kind === "done" && nothing.listen === null, `a listen that heard nothing ends with no result (${JSON.stringify(nothing)})`);
const handedOver = new Float32Array(SAMPLE_RATE);
const handedTo = new FakeWorker("learn-worker.ts");
handedTo.postMessage({ kind: "samples", chunk: handedOver, sampleRate: SAMPLE_RATE }, [handedOver.buffer]);
handedTo.terminate();
check(handedOver.length === 0, "a chunk posted with its buffer in the transfer list is handed to the worker, not copied");
clearWorkerLog();

// TESTS-FIRST for learn wave A: the pass conditions of LEARN-PLAN.md L1 (listen from a file or the mic) and L2 (tempo
// and bars). Each line starts with its condition's number. The cooks make these pass and do not change them. Beyond
// src/learn-result.ts and the browser fakes above, they rely on:
// - the Learn sheet's two ways in: a button named with the word "file" (FILE_WORD), which picks through an
//   <input type="file"> read on change, and one named with the word "mic" (MIC_WORD);
// - a heard thing on screen carrying data-band with its Band, and the player's own pick carrying data-band="set";
// - the Review writing "76 BPM · or 152" when it offers a second tempo, and a button whose name starts with "Tap";
// - the phone making its worker as scripts/fake-worker.ts says, and decoding through OfflineAudioContext.

/** check:learn's speed line on the freeze commit f336126, and the probe printed beside it, on the laptop that ran it. */
const BASELINE = { seconds: 230.7, ms: 3743, probeMs: 58.7 };
const budgetMs = (seconds: number) => 1.2 * (BASELINE.ms / BASELINE.seconds) * seconds * (probeMs / BASELINE.probeMs);
const FILE_RATE = 22_050;

interface Groove {
  bpm: number;
  seconds: number;
  /** From `at` seconds the beat is `bpm`. */
  change?: { at: number; bpm: number };
  /** A kick on every beat, as the songs above; otherwise kick on 1 and 3 and snare on 2 and 4. */
  everyKick?: boolean;
  /** Eighths long and short, 2 to 1. */
  swing?: boolean;
  /** A chord strummed on every eighth note, this loud. */
  strum?: number;
  hats?: number;
  /** The same click on every beat and nothing else. */
  clicks?: boolean;
  drums?: number;
  /** A chord on 1 and 3 when there is no strum. */
  keys?: number;
  /** The bass holds one note a bar. */
  bassPerBar?: boolean;
  /** Seconds of room hiss after the music. */
  tail?: number;
}

/** A band over room hiss from HEAD on, D G A D a bar each. */
function groove(g: Groove, rate: number): Float32Array {
  const out = new Float32Array(Math.round(g.seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = 0.003 * (random() * 2 - 1);
  const end = g.seconds - (g.tail ?? 0);
  const add = (from: number, seconds: number, voice: (t: number) => number) => {
    const first = Math.round(from * rate);
    const last = Math.min(Math.round(end * rate), first + Math.round(seconds * rate));
    for (let i = first; i < last; i++) out[i] += voice((i - first) / rate);
  };
  const tone = (midi: number, harmonics: number) => {
    const hz = 440 * 2 ** ((midi - 69) / 12);
    return (t: number) => {
      let sum = 0;
      for (let k = 1; k <= harmonics; k++) sum += Math.sin(2 * Math.PI * k * hz * t) / k;
      return sum;
    };
  };
  const kick = (level: number) => (t: number) => level * Math.sin(2 * Math.PI * (50 * t + 0.9 * (1 - Math.exp(-t / 0.013)))) * Math.exp(-t / 0.1);
  const drums = g.drums ?? 1;
  for (let k = 0, at = HEAD; at < end; k++) {
    const beat = 60 / (g.change && at >= g.change.at ? g.change.bpm : g.bpm);
    const inBar = k % 4;
    const root = [50, 55, 57, 50][Math.floor(k / 4) % 4];
    if (g.clicks) {
      add(at, 0.3, kick(0.3));
      at += beat;
      continue;
    }
    if (g.everyKick || inBar % 2 === 0) add(at, 0.35, kick(0.5 * drums));
    else add(at, 0.2, (t) => drums * 0.3 * ((random() * 2 - 1) * 0.8 + 0.4 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t / 0.06));
    const offbeat = g.swing ? (2 * beat) / 3 : beat / 2;
    if (g.hats) for (const half of [0, offbeat]) add(at + half, 0.05, (t) => g.hats! * (random() * 2 - 1) * Math.exp(-t / 0.015));
    const bass = tone(root - 12, 6);
    if (!g.bassPerBar || inBar === 0) add(at, (g.bassPerBar ? 4 : 1) * beat * 0.95, (t) => 0.2 * bass(t) * Math.min(1, t / 0.005) * Math.exp(-t / 0.5));
    if (g.strum) {
      for (const half of [0, offbeat]) {
        [0, 4, 7, 12, 16].forEach((step, string) => {
          const key = tone(root + 12 + step, 5);
          add(at + half + 0.004 * string, 0.35, (t) => g.strum! * 0.08 * key(t) * Math.min(1, t / 0.002) * Math.exp(-t / 0.12));
        });
      }
    } else if (inBar % 2 === 0 && (g.keys ?? 0.05) > 0) {
      for (const step of [0, 4, 7, 12]) {
        const key = tone(root + 12 + step, 5);
        add(at, 2 * beat, (t) => (g.keys ?? 0.05) * key(t) * Math.min(1, t / 0.003) * Math.exp(-t / 0.6));
      }
    }
    at += beat;
  }
  return out;
}

/** A 122 BPM song with a kick on every beat, to the file's last sample. */
const fileSong = (seconds: number, extra: Partial<Groove> = {}) => (rate: number) => groove({ bpm: 122, seconds, everyKick: true, keys: 0, ...extra }, rate);
/** The same song under room noise half as loud as the band. */
const underNoise = (render: (rate: number) => Float32Array) => (rate: number) => {
  const song = render(rate);
  const pink = new Float32Array(song.length);
  for (let i = 1; i < pink.length; i++) pink[i] = 0.97 * pink[i - 1] + (random() * 2 - 1);
  const level = (values: Float32Array) => Math.sqrt(values.reduce((sum, x) => sum + x * x, 0) / values.length);
  const gain = (0.5 * level(song.subarray(HEAD * rate))) / level(pink);
  return song.map((x, i) => x + gain * pink[i]);
};
/** The same song four times too loud, cut off at full scale. */
const clipped = (render: (rate: number) => Float32Array) => (rate: number) => render(rate).map((x) => Math.max(-1, Math.min(1, 4 * x)));

micAllowed = true;

/** A tap the way a finger makes one: the click handler runs inside it, so it may ask for the wake lock. */
async function press(target: FakeElement | undefined, name: string) {
  if (!target) throw new Error(`no ${name} in: ${text().slice(0, 400)}`);
  clicking = true;
  try {
    dom.click(target);
  } finally {
    clicking = false;
  }
  await settle();
}
const nameOf = (el: FakeElement) => el.getAttribute("aria-label") ?? el.textContent;
const buttonNamed = (pattern: RegExp) => elements().find((el) => el.nodeName === "BUTTON" && pattern.test(nameOf(el)));
const reviewing = () => !!button("Save");
/** Steps 60 fps frames and lets every message through until `done` holds. */
async function until(done: () => boolean, what: string, frameLimit = 3000) {
  for (let i = 0; i < frameLimit; i++) {
    if (done()) return;
    frame();
    await settle();
    if (i % 20 === 19) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`no ${what} (${text().slice(0, 400)})`);
}
const lastListen = () => (workerLog.fromWorker.filter((reply) => reply.kind === "done").at(-1) as Extract<FromWorker, { kind: "done" }> | undefined)?.listen ?? null;
const posted = () => workerLog.toWorker.filter((message): message is Extract<ToWorker, { kind: "samples" }> => message.kind === "samples");

/** A chart of two headings, so a short listen still places them. */
const twoHeadings = (officialRuntimeSec: number | null) =>
  ({ id: 8, title: "Fourth Street", timeSignature: "4/4", tempo: null, officialRuntimeSec, body: [{ heading: "VERSE 1", lines: [] }, { heading: "CHORUS", lines: [] }] }) as unknown as Song;
const sheets: { unmount: () => void }[] = [];
async function closeSheets() {
  for (const each of sheets.splice(0)) each.unmount();
  await settle();
}
/** Opens the Learn sheet as the app does; returns what it saves and how many audio contexts there were before it. */
async function openSheet(song: Song) {
  const saved: { version: Omit<import("../src/scroll-timing.ts").ScrollVersion, "name">; data: SongData | null }[] = [];
  const contexts = FakeAudioContext.made;
  const sheet = learn.createRoot(dom.container);
  sheets.push(sheet);
  const shut = () => sheet.render(null);
  sheet.render(
    learn.createElement(learn.LearnSong, {
      key: (opened += 1),
      song,
      original: song,
      metronomeBpm: null,
      onSave: (version: never, data: SongData | null) => (saved.push({ version, data }), shut()),
      onClose: shut,
    }),
  );
  await settle();
  return { saved, contexts };
}
/** Starts the mic the way the sheet offers it: at once, as before the file input, or from its mic button. */
async function startMic(sheet: { contexts: number }) {
  if (!button("Stop")) await press(buttonNamed(MIC_WORD), "a button for the mic");
  await until(() => FakeAudioContext.made > sheet.contexts && !!FakeAudioContext.last.processor.onaudioprocess && !!button("Stop"), "listening with the mic");
}
/** The mic hands over 4096 samples at a time, each in a buffer of its own, and the worker keeps up, as in real time. */
async function micPlay(samples: Float32Array) {
  for (let at = 0; at < samples.length; at += 4096) {
    const chunk = samples.slice(at, at + 4096);
    const inputBuffer = { numberOfChannels: 1, length: chunk.length, sampleRate: SAMPLE_RATE, getChannelData: () => chunk, copyFromChannel: (to: Float32Array) => to.set(chunk.subarray(0, to.length)) };
    FakeAudioContext.last.processor.onaudioprocess?.({ inputBuffer });
    await workerIdle();
  }
  await settle();
}
/** Runs one case. A throw is a FAIL line, so a piece not built yet never hides the cases after it. */
async function frozen(name: string, run: () => Promise<void>) {
  clearWorkerLog();
  try {
    await run();
  } catch (error) {
    check(false, `${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  await closeSheets();
  clearWorkerLog();
  dom.document.visibilityState = "visible";
  micAllowed = true;
}

interface FileRun {
  error: string;
  listen: Listen | null;
  text: string;
  /** The most progress bars shown at once, and each new fraction one showed. */
  bars: number;
  progress: number[];
  made: { channels: number; length: number; sampleRate: number }[];
  decodes: number;
  chunks: { length: number; sampleRate: number }[];
  busyMs: number;
  /** After it ended, the sheet still had a file input and a button or label for picking a file. */
  canPick: boolean;
}
/** Opens the sheet, picks `file` through its file input, and waits until `shown` holds or the wait runs out. */
async function listenToFile(file: File, shown: () => boolean = reviewing): Promise<FileRun> {
  clearWorkerLog();
  Object.assign(offline, { made: [], decodes: 0 });
  const run: FileRun = { error: "", listen: null, text: "", bars: 0, progress: [], made: [], decodes: 0, chunks: [], busyMs: 0, canPick: false };
  const fileInput = () => elements().find((el) => el.nodeName === "INPUT" && (el as unknown as { type?: string }).type === "file");
  try {
    await openSheet(twoHeadings(null));
    const chooser = buttonNamed(FILE_WORD);
    if (chooser) await press(chooser, "the file button");
    const input = fileInput();
    if (!input) throw new Error(`no file input in the Learn sheet (${text().slice(0, 300)})`);
    Object.assign(input, { files: Object.assign([file], { item: (i: number) => (i === 0 ? file : null) }), value: `C:\\fakepath\\${file.name}` });
    fire(input, "input");
    fire(input, "change");
    await until(() => {
      const bars = elements().filter((el) => el.nodeName === "PROGRESS");
      run.bars = Math.max(run.bars, bars.length);
      if (bars[0]) {
        const fraction = Number(bars[0].getAttribute("value")) / (Number(bars[0].getAttribute("max") ?? 1) || 1);
        if (Number.isFinite(fraction) && fraction !== run.progress[run.progress.length - 1]) run.progress.push(fraction);
      }
      return shown();
    }, "end to the listen", 6000);
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  }
  const chunks = posted().map((message) => ({ length: message.chunk.length, sampleRate: message.sampleRate }));
  const canPick = !!fileInput() && elements().some((el) => (el.nodeName === "BUTTON" || el.nodeName === "LABEL") && FILE_WORD.test(nameOf(el)));
  Object.assign(run, { listen: lastListen(), text: text(), made: [...offline.made], decodes: offline.decodes, chunks, busyMs: workerLog.busyMs, canPick });
  await closeSheets();
  clearWorkerLog();
  return run;
}
const coverageText = (run: FileRun) => (run.listen ? JSON.stringify(run.listen.coverage) : run.error || "no listen came back");

const fourNineteen = await listenToFile(audioFile("Four Nineteen.m4a", { seconds: 259, channels: 2, song: fileSong(259) }));
{
  const heard = fourNineteen.listen?.coverage.heardSeconds;
  check(heard !== undefined && Math.abs(heard - 259) <= 0.5, `L1.1 a picked file is decoded and heard to its last second (${coverageText(fourNineteen)})`);
  const first = fourNineteen.text.indexOf("From a file · 4:19 · clear");
  check(first >= 0 && first < fourNineteen.text.indexOf(" BPM"), `L1.1 the Review's first line reads "From a file · 4:19 · clear" (${fourNineteen.text.slice(0, 160)})`);
}

{
  const late = await listenToFile(audioFile("Late Change.wav", { seconds: 60, channels: 1, song: fileSong(60, { change: { at: 52, bpm: 150 } }) }));
  const tempos = late.listen?.analysis.tempos ?? [];
  const change = tempos.find((tempo) => Math.abs(tempo.bpm - 150) <= 2);
  const heard = tempos.map((tempo) => `${tempo.bpm.toFixed(1)} BPM at ${tempo.at.toFixed(2)} s`).join(", ");
  check(!!change && Math.abs(change.at - 52) <= 2 * (60 / 150), `L1.2 the last ten seconds count: a change to 150 BPM 8 s before the end is in analysis.tempos (${heard || late.error})`);
}

for (const seconds of [30, 70, 120, 259, 360]) {
  const run = seconds === 259 ? fourNineteen : await listenToFile(audioFile(`Take ${seconds}.mp3`, { seconds, channels: 2, song: fileSong(seconds) }));
  const coverage = run.listen?.coverage;
  const full = !!coverage && Math.abs(coverage.heardSeconds - seconds) <= 0.5 && Math.abs((coverage.expectedSeconds ?? -1) - seconds) <= 0.5 && coverage.stopped === "finished";
  check(full && run.text.includes(`From a file · ${songClock(seconds)}`), `L1.3 a ${songClock(seconds)} file shows full coverage (${coverageText(run)})`);
}

{
  const { made, chunks } = fourNineteen;
  check(made.length > 0 && made.every((each) => each.channels === 1 && each.sampleRate === FILE_RATE), `L1.4 decode is mono at 22050 Hz: every OfflineAudioContext has one channel at 22050 (${JSON.stringify(made) === "[]" ? "none made" : JSON.stringify(made)})`);
  const seconds = chunks.every((chunk, i) => chunk.sampleRate === FILE_RATE && (i === chunks.length - 1 ? chunk.length > 0 && chunk.length <= FILE_RATE : chunk.length === FILE_RATE));
  check(chunks.length > 0 && seconds, `L1.4 the worker's chunks are one second each (${chunks.length} chunks, ${[...new Set(chunks.map((chunk) => `${chunk.length} at ${chunk.sampleRate} Hz`))].join(", ") || "none"})`);
  const slow = synthesizeSong(FILE_RATE);
  const ear = new learn.SongListener(FILE_RATE);
  for (let at = 0; at < slow.samples.length; at += FILE_RATE) ear.push(slow.samples.subarray(at, at + FILE_RATE));
  const at22 = ear.analyze(4)?.analysis;
  const late = at22 ? Math.max(...slow.beats.map((beat) => nearest(at22.beats, beat))) : Infinity;
  const read = at22?.tempos.map((tempo) => `${tempo.bpm.toFixed(2)} BPM at ${tempo.at.toFixed(2)} s`).join(", ") ?? "nothing heard";
  const tempoRight = !!at22 && at22.tempos.length === 2 && Math.abs(at22.tempos[0].bpm - 122) <= 1 && Math.abs(at22.tempos[1].bpm - 104) <= 1 && Math.abs(at22.tempos[1].at - slow.starts[2]) <= 60 / 104;
  check(tempoRight && late <= 0.03, `L1.4 at 22050 Hz the song above keeps every beat within 30 ms and reads 122 then 104 BPM (worst ${(late * 1000).toFixed(1)} ms; ${read})`);
  const steady = temposHeard(64, () => 112, 0.02, FILE_RATE);
  check(steady.tempos.length === 1 && Math.abs(steady.tempos[0].bpm - 112) <= 1, `L1.4 at 22050 Hz a steady 112 BPM take reads as one tempo within 1 BPM (${steady.text})`);
  const blues12 = hearAt(blues(FILE_RATE, { choruses: 2, noise: 0, reverb: false, pickup: 0, swaps: {} }), FILE_RATE);
  const bars = blues12 ? learn.heardBars(blues12.analysis.chroma, 0, blues12.analysis.chroma.length, 4, ["A7", "D7", "E7"]) : [];
  const right = [0, 1].map((chorus) => bars.slice(12 * chorus, 12 * chorus + 12).filter((bar, i) => bar.chord === FORM[i]).length);
  check(right.every((count) => count >= 11), `L1.4 at 22050 Hz the clean blues reads at least 11 of 12 bars right in each chorus (${right.join(", ")})`);
}

await frozen("L1.5 a mic that stops mid-song says why and offers to go on or use what was heard", async () => {
  const sheet = await openSheet(twoHeadings(259));
  await startMic(sheet);
  await micPlay(truth.samples.subarray(0, 70 * SAMPLE_RATE));
  latest().readyState = "ended";
  latest().emit("ended");
  await settle();
  const said = text();
  check(said.includes("Listening stopped at 1:10.") && said.includes("Play the song from a speaker or another device and stay on this screen."), `L1.5 a mic track that ends at 1:10 says why (${said.slice(0, 240)})`);
  check(!!button("Keep listening") && !!button("Use what was heard"), "L1.5 it offers Keep listening and Use what was heard");
  await press(button("Use what was heard"), "Use what was heard");
  await until(reviewing, "Review");
  const coverage = lastListen()?.coverage;
  check(text().includes("From the mic · heard 1:10 of 4:19") && coverage?.stopped === "mic-ended", `L1.5 the Review then reads "From the mic · heard 1:10 of 4:19" (${JSON.stringify(coverage)}; ${text().slice(0, 160)})`);
});

await frozen("L1.5 Keep listening goes on with the same listen", async () => {
  const sheet = await openSheet(twoHeadings(259));
  await startMic(sheet);
  await micPlay(truth.samples.subarray(0, 70 * SAMPLE_RATE));
  const asked = micAsks;
  latest().readyState = "ended";
  latest().emit("ended");
  await settle();
  await press(button("Keep listening"), "Keep listening");
  await until(() => micAsks > asked && !!button("Stop") && !!FakeAudioContext.last.processor.onaudioprocess, "listening again");
  await micPlay(truth.samples.subarray(70 * SAMPLE_RATE, 100 * SAMPLE_RATE));
  await press(button("Stop"), "Stop");
  await until(reviewing, "Review");
  const coverage = lastListen()?.coverage;
  check(!!coverage && Math.abs(coverage.heardSeconds - 100) <= 0.5 && coverage.stopped === "player", `L1.5 after Keep listening and 30 s more, the listen holds all 1:40 (${JSON.stringify(coverage)})`);
});

await frozen("L1.6 a hidden page is reported as the reason", async () => {
  const sheet = await openSheet(twoHeadings(259));
  await startMic(sheet);
  await micPlay(truth.samples.subarray(0, 30 * SAMPLE_RATE));
  dom.document.visibilityState = "hidden";
  fire(dom.document as unknown as FakeElement, "visibilitychange");
  await settle();
  dom.document.visibilityState = "visible";
  fire(dom.document as unknown as FakeElement, "visibilitychange");
  await settle();
  const said = text();
  check(said.includes("Listening stopped at 0:30.") && said.includes("This app was left while listening."), `L1.6 leaving the app stops the listen and says so (${said.slice(0, 240)})`);
  await press(button("Use what was heard"), "Use what was heard");
  await until(reviewing, "Review");
  check(lastListen()?.coverage.stopped === "page-hidden", `L1.6 the listen records stopped: "page-hidden" (${JSON.stringify(lastListen()?.coverage)})`);
});

for (const [stopped, stop] of [
  ["mic-muted", () => ((latest().muted = true), latest().emit("mute"))],
  ["audio-suspended", () => ((FakeAudioContext.last.stuck = true), FakeAudioContext.last.setState("suspended"))],
] as const) {
  await frozen(`L1.7 a ${stopped === "mic-muted" ? "muted track" : "suspended context"} is reported`, async () => {
    const sheet = await openSheet(twoHeadings(259));
    await startMic(sheet);
    await micPlay(truth.samples.subarray(0, 30 * SAMPLE_RATE));
    stop();
    await settle();
    check(text().includes("Listening stopped at 0:30."), `L1.7 ${stopped} stops the listen and says when (${text().slice(0, 200)})`);
    await press(button("Use what was heard"), "Use what was heard");
    await until(reviewing, "Review");
    check(lastListen()?.coverage.stopped === stopped, `L1.7 the listen records stopped: "${stopped}" (${JSON.stringify(lastListen()?.coverage)})`);
  });
}

await frozen("L1.8 listening holds the wake lock from the tap and lets it go", async () => {
  for (const end of ["Stop", "Cancel"]) {
    wakeLocks.length = 0;
    const sheet = await openSheet(twoHeadings(259));
    await startMic(sheet);
    const asked = wakeLocks.length;
    check(asked > 0 && wakeLocks.every((lock) => lock.duringClick), `L1.8 the wake lock is asked for inside the tap that starts listening (${asked} asked, ${wakeLocks.filter((lock) => lock.duringClick).length} inside a tap)`);
    await micPlay(truth.samples.subarray(0, 5 * SAMPLE_RATE));
    await press(button(end), end);
    await workerIdle();
    await settle();
    check(asked > 0 && wakeLocks.every((lock) => lock.released), `L1.8 ${end} lets the wake lock go (${wakeLocks.filter((lock) => lock.released).length} of ${wakeLocks.length} released)`);
    await closeSheets();
  }
  const held = (navigator as unknown as { wakeLock?: unknown }).wakeLock;
  delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
  try {
    const sheet = await openSheet(twoHeadings(259));
    await startMic(sheet);
    check(text().includes("Keep this screen on while it listens"), `L1.8 with no wake lock the sheet says "Keep this screen on while it listens" (${text().slice(0, 200)})`);
  } finally {
    Object.assign(navigator, { wakeLock: held });
  }
});

await frozen("L1.9 analysis runs off the main thread", async () => {
  const total = fourNineteen.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  check(total === Math.round(259 * FILE_RATE), `L1.9 the worker receives every sample of a picked file (${total} of ${Math.round(259 * FILE_RATE)})`);
  const sheet = await openSheet(twoHeadings(259));
  await startMic(sheet);
  const heard = truth.samples.subarray(0, 40 * SAMPLE_RATE);
  await micPlay(heard);
  await press(button("Stop"), "Stop");
  await until(reviewing, "Review");
  const fromMic = posted().reduce((sum, message) => sum + message.chunk.length, 0);
  check(fromMic === heard.length && posted().every((message) => message.sampleRate === SAMPLE_RATE), `L1.9 the worker receives every sample the mic heard (${fromMic} of ${heard.length})`);
});

{
  const { progress, bars } = fourNineteen;
  const rising = progress.every((fraction, i) => fraction >= 0 && fraction <= 1 && (i === 0 || fraction >= progress[i - 1]));
  check(!fourNineteen.error && bars === 1 && progress.length >= 3 && rising && progress[progress.length - 1] >= 0.9, `L1.10 progress is one bar from the file's duration (${bars} bar(s), ${progress.length} steps, ${progress.slice(0, 3).map((fraction) => fraction.toFixed(2)).join(", ")} ... ${progress.slice(-2).map((fraction) => fraction.toFixed(2)).join(", ")}; ${fourNineteen.error})`);
}

{
  const broken = await listenToFile(audioFile("Bought Song.m4p", { seconds: 215, channels: 2 }), () => text().includes("Can't read this file"));
  check(broken.text.includes("Can't read this file. Try an MP3, M4A or WAV.") && broken.canPick && !broken.listen, `L1.11 a file that cannot be decoded fails kindly and the file button stays (${broken.error || broken.text.slice(0, 200)})`);
}

{
  const long = await listenToFile(audioFile("Whole Concert.mp3", { seconds: 21 * 60, channels: 2, song: fileSong(30) }), () => text().includes("longer than a song"));
  check(long.text.includes("That's longer than a song. Pick a file under twenty minutes.") && long.decodes === 0, `L1.12 a file over twenty minutes is refused before decode (${long.decodes} decode(s); ${long.error || long.text.slice(0, 200)})`);
}

for (const [word, song, what] of [
  ["clear", fileSong(60), "a clean"],
  ["noisy", underNoise(fileSong(60)), "a loud room noise"],
  ["some noise", clipped(fileSong(60)), "a clipped"],
] as const) {
  const run = await listenToFile(audioFile(`${word}.wav`, { seconds: 60, channels: 1, song }));
  check(run.text.includes(`From a file · 1:00 · ${word}`) && run.listen?.coverage.quality === word, `L1.13 quality is a word from measured things: ${what} file reads "${word}" (${run.listen?.coverage.quality ?? run.error})`);
}

check(!fourNineteen.error && !!fourNineteen.listen && fourNineteen.busyMs <= budgetMs(259), `L1.14 a 4:19 file is analyzed no slower than the recorded baseline times 1.2 (${fourNineteen.busyMs.toFixed(0)} ms in the worker, budget ${budgetMs(259).toFixed(0)} ms on this machine)`);

/** The engine on its own, fed a second at a time. */
function hearAt(samples: Float32Array, rate: number) {
  const ear = new learn.SongListener(rate);
  for (let at = 0; at < samples.length; at += rate) ear.push(samples.subarray(at, at + rate));
  return ear.analyze(4);
}
type HeardSong = NonNullable<ReturnType<typeof hearAt>>;
const tempoText = (heard: HeardSong | null) =>
  heard
    ? `${heard.tempo.bpm.toFixed(1)} BPM ${heard.tempo.band}; choices ${heard.tempo.choices.map((choice) => `${choice.bpm.toFixed(1)} ${choice.feel} ${choice.score.toFixed(2)}`).join(" / ")}; tempos ${heard.analysis.tempos.map((tempo) => tempo.bpm.toFixed(1)).join(", ")}`
    : "nothing heard";
const near = (value: number | undefined, want: number, within: number) => value !== undefined && Math.abs(value - want) <= within;

const strummed = hearAt(groove({ bpm: 76, seconds: 60, strum: 2, drums: 0.6, bassPerBar: true, tail: 2 }, FILE_RATE), FILE_RATE);
check(!!strummed && near(strummed.tempo.bpm, 76, 2) && near(strummed.analysis.tempos[0].bpm, 76, 2), `L2.1 strong eighth-note strums at 76 BPM read 76, not 152 (${tempoText(strummed)})`);

const rock = hearAt(groove({ bpm: 100, seconds: 50, hats: 0.1, tail: 2 }, FILE_RATE), FILE_RATE);
{
  const rows = rock?.tempo.choices ?? [];
  const asHeard = rows.find((row) => row.feel === "as heard")?.bpm ?? 0;
  const partners = near(rows.find((row) => row.feel === "half")?.bpm, asHeard / 2, 1) && near(rows.find((row) => row.feel === "double")?.bpm, asHeard * 2, 2);
  const inOrder = rows.every((row, i) => i === 0 || row.score <= rows[i - 1].score);
  const [low, mid, high] = rows.map((row) => row.bpm).sort((a, b) => a - b);
  const offered = rows.length === 3 && partners && inOrder && near(low, 50, 1.5) && near(mid, 100, 1.5) && near(high, 200, 3);
  check(offered && near(rock?.tempo.bpm, 100, 1.5) && near(rock?.tempo.bpm, rows[0]?.bpm, 0.5), `L2.3 a 100 BPM song offers 50, 100 and 200, half and double of the tempo as heard, scored and best first (${tempoText(rock)})`);
}
const ballad = hearAt(groove({ bpm: 50, seconds: 70, hats: 0.1, tail: 2 }, FILE_RATE), FILE_RATE);
const punk = hearAt(groove({ bpm: 200, seconds: 45, tail: 2 }, FILE_RATE), FILE_RATE);
for (const [bpm, heard] of [[50, ballad], [200, punk]] as const) {
  check(!!heard?.tempo.choices.some((choice) => near(choice.bpm, bpm, 2)), `L2.3 tempos from 40 to 220 are candidates: a ${bpm} BPM song has ${bpm} among its choices (${tempoText(heard)})`);
}

const swung = hearAt(groove({ bpm: 120, seconds: 60, swing: true, strum: 0.6, tail: 2 }, FILE_RATE), FILE_RATE);

const clickTrack = groove({ bpm: 152, seconds: 45, clicks: true, tail: 2 }, SAMPLE_RATE);
const tied = hearAt(clickTrack, SAMPLE_RATE);
{
  const songs = [rock, strummed, ballad, punk, swung, tied].filter((heard): heard is HeardSong => !!heard);
  const close = songs.filter((heard) => heard.tempo.choices.length > 1 && heard.tempo.choices[1].score >= 0.9 * heard.tempo.choices[0].score);
  check(close.every((heard) => heard.tempo.band !== "sure"), `L2.4 a close call is never green: of this check's ${songs.length} songs, ${close.length} have their top two tempos within 10%, and none of those is sure (${close.map(tempoText).join(" | ") || "none close"})`);
}

/**
 * Shows the phone `tempo` as what a listen heard, at the frozen boundary on either side of the worker: the engine's
 * answer while the phone listens in its own thread, and the worker's reply once it listens through one.
 */
async function withHeardTempo(tempo: HeardSong["tempo"], run: () => Promise<void>) {
  const analyze = learn.SongListener.prototype.analyze;
  learn.SongListener.prototype.analyze = function (this: InstanceType<typeof learn.SongListener>, bar: number) {
    const heard = analyze.call(this, bar);
    return heard && { ...heard, tempo };
  };
  workerReplies.rewrite = (reply) => (reply.kind === "done" && reply.listen ? { ...reply, listen: { ...reply.listen, tempo } } : reply);
  try {
    await run();
  } finally {
    learn.SongListener.prototype.analyze = analyze;
    workerReplies.rewrite = null;
  }
}

await frozen("L2.4 a close call is yellow and both tempos are offered", async () => {
  const close = { bpm: 76, choices: [{ bpm: 76, feel: "as heard" as const, score: 1 }, { bpm: 152, feel: "double" as const, score: 0.95 }, { bpm: 38, feel: "half" as const, score: 0.2 }], band: "likely" as const };
  await withHeardTempo(close, async () => {
    const sheet = await openSheet(twoHeadings(null));
    await startMic(sheet);
    await micPlay(clickTrack);
    await press(button("Stop"), "Stop");
    await until(reviewing, "Review");
  });
  check(text().includes("76 BPM · or 152") && bandAround("76 BPM") === "likely", `L2.4 the Review shows a close call as "76 BPM · or 152" in yellow (76 BPM has data-band ${bandAround("76 BPM")}; ${text().slice(0, 200)})`);
});

for (const pickup of [0, 2]) {
  const heard = hearAt(blues(FILE_RATE, { choruses: 2, noise: 0, reverb: false, pickup, swaps: {} }), FILE_RATE);
  const beats = heard?.analysis.beats ?? [];
  const bar1 = beats.reduce((best, beat, i) => (Math.abs(beat - BLUES_HEAD) < Math.abs(beats[best] - BLUES_HEAD) ? i : best), 0);
  check(!!heard && heard.analysis.downbeatPhase === bar1 % 4, `L2.5 the downbeat phase lands on bar 1 ${pickup ? `after a ${pickup}-beat drum pickup` : "when the song starts on it"} (phase ${heard?.analysis.downbeatPhase}, bar 1 is beat ${bar1})`);
}

check(!!swung && near(swung.tempo.bpm, 120, 2) && near(swung.analysis.tempos[0].bpm, 120, 2), `L2.6 a swung feel reads its 120 BPM, not as triple time (${tempoText(swung)})`);

/** The band on screen of the tempo text `words`: data-band on it or around it, null when none, "missing" when not shown. */
function bandAround(words: string) {
  const inLabel = (el: FakeElement) => {
    for (let at: FakeElement | null = el; at; at = at.parentNode) if (at.nodeName === "LABEL") return true;
    return false;
  };
  const holders = elements().filter((el) => el.textContent.includes(words) && !inLabel(el));
  const deepest = holders.find((el) => !el.elements.some((child) => child.textContent.includes(words)));
  if (!deepest) return "missing";
  for (let at: FakeElement | null = deepest; at && at.nodeName !== "BODY"; at = at.parentNode) if (at.hasAttribute("data-band")) return at.getAttribute("data-band");
  return null;
}
const rockAtMic = groove({ bpm: 100, seconds: 50, hats: 0.1, tail: 2 }, SAMPLE_RATE);
const rockHeard = hearAt(rockAtMic, SAMPLE_RATE);
/** Four taps half a second apart on the Review's Tap button. */
async function tapFour() {
  const tapControl = buttonNamed(/^tap/i);
  if (!tapControl) throw new Error(`no Tap button in the Review (${text().slice(0, 200)})`);
  for (let i = 0; i < 4; i++) {
    if (i) now += 0.5;
    await press(buttonNamed(/^tap/i), "the Tap button");
  }
}

await frozen("L2.7 tap to confirm sets the tempo and is black", async () => {
  const sheet = await openSheet(twoHeadings(null));
  await startMic(sheet);
  await micPlay(rockAtMic);
  await press(button("Stop"), "Stop");
  await until(reviewing, "Review");
  const heardWords = `${Math.round(rockHeard!.tempo.bpm)} BPM`;
  check(bandAround(heardWords) === rockHeard!.tempo.band, `L2.7 the heard tempo is drawn in its band (${heardWords} has data-band ${bandAround(heardWords)}, heard ${rockHeard!.tempo.band})`);
  await tapFour();
  const tapped = bandAround("120 BPM");
  check(tapped === null || tapped === "set", `L2.7 four taps 500 ms apart set 120 BPM, drawn black (data-band ${tapped}; ${text().slice(0, 200)})`);
  const forSong = checkbox("for this song");
  if (forSong) await press(forSong, "the box to use it for the song");
  await press(button("Save"), "Save");
  const [save] = sheet.saved;
  check(sheet.saved.length === 1 && save.version.bpm === 120 && (!forSong || save.data?.tempo === 120), `L2.7 Save stores the tapped 120 BPM (${JSON.stringify(sheet.saved.map((each) => ({ bpm: each.version.bpm, data: each.data })))})`);
});

await frozen("L2.8 the Review's tempo control changes nothing until Save", async () => {
  const stored = JSON.stringify([...store]);
  const sheet = await openSheet(twoHeadings(null));
  await startMic(sheet);
  await micPlay(rockAtMic);
  await press(button("Stop"), "Stop");
  await until(reviewing, "Review");
  await tapFour();
  check(sheet.saved.length === 0 && JSON.stringify([...store]) === stored, "L2.8 tapping a tempo saves nothing and stores nothing");
  await press(button("Cancel"), "Cancel");
  check(sheet.saved.length === 0 && JSON.stringify([...store]) === stored, "L2.8 Cancel after the taps leaves everything as it was");
  await closeSheets();
  const again = await openSheet(twoHeadings(null));
  await startMic(again);
  await micPlay(rockAtMic);
  await press(button("Stop"), "Stop");
  await until(reviewing, "Review");
  const heardWords = `${Math.round(rockHeard!.tempo.bpm)} BPM`;
  check(text().includes(heardWords) && !text().includes("120 BPM"), `L2.8 listening again shows the heard ${heardWords}, not the cancelled tap (${text().slice(0, 200)})`);
});

if (failures) {
  console.error(`${failures} learn check(s) failed`);
  process.exit(1);
}
console.log("Learn this song checks passed");
