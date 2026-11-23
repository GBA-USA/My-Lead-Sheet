import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { listenThrough } from "./fake-worker.ts";
import { readWav, type Sidecar } from "./learn-render.ts";
import { beatsPerBarOf, chartRows, lyricsOf, rechartRates, scoreListen, stripChords } from "./learn-score.ts";
import type { HeardChange, Listen } from "../src/learn-result.ts";
import type { ChartSection } from "../src/types.ts";

/**
 * The local lane: each WAV in learn-songs/ scored against the sidecar beside it, printed and never gated. With
 * --rechart, a song's chart in the library's shape (<name>.song.json) has its chord lines dropped and is rebuilt by L8
 * from the chart's chords at their heard times, then judged against the chart's own chordAnchors. See
 * learn-songs/README.md. --dir <folder> reads another folder.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const at = process.argv.indexOf("--dir");
const dir = at > 0 ? resolve(process.argv[at + 1]) : join(root, "learn-songs");
const label = at > 0 ? `${process.argv[at + 1]}/` : "learn-songs/";
const rechart = process.argv.includes("--rechart");

type Shape = (value: unknown) => boolean;
const isNumber: Shape = (value) => typeof value === "number" && Number.isFinite(value);
const isString: Shape = (value) => typeof value === "string";
const optional = (shape: Shape): Shape => (value) => value === undefined || shape(value);
const listOf = (shape: Shape): Shape => (value) => Array.isArray(value) && value.every(shape);
const objectOf = (fields: Record<string, Shape>): Shape => (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.entries(fields).every(([key, shape]) => shape((value as Record<string, unknown>)[key]));

const SIDECAR: Record<keyof Sidecar, [Shape, string]> = {
  durationSec: [isNumber, "a number of seconds"],
  bpm: [isNumber, "a number"],
  downbeats: [listOf(isNumber), "a list of seconds"],
  changes: [listOf(objectOf({ at: isNumber, chord: isString })), 'a list of { "at": seconds, "chord": name }'],
  sections: [listOf(objectOf({ fromBar: isNumber, toBar: isNumber, label: isString, group: isString })), 'a list of { "fromBar", "toBar", "label", "group" }'],
  anchors: [listOf(isString), "a list of strings"],
};
const CHART = listOf(objectOf({ heading: isString, lines: listOf(objectOf({ chords: optional(isString), lyrics: optional(isString), bars: optional(isString), note: optional(isString) })) }));

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${basename(file)} is not JSON (${error instanceof Error ? error.message : error})`);
  }
}

function parseSidecar(file: string): Sidecar {
  const json = readJson(file);
  if (!objectOf({})(json)) throw new Error(`${basename(file)} is not an object`);
  const fields = json as Record<string, unknown>;
  const entries = Object.entries(SIDECAR) as [keyof Sidecar, [Shape, string]][];
  const missing = entries.filter(([field]) => !(field in fields)).map(([field]) => `"${field}"`);
  if (missing.length) throw new Error(`sidecar has no ${missing.join(", ")}`);
  const wrong = entries.filter(([field, [shape]]) => !shape(fields[field])).map(([field, [, want]]) => `"${field}" is not ${want}`);
  if (wrong.length) throw new Error(`sidecar ${wrong.join("; ")}`);
  return json as Sidecar;
}

function parseChart(file: string): ChartSection[] {
  const json = readJson(file);
  const body = objectOf({})(json) ? (json as { body?: unknown }).body : undefined;
  if (!CHART(body)) throw new Error(`${basename(file)} has no "body" in the library's shape (sections of { "heading", "lines" })`);
  return body as ChartSection[];
}

const wavs = existsSync(dir) ? readdirSync(dir).filter((name) => /\.wav$/i.test(name)).sort() : [];
if (!wavs.length) {
  console.log(`skip  no songs in ${label}`);
  process.exit(0);
}

type BuildChart = (sections: Listen["sections"], changes: HeardChange[], lines: Listen["lines"], lyrics: string) => ChartSection[];
let buildChart: BuildChart | null | undefined;
/** L8's buildChart from src/learn-words.ts, or null while L8 has not landed. */
async function rebuilder(): Promise<BuildChart | null> {
  if (buildChart !== undefined) return buildChart;
  const words = join(root, "src", "learn-words.ts");
  if (!existsSync(words)) return (buildChart = null);
  const out = await build({ entryPoints: [words], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
  const module = (await import(`data:text/javascript,${encodeURIComponent(out.outputFiles[0].text)}`)) as { buildChart?: BuildChart };
  return (buildChart = typeof module.buildChart === "function" ? module.buildChart : null);
}

/** The chart's changes in reading order: lyric rows' chords, then bar rows' bars, a held chord counted once. */
function chartChanges(body: ChartSection[]) {
  const tokens = body.flatMap((section) =>
    section.lines.flatMap((line) => (line.lyrics !== undefined ? (line.chords ?? "").match(/\S+/g) ?? [] : (line.bars ?? "").split("|").flatMap((bar) => bar.match(/\S+/g) ?? []))),
  );
  return tokens.filter((token, i) => token !== tokens[i - 1]);
}

/** Scores one WAV and prints its card, or returns why it is skipped. */
async function laneSong(wav: string): Promise<string | undefined> {
  const name = basename(wav, wav.slice(-4));
  const sidecarFile = join(dir, `${name}.json`);
  if (!existsSync(sidecarFile)) return `no sidecar ${name}.json beside it`;
  const sidecar = parseSidecar(sidecarFile);
  const songFile = join(dir, `${name}.song.json`);
  const chart = existsSync(songFile) ? parseChart(songFile) : null;
  const { sampleRate, channels } = readWav(readFileSync(join(dir, wav)));
  const samples = channels.length === 1 ? channels[0] : channels[0].map((_, i) => channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length);
  const lyrics = chart ? lyricsOf(stripChords(chart)) : null;
  const beatsPerBar = beatsPerBarOf(sidecar);
  const { listen } = await listenThrough(samples, sampleRate, {
    beatsPerBar,
    lyrics,
    source: { kind: "file", name: wav, stereo: channels.length > 1, sampleRate },
    expectedSeconds: samples.length / sampleRate,
    stopped: "finished",
  });
  const card = scoreListen(listen, sidecar).text;
  console.log(`${wav}: ${(samples.length / sampleRate).toFixed(1)} s at ${sampleRate} Hz${channels.length > 1 ? `, ${channels.length} channels mixed to one` : ""}`);
  for (const line of card) console.log(line);
  if (!rechart) return;
  if (!chart || !lyrics) return `--rechart needs a chart with words in ${name}.song.json`;
  const rebuild = await rebuilder();
  if (!rebuild) return "--rechart waits for L8 (src/learn-words.ts has no buildChart)";
  if (!listen?.lines.length) return "the listen timed no words";
  const written = chartChanges(chart);
  const told = sidecar.changes.map((change) => change.chord);
  const differ = written.findIndex((chord, i) => chord !== told[i]);
  if (differ >= 0 || written.length !== told.length) {
    const k = differ >= 0 ? differ : Math.min(written.length, told.length);
    return `the chart's chords do not follow the sidecar's changes at change ${k + 1} (chart ${written[k] ?? "none"}, sidecar ${told[k] ?? "none"})`;
  }
  const beats = listen.analysis.beats;
  const changes: HeardChange[] = sidecar.changes.map((change) => ({
    beat: beats.reduce((best, beat, i) => (Math.abs(beat - change.at) < Math.abs(beats[best] - change.at) ? i : best), 0),
    at: change.at,
    chord: change.chord === "N.C." ? null : change.chord,
    confidence: 100,
    alternatives: [],
    evidence: { bass: null, tones: [], stable: 1 },
  }));
  const rates = rechartRates(chartRows(chart), chartRows(rebuild(listen.sections, changes, listen.lines, lyrics)));
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  console.log(`rechart ${wav}: exact ${pct(rates.exact)}, within one syllable ${pct(rates.withinSyllable)}, within one word ${pct(rates.withinWord)} (${rates.chords} chords)`);
}

for (const wav of wavs) {
  const skipped = await laneSong(wav).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  if (skipped) console.log(`skip  ${wav}: ${skipped}`);
}
