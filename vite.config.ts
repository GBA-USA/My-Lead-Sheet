import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { privacyPage } from "./scripts/build-privacy.ts";

function shipLibrary(): Plugin {
  return {
    name: "ship-library",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "data/library.json",
        source: readFileSync("data/library.json", "utf8"),
      });
    },
  };
}

const WORKER = "sw.js";
const WORKER_BUILD_LINE = 'const BUILD = { version: "dev", files: [] };';
const PUBLISHED = "build.json";
/** build.json stays out of the worker's cache: a cached copy would always match the worker that holds it, so a page could never see it is behind. */
const NOT_PRECACHED = new Set([WORKER, "404.html", PUBLISHED]);

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const BUILD_ENV = "MLS_BUILD_ID";
const SOURCE_INPUTS = ["src", "public", "data", "index.html", "package-lock.json", "vite.config.ts", "scripts/build-privacy.ts"];

/** A hash of every source input, sorted by path, so the same source always gives the same id and no clock goes in. */
function sourceId(): string {
  const files = SOURCE_INPUTS.flatMap((input) =>
    statSync(join(ROOT, input)).isDirectory() ? (readdirSync(join(ROOT, input), { recursive: true }) as string[]).map((file) => join(input, file)) : [input],
  )
    .filter((file) => statSync(join(ROOT, file)).isFile())
    .map((file) => file.split(sep).join("/"))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file}\0`).update(readFileSync(join(ROOT, file))).update("\0");
  return hash.digest("hex").slice(0, 16);
}

/** This release's version id: the source hash, or the one `MLS_BUILD_ID` names, so a check can make two builds that differ only here. */
function buildId(): string {
  const named = process.env[BUILD_ENV];
  if (named === undefined || named === "") return sourceId();
  if (named.length > 64) throw new Error(`${BUILD_ENV} must be at most 64 characters`);
  return named;
}
const BUILD_ID = buildId();

/** Publishes the version id beside the page, as build.json `{ "id": ... }`, from the same value the page is compiled with. */
function publishBuildId(): Plugin {
  return {
    name: "publish-build-id",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: PUBLISHED, source: JSON.stringify({ id: BUILD_ID }) });
    },
  };
}

/** Writes the release's file list and a hash of their bytes into sw.js, so every deploy installs a new worker with a fresh cache. */
function stampServiceWorker(): Plugin {
  let outDir = "";
  return {
    name: "stamp-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const files = (readdirSync(outDir, { recursive: true }) as string[])
        .filter((file) => statSync(join(outDir, file)).isFile() && !NOT_PRECACHED.has(file) && !file.endsWith(".woff"))
        .sort();
      const hash = createHash("sha256");
      for (const file of files) hash.update(`${file}\0`).update(readFileSync(join(outDir, file)));
      const path = join(outDir, WORKER);
      const source = readFileSync(path, "utf8");
      if (!source.includes(WORKER_BUILD_LINE)) throw new Error(`public/${WORKER} must keep the line ${WORKER_BUILD_LINE}`);
      const build = { version: hash.digest("hex").slice(0, 16), files };
      writeFileSync(path, source.replace(WORKER_BUILD_LINE, `const BUILD = ${JSON.stringify(build)};`));
    },
  };
}

export default defineConfig({
  base: "./",
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [react(), shipLibrary(), privacyPage(), publishBuildId(), stampServiceWorker()],
});
