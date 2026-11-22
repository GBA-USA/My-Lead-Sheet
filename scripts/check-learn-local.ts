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
const FIELDS: (keyof Sidecar)[] = ["durationSec", "bpm", "downbeats", "changes", "sections", "anchors"];

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

for (const wav of wavs) {
  const name = basename(wav, wav.slice(-4));
  const sidecarFile = join(dir, `${name}.json`);
  if (!existsSync(sidecarFile)) {
    console.log(`skip  ${wav}: no sidecar ${name}.json beside it`);
    continue;
  }
  let sidecar: Sidecar;
  try {
    sidecar = JSON.parse(readFileSync(sidecarFile, "utf8"));
  } catch (error) {
    console.log(`skip  ${wav}: ${name}.json is not JSON (${error instanceof Error ? error.message : error})`);
    continue;
  }
  const missing = FIELDS.filter((field) => !(field in sidecar));
  if (missing.length) {
    console.log(`skip  ${wav}: sidecar has no ${missing.map((field) => `"${field}"`).join(", ")}`);
    continue;
  }
  let audio: ReturnType<typeof readWav>;
  try {
    audio = readWav(readFileSync(join(dir, wav)));
  } catch (error) {
    console.log(`skip  ${wav}: ${error instanceof Error ? error.message : error}`);
    continue;
  }
  const { sampleRate, channels } = audio;
  const samples = channels.length === 1 ? channels[0] : channels[0].map((_, i) => channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length);
  const songFile = join(dir, `${name}.song.json`);
  const chart: ChartSection[] | null = existsSync(songFile) ? (JSON.parse(readFileSync(songFile, "utf8")) as { body: ChartSection[] }).body : null;
  const lyrics = chart ? lyricsOf(stripChords(chart)) : null;
  const beatsPerBar = beatsPerBarOf(sidecar);
  const { listen } = await listenThrough(samples, sampleRate, {
    beatsPerBar,
    lyrics,
    source: { kind: "file", name: wav, stereo: channels.length > 1, sampleRate },
    expectedSeconds: samples.length / sampleRate,
    stopped: "finished",
  });
  console.log(`${wav}: ${(samples.length / sampleRate).toFixed(1)} s at ${sampleRate} Hz${channels.length > 1 ? `, ${channels.length} channels mixed to one` : ""}`);
  for (const line of scoreListen(listen, sidecar).text) console.log(line);
  if (!rechart) continue;
  if (!chart || !lyrics) {
    console.log(`skip  ${wav}: --rechart needs a chart with words in ${name}.song.json`);
    continue;
  }
  const rebuild = await rebuilder();
  if (!rebuild) {
    console.log(`skip  ${wav}: --rechart waits for L8 (src/learn-words.ts has no buildChart)`);
    continue;
  }
  if (!listen?.lines.length) {
    console.log(`skip  ${wav}: the listen timed no words`);
    continue;
  }
  const written = chartChanges(chart);
  const told = sidecar.changes.map((change) => change.chord);
  const differ = written.findIndex((chord, i) => chord !== told[i]);
  if (differ >= 0 || written.length !== told.length) {
    const k = differ >= 0 ? differ : Math.min(written.length, told.length);
    console.log(`skip  ${wav}: the chart's chords do not follow the sidecar's changes at change ${k + 1} (chart ${written[k] ?? "none"}, sidecar ${told[k] ?? "none"})`);
    continue;
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
