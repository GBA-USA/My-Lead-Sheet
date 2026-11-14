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

if (failed === 0) {
  console.log("look-ahead: all checks passed");
  process.exit(0);
} else {
  process.exit(1);
}
