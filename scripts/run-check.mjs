import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { checkFile, checkNames, root } from "./checks.mjs";

const [name, ...args] = process.argv.slice(2);
if (name === "--list") {
  for (const n of checkNames()) console.log(n);
  process.exit(0);
}
const file = name && checkFile(name);
if (!file || !existsSync(file)) {
  console.error(`${name ? `no check named ${name}. ` : ""}usage: npm run check -- <name> [args]`);
  console.error(`checks: ${checkNames().map((n) => n.slice("check:".length)).join(" ")}`);
  process.exit(2);
}
const run = spawnSync(process.execPath, ["--experimental-strip-types", file, ...args], { cwd: root, stdio: "inherit" });
process.exit(run.status ?? 128 + (constants.signals[run.signal] ?? 0));
