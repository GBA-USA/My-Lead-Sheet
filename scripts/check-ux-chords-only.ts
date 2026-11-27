import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { LibraryFile, Song } from "../src/types.ts";
import type { ScrollVersions, StoredVersion } from "../src/storage.ts";
import { chordAnchors, type Row } from "./chord-anchors.ts";
import { openSite } from "./chrome.ts";

/** The last build before Chords only. Its version check drops a version whose notation it does not know. */
const OLDER_BUILD = "d15d5d3f47af3490121b62fe2eecc79ba700fa62";
const FIRE_AWAY = 1;
const NO_HALF_STEPPIN = 13;
const SCALE_15 = 4;
const FPS = 60;
const SWITCH = `document.querySelector("[role=group][aria-label='Notes or Nashville']")`;

const root = new URL("..", import.meta.url).pathname;
const seed = JSON.parse(readFileSync(join(root, "data/library.json"), "utf8")) as LibraryFile;
const fireAway = seed.songs.find((song) => song.id === FIRE_AWAY)!;
const js = (value: unknown) => JSON.stringify(value);

let failures = 0;
async function test(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${(error as Error).message}`);
  }
}
function expect(ok: boolean, message: string) {
  if (!ok) throw new Error(message);
}

/** Animation frames and performance.now move only when the check steps them, so the song's clock is exact. */
const STAND_INS = `(() => {
  window.__errors = [];
  addEventListener("error", (event) => window.__errors.push(String(event.message)));
  addEventListener("unhandledrejection", (event) => window.__errors.push(String(event.reason)));
  let now = 0;
  let next = 0;
  const frames = new Map();
  Object.defineProperty(performance, "now", { value: () => now });
  window.requestAnimationFrame = (run) => (frames.set(++next, run), next);
  window.cancelAnimationFrame = (id) => frames.delete(id);
  window.__frames = (count) => {
    for (let i = 0; i < count; i++) {
      now += 1000 / ${FPS};
      const due = [...frames.values()];
      frames.clear();
      for (const run of due) run(now);
    }
  };
})()`;

/**
 * Every chord on the chart as drawn: its text, section, row, where it is on screen, and whether the player can see
 * it. Read from the page's text, so it does not care how a chord is wrapped in elements.
 */
const CHORDS = `(() => {
  const chart = document.getElementById("chord-section");
  const sections = [...chart.querySelectorAll(".chart-section")];
  const rows = [...chart.querySelectorAll(".chords, .bars")].filter((row) => row.getClientRects().length > 0);
  const out = [];
  rows.forEach((row, r) => {
    const section = sections.findIndex((each) => each.contains(row));
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode()); ) {
      for (const match of node.textContent.matchAll(/[^\\s|]+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const box = range.getBoundingClientRect();
        const points = [[0.5, 0.5], [0.05, 0.1], [0.95, 0.1], [0.05, 0.9], [0.95, 0.9]].map(([x, y]) => document.elementFromPoint(box.left + box.width * x, box.top + box.height * y));
        out.push({ text: match[0], section, row: r, x: box.left, y: box.top, w: box.width, h: box.height, visible: points.every((hit) => !!hit && row.contains(hit)) });
      }
    }
  });
  return out;
})()`;

/** Where the timed scroll is: its progress through the chord section, that progress as a height down the chart, and each chord row's slot. */
const SCROLL = `(() => {
  const el = document.getElementById("sheet-scroll");
  const chart = document.getElementById("chord-section");
  const top = chart.getBoundingClientRect().top;
  const origin = el.getBoundingClientRect().top - el.scrollTop;
  const start = top - origin;
  const end = start + chart.offsetHeight - el.clientHeight;
  const sections = [...chart.querySelectorAll(".chart-section")];
  const rows = [...chart.querySelectorAll(".chords, .bars")].filter((row) => row.getClientRects().length > 0);
  const firsts = new Set(sections.map((section) => rows.find((row) => section.contains(row))).filter(Boolean));
  const starts = rows.map((row) => (firsts.has(row) ? row.closest(".chart-section").getBoundingClientRect().top : row.getBoundingClientRect().top) - top);
  const progress = end > start ? (el.scrollTop - start) / (end - start) : null;
  return { scrollTop: el.scrollTop, progress, at: progress === null ? null : progress * chart.offsetHeight, slots: starts.map((from, i) => [from, starts[i + 1] ?? chart.offsetHeight]) };
})()`;

interface Chord {
  text: string;
  section: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
  /** Share of the chord's inked columns painted in a color other than the chord's own, or null when not visible. */
  filled: number | null;
  /** Whether every column in the fill color sits left of every column in the chord's own color. */
  leftToRight: boolean;
}

type Rgb = [number, number, number];

const site = await openSite(root, "check-ux-chords-only");
const { send, evaluate } = site;
const pause = (ms: number) => evaluate(`new Promise((resolve) => setTimeout(resolve, ${ms}))`);
const until = async (expression: string, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (await evaluate<boolean>(expression)) return;
    await pause(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const tap = async (text: string, scope = "document") => {
  const found = await evaluate<boolean>(`(() => {
    const button = [...(${scope}?.querySelectorAll("button") ?? [])].find((each) => each.textContent.trim() === ${js(text)} && !each.disabled);
    button?.click();
    return !!button;
  })()`);
  expect(found, `a ${text} button to tap`);
  await pause(80);
};
const pressed = () => evaluate<string[]>(`[...(${SWITCH}?.querySelectorAll("button[aria-pressed=true]") ?? [])].map((b) => b.textContent.trim())`);
const frames = async (seconds: number) => {
  await evaluate(`window.__frames(${Math.round(seconds * FPS)})`);
  await pause(60);
};
const play = async () => {
  await evaluate(`document.querySelector(".scroll-pill").click()`);
  await pause(80);
};

let loads = 0;
async function phone(width: number, height = 844) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
}
/** Opens `hash` fresh after `setup` runs on the page's storage, at text size x1.5. `setup` can read the library the app stored as `library`. */
async function open(hash: string, setup = "", ready = `!!document.querySelector("#chord-section .chart-heading")`) {
  await send("Page.navigate", { url: `${site.origin}/?load=${(loads += 1)}#/songs` });
  await until(`document.readyState === "complete"`, "the app");
  await evaluate(`(() => { const library = localStorage.getItem("leadSheetsLibraryV2"); localStorage.clear(); ${setup}; localStorage.setItem("leadSheetsTextScale", "${SCALE_15}"); })()`);
  await send("Page.navigate", { url: `${site.origin}/?load=${(loads += 1)}${hash}` });
  await until(ready, hash);
  await evaluate(`document.fonts.ready.then(() => true)`);
  await pause(150);
}
const versions = (songId: number, value: ScrollVersions) => `localStorage.setItem("leadSheetsScrollVersions.${songId}", ${js(js(value))})`;

let base: Rgb | null = null;
/** The color Notes draws chords in, read once from the page. */
async function chordColor(): Promise<Rgb> {
  const color = await evaluate<string>(`getComputedStyle(document.querySelector("#chord-section .chords")).color`);
  const parts = color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  return [parts[0], parts[1], parts[2]];
}

/**
 * Every chord with how much of it is filled, read from a screenshot: within a chord's box, a strongly inked pixel
 * either lies on the blend of the chord color Notes uses with the paper, or is the fill. A column counts as the color
 * most of its ink has.
 */
async function look(): Promise<Chord[]> {
  const chords = await evaluate<Omit<Chord, "filled" | "leftToRight">[]>(CHORDS);
  const view = await evaluate<{ x: number; y: number; width: number; height: number }>(
    `(() => { const r = document.getElementById("sheet-scroll").getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: Math.min(r.height, innerHeight - r.top) }; })()`,
  );
  const shot = await send("Page.captureScreenshot", { format: "png", clip: { ...view, scale: 1 } });
  return evaluate<Chord[]>(`(async () => {
    const chords = ${js(chords)};
    const view = ${js(view)};
    const base = ${js(base)};
    const img = new Image();
    img.src = "data:image/png;base64,${shot.data}";
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const scale = img.width / view.width;
    const { data, width } = ctx.getImageData(0, 0, img.width, img.height);
    const at = (x, y) => { const i = (y * width + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
    const far = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const offBlend = (p, a, b) => {
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / (d[0] ** 2 + d[1] ** 2 + d[2] ** 2)));
      return far(p, [a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]]);
    };
    return chords.map((chord) => {
      if (!chord.visible) return { ...chord, filled: null, leftToRight: true };
      const x0 = Math.max(2, Math.ceil((chord.x - view.x) * scale)), x1 = Math.min(img.width, Math.floor((chord.x + chord.w - view.x) * scale));
      const y0 = Math.max(0, Math.ceil((chord.y - view.y) * scale)), y1 = Math.min(img.height, Math.floor((chord.y + chord.h - view.y) * scale));
      const paper = at(Math.max(0, x0 - 2), y0);
      const ink = far(base, paper);
      const columns = [];
      for (let x = x0; x < x1; x++) {
        let own = 0, fill = 0;
        for (let y = y0; y < y1; y++) {
          const pixel = at(x, y);
          if (far(pixel, paper) < 0.6 * ink) continue;
          if (offBlend(pixel, base, paper) < 0.15 * ink) own += 1;
          else fill += 1;
        }
        if (own + fill > 0) columns.push(fill > own ? "fill" : "own");
      }
      const fills = columns.filter((c) => c === "fill").length;
      const lastFill = columns.lastIndexOf("fill");
      const firstOwn = columns.indexOf("own");
      return { ...chord, filled: columns.length ? fills / columns.length : 0, leftToRight: lastFill < 0 || firstOwn < 0 || lastFill <= firstOwn + 1 };
    });
  })()`);
}

const FULL = 0.95;
const EMPTY = 0.05;
const shown = (chords: Chord[]) => chords.filter((chord) => chord.filled !== null);
/** How far through the chart the fill is: the first visible chord not yet full, plus its share. */
function position(chords: Chord[]): { index: number; share: number } {
  const index = chords.findIndex((chord) => chord.filled !== null && chord.filled < FULL);
  return { index, share: index < 0 ? 1 : chords[index].filled! };
}
const describe = (chords: Chord[]) => shown(chords).map((chord) => `${chord.text}:${chord.filled!.toFixed(2)}`).join(" ");

/** Full chords, then at most one partly filled, then empty ones, among the chords on screen. */
function inOrder(chords: Chord[]): boolean {
  const states = shown(chords).map((chord) => (chord.filled! >= FULL ? "F" : chord.filled! <= EMPTY ? "E" : "P")).join("");
  return /^F*P?E*$/.test(states);
}

/** The chart's lyric rows, its chords in order, and all its text outside performance notes, which may quote a lyric. */
async function lyricsAndChords(): Promise<{ lyrics: string[]; chords: string[]; chartText: string }> {
  return evaluate(`(() => {
    const chart = document.getElementById("chord-section");
    const lyrics = [...chart.querySelectorAll(".lyrics, .lyric-only")].filter((el) => el.getClientRects().length > 0).map((el) => el.textContent.trim()).filter((text) => text.length > 3);
    const chords = [...chart.querySelectorAll(".chords, .bars")].filter((el) => el.getClientRects().length > 0).flatMap((el) => el.textContent.match(/[^\\s|]+/g) ?? []);
    const words = [...chart.querySelectorAll(".chart-section *")].filter((el) => !el.closest(".chart-note") && el.children.length === 0 && el.getClientRects().length > 0);
    return { lyrics, chords, chartText: words.map((el) => el.textContent).join(" | ") };
  })()`);
}

/** Each chart row as drawn: its chord line, its lyric line, the lyric column each chord starts over, and its box. */
const ANCHORS = `(() => {
  const chart = document.getElementById("chord-section");
  const range = (node, from, to) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return r.getBoundingClientRect(); };
  return [...chart.querySelectorAll(".pair")].map((pair) => {
    const chords = pair.querySelector(".chords");
    const lyrics = pair.querySelector(".lyrics");
    const text = chords.textContent;
    const lyric = lyrics?.textContent;
    const under = lyrics ?? chords;
    const sample = lyric ? lyrics.firstChild : chords.firstChild;
    const advance = range(sample, 0, sample.textContent.length).width / sample.textContent.length;
    const left = under.getBoundingClientRect().left;
    const at = [...text.matchAll(/\\S+/g)].map((chord) => Math.round(((range(chords.firstChild, chord.index, chord.index + 1).left - left) / advance) * 100) / 100);
    const box = chords.getBoundingClientRect();
    return { chords: text, lyrics: lyrics ? lyric : undefined, at, box: [box.left, box.top, box.width, box.height].map((n) => Math.round(n * 100) / 100) };
  });
})()`;

const storageTree = mkdtempSync(join(tmpdir(), "mls-chords-only-older-"));
try {
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: STAND_INS });
  await phone(390);

  await test("the notation switch includes Chords only next to Notes and Nashville", async () => {
    for (const width of [360, 390]) {
      await phone(width);
      await open(`#/song/${FIRE_AWAY}`);
      const labels = await evaluate<string[]>(`[...${SWITCH}.querySelectorAll("button")].map((b) => b.textContent.trim())`);
      expect(js(labels) === js(["Notes", "Nashville", "Chords only"]), `at ${width} px the switch reads ${js(labels)}`);
      await tap("Chords only", SWITCH);
      expect(js(await pressed()) === js(["Chords only"]), `at ${width} px Chords only is the one pressed (${js(await pressed())})`);
      await tap("Notes", SWITCH);
      expect(js(await pressed()) === js(["Notes"]), `at ${width} px Notes is pressed again (${js(await pressed())})`);
      for (const fold of [false, true]) {
        if (fold) {
          await evaluate(`(() => { const el = document.getElementById("sheet-scroll"); el.scrollTop = 600; el.dispatchEvent(new Event("scroll")); })()`);
          await pause(150);
          expect(await evaluate<boolean>(`!!document.querySelector(".song-chrome-bar[data-folded]")`), `at ${width} px the song chrome folds after scrolling the sheet`);
        }
        const row = await evaluate<{ fits: boolean; detail: string }>(`(() => {
          const group = ${SWITCH};
          const buttons = [...group.querySelectorAll("button")];
          const whole = (b) => { const r = b.getBoundingClientRect(), g = group.getBoundingClientRect(); return r.left >= g.left - 0.5 && r.right <= g.right + 0.5 && b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); };
          const parts = [group.closest(".control-row").querySelector(".transpose"), group];
          const boxes = parts.map((el) => el.getBoundingClientRect());
          const middle = boxes.map((b) => b.top + b.height / 2);
          const oneLine = Math.abs(middle[1] - middle[0]) < 2 && boxes[0].right <= boxes[1].left;
          const inside = boxes.every((b) => b.left >= 0 && b.right <= innerWidth - 4);
          const unclipped = buttons.every((b) => b.scrollWidth <= b.clientWidth);
          const pressedSeen = buttons.filter((b) => b.getAttribute("aria-pressed") === "true").every(whole);
          const before = group.scrollLeft;
          const reach = buttons.every((b) => { b.scrollIntoView({ inline: "nearest", block: "nearest" }); return whole(b); });
          group.scrollLeft = before;
          const allSeen = buttons.every(whole);
          return { fits: oneLine && inside && unclipped && pressedSeen && reach && (${width} < 390 || allSeen), detail: JSON.stringify({ oneLine, inside, unclipped, pressedSeen, reach, allSeen, boxes: [...boxes, ...buttons.map((b) => b.getBoundingClientRect())].map((b) => [Math.round(b.left), Math.round(b.right)]) }) };
        })()`);
        expect(row.fits, `at ${width} px ${fold ? "folded" : "open"}, the key and the switch share one row, the mode in use is whole on screen, each mode can be reached${width >= 390 ? ", and all three show at once" : " by scrolling the switch"}: ${row.detail}`);
        if (width < 390) {
          await tap("Chords only", SWITCH);
          const seen = await evaluate<boolean>(`(() => { const b = [...${SWITCH}.querySelectorAll("button")].at(-1), r = b.getBoundingClientRect(), g = ${SWITCH}.getBoundingClientRect(); return r.right <= g.right + 0.5 && r.left >= g.left - 0.5; })()`);
          expect(seen, `at ${width} px ${fold ? "folded" : "open"}, choosing Chords only scrolls it whole into view`);
          await tap("Notes", SWITCH);
        }
      }
    }
    await phone(390);
  });

  await test("Chords only hides lyrics and shows only the chords", async () => {
    await open(`#/song/${FIRE_AWAY}`);
    const notes = await lyricsAndChords();
    expect(notes.lyrics.length > 5, `Notes shows Fire Away's lyrics (${notes.lyrics.length} lines)`);
    await tap("Chords only", SWITCH);
    const only = await lyricsAndChords();
    const leaked = notes.lyrics.filter((line) => only.chartText.includes(line));
    expect(only.lyrics.length === 0 && leaked.length === 0, `Chords only shows no lyric line (${only.lyrics.length} lyric rows, ${leaked.length} lines in the chart text: ${js(leaked.slice(0, 2))})`);
    expect(js(only.chords) === js(notes.chords), `Chords only shows every chord Notes shows, in order, as letters (${only.chords.length} of ${notes.chords.length})`);

    await send("Page.navigate", { url: `${site.origin}/?load=${(loads += 1)}#/song/${FIRE_AWAY}` });
    await until(`!!document.querySelector("#chord-section .chart-heading")`, "Fire Away again");
    await pause(150);
    const reloaded = await lyricsAndChords();
    expect(js(await pressed()) === js(["Chords only"]) && reloaded.lyrics.length === 0, `after a reload the song is still in Chords only (${js(await pressed())}, ${reloaded.lyrics.length} lyric rows)`);

    const copy = { ...fireAway, id: 901, title: "Mike's Fire Away", copy: { id: "copy-dm", canSendOn: false, from: { name: "Mike" } } };
    await open(
      "#/song/901",
      `const stored = JSON.parse(library); stored.songs.push(${js(copy)}); localStorage.setItem("leadSheetsLibraryV2", JSON.stringify(stored))`,
    );
    await tap("Chords only", SWITCH);
    const locked = await lyricsAndChords();
    expect(locked.lyrics.length === 0 && js(locked.chords) === js(notes.chords), `a locked copy shows Chords only too (${locked.lyrics.length} lyric rows, ${locked.chords.length} chords)`);

    const untimed = `[...document.querySelectorAll("#chord-section .chart-note")].some((note) => note.textContent.includes("no tempo and length"))`;
    await open(`#/song/${FIRE_AWAY}`);
    await tap("Chords only", SWITCH);
    expect(!(await evaluate<boolean>(untimed)), "Fire Away, which has a tempo and length, does not say its chords won't fill");
    await open(`#/song/${NO_HALF_STEPPIN}`);
    await tap("Chords only", SWITCH);
    expect(await evaluate<boolean>(untimed), "No Half Steppin', which has no tempo, says its chords don't fill as it plays");
    await tap("Notes", SWITCH);
    expect(!(await evaluate<boolean>(untimed)), "Notes does not show that line");

    await open("#/live/1/0");
    await tap("Chords only", SWITCH);
    const live = await lyricsAndChords();
    expect(live.lyrics.length === 0 && live.chords.length > 0, `a song played Live from a setlist shows Chords only (${live.lyrics.length} lyric rows, ${live.chords.length} chords)`);

    const tar = execFileSync("git", ["archive", "--format=tar", OLDER_BUILD, "src", "data"], { cwd: root });
    execFileSync("tar", ["-x", "-C", storageTree], { input: tar });
    const store = new Map<string, string>();
    Object.assign(globalThis, {
      localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, String(value)), removeItem: (key: string) => void store.delete(key) },
    });
    const storage = async (tree: string) => {
      const out = await build({ entryPoints: [join(tree, "src/storage.ts")], bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" });
      return (await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`)) as typeof import("../src/storage.ts");
    };
    const current = await storage(root);
    const older = await storage(storageTree);
    const gig = { name: "Gig", semitones: 0, scrollPercent: 100, notation: "chords" } as unknown as StoredVersion;
    current.saveScrollVersions("local/1", { versions: [gig], selected: 0 });
    const mine = current.loadScrollVersions("local/1");
    expect(js(mine.versions.map((v) => [v.name, v.notation])) === js([["Gig", "chords"]]), `this build reads its Chords only version back (${js(mine)})`);
    const theirs = older.loadScrollVersions("local/1");
    expect(js(theirs.versions.map((v) => [v.name, v.notation])) === js([["Gig", "notes"]]) && theirs.selected === 0, `the build before Chords only keeps the version, in Notes (${js(theirs)})`);
  });

  await test("as a chord plays, color fills its letter from left to right, and the next chord starts when the first is full", async () => {
    await open(`#/song/${FIRE_AWAY}`);
    base = await chordColor();
    await tap("Chords only", SWITCH);
    await evaluate(`(() => { const el = document.getElementById("sheet-scroll"); el.scrollTop += document.getElementById("chord-section").getBoundingClientRect().top - el.getBoundingClientRect().top; })()`);
    await pause(150);
    const still = await look();
    expect(shown(still).length > 4 && shown(still).every((chord) => chord.filled! <= EMPTY), `before Scroll, no chord is filled (${describe(still)})`);
    await play();
    await frames(1.8);
    const held = await look();
    expect(shown(held).every((chord) => chord.filled! <= EMPTY), `the even pace holds the first 2 s, and so does the fill (${describe(held)})`);

    let last = -1;
    let partial = 0;
    for (let t = 3; t <= 45; t += 3) {
      await frames(3);
      const now = await look();
      expect(inOrder(now), `at ${t} s the chords on screen are full, then one filling, then empty (${describe(now)})`);
      const filling = shown(now).find((chord) => chord.filled! > EMPTY && chord.filled! < FULL);
      if (filling) partial += 1;
      expect(!filling || filling.leftToRight, `at ${t} s ${filling?.text} fills from its left edge (${describe(now)})`);
      const { index, share } = position(now);
      const at = index + share;
      expect(at >= last, `at ${t} s the fill has not gone back (${at.toFixed(2)} after ${last.toFixed(2)})`);
      last = at;
    }
    expect(partial >= 5, `a chord was partly filled at ${partial} of 15 samples`);

    let before = await look();
    for (let i = 0; i < 100 && before[position(before).index]?.filled! > 0.5; i++) {
      await evaluate(`window.__frames(15)`);
      before = await look();
    }
    const k = position(before).index;
    const begun = before[k]?.filled ?? 1;
    expect(k >= 0 && k + 1 < before.length && before[k + 1].visible && begun <= 0.5, `a chord at most half filled and the one after it are on screen (${describe(before)})`);
    let [steps, toFull, lag, started] = [0, 0, 0, false];
    for (; steps < 600 && !started; steps++) {
      await evaluate(`window.__frames(3)`);
      const now = await look();
      const [first, next] = [now[k], now[k + 1]];
      expect(!(next.filled! > 0 && first.filled! < 0.9), `step ${steps}: ${next.text} starts only once ${first.text} is full (${first.filled!.toFixed(2)}, ${next.filled!.toFixed(2)})`);
      if (first.filled! >= 1 && !toFull) toFull = steps + 1;
      if (first.filled! >= 1 && next.filled! === 0) lag += 1;
      started = next.filled! > 0;
      before = now;
    }
    expect(started && toFull > 0, `${before[k + 1].text} started filling after ${before[k].text} filled up`);
    const whole = toFull / (1 - begun);
    expect(lag <= Math.max(2, 0.1 * whole), `${before[k + 1].text} started within a tenth of ${before[k].text}'s fill time of it filling up (${lag} looks of 3 frames between, its fill takes about ${whole.toFixed(0)})`);

    await evaluate(`location.hash = "#/song/2"`);
    await until(`document.querySelector(".sheet-name")?.textContent === "Neon Moon"`, "Neon Moon");
    await tap("Chords only", SWITCH);
    const fresh = await look();
    expect(shown(fresh).every((chord) => chord.filled! <= EMPTY), `the next song opens with no chord filled (${describe(fresh)})`);
  });

  await test("the fill follows the song's learned version, take, or tempo and bars, and stays in sync with auto-scroll and the metronome", async () => {
    await open(`#/song/${FIRE_AWAY}`);
    base ??= await chordColor();
    await tap("Chords only", SWITCH);
    await play();
    await frames(2);
    for (let t = 5; t <= 50; t += 5) {
      await frames(5);
      const now = await look();
      const scroll = await evaluate<{ scrollTop: number; progress: number | null; at: number | null; slots: [number, number][] }>(SCROLL);
      expect(scroll.at !== null, "the Chords only chart is taller than the screen, so the scroll moves");
      const k = now.findIndex((chord) => chord.filled !== null && chord.filled > EMPTY && chord.filled < FULL);
      if (k < 0) continue;
      const [filling, next] = [now[k], now[k + 1] ?? now[k]];
      const [from, to] = [scroll.slots[filling.row][0], scroll.slots[next.row][1]];
      expect(
        scroll.at! >= from - 2 && scroll.at! <= to + 2,
        `at ${t} s the scroll is ${(scroll.progress! * 100).toFixed(1)}% down the chart (${scroll.at!.toFixed(0)} px), between the top of ${filling.text}'s row and the end of the row where ${next.text} comes next (${from.toFixed(0)} to ${to.toFixed(0)} px)`,
      );
    }
    const atForty = async (setup: string, seconds: number) => {
      await open(`#/song/${FIRE_AWAY}`, setup);
      await tap("Chords only", SWITCH);
      await play();
      await frames(seconds);
      return { chords: await look(), scrollTop: await evaluate<number>(`document.getElementById("sheet-scroll").scrollTop`) };
    };
    const even = await atForty("", 40);
    const fast = await atForty(versions(FIRE_AWAY, { versions: [{ name: "Fast", metronomeBpm: 232 }], selected: 0 }), 20);
    const [slow, quick] = [position(even.chords), position(fast.chords)];
    expect(
      slow.index === quick.index && Math.abs(slow.share - quick.share) < 0.1 && Math.abs(even.scrollTop - fast.scrollTop) < 3,
      `with the metronome at 232 instead of 116, the fill and the scroll reach in 20 s where they reach in 40 s (chord ${quick.index} at ${quick.share.toFixed(2)} vs ${slow.index} at ${slow.share.toFixed(2)}, scrollTop ${fast.scrollTop} vs ${even.scrollTop})`,
    );

    const taught: StoredVersion = { name: "Taught", bpm: 116, marks: [{ at: 0, progress: 0 }, { at: 40, progress: 0.3 }, { at: 70, progress: 0.3 }, { at: 244, progress: 1 }] };
    await open(`#/song/${FIRE_AWAY}`, versions(FIRE_AWAY, { versions: [taught], selected: 0 }));
    await tap("Chords only", SWITCH);
    await play();
    await frames(45);
    const early = { at: position(await look()), top: await evaluate<number>(`document.getElementById("sheet-scroll").scrollTop`) };
    await frames(20);
    const late = { at: position(await look()), top: await evaluate<number>(`document.getElementById("sheet-scroll").scrollTop`) };
    await frames(15);
    const after = position(await look());
    expect(
      early.at.index === late.at.index && Math.abs(early.at.share - late.at.share) < 0.05 && Math.abs(early.top - late.top) < 2,
      `during the taught hold (40 to 70 s) the fill and the scroll stand still (${js(early)} then ${js(late)})`,
    );
    expect(after.index + after.share > late.at.index + late.at.share, `after the hold the fill moves on (${js(after)} after ${js(late.at)})`);

    const headings = fireAway.body.map((section) => section.heading);
    const downbeat = (60 * 4) / 116;
    const arrivals = headings.map((_, i) => downbeat + i * 25);
    const beats = Array.from({ length: Math.floor((240 - downbeat) / (60 / 116)) }, (_, i) => downbeat + (i * 60) / 116);
    const learned: StoredVersion = {
      name: "Learned",
      bpm: 116,
      marks: [{ at: 0, progress: 0 }, { at: 244, progress: 1 }],
      learned: { beatsPerBar: 4, downbeat, beats, sections: headings.map((heading, i) => ({ heading, at: arrivals[i] })), vocals: [] },
    };
    await open(`#/song/${FIRE_AWAY}`, versions(FIRE_AWAY, { versions: [learned], selected: 0 }));
    await tap("Chords only", SWITCH);
    await play();
    let clock = 0;
    const to = async (at: number) => {
      await frames(at - clock);
      clock = at;
      return look();
    };
    for (const k of [2, 3]) {
      const ahead = await to(arrivals[k] - 0.3);
      const early = shown(ahead).filter((chord) => chord.section >= k && chord.filled! > EMPTY);
      expect(shown(ahead).some((chord) => chord.section === k) && early.length === 0, `just before ${headings[k]} starts, none of its chords has begun (${describe(ahead)})`);
      const middle = await to((arrivals[k] + arrivals[k + 1]) / 2);
      const playing = middle[position(middle).index];
      expect(playing?.section === k, `halfway through ${headings[k]}, the chord filling is one of its own (${playing?.text} in section ${playing?.section}: ${describe(middle)})`);
      const done = await to(arrivals[k + 1] - 0.3);
      const next = shown(done).filter((chord) => chord.section > k && chord.filled! > EMPTY);
      expect(next.length === 0, `until ${headings[k + 1]} starts, none of its chords fills (${describe(done)})`);
    }
  });

  await test("check:chords anchors stay over their syllables in Notes and Nashville, and Chords only does not shift those modes", async () => {
    const { displayChordLine } = (await import(`data:text/javascript;base64,${Buffer.from(
      (await build({ entryPoints: [join(root, "src/music.ts")], bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" })).outputFiles[0].text,
    ).toString("base64")}`)) as typeof import("../src/music.ts");
    for (const id of [FIRE_AWAY, NO_HALF_STEPPIN]) {
      const song = seed.songs.find((each) => each.id === id) as Song;
      await open(`#/song/${id}`);
      for (const mode of ["Notes", "Nashville"]) {
        await tap(mode, SWITCH);
        const first = await evaluate<(Row & { box: number[] })[]>(ANCHORS);
        await tap("Chords only", SWITCH);
        await tap(mode, SWITCH);
        const again = await evaluate<(Row & { box: number[] })[]>(ANCHORS);
        expect(js(again) === js(first), `${song.title} in ${mode} draws every chord row in the same place after a Chords only round trip`);
        const source: Row[] = song.body.flatMap((section) =>
          section.lines.flatMap((line) => (line.chords === undefined ? [] : [{ chords: displayChordLine(line.chords, song, 0, mode === "Notes" ? "notes" : "nashville"), lyrics: line.lyrics }])),
        );
        const drawn = again.map((row) => ({ ...row, at: row.at!.map(Math.round) }));
        expect(js(chordAnchors(drawn)) === js(chordAnchors(source)), `${song.title} in ${mode} keeps each chord over its notated syllable`);
      }
    }
  });

  const errors = await evaluate<string[]>("window.__errors");
  if (errors.length) {
    failures += 1;
    console.log(`FAIL the page threw: ${errors.slice(0, 3).join(" | ")}`);
  }
} finally {
  await site.close();
  rmSync(storageTree, { recursive: true, force: true });
}

if (failures) {
  console.log(`${failures} failing`);
  process.exit(1);
}
console.log("chords only ok");
