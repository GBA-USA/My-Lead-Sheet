import { chordAnchors, type Row } from "./chord-anchors.ts";
import { LYRICS, plainLine } from "./learn-lyrics.ts";
import type { ChartSection } from "../src/types.ts";

/**
 * A score to samples, the way scripts/blues.ts renders the blues: kick, snare, hats, a bass line, keys or a strummed
 * guitar on the chord tones, and for sung sections a voice that sings each syllable on a chord tone. The score is the
 * truth: every beat, change, section and syllable onset is a sample index first, and its time is that index over the
 * rate, so the answers match the audio to the sample.
 */

/** The rate the phone decodes at. */
export const SAMPLE_RATE = 22050;
/** The one seed every render and every mic coloring draws its noise from. */
export const SEED = 20261113;
/** Seconds of room hiss before bar 1 and after the last bar. */
export const HEAD = 2;
export const TAIL = 2;
/** A bar where everything stops, and a bar where only the drums play. Both chart and score as N.C. */
export const SILENCE = "rest";
export const DRUMS_ONLY = "N.C.";
export const MIC_LEVELS = ["light", "medium", "loud"] as const;
export type MicLevel = (typeof MIC_LEVELS)[number];

export interface ScoreSection {
  /** A heading word the listen can name: INTRO, VERSE, PRE-CHORUS, CHORUS, BRIDGE, SOLO, INSTRUMENTAL or OUTRO. */
  label: string;
  /** Sections that repeat share a letter. */
  group: string;
  /** One or two chords a bar; two split the bar at its middle beat. */
  bars: string[][];
  /** The words sung, one entry a line, each line taking the same number of bars. Every line is in scripts/learn-lyrics.ts. */
  lines?: string[];
}

export interface Score {
  title: string;
  bpm: number;
  beatsPerBar: number;
  stereo: boolean;
  swing: boolean;
  strum: "none" | "light" | "strong";
  bass: "root" | "root-fifth" | "walking";
  sections: ScoreSection[];
  /** From this bar, counted from 0, the song plays at `bpm`. */
  tempoChangeAtBar?: { bar: number; bpm: number };
}

/** The exact answers, in seconds from the first sample. */
export interface Truth {
  durationSec: number;
  /** The opening tempo. */
  bpm: number;
  beats: number[];
  downbeats: number[];
  /** Each time the chord changes; N.C. where none sounds. */
  changes: { at: number; chord: string }[];
  /** Bars counted from 0; `toBar` is the first bar after the section. */
  sections: { fromBar: number; toBar: number; label: string; group: string }[];
  /** Each syllable's onset; `line` counts the song's sung lines from 0, `word` the line's words from 0, `column` its characters. */
  syllables: { at: number; line: number; word: number; column: number }[];
  /** `chordAnchors` of the chart the score implies. */
  anchors: string[];
}

/** What a person can write down by hand for a recording: the truth without its beats and syllables. */
export type Sidecar = Omit<Truth, "beats" | "syllables">;
export const sidecarOf = ({ beats: _beats, syllables: _syllables, ...sidecar }: Truth): Sidecar => sidecar;

export interface Stems {
  drums: Float32Array;
  bass: Float32Array;
  keys: Float32Array;
  strum: Float32Array;
  voice: Float32Array;
}

export interface Rendered {
  /** Mono, the file case; for a stereo score, the mix of its two channels. */
  samples: Float32Array;
  stereo: [Float32Array, Float32Array] | null;
  truth: Truth;
  /** The words as a player would paste them, sections apart by a blank line; null when nothing is sung. */
  lyrics: string | null;
  /** The chart the score implies, in the library's shape. */
  chart: ChartSection[];
  stems: Stems;
}

export class ScoreRefused extends Error {}

const NOTES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const QUALITIES: Record<string, number[]> = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  "7": [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  "6": [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  "9": [0, 4, 7, 10, 14],
  add9: [0, 4, 7, 14],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  "7sus4": [0, 5, 7, 10],
  dim: [0, 3, 6],
  m7b5: [0, 3, 6, 10],
};

export interface Chord {
  root: number;
  /** The slash bass, else the root. */
  bass: number;
  minor: boolean;
  /** Semitones above the root. */
  tones: number[];
}

/** A chord name as charts write it, such as F#m7 or C/E; null for anything else. */
export function parseChord(name: string): Chord | null {
  const match = /^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/.exec(name);
  const tones = match && QUALITIES[match[3]];
  if (!match || !tones) return null;
  const pc = (letter: string, accidental: string) => (NOTES[letter] + (accidental === "#" ? 1 : accidental === "b" ? -1 : 0) + 12) % 12;
  const root = pc(match[1], match[2]);
  return { root, bass: match[4] ? pc(match[4], match[5]) : root, minor: tones.includes(3) && !tones.includes(4), tones };
}

const LABEL_GAIN: Record<string, number> = { INTRO: 0.7, VERSE: 0.8, "PRE-CHORUS": 0.9, CHORUS: 1.05, BRIDGE: 0.9, SOLO: 1, INSTRUMENTAL: 0.95, OUTRO: 0.7 };
const MARKED = new Map(Object.values(LYRICS).flatMap((lyric) => lyric.lines.map((line) => [plainLine(line), line] as const)));

/** A line's syllables: the word each is in and the column it starts at, from the hyphens in scripts/learn-lyrics.ts. */
function syllablesOf(marked: string) {
  const syllables: { word: number; column: number }[] = [];
  let column = 0;
  marked.split(" ").forEach((word, index) => {
    if (!word) {
      column += 1;
      return;
    }
    let offset = 0;
    for (const part of word.split("-")) {
      syllables.push({ word: index, column: column + offset });
      offset += part.length;
    }
    column += offset + 1;
  });
  return syllables;
}

/** A seeded generator, so every render draws the same noise. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

const TABLE = 2048;
const tables = new Map<string, Float32Array>();
/** One cycle of a tone with these harmonic levels, peak 1. */
function wave(key: string, levels: number[]) {
  let table = tables.get(key);
  if (table) return table;
  table = new Float32Array(TABLE);
  for (let i = 0; i < TABLE; i++) levels.forEach((level, k) => (table![i] += level * Math.sin((2 * Math.PI * (k + 1) * i) / TABLE)));
  const peak = table.reduce((most, value) => Math.max(most, Math.abs(value)), 0);
  for (let i = 0; i < TABLE; i++) table[i] /= peak;
  tables.set(key, table);
  return table;
}
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
/** Harmonics up to `top` Hz, each at `level(k, frequency)`. */
const harmonics = (midi: number, top: number, level: (k: number, frequency: number) => number) =>
  Array.from({ length: Math.max(1, Math.floor(top / hz(midi))) }, (_, k) => level(k + 1, (k + 1) * hz(midi)));
/** The sung vowel: a harmonic tone shaped by two resonances near 700 and 1200 Hz. */
const vowel = (midi: number) =>
  wave(`voice ${midi}`, harmonics(midi, 5000, (k, f) => (1 / (1 + ((f - 700) / 130) ** 2) + 0.8 / (1 + ((f - 1200) / 150) ** 2) + 0.04) / k ** 0.3));

export function render(score: Score, rate = SAMPLE_RATE): Rendered {
  const refuse = (why: string): never => {
    throw new ScoreRefused(`${score.title}: ${why}`);
  };
  const bars = score.sections.flatMap((section) => section.bars);
  for (const section of score.sections) if (!section.bars.length) refuse(`${section.label} has no bars`);
  if (!bars.length) refuse("the score has no bars");
  bars.forEach((bar, index) => {
    if (bar.length < 1 || bar.length > 2) refuse(`bar ${index + 1} holds ${bar.length} chords; a bar holds one or two`);
    for (const token of bar) {
      if ((token === SILENCE || token === DRUMS_ONLY) && bar.length > 1) refuse(`bar ${index + 1} splits ${token} with a chord`);
      if (token !== SILENCE && token !== DRUMS_ONLY && !parseChord(token)) refuse(`bar ${index + 1}: unknown chord "${token}"`);
    }
  });

  const perBar = score.beatsPerBar;
  const half = Math.ceil(perBar / 2);
  const total = bars.length * perBar;
  const turn = score.tempoChangeAtBar ? score.tempoChangeAtBar.bar * perBar : Infinity;
  const exact = (k: number) => (k < turn ? HEAD + (k * 60) / score.bpm : HEAD + (turn * 60) / score.bpm + ((k - turn) * 60) / score.tempoChangeAtBar!.bpm);
  /** The sample `fraction` of the way through beat `k`. */
  const sampleAt = (k: number, fraction = 0) => Math.round((exact(k) + fraction * (exact(k + 1) - exact(k))) * rate);
  const beatSeconds = (k: number) => exact(k + 1) - exact(k);
  const offbeat = score.swing ? 2 / 3 : 1 / 2;
  const length = sampleAt(total) + Math.round(TAIL * rate);
  const time = (sample: number) => sample / rate;

  const tokenAt = (k: number) => {
    const bar = bars[Math.floor(k / perBar)];
    return bar.length === 2 && k % perBar >= half ? bar[1] : bar[0];
  };
  const startsToken = (k: number) => k % perBar === 0 || (bars[Math.floor(k / perBar)].length === 2 && k % perBar === half);
  const sectionOf: ScoreSection[] = score.sections.flatMap((section) => section.bars.map(() => section));
  const truthChord = (token: string) => (token === SILENCE || token === DRUMS_ONLY ? "N.C." : token);
  /** Where the chord sounding at beat `k` stops: its next change, or the song's end. */
  const tokenEnd = (k: number) => {
    let next = k + 1;
    while (next < total && !startsToken(next)) next += 1;
    return sampleAt(next);
  };

  const changes: { beat: number; chord: string }[] = [];
  for (let k = 0; k < total; k++) {
    if (!startsToken(k)) continue;
    const chord = truthChord(tokenAt(k));
    if (changes[changes.length - 1]?.chord !== chord) changes.push({ beat: k, chord });
  }

  const stems: Stems = { drums: new Float32Array(length), bass: new Float32Array(length), keys: new Float32Array(length), strum: new Float32Array(length), voice: new Float32Array(length) };
  const random = seeded(SEED);
  const noise = () => random() * 2 - 1;
  /** Adds `voice(t)` from sample `from` for `count` samples, stopping where a silent bar begins. */
  const add = (out: Float32Array, from: number, count: number, voice: (t: number) => number) => {
    const bar = bars.findIndex((each, index) => each[0] === SILENCE && sampleAt(index * perBar) > from);
    const last = Math.min(out.length, from + count, bar < 0 ? Infinity : sampleAt(bar * perBar));
    for (let i = from; i < last; i++) out[i] += voice((i - from) / rate);
  };
  /** A tone from a one-cycle table, its pitch bent by `bend(t)` semitones. */
  const tone = (out: Float32Array, from: number, count: number, midi: number, table: Float32Array, gain: number, envelope: (t: number) => number, bend?: (t: number) => number) => {
    let phase = 0;
    const step = (hz(midi) * TABLE) / rate;
    add(out, from, count, (t) => {
      const at = phase | 0;
      const fraction = phase - at;
      const value = table[at & (TABLE - 1)] * (1 - fraction) + table[(at + 1) & (TABLE - 1)] * fraction;
      phase += bend ? step * 2 ** (bend(t) / 12) : step;
      if (phase >= TABLE) phase -= TABLE;
      return gain * envelope(t) * value;
    });
  };
  const decay = (attack: number, tau: number, seconds: number, release = 0.02) => (t: number) =>
    Math.min(1, t / attack) * Math.exp(-t / tau) * Math.min(1, Math.max(0, (seconds - t) / release));
  const inRange = (pc: number, low: number) => low + ((pc - low) % 12 + 12) % 12;

  // Drums: kick, snare, hats, on every beat of every bar that is not silent.
  for (let k = 0; k < total; k++) {
    const bar = Math.floor(k / perBar);
    if (bars[bar][0] === SILENCE) continue;
    const beat = k % perBar;
    const gain = LABEL_GAIN[sectionOf[bar].label] ?? 0.85;
    const at = sampleAt(k);
    const kick = perBar === 3 ? beat === 0 : beat % 2 === 0;
    if (kick) add(stems.drums, at, Math.round(0.35 * rate), (t) => 0.5 * gain * Math.sin(2 * Math.PI * (50 * t + 0.9 * (1 - Math.exp(-t / 0.013)))) * Math.exp(-t / 0.1));
    else add(stems.drums, at, Math.round(0.2 * rate), (t) => 0.25 * gain * (0.8 * noise() + 0.4 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t / 0.06));
    let previous = 0;
    const hat = (t: number) => {
      const value = noise();
      const hiss = value - previous;
      previous = value;
      return 0.06 * gain * hiss * Math.exp(-t / 0.015);
    };
    add(stems.drums, at, Math.round(0.05 * rate), hat);
    if (score.bpm <= 160) add(stems.drums, sampleAt(k, offbeat), Math.round(0.05 * rate), hat);
  }

  // Bass, keys and strums, on the chord sounding at each beat.
  const strings = (chord: Chord) => {
    const low = inRange(chord.bass, 40);
    const up = chord.tones.map((step) => (chord.root + step) % 12);
    const notes = [low];
    for (let midi = low + 1; notes.length < 6 && midi <= 69; midi++) if (up.includes(midi % 12)) notes.push(midi);
    return notes;
  };
  for (let k = 0; k < total; k++) {
    const token = tokenAt(k);
    const chord = parseChord(token);
    if (!chord) continue;
    const bar = Math.floor(k / perBar);
    const beat = k % perBar;
    const gain = LABEL_GAIN[sectionOf[bar].label] ?? 0.85;
    const at = sampleAt(k);
    const stop = tokenEnd(k);
    const split = bars[bar].length === 2;
    const fromStart = split && beat >= half ? beat - half : beat;
    const span = split ? (beat >= half ? perBar - half : half) : perBar;
    const root = inRange(chord.root, 36);
    const bass = inRange(chord.bass, 36);
    const third = root + (chord.minor ? 3 : 4);
    const fifth = root + 7;
    const nextChord = k + 1 < total ? parseChord(tokenAt(k + 1)) : null;
    const approach = nextChord ? inRange(nextChord.root, 36) - 1 : fifth;
    let note: number | null = null;
    if (score.bass === "root") note = bass;
    else if (score.bass === "root-fifth") note = fromStart === 0 ? bass : fromStart === Math.ceil(span / 2) ? fifth : null;
    else note = [bass, third, fifth, approach][span <= 2 ? [0, 2][fromStart] : fromStart] ?? fifth;
    if (note !== null) {
      const seconds = score.bass === "root-fifth" ? beatSeconds(k) * Math.ceil(span / 2) * 0.92 : beatSeconds(k) * 0.92;
      const count = Math.min(Math.round(seconds * rate), stop - at);
      tone(stems.bass, at, count, note, wave("bass", [1, 0.5, 0.33, 0.25, 0.2, 0.17]), 0.22 * gain, decay(0.005, 0.6, count / rate));
    }
    const keysGain = { none: 0.07, light: 0.04, strong: 0.025 }[score.strum] * gain;
    if (fromStart === 0 || (!split && beat === half && perBar === 4)) {
      const count = Math.min(stop, sampleAt(k + (fromStart === 0 && !split && perBar === 4 ? half : span))) - at;
      for (const step of chord.tones) tone(stems.keys, at, count, inRange(chord.root + step, 55), wave("keys", [1, 0.4, 0.25, 0.12, 0.08]), keysGain, decay(0.003, 0.8, count / rate));
      tone(stems.keys, at, count, inRange(chord.root, 48), wave("keys", [1, 0.4, 0.25, 0.12, 0.08]), keysGain, decay(0.003, 0.8, count / rate));
    }
    if (score.strum === "none") continue;
    const strong = score.strum === "strong";
    const strums = strong ? [{ at, down: true }, { at: sampleAt(k, offbeat), down: false }] : [{ at, down: true }];
    strums.forEach(({ at: from, down }, index) => {
      const until = index === 0 && strong ? strums[1].at : Math.min(stop, sampleAt(k + 1));
      const notes = down ? strings(chord) : strings(chord).slice(2).reverse();
      const level = (strong ? (down ? 0.09 : 0.065) : 0.05) * gain;
      const pluck = wave(strong ? "bright string" : "string", harmonics(52, 3600, (k) => 1 / k ** (strong ? 0.9 : 1.3)).slice(0, 8));
      notes.forEach((midi, string) => {
        const start = from + Math.round(string * 0.008 * rate);
        const count = Math.max(0, Math.min(until, stop) - start - Math.round(0.002 * rate));
        tone(stems.strum, start, count, midi, pluck, level, decay(0.002, strong ? 0.25 : 0.4, count / rate, 0.01));
      });
      if (strong) add(stems.strum, from, Math.round(0.012 * rate), (t) => 0.05 * gain * noise() * Math.exp(-t / 0.004));
    });
  }

  // The voice, and the chart the score implies.
  const counts = new Map<string, number>();
  for (const section of score.sections) counts.set(section.label, (counts.get(section.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  const chart: ChartSection[] = [];
  const syllables: Truth["syllables"] = [];
  let line = 0;
  let firstBar = 0;
  let pitch = 62;
  for (const section of score.sections) {
    const number = (seen.get(section.label) ?? 0) + 1;
    seen.set(section.label, number);
    const heading = (counts.get(section.label) ?? 0) > 1 ? `${section.label} ${number}` : section.label;
    const gain = LABEL_GAIN[section.label] ?? 0.85;
    const lines = section.lines ?? [];
    if (!lines.length) {
      const rows: { bars: string }[] = [];
      for (let at = 0; at < section.bars.length; at += 4) {
        rows.push({ bars: `| ${section.bars.slice(at, at + 4).map((bar) => bar.map(truthChord).join("  ")).join(" | ")} |` });
      }
      chart.push({ heading, lines: rows });
      firstBar += section.bars.length;
      continue;
    }
    if (section.bars.length % lines.length) refuse(`${heading} has ${lines.length} lines for ${section.bars.length} bars; each line takes the same number of bars`);
    const barsEach = section.bars.length / lines.length;
    const rows: { chords: string; lyrics: string }[] = [];
    lines.forEach((words, index) => {
      const marked = MARKED.get(words) ?? refuse(`line "${words}" has no syllable marks in scripts/learn-lyrics.ts`);
      const parts = syllablesOf(marked);
      const start = (firstBar + index * barsEach) * perBar;
      const beats = barsEach * perBar;
      if (section.bars.slice(index * barsEach, (index + 1) * barsEach).some((bar) => bar[0] === SILENCE)) refuse(`line "${words}" is sung over a silent bar`);
      const rest = Math.max(1, Math.ceil(0.4 / beatSeconds(start)));
      const room = 2 * (beats - rest);
      const lineChanges = changes.filter((change) => change.beat >= start && change.beat < start + beats);
      const required = [...new Set([0, ...lineChanges.map((change) => 2 * (change.beat - start))])].sort((a, b) => a - b);
      if (required[required.length - 1] >= room) refuse(`line "${words}": the chord changes in the breath at its end`);
      if (parts.length < required.length || parts.length > room) refuse(`line "${words}" has ${parts.length} syllables for ${barsEach} bars`);
      const lengths = required.map((at, i) => (required[i + 1] ?? room) - at);
      const sizes = required.map(() => 1);
      for (let extra = parts.length - required.length; extra > 0; extra--) {
        let best = -1;
        lengths.forEach((size, i) => {
          if (sizes[i] < size && (best < 0 || size / sizes[i] > lengths[best] / sizes[best])) best = i;
        });
        if (best < 0) refuse(`line "${words}" has ${parts.length} syllables for ${barsEach} bars`);
        sizes[best] += 1;
      }
      const slots: number[] = [];
      required.forEach((at, i) => {
        for (let j = 0; j < sizes[i]; j++) slots.push(sizes[i] <= lengths[i] / 2 ? at + 2 * Math.floor((j * lengths[i]) / 2 / sizes[i]) : at + Math.floor((j * lengths[i]) / sizes[i]));
      });
      const onsets = slots.map((slot) => sampleAt(start + Math.floor(slot / 2), slot % 2 ? offbeat : 0));
      const end = sampleAt(start + beats - rest);
      const plain = plainLine(marked);
      let chords = "";
      for (const change of lineChanges) {
        const syllable = slots.indexOf(2 * (change.beat - start));
        const column = parts[syllable].column;
        if (chords.length && column < chords.length + 1) refuse(`line "${words}": ${chords.trim().split(" ").pop()} and ${change.chord} crowd each other over the words`);
        chords += " ".repeat(column - chords.length) + change.chord;
      }
      rows.push({ chords, lyrics: plain });
      parts.forEach((part, j) => {
        const from = onsets[j];
        const count = Math.min(onsets[j + 1] ?? end, end) - from - Math.round(0.005 * rate);
        const chord = parseChord(tokenAt(start + Math.floor(slots[j] / 2)))!;
        const tones = chord.tones.flatMap((step) => [-12, 0, 12].map((octave) => inRange(chord.root + step, 57) + octave)).filter((midi) => midi >= 55 && midi <= 71);
        const aim = pitch + (j % 6 < 3 ? 2 : -2);
        pitch = tones.reduce((best, midi) => (Math.abs(midi - aim) < Math.abs(best - aim) ? midi : best), tones[0]);
        const seconds = count / rate;
        const envelope = (t: number) => ((1 - Math.cos(Math.PI * Math.min(1, t / 0.06))) / 2) * Math.min(1, Math.max(0, (seconds - t) / 0.03));
        tone(stems.voice, from, count, pitch, vowel(pitch), 0.16 * gain, envelope, (t) => (t < 0.15 ? 0 : 0.2 * Math.sin(2 * Math.PI * 5.5 * (t - 0.15))));
        syllables.push({ at: time(from), line, word: part.word, column: part.column });
      });
      line += 1;
    });
    chart.push({ heading, lines: rows });
    firstBar += section.bars.length;
  }

  // The mix: mono, and for a stereo score keys left and strums right, so that mono is the two channels' mean.
  const pans: Record<keyof Stems, number> = { drums: 0, bass: 0, keys: -0.6, strum: 0.6, voice: 0 };
  const names = Object.keys(stems) as (keyof Stems)[];
  let peak = 0;
  for (let i = 0; i < length; i++) {
    let [left, right] = [0, 0];
    for (const name of names) [left, right] = [left + stems[name][i] * (1 - pans[name]), right + stems[name][i] * (1 + pans[name])];
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
  }
  const scale = Math.min(1, 0.9 / (peak || 1));
  for (const name of names) for (let i = 0; i < length; i++) stems[name][i] *= scale;
  const samples = new Float32Array(length);
  const stereo: [Float32Array, Float32Array] | null = score.stereo ? [new Float32Array(length), new Float32Array(length)] : null;
  for (let i = 0; i < length; i++) {
    const hiss = 0.002 * noise();
    let [mono, left, right] = [hiss, hiss, hiss];
    for (const name of names) {
      mono += stems[name][i];
      left += stems[name][i] * (1 - pans[name]);
      right += stems[name][i] * (1 + pans[name]);
    }
    samples[i] = mono;
    if (stereo) [stereo[0][i], stereo[1][i]] = [left, right];
  }

  const beats = Array.from({ length: total }, (_, k) => time(sampleAt(k)));
  const truth: Truth = {
    durationSec: length / rate,
    bpm: score.bpm,
    beats,
    downbeats: beats.filter((_, k) => k % perBar === 0),
    changes: changes.map((change) => ({ at: beats[change.beat], chord: change.chord })),
    sections: score.sections.reduce<Truth["sections"]>((out, section) => {
      const fromBar = out[out.length - 1]?.toBar ?? 0;
      return [...out, { fromBar, toBar: fromBar + section.bars.length, label: section.label, group: section.group }];
    }, []),
    syllables,
    anchors: chordAnchors(chartRows(chart)),
  };
  return { samples, stereo, truth, lyrics: lyricsOf(chart), chart, stems };
}

/** A chart's lyric rows, as `chordAnchors` reads them. */
export const chartRows = (body: ChartSection[]): Row[] =>
  body.flatMap((section) => section.lines.filter((line) => line.lyrics !== undefined).map((line) => ({ chords: line.chords ?? "", lyrics: line.lyrics })));

/** A chart's words as a player would paste them: its lyric lines, sections apart by a blank line. */
export function lyricsOf(body: ChartSection[]): string | null {
  const blocks = body.map((section) => section.lines.flatMap((line) => (line.lyrics === undefined ? [] : [line.lyrics])).join("\n")).filter(Boolean);
  return blocks.length ? blocks.join("\n\n") : null;
}

/** The chart with its chord lines and bar rows dropped and its words left exactly as they were. */
export const stripChords = (body: ChartSection[]): ChartSection[] =>
  body.map((section) => ({ heading: section.heading, lines: section.lines.flatMap((line) => (line.lyrics === undefined ? [] : [{ lyrics: line.lyrics }])) }));

const rms = (values: Float32Array) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / (values.length || 1));

/** A two-pole filter run in place, from the Audio EQ Cookbook. */
function biquad(values: Float32Array, kind: "highpass" | "lowpass", frequency: number, rate: number) {
  const w = (2 * Math.PI * frequency) / rate;
  const alpha = Math.sin(w) / Math.SQRT2;
  const cos = Math.cos(w);
  const b = kind === "highpass" ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2] : [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  const a = [1 + alpha, -2 * cos, 1 - alpha];
  let [x1, x2, y1, y2] = [0, 0, 0, 0];
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    const y = (b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2) / a[0];
    [x2, x1, y2, y1] = [x1, x, y1, y];
    values[i] = y;
  }
}

/** The room's pink noise as a share of the song's level in the mic's band: 30, 20 and 10 dB below it. */
const NOISE: Record<MicLevel, number> = { light: 0.03, medium: 0.1, loud: 0.3 };

/**
 * The song as a phone hears it across a room: a 40 ms room reverb, the room's pink noise, the mic's 300 to 6000 Hz
 * band and the phone's soft compression. Every step looks only backward in time and adds no delay, so the song keeps
 * its length and every onset its sample, and one truth serves the file and the mic.
 */
export function micColor(samples: Float32Array, level: MicLevel, rate = SAMPLE_RATE): Float32Array {
  const out = Float32Array.from(samples);
  const combs = [0.0113, 0.0187, 0.0271, 0.0367].map((seconds) => ({ line: new Float32Array(Math.round(seconds * rate)), at: 0, feedback: 10 ** ((-3 * seconds) / 0.3) }));
  for (let i = 0; i < out.length; i++) {
    let wet = 0;
    for (const comb of combs) {
      const delayed = comb.line[comb.at];
      comb.line[comb.at] = out[i] + delayed * comb.feedback;
      comb.at = (comb.at + 1) % comb.line.length;
      wet += delayed;
    }
    out[i] += 0.15 * wet;
  }
  const random = seeded(SEED + 1 + MIC_LEVELS.indexOf(level));
  const pink = new Float32Array(out.length);
  let [b0, b1, b2] = [0, 0, 0];
  for (let i = 0; i < pink.length; i++) {
    const white = random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    pink[i] = b0 + b1 + b2 + white * 0.1848;
  }
  // The band is a linear filter, so the song and the room are filtered apart and the room set by its level in the band.
  for (const values of [out, pink]) {
    biquad(values, "highpass", 300, rate);
    biquad(values, "lowpass", 6000, rate);
  }
  const gain = (NOISE[level] * rms(out)) / (rms(pink) || 1);
  for (let i = 0; i < out.length; i++) out[i] += gain * pink[i];
  const before = rms(out);
  const threshold = 1.5 * before;
  const attack = 1 - Math.exp(-1 / (0.005 * rate));
  const release = 1 - Math.exp(-1 / (0.1 * rate));
  let envelope = 0;
  for (let i = 0; i < out.length; i++) {
    const size = Math.abs(out[i]);
    envelope += (size - envelope) * (size > envelope ? attack : release);
    if (envelope > threshold) out[i] *= (threshold * (envelope / threshold) ** (1 / 3)) / envelope;
  }
  const makeUp = before / (rms(out) || 1);
  for (let i = 0; i < out.length; i++) out[i] *= makeUp;
  return out;
}

/** A 32-bit float WAV, so the samples read back exactly. */
export function writeWav(channels: Float32Array[], rate: number): Buffer {
  const frames = channels[0].length;
  const data = frames * channels.length * 4;
  const out = Buffer.alloc(58 + data);
  out.write("RIFF", 0);
  out.writeUInt32LE(50 + data, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(18, 16);
  out.writeUInt16LE(3, 20);
  out.writeUInt16LE(channels.length, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels.length * 4, 28);
  out.writeUInt16LE(channels.length * 4, 32);
  out.writeUInt16LE(32, 34);
  out.writeUInt16LE(0, 36);
  out.write("fact", 38);
  out.writeUInt32LE(4, 42);
  out.writeUInt32LE(frames, 46);
  out.write("data", 50);
  out.writeUInt32LE(data, 54);
  for (let i = 0; i < frames; i++) channels.forEach((channel, c) => out.writeFloatLE(channel[i], 58 + (i * channels.length + c) * 4));
  return out;
}

/** Reads PCM WAVs of 8, 16, 24 or 32 bits and float WAVs of 32 or 64 bits, plain or extensible, into one array a channel. */
export function readWav(bytes: Uint8Array): { sampleRate: number; channels: Float32Array[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (text(0) !== "RIFF" || text(8) !== "WAVE") throw new Error("not a WAV file");
  let format: { code: number; channels: number; rate: number; bits: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = text(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      const code = view.getUint16(body, true);
      format = { code: code === 0xfffe ? view.getUint16(body + 24, true) : code, channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    }
    if (id === "data") {
      if (!format) throw new Error("the WAV's data comes before its format");
      const { code, channels, rate, bits } = format;
      const width = bits / 8;
      const frames = Math.floor(Math.min(size, bytes.length - body) / (width * channels));
      const read = (offset: number) => {
        if (code === 3) return bits === 64 ? view.getFloat64(offset, true) : view.getFloat32(offset, true);
        if (code !== 1) throw new Error(`WAV format ${code} is not PCM or float`);
        if (bits === 8) return (view.getUint8(offset) - 128) / 128;
        if (bits === 16) return view.getInt16(offset, true) / 32768;
        if (bits === 24) return ((view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getInt8(offset + 2) << 16)) / 8388608);
        return view.getInt32(offset, true) / 2147483648;
      };
      const out = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) out[c][i] = read(body + (i * channels + c) * width);
      return { sampleRate: rate, channels: out };
    }
    at = body + size + (size % 2);
  }
  throw new Error("the WAV has no data");
}
