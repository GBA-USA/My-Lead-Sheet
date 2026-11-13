import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { build as bundle } from "esbuild";
import { build } from "vite";
import type { LibraryFile, Song } from "../src/types.ts";
import { canWrap, chordAnchors, lyricWords, type Row } from "./chord-anchors.ts";

const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const WIDTHS = [320, 390, 768, 1280];
const SCALES = [1, 1.3, 1.5, 1.7];
/** Set SHOTS to a folder to save the chord chart of the two longest songs at 390 and 1280 px, x1, x1.3 and x1.7. */
const shots = process.env.SHOTS;

const root = new URL("..", import.meta.url).pathname;
const seed = JSON.parse(readFileSync(join(root, "data/library.json"), "utf8")) as LibraryFile;
const modules = await bundle({
  stdin: { contents: 'export * from "./src/storage.ts"; export * from "./src/music.ts";', resolveDir: root, loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const app = (await import(`data:text/javascript,${encodeURIComponent(modules.outputFiles[0].text)}`)) as typeof import("../src/storage.ts") & typeof import("../src/music.ts");

const width = (song: Song) => Math.max(...song.body.flatMap((section) => section.lines.flatMap((line) => [line.chords?.length ?? 0, line.chords ? (line.lyrics?.length ?? 0) : 0])));
const longest = [...seed.songs].sort((a, b) => width(b) - width(a)).slice(0, 2);

const out = mkdtempSync(join(tmpdir(), "check-chords-"));
await build({ root, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml" };
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const file = join(out, path === "/" ? "index.html" : path);
  try {
    const body = readFileSync(file);
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

const profile = mkdtempSync(join(tmpdir(), "check-chords-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"], {
  stdio: ["ignore", "ignore", "pipe"],
});
const endpoint = await new Promise<string>((resolve, reject) => {
  let log = "";
  chrome.stderr.on("data", (chunk) => {
    log += chunk;
    const found = log.match(/DevTools listening on (ws:\S+)/);
    if (found) resolve(found[1]);
  });
  chrome.on("exit", () => reject(new Error(`Chrome exited before DevTools was up:\n${log}`)));
});

const socket = new WebSocket(endpoint);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});
let nextId = 0;
let sessionId: string | undefined;
function send(method: string, params: object = {}): Promise<any> {
  const id = (nextId += 1);
  socket.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate<T>(expression: string): Promise<T> {
  const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value as T;
}

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
sessionId = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;

const shown = (title: string) => `new Promise((resolve) => {
  const ready = () => document.querySelector(".sheet-name")?.textContent === ${JSON.stringify(title)} && document.querySelector(".chart .chords");
  const wait = () => (ready() ? document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(resolve))) : setTimeout(wait, 10));
  wait();
})`;

interface Drawn extends Row {
  bars: boolean;
  size: number;
  lyricSize: number;
  /** Pixel width of the wider of the two lines. */
  span: number;
  right: number;
}

/** Each chart row as drawn: its text, font size, right edge, and the lyric column every chord glyph starts over. */
const measure = `(() => {
  const chart = document.querySelector(".chart");
  const box = chart.getBoundingClientRect();
  const range = (node, from, to) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return r.getBoundingClientRect(); };
  const rows = [...chart.querySelectorAll(".pair, .bars")].map((row) => {
    const bars = row.classList.contains("bars");
    const chords = bars ? row : row.querySelector(".chords");
    const lyrics = bars ? null : row.querySelector(".lyrics");
    const text = chords.textContent;
    const lyric = lyrics?.textContent;
    const under = lyrics ?? chords;
    const left = under.getBoundingClientRect().left;
    const sample = lyric ? { node: lyrics.firstChild, length: lyric.length } : { node: chords.firstChild, length: text.length };
    const advance = range(sample.node, 0, sample.length).width / sample.length;
    const at = [...text.matchAll(/\\S+/g)].map((chord) => (range(chords.firstChild, chord.index, chord.index + 1).left - left) / advance);
    const edges = [...(text ? [range(chords.firstChild, 0, text.length)] : []), ...(lyric ? [range(lyrics.firstChild, 0, lyric.length)] : [])];
    return {
      bars,
      chords: text,
      lyrics: lyrics ? lyric : undefined,
      at,
      size: parseFloat(getComputedStyle(chords).fontSize),
      lyricSize: lyrics ? parseFloat(getComputedStyle(lyrics).fontSize) : parseFloat(getComputedStyle(chords).fontSize),
      span: Math.max(...edges.map((edge) => edge.width)),
      right: Math.max(...edges.map((edge) => edge.right)),
    };
  });
  return { left: box.left, width: chart.clientWidth, rows };
})()`;

let views = 0;
let chords = 0;
const shrunk = new Set<string>();
const failed = new Map<string, number>();
function check(ok: boolean, kind: string, detail: string) {
  if (ok) return;
  const count = (failed.get(kind) ?? 0) + 1;
  failed.set(kind, count);
  if (count <= 3) console.error(`FAIL ${kind}: ${detail}`);
}

try {
  for (const scale of SCALES) {
    const index = app.TEXT_SCALES.indexOf(scale as (typeof app.TEXT_SCALES)[number]);
    await send("Emulation.setDeviceMetricsOverride", { width: WIDTHS[0], height: 900, deviceScaleFactor: 2, mobile: false });
    await send("Page.navigate", { url: `${origin}/` });
    await evaluate(`new Promise((resolve) => { const wait = () => (document.readyState === "complete" ? resolve() : setTimeout(wait, 10)); wait(); })`);
    await evaluate(`localStorage.setItem(${JSON.stringify(app.TEXT_SCALE_KEY)}, "${index}")`);
    await send("Page.navigate", { url: `${origin}/?scale=${index}#/song/${seed.songs[0].id}` });
    const normal = +(13 * scale).toFixed(2);
    for (const window of WIDTHS) {
      await send("Emulation.setDeviceMetricsOverride", { width: window, height: 900, deviceScaleFactor: 2, mobile: false });
      for (const song of seed.songs) {
        await evaluate(`location.hash = "#/song/${song.id}"`);
        await evaluate(shown(song.title));
        views += 1;
        const where = `${song.title} @${window}px x${scale}`;
        const page = await evaluate<{ left: number; width: number; rows: Drawn[] }>(measure);
        const source: Row[] = song.body.flatMap((section) =>
          section.lines.flatMap((line) => (line.chords === undefined ? [] : [{ chords: app.displayChordLine(line.chords, song, 0, "notes"), lyrics: line.lyrics }])),
        );
        const drawn = page.rows.filter((row) => !row.bars);
        for (const row of drawn) {
          const off = row.at!.find((column) => Math.abs(column - Math.round(column)) > 0.05);
          check(off === undefined, "a chord is drawn between lyric columns", `${where} (column ${off?.toFixed(2)} in "${row.chords.trim()}")`);
          row.at = row.at!.map(Math.round);
        }
        const want = chordAnchors(source);
        const got = chordAnchors(drawn);
        chords += want.length;
        const miss = want.findIndex((anchor, k) => anchor !== got[k]);
        check(miss < 0 && got.length === want.length, "a chord moved off its notated syllable", `${where}: chord ${miss + 1} of ${want.length} (notated ${want[miss]}, drawn ${got[miss] ?? "nowhere"})`);
        check(lyricWords(drawn).join(" ") === lyricWords(source).join(" "), "a lyric word is cut across two rows", where);
        for (const row of page.rows) {
          const text = `"${row.chords.trim().slice(0, 30)}" / "${row.lyrics?.trim().slice(0, 30) ?? ""}"`;
          check(row.right <= page.left + page.width + 0.5, "a row paints past the chart", `${where} (${text})`);
          check(row.size === row.lyricSize, "chords and lyrics of one row differ in size", `${where} (${row.size}px, ${row.lyricSize}px: ${text})`);
          if (row.size >= normal - 0.01) continue;
          shrunk.add(`${where} ${row.size}px ${text}`);
          check(row.span * (normal / row.size) > page.width - 1, "a row is shrunk though it fits at full size", `${where} (${row.size}px, not ${normal}px: ${text})`);
          check(!canWrap(row), "a row is shrunk instead of wrapping between words", `${where} (${row.size}px, not ${normal}px: ${text})`);
        }
        if (shots && longest.includes(song) && [390, 1280].includes(window) && [1, 1.3, 1.7].includes(scale)) {
          const tall = await evaluate<number>(`document.querySelector(".scroll").scrollHeight + document.querySelector(".scroll").getBoundingClientRect().top`);
          await send("Emulation.setDeviceMetricsOverride", { width: window, height: Math.ceil(tall), deviceScaleFactor: 1, mobile: false });
          await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
          const clip = await evaluate<object>(`(() => { const r = document.querySelector(".chart").getBoundingClientRect(); return { x: 0, y: r.top - 8, width: innerWidth, height: r.height + 16, scale: 1 }; })()`);
          const shot = await send("Page.captureScreenshot", { format: "png", clip });
          mkdirSync(shots, { recursive: true });
          writeFileSync(join(shots, `chart-${song.id}-${window}px-x${scale}.png`), Buffer.from(shot.data, "base64"));
          await send("Emulation.setDeviceMetricsOverride", { width: window, height: 900, deviceScaleFactor: 2, mobile: false });
        }
      }
    }
  }
} finally {
  socket.close();
  chrome.kill();
  server.close();
  await new Promise((resolve) => (chrome.exitCode === null ? chrome.once("exit", resolve) : resolve(null)));
  rmSync(profile, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
}

console.log(`longest charts: ${longest.map((song) => `${song.title} (${width(song)} columns)`).join(", ")}`);
console.log(`rows below ${SCALES.map((scale) => `${+(13 * scale).toFixed(2)}px`).join("/")}: ${shrunk.size}`);
for (const row of [...shrunk].slice(0, 12)) console.log(`  ${row}`);
if (failed.size) {
  for (const [kind, count] of failed) console.error(`${count} x ${kind}`);
  console.error(`chord checks failed across ${views} views`);
  process.exit(1);
}
console.log(`chords ok: ${chords} chords over their notated syllables, no lyric word cut, chart at 13px x scale except lone units wider than the chart, across ${seed.songs.length} songs x ${WIDTHS.length} widths x ${SCALES.length} text scales (${views} views)`);
