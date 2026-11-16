import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openSite } from "./chrome.ts";

const root = new URL("..", import.meta.url).pathname;
const THEMES = ["stage", "day", "cb-rg", "cb-by", "contrast"] as const;
type Theme = (typeof THEMES)[number];
const DARK_MARK_THEMES: Theme[] = ["cb-rg", "cb-by", "contrast"];

let failures = 0;
const check = (ok: boolean, message: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
};

type Block = { file: string; line: number; selector: string; body: string };
type Rule = { name: string; pattern: RegExp };
type Finding = { file: string; line: number; rule: string; text: string };

const COLOR_RULES: Rule[] = [
  { name: "hex", pattern: /#[0-9a-f]{3,8}\b/gi },
  { name: "rgb-or-hsl", pattern: /\b(?:rgba?|hsla?)\(/gi },
  { name: "named-color", pattern: /(?<![\w-])(?:white|black)(?![\w-])/gi },
];
const TOKEN_SELECTOR = /^(?::root|\.gig-stage|html\[data-theme="(stage|day|cb-rg|cb-by|contrast)"\])$/;

const blank = (text: string) => text.replace(/[^\n]/g, " ");

/** Every `selector { body }` in a stylesheet, innermost first, so rules inside @media keep their own selector. */
function cssBlocks(file: string, text: string): Block[] {
  let rest = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  const blocks: Block[] = [];
  for (let match = /([^{}]*)\{([^{}]*)\}/.exec(rest); match; match = /([^{}]*)\{([^{}]*)\}/.exec(rest)) {
    const selector = match[1].trim().replace(/\s+/g, " ");
    const line = rest.slice(0, match.index + match[1].length).split("\n").length;
    if (!selector.startsWith("@")) blocks.push({ file, line, selector, body: match[2] });
    rest = rest.slice(0, match.index) + blank(match[0]) + rest.slice(match.index + match[0].length);
  }
  return blocks;
}

const isTokenBlock = (selector: string) => selector.split(",").every((part) => TOKEN_SELECTOR.test(part.trim()));

function themeOf(selector: string): Theme | null {
  const parts = selector.split(",").map((part) => part.trim());
  if (parts.includes(":root")) return "stage";
  for (const part of parts) {
    const found = TOKEN_SELECTOR.exec(part);
    if (found?.[1]) return found[1] as Theme;
  }
  return null;
}

function literalsOutsideTokens(blocks: Block[]): Finding[] {
  return blocks
    .filter((block) => !isTokenBlock(block.selector))
    .flatMap((block) =>
      block.body.split("\n").flatMap((line, index) =>
        COLOR_RULES.flatMap((rule) => [...line.matchAll(rule.pattern)].map((match) => ({ file: block.file, line: block.line + index, rule: rule.name, text: `${block.selector} { ${match[0]}` }))),
      ),
    );
}

function tokens(blocks: Block[]): Map<Theme, Map<string, string>> {
  const byTheme = new Map<Theme, Map<string, string>>();
  for (const block of blocks) {
    if (!isTokenBlock(block.selector)) continue;
    const theme = themeOf(block.selector);
    if (!theme) continue;
    const values = byTheme.get(theme) ?? new Map<string, string>();
    for (const match of block.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) values.set(match[1], match[2].trim());
    byTheme.set(theme, values);
  }
  return byTheme;
}

const cssFiles = readdirSync(join(root, "src")).filter((name) => name.endsWith(".css")).sort();
const blocks = cssFiles.flatMap((name) => cssBlocks(`src/${name}`, readFileSync(join(root, "src", name), "utf8")));

const planted = cssBlocks("planted.css", `:root { --bg: #111; --wash: rgba(0, 0, 0, 0.5); }\nhtml[data-theme="day"] { --bg: #fff; }\n.x { color: #abc; border-color: white; }\n@media (min-width: 768px) {\n  .y { background: rgb(1, 2, 3); }\n  .z { white-space: pre; }\n}\n.gig-stage { --bg: #000; }`);
const plantedFindings = literalsOutsideTokens(planted);
check(
  plantedFindings.length === 3 && plantedFindings.every((f) => f.file === "planted.css") && plantedFindings.map((f) => f.line).join(",") === "3,3,5",
  `planted literals: the three outside the token blocks are caught on their lines and the token blocks, white-space and .gig-stage are not (got ${JSON.stringify(plantedFindings)})`,
);

const findings = literalsOutsideTokens(blocks);
for (const f of findings) console.error(`${f.file}:${f.line} ${f.rule}: ${f.text}`);
check(findings.length === 0, `no color literal outside the token blocks (${findings.length} found in ${cssFiles.length} stylesheets)`);

const byTheme = tokens(blocks);
const stageKeys = [...(byTheme.get("stage")?.keys() ?? [])].sort();
const keyReport = THEMES.map((theme) => {
  const keys = [...(byTheme.get(theme)?.keys() ?? [])].sort();
  const missing = stageKeys.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !stageKeys.includes(key));
  return { theme, keys, missing, extra };
});
check(
  stageKeys.length > 0 && keyReport.every((r) => r.keys.length > 0 && r.missing.length === 0 && r.extra.length === 0),
  `every token has a value in all five themes (${stageKeys.length} tokens; ${keyReport.map((r) => `${r.theme}: ${r.keys.length}${r.missing.length ? ` missing ${r.missing.join(" ")}` : ""}${r.extra.length ? ` extra ${r.extra.join(" ")}` : ""}`).join("; ")})`,
);

const mark = (theme: Theme) => byTheme.get(theme)?.get("--battery-low-mark");
const isEmptyString = (value: string | undefined) => value === '""' || value === "''";
const isGlyph = (value: string | undefined) => /^(["']).+\1$/.test(value ?? "") && !isEmptyString(value);
check(
  isEmptyString(mark("stage")) && isEmptyString(mark("day")) && DARK_MARK_THEMES.every((theme) => isGlyph(mark(theme))),
  `\`--battery-low-mark\` is empty in stage and day and a glyph in cb-rg, cb-by and contrast (${THEMES.map((theme) => `${theme}=${mark(theme) ?? "missing"}`).join(", ")})`,
);

const bgOf = (theme: Theme) => byTheme.get(theme)?.get("--bg") ?? "";

const site = await openSite(root, "check-ux-theme-tokens");
try {
  await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await site.send("Page.enable");
  await site.send("Network.enable");
  const settle = (ms = 200) => new Promise((done) => setTimeout(done, ms));
  const until = async (expression: string, what: string) => {
    for (const end = Date.now() + 10000; Date.now() < end; await settle(50)) if (await site.evaluate<boolean>(expression)) return;
    throw new Error(`timed out waiting for ${what}`);
  };
  const open = async (url: string) => {
    await site.send("Page.navigate", { url });
    await until(`document.readyState === "complete"`, `${url} to load`);
  };
  const firstPaintState = () => site.evaluate<{ theme: string | null; meta: string | null }>(`({ theme: document.documentElement.dataset.theme ?? null, meta: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null })`);

  await site.send("Network.setBlockedURLs", { urls: ["*.js"] });
  await open(`${site.origin}/`);
  const nothingStored = await firstPaintState();
  const bundleRan = await site.evaluate<boolean>(`!!document.querySelector("#root .app")`);
  await site.evaluate(`localStorage.setItem("leadSheetsTheme", "day")`);
  await open(`${site.origin}/`);
  const daySaved = await firstPaintState();
  await site.evaluate(`localStorage.setItem("leadSheetsTheme", "purple")`);
  await open(`${site.origin}/`);
  const unknownSaved = await firstPaintState();
  await site.evaluate(`localStorage.removeItem("leadSheetsTheme")`);
  await site.send("Network.setBlockedURLs", { urls: [] });

  check(
    !bundleRan && daySaved.theme === "day" && daySaved.meta === bgOf("day") && nothingStored.meta === bgOf("stage"),
    `the saved theme is applied before first paint (bundle blocked: ${!bundleRan}; day → data-theme=${daySaved.theme}, theme-color=${daySaved.meta}, css --bg=${bgOf("day")}; stage theme-color=${nothingStored.meta})`,
  );
  check(
    nothingStored.theme === "stage" && unknownSaved.theme === "stage",
    `stage is the default with nothing stored, and an unknown stored name falls back to stage (nothing → ${nothingStored.theme}, purple → ${unknownSaved.theme})`,
  );

  const songId = JSON.parse(readFileSync(join(root, "data/library.json"), "utf8")).songs[0].id;
  await open(`${site.origin}/#/song/${songId}`);
  await site.send("Page.reload");
  await until(`!!document.querySelector(".app") && !!document.querySelector(".sheet")`, "the sheet to render");
  const setTheme = (theme: Theme) => site.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
  const shellAndPaper = () => site.evaluate<{ app: string; sheet: string }>(`({ app: getComputedStyle(document.querySelector(".app")).backgroundColor, sheet: getComputedStyle(document.querySelector(".sheet")).backgroundColor })`);
  await setTheme("stage");
  const stage = await shellAndPaper();
  const others: Record<string, { app: string; sheet: string }> = {};
  for (const theme of THEMES.slice(1)) {
    await setTheme(theme);
    others[theme] = await shellAndPaper();
  }
  check(
    THEMES.slice(1).every((theme) => others[theme].app !== stage.app && others[theme].sheet === stage.sheet),
    `each of the four themes changes the shell background and leaves the chart paper (stage app=${stage.app} sheet=${stage.sheet}; ${THEMES.slice(1).map((theme) => `${theme} app=${others[theme].app} sheet=${others[theme].sheet}`).join("; ")})`,
  );

  await site.evaluate(`(() => { const probe = document.createElement("div"); probe.id = "gig-probe"; probe.className = "gig-stage"; document.body.append(probe); })()`);
  const tokenValues = (selector: string) =>
    site.evaluate<Record<string, string>>(`(() => { const style = getComputedStyle(document.querySelector(${JSON.stringify(selector)})); return Object.fromEntries(${JSON.stringify(stageKeys)}.map((key) => [key, style.getPropertyValue(key).trim()])); })()`);
  await setTheme("stage");
  const stageTokens = await tokenValues("html");
  const gigReport: string[] = [];
  let gigHolds = stageKeys.length > 0;
  for (const theme of THEMES.slice(1)) {
    await setTheme(theme);
    const shell = await tokenValues("html");
    const gig = await tokenValues("#gig-probe");
    const shellChanged = shell["--bg"] !== stageTokens["--bg"];
    const differing = stageKeys.filter((key) => gig[key] !== stageTokens[key]);
    gigHolds &&= shellChanged && differing.length === 0;
    gigReport.push(`${theme}: shell --bg ${shell["--bg"] || "unset"}${differing.length ? `, .gig-stage differs on ${differing.join(" ")}` : ""}`);
  }
  check(gigHolds, `\`.gig-stage\` forces the stage palette under every other theme (${stageKeys.length} tokens compared; ${gigReport.join("; ")})`);

  await site.evaluate(`(() => {
    const style = document.createElement("style");
    style.textContent = \`
      #band-probe { position: fixed; top: 0; left: 0; z-index: 9999; display: flex; gap: 8px; padding: 8px; background: #fff; color: #000; font: 700 16px Inter, Arial, sans-serif; }
      #band-probe span { display: inline-block; width: 80px; height: 36px; line-height: 36px; text-align: center; text-underline-offset: 3px; }
      #band-probe .check { text-decoration-line: underline; text-decoration-style: var(--chord-check-line); }
      #band-probe .unsure { text-decoration-line: underline; text-decoration-style: var(--chord-unsure-line); }
      #band-probe .unsure::before { content: var(--chord-unsure-mark); }
      #band-probe .set { background: var(--chord-set-fill); color: var(--chord-set); }
    \`;
    document.head.append(style);
    const probe = document.createElement("div");
    probe.id = "band-probe";
    probe.innerHTML = '<span class="sure">Am7</span><span class="check">Am7</span><span class="unsure">Am7</span><span class="set">Am7</span>';
    document.body.append(probe);
  })()`);
  const bandReport: string[] = [];
  let bandsDiffer = true;
  for (const theme of THEMES) {
    await setTheme(theme);
    await settle(100);
    const { data } = await site.send("Page.captureScreenshot", { format: "png" });
    const sameness = await site.evaluate<string[]>(`(async () => {
      const image = new Image();
      image.src = "data:image/png;base64," + ${JSON.stringify(data)};
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const gray = (rect) => {
        const { data: px } = context.getImageData(Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height));
        const out = new Uint8Array(px.length / 4);
        for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
        return out;
      };
      const cells = [...document.querySelectorAll("#band-probe span")].map((cell) => ({ name: cell.className, gray: gray(cell.getBoundingClientRect()) }));
      const same = [];
      for (let a = 0; a < cells.length; a++) for (let b = a + 1; b < cells.length; b++) {
        let differing = 0;
        for (let i = 0; i < cells[a].gray.length; i++) if (Math.abs(cells[a].gray[i] - cells[b].gray[i]) > 8) differing += 1;
        if (differing <= 4) same.push(cells[a].name + "=" + cells[b].name);
      }
      return same;
    })()`);
    if (sameness.length) bandsDiffer = false;
    bandReport.push(`${theme}: ${sameness.length ? `same in grayscale ${sameness.join(" ")}` : "four distinct cells"}`);
  }
  check(bandsDiffer, `the four chord bands differ without color (${bandReport.join("; ")})`);
} finally {
  await site.close();
}

if (failures) {
  console.error(`${failures} theme token check(s) failed`);
  process.exit(1);
}
console.log(`check:ux-theme-tokens passed: ${stageKeys.length} tokens in five themes, no literals outside the token blocks, theme applied before the bundle, shell changes while paper stays, gig view stays stage, chord bands differ in grayscale`);
