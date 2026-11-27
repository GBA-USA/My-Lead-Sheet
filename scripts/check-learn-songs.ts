import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chordAnchors, type Row } from "./chord-anchors.ts";
import { FakeWorker, listenThrough } from "./fake-worker.ts";
import { LYRICS, plainLine } from "./learn-lyrics.ts";
import { DRUMS_ONLY, HEAD, MIC_LEVELS, SAMPLE_RATE, SILENCE, ScoreRefused, micColor, parseChord, readWav, render, sidecarOf, writeWav, type Score, type Truth } from "./learn-render.ts";
import { SONGS } from "./learn-songs.ts";
import { BANDS_FILE, chartRows, fitBands, lyricsOf, rechartRates, scoreListen, stripChords, writeBands, type Call } from "./learn-score.ts";
import type { FromWorker, HeardLine, Listen } from "../src/learn-result.ts";

/** A TESTS-FIRST case its cook has not landed yet: it runs and prints, but its FAIL does not fail check:learn-songs. */
type Pending = "pending until l3" | "pending until l5" | "pending until l8";
let failures = 0;
function check(ok: boolean, message: string, pending?: Pending) {
  if (pending && ok) {
    failures += 1;
    console.log(`FAIL ${message}: it holds now, so remove its "${pending}" mark`);
    return;
  }
  if (!ok && !pending) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}${pending ? ` (${pending})` : ""}`);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const fit = process.argv.includes("--fit");
const rate = SAMPLE_RATE;
const listenTo = (samples: Float32Array, name: string, beatsPerBar: number, lyrics: string | null) =>
  listenThrough(samples, rate, {
    beatsPerBar,
    lyrics,
    source: { kind: "file", name, stereo: false, sampleRate: rate },
    expectedSeconds: samples.length / rate,
    stopped: "finished",
  }).then((out) => out.listen);

// 1. A 24-bar song at 90 BPM: its truth is the score's, to the sample.
const susanna = LYRICS["oh-susanna"].lines.map(plainLine);
const TEST_SONG: Score = {
  title: "Test Song at 90",
  bpm: 90,
  beatsPerBar: 4,
  stereo: false,
  swing: false,
  strum: "light",
  bass: "root-fifth",
  sections: [
    { label: "INTRO", group: "A", bars: [["C"], ["C"], ["G7"], ["C"]] },
    { label: "VERSE", group: "B", bars: [["C"], ["C"], ["G"], ["G"], ["C"], ["C/E", "F"], ["G7"], ["C"]], lines: susanna.slice(0, 2) },
    { label: "CHORUS", group: "C", bars: [["F"], ["F"], ["C"], ["C"], ["C"], ["Am"], ["G7"], ["C"]], lines: susanna.slice(4, 6) },
    { label: "OUTRO", group: "D", bars: [["C"], [DRUMS_ONLY], ["F", "G"], ["C"]] },
  ],
};
const song = render(TEST_SONG);
const { truth } = song;
const bars = TEST_SONG.sections.flatMap((section) => section.bars);
const beatSample = (k: number) => Math.round((HEAD + (k * 60) / TEST_SONG.bpm) * rate);
const onSample = (time: number, sample: number) => Math.abs(time * rate - sample) < 1e-6;
check(song.samples instanceof Float32Array && Math.abs(song.samples.length / rate - truth.durationSec) < 1e-9, `the song renders to a Float32Array as long as its truth (${truth.durationSec.toFixed(3)} s)`);
check(bars.length === 24 && truth.bpm === 90, `the test song is 24 bars at 90 BPM (${bars.length} bars, ${truth.bpm} BPM)`);
check(truth.beats.length === 96 && truth.beats.every((time, k) => onSample(time, beatSample(k))), `the truth's 96 beats sit on the score's beat samples (${truth.beats.length} beats)`);
check(truth.downbeats.length === 24 && truth.downbeats.every((time, bar) => onSample(time, beatSample(4 * bar))), `the truth's 24 downbeats sit on each bar's first beat sample (${truth.downbeats.length})`);
const wantChanges: { sample: number; chord: string }[] = [];
bars.forEach((tokens, bar) =>
  tokens.forEach((token, k) => {
    const chord = token === SILENCE || token === DRUMS_ONLY ? "N.C." : token;
    if (wantChanges[wantChanges.length - 1]?.chord !== chord) wantChanges.push({ sample: beatSample(4 * bar + 2 * k), chord });
  }),
);
check(
  truth.changes.length === wantChanges.length && truth.changes.every((change, i) => change.chord === wantChanges[i].chord && onSample(change.at, wantChanges[i].sample)),
  `the truth's changes are the score's, a drums-only bar as N.C. and a second chord on beat 3 (${truth.changes.map((change) => change.chord).join(" ")})`,
);
const wantSections = [
  { fromBar: 0, toBar: 4, label: "INTRO", group: "A" },
  { fromBar: 4, toBar: 12, label: "VERSE", group: "B" },
  { fromBar: 12, toBar: 20, label: "CHORUS", group: "C" },
  { fromBar: 20, toBar: 24, label: "OUTRO", group: "D" },
];
check(JSON.stringify(truth.sections) === JSON.stringify(wantSections), `the truth's sections are the score's bars, labels and groups (${JSON.stringify(truth.sections)})`);
const hits = truth.beats.map((time) => Math.round(time * rate));
check(
  hits.every((sample) => song.stems.drums[sample - 1] === 0 && song.stems.drums[sample + 1] !== 0),
  "the drums start on each beat's own sample, silent the sample before",
);

// 2. The set covers the classes that failed before.
const tempos = SONGS.map((score) => score.bpm);
const strongAt = SONGS.filter((score) => score.strum === "strong").map((score) => score.bpm);
const tokens = SONGS.flatMap((score) => score.sections.flatMap((section) => section.bars.flat()));
const labelsOf = (score: Score) => score.sections.map((section) => section.label).filter((label) => label !== "INTRO" && label !== "OUTRO");
check(SONGS.length >= 24, `the set holds at least 24 songs (${SONGS.length})`);
check(Math.min(...tempos) === 55 && Math.max(...tempos) === 200, `tempos run from 55 to 200 BPM (${Math.min(...tempos)} to ${Math.max(...tempos)})`);
check(["none", "light", "strong"].every((strum) => SONGS.some((score) => score.strum === strum)), "strums none, light and strong are all in the set");
check([60, 76, 90, 110].every((bpm) => strongAt.includes(bpm)), `strong strums at 60, 76, 90 and 110 BPM (${[...new Set(strongAt)].sort((a, b) => a - b).join(", ")})`);
check(SONGS.some((score) => score.swing) && SONGS.some((score) => !score.swing), "both straight and swung songs");
check(tokens.some((token) => /^[A-G][#b]?(m|maj)?7/.test(token)), "sevenths");
check(tokens.some((token) => /^[A-G][#b]?[^/]*\/[A-G]/.test(token)), "slash chords");
check(SONGS.some((score) => score.sections.some((section) => section.bars.some((bar) => bar.length === 2))), "two chords in a bar");
check(tokens.includes(SILENCE) && tokens.includes(DRUMS_ONLY), "a silent bar and a drums-only bar");
check(SONGS.some((score) => score.tempoChangeAtBar && score.tempoChangeAtBar.bpm !== score.bpm), "a tempo change");
const NOTES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const transpose = (chord: string, by: number) =>
  chord.replace(/\b([A-G])([#b]?)/g, (_, letter: string, accidental: string) => {
    const pc = (NOTES[letter] + (accidental === "#" ? 1 : accidental === "b" ? -1 : 0) + by + 120) % 12;
    return ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"][pc];
  });
const sameChord = (a: string, b: string) => transpose(a, 0) === transpose(b, 0);
const keyChange = SONGS.some((score) =>
  score.sections.some((later, j) =>
    score.sections.slice(0, j).some((earlier) =>
      Array.from({ length: 11 }, (_, k) => k + 1).some(
        (by) => earlier.bars.length === later.bars.length && earlier.bars.every((bar, b) => bar.length === later.bars[b].length && bar.every((chord, c) => sameChord(transpose(chord, by), later.bars[b][c]))),
      ),
    ),
  ),
);
check(keyChange, "a key change: a later section plays an earlier one's chords moved to another key");
check(
  SONGS.some((score) => score.sections.some((section) => section.lines?.length) && score.sections[0].label === "INTRO" && !score.sections[0].lines?.length && score.sections[score.sections.length - 1].label === "OUTRO" && !score.sections[score.sections.length - 1].lines?.length),
  "a sung song opens with an intro and closes with an outro that have no voice",
);
const vcvcbc = SONGS.find((score) => labelsOf(score).join(" ") === "VERSE CHORUS VERSE CHORUS BRIDGE CHORUS");
const choruses = vcvcbc?.sections.filter((section) => section.label === "CHORUS") ?? [];
const changedBars = (a: string[][], b: string[][]) => a.filter((bar, i) => bar.join(" ") !== b[i]?.join(" ")).length + Math.abs(a.length - b.length);
check(
  !!vcvcbc && choruses.length === 3 && new Set(choruses.map((section) => section.group)).size === 1 && changedBars(choruses[0].bars, choruses[1].bars) === 0 && changedBars(choruses[0].bars, choruses[2].bars) === 1,
  `a V C V C B C form whose last chorus changes one bar and keeps its group (${vcvcbc?.title ?? "none"})`,
);

// 3. Sung songs carry words with known syllable times.
const lyricLines = new Set(Object.values(LYRICS).flatMap((lyric) => lyric.lines.map(plainLine)));
const sung = SONGS.filter((score) => score.sections.some((section) => section.lines?.length));
check(sung.length >= 12, `at least 12 songs are sung (${sung.length})`);
check(sung.every((score) => score.sections.every((section) => (section.lines ?? []).every((line) => lyricLines.has(line)))), "every sung line comes from scripts/learn-lyrics.ts");
check(
  Object.values(LYRICS).some((lyric) => /public domain/i.test(lyric.source)) && Object.values(LYRICS).some((lyric) => /nonsense/i.test(lyric.source)),
  "the lyrics hold public-domain texts and nonsense lines, each with its source",
);
const songLines = (song.lyrics ?? "").split("\n").filter((line) => line.trim());
const wordAt = (line: string, column: number) => [...line.slice(0, column + 1).matchAll(/\S+/g)].length - 1;
check(
  truth.syllables.length > 0 &&
    truth.syllables.every((syllable) => {
      const line = songLines[syllable.line] ?? "";
      return /\S/.test(line[syllable.column] ?? "") && wordAt(line, syllable.column) === syllable.word;
    }),
  `each syllable names its line, word and column in the song's words (${truth.syllables.length} syllables over ${songLines.length} lines)`,
);
check(truth.syllables.every((syllable, i) => i === 0 || syllable.at > truth.syllables[i - 1].at), "syllables are sung in order");
const voiced = truth.syllables.map((syllable) => Math.round(syllable.at * rate));
check(
  truth.syllables.every((syllable, i) => onSample(syllable.at, voiced[i]) && song.stems.voice[voiced[i] - 1] === 0 && song.stems.voice[voiced[i] + 1] !== 0),
  "the voice starts each syllable on its own sample, silent the sample before",
);
const rows: Row[] = chartRows(song.chart);
check(JSON.stringify(truth.anchors) === JSON.stringify(chordAnchors(rows)) && truth.anchors.length > 0, `Truth.anchors is chordAnchors of the chart the score implies (${truth.anchors.length} anchors, first ${truth.anchors[0]})`);
const lineSpans = songLines.map((_, line) => {
  const own = truth.syllables.filter((syllable) => syllable.line === line);
  return { start: own[0]?.at ?? Infinity, end: own[own.length - 1]?.at ?? -Infinity };
});
const sungChanges = truth.changes.filter((change) => lineSpans.some((span) => change.at >= span.start && change.at <= span.end));
check(
  sungChanges.length > 0 && sungChanges.every((change) => truth.syllables.some((syllable) => syllable.at === change.at)),
  `each change inside a sung line starts on a syllable, so its chord sits over the syllable sung (${sungChanges.length} changes)`,
);
for (const [what, broken] of [
  ["a score with no bars", { ...TEST_SONG, title: "No Bars", sections: [] }],
  ["a section with no bars", { ...TEST_SONG, title: "Empty Verse", sections: [{ label: "VERSE", group: "A", bars: [] }] }],
  ["words that do not fit their bars", { ...TEST_SONG, title: "Too Many Words", sections: [{ label: "VERSE", group: "A", bars: [["C"]], lines: [susanna[0]] }] }],
] as const) {
  let refused: unknown = null;
  try {
    render(broken as Score);
  } catch (error) {
    refused = error;
  }
  const words = what === "words that do not fit their bars" ? susanna[0] : "";
  check(refused instanceof ScoreRefused && refused.message.includes(broken.title) && refused.message.includes(words), `${what} is refused with the song's name${words ? " and the line" : ""} (${refused instanceof Error ? refused.message : "rendered"})`);
}

// 4. The mic coloring keeps the song's length, beats and syllable times.
const envelope = (samples: Float32Array) => {
  const hop = 64;
  const energy = Array.from({ length: Math.floor(samples.length / hop) }, (_, f) => {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) sum += samples[i] * samples[i];
    return Math.log(1e-9 + sum);
  });
  return energy.map((value, f) => Math.max(0, value - (energy[f - 1] ?? value)));
};
const lagOf = (a: number[], b: number[]) => {
  let best = { lag: 0, score: -Infinity };
  for (let lag = -20; lag <= 20; lag++) {
    let score = 0;
    for (let f = 20; f < a.length - 20; f++) score += a[f] * b[f + lag];
    if (score > best.score) best = { lag, score };
  }
  return best.lag;
};
const correlation = (a: Float32Array, b: Float32Array) => {
  let [ab, aa, bb] = [0, 0, 0];
  for (let i = 0; i < a.length; i++) [ab, aa, bb] = [ab + a[i] * b[i], aa + a[i] * a[i], bb + b[i] * b[i]];
  return ab / Math.sqrt(aa * bb);
};
const cleanBeats = envelope(song.samples);
const cleanVoice = envelope(song.stems.voice);
const likeness: number[] = [];
for (const level of MIC_LEVELS) {
  const mic = micColor(song.samples, level);
  const voice = micColor(song.stems.voice, level);
  likeness.push(correlation(song.samples, mic));
  check(mic.length === song.samples.length, `mic coloring at ${level} noise keeps the song's length (${mic.length} of ${song.samples.length} samples)`);
  const beatLag = lagOf(cleanBeats, envelope(mic));
  const voiceLag = lagOf(cleanVoice, envelope(voice));
  check(beatLag === 0 && voiceLag === 0, `mic coloring at ${level} noise moves no onset, the beats' or the syllables' (lags ${beatLag} and ${voiceLag} frames of 64 samples)`);
}
check(MIC_LEVELS.length === 3 && likeness[0] > likeness[1] && likeness[1] > likeness[2], `the three noise levels color the song more each time (likeness ${likeness.map((value) => value.toFixed(3)).join(", ")})`);

// 5. The scorecard reads a Listen and a Truth and prints every row.
const ROWS = [
  "coverage",
  "BPM at the right octave",
  "beat F-measure at 70 ms",
  "downbeat accuracy",
  "root accuracy per change",
  "major-or-minor accuracy per change",
  "change-time error in beats",
  "section boundary error in bars",
  "false boundaries",
  "repeat grouping",
  "section label accuracy",
  "line start error in ms",
  "syllable placement exact",
  "syllable placement within one syllable",
  "syllable placement within one word",
  "calibration green",
  "calibration yellow",
  "calibration red",
];
const beatOf = (time: number, of: Truth) => of.beats.findIndex((beat) => Math.abs(beat - time) < 1e-9);
/** What a listen that heard everything right would say. */
function perfectListen(of: Truth, beatsPerBar: number, shift = 0, bpmBy = 1, transposeBy = 0): Listen {
  const lines: HeardLine[] = [];
  for (const syllable of of.syllables) {
    const line = (lines[syllable.line] ??= { line: syllable.line, start: syllable.at + shift, end: syllable.at + shift, syllables: [] });
    line.end = syllable.at + shift;
    line.syllables.push({ at: syllable.at + shift, word: syllable.word, column: syllable.column, band: "sure" });
  }
  return {
    source: { kind: "file", name: "perfect.wav", stereo: false, sampleRate: rate },
    coverage: { heardSeconds: of.durationSec, expectedSeconds: of.durationSec, stopped: "finished", quality: "clear" },
    analysis: {
      sound: { start: of.beats[0], end: of.durationSec },
      beats: of.beats.map((beat) => beat + shift),
      tempos: [{ at: of.beats[0], bpm: of.bpm * bpmBy }],
      downbeatPhase: 0,
      vocals: [],
      chroma: [],
      voiceOnsets: new Float32Array(0),
      novelty: [],
    },
    tempo: { bpm: of.bpm * bpmBy, choices: [{ bpm: of.bpm * bpmBy, feel: "as heard", score: 1 }], band: "sure" },
    changes: of.changes.map((change) => ({
      beat: beatOf(change.at, of),
      at: change.at + shift,
      chord: change.chord === "N.C." ? null : transpose(change.chord, transposeBy),
      confidence: 100,
      alternatives: [],
      evidence: { bass: null, tones: [], stable: 1 },
    })),
    sections: of.sections.map((section, i) => ({
      fromBeat: section.fromBar * beatsPerBar,
      toBeat: section.toBar * beatsPerBar,
      group: section.group,
      label: section.label as Listen["sections"][number]["label"],
      number: i + 1,
      band: "sure",
    })),
    lines: lines.filter(Boolean),
  };
}
const perfect = scoreListen(perfectListen(truth, 4), truth);
const printed = perfect.text.join("\n");
check(ROWS.every((row) => printed.includes(row)), `the scorecard prints every row (missing: ${ROWS.filter((row) => !printed.includes(row)).join(", ") || "none"})`);
const want: Record<string, number | null> = {
  coverage: 1,
  "BPM at the right octave": 1,
  "beat F-measure at 70 ms": 1,
  "downbeat accuracy": 1,
  "root accuracy per change": 1,
  "major-or-minor accuracy per change": 1,
  "change-time error in beats": 0,
  "section boundary error in bars": 0,
  "false boundaries": 0,
  "repeat grouping": 1,
  "section label accuracy": 1,
  "line start error in ms": 0,
  "syllable placement exact": 1,
  "syllable placement within one syllable": 1,
  "syllable placement within one word": 1,
  "calibration green": 1,
  "calibration yellow": null,
  "calibration red": null,
};
const off = Object.keys(want).filter((row) => perfect.values[row] !== want[row]);
check(off.length === 0, `a listen that heard the truth scores perfectly on every row (off: ${off.map((row) => `${row} ${perfect.values[row]}`).join(", ") || "none"})`);
const late = scoreListen(perfectListen(truth, 4, 0.1), truth);
check(late.values["beat F-measure at 70 ms"] === 0 && late.values["downbeat accuracy"] === 0, `beats 100 ms late miss the 70 ms window (F ${late.values["beat F-measure at 70 ms"]}, downbeats ${late.values["downbeat accuracy"]})`);
const doubled = scoreListen(perfectListen(truth, 4, 0, 2), truth);
check(doubled.values["BPM at the right octave"] === 0 && doubled.text.some((line) => line.includes("BPM at the right octave") && line.includes("double")), `a doubled BPM is the wrong octave and says double (${doubled.text.find((line) => line.includes("BPM"))})`);
const wrongKey = scoreListen(perfectListen(truth, 4, 0, 1, 2), truth);
check(wrongKey.values["root accuracy per change"]! < 0.2, `chords heard a tone off miss their roots (${wrongKey.values["root accuracy per change"]})`);
const nothing = scoreListen(null, truth);
check(ROWS.every((row) => nothing.text.join("\n").includes(row)) && nothing.values.coverage === 0, "a listen that heard nothing still prints every row, with no coverage");

// 6. The scorecard fits the color floors.
const calls: Call[] = [
  ...Array.from({ length: 10 }, () => ({ confidence: 95, right: true })),
  ...Array.from({ length: 10 }, (_, i) => ({ confidence: 90, right: i < 9 })),
  ...Array.from({ length: 10 }, (_, i) => ({ confidence: 80, right: i < 7 })),
  ...Array.from({ length: 10 }, (_, i) => ({ confidence: 70, right: i < 8 })),
  ...Array.from({ length: 10 }, (_, i) => ({ confidence: 50, right: i < 2 })),
];
const fitted = fitBands(calls);
check(fitted?.sure === 90 && fitted?.likely === 70, `hand-built confidences fit green from 90 and yellow from 70 (${JSON.stringify(fitted)})`);
check(fitBands([]) === null, "with no confidences there is nothing to fit");
check(perfect.calls.length === truth.changes.length && perfect.calls.every((call) => call.right && call.confidence === 100), `the scorecard hands --fit one call per heard change (${perfect.calls.length})`);
const bandsCopy = join(mkdtempSync(join(tmpdir(), "learn-bands-")), "learn-bands.json");
copyFileSync(BANDS_FILE, bandsCopy);
const before = JSON.parse(readFileSync(bandsCopy, "utf8"));
writeBands({ sure: 90, likely: 70 }, bandsCopy);
const after = JSON.parse(readFileSync(bandsCopy, "utf8"));
check(
  after.sure === 90 && after.likely === 70 && after.fitted === true && Object.keys(before).every((key) => key in after) && JSON.stringify(after.quality) === JSON.stringify(before.quality),
  `--fit writes the floors, sets fitted and keeps every key (${JSON.stringify({ sure: after.sure, likely: after.likely, fitted: after.fitted })})`,
);
check(
  resolve(BANDS_FILE) === resolve(root, "scripts", "learn-bands.json") && readFileSync(join(root, "src", "learn-result.ts"), "utf8").includes('from "../scripts/learn-bands.json"'),
  "the floors --fit writes are the file src/learn-result.ts reads",
);

// 7. The same result scores the same way twice, and a song renders the same way twice.
const again = render(TEST_SONG);
const sameSamples = again.samples.length === song.samples.length && again.samples.every((value, i) => value === song.samples[i]);
check(sameSamples && JSON.stringify(again.truth) === JSON.stringify(truth), "a song renders to the same samples and truth twice (one fixed seed)");
const micTwice = micColor(song.samples, "loud");
check(micColor(song.samples, "loud").every((value, i) => value === micTwice[i]), "the mic coloring adds the same noise twice");
const heard = await listenTo(song.samples, "test-song.wav", 4, song.lyrics);
const first = scoreListen(heard, truth);
const second = scoreListen(heard, truth);
check(JSON.stringify(first) === JSON.stringify(second), "the scorecard scores the same listen the same way twice");

// 8. A WAV written by the generator reads back sample-exact.
for (const channels of [[song.samples], [song.stems.voice, song.stems.drums]]) {
  const back = readWav(writeWav(channels, rate));
  const exact = back.sampleRate === rate && back.channels.length === channels.length && back.channels.every((channel, c) => channel.length === channels[c].length && channel.every((value, i) => value === channels[c][i]));
  check(exact, `a ${channels.length === 1 ? "mono" : "stereo"} WAV reads back sample-exact`);
}

// 9. to 11. The local lane.
const lane = (...args: string[]) => {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", join(root, "scripts", "check-learn-local.ts"), ...args], { cwd: root, encoding: "utf8", timeout: 600_000 });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
};
const songsDir = join(root, "learn-songs");
const ownSongs = existsSync(songsDir) && readdirSync(songsDir).some((name) => /\.wav$/i.test(name));
const empty = ownSongs ? lane("--dir", mkdtempSync(join(tmpdir(), "learn-local-empty-"))) : lane();
check(
  empty.status === 0 && (ownSongs ? /^skip {2}no songs in /m.test(empty.out) : empty.out.split(/\r?\n/).includes("skip  no songs in learn-songs/")),
  `the local lane skips an empty folder with a visible line and exit 0 (${empty.status}: ${empty.out.trim().split(/\r?\n/)[0]})`,
);
const local = mkdtempSync(join(tmpdir(), "learn-local-"));
writeFileSync(join(local, "test-song.wav"), writeWav([song.samples], rate));
writeFileSync(join(local, "test-song.json"), JSON.stringify(sidecarOf(truth), null, 2));
const { changes: _dropped, ...noChanges } = sidecarOf(truth);
writeFileSync(join(local, "broken.wav"), writeWav([song.samples.subarray(0, rate)], rate));
writeFileSync(join(local, "broken.json"), JSON.stringify(noChanges));
const badInputs: [string, string, string, RegExp][] = [
  ["bad-chart", JSON.stringify(sidecarOf(truth)), "{not json", /bad-chart\.song\.json is not JSON/],
  ["no-body", JSON.stringify(sidecarOf(truth)), JSON.stringify({ title: "no body" }), /no-body\.song\.json has no "body"/],
  ["null-changes", JSON.stringify({ ...sidecarOf(truth), changes: null }), "", /"changes" is not a list/],
  ["string-downbeats", JSON.stringify({ ...sidecarOf(truth), downbeats: "1, 2" }), "", /"downbeats" is not a list/],
  ["not-object", "null", "", /not-object\.json is not an object/],
];
for (const [name, sidecar, chart] of badInputs) {
  writeFileSync(join(local, `${name}.wav`), writeWav([song.samples.subarray(0, rate)], rate));
  writeFileSync(join(local, `${name}.json`), sidecar);
  if (chart) writeFileSync(join(local, `${name}.song.json`), chart);
}
const scored = lane("--dir", local);
const inMemory = scoreListen(await listenTo(song.samples, "test-song.wav", 4, null), sidecarOf(truth));
const lines = scored.out.split(/\r?\n/);
const missing = inMemory.text.filter((line) => !lines.includes(line));
check(scored.status === 0 && missing.length === 0, `the local lane scores a WAV against its sidecar with the in-memory numbers (${missing.length} of ${inMemory.text.length} rows differ${missing.length ? `, first: ${missing[0]}` : ""})`);
check(lines.some((line) => line.startsWith("skip  broken.wav") && line.includes('"changes"')), `a sidecar missing a field says which and is skipped (${lines.find((line) => line.startsWith("skip  broken")) ?? "no line"})`);
for (const [name, , , says] of badInputs) {
  const line = lines.find((each) => each.startsWith(`skip  ${name}.wav: `));
  check(scored.status === 0 && !!line && says.test(line) && !/\n\s+at /.test(scored.out), `a bad hand-written ${name} file is skipped with a line naming what is wrong, and the lane goes on (${line ?? `exit ${scored.status}: ${scored.out.trim().split(/\r?\n/).find((each) => /Error/.test(each)) ?? "no line"}`})`);
}

const original = chartRows(song.chart);
const stripped = stripChords(song.chart);
check(
  stripped.every((section) => section.lines.every((line) => !line.chords && !line.bars)) && lyricsOf(stripped) === song.lyrics && lyricsOf(song.chart) === song.lyrics,
  "stripping a chart drops its chord lines and leaves its words exactly as they were",
);
const same = rechartRates(original, original);
check(same.exact === 1 && same.withinSyllable === 1 && same.withinWord === 1 && same.chords === truth.anchors.length, `the re-chart judge reads 100% for a rebuilt chart that matches (${JSON.stringify(same)})`);
/** Each chord moved to the start of the word `by` words later in its row, or its last word, by the columns `at` names. */
const moved = (by: number): Row[] =>
  original.map((row) => {
    const words = [...(row.lyrics ?? "").matchAll(/\S+/g)];
    const at = [...row.chords.matchAll(/\S+/g)].map((chord) => {
      const word = words.findIndex((each) => each.index + each[0].length > chord.index);
      return words[Math.min(words.length - 1, word + by)]?.index ?? chord.index;
    });
    return { ...row, at };
  });
const nextWord = rechartRates(original, moved(1));
check(nextWord.exact < 0.5 && nextWord.withinWord === 1, `chords one word late are rarely exact but all within one word (${JSON.stringify(nextWord)})`);
const farOff = rechartRates(original, moved(3));
check(farOff.withinWord < 0.5, `chords three words late are not within one word (${JSON.stringify(farOff)})`);
writeFileSync(join(local, "test-song.song.json"), JSON.stringify({ title: TEST_SONG.title, body: song.chart }, null, 2));
const rechart = lane("--rechart", "--dir", local);
check(
  rechart.status === 0 && rechart.out.split(/\r?\n/).some((line) => line.startsWith("rechart test-song.wav") && line.includes("exact 100%, within one syllable 100%, within one word 100%")),
  `check:learn-local --rechart rebuilds the generated song's chart at 100% (${rechart.out.split(/\r?\n/).find((line) => /test-song/.test(line) && /rechart|skip/.test(line)) ?? "no line"})`,
  "pending until l8",
);

// The whole set, clean and through the mic, for the gates later cooks read and for --fit.
interface SetRun {
  score: Score;
  take: ReturnType<typeof render>;
  kind: string;
  listen: Listen | null;
  card: ReturnType<typeof scoreListen>;
}
const setCalls: Call[] = [];
const table: string[] = [];
const runs: SetRun[] = [];
/** The clean file of each song heard with no words, for the labels the audio alone gives. */
const wordless: SetRun[] = [];
let rendered = 0;
for (const score of SONGS) {
  let take: ReturnType<typeof render>;
  try {
    take = render(score);
  } catch (error) {
    check(false, `${score.title} renders (${error instanceof Error ? error.message : error})`);
    continue;
  }
  rendered += 1;
  for (const [kind, samples] of [["file", take.samples], ...MIC_LEVELS.map((level) => [`mic ${level}`, micColor(take.samples, level)] as const)] as const) {
    const listen = await listenTo(samples, `${score.title}.wav`, score.beatsPerBar, take.lyrics);
    const card = scoreListen(listen, take.truth);
    runs.push({ score, take, kind, listen, card });
    if (kind === "file" && !take.lyrics) wordless.push(runs[runs.length - 1]);
    setCalls.push(...card.calls);
    const cell = (row: string) => (card.values[row] === null ? "-" : Number(card.values[row]).toFixed(2));
    table.push(`| ${score.title} | ${kind} | ${score.bpm} | ${cell("BPM at the right octave")} | ${cell("beat F-measure at 70 ms")} | ${cell("downbeat accuracy")} | ${cell("root accuracy per change")} | ${cell("section boundary error in bars")} | ${cell("line start error in ms")} | ${cell("syllable placement exact")} |`);
  }
  if (take.lyrics) {
    const listen = await listenTo(take.samples, `${score.title}.wav`, score.beatsPerBar, null);
    wordless.push({ score, take, kind: "file, no words", listen, card: scoreListen(listen, take.truth) });
  }
}
check(rendered === SONGS.length, `every song in the set renders (${rendered} of ${SONGS.length})`);
console.log("\n| song | case | BPM | BPM right | beat F | downbeats | roots | boundary bars | line start ms | syllables exact |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const row of table) console.log(row);
console.log(`\n${setCalls.length} heard changes with a confidence across the set`);

// TESTS-FIRST for learn wave B: the set's gates for L3 (chords), L5 (sections) and L8 (words) in LEARN-PLAN.md, each
// line starting with its pass condition's number. They read only the Listen each song gives through the worker.
const clean = runs.filter((run) => run.kind === "file");
const mics = runs.filter((run) => run.kind.startsWith("mic"));
const pooledShare = (parts: { value: number | null; of: number }[]) => {
  const of = parts.reduce((sum, part) => sum + part.of, 0);
  return of ? parts.reduce((sum, part) => sum + (part.value ?? 0) * part.of, 0) / of : 0;
};
const middle = (values: number[]) => (values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null);
const pct = (value: number | null) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
const barLength = (truth: Truth) => truth.downbeats[truth.downbeats.length - 1] - truth.downbeats[truth.downbeats.length - 2];
const songEnd = (truth: Truth) => truth.downbeats[truth.downbeats.length - 1] + barLength(truth);
const soundingAt = (listen: Listen | null, time: number) => (listen?.changes ?? []).filter((change) => change.at <= time + 1e-9).at(-1) ?? null;
const rootOf = (name: string | null | undefined) => (name ? (parseChord(name)?.root ?? null) : null);
const L3: Pending = "pending until l3";
const L5: Pending = "pending until l5";
const L8: Pending = "pending until l8";

{
  const twoBar = clean.find((run) => run.score.title === "Two a Bar")!;
  const { truth } = twoBar.take;
  const beat = 60 / truth.bpm;
  const midBar = truth.changes.filter((change) => truth.downbeats.every((down) => Math.abs(down - change.at) > beat / 2));
  const split = midBar.filter((change) => {
    const heard = (twoBar.listen?.changes ?? []).find((each) => Math.abs(each.at - change.at) <= beat / 2);
    const down = truth.downbeats.filter((each) => each < change.at).at(-1)!;
    return !!heard?.chord && heard.chord !== soundingAt(twoBar.listen, down + beat / 4)?.chord;
  });
  const errors = clean.flatMap((run) => run.take.truth.changes.map((change) => Math.min(...(run.listen?.changes ?? []).map((heard) => Math.abs(heard.at - change.at))) / (60 / run.take.truth.bpm)));
  const error = middle(errors.filter(Number.isFinite));
  check(
    midBar.length > 0 && split.length === midBar.length && error !== null && error < 0.5,
    `L3.2 changes fall on beats and a bar can hold two: ${split.length} of ${twoBar.score.title}'s ${midBar.length} beat-3 changes are heard there as a second chord, and the change-time error is ${error === null ? "n/a" : error.toFixed(2)} beats in the middle (want under 0.5)`,
    L3,
  );
}
{
  const changesOf = (run: SetRun) => run.take.truth.changes.length;
  const roots = pooledShare(clean.map((run) => ({ value: run.card.values["root accuracy per change"], of: changesOf(run) })));
  const qualities = pooledShare(clean.map((run) => ({ value: run.card.values["major-or-minor accuracy per change"], of: changesOf(run) })));
  check(roots >= 0.85 && qualities >= 0.75, `L3.3 clean songs read the root right in ${pct(roots)} of changes and major or minor in ${pct(qualities)} (want 85% and 75%)`, L3);
  const micRoots = pooledShare(mics.map((run) => ({ value: run.card.values["root accuracy per change"], of: changesOf(run) })));
  check(micRoots >= 0.6, `L3.4 mic-colored songs read the root right in ${pct(micRoots)} of changes (want 60%)`, L3);
}
{
  const floors = JSON.parse(readFileSync(BANDS_FILE, "utf8")) as { fitted: boolean; sure: number; likely: number };
  const green = setCalls.filter((call) => call.confidence >= floors.sure);
  const yellow = setCalls.filter((call) => call.confidence >= floors.likely && call.confidence < floors.sure);
  const rightIn = (calls: Call[]) => (calls.length ? calls.filter((call) => call.right).length / calls.length : null);
  const refit = fitBands(setCalls);
  const committed = floors.fitted && refit?.sure === floors.sure && refit?.likely === floors.likely;
  check(
    (rightIn(green) ?? 0) >= 0.9 && (rightIn(yellow) ?? 0) >= 0.7 && committed,
    `L3.5 green is right ${pct(rightIn(green))} of ${green.length} and yellow ${pct(rightIn(yellow))} of ${yellow.length} at the committed floors, green from ${floors.sure} and yellow from ${floors.likely}, which ${committed ? "are" : "are not"} what --fit gives the set now (${JSON.stringify(refit)}, fitted ${floors.fitted})`,
    L3,
  );
}
{
  const spans = clean.flatMap((run) => {
    const { truth } = run.take;
    return truth.changes.flatMap((change, i) => (change.chord === "N.C." ? [] : [soundingAt(run.listen, (change.at + (truth.changes[i + 1]?.at ?? songEnd(truth))) / 2)]));
  });
  const unsure = spans.filter((heard) => !heard?.chord).length / (spans.length || 1);
  check(unsure <= 0.25, `L3.6 no more than 25% of changes are unsure on clean songs (${pct(unsure)} of ${spans.length})`, L3);
}
{
  const run = clean.find((each) => each.score.title === "Gather at the River")!;
  const { truth } = run.take;
  const choruses = truth.sections.filter((section) => section.label === "CHORUS").map((section) => section.fromBar + 5);
  const heard = choruses.map((bar) => soundingAt(run.listen, truth.downbeats[bar] + barLength(truth) / 2)?.chord ?? null);
  check(
    choruses.length === 3 && rootOf(heard[0]) === 4 && rootOf(heard[1]) === 4 && rootOf(heard[2]) === 9,
    `L5.10 repeats with different chords keep their own chords: the last chorus's changed bar reads its Am while the first two read Em (${heard.map((chord) => chord ?? "?").join(", ")})`,
    L3,
  );
}
{
  const stereo = SONGS.find((score) => score.stereo && score.sections.some((section) => section.lines?.length))!;
  const take = render(stereo);
  const mono = await listenTo(take.samples, `${stereo.title}.wav`, stereo.beatsPerBar, take.lyrics);
  const both = await new Promise<Listen | null>((resolve, reject) => {
    const worker = new FakeWorker("learn-worker.ts");
    worker.onerror = (event) => (worker.terminate(), reject(event.error));
    worker.onmessage = ({ data }) => {
      const reply = data as FromWorker;
      if (reply.kind !== "done") return;
      worker.terminate();
      resolve(reply.listen);
    };
    for (let at = 0; at < take.samples.length; at += rate) {
      const chunk = take.samples.slice(at, at + rate);
      const [left, right] = take.stereo!.map((channel) => channel.slice(at, at + rate));
      worker.postMessage({ kind: "samples", chunk, sampleRate: rate }, [chunk.buffer]);
      worker.postMessage({ kind: "stereo", left, right }, [left.buffer, right.buffer]);
    }
    worker.postMessage({ kind: "finish", beatsPerBar: stereo.beatsPerBar, lyrics: take.lyrics, source: { kind: "file", name: `${stereo.title}.wav`, stereo: true, sampleRate: rate }, expectedSeconds: take.samples.length / rate, stopped: "finished" });
  });
  const { source: _mono, ...heardMono } = mono ?? { source: null };
  const { source: _both, ...heardBoth } = both ?? { source: null };
  check(
    !!mono && JSON.stringify(heardBoth) === JSON.stringify(heardMono),
    `L3.11 the side view is used only when the source is stereo and only if the A/B keeps it: no A/B has kept it, so ${stereo.title} heard with both channels gives what its mono mix gives`,
  );
}

/** Each true section boundary as bars from bar 1, and each heard one by the truth's downbeats. */
const boundaries = (run: SetRun) => {
  const { truth } = run.take;
  const barOf = (time: number) => {
    const k = Math.max(0, truth.downbeats.findLastIndex((down) => down <= time));
    return k + (time - truth.downbeats[k]) / barLength(truth);
  };
  const beats = run.listen?.analysis.beats ?? [];
  const heard = [...(run.listen?.sections ?? [])].sort((a, b) => a.fromBeat - b.fromBeat).slice(1).map((section) => barOf(beats[section.fromBeat] ?? songEnd(truth)));
  return { truth: truth.sections.slice(1).map((section) => section.fromBar), heard };
};
{
  const found = clean.map((run) => {
    const { truth, heard } = boundaries(run);
    return { value: truth.length ? truth.filter((bound) => heard.some((each) => Math.abs(each - bound) <= 1)).length / truth.length : 1, of: truth.length };
  });
  const share = pooledShare(found);
  check(share >= 0.7, `L5.2 at least 70% of true boundaries are found within one bar on the set (${pct(share)} of ${found.reduce((sum, each) => sum + each.of, 0)})`, L5);
  const falses = clean.map((run) => {
    const { truth, heard } = boundaries(run);
    return { title: run.score.title, count: heard.filter((each) => !truth.some((bound) => Math.abs(each - bound) <= 1)).length };
  });
  const over = falses.filter((each) => each.count > 1);
  check(over.length === 0, `L5.3 no more than one false boundary per song (over one: ${over.map((each) => `${each.title} ${each.count}`).join(", ") || "none"})`);
  const short = clean.flatMap((run) =>
    (run.listen?.sections ?? []).filter((section) => section.toBeat - section.fromBeat < 4 * run.score.beatsPerBar).map((section) => `${run.score.title} beats ${section.fromBeat} to ${section.toBeat}`),
  );
  check(short.length === 0, `L5.5 a section shorter than four bars is not made (${short.slice(0, 3).join(", ") || "none"})`);
}
{
  const pairs = clean.map((run) => {
    const n = run.take.truth.sections.length;
    return { value: run.card.values["repeat grouping"], of: (n * (n - 1)) / 2 };
  });
  const grouping = pooledShare(pairs);
  const gather = clean.find((run) => run.score.title === "Gather at the River")!;
  const { truth } = gather.take;
  const beats = gather.listen?.analysis.beats ?? [];
  const sections = gather.listen?.sections ?? [];
  const at = (section: (typeof sections)[number]) => ({ start: beats[section.fromBeat] ?? 0, end: beats[section.toBeat] ?? songEnd(truth) });
  const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const letters = truth.sections.map((section) => {
    const span = { start: truth.downbeats[section.fromBar], end: truth.downbeats[section.toBar] ?? songEnd(truth) };
    return sections.reduce((best, each) => (overlap(at(each), span) > overlap(at(best), span) ? each : best), sections[0])?.group ?? "?";
  });
  const alike = truth.sections.every((a, i) => truth.sections.every((b, j) => (a.group === b.group) === (letters[i] === letters[j])));
  check(
    alike && grouping >= 0.8,
    `L5.4 repeats are grouped by letter: ${gather.score.title}'s ${truth.sections.map((section) => section.group).join(" ")} is heard ${letters.join(" ")}, and ${pct(grouping)} of section pairs across the set are grouped alike (want 80%)`,
    L5,
  );
}
{
  const sung = clean.filter((run) => run.take.lyrics);
  const labels = pooledShare(sung.map((run) => ({ value: run.card.values["section label accuracy"], of: run.take.truth.sections.length })));
  check(labels >= 0.9, `L5.6 labels from the words are right on ${pct(labels)} of the sung songs' sections (want 90%)`, L5);
  const audio = pooledShare(wordless.map((run) => ({ value: run.card.values["section label accuracy"], of: run.take.truth.sections.length })));
  const bands = [...new Set(wordless.flatMap((run) => (run.listen?.sections ?? []).map((section) => section.band)))];
  check(
    audio >= 0.75 && bands.length === 1 && bands[0] === "likely",
    `L5.7 labels from the audio alone, with no words, are right on ${pct(audio)} of the set's sections (want 75%) and all yellow (bands: ${bands.join(", ") || "none"})`,
    L5,
  );
}
{
  const lineErrors = (set: SetRun[]) =>
    set.flatMap((run) => {
      const starts = new Map<number, number>();
      for (const syllable of run.take.truth.syllables) if (!starts.has(syllable.line)) starts.set(syllable.line, syllable.at);
      return (run.listen?.lines ?? []).filter((line) => starts.has(line.line)).map((line) => 1000 * Math.abs(line.start - starts.get(line.line)!));
    });
  const sungOf = (set: SetRun[]) => set.filter((run) => run.take.lyrics);
  const [onFile, onMic] = [middle(lineErrors(sungOf(clean))), middle(lineErrors(sungOf(mics)))];
  check(onFile !== null && onFile <= 300, `L8.3 line starts land within 300 ms, median, on the clean sung set (${onFile === null ? "no lines timed" : `${Math.round(onFile)} ms`})`, L8);
  check(onMic !== null && onMic <= 500, `L8.3 line starts land within 500 ms, median, on the mic case (${onMic === null ? "no lines timed" : `${Math.round(onMic)} ms`})`, L8);
  const placed = (run: SetRun) => run.take.truth.changes.filter((change) => run.take.truth.syllables.some((syllable) => syllable.at === change.at)).length;
  const exact = pooledShare(sungOf(clean).map((run) => ({ value: run.card.values["syllable placement exact"], of: placed(run) })));
  const oneSyllable = pooledShare(sungOf(clean).map((run) => ({ value: run.card.values["syllable placement within one syllable"], of: placed(run) })));
  check(exact >= 0.85 && oneSyllable >= 0.95, `L8.4 each chord sung on a syllable is heard on it in ${pct(exact)} of the clean sung set, within one syllable in ${pct(oneSyllable)} (want 85% and 95%)`, L8);
}

if (fit) {
  const floors = fitBands(setCalls);
  if (!floors) console.log(`--fit: no heard changes carry a confidence yet, so ${BANDS_FILE} is left as it is`);
  else {
    writeBands(floors, BANDS_FILE);
    console.log(`--fit: wrote green from ${floors.sure} and yellow from ${floors.likely} to ${BANDS_FILE}`);
  }
}

if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
