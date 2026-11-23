import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { SongContent } from "../src/band-library-model.ts";
import type { BandView } from "../src/bands-model.ts";
import type { GigView } from "../src/gig-plan-model.ts";
import { CHOICE_WORDS, ROUTE_WORDS } from "../src/routes.ts";
import { startApi, TEST_ORIGIN } from "./api-session.ts";
import { PASSWORD_PEPPER, passwordPlayer, WIDTH } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/**
 * C23, Band status at a glance (PLAN.md 7.5, FABLE-PLAN C23). The pure model cases, then a Worker-fed lineup of five
 * players (real accounts, a real gig and real pack receipts) joined with the leader's per-player ping statuses, then
 * the strip and the panel in a browser at 390x844.
 *
 * The contract these cases fix:
 * - `Player.live` is null before a gig goes live. During one, `livePlayers(players, leader, statuses, now)` gives each
 *   lineup player `{ kind: "leading" }`, `{ kind: "not-joined" }` or `{ kind: "heard", route, spreadMs, p99Ms, lateRate,
 *   inTime, heardMsAgo }`. A `PlayerStatus` is `{ id, route, spreadMs, p99Ms, lateRate, inTime, heardAt }`, with
 *   `heardAt` on the clock `now` reads. The newest status per player wins; a status for someone off the lineup is dropped.
 * - `seesBandStatus(admin, me, leader)`: only the admin and the live leader open Band status during a live gig.
 * - `BandStatusFaces({ players, live })`, with `live = { leader, admin, statuses(), now() }`, re-reads both getters
 *   about once a second. Faces carry `band-status-face-steady`, `-amber` or `-grey`, the leader `-leader`. Rows carry
 *   `band-status-amber` or `band-status-grey`. A player not heard for 10 s is amber. A player who never joined reads
 *   "Not joined" in grey. The leader with no one heard yet reads "Just you so far".
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const js = (value: unknown) => JSON.stringify(value);

execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "worker"], { cwd: root, stdio: "inherit" });

type Mod = typeof import("../src/band-status-model.ts") &
  typeof import("../src/band-status.tsx") & { renderToStaticMarkup: (el: unknown) => string; createElement: (c: unknown, p: unknown) => unknown };
const bundled = await build({
  stdin: {
    contents:
      'export * from "./src/band-status-model.ts"; export * from "./src/band-status.tsx"; export { renderToStaticMarkup } from "react-dom/server"; export { createElement } from "react";',
    resolveDir: root,
    loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic", logLevel: "silent", loader: { ".css": "empty" },
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const modFile = join(mkdtempSync(join(tmpdir(), "check-band-status-")), "m.mjs");
writeFileSync(modFile, bundled.outputFiles[0].text);
const m = (await import(pathToFileURL(modFile).href)) as Mod;

let failed = 0;
async function test(name: string, run: () => unknown) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------- the pure model

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
const view = {
  gig: { gigId: "g1", bandId: "b1", setlistId: "s1", name: "Friday", date: "2026-11-20", lineup: ["u-terry", "u-mike", "u-dana", "u-sam", "u-gone"], leader: "u-mike", backup: null, route: "band_wifi", status: "planned" },
  packRev: 3,
  receipts: [
    { userId: "u-mike", packRev: 3, at: 1 },
    { userId: "u-dana", packRev: 2, at: 1 },
    { userId: "u-sam", packRev: 3, at: 2 },
  ],
  songIds: [],
  songCount: 0,
} as unknown as GigView;
const pure = m.playersFrom(view, band, "u-sam");
const pureById = Object.fromEntries(pure.map((p) => [p.id, p]));

await test("one player per lineup member, in lineup order", () => assert.deepEqual(pure.map((p) => p.id), ["u-terry", "u-mike", "u-dana", "u-sam"]));
await test("names are the members' names", () => assert.deepEqual(pure.map((p) => p.name), ["Terry Bass", "Mike Keys", "Dana Drums", "Sam Rivera"]));
await test("a lineup id that is no longer a member gets no made-up player", () => assert.ok(!pure.some((p) => p.id === "u-gone")));
await test("a band member not on the lineup is left out", () => assert.ok(!pure.some((p) => p.id === "u-ray")));
await test("only the leader is marked leader", () => assert.deepEqual(pure.filter((p) => p.leader).map((p) => p.id), ["u-mike"]));
await test("only me is marked you", () => assert.deepEqual(pure.filter((p) => p.you).map((p) => p.id), ["u-sam"]));
await test("a receipt for the current pack rev is downloaded, a stale one or none is not", () =>
  assert.deepEqual(pure.map((p) => p.downloaded), [false, true, false, true]));
await test("no live feed before a gig goes live", () => assert.ok(pure.every((p) => p.live === null), js(pure)));
await test("an empty lineup has no players", () => assert.equal(m.playersFrom({ ...view, gig: { ...view.gig, lineup: [] } }, band, "u-sam").length, 0));

await test("planned rows read Downloaded ✓ or Not yet, the gig's route word, no bars, no In time, a blank Heard and no amber", () => {
  const rows = m.statusRows(pure);
  assert.deepEqual(rows.map((r) => r.downloaded), ["Not yet", "Downloaded ✓", "Not yet", "Downloaded ✓"]);
  assert.ok(rows.every((r) => r.routeText === CHOICE_WORDS.band_wifi.name), js(rows));
  assert.ok(rows.every((r) => r.bars === null && r.barsText === "" && r.inTime === "" && r.heard === "Heard —" && r.tone === "steady"), js(rows));
});
await test("the planned panel shows the live-gig line, marks the leader and you, and has no inline style", () => {
  const html = m.renderToStaticMarkup(m.createElement(m.BandStatusPanel, { players: pure, onClose: () => {} }));
  assert.ok(html.includes("Sync and timing show during a live gig."), html);
  assert.ok(/Mike Keys.*?Leader/.test(html) && /Sam Rivera.*?You/.test(html), html);
  assert.ok(!html.includes("style=") && !html.includes("□") && !html.includes("band-status-amber"), html);
});
await test("with no players the strip renders nothing", () => assert.equal(m.renderToStaticMarkup(m.createElement(m.BandStatusFaces, { players: [] })), ""));

await test("syncBars: four at 2 ms or less, three at 5, two at 8, else none", () =>
  assert.deepEqual([1.5, 2, 4, 5, 7.5, 8, 9].map(m.syncBars), [4, 4, 3, 3, 2, 2, 0]));
await test("barsText says Out of sync only past 8 ms", () => assert.deepEqual([m.barsText(9), m.barsText(1)], ["Out of sync", ""]));
await test("heardText rounds to whole seconds", () => assert.deepEqual([m.heardText(2000), m.heardText(0), m.heardText(9600)], ["Heard 2 s ago", "Heard 0 s ago", "Heard 10 s ago"]));

const status = (id: string, over: Partial<{ route: "wifi" | "internet" | "server"; spreadMs: number; p99Ms: number; lateRate: number; inTime: boolean; heardAt: number }> = {}) => ({
  id, route: "wifi" as const, spreadMs: 1.5, p99Ms: 80, lateRate: 0, inTime: true, heardAt: 1_000, ...over,
});
const liveOf = (players: ReturnType<typeof m.playersFrom>, id: string) => players.find((p) => p.id === id)?.live;

await test("a late-change rate over 1% is amber even at a 1 ms spread", () => {
  const [p] = m.livePlayers([pureById["u-sam"]], "u-mike", [status("u-sam", { spreadMs: 1, p99Ms: 2, lateRate: 0.02 })], 1_000);
  assert.equal(m.isAmber(p), true);
});
await test("the leader's row is leading, a joined player is heard, a player with no status is not joined", () => {
  const live = m.livePlayers(pure, "u-mike", [status("u-sam")], 3_000);
  assert.deepEqual(live.map((p) => p.live?.kind), ["not-joined", "leading", "not-joined", "heard"]);
  assert.deepEqual(liveOf(live, "u-sam"), { kind: "heard", route: "wifi", spreadMs: 1.5, p99Ms: 80, lateRate: 0, inTime: true, heardMsAgo: 2_000 });
});
await test("the live leader is marked, not the planned one", () => {
  const live = m.livePlayers(pure, "u-dana", [status("u-mike")], 1_000);
  assert.deepEqual(live.filter((p) => p.leader).map((p) => p.id), ["u-dana"]);
  assert.equal(liveOf(live, "u-dana")?.kind, "leading");
  assert.equal(liveOf(live, "u-mike")?.kind, "heard");
});
await test("re-added during a reconnect, a player has one row, from the newest status", () => {
  const live = m.livePlayers(pure, "u-mike", [status("u-sam", { heardAt: 5_000, route: "server", spreadMs: 6 }), status("u-sam", { heardAt: 1_000, route: "wifi", spreadMs: 11 })], 6_000);
  assert.equal(live.filter((p) => p.id === "u-sam").length, 1);
  const sam = m.statusRows(live).find((r) => r.id === "u-sam");
  assert.equal(sam?.routeText, `${ROUTE_WORDS.server} · Good`);
  assert.equal(sam?.heard, "Heard 1 s ago");
});
await test("a status from someone off the lineup makes no row", () => {
  const live = m.livePlayers(pure, "u-mike", [status("u-ray"), status("u-gone")], 1_000);
  assert.deepEqual(live.map((p) => p.id), ["u-terry", "u-mike", "u-dana", "u-sam"]);
});
await test("a phone that drops out goes amber at 10 s and comes back steady when it rescans", () => {
  const at = (heardAt: number, now: number) => m.statusRows(m.livePlayers(pure, "u-mike", [status("u-sam", { heardAt })], now)).find((r) => r.id === "u-sam");
  assert.equal(at(1_000, 10_000)?.tone, "steady", "9 s quiet is not amber yet");
  assert.equal(at(1_000, 11_000)?.tone, "amber", "10 s quiet is amber");
  assert.equal(at(1_000, 11_000)?.heard, "Heard 10 s ago");
  assert.equal(at(11_000, 11_000)?.tone, "steady", "a fresh ping after the rescan is steady");
});
await test("a lineup player who never joined reads Not joined in grey", () => {
  const dana = m.statusRows(m.livePlayers(pure, "u-mike", [], 1_000)).find((r) => r.id === "u-dana");
  assert.equal(dana?.routeText, "Not joined");
  assert.equal(dana?.tone, "grey");
  assert.equal(dana?.bars, null);
});
await test("only the admin and the leader see Band status", () => {
  assert.equal(m.seesBandStatus(true, "u-terry", "u-mike"), true, "the admin");
  assert.equal(m.seesBandStatus(false, "u-mike", "u-mike"), true, "the leader");
  assert.equal(m.seesBandStatus(false, "u-sam", "u-mike"), false, "a member");
  assert.equal(m.seesBandStatus(false, "u-mike", "u-dana"), false, "a member who led before the hand-off");
});

// ---------------------------------------------------------------- the Worker-fed lineup

const day = new Date(Date.now() + 2 * 86_400_000);
const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: (SongContent & { id: number })[] };
const { id: _seedId, ...song } = seed.songs[0];

const { worker, base } = await startApi({ PASSWORD_PEPPER });
let fed: { view: GigView; band: BandView; ids: Record<"terry" | "mike" | "dana" | "sam" | "ana", string> };
try {
  const terry = await passwordPlayer(base, TEST_ORIGIN, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(base, TEST_ORIGIN, "Mike Keys", "mikekeys");
  const dana = await passwordPlayer(base, TEST_ORIGIN, "Dana Drums", "danadrums");
  const sam = await passwordPlayer(base, TEST_ORIGIN, "Sam Rivera", "samrivera");
  const ana = await passwordPlayer(base, TEST_ORIGIN, "Ana Lee", "analee");
  const bandId = (await terry.call("/api/bands/create", { name: "The Blue Notes" })).body.bandId as string;
  const invite = (await terry.call("/api/codes", { kind: "band", bandId })).body.code as string;
  for (const who of [mike, dana, sam, ana]) assert.equal((await who.call("/api/bands/join", { code: invite })).status, 200, `${who.name} joins`);
  const shared = await terry.call("/api/bands/library/share-song", { bandId, song, choice: "public", localId: null });
  assert.equal(shared.status, 200, `Terry shares a song (${js(shared.body)})`);
  const setlist = await terry.call("/api/bands/library/share-setlist", { bandId, name: "Set", songIds: [shared.body.songId], tags: [], choice: "public", localId: null });
  assert.equal(setlist.status, 200, `Terry shares a set (${js(setlist.body)})`);
  const gigId = `gig_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;
  const lineup = [terry, mike, dana, sam, ana].map((who) => who.userId);
  const planned = await terry.call("/api/bands/gig/plan", { bandId, setlistId: setlist.body.setlistId, gigId, name: "Friday at the Elks", date, lineup, leader: mike.userId });
  assert.equal(planned.status, 200, `Terry plans Friday (${js(planned.body)})`);
  const pack = (who: typeof terry) => who.call("/api/bands/gig/pack", { bandId, gigId });
  assert.equal((await pack(dana)).status, 200, "Dana downloads the first pack");
  assert.equal((await terry.call("/api/bands/gig/route", { bandId, gigId, route: "band_wifi" })).status, 200, "Terry moves Friday to band Wi-Fi, a new pack rev");
  for (const who of [mike, sam, ana]) assert.equal((await pack(who)).status, 200, `${who.name} downloads the new pack`);
  const opened = await terry.call("/api/bands/gig/open", { bandId, gigId });
  assert.equal(opened.status, 200, `Terry opens Friday (${js(opened.body)})`);
  const bandOpen = await terry.call("/api/bands/open", { bandId });
  assert.equal(bandOpen.status, 200, "Terry opens the band");
  fed = {
    view: opened.body as GigView,
    band: { ...(bandOpen.body as BandView), members: bandOpen.body.members },
    ids: { terry: terry.userId, mike: mike.userId, dana: dana.userId, sam: sam.userId, ana: ana.userId },
  };
} finally {
  await worker.dispose();
}

const { ids } = fed;
const NOW = 100_000;
/** What Mike's fan-out heard from each follower: three routes, Mike leading, Dana out of sync (PLAN.md 7.5 table). */
const statuses = [
  status(ids.sam, { route: "wifi", spreadMs: 1.5, p99Ms: 80, lateRate: 0, inTime: true, heardAt: NOW - 2_000 }),
  status(ids.ana, { route: "internet", spreadMs: 4, p99Ms: 200, lateRate: 0, inTime: true, heardAt: NOW - 1_000 }),
  status(ids.terry, { route: "server", spreadMs: 7.5, p99Ms: 300, lateRate: 0, inTime: true, heardAt: NOW - 3_000 }),
  status(ids.dana, { route: "wifi", spreadMs: 11, p99Ms: 150, lateRate: 0.05, inTime: false, heardAt: NOW - 4_000 }),
];
const expected: Record<string, { name: string; route: string; bars: number | null; out: boolean; downloaded: string; inTime: boolean; amber: boolean }> = {
  [ids.terry]: { name: "Terry Bass", route: `${ROUTE_WORDS.server} · Good`, bars: 2, out: false, downloaded: "Not yet", inTime: true, amber: false },
  [ids.mike]: { name: "Mike Keys", route: "", bars: null, out: false, downloaded: "Downloaded ✓", inTime: false, amber: false },
  [ids.dana]: { name: "Dana Drums", route: `${ROUTE_WORDS.wifi} · Not steady`, bars: 0, out: true, downloaded: "Not yet", inTime: false, amber: true },
  [ids.sam]: { name: "Sam Rivera", route: `${ROUTE_WORDS.wifi} · Best`, bars: 4, out: false, downloaded: "Downloaded ✓", inTime: true, amber: false },
  [ids.ana]: { name: "Ana Lee", route: `${ROUTE_WORDS.internet} · Better`, bars: 3, out: false, downloaded: "Downloaded ✓", inTime: true, amber: false },
};
const lineupFor = (me: string) => m.playersFrom(fed.view, fed.band, me);

await test("the Worker's gig gives five lineup players with Mike as the planned leader", () => {
  const players = lineupFor(ids.terry);
  assert.deepEqual(players.map((p) => p.name), ["Terry Bass", "Mike Keys", "Dana Drums", "Sam Rivera", "Ana Lee"]);
  assert.deepEqual(players.filter((p) => p.leader).map((p) => p.id), [ids.mike]);
});

await test("each row shows the right route word, bar count and rating", () => {
  const rows = m.statusRows(m.livePlayers(lineupFor(ids.terry), ids.mike, statuses, NOW));
  for (const row of rows) {
    const want = expected[row.id];
    assert.equal(row.routeText, want.route, `${want.name}'s route and rating`);
    assert.equal(row.bars, want.bars, `${want.name}'s bars`);
    assert.equal(row.barsText, want.out ? "Out of sync" : "", `${want.name}'s Out of sync`);
  }
  const html = m.renderToStaticMarkup(m.createElement(m.BandStatusPanel, { players: m.livePlayers(lineupFor(ids.terry), ids.mike, statuses, NOW), onClose: () => {} }));
  for (const want of Object.values(expected).filter((w) => w.route)) assert.ok(html.includes(want.route), `the panel reads ${want.route}`);
  assert.ok(!html.includes("Sync and timing show during a live gig."), "the planned-gig line is gone once the gig is live");
});

await test("Downloaded ✓ and In time ✓ come from pack_receipts and the heard click", () => {
  const current = new Set(fed.view.receipts.filter((r) => r.packRev === fed.view.packRev).map((r) => r.userId));
  assert.deepEqual([...current].sort(), [ids.mike, ids.sam, ids.ana].sort(), "the Worker holds current receipts for Mike, Sam and Ana; Dana's is stale; Terry has none");
  const rows = m.statusRows(m.livePlayers(lineupFor(ids.terry), ids.mike, statuses, NOW));
  for (const row of rows) {
    const want = expected[row.id];
    assert.equal(row.downloaded, want.downloaded, `${want.name}'s download`);
    assert.equal(row.inTime, want.inTime ? "In time ✓" : "", `${want.name}'s In time`);
  }
});

await test("the leader alone reads Just you so far", () => {
  const html = m.renderToStaticMarkup(m.createElement(m.BandStatusPanel, { players: m.livePlayers(lineupFor(ids.mike), ids.mike, [], NOW), onClose: () => {} }));
  assert.ok(html.includes("Just you so far"), html);
  const busy = m.renderToStaticMarkup(m.createElement(m.BandStatusPanel, { players: m.livePlayers(lineupFor(ids.mike), ids.mike, statuses, NOW), onClose: () => {} }));
  assert.ok(!busy.includes("Just you so far"), "not once someone is heard");
});

// ---------------------------------------------------------------- the strip and the panel in a browser

const harness = await build({
  stdin: {
    contents: `
      import { createElement } from "react";
      import { createRoot } from "react-dom/client";
      import { BandStatusFaces } from "./src/band-status.tsx";
      let root = null;
      window.__statuses = [];
      window.__now = 0;
      window.__mount = (props) => {
        root?.unmount();
        document.getElementById("harness")?.remove();
        const host = document.createElement("div");
        host.id = "harness";
        host.className = "app";
        document.body.append(host);
        root = createRoot(host);
        const live = props.live && { ...props.live, statuses: () => window.__statuses, now: () => window.__now };
        root.render(createElement(BandStatusFaces, { players: props.players, live }));
      };`,
    resolveDir: root,
    loader: "tsx",
  },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", logLevel: "silent", loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"production"' },
});

const FACE = "#harness .band-status-faces .band-status-face";
const SHEET = "#harness [role=dialog].band-status-sheet";
const site = await openSite(root, "check-band-status");
try {
  await site.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 844, deviceScaleFactor: 1, mobile: true });
  await site.send("Emulation.setScriptExecutionDisabled", { value: true });
  await site.send("Page.enable");
  await site.send("Page.navigate", { url: `${site.origin}/` });
  const until = async (expression: string, what: string, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await site.evaluate<boolean>(`(() => { try { return !!(${expression}); } catch { return false; } })()`)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  await until(`document.readyState === "complete" && [...document.styleSheets].some((sheet) => { try { return [...sheet.cssRules].some((rule) => rule.selectorText?.includes(".band-status-row")); } catch { return false; } })`, "the app's styles", 15000);
  await site.send("Emulation.setScriptExecutionDisabled", { value: false });
  await site.evaluate(`${harness.outputFiles[0].text}; true`);

  const mount = async (me: string, live: { leader: string; admin: boolean }, list = statuses, now = NOW) => {
    await site.evaluate(`window.__statuses = ${js(list)}; window.__now = ${now}; window.__mount(${js({ players: lineupFor(me), live })}); true`);
    await until(`document.querySelectorAll(${js(FACE)}).length === 5`, "five faces");
  };
  const face = (name: string) => `[...document.querySelectorAll(${js(FACE)})].find((el) => el.getAttribute("aria-label").startsWith(${js(name)}))`;
  const row = (name: string) => `[...document.querySelectorAll(${js(`${SHEET} .band-status-row`)})].find((el) => el.querySelector(".band-status-name").textContent.trim() === ${js(name)})`;
  const tap = (name: string) => site.evaluate(`${face(name)}.click(); true`);
  const isOpen = () => site.evaluate<boolean>(`!!document.querySelector(${js(SHEET)})`);
  const close = async () => {
    await site.evaluate(`document.querySelector(${js(`${SHEET} [aria-label=Close]`)}).click(); true`);
    await until(`!document.querySelector(${js(SHEET)})`, "the panel to close");
  };
  const token = (name: string, property: "color" | "borderTopColor" = "color") =>
    site.evaluate<string>(`(() => {
      const probe = document.createElement("span");
      probe.style.${property === "color" ? "color" : "borderTop"} = ${js(property === "color" ? `var(${name})` : `2px solid var(${name})`)};
      document.getElementById("harness").appendChild(probe);
      const value = getComputedStyle(probe)[${js(property)}];
      probe.remove();
      return value;
    })()`);
  const asAdmin = { leader: ids.mike, admin: true };

  await test("the out-of-sync player is amber and the text is at least 16 px", async () => {
    await mount(ids.terry, asAdmin);
    await tap("Terry Bass");
    await until(`!!document.querySelector(${js(SHEET)})`, "the panel");
    const danger = await token("--danger");
    const text = await token("--text");
    assert.notEqual(danger, text, "the theme's danger and text tokens differ");
    const dana = await site.evaluate<{ amber: boolean; colors: string[] }>(`(() => { const el = ${row("Dana Drums")}; return { amber: el.classList.contains("band-status-amber"), colors: [el, ...el.querySelectorAll("span")].filter((n) => n.textContent.trim()).map((n) => getComputedStyle(n).color) }; })()`);
    assert.ok(dana.amber, "Dana's row is marked amber");
    assert.deepEqual([...new Set(dana.colors)], [danger], "every word in Dana's row paints the danger token");
    const amberRows = await site.evaluate<string[]>(`[...document.querySelectorAll(${js(`${SHEET} .band-status-amber .band-status-name`)})].map((el) => el.textContent.trim())`);
    assert.deepEqual(amberRows, ["Dana Drums"], "Dana is the only amber row");
    assert.equal(await site.evaluate<string>(`getComputedStyle(${row("Sam Rivera")}.querySelector(".band-status-name")).color`), text, "a steady name paints the text token");
    const sizes = await site.evaluate<number[]>(`[...document.querySelectorAll(${js(`${SHEET} .band-status-row`)})].flatMap((el) => [el, ...el.querySelectorAll("span")]).filter((n) => n.textContent.trim()).map((n) => parseFloat(getComputedStyle(n).fontSize))`);
    assert.ok(sizes.length > 0 && sizes.every((size) => size >= 16), `every word in the panel is at least 16 px (${js([...new Set(sizes)])})`);
    await close();
  });

  await test("the faces strip shows one ring per player colored by status", async () => {
    await mount(ids.terry, asAdmin);
    const faces = await site.evaluate<{ label: string; classes: string[]; ring: string; style: string }[]>(
      `[...document.querySelectorAll(${js(FACE)})].map((el) => ({ label: el.getAttribute("aria-label"), classes: [...el.classList], ring: getComputedStyle(el).borderTopColor, style: getComputedStyle(el).borderTopStyle }))`,
    );
    assert.equal(faces.length, 5, "one face per lineup player");
    const kind = (label: string) => faces.find((f) => f.label.startsWith(label))!;
    const count = (cls: string) => faces.filter((f) => f.classes.includes(cls)).length;
    assert.deepEqual([count("band-status-face-steady"), count("band-status-face-amber"), count("band-status-face-leader")], [3, 1, 1], js(faces));
    assert.ok(kind("Dana Drums").classes.includes("band-status-face-amber"), "Dana's face is amber");
    assert.ok(kind("Mike Keys").classes.includes("band-status-face-leader"), "Mike's face is the leader's");
    assert.equal(kind("Dana Drums").ring, await token("--danger", "borderTopColor"), "an amber ring is the danger token");
    assert.equal(kind("Mike Keys").ring, await token("--accent", "borderTopColor"), "the leader's ring is the accent token");
    assert.equal(kind("Sam Rivera").ring, await token("--text", "borderTopColor"), "a steady ring is the text token");
    assert.ok(faces.every((f) => f.style !== "none"), "every face has a ring");
    assert.equal(new Set([kind("Dana Drums").ring, kind("Mike Keys").ring, kind("Sam Rivera").ring]).size, 3, "the three statuses ring in three colors");
    await mount(ids.terry, asAdmin, statuses.filter((s) => s.id !== ids.ana));
    const ana = await site.evaluate<{ classes: string[]; ring: string }>(`(() => { const el = ${face("Ana Lee")}; return { classes: [...el.classList], ring: getComputedStyle(el).borderTopColor }; })()`);
    assert.ok(ana.classes.includes("band-status-face-grey"), `Ana, never joined, is grey (${js(ana.classes)})`);
    assert.equal(ana.ring, await token("--text-dim", "borderTopColor"), "a grey ring is the dim text token");
  });

  await test("only the admin and the leader see Band status", async () => {
    await mount(ids.sam, { leader: ids.mike, admin: false });
    await tap("Mike Keys");
    await new Promise((done) => setTimeout(done, 600));
    assert.equal(await isOpen(), false, "Sam, a member, taps and nothing opens");
    await mount(ids.mike, { leader: ids.dana, admin: false }, statuses.filter((s) => s.id !== ids.dana).concat(status(ids.mike, { heardAt: NOW })));
    await tap("Dana Drums");
    await new Promise((done) => setTimeout(done, 600));
    assert.equal(await isOpen(), false, "Mike, once Dana has taken the lead, taps and nothing opens");
    await mount(ids.mike, { leader: ids.mike, admin: false });
    await tap("Sam Rivera");
    await until(`!!document.querySelector(${js(SHEET)})`, "the panel for the leader");
    await close();
    await mount(ids.terry, asAdmin);
    await tap("Sam Rivera");
    await until(`!!document.querySelector(${js(SHEET)})`, "the panel for the admin");
    await close();
  });

  await test("'Heard 2 s ago' updates from the leader's last ping, and a player not heard for 10 s shows amber", async () => {
    await mount(ids.terry, asAdmin);
    await tap("Sam Rivera");
    await until(`!!document.querySelector(${js(SHEET)})`, "the panel");
    const heard = (name: string) => site.evaluate<string>(`${row(name)}.querySelector(".band-status-heard").textContent.trim()`);
    assert.equal(await heard("Sam Rivera"), "Heard 2 s ago");
    await site.evaluate(`window.__now = ${NOW + 5_000}; true`);
    await until(`${row("Sam Rivera")}.querySelector(".band-status-heard").textContent.trim() === "Heard 7 s ago"`, "Heard 7 s ago with no new ping");
    assert.ok(!(await site.evaluate<boolean>(`${row("Sam Rivera")}.classList.contains("band-status-amber")`)), "7 s quiet is not amber");
    await site.evaluate(`window.__now = ${NOW + 8_000}; true`);
    await until(`${row("Sam Rivera")}.classList.contains("band-status-amber")`, "Sam's row amber at 10 s");
    assert.equal(await heard("Sam Rivera"), "Heard 10 s ago");
    assert.ok(await site.evaluate<boolean>(`${face("Sam Rivera")}.classList.contains("band-status-face-amber")`), "Sam's face goes amber too");
    await site.evaluate(`window.__statuses = window.__statuses.map((s) => s.id === ${js(ids.sam)} ? { ...s, heardAt: ${NOW + 8_000} } : s); true`);
    await until(`!${row("Sam Rivera")}.classList.contains("band-status-amber")`, "Sam steady again after a fresh ping");
    assert.equal(await heard("Sam Rivera"), "Heard 0 s ago");
    assert.ok(await site.evaluate<boolean>(`${face("Sam Rivera")}.classList.contains("band-status-face-steady")`), "Sam's face is steady again");
    await close();
  });

  await test("a player who never joined reads Not joined in grey, and the leader alone reads Just you so far", async () => {
    await mount(ids.mike, { leader: ids.mike, admin: false }, []);
    await tap("Mike Keys");
    await until(`!!document.querySelector(${js(SHEET)})`, "the panel");
    const ana = await site.evaluate<{ grey: boolean; route: string; color: string }>(`(() => { const el = ${row("Ana Lee")}; return { grey: el.classList.contains("band-status-grey"), route: el.querySelector(".band-status-route").textContent.trim(), color: getComputedStyle(el.querySelector(".band-status-name")).color }; })()`);
    assert.deepEqual(ana, { grey: true, route: "Not joined", color: await token("--text-dim") }, "Ana's row");
    assert.deepEqual(await site.evaluate<string[]>(`[...document.querySelectorAll(${js(`${SHEET} .band-status-line`)})].map((el) => el.textContent.trim())`), ["Just you so far"]);
    await close();
    assert.equal(await site.evaluate<number>(`document.querySelectorAll(${js(FACE)}).length`), 5, "the strip stays after the panel closes");
  });
} finally {
  await site.close();
}

if (failed > 0) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("check:band-status passed");
