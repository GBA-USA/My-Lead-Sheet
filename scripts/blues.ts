/** No Half Steppin's chart form: a 12-bar blues in A. */
export const FORM = ["A7", "A7", "A7", "A7", "D7", "D7", "A7", "A7", "E7", "D7", "A7", "E7"];
export const BPM = 100;
export const HEAD = 2;
const TAIL = 2;
const ROOTS: Record<string, number> = { A7: 45, D7: 50, E7: 52, G7: 43 };

export interface Take {
  choruses: number;
  /** Pink noise's level as a share of the band's, on top of a faint room hiss. */
  noise: number;
  reverb: boolean;
  /** Beats of drums alone before bar 1, as in a count-off. */
  pickup: number;
  /** Bars, counted from 0, that hold only silence, only drums, or another chord than the form's. */
  swaps: Record<number, "silence" | "drums" | string>;
}

/** What each bar really holds: its chord, or null where no chord sounds. */
export function truthOf(take: Take): (string | null)[] {
  return Array.from({ length: take.choruses * 12 }, (_, bar) => {
    const swap = take.swaps[bar];
    return swap === "silence" || swap === "drums" ? null : (swap ?? FORM[bar % 12]);
  });
}

/**
 * A band in a room at 100 BPM: kick on 1 and 3, snare on 2 and 4, a bass walking root, 5th, b7, 5th, and a
 * keyboard striking the four chord tones on 1 and 3. Every other chorus is louder and adds eighth-note hats.
 */
export function blues(sampleRate: number, take: Take): Float32Array {
  const beat = 60 / BPM;
  const bars = take.choruses * 12;
  const end = HEAD + bars * 4 * beat;
  const out = new Float32Array(Math.round((end + TAIL) * sampleRate));
  let seed = 20261113;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 31) - 1;
  const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
  const add = (from: number, seconds: number, voice: (t: number) => number) => {
    const first = Math.round(from * sampleRate);
    const last = Math.min(out.length, first + Math.round(seconds * sampleRate));
    for (let i = first; i < last; i++) out[i] += voice((i - first) / sampleRate);
  };
  const tone = (midi: number, harmonics: number) => (t: number) => {
    let sum = 0;
    for (let k = 1; k <= harmonics; k++) sum += Math.sin(2 * Math.PI * k * hz(midi) * t) / k;
    return sum;
  };

  const truth = truthOf(take);
  for (let k = -take.pickup; k < bars * 4; k++) {
    const bar = Math.floor(k / 4);
    const b = k - bar * 4;
    const swap = take.swaps[bar];
    const chord = truth[bar];
    const big = Math.floor(bar / 12) % 2 === 1;
    const loud = big ? 1.2 : 0.6;
    const at = HEAD + k * beat;
    if (swap === "silence") continue;
    if (b % 2 === 0) add(at, 0.35, (t) => 0.5 * loud * Math.sin(2 * Math.PI * (50 * t + 0.9 * (1 - Math.exp(-t / 0.013)))) * Math.exp(-t / 0.1));
    else add(at, 0.2, (t) => 0.25 * loud * random() * Math.exp(-t / 0.06));
    for (const half of big ? [0, beat / 2] : []) add(at + half, 0.05, (t) => 0.08 * random() * Math.exp(-t / 0.015));
    if (!chord) continue;
    const root = ROOTS[chord];
    const bass = tone(root - 12 + [0, 7, 10, 7][b], 6);
    add(at, beat * 0.95, (t) => 0.22 * loud * bass(t) * Math.min(1, t / 0.005) * Math.exp(-t / 0.5));
    if (b % 2 === 0) {
      for (const step of [0, 4, 7, 10]) {
        const key = tone(root + 12 + step, 5);
        add(at, 2 * beat, (t) => 0.05 * loud * key(t) * Math.min(1, t / 0.003) * Math.exp(-t / 0.6));
      }
    }
  }

  if (take.reverb) {
    const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((seconds) => ({ delay: Math.round(seconds * sampleRate), line: new Float32Array(Math.round(seconds * sampleRate)), at: 0 }));
    const feedback = (delay: number) => 10 ** ((-3 * delay) / sampleRate / 0.8);
    for (let i = 0; i < out.length; i++) {
      let wet = 0;
      for (const comb of combs) {
        const delayed = comb.line[comb.at];
        comb.line[comb.at] = out[i] + delayed * feedback(comb.delay);
        comb.at = (comb.at + 1) % comb.delay;
        wet += delayed;
      }
      out[i] += 0.25 * wet;
    }
  }

  const rms = (values: Float32Array) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
  const pink = new Float32Array(out.length);
  for (let i = 1; i < pink.length; i++) pink[i] = 0.97 * pink[i - 1] + random();
  const gain = (take.noise * rms(out)) / (rms(pink) || 1);
  for (let i = 0; i < out.length; i++) out[i] += 0.002 * random() + gain * pink[i];
  return out;
}
