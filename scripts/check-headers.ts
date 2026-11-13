import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { build as bundle } from "esbuild";
import { build } from "vite";
import type { LibraryFile } from "../src/types.ts";

const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const WIDTHS = [320, 390, 768];
/** Set SHOTS to a folder to save the Bass table at every width and scale for the first song. */
const shots = process.env.SHOTS;

const root = new URL("..", import.meta.url).pathname;
const seed = JSON.parse(readFileSync(join(root, "data/library.json"), "utf8")) as LibraryFile;
const storage = await bundle({ entryPoints: [join(root, "src/storage.ts")], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
const { TEXT_SCALES, TEXT_SCALE_KEY } = (await import(`data:text/javascript,${encodeURIComponent(storage.outputFiles[0].text)}`)) as typeof import("../src/storage.ts");

const out = mkdtempSync(join(tmpdir(), "check-headers-"));
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

const profile = mkdtempSync(join(tmpdir(), "check-headers-chrome-"));
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

/** Resolves once the sheet for `title` is drawn with its fonts loaded. */
const shown = (title: string) => `new Promise((resolve) => {
  const ready = () => document.querySelector(".sheet-name")?.textContent === ${JSON.stringify(title)} && document.querySelector(".bass th");
  const wait = () => (ready() ? document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(resolve))) : setTimeout(wait, 10));
  wait();
})`;

/**
 * Every word of every Bass table header must sit on one line inside its cell's content box,
 * and the table must fit the sheet without overflowing sideways.
 */
const measure = `(() => {
  const inner = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { left: rect.left + parseFloat(style.paddingLeft), right: rect.right - parseFloat(style.paddingRight) };
  };
  const problems = [];
  const table = document.querySelector(".sheet .bass");
  for (const th of table.querySelectorAll("th")) {
    const cell = inner(th);
    const walker = document.createTreeWalker(th, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const word of node.data.matchAll(/\\S+/g)) {
        const range = document.createRange();
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        const lines = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)));
        const box = range.getBoundingClientRect();
        if (lines.size > 1) problems.push(\`"\${word[0]}" splits across \${lines.size} lines\`);
        if (box.left < cell.left - 0.5 || box.right > cell.right + 0.5) problems.push(\`"\${word[0]}" spills out of its column\`);
      }
    }
  }
  if (table.getBoundingClientRect().right > inner(document.querySelector(".sheet")).right + 0.5) problems.push("the table is wider than the sheet");
  const scroller = document.querySelector(".scroll");
  if (document.documentElement.scrollWidth > innerWidth || scroller.scrollWidth > scroller.clientWidth) problems.push("the sheet overflows sideways");
  return problems;
})()`;

let failures = 0;
let views = 0;
try {
  for (const [index, scale] of TEXT_SCALES.entries()) {
    await send("Emulation.setDeviceMetricsOverride", { width: WIDTHS[0], height: 900, deviceScaleFactor: 2, mobile: false });
    await send("Page.navigate", { url: `${origin}/` });
    await evaluate(`new Promise((resolve) => { const wait = () => (document.readyState === "complete" ? resolve() : setTimeout(wait, 10)); wait(); })`);
    await evaluate(`localStorage.setItem(${JSON.stringify(TEXT_SCALE_KEY)}, "${index}")`);
    await send("Page.navigate", { url: `${origin}/?scale=${index}#/song/${seed.songs[0].id}` });
    for (const width of WIDTHS) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: false });
      for (const song of seed.songs) {
        await evaluate(`location.hash = "#/song/${song.id}"`);
        await evaluate(shown(song.title));
        views += 1;
        for (const problem of await evaluate<string[]>(measure)) {
          failures += 1;
          console.error(`FAIL ${song.title} @${width}px x${scale}: ${problem}`);
        }
        if (shots && song === seed.songs[0]) {
          const clip = await evaluate<object>(`(() => {
            const table = document.querySelector(".bass");
            table.scrollIntoView({ block: "start" });
            const top = table.getBoundingClientRect().top;
            const rows = table.querySelectorAll("tr");
            const bottom = rows[Math.min(rows.length - 1, 2)].getBoundingClientRect().bottom;
            return { x: 0, y: top - 8, width: innerWidth, height: bottom - top + 16, scale: 1 };
          })()`);
          const shot = await send("Page.captureScreenshot", { format: "png", clip });
          mkdirSync(shots, { recursive: true });
          writeFileSync(join(shots, `headers-${width}px-x${scale}.png`), Buffer.from(shot.data, "base64"));
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

if (failures) {
  console.error(`${failures} header check(s) failed across ${views} views`);
  process.exit(1);
}
console.log(`headers ok: no Bass table header word splits or spills, and the table fits, across ${seed.songs.length} songs x ${WIDTHS.length} widths x ${TEXT_SCALES.length} text scales (${views} views)`);
