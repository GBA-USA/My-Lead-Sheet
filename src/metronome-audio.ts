import { isHighLatencyOutput, metronomeBeatSeconds } from "./metronome";

let audio: AudioContext | null = null;
let timer = 0;
let nextAt = 0;
let running = false;
let armed = false;
let bpm = 0;
let sound = true;
let listening = false;
let clicks: number[] = [];
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

function scheduleClick(ctx: AudioContext, time: number) {
  clicks.push(time);
  if (!sound) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
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

function queue() {
  window.clearTimeout(timer);
  timer = window.setTimeout(tick, 25);
}

function tick() {
  timer = 0;
  if (!running || !audio || bpm <= 0) return;
  if (nextAt < audio.currentTime - 0.05) nextAt = audio.currentTime + 0.02;
  const beat = metronomeBeatSeconds(bpm);
  const horizon = audio.currentTime + 0.12;
  while (nextAt < horizon) {
    scheduleClick(audio, nextAt);
    nextAt += beat;
  }
  queue();
}

function arm(ctx: AudioContext) {
  if (!running || armed || bpm <= 0) return;
  armed = true;
  const beat = metronomeBeatSeconds(bpm);
  nextAt = ctx.currentTime + 0.02;
  scheduleClick(ctx, nextAt);
  nextAt += beat;
  queue();
}

/**
 * Start or keep the click going. Call this from the user gesture so mobile audio can resume.
 * fail runs when no click can sound: no AudioContext, or the browser refused to resume it now or on a return to the page.
 */
export function startMetronome(nextBpm: number, fail: () => void) {
  if (!(nextBpm > 0)) return;
  bpm = nextBpm;
  onFail = fail;
  const ctx = context();
  if (!ctx) {
    onFail();
    return;
  }
  running = true;
  const kick = () => {
    if (!running) return;
    if (!armed) arm(ctx);
    else if (!timer) queue();
  };
  if (ctx.state === "running") kick();
  else resume(ctx, kick);
}

export function setMetronomeBpm(nextBpm: number) {
  if (!(nextBpm > 0)) return;
  bpm = nextBpm;
  if (!running || !audio) return;
  const beat = metronomeBeatSeconds(bpm);
  const latest = audio.currentTime + beat;
  if (nextAt > latest) nextAt = Math.max(audio.currentTime + 0.05, latest);
}

export function stopMetronome() {
  running = false;
  armed = false;
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
 * offsetSeconds is the player's manual sync on top of the reported output latency.
 */
export function secondsSinceHeardClick(offsetSeconds: number): number | null {
  if (!audio) return null;
  const heard = audio.currentTime - outputLatency(audio) - offsetSeconds;
  while (clicks.length > 1 && clicks[1] <= heard) clicks.shift();
  return clicks.length > 0 && clicks[0] <= heard ? heard - clicks[0] : null;
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
