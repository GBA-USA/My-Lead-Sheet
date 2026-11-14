import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { runInNewContext } from "node:vm";
import { experimental_readRawConfig, unstable_readConfig } from "wrangler";

type Rule = { name: string; pattern: RegExp; allowedInVars: boolean };
type Finding = { file: string; line: number; rule: string; text: string };

const RULES: Rule[] = [
  { name: "cloudflare-account-or-key-id", pattern: /\b[0-9a-f]{32}\b/gi, allowedInVars: true },
  { name: "workers-or-pages-dev-host", pattern: /\b[a-z0-9-]+\.(?:workers|pages)\.dev\b/gi, allowedInVars: true },
  { name: "email", pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi, allowedInVars: true },
  { name: "literal-origin", pattern: /\bhttps?:\/\/(?!localhost\b|127\.0\.0\.1\b|www\.w3\.org\/)[^\s"'`<>)]+/gi, allowedInVars: true },
  { name: "relying-party-id", pattern: /\brp_?id\b\s*[:=]\s*["'`][^"'`]+/gi, allowedInVars: true },
  { name: "repo-base-path", pattern: /\/My-Lead-Sheet\b/g, allowedInVars: true },
  { name: "terry-or-gba", pattern: /\b(?:terry|gba|guardian\s?bee)/gi, allowedInVars: false },
];

const SCANNED_DIRS = ["src", "worker", "functions", "public", ".github/workflows"];
const SCANNED_FILES = ["index.html", "vite.config.ts", "package.json", "tsconfig.json"];
const SKIPPED = /(^|\/)(node_modules|\.wrangler)(\/|$)|\.(md|ico|png|jpe?g|webp|woff2?)$/;
const WRANGLER_CONFIG = "worker/wrangler.jsonc";

function filesIn(root: string, path: string): string[] {
  const full = join(root, path);
  let stat;
  try {
    stat = statSync(full);
  } catch {
    return [];
  }
  if (stat.isFile()) return SKIPPED.test(path) ? [] : [path];
  return readdirSync(full).flatMap((name) => filesIn(root, join(path, name)));
}

function varsValues(root: string): string[] {
  const { rawConfig } = experimental_readRawConfig({ config: join(root, WRANGLER_CONFIG) });
  return Object.values(rawConfig.env ?? {}).flatMap((env) =>
    Object.values(env.vars ?? {}).filter((value): value is string => typeof value === "string" && value !== ""),
  );
}

function scanText(file: string, text: string, rules: Rule[]): Finding[] {
  return text.split("\n").flatMap((line, index) =>
    rules.flatMap((rule) =>
      [...line.matchAll(rule.pattern)].map((match) => ({ file, line: index + 1, rule: rule.name, text: match[0] })),
    ),
  );
}

function scan(root: string): Finding[] {
  const files = [...SCANNED_DIRS, ...SCANNED_FILES].flatMap((path) => filesIn(root, path));
  return files.flatMap((file) => {
    const text = readFileSync(join(root, file), "utf8");
    if (file !== WRANGLER_CONFIG) return scanText(file, text, RULES);
    const withoutVars = varsValues(root).reduce((rest, value) => rest.replaceAll(JSON.stringify(value), '""'), text);
    return [
      ...scanText(file, text, RULES.filter((rule) => !rule.allowedInVars)),
      ...scanText(file, withoutVars, RULES.filter((rule) => rule.allowedInVars)),
    ];
  });
}

function plantTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "check-portable-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function wranglerWithVars(vars: Record<string, string>, extra = "") {
  return JSON.stringify({ name: "mls-rooms", env: { production: { vars } }, ...(extra ? { routes: [extra] } : {}) }, null, 2);
}

function checkPlantedFixtures() {
  const accountId = "0123456789abcdef0123456789abcdef";
  const planted: Record<string, [string, string]> = {
    "src/account.ts": ["cloudflare-account-or-key-id", `export const account = "${accountId}";`],
    "functions/api/host.ts": ["workers-or-pages-dev-host", `fetch("//mls-rooms.someone.workers.dev/api")`],
    "src/preview.ts": ["workers-or-pages-dev-host", `const site = "my-lead-sheet-preview.pages.dev";`],
    "worker/contact.ts": ["email", `const contact = "owner@example.org";`],
    "vite.config.ts": ["literal-origin", `const origin = "https://leadsheets.example.net";`],
    "worker/google.ts": ["literal-origin", `const redirect = "https://app.example.net/api/google/callback";`],
    "worker/passkey.ts": ["relying-party-id", `const options = { rpId: "leadsheets.example.net" };`],
    "public/404.html": ["repo-base-path", `<a href="/My-Lead-Sheet/">home</a>`],
    "src/credit.ts": ["terry-or-gba", `const owner = "GBA-USA";`],
    ".github/workflows/pages.yml": ["workers-or-pages-dev-host", `# deploys to x.pages.dev`],
  };
  for (const [file, [rule, text]] of Object.entries(planted)) {
    const root = plantTree({ [file]: text });
    const findings = scan(root);
    rmSync(root, { recursive: true });
    assert.ok(findings.some((f) => f.file === file && f.rule === rule), `planted ${rule} in ${file} is caught, got ${JSON.stringify(findings)}`);
  }

  const ownerVars = { APP_ORIGIN: "https://leadsheets.example.net", CF_ACCOUNT_ID: accountId, PRIVACY_CONTACT: "owner@example.org" };
  const filled = plantTree({ [WRANGLER_CONFIG]: wranglerWithVars(ownerVars), "worker/README.md": `${accountId} x.pages.dev Terry` });
  assert.deepEqual(scan(filled), [], "owner values in env vars slots and docs are allowed");
  rmSync(filled, { recursive: true });

  const outsideVars = plantTree({ [WRANGLER_CONFIG]: wranglerWithVars({}, "rooms.someone.workers.dev/*") });
  assert.ok(scan(outsideVars).some((f) => f.rule === "workers-or-pages-dev-host"), "a host outside the vars slots is caught");
  rmSync(outsideVars, { recursive: true });

  const terryVar = plantTree({ [WRANGLER_CONFIG]: wranglerWithVars({ PRIVACY_CONTACT: "terry@example.org" }) });
  assert.ok(scan(terryVar).some((f) => f.rule === "terry-or-gba"), "a Terry string is caught even in a vars slot");
  rmSync(terryVar, { recursive: true });
}

async function notFoundRedirect(pathname: string, existing: string[]): Promise<string | null> {
  const html = readFileSync("public/404.html", "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, "404.html has an inline script");
  let target: string | null = null;
  const location = { pathname, search: "?s=1", hash: "#/song/3", replace: (url: string) => (target = url) };
  const fetch = async (url: string) => ({ ok: existing.includes(url) });
  runInNewContext(script, { location, fetch });
  for (let tick = 0; tick < 50 && target === null; tick++) await new Promise((resolve) => setTimeout(resolve, 0));
  return target;
}

async function checkNotFoundPage() {
  assert.equal(await notFoundRedirect("/My-Lead-Sheet/song/3", ["/My-Lead-Sheet/"]), "/My-Lead-Sheet/?s=1#/song/3", "a project-path site goes back to its own root");
  assert.equal(await notFoundRedirect("/song/3/", ["/"]), "/?s=1#/song/3", "a root site goes back to /");
  assert.equal(await notFoundRedirect("/x/y", []), null, "no root found leaves the page alone");
}

function checkProductionConfig() {
  const config = unstable_readConfig({ config: WRANGLER_CONFIG, env: "production" });
  const classes = config.durable_objects.bindings.map((binding) => binding.class_name).sort();
  assert.deepEqual(classes, ["Directory", "Room"], "env.production binds the Directory and Room classes");
  const migrated = config.migrations.flatMap((migration) => migration.new_sqlite_classes ?? []).sort();
  assert.deepEqual(migrated, ["Directory", "Room"], "env.production migrations create both classes as SQLite classes");
  assert.equal(config.account_id, undefined, "no account id in the config");
  const { rawConfig } = experimental_readRawConfig({ config: WRANGLER_CONFIG });
  const names = (env: string) => Object.keys(rawConfig.env?.[env]?.vars ?? {}).sort();
  assert.ok(names("production").length > 0, "env.production declares its vars");
  assert.deepEqual(names("test"), names("production"), "env.test and env.production declare the same vars");
}

let failed = false;
try {
  const findings = scan(".");
  for (const f of findings) console.error(`${f.file}:${f.line} ${f.rule}: ${f.text}`);
  assert.equal(findings.length, 0, `${findings.length} hard-coded account, host, email or owner strings`);
  checkPlantedFixtures();
  await checkNotFoundPage();
  checkProductionConfig();
  console.log("check:portable passed: planted fixtures caught, 404 page finds its root, production config complete, tree clean");
} catch (error) {
  failed = true;
  console.error(error);
}
process.exit(failed ? 1 : 0);
