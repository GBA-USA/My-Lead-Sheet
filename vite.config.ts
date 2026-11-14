import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
const NOT_PRECACHED = new Set([WORKER, "404.html"]);

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
  plugins: [react(), shipLibrary(), privacyPage(), stampServiceWorker()],
});
