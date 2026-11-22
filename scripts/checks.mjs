import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const CHECKS_DIR = join(root, "scripts", "checks");
const SUFFIX = ".check.ts";
const NAME = /^(?:check:)?([a-z0-9][a-z0-9-]*)$/;

export const checkNames = () =>
  readdirSync(CHECKS_DIR)
    .filter((file) => file.endsWith(SUFFIX))
    .map((file) => `check:${file.slice(0, -SUFFIX.length)}`)
    .sort();

export function checkFile(name) {
  const m = NAME.exec(name);
  return m ? join(CHECKS_DIR, `${m[1]}${SUFFIX}`) : null;
}
