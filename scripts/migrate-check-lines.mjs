import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { CHECKS_DIR, checkFile, root } from "./checks.mjs";

const COMMAND = /^(tsc -p worker && )?node (?:--experimental-strip-types )?(\S+\.(?:ts|mjs))$/;
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
mkdirSync(CHECKS_DIR, { recursive: true });

let left = 0;
for (const [key, command] of Object.entries(pkg.scripts ?? {})) {
  if (!key.startsWith("check:")) continue;
  const m = COMMAND.exec(command);
  const file = checkFile(key);
  if (!m || !file) {
    console.log(`left ${key}: cannot turn "${command}" into a scripts/checks file`);
    left++;
    continue;
  }
  const body = `${m[1] ? 'import "../tsc-worker.ts";\n' : ""}import "${posix.relative("scripts/checks", m[2])}";\n`;
  if (existsSync(file) && readFileSync(file, "utf8").replaceAll("\r\n", "\n") !== body) {
    console.log(`left ${key}: ${posix.relative(root.replaceAll("\\", "/"), file.replaceAll("\\", "/"))} already exists and runs something else`);
    left++;
    continue;
  }
  writeFileSync(file, body);
  delete pkg.scripts[key];
}
pkg.scripts.check ??= "node scripts/run-check.mjs";
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(left ? `${left} check:* lines left in package.json` : "no check:* lines left in package.json");
process.exit(left ? 1 : 0);
