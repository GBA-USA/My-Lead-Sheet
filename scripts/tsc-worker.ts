import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const { status } = spawnSync(process.execPath, [tsc, "-p", "worker"], { cwd: root, stdio: "inherit" });
if (status !== 0) process.exit(status ?? 1);
