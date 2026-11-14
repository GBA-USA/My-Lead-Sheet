import { beatTime, type Grid } from "./band-time";
import type { Timeline } from "./gig-state";
import { clampMetronomeBpm, isHighLatencyOutput, metronomeBeatSeconds } from "./metronome";
import type { TimeSource } from "./scroll-timing";

/** Solo beats are milliseconds on the audio clock. Band beats are band milliseconds, heard `speakerDelayMs` after the output presents them. */
type Clock = { kind: "solo" } | { kind: "band"; bandAt: TimeSource; speakerDelayMs: number };

/** The beat at `at` on the clock sounds at audio time `ctx + (at - band) / 1000`. */
interface Anchor {
  band: number;
  ctx: number;
}

interface Click {
  at: number;
  time: number;
  gain: GainNode | null;
}

const SOLO: Clock = { kind: "solo" };
const SAME_BEAT_MS = 0.01;

let audio: AudioContext | null = null;
let timer = 0;
let running = false;
let armed = false;
let bpm = 0;
let sound = true;
let listening = false;
let clock: Clock = SOLO;
let beats: Timeline<Grid | null> = [];
let last = -Infinity;
let clicks: Click[] = [];
let onFail = () => {};

function newContext(): AudioContext {
  const webkit = window as Window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = window.AudioContext ?? webkit.webkitAudioContext;
  if (!Ctor) throw new Error("AudioContext is unavailable");
  return new Ctor();
}

function context(): AudioContext | null {
  if (audio) return audio;
  try {
    audio = newContext();
  } catch {
    return null;
  }
  if (!listening) {
    listening = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && running && audio && audio.state !== "running") {
        resume(audio, () => {});
      }
    });
  }
  return audio;
}

function resume(ctx: AudioContext, then: () => void) {
  ctx.resume().then(then, () => {
    stopMetronome();
    onFail();
  });
}

function scheduleClick(ctx: AudioContext, at: number, time: number) {
  last = at;
  if (!sound) {
    clicks.push({ at, time, gain: null });
    return;
  }
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  clicks.push({ at, time, gain });
  osc.type = "sine";
  osc.frequency.setValueAtTime(980, time);
  osc.frequency.exponentialRampToValueAtTime(280, time + 0.028);
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(0.55, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(time);
  osc.stop(time + 0.05);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

/** Beats after `from` and before `to`. A grid's beats end where the next step begins, so Stop silences the beat it lands on. */
function* beatsBetween(from: number, to: number) {
  for (let i = 0; i < beats.length; i += 1) {
    const grid = beats[i].value;
    if (!grid) continue;
    const end = Math.min(to, (beats[i + 1]?.at ?? Infinity) - SAME_BEAT_MS);
    const first = Math.max(from + SAME_BEAT_MS, beats[i].at - SAME_BEAT_MS);
    for (let n = Math.max(0, Math.ceil(((first - grid.startAt) * grid.bpm) / 60_000)); beatTime(grid, n) < end; n += 1) {
      yield beatTime(grid, n);
    }
  }
}

function soloGrid(time: number) {
  const at = (time * 1000) as Grid["startAt"];
  beats = [{ at, value: { bpm: clampMetronomeBpm(bpm), beatsPerBar: 1, startAt: at, firstBar: 0 } }];
  last = -Infinity;
}

/** Read afresh every tick, so the band's clicks follow the output however the audio clock drifts. Null until the output is presenting audio. */
function anchor(ctx: AudioContext): Anchor | null {
  if (clock.kind === "solo") return { band: 0, ctx: 0 };
  const stamp = ctx.getOutputTimestamp?.();
  if (!stamp?.performanceTime || stamp.contextTime == null) return null;
  return { band: clock.bandAt(stamp.performanceTime) + clock.speakerDelayMs, ctx: stamp.contextTime };
}

function queue() {
  window.clearTimeout(timer);
  timer = window.setTimeout(tick, 25);
}

function tick() {
  timer = 0;
  if (!running || !audio) return;
  const map = anchor(audio);
  if (map) {
    const now = audio.currentTime;
    const timeOf = (at: number) => map.ctx + (at - map.band) / 1000;
    const atOf = (time: number) => map.band + (time - map.ctx) * 1000;
    if (clock.kind === "solo") {
      const next = beatsBetween(last, Infinity).next().value;
      if (next != null && timeOf(next) < now - 0.05) soloGrid(now + 0.02);
    }
    const from = clock.kind === "band" ? Math.max(last, atOf(now)) : last;
    for (const at of beatsBetween(from, atOf(now + 0.12))) scheduleClick(audio, at, timeOf(at));
  }
  queue();
}

function arm(ctx: AudioContext) {
  if (!running || armed || bpm <= 0) return;
  armed = true;
  soloGrid(ctx.currentTime + 0.02);
  tick();
}

function begin(fail: () => void, kick: (ctx: AudioContext) => void) {
  onFail = fail;
  const ctx = context();
  if (!ctx) {
    onFail();
    return;
  }
  running = true;
  const go = () => {
    if (running) kick(ctx);
  };
  if (ctx.state === "running") go();
  else resume(ctx, go);
}

/**
 * Start or keep the click going. Call this from the user gesture so mobile audio can resume.
 * fail runs when no click can sound: no AudioContext, or the browser refused to resume it now or on a return to the page.
 */
export function startMetronome(nextBpm: number, fail: () => void) {
  if (!(nextBpm > 0)) return;
  if (clock.kind === "band") stopMetronome();
  bpm = nextBpm;
  begin(fail, (ctx) => {
    if (!armed) arm(ctx);
    else if (!timer) queue();
  });
}

/**
 * Click the band's grid: each beat is heard when `bandAt` reads its band time, `speakerDelayMs` after the output presents it.
 * Call again with each new timeline. A queued click the new one no longer has, as after a late Stop or tempo change, is silenced.
 */
export function followBand(click: Timeline<Grid | null>, bandAt: TimeSource, speakerDelayMs: number, fail: () => void) {
  if (clock.kind === "solo") stopMetronome();
  clock = { kind: "band", bandAt, speakerDelayMs };
  beats = click;
  const now = audio?.currentTime ?? 0;
  const stays = (each: Click) => each.time <= now || !beatsBetween(each.at - 2 * SAME_BEAT_MS, each.at + 2 * SAME_BEAT_MS).next().done;
  for (const each of clicks) if (!stays(each)) each.gain?.disconnect();
  clicks = clicks.filter(stays);
  last = clicks.length > 0 ? clicks[clicks.length - 1].at : -Infinity;
  begin(fail, tick);
}

export function setMetronomeBpm(nextBpm: number) {
  if (!(nextBpm > 0)) return;
  bpm = nextBpm;
  if (!running || !audio || !armed || clock.kind !== "solo") return;
  const beat = metronomeBeatSeconds(bpm);
  const latest = audio.currentTime + beat;
  const next = (beatsBetween(last, Infinity).next().value ?? latest * 1000) / 1000;
  soloGrid(next > latest ? Math.max(audio.currentTime + 0.05, latest) : next);
}

export function stopMetronome() {
  running = false;
  armed = false;
  clock = SOLO;
  beats = [];
  last = -Infinity;
  clicks = [];
  window.clearTimeout(timer);
  timer = 0;
}

/** Sound off keeps the clock and the beat dot running without scheduling an audible click. */
export function setMetronomeSound(on: boolean) {
  sound = on;
}

/** Seconds from the audio clock to the speaker, as the browser reports it now. It changes when the output does. */
function outputLatency(ctx: AudioContext): number {
  for (const seconds of [ctx.outputLatency, ctx.baseLatency]) {
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  return 0;
}

/**
 * Seconds since the latest click reached the listener, or null before the first one and after stop.
 * offsetSeconds is the player's manual sync on top of the reported output latency and, in a gig, the speaker delay.
 */
export function secondsSinceHeardClick(offsetSeconds: number): number | null {
  if (!audio) return null;
  const speaker = clock.kind === "band" ? clock.speakerDelayMs / 1000 : 0;
  const heard = audio.currentTime - outputLatency(audio) - speaker - offsetSeconds;
  while (clicks.length > 1 && clicks[1].time <= heard) clicks.shift();
  return clicks.length > 0 && clicks[0].time <= heard ? heard - clicks[0].time : null;
}

/**
 * Whether the browser says the output is slow: a large reported outputLatency, or an output named like Bluetooth.
 * Reads only what is already exposed. It never creates an AudioContext and never asks for a permission.
 */
export async function highLatencyOutput(): Promise<boolean> {
  const devices = await (navigator.mediaDevices?.enumerateDevices() ?? Promise.resolve([])).catch(() => []);
  const outputs = devices.filter((device) => device.kind === "audiooutput");
  const current = outputs.filter((device) => device.deviceId === "default");
  const labels = (current.length > 0 ? current : outputs).map((device) => device.label);
  return isHighLatencyOutput(audio?.outputLatency ?? 0, labels);
}
