import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SongContent } from "../src/band-library-model.ts";
import { startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, settle } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/**
 * U8, the theme sweep (UX-PLAN U8). One case per pass condition, named by its text. The walk visits every route in the
 * `check:screens` route list, signed out and then signed in with a real band, gig and room, plus the sheets a tap opens,
 * in the five themes at 390, 768 and 1280, and gathers what each case needs from every stop.
 *
 * Contrast is WCAG 2 relative luminance. A text node's color is laid over its effective background: the background
 * colors of its ancestors composited up to the first opaque one. Large text is 24 px, or 18.66 px at weight 700.
 * Text drawn with `background-clip: text` is measured at each color of its gradient.
 *
 * The shape case runs probes made of the app's own classes and its real Save button through the Machado 2009 severity
 * 1.0 matrices (applied to linear RGB). A pixel is ink where it differs from the probe's background after simulation,
 * so two cues that differ only in color draw the same ink and fail.
 *
 * Set CHROME to a Chromium binary. Signs up one phone with a passkey, no password, so no auth lock is needed.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const js = (value: unknown) => JSON.stringify(value);
const THEMES = ["stage", "day", "cb-rg", "cb-by", "contrast"] as const;
type Theme = (typeof THEMES)[number];
const WIDTHS = [390, 768, 1280] as const;
const HEIGHT: Record<number, number> = { 390: 844, 768: 1024, 1280: 800 };
const SIMULATED_THEMES: Theme[] = ["stage", "cb-rg", "cb-by"];

const CASES = {
  contrast: "every route in each of the five themes meets 4.5:1 for text and 3:1 for large text, and 7:1 in high contrast",
  overflow: "no element overflows the viewport at 390 and 768 in any theme",
  gigStage: "the gig screens are stage under day and take the other three",
  shapes: "under the deuteranopia, protanopia and tritanopia matrices the four chord bands, amber status, low battery and Save still differ by shape or text",
  bandTablet: "at 768 the band page shows two columns and the sheet one",
  gigTablet: "at 768 the gig view shows Now, Next and Later left and the status panel right",
  settingsTablet: "at 768 Settings is one column no wider than 560 px",
  borders: "in high contrast every control has a 2 px border",
} as const;
type Case = keyof typeof CASES;
const problems = Object.fromEntries(Object.keys(CASES).map((key) => [key, [] as string[]])) as Record<Case, string[]>;
const measured = Object.fromEntries(Object.keys(CASES).map((key) => [key, 0])) as Record<Case, number>;
const fail = (key: Case, line: string) => problems[key].push(line);

/** Text WCAG lets go, each with its reason. `--on-accent` on accent fill is not here: it is measured like any pair and passes. */
const EXCEPTIONS = [{ selector: ":disabled, [aria-disabled='true'], fieldset:disabled *", reason: "text in an inactive control is exempt (WCAG 1.4.3)" }];

/** Machado, Oliveira and Fernandes 2009, severity 1.0, rows of a 3×3 matrix on linear RGB. */
const MATRICES: Record<string, number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

type Pair = { fg: string; bg: string; ratio: number; need: number; text: string; where: string };

/** Runs in the page: every visible text node in the open modal (or the page), with its contrast and the ratio it needs. */
const CONTRAST_WALK = `((exempt, highContrast) => {
  const parse = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value || "");
    if (!m) return null;
    const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const hex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const backdrop = (from) => {
    const layers = [];
    for (let node = from; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color && color[3] > 0) layers.push(color);
      if (color && color[3] >= 1) break;
    }
    let base = layers.length && layers[layers.length - 1][3] >= 1 ? layers.pop() : [255, 255, 255, 1];
    for (const layer of layers.reverse()) base = over(layer, base);
    return base;
  };
  const describe = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "");
  const modals = [...document.querySelectorAll('[aria-modal="true"]')].filter((el) => el.checkVisibility());
  const scope = modals[modals.length - 1] ?? document.body;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const pairs = [];
  let exempted = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    const el = node.parentElement;
    if (!text || !el || el.closest("svg, script, style, noscript, title")) continue;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) continue;
    if (exempt.some((selector) => el.closest(selector))) { exempted += 1; continue; }
    const style = getComputedStyle(el);
    let opacity = 1;
    for (let n = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const need = highContrast ? (large ? 4.5 : 7) : large ? 3 : 4.5;
    const clipped = (style.backgroundClip === "text" || style.webkitBackgroundClip === "text") && style.backgroundImage !== "none";
    const bg = backdrop(clipped ? el.parentElement : el);
    const inks = clipped ? [...style.backgroundImage.matchAll(/rgba?\\([^)]+\\)/g)].map((m) => parse(m[0])) : [parse(style.color)];
    for (const ink of inks) {
      if (!ink || ink[3] === 0) continue;
      const fg = over([ink[0], ink[1], ink[2], ink[3] * opacity], bg);
      pairs.push({ fg: hex(fg), bg: hex(bg), ratio: Math.round(ratio(fg, bg) * 100) / 100, need, text: text.slice(0, 40), where: describe(el) });
    }
  }
  return { pairs, exempted };
})`;

/** Runs in the page: vertical scrollers that scroll or clip sideways, as vdiff's overflowX reads the page's scrollWidth. */
const OVERFLOW = `(() => {
  const describe = (el) => el === document.documentElement ? "the page" : el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).join(".") : "");
  const boxes = [document.documentElement, ...document.querySelectorAll(".scroll, [role=dialog], .bottom-sheet, .account-sheet, .room, .messages")].filter((el) => el === document.documentElement || el.checkVisibility());
  const out = [];
  for (const box of boxes) {
    if (box.scrollWidth <= box.clientWidth + 1) continue;
    const edge = box === document.documentElement ? box.clientWidth : box.getBoundingClientRect().left + box.clientWidth;
    const past = [...box.querySelectorAll("*")].filter((el) => el.checkVisibility() && el.getBoundingClientRect().right > edge + 1 && ![...el.children].some((child) => child.getBoundingClientRect().right > edge + 1));
    out.push(describe(box) + " is " + box.scrollWidth + " wide in " + box.clientWidth + (past.length ? " (" + past.slice(0, 3).map((el) => describe(el) + " to " + Math.round(el.getBoundingClientRect().right)).join(", ") + ")" : ""));
  }
  return out;
})()`;

/** Runs in the page: every visible control without a 2 px border on all four sides. */
const BORDERS = `(() => {
  const modals = [...document.querySelectorAll('[aria-modal="true"]')].filter((el) => el.checkVisibility());
  const scope = modals[modals.length - 1] ?? document.body;
  const controls = [...scope.querySelectorAll('button, input:not([type="hidden"]), select, textarea, [role="button"]:not(button), [role="switch"]:not(button)')];
  const thin = [];
  for (const el of controls) {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) continue;
    const style = getComputedStyle(el);
    const sides = ["Top", "Right", "Bottom", "Left"].filter((side) => parseFloat(style["border" + side + "Width"]) < 2 || style["border" + side + "Style"] === "none");
    if (sides.length) thin.push((el.getAttribute("aria-label") || el.textContent.trim() || el.tagName.toLowerCase()).slice(0, 30) + " (" + el.className + ")");
  }
  return { count: controls.length, thin };
})()`;

/** Runs in the page: the custom properties of the `:root, .gig-stage` block, and their values on html and on `.app`. */
const TOKENS = `(() => {
  const keys = new Set();
  for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) if (rule.selectorText && rule.selectorText.replace(/\\s+/g, "") === ":root,.gig-stage") for (const name of rule.style) if (name.startsWith("--")) keys.add(name);
  const read = (el) => { const style = getComputedStyle(el); return Object.fromEntries([...keys].map((key) => [key, style.getPropertyValue(key).trim()])); };
  const app = document.querySelector(".app");
  return { keys: [...keys], html: read(document.documentElement), app: app ? read(app) : null };
})()`;

type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const rectOf = (selector: string) => `(() => { const el = document.querySelector(${js(selector)}); if (!el || !el.checkVisibility()) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })()`;
const overlapsVertically = (a: Rect, b: Rect) => a.top < b.bottom - 1 && b.top < a.bottom - 1;
const leftOf = (a: Rect, b: Rect) => a.right <= b.left + 1;

const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: (SongContent & { id: number })[]; setlists: { id: number; songIds: number[] }[] };
const content = ({ id: _id, ...song }: SongContent & { id: number }): SongContent => song;
const SET_SONGS = seed.songs.slice(0, 3);
const firstSetlist = seed.setlists[0];
const dayFromNow = (days: number) => {
  const day = new Date();
  day.setDate(day.getDate() + days);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};
const newGigId = () => `gig_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;

/** A place the walk stops: a hash, what shows when it is ready, and an optional tap that opens a sheet over it. */
type Stop = { name: string; hash: string; ready: string; tap?: string; opened?: string; kind?: "band" | "gig" | "stage" | "song" | "settings" };
const button = (text: string, scope = "document") => `[...${scope}.querySelectorAll("button")].find((b) => b.textContent.trim() === ${js(text)} && !b.disabled)`;
const tapButton = (text: string, scope = "document") => `${button(text, scope)}.click()`;

/** The `check:screens` route list as that check writes it. */
const SCREEN_ROUTES = ["#/songs", "#/setlists", "#/bands", `#/song/${seed.songs[0].id}`, "#/song/999", `#/live/${firstSetlist.id}/0`, `#/live/${firstSetlist.id}/99`, "#/live/77/0", "#/live/404/0", "#/settings", "#/band/band_x", "#/band/band_x/plan/gig_x?setlist=set_x", "#/gig/band_x/gig_x", "#/gig/band_x/gig_x/0", "#/messages", "#/messages/dm_x"];
const SONG = `#/song/${seed.songs[0].id}`;

let apiBase = "";
const site = await openSite(root, "check-ux-theme-sweep", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;

try {
  const app = await appPage(site);
  const call = (path: string, body: object) =>
    site.evaluate<{ status: number; body: any }>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const setWidth = async (width: number) => {
    await site.send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT[width], deviceScaleFactor: 1, mobile: width < 1000 });
    await settle(200);
  };
  const setTheme = async (theme: Theme) => {
    await site.evaluate(`document.documentElement.dataset.theme = ${js(theme)}`);
    await settle(60);
  };
  const visit = async (stop: Stop) => {
    await site.send("Page.navigate", { url: "about:blank" });
    await site.send("Page.navigate", { url: `${origin}/${stop.hash}` });
    await app.until(`document.readyState === "complete" && !!document.querySelector(".app") && (${stop.ready})`, `${stop.name} to show`, 20000);
    if (stop.tap) {
      await site.evaluate(stop.tap);
      await app.until(stop.opened ?? "true", `${stop.name} to open`, 10000);
    }
    await settle(300);
  };

  const worst: Record<Theme, Map<string, Pair & { stop: string }>> = Object.fromEntries(THEMES.map((theme) => [theme, new Map()])) as any;
  let exemptedTexts = 0;
  const gigTokens: string[] = [];

  /** Every route and sheet in all five themes at all three widths, gathering what the cases read. */
  const sweep = async (stop: Stop) => {
    await visit(stop);
    for (const width of WIDTHS) {
      await setWidth(width);
      for (const theme of THEMES) {
        await setTheme(theme);
        const where = `${stop.name} @${width} ${theme}`;
        const { pairs, exempted } = await site.evaluate<{ pairs: Pair[]; exempted: number }>(`${CONTRAST_WALK}(${js(EXCEPTIONS.map((e) => e.selector))}, ${theme === "contrast"})`);
        exemptedTexts += exempted;
        measured.contrast += pairs.length;
        for (const pair of pairs) {
          const key = `${pair.fg}|${pair.bg}|${pair.need}`;
          const seen = worst[theme].get(key);
          if (!seen) worst[theme].set(key, { ...pair, stop: `${stop.name} @${width}` });
          if (pair.ratio < pair.need && !seen) fail("contrast", `${where}: "${pair.text}" ${pair.where} ${pair.fg} on ${pair.bg} is ${pair.ratio}:1, needs ${pair.need}:1`);
        }
        if (width !== 1280) {
          measured.overflow += 1;
          for (const line of await site.evaluate<string[]>(OVERFLOW)) fail("overflow", `${where}: ${line}`);
        }
        if (theme === "contrast") {
          const { count, thin } = await site.evaluate<{ count: number; thin: string[] }>(BORDERS);
          measured.borders += count;
          if (thin.length) fail("borders", `${stop.name} @${width}: ${thin.length} without a 2 px border: ${thin.slice(0, 6).join("; ")}`);
        }
        if ((stop.kind === "gig" || stop.kind === "stage") && width === 390) {
          const tokens = await site.evaluate<{ keys: string[]; html: Record<string, string>; app: Record<string, string> | null }>(TOKENS);
          gigTokens.push(js({ stop: stop.name, theme, ...tokens }));
        }
      }
      await setTheme("stage");
      if (width === 768) await tablet(stop);
    }
    await setWidth(390);
  };

  const tablet = async (stop: Stop) => {
    if (stop.kind === "band") {
      const tabs = await site.evaluate<Rect | null>(rectOf(".band-page > .band-tabs"));
      const open = await site.evaluate<Rect | null>(`(() => { const tabs = document.querySelector(".band-page > .band-tabs"); let el = tabs?.nextElementSibling; while (el && !el.checkVisibility()) el = el.nextElementSibling; if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })()`);
      measured.bandTablet += 1;
      if (!tabs || !open) fail("bandTablet", `${stop.name}: no section list or open section (${js({ tabs, open })})`);
      else if (!(leftOf(tabs, open) && overlapsVertically(tabs, open))) fail("bandTablet", `${stop.name}: the section list ${js(tabs)} is not beside the open section ${js(open)}`);
    }
    if (stop.kind === "song") {
      const rows = await site.evaluate<Rect[]>(`[...document.querySelectorAll(".sheet .chart .pair")].filter((el) => el.checkVisibility()).map((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })`);
      measured.bandTablet += 1;
      const lefts = new Set(rows.map((row) => Math.round(row.left)));
      const stacked = rows.every((row, i) => i === 0 || row.top >= rows[i - 1].bottom - 1);
      if (rows.length < 2 || lefts.size !== 1 || !stacked) fail("bandTablet", `${stop.name}: the sheet is not one column (${rows.length} lines, lefts ${[...lefts].join(",")}, stacked ${stacked})`);
    }
    if (stop.kind === "gig") {
      const [now, next, later, status] = await Promise.all([".gig-now", ".gig-next", ".gig-set", ".gig-view > .band-status-slot"].map((selector) => site.evaluate<Rect | null>(rectOf(selector))));
      measured.gigTablet += 1;
      if (!now || !next || !later || !status) fail("gigTablet", `${stop.name}: missing a box (${js({ now: !!now, next: !!next, later: !!later, status: !!status })})`);
      else if (![now, next, later].every((box) => leftOf(box, status)) || !overlapsVertically(now, status)) fail("gigTablet", `${stop.name}: Now ${js(now)}, Next ${js(next)}, Later ${js(later)} are not left of the status panel ${js(status)}`);
    }
    if (stop.kind === "settings") {
      const shell = await site.evaluate<Rect | null>(rectOf(".settings"));
      const groups = await site.evaluate<Rect[]>(`[...document.querySelectorAll(".settings > .settings-group, .settings > section")].filter((el) => el.checkVisibility()).map((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })`);
      measured.settingsTablet += 1;
      const lefts = new Set(groups.map((group) => Math.round(group.left)));
      const stacked = groups.every((group, i) => i === 0 || group.top >= groups[i - 1].bottom - 1);
      if (!shell || shell.width > 560 || groups.length < 2 || lefts.size !== 1 || !stacked) fail("settingsTablet", `${stop.name}: ${js({ width: shell?.width, groups: groups.length, lefts: [...lefts], stacked })}`);
    }
  };

  const shapes = async (stop: Stop, save: boolean) => {
    await visit(stop);
    await setWidth(390);
    if (save) {
      await site.evaluate(`document.querySelector("[aria-label='Transpose up']").click()`);
      await app.until(`!!document.querySelector(".save-btn") && !!document.querySelector(".revert-btn")`, "Save and Revert after a change", 10000);
    }
    await site.evaluate(`(() => {
      const style = document.createElement("style");
      style.textContent = \`
        #u8-probe { position: fixed; top: 60px; left: 0; z-index: 9999; display: grid; gap: 8px; width: 390px; padding: 8px; background: var(--bg); color: var(--text); font: 700 16px Inter, Arial, sans-serif; }
        #u8-probe > div { display: flex; gap: 8px; padding: 8px; }
        #u8-probe .u8-bands span { display: inline-block; width: 80px; height: 36px; line-height: 36px; text-align: center; text-underline-offset: 3px; }
        #u8-probe .sure { color: var(--chord-sure); }
        #u8-probe .check { color: var(--chord-check); text-decoration-line: underline; text-decoration-style: var(--chord-check-line); }
        #u8-probe .unsure { color: var(--chord-unsure); text-decoration-line: underline; text-decoration-style: var(--chord-unsure-line); }
        #u8-probe .unsure::before { content: var(--chord-unsure-mark); }
        #u8-probe .set { background: var(--chord-set-fill); color: var(--chord-set); }
        #u8-probe .u8-rows { display: grid; background: var(--surface-2); }
        #u8-probe .u8-dots { background: var(--paper); }
        #u8-probe .beat-rail { position: relative; width: 60px; height: 60px; }
      \`;
      document.head.append(style);
      const probe = document.createElement("div");
      probe.id = "u8-probe";
      probe.innerHTML = '<div class="u8-bands"><span class="sure">Am7</span><span class="check">Am7</span><span class="unsure">Am7</span><span class="set">Am7</span></div>'
        + '<div class="u8-faces band-status-faces"><button type="button" class="band-status-face">SR</button><button type="button" class="band-status-face band-status-face-amber">SR</button></div>'
        + '<div class="u8-rows"><ul class="band-status-rows"><li class="band-status-row"><span class="band-status-name">Sam Rivera</span><span class="band-status-route">On the sheet</span><span class="band-status-heard">Heard —</span></li><li class="band-status-row band-status-amber"><span class="band-status-name">Sam Rivera</span><span class="band-status-route">On the sheet</span><span class="band-status-heard">Heard —</span></li></ul></div>'
        + '<div class="u8-dots"><div class="beat-rail"><button type="button" class="beat-pill"><span class="beat-dot" data-beat="on" data-battery="ok"></span></button></div><div class="beat-rail"><button type="button" class="beat-pill"><span class="beat-dot" data-beat="on" data-battery="low"></span><span class="battery-mark" aria-hidden="true"></span></button></div></div>';
      document.body.append(probe);
    })()`);
    const groups = save
      ? [{ name: "Save", pairs: `(() => { const save = document.querySelector(".save-btn"); const others = [...save.closest(".song-line, .song-save, header").querySelectorAll("button, .version-chip")].filter((el) => el !== save && !save.contains(el) && el.checkVisibility()); return others.map((other) => [save, other]); })()`, bg: `document.querySelector(".save-btn").parentElement` }]
      : [
          { name: "chord bands", pairs: `(() => { const cells = [...document.querySelectorAll("#u8-probe .u8-bands span")]; const out = []; for (let a = 0; a < cells.length; a++) for (let b = a + 1; b < cells.length; b++) out.push([cells[a], cells[b]]); return out; })()`, bg: `document.querySelector("#u8-probe .u8-bands")` },
          { name: "amber face", pairs: `[[...document.querySelectorAll("#u8-probe .u8-faces button")]]`, bg: `document.querySelector("#u8-probe .u8-faces")` },
          { name: "amber row", pairs: `[[...document.querySelectorAll("#u8-probe .u8-rows li")]]`, bg: `document.querySelector("#u8-probe .u8-rows")` },
          { name: "low battery", pairs: `[[...document.querySelectorAll("#u8-probe .u8-dots .beat-pill")]]`, bg: `document.querySelector("#u8-probe .u8-dots")` },
        ];
    if (save) await site.evaluate(`document.getElementById("u8-probe").remove()`);
    for (const theme of SIMULATED_THEMES) {
      await setTheme(theme);
      await settle(150);
      const { data } = await site.send("Page.captureScreenshot", { format: "png" });
      for (const group of groups) {
        const report = await site.evaluate<{ pairs: number; same: string[] }>(`(async () => {
          const image = new Image();
          image.src = "data:image/png;base64," + ${js(data)};
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          context.drawImage(image, 0, 0);
          const scale = image.width / innerWidth;
          const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          const enc = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
          const simulate = (m, r, g, b) => { const [R, G, B] = [lin(r), lin(g), lin(b)]; return [0, 3, 6].map((i) => enc(Math.min(1, Math.max(0, m[i] * R + m[i + 1] * G + m[i + 2] * B)))); };
          const bgBox = (${group.bg}).getBoundingClientRect();
          const bgPx = context.getImageData(Math.round((bgBox.left + 2) * scale), Math.round((bgBox.top + 2) * scale), 1, 1).data;
          const label = (el) => (el.getAttribute("aria-label") || el.className || el.textContent).toString().trim().slice(0, 24);
          const pairs = ${group.pairs};
          const same = [];
          for (const [name, m] of Object.entries(${js(MATRICES)})) {
            const bg = simulate(m, bgPx[0], bgPx[1], bgPx[2]);
            const ink = (el) => {
              const r = el.getBoundingClientRect();
              const x = Math.round(r.left * scale), y = Math.round(r.top * scale), w = Math.round(r.width * scale), h = Math.round(r.height * scale);
              const px = context.getImageData(x, y, w, h).data;
              const mask = new Uint8Array(w * h);
              for (let i = 0; i < mask.length; i++) {
                const s = simulate(m, px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
                mask[i] = Math.hypot(s[0] - bg[0], s[1] - bg[1], s[2] - bg[2]) > 20 ? 1 : 0;
              }
              return { w, h, mask };
            };
            for (const [a, b] of pairs) {
              if (a.textContent.trim() !== b.textContent.trim()) continue;
              const [p, q] = [ink(a), ink(b)];
              if (p.w !== q.w || p.h !== q.h) continue;
              let union = 0, differ = 0;
              for (let i = 0; i < p.mask.length; i++) { if (p.mask[i] || q.mask[i]) union++; if (p.mask[i] !== q.mask[i]) differ++; }
              if (differ <= Math.max(4, union * 0.08)) same.push(name + ": " + label(a) + " = " + label(b) + " (" + differ + " of " + union + " ink px differ)");
            }
          }
          return { pairs: pairs.length, same };
        })()`);
        measured.shapes += report.pairs;
        if (report.pairs === 0) fail("shapes", `${stop.name} ${theme}: no ${group.name} to compare`);
        for (const line of report.same) fail("shapes", `${theme} ${group.name} differ by color alone under ${line}`);
      }
    }
    await setTheme("stage");
  };

  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await app.library();

  const signedOut: Stop[] = [
    ...SCREEN_ROUTES.map((hash): Stop => ({
      name: `signed out ${hash}`,
      hash,
      ready: hash.startsWith("#/song/") && hash !== "#/song/999" ? `!!document.querySelector(".sheet")` : `!!document.querySelector(".scroll, .app h1")`,
      kind: hash === SONG ? "song" : hash === "#/settings" ? "settings" : hash.startsWith("#/gig/") ? "stage" : undefined,
    })),
    { name: "signed out Settings, Sign in sheet", hash: "#/settings", ready: `!!document.querySelector(".settings")`, tap: tapButton("Sign in", `document.querySelector(".settings [role=group][aria-label=Account]")`), opened: `!!document.querySelector(".account-sheet[data-step]")` },
    { name: "Metronome sheet", hash: SONG, ready: `!!document.querySelector(".metronome-pill")`, tap: `document.querySelector(".metronome-pill").click()`, opened: `!!document.querySelector(".metronome-sheet")` },
    { name: "Scroll sheet", hash: SONG, ready: `!!document.querySelector(".scroll-caret")`, tap: `document.querySelector(".scroll-caret").click()`, opened: `!!document.querySelector(".bottom-sheet")` },
    { name: "song More menu", hash: SONG, ready: `!!document.querySelector(".shell-header [aria-label=More]")`, tap: `document.querySelector(".shell-header [aria-label=More]").click()`, opened: `!!document.querySelector("[role=menu]")` },
  ];
  for (const stop of signedOut) await sweep(stop);

  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await app.library();
  await app.signUp("Sam Rivera");
  const me = (await site.evaluate<{ account?: { userId: string } }>(`fetch("/api/me").then((r) => r.json())`)).account;
  if (!me) throw new Error("Sam is not signed in after Create account");
  const bandId = (await call("/api/bands/create", { name: "The Blue Notes" })).body.bandId as string;
  const shared: string[] = [];
  for (const song of SET_SONGS) shared.push((await call("/api/bands/library/share-song", { bandId, song: content(song), choice: "public", localId: null })).body.songId);
  const setlistId = (await call("/api/bands/library/share-setlist", { bandId, name: "Friday set", songIds: shared, tags: [], choice: "public", localId: null })).body.setlistId as string;
  const planned = await call("/api/bands/gig/plan", { bandId, setlistId, gigId: newGigId(), lineup: [me.userId], name: "Friday at the Elks", date: dayFromNow(2), leader: me.userId });
  if (planned.status !== 200) throw new Error(`the gig did not plan (${js(planned.body)})`);
  const gigId = planned.body.gig.gigId as string;
  const bandPage = `document.querySelector(${js(`.band-page[data-band="${bandId}"]`)})`;
  const bandReady = `${bandPage}?.dataset.view === "band" && !${bandPage}.textContent.includes("Loading")`;
  await site.send("Page.navigate", { url: `${origin}/#/band/${bandId}` });
  await app.until(`${bandReady} && /Pack 3 of 3 downloaded/.test(${bandPage}.querySelector(".next-gig")?.textContent ?? "")`, "the gig pack on this phone", 30000);

  await site.send("Page.navigate", { url: `${origin}/#/messages` });
  await app.until(`!!document.querySelector(".chat-row")`, "the band room in Messages", 15000);
  await site.evaluate(`document.querySelector(".chat-row").click()`);
  await app.until(`!!document.querySelector(".room .chat-composer textarea")`, "the band room", 15000);
  const roomHash = await site.evaluate<string>("location.hash");
  await site.evaluate(`document.querySelector(".room .chat-composer textarea").focus()`);
  await site.send("Input.insertText", { text: "Soundcheck at six" });
  await site.evaluate(`document.querySelector(".room .chat-composer button[type=submit]").click()`);
  await app.until(`[...document.querySelectorAll(".chat-bubble")].some((b) => b.textContent.includes("Soundcheck at six"))`, "the message in the room", 15000);

  const sectionStop = (label: string): Stop => ({
    name: `band page ${label}`,
    hash: `#/band/${bandId}`,
    ready: bandReady,
    tap: tapButton(label, `${bandPage}.querySelector(".band-tabs")`),
    opened: `[...${bandPage}.querySelectorAll(".band-tabs [role=tab]")].some((tab) => tab.getAttribute("aria-selected") === "true" && tab.textContent.includes(${js(label)}))`,
    kind: "band",
  });
  const signedIn: Stop[] = [
    { name: "signed in #/songs", hash: "#/songs", ready: `!!document.querySelector(".scroll")` },
    { name: "signed in #/setlists", hash: "#/setlists", ready: `!!document.querySelector(".scroll")` },
    { name: "signed in #/bands", hash: "#/bands", ready: `!!document.querySelector(".scroll")` },
    { name: "signed in #/settings", hash: "#/settings", ready: `!!document.querySelector(".settings")`, kind: "settings" },
    { name: "Friends sheet", hash: "#/settings", ready: `!!document.querySelector(".settings")`, tap: tapButton("Friends"), opened: `!!document.querySelector(".friends-sheet")` },
    { name: "New band sheet", hash: "#/bands", ready: `!!${button("+ New band")}`, tap: tapButton("+ New band"), opened: `!!document.querySelector(".bands-sheet")` },
    { name: "signed in song", hash: SONG, ready: `!!document.querySelector(".sheet")`, kind: "song" },
    { name: "Send sheet", hash: SONG, ready: `!!document.querySelector(".send-btn")`, tap: `document.querySelector(".send-btn").click()`, opened: `!!document.querySelector(".send-song-sheet")` },
    { name: "song with a change", hash: SONG, ready: `!!document.querySelector("[aria-label='Transpose up']")`, tap: `document.querySelector("[aria-label='Transpose up']").click()`, opened: `!!document.querySelector(".save-btn")` },
    ...["Songs", "Setlists", "Chat", "Gigs", "Members"].map(sectionStop),
    { name: "band status panel", hash: `#/band/${bandId}`, ready: `${bandReady} && !!document.querySelector(".band-status-face")`, tap: `document.querySelector(".band-status-face").click()`, opened: `!!document.querySelector(".band-status-sheet")` },
    { name: "band invite QR", hash: `#/band/${bandId}`, ready: bandReady, tap: tapButton("Show as QR", bandPage), opened: `${bandPage}?.dataset.view === "invite"` },
    { name: "plan gig", hash: `#/band/${bandId}/plan/${gigId}?setlist=${setlistId}`, ready: `!!document.querySelector(".plan-gig")` },
    { name: "gig view", hash: `#/gig/${bandId}/${gigId}`, ready: `!!document.querySelector(${js(`.gig-view[data-gig="${gigId}"] .gig-now`)}) && !!document.querySelector(".gig-view .band-status-face")`, kind: "gig" },
    { name: "gig sheet", hash: `#/gig/${bandId}/${gigId}/0`, ready: `!!document.querySelector(".sheet .sheet-name")`, kind: "stage" },
    { name: "live set", hash: `#/live/${firstSetlist.id}/0`, ready: `!!document.querySelector(".sheet")` },
    { name: "signed in #/messages", hash: "#/messages", ready: `!!document.querySelector(".chat-row")` },
    { name: "band room", hash: roomHash, ready: `!!document.querySelector(".chat-bubble")` },
  ];
  for (const stop of signedIn) await sweep(stop);

  await shapes({ name: "band page probes", hash: `#/band/${bandId}`, ready: bandReady }, false);
  await shapes({ name: "Save", hash: SONG, ready: `!!document.querySelector("[aria-label='Transpose up']")` }, true);

  const stageValues = gigTokens.map((line) => JSON.parse(line)).find((entry) => entry.theme === "stage")?.html ?? {};
  for (const line of gigTokens) {
    const entry = JSON.parse(line) as { stop: string; theme: Theme; keys: string[]; html: Record<string, string>; app: Record<string, string> | null };
    measured.gigStage += 1;
    if (!entry.app || entry.keys.length === 0) {
      fail("gigStage", `${entry.stop} ${entry.theme}: no .app or no tokens`);
      continue;
    }
    const want = entry.theme === "stage" || entry.theme === "day" ? stageValues : entry.html;
    const off = entry.keys.filter((key) => entry.app![key] !== want[key]);
    if (entry.theme === "day" && entry.html["--bg"] === stageValues["--bg"]) fail("gigStage", `${entry.stop} day: the shell itself is not in day`);
    if (off.length) fail("gigStage", `${entry.stop} ${entry.theme}: the gig screen should be ${entry.theme === "day" ? "stage" : entry.theme} but differs on ${off.slice(0, 6).join(" ")}${off.length > 6 ? ` and ${off.length - 6} more` : ""} (--bg ${entry.app["--bg"]}, wanted ${want["--bg"]})`);
  }

  for (const theme of THEMES) {
    const pairs = [...worst[theme].values()].sort((a, b) => a.ratio / a.need - b.ratio / b.need).slice(0, 5);
    console.log(`     ${theme} worst five: ${pairs.map((p) => `${p.ratio}:1 (needs ${p.need}) "${p.text}" ${p.fg} on ${p.bg} at ${p.stop}`).join(" | ")}`);
  }
  console.log(`     ${exemptedTexts} text nodes exempt: ${EXCEPTIONS.map((e) => `${e.selector}, ${e.reason}`).join("; ")}`);

  for (const [key, name] of Object.entries(CASES) as [Case, string][]) {
    const found = problems[key];
    const ok = found.length === 0 && measured[key] > 0;
    console.log(`${ok ? "ok  " : "FAIL"} ${name} (${measured[key]} measured${found.length ? `, ${found.length} problems` : ""})`);
    for (const line of found.slice(0, 40)) console.log(`       ${line}`);
    if (found.length > 40) console.log(`       and ${found.length - 40} more`);
  }
} finally {
  await worker.dispose();
  await site.close();
}

const failed = (Object.keys(CASES) as Case[]).filter((key) => problems[key].length > 0 || measured[key] === 0);
if (failed.length) {
  console.error(`${failed.length} theme sweep check(s) failed`);
  process.exit(1);
}
console.log("check:ux-theme-sweep passed");
