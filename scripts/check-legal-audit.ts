import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privacyHtml } from "./build-privacy.ts";

type Finding = { file: string; rule: string; text: string };
type Page = { file: string; text: string };
type Paths = Pick<typeof path, "relative" | "sep">;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCANNED = ["dist", "public", "src", "worker", "functions", "index.html"];
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;
const TEXT_FILE = /\.(?:html?|css|[cm]?[jt]sx?|webmanifest|json|svg)$/i;
const NOT_TEXT = /\.(?:woff2?|ttf|otf|eot|ico|png|jpe?g|gif|webp|avif|bmp|mp3|wav|ogg|m4a|flac|mp4|webm|pdf|zip|gz|br|wasm|map)$/i;
const isRead = (file: string) => (file.startsWith("dist/") ? !NOT_TEXT.test(file) : TEXT_FILE.test(file));
const URL_AUDITED = /^(?:dist|worker|functions)\//;
const SKIPPED = /(^|\/)(node_modules|\.wrangler)(\/|$)/;

const FONT_OR_CDN_HOST =
  /\b(?:fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|p\.typekit\.net|fonts\.bunny\.net|fonts\.cdnfonts\.com|kit\.fontawesome\.com|use\.fontawesome\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|ajax\.googleapis\.com|code\.jquery\.com|(?:stackpath|maxcdn)\.bootstrapcdn\.com|cdn\.tailwindcss\.com|esm\.sh|cdn\.skypack\.dev|ga\.jspm\.io)\b/gi;
const REMOTE = String.raw`["'\x60]?\s*(?:https?:)?\/\/`;
const SCRIPT_TAG = new RegExp(String.raw`<script\b[^>]*\bsrc\s*=\s*${REMOTE}[^>]*>`, "gi");
const LINK_TAG = /<link\b[^>]*>/gi;
const LOADING_REL = /\brel\s*=\s*["'\x60]?[^"'\x60>]*\b(?:stylesheet|preload|modulepreload|preconnect|dns-prefetch|prefetch|icon|manifest)\b/i;
const REMOTE_HREF = new RegExp(String.raw`\bhref\s*=\s*${REMOTE}`, "i");
const CSS_REMOTE = new RegExp(String.raw`@import\s+(?:url\(\s*)?${REMOTE}[^;]*|(?<![\w$.]|\bnew\s+)url\(\s*${REMOTE}[^)]*\)`, "gi");
const EMBED_TAG = new RegExp(String.raw`<(?:img|image|iframe|frame|video|audio|source|track|embed|object|input|form)\b[^>]*\b(?:src|srcset|data|poster|href|action)\s*=\s*${REMOTE}[^>]*>`, "gi");
const REMOTE_IMPORT = new RegExp(String.raw`\b(?:import|importScripts)\s*\(\s*${REMOTE}[^)]*\)|\bfrom\s*["'\x60](?:https?:)?\/\/[^"'\x60]*`, "g");

const TRACKER_PACKAGE =
  /^(?:@sentry\/.+|@fullstory\/.+|logrocket.*|@logrocket\/.+|mixpanel(?:-browser)?|@amplitude\/.+|amplitude-js|@segment\/.+|analytics-node|analytics|@analytics\/.+|posthog-(?:js|node)|@hotjar\/.+|react-hotjar|react-ga4?|@microsoft\/clarity|clarity-js|rrweb.*|@rrweb\/.+|@datadog\/browser-.+|@newrelic\/.+|newrelic|smartlook-client|mouseflow.*|@vercel\/analytics|@vercel\/speed-insights|react-facebook-pixel|@openreplay\/.+|openreplay|@highlight-run\/.+|highlight\.run|heap-api|@heap\/.+|@bugsnag\/.+|universal-analytics|ga-4-react|react-gtm-module|@google-analytics\/.+|@growthbook\/.+|@statsig\/.+|@intercom\/.+)$/;
const TRACKER_SIGN =
  /\b(?:static\.hotjar\.com|script\.hotjar\.com|edge\.fullstory\.com|cdn\.lr-ingest\.(?:io|com)|r\.lr-ingest\.io|cdn\.logrocket\.(?:io|com)|clarity\.ms|cdn\.mxpnl\.com|api(?:-js)?\.mixpanel\.com|cdn\.amplitude\.com|api2?\.amplitude\.com|cdn\.segment\.(?:com|io)|api\.segment\.io|googletagmanager\.com|google-analytics\.com|connect\.facebook\.net|ingest(?:\.us)?\.sentry\.io|browser\.sentry-cdn\.com|[a-z0-9-]+\.posthog\.com|browser-intake-datadoghq\.(?:com|eu)|js-agent\.newrelic\.com|bam\.nr-data\.net|cdn\.heapanalytics\.com|plausible\.io|cloud\.umami\.is|static\.cloudflareinsights\.com)\b|\b(?:gtag|fbq|clarity)\s*\(\s*["'\x60]|\bdataLayer\.push\s*\(|__SENTRY__|_hjSettings|\bLogRocket\b|\bmixpanel\.init\b|\bposthog\.init\b|\brrweb\b/gi;
const IMPORT_SPECIFIER = /\b(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'\x60]([^"'\x60\s]+)["'\x60]/g;

const KNOWN_URLS: { prefix: string; why: string }[] = [
  { prefix: "http://www.w3.org/", why: "SVG and XML namespace names, never fetched" },
  { prefix: "https://react.dev/errors/", why: "React's own error help text, never fetched" },
  { prefix: "https://www.google.com/search?q=", why: "a web search the player opens by tapping, nothing loads by itself" },
  { prefix: "https://musicbrainz.org/ws/2/recording", why: "song search sends the typed title when the player searches; LEGAL-TODO row 5" },
  { prefix: "stun:stun.cloudflare.com:3478", why: "a live-gig link or Test now asks this STUN server for the phone's public address; LEGAL-TODO row 8" },
];
const URL_TAIL = String.raw`(?::\d+)?[^\s"'\x60<>)\\]*`;
const DOTTED_OR_IP = String.raw`(?:[a-z0-9-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\]`;
const ABSOLUTE_URL = new RegExp(
  String.raw`\b(?:https?|wss?):\/\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])${URL_TAIL}|(?<=["'\x60(=]\s*)\/\/(?:${DOTTED_OR_IP})${URL_TAIL}|(?<=["'\x60]\s*)(?:stuns?|turns?):(?:${DOTTED_OR_IP})${URL_TAIL}`,
  "gi",
);
const isKnownUrl = (url: string) => KNOWN_URLS.some(({ prefix }) => url.startsWith(url.startsWith("//") ? prefix.replace(/^https?:/, "") : prefix));

const CONTROL_WORDS = /^\s*(?:subscribe|upgrade|(?:go|get|try|join) (?:pro|premium|plus)|buy|pay|purchase|checkout|start (?:your |a )?(?:free )?trial|unlock (?:pro|premium|plus|all|everything|the full))\b/i;
const isCodeControlLabel = (label: string) => /^\s*[A-Z]/.test(label) && CONTROL_WORDS.test(label);
const PRICE = /[$€£]\s?\d+(?:[.,]\d{2})?\s*(?:\/|a|per|each)\s*(?:mo|month|yr|year|week|wk)\b|[$€£]\s?\d+[.,]\d{2}\b/i;
const RENEWAL_WORDS = [/[$€£]\s?\d/, /\brenew/i, /\b(?:every|each|per|a)\s+(?:month|year|week)\b|\bmonthly\b|\byearly\b|\bannually\b/i, /\bcancel/i];
const BESIDE = 600;
const HTML_CONTROL = /<(button|a)\b[^>]*>([\s\S]{0,200}?)<\/\1>|<input\b[^>]*\btype\s*=\s*["']?(?:submit|button)\b[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*>/gi;
const STRING_LITERAL = /"((?:\\.|[^"\\\n]){1,80})"|'((?:\\.|[^'\\\n]){1,80})'|`([^`$\\\n]{1,80})`/g;
const HEADER_USE = /\.(?:get|set|has|append|delete)\(\s*$/;

const relPath = (root: string, file: string, paths: Paths = path) => paths.relative(root, file).split(paths.sep).join("/");

function walk(root: string, entry: string): string[] {
  const full = path.join(root, entry);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { recursive: true })
    .map((name) => path.join(full, String(name)))
    .filter((file) => !SKIPPED.test(relPath(root, file)) && statSync(file).isFile());
}

const matches = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[0].slice(0, 120));
const stripTags = (html: string) => html.replace(/<[^>]*>/g, " ");
const hasRenewalTerms = (text: string, at: number, length: number) => {
  const near = stripTags(text.slice(Math.max(0, at - BESIDE), at + length + BESIDE));
  return RENEWAL_WORDS.every((word) => word.test(near));
};
const packageOf = (specifier: string) => (specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);

function loadRules({ file, text }: Page): Finding[] {
  const found = (rule: string, hits: string[]) => hits.map((hit) => ({ file, rule, text: hit }));
  const links = matches(text, LINK_TAG).filter((tag) => LOADING_REL.test(tag) && REMOTE_HREF.test(tag));
  return [
    ...found("font-or-cdn-host", matches(text, FONT_OR_CDN_HOST)),
    ...found("third-party-script", matches(text, SCRIPT_TAG)),
    ...found("third-party-link", links),
    ...found("third-party-embed", matches(text, EMBED_TAG)),
    ...found("css-remote-load", matches(text, CSS_REMOTE)),
    ...found("remote-script-import", SCRIPT_FILE.test(file) ? matches(text, REMOTE_IMPORT) : []),
    ...found("tracker-sign", matches(text, TRACKER_SIGN)),
  ];
}

function importRules({ file, text }: Page): Finding[] {
  if (file.startsWith("dist/") || !(SCRIPT_FILE.test(file) || /\.html?$/i.test(file))) return [];
  return [...text.matchAll(IMPORT_SPECIFIER)]
    .map((m) => packageOf(m[1]))
    .filter((name) => TRACKER_PACKAGE.test(name))
    .map((name) => ({ file, rule: "tracker-import", text: name }));
}

function urlRules({ file, text }: Page): Finding[] {
  if (!URL_AUDITED.test(file)) return [];
  return matches(text, ABSOLUTE_URL)
    .filter((url) => !isKnownUrl(url))
    .map((url) => ({ file, rule: "unlisted-third-party-url", text: url }));
}

function priceRules({ file, text }: Page): Finding[] {
  const out: Finding[] = [];
  if (/\.html?$/i.test(file) || !/\./.test(file) || file.startsWith("worker/")) {
    for (const m of text.matchAll(HTML_CONTROL)) {
      const label = stripTags(m[2] ?? m[3] ?? "").trim();
      if ((CONTROL_WORDS.test(label) || PRICE.test(label)) && !hasRenewalTerms(text, m.index, m[0].length)) out.push({ file, rule: "price-control-without-renewal-terms", text: m[0].slice(0, 120) });
    }
  }
  if (file.startsWith("dist/") && /\.[cm]?js$/i.test(file)) {
    for (const m of text.matchAll(STRING_LITERAL)) {
      const label = m[1] ?? m[2] ?? m[3];
      const isKey = /^\s*:/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 2));
      if (isKey || HEADER_USE.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
      if ((isCodeControlLabel(label) || PRICE.test(label)) && !hasRenewalTerms(text, m.index, m[0].length)) out.push({ file, rule: "price-control-without-renewal-terms", text: m[0] });
    }
  }
  return out;
}

function packageRules(root: string): Finding[] {
  const out: Finding[] = [];
  const pkgFile = path.join(root, "package.json");
  if (existsSync(pkgFile)) {
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(pkg[field] ?? {})) if (TRACKER_PACKAGE.test(name)) out.push({ file: "package.json", rule: "tracker-package", text: `${field}: ${name}` });
    }
  }
  const lockFile = path.join(root, "package-lock.json");
  if (existsSync(lockFile)) {
    for (const key of Object.keys(JSON.parse(readFileSync(lockFile, "utf8")).packages ?? {})) {
      const name = key.split("node_modules/").pop() ?? "";
      if (name && TRACKER_PACKAGE.test(name)) out.push({ file: "package-lock.json", rule: "tracker-package", text: key });
    }
  }
  return out;
}

function scan(root: string, extra: Page[] = []): Finding[] {
  const out: Finding[] = [];
  if (!existsSync(path.join(root, "dist", "index.html"))) out.push({ file: "dist/index.html", rule: "no-build", text: "run npm run build first" });
  const files = [...new Set(SCANNED.flatMap((entry) => walk(root, entry)))].filter((file) => isRead(relPath(root, file)));
  const pages = [...files.map((file) => ({ file: relPath(root, file), text: readFileSync(file, "utf8") })), ...extra];
  for (const page of pages) out.push(...loadRules(page), ...importRules(page), ...urlRules(page), ...priceRules(page));
  return [...out, ...packageRules(root)];
}

const CLEAN_INDEX = `<!doctype html><html><head><link rel="icon" href="./favicon.svg"><link rel="manifest" href="./manifest.webmanifest"><script type="module" crossorigin src="/assets/index-abc.js"></script><link rel="stylesheet" href="./assets/index-abc.css"></head><body><div id="root"></div></body></html>`;

function plant(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "legal-audit-"));
  for (const [file, text] of Object.entries({ "dist/index.html": CLEAN_INDEX, ...files })) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}

function scanPlanted(files: Record<string, string>, extra: Page[] = []): Finding[] {
  const root = plant(files);
  try {
    return scan(root, extra);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type Case = { name: string; files: Record<string, string>; extra?: Page[]; expect: { rule: string; file: string } | "clean" };
const GOOGLE_FONTS = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap">`;
const RENEWAL = `<p>$4.99 a month. Renews every month until you cancel. To cancel: Settings, Account, Cancel plan.</p>`;
const CASES: Case[] = [
  { name: "L01 a built page that links Google Fonts fails", files: { "dist/index.html": CLEAN_INDEX.replace("</head>", `${GOOGLE_FONTS}</head>`) }, expect: { rule: "font-or-cdn-host", file: "dist/index.html" } },
  { name: "L02 a Google Fonts link is also caught as a third-party stylesheet", files: { "dist/index.html": CLEAN_INDEX.replace("</head>", `${GOOGLE_FONTS}</head>`) }, expect: { rule: "third-party-link", file: "dist/index.html" } },
  { name: "L03 a preconnect to any outside host fails", files: { "index.html": `<link rel="preconnect" href="https://assets.example.net">` }, expect: { rule: "third-party-link", file: "index.html" } },
  { name: "L04 a CSS @import of an outside font sheet fails", files: { "dist/assets/index-abc.css": `@import url("https://fonts.example.net/inter.css");body{margin:0}` }, expect: { rule: "css-remote-load", file: "dist/assets/index-abc.css" } },
  { name: "L05 an @font-face that loads from fonts.gstatic.com fails", files: { "src/fonts.css": `@font-face{font-family:Inter;src:url(https://fonts.gstatic.com/s/inter/v1/a.woff2) format("woff2")}` }, expect: { rule: "css-remote-load", file: "src/fonts.css" } },
  { name: "L06 a third-party script tag in any HTML fails", files: { "public/404.html": `<script src="https://cdn.example.net/widget.js"></script>` }, expect: { rule: "third-party-script", file: "public/404.html" } },
  { name: "L07 a protocol-relative script tag fails", files: { "dist/index.html": CLEAN_INDEX.replace("</head>", `<script async src="//cdn.example.net/w.js"></script></head>`) }, expect: { rule: "third-party-script", file: "dist/index.html" } },
  { name: "L08 a same-origin script and stylesheet pass", files: { "index.html": `<script type="module" src="/src/main.tsx"></script><script src="./sw-register.js"></script><link rel="stylesheet" href="/assets/a.css">` }, expect: "clean" },
  { name: "L09 a Worker HTML response that links an outside stylesheet fails", files: { "worker/landing.ts": "const page = `<html><head><link rel=\"stylesheet\" href=\"https://cdn.example.net/a.css\"></head></html>`;" }, expect: { rule: "third-party-link", file: "worker/landing.ts" } },
  { name: "L10 the privacy page with an outside font fails", files: {}, extra: [{ file: "privacy page", text: privacyHtml(undefined).replace("</head>", `${GOOGLE_FONTS}</head>`) }], expect: { rule: "font-or-cdn-host", file: "privacy page" } },
  { name: "L11 the service worker loading an outside script fails", files: { "public/sw.js": `importScripts("https://cdn.example.net/sw-tools.js");` }, expect: { rule: "remote-script-import", file: "public/sw.js" } },
  { name: "L12 a new outside URL in the bundle fails until it gets an audit row", files: { "dist/assets/index-abc.js": `fetch("https://api.example.net/v1/events",{method:"POST"})` }, expect: { rule: "unlisted-third-party-url", file: "dist/assets/index-abc.js" } },
  { name: "L13 the audited outside URLs in the bundle pass", files: { "dist/assets/index-abc.js": `const a="http://www.w3.org/2000/svg",b="https://react.dev/errors/418",c="https://www.google.com/search?q=",d="https://musicbrainz.org/ws/2/recording";` }, expect: "clean" },
  { name: "L14 an analytics package in package.json fails", files: { "package.json": JSON.stringify({ dependencies: { react: "^19.1.0", "@sentry/react": "^8.0.0" } }) }, expect: { rule: "tracker-package", file: "package.json" } },
  { name: "L15 a session-replay package in devDependencies fails", files: { "package.json": JSON.stringify({ devDependencies: { "posthog-js": "^1.0.0" } }) }, expect: { rule: "tracker-package", file: "package.json" } },
  { name: "L16 a session-replay package deep in the lockfile fails", files: { "package-lock.json": JSON.stringify({ packages: { "": {}, "node_modules/some-tool/node_modules/rrweb": { version: "2.0.0" } } }) }, expect: { rule: "tracker-package", file: "package-lock.json" } },
  { name: "L17 an analytics import in the app source fails", files: { "src/main.tsx": `import * as Sentry from "@sentry/react";\nSentry.init({});` }, expect: { rule: "tracker-import", file: "src/main.tsx" } },
  { name: "L18 a lazy analytics import fails", files: { "src/later.ts": `const mp = await import("mixpanel-browser");` }, expect: { rule: "tracker-import", file: "src/later.ts" } },
  { name: "L19 a tag-manager snippet in the built bundle fails", files: { "dist/assets/index-abc.js": `window.dataLayer=window.dataLayer||[];function g(){dataLayer.push(arguments)}g("js",new Date);` }, expect: { rule: "tracker-sign", file: "dist/assets/index-abc.js" } },
  { name: "L20 the word amplitude about sound passes", files: { "src/learn.ts": `/** Each pitch's amplitude, summed. */\nexport const amplitude = (x: number) => x * 2;` }, expect: "clean" },
  { name: "L21 a Subscribe button with no renewal words fails", files: { "dist/index.html": CLEAN_INDEX.replace(`<div id="root"></div>`, `<button type="button">Subscribe</button>`) }, expect: { rule: "price-control-without-renewal-terms", file: "dist/index.html" } },
  { name: "L22 a price label in the bundle with no renewal words fails", files: { "dist/assets/index-abc.js": `x("button",{className:"pay",children:"$4.99/month"})` }, expect: { rule: "price-control-without-renewal-terms", file: "dist/assets/index-abc.js" } },
  { name: "L23 an Upgrade label in the bundle with no renewal words fails", files: { "dist/assets/index-abc.js": `x("button",{onClick:u,children:"Upgrade to Pro"})` }, expect: { rule: "price-control-without-renewal-terms", file: "dist/assets/index-abc.js" } },
  { name: "L24 a Subscribe button with price, term and cancel steps beside it passes", files: { "dist/index.html": CLEAN_INDEX.replace(`<div id="root"></div>`, `<button type="button">Subscribe</button>${RENEWAL}`) }, expect: "clean" },
  { name: "L25 a websocket Upgrade header is not a control", files: { "dist/assets/index-abc.js": `if(r.headers.get("Upgrade")!=="websocket")return;const h={"Upgrade":"websocket"};` }, expect: "clean" },
  { name: "L26 no price control and no outside load passes", files: {}, expect: "clean" },
  { name: "L28 a lowercase id like unlock or pay and a Hold to unlock button are not price controls", files: { "dist/assets/index-abc.js": `x("button",{...Z("unlock",f,{attrs:{"data-stage":"unlock"}}),children:"Hold to unlock"});const k="pay";` }, expect: "clean" },
  { name: "L29 an Unlock Pro label with no renewal words fails", files: { "dist/assets/index-abc.js": `x("button",{children:"Unlock Pro"})` }, expect: { rule: "price-control-without-renewal-terms", file: "dist/assets/index-abc.js" } },
  { name: "L30 a Worker HTML response with a <style> @import of an outside sheet fails", files: { "worker/landing.ts": "const page = `<html><style>@import url(\"https://fonts.example.net/a.css\");</style></html>`;" }, expect: { rule: "css-remote-load", file: "worker/landing.ts" } },
  { name: "L31 a Worker HTML response with an @font-face from an outside host fails", files: { "worker/landing.ts": "const page = `<style>@font-face{font-family:A;src:url(https://fonts.example.net/a.woff2)}</style>`;" }, expect: { rule: "css-remote-load", file: "worker/landing.ts" } },
  { name: "L32 a Worker HTML response with an outside <img> fails", files: { "worker/landing.ts": "const page = `<p><img src=\"https://px.example.net/p.gif\"></p>`;" }, expect: { rule: "third-party-embed", file: "worker/landing.ts" } },
  { name: "L33 a Worker HTML response with an outside <iframe> fails", files: { "worker/landing.ts": "const page = `<iframe src=\"https://embed.example.net/x\"></iframe>`;" }, expect: { rule: "third-party-embed", file: "worker/landing.ts" } },
  { name: "L34 a protocol-relative outside script injected by the bundle fails until it gets an audit row", files: { "dist/assets/i.js": `s=document.createElement("script");s.src="//cdn.example.net/x.js";document.head.append(s)` }, expect: { rule: "unlisted-third-party-url", file: "dist/assets/i.js" } },
  { name: "L35 a lowercase subscribe now button with no renewal words fails", files: { "dist/index.html": CLEAN_INDEX.replace(`<div id="root"></div>`, `<button>subscribe now</button>`) }, expect: { rule: "price-control-without-renewal-terms", file: "dist/index.html" } },
  { name: "L36 a Go Premium label in the bundle with no renewal words fails", files: { "dist/assets/index-abc.js": `x("button",{children:"Go Premium"})` }, expect: { rule: "price-control-without-renewal-terms", file: "dist/assets/index-abc.js" } },
  { name: "L37 an analytics import in a .jsx file fails", files: { "src/a.jsx": `import "@sentry/react";` }, expect: { rule: "tracker-import", file: "src/a.jsx" } },
  { name: "L38 a session-replay require in a .cjs file fails", files: { "worker/a.cjs": `const LR = require("logrocket");` }, expect: { rule: "tracker-import", file: "worker/a.cjs" } },
  { name: "L39 new URL to an audited host, a same-origin <img>, a local url() and a tapped outside link pass", files: { "src/search.ts": `const u = new URL("https://musicbrainz.org/ws/2/recording");\nconst v = x.url("https://musicbrainz.org/ws/2/recording");`, "worker/landing.ts": "const page = `<style>@font-face{src:url(./a.woff2)}</style><img src=\"/icon.png\"><a href=\"https://www.google.com/search?q=x\">Search</a>`;" }, expect: "clean" },
  { name: "L40 an outside script from an IPv4 address injected by the bundle fails until it gets an audit row", files: { "dist/assets/i.js": `s=document.createElement("script");s.src="https://203.0.113.5/x.js";document.head.append(s)` }, expect: { rule: "unlisted-third-party-url", file: "dist/assets/i.js" } },
  { name: "L41 a protocol-relative outside script from an IPv4 address fails", files: { "dist/assets/i.js": `s.src="//203.0.113.5:8080/x.js"` }, expect: { rule: "unlisted-third-party-url", file: "dist/assets/i.js" } },
  { name: "L42 an outside fetch to an IPv6 address or a one-word host fails", files: { "dist/assets/i.js": `fetch("https://[2001:db8::1]/p");fetch("http://tracker:9000/p")` }, expect: { rule: "unlisted-third-party-url", file: "dist/assets/i.js" } },
  { name: "L43 a manifest icon from an outside host fails", files: { "dist/manifest.webmanifest": `{"icons":[{"src":"https://cdn.example.net/i.png"}]}` }, expect: { rule: "unlisted-third-party-url", file: "dist/manifest.webmanifest" } },
  { name: "L44 an SVG in the build that loads an outside image fails", files: { "dist/icon.svg": `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://px.example.net/p.png"/></svg>` }, expect: { rule: "third-party-embed", file: "dist/icon.svg" } },
  { name: "L45 a Worker page whose inline script injects an outside script fails", files: { "worker/landing.ts": "const page = `<script>const s=document.createElement('script');s.src='https://cdn.example.net/x.js';document.head.append(s)</script>`;" }, expect: { rule: "unlisted-third-party-url", file: "worker/landing.ts" } },
  { name: "L46 a Worker page whose inline script sends a beacon outside fails", files: { "worker/landing.ts": "const page = `<script>navigator.sendBeacon('https://px.example.net/p')</script>`;" }, expect: { rule: "unlisted-third-party-url", file: "worker/landing.ts" } },
  { name: "L47 a same-origin manifest, a Worker page script with local paths and a version number pass", files: { "dist/manifest.webmanifest": `{"start_url":"./","icons":[{"src":"./icon-192.png"}]}`, "dist/assets/v.js": `const v="1.2.3.4",p="/api/me",q="./x.js";`, "worker/landing.ts": "const page = `<script>location.href='/?open=band'</script>`;" }, expect: "clean" },
  { name: "L48 a websocket to an outside host fails until it gets an audit row", files: { "dist/assets/i.js": `new WebSocket("wss://px.example.net/s")` }, expect: { rule: "unlisted-third-party-url", file: "dist/assets/i.js" } },
  { name: "L49 an outside STUN server in an ICE config fails until it gets an audit row", files: { "dist/assets/i.js": `new RTCPeerConnection({iceServers:[{urls:"stun:stun.example.net:3478"}]})` }, expect: { rule: "unlisted-third-party-url", file: "dist/assets/i.js" } },
  { name: "L50 an outside TURN relay at an IP address fails", files: { "dist/assets/i.js": `const ice=[{urls:'turn:203.0.113.5:3478'}]` }, expect: { rule: "unlisted-third-party-url", file: "dist/assets/i.js" } },
  { name: "L51 an outside fetch to an IPv6 address fails", files: { "dist/assets/i.js": `fetch("https://[2001:db8::1]/p")` }, expect: { rule: "unlisted-third-party-url", file: "dist/assets/i.js" } },
  { name: "L52 an outside fetch to a one-word host fails", files: { "dist/assets/i.js": `fetch("http://tracker:9000/p")` }, expect: { rule: "unlisted-third-party-url", file: "dist/assets/i.js" } },
  { name: "L54 a build file of a type no rule names, such as a browserconfig.xml tile icon from an outside host, fails", files: { "dist/browserconfig.xml": `<browserconfig><msapplication><tile><square150x150logo src="https://cdn.example.net/t.png"/></tile></msapplication></browserconfig>` }, expect: { rule: "unlisted-third-party-url", file: "dist/browserconfig.xml" } },
  { name: "L53 an object key named stun and the audited STUN server pass", files: { "dist/assets/i.js": `f({stun:C.stun});g({stun:EN});const s=["stun:stun.cloudflare.com:3478"];` }, expect: "clean" },
];

let failures = 0;
const report = (ok: boolean, name: string, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
};

function runCases() {
  for (const c of CASES) {
    const findings = scanPlanted(c.files, c.extra);
    const shown = JSON.stringify(findings.slice(0, 4));
    if (c.expect === "clean") report(findings.length === 0, c.name, `expected no findings, got ${shown}`);
    else {
      const { rule, file } = c.expect;
      report(findings.some((f) => f.rule === rule && f.file === file), c.name, `expected ${rule} in ${file}, got ${shown}`);
    }
  }
  const noBuild = (() => {
    const root = mkdtempSync(path.join(tmpdir(), "legal-audit-"));
    try {
      return scan(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  })();
  report(noBuild.some((f) => f.rule === "no-build"), "L27 a tree with no dist fails and says build first", JSON.stringify(noBuild));
}

function runPathCases() {
  const win = relPath("C:\\work\\app", "C:\\work\\app\\dist\\assets\\index-abc.css", path.win32);
  report(win === "dist/assets/index-abc.css", "W1 a Windows drive-letter path with backslashes reads as dist/assets/index-abc.css", win);
  const posix = relPath("/work/app", "/work/app/dist/index.html", path.posix);
  report(posix === "dist/index.html", "W2 a Linux path reads as dist/index.html", posix);
  const root = plant({ "dist/assets/deep/index-abc.css": `@import url("https://fonts.googleapis.com/css2?family=Inter");` });
  try {
    const native = scan(root);
    const slashed = scan(root.replaceAll("\\", "/"));
    const files = native.map((f) => f.file);
    report(files.includes("dist/assets/deep/index-abc.css") && files.every((f) => !f.includes("\\")), `W3 a planted tree under ${path.sep === "\\" ? "a drive-letter temp folder" : "the temp folder"} is reported with / paths`, JSON.stringify(files));
    report(JSON.stringify(slashed) === JSON.stringify(native), "W4 the same tree reached through forward slashes gives the same findings", JSON.stringify(slashed));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SIGNED_IN = /\bsignedIn\(c\)/;
const STORES_PROFILE = /\binsertPasskey\(|\bstorePassword\(|"google-link"|INSERT INTO (?:users|passkeys|passwords|google_logins)\b|UPDATE users SET (?!session_version\b)/;

function todoRows(root: string): Map<number, string> {
  const rows = new Map<number, string>();
  for (const line of readFileSync(path.join(root, "LEGAL-TODO.md"), "utf8").split(/\r?\n/)) {
    const row = /^\|\s*(\d+)\s*\|/.exec(line);
    if (row) rows.set(Number(row[1]), line);
  }
  return rows;
}

function routesThatStoreProfileAfterSignUp(source: string): string[] {
  const keys = [...source.matchAll(/^\s*(?:async\s+)?"([A-Z]+ \/api\/[^"]+)"\s*[(:]/gm)];
  return keys
    .filter((key, i) => {
      const body = source.slice(key.index, keys[i + 1]?.index ?? source.length);
      return SIGNED_IN.test(body) && STORES_PROFILE.test(body);
    })
    .map((key) => key[1].split(" ")[1]);
}

function profileRoutes(root: string): string[] {
  return walk(root, "worker")
    .filter((file) => SCRIPT_FILE.test(file))
    .flatMap((file) => routesThatStoreProfileAfterSignUp(readFileSync(file, "utf8")));
}

const PLANTED_PROFILE_ROUTES = `export const ROUTES: Record<string, Route> = {
  async "POST /api/me/rename"(c) {
    const user = await signedIn(c);
    c.sql.exec("UPDATE users SET name = ? WHERE id = ?", name, user.id);
  },
  "POST /api/me/handle": Object.assign(async (c: Context) => {
    const user = await signedIn(c);
    c.sql.exec("UPDATE users SET handle = ? WHERE id = ?", handle, user.id);
  }, { limit: 5 }),
};
`;

function runDocCases() {
  const rows = todoRows(ROOT);
  for (const known of KNOWN_URLS) {
    const cited = /LEGAL-TODO row (\d+)/.exec(known.why);
    if (!cited || !new URL(known.prefix).hostname) continue;
    const host = new URL(known.prefix).hostname.replace(/^www\./, "");
    const row = rows.get(Number(cited[1])) ?? "";
    report(row.toLowerCase().includes(host), `D1 the KNOWN_URLS row for ${host} cites a LEGAL-TODO row that names it`, `row ${cited[1]} does not mention ${host}`);
  }
  for (const known of KNOWN_URLS) {
    const cited = /LEGAL-TODO row (\d+)/.exec(known.why);
    const url = new URL(known.prefix);
    if (!cited || url.hostname) continue;
    const host = url.pathname.split(":")[0];
    const row = rows.get(Number(cited[1])) ?? "";
    report(host !== "" && row.toLowerCase().includes(host), `D4 the KNOWN_URLS row for ${host}, which has no // host, cites a LEGAL-TODO row that names it`, `row ${cited[1]} does not mention ${host}`);
  }
  const routes = profileRoutes(ROOT);
  const missing = routes.filter((route) => !(rows.get(1) ?? "").includes(route));
  report(routes.length > 0 && missing.length === 0, `D2 LEGAL-TODO row 1 names every signed-in route that stores a profile field (${routes.join(", ")})`, `row 1 is missing ${missing.join(", ") || "(no routes found)"}`);
  const root = plant({ "worker/directory.ts": PLANTED_PROFILE_ROUTES });
  try {
    const planted = profileRoutes(root);
    report(planted.includes("/api/me/rename") && planted.includes("/api/me/handle"), "D3 a signed-in route that stores a profile field in any Worker file, in either route form, reaches D2", `found ${JSON.stringify(planted)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const TERMS_FILE = "legal/TERMS-DRAFT.md";
const TERMS_CONTACT = "Brian Pruitt (contact details to be added)";
const count = (text: string, part: string) => text.split(part).length - 1;

function runTermsCases() {
  const file = path.join(ROOT, TERMS_FILE);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  report(text !== "", `T1 ${TERMS_FILE} is in the repo`, "the file is missing");
  report(
    count(text, TERMS_CONTACT) === 6 && !text.includes("[CONTACT EMAIL]"),
    `T2 each of the six [CONTACT EMAIL] placeholders in the Terms draft reads ${TERMS_CONTACT}`,
    `found ${count(text, TERMS_CONTACT)} named, ${count(text, "[CONTACT EMAIL]")} [CONTACT EMAIL] left`,
  );
  report(text !== "" && !text.includes("@"), "T3 the Terms draft holds no @, so no address was made up", text === "" ? "the file is missing" : `${count(text, "@")} @ found`);
  report(text.includes("[COMPANY NAME]") && text.includes("[STATE]"), "T4 the Terms draft keeps its [COMPANY NAME] and [STATE] placeholders", "a placeholder is gone");
}

const ITEMS: { name: string; rules: string[] }[] = [
  { name: "R0 the build exists", rules: ["no-build"] },
  { name: "R2 no outside font, stylesheet, script, image or frame in index.html, public, dist, the Worker pages or the privacy page", rules: ["font-or-cdn-host", "third-party-script", "third-party-link", "third-party-embed", "css-remote-load", "remote-script-import"] },
  { name: "R2b every outside URL in the build, the Worker and functions has an audit row", rules: ["unlisted-third-party-url"] },
  { name: "R3 no analytics or session-replay package, import or snippet", rules: ["tracker-package", "tracker-import", "tracker-sign"] },
  { name: "R5 no Subscribe or price control without renewal terms beside it", rules: ["price-control-without-renewal-terms"] },
];

function runRealTree() {
  const privacy = [
    { file: "privacy page (no contact set)", text: privacyHtml(undefined) },
    { file: "privacy page (contact set)", text: privacyHtml("Write to the band app owner") },
  ];
  const findings = scan(ROOT, privacy);
  for (const item of ITEMS) {
    const hits = findings.filter((f) => item.rules.includes(f.rule));
    report(hits.length === 0, item.name, hits.slice(0, 8).map((f) => `${f.file} ${f.rule}: ${f.text}`).join(" | "));
  }
}

const started = Date.now();
runRealTree();
runCases();
runPathCases();
runDocCases();
runTermsCases();
console.log(`check:legal-audit ${failures ? `failed ${failures}` : "passed"} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(failures ? 1 : 0);
