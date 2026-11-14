import { mkdtempSync, writeFileSync } from "node:fs";
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
  export * from "./src/learn-analyze.ts";
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

function synthesizeSong() {
  const beats: number[] = [];
  const starts: number[] = [];
  let at = HEAD;
  for (const part of PARTS) {
    starts.push(at);
    for (let beat = 0; beat < part.bars * 4; beat++, at += 60 / part.bpm) beats.push(at);
  }
  const end = at;
  const samples = new Float32Array(Math.round((end + TAIL) * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.003 * (random() * 2 - 1);
  const add = (from: number, seconds: number, voice: (t: number) => number) => {
    const first = Math.round(from * SAMPLE_RATE);
    const last = Math.min(Math.round(end * SAMPLE_RATE), first + Math.round(seconds * SAMPLE_RATE));
    for (let i = first; i < last; i++) samples[i] += voice((i - first) / SAMPLE_RATE);
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
const analysis = listener.analyze(headings.length, 4);
console.log(`analyzed ${(truth.samples.length / SAMPLE_RATE).toFixed(1)} s of audio in ${Date.now() - began} ms`);
if (!analysis) {
  check(false, "the synthesized song is heard");
  process.exit(1);
}

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
function temposHeard(bars: number, bpmAt: (beat: number) => number, jitter = 0.01) {
  const beats: number[] = [];
  for (let k = 0, at = HEAD; k < 4 * bars; at += 60 / bpmAt(k), k++) beats.push(at + (jitter * (random() * 2 - 1) * 60) / bpmAt(k));
  const samples = new Float32Array(Math.round((beats[beats.length - 1] + 0.5 + TAIL) * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.003 * (random() * 2 - 1);
  for (const beat of beats) {
    const first = Math.round(beat * SAMPLE_RATE);
    for (let i = 0; i < 0.3 * SAMPLE_RATE; i++) {
      const t = i / SAMPLE_RATE;
      samples[first + i] += 0.3 * Math.sin(2 * Math.PI * (50 * t + 0.9 * (1 - Math.exp(-t / 0.013)))) * Math.exp(-t / 0.12);
    }
  }
  const ear = new learn.SongListener(SAMPLE_RATE);
  for (let at = 0; at < samples.length; at += 4096) ear.push(samples.subarray(at, at + 4096));
  const tempos = ear.analyze(1, 4)?.tempos ?? [];
  return {
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

const boundaryTimes = analysis.boundaries.map((beat) => analysis.beats[beat]);
check(analysis.boundaries.length === 2, `two boundaries for three headings (${analysis.boundaries.length})`);
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
const tracks: { stopped: boolean; stop: () => void }[] = [];
let micAsks = 0;
let micAllowed = true;
const node = { connect() {}, disconnect() {} };
const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };

class FakeAudioContext {
  static last: FakeAudioContext;
  sampleRate = SAMPLE_RATE;
  state = "suspended";
  destination = {};
  processor = { ...node, onaudioprocess: null as null | ((event: object) => void) };
  constructor() {
    FakeAudioContext.last = this;
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
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
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
Object.assign(globalThis, {
  window: {
    document: dom.document,
    HTMLIFrameElement: class {},
    AudioContext: FakeAudioContext,
    setTimeout: (run: () => void, ms: number) => {
      timers.push({ at: now + ms / 1000, id: nextId, run });
      return nextId++;
    },
    clearTimeout: (id: number) => (timers = timers.filter((timer) => timer.id !== id)),
  },
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
        const track = { stopped: false, stop: () => (track.stopped = true) };
        tracks.push(track);
        return { getTracks: () => [track] };
      },
    },
  },
});

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
const tap = async (target: FakeElement | undefined, name: string) => {
  if (!target) throw new Error(`no "${name}" in: ${text()}`);
  dom.click(target);
  await settle();
};
const latest = () => tracks[tracks.length - 1];
async function play(samples: Float32Array) {
  for (let at = 0; at < samples.length; at += 4096) {
    const chunk = samples.subarray(at, at + 4096);
    FakeAudioContext.last.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => chunk } });
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
/** Opens the sheet the way the app does when Learn by listen is picked, and closes it on Save or Cancel. */
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

if (failures) {
  console.error(`${failures} learn check(s) failed`);
  process.exit(1);
}
console.log("Learn this song checks passed");
