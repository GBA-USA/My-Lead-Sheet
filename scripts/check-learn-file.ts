/**
 * L1.15: a real WAV through the real file input is heard to the end. Headless Chrome builds the app, opens a song,
 * takes Learn by listen, and hands the sheet's <input type="file"> a WAV on disk with DOM.setFileInputFiles. The
 * browser decodes it and the built module worker analyzes it; the Review must say it heard the whole file, and the
 * mic must never be asked for. Runs at a phone's 360 and 390 px and a computer's 1280 px.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LibraryFile } from "../src/types.ts";
import { openSite } from "./chrome.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as LibraryFile;
const SONG = 13;
const WAV_RATE = 44_100;
const WAV_SECONDS = 47.5;

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
}

/** A 16-bit stereo WAV: two seconds of room hiss, then a kick and a bass note on every beat at 120 BPM to the end. */
function wav(seconds: number, rate: number): Buffer {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(44 + frames * 4);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + frames * 4, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(frames * 4, 40);
  let state = 20261123;
  const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const beat = 0.5;
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    let x = 0.003 * (random() * 2 - 1);
    if (t >= 2) {
      const since = (t - 2) % beat;
      x += 0.5 * Math.sin(2 * Math.PI * (50 * since + 0.9 * (1 - Math.exp(-since / 0.013)))) * Math.exp(-since / 0.1);
      x += 0.15 * Math.sin(2 * Math.PI * 55 * t) * Math.min(1, since / 0.01);
    }
    const sample = Math.round(Math.max(-1, Math.min(1, x)) * 32767);
    data.writeInt16LE(sample, 44 + i * 4);
    data.writeInt16LE(sample, 46 + i * 4);
  }
  return data;
}

/** Runs before the app: counts every ask for the mic, and records each worker the page starts and how. */
const STAND_INS = `(() => {
  window.__errors = [];
  addEventListener("error", (event) => window.__errors.push(String(event.message)));
  addEventListener("unhandledrejection", (event) => window.__errors.push(String(event.reason)));
  window.__micAsks = 0;
  const ask = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: (...args) => ((window.__micAsks += 1), ask(...args)) });
  window.__workers = [];
  const RealWorker = window.Worker;
  window.Worker = class extends RealWorker {
    constructor(url, options) {
      super(url, options);
      window.__workers.push({ url: String(url), type: options?.type ?? "classic" });
    }
  };
})()`;

const scratch = mkdtempSync(join(tmpdir(), "check-learn-file-"));
const file = join(scratch, "Practice Take.wav");
writeFileSync(file, wav(WAV_SECONDS, WAV_RATE));
const title = seed.songs.find((song) => song.id === SONG)?.title ?? "";

const site = await openSite(root, "check-learn-file");
const { send, evaluate } = site;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(expression: string, what: string, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(50)) if (await evaluate<boolean>(expression)) return;
  throw new Error(`timed out waiting for ${what} (${await evaluate<string>(`document.querySelector("[role=dialog]")?.innerText ?? document.body.innerText.slice(0, 200)`)})`);
}
async function click(selector: string, text?: string) {
  const found = await evaluate<boolean>(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => ${text === undefined ? "true" : `el.textContent.trim() === ${JSON.stringify(text)}`});
    target?.click();
    return !!target;
  })()`);
  if (!found) throw new Error(`no ${selector} ${text ?? ""} to click`);
  await pause(100);
}

try {
  await send("Page.enable");
  await send("DOM.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: STAND_INS });
  let loads = 0;
  for (const size of [
    { width: 360, height: 780, deviceScaleFactor: 3, mobile: true },
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  ]) {
    const at = `at ${size.width} px`;
    try {
      await send("Emulation.setDeviceMetricsOverride", size);
      await send("Page.navigate", { url: `${site.origin}/?load=${(loads += 1)}#/songs` });
      await until(`document.readyState === "complete"`, "the app");
      await evaluate(`localStorage.clear()`);
      await send("Page.navigate", { url: `${site.origin}/?load=${(loads += 1)}#/song/${SONG}` });
      await until(`document.querySelector(".sheet-name")?.textContent === ${JSON.stringify(title)}`, title);

      await click('[aria-label="Scroll settings"]');
      await click("[role=dialog] button", "Learn this song");
      await click('[role=dialog] button[aria-label="Learn by listen"]');
      await until(`!!document.querySelector(".learn input[type=file]")`, "the Learn sheet's file input");
      const spill = await evaluate<string[]>(`(() => {
        const wide = document.documentElement.clientWidth;
        const sheet = document.querySelector(".learn");
        const ways = [...document.querySelectorAll(".learn-way")];
        const past = [...ways, ...document.querySelectorAll(".learn-actions button")]
          .filter((el) => {
            const box = el.getBoundingClientRect();
            return box.left < 0 || box.right > wide || box.height < 44;
          })
          .map((el) => el.textContent.trim().slice(0, 24) + " " + JSON.stringify(el.getBoundingClientRect()));
        if (ways.length !== 2) past.push(ways.length + " ways in");
        if (sheet.scrollWidth > sheet.clientWidth) past.push("the sheet scrolls sideways, " + sheet.scrollWidth + " in " + sheet.clientWidth);
        if (document.documentElement.scrollWidth > wide) past.push("the page scrolls sideways, " + document.documentElement.scrollWidth + " in " + wide);
        return past;
      })()`);
      check(spill.length === 0, `L1 ${at} the two ways in and Cancel fit the screen, each at least 44 px tall (${spill.join("; ") || "nothing past the edge"})`);
      const { root: documentNode } = await send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await send("DOM.querySelector", { nodeId: documentNode.nodeId, selector: ".learn input[type=file]" });
      await send("DOM.setFileInputFiles", { nodeId, files: [file] });
      await until(`!!document.querySelector(".learn-sections")`, "the Review", 60_000);

      const line = await evaluate<string>(`[...document.querySelectorAll(".learn p")].map((p) => p.textContent).find((text) => text.startsWith("From ")) ?? ""`);
      const clock = line.match(/^From a file · (\d+):(\d\d) · /);
      const heard = clock ? 60 * Number(clock[1]) + Number(clock[2]) : Number.NaN;
      check(Math.abs(heard - WAV_SECONDS) <= 1, `L1.15 ${at} the Review says the whole ${WAV_SECONDS} s WAV was heard, within 1 s ("${line}")`);
      const short = await evaluate<string[]>(
        `[...document.querySelectorAll(".learn-actions button")].filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim() + " " + b.getBoundingClientRect().height + " px")`,
      );
      check(short.length === 0, `L1 ${at} every Learn sheet action button is at least 44 px tall (${short.join(", ") || "all 44 px or more"})`);
      const workers = await evaluate<{ url: string; type: string }[]>("window.__workers");
      check(workers.length === 1 && workers[0].type === "module" && /learn-worker/.test(workers[0].url), `L1.15 ${at} one module worker did the listening (${JSON.stringify(workers)})`);
      check((await evaluate<number>("window.__micAsks")) === 0, `L1.15 ${at} the mic was never asked for`);
      const errors = await evaluate<string[]>("window.__errors");
      check(errors.length === 0, `L1.15 ${at} the page threw nothing (${errors.join("; ") || "no errors"})`);
    } catch (error) {
      check(false, `L1.15 ${at} a real WAV through the real file input is heard to the end: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await site.close();
  rmSync(scratch, { recursive: true, force: true });
}

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("check:learn-file passed");
