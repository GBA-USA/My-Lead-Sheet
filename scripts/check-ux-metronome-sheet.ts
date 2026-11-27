import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SongContent } from "../src/band-library-model.ts";
import { startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER } from "./app-page.ts";
import { chordAnchors, type Row } from "./chord-anchors.ts";
import { openSite, type Site } from "./chrome.ts";

/**
 * U3b, the Metronome sheet and the battery dot (UX-PLAN U3b, SCREEN-MAP 3 and 5, Terry t161u to t163u). One case per
 * pass condition, named by it. The cases fix this contract.
 *
 * The Metronome pill `.controls .metronome-pill` reads "Metronome" while the metronome is off and "<bpm> bpm" while it
 * plays, and opens a bottom sheet `[role=dialog]` titled "Metronome" (✕ `[aria-label=Close]`, Escape, or a tap on the
 * backdrop closes it). The sheet holds the On/Off pad `.metro-pad` (`aria-pressed`), "Slower metronome" and "Faster
 * metronome", the bpm field "Metronome speed in bpm", and the groups `[role=group][aria-label=Sound]` and
 * `[aria-label=Dot]` with On and Off. Settings has the same two groups under `.settings`. The paper card has no
 * metronome block.
 *
 * While the metronome plays, the card `article.sheet` holds the tappable pill `.beat-pill` around the beat dot. Its
 * `aria-label` starts with the state: "Sound and dot", "Sound only", "Dot only" or "No sound or dot". With Dot on the
 * pill holds `.beat-dot` (`data-beat` on/off with the beat); with Dot off there is no `.beat-dot`. The dot is the
 * `--battery-ok` color at 21 to 100%, `--battery-low` at 20% or less, and its normal red where `navigator.getBattery`
 * is missing. At low battery in cb-rg, cb-by and contrast a glyph shows beside the dot inside the pill.
 *
 * Sound and Dot are `sound` and `indicator` in `leadSheetsMetronome`, this phone's own settings.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "worker"], { cwd: root, stdio: "inherit" });

const SONG = 10;
const SONG_BPM = 78;
const PREFS_KEY = "leadSheetsMetronome";
const js = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const seed = JSON.parse(readFileSync(join(root, "data/library.json"), "utf8")) as { songs: (SongContent & { id: number })[] };

/**
 * At `#/song/10` with Song info closed, relative to `article.sheet`: the first chord glyph, the left edge, and the
 * tops of the card's children, which read title, meta, Song info row, chart. The source line, Feel and the labelled
 * notes sit in the closed panel and are not laid out.
 * x is Chrome on Linux (the CI runner), measured on the base (addc5a2). No y here is a measurement on another system.
 * Each is the stylesheet's arithmetic from the card's top padding and the title's line count. The base's Linux pins
 * give that count: .source at 87.88 and 68.14 is 2 and 1 title lines (27.744 px each) under the 20 and 28 px padding,
 * plus .source's 12.416 px margin. Below the title every line height is unitless and the row is 44 px. The first chord
 * row sits under the section margin and the heading's one line (Inter's normal line at 13.12 px, 16 px), and the
 * glyph's top is its row's top. The chart reads the Linux pins to 0.01 px on the base at 1280 px. The case measures
 * the card again in serif. Every top holds there, so only the title's line count and the glyph's place in its row
 * depend on how a system draws text.
 */
const IN_SONG_INFO = [".source", ".feel", ".sheet-label"];
/** The Song info row is a 44 px tap target (the brief's number, not a measurement). Its one text line is shorter. */
const ROW_TAP = 44;
const EM = 16;
const LINE = { title: 1.7 * 1.02 * EM, meta: 0.84 * 1.4 * EM, heading: 16 };
const GAP = { meta: 0.7 * 0.84 * EM, info: 0.55 * EM, chart: 0.2 * EM, section: 1.15 * EM, heading: 0.4 * 0.82 * EM };
/** The closed card's tops below a title at `top` that wraps to `lines`, and the first chord's y. */
function stack(top: number, lines: number) {
  const meta = top + lines * LINE.title + GAP.meta;
  const info = meta + LINE.meta + GAP.info;
  const chart = info + ROW_TAP + GAP.chart;
  return { tops: { ".sheet-title": top, ".meta": meta, ".song-info": info, ".chart": chart }, chord: chart + GAP.section + LINE.heading + GAP.heading };
}
const CARD: Record<number, { x: number; left: number; top: number; titleLines: number }> = {
  390: { x: 109.59, left: 16, top: 20, titleLines: 2 },
  1280: { x: 121.59, left: 28, top: 28, titleLines: 1 },
};

/** Counts every click the page starts, records every body it sends, and stands in for the battery named in sessionStorage. */
const PAGE_SETUP = `(() => {
  window.__clicks = 0;
  const start = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (...args) { window.__clicks += 1; return start.apply(this, args); };
  window.__sent = [];
  const note = (url, body) => window.__sent.push({ url: String(url), body: typeof body === "string" ? body : body == null ? "" : String(body) });
  const realFetch = window.fetch;
  window.fetch = function (input, init) { note(input instanceof Request ? input.url : input, init?.body); return realFetch.apply(this, arguments); };
  const xhr = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) { note("xhr", body); return xhr.apply(this, arguments); };
  const ws = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) { note(this.url, data); return ws.apply(this, arguments); };
  const beacon = navigator.sendBeacon?.bind(navigator);
  if (beacon) navigator.sendBeacon = (url, data) => { note(url, data); return beacon(url, data); };
  const level = sessionStorage.getItem("__battery");
  if (level === null) {
    delete Navigator.prototype.getBattery;
    return;
  }
  const manager = new EventTarget();
  Object.assign(manager, { level: Number(level), charging: false, chargingTime: Infinity, dischargingTime: Infinity });
  Object.defineProperty(navigator, "getBattery", { configurable: true, value: () => Promise.resolve(manager) });
  window.__setBattery = (next) => {
    manager.level = next;
    manager.dispatchEvent(new Event("levelchange"));
  };
})()`;

const STATES = { both: "Sound and dot", sound: "Sound only", dot: "Dot only", off: "No sound or dot" } as const;
type State = keyof typeof STATES;
const PREFS: Record<State, { sound: boolean; indicator: boolean }> = {
  both: { sound: true, indicator: true },
  sound: { sound: true, indicator: false },
  dot: { sound: false, indicator: true },
  off: { sound: false, indicator: false },
};

const METRO = `[...document.querySelectorAll("[role=dialog]")].find((d) => d.querySelector("h2")?.textContent.trim() === "Metronome")`;
const SETTINGS = `document.querySelector(".settings")`;
const HEADER = `document.querySelector(".shell-header")`;
const PILL = ".controls .metronome-pill";
const BEAT_PILL = "article.sheet .beat-pill";

/** One phone: a Chrome tab on the app, driven the way a player taps it. */
async function phoneOn(site: Site, origin: string) {
  await site.send("Page.enable");
  await site.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SETUP });
  const evaluate = <T>(expression: string) => site.evaluate<T>(expression);
  const until = async (expression: string, what: string, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await evaluate<boolean>(expression)) return;
    throw new Error(`timed out waiting for ${what} at ${await evaluate<string>("location.hash")}`);
  };
  const buttonIn = (scope: string, text: string) =>
    `[...(${scope}?.querySelectorAll("button") ?? [])].find((b) => (b.textContent.trim() === ${js(text)} || b.getAttribute("aria-label") === ${js(text)}) && b.getClientRects().length > 0)`;
  const has = (text: string, scope = "document") => evaluate<boolean>(`!!${buttonIn(scope, text)}`);
  const tap = async (text: string, scope = "document") => {
    const tapped = await evaluate<boolean>(`(() => { const el = ${buttonIn(scope, text)}; if (!el || el.disabled) return false; el.click(); return true; })()`);
    assert.ok(tapped, `a ${text} button to tap at ${await evaluate<string>("location.hash")}`);
    await sleep(250);
  };
  const tapOn = async (selector: string) => {
    const tapped = await evaluate<boolean>(`(() => { const el = document.querySelector(${js(selector)}); if (!el || el.disabled || !el.getClientRects().length) return false; el.click(); return true; })()`);
    assert.ok(tapped, `${selector} to tap at ${await evaluate<string>("location.hash")}`);
    await sleep(250);
  };
  const ready = async () => {
    await until(`!!document.querySelector(".shell-header") && document.readyState === "complete"`, "the app", 15000);
    await evaluate(`document.fonts.ready.then(() => true)`);
    await sleep(400);
  };
  /** A fresh, signed-out phone at `hash`, after `setup` runs on an empty localStorage and sessionStorage. */
  const fresh = async (hash = `#/song/${SONG}`, setup = "") => {
    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await until(`document.readyState === "complete"`, "the page");
    await evaluate(`localStorage.clear(); sessionStorage.clear(); ${setup}; 0`);
    await site.send("Page.navigate", { url: `${origin}/${hash}` });
    await until(`location.hash === ${js(hash)}`, `the address ${hash}`);
    await site.send("Page.reload");
    await ready();
  };
  const reload = async () => {
    await evaluate(`window.__beforeReload = true`);
    await site.send("Page.reload");
    await until(`!window.__beforeReload`, "the reload");
    await ready();
  };
  const go = async (hash: string, what: string, ready: string) => {
    await evaluate(`location.hash = ${js(hash)}`);
    await until(ready, what, 15000);
    await sleep(300);
  };
  const toSong = () => go(`#/song/${SONG}`, "the song", `!!document.querySelector("article.sheet") && !!document.querySelector(${js(PILL)})`);
  const toSettings = () => go("#/settings", "Settings", `!!${SETTINGS}?.querySelector("[role=group][aria-label=Sound]")`);
  const sheetOpen = () => evaluate<boolean>(`!!${METRO}`);
  const openSheet = async () => {
    await tapOn(PILL);
    await until(`!!${METRO}`, "the Metronome sheet");
  };
  const closeSheet = async () => {
    await tap("Close", METRO);
    await until(`!${METRO}`, "the Metronome sheet to close");
  };
  const playing = () => evaluate<boolean>(`${METRO}?.querySelector(".metro-pad")?.getAttribute("aria-pressed") === "true"`);
  const setPlaying = async (on: boolean) => {
    const opened = await sheetOpen();
    if (!opened) await openSheet();
    if ((await playing()) !== on) await tap(await evaluate<string>(`${METRO}.querySelector(".metro-pad").textContent.trim()`), METRO);
    await until(`(${METRO}?.querySelector(".metro-pad")?.getAttribute("aria-pressed") === "true") === ${on}`, `the metronome ${on ? "on" : "off"}`);
    if (!opened) await closeSheet();
  };
  const pillText = () => evaluate<string>(`document.querySelector(${js(PILL)})?.textContent.trim() ?? ""`);
  const bpmField = () => evaluate<string>(`${METRO}?.querySelector("input[aria-label='Metronome speed in bpm']")?.value ?? ""`);
  const pressed = (scope: string, group: string) => evaluate<string>(`${scope}?.querySelector('[role=group][aria-label=${js(group)}] [aria-pressed=true]')?.textContent.trim() ?? ""`);
  const choose = (scope: string, group: string, option: "On" | "Off") => tap(option, `${scope}?.querySelector('[role=group][aria-label=${js(group)}]')`);
  const stored = () => evaluate<{ sound?: boolean; indicator?: boolean } | null>(`JSON.parse(localStorage.getItem(${js(PREFS_KEY)}) ?? "null")`);
  const storedPair = async () => {
    const prefs = await stored();
    return { sound: prefs?.sound ?? true, indicator: prefs?.indicator ?? true };
  };
  const beatLabel = () => evaluate<string>(`document.querySelector(${js(BEAT_PILL)})?.getAttribute("aria-label") ?? ""`);
  const beatState = async (): Promise<State | "none"> => {
    const label = await beatLabel();
    const found = (Object.keys(STATES) as State[]).filter((state) => label.startsWith(STATES[state])).sort((a, b) => STATES[b].length - STATES[a].length)[0];
    return found ?? "none";
  };
  /** Over `ms`, the clicks the page started and how the card's beat dot behaved, sampled every frame. */
  const watch = async (ms: number) => {
    const before = await evaluate<number>("window.__clicks");
    const seen = await evaluate<{ flashes: number; frames: number; present: number }>(`new Promise((done) => {
      let flashes = 0, frames = 0, present = 0, last = "none";
      const end = performance.now() + ${ms};
      const tick = () => {
        const dot = document.querySelector("article.sheet .beat-dot");
        const state = dot ? dot.dataset.beat : "none";
        frames += 1;
        if (dot) present += 1;
        if (state === "on" && last !== "on") flashes += 1;
        last = state;
        if (performance.now() < end) requestAnimationFrame(tick);
        else done({ flashes, frames, present });
      };
      tick();
    })`);
    return { clicks: (await evaluate<number>("window.__clicks")) - before, ...seen };
  };
  const color = (expression: string) => evaluate<string>(expression);
  const tokenColor = (token: string) =>
    color(`(() => { const probe = document.createElement("span"); probe.style.background = "var(${token})"; document.body.append(probe); const value = getComputedStyle(probe).backgroundColor; probe.remove(); return value; })()`);
  const dotColor = () => color(`(() => { const dot = document.querySelector("article.sheet .beat-dot"); return dot ? getComputedStyle(dot).backgroundColor : "no dot"; })()`);
  /** Every visible glyph or text around the beat dot: text in the pill's box and any ::before or ::after content. */
  const glyphs = () =>
    evaluate<string[]>(`(() => {
      const pill = document.querySelector(${js(BEAT_PILL)});
      if (!pill) return ["no pill"];
      const box = pill.parentElement;
      const out = [];
      for (const el of [box, ...box.querySelectorAll("*")]) {
        for (const pseudo of ["::before", "::after"]) {
          const style = getComputedStyle(el, pseudo);
          if (style.content && !["none", "normal", '""', "''"].includes(style.content) && style.display !== "none" && style.visibility !== "hidden") out.push(style.content);
        }
      }
      const text = box.textContent.trim();
      if (text) out.push(text);
      return out;
    })()`);
  const width = (pixels: number) => site.send("Emulation.setDeviceMetricsOverride", { width: pixels, height: pixels < 600 ? 844 : 800, deviceScaleFactor: 2, mobile: pixels < 600 });
  const sent = () => evaluate<{ url: string; body: string }[]>("window.__sent");
  return {
    site, evaluate, until, has, tap, tapOn, fresh, reload, go, toSong, toSettings, sheetOpen, openSheet, closeSheet, playing, setPlaying, pillText, bpmField,
    pressed, choose, stored, storedPair, beatLabel, beatState, watch, tokenColor, dotColor, glyphs, width, sent,
  };
}
type Phone = Awaited<ReturnType<typeof phoneOn>>;

const rgb = (css: string) => (css.match(/\d+(\.\d+)?/g) ?? []).map(Number);
/** Red the way a player names it, as `check:beat-red` reads it. */
const isRed = (css: string) => {
  const [r, g, b] = rgb(css);
  return r >= 180 && g <= 80 && b <= 100;
};
const isGreen = (css: string) => {
  const [r, g, b] = rgb(css);
  return g >= 120 && g >= r + 60 && g >= b + 30;
};

let failed = 0;
/** `CASE=<words>` runs only the cases whose name holds them. */
async function check(name: string, run: () => Promise<void>) {
  if (process.env.CASE && !name.includes(process.env.CASE)) return;
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let apiBase = "";
const flags = ["--autoplay-policy=no-user-gesture-required"];
const sites: Site[] = [];
const memberSite = await openSite(root, "check-ux-metronome-sheet", () => apiBase, flags);
sites.push(memberSite);
const origin = memberSite.origin.replace("127.0.0.1", "localhost");
let worker: Awaited<ReturnType<typeof startApi>>["worker"] | null = null;
try {
  const api = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
  worker = api.worker;
  apiBase = api.base;
  const phone = await phoneOn(memberSite, origin);
  await phone.width(390);

  await check("the pill opens the sheet and − + change the bpm", async () => {
    await phone.fresh();
    assert.ok(!(await phone.sheetOpen()), "no sheet before the pill is tapped");
    await phone.openSheet();
    assert.equal(await phone.bpmField(), String(SONG_BPM), "the sheet shows the song's bpm");
    await phone.tap("Faster metronome", METRO);
    assert.equal(await phone.bpmField(), String(SONG_BPM + 1), "+ makes it one faster");
    await phone.tap("Slower metronome", METRO);
    await phone.tap("Slower metronome", METRO);
    assert.equal(await phone.bpmField(), String(SONG_BPM - 1), "− twice makes it one slower than the song");
    await phone.closeSheet();
    await phone.openSheet();
    assert.equal(await phone.bpmField(), String(SONG_BPM - 1), "the sheet opens again on the bpm it set");
    await phone.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    await phone.until(`!${METRO}`, "Escape to close the sheet");
    await phone.openSheet();
    await phone.evaluate(`document.querySelector(".bottom-backdrop").click()`);
    await phone.until(`!${METRO}`, "a tap on the backdrop to close the sheet");
  });

  await check("the pill reads Metronome when off and the bpm when on", async () => {
    await phone.fresh();
    assert.equal(await phone.pillText(), "Metronome", "the pill before the metronome plays");
    await phone.openSheet();
    await phone.setPlaying(true);
    assert.equal(await phone.pillText(), `${SONG_BPM} bpm`, "the pill while it plays, sheet open");
    await phone.tap("Faster metronome", METRO);
    assert.equal(await phone.pillText(), `${SONG_BPM + 1} bpm`, "the pill follows a bpm change");
    await phone.closeSheet();
    assert.equal(await phone.pillText(), `${SONG_BPM + 1} bpm`, "the pill while it plays, sheet closed");
    await phone.setPlaying(false);
    assert.equal(await phone.pillText(), "Metronome", "the pill once it stops");
  });

  await check("the dot keeps beating on the card with the sheet closed", async () => {
    await phone.fresh();
    assert.ok(!(await phone.evaluate<boolean>(`!!document.querySelector("article.sheet .metronome, article.sheet .metro-pad")`)), "the paper card has no metronome block");
    await phone.setPlaying(true);
    assert.ok(!(await phone.sheetOpen()), "the sheet is closed");
    const seen = await phone.watch(2000);
    assert.ok(seen.present === seen.frames, `the beat dot is on the card every frame (${seen.present} of ${seen.frames})`);
    assert.ok(seen.flashes >= 2, `the dot flashes with the beat (${seen.flashes} flashes in 2 s at ${SONG_BPM} bpm)`);
    assert.ok(seen.clicks >= 2, `the click keeps going (${seen.clicks})`);
  });

  await check("Settings Sound and Dot, the sheet, and the tappable pill around the beat dot read and write the same two settings", async () => {
    await phone.fresh("#/settings");
    await phone.choose(SETTINGS, "Sound", "Off");
    await phone.toSong();
    await phone.openSheet();
    assert.equal(await phone.pressed(METRO, "Sound"), "Off", "Sound off in Settings shows Off in the sheet");
    assert.equal(await phone.pressed(METRO, "Dot"), "On", "Dot on in Settings shows On in the sheet");
    await phone.setPlaying(true);
    await phone.closeSheet();
    assert.equal(await phone.beatState(), "dot", `the pill shows Dot only (${await phone.beatLabel()})`);
    await phone.tapOn(BEAT_PILL);
    assert.equal(await phone.beatState(), "off", `a tap on the pill moves on to No sound or dot (${await phone.beatLabel()})`);
    await phone.openSheet();
    assert.equal(await phone.pressed(METRO, "Dot"), "Off", "the pill's tap turned Dot off in the sheet");
    await phone.choose(METRO, "Sound", "On");
    await phone.closeSheet();
    assert.equal(await phone.beatState(), "sound", `Sound on in the sheet shows Sound only on the pill (${await phone.beatLabel()})`);
    await phone.toSettings();
    assert.equal(await phone.pressed(SETTINGS, "Sound"), "On", "Settings shows the sheet's Sound on");
    assert.equal(await phone.pressed(SETTINGS, "Dot"), "Off", "Settings shows the pill's Dot off");
    assert.deepEqual(await phone.storedPair(), PREFS.sound, "one pair of settings is stored");
  });

  await check("the sheet's buttons are 48 px", async () => {
    for (const pixels of [390, 1280]) {
      await phone.width(pixels);
      await phone.fresh(`#/song/${SONG}`, `localStorage.setItem(${js(PREFS_KEY)}, ${js(js({ syncMode: "on" }))})`);
      await phone.openSheet();
      const buttons = await phone.evaluate<{ name: string; w: number; h: number }[]>(
        `[...${METRO}.querySelectorAll("button")].filter((b) => b.getClientRects().length).map((b) => ({ name: b.getAttribute("aria-label") || b.textContent.trim(), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height }))`,
      );
      const names = buttons.map((b) => b.name);
      for (const want of ["Close", "Slower metronome", "Faster metronome", "Dot earlier", "Dot later"]) assert.ok(names.includes(want), `the sheet at ${pixels} px has ${want} (${js(names)})`);
      const small = buttons.filter((b) => b.w < 47.5 || b.h < 47.5);
      assert.deepEqual(small, [], `every button in the sheet is at least 48 by 48 px at ${pixels} px`);
    }
    await phone.width(390);
  });

  await check("at 1280 px the bpm field is compact with bpm beside it", async () => {
    await phone.width(1280);
    await phone.fresh();
    await phone.openSheet();
    const field = await phone.evaluate<{ input: number; right: number; unit: number | null }>(`(() => {
      const input = ${METRO}.querySelector("input[aria-label='Metronome speed in bpm']").getBoundingClientRect();
      const unit = [...${METRO}.querySelectorAll("*")].find((el) => !el.children.length && el.textContent.trim() === "bpm")?.getBoundingClientRect();
      return { input: input.width, right: input.right, unit: unit ? unit.left : null };
    })()`);
    assert.ok(field.input <= 120, `the bpm field is ${field.input.toFixed(0)} px wide, not a wide box`);
    assert.ok(field.unit !== null && field.unit - field.right >= 0 && field.unit - field.right <= 12, `"bpm" sits right after the field (${js(field)})`);
    await phone.width(390);
  });

  const batteryPhone = async (level: number | null, theme = "stage") => {
    await phone.fresh(`#/song/${SONG}`, `${level === null ? "" : `sessionStorage.setItem("__battery", ${js(String(level))});`} localStorage.setItem("leadSheetsTheme", ${js(theme)})`);
    await phone.setPlaying(true);
    await phone.until(`!!document.querySelector("article.sheet .beat-dot")`, "the beat dot");
    await sleep(300);
  };

  await check("with a stubbed battery at 0.5 the dot is the ok color, at 0.2 the low color, at 0.21 the ok color", async () => {
    const seen: Record<string, string> = {};
    for (const level of [0.5, 0.2, 0.21]) {
      await batteryPhone(level);
      seen[level] = await phone.dotColor();
      const want = await phone.tokenColor(level <= 0.2 ? "--battery-low" : "--battery-ok");
      assert.equal(seen[level], want, `at ${level} the dot is ${level <= 0.2 ? "--battery-low" : "--battery-ok"}`);
    }
    assert.ok(isGreen(seen[0.5]), `the ok color is green (${seen[0.5]})`);
    assert.ok(isRed(seen[0.2]), `the low color is red (${seen[0.2]})`);
  });

  await check("with no getBattery the dot is its normal color and no glyph or text appears", async () => {
    await batteryPhone(null);
    assert.ok(!(await phone.evaluate<boolean>(`"getBattery" in navigator`)), "setup: this phone has no getBattery, like an iPhone");
    const dot = await phone.dotColor();
    assert.ok(isRed(dot), `the dot is its normal red (${dot})`);
    assert.notEqual(dot, await phone.tokenColor("--battery-ok"), "the dot is not the ok color");
    assert.deepEqual(await phone.glyphs(), [], "nothing but the dot and the pill's icon shows");
    assert.ok(!/unknown|battery/i.test(await phone.evaluate<string>(`document.body.innerText + " " + document.querySelector(${js(BEAT_PILL)}).getAttribute("aria-label")`)), "nothing says the battery is unknown");
    assert.deepEqual(await phone.evaluate<string[]>("window.__errors ?? []"), [], "no page errors");
  });

  await check("a levelchange from 0.3 to 0.15 flips the dot without a reload", async () => {
    await batteryPhone(0.3);
    assert.equal(await phone.dotColor(), await phone.tokenColor("--battery-ok"), "at 0.3 the dot is the ok color");
    await phone.evaluate(`window.__noReload = true; window.__setBattery(0.15)`);
    await phone.until(`getComputedStyle(document.querySelector("article.sheet .beat-dot")).backgroundColor === ${js(await phone.tokenColor("--battery-low"))}`, "the dot to turn the low color");
    assert.ok(await phone.evaluate<boolean>("window.__noReload === true"), "the page did not reload");
    await phone.evaluate(`window.__setBattery(0.6)`);
    await phone.until(`getComputedStyle(document.querySelector("article.sheet .beat-dot")).backgroundColor === ${js(await phone.tokenColor("--battery-ok"))}`, "the dot to turn back once charged");
  });

  await check("in each of cb-rg, cb-by and contrast the low state shows the glyph and in stage and day it does not", async () => {
    for (const theme of ["cb-rg", "cb-by", "contrast", "stage", "day"]) {
      await batteryPhone(0.15, theme);
      const marked = await phone.glyphs();
      if (theme === "stage" || theme === "day") assert.deepEqual(marked, [], `no glyph in ${theme}`);
      else {
        assert.equal(marked.length, 1, `one glyph beside the low dot in ${theme} (${js(marked)})`);
        assert.equal(marked[0], await phone.evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue("--battery-low-mark").trim()`), `the ${theme} glyph is --battery-low-mark`);
      }
    }
    await batteryPhone(0.5, "cb-rg");
    assert.deepEqual(await phone.glyphs(), [], "no glyph at an ok level in cb-rg");
  });

  await check("at 390 px nothing the beat pill paints covers the title or any chart text, and it stays a 48 px tap target", async () => {
    await phone.width(390);
    for (const [level, theme] of [[null, "stage"], [0.15, "cb-rg"]] as const) {
      await batteryPhone(level, theme);
      for (const scrollTop of [0, 600, 1200, 1800, 2400]) {
        await phone.evaluate(`document.getElementById("sheet-scroll").scrollTop = ${scrollTop}`);
        await sleep(400);
        const seen = await phone.evaluate<{ hit: { w: number; h: number; r: number; tappable: boolean }; covered: string[]; contrast: number }>(`(() => {
          const pill = document.querySelector(${js(BEAT_PILL)});
          const filled = (style) => !/rgba\\(.*, 0\\)|transparent/.test(style.backgroundColor);
          const shows = (style) => filled(style) || parseFloat(style.borderTopWidth) > 0 || style.boxShadow !== "none";
          const backdrop = (el) => { while (el && !filled(getComputedStyle(el))) el = el.parentElement; return el ? getComputedStyle(el).backgroundColor : "rgb(255, 255, 255)"; };
          const painted = [...(shows(getComputedStyle(pill)) ? [pill] : []), ...pill.querySelectorAll("*")].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
          const covered = [];
          const walker = document.createTreeWalker(document.querySelector("article.sheet"), NodeFilter.SHOW_TEXT);
          for (let node; (node = walker.nextNode()); ) {
            if (!node.nodeValue.trim() || node.parentElement.closest(".beat-rail")) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const t of range.getClientRects()) {
              if (painted.some((p) => t.left < p.right && t.right > p.left && t.top < p.bottom && t.bottom > p.top)) covered.push(node.nodeValue.trim().slice(-16) + " (" + node.parentElement.className + ")");
            }
          }
          const lum = (css) => { const [r, g, b] = css.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
          const icon = pill.querySelector("svg");
          const [a, b] = [lum(getComputedStyle(icon).color), lum(backdrop(icon))].sort((x, y) => y - x);
          const box = pill.getBoundingClientRect();
          return { hit: { w: box.width, h: box.height, r: box.right, tappable: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest(".beat-pill") === pill }, covered, contrast: (a + 0.05) / (b + 0.05) };
        })()`);
        assert.deepEqual(seen.covered, [], `${theme}, scrolled to ${scrollTop}: the pill paints over no text (${js(seen.covered)})`);
        assert.ok(seen.hit.w >= 47.5 && seen.hit.h >= 47.5 && seen.hit.r <= 390 && seen.hit.tappable, `${theme}, scrolled to ${scrollTop}: the pill is still a 48 px tap target inside the screen (${js(seen.hit)})`);
        assert.ok(seen.contrast >= 3, `${theme}: the speaker icon reads against what is behind it (contrast ${seen.contrast.toFixed(2)})`);
      }
    }
  });

  await check("the bpm the sheet sets is part of the song's draft", async () => {
    await phone.fresh();
    assert.ok(!(await phone.has("Save", HEADER)), "no Save before a change");
    await phone.openSheet();
    await phone.tap("Faster metronome", METRO);
    await phone.closeSheet();
    assert.ok((await phone.has("Save", HEADER)) && (await phone.has("Revert", HEADER)), "Save and Revert appear after the sheet's +");
    await phone.reload();
    await phone.openSheet();
    assert.equal(await phone.bpmField(), String(SONG_BPM + 1), "the draft bpm is back after a reload");
    await phone.closeSheet();
    assert.ok(await phone.has("Save", HEADER), "Save still shows after the reload");
    await phone.tap("Revert", HEADER);
    await phone.openSheet();
    assert.equal(await phone.bpmField(), String(SONG_BPM), "Revert puts the song's bpm back");
    await phone.closeSheet();
    assert.ok(!(await phone.has("Save", HEADER)), "Save goes away after Revert");
  });

  await check("with Song info closed, the chart's first chord and the card's blocks sit exactly at their pinned places", async () => {
    type Card = { x: number; y: number; row: Row; lines: number; tops: Record<string, number>; lefts: Record<string, number>; folded: Record<string, boolean>; closed: { info: number; row: number } };
    const measure = () =>
      phone.evaluate<Card>(`(() => {
        const sheet = document.querySelector("article.sheet").getBoundingClientRect();
        const chords = document.querySelector(".chart .pair .chords");
        const lyrics = document.querySelector(".chart .pair .lyrics");
        const range = (node, from, to) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return r.getBoundingClientRect(); };
        const text = chords.textContent;
        const lyric = lyrics.textContent;
        const left = lyrics.getBoundingClientRect().left;
        const advance = range(lyrics.firstChild, 0, lyric.length).width / lyric.length;
        const at = [...text.matchAll(/\\S+/g)].map((chord) => Math.round((range(chords.firstChild, chord.index, chord.index + 1).left - left) / advance));
        const glyph = range(chords.firstChild, text.search(/\\S/), text.search(/\\S/) + 1);
        const title = document.createRange();
        title.selectNodeContents(document.querySelector("article.sheet > .sheet-title"));
        const lines = new Set([...title.getClientRects()].map((r) => Math.round(r.bottom))).size;
        const tops = {}, lefts = {}, folded = {};
        for (const selector of ${js([...Object.keys(stack(0, 1).tops), ...IN_SONG_INFO])}) {
          const el = document.querySelector("article.sheet > " + selector) ?? document.querySelector("article.sheet > .song-info > .song-info-panel > " + selector);
          folded[selector] = !!el.closest(".song-info-panel") && el.getClientRects().length === 0;
          if (folded[selector]) continue;
          const box = el.getBoundingClientRect();
          tops[selector] = box.top - sheet.top;
          lefts[selector] = box.left - sheet.left;
        }
        const info = document.querySelector("article.sheet > .song-info");
        const closed = { info: info.getBoundingClientRect().height, row: info.querySelector(".song-info-row").getBoundingClientRect().height };
        return { x: glyph.left - sheet.left, y: glyph.top - sheet.top, row: { chords: text, lyrics: lyric, at }, lines, tops, lefts, folded, closed };
      })()`);
    const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
    const xs: [number, number][] = [];
    for (const pixels of [390, 1280]) {
      await phone.width(pixels);
      await phone.fresh();
      const pin = CARD[pixels];
      const want = stack(pin.top, pin.titleLines);
      const card = await measure();
      console.log(`note at ${pixels} px: first chord x ${card.x.toFixed(2)} y ${card.y.toFixed(2)}, title lines ${card.lines}, tops ${js(card.tops)}`);
      xs.push([pixels, card.x]);
      assert.equal(card.lines, pin.titleLines, `at ${pixels} px the title wraps to ${pin.titleLines} lines, as on the base's Linux run`);
      assert.ok(near(card.y, want.chord), `at ${pixels} px the first chord sits at y ${want.chord.toFixed(2)} (now ${card.y.toFixed(2)})`);
      for (const [selector, top] of Object.entries(want.tops)) assert.ok(near(card.tops[selector], top), `at ${pixels} px ${selector} sits at ${top.toFixed(2)} (now ${card.tops[selector]?.toFixed(2)})`);
      assert.ok(near(card.closed.info, card.closed.row) && near(card.closed.row, ROW_TAP), `at ${pixels} px the closed Song info is exactly its row, and the row is the brief's ${ROW_TAP} px tap height (block ${card.closed.info.toFixed(2)}, row ${card.closed.row.toFixed(2)})`);
      for (const selector of IN_SONG_INFO) assert.ok(card.folded[selector], `at ${pixels} px ${selector} is inside the closed Song info panel and not laid out`);
      for (const [selector, left] of Object.entries(card.lefts)) assert.ok(near(left, pin.left), `at ${pixels} px ${selector} keeps its left edge (${left.toFixed(2)})`);
      const line = seed.songs.find((song) => song.id === SONG)!.body.flatMap((section) => section.lines).find((each) => each.chords !== undefined && each.lyrics !== undefined)!;
      assert.equal(chordAnchors([card.row])[0], chordAnchors([{ chords: line.chords!, lyrics: line.lyrics }])[0], `at ${pixels} px the first chord stays on its syllable`);
      const chordAndInfo = `(() => {
        const sheet = document.querySelector("article.sheet").getBoundingClientRect();
        const chords = document.querySelector(".chart .pair .chords");
        const r = document.createRange();
        r.setStart(chords.firstChild, chords.textContent.search(/\\S/));
        r.setEnd(chords.firstChild, chords.textContent.search(/\\S/) + 1);
        return { y: r.getBoundingClientRect().top - sheet.top, info: document.querySelector("article.sheet > .song-info").getBoundingClientRect().height };
      })()`;
      const toggle = async () => {
        await phone.evaluate(`document.querySelector("article.sheet > .song-info > .song-info-row").click()`);
        await sleep(150);
      };
      const shut = await phone.evaluate<{ y: number; info: number }>(chordAndInfo);
      await toggle();
      const open = await phone.evaluate<{ y: number; info: number }>(chordAndInfo);
      await toggle();
      const again = await phone.evaluate<{ y: number; info: number }>(chordAndInfo);
      assert.ok(open.info > shut.info + 0.5 && near(open.y - shut.y, open.info - shut.info), `at ${pixels} px opening Song info moves the first chord down by exactly what the panel adds (chord ${(open.y - shut.y).toFixed(2)}, panel ${(open.info - shut.info).toFixed(2)})`);
      assert.ok(near(again.y, shut.y) && near(again.y, card.y), `at ${pixels} px closing Song info puts the first chord back (${again.y.toFixed(2)}, closed ${shut.y.toFixed(2)})`);

      await phone.evaluate(`(() => { const style = document.createElement("style"); style.textContent = ".sheet, .sheet * { font-family: serif !important; }"; document.head.append(style); return document.fonts.ready.then(() => true); })()`);
      await sleep(300);
      const serif = await measure();
      const drawn = stack(pin.top, serif.lines);
      console.log(`note at ${pixels} px in serif: title lines ${serif.lines}, tops ${js(serif.tops)}`);
      for (const [selector, top] of Object.entries(drawn.tops)) assert.ok(near(serif.tops[selector], top), `at ${pixels} px in serif ${selector} still sits at ${top.toFixed(2)} for ${serif.lines} title lines (now ${serif.tops[selector]?.toFixed(2)})`);
    }
    await phone.width(390);
    for (const [pixels, x] of xs) assert.ok(near(x, CARD[pixels].x), `at ${pixels} px the first chord keeps its x (${x.toFixed(2)}, base ${CARD[pixels].x})`);
  });

  await check("Settings has separate Sound and Dot toggles, and both can be off", async () => {
    await phone.fresh("#/settings");
    for (const group of ["Sound", "Dot"]) {
      const options = await phone.evaluate<string[]>(`[...${SETTINGS}.querySelectorAll('[role=group][aria-label=${group}] button')].map((b) => b.textContent.trim())`);
      assert.deepEqual(options, ["On", "Off"], `Settings has a ${group} toggle with On and Off`);
      assert.equal(await phone.pressed(SETTINGS, group), "On", `${group} starts on`);
    }
    assert.ok(!/Out loud|Dot only/.test(await phone.evaluate<string>(`${SETTINGS}.textContent`)), "the old Click row is gone");
    await phone.choose(SETTINGS, "Sound", "Off");
    assert.equal(await phone.pressed(SETTINGS, "Dot"), "On", "Sound off leaves Dot on");
    await phone.choose(SETTINGS, "Dot", "Off");
    assert.equal(await phone.pressed(SETTINGS, "Sound"), "Off", "Dot off leaves Sound off");
    assert.equal(await phone.pressed(SETTINGS, "Dot"), "Off", "both can be off");
    await phone.reload();
    assert.equal(await phone.pressed(SETTINGS, "Sound"), "Off", "Sound off is kept");
    assert.equal(await phone.pressed(SETTINGS, "Dot"), "Off", "Dot off is kept");
  });

  await check("Sound off and Dot on shows the beat dot with no click; Sound on and Dot off plays the click with no beat dot; both off leaves no click and no beat dot", async () => {
    const run = async (state: State) => {
      await phone.fresh(`#/song/${SONG}`, `localStorage.setItem(${js(PREFS_KEY)}, ${js(js(PREFS[state]))})`);
      await phone.setPlaying(true);
      await sleep(300);
      return { ...(await phone.watch(2000)), pill: await phone.beatState() };
    };
    const both = await run("both");
    assert.ok(both.clicks >= 2 && both.flashes >= 2, `setup: both on clicks and flashes (${js(both)})`);
    const dot = await run("dot");
    assert.ok(dot.clicks === 0 && dot.flashes >= 2, `Sound off, Dot on: the dot beats with no click (${js(dot)})`);
    const sound = await run("sound");
    assert.ok(sound.clicks >= 2 && sound.present === 0, `Sound on, Dot off: the click plays with no beat dot (${js(sound)})`);
    const off = await run("off");
    assert.ok(off.clicks === 0 && off.present === 0, `both off: no click and no beat dot (${js(off)})`);
    assert.equal(off.pill, "off", "with both off the pill is still there to tap");
  });

  await check("tapping the pill around the metronome dot advances from the current state through both on, then sound only, then dot only, then both off, then back to both on", async () => {
    await phone.fresh();
    await phone.setPlaying(true);
    const order: State[] = ["both", "sound", "dot", "off", "both"];
    for (const [index, state] of order.entries()) {
      if (index > 0) await phone.tapOn(BEAT_PILL);
      assert.equal(await phone.beatState(), state, `tap ${index}: the pill shows ${STATES[state]} (${await phone.beatLabel()})`);
      assert.deepEqual(await phone.storedPair(), PREFS[state], `tap ${index}: the stored settings are ${STATES[state]}`);
      assert.equal(await phone.evaluate<boolean>(`!!document.querySelector("article.sheet .beat-dot")`), PREFS[state].indicator, `tap ${index}: the beat dot shows only with Dot on`);
    }
    await phone.fresh("#/settings");
    await phone.choose(SETTINGS, "Dot", "Off");
    await phone.toSong();
    await phone.setPlaying(true);
    assert.equal(await phone.beatState(), "sound", "Settings' Sound only is the pill's state");
    await phone.tapOn(BEAT_PILL);
    assert.equal(await phone.beatState(), "dot", "a tap moves on from the saved Sound only to Dot only, not from both on");
  });

  await check("in Band mode, a member turning Sound off while the leader has Sound on changes nothing on the leader's phone or on any other member's phone", async () => {
    const leaderSite = await openSite(root, "check-ux-metronome-sheet-leader", undefined, flags);
    sites.push(leaderSite);
    const leader = await phoneOn(leaderSite, origin);
    const phones: [string, Phone, Site][] = [
      ["Lee Leader", leader, leaderSite],
      ["Mo Member", phone, memberSite],
    ];
    for (const [name, each, site] of phones) {
      await site.send("Page.navigate", { url: `${origin}/#/songs` });
      await each.until(`document.readyState === "complete"`, "the page");
      await each.evaluate(`localStorage.clear(); sessionStorage.clear(); 0`);
      await site.send("Page.reload");
      const app = await appPage(site);
      await app.library();
      await app.signUp(name);
    }
    const call = (who: Phone, path: string, body: object) =>
      who.evaluate<{ status: number; body: Record<string, any> }>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
    const made = await call(leader, "/api/bands/create", { name: "The Blue Notes" });
    assert.equal(made.status, 200, `the leader makes a band (${js(made.body)})`);
    const bandId = made.body.bandId as string;
    const { id: _id, ...content } = seed.songs.find((song) => song.id === SONG)!;
    const shared = await call(leader, "/api/bands/library/share-song", { bandId, song: content, choice: "public", localId: null });
    assert.equal(shared.status, 200, `the leader shares the song into the band (${js(shared.body)})`);
    const invite = (await call(leader, "/api/codes", { kind: "band", bandId })).body.code as string;
    assert.equal((await call(phone, "/api/bands/join", { code: invite })).status, 200, "the member joins");
    const bandSong = `#/band/${bandId}/song/${shared.body.songId}`;
    const onBandSong = async (who: Phone) => {
      await who.go(`#/band/${bandId}`, "the band page", `!!document.querySelector(${js(`.band-page[data-band="${bandId}"]`)}) && !document.querySelector(".band-page").textContent.includes("Loading")`);
      await who.go(bandSong, "the band song", `!!document.querySelector("article.sheet") && !!document.querySelector(${js(PILL)})`);
    };
    for (const who of [leader, phone]) {
      await onBandSong(who);
      await who.setPlaying(true);
      assert.equal(await who.beatState(), "both", "each phone starts with sound and dot");
    }

    const memberSentBefore = (await phone.sent()).length;
    const leaderBefore = await leader.storedPair();
    await phone.toSettings();
    await phone.choose(SETTINGS, "Sound", "Off");
    await onBandSong(phone);
    await phone.setPlaying(true);
    assert.equal(await phone.beatState(), "dot", "the member's Settings Sound off shows on the member's pill in Band mode");
    await phone.tapOn(BEAT_PILL);
    assert.equal(await phone.beatState(), "off", "the member's pill cycles in Band mode as it does alone");
    await phone.openSheet();
    await phone.choose(METRO, "Dot", "On");
    await phone.closeSheet();
    assert.deepEqual(await phone.storedPair(), PREFS.dot, "the member's phone keeps the member's own settings");

    const leaderNow = await leader.watch(2000);
    assert.deepEqual(await leader.storedPair(), leaderBefore, "the leader's stored Sound and Dot did not change");
    assert.equal(await leader.beatState(), "both", "the leader's pill still shows Sound and dot");
    assert.ok(leaderNow.clicks >= 2 && leaderNow.flashes >= 2, `the leader's click and dot keep going (${js(leaderNow)})`);

    const carried = (await phone.sent()).slice(memberSentBefore).filter((each) => /sound|indicator|leadSheetsMetronome/i.test(each.body));
    assert.deepEqual(carried, [], "no request from the member's phone carries Sound or Dot, so no band, gig or other member's phone can get them");

    const memberBefore = await phone.storedPair();
    const leaderSentBefore = (await leader.sent()).length;
    await leader.openSheet();
    await leader.tap("Faster metronome", METRO);
    await leader.choose(METRO, "Dot", "Off");
    await leader.closeSheet();
    await leader.tapOn(BEAT_PILL);
    assert.equal(await leader.beatState(), "dot", "the leader's own pill cycles");
    await sleep(1000);
    assert.deepEqual(await phone.storedPair(), memberBefore, "the leader's tempo, Dot and pill taps leave the member's settings alone");
    assert.equal(await phone.beatState(), "dot", "the member's pill still shows the member's Dot only");
    const leaderCarried = (await leader.sent()).slice(leaderSentBefore).filter((each) => /sound|indicator|leadSheetsMetronome/i.test(each.body));
    assert.deepEqual(leaderCarried, [], "no request from the leader's phone carries Sound or Dot");
  });
} finally {
  for (const site of sites) await site.close();
  await worker?.dispose();
}

console.log(failed ? `check:ux-metronome-sheet: ${failed} failed` : "check:ux-metronome-sheet passed");
process.exit(failed ? 1 : 0);
