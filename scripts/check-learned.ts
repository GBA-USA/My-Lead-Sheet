import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build as bundle } from "esbuild";
import type { LibraryFile, Song } from "../src/types.ts";
import { openSite } from "./chrome.ts";

/** Set SHOTS to a folder to save the Review panel, the name sheet, and headings on the reading line. */
const shots = process.env.SHOTS;
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const NO_HALF_STEPPIN = 13;
const TRUTH = 8;

const root = new URL("..", import.meta.url).pathname;
const seed = JSON.parse(readFileSync(join(root, "data/library.json"), "utf8")) as LibraryFile;
const original = JSON.parse(readFileSync(join(root, "docs/handoff/lead-sheets-data-export.json"), "utf8")) as LibraryFile;
const modules = await bundle({
  stdin: { contents: 'export * from "./src/storage.ts"; export * from "./src/metronome.ts";', resolveDir: root, loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const app = (await import(`data:text/javascript,${encodeURIComponent(modules.outputFiles[0].text)}`)) as typeof import("../src/storage.ts") & typeof import("../src/metronome.ts");

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
}

/**
 * Runs before the app. Animation frames and performance.now only move when the check steps them, so a whole song
 * plays in a moment. The mic is a stand-in the check feeds a click track to, as fast as it likes.
 */
const STAND_INS = `(() => {
  window.__errors = [];
  addEventListener("error", (event) => window.__errors.push(String(event.message)));
  addEventListener("unhandledrejection", (event) => window.__errors.push(String(event.reason)));
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
  /** A click track of 8-bar parts, every other one with a voice over it. */
  window.__playSong = (parts) => {
    const { rate } = window.__mic;
    const beat = 0.5;
    const head = 2;
    const beats = parts * 8 * 4;
    const samples = new Float32Array(Math.round((head + beats * beat + 2) * rate));
    let seed = 7;
    for (let i = 0; i < samples.length; i++) samples[i] = 0.003 * (((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 31) - 1);
    for (let k = 0; k < beats; k++) {
      const part = Math.floor(k / 32);
      const loud = [0.2, 0.5, 0.3, 0.6, 0.25, 0.55, 0.35][part % 7];
      const from = Math.round((head + k * beat) * rate);
      for (let i = 0; i < 0.3 * rate; i++) samples[from + i] += loud * Math.sin((2 * Math.PI * 60 * i) / rate) * Math.exp(-i / (0.08 * rate));
      if (part % 2 === 0) continue;
      for (let i = 0; i < beat * rate; i++) {
        let voice = 0;
        for (let h = 2; h <= 13; h++) voice += Math.sin((2 * Math.PI * h * 196 * (from + i)) / rate) / h;
        samples[from + i] += 0.1 * voice;
      }
    }
    for (let at = 0; at < samples.length; at += 4096) {
      const chunk = samples.subarray(at, at + 4096);
      window.__mic.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } });
    }
  };
})()`;

const site = await openSite(root, "check-learned");
const { send, evaluate } = site;

const pause = (ms: number) => evaluate(`new Promise((resolve) => setTimeout(resolve, ${ms}))`);
const until = async (expression: string, what: string) => {
  for (let i = 0; i < 200; i++) {
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
const stored = (songId: number) => evaluate<{ versions: { name: string; learned?: object }[] } | null>(`JSON.parse(localStorage.getItem("${app.SCROLL_VERSIONS_KEY}.${songId}"))`);

let loads = 0;
/** Opens the song fresh at a text scale, after `setup` runs on the page's storage. */
async function openSong(id: number, scale: number, setup = "") {
  const title = seed.songs.find((song) => song.id === id)!.title;
  await send("Page.navigate", { url: `${site.origin}/?load=${(loads += 1)}#/songs` });
  await until(`document.readyState === "complete"`, "the app");
  await evaluate(`${setup}; localStorage.setItem("${app.TEXT_SCALE_KEY}", "${app.TEXT_SCALES.indexOf(scale as (typeof app.TEXT_SCALES)[number])}")`);
  await send("Page.navigate", { url: `${site.origin}/?load=${(loads += 1)}#/song/${id}` });
  await until(`document.querySelector(".sheet-name")?.textContent === ${JSON.stringify(title)} && !!document.querySelector(".chart-heading")`, title);
  await evaluate(`document.fonts.ready.then(() => true)`);
  await pause(100);
}

async function learnOnce() {
  await evaluate(`window.__mic = null`);
  await click(".teach-btn", "Learn this song");
  await until(`!!window.__mic`, "the mic");
  await evaluate(`window.__playSong(document.querySelectorAll(".chart-heading").length)`);
  await pause(50);
  await click(".learn-actions button", "Stop");
  await until(`!!document.querySelector(".learn-sections")`, "the Review panel");
}

try {
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: STAND_INS });
  await send("Emulation.setDeviceMetricsOverride", PHONE);

  await openSong(NO_HALF_STEPPIN, 1, "localStorage.clear()");
  const chart = await evaluate<{ heading: string; bars: number }[]>(
    `[...document.querySelectorAll("#chord-section .chart-section")].map((section) => ({ heading: section.querySelector(".chart-heading").textContent, bars: section.querySelectorAll(".bars").length }))`,
  );
  await shoot("no-half-steppin-top");
  await evaluate(`(() => {
    const sheet = document.getElementById("sheet-scroll");
    const verse = [...document.querySelectorAll(".chart-heading")].find((heading) => heading.textContent === "VERSE 2");
    sheet.scrollTop += verse.getBoundingClientRect().top - sheet.getBoundingClientRect().top - 8;
  })()`);
  await pause(100);
  await shoot("no-half-steppin-verse-2-3");
  const headingList = chart.map((section) => `${section.heading} (${section.bars} bar rows)`).join(", ");
  check(chart.length === 6 && chart[0].heading === "VERSE 1" && !chart.some((section) => section.heading.startsWith("THE FORM")), `No Half Steppin' shows its 6 song sections from VERSE 1, no THE FORM heading (${headingList})`);
  check(chart.every((section) => section.bars > 0), `every No Half Steppin' section shows chord bars on screen (${headingList})`);

  await learnOnce();
  const asked = await evaluate<string[]>(`[...document.querySelectorAll(".learn-sections .learn-heading")].map((heading) => heading.textContent)`);
  check(asked.length === 6 && asked[0] === "VERSE 1", `Learn asks for No Half Steppin's 6 song sections, from VERSE 1 (${asked.join(", ")})`);
  const cover = await evaluate<{ top: number; bottom: number; points: number; misses: string[]; under: string[] }>(`(() => {
    const panel = document.querySelector(".learn");
    const box = panel.getBoundingClientRect();
    const name = (el) => (el ? el.tagName + (el.getAttribute("class") ? "." + el.getAttribute("class") : "") : "nothing");
    const misses = [];
    let points = 0;
    const inset = parseFloat(getComputedStyle(panel).borderTopLeftRadius) * (1 - Math.SQRT1_2) + 1;
    for (let y = Math.max(0, box.top) + inset; y < Math.min(innerHeight, box.bottom) - inset; y += 8) {
      for (const x of [box.left + inset, box.left + box.width / 4, box.left + box.width / 2, box.right - box.width / 4, box.right - inset]) {
        points += 1;
        const hit = document.elementFromPoint(x, y);
        if (!panel.contains(hit)) misses.push(name(hit) + " at y=" + Math.round(y));
      }
    }
    const backdrop = panel.closest(".learn-backdrop");
    const under = [".shell-header", ".tabs", ".controls", ".teach-bar"].flatMap((selector) => {
      const bar = document.querySelector(selector).getBoundingClientRect();
      return [0.1, 0.5, 0.9].flatMap((across) => {
        const hit = document.elementFromPoint(bar.left + bar.width * across, bar.top + bar.height / 2);
        return backdrop.contains(hit) ? [] : [selector + " shows " + name(hit) + " at y=" + Math.round(bar.top + bar.height / 2)];
      });
    });
    return { top: box.top, bottom: box.bottom, points, misses, under };
  })()`);
  await shoot("review-panel");
  check(cover.misses.length === 0, `every point of the Review panel (${cover.points} points, y ${Math.round(cover.top)} to ${Math.round(cover.bottom)}) is the panel itself${cover.misses.length ? `, not ${[...new Set(cover.misses)].slice(0, 4).join(", ")}` : ""}`);
  check(cover.under.length === 0, `the header, tabs, controls and Teach bar sit under the backdrop${cover.under.length ? `, but ${cover.under.slice(0, 4).join(", ")}` : ""}`);

  await click(".learn-actions button", "Save");
  const sheet = await evaluate<{ title: string; name: string; buttons: string[] } | null>(`(() => {
    const sheet = document.querySelector(".teach-sheet");
    return sheet && { title: sheet.querySelector("h2").textContent, name: sheet.querySelector("input").value, buttons: [...sheet.querySelectorAll("button")].map((b) => b.textContent) };
  })()`);
  await shoot("name-sheet-after-learn");
  check(sheet?.title === "Save this take" && sheet.name === "V1" && sheet.buttons.join() === "Discard,Save", `Learn's Save opens the Teach name sheet with V1 to edit, Discard and Save (${JSON.stringify(sheet)})`);
  check((await stored(NO_HALF_STEPPIN)) === null, "nothing is stored before the name sheet's Save");
  if (sheet) {
    await evaluate(`(() => {
      const input = document.querySelector(".teach-sheet input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Gig take");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await click(".teach-sheet button", "Save");
  }
  const saved = await stored(NO_HALF_STEPPIN);
  check(saved?.versions.length === 1 && saved.versions[0].name === "Gig take" && !!saved.versions[0].learned, `Save stores the learned version under the edited name (${JSON.stringify(saved?.versions.map((version) => version.name))})`);

  await learnOnce();
  await click(".learn-use input");
  await click(".learn-actions button", "Save");
  const second = await evaluate<string | undefined>(`document.querySelector(".teach-sheet input")?.value`);
  check(second === "V2", `the next Learn offers V2 (${second})`);
  if (second) await click(".teach-sheet button", "Discard");
  const after = await stored(NO_HALF_STEPPIN);
  const data = await evaluate<string | null>(`localStorage.getItem("${app.SONG_DATA_KEY}.${NO_HALF_STEPPIN}")`);
  check(after?.versions.length === 1 && data === null && !(await evaluate<boolean>(`!!document.querySelector("[role=dialog]")`)), `Discard closes the sheet and stores nothing, not the version and not the song's length and BPM (${after?.versions.length} version, song data ${data})`);

  for (const run of [
    { id: NO_HALF_STEPPIN, learnAt: 1, playAt: 1, at: [1, 12, 45, 75, 110, 150, 190], end: 232 },
    { id: NO_HALF_STEPPIN, learnAt: 1, playAt: 1.5, at: [1, 12, 45, 75, 110, 150, 190], end: 232 },
    { id: TRUTH, learnAt: 1, playAt: 1, at: [1, 14, 38, 60, 85, 112, 140, 168, 196], end: 220 },
    { id: TRUTH, learnAt: 1, playAt: 1, at: [1, 14, 38, 60, 85, 112, 140, 168, 196], end: 220, larger: 3, resize: 6 },
  ]) {
    const song = seed.songs.find((each) => each.id === run.id) as Song;
    const where = `${song.title} learned at x${run.learnAt}, played at x${run.playAt}${run.larger ? `, A+ before section ${run.larger + 1}, rotated to 844x390 before section ${run.resize! + 1}` : ""}`;
    await openSong(run.id, run.learnAt, "localStorage.clear()");
    const headings = await evaluate<{ heading: string; fraction: number }[]>(`(() => {
      const chart = document.getElementById("chord-section");
      const { top, height } = chart.getBoundingClientRect();
      return [...chart.querySelectorAll(".chart-section")].map((section) => ({
        heading: section.querySelector(".chart-heading").textContent,
        fraction: Math.min(1, Math.max(0, (section.getBoundingClientRect().top - top) / height)),
      }));
    })()`);
    const bpm = app.initialMetronomeBpm(song.tempo) ?? 112;
    const downbeat = run.at[0] + (4 * 60) / bpm;
    const beats = Array.from({ length: Math.floor(((run.end - downbeat) * bpm) / 60) }, (_, k) => +(downbeat + (k * 60) / bpm).toFixed(3));
    const sections = headings.map(({ heading }, i) => ({ heading, at: run.at[i] }));
    const marks = [{ at: 0, progress: 0 }, ...sections.map(({ at }, i) => ({ at, progress: i === 0 ? 0 : headings[i].fraction })), { at: run.end, progress: 1 }];
    const version = { name: "V1", bpm, marks, learned: { beatsPerBar: 4, downbeat, beats, sections, vocals: [] } };
    await openSong(run.id, run.playAt, `localStorage.setItem("${app.SCROLL_VERSIONS_KEY}.${run.id}", ${JSON.stringify(JSON.stringify({ versions: [version], selected: 0 }))})`);

    await click(".scroll-pill");
    await until(`window.__frames(0) > 0`, "the scroll loop");
    let frames = 0;
    const playTo = async (seconds: number) => {
      const count = Math.round(seconds * 60) - frames;
      frames += count;
      await evaluate(`window.__frames(${count})`);
    };
    const place = () =>
      evaluate<{ ys: number[]; line: number; top: number; on: boolean }>(`(() => {
        const sheet = document.getElementById("sheet-scroll");
        const view = sheet.getBoundingClientRect().top;
        const headings = [...document.querySelectorAll(".chart-heading")];
        return {
          ys: headings.map((heading) => heading.getBoundingClientRect().top - view),
          line: (() => {
            const text = document.createRange();
            text.selectNodeContents(headings[0]);
            return text.getClientRects()[0].height;
          })(),
          top: sheet.scrollTop,
          on: document.querySelector(".scroll-pill").textContent.includes("On"),
        };
      })()`);

    const landed: string[] = [];
    let reading = 0;
    let lastTop = 0;
    for (const [i, section] of sections.entries()) {
      if (i === run.larger) {
        await click('[aria-label="Larger text"]');
        await pause(150);
      }
      if (i === run.resize) {
        await send("Emulation.setDeviceMetricsOverride", { ...PHONE, width: PHONE.height, height: PHONE.width });
        await pause(150);
      }
      await playTo(section.at);
      const { ys, line, top } = await place();
      if (i === 0) reading = ys[0];
      const y = ys[i];
      landed.push(`${section.heading.split(/\s+[(—]/)[0]} ${y.toFixed(0)}`);
      const last = i === sections.length - 1;
      if (i === 0) check(reading > 0 && reading < 3 * line, `${where}: the reading line, where the first heading sits as the song starts, is near the top of the sheet (${reading.toFixed(1)} px, a line is ${line.toFixed(1)} px)`);
      else check(Math.abs(y - reading) <= line, `${where}: ${last ? "the final heading still reaches" : `heading ${i + 1} lands within a line of`} the reading line as its section starts (${y.toFixed(1)} px, reading line ${reading.toFixed(1)} px)`);
      if (!run.larger && [1, Math.floor(sections.length / 2), sections.length - 1].includes(i)) await shoot(`learned-${run.id}-x${run.playAt}-section-${i + 1}`);
      lastTop = top;
    }
    console.log(`     ${where}: heading y at each section start: ${landed.join(", ")}`);
    await playTo(run.end - 0.5);
    const late = await place();
    check(late.on && late.top > lastTop + 20, `${where}: after the last section starts the sheet keeps moving until the song ends (${lastTop.toFixed(0)} px to ${late.top.toFixed(0)} px)`);
    await playTo(run.end + 0.5);
    await pause(50);
    check(!(await place()).on, `${where}: the scroll stops at the song's end`);
    await send("Emulation.setDeviceMetricsOverride", PHONE);
  }

  {
    const oldChart = original.songs.find((song) => song.id === NO_HALF_STEPPIN)!.body.map((section) => section.heading);
    const at = [1, 12, 45, 75, 110, 150, 190];
    const end = 232;
    const downbeat = at[0] + (4 * 60) / 112;
    const beats = Array.from({ length: Math.floor(((end - downbeat) * 112) / 60) }, (_, k) => +(downbeat + (k * 60) / 112).toFixed(3));
    const sections = oldChart.map((heading, i) => ({ heading, at: at[i] }));
    const version = { name: "V1", bpm: 112, marks: [{ at: 0, progress: 0 }, { at: end, progress: 1 }], learned: { beatsPerBar: 4, downbeat, beats, sections, vocals: [] } };
    await openSong(NO_HALF_STEPPIN, 1, `localStorage.clear(); localStorage.setItem("${app.SCROLL_VERSIONS_KEY}.${NO_HALF_STEPPIN}", ${JSON.stringify(JSON.stringify({ versions: [version], selected: 0 }))})`);
    const headings = await evaluate<string[]>(`[...document.querySelectorAll(".chart-heading")].map((heading) => heading.textContent)`);
    check(sections.length > headings.length, `a V1 learned on the old chart has more sections (${sections.length}) than No Half Steppin' now has headings (${headings.length})`);
    await click(".scroll-pill");
    await until(`window.__frames(0) > 0`, "the scroll loop");
    let reading = 0;
    const seen: string[] = [];
    let frames = 0;
    let top = 0;
    let forward = true;
    for (const section of sections) {
      const count = Math.round(section.at * 60) - frames;
      frames += count;
      await evaluate(`window.__frames(${count})`);
      const now = await evaluate<{ top: number; ys: number[]; cue: string }>(`(() => {
        const sheet = document.getElementById("sheet-scroll");
        const view = sheet.getBoundingClientRect().top;
        return { top: sheet.scrollTop, ys: [...document.querySelectorAll(".chart-heading")].map((heading) => heading.getBoundingClientRect().top - view), cue: document.querySelector(".cue")?.textContent ?? "" };
      })()`);
      forward &&= now.top >= top;
      top = now.top;
      if (section === sections[0]) reading = now.ys[0];
      const nearest = now.ys.reduce((best, y, i) => (Math.abs(y - reading) < Math.abs(now.ys[best] - reading) ? i : best), 0);
      seen.push(`${section.at} s old ${section.heading.split(/\s+[(—]/)[0]} -> ${headings[nearest].split(/\s+[(—]/)[0]} on the reading line`);
    }
    console.log(`     old 7-section V1 on the 6-heading chart: ${seen.join("; ")}`);
    await evaluate(`window.__frames(${Math.round((end - 0.5) * 60) - frames})`);
    const late = await evaluate<{ on: boolean; top: number }>(`({ on: document.querySelector(".scroll-pill").textContent.includes("On"), top: document.getElementById("sheet-scroll").scrollTop })`);
    await evaluate(`window.__frames(60)`);
    await pause(50);
    const stopped = !(await evaluate<boolean>(`document.querySelector(".scroll-pill").textContent.includes("On")`));
    const errors = await evaluate<string[]>(`window.__errors`);
    check(forward && late.on && late.top > top && stopped, `the old V1 plays: the sheet moves forward through every section and keeps going until the song's end, then stops (${top.toFixed(0)} px at the last old section, ${late.top.toFixed(0)} px near the end, stopped ${stopped})`);
    check(errors.length === 0 && !!(await evaluate<boolean>(`!!document.querySelector(".chart-heading")`)), `the old V1 throws nothing and the sheet stays up (${errors.length ? errors.join("; ") : "no page errors"})`);
  }
} finally {
  await site.close();
}

if (failures) {
  console.error(`${failures} learned check(s) failed`);
  process.exit(1);
}
console.log("learned ok: the Learn panel is on top at phone size, Learn names its version like Teach, and learned headings land on the reading line at any text size");
