import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { LiveRoute } from "../src/band-status-model.ts";

// src files import siblings without extensions, so bundle them (same pattern as check-send-song.ts).
type Mod = typeof import("../src/band-status-model.ts") & typeof import("../src/band-status.tsx") & { renderToStaticMarkup: (el: unknown) => string; createElement: (c: unknown, p: unknown) => unknown };
const bundled = await build({
  stdin: { contents: 'export * from "./src/band-status-model.ts"; export * from "./src/band-status.tsx"; export { renderToStaticMarkup } from "react-dom/server"; export { createElement } from "react";', resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic", logLevel: "silent",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const file = join(mkdtempSync(join(tmpdir(), "check-band-status-")), "m.mjs");
writeFileSync(file, bundled.outputFiles[0].text);
const m = (await import(pathToFileURL(file).href)) as Mod;
const { LIVE_ROUTE_WORDS, fixturePlayers, syncBars, barsText, statusRows, heardText, liveRating, isAmber, BAND_STATUS_FONT_PX } = m;
const panel = m.renderToStaticMarkup(m.createElement(m.BandStatusPanel, {}));
const amberCount = (panel.match(/band-status-amber/g) || []).length;
const sizes = [...panel.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((x) => Number(x[1]));
if (amberCount !== 1 || !/Out of sync/.test(panel) || sizes.length === 0 || Math.min(...sizes) < 16) { console.error(`FAIL panel render: amber=${amberCount} sizes=${sizes.join(",")}`); process.exit(1); }
console.log("ok panel renders one amber row, Out of sync, text >= 16 px");

let passed = 0;
let failed = 0;

function test(name: string, condition: boolean, actual?: unknown, expected?: unknown) {
  if (condition) {
    console.log(`ok ${name}`);
    passed++;
  } else {
    console.log(`FAIL ${name}: expected ${expected}, got ${actual}`);
    failed++;
  }
}

// Test LIVE_ROUTE_WORDS
test(
  "LIVE_ROUTE_WORDS has all four routes",
  ["wifi", "internet", "relay", "server"].every(
    (r) => r in LIVE_ROUTE_WORDS && LIVE_ROUTE_WORDS[r as LiveRoute] !== ""
  )
);

// Test fixture has 5 players on 4 distinct routes
const routes = new Set(fixturePlayers.map((p) => p.route));
test("fixture has 5 players", fixturePlayers.length === 5, fixturePlayers.length, 5);
test("fixture on 4 distinct routes", routes.size === 4, routes.size, 4);

// Test syncBars
test("syncBars(1.5) === 4", syncBars(1.5) === 4, syncBars(1.5), 4);
test("syncBars(2) === 4", syncBars(2) === 4, syncBars(2), 4);
test("syncBars(4) === 3", syncBars(4) === 3, syncBars(4), 3);
test("syncBars(7.5) === 2", syncBars(7.5) === 2, syncBars(7.5), 2);
test("syncBars(9) === 0", syncBars(9) === 0, syncBars(9), 0);

// Test barsText
test("barsText(9) === 'Out of sync'", barsText(9) === "Out of sync", barsText(9), "Out of sync");
test("barsText(1) === ''", barsText(1) === "", barsText(1), "");

// Test statusRows and routeText
const rows = statusRows(fixturePlayers);
test("statusRows returns 5 rows", rows.length === 5, rows.length, 5);

rows.forEach((row, i) => {
  const player = fixturePlayers[i];
  const expectedRoute = LIVE_ROUTE_WORDS[player.route];
  const expectedRating = liveRating(player);
  const startsCorrect = row.routeText.startsWith(expectedRoute);
  const endsCorrect = row.routeText.endsWith(expectedRating);
  test(
    `statusRows[${i}].routeText format (${player.name})`,
    startsCorrect && endsCorrect,
    row.routeText,
    `${expectedRoute} · ${expectedRating}`
  );
});

// Test Jo's row (spreadMs 11) is amber with barsText "Out of sync"
const joRow = rows.find((r) => r.id === "jo")!;
test("Jo row is amber", joRow.amber === true, joRow.amber, true);
test("Jo row barsText 'Out of sync'", joRow.barsText === "Out of sync", joRow.barsText, "Out of sync");

// Test exactly one amber row in fixture
const amberRows = rows.filter((r) => r.amber);
test("exactly one amber row", amberRows.length === 1, amberRows.length, 1);

// Test player with lateRate 0.02 and spread 1 is amber
const testPlayer = {
  id: "test",
  name: "Test",
  route: "wifi" as const,
  spreadMs: 1,
  p99Ms: 2,
  lateRate: 0.02,
  downloaded: true,
  inTime: true,
  heardMsAgo: 0,
};
test(
  "player with lateRate 0.02, spread 1 is amber",
  isAmber(testPlayer) === true,
  isAmber(testPlayer),
  true
);

// Test heardText
test("heardText(2000) === 'Heard 2 s ago'", heardText(2000) === "Heard 2 s ago", heardText(2000), "Heard 2 s ago");
test("heardText(0) === 'Heard 0 s ago'", heardText(0) === "Heard 0 s ago", heardText(0), "Heard 0 s ago");

// Test not-downloaded player row
const notDownloadedRow = rows.find((r) => r.id === "sam")!;
test(
  "not-downloaded player's downloaded is ''",
  notDownloadedRow.downloaded === "",
  notDownloadedRow.downloaded,
  ""
);

// Test BAND_STATUS_FONT_PX
test("BAND_STATUS_FONT_PX >= 16", BAND_STATUS_FONT_PX >= 16, BAND_STATUS_FONT_PX, ">=16");

if (failed === 0) {
  console.log("band-status: all checks passed");
  process.exit(0);
} else {
  process.exit(1);
}
