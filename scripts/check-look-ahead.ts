import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";
import { openSite } from "./chrome.ts";
import {
  type LookState,
  type Outbound,
  GLIDE_MS,
  initialLook,
  touchAction,
  startDrag,
  dragTo,
  release,
  easeOut,
  tick,
  tagText,
  showBandLine,
} from "../src/look-ahead.ts";

const tests: { name: string; fn: () => void }[] = [];
let failed = 0;

function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    console.error(
      `  FAIL: ${message} (got ${actual}, expected ${expected})`
    );
    failed++;
  }
}

function countOutbound(
  ...results: { state: LookState; out: Outbound[] }[]
): number {
  return results.reduce((sum, r) => sum + r.out.length, 0);
}

test("touchAction in gig", () => {
  assertEqual(touchAction(true), "look-ahead", "touchAction(true)");
});

test("touchAction not in gig", () => {
  assertEqual(touchAction(false), "stop-scroll", "touchAction(false)");
});

test("startDrag outside gig leaves state locked", () => {
  const s = initialLook(300);
  const result = startDrag(s, false);
  assertEqual(result.state.mode, "locked", "mode is locked");
  assertEqual(result.state.px, 300, "px unchanged");
  assertEqual(tagText(result.state), "", "tagText is empty");
  assertEqual(result.out.length, 0, "out is empty");
});

test("startDrag in gig transitions to looking", () => {
  const s = initialLook(300);
  const result = startDrag(s, true);
  assertEqual(result.state.mode, "looking", "mode is looking");
  assertEqual(tagText(result.state), "Looking ahead", "tagText correct");
  assertEqual(showBandLine(result.state), true, "showBandLine true");
  assertEqual(result.out.length, 0, "out is empty");
});

test("dragTo while looking updates px", () => {
  const s = initialLook(300);
  const looking = startDrag(s, true).state;
  const result = dragTo(looking, 900);
  assertEqual(result.state.px, 900, "px is 900");
  assertEqual(result.out.length, 0, "out is empty");
});

test("dragTo clamps negative to 0", () => {
  const s = initialLook(300);
  const looking = startDrag(s, true).state;
  const result = dragTo(looking, -50);
  assertEqual(result.state.px, 0, "px is 0");
});

test("dragTo while locked does nothing", () => {
  const s = initialLook(300);
  const result = dragTo(s, 900);
  assertEqual(result.state.mode, "locked", "mode unchanged");
  assertEqual(result.state.px, 300, "px unchanged");
});

test("tick while looking leaves px unchanged", () => {
  const s = initialLook(300);
  const looking = startDrag(s, true).state;
  const dragged = dragTo(looking, 900).state;
  const result = tick(dragged, 500, 300);
  assertEqual(result.px, 900, "px unchanged");
  assertEqual(result.mode, "looking", "mode unchanged");
});

test("full drag+release+ticks produces zero Outbound messages", () => {
  const s = initialLook(300);
  const r1 = startDrag(s, true);
  const r2 = dragTo(r1.state, 900);
  const r3 = release(r2.state, 1000);
  const r4 = tick(r3.state, 1100, 300);
  const r5 = tick(r4, 1200, 300);
  const r6 = tick(r5, 1400, 300);
  const total = countOutbound(r1, r2, r3);
  assertEqual(r6.mode, "locked", "locked after glide");
  assertEqual(total, 0, "total Outbound messages");
});

test("release at t=1000 then tick at 1200 px between values", () => {
  const s = initialLook(300);
  const looking = startDrag(s, true).state;
  const dragged = dragTo(looking, 900).state;
  const released = release(dragged, 1000).state;
  const ticked = tick(released, 1200, 300);
  assert(
    ticked.px > 300 && ticked.px < 900,
    `px ${ticked.px} between 300 and 900`
  );
});

test("tick at 1400 locks at band place", () => {
  const s = initialLook(300);
  const looking = startDrag(s, true).state;
  const dragged = dragTo(looking, 900).state;
  const released = release(dragged, 1000).state;
  const ticked = tick(released, 1400, 300);
  assertEqual(ticked.mode, "locked", "mode locked");
  assertEqual(ticked.px, 300, "px exactly bandPx");
});

test("tick at 1399 not yet locked", () => {
  const s = initialLook(300);
  const looking = startDrag(s, true).state;
  const dragged = dragTo(looking, 900).state;
  const released = release(dragged, 1000).state;
  const ticked = tick(released, 1399, 300);
  assertEqual(ticked.mode, "gliding", "mode still gliding");
  assert(ticked.px !== 300, "px not yet at bandPx");
});

test("band moves during drag before release", () => {
  const s = initialLook(300);
  const looking = startDrag(s, true).state;
  const dragged = dragTo(looking, 900).state;
  const released = release(dragged, 1000).state;
  const ticked1 = tick(released, 1400, 500); // band moved to 500
  assertEqual(ticked1.px, 500, "px locked at new band place");
});

test("release at 1000 drag to 900 band at 300->500 tick at 1450", () => {
  const s = initialLook(300);
  const looking = startDrag(s, true).state;
  const dragged = dragTo(looking, 900).state;
  const released = release(dragged, 1000).state;
  const ticked = tick(released, 1450, 500);
  assertEqual(ticked.mode, "locked", "mode locked");
  assertEqual(ticked.px, 500, "px at new band place");
});

test("glide is monotonic toward band", () => {
  const s = initialLook(300);
  const looking = startDrag(s, true).state;
  const dragged = dragTo(looking, 900).state;
  const released = release(dragged, 1000).state;

  let prev = 900;
  for (let t = 1000 + 50; t < 1000 + GLIDE_MS; t += 50) {
    const current = tick(released, t, 300).px;
    const distFromBand = Math.abs(current - 300);
    const prevDistFromBand = Math.abs(prev - 300);
    assert(
      distFromBand < prevDistFromBand || distFromBand === prevDistFromBand,
      `monotonic at t=${t}: ${current} toward 300`
    );
    prev = current;
  }
});

test("easeOut(0) = 0", () => {
  assertEqual(easeOut(0), 0, "easeOut(0)");
});

test("easeOut(1) = 1", () => {
  assertEqual(easeOut(1), 1, "easeOut(1)");
});

test("easeOut(2) clamped to 1", () => {
  assertEqual(easeOut(2), 1, "easeOut(2)");
});

test("locked tick follows bandPx", () => {
  const s = initialLook(300);
  const ticked = tick(s, 1000, 500);
  assertEqual(ticked.px, 500, "px follows bandPx");
  assertEqual(ticked.mode, "locked", "mode locked");
});

// Run all tests
for (const t of tests) {
  try {
    t.fn();
    console.log(`ok ${t.name}`);
  } catch (e) {
    console.error(`FAIL ${t.name} (exception: ${e})`);
    failed++;
  }
}

// The wired flow in Chrome at 390×844 (PLAN.md 7.18): the real sheet and `useAutoScroll` on a band clock the page holds
// still or moves on, driven by touch events from DevTools. The timed motion runs the chart's top at the view's top to its
// bottom at the view's bottom over 100 s of band time, so the band's place at band second `t` is start + (end − start) · t/100
// and the song is `t`/100 of the way down the chart.
const root = fileURLToPath(new URL("..", import.meta.url));
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const RUNTIME_S = 100;
const HARNESS = `
  import { useState } from "react";
  import { createRoot } from "react-dom/client";
  import { useAutoScroll } from "./src/hooks.ts";
  import { LeadSheet } from "./src/sheet.tsx";
  import { DEFAULT_METRONOME_PREFS } from "./src/metronome.ts";
  import "./src/styles.css";
  import "./src/metronome.css";

  const w = window;
  const motion = { kind: "timed", rate: 1, progressAt: (at) => Math.min(1, Math.max(0, at / ${RUNTIME_S})), startAt: (p) => p * ${RUNTIME_S}, holdOpening: false };
  const bandTime = () => w.__band;
  function Harness({ song, gig, playing }) {
    const [on, setOn] = useState(true);
    // A redial, as when a phone drops out and rescans, hands the scroll a new band clock reading the same band time.
    const [time, setTime] = useState(() => (gig ? bandTime : undefined));
    w.__redial = () => setTime(() => () => w.__band);
    useAutoScroll(on, motion, "plan", (reason) => { w.__stops.push(reason); setOn(false); }, time);
    const metronome = { bpm: 96, playing, setBpm() {}, nudge() {}, toggle() {}, stop() {}, prefs: DEFAULT_METRONOME_PREFS, setPrefs: (patch) => w.__prefs.push(patch) };
    return (
      <div className="scroll" id="sheet-scroll" style={{ height: "100vh" }}>
        <LeadSheet song={song} scale={1} semitones={0} notation="notes" metronome={metronome} />
      </div>
    );
  }
  let mounted = null;
  w.__mount = (song, gig, playing = false) => {
    mounted?.unmount();
    w.__stops = [];
    w.__prefs = [];
    w.__band = 0;
    mounted = createRoot(document.getElementById("root"));
    mounted.render(<Harness song={song} gig={gig} playing={playing} />);
  };
  w.__sent = 0;
  const count = (owner, name) => {
    const real = owner?.[name];
    if (!real) return;
    owner[name] = function (...args) {
      w.__sent += 1;
      return real.apply(this, args);
    };
  };
  count(window, "fetch");
  count(navigator, "sendBeacon");
  count(WebSocket.prototype, "send");
  count(globalThis.RTCDataChannel?.prototype, "send");
  count(XMLHttpRequest.prototype, "send");
  count(BroadcastChannel.prototype, "postMessage");
`;

async function browserCases(): Promise<number> {
  let failures = 0;
  const check = (ok: boolean, message: string) => {
    if (!ok) failures += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  };
  const library = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: { title: string; body: unknown[] }[] };
  const base = library.songs.find((song) => song.title === "Give Me One Reason")!;
  const song = { ...base, body: [...base.body, ...base.body, ...base.body] };
  const bundled = await bundle({
    stdin: { contents: HARNESS, resolveDir: root, loader: "tsx", sourcefile: "look-ahead-harness.tsx" },
    bundle: true,
    write: false,
    outdir: join(root, ".look-ahead-harness"),
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".woff2": "empty", ".woff": "empty", ".svg": "dataurl", ".png": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const script = bundled.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const css = bundled.outputFiles.filter((file) => file.path.endsWith(".css")).map((file) => file.text).join("\n");

  const site = await openSite(root, "check-look-ahead");
  const { send, evaluate } = site;
  try {
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", PHONE);
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    const loaded = new Promise((resolve) => setTimeout(resolve, 1500));
    await send("Page.navigate", { url: `${site.origin}/look-ahead-harness` });
    await loaded;
    await evaluate(`(() => {
      document.open();
      document.write('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div></body></html>');
      document.close();
      const style = document.createElement("style");
      style.textContent = ${JSON.stringify(css)};
      document.head.append(style);
    })()`);
    await send("Runtime.evaluate", { expression: script });

    const frames = (count = 1) => evaluate(`new Promise((done) => { let left = ${count}; const tick = () => (--left > 0 ? requestAnimationFrame(tick) : done(null)); requestAnimationFrame(tick); })`);
    const pause = (ms: number) => evaluate(`new Promise((done) => setTimeout(done, ${ms}))`);
    type Seen = { top: number; start: number; end: number; chartHeight: number; tag: string | null; line: number | null; stops: string[]; sent: number; prefs: number };
    const seen = () =>
      evaluate<Seen>(`(() => {
        const el = document.getElementById("sheet-scroll");
        const chart = document.getElementById("chord-section");
        const start = chart.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        const tag = document.querySelector("article.sheet .look-tag");
        const line = chart.querySelector(".band-line");
        return {
          top: el.scrollTop,
          start,
          end: start + chart.offsetHeight - el.clientHeight,
          chartHeight: chart.offsetHeight,
          tag: tag && tag.getClientRects().length ? tag.innerText.trim() : null,
          line: line && line.getClientRects().length ? line.getBoundingClientRect().top - chart.getBoundingClientRect().top : null,
          stops: window.__stops,
          sent: window.__sent,
          prefs: window.__prefs.length,
        };
      })()`);
    const bandPlace = (s: Seen, second: number) => s.start + (s.end - s.start) * (second / RUNTIME_S);
    const setBand = async (second: number) => {
      await evaluate(`window.__band = ${second * 1000}`);
      await frames(8);
    };
    const X = 200;
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", y = 0) => send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: X, y }] });
    /** A slow finger from y 700 to 460, so the sheet scrolls about 240 px ahead and no fling follows. */
    const dragUp = async () => {
      await touch("touchStart", 700);
      for (let y = 690; y >= 460; y -= 10) {
        await touch("touchMove", y);
        await frames(1);
      }
      await pause(150);
      await touch("touchMove", 460);
      await frames(4);
    };
    /** Lets go and reports how long the sheet took, from the touchend, to sit within 2 px of the band's place at `second`. */
    const letGo = async (second: number) => {
      const s = await seen();
      const target = bandPlace(s, second);
      await evaluate(`(() => {
        const el = document.getElementById("sheet-scroll");
        window.__landed = null;
        window.__released = null;
        window.__track = [];
        addEventListener("touchend", () => (window.__released = performance.now()), { capture: true, once: true });
        const watch = () => {
          if (window.__released !== null) window.__track.push(el.scrollTop);
          if (window.__released !== null && Math.abs(el.scrollTop - ${target}) < 2) return (window.__landed = performance.now() - window.__released);
          requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
      })()`);
      await touch("touchEnd");
      await pause(700);
      return evaluate<number | null>("window.__landed");
    };
    const near = (a: number | null, b: number, tolerance: number) => a !== null && Math.abs(a - b) <= tolerance;
    /** The frames from the last release to landing on `target`: each one no farther from it than the one before, and at least five in between, so it glides and does not jump. */
    const glide = async (target: number) => {
      const track = await evaluate<number[]>("window.__track");
      const away = track.map((top) => Math.abs(top - target));
      const toward = away.every((each, i) => i === 0 || each <= away[i - 1] + 1);
      const between = new Set(track.filter((top, i) => away[i] > 2 && Math.abs(top - track[0]) > 2).map(Math.round)).size;
      return { ok: toward && between >= 5, words: `toward ${toward}, ${between} frames in between` };
    };

    // Sanity: a counted send is seen, so a zero below means nothing went out.
    await evaluate(`fetch("data:,probe").catch(() => {}); window.__sent`);
    check((await evaluate<number>("window.__sent")) === 1, "the outbound counter sees a send (control)");

    await evaluate(`window.__mount(${JSON.stringify(song)}, true)`);
    await frames(10);
    await evaluate("window.__sent = 0");
    await setBand(30);
    let s = await seen();
    check(s.end - s.start > 1500 && near(s.top, bandPlace(s, 30), 2), `in a gig the locked sheet sits on the band's place (top ${s.top.toFixed(1)}, band ${bandPlace(s, 30).toFixed(1)})`);
    check(s.tag === null && s.line === null, "a locked sheet shows no tag and no gold line");

    await dragUp();
    s = await seen();
    const ahead = s.top;
    check(
      s.tag === "Looking ahead" && s.stops.length === 0 && s.sent === 0 && ahead - bandPlace(s, 30) > 100,
      `a drag in a gig shows 'Looking ahead' and sends no message on any link (tag ${JSON.stringify(s.tag)}, stops ${JSON.stringify(s.stops)}, sent ${s.sent}, ahead by ${(ahead - bandPlace(s, 30)).toFixed(1)} px)`,
    );
    check(
      near(s.line, 0.3 * s.chartHeight, 3),
      `the thin gold line marks the band's place while looking ahead (line at ${s.line?.toFixed(1)} px down the chart, song at ${(0.3 * s.chartHeight).toFixed(1)})`,
    );
    await pause(300);
    s = await seen();
    check(near(s.top, ahead, 1), `while looking the band's scroll leaves this phone's chart where the finger put it (${ahead.toFixed(1)} then ${s.top.toFixed(1)})`);

    let landed = await letGo(30);
    s = await seen();
    check(
      landed !== null && landed <= 450 && near(s.top, bandPlace(s, 30), 2),
      `on release the scroll reaches the band's place within 450 ms (took ${landed?.toFixed(0)} ms, top ${s.top.toFixed(1)}, band ${bandPlace(s, 30).toFixed(1)})`,
    );
    let glided = await glide(bandPlace(s, 30));
    check(glided.ok, `the release glides to the band's place frame by frame, never jumping (${glided.words})`);
    check(s.tag === null && s.line === null, `once locked again the tag and the gold line are gone (tag ${JSON.stringify(s.tag)}, line ${s.line})`);

    await dragUp();
    const before = (await seen()).top;
    await setBand(50);
    s = await seen();
    const heldWhileBandMoved = near(s.top, before, 1);
    check(near(s.line, 0.5 * s.chartHeight, 3), `the gold line follows the band while looking ahead (line ${s.line?.toFixed(1)}, song ${(0.5 * s.chartHeight).toFixed(1)})`);
    landed = await letGo(50);
    s = await seen();
    check(
      heldWhileBandMoved && landed !== null && landed <= 450 && near(s.top, bandPlace(s, 50), 2),
      `if the band moved during the drag it lands on the new place (held ${heldWhileBandMoved}, took ${landed?.toFixed(0)} ms, top ${s.top.toFixed(1)}, band ${bandPlace(s, 50).toFixed(1)})`,
    );
    glided = await glide(bandPlace(s, 50));
    check(glided.ok, `after the band moved, the release glides toward the new place, never the old one (${glided.words})`);
    await setBand(60);
    s = await seen();
    check(near(s.top, bandPlace(s, 60), 2), `after the glide the sheet is locked to the band again (top ${s.top.toFixed(1)}, band ${bandPlace(s, 60).toFixed(1)})`);
    check(s.stops.length === 0 && s.sent === 0, `the whole look ahead sent nothing and never stopped the band's scroll (stops ${JSON.stringify(s.stops)}, sent ${s.sent})`);

    await dragUp();
    await evaluate("window.__redial()");
    await frames(10);
    s = await seen();
    const redialed = s.tag === null && s.line === null && near(s.top, bandPlace(s, 60), 2);
    await touch("touchEnd");
    await frames(4);
    await setBand(70);
    s = await seen();
    check(
      redialed && near(s.top, bandPlace(s, 70), 2) && s.stops.length === 0,
      `a phone that drops out and rescans mid-look goes back to the band's place, locked, with no tag (back ${redialed}, top ${s.top.toFixed(1)}, band ${bandPlace(s, 70).toFixed(1)})`,
    );
    await dragUp();
    s = await seen();
    const againTag = s.tag;
    landed = await letGo(70);
    s = await seen();
    check(
      againTag === "Looking ahead" && landed !== null && landed <= 450 && s.tag === null,
      `after the rescan a drag looks ahead and glides back again (tag ${JSON.stringify(againTag)}, took ${landed?.toFixed(0)} ms)`,
    );

    await dragUp();
    await touch("touchEnd");
    await pause(120);
    await touch("touchStart", 700);
    await frames(2);
    s = await seen();
    const caught = s.top;
    const caughtTag = s.tag;
    const caughtAway = caught - bandPlace(s, 70);
    await pause(300);
    s = await seen();
    const heldCaught = near(s.top, caught, 15);
    landed = await letGo(70);
    s = await seen();
    check(
      caughtAway > 20 && caughtTag === "Looking ahead" && heldCaught && landed !== null && landed <= 450 && near(s.top, bandPlace(s, 70), 2) && s.tag === null,
      `a finger that catches the chart mid-glide holds it there, looking ahead, and the next release glides back (caught ${caughtAway.toFixed(1)} px off the band, tag ${JSON.stringify(caughtTag)}, held ${heldCaught}, took ${landed?.toFixed(0)} ms)`,
    );

    await evaluate(`window.__mount(${JSON.stringify(song)}, true, true)`);
    await frames(10);
    await setBand(30);
    const pill = await evaluate<{ x: number; y: number } | null>(`(() => {
      const pill = document.querySelector("article.sheet .beat-pill");
      if (!pill) return null;
      const box = pill.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    if (pill) {
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pill] });
      await frames(2);
      const during = await seen();
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await frames(4);
      s = await seen();
      check(
        during.tag === null && s.tag === null && s.prefs === 1 && s.stops.length === 0,
        `tapping the beat pill in a gig changes Sound and Dot and does not look ahead (tag ${JSON.stringify(during.tag)}, taps ${s.prefs}, stops ${JSON.stringify(s.stops)})`,
      );

      // The pill stops its pointerdown, so a pan that starts on it reaches the sheet only as scrolling.
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pill] });
      for (let dy = 10; dy <= 240; dy += 10) {
        await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: pill.x, y: pill.y + dy }] });
        await frames(1);
      }
      await pause(150);
      await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: pill.x, y: pill.y + 240 }] });
      await frames(4);
      s = await seen();
      const back = bandPlace(s, 30) - s.top;
      const panTag = s.tag;
      landed = await letGo(30);
      s = await seen();
      check(
        panTag === "Looking ahead" && back > 150 && landed !== null && landed <= 450 && near(s.top, bandPlace(s, 30), 2) && s.tag === null && s.stops.length === 0,
        `a pan that starts on the beat pill in a gig looks back and glides to the band on release (back ${back.toFixed(1)} px, tag ${JSON.stringify(panTag)}, took ${landed?.toFixed(0)} ms, stops ${JSON.stringify(s.stops)})`,
      );

      await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: X, y: 400, deltaX: 0, deltaY: 300 });
      await frames(6);
      s = await seen();
      const wheeled = s.top - bandPlace(s, 30);
      const wheelTag = s.tag;
      await pause(700);
      s = await seen();
      check(
        wheelTag === "Looking ahead" && wheeled > 150 && near(s.top, bandPlace(s, 30), 2) && s.tag === null && s.stops.length === 0,
        `a wheel in a gig looks ahead, then glides back to the band once the sheet is still (ahead ${wheeled.toFixed(1)} px, tag ${JSON.stringify(wheelTag)}, then top ${s.top.toFixed(1)}, band ${bandPlace(s, 30).toFixed(1)}, tag ${JSON.stringify(s.tag)})`,
      );
    } else check(false, "the beat pill shows while the metronome plays");

    await evaluate(`window.__mount(${JSON.stringify(song)}, false)`);
    await frames(30);
    await touch("touchStart", 600);
    await frames(2);
    await touch("touchEnd");
    await frames(4);
    s = await seen();
    check(s.stops.length === 1 && s.stops[0] === "user" && s.tag === null, `outside a gig a touch still stops the scroll (stops ${JSON.stringify(s.stops)}, tag ${JSON.stringify(s.tag)})`);
  } catch (error) {
    check(false, `the look-ahead page could not run: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await site.close();
  }
  return failures;
}

const browserFailures = await browserCases();
if (failed === 0 && browserFailures === 0) {
  console.log("look-ahead: all checks passed");
  process.exit(0);
} else {
  process.exit(1);
}
