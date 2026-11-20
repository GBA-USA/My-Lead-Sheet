import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { BandView } from "../src/bands-model.ts";
import type { GigView } from "../src/gig-plan-model.ts";
import { CHOICE_WORDS } from "../src/routes.ts";

// src files import siblings without extensions, so bundle them (same pattern as check-send-song.ts).
type Mod = typeof import("../src/band-status-model.ts") & typeof import("../src/band-status.tsx") & { renderToStaticMarkup: (el: unknown) => string; createElement: (c: unknown, p: unknown) => unknown };
const bundled = await build({
  stdin: { contents: 'export * from "./src/band-status-model.ts"; export * from "./src/band-status.tsx"; export { renderToStaticMarkup } from "react-dom/server"; export { createElement } from "react";', resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic", logLevel: "silent", loader: { ".css": "empty" },
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const file = join(mkdtempSync(join(tmpdir(), "check-band-status-")), "m.mjs");
writeFileSync(file, bundled.outputFiles[0].text);
const m = (await import(pathToFileURL(file).href)) as Mod;
const { playersFrom, syncBars, barsText, statusRows, heardText, isAmber } = m;

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

const band: BandView = {
  bandId: "b1",
  name: "The Blue Notes",
  role: "member",
  scrollWithLeader: false,
  members: [
    { userId: "u-terry", name: "Terry Bass", role: "admin" },
    { userId: "u-mike", name: "Mike Keys", role: "member" },
    { userId: "u-dana", name: "Dana Drums", role: "member" },
    { userId: "u-sam", name: "Sam Rivera", role: "member" },
    { userId: "u-ray", name: "Ray Fox", role: "member" },
  ],
};
const view: GigView = {
  gig: { gigId: "g1", bandId: "b1", setlistId: "s1", name: "Friday", date: "2026-11-20", lineup: ["u-terry", "u-mike", "u-dana", "u-sam", "u-gone"], leader: "u-mike", backup: null, route: "band_wifi", status: "planned" },
  packRev: 3,
  receipts: [
    { userId: "u-mike", packRev: 3, at: 1 },
    { userId: "u-dana", packRev: 2, at: 1 },
    { userId: "u-sam", packRev: 3, at: 2 },
  ],
};
const json = (value: unknown) => JSON.stringify(value);
const players = playersFrom(view, band, "u-sam");
const byId = Object.fromEntries(players.map((p) => [p.id, p]));

test("one player per lineup member, in lineup order", json(players.map((p) => p.id)) === json(["u-terry", "u-mike", "u-dana", "u-sam"]), json(players.map((p) => p.id)), "terry, mike, dana, sam");
test("names are the members' names", json(players.map((p) => p.name)) === json(["Terry Bass", "Mike Keys", "Dana Drums", "Sam Rivera"]), json(players.map((p) => p.name)));
test("a lineup id that is no longer a member gets no made-up player", !players.some((p) => p.id === "u-gone"));
test("a band member not on the lineup is left out", !players.some((p) => p.id === "u-ray"));
test("only the leader is marked leader", json(players.filter((p) => p.leader).map((p) => p.id)) === json(["u-mike"]), json(players.filter((p) => p.leader).map((p) => p.id)), "u-mike");
test("only me is marked you", json(players.filter((p) => p.you).map((p) => p.id)) === json(["u-sam"]), json(players.filter((p) => p.you).map((p) => p.id)), "u-sam");
test("a receipt for the current pack rev is downloaded", byId["u-mike"].downloaded && byId["u-sam"].downloaded);
test("a stale receipt is not downloaded", !byId["u-dana"].downloaded);
test("no receipt is not downloaded", !byId["u-terry"].downloaded);
test("no sync data before a live gig", players.every((p) => p.spreadMs === undefined && p.inTime === undefined && p.heardMsAgo === undefined));

const rows = statusRows(players);
test("rows read Downloaded ✓ or Not yet", json(rows.map((r) => r.downloaded)) === json(["Not yet", "Downloaded ✓", "Not yet", "Downloaded ✓"]), json(rows.map((r) => r.downloaded)));
test("rows read the gig's route word from routes.ts", rows.every((r) => r.routeText === CHOICE_WORDS.band_wifi.name), json(rows.map((r) => r.routeText)), CHOICE_WORDS.band_wifi.name);
test("rows have no bars, no In time and a blank Heard with no sync data", rows.every((r) => r.bars === null && r.barsText === "" && r.inTime === "" && r.heard === "Heard —"), json(rows[0]));
test("no row is amber with no sync data", rows.every((r) => !r.amber) && players.every((p) => !isAmber(p)));
test("an empty lineup has no players", playersFrom({ ...view, gig: { ...view.gig, lineup: [] } }, band, "u-sam").length === 0);

const close = () => {};
const blank = m.renderToStaticMarkup(m.createElement(m.BandStatusPanel, { players, onClose: close }));
test("the panel shows the live-gig line", blank.includes("Sync and timing show during a live gig."));
test("the panel shows no bars, no amber and no inline style", !blank.includes("□") && !blank.includes("band-status-amber") && !blank.includes("style="), blank);
test("the panel marks the leader and you", /Mike Keys.*?Leader/.test(blank) && /Sam Rivera.*?You/.test(blank), blank);

const live = [
  { ...byId["u-mike"], spreadMs: 1.5, p99Ms: 3, lateRate: 0, inTime: true, heardMsAgo: 2000 },
  { ...byId["u-dana"], spreadMs: 11, p99Ms: 15, lateRate: 0.05, inTime: false, heardMsAgo: 5000 },
];
const fed = m.renderToStaticMarkup(m.createElement(m.BandStatusPanel, { players: live, onClose: close }));
test("with sync data the panel renders one amber row, Out of sync, In time ✓ and Heard", (fed.match(/band-status-amber/g) ?? []).length === 1 && fed.includes("Out of sync") && fed.includes("In time ✓") && fed.includes("Heard 2 s ago"), fed);
test("with sync data the amber row carries no inline style", !fed.includes("style="), fed);
test("with sync data the faces mark the amber player by class", (m.renderToStaticMarkup(m.createElement(m.BandStatusFaces, { players: live })).match(/band-status-face-amber/g) ?? []).length === 1);
test("with no players the strip renders nothing", m.renderToStaticMarkup(m.createElement(m.BandStatusFaces, { players: [] })) === "");

// Test syncBars
test("syncBars(1.5) === 4", syncBars(1.5) === 4, syncBars(1.5), 4);
test("syncBars(2) === 4", syncBars(2) === 4, syncBars(2), 4);
test("syncBars(4) === 3", syncBars(4) === 3, syncBars(4), 3);
test("syncBars(7.5) === 2", syncBars(7.5) === 2, syncBars(7.5), 2);
test("syncBars(9) === 0", syncBars(9) === 0, syncBars(9), 0);

// Test barsText
test("barsText(9) === 'Out of sync'", barsText(9) === "Out of sync", barsText(9), "Out of sync");
test("barsText(1) === ''", barsText(1) === "", barsText(1), "");

// Test liveRating and the route word once C23 feeds sync data
const [steady, shaky] = statusRows(live);
test("liveRating of a steady player is Best", m.liveRating(live[0]) === "Best", m.liveRating(live[0]), "Best");
test("liveRating of a late player is Not steady", m.liveRating(live[1]) === "Not steady", m.liveRating(live[1]), "Not steady");
test("a fed row reads the route word and the rating", steady.routeText === `${CHOICE_WORDS.band_wifi.name} · Best` && shaky.routeText === `${CHOICE_WORDS.band_wifi.name} · Not steady`, `${steady.routeText} / ${shaky.routeText}`);
test("a fed row out of sync is amber with Out of sync and no bars", shaky.amber && shaky.barsText === "Out of sync" && shaky.bars === 0, json(shaky));
test("a fed steady row has four bars", steady.bars === 4 && !steady.amber, json(steady));

// Test player with lateRate 0.02 and spread 1 is amber
const testPlayer = {
  id: "test",
  name: "Test",
  leader: false,
  you: false,
  route: "band_wifi" as const,
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

if (failed === 0) {
  console.log("band-status: all checks passed");
  process.exit(0);
} else {
  process.exit(1);
}
