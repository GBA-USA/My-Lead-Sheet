import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, preview, type Plugin, type PreviewServer } from "vite";
import type { LibraryFile } from "../src/types.ts";
import { openSite } from "./chrome.ts";

const root = new URL("..", import.meta.url).pathname;
const seed = JSON.parse(readFileSync(join(root, "data/library.json"), "utf8")) as LibraryFile;

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${message}`);
  }
}

async function buildRelease(name: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), `offline-${name}-`));
  await build({
    root,
    logLevel: "silent",
    build: { outDir, emptyOutDir: true },
    plugins: [{ name: "release-tag", transformIndexHtml: () => [{ tag: "meta", attrs: { name: "release", content: name }, injectTo: "head" }] }],
  });
  return outDir;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return typeof address === "object" && address ? address.port : 0;
}

/** Answers a path with no file behind it the way GitHub Pages does, with 404.html and status 404, instead of vite's index.html fallback. */
const pagesNotFound = (outDir: string, base: string): Plugin => ({
  name: "pages-not-found",
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = decodeURIComponent(new URL(req.url ?? "/", "http://preview").pathname);
      const file = join(outDir, path.slice(base.length), path.endsWith("/") ? "index.html" : "");
      if (!path.startsWith(base) || (existsSync(file) && statSync(file).isFile())) return next();
      res.statusCode = 404;
      res.setHeader("content-type", "text/html");
      res.end(readFileSync(join(outDir, "404.html")));
    });
  },
});

const LANDING_WAIT_MS = 6000;
const CODE = "friend-link.AAAAAAAAAAAAAAAA.1999999999999.AAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const slowCodeLanding = (base: string): Plugin => ({
  name: "slow-code-landing",
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      const code = new URL(req.url ?? "/", "http://preview").pathname.match(/\/c\/([^/]+)$/)?.[1];
      if (!code) return next();
      setTimeout(() => {
        res.writeHead(302, { Location: `${base}?open=friends&code=${code}`, "Cache-Control": "no-store" });
        res.end();
      }, LANDING_WAIT_MS);
    });
  },
});

const serve = (outDir: string, base: string, port: number): Promise<PreviewServer> =>
  preview({
    root,
    base,
    logLevel: "silent",
    build: { outDir },
    preview: { host: "127.0.0.1", port, strictPort: true },
    plugins: [slowCodeLanding(base), pagesNotFound(outDir, base)],
  });

const releases = [await buildRelease("first"), await buildRelease("second")];
// openSite's own server cannot be stopped mid-test, so this check serves its builds with vite preview and borrows only the Chrome tab.
const chrome = await openSite(root, "offline-chrome");

async function until<T>(expression: string, done: (value: T) => boolean, label: string): Promise<T | undefined> {
  let value: T | undefined;
  for (let tries = 0; tries < 150; tries += 1) {
    value = await chrome.evaluate<T>(expression).catch(() => undefined);
    if (value !== undefined && done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.error(`  timed out waiting for ${label}, last value ${JSON.stringify(value)}`);
  return value;
}

const currentEntry = async (): Promise<{ id: number; url: string }> => {
  const { currentIndex, entries } = await chrome.send("Page.getNavigationHistory");
  return entries[currentIndex];
};
const offline = (on: boolean) => chrome.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
const release = () => until<string>("document.querySelector('meta[name=release]')?.content ?? ''", (value) => value !== "", "the page");
const ourCaches = () => until<string[]>("caches.keys().then((keys) => keys.filter((key) => key.startsWith('lead-sheets ')))", () => true, "cache names");

async function showsSongsAndSheet(where: string) {
  const rows = await until<number>("document.querySelectorAll('.song-list .song-row').length", (count) => count === seed.songs.length, "the song list");
  check(rows === seed.songs.length, `${where}: My Songs lists all ${seed.songs.length} songs (saw ${rows})`);
  await chrome.evaluate("document.querySelector('.song-list .song-row')?.click()");
  const title = await until<string>("document.querySelector('.sheet .sheet-name')?.textContent ?? ''", (text) => text !== "", "a sheet");
  check(title === seed.songs[0].title, `${where}: the first song's sheet renders (saw "${title}")`);
  const chords = await chrome.evaluate<number>("document.querySelectorAll('.sheet .chart').length");
  check(chords > 0, `${where}: the sheet shows its chord chart`);
}

async function reloadAt(url: string) {
  await chrome.send("Page.navigate", { url });
  await chrome.evaluate("window.beforeReload = true");
  await chrome.send("Page.reload");
  await until<boolean>("!window.beforeReload && document.readyState === 'complete'", Boolean, "the reload");
}

await chrome.send("Network.enable");
try {
  for (const base of ["/", "/sub/"]) {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}${base}#/songs`;
    let server = await serve(releases[0], base, port);

    await offline(false);
    await chrome.send("Page.navigate", { url });
    check((await release()) === "first", `${base}: the first release loads online`);
    const controlled = await until<boolean>("!!navigator.serviceWorker?.controller", Boolean, "the service worker to take control");
    check(controlled === true, `${base}: a service worker controls the page after the first open`);
    const firstCaches = (await ourCaches()) ?? [];
    await chrome.evaluate("fetch('api/ping')");
    check(firstCaches.length === 1, `${base}: one app cache after install (saw ${firstCaches.join(" | ")})`);

    for (const deep of ["foo/bar", "songs/"]) {
      await chrome.send("Page.navigate", { url: `http://127.0.0.1:${port}${base}${deep}` });
      const opened = await until<{ path: string; rows: number }>(
        "({ path: location.pathname, rows: document.querySelectorAll('.song-list .song-row').length })",
        (page) => page.rows === seed.songs.length,
        `${base}${deep} to reach the song list`,
      );
      check(
        opened?.path === base && opened.rows === seed.songs.length,
        `${base}: online with the worker in control, ${base}${deep} ends at ${base} with all ${seed.songs.length} songs (saw ${JSON.stringify(opened)})`,
      );
    }

    const codeLink = `http://127.0.0.1:${port}${base}c/${CODE}`;
    const before = (await currentEntry()).id;
    const arrived = (entry: { id: number; url: string }) => entry.id !== before && new URL(entry.url).pathname === base;
    void chrome.send("Page.navigate", { url: codeLink });
    let entry = await currentEntry();
    for (const started = Date.now(); Date.now() - started < LANDING_WAIT_MS + 6000 && !arrived(entry); ) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      entry = await currentEntry();
    }
    if (!arrived(entry)) {
      throw new Error(`${base}: a code link whose landing takes ${LANDING_WAIT_MS} ms never reached ${base}, last committed page ${entry.url}`);
    }
    const landed = await until<{ path: string; rows: number; signIn: boolean }>(
      "({ path: location.pathname, rows: document.querySelectorAll('.song-list .song-row').length, signIn: !!document.querySelector('.account-sheet') })",
      (page) => page.rows === seed.songs.length && page.signIn,
      `${base}c/ to land in the app`,
    );
    check(
      landed?.path === base && landed.rows === seed.songs.length && landed.signIn,
      `${base}: a code link whose landing takes ${LANDING_WAIT_MS} ms still opens the app, signed out at the sign-in sheet (saw ${JSON.stringify(landed)})`,
    );

    await server.close();
    await offline(true);
    const offlineCode = await chrome.send("Page.navigate", { url: codeLink });
    if (typeof offlineCode.errorText !== "string") {
      throw new Error(`${base}: offline, a code link got the app shell at a path its files can't load from, not the browser's own offline page (saw ${JSON.stringify(offlineCode)})`);
    }
    await reloadAt(url);
    check((await release()) === "first", `${base}: offline reload with the server gone still opens the app`);
    await showsSongsAndSheet(`${base} offline`);
    const probe = await chrome.evaluate<string>("fetch('not-shipped.txt').then((r) => 'answered ' + r.status, () => 'no network')");
    check(probe === "no network", `${base}: the network really is down during the offline run (${probe})`);
    const api = await chrome.evaluate<string>("fetch('api/ping').then((r) => 'answered ' + r.status, () => 'no network')");
    check(api === "no network", `${base}: /api/ is never answered from the cache (${api})`);

    server = await serve(releases[1], base, port);
    await offline(false);
    await reloadAt(url);
    check((await release()) === "second", `${base}: online after a new deploy, the new release opens at once`);
    const swapped = await until<string[]>(
      "caches.keys().then((keys) => keys.filter((key) => key.startsWith('lead-sheets ')))",
      (keys) => keys.length === 1 && keys[0] !== firstCaches[0],
      "the old cache to be replaced",
    );
    check(swapped?.length === 1 && swapped[0] !== firstCaches[0], `${base}: the new worker replaced the old cache (saw ${swapped?.join(" | ")})`);

    await server.close();
    await offline(true);
    await reloadAt(url);
    check((await release()) === "second", `${base}: offline after the deploy opens the new release, not the old one`);
    await showsSongsAndSheet(`${base} offline after deploy`);
  }
} finally {
  await chrome.close();
  for (const outDir of releases) rmSync(outDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`check:offline failed (${failures})`);
  process.exit(1);
}
console.log("check:offline passed: at / and /sub/, the app opens offline with songs and a sheet, a deep path online still reaches the app through 404.html, a code link is never answered by the service worker, and a new deploy replaces the old cache");
