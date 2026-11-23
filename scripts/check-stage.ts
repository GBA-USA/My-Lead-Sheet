/**
 * check:stage (C22, PLAN.md 8.2 steps 11-16, 8.3). The leader's stage bar in a live gig, driven through the real App in
 * headless Chrome at 390×844. App's `./gig-live.tsx` import is wrapped only to hand `useGigStage` stand-in deps, so the
 * real `useLiveGig`, `liveGig`, `gigSync`, `reduce` and strip run. The band room is a page-side stand-in that speaks the
 * room's messages (hello, join-gig, gig-state, gig-op, link pings), and a second phone in the same page, Sam, follows the
 * gig through it on the server route, so "every phone flips" is read from a real follower's state.
 *
 * Every control is pressed with DevTools mouse events at its own box. A hold is 650 ms down, a tap 60 ms.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { openSite, type Site } from "./chrome.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const HOLD_MS = 650;
const TAP_MS = 60;
const LEAD_MS = 150;
const BPM = 60;
const BEAT_MS = 60_000 / BPM;
const BAR_MS = BEAT_MS * 4;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const js = (value: unknown) => JSON.stringify(value);

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
}

/**
 * The solo `#/live/1/0` bar as the base tree (156b186) renders it at 390×844: its markup and every child's height. The
 * plan's "32 px" is older than the tree, where the UX pass already made these 64 px (`--touch-stage`), so the vdiff holds
 * the bar to the base as it is.
 */
const SOLO_NAV = {
  html: '<nav class="live-nav" aria-label="Set"><button type="button" class="stage-step" aria-label="Previous song" disabled="">Prev</button><div class="stage-middle"><button type="button" class="scroll-pill" aria-pressed="false">Scroll: Off</button><span class="live-count">Worship Set · 1/4</span></div><button type="button" class="stage-step" aria-label="Next song">Next</button></nav>',
  heights: [64, 64, 64],
  navHeight: 98,
};

const library = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: Record<string, unknown>[] };
const content = (title: string) => {
  const { ref: _ref, id: _id, copy: _copy, ...song } = library.songs.find((each) => each.title === title)! as Record<string, unknown> & { body: unknown[] };
  return { ...song, tempo: BPM, timeSignature: "4/4", body: [...song.body, ...song.body] };
};
const SONGS = [
  { songId: "s_bayou", song: content("Born on the Bayou"), bandTiming: null },
  { songId: "s_brown", song: content("Brown Eyed Girl"), bandTiming: null },
  { songId: "s_reason", song: content("Give Me One Reason"), bandTiming: null },
];

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
  import { startGig, reduce, position } from "./src/gig-state.ts";
  import * as stage from "./src/stage-bar.tsx";
  import "./src/styles.css";

  const w = window;
  const GIG = "gig_stage";
  const BAND = "band_stage";
  const localNow = () => performance.timeOrigin + performance.now();
  w.__stage = stage;
  w.__pure = { startGig, reduce, position };

  const hub = { held: null, sends: [], down: new Set(), rooms: new Map() };
  w.__hub = hub;
  function fakeRoom(me) {
    const listeners = new Set();
    const tell = (m) => [...listeners].forEach((cb) => cb(m));
    const later = (run) => setTimeout(() => { if (!hub.down.has(me)) run(); }, 5);
    const room = {
      get state() { return hub.down.has(me) ? "down" : "open"; },
      send(m) {
        if (hub.down.has(me)) return false;
        if (m.kind === "join-gig") later(() => tell({ kind: "gig", gigId: GIG, you: me + "-sock", leader: hub.held ? hub.held.leader + "-sock" : null, openedAt: 0 }));
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
    screenOn: async () => (w.__wake ? () => {} : null),
  };

  // Every text the landing chip shows, in order, so a "Now" that lasts one lead (150 ms) is still seen.
  w.__chips = [];
  new MutationObserver(() => {
    const chip = document.querySelector("[data-stage-chip]");
    const text = chip ? chip.textContent : null;
    if (w.__chips[w.__chips.length - 1] !== text) w.__chips.push(text);
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });

  let mounted = null;
  w.__boot = (cfg) => {
    if (mounted) mounted.unmount();
    if (w.__follower) w.__follower.close();
    w.__follower = null;
    for (const room of [...hub.rooms.values()]) room.close();
    hub.sends = [];
    hub.down = new Set();
    w.__chips = [];
    w.__me = cfg.me;
    w.__wake = cfg.wake !== false;
    // A fresh phone each boot: the click question is asked once per account, and its answer lives in localStorage.
    localStorage.clear();
    if (cfg.me) localStorage.setItem("leadSheetsSignedIn", cfg.me);
    const songs = cfg.songs;
    w.__pack = { gig: null, songs, scrollWithLeader: false, secret: null, packRev: 1, expiresAt: null };
    w.__gig = { gigId: GIG, bandId: BAND, setlistId: "set_stage", name: "Friday at the Elks", date: "2026-11-23", lineup: ["terry", "mike", "sam", "ann"], leader: "terry", backup: "mike", route: "auto", status: "live" };
    w.__pack.gig = w.__gig;
    hub.held = startGig({ gigId: GIG, order: songs.map((s) => s.songId), leader: "terry", admin: "ann", backup: "mike", lineup: ["terry", "mike", "sam", "ann"], route: "auto", scrollAlong: false, now: localNow() });
    history.replaceState(null, "", cfg.hash);
    mounted = createRoot(document.getElementById("root"));
    mounted.render(<App />);
  };
  w.__follow = () => {
    w.__follower = liveGig({ me: "sam", gigId: GIG, room: fakeRoom("sam"), stun: [], rows: ["server"] });
  };
  w.__session = () => (w.__live && w.__live.joined ? w.__live.joined.session : null);
  w.__now = () => localNow();
  w.__leaderState = () => { const s = w.__session(); return s ? s.view().state : null; };
  w.__followerState = () => (w.__follower ? w.__follower.view().state : null);
  w.__at = (state, t) => (state ? position(state, t) : null);
  w.__ops = (me) => hub.sends.filter((s) => s.kind === "gig-op" && (!me || s.me === me)).map((s) => s.op);

  // Busy frames for the Low Power Mode case: each frame's callback holds the main thread for ms, n times.
  w.__slowFrames = (ms, n) => new Promise((done) => {
    let left = n;
    const tick = () => { const until = performance.now() + ms; while (performance.now() < until) {} if (--left > 0) requestAnimationFrame(tick); else done(null); };
    requestAnimationFrame(tick);
  });
`;

/** App imports "./gig-live.tsx"; only that import is swapped, for the wrapper above. */
const wrapLive: Plugin = {
  name: "stage-deps",
  setup(b) {
    b.onResolve({ filter: /gig-live\.tsx$/ }, (args) => (args.importer.endsWith("App.tsx") ? { path: "stage-wrap", namespace: "stage" } : undefined));
    b.onLoad({ filter: /.*/, namespace: "stage" }, () => ({ contents: WRAP, resolveDir: root, loader: "tsx" }));
  },
};

type Box = { x: number; y: number; width: number; height: number } | null;

async function main() {
  const bundled = await build({
    stdin: { contents: HARNESS, resolveDir: root, loader: "tsx", sourcefile: "stage-harness.tsx" },
    bundle: true,
    write: false,
    outdir: join(root, ".stage-harness"),
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

  const site = await openSite(root, "check-stage");
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
  // The app's own page with its script held back gives the harness a real origin, with localStorage, that the app never ran on.
  await send("Emulation.setScriptExecutionDisabled", { value: true });
  const loaded = new Promise((resolve) => setTimeout(resolve, 1500));
  await send("Page.navigate", { url: `${site.origin}/?stage-harness` });
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
  const box = (selector: string) =>
    page<Box>(`(() => { const el = document.querySelector(${js(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()`);
  const text = (selector: string) => page<string | null>(`document.querySelector(${js(selector)})?.textContent ?? null`);
  const has = (selector: string) => page<boolean>(`!!document.querySelector(${js(selector)})`);
  const mouse = (type: string, x: number, y: number) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "mouse" });
  async function press(selector: string, ms: number, during?: () => Promise<void>) {
    const at = await box(selector);
    if (!at) throw new Error(`no ${selector} on screen`);
    const x = at.x + at.width / 2;
    const y = at.y + at.height / 2;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await mouse("mousePressed", x, y);
    const start = Date.now();
    if (during) await during();
    await sleep(Math.max(0, ms - (Date.now() - start)));
    await mouse("mouseReleased", x, y);
  }
  const hold = (selector: string, during?: () => Promise<void>) => press(selector, HOLD_MS, during);
  const tap = (selector: string) => press(selector, TAP_MS);
  const click = (selector: string) => page<boolean>(`(() => { const el = document.querySelector(${js(selector)}); if (!el) return false; el.click(); return true; })()`);
  const ops = (me = "terry") => page<{ kind: string; [key: string]: unknown }[]>(`window.__ops(${js(me)})`);
  const chips = () => page<(string | null)[]>("window.__chips");
  const title = () => text(".shell-title");
  const followerAt = (t: number) => page<{ song: { key: string }; section: number | null; beat: unknown } | null>(`window.__at(window.__followerState(), ${t})`);
  const leaderState = () => page<any>("window.__leaderState()");
  const followerState = () => page<any>("window.__followerState()");
  const now = () => page<number>("window.__now()");
  const latestGrid = (state: any) => state.click[state.click.length - 1].value as { bpm: number; beatsPerBar: number; startAt: number; firstBar: number } | null;
  const gridAt = (state: any, t: number) => {
    let grid = null;
    for (const step of state.click) if (step.at <= t) grid = step.value;
    return grid as { bpm: number; beatsPerBar: number; startAt: number; firstBar: number } | null;
  };
  const onBarLine = (grid: { startAt: number; bpm: number; beatsPerBar: number }, t: number) => {
    const bar = (60_000 / grid.bpm) * grid.beatsPerBar;
    const off = (((t - grid.startAt) % bar) + bar) % bar;
    return Math.min(off, bar - off) < 1;
  };

  /** Boots the App as `me`, joins the live gig through the strip, answers the click question, and waits for the gig sheet. */
  async function joinAs(me: string, options: { songs?: typeof SONGS; wake?: boolean; follower?: boolean } = {}) {
    await page(`window.__boot(${js({ me, hash: "#/bands", songs: options.songs ?? SONGS, wake: options.wake })})`);
    await until("Join gig on the strip", () => page<boolean>(`[...document.querySelectorAll(".gig-strip button")].some((b) => b.textContent === "Join gig")`), Boolean);
    await page(`[...document.querySelectorAll(".gig-strip button")].find((b) => b.textContent === "Join gig").click()`);
    await until("the click question", () => page<boolean>(`[...document.querySelectorAll(".gig-question button")].some((b) => b.textContent === "Dot only")`), Boolean);
    await page(`[...document.querySelectorAll(".gig-question button")].find((b) => b.textContent === "Dot only").click()`);    await until("the gig sheet", () => page<string>("location.hash"), (hash) => hash.startsWith("#/gig/band_stage/gig_stage/0"));
    await until(`${me}'s session has the gig state`, () => leaderState(), (state) => state !== null);
    if (options.follower !== false) {
      await page("window.__follow()");
      await until("Sam's phone has the gig state", () => followerState(), (state) => state !== null);
    }
  }
  const asLeader = (options: { songs?: typeof SONGS; wake?: boolean; follower?: boolean } = {}) =>
    joinAs("terry", options).then(() => until("the stage bar", () => has("[data-stage-bar]"), Boolean));

  /** Holds Count in with no click running, and waits until the band's click has started. */
  async function startClick() {
    await hold('[data-stage="count-in"]');
    await until("the click to start", () => leaderState(), (state) => latestGrid(state) !== null);
    const grid = latestGrid(await leaderState())!;
    await until("the count-in to land", now, (t) => t > grid.startAt + 50);
    return grid;
  }
  /** Waits for a band moment just after a bar line, so a hold that starts now lands on the next bar line, about a bar away. */
  async function afterBarLine(grid: { startAt: number }, plusMs = 30) {
    const t = await now();
    const into = (((t - grid.startAt) % BAR_MS) + BAR_MS) % BAR_MS;
    await sleep(BAR_MS - into + plusMs);
  }

  const cases: [string, () => Promise<void>][] = [];
  const it = (name: string, body: () => Promise<void>) => cases.push([name, body]);

  it("a tap on hold-Next shows 'Hold to move the band' and moves nobody", async () => {
    await asLeader();
    const before = await title();
    await tap('[data-stage="next"]');
    const note = await until("the hint", () => text("[data-stage-note]"), (words) => words === "Hold to move the band", 2000).catch(() => text("[data-stage-note]"));
    check(note === "Hold to move the band", `a 60 ms tap on Next says "Hold to move the band" (saw ${js(note)})`);
    await sleep(LEAD_MS + 400);
    check((await ops()).length === 0, `the tap sent no op (sent ${js(await ops())})`);
    check((await title()) === before, `the leader's chart stays on its song (${js(before)} → ${js(await title())})`);
    const follower = await followerAt(await now());
    check(follower?.song.key === "s_bayou", `Sam's phone stays on song 1 (${js(follower?.song.key)})`);
  });

  it("a 0.5 s hold moves the band and the chip names the beat it lands on", async () => {
    await asLeader();
    const grid = await startClick();
    await afterBarLine(grid);
    let ringRunning = false;
    await hold('[data-stage="next"]', async () => {
      await sleep(200);
      ringRunning = await page<boolean>(`(() => { const el = document.querySelector('[data-stage="next"]'); return !!el && el.classList.contains("is-holding") && el.getAnimations({ subtree: true }).some((a) => a.playState === "running"); })()`);
    });
    check(ringRunning, "while held, hold-Next is marked is-holding and its ring is a running CSS animation");
    const sent = await ops();
    const goTo = sent.filter((op) => op.kind === "goTo");
    check(goTo.length === 1 && goTo[0].key === "s_brown", `the hold sent one goTo to song 2 (sent ${js(sent)})`);
    const state = await leaderState();
    const at = state.last?.at as number;
    check(onBarLine(grid, at) && at - state.changedAt >= LEAD_MS && at - state.changedAt <= LEAD_MS + BAR_MS, `the move lands on the next bar line at least the lead ahead (lands ${at - state.changedAt} ms after the hold)`);
    const chip = await text("[data-stage-chip]");
    check(chip === "On 1 ▸", `the chip names the beat it lands on: "On 1 ▸" (saw ${js(chip)})`);
    check((await title())?.startsWith("1 of 3") ?? false, `before the landing the leader's chart is still song 1 (${js(await title())})`);
    const f = await until("Sam's phone to hear the move", () => followerState(), (s) => s?.rev === state.rev);
    check((await followerAt(at - 5))?.song.key === "s_bayou" && (await followerAt(at + 5))?.song.key === "s_brown", "Sam's phone flips to song 2 at the landing, not before");
    check(f.last?.at === at, "Sam's phone holds the same landing time");
    await until("the landing", now, (t) => t > at + 100);
    const after = await until("the leader's chart to flip", title, (words) => words?.startsWith("2 of 3") ?? false, 3000).catch(title);
    check(after?.startsWith("2 of 3") ?? false, `after the landing the leader's chart is song 2 (${js(after)})`);
  });

  it("every stage bar target is at least 56 px tall", async () => {
    await asLeader();
    await startClick();
    await hold('[data-stage="next"]');
    const sizes = await page<{ name: string; height: number }[]>(
      `[...document.querySelectorAll("[data-stage-bar] button")].filter((b) => b.getBoundingClientRect().height > 0).map((b) => ({ name: b.dataset.stage ?? b.textContent, height: b.getBoundingClientRect().height }))`,
    );
    const names = sizes.map((s) => s.name);
    for (const need of ["prev", "next", "count-in", "stop", "slower", "faster", "undo", "edit-order", "lock", "more", "section"]) check(names.includes(need), `the stage bar shows ${need}`);
    const small = sizes.filter((s) => s.height < 56);
    check(sizes.length >= 11 && small.length === 0, `all ${sizes.length} stage bar targets are at least 56 px tall (too small: ${js(small)})`);
    const bar = await box("[data-stage-bar]");
    check(!!bar && bar.y + bar.height <= PHONE.height + 0.5 && bar.y >= PHONE.height / 2, `the stage bar sits in the bottom half of the 844 px screen (${js(bar)})`);
  });

  it("Prev and Next show their whole label at 360 and 390 wide, with nothing pending and with a move pending", async () => {
    const cut = () =>
      page<{ what: string; text: string; out: boolean; w: string; h: string }[]>(`[...document.querySelectorAll(".stage-move > button")].map((b) => {
        const r = b.getBoundingClientRect();
        return { what: b.dataset.stage, text: b.textContent, out: r.left < -0.5 || r.right > innerWidth + 0.5, w: b.scrollWidth + "/" + b.clientWidth, h: b.scrollHeight + "/" + b.clientHeight, cut: b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1 };
      }).filter((b) => b.cut || b.out)`);
    try {
      for (const [width, height] of [[360, 780], [390, 844]]) {
        await send("Emulation.setDeviceMetricsOverride", { ...PHONE, width, height });
        await asLeader();
        const idle = await cut();
        check(idle.length === 0 && (await text('[data-stage="next"]')) === "Next: Brown Eyed Girl ▶", `at ${width} px, with nothing pending, Prev and "Next: Brown Eyed Girl ▶" are whole (cut: ${js(idle)})`);
        const grid = await startClick();
        await afterBarLine(grid);
        await hold('[data-stage="next"]');
        check(await has('[data-stage="undo"]') && await has("[data-stage-chip]"), `at ${width} px the pending move shows its chip and Undo`);
        const pending = await cut();
        check(pending.length === 0 && (await text('[data-stage="next"]')) === "Next: Give Me One Reason ▶", `at ${width} px, with Next pending, Prev and "Next: Give Me One Reason ▶" are whole (cut: ${js(pending)})`);
      }
    } finally {
      await send("Emulation.setDeviceMetricsOverride", PHONE);
    }
  });

  it("Undo within 5 s before the landing cancels and no phone flips", async () => {
    await asLeader();
    const grid = await startClick();
    await afterBarLine(grid);
    await hold('[data-stage="next"]');
    const moved = await leaderState();
    const at = moved.last.at as number;
    const shown = await box('[data-stage="undo"]');
    check(!!shown, "Undo shows after the hold");
    await tap('[data-stage="undo"]');
    const sent = await ops();
    const undo = sent.find((op) => op.kind === "undo");
    check(!!undo && undo.target === sent.find((op) => op.kind === "goTo")?.opId, `Undo sent an undo op for the goTo (sent ${js(sent.map((op) => op.kind))})`);
    const undone = await until("Sam's phone to hear the undo", () => followerState(), (s) => s?.rev === moved.rev + 1);
    check((await now()) < at, "the undo was sent before the landing");
    await until("the landing time to pass", now, (t) => t > at + 200);
    check((await page<any>(`window.__at(window.__followerState(), ${at + 100})`))?.song.key === "s_bayou", "Sam's phone never flips: still song 1 after the landing time");
    check(undone.current.every((step: { value: string }) => step.value === "s_bayou"), "Sam's phone holds no step to song 2");
    check((await title())?.startsWith("1 of 3") ?? false, `the leader's chart never flips (${js(await title())})`);
    check(!(await box('[data-stage="undo"]')), "Undo is gone once the move is undone");
  });

  it("Undo shows for at most 5 s and is gone once the move has landed", async () => {
    await asLeader();
    await hold('[data-stage="next"]');
    await sleep(LEAD_MS + 300);
    check(!(await box('[data-stage="undo"]')), "with no click the move lands after the lead, and Undo is gone after it lands");
    const { at } = (await leaderState()).last ?? { at: 0 };
    await sleep(5200);
    check(!(await box('[data-stage="undo"]')) && (await now()) > at, "5 s on, no Undo is offered");
  });

  it("Count in starts the click on the next bar and Stop ends click, dot and scroll at the next beat", async () => {
    await asLeader();
    await page("window.__chips = []");
    await hold('[data-stage="count-in"]');
    let state = await leaderState();
    const first = latestGrid(state)!;
    check(!!first && first.bpm === BPM && first.beatsPerBar === 4 && first.firstBar === -1, `Count in sends a one-bar count-in at the song's ${BPM} bpm in 4/4 (${js(first)})`);
    check(first.startAt - state.changedAt >= LEAD_MS - 1 && first.startAt - state.changedAt <= LEAD_MS + 20, `with no click running it starts one lead after the hold (${first.startAt - state.changedAt} ms)`);
    check((await chips()).includes("Now"), `with no click running the chip says "Now" (saw ${js(await chips())})`);
    const f = await until("Sam's phone to hear the count-in", () => followerState(), (s) => s?.rev === state.rev);
    check(js(latestGrid(f)) === js(first), "Sam's phone clicks the same grid");
    await sleep(BEAT_MS * 1.3);
    await hold('[data-stage="count-in"]');
    state = await leaderState();
    const again = latestGrid(state)!;
    check(onBarLine(first, again.startAt) && again.startAt > state.changedAt, `Count in while the click runs starts on the next bar line (${again.startAt - first.startAt} ms into the first grid)`);
    check((await text("[data-stage-chip]")) === "On 1 ▸", `its chip says "On 1 ▸" (${js(await text("[data-stage-chip]"))})`);
    await until("the second count-in to land", now, (t) => t > again.startAt + 50);
    await sleep(BEAT_MS * 0.4);
    await hold('[data-stage="stop"]');
    state = await leaderState();
    const stopAt = state.last.at as number;
    const beats = (stopAt - again.startAt) / BEAT_MS;
    check(Math.abs(beats - Math.round(beats)) < 0.001 && stopAt - state.changedAt >= LEAD_MS && stopAt - state.changedAt <= LEAD_MS + BEAT_MS, `Stop lands on the next beat (${beats.toFixed(3)} beats into the grid, ${stopAt - state.changedAt} ms after the hold)`);
    const beatNo = (((Math.round(beats) % 4) + 4) % 4) + 1;
    check((await text("[data-stage-chip]")) === `On ${beatNo} ▸`, `Stop's chip names that beat: "On ${beatNo} ▸" (${js(await text("[data-stage-chip]"))})`);
    const fs = await until("Sam's phone to hear Stop", () => followerState(), (s) => s?.rev === state.rev);
    check(gridAt(fs, stopAt - 1) !== null && gridAt(fs, stopAt) === null, "on Sam's phone the click runs up to the beat and ends on it");
    check((await page<any>(`window.__at(window.__followerState(), ${stopAt + 1})`)).beat === null && (await page<any>(`window.__at(window.__followerState(), ${stopAt + 1})`)).scroll === null, "Sam's dot and scroll have no beat after Stop lands");
    await until("Stop to land", now, (t) => t > stopAt + 50);
    const click = await page<any>("window.__session().click()");
    check(click[click.length - 1].value === null, "the leader's own click ends too");
  });

  it("− and + change the tempo from the next bar line and a second tap before it lands is computed from the pending grid", async () => {
    await asLeader();
    const grid = await startClick();
    check((await text("[data-stage-bpm]")) === String(BPM), `the stage bar shows ${BPM} bpm (${js(await text("[data-stage-bpm]"))})`);
    await afterBarLine(grid);
    await hold('[data-stage="faster"]');
    const one = await leaderState();
    const t1 = one.last.at as number;
    check(onBarLine(grid, t1) && latestGrid(one)!.bpm === BPM + 1, `+ sends ${BPM + 1} bpm from the next bar line (${js(latestGrid(one))})`);
    check((await text("[data-stage-chip]")) === "On 1 ▸", `its chip says "On 1 ▸" (${js(await text("[data-stage-chip]"))})`);
    await hold('[data-stage="faster"]');
    const two = await leaderState();
    check((await now()) < t1, "the second + was held before the first landed");
    const sent = (await ops()).filter((op) => op.kind === "tempo");
    check(sent.length === 2 && sent[1].bpm === BPM + 2, `the second + is computed from the pending ${BPM + 1} bpm grid, so it asks ${BPM + 2} (sent ${js(sent)})`);
    check(latestGrid(two)!.startAt === t1 && latestGrid(two)!.bpm === BPM + 2, `it lands on the same bar line as the first (${latestGrid(two)!.startAt - t1} ms apart)`);
    check((await text("[data-stage-bpm]")) === String(BPM + 2), `the stage bar shows the pending ${BPM + 2} bpm (${js(await text("[data-stage-bpm]"))})`);
    const f = await until("Sam's phone to hear both", () => followerState(), (s) => s?.rev === two.rev);
    check(gridAt(f, t1 - 1)?.bpm === BPM && gridAt(f, t1)?.bpm === BPM + 2, `Sam's phone clicks ${BPM} up to the bar line and ${BPM + 2} from it`);
    await until("the tempo to land", now, (t) => t > t1 + 50);
    const g2 = latestGrid(two)!;
    await sleep(100);
    await hold('[data-stage="slower"]');
    const three = await leaderState();
    const t3 = three.last.at as number;
    check(latestGrid(three)!.bpm === BPM + 1 && onBarLine(g2, t3), `− sends ${BPM + 1} bpm from the next bar line of the ${BPM + 2} grid (${js(latestGrid(three))})`);
  });

  it("Edit order applies on Done, never moves the current song and refuses an order that adds or drops songs", async () => {
    await asLeader();
    await tap('[data-stage="edit-order"]');
    const rows = await until("the order list", () => page<string[]>(`[...document.querySelectorAll("[data-stage-order] li")].map((li) => li.dataset.song)`), (list) => list.length === 3);
    check(js(rows) === js(["s_bayou", "s_brown", "s_reason"]), `Edit order lists tonight's order (${js(rows)})`);
    await tap('[data-stage-order] li[data-song="s_reason"] [data-stage-move="up"]');
    await tap('[data-stage-order] li[data-song="s_reason"] [data-stage-move="up"]');
    const draft = await page<string[]>(`[...document.querySelectorAll("[data-stage-order] li")].map((li) => li.dataset.song)`);
    check(js(draft) === js(["s_reason", "s_bayou", "s_brown"]), `the list moves Give Me One Reason to the top (${js(draft)})`);
    check((await ops()).length === 0, "nothing reaches the band before Done");
    await tap('[data-stage="done"]');
    const sent = await ops();
    check(sent.length === 1 && sent[0].kind === "reorder" && js(sent[0].order) === js(["s_reason", "s_bayou", "s_brown"]), `Done sends one reorder (${js(sent)})`);
    const state = await leaderState();
    const f = await until("Sam's phone to hear the order", () => followerState(), (s) => s?.rev === state.rev);
    const t = (await now()) + 500;
    const at = await page<any>(`window.__at(window.__followerState(), ${t})`);
    check(at.song.key === "s_bayou" && at.song.index === 1, `the current song stays Born on the Bayou, now 2nd in the order (${js(at.song)})`);
    check(f.current[f.current.length - 1].value === "s_bayou", "the reorder holds no song change");
    check(!(await has("[data-stage-order]")), "the list closes on Done");
    // The order under an open list changes (a take-over and back can do that): Done would drop a song, and the gig refuses it.
    await tap('[data-stage="edit-order"]');
    await until("the order list", () => has("[data-stage-order]"), Boolean);
    await page(`(() => {
      const s = window.__hub.held;
      const order = s.order[s.order.length - 1].value.filter((key) => key !== "s_brown");
      window.__hub.held = { ...s, rev: s.rev + 1, order: [...s.order, { at: s.changedAt, value: order }] };
      window.__hub.rooms.get("terry").hear({ kind: "gig-state", state: window.__hub.held, at: s.changedAt });
    })()`);
    await until("the leader to hear the shorter order", () => leaderState(), (s) => s.order[s.order.length - 1].value.length === 2);
    await tap('[data-stage-order] li[data-song="s_bayou"] [data-stage-move="up"]');
    await tap('[data-stage="done"]');
    const note = await until("the refusal", () => text("[data-stage-note]"), (words) => !!words, 2000).catch(() => text("[data-stage-note]"));
    check(note === "That order adds or drops a song", `an order that drops a song is refused with "That order adds or drops a song" (saw ${js(note)})`);
    check((await ops()).length === 1, "the refused order reaches nobody");
    const pure = await page<string[]>(`(() => {
      const { startGig, reduce } = window.__pure;
      const s = startGig({ gigId: "g", order: ["a", "b", "c"], leader: "terry", admin: "ann", backup: null, lineup: ["terry"], route: "auto", scrollAlong: false, now: 1000 });
      const tryOrder = (order, n) => { const out = reduce(s, { opId: "o" + n, epoch: 0, kind: "reorder", order }, { by: "terry", now: 2000, lead: 150 }); return out.ok ? "ok" : out.refused; };
      return [tryOrder(["c", "a", "b"], 1), tryOrder(["c", "a", "b", "d"], 2), tryOrder(["c", "a"], 3), tryOrder(["c", "a", "a"], 4)];
    })()`);
    check(js(pure) === js(["ok", "changes-songs", "changes-songs", "changes-songs"]), `the gig refuses an added, a dropped and a doubled song (${js(pure)})`);
  });

  it("closing Edit order without Done sends nothing and leaves the order as it was", async () => {
    await asLeader();
    await tap('[data-stage="edit-order"]');
    await until("the order list", () => has("[data-stage-order]"), Boolean);
    await tap('[data-stage-order] li[data-song="s_reason"] [data-stage-move="up"]');
    await tap('[data-stage="cancel"]');
    check(!(await has("[data-stage-order]")), "the list closes");
    check((await ops()).length === 0, "closing it sent nothing");
    await tap('[data-stage="edit-order"]');
    const rows = await until("the order list", () => page<string[]>(`[...document.querySelectorAll("[data-stage-order] li")].map((li) => li.dataset.song)`), (list) => list.length === 3);
    check(js(rows) === js(["s_bayou", "s_brown", "s_reason"]), `opened again, it shows the band's order, not the closed draft (${js(rows)})`);
  });

  it("a section chip turns every chart one beat before the next bar line", async () => {
    await asLeader();
    const grid = await startClick();
    const labels = await page<string[]>(`[...document.querySelectorAll('[data-stage="section"]')].map((b) => b.textContent)`);
    check(labels.length === SONGS[0].song.body.length && labels[0] === "INTRO" && labels[1] === "VERSE 1", `the chips name the song's sections (${js(labels.slice(0, 4))}…)`);
    await afterBarLine(grid);
    const sheetTop = await page<number>(`document.getElementById("sheet-scroll").scrollTop`);
    await hold('[data-stage="section"][data-index="5"]');
    const state = await leaderState();
    const at = state.last.at as number;
    const fromBar = (((at + BEAT_MS - grid.startAt) % BAR_MS) + BAR_MS) % BAR_MS;
    check(Math.min(fromBar, BAR_MS - fromBar) < 1 && at - state.changedAt >= LEAD_MS, `section 6 lands one beat before the next bar line (${at - state.changedAt} ms after the hold)`);
    check((await text("[data-stage-chip]")) === "On 4 ▸", `its chip says "On 4 ▸" (${js(await text("[data-stage-chip]"))})`);
    check((await page<number>(`document.getElementById("sheet-scroll").scrollTop`)) === sheetTop, "the leader's chart has not turned before the landing");
    await until("Sam's phone to hear it", () => followerState(), (s) => s?.rev === state.rev);
    check((await followerAt(at - 5))?.section === null && (await followerAt(at + 5))?.section === 5, "Sam's phone turns to section 6 at the landing, not before");
    await until("the landing", now, (t) => t > at + 150);
    const placed = await page<number>(`(() => { const sheet = document.getElementById("sheet-scroll"); const sec = document.querySelectorAll("#chord-section .chart-section")[5]; return sec.getBoundingClientRect().top - sheet.getBoundingClientRect().top; })()`);
    check(Math.abs(placed) < 40, `after the landing the leader's chart shows section 6 at its top (${placed.toFixed(1)} px from the top)`);
  });

  it("two holds in flight: Next, then a section chip before Next lands, and both land", async () => {
    await asLeader();
    const grid = await startClick();
    await afterBarLine(grid);
    await hold('[data-stage="next"]');
    const one = await leaderState();
    const songAt = one.last.at as number;
    await hold('[data-stage="section"][data-index="2"]');
    const two = await leaderState();
    const sectionAt = two.last.at as number;
    check((await now()) < songAt, "the section chip was held before Next landed");
    // The click this case started with Count in is not one of the two holds.
    const sent = (await ops()).filter((op) => op.kind !== "countIn");
    check(sent.length === 2 && sent[0].kind === "goTo" && sent[1].kind === "section", `both holds reached the band (sent ${js(sent.map((op) => op.kind))})`);
    check(two.current[two.current.length - 1].at === songAt && two.current[two.current.length - 1].value === "s_brown", "the pending Next is kept, not erased by the section");
    check((await text("[data-stage-chip]")) === "On 4 ▸", `the chip names the section's landing beat (${js(await text("[data-stage-chip]"))})`);
    await until("Sam's phone to hear both", () => followerState(), (s) => s?.rev === two.rev);
    check((await followerAt(sectionAt - 5))?.section !== 2 && (await followerAt(sectionAt + 5))?.section === 2, "Sam's phone turns the section at its landing");
    check((await followerAt(songAt - 5))?.song.key === "s_bayou" && (await followerAt(songAt + 5))?.song.key === "s_brown", "and flips to song 2 at Next's landing");
    const opened = await followerAt(songAt + 5);
    check(opened?.section === null, `song 2 opens at its top on Sam's phone, not at song 1's section 3 (section ${js(opened?.section)})`);
    await until("both landings", now, (t) => t > Math.max(songAt, sectionAt) + 150);
    const after = await until("the leader's chart to flip", title, (words) => words?.startsWith("2 of 3") ?? false, 3000).catch(title);
    check(after?.startsWith("2 of 3") ?? false, `the leader's chart is on song 2 (${js(after)})`);
  });

  it("Hand off, Change backup and Take the lead appear only for the roles PLAN section 6 allows", async () => {
    const matrix = await page<Record<string, unknown> | null>(`(() => {
      const menu = window.__stage.stageMenu;
      if (typeof menu !== "function") return null;
      const { startGig } = window.__pure;
      const s = startGig({ gigId: "g", order: ["a"], leader: "terry", admin: "ann", backup: "mike", lineup: ["terry", "mike", "sam", "ann", "gus"], route: "auto", scrollAlong: false, now: 0 });
      const out = {};
      for (const me of ["terry", "ann", "mike", "sam", "gus", "rob"]) for (const heard of ["answering", "quiet", "dropped"]) out[me + "/" + heard] = menu(s, me, heard);
      out["ann-leads/answering"] = menu({ ...s, leader: "ann", backup: "mike" }, "ann", "answering");
      return out;
    })()`);
    check(matrix !== null, "stage-bar.tsx exports stageMenu(state, me, heard)");
    if (matrix) {
      const want = (handOff: boolean, changeBackup: boolean, takeLead: boolean) => js({ handOff, changeBackup, takeLead });
      const rows: [string, string][] = [];
      for (const heard of ["answering", "quiet", "dropped"]) {
        rows.push([`terry/${heard}`, want(true, true, false)]);
        rows.push([`ann/${heard}`, want(false, true, true)]);
        rows.push([`mike/${heard}`, want(false, false, heard === "dropped")]);
        rows.push([`sam/${heard}`, want(false, false, false)]);
        rows.push([`gus/${heard}`, want(false, false, false)]);
        rows.push([`rob/${heard}`, want(false, false, false)]);
      }
      rows.push(["ann-leads/answering", want(true, true, false)]);
      const wrong = rows.filter(([key, expected]) => js(matrix[key]) !== expected).map(([key, expected]) => `${key}: ${js(matrix[key])} not ${expected}`);
      check(wrong.length === 0, `leader: Hand off and Change backup; admin: Change backup and Take the lead any time; backup: Take the lead once the leader dropped; member, guest, removed: none (${wrong.join("; ") || "all 19 rows"})`);
    }
    await asLeader();
    await tap('[data-stage="more"]');
    const leaderItems = await page<string[]>(`[...document.querySelectorAll("[data-stage-menu] button")].map((b) => b.dataset.stage)`);
    check(leaderItems.includes("hand-off") && leaderItems.includes("change-backup") && !leaderItems.includes("take-lead"), `on screen the leader's ••• has Hand off and Change backup, no Take the lead (${js(leaderItems)})`);
    await tap('[data-stage="hand-off"]');
    await until("the hand-off list", () => has('[data-stage-to="mike"]'), Boolean);
    check(!(await has('[data-stage-to="terry"]')), "Hand off never lists the leader");
    await hold('[data-stage-to="mike"]');
    const handOff = (await ops()).find((op) => op.kind === "handOff");
    check(handOff?.to === "mike", `holding Mike hands him the lead (sent ${js(await ops())})`);

    await joinAs("ann", { follower: false });
    check(!(await has("[data-stage-bar]")), "the admin who isn't leading gets no stage bar");
    const annItems = await page<string[]>(`(() => { document.querySelector('[data-stage="more"]')?.click(); return new Promise((done) => setTimeout(() => done([...document.querySelectorAll("[data-stage-menu] button")].map((b) => b.dataset.stage)), 100)); })()`);
    check(!annItems.includes("hand-off") && annItems.includes("change-backup") && annItems.includes("take-lead"), `the admin's ••• has Change backup and Take the lead (${js(annItems)})`);
    await joinAs("sam", { follower: false });
    check(!(await has('[data-stage="more"]')) && !(await has("[data-stage-bar]")), "a member gets no ••• and no stage bar");
    await joinAs("mike", { follower: false });
    check(!(await has('[data-stage="more"]')), "the backup gets no ••• while the leader is answering");
  });

  it("Change backup sends the backup the leader taps and closes, and Escape closes an open panel", async () => {
    await asLeader();
    await tap('[data-stage="more"]');
    await tap('[data-stage="change-backup"]');
    await until("the backup list", () => has('[data-stage-backup="sam"]'), Boolean);
    check(!(await has('[data-stage-backup="terry"]')) && (await has('[data-stage-backup=""]')), "the list offers the bandmates and No backup, not the leader");
    await tap('[data-stage-backup="sam"]');
    const sent = await ops();
    check(sent.length === 1 && sent[0].kind === "setBackup" && sent[0].userId === "sam", `tapping Sam sends one setBackup to Sam (sent ${js(sent)})`);
    check(!(await has("[data-stage-panel]")) && !(await has("[data-stage-menu]")), "the list closes");
    const state = await leaderState();
    const f = await until("Sam's phone to hear it", () => followerState(), (s) => s?.rev === state.rev);
    check(f.backup === "sam", `Sam's phone holds Sam as the backup (${js(f.backup)})`);
    await tap('[data-stage="more"]');
    check((await text('[data-stage="change-backup"]')) === "Change backup · Sam", `the menu names the new backup (${js(await text('[data-stage="change-backup"]'))})`);
    await tap('[data-stage="change-backup"]');
    await until("the backup list", () => has('[data-stage-backup="sam"]'), Boolean);
    await tap('[data-stage-backup="sam"]');
    check((await ops()).length === 1 && !(await has("[data-stage-panel]")), "tapping the backup already picked sends nothing and closes the list");
    const escape = async () => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await sleep(100);
    };
    await tap('[data-stage="more"]');
    await until("the ••• menu", () => has("[data-stage-menu]"), Boolean);
    await escape();
    check(!(await has("[data-stage-menu]")), "Escape closes the ••• menu");
    await tap('[data-stage="edit-order"]');
    await until("the order list", () => has("[data-stage-order]"), Boolean);
    await tap('[data-stage-order] li[data-song="s_reason"] [data-stage-move="up"]');
    await escape();
    check(!(await has("[data-stage-order]")), "Escape closes Edit order");
    check((await ops()).length === 1, "and sends nothing");
  });

  it("the admin's Take the lead in ••• takes the lead only on a hold and closes the menu", async () => {
    await joinAs("ann", { follower: false });
    await until("the admin's •••", () => has('[data-stage="more"]'), Boolean);
    // A take-over needs the band's clock, which a follower's phone has once a link to the leader answers (about 9 s here).
    await until("Ann's band clock", () => page<number | null>("window.__session().bandNow()"), (t) => t !== null, 20_000);
    await tap('[data-stage="more"]');
    await until("Take the lead", () => has('[data-stage="take-lead"]'), Boolean);
    await tap('[data-stage="take-lead"]');
    await sleep(LEAD_MS);
    check((await ops("ann")).length === 0, `a tap on Take the lead sends nothing (sent ${js(await ops("ann"))})`);
    check(await has('[data-stage="take-lead"]'), "and the menu stays open");
    await hold('[data-stage="take-lead"]');
    const sent = await ops("ann");
    check(sent.length === 1 && sent[0].kind === "takeOver", `a hold sends one takeOver (sent ${js(sent)})`);
    check(!(await has("[data-stage-menu]")), "the menu closes");
    const state = await until("Ann to lead", () => leaderState(), (s) => s?.leader === "ann");
    check(state.leader === "ann", "the gig names Ann the leader");
    check(!!(await until("Ann's stage bar", () => has("[data-stage-bar]"), Boolean, 3000).catch(() => false)), "Ann's phone now has the stage bar");
  });

  it("Stage lock hides everything except hold-Next, hold-Prev, Count in and Stop", async () => {
    await asLeader();
    const visible = () => page<string[]>(`[...document.querySelectorAll("[data-stage-bar] button, [data-stage-bar] [data-stage-chip]")].filter((el) => el.getBoundingClientRect().height > 0).map((el) => el.dataset.stage ?? "chip").sort()`);
    const before = await visible();
    await tap('[data-stage="lock"]');
    const locked = await visible();
    check(js(locked) === js(["count-in", "next", "prev", "stop", "unlock"]), `locked, the bar shows only Prev, Next, Count in and Stop, plus the hold to unlock (${js(locked)})`);
    await tap('[data-stage="unlock"]');
    check(js(await visible()) === js(locked), "a tap does not unlock");
    await hold('[data-stage="unlock"]');
    check(js(await visible()) === js(before), `a hold unlocks and every control is back (${js(await visible())})`);
    check((await ops()).length === 0, "locking and unlocking send nothing to the band");
  });

  it("a refused wake lock says 'Your screen may sleep' and a frame interval over 20 ms says 'Turn off Low Power Mode for tight timing'", async () => {
    const LOW = "Turn off Low Power Mode for tight timing";
    const words = () => page<string>("document.body.textContent");
    await asLeader({ wake: false });
    await until("the wake-lock note", words, (all) => all.includes("Your screen may sleep"), 3000).catch(() => "");
    check((await words()).includes("Your screen may sleep"), "a refused wake lock says \"Your screen may sleep\"");
    await sleep(1500);
    check(!(await words()).includes(LOW), "at the phone's normal frame rate there is no Low Power Mode note");
    await page("window.__slowFrames(45, 1)");
    await sleep(800);
    check(!(await words()).includes(LOW), "one slow 45 ms frame does not nag");
    await page("window.__slowFrames(70, 3)");
    await sleep(800);
    check(!(await words()).includes(LOW), "three long stalls over the 50 ms cap do not nag either");
    await page("void (window.__slowRun = window.__slowFrames(28, 150))");
    await sleep(2500);
    check((await words()).includes(LOW), `a run of 30 ms frames says "${LOW}"`);
    await page("window.__slowRun");
    await sleep(2500);
    check(!(await words()).includes(LOW), "back at the normal frame rate the note goes away");
    await asLeader({ wake: true });
    await sleep(500);
    check(!(await words()).includes("Your screen may sleep"), "a held wake lock says nothing");
  });

  it("a gig with one song disables Next with 'Last song'", async () => {
    await asLeader({ songs: SONGS.slice(0, 1) });
    const next = await page<{ disabled: boolean; text: string } | null>(`(() => { const b = document.querySelector('[data-stage="next"]'); return b && { disabled: b.disabled, text: b.textContent }; })()`);
    check(!!next && next.disabled && next.text === "Last song", `Next is disabled and says "Last song" (${js(next)})`);
    await hold('[data-stage="next"]');
    check((await ops()).length === 0, "holding it sends nothing");
  });

  it("no grid shows the chip as 'Now'", async () => {
    await asLeader();
    await page("window.__chips = []");
    await hold('[data-stage="next"]');
    const state = await leaderState();
    check(state.last.at - state.changedAt === LEAD_MS, `with the click stopped the move lands one lead (${LEAD_MS} ms) after the hold (${state.last.at - state.changedAt} ms)`);
    check((await chips()).includes("Now") && !(await chips()).some((c) => c?.startsWith("On ")), `the chip says "Now" (saw ${js(await chips())})`);
  });

  it("a leader who lost every route sees 'Your phone isn't reaching anyone', and the controls still move the leader's own chart", async () => {
    await asLeader();
    await page(`window.__hub.rooms.get("terry").drop()`);
    const note = await until("the note", () => text("[data-stage-note]"), (words) => words === "Your phone isn't reaching anyone", 3000).catch(() => text("[data-stage-note]"));
    check(note === "Your phone isn't reaching anyone", `the stage bar says "Your phone isn't reaching anyone" (saw ${js(note)})`);
    await hold('[data-stage="next"]');
    const after = await until("the leader's chart to flip", title, (words) => words?.startsWith("2 of 3") ?? false, 3000).catch(title);
    check(after?.startsWith("2 of 3") ?? false, `the leader's own chart moves to song 2 (${js(after)})`);
    check((await followerAt(await now()))?.song.key === "s_bayou", "Sam's phone, out of reach, stays on song 1");
    await sleep(300);
    await hold('[data-stage="next"]');
    await until("the leader's chart to flip again", title, (words) => words?.startsWith("3 of 3") ?? false, 3000).catch(title);
    check((await ops()).length === 0, "nothing was sent while out of reach");
    // Re-tick during reconnect: two moves while out of reach, then the room comes back.
    await page(`window.__hub.rooms.get("terry").back()`);
    await until("Sam's phone to catch up", () => followerAt(Date.now() + 1e9), (at) => at?.song.key === "s_reason", 5000).catch(() => null);
    const f = await page<any>(`window.__at(window.__followerState(), window.__now())`);
    check(f?.song.key === "s_reason", `back in reach, Sam's phone shows song 3 (${js(f?.song)})`);
    const revs = await page<number[]>(`window.__hub.sends.filter((s) => s.me === "terry" && s.kind === "gig-op").map((s) => s.rev)`);
    check(new Set(revs).size === revs.length && revs.length >= 1, `the band got the latest state once, no duplicate (${js(revs)})`);
    check((await text("[data-stage-note]")) !== "Your phone isn't reaching anyone", "the note goes once the room is back");
  });

  it("a follower phone that drops out and comes back shows the band's song", async () => {
    await asLeader();
    await page(`window.__hub.rooms.get("sam").drop()`);
    await hold('[data-stage="next"]');
    const state = await leaderState();
    await sleep(LEAD_MS + 100);
    check((await followerState()).rev < state.rev, "while out, Sam's phone does not have the move");
    await page(`window.__hub.rooms.get("sam").back()`);
    const f = await until("Sam's phone to catch up", () => followerState(), (s) => s?.rev === state.rev, 5000).catch(() => followerState());
    check(f?.rev === state.rev && (await followerAt(await now()))?.song.key === "s_brown", `back, Sam's phone is on song 2 (${js(f?.rev)} of ${state.rev})`);
  });

  it("the gig stage bar shows only while this phone leads a live gig, and the band moves only by a hold", async () => {
    await page(`window.__boot(${js({ me: "terry", hash: "#/bands", songs: SONGS })})`);
    await sleep(300);
    check(!(await has("[data-stage-bar]")), "before joining, no stage bar");
    await asLeader();
    check(await has("[data-stage-bar]"), "leading the live gig, the stage bar is up");
    check(!(await has('.live-nav [aria-label="Next song"]')), "the solo Next button is gone in the gig");
    await page(`(() => { const s = window.__hub.held; window.__hub.held = { ...s, rev: s.rev + 1, status: "ended" }; window.__hub.rooms.get("terry").hear({ kind: "gig-state", state: window.__hub.held, at: s.changedAt }); })()`);
    await until("the gig to end", () => page<string>("document.body.textContent"), (all) => all.includes("That's the gig. Nice playing."), 4000).catch(() => "");
    check(!(await has("[data-stage-bar]")), "once the gig has ended, no stage bar");
  });

  it("the existing Live buttons are unchanged outside a gig", async () => {
    const nav = async () =>
      page<{ html: string; heights: number[]; navHeight: number } | null>(`(() => {
        const nav = document.querySelector(".live-nav");
        if (!nav) return null;
        return { html: nav.outerHTML, heights: [...nav.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().height)), navHeight: Math.round(nav.getBoundingClientRect().height) };
      })()`);
    await page(`window.__boot(${js({ me: null, hash: "#/live/1/0", songs: SONGS })})`);
    const solo = await until("the solo bar", nav, (found) => found !== null);
    check(solo?.html === SOLO_NAV.html, `signed out, #/live/1/0's bar has the base markup${solo?.html === SOLO_NAV.html ? "" : `: ${solo?.html}`}`);
    check(js(solo?.heights) === js(SOLO_NAV.heights) && solo?.navHeight === SOLO_NAV.navHeight, `and the base sizes (${js(solo?.heights)}, bar ${solo?.navHeight} px)`);
    check(!(await has("[data-stage-bar]")), "with no gig there is no stage bar");
    await joinAs("terry");
    await page(`location.hash = "#/live/1/0"`);
    const during = await until("the solo bar", nav, (found) => found !== null);
    check(during?.html === SOLO_NAV.html && js(during?.heights) === js(SOLO_NAV.heights), `while this phone leads a gig, #/live/1/0 still has the base bar${during?.html === SOLO_NAV.html ? "" : `: ${during?.html}`}`);
    check(!(await has("[data-stage-bar]")), "and no stage bar");
  });

  // CHECK_STAGE_ONLY=<words> runs the cases whose name holds them, for working on one.
  const only = process.env.CHECK_STAGE_ONLY;
  for (const [name, body] of cases) {
    if (only && !name.includes(only)) continue;
    const before = failures;
    try {
      await body();
    } catch (error) {
      check(false, `${name}: ${(error as Error).message}`);
    }
    console.log(`${failures === before ? "ok  " : "FAIL"} ${name}`);
  }
}

await main().catch((error) => {
  failures += 1;
  console.log(`FAIL check:stage could not run: ${(error as Error).stack ?? error}`);
});
if (failures > 0) {
  console.log(`check:stage: ${failures} FAIL`);
  process.exit(1);
}
console.log("check:stage passed");
