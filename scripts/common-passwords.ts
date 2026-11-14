import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Rebuilds public/common-passwords.txt from SecLists (MIT licence, Copyright (c) 2018 Daniel Miessler):
 * Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt at commit 51aa7644c96b3fb6db8de9ecf55aa91195209c80.
 * Download that file and pass its path. The phone refuses passwords under 10 characters anyway, so only longer ones are kept.
 */
const SOURCE_SHA256 = "424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51";
const COUNT = 5000;
const MIN_LENGTH = 10;

const source = process.argv[2];
if (!source) throw new Error("usage: node --experimental-strip-types scripts/common-passwords.ts <xato-net-10-million-passwords-1000000.txt>");
const bytes = readFileSync(source);
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== SOURCE_SHA256) throw new Error(`unexpected source file (sha256 ${digest})`);

const kept = new Set<string>();
for (const line of bytes.toString("utf8").split("\n")) {
  const password = line.trim().toLowerCase();
  if (password.length >= MIN_LENGTH && !/\b(?:terry|gba)/.test(password)) kept.add(password);
  if (kept.size === COUNT) break;
}
writeFileSync(new URL("../public/common-passwords.txt", import.meta.url), [...kept].join("\n") + "\n");
console.log(`wrote ${kept.size} passwords`);
