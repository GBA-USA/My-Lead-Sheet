import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "vite";
import { DATA_KINDS, PRIVACY_HREF } from "../src/data-kinds.ts";
import { CONTACT_PLACEHOLDER } from "./build-privacy.ts";
import { openSite } from "./chrome.ts";

const root = new URL("..", import.meta.url).pathname;

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${message}`);
  }
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).map((file) => join(dir, file)).filter((file) => statSync(file).isFile());
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((found) => found[1].replace(/\.$/, ""));
}

/** Every localStorage key under src/, and every table and Durable Object storage key under worker/. */
function storedKeys(tree: string): Set<string> {
  const keys = new Set<string>();
  for (const file of filesUnder(join(tree, "src"))) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("localStorage")) continue;
    for (const key of matches(text, /\bconst\s+\w*_KEY\s*=\s*["'`]([^"'`$]+)["'`]/g)) keys.add(key);
    for (const key of matches(text, /localStorage\.(?:getItem|setItem|removeItem)\(\s*["'`]([^"'`$]+)/g)) keys.add(key);
  }
  for (const file of filesUnder(join(tree, "worker"))) {
    const text = readFileSync(file, "utf8");
    for (const key of matches(text, /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?(\w+)/gi)) keys.add(key);
    for (const key of matches(text, /storage\.(?:get|put|delete)\(\s*["'`]([^"'`$]+)/g)) keys.add(key);
  }
  return keys;
}

const fixture = mkdtempSync(join(tmpdir(), "privacy-fixture-"));
const seed = (path: string, text: string) => {
  mkdirSync(dirname(join(fixture, path)), { recursive: true });
  writeFileSync(join(fixture, path), text);
};
seed("src/app.ts", 'export const THEME_KEY = "leadSheetsTheme";\nlocalStorage.setItem(`leadSheetsDraft.${id}`, "1");\n');
check(storedKeys(fixture).size === 2, "a tree with no worker/ folder still scans src/");
seed("worker/directory.ts", 'sql.exec(`CREATE TABLE IF NOT EXISTS users (user_id TEXT)`);\nawait this.ctx.storage.put("relay_budget", budget);\n');
seed("worker/schema.sql", "create table google_logins (google_sub text);\n");
const fixtureKeys = [...storedKeys(fixture)].sort().join(",");
check(
  fixtureKeys === "google_logins,leadSheetsDraft,leadSheetsTheme,relay_budget,users",
  `the scan finds seeded keys in src/ and worker/ (found ${fixtureKeys})`,
);
rmSync(fixture, { recursive: true, force: true });

const described = new Set(DATA_KINDS.map((kind) => kind.key));
const stored = storedKeys(root);
check(stored.size > 0, "the scan finds the app's localStorage keys");
for (const key of stored) check(described.has(key), `stored key "${key}" is described in src/data-kinds.ts`);
for (const key of described) check(stored.has(key), `data kind "${key}" is still stored somewhere`);

const contact = `privacy check contact ${process.pid}`;
process.env.VITE_PRIVACY_CONTACT = contact;
const site = await openSite(root, "privacy");
try {
  const page = await fetch(`${site.origin}/${PRIVACY_HREF}`);
  const html = await page.text();
  check(page.ok && /text\/html/.test(page.headers.get("content-type") ?? ""), `the built site serves /${PRIVACY_HREF} as HTML (${page.status})`);
  check(html.includes(`<p id="contact">${contact}</p>`), "the privacy page shows the contact from VITE_PRIVACY_CONTACT");
  for (const kind of DATA_KINDS) check(html.includes(kind.what), `the privacy page describes ${kind.key}`);
  check(/name, your email address/.test(html) && /Deleting your data/.test(html), "the privacy page covers Google sign-in and deleting data");

  await site.send("Page.navigate", { url: `${site.origin}/#/songs` });
  let opened = "";
  for (let tries = 0; tries < 100 && !opened.endsWith(`/${PRIVACY_HREF}`); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    opened = await site
      .evaluate<string>(
        `(() => { const link = document.querySelector('a[href="${PRIVACY_HREF}"]'); if (link && location.hash) link.click(); return location.pathname; })()`,
      )
      .catch(() => "");
  }
  check(opened.endsWith(`/${PRIVACY_HREF}`), `My Songs links to the privacy page (ended on ${opened || "nothing"})`);
  check((await site.evaluate<string>("document.getElementById('contact')?.textContent ?? ''").catch(() => "")) === contact, "the link opens the built privacy page");
} finally {
  await site.close();
}

delete process.env.VITE_PRIVACY_CONTACT;
const plain = mkdtempSync(join(tmpdir(), "privacy-plain-"));
await build({ root, logLevel: "silent", build: { outDir: plain, emptyOutDir: true } });
const plainPage = join(plain, PRIVACY_HREF);
const plainHtml = existsSync(plainPage) ? readFileSync(plainPage, "utf8") : "";
check(plainHtml.includes(`<p id="contact">${CONTACT_PLACEHOLDER}</p>`) && !plainHtml.includes("@"), "a build without VITE_PRIVACY_CONTACT shows placeholder text, not an address");
rmSync(plain, { recursive: true, force: true });

if (failures > 0) {
  console.error(`check:privacy failed (${failures})`);
  process.exit(1);
}
console.log(`check:privacy passed: ${stored.size} stored keys described, /${PRIVACY_HREF} built with the contact var and linked from My Songs`);
