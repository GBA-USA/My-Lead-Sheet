import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { BPM, FORM, HEAD, blues, truthOf, type Take } from "./blues.ts";
import { openSite } from "./chrome.ts";
import { HEAD as SCORE_HEAD, SAMPLE_RATE as SCORE_RATE, render, type Score } from "./learn-render.ts";
import type { Heard, HeardChange } from "../src/learn-result.ts";

/** Set SHOTS to a folder to save Review with heard bars and the learned version playing with its kept row. */
const shots = process.env.SHOTS;

const root = new URL("..", import.meta.url).pathname;
const bundled = await build({
  stdin: {
    contents:
      'export * from "./src/learn-analyze.ts"; export * from "./src/learn-chords.ts"; export { bandOf } from "./src/learn-result.ts"; export { parseChord, pitchClass } from "./src/music.ts";',
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const app = (await import(`data:text/javascript,${encodeURIComponent(bundled.outputFiles[0].text)}`)) as typeof import("../src/learn-analyze.ts") &
  typeof import("../src/learn-chords.ts") &
  Pick<typeof import("../src/learn-result.ts"), "bandOf"> &
  Pick<typeof import("../src/music.ts"), "parseChord" | "pitchClass">;

/** A TESTS-FIRST case its cook has not landed yet: it runs and prints, but its FAIL does not fail check:heard. */
type Pending = "pending until l3";
const L3: Pending = "pending until l3";
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

const SAMPLE_RATE = 48_000;
const CHORDS = ["A7", "D7", "E7"];
const SIX = 6;
const quiet = { choruses: SIX, noise: 0, reverb: false, pickup: 0, swaps: {} };
/** `least` is how many bars of each chorus must come out right. */
const TAKES: { name: string; take: Take; least?: number }[] = [
  { name: "clean", take: quiet, least: 11 },
  { name: "light noise + room reverb", take: { ...quiet, noise: 0.25, reverb: true } },
  { name: "noise + room reverb", take: { ...quiet, noise: 0.5, reverb: true } },
  { name: "loud noise + room reverb", take: { ...quiet, noise: 1, reverb: true } },
  { name: "silent bar, drums-only bar, G7 bar", take: { ...quiet, swaps: { 16: "silence", 32: "drums", 49: "G7" } }, least: 11 },
  { name: "2-beat drum pickup", take: { ...quiet, pickup: 2 } },
];

const spread = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]?.toFixed(2) ?? "-";
  return `min ${at(0)}, 10th ${at(0.1)}, median ${at(0.5)}, max ${at(1)} (${values.length} bars)`;
};
const text = (bars: (string | null)[]) => bars.map((chord) => chord ?? "?").join(" ");

/** Scores each heard bar against the song's bar it starts in, the first one against bar `firstBar`. */
function score(name: string, take: Take, heard: { chord: string | null; confidence: number }[], firstBar: number, least?: number) {
  const truth = truthOf(take);
  const tally = { right: 0, wrong: 0, unsure: 0 };
  const sure: number[] = [];
  const none: number[] = [];
  const misheard: number[] = [];
  const perChorus = new Array<number>(take.choruses).fill(0);
  heard.forEach(({ chord, confidence }, k) => {
    const bar = firstBar + k;
    if (bar < 0 || bar >= truth.length) return;
    const expected = truth[bar] !== null && CHORDS.includes(truth[bar]!) ? truth[bar] : null;
    if (chord === expected) perChorus[Math.floor(bar / 12)] += 1;
    tally[chord === expected ? "right" : chord === null ? "unsure" : "wrong"] += 1;
    if (chord !== expected && chord !== null) misheard.push(confidence);
    (expected ? sure : none).push(confidence);
    if (take.swaps[bar]) check(chord === null, `${name}: bar ${bar + 1} (${take.swaps[bar]}) is not sure (${chord ?? "null"}, ${confidence.toFixed(2)})`);
  });
  if (least) perChorus.forEach((right, chorus) => check(right >= least, `${name}: chorus ${chorus + 1} has ${right} of 12 bars right`));
  console.log(`     ${name}: where a chart chord sounds, confidence ${spread(sure)}; where none does, ${spread(none)}; wrong chords at ${spread(misheard)}`);
  return `${tally.right} | ${tally.wrong} | ${tally.unsure} | ${perChorus.map((right) => `${right}/12`).join(", ")}`;
}

const rows: string[] = [];
const heardTakes = new Map<string, Heard | null>();
for (const { name, take, least } of TAKES) {
  const samples = blues(SAMPLE_RATE, take);
  const listener = new app.SongListener(SAMPLE_RATE);
  const started = performance.now();
  for (let at = 0; at < samples.length; at += 4096) listener.push(samples.subarray(at, at + 4096));
  const listened = performance.now() - started;
  const whole = listener.analyze(4);
  heardTakes.set(name, whole);
  const analysis = whole?.analysis;
  if (!analysis) {
    console.log(`     ${name}: Learn hears no steady beat, so there are no bars to hear`);
    rows.push(`| ${name} | no steady beat heard | | | |`);
    continue;
  }
  const beat = 60 / BPM;
  const late = Math.round((analysis.beats[0] - HEAD) / beat);
  console.log(`     ${name}: Learn's grid starts ${late} beat(s) after the song's first downbeat, ${analysis.beats.length} of ${take.choruses * 48 + take.pickup} beats`);
  const heard = app.heardBars(analysis.chroma, 0, analysis.chroma.length, 4, CHORDS);
  check(heard.every((bar) => bar.chord === null || CHORDS.includes(bar.chord)), `${name}: every bar names a chord from the chart, or none`);
  console.log(`     ${name}: chorus 1 heard ${text(heard.slice(0, 12).map((bar) => bar.chord))}`);
  console.log(`     ${name}: ${(listened / (samples.length / SAMPLE_RATE)).toFixed(1)} ms of listening per second of song`);
  const grid = late === 0 ? "" : `, on Learn's grid, ${Math.abs(late)} beats ${late > 0 ? "late" : "early"}`;
  rows.push(`| ${name}${grid} | ${score(`${name}${grid}`, take, heard, Math.floor(late / 4), least)} |`);
  const toDownbeat = (4 - (late % 4)) % 4;
  if (toDownbeat === 0) continue;
  const realigned = app.heardBars(analysis.chroma, toDownbeat, analysis.chroma.length, 4, CHORDS);
  rows.push(`| ${name}, on the song's own bars | ${score(`${name}, on the song's own bars`, take, realigned, (late + toDownbeat) / 4)} |`);
}

console.log(`\nSURE = ${app.SURE}\n`);
console.log(`| take at ${BPM} BPM, ${SIX} choruses of ${FORM.length} bars | right | wrong | not sure | right per chorus |`);
console.log("| --- | --- | --- | --- | --- |");
for (const row of rows) console.log(row);

// TESTS-FIRST for L3, chords heard with no chart. Each line starts with its pass condition's number in LEARN-PLAN.md
// L3. They read `changes` from the listener, as a listen gives them, and rely on nothing else of L3's.
const VOCABULARY: Record<string, number[]> = { "": [0, 4, 7], m: [0, 3, 7], "7": [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], sus2: [0, 2, 7], sus4: [0, 5, 7] };
/** One of 12 roots times the seven qualities, with a slash bass only where the bass is a chord tone other than the root. */
const inVocabulary = (name: string) => {
  const chord = app.parseChord(name);
  const tones = chord && VOCABULARY[chord.quality];
  if (!chord || !tones) return false;
  if (!chord.bass) return true;
  const step = (app.pitchClass(chord.bass) - app.pitchClass(chord.root) + 12) % 12;
  return step !== 0 && tones.includes(step);
};
const rootOf = (name: string | null) => (name && app.parseChord(name) ? app.pitchClass(app.parseChord(name)!.root) : null);
/** The heard change sounding at `time`. */
const soundingAt = (changes: HeardChange[], time: number) => changes.filter((change) => change.at <= time + 1e-9).at(-1) ?? null;
const named = (change: HeardChange | null) => (change ? `${change.chord ?? "?"} at ${change.at.toFixed(2)} s, ${change.confidence}` : "none");

{
  const swapped = heardTakes.get("silent bar, drums-only bar, G7 bar")?.changes ?? [];
  const barMiddle = (bar: number) => HEAD + (4 * bar + 2) * (60 / BPM);
  const outside = swapped.filter((change) => change.chord !== null && !inVocabulary(change.chord));
  const g7 = soundingAt(swapped, barMiddle(49));
  check(
    swapped.length > 0 && outside.length === 0 && (g7?.chord === "G7" || g7?.chord === "G"),
    `L3.1 every change names a chord from the fixed vocabulary or none, never only from the chart: the blues' G7 bar reads G7 or G (G7 bar: ${named(g7)}; outside the vocabulary: ${outside.map((change) => change.chord).join(", ") || "none"})`,
    L3,
  );
  const unsure = [16, 32].map((bar) => soundingAt(swapped, barMiddle(bar)));
  const neighbours = [15, 17, 31, 33].map((bar) => ({ bar, change: soundingAt(swapped, barMiddle(bar)) }));
  const heardNeighbours = neighbours.filter(({ bar, change }) => rootOf(change?.chord ?? null) === rootOf(FORM[bar % 12]));
  check(
    unsure.every((change) => change?.chord === null) && heardNeighbours.length === neighbours.length,
    `L3.7 a silent bar and a drums-only bar are unsure, not guessed, while the bars around them are named (silent ${named(unsure[0])}, drums only ${named(unsure[1])}; neighbours named ${heardNeighbours.length} of ${neighbours.length})`,
    L3,
  );
}

/** A score heard the way the phone hears a picked file: at its decode rate, a second at a time. */
function hearScore(samples: Float32Array): Heard | null {
  const ear = new app.SongListener(SCORE_RATE);
  for (let at = 0; at < samples.length; at += SCORE_RATE) ear.push(samples.subarray(at, at + SCORE_RATE));
  return ear.analyze(4);
}
const barsOf = (text: string) => text.split("|").map((bar) => [bar.trim()]);
const songOf = (title: string, bass: Score["bass"], ...parts: string[]): Score => ({
  title,
  bpm: 100,
  beatsPerBar: 4,
  stereo: false,
  swing: false,
  strum: "light",
  bass,
  sections: parts.map((chords, i) => ({ label: ["INTRO", "VERSE", "OUTRO"][i], group: "ABC"[i], bars: barsOf(chords) })),
});
const scoreBar = (bar: number, beat = 2) => SCORE_HEAD + ((4 * bar + beat) * 60) / 100;
/** The heard changes over bars 5 to 10 of a 16-bar score, the middle of its 8-bar verse. */
const verseChanges = (heard: Heard | null) => [5, 6, 7, 8, 9, 10].map((bar) => soundingAt(heard?.changes ?? [], scoreBar(bar)));

{
  const overA = render(songOf("C over A", "root", "C | C | C | C", "C/A | C/A | C/A | C/A | C/A | C/A | C/A | C/A", "C | C | C | C"));
  const heard = verseChanges(hearScore(overA.samples));
  const reads = (change: HeardChange | null) => {
    const names = change ? [change.chord, ...change.alternatives.map((each) => each.chord)] : [];
    const minorOnA = names.some((name) => rootOf(name) === 9 && !!app.parseChord(name ?? "")?.minor);
    const majorOnC = names.some((name) => rootOf(name) === 0 && !app.parseChord(name ?? "")?.minor);
    return ["Am", "Am7", "C"].includes(change?.chord ?? "") && minorOnA && majorOnC && app.bandOf(change!.confidence) !== "sure";
  };
  check(
    heard.every(reads),
    `L3.8 the bass root is read from the low view and a stable bass that disagrees lowers confidence: C E G over a steady A reads Am or C with both offered and is not green (${heard.map((change) => `${named(change)} [${change?.alternatives.map((each) => each.chord).join(" ") ?? ""}]`).join("; ")})`,
    L3,
  );
}
{
  const overFSharp = render(songOf("D over F#", "root", "D | D | D | D", "D/F# | D/F# | D/F# | D/F# | D/F# | D/F# | D/F# | D/F#", "G | G | D | D"));
  const heard = verseChanges(hearScore(overFSharp.samples));
  const slash = (change: HeardChange | null) => {
    const chord = app.parseChord(change?.chord ?? "");
    return !!chord?.bass && app.pitchClass(chord.root) === 2 && app.pitchClass(chord.bass) === 6 && chord.quality === "";
  };
  check(heard.every(slash), `L3.9 a slash chord is named when the bass is a stable chord tone that is not the root: D over a steady F# reads D/F# (${heard.map(named).join("; ")})`, L3);
}
{
  const form = ["G | G | C | C", "G | G | D | D | G | G | C | C", "G | G | G | G"] as const;
  const plain = render(songOf("Two bars of G", "root", ...form));
  const blip = render(songOf("Two bars of G", "root", form[0], `C | ${form[1].split("|").slice(1).join("|")}`, form[2]));
  const beat = (k: number) => Math.round((SCORE_HEAD + (k * 60) / 100) * SCORE_RATE);
  const samples = Float32Array.from(plain.samples);
  samples.set(blip.samples.subarray(beat(18), beat(19)), beat(18));
  const heard = hearScore(samples)?.changes ?? [];
  const inside = heard.filter((change) => change.at > scoreBar(4, 0.5) && change.at < scoreBar(6, 0));
  const through = [scoreBar(4, 0.5), scoreBar(4, 3.5), scoreBar(5, 2)].map((time) => soundingAt(heard, time));
  check(
    inside.length === 0 && through.every((change) => change?.chord === "G"),
    `L3.10 a one-beat blip inside a two-bar chord does not split it: one beat of C inside two bars of G reads G throughout (changes inside: ${inside.map(named).join("; ") || "none"}; through it: ${through.map(named).join("; ")})`,
    L3,
  );
}

const page = await build({
  entryPoints: [join(root, "scripts/blues.ts")],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "__blues",
  logLevel: "silent",
});
/** Frames and the clock move only when stepped, and the mic is a stand-in the check feeds the blues to. */
const STAND_INS = `${page.outputFiles[0].text}
(() => {
  let now = 0;
  let next = 0;
  const frames = new Map();
  Object.defineProperty(performance, "now", { value: () => now });
  window.requestAnimationFrame = (run) => (frames.set(++next, run), next);
  window.cancelAnimationFrame = (id) => frames.delete(id);
  window.__frames = (count) => {
    for (let i = 0; i < count; i++) {
      now += 1000 / 60;
      const due = [...frames.values()];
      frames.clear();
      for (const run of due) run(now);
    }
    return frames.size;
  };
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => ({ getTracks: () => [{ stop() {} }] }) });
  AudioContext.prototype.createMediaStreamSource = () => ({ connect() {} });
  AudioContext.prototype.createScriptProcessor = function () {
    return (window.__mic = { rate: this.sampleRate, connect() {}, onaudioprocess: null });
  };
  window.__play = (take) => {
    const samples = __blues.blues(window.__mic.rate, take);
    for (let at = 0; at < samples.length; at += 4096) {
      const chunk = samples.subarray(at, at + 4096);
      window.__mic.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } });
    }
  };
})()`;

const NO_HALF_STEPPIN = 13;
const OUTSIDE = 21;
const site = await openSite(root, "check-heard");
const { send, evaluate } = site;
const pause = (ms: number) => evaluate(`new Promise((resolve) => setTimeout(resolve, ${ms}))`);
const until = async (expression: string, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (await evaluate<boolean>(expression)) return;
    await pause(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const click = async (selector: string, text?: string) => {
  const found = await evaluate<boolean>(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => ${text === undefined ? "true" : `el.textContent.trim() === ${JSON.stringify(text)}`});
    target?.click();
    return !!target;
  })()`);
  if (!found) throw new Error(`no ${selector} ${text ?? ""} to click`);
  await pause(50);
};
const shoot = async (name: string) => {
  if (!shots) return;
  const shot = await send("Page.captureScreenshot", { format: "png" });
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, `${name}.png`), Buffer.from(shot.data, "base64"));
};
const barRows = () => evaluate<string[][]>(`[...document.querySelectorAll("#chord-section .chart-section")].map((section) => [...section.querySelectorAll(".bars")].map((row) => row.textContent))`);
const chartRows: string[][] = [];
/** Per section, the bar rows the sheet shows beyond the chart's own, as one line. */
const heardRows = async () => (await barRows()).map((rows, i) => rows.slice(0, rows.length - chartRows[i].length).join(" ").replace(/ +/g, " "));

try {
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: STAND_INS });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: `${site.origin}/#/songs` });
  await until(`document.readyState === "complete"`, "the app");
  await evaluate(`localStorage.clear()`);
  await send("Page.navigate", { url: `${site.origin}/?fresh#/song/${NO_HALF_STEPPIN}` });
  await until(`!!document.querySelector(".chart-heading")`, "No Half Steppin'");
  await evaluate(`document.fonts.ready.then(() => true)`);
  chartRows.push(...(await barRows()));

  await click('[aria-label="Scroll settings"]');
  await click("[role=dialog] button", "Learn this song");
  await click('[role=dialog] button[aria-label="Learn by listen"]');
  await until(`!!document.querySelector(".learn[role=dialog]")`, "the Learn sheet");
  const ways = await evaluate<string[]>(`[...document.querySelectorAll(".learn[role=dialog] :is(input, button)")].map((el) => el.getAttribute("aria-label") ?? el.textContent.trim())`);
  check(JSON.stringify(ways) === `["Pick the song's file","Listen with the mic","Cancel"]`, `Learn by listen opens the Learn sheet on its two ways in, the file first, with Cancel (${ways.join(", ")})`);
  await pause(250);
  check(await evaluate<boolean>(`!window.__mic`), "the mic is not asked for until the player picks it");
  await click('.learn[role=dialog] button[aria-label="Listen with the mic"]');
  await until(`!!window.__mic`, "the mic");
  await evaluate(`window.__play(${JSON.stringify({ ...quiet, swaps: { [OUTSIDE]: "G7" } })})`);
  await click(".learn-actions button", "Stop");
  await until(`!!document.querySelector(".learn-sections")`, "the Review panel");
  const from = await evaluate<string>(`document.querySelector(".learn-coverage")?.textContent ?? ""`);
  check(from.startsWith("From the mic · "), `the Review's first line says the song came from the mic (${from})`);

  const placed = await evaluate<{ name: string; beat: number }[]>(`[...document.querySelectorAll(".learn-sections li")].map((li) => {
    const [, bar, beat] = li.querySelector(".learn-at").textContent.match(/bar (\\d+)(?:, beat (\\d+))?/);
    return { name: li.querySelector(".learn-heading").textContent, beat: (bar - 1) * 4 + (beat ? beat - 1 : 0) };
  })`);
  console.log(`     Learn placed the headings at beats ${placed.map((each) => each.beat).join(", ")}; the check nudges them onto each chorus`);
  const nudge = async (i: number) => {
    const { name, beat } = placed[i];
    for (let at = beat; at !== i * 48; at += Math.sign(i * 48 - at)) await click(`[aria-label="${name} ${at > i * 48 ? "earlier" : "later"}"]`);
  };
  for (let i = 1; i < SIX; i++) if (placed[i].beat > i * 48) await nudge(i);
  for (let i = SIX - 1; i > 0; i--) if (placed[i].beat < i * 48) await nudge(i);

  const review = await evaluate<{ heading: string; at: string; chart: string; heard: string; box: boolean }[]>(`[...document.querySelectorAll(".learn-sections li")].map((li) => {
    const rows = [...li.querySelectorAll(".learn-bars")].map((row) => row.textContent.replace(/ +/g, " "));
    return { heading: li.querySelector(".learn-heading").textContent, at: li.querySelector(".learn-at").textContent, chart: rows.length > 1 ? rows[0] : "", heard: rows[rows.length - 1] ?? "", box: !!li.querySelector(".learn-chords input:not(:disabled)") };
  })`);
  for (const each of review) console.log(`     Review ${each.heading} (${each.at}): chart ${each.chart} / heard ${each.heard}`);
  const form = "A7 A7 A7 A7 | D7 D7 A7 A7 | E7 D7 A7 E7";
  check(review.length === SIX && review.every((each) => each.chart === form && each.box), "Review shows every section's chart form over its heard bars, each with a box to keep them");
  check(review.every((each, i) => each.heard === (i === 1 ? "A7 A7 A7 A7 | D7 D7 A7 A7 | E7 ? A7 E7" : form)), "the heard bars match the chart, with ? on HOOK's G7 bar, a chord the chart does not have");
  check((await evaluate<boolean>(`[...document.querySelectorAll(".learn-chords input")].every((box) => !box.checked)`)), "no heard bars are kept until the player ticks them");
  await shoot("01-review-heard-bars");

  await click(".learn-chords input[aria-label^='Keep HOOK']");
  await click(".learn-actions button", "Save");
  await click(".shell-header .song-line button", "Save");
  await click("[role=menu] button", "Save as…");
  await click(".teach-sheet button", "Save");
  const saved = await evaluate<{ versions: { learned: { sections: { heading: string; heard?: (string | null)[] }[] } }[] }>(`JSON.parse(localStorage.getItem("leadSheetsScrollVersions.${NO_HALF_STEPPIN}"))`);
  const sections = saved.versions[0].learned.sections;
  const hook = [...FORM.slice(0, 9), null, ...FORM.slice(10)];
  check(JSON.stringify(sections[1].heard) === JSON.stringify(hook) && sections.every((section, i) => i === 1 || section.heard === undefined), `only HOOK's heard bars are saved, its G7 bar as not sure (${JSON.stringify(sections.map((section) => section.heard ?? "-"))})`);
  check((await heardRows()).every((row) => row === ""), "the sheet shows no heard row until the learned version plays");

  await click(".scroll-pill");
  await until(`window.__frames(0) > 0`, "the scroll loop");
  const hookAt = (await evaluate<{ versions: { learned: { sections: { at: number }[] } }[] }>(`JSON.parse(localStorage.getItem("leadSheetsScrollVersions.${NO_HALF_STEPPIN}"))`)).versions[0].learned.sections[1].at;
  await evaluate(`window.__frames(${Math.round(hookAt * 60)})`);
  await pause(50);
  const playing = await heardRows();
  console.log(`     playing: ${JSON.stringify(playing)}`);
  check(playing[1] === "Heard | A7 | A7 | A7 | A7 | D7 | D7 | A7 | A7 | E7 | | A7 | E7 |" && playing.every((row, i) => i === 1 || row === ""), "while it plays, HOOK alone shows its kept heard row, blank on the not-sure bar");
  await shoot("02-playing-kept-heard-row");
  await click('[aria-label="Transpose up"]');
  await click('[aria-label="Transpose up"]');
  const up = await heardRows();
  check(up[1] === "Heard | B7 | B7 | B7 | B7 | E7 | E7 | B7 | B7 | F#7 | | B7 | F#7 |", `transposed up a whole step, the heard row moves with the chart (${up[1]})`);
  await click(".scroll-pill");
  check((await heardRows()).every((row) => row === ""), "stopping the scroll takes the heard row away again");
} finally {
  await site.close();
}

if (failures > 0) {
  console.error(`${failures} heard-chord check(s) failed`);
  process.exit(1);
}
console.log("all heard-chord checks passed");
