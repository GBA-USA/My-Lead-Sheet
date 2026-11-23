import { CANDIDATE_FASTEST, CANDIDATE_SLOWEST, TempoDetector, smoothed, tempoCandidates, tempoOf } from "./bpm-detect";
import { Chroma } from "./learn-chords";
import type { Analysis, Heard, TempoGuess } from "./learn-result";
import type { Learned, ScrollVersion, Span } from "./scroll-timing";

/** A song is heard only when a steady beat holds for this many bars. */
const MIN_BARS = 8;
const FRAMES_PER_SECOND = 20;
/** Sound starts and ends where a frame is 12 dB over the room's quietest second. */
const ABOVE_FLOOR = 16;
const TEMPO_WINDOW_SECONDS = 10;
const TEMPO_STEP_SECONDS = 2;
/** How strongly the beat tracker keeps to the local tempo. */
const TIGHTNESS = 100;
/** Live bands drift a few percent over a song; a real change of tempo is bigger (Take Me Out drops 15%). */
const TEMPO_CHANGE = 0.1;
/** A tempo change holds at least this long, so a fill or a push is not one. */
const TEMPO_HOLD_BARS = 4;
/** Neighboring tempos this close are one tempo. */
const SAME_TEMPO_BPM = 3;
/** Voice-band share that sets the vocal suggestions apart from the rest of the song. */
const MIN_VOICE_LIFT = 0.08;
/** The band levels a beat's accent is read from, 10 ms apart. */
const LEVELS_PER_SECOND = 100;
/** A beat's accent compares this many level frames after it with as many before it. */
const ACCENT_SPAN = 5;
/** The tracker follows a local tempo this close to the tempo it tracks; further off, it keeps the tempo. */
const FOLLOW_LOCAL = 0.2;
/** Candidate tempos this close are one candidate. */
const SAME_CANDIDATE = 0.02;
/** A beat's own onset lasts this long either side of it, so the fit looks for onsets between beats outside it. */
const BEAT_WIDTH = 0.05;
/**
 * How much the backbeat counts against the fit. Measured, not picked: every tempo case in check:learn and every song of
 * the L0 set, file and mic, reads at the right octave for any weight from 12 to 30 (strong eighth strums at 76 need 12;
 * past 30 a phone recording at 76 reads 101), and 20 sits in the middle.
 */
const BACKBEAT_WEIGHT = 20;
/** A runner-up scoring at least this share of the best is a close call. */
const CLOSE_CALL = 0.9;

interface Bands {
  total: number;
  low: number;
  voice: number;
  high: number;
}

/** A second-order filter from the RBJ cookbook, Q = 0.707. */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private readonly b: number[];
  private readonly a: number[];

  constructor(kind: "low" | "high", frequency: number, sampleRate: number) {
    const w = (2 * Math.PI * frequency) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / Math.SQRT2;
    const a0 = 1 + alpha;
    const edge = kind === "low" ? (1 - cos) / 2 : (1 + cos) / 2;
    this.b = [edge / a0, ((kind === "low" ? 2 : -2) * edge) / a0, edge / a0];
    this.a = [(-2 * cos) / a0, (1 - alpha) / a0];
  }

  run(x: number): number {
    const y = this.b[0] * x + this.b[1] * this.x1 + this.b[2] * this.x2 - this.a[0] * this.y1 - this.a[1] * this.y2;
    [this.x2, this.x1, this.y2, this.y1] = [this.x1, x, this.y1, y];
    return y;
  }
}

interface Tempo {
  at: number;
  bpm: number;
}

/**
 * Hears a whole song a chunk at a time. Keeps D's onset envelope, and the energy of a few bands and the
 * chroma every 50 ms. Raw samples are not stored: the chroma overwrites its last fraction of a second.
 */
export class SongListener {
  private readonly detector: TempoDetector;
  private readonly frames: Bands[] = [];
  private readonly chroma: Chroma;
  private readonly chromaFrames: number[][] = [];
  private readonly frameSize: number;
  private readonly frameRate: number;
  private readonly low: Biquad;
  private readonly voiceLow: Biquad;
  private readonly voiceHigh: Biquad;
  private readonly high: Biquad;
  private sum: Bands = { total: 0, low: 0, voice: 0, high: 0 };
  private filled = 0;
  private readonly levels: Levels;
  private readonly levelSize: number;
  private levelSum = { low: 0, voice: 0, high: 0 };
  private levelFilled = 0;

  constructor(sampleRate: number) {
    this.detector = new TempoDetector(sampleRate);
    this.frameSize = Math.round(sampleRate / FRAMES_PER_SECOND);
    this.frameRate = sampleRate / this.frameSize;
    this.levelSize = Math.round(sampleRate / LEVELS_PER_SECOND);
    this.levels = { low: [], voice: [], high: [], rate: sampleRate / this.levelSize };
    this.low = new Biquad("low", 200, sampleRate);
    this.voiceLow = new Biquad("high", 300, sampleRate);
    this.voiceHigh = new Biquad("low", 3400, sampleRate);
    this.high = new Biquad("high", 5000, sampleRate);
    this.chroma = new Chroma(sampleRate);
  }

  get seconds(): number {
    return this.frames.length / this.frameRate;
  }

  push(samples: Float32Array) {
    this.detector.push(samples);
    for (const x of samples) {
      const low = this.low.run(x);
      const voice = this.voiceHigh.run(this.voiceLow.run(x));
      const high = this.high.run(x);
      this.sum.total += x * x;
      this.sum.low += low * low;
      this.sum.voice += voice * voice;
      this.sum.high += high * high;
      this.levelSum.low += low * low;
      this.levelSum.voice += voice * voice;
      this.levelSum.high += high * high;
      if (++this.levelFilled === this.levelSize) {
        this.levels.low.push(decibels(this.levelSum.low / this.levelSize));
        this.levels.voice.push(decibels(this.levelSum.voice / this.levelSize));
        this.levels.high.push(decibels(this.levelSum.high / this.levelSize));
        this.levelSum = { low: 0, voice: 0, high: 0 };
        this.levelFilled = 0;
      }
      this.chroma.push(x);
      if (++this.filled < this.frameSize) continue;
      this.frames.push(this.sum);
      this.chromaFrames.push(this.chroma.now());
      this.sum = { total: 0, low: 0, voice: 0, high: 0 };
      this.filled = 0;
    }
  }

  /** Everything the samples alone give; null when no song with a steady beat was heard. */
  analyze(beatsPerBar: number): Heard | null {
    const sound = soundSpan(this.frames.map((frame) => frame.total), this.frameRate);
    if (!sound) return null;
    const envelope = this.detector.envelope;
    const rate = this.detector.hopsPerSecond;
    const heard = hearTempo(envelope, rate, sound, this.levels);
    if (!heard || heard.asHeard.beats.length < MIN_BARS * beatsPerBar) return null;
    const { beats, contrast } = heard.asHeard;
    const features = beatFeatures(beats, sound.end, this.frames, this.chromaFrames, this.frameRate, envelope, rate);
    const chroma = features.map((beat) => beat.chroma);
    const tempos = tempoChanges(beats, beatsPerBar);
    const analysis: Analysis = {
      sound,
      beats,
      tempos,
      downbeatPhase: downbeatPhase(contrast, chroma, beatsPerBar),
      vocals: vocalSpans(features.map((beat) => beat.voiceShare), beats, sound.end, beatsPerBar),
      chroma,
      voiceOnsets: new Float32Array(0),
      novelty: novelty(features.map((beat) => beat.texture), 2 * beatsPerBar),
    };
    return { analysis, tempo: tempoOfSong(heard, tempos[0].bpm), changes: [], sections: [], lines: [] };
  }
}

/**
 * Where a chart's headings after the first fall on the heard song: the novelty picks for that many headings. Null when
 * the song is too short to hold them two bars apart. The chart is placed on what was heard, never the other way.
 */
export function placeHeadings(analysis: Analysis, headingCount: number, beatsPerBar: number): number[] | null {
  const gap = 2 * beatsPerBar;
  return analysis.beats.length < headingCount * gap ? null : sectionBoundaries(analysis.novelty, headingCount, gap);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

/** The room's level: the quietest second heard, before the song starts or after it ends. */
function roomFloor(power: number[], frameRate: number): number {
  const width = Math.min(power.length, Math.round(frameRate));
  let sum = power.slice(0, width).reduce((total, value) => total + value, 0);
  let quietest = sum;
  for (let i = width; i < power.length; i++) {
    sum += power[i] - power[i - width];
    quietest = Math.min(quietest, sum);
  }
  return quietest / width;
}

/** From the first frame above the room floor to the end of the last one. */
function soundSpan(power: number[], frameRate: number): Span | null {
  const threshold = Math.max(roomFloor(power, frameRate), 1e-10) * ABOVE_FLOOR;
  const first = power.findIndex((value) => value > threshold);
  if (first < 0) return null;
  let last = power.length - 1;
  while (power[last] <= threshold) last--;
  return { start: first / frameRate, end: (last + 1) / frameRate };
}

/** The local tempo every few seconds, so the tracker follows a tempo change. Null where no beat is clear. */
function localTempos(envelope: readonly number[], rate: number, from: number, to: number): (number | null)[] {
  const half = Math.round((TEMPO_WINDOW_SECONDS * rate) / 2);
  const step = Math.round(TEMPO_STEP_SECONDS * rate);
  const tempos: (number | null)[] = [];
  for (let center = from; center < to + step; center += step) {
    const start = Math.max(from, Math.min(center - half, to - 2 * half));
    tempos.push(tempoOf(envelope.slice(start, start + 2 * half), rate));
  }
  return tempos;
}

/** `local` moved by octaves next to `bpm`, or `bpm` itself where the two are not one tempo at all. */
function nearOctave(local: number | null, bpm: number): number {
  if (local == null) return bpm;
  const moved = local * 2 ** Math.round(Math.log2(bpm / local));
  return Math.abs(moved - bpm) / bpm <= FOLLOW_LOCAL ? moved : bpm;
}

/** One way to hear the song: a tempo, the beats tracked at it, and how well the song fits them. */
interface Reading {
  bpm: number;
  beats: number[];
  /** Per beat, how much more the low band rose than the high band: a kick reads high and a snare low. */
  contrast: number[];
  score: number;
}

interface HeardTempo {
  asHeard: Reading;
  half: Reading;
  double: Reading;
}

/**
 * The song's tempo at the right octave. The comb's top peaks and their halves and doubles are each tracked and
 * scored by how well the song fits them, and the best is the tempo as heard; its half and double are scored beside it.
 */
function hearTempo(envelope: readonly number[], rate: number, sound: Span, levels: Levels): HeardTempo | null {
  const from = Math.floor(sound.start * rate);
  const to = Math.min(envelope.length, Math.ceil(sound.end * rate));
  const peaks = tempoCandidates(envelope.slice(from, to), rate);
  if (peaks.length === 0) return null;
  const local = localTempos(envelope, rate, from, to);
  const onset = smoothed(envelope);
  const flux = fluxOf(levels);
  const unit = riseSpread(levels, sound);
  const readings: Reading[] = [];
  const read = (bpm: number) => {
    const known = readings.find((reading) => Math.abs(reading.bpm - bpm) <= SAME_CANDIDATE * bpm);
    if (known) return known;
    const beats = trackBeats(onset, rate, from, to, local, bpm);
    const reading = { bpm, beats, ...fitOf(beats, flux, levels, unit) };
    readings.push(reading);
    return reading;
  };
  const inRange = (bpm: number) => bpm >= CANDIDATE_SLOWEST && bpm <= CANDIDATE_FASTEST;
  for (const peak of peaks) for (const bpm of [peak, peak / 2, peak * 2]) if (inRange(bpm)) read(bpm);
  let asHeard = readings.reduce((best, reading) => (reading.score > best.score ? reading : best));
  for (;;) {
    const partners = [read(asHeard.bpm / 2), read(asHeard.bpm * 2)].filter((reading) => inRange(reading.bpm) && reading.score > asHeard.score);
    if (partners.length === 0) break;
    asHeard = partners[0];
  }
  return { asHeard, half: read(asHeard.bpm / 2), double: read(asHeard.bpm * 2) };
}

/** The tempo as a listen tells it: the opening tempo of the tracked beats with its half and double, best first. */
function tempoOfSong(heard: HeardTempo, bpm: number): Heard["tempo"] {
  const choices: TempoGuess[] = [
    { bpm, feel: "as heard" as const, score: heard.asHeard.score },
    { bpm: bpm / 2, feel: "half" as const, score: heard.half.score },
    { bpm: bpm * 2, feel: "double" as const, score: heard.double.score },
  ].sort((a, b) => b.score - a.score);
  const [best, next] = choices;
  return { bpm, choices, band: best.score <= 0 ? "check" : next.score >= CLOSE_CALL * best.score ? "likely" : "sure" };
}

/**
 * How well the song fits beats at a tempo, from two terms, each on one scale for every tempo of a song:
 * - fit: the onsets on the beats less the strongest onset between each two, so half or a third of the tempo, which
 *   leaves real beats between its beats, scores low, and below 0 is no beat at all.
 * - backbeat: how often a low beat (a kick) is followed by a bright one (a snare) and the other way round, beyond how
 *   often the two land together. Double time puts an empty beat between each kick and its snare, and half time lands
 *   on the kicks alone, so both score about nothing. It counts only where the fit says the tempo is a beat, since a
 *   third of the tempo also steps from kick to snare.
 */
function fitOf(beats: number[], flux: number[], levels: Levels, unit: number) {
  const low = beats.map((beat) => riseAt(levels.low, beat * levels.rate));
  const high = beats.map((beat) => riseAt(levels.high, beat * levels.rate));
  const contrast = low.map((value, k) => value - high[k]);
  if (beats.length < 3) return { contrast, score: -Infinity };
  const level = flux.reduce((sum, value) => sum + value, 0) / flux.length || 1;
  const hops = beats.map((beat) => Math.round(beat * levels.rate));
  const clear = Math.round(BEAT_WIDTH * levels.rate);
  const onBeat = hops.reduce((sum, hop) => sum + (flux[hop] ?? 0), 0) / hops.length;
  const between =
    hops.slice(1).reduce((sum, hop, i) => {
      let most = 0;
      for (let at = hops[i] + clear; at < hop - clear; at++) most = Math.max(most, flux[at]);
      return sum + most;
    }, 0) /
    (hops.length - 1);
  const fit = (onBeat - between) / level;
  const backbeat = ((covariance(low, high, 1) + covariance(high, low, 1)) / 2 - covariance(low, high, 0)) / unit;
  return { contrast, score: fit > 0 ? fit + BACKBEAT_WEIGHT * backbeat : fit };
}

/** The covariance of `a` with `b` `lag` steps later. */
function covariance(a: number[], b: number[], lag: number): number {
  const count = a.length - lag;
  const meanA = a.slice(0, count).reduce((sum, value) => sum + value, 0) / count;
  const meanB = b.slice(lag).reduce((sum, value) => sum + value, 0) / count;
  let sum = 0;
  for (let k = 0; k < count; k++) sum += (a[k] - meanA) * (b[k + lag] - meanB);
  return sum / count;
}

/** The low, voice and high bands' levels in dB, every 10 ms. */
interface Levels {
  low: number[];
  voice: number[];
  high: number[];
  rate: number;
}

/**
 * Every 10 ms, how much each band rose in dB, summed over the bands and smoothed over 30 ms: a snare counts as much as a
 * kick, where the onset envelope of the whole sound hears mostly the kick and the bass.
 */
function fluxOf(levels: Levels): number[] {
  const bands = [levels.low, levels.voice, levels.high];
  const rise = levels.low.map((_, f) => bands.reduce((sum, band) => sum + Math.max(0, band[f] - (band[f - 1] ?? band[f])), 0));
  return rise.map((value, f) => ((rise[f - 1] ?? 0) + 2 * value + (rise[f + 1] ?? 0)) / 4);
}

const decibels = (power: number) => 10 * Math.log10(power + 1e-12);

/** How much a band's level rose across a moment, in dB, the 50 ms after it against the 50 ms before; 0 where it fell. */
function riseAt(values: number[], at: number): number {
  const frame = Math.round(at);
  let after = 0;
  let before = 0;
  for (let i = 0; i < ACCENT_SPAN; i++) {
    after += values[Math.min(values.length - 1, frame + i)] ?? 0;
    before += values[Math.max(0, frame - 1 - i)] ?? 0;
  }
  return Math.max(0, (after - before) / ACCENT_SPAN);
}

/**
 * The backbeat's unit: how much the low and the high band's rises vary across the sound, read every 10 ms whatever the
 * tempo, so every tempo of one song is scored on one scale.
 */
function riseSpread(levels: Levels, sound: Span): number {
  const spread = (values: number[]) => {
    const rises: number[] = [];
    for (let at = Math.floor(sound.start * levels.rate); at < sound.end * levels.rate; at++) rises.push(riseAt(values, at));
    const mean = rises.reduce((sum, value) => sum + value, 0) / (rises.length || 1);
    return rises.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (rises.length || 1);
  };
  return spread(levels.low) + spread(levels.high) || 1;
}

/**
 * Where bar 1 falls among the beats: the phase whose bars hold one chord each (the bar-to-bar change in raw chroma,
 * squared so a chord split across two bars counts for less) and open on a low beat rather than a bright one.
 */
function downbeatPhase(contrast: number[], chroma: number[][], beatsPerBar: number): number {
  if (beatsPerBar < 2) return 0;
  const unit = (vector: number[]) => {
    const length = Math.hypot(...vector) || 1;
    return vector.map((value) => value / length);
  };
  const phases = Array.from({ length: beatsPerBar }, (_, phase) => {
    const bars: number[][] = [];
    for (let start = phase; start + beatsPerBar <= chroma.length; start += beatsPerBar) {
      const sum = new Array<number>(12).fill(0);
      for (let k = start; k < start + beatsPerBar; k++) chroma[k].forEach((value, pc) => (sum[pc] += value));
      bars.push(unit(sum));
    }
    const change = bars.slice(1).reduce((total, bar, j) => total + bar.reduce((sum, value, pc) => sum + (value - bars[j][pc]) ** 2, 0), 0) / Math.max(1, bars.length - 1);
    const downs = contrast.filter((_, k) => k >= phase && (k - phase) % beatsPerBar === 0);
    const accent = downs.reduce((sum, value) => sum + value, 0) / (downs.length || 1);
    return { change, accent };
  });
  const scaled = (values: number[]) => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const spread = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) || 1;
    return values.map((value) => (value - mean) / spread);
  };
  const change = scaled(phases.map((phase) => phase.change));
  const accent = scaled(phases.map((phase) => phase.accent));
  let best = 0;
  change.forEach((_, phase) => (change[phase] + accent[phase] > change[best] + accent[best] ? (best = phase) : 0));
  return best;
}

/**
 * Dynamic-programming beat tracking (Ellis 2007) at one tempo: each beat is the strongest onset about one beat period
 * after the one before, the period following the local tempo where it stays near `bpm`. Weak beats at either end, in a
 * fade or a ringing tail, are dropped.
 */
function trackBeats(onset: number[], rate: number, from: number, to: number, local: (number | null)[], bpm: number): number[] {
  const step = Math.round(TEMPO_STEP_SECONDS * rate);
  const period = (hop: number) => (60 * rate) / nearOctave(local[Math.round((hop - from) / step)] ?? null, bpm);
  const mean = onset.reduce((sum, value) => sum + value, 0) / onset.length;
  const spread = Math.sqrt(onset.reduce((sum, value) => sum + (value - mean) ** 2, 0) / onset.length) || 1;
  const score = new Float64Array(to);
  const previous = new Int32Array(to).fill(-1);
  for (let hop = from; hop < to; hop++) {
    const beat = period(hop);
    let best = 0;
    for (let back = Math.max(from, hop - Math.round(2 * beat)); back <= hop - Math.round(beat / 2); back++) {
      const candidate = score[back] - TIGHTNESS * Math.log((hop - back) / beat) ** 2;
      if (candidate > best) [best, previous[hop]] = [candidate, back];
    }
    score[hop] = onset[hop] / spread + best;
  }

  let last = to - 1;
  for (let hop = Math.max(from, to - Math.round(period(to - 1))); hop < to; hop++) if (score[hop] > score[last]) last = hop;
  const hops: number[] = [];
  for (let hop = last; hop >= 0; hop = previous[hop]) hops.unshift(hop);
  const weak = median(hops.map((hop) => onset[hop])) / 2;
  while (hops.length > 0 && onset[hops[0]] < weak) hops.shift();
  while (hops.length > 0 && onset[hops[hops.length - 1]] < weak) hops.pop();
  return hops.map((hop) => hop / rate);
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

/** The opening tempo and every lasting change, each from the steady beats it covers. */
function tempoChanges(beats: number[], beatsPerBar: number): Tempo[] {
  const gaps = beats.slice(1).map((beat, i) => beat - beats[i]);
  const local = gaps.map((_, i) => median(gaps.slice(Math.max(0, i - beatsPerBar), i + beatsPerBar)));
  const starts = [0];
  for (let i = 1; i < gaps.length; i++) {
    const current = local[starts[starts.length - 1]];
    if (Math.abs(local[i] - current) / current > TEMPO_CHANGE) starts.push(i);
  }
  const lasting = starts.filter((start, k) => k === 0 || (starts[k + 1] ?? gaps.length) - start >= TEMPO_HOLD_BARS * beatsPerBar);
  const bpm = (from: number, to: number) => {
    const run = gaps.slice(from, to);
    const typical = median(run);
    const steady = run.filter((gap) => Math.abs(gap - typical) / typical <= TEMPO_CHANGE);
    return (60 * steady.length) / steady.reduce((sum, gap) => sum + gap, 0);
  };
  const kept: number[] = [];
  lasting.forEach((start, k) => {
    const previous = kept[kept.length - 1];
    if (previous === undefined || Math.abs(bpm(start, lasting[k + 1] ?? gaps.length) - bpm(previous, start)) > SAME_TEMPO_BPM) kept.push(start);
  });
  return kept.map((start, k) => ({ at: beats[start], bpm: bpm(start, kept[k + 1] ?? gaps.length) }));
}

interface BeatFeatures {
  /** Loudness, brightness, low and voice shares, and onset strength, before scaling. */
  texture: number[];
  voiceShare: number;
  chroma: number[];
}

function beatFeatures(
  beats: number[],
  end: number,
  frames: Bands[],
  chroma: number[][],
  frameRate: number,
  envelope: readonly number[],
  rate: number,
): BeatFeatures[] {
  const mean = (values: readonly number[], from: number, to: number) => {
    const part = values.slice(from, Math.max(from + 1, to));
    return part.reduce((sum, value) => sum + value, 0) / part.length || 0;
  };
  return beats.map((beat, i) => {
    const next = beats[i + 1] ?? Math.min(end, 2 * beat - beats[i - 1]);
    const from = Math.floor(beat * frameRate);
    const to = Math.ceil(next * frameRate);
    const part = frames.slice(from, Math.max(from + 1, to));
    const tones = chroma.slice(from, Math.max(from + 1, to));
    const band = (name: keyof Bands) => part.reduce((sum, frame) => sum + frame[name], 0) / part.length + 1e-12;
    const total = band("total");
    return {
      texture: [
        10 * Math.log10(total),
        band("high") / total,
        band("low") / total,
        band("voice") / total,
        Math.log(1e-6 + mean(envelope, Math.floor(beat * rate), Math.floor(next * rate))),
      ],
      voiceShare: band("voice") / total,
      chroma: Array.from({ length: 12 }, (_, pc) => tones.reduce((sum, frame) => sum + frame[pc], 0)),
    };
  });
}

/** How different the 2 bars after each beat sound from the 2 bars before, with every feature scaled alike. */
function novelty(features: number[][], width: number): number[] {
  const columns = features[0]?.length ?? 0;
  const scaled = features.map((row) => [...row]);
  for (let c = 0; c < columns; c++) {
    const values = features.map((row) => row[c]);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const spread = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) || 1;
    scaled.forEach((row) => (row[c] = (row[c] - mean) / spread));
  }
  const average = (from: number, to: number) =>
    Array.from({ length: columns }, (_, c) => scaled.slice(from, to).reduce((sum, row) => sum + row[c], 0) / (to - from));
  return scaled.map((_, i) => {
    if (i === 0) return 0;
    const before = average(Math.max(0, i - width), i);
    const after = average(i, Math.min(scaled.length, i + width));
    return Math.hypot(...before.map((value, c) => value - after[c]));
  });
}

/**
 * One boundary per heading after the first, in order: the beats with the most novelty in total,
 * at least `gap` beats apart and from either end. Needs `headingCount * gap` beats.
 */
function sectionBoundaries(novelty: number[], headingCount: number, gap: number): number[] {
  const needed = headingCount - 1;
  if (needed <= 0) return [];
  const spacing = gap;
  const last = novelty.length - spacing;
  let best = novelty.map((value, i) => (i >= spacing && i <= last ? value : -Infinity));
  const picks: Int32Array[] = [];
  for (let k = 1; k < needed; k++) {
    const pick = new Int32Array(novelty.length).fill(-1);
    const next = novelty.map(() => -Infinity);
    let top = -Infinity;
    let topAt = -1;
    for (let i = spacing; i <= last; i++) {
      if (best[i - spacing] > top) [top, topAt] = [best[i - spacing], i - spacing];
      if (topAt >= 0) [next[i], pick[i]] = [top + novelty[i], topAt];
    }
    picks.push(pick);
    best = next;
  }
  let at = best.indexOf(Math.max(...best));
  const boundaries = [at];
  for (let k = picks.length - 1; k >= 0; k--) boundaries.unshift((at = picks[k][at]));
  return boundaries;
}

/** Runs of at least two bars where the voice band's share of the sound is in the song's upper group. */
function vocalSpans(shares: number[], beats: number[], end: number, beatsPerBar: number): Span[] {
  const smooth = shares.map((_, i) => median(shares.slice(Math.max(0, i - beatsPerBar), i + beatsPerBar)));
  let low = Math.min(...smooth);
  let high = Math.max(...smooth);
  let split = (low + high) / 2;
  for (let round = 0; round < 10; round++) {
    split = (low + high) / 2;
    low = median(smooth.filter((share) => share <= split));
    high = median(smooth.filter((share) => share > split));
  }
  if (!(high - low >= MIN_VOICE_LIFT)) return [];
  const spans: Span[] = [];
  let start = -1;
  smooth.forEach((share, i) => {
    const voiced = share > split;
    if (voiced && start < 0) start = i;
    if ((!voiced || i === smooth.length - 1) && start >= 0) {
      const stop = voiced ? i + 1 : i;
      if (stop - start >= 2 * beatsPerBar) spans.push({ start: beats[start], end: beats[stop] ?? end });
      start = -1;
    }
  });
  return spans;
}

/** The top number of a time signature: "3/4 — waltz" is 3. */
export function beatsPerBar(timeSignature: string): number {
  return Number(timeSignature.match(/^\s*(\d+)\s*\//)?.[1]) || 4;
}

/** The heading without its notes: "RIFF / CHORUS 1 (tempo drops to ~104)" is "RIFF / CHORUS 1". */
export function shortHeading(heading: string): string {
  return heading.split(/\s+[(—]/)[0].trim();
}

interface LearnChoice {
  boundaries: number[];
  vocals: Span[];
  heard: ((string | null)[] | undefined)[];
}

/**
 * The confirmed result as a timing version. The clock opens with a one-bar count-in at the opening tempo that ends on
 * bar 1, so a pickup before it falls inside the count-in.
 * The scroll places each heading from the chart as laid out when it plays, so only the song's end is a mark.
 */
export function learnedVersion(analysis: Analysis, choice: LearnChoice, headings: string[], bar: number, bpm: number): Omit<ScrollVersion, "name"> {
  const downbeat = analysis.beats[analysis.downbeatPhase] ?? analysis.beats[0];
  const shift = (bar * 60) / analysis.tempos[0].bpm - downbeat;
  const clock = (seconds: number) => Math.round(Math.max(0, seconds + shift) * 1000) / 1000;
  const sections = headings.map((heading, i) => ({
    heading,
    at: clock(i === 0 ? analysis.sound.start : analysis.beats[choice.boundaries[i - 1]]),
    ...(choice.heard[i] ? { heard: choice.heard[i] } : {}),
  }));
  const learned: Learned = {
    beatsPerBar: bar,
    downbeat: clock(downbeat),
    beats: analysis.beats.map(clock),
    sections,
    vocals: choice.vocals.map((span) => ({ start: clock(span.start), end: clock(span.end) })),
  };
  return { bpm, marks: [{ at: 0, progress: 0 }, { at: clock(analysis.sound.end), progress: 1 }], learned };
}
