import { metronomeBeatSeconds } from "./metronome";

let audio: AudioContext | null = null;
let timer = 0;
let nextAt = 0;
let running = false;
let armed = false;
let bpm = 0;
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
  clicks.push(time);
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

/** Seconds since the latest scheduled click the audio clock has reached, or null before the first one and after stop. */
export function secondsSinceClick(): number | null {
  if (!audio) return null;
  const now = audio.currentTime;
  while (clicks.length > 1 && clicks[1] <= now) clicks.shift();
  return clicks.length > 0 && clicks[0] <= now ? now - clicks[0] : null;
}
