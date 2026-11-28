/**
 * check:gig-corners (plan 4, p4-gig-corners). The leader of a live gig gets A− A+ at the bottom left of the chart and,
 * while the sheet scrolls, Scroll slower and Scroll faster at the bottom right, right above the stage bar. Every song
 * sheet's top bar is one line and one height, A+ keeps the line being read on screen, and the sheet's title stops
 * growing at the 1.15 step.
 *
 * The harness is check:stage's: the real App in headless Chrome, App's `./gig-live.tsx` import wrapped only to hand
 * `useGigStage` stand-in deps, a page-side band room, and a second phone in the same page, Sam, that follows the gig.
 * Every control is pressed with DevTools mouse or touch events at its own box. Songs are made up here. Every page stores
 * `leadSheetsTextScale` = 1 before the App first renders. A scroll rate is read over a 2-second window of frames.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { openSite, type Site } from "./chrome.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SMALL = { width: 360, height: 740, deviceScaleFactor: 2, mobile: true };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const TABLET = { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true };
const PHONES = [SMALL, PHONE];
const HOLD_MS = 650;
const TAP_MS = 60;
const BPM = 120;
const SHEET_FONTS = ["13.6px", "16px", "18.4px", "20.8px", "24px", "27.2px"];
/** `src/App.tsx` on origin/mls-int-20261113 at 15591ca, this cook's base. */
const APP_LINES = 494;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const js = (value: unknown) => JSON.stringify(value);

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) failures += 1;
  if (!ok) console.log(`  FAIL ${message}`);
  return ok;
}

// ---------------------------------------------------------------- made-up songs

const NAMES = ["Copper Kettle", "Lantern Road", "Paper Boats", "Slow Tide", "Orchard Hill", "Northbound", "Sawdust", "Blue Smoke", "Field Day", "Night Ferry", "Low Sun", "Long Way Round"];
const KEYS: [string, string, "major" | "minor"][] = [["A major", "A", "major"], ["D major", "D", "major"], ["E minor", "E", "minor"], ["G major", "G", "major"], ["C major", "C", "major"], ["B minor", "B", "minor"], ["F major", "F", "major"], ["A minor", "A", "minor"], ["E major", "E", "major"], ["F# minor", "F#", "minor"], ["Bb major", "Bb", "major"], ["D mixolydian over a pedal, capo 2 (sounds in E)", "D", "major"]];
const TEMPOS = [96, 100, 104, 108, 112, 116, 120, 124, 132, 128, 88, null];
const WORDS = ["amber", "bicycle", "canvas", "dandelion", "ember", "fiddle", "granite", "harbor", "ivy", "juniper", "kestrel", "lantern", "meadow", "nickel", "oatmeal", "pebble", "quill", "ribbon", "saffron", "thimble", "umber", "velvet", "willow", "yarrow", "zephyr"];
/** Row n's words: two made-up words and its number, unique on the sheet and short enough never to wrap at 360 px and 1.7. */
const rowWords = (n: number) => `${WORDS[n % WORDS.length]} ${WORDS[(n * 7 + 3) % WORDS.length]} ${n + 1}`;

type ChartLine = { chords?: string; lyrics?: string; bars?: string };
type Section = { heading: string; lines: ChartLine[] };
/** One long section of even rows, so the band scroll runs at an even pace, then a few short sections for the chips. */
function body(rows: number, chips: string[]): Section[] {
  const lines: ChartLine[] = Array.from({ length: rows }, (_, n) => ({ chords: "A       D", lyrics: rowWords(n) }));
  return [{ heading: "VERSE", lines }, ...chips.map((heading, i) => ({ heading, lines: [{ chords: "E       A", lyrics: rowWords(rows + i) }] }))];
}
const song = (i: number, rows = 60, chips = ["CHORUS", "BRIDGE", "OUTRO"]) => ({
  title: NAMES[i],
  artist: "The Test Pressings",
  keyLabel: KEYS[i][0],
  keyRoot: KEYS[i][1],
  keyMode: KEYS[i][2],
  keyNote: "",
  tempo: i === 0 ? BPM : TEMPOS[i],
  tempoNote: "",
  timeSignature: "4/4",
  officialRuntimeSec: null,
  feel: "",
  sourceNote: "",
  atAGlance: "",
  howToPlay: "",
  practiceTip: "",
  body: body(rows, chips),
});
/** Song 2 has two rows of section chips at 360 and 390 px. */
const MANY_CHIPS = ["INTRO", "CHORUS", "BRIDGE", "SOLO", "OUTRO"];
const SONGS = NAMES.map((_, i) => ({ songId: `s_${i + 1}`, song: i === 1 ? song(i, 60, MANY_CHIPS) : song(i), bandTiming: null }));
const OWN = [song(0), song(3)];

// ---------------------------------------------------------------- the page

const WRAP = `
  import * as real from "./src/gig-live.tsx";
  export const LiveGigStrip = real.LiveGigStrip;
  export const useBandFollow = real.useBandFollow;
  export function useGigStage(args) {
    const out = real.useGigStage({ ...args, deps: window.__deps });
    window.__live = out.live;
    return out;
  }
`;

const HARNESS = `
  import { createRoot } from "react-dom/client";
  import { App } from "./src/App.tsx";
  import { liveGig } from "./src/gig-live.ts";
  import { startGig } from "./src/gig-state.ts";
  import { addOwnSetlist, addOwnSongs } from "./src/storage.ts";
  import "./src/styles.css";

  const w = window;
  const GIG = "gig_corners";
  const BAND = "band_corners";
  const localNow = () => performance.timeOrigin + performance.now();

  const hub = { held: null, sends: [], log: [], down: new Set(), rooms: new Map() };
  w.__hub = hub;
  function fakeRoom(me) {
    const listeners = new Set();
    const tell = (m) => [...listeners].forEach((cb) => cb(m));
    const later = (run) => setTimeout(() => { if (!hub.down.has(me)) run(); }, 5);
    const room = {
      get state() { return hub.down.has(me) ? "down" : "open"; },
      send(m) {
        if (hub.down.has(me)) return false;
        hub.log.push({ me, kind: m.kind });
        // As worker/room.ts joinGig does, the leader's socket joining is told to every other phone in the gig too.
        if (m.kind === "join-gig") {
          const peers = (you) => ({ kind: "gig", gigId: GIG, you: you + "-sock", leader: hub.held ? hub.held.leader + "-sock" : null, openedAt: 0 });
          later(() => tell(peers(me)));
          if (hub.held && hub.held.leader === me) for (const [who, other] of hub.rooms) if (who !== me) other.hear(peers(who));
        }
        else if (m.kind === "gig-state") later(() => tell({ kind: "gig-state", state: hub.held, at: hub.held ? hub.held.changedAt : null }));
        else if (m.kind === "link" && m.body && m.body.k === "ping") later(() => tell({ kind: "link", from: m.to, body: { k: "pong", n: m.body.n, t0: m.body.t0, band: localNow() }, rx: 0, tx: 0 }));
        else if (m.kind === "gig-op" || m.kind === "gig-start") {
          hub.sends.push({ me, kind: m.kind, op: m.op || null, rev: m.state.rev, epoch: m.state.epoch });
          const newer = !hub.held || m.state.epoch > hub.held.epoch || (m.state.epoch === hub.held.epoch && m.state.rev > hub.held.rev);
          if (newer) hub.held = m.state;
          for (const [who, other] of hub.rooms) if (who !== me) other.hear({ kind: "gig-state", state: hub.held, at: m.at });
        }
        return true;
      },
      listen(cb) { listeners.add(cb); return () => listeners.delete(cb); },
      close() { listeners.clear(); if (hub.rooms.get(me) === room) hub.rooms.delete(me); },
      hear(m) { later(() => tell(m)); },
      drop() { hub.down.add(me); tell({ kind: "room-down" }); },
      back() { hub.down.delete(me); tell({ kind: "hello", you: me + "-sock", peers: [], lineups: [GIG] }); },
    };
    hub.rooms.set(me, room);
    later(() => tell({ kind: "hello", you: me + "-sock", peers: [], lineups: [GIG] }));
    return room;
  }

  w.__deps = {
    gigs: async () => [w.__gig],
    pack: async () => w.__pack,
    room: () => fakeRoom(w.__me),
    names: async () => ({ terry: "Terry", mike: "Mike", sam: "Sam", ann: "Ann" }),
    admins: async () => ["ann"],
    screenOn: async () => () => {},
  };

  let mounted = null;
  w.__boot = (cfg) => {
    if (mounted) mounted.unmount();
    if (w.__follower) w.__follower.close();
    w.__follower = null;
    for (const room of [...hub.rooms.values()]) room.close();
    hub.sends = [];
    hub.log = [];
    hub.down = new Set();
    w.__me = cfg.me;
    if (!cfg.keepStorage) {
      localStorage.clear();
      localStorage.setItem("leadSheetsTextScale", String(cfg.text ?? 1));
      if (cfg.me) localStorage.setItem("leadSheetsSignedIn", cfg.me);
    }
    let hash = cfg.hash;
    if (cfg.own) {
      const ids = addOwnSongs(cfg.own);
      const set = addOwnSetlist({ name: "Corner Set", songIds: ids });
      w.__own = { ids, set };
    }
    if (w.__own) hash = hash.replace("{song}", String(w.__own.ids[0])).replace("{set}", String(w.__own.set));
    const songs = cfg.songs;
    w.__pack = { gig: null, songs, scrollWithLeader: !!cfg.scrollAlong, secret: null, packRev: 1, expiresAt: null };
    w.__gig = { gigId: GIG, bandId: BAND, setlistId: "set_corners", name: "Saturday at the Grange", date: "2026-11-28", lineup: ["terry", "mike", "sam", "ann"], leader: "terry", backup: "mike", route: "auto", status: "live" };
    w.__pack.gig = w.__gig;
    if (!cfg.keepGig) {
      hub.held = startGig({ gigId: GIG, order: songs.map((s) => s.songId), leader: "terry", admin: "ann", backup: "mike", lineup: ["terry", "mike", "sam", "ann"], route: "auto", scrollAlong: !!cfg.scrollAlong, now: localNow() });
      if (cfg.at) {
        const s = hub.held;
        const key = s.order[s.order.length - 1].value[cfg.at];
        hub.held = { ...s, current: s.current.map((step) => ({ ...step, value: key })) };
      }
    }
    history.replaceState(null, "", hash);
    mounted = createRoot(document.getElementById("root"));
    mounted.render(<App />);
  };
  w.__follow = () => {
    w.__follower = liveGig({ me: "sam", gigId: GIG, room: fakeRoom("sam"), stun: [], rows: ["server"] });
  };
  /** Mike, the backup, on a phone of his own in the gig. */
  w.__backup = () => {
    w.__mike = liveGig({ me: "mike", gigId: GIG, room: fakeRoom("mike"), stun: [], rows: ["server"] });
  };
  w.__session = () => (w.__live && w.__live.joined ? w.__live.joined.session : null);
  w.__now = () => localNow();
  w.__leaderState = () => { const s = w.__session(); return s ? s.view().state : null; };
  w.__followerState = () => (w.__follower ? w.__follower.view().state : null);
  w.__gigSends = () => hub.log.filter((m) => m.me === w.__me && /^gig/.test(m.kind)).length + hub.sends.filter((s) => s.me === w.__me).length;

  /** px per second the sheet moves, a least-squares fit over every frame of a window of ms. */
  w.__rate = (ms) => new Promise((done) => {
    const el = document.getElementById("sheet-scroll");
    const points = [];
    let start = null;
    const frame = (t) => {
      start ??= t;
      points.push([t / 1000, el.scrollTop]);
      if (t - start < ms) return requestAnimationFrame(frame);
      const n = points.length;
      const mx = points.reduce((a, p) => a + p[0], 0) / n;
      const my = points.reduce((a, p) => a + p[1], 0) / n;
      const sxy = points.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
      const sxx = points.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
      done({ rate: sxx ? sxy / sxx : 0, frames: n });
    };
    requestAnimationFrame(frame);
  });
  w.__frames = (n) => new Promise((done) => { const tick = () => (--n <= 0 ? done(null) : requestAnimationFrame(tick)); requestAnimationFrame(tick); });

  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
  /** Shown: on screen with a box, not display:none or visibility:hidden anywhere up its tree. */
  const shown = (el) => !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== "hidden";
  w.__look = {
    rect,
    shown,
    box: (selector) => { const el = document.querySelector(selector); return shown(el) ? rect(el) : null; },
    /** The line boxes a text runs over. */
    lines: (el) => { if (!el) return 0; const range = document.createRange(); range.selectNodeContents(el); return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size; },
    /** The top of what shows of the sheet: below the open bar at rest, below the bar that hangs over it while it scrolls. */
    sheetTop: () => { const el = document.getElementById("sheet-scroll"); return el.getBoundingClientRect().top + (parseFloat(el.style.getPropertyValue("--chrome-over")) || 0); },
    rows: () => [...document.querySelectorAll("#chord-section .chart-section > :not(.chart-heading)")],
  };
`;

/** App imports "./gig-live.tsx"; only that import is swapped, for the wrapper above. */
const wrapLive: Plugin = {
  name: "corner-deps",
  setup(b) {
    b.onResolve({ filter: /gig-live\.tsx$/ }, (args) => (args.importer.endsWith("App.tsx") ? { path: "corner-wrap", namespace: "corner" } : undefined));
    b.onLoad({ filter: /.*/, namespace: "corner" }, () => ({ contents: WRAP, resolveDir: root, loader: "tsx" }));
  },
};

type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number } | null;
type Metrics = typeof PHONE;

async function main() {
  const bundled = await build({
    stdin: { contents: HARNESS, resolveDir: root, loader: "tsx", sourcefile: "corner-harness.tsx" },
    bundle: true,
    write: false,
    outdir: join(root, ".corner-harness"),
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    plugins: [wrapLive],
    loader: { ".woff2": "empty", ".woff": "empty", ".svg": "dataurl", ".png": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const script = bundled.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const css = bundled.outputFiles.filter((file) => file.path.endsWith(".css")).map((file) => file.text).join("\n");

  const site = await openSite(root, "check-gig-corners");
  try {
    await run(site, script, css);
  } finally {
    await site.close();
  }
}

async function run(site: Site, script: string, css: string) {
  const { send, evaluate } = site;
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", PHONE);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  /** Loads the page afresh: the app's own page with its script held back gives the harness a real origin, with localStorage, that the app never ran on. */
  async function load() {
    await send("Emulation.setScriptExecutionDisabled", { value: true });
    const loaded = new Promise((resolve) => setTimeout(resolve, 1500));
    await send("Page.navigate", { url: `${site.origin}/?corner-harness` });
    await loaded;
    await send("Emulation.setScriptExecutionDisabled", { value: false });
    await evaluate(`(() => {
      document.open();
      document.write('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div></body></html>');
      document.close();
      const style = document.createElement("style");
      style.textContent = ${js(css)};
      document.head.append(style);
    })()`);
    await send("Runtime.evaluate", { expression: script });
  }
  await load();

  const page = <T>(expression: string) => evaluate<T>(expression);
  const until = async <T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 8000): Promise<T> => {
    const end = Date.now() + timeoutMs;
    let last = await read();
    while (!ok(last)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last ${js(last)})`);
      await sleep(40);
      last = await read();
    }
    return last;
  };
  const settle = () => page("window.__frames(3)");
  const box = (selector: string) => page<Box>(`window.__look.box(${js(selector)})`);
  const boxes = (selector: string) => page<Box[]>(`[...document.querySelectorAll(${js(selector)})].filter(window.__look.shown).map(window.__look.rect)`);
  const shown = (selector: string) => box(selector).then((found) => found !== null);
  const text = (selector: string) => page<string | null>(`document.querySelector(${js(selector)})?.textContent ?? null`);
  const has = (selector: string) => page<boolean>(`!!document.querySelector(${js(selector)})`);
  const mouse = (type: string, x: number, y: number) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "mouse" });
  async function press(selector: string, ms: number) {
    // A control at the end of a stage panel's own scroll is brought into the panel's view first, as a thumb would.
    await page(`document.querySelector(${js(selector)})?.scrollIntoView({ block: "nearest" })`);
    const at = await box(selector);
    if (!at) throw new Error(`no ${selector} on screen`);
    const x = at.x + at.width / 2;
    const y = at.y + at.height / 2;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await mouse("mousePressed", x, y);
    await sleep(ms);
    await mouse("mouseReleased", x, y);
  }
  const hold = (selector: string) => press(selector, HOLD_MS);
  const tap = async (selector: string) => {
    await press(selector, TAP_MS);
    await settle();
  };
  async function touch(selector: string) {
    const at = await box(selector);
    if (!at) throw new Error(`no ${selector} on screen`);
    const point = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await sleep(TAP_MS);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await settle();
  }
  const key = async (name: "Tab" | "Enter") => {
    const code = name === "Tab" ? 9 : 13;
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code, text: name === "Enter" ? "\r" : undefined });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code });
  };
  const leaderState = () => page<any>("window.__leaderState()");
  const followerState = () => page<any>("window.__followerState()");
  const now = () => page<number>("window.__now()");
  const latestGrid = (state: any) => state.click[state.click.length - 1].value as { startAt: number } | null;
  const scrollTop = () => page<number>(`document.getElementById("sheet-scroll").scrollTop`);
  const sheetFont = () => page<string>(`getComputedStyle(document.querySelector(".sheet")).fontSize`);
  const titleFont = () => page<number>(`parseFloat(getComputedStyle(document.querySelector(".sheet-title")).fontSize)`);
  const rowFont = () => page<number>(`parseFloat(getComputedStyle(document.querySelector("#chord-section .lyrics")).fontSize)`);
  const rate = () => page<{ rate: number; frames: number }>("window.__rate(2000)");
  const metrics = (phone: Metrics) => send("Emulation.setDeviceMetricsOverride", phone);

  const CORNERS = ".gig-corners";
  const TEXT_PAIR = '.gig-corners [role="group"][aria-label="Text size"]';
  const SPEED_PAIR = '.gig-corners [role="group"][aria-label="Scroll speed"]';
  const C_SMALLER = `${TEXT_PAIR} [aria-label="Smaller text"]`;
  const C_LARGER = `${TEXT_PAIR} [aria-label="Larger text"]`;
  const SLOWER = `${SPEED_PAIR} [aria-label="Scroll slower"]`;
  const FASTER = `${SPEED_PAIR} [aria-label="Scroll faster"]`;
  const PERCENT = `${SPEED_PAIR} [role="status"]`;
  const H_SMALLER = '.shell-header [aria-label="Smaller text"]';
  const H_LARGER = '.shell-header [aria-label="Larger text"]';
  const BAR = "[data-stage-bar]";

  /** Boots the App as `me`, joins the live gig through the strip, answers the click question, and waits for the gig sheet. */
  async function joinAs(me: string, options: { scrollAlong?: boolean; at?: number; follower?: boolean; keepGig?: boolean; keepStorage?: boolean } = {}) {
    await page(`window.__boot(${js({ me, hash: "#/bands", songs: SONGS, scrollAlong: options.scrollAlong, at: options.at, keepGig: options.keepGig, keepStorage: options.keepStorage })})`);
    await until("Join gig on the strip", () => page<boolean>(`[...document.querySelectorAll(".gig-strip button")].some((b) => b.textContent === "Join gig")`), Boolean);
    await page(`[...document.querySelectorAll(".gig-strip button")].find((b) => b.textContent === "Join gig").click()`);
    // A phone that answered the click question before, and kept its storage, is not asked again.
    if (!options.keepStorage) {
      await until("the click question", () => page<boolean>(`[...document.querySelectorAll(".gig-question button")].some((b) => b.textContent === "Dot only")`), Boolean);
      await page(`[...document.querySelectorAll(".gig-question button")].find((b) => b.textContent === "Dot only").click()`);
    }
    await until("the gig sheet", () => page<string>("location.hash"), (hash) => hash.startsWith("#/gig/band_corners/gig_corners/") && !hash.endsWith("/"));
    await until("the sheet", () => has(".sheet .sheet-name"), Boolean);
    await until(`${me}'s session has the gig state`, () => leaderState(), (state) => state !== null);
    if (options.follower !== false) {
      await page("window.__follow()");
      await until("Sam's phone has the gig state", () => followerState(), (state) => state !== null);
    }
    await settle();
  }
  const asLeader = async (options: { scrollAlong?: boolean; at?: number } = {}) => {
    await joinAs("terry", options);
    await until("the stage bar", () => has(BAR), Boolean);
    await settle();
  };
  const asMember = () => joinAs("sam", { follower: false });
  /** Signed out on this phone's own songs: `#/song/<id>` or `#/live/<setlist>/0`. */
  async function solo(hash: string, keepStorage = false) {
    await page(`window.__boot(${js({ me: null, hash, songs: SONGS, own: keepStorage ? undefined : OWN, keepStorage })})`);
    await until("the sheet", () => has(".sheet .sheet-name"), Boolean);
    await settle();
  }
  const SOLO_SONG = "#/song/{song}";
  const SOLO_LIVE = "#/live/{set}/0";

  /** Holds Count in and waits until the band's click has landed and this sheet is moving on its own. */
  async function countIn() {
    await hold('[data-stage="count-in"]');
    const grid = await until("the click to start", () => leaderState(), (state) => latestGrid(state) !== null).then(latestGrid);
    await until("the count-in to land", now, (t) => t > grid!.startAt + 50);
    const from = await scrollTop();
    await until("the band scroll to move the sheet", scrollTop, (top) => top > from + 5, 10_000);
  }
  /** The corner control `selector`, or a FAIL that says it is not there. */
  async function need(selector: string, what: string) {
    return check(await shown(selector), `${what}: no ${selector} on screen`);
  }
  const stageGap = async () => {
    const bar = await box(BAR);
    const pairs = [await box(TEXT_PAIR), await box(SPEED_PAIR)].filter(Boolean) as NonNullable<Box>[];
    return { bar, pairs, gaps: pairs.map((pair) => bar!.y - pair.bottom) };
  };
  const meets = (a: NonNullable<Box>, b: NonNullable<Box>) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

  const cases: [string, () => Promise<void>][] = [];
  const it = (name: string, body: () => Promise<void>) => cases.push([name, body]);

  it("C1 placement", async () => {
    try {
      for (const phone of [SMALL, PHONE, TABLET]) {
        await metrics(phone);
        await asLeader({ scrollAlong: true });
        await countIn();
        if (!(await need(TEXT_PAIR, `at ${phone.width} px the leader's text pair`)) || !(await need(SPEED_PAIR, `at ${phone.width} px, while the sheet scrolls, the leader's speed pair`))) continue;
        const text = (await box(TEXT_PAIR))!;
        const speed = (await box(SPEED_PAIR))!;
        const sheet = (await box("#sheet-scroll"))!;
        const { bar, gaps } = await stageGap();
        check(text.x >= 0 && text.x <= 16, `at ${phone.width} px the text pair is within 16 px of the left edge (left ${text.x})`);
        check(speed.right <= phone.width && phone.width - speed.right <= 16, `at ${phone.width} px the speed pair is within 16 px of the right edge (right ${speed.right})`);
        for (const [name, pair] of [["text", text], ["speed", speed]] as const) {
          check(pair.x >= sheet.x && pair.right <= sheet.right && pair.y >= sheet.y && pair.bottom <= sheet.bottom, `at ${phone.width} px the ${name} pair sits inside the sheet's box (${js(pair)} in ${js(sheet)})`);
        }
        check(gaps.every((gap) => gap >= 0 && gap <= 16), `at ${phone.width} px each pair's bottom is 0 to 16 px above the stage bar's top (bar top ${bar?.y}, gaps ${js(gaps)})`);
      }
    } finally {
      await metrics(PHONE);
    }
  });

  it("C2 who", async () => {
    await asMember();
    check(!(await has(CORNERS)), "the follower has no corner pairs");
    check((await shown(H_SMALLER)) && (await shown(H_LARGER)), "the follower has A− A+ in the top bar");
    await asLeader({ scrollAlong: true });
    await countIn();
    check(await shown(TEXT_PAIR), "the leader has the text pair");
    check(await shown(SPEED_PAIR), "the leader has the speed pair while the sheet scrolls");
    check(!(await shown(H_SMALLER)) && !(await shown(H_LARGER)), "the leader's top bar shows no A− A+");
  });

  it("C3 text", async () => {
    await asLeader();
    if (!(await need(C_LARGER, "the leader's corner Larger text"))) return;
    const seen = [await sheetFont()];
    for (let i = 0; i < 4; i += 1) {
      await (i === 0 ? touch(C_LARGER) : tap(C_LARGER));
      seen.push(await sheetFont());
    }
    check(js(seen) === js(SHEET_FONTS.slice(1)), `Larger text steps the sheet 16 → 18.4 → 20.8 → 24 → 27.2 px (saw ${js(seen)})`);
    check(await page<boolean>(`document.querySelector(${js(C_LARGER)}).disabled`), "Larger text is off at the largest size");
    await tap(C_LARGER);
    check((await sheetFont()) === "27.2px", "a tap on the off Larger text changes nothing");
    const down = [];
    for (let i = 0; i < 5; i += 1) {
      await tap(C_SMALLER);
      down.push(await sheetFont());
    }
    check(js(down) === js(SHEET_FONTS.slice(0, 5).reverse()), `Smaller text steps it back 24 → … → 13.6 px (saw ${js(down)})`);
    check(await page<boolean>(`document.querySelector(${js(C_SMALLER)}).disabled`), "Smaller text is off at the smallest size");
    for (let i = 0; i < 3; i += 1) await tap(C_LARGER);
    check((await sheetFont()) === "20.8px" && (await page<string | null>(`localStorage.getItem("leadSheetsTextScale")`)) === "3", `three taps up from the smallest is 20.8 px, stored as step 3 (${await sheetFont()})`);
    await load();
    await joinAs("terry", { keepStorage: true });
    check((await sheetFont()) === "20.8px", `after a reload the leader's gig sheet is still 20.8 px (${await sheetFont()})`);
  });

  it("C4 speed", async () => {
    await asLeader({ scrollAlong: true });
    await countIn();
    if (!(await need(FASTER, "while the band scroll runs, the leader's Scroll faster"))) return;
    // With no runtime the band scroll runs at one even pace; the first rate is the one two windows in a row agree on.
    let first = await rate();
    for (let window = 0; window < 8; window += 1) {
      const next = await rate();
      const steady = Math.abs(next.rate / first.rate - 1) <= 0.03;
      first = next;
      if (steady) break;
    }
    for (let i = 0; i < 4; i += 1) await tap(FASTER);
    check((await text(PERCENT)) === "120%", `four taps of Scroll faster read 120% (${js(await text(PERCENT))})`);
    const fast = await rate();
    console.log(`       rate ${first.rate.toFixed(1)} px/s over ${first.frames} frames, at 120% ${fast.rate.toFixed(1)} px/s over ${fast.frames}`);
    check(first.rate > 2 && Math.abs(fast.rate / first.rate - 1.2) <= 0.1, `at 120% the sheet moves 1.2 times as fast within 0.1 (${(fast.rate / first.rate).toFixed(3)})`);
    for (let i = 0; i < 4; i += 1) await tap(SLOWER);
    const back = await rate();
    check(Math.abs(back.rate / first.rate - 1) <= 0.1 && (await text(PERCENT)) === "", `four taps of Scroll slower bring it back to the first rate within 0.1 (${(back.rate / first.rate).toFixed(3)}, label ${js(await text(PERCENT))})`);
    for (let i = 0; i < 10; i += 1) await tap(FASTER);
    check((await text(PERCENT)) === "150%" && (await page<boolean>(`document.querySelector(${js(FASTER)}).disabled`)), `ten taps up from 100% end at 150% with Scroll faster off (${js(await text(PERCENT))})`);
    for (let i = 0; i < 20; i += 1) await tap(SLOWER);
    check((await text(PERCENT)) === "50%" && (await page<boolean>(`document.querySelector(${js(SLOWER)}).disabled`)), `ten taps down from 100% end at 50% with Scroll slower off (${js(await text(PERCENT))})`);
  });

  it("C5 only while scrolling", async () => {
    await asLeader({ scrollAlong: true });
    check(await shown(TEXT_PAIR), "before Count in the text pair shows");
    check(!(await has(SPEED_PAIR)), "before Count in the speed pair is not drawn");
    await countIn();
    if (!(await need(FASTER, "while the band scroll runs, Scroll faster"))) return;
    await tap(FASTER);
    await tap(FASTER);
    check((await text(PERCENT)) === "110%", `two taps read 110% (${js(await text(PERCENT))})`);
    await hold('[data-stage="stop"]');
    await until("Stop to land", () => leaderState(), (state) => latestGrid(state) === null);
    const gone = await until("the speed pair to go", () => has(SPEED_PAIR), (there) => !there, 4000).catch(() => true);
    check(!gone, "after Stop the speed pair is gone");
    check(await shown(TEXT_PAIR), "after Stop the text pair stays");
    await hold('[data-stage="next"]');
    await until("song 2", () => text(".shell-title"), (words) => words?.startsWith("2 of 12") ?? false);
    await settle();
    await countIn();
    if (!(await need(FASTER, "on the next song, once the scroll runs, Scroll faster"))) return;
    check((await text(PERCENT)) === "", `on the next song the speed is back at 100% (label ${js(await text(PERCENT))})`);
    await tap(FASTER);
    check((await text(PERCENT)) === "105%", `one tap from there reads 105% (${js(await text(PERCENT))})`);
  });

  it("C6 nothing leaves this phone", async () => {
    await asLeader({ scrollAlong: true });
    await countIn();
    if (!(await need(FASTER, "while the band scroll runs, Scroll faster")) || !(await need(C_LARGER, "the corner Larger text"))) return;
    const keys = () => page<string>(`JSON.stringify(Object.keys(localStorage).filter((k) => /^leadSheets(SongDraft|ScrollPercent)/.test(k)).sort().map((k) => [k, localStorage.getItem(k)]))`);
    const followerRate = (state: any) => state.scroll[state.scroll.length - 1].value?.rate ?? null;
    const before = { keys: await keys(), follower: js(await followerState()), sends: await page<number>("window.__gigSends()"), rev: (await leaderState()).rev };
    const rateBefore = followerRate(await followerState());
    for (let i = 0; i < 4; i += 1) await tap(FASTER);
    for (let i = 0; i < 2; i += 1) await tap(SLOWER);
    await tap(C_LARGER);
    await tap(C_SMALLER);
    await tap(C_LARGER);
    await sleep(500);
    const after = { keys: await keys(), follower: js(await followerState()), sends: await page<number>("window.__gigSends()"), rev: (await leaderState()).rev };
    const rateAfter = followerRate(await followerState());
    console.log(`       room gig messages ${before.sends} → ${after.sends}, gig rev ${before.rev} → ${after.rev}, Sam's scroll rate ${rateBefore} → ${rateAfter}`);
    check(after.sends === before.sends, `the room received no gig message from the leader (${before.sends} → ${after.sends})`);
    check(after.follower === before.follower && after.rev === before.rev, "the follower's gig state is the same");
    check(typeof rateBefore === "number" && typeof rateAfter === "number" && Math.abs(rateAfter - rateBefore) <= 0.1, `the follower's scroll rate is the same within 0.1 (${rateBefore} → ${rateAfter})`);
    check(after.keys === before.keys, `no leadSheetsSongDraft or leadSheetsScrollPercent key changed (${before.keys} → ${after.keys})`);
  });

  it("C7 the bar grows", async () => {
    try {
      for (const phone of PHONES) {
        await metrics(phone);
        await asLeader({ scrollAlong: true, at: 1 });
        await countIn();
        if (!(await need(SPEED_PAIR, `at ${phone.width} px, while the sheet scrolls, the speed pair`))) continue;
        const chipRows = await page<number>(`new Set([...document.querySelectorAll('[data-stage="section"]')].map((b) => Math.round(b.getBoundingClientRect().top))).size`);
        check(chipRows === 2, `at ${phone.width} px song 2's section chips run to two rows (${chipRows})`);
        const rest = await stageGap();
        await hold('[data-stage="next"]');
        const shownRow = await has('[data-stage="undo"]');
        check(shownRow, `at ${phone.width} px the status row shows a pending move`);
        const grown = await stageGap();
        const buttons = (await boxes(`${BAR} button`)) as NonNullable<Box>[];
        const hit = grown.pairs.flatMap((pair) => buttons.filter((button) => meets(pair, button)));
        check(grown.bar!.height > rest.bar!.height, `at ${phone.width} px the bar grew (${rest.bar!.height} → ${grown.bar!.height})`);
        check(grown.pairs.length === 2 && hit.length === 0, `at ${phone.width} px no pair meets a stage bar button (${hit.length} meet)`);
        check(grown.gaps.every((gap) => gap >= 0), `at ${phone.width} px each pair stays above the bar's top (${js(grown.gaps)})`);
        check(grown.gaps.every((gap, i) => Math.abs(gap - rest.gaps[i]) <= 1), `at ${phone.width} px the gap is the same as at rest within 1 px (${js(rest.gaps)} → ${js(grown.gaps)})`);
      }
    } finally {
      await metrics(PHONE);
    }
  });

  it("C8 lock and panels", async () => {
    await asLeader();
    if (!(await need(TEXT_PAIR, "the leader's text pair"))) return;
    await tap('[data-stage="lock"]');
    check(!(await has(CORNERS)), "locked, both pairs are gone");
    await hold('[data-stage="unlock"]');
    await settle();
    check(await shown(TEXT_PAIR), "held to unlock, the text pair is back");
    for (const [open, name] of [['[data-stage="more"]', "•••"], ['[data-stage="edit-order"]', "Order"]]) {
      await tap(open);
      await until(`the ${name} panel`, () => has("[data-stage-menu], [data-stage-order]"), Boolean);
      check(!(await has(CORNERS)), `with ${name} open the pairs are gone`);
      await tap('[data-stage="cancel"]');
      check(await shown(TEXT_PAIR), `after Close on ${name} the text pair is back`);
    }
  });

  it("C9 the lead moves", async () => {
    await asLeader();
    if (!(await need(TEXT_PAIR, "Terry's text pair while he leads"))) return;
    await until("Sam's band clock", () => page<number | null>("window.__follower.bandNow()"), (t) => t !== null, 20_000);
    await tap('[data-stage="more"]');
    await tap('[data-stage="hand-off"]');
    await until("the hand-off list", () => has('[data-stage-to="sam"]'), Boolean);
    await hold('[data-stage-to="sam"]');
    await until("the ask to reach Sam", () => followerState(), (state) => state?.handoff?.to === "sam");
    const took = await page<any>(`window.__follower.tap({ kind: "accept" })`);
    check(took?.ok === true, `Sam takes the lead (${js(took?.refused ?? took?.ok)})`);
    await until("Terry's phone to hear Sam leads", () => leaderState(), (state) => state?.leader === "sam");
    await until("Terry's stage bar to go", () => has(BAR), (there) => !there, 4000);
    await settle();
    check(!(await has(CORNERS)), "Terry's pairs are gone once Sam leads");
    check((await shown(H_SMALLER)) && (await shown(H_LARGER)), "Terry's top bar has A− A+ again");
    await joinAs("sam", { follower: false, keepGig: true });
    await until("Sam's stage bar", () => has(BAR), Boolean, 20_000);
    await settle();
    check(await shown(TEXT_PAIR), "Sam, now leading, has the text pair");
    check(!(await shown(H_SMALLER)) && !(await shown(H_LARGER)), "Sam's top bar shows no A− A+");
  });

  it("C10 size and cover", async () => {
    try {
      for (const phone of PHONES) {
        await metrics(phone);
        await asLeader({ scrollAlong: true });
        await countIn();
        if (!(await need(SPEED_PAIR, `at ${phone.width} px the speed pair`))) continue;
        const buttons = (await boxes(`${CORNERS} button`)) as NonNullable<Box>[];
        check(buttons.length === 4 && buttons.every((b) => b.width >= 56 && b.height >= 56), `at ${phone.width} px each of the 4 corner buttons is at least 56 x 56 (${js(buttons.map((b) => [b.width, b.height]))})`);
        const pairs = [(await box(TEXT_PAIR))!, (await box(SPEED_PAIR))!];
        check(pairs.every((pair) => pair.width <= phone.width / 3), `at ${phone.width} px each pair is at most a third of the screen wide (${js(pairs.map((p) => p.width))})`);
        const sheet = (await box("#sheet-scroll"))!;
        const covered = pairs.reduce((sum, pair) => sum + pair.width * pair.height, 0);
        const share = covered / (sheet.width * sheet.height);
        console.log(`       at ${phone.width} x ${phone.height} the pairs cover ${Math.round(covered)} px² of the sheet's ${Math.round(sheet.width * sheet.height)} px² (${(share * 100).toFixed(1)}%)`);
        if (phone === SMALL) check(share <= 0.15, `at 360 x 740 the two pairs cover at most 15% of the sheet's visible box (${(share * 100).toFixed(1)}%)`);
      }
    } finally {
      await metrics(PHONE);
    }
  });

  it("C11 names, keys, motion", async () => {
    await asLeader({ scrollAlong: true });
    await countIn();
    if (!(await need(SPEED_PAIR, "while the sheet scrolls, the speed pair"))) return;
    const named = await page<string[]>(`[...document.querySelectorAll(".gig-corners [role=group]")].map((g) => g.getAttribute("aria-label") + ": " + [...g.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")).join(", "))`);
    check(js(named) === js(["Text size: Smaller text, Larger text", "Scroll speed: Scroll slower, Scroll faster"]), `the groups and buttons have the app's names (${js(named)})`);
    check(await has(PERCENT), "the percent label has role=\"status\"");
    for (const [selector, did] of [
      [C_LARGER, async () => (await sheetFont()) === "18.4px"],
      [FASTER, async () => (await text(PERCENT)) === "105%"],
      [SLOWER, async () => (await text(PERCENT)) === ""],
      [C_SMALLER, async () => (await sheetFont()) === "16px"],
    ] as const) {
      await page("document.activeElement?.blur()");
      let reached = false;
      for (let i = 0; i < 80 && !reached; i += 1) {
        await key("Tab");
        reached = await page<boolean>(`document.activeElement === document.querySelector(${js(selector)})`);
      }
      check(reached, `Tab reaches ${selector}`);
      if (!reached) continue;
      await key("Enter");
      await settle();
      check(await did(), `Enter on ${selector} works (font ${await sheetFont()}, label ${js(await text(PERCENT))})`);
    }
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    try {
      await settle();
      const moving = await page<string[]>(`[...document.querySelectorAll(".gig-corners, .gig-corners *")].filter((el) => { const s = getComputedStyle(el); return s.transitionDuration.split(",").some((d) => parseFloat(d) > 0) || s.animationName !== "none"; }).map((el) => el.className || el.tagName)`);
      check(moving.length === 0, `with reduced motion the pairs have no transition and no animation (${js(moving)})`);
    } finally {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    }
  });

  it("C12 the last row", async () => {
    for (const phone of PHONES) {
      await metrics(phone);
      await asLeader();
      if (!(await need(TEXT_PAIR, `at ${phone.width} px the text pair`))) continue;
      await page(`(() => { const el = document.getElementById("sheet-scroll"); el.scrollTop = el.scrollHeight; })()`);
      await sleep(300);
      await settle();
      const last = await page<Box>(`window.__look.rect(window.__look.rows().at(-1))`);
      const pair = (await box(TEXT_PAIR))!;
      check(!!last && last.bottom <= pair.y, `at ${phone.width} px, at the sheet's end, the last chart row's bottom (${last?.bottom}) is above the pairs' top (${pair.y})`);
    }
    await metrics(PHONE);
  });

  it("C13 no signal", async () => {
    await asLeader({ scrollAlong: true });
    await countIn();
    await page(`window.__hub.rooms.get("terry").drop()`);
    await until("the no-signal note", () => text("[data-stage-note]"), (words) => words === "Your phone isn't reaching anyone", 4000).catch(() => null);
    check((await text("[data-stage-note]")) === "Your phone isn't reaching anyone", `the stage says "Your phone isn't reaching anyone" (${js(await text("[data-stage-note]"))})`);
    if (!(await need(TEXT_PAIR, "with no signal the text pair")) || !(await need(SPEED_PAIR, "with no signal, while the sheet scrolls, the speed pair"))) return;
    await tap(C_LARGER);
    check((await sheetFont()) === "18.4px", `with no signal A+ still works (${await sheetFont()})`);
    await tap(FASTER);
    check((await text(PERCENT)) === "105%", `with no signal Scroll faster still works (${js(await text(PERCENT))})`);
  });

  /** The four sheets, each with the A+ it has: the corner on the leader's, the top bar's on the rest. */
  const SHEETS: [string, () => Promise<void>, string][] = [
    ["the leader's gig sheet", () => asLeader(), C_LARGER],
    ["the member's gig sheet", () => asMember(), H_LARGER],
    ["#/live", () => solo(SOLO_LIVE), H_LARGER],
    ["#/song", () => solo(SOLO_SONG), H_LARGER],
  ];
  const topMeasure = () =>
    page<{ header: number; chrome: number; titleFont: string; titleLines: number; sheetTop: number; chromeBottom: number; sheetTitle: number }>(`(() => {
      const L = window.__look;
      const header = document.querySelector(".shell-header").getBoundingClientRect();
      const chrome = document.querySelector(".song-chrome-bar").getBoundingClientRect();
      const title = document.querySelector(".shell-title");
      return { header: header.height, chrome: chrome.height, chromeBottom: chrome.bottom, titleFont: getComputedStyle(title).fontSize, titleLines: L.lines(title), sheetTop: L.sheetTop(), sheetTitle: document.querySelector(".sheet-title").getBoundingClientRect().height };
    })()`);

  it("T1 one height", async () => {
    for (const [name, open, larger] of SHEETS) {
      await metrics(SMALL);
      await open();
      if (!(await need(larger, `${name}'s A+`))) continue;
      const before = await topMeasure();
      for (let i = 0; i < 3; i += 1) await tap(larger);
      const after = await topMeasure();
      console.log(`       ${name} at 360 x 740: top bar ${before.header} → ${after.header} px, chrome ${before.chrome} → ${after.chrome}, title ${before.titleLines} → ${after.titleLines} lines, sheet top ${before.sheetTop} → ${after.sheetTop}, sheet title ${before.sheetTitle} → ${after.sheetTitle} px`);
      check(before.header === after.header && before.chrome === after.chrome && before.titleFont === after.titleFont, `on ${name} three A+ taps leave the top bar (${before.header} → ${after.header}), the chrome bar (${before.chrome} → ${after.chrome}) and the title font (${before.titleFont} → ${after.titleFont}) as they were`);
    }
    await metrics(PHONE);
  });

  it("T2 one line", async () => {
    try {
      for (const phone of PHONES) {
        await metrics(phone);
        for (const who of ["leader", "member"]) {
          const open = async (at: number) => {
            await (who === "leader" ? asLeader({ at }) : joinAs("sam", { follower: false, at }));
            await until(`the ${who}'s top bar to name song ${at + 1}`, () => text(".shell-title"), (words) => words?.startsWith(`${at + 1} of 12 ·`) ?? false, 20_000);
            await settle();
          };
          const read = () => page<{ text: string; lines: number; header: number; whole: boolean }>(`(() => {
            const title = document.querySelector(".shell-title");
            const node = title.firstChild;
            const range = document.createRange();
            range.setStart(node, 0);
            range.setEnd(node, node.textContent.indexOf(" ·"));
            const probe = document.createElement("span");
            probe.textContent = "…";
            title.append(probe);
            const dots = probe.getBoundingClientRect().width;
            probe.remove();
            const cell = title.getBoundingClientRect();
            const pad = parseFloat(getComputedStyle(title).paddingRight) || 0;
            return { text: title.textContent, lines: window.__look.lines(title), header: document.querySelector(".shell-header").getBoundingClientRect().height, whole: range.getBoundingClientRect().right + dots <= cell.right - pad + 0.5 };
          })()`);
          await open(0);
          const first = await read();
          await open(9);
          const tenth = await read();
          check(tenth.text.startsWith("10 of 12 · F# minor · ") && tenth.text.includes("128 bpm"), `at ${phone.width} px the ${who}'s top bar names song 10 of 12 in F# minor at 128 bpm (${js(tenth.text)})`);
          check(tenth.lines === 1, `at ${phone.width} px the ${who}'s top bar title is one line on song 10 (${tenth.lines} lines)`);
          check(tenth.header === first.header, `at ${phone.width} px the ${who}'s top bar is as tall on song 10 as on song 1 (${first.header} → ${tenth.header})`);
          check(tenth.whole, `at ${phone.width} px "10 of 12" is fully shown in the ${who}'s top bar`);
          await open(11);
          const last = await read();
          check(last.lines === 1 && last.header === first.header, `at ${phone.width} px the ${who}'s top bar is one line and as tall for song 12, a long key and no tempo (${last.lines} lines, ${last.header} px)`);
        }
      }
    } finally {
      await metrics(PHONE);
    }
  });

  it("T3 below the bar", async () => {
    for (const [name, open, larger] of SHEETS) {
      await metrics(SMALL);
      await open();
      const below = async (when: string) => {
        const m = await topMeasure();
        check(m.sheetTop >= m.chromeBottom - 0.5, `on ${name}, ${when}, the sheet's top (${m.sheetTop}) is at or below the chrome bar's bottom (${m.chromeBottom})`);
      };
      await below("at the top of the page");
      if (!(await need(larger, `${name}'s A+`))) continue;
      for (let i = 0; i < 3; i += 1) await tap(larger);
      await below("after three A+ taps");
      await page(`document.getElementById("sheet-scroll").scrollTop = 200`);
      await sleep(200);
      await settle();
      await tap(".shell-title");
      await sleep(200);
      await settle();
      await below("after a 200 px scroll and a tap that opens the bar");
    }
    await metrics(PHONE);
  });

  /** Puts the sixth chart row right below the open top bar, with the scroll stopped. */
  async function sixthBelowBar() {
    await page(`(() => { const el = document.getElementById("sheet-scroll"); const row = window.__look.rows()[5]; el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top; })()`);
    await sleep(200);
    await settle();
    if (await page<boolean>(`!!document.querySelector(".song-chrome-bar[data-folded]")`)) await tap(".shell-title");
    await sleep(200);
    await page(`(() => { const el = document.getElementById("sheet-scroll"); const row = window.__look.rows()[5]; el.scrollTop += row.getBoundingClientRect().top - window.__look.sheetTop(); })()`);
    await sleep(200);
    await settle();
  }
  const sixth = () => page<{ top: number; height: number; words: string }>(`(() => { const row = [...window.__look.rows()].find((r) => r.textContent.includes(${js(rowWords(5))})); const r = row.getBoundingClientRect(); return { top: r.top - window.__look.sheetTop(), height: r.height, words: row.textContent.trim() }; })()`);

  it("T4 the reading row", async () => {
    for (const [name, open, larger, smaller] of [
      ["#/song with the top bar buttons", () => solo(SOLO_SONG), H_LARGER, H_SMALLER],
      ["the leader's gig sheet with the corner buttons", () => asLeader(), C_LARGER, C_SMALLER],
    ] as const) {
      await metrics(SMALL);
      await open();
      await sixthBelowBar();
      if (!(await need(larger, `${name}: A+`))) continue;
      const start = await sixth();
      await tap(larger);
      await sleep(300);
      const up = await sixth();
      check(Math.abs(up.top - start.top) <= up.height, `on ${name} A+ leaves the sixth row within one row height (${start.top.toFixed(1)} → ${up.top.toFixed(1)}, row ${up.height.toFixed(1)} px)`);
      await sixthBelowBar();
      const mid = await sixth();
      await tap(smaller);
      await sleep(300);
      const down = await sixth();
      check(Math.abs(down.top - mid.top) <= mid.height, `on ${name} A− leaves it within one row height (${mid.top.toFixed(1)} → ${down.top.toFixed(1)}, row ${mid.height.toFixed(1)} px)`);
    }
    // Guard: with auto-scroll running on #/song, A+ from the opened bar does not stop the scroll and the row holds.
    await solo(SOLO_SONG);
    await page(`document.querySelector(".scroll-pill").click()`);
    const from = await scrollTop();
    await until("the scroll to run", scrollTop, (top) => top > from + 30, 10_000);
    await tap(".shell-title");
    const was = await page<{ top: number; height: number; at: number }>(`(() => { const row = window.__look.rows().find((r) => r.getBoundingClientRect().top > window.__look.sheetTop()); window.__held = row; const r = row.getBoundingClientRect(); return { top: r.top - window.__look.sheetTop(), height: r.height, at: performance.now() }; })()`);
    await tap(H_LARGER);
    const is = await page<{ top: number; at: number }>(`(() => { const r = window.__held.getBoundingClientRect(); return { top: r.top - window.__look.sheetTop(), at: performance.now() }; })()`);
    const going = await page<boolean>(`document.querySelector(".scroll-pill").getAttribute("aria-pressed") === "true"`);
    const t0 = await scrollTop();
    await sleep(600);
    check(going && (await scrollTop()) > t0, "guard: with auto-scroll running, an A+ tap does not stop the scroll");
    check(Math.abs(is.top - was.top) <= was.height + 60 * ((is.at - was.at) / 1000), `guard: with auto-scroll running the row holds within a row height plus the scroll's own travel (${was.top.toFixed(1)} → ${is.top.toFixed(1)})`);
    await metrics(PHONE);
  });

  it("T5 the title cap", async () => {
    for (const [name, open, larger, smaller] of [
      ["#/song", () => solo(SOLO_SONG), H_LARGER, H_SMALLER],
      ["the leader's gig sheet", () => asLeader(), C_LARGER, C_SMALLER],
    ] as const) {
      await open();
      if (!(await need(larger, `${name}: A+`))) continue;
      const at100 = await titleFont();
      await tap(larger);
      const at115 = { title: await titleFont(), row: await rowFont() };
      await tap(larger);
      await tap(larger);
      const at150 = { title: await titleFont(), row: await rowFont() };
      check(Math.abs(at150.title - at115.title) < 0.01, `on ${name} three A+ taps from 1.0 leave the title at its 1.15 size (${at100} → ${at115.title} → ${at150.title} px)`);
      check(at150.row > at115.row, `on ${name} the chart rows keep growing past 1.15 (${at115.row} → ${at150.row} px)`);
      for (let i = 0; i < 4; i += 1) await tap(smaller);
      const at85 = await titleFont();
      check(at85 < at115.title, `on ${name} at 0.85 the title is smaller than at 1.15 (${at85} < ${at115.title})`);
    }
  });

  it("H1 the leader's top bar end", async () => {
    try {
      for (const phone of PHONES) {
        await metrics(phone);
        await asMember();
        const member = { more: await box(".song-header > .menu-anchor"), title: await box(".song-header > .shell-title"), bar: await box(".song-header") };
        await asLeader();
        const leader = { more: await box(".song-header > .menu-anchor"), title: await box(".song-header > .shell-title"), bar: await box(".song-header") };
        if (!check(!!(member.more && member.title && member.bar && leader.more && leader.title && leader.bar), `at ${phone.width} px both gig sheets have a top bar with a title and •••`)) continue;
        check(Math.abs(leader.more!.right - member.more!.right) <= 1, `at ${phone.width} px the leader's ••• ends where the member's does (${leader.more!.right} against ${member.more!.right})`);
        check(leader.title!.width > member.title!.width, `at ${phone.width} px the leader's title takes the room A− A+ left (${leader.title!.width} against ${member.title!.width} px)`);
        check(leader.more!.x - leader.title!.right <= member.more!.x - member.title!.right + 1, `at ${phone.width} px no empty track sits between the leader's title and ••• (${leader.more!.x - leader.title!.right} px)`);
      }
    } finally {
      await metrics(PHONE);
    }
  });

  it("H2 the leader's top bar while locked or a panel is open", async () => {
    await asLeader();
    if (!(await need(TEXT_PAIR, "the leader's text pair"))) return;
    const look = async () => ({ more: (await box(".song-header > .menu-anchor"))?.right, room: await page<string>(`getComputedStyle(document.querySelector(".sheet")).paddingBottom`) });
    const was = await look();
    const same = async (when: string) => {
      check(!(await shown(H_SMALLER)) && !(await shown(H_LARGER)), `${when}, the leader's top bar shows no A− A+`);
      const now = await look();
      check(now.more === was.more && now.room === was.room, `${when}, the leader's ••• and the sheet's bottom room stay put (••• right ${was.more} → ${now.more}, room ${was.room} → ${now.room})`);
    };
    await tap('[data-stage="lock"]');
    await same("locked");
    await hold('[data-stage="unlock"]');
    await settle();
    for (const [open, name] of [['[data-stage="more"]', "•••"], ['[data-stage="edit-order"]', "Order"]]) {
      await tap(open);
      await until(`the ${name} panel`, () => has("[data-stage-menu], [data-stage-order]"), Boolean);
      await same(`with ${name} open`);
      await tap('[data-stage="cancel"]');
    }
  });

  it("H3 the speed pair with its percent showing", async () => {
    try {
      for (const phone of PHONES) {
        await metrics(phone);
        await asLeader({ scrollAlong: true });
        await countIn();
        if (!(await need(FASTER, `at ${phone.width} px Scroll faster`))) continue;
        for (let i = 0; i < 10; i += 1) await tap(FASTER);
        check((await text(PERCENT)) === "150%", `at ${phone.width} px the label reads 150% (${await text(PERCENT)})`);
        const pair = (await box(SPEED_PAIR))!;
        const label = await box(PERCENT);
        const textPair = (await box(TEXT_PAIR))!;
        if (!check(!!label, `at ${phone.width} px the percent label is on screen`)) continue;
        const both = { x: Math.min(pair.x, label!.x), right: Math.max(pair.right, label!.right), y: Math.min(pair.y, label!.y), bottom: Math.max(pair.bottom, label!.bottom) };
        const width = both.right - both.x;
        check(width <= phone.width / 3, `at ${phone.width} px the speed pair with its label is at most a third of the screen wide (${width})`);
        check(!meets(label!, textPair), `at ${phone.width} px the label does not meet the text pair`);
        const sheet = (await box("#sheet-scroll"))!;
        const covered = textPair.width * textPair.height + width * (both.bottom - both.y);
        const share = covered / (sheet.width * sheet.height);
        console.log(`       at ${phone.width} x ${phone.height} with the label showing the pairs cover ${Math.round(covered)} px² (${(share * 100).toFixed(1)}%)`);
        if (phone === SMALL) check(share <= 0.15, `at 360 x 740 with the label showing the pairs cover at most 15% of the sheet's visible box (${(share * 100).toFixed(1)}%)`);
      }
    } finally {
      await metrics(PHONE);
    }
  });

  it("H4 one line off the gig (guard)", async () => {
    try {
      for (const phone of PHONES) {
        await metrics(phone);
        await asMember();
        const gigBar = (await box(".song-header"))!.height;
        for (const hash of [SOLO_SONG, SOLO_LIVE]) {
          await page(`window.__boot(${js({ me: null, hash, songs: SONGS, own: [song(11), song(9)] })})`);
          await until("the sheet", () => has(".sheet .sheet-name"), Boolean);
          await settle();
          const name = await text(".sheet .sheet-name");
          const title = await page<{ text: string; lines: number }>(`({ text: document.querySelector(".song-header .shell-title").textContent, lines: window.__look.lines(document.querySelector(".song-header .shell-title")) })`);
          const bar = (await box(".song-header"))!.height;
          console.log(`       at ${phone.width} px ${hash} on ${js(name)}: the top bar reads ${js(title.text)}, ${title.lines} line, ${bar} px`);
          check(title.lines === 1 && bar === gigBar, `at ${phone.width} px ${hash}'s top bar is one line and as tall as the gig sheet's (${title.lines} lines, ${bar} against ${gigBar} px)`);
        }
      }
    } finally {
      await metrics(PHONE);
    }
  });

  it("H5 lock and panels while the sheet scrolls", async () => {
    await asLeader({ scrollAlong: true });
    await countIn();
    if (!(await need(FASTER, "while the band scroll runs, Scroll faster"))) return;
    await tap(FASTER);
    await tap(FASTER);
    const both = async (when: string) => {
      check((await shown(TEXT_PAIR)) && (await shown(SPEED_PAIR)), `${when}, both pairs are back`);
      check((await text(PERCENT)) === "110%", `${when}, the live speed is still 110% (${js(await text(PERCENT))})`);
    };
    await tap('[data-stage="lock"]');
    check(!(await has(TEXT_PAIR)) && !(await has(SPEED_PAIR)), "locked while the sheet scrolls, the text pair and the speed pair are gone");
    await hold('[data-stage="unlock"]');
    await settle();
    await both("held to unlock");
    for (const [open, name] of [['[data-stage="more"]', "•••"], ['[data-stage="edit-order"]', "Order"]]) {
      await tap(open);
      await until(`the ${name} panel`, () => has("[data-stage-menu], [data-stage-order]"), Boolean);
      check(!(await has(TEXT_PAIR)) && !(await has(SPEED_PAIR)), `with ${name} open while the sheet scrolls, the text pair and the speed pair are gone`);
      await tap('[data-stage="cancel"]');
      await both(`after Close on ${name}`);
    }
  });

  it("H6 no message of any kind leaves", async () => {
    await asLeader({ scrollAlong: true });
    await countIn();
    if (!(await need(FASTER, "while the band scroll runs, Scroll faster")) || !(await need(C_LARGER, "the corner Larger text"))) return;
    await sleep(500);
    await page(`(() => {
      const hub = window.__hub;
      hub.all = [];
      for (const [who, room] of hub.rooms) {
        if (who !== "terry" || room.__seen) continue;
        const send = room.send.bind(room);
        room.send = (m) => { hub.all.push(m.kind === "link" && m.body && m.body.k === "ping" ? "ping" : m.kind + (m.body && m.body.k ? ":" + m.body.k : "")); return send(m); };
        room.__seen = true;
      }
      performance.clearResourceTimings();
      window.__asked = [];
      new PerformanceObserver((list) => window.__asked.push(...list.getEntries().map((e) => e.name))).observe({ type: "resource" });
    })()`);
    for (let i = 0; i < 4; i += 1) await tap(FASTER);
    for (let i = 0; i < 2; i += 1) await tap(SLOWER);
    await tap(C_LARGER);
    await tap(C_SMALLER);
    await tap(C_LARGER);
    await sleep(500);
    const kinds = await page<string[]>(`window.__hub.all.filter((k) => k !== "ping")`);
    const pings = await page<number>(`window.__hub.all.filter((k) => k === "ping").length`);
    const asked = await page<string[]>(`[...window.__asked, ...performance.getEntriesByType("resource").map((e) => e.name)]`);
    console.log(`       across the taps the leader's room sent ${js(kinds)} besides ${pings} clock pings; the page asked for ${js(asked)}`);
    check(kinds.length === 0, `the leader's room sent nothing but clock pings across the taps (${js(kinds)})`);
    check(asked.length === 0, `the page asked the network for nothing across the taps (${js(asked)})`);
  });

  it("H7 the corner A+ while the band scroll runs", async () => {
    await metrics(SMALL);
    try {
      await asLeader({ scrollAlong: true });
      await countIn();
      if (!(await need(C_LARGER, "while the band scroll runs, the corner Larger text"))) return;
      await until("the band scroll to pass the first rows", scrollTop, (top) => top > 120, 20_000);
      const before = await rate();
      const was = await page<{ top: number; height: number; at: number; scroll: number }>(`(() => { const row = window.__look.rows().find((r) => r.getBoundingClientRect().top > window.__look.sheetTop() + 40); window.__held = row; const r = row.getBoundingClientRect(); return { top: r.top - window.__look.sheetTop(), height: r.height, at: performance.now(), scroll: document.getElementById("sheet-scroll").scrollTop }; })()`);
      await press(C_LARGER, TAP_MS);
      const seen = await page<{ top: number; at: number; height: number }[]>(`new Promise((done) => {
        const out = [];
        const start = performance.now();
        const frame = () => {
          const r = window.__held.getBoundingClientRect();
          out.push({ top: r.top - window.__look.sheetTop(), at: performance.now(), height: r.height });
          if (performance.now() - start < 1500) requestAnimationFrame(frame); else done(out);
        };
        requestAnimationFrame(frame);
      })`);
      check((await sheetFont()) === "18.4px", `the corner A+ took the sheet to 18.4 px (${await sheetFont()})`);
      const after = await rate();
      console.log(`       band scroll ${before.rate.toFixed(1)} px/s before the tap, ${after.rate.toFixed(1)} px/s after; the row ${was.top.toFixed(1)} px below the bar, then ${seen.filter((_, i) => i % 15 === 0).map((s) => s.top.toFixed(1)).join(", ")}`);
      check(before.rate > 2 && after.rate > 2 && (await shown(SPEED_PAIR)), `the corner A+ does not stop the band scroll (${before.rate.toFixed(1)} → ${after.rate.toFixed(1)} px/s, speed pair ${await shown(SPEED_PAIR)})`);
      const off = seen.filter((s) => {
        const travel = 1.5 * Math.max(before.rate, after.rate) * ((s.at - was.at) / 1000);
        const delta = s.top - was.top;
        return delta > s.height || delta < -(s.height + travel);
      });
      check(seen.length > 30 && off.length === 0, `on every frame of the 1.5 s after the tap the row holds within a row height plus the band scroll's own travel (${off.length} of ${seen.length} frames off${off[0] ? `, first at ${off[0].top.toFixed(1)} px against ${was.top.toFixed(1)}` : ""})`);
    } finally {
      await metrics(PHONE);
    }
  });

  it("H8 the live speed ends with the lead", async () => {
    /**
     * Terry leads, counts in, taps Scroll faster `taps` times, and loses the lead: he hands it to Sam, or Mike, the backup,
     * takes it over. Once Terry's phone hears the band clock from the new leader, returns 12 s of his sheet's scrollTop
     * against band seconds since the scroll's start.
     */
    const leadLost = async (how: "hand-off" | "take-over", taps: number) => {
      const to = how === "hand-off" ? "sam" : "mike";
      await asLeader({ scrollAlong: true });
      await countIn();
      if (!(await need(FASTER, "while the band scroll runs, Terry's Scroll faster"))) return null;
      await until("Sam's band clock", () => page<number | null>("window.__follower.bandNow()"), (t) => t !== null, 20_000);
      if (how === "take-over") {
        await page("window.__backup()");
        await until("Mike's band clock", () => page<number | null>("window.__mike.bandNow()"), (t) => t !== null, 20_000);
      }
      for (let i = 0; i < taps; i += 1) await tap(FASTER);
      await sleep(2000);
      if (how === "hand-off") {
        await tap('[data-stage="more"]');
        await tap('[data-stage="hand-off"]');
        await until("the hand-off list", () => has('[data-stage-to="sam"]'), Boolean);
        await hold('[data-stage-to="sam"]');
        await until("the ask to reach Sam", () => followerState(), (state) => state?.handoff?.to === "sam");
      }
      const took = await page<any>(how === "hand-off" ? `window.__follower.tap({ kind: "accept" })` : `window.__mike.tap({ kind: "takeOver" })`);
      check(took?.ok === true, `${to} takes the lead by ${how} (${js(took?.refused ?? took?.ok)})`);
      await until(`Terry's phone to hear ${to} leads`, () => leaderState(), (state) => state?.leader === to);
      await until("Terry's stage bar to go", () => has(BAR), (there) => !there, 4000);
      check(!(await has(CORNERS)), `once ${to} leads by ${how}, Terry has no speed pair to see or reset the speed with`);
      const ticking = `new Promise((done) => { const s = window.__session(); const a = s.bandNow(); setTimeout(() => done(a !== null && s.bandNow() > a), 300); })`;
      await until(`Terry's band clock to run from ${to}`, () => page<boolean>(ticking), Boolean, 30_000);
      await sleep(1000);
      const samples = await page<[number, number][]>(`new Promise((done) => {
        const s = window.__session();
        const from = s.view().state.scroll.at(-1).value.startAt;
        const el = document.getElementById("sheet-scroll");
        const out = [];
        const take = () => {
          out.push([(s.bandNow() - from) / 1000, el.scrollTop]);
          if (out.length < 48) setTimeout(take, 250); else done(out);
        };
        take();
      })`);
      if (how === "take-over") await page("window.__mike.close()");
      return samples;
    };
    /** scrollTop at band second `t`, read off the samples in a straight line between the two around it. */
    const at = (samples: [number, number][], t: number) => {
      const i = samples.findIndex(([s]) => s >= t);
      if (i <= 0) return samples[Math.max(i, 0)][1];
      const [[t0, y0], [t1, y1]] = [samples[i - 1], samples[i]];
      return y0 + ((y1 - y0) * (t - t0)) / (t1 - t0);
    };
    for (const how of ["hand-off", "take-over"] as const) {
      const plain = await leadLost(how, 0);
      const sped = await leadLost(how, 4);
      if (!plain || !sped) continue;
      const from = Math.max(plain[0][0], sped[0][0]);
      const to = Math.min(plain[plain.length - 1][0], sped[sped.length - 1][0]);
      const slope = (samples: [number, number][]) => (at(samples, to) - at(samples, from)) / (to - from);
      const ratio = slope(sped) / slope(plain);
      console.log(`       after the ${how}, over band ${from.toFixed(1)}-${to.toFixed(1)} s Terry's sheet moves ${slope(plain).toFixed(1)} px/s after leading at 100%, ${slope(sped).toFixed(1)} px/s after leading at 120%`);
      check(to - from >= 6 && slope(plain) > 2, `after the ${how} the two runs share at least 6 band seconds of a moving sheet (${(to - from).toFixed(1)} s, ${slope(plain).toFixed(1)} px/s)`);
      check(Math.abs(ratio - 1) <= 0.05, `after the ${how}, Terry's sheet moves at the band's own pace whatever speed he led at, within 0.05 (${ratio.toFixed(3)})`);
    }
  });

  it("G1 guard", async () => {
    const lines = readFileSync(join(root, "src", "App.tsx"), "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
    check(lines <= APP_LINES, `src/App.tsx has ${lines} lines, at most the ${APP_LINES} it has on origin/mls-int-20261113`);
  });

  // CHECK_GIG_CORNERS_ONLY=<words> runs the cases whose name holds them, for working on one.
  const only = process.env.CHECK_GIG_CORNERS_ONLY;
  for (const [name, body] of cases) {
    if (only && !only.split(",").some((part) => name.startsWith(part))) continue;
    const before = failures;
    let reason = "";
    try {
      await body();
    } catch (error) {
      failures += 1;
      reason = (error as Error).message;
    }
    if (failures === before) console.log(`ok   ${name}`);
    else console.log(`FAIL ${name}: ${reason || "see the FAIL lines above"}`);
  }
}

await main().catch((error) => {
  failures += 1;
  console.log(`FAIL check:gig-corners could not run: ${(error as Error).stack ?? error}`);
});
if (failures > 0) {
  console.log(`check:gig-corners: ${failures} FAIL`);
  process.exit(1);
}
console.log("check:gig-corners passed");
