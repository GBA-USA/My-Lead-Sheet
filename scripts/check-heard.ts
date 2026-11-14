import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { BPM, FORM, HEAD, blues, truthOf, type Take } from "./blues.ts";
import { openSite } from "./chrome.ts";

/** Set SHOTS to a folder to save Review with heard bars and the learned version playing with its kept row. */
const shots = process.env.SHOTS;

const root = new URL("..", import.meta.url).pathname;
const bundled = await build({
  stdin: { contents: 'export * from "./src/learn-analyze.ts"; export * from "./src/learn-chords.ts";', resolveDir: root, loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const app = (await import(`data:text/javascript,${encodeURIComponent(bundled.outputFiles[0].text)}`)) as typeof import("../src/learn-analyze.ts") &
  typeof import("../src/learn-chords.ts");

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
}

const SAMPLE_RATE = 48_000;
const CHORDS = ["A7", "D7", "E7"];
const SIX = 6;
const TAKES: { name: string; take: Take }[] = [
  { name: "clean", take: { choruses: SIX, noise: 0, reverb: false, swaps: {} } },
  { name: "noise + room reverb", take: { choruses: SIX, noise: 0.5, reverb: true, swaps: {} } },
  { name: "loud noise + room reverb", take: { choruses: SIX, noise: 1, reverb: true, swaps: {} } },
  { name: "silent bar, drums-only bar, G7 bar", take: { choruses: SIX, noise: 0, reverb: false, swaps: { 16: "silence", 32: "drums", 49: "G7" } } },
];

const spread = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]?.toFixed(2) ?? "-";
  return `min ${at(0)}, 10th ${at(0.1)}, median ${at(0.5)}, max ${at(1)} (${values.length} bars)`;
};
const text = (bars: (string | null)[]) => bars.map((chord) => chord ?? "?").join(" ");

/** Scores each heard bar against the song's bar it covers, the first one against bar `firstBar`. */
function score(name: string, take: Take, heard: { chord: string | null; confidence: number }[], firstBar: number, gate: boolean) {
  const truth = truthOf(take);
  const tally = { right: 0, wrong: 0, unsure: 0 };
  const sure: number[] = [];
  const none: number[] = [];
  const misheard: number[] = [];
  const perChorus = new Array<number>(take.choruses).fill(0);
  heard.forEach(({ chord, confidence }, k) => {
    const bar = firstBar + k;
    if (bar >= truth.length) return;
    const expected = truth[bar] !== null && CHORDS.includes(truth[bar]!) ? truth[bar] : null;
    if (chord === expected) perChorus[Math.floor(bar / 12)] += 1;
    tally[chord === expected ? "right" : chord === null ? "unsure" : "wrong"] += 1;
    if (chord !== expected && chord !== null) misheard.push(confidence);
    (expected ? sure : none).push(confidence);
    if (gate && take.swaps[bar]) check(chord === null, `${name}: bar ${bar + 1} (${take.swaps[bar]}) is not sure (${chord ?? "null"}, ${confidence.toFixed(2)})`);
  });
  if (gate && take.noise === 0) perChorus.forEach((right, chorus) => check(right >= 11, `${name}: chorus ${chorus + 1} has ${right} of 12 bars right`));
  console.log(`     ${name}: where a chart chord sounds, confidence ${spread(sure)}; where none does, ${spread(none)}; wrong chords at ${spread(misheard)}`);
  return `${tally.right} | ${tally.wrong} | ${tally.unsure} | ${perChorus.map((right) => `${right}/12`).join(", ")}`;
}

const rows: string[] = [];
for (const { name, take } of TAKES) {
  const samples = blues(SAMPLE_RATE, take);
  const listener = new app.SongListener(SAMPLE_RATE);
  const started = performance.now();
  for (let at = 0; at < samples.length; at += 4096) listener.push(samples.subarray(at, at + 4096));
  const listened = performance.now() - started;
  const analysis = listener.analyze(SIX, 4);
  const truth = truthOf(take);
  if (!analysis) {
    console.log(`     ${name}: Learn hears no steady beat, so there are no bars to hear`);
    rows.push(`| ${name} | no steady beat heard | | | |`);
    continue;
  }
  const beat = 60 / BPM;
  const late = Math.round((analysis.beats[0] - HEAD) / beat);
  const onGrid = late === 0 && analysis.beats.length === truth.length * 4;
  console.log(`     ${name}: Learn's grid starts ${late} beat(s) after the song's first downbeat, ${analysis.beats.length} of ${truth.length * 4} beats`);
  const heard = app.heardBars(analysis.chroma, 0, analysis.chroma.length, 4, CHORDS);
  check(heard.every((bar) => bar.chord === null || CHORDS.includes(bar.chord)), `${name}: every bar names a chord from the chart, or none`);
  console.log(`     ${name}: chorus 1 heard ${text(heard.slice(0, 12).map((bar) => bar.chord))}`);
  console.log(`     ${name}: ${(listened / (samples.length / SAMPLE_RATE)).toFixed(1)} ms of listening per second of song`);
  if (onGrid) {
    rows.push(`| ${name} | ${score(name, take, heard, 0, true)} |`);
    continue;
  }
  check(take.noise > 0, `${name}: Learn's beats are the song's beats from its first downbeat`);
  rows.push(`| ${name}, on Learn's grid | ${score(`${name}, on Learn's grid`, take, heard, 0, false)} |`);
  const toDownbeat = (4 - (late % 4)) % 4;
  const realigned = app.heardBars(analysis.chroma, toDownbeat, analysis.chroma.length, 4, CHORDS);
  rows.push(`| ${name}, on the song's own bars | ${score(`${name}, on the song's own bars`, take, realigned, (late + toDownbeat) / 4, false)} |`);
}

console.log(`\nSURE = ${app.SURE}\n`);
console.log(`| take at ${BPM} BPM, ${SIX} choruses of ${FORM.length} bars | right | wrong | not sure | right per chorus |`);
console.log("| --- | --- | --- | --- | --- |");
for (const row of rows) console.log(row);

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

  await click(".teach-btn", "Customize scroll ▾");
  await click("[role=menu] button", "Learn by listen (play the song)");
  await until(`!!window.__mic`, "the mic");
  await evaluate(`window.__play(${JSON.stringify({ choruses: SIX, noise: 0, reverb: false, swaps: { [OUTSIDE]: "G7" } })})`);
  await click(".learn-actions button", "Stop");
  await until(`!!document.querySelector(".learn-sections")`, "the Review panel");

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
