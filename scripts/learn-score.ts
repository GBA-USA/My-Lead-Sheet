import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chordAnchors, lyricWords, type Row } from "./chord-anchors.ts";
import { LYRICS } from "./learn-lyrics.ts";
import { parseChord, type Sidecar, type Truth } from "./learn-render.ts";
import type { Band, Listen } from "../src/learn-result.ts";

export { chartRows, lyricsOf, stripChords } from "./learn-render.ts";

/**
 * The scorecard: what a listen heard against the exact answers, row by row, and the fit of the color floors. Every
 * learn cook is judged by these rows; none writes its own.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
/** The floors the app draws colors by. src/learn-result.ts imports this file; --fit writes it. */
export const BANDS_FILE = join(root, "scripts", "learn-bands.json");
const app = await build({ entryPoints: [join(root, "src", "learn-result.ts")], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
const { bandOf } = (await import(`data:text/javascript,${encodeURIComponent(app.outputFiles[0].text)}`)) as typeof import("../src/learn-result.ts");

/** One heard change: how sure the listen said it was, and whether it was right. --fit reads these. */
export interface Call {
  confidence: number;
  right: boolean;
}

export interface Scorecard {
  /** Each row's number; null where the listen or the truth has nothing to score it by. */
  values: Record<string, number | null>;
  /** The rows as printed. */
  text: string[];
  calls: Call[];
}

export const TOLERANCE = 0.07;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const share = (hits: number, of: number) => (of ? hits / of : null);
const percent = (value: number | null) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
const fixed = (value: number | null, digits: number, unit = "") => (value === null ? "n/a" : `${value.toFixed(digits)}${unit}`);

/** The bar length a sidecar's downbeats and BPM imply. */
export const beatsPerBarOf = (truth: Sidecar) => Math.max(1, Math.round(((truth.downbeats[1] - truth.downbeats[0]) * truth.bpm) / 60) || 4);

/** How many of `truth` have one of `heard` within the tolerance, each heard time matched once. */
function matched(heard: number[], truth: number[]) {
  const used = new Set<number>();
  let hits = 0;
  for (const time of truth) {
    let best = -1;
    heard.forEach((each, i) => {
      if (!used.has(i) && Math.abs(each - time) <= TOLERANCE && (best < 0 || Math.abs(each - time) < Math.abs(heard[best] - time))) best = i;
    });
    if (best >= 0) {
      used.add(best);
      hits += 1;
    }
  }
  return hits;
}

const sameRoot = (heard: string | null, truth: string) => {
  if (truth === "N.C." || heard === null) return (truth === "N.C.") === (heard === null);
  const [a, b] = [parseChord(heard), parseChord(truth)];
  return !!a && !!b && a.root === b.root;
};
const sameMajorMinor = (heard: string | null, truth: string) => {
  if (!sameRoot(heard, truth)) return false;
  return heard === null || parseChord(heard)!.minor === parseChord(truth)!.minor;
};

export function scoreListen(listen: Listen | null, truth: Truth | Sidecar): Scorecard {
  const values: Record<string, number | null> = {};
  const text: string[] = [];
  const row = (name: string, value: number | null, shown: string) => {
    values[name] = value;
    text.push(`     ${name}: ${shown}`);
  };
  const perBar = beatsPerBarOf(truth);
  const bar = truth.downbeats.length > 1 ? truth.downbeats[truth.downbeats.length - 1] - truth.downbeats[truth.downbeats.length - 2] : (60 * perBar) / truth.bpm;
  const songEnd = truth.downbeats[truth.downbeats.length - 1] + bar;
  const beats = "beats" in truth ? truth.beats : null;
  const syllables = "syllables" in truth ? truth.syllables : null;
  const heardBeats = listen?.analysis.beats ?? [];
  const beatLength = (time: number) => {
    if (!beats || beats.length < 2) return 60 / truth.bpm;
    const k = Math.max(0, Math.min(beats.length - 2, beats.findLastIndex((beat) => beat <= time)));
    return beats[k + 1] - beats[k];
  };
  /** A time as bars from bar 1, by the truth's downbeats. */
  const barOf = (time: number) => {
    const downs = truth.downbeats;
    const k = Math.max(0, Math.min(downs.length - 1, downs.findLastIndex((down) => down <= time)));
    const span = downs[k + 1] !== undefined ? downs[k + 1] - downs[k] : bar;
    return k + (time - downs[k]) / span;
  };

  const coverage = listen ? Math.min(1, listen.coverage.heardSeconds / truth.durationSec) : 0;
  row("coverage", coverage, listen ? `${percent(coverage)} (heard ${listen.coverage.heardSeconds.toFixed(1)} of ${truth.durationSec.toFixed(1)} s, ${listen.coverage.stopped}, ${listen.coverage.quality})` : "0% (nothing heard)");

  const bpm = listen?.tempo.bpm ?? null;
  const octave = bpm === null ? "nothing heard" : Math.abs(bpm - truth.bpm) <= 2 ? "right" : Math.abs(bpm - 2 * truth.bpm) <= 2 ? "double" : Math.abs(bpm - truth.bpm / 2) <= 2 ? "half" : "wrong";
  const tempoRight = octave === "right";
  row("BPM at the right octave", listen ? Number(tempoRight) : null, bpm === null ? "n/a (nothing heard)" : `${tempoRight ? 1 : 0} (heard ${bpm.toFixed(1)}, truth ${truth.bpm}, ${octave})`);

  if (beats && listen) {
    const hits = matched(heardBeats, beats);
    const [precision, recall] = [share(hits, heardBeats.length) ?? 0, share(hits, beats.length) ?? 0];
    const f = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    row("beat F-measure at 70 ms", f, `${f.toFixed(2)} (precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)}, ${heardBeats.length} heard of ${beats.length})`);
  } else row("beat F-measure at 70 ms", null, listen ? "n/a (the sidecar has no beats)" : "n/a (nothing heard)");

  const phase = listen?.analysis.downbeatPhase ?? 0;
  const heardDowns = heardBeats.filter((_, k) => k >= phase && (k - phase) % perBar === 0);
  const downs = listen ? share(matched(heardDowns, truth.downbeats), truth.downbeats.length) : null;
  row("downbeat accuracy", downs, listen ? `${percent(downs)} of ${truth.downbeats.length} downbeats within 70 ms${heardDowns[0] !== undefined && Math.abs(heardDowns[0] - truth.downbeats[0]) <= TOLERANCE ? ", bar 1 found" : ", bar 1 missed"}` : "n/a (nothing heard)");

  const heardChanges = listen?.changes ?? [];
  const chordAt = (time: number) => heardChanges.findLast((change) => change.at <= time + 1e-9)?.chord ?? null;
  const truthAt = (time: number) => truth.changes.findLast((change) => change.at <= time + 1e-9)?.chord ?? "N.C.";
  const spans = truth.changes.map((change, i) => ({ ...change, middle: (change.at + (truth.changes[i + 1]?.at ?? songEnd)) / 2 }));
  if (heardChanges.length) {
    const roots = share(spans.filter((span) => sameRoot(chordAt(span.middle), span.chord)).length, spans.length);
    const qualities = share(spans.filter((span) => sameMajorMinor(chordAt(span.middle), span.chord)).length, spans.length);
    row("root accuracy per change", roots, `${percent(roots)} of ${spans.length} changes`);
    row("major-or-minor accuracy per change", qualities, `${percent(qualities)} of ${spans.length} changes`);
    const errors = truth.changes.map((change) => Math.min(...heardChanges.map((heard) => Math.abs(heard.at - change.at))) / beatLength(change.at));
    const error = median(errors);
    const sorted = [...errors].sort((a, b) => a - b);
    row("change-time error in beats", error, `median ${fixed(error, 2)}, 90th ${fixed(sorted[Math.floor(0.9 * (sorted.length - 1))] ?? null, 2)}`);
  } else {
    for (const name of ["root accuracy per change", "major-or-minor accuracy per change", "change-time error in beats"]) row(name, null, "n/a (no chords heard)");
  }

  const heardSections = [...(listen?.sections ?? [])].sort((a, b) => a.fromBeat - b.fromBeat);
  const heardTime = (beat: number) => heardBeats[beat] ?? (beat >= heardBeats.length ? songEnd : 0);
  if (heardSections.length) {
    const truthBounds = truth.sections.slice(1).map((section) => section.fromBar);
    const heardBounds = heardSections.slice(1).map((section) => barOf(heardTime(section.fromBeat)));
    const misses = truthBounds.map((bound) => Math.min(Infinity, ...heardBounds.map((heard) => Math.abs(heard - bound))));
    const error = median(misses.filter(Number.isFinite));
    const within = share(misses.filter((miss) => miss <= 1).length, truthBounds.length);
    row("section boundary error in bars", truthBounds.length ? (heardBounds.length ? error : null) : 0, `median ${fixed(truthBounds.length ? error : 0, 2)}, ${percent(within)} of ${truthBounds.length} boundaries within one bar`);
    const falses = heardBounds.filter((heard) => !truthBounds.some((bound) => Math.abs(heard - bound) <= 1)).length;
    row("false boundaries", falses, `${falses} of ${heardBounds.length} heard boundaries are over a bar from any true one`);
    const truthSpan = (section: Truth["sections"][number]) => ({ start: truth.downbeats[section.fromBar], end: truth.downbeats[section.toBar] ?? songEnd });
    const heardSpan = (section: (typeof heardSections)[number]) => ({ start: heardTime(section.fromBeat), end: heardTime(section.toBeat) });
    const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
    const matches = truth.sections.map((section) => {
      const span = truthSpan(section);
      return heardSections.reduce((best, heard) => (overlap(heardSpan(heard), span) > overlap(heardSpan(best), span) ? heard : best), heardSections[0]);
    });
    let [agree, pairs] = [0, 0];
    truth.sections.forEach((a, i) =>
      truth.sections.slice(i + 1).forEach((b, j) => {
        pairs += 1;
        if ((a.group === b.group) === (matches[i].group === matches[i + 1 + j].group)) agree += 1;
      }),
    );
    const grouping = share(agree, pairs);
    row("repeat grouping", grouping, `${percent(grouping)} of ${pairs} section pairs grouped alike`);
    const labels = share(truth.sections.filter((section, i) => matches[i].label === section.label).length, truth.sections.length);
    row("section label accuracy", labels, `${percent(labels)} of ${truth.sections.length} sections`);
  } else {
    for (const name of ["section boundary error in bars", "false boundaries", "repeat grouping", "section label accuracy"]) row(name, null, "n/a (no sections heard)");
  }

  const heardLines = listen?.lines ?? [];
  const lineCount = syllables ? new Set(syllables.map((syllable) => syllable.line)).size : 0;
  if (syllables && lineCount && heardLines.length) {
    const starts = new Map<number, number>();
    for (const syllable of syllables) if (!starts.has(syllable.line)) starts.set(syllable.line, syllable.at);
    const misses = heardLines.filter((line) => starts.has(line.line)).map((line) => Math.abs(line.start - starts.get(line.line)!) * 1000);
    const error = median(misses);
    row("line start error in ms", error, `median ${fixed(error, 0, " ms")} over ${misses.length} of ${lineCount} lines`);
    const words = new Map<number, number>();
    for (const syllable of syllables) words.set(syllable.line, Math.max(words.get(syllable.line) ?? 0, syllable.word + 1));
    const firstWord = new Map<number, number>();
    let count = 0;
    for (const line of [...words.keys()].sort((a, b) => a - b)) {
      firstWord.set(line, count);
      count += words.get(line)!;
    }
    /** The truth syllable a heard (line, word, column) falls in, by index, and its word across the song. */
    const place = (line: number, word: number, column: number) => {
      const own = syllables.map((syllable, index) => ({ ...syllable, index })).filter((syllable) => syllable.line === line && syllable.word === word);
      const hit = own.findLast((syllable) => syllable.column <= column) ?? own[0];
      return { index: hit?.index ?? null, word: (firstWord.get(line) ?? -Infinity) + word };
    };
    const heard = heardLines.flatMap((line) => line.syllables.map((syllable) => ({ ...syllable, line: line.line })));
    const sung = truth.changes.flatMap((change) => {
      const index = syllables.findIndex((syllable) => syllable.at === change.at);
      return index < 0 ? [] : [{ change, index }];
    });
    const placed = sung.map(({ change, index }) => {
      const near = heard.reduce((best, each) => (Math.abs(each.at - change.at) < Math.abs(best.at - change.at) ? each : best), heard[0]);
      const at = near ? place(near.line, near.word, near.column) : { index: null, word: -Infinity };
      const want = syllables[index];
      return { index: at.index === null ? Infinity : Math.abs(at.index - index), word: Math.abs(at.word - (firstWord.get(want.line)! + want.word)) };
    });
    const exact = share(placed.filter((each) => each.index === 0).length, placed.length);
    const oneSyllable = share(placed.filter((each) => each.index <= 1).length, placed.length);
    const oneWord = share(placed.filter((each) => each.word <= 1).length, placed.length);
    row("syllable placement exact", exact, `${percent(exact)} of ${placed.length} chords sung on a syllable`);
    row("syllable placement within one syllable", oneSyllable, `${percent(oneSyllable)} of ${placed.length}`);
    row("syllable placement within one word", oneWord, `${percent(oneWord)} of ${placed.length}`);
  } else {
    const why = !syllables ? "n/a (the sidecar has no syllables)" : !lineCount ? "n/a (nothing is sung)" : "n/a (no words timed)";
    for (const name of ["line start error in ms", "syllable placement exact", "syllable placement within one syllable", "syllable placement within one word"]) row(name, null, why);
  }

  const calls: Call[] = heardChanges.map((change, i) => {
    const middle = (change.at + (heardChanges[i + 1]?.at ?? songEnd)) / 2;
    return { confidence: change.confidence, right: sameMajorMinor(change.chord, truthAt(middle)) };
  });
  const judged: { band: Band; right: boolean; kind: string }[] = calls.map((call) => ({ band: bandOf(call.confidence), right: call.right, kind: "changes" }));
  if (listen) judged.push({ band: listen.tempo.band, right: tempoRight, kind: "tempo" });
  if (heardSections.length) {
    truth.sections.forEach((section) => {
      const start = truth.downbeats[section.fromBar];
      const heard = heardSections.find((each) => Math.abs(heardTime(each.fromBeat) - start) <= bar / 2);
      if (heard) judged.push({ band: heard.band, right: heard.label === section.label, kind: "sections" });
    });
  }
  if (syllables) {
    for (const line of heardLines) {
      for (const syllable of line.syllables) {
        const want = syllables.find((each) => each.line === line.line && each.word === syllable.word && each.column === syllable.column);
        judged.push({ band: syllable.band, right: !!want && Math.abs(want.at - syllable.at) <= TOLERANCE, kind: "syllables" });
      }
    }
  }
  for (const [name, band] of [["calibration green", "sure"], ["calibration yellow", "likely"], ["calibration red", "check"]] as const) {
    const own = judged.filter((each) => each.band === band);
    const right = share(own.filter((each) => each.right).length, own.length);
    const kinds = ["changes", "sections", "syllables", "tempo"].map((kind) => `${kind} ${own.filter((each) => each.kind === kind).length}`).join(", ");
    row(name, right, `${percent(right)} right of ${own.length} (${kinds})`);
  }
  return { values, text, calls };
}

/**
 * The lowest green floor at which green is right at least 90% of the time, and the lowest yellow floor at which
 * yellow, below green, is right at least 70%. No green floor qualifies: nothing is green (101). No yellow: yellow
 * starts where green does. Null with nothing to fit.
 */
export function fitBands(calls: Call[]): { sure: number; likely: number } | null {
  if (!calls.length) return null;
  const floors = [...new Set(calls.map((call) => call.confidence))].sort((a, b) => a - b);
  const rightShare = (from: number, below: number) => {
    const own = calls.filter((call) => call.confidence >= from && call.confidence < below);
    return own.length ? own.filter((call) => call.right).length / own.length : 0;
  };
  const sure = floors.find((floor) => rightShare(floor, Infinity) >= 0.9) ?? 101;
  const likely = floors.find((floor) => floor < sure && rightShare(floor, sure) >= 0.7) ?? sure;
  return { sure, likely };
}

/** Writes fitted floors into the bands file, keeping every other key, and marks it fitted. */
export function writeBands(floors: { sure: number; likely: number }, file = BANDS_FILE) {
  const bands = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(bands, { fitted: true, sure: floors.sure, likely: floors.likely });
  writeFileSync(file, `${JSON.stringify(bands, null, 2)}\n`);
}

/** Where each syllable of a word starts, by the hyphens in scripts/learn-lyrics.ts, else by its vowel groups. */
const MARKED_WORDS = new Map(
  Object.values(LYRICS).flatMap((lyric) =>
    lyric.lines.flatMap((line) =>
      line.split(" ").map((word) => {
        const starts: number[] = [];
        let at = 0;
        for (const part of word.split("-")) {
          starts.push(at);
          at += part.length;
        }
        return [word.replaceAll("-", "").toLowerCase(), starts] as const;
      }),
    ),
  ),
);
function syllableStarts(word: string): number[] {
  const marked = MARKED_WORDS.get(word.toLowerCase());
  if (marked) return marked;
  const starts = [0];
  const vowel = (i: number) => /[aeiouy]/i.test(word[i] ?? "") && !(i === 0 && /y/i.test(word[i]));
  for (let i = 1; i < word.length; i++) {
    if (!vowel(i) || vowel(i - 1)) continue;
    if (/e$/i.test(word) && i === word.length - 1) continue;
    let consonants = 0;
    while (i - consonants - 1 >= 0 && !vowel(i - consonants - 1) && /[a-z]/i.test(word[i - consonants - 1])) consonants += 1;
    if (i - consonants - 1 < 0) continue;
    starts.push(consonants >= 2 ? i - consonants + 1 : i - consonants);
  }
  return starts;
}

/**
 * The re-chart judge: each chord of `rebuilt` against the same chord of `original`, in reading order, by the word and
 * column `chordAnchors` names. Exact is the same anchor; within one syllable or one word counts syllables or words
 * across the song's lyrics.
 */
export function rechartRates(original: Row[], rebuilt: Row[]) {
  const words = lyricWords(original);
  const before: number[] = [0];
  for (const word of words) before.push(before[before.length - 1] + syllableStarts(word).length);
  const read = (anchor: string | undefined) => {
    const on = anchor && /^(\S+) on word (\d+) ".*" at (-?\d+)$/.exec(anchor);
    if (on) {
      const word = Number(on[2]) - 1;
      const syllable = syllableStarts(words[word] ?? "").filter((start) => start <= Number(on[3])).length - 1;
      return { chord: on[1], word, syllable: before[word] + Math.max(0, syllable) };
    }
    const after = anchor && /^(\S+) after word (\d+)$/.exec(anchor);
    return after ? { chord: after[1], word: Number(after[2]) - 0.5, syllable: before[Number(after[2])] - 0.5 } : null;
  };
  const [want, got] = [chordAnchors(original), chordAnchors(rebuilt)];
  let [exact, syllable, word] = [0, 0, 0];
  want.forEach((anchor, i) => {
    const [a, b] = [read(anchor), read(got[i])];
    if (!a || !b || a.chord !== b.chord) return;
    if (anchor === got[i]) exact += 1;
    if (Math.abs(a.syllable - b.syllable) <= 1) syllable += 1;
    if (Math.abs(a.word - b.word) <= 1) word += 1;
  });
  const of = want.length || 1;
  return { exact: exact / of, withinSyllable: syllable / of, withinWord: word / of, chords: want.length };
}
