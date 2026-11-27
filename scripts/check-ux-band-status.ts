import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { SongContent } from "../src/band-library-model.ts";
import type { GigPlan } from "../src/gig-pack.ts";
import { CHOICE_WORDS, ROUTE_WORDS } from "../src/routes.ts";
import { startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, WIDTH } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/**
 * U7, the band status strip and panel wired to real people (UX-PLAN U7, SCREEN-MAP 4 and 5). One case per pass
 * condition, named by it. The cases fix this contract.
 *
 * The strip is `.band-status-faces` inside a `.band-status-slot`: on the band page under `.next-gig`, and on the gig
 * view `.gig-view`. It holds one `button.band-status-face` per lineup player who is a member of the band, showing their
 * initials, with `aria-label` the member's name, and `"<name>, leader"` for tonight's leader. With no live or planned gig
 * there is no strip. Tapping a face opens the panel, a `[role=dialog].band-status-sheet` bottom sheet with one
 * `.band-status-row` per face: `.band-status-name` (the member's name), `.band-status-route` (the gig's route word from
 * `src/routes.ts` `CHOICE_WORDS`), `.band-status-downloaded` ("Downloaded ✓" when the player's receipt is for the
 * current pack rev, else "Not yet") and `.band-status-heard` ("Heard —" until a live gig feeds it). Under the rows the
 * line "Sync and timing show during a live gig." Its ✕ is `[aria-label=Close]`; Escape closes it too. Amber is the
 * `.band-status-amber` row and `.band-status-face-amber` face, colored by the `--danger` token.
 */

type Reply = { status: number; body: Record<string, any> };
type GigView = { gig: GigPlan; packRev: number; receipts: { userId: string; packRev: number; at: number }[] };
type Box = { x: number; y: number; w: number; h: number; bottom: number; right: number };

const root = fileURLToPath(new URL("..", import.meta.url));
const js = (value: unknown) => JSON.stringify(value);
const gigId = () => `gig_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;
const dayFromNow = (days: number) => {
  const day = new Date();
  day.setDate(day.getDate() + days);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};

const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: (SongContent & { id: number })[] };
const content = ({ id: _id, ...song }: SongContent & { id: number }): SongContent => song;
const LIVE_LINE = "Sync and timing show during a live gig.";
const STRIP = ".band-status-slot .band-status-faces";
const SHEET = "[role=dialog].band-status-sheet";

let failed = 0;
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function viewOf(reply: Reply, what: string): GigView {
  assert.equal(reply.status, 200, `${what} (${js(reply.body)})`);
  return reply.body as GigView;
}

let apiBase = "";
const site = await openSite(root, "check-ux-band-status", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;
try {
  const app = await appPage(site);
  const appCalls = (path: string, body: object) =>
    site.evaluate<Reply>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const has = (selector: string) => site.evaluate<boolean>(`!!document.querySelector(${js(selector)})`);
  const texts = (selector: string) => site.evaluate<string[]>(`[...document.querySelectorAll(${js(selector)})].map((el) => el.textContent.trim())`);
  const labels = (selector: string) => site.evaluate<string[]>(`[...document.querySelectorAll(${js(selector)})].map((el) => el.getAttribute("aria-label"))`);
  const box = (selector: string) =>
    site.evaluate<Box | null>(`(() => { const el = document.querySelector(${js(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right }; })()`);
  const boxes = (selector: string) =>
    site.evaluate<Box[]>(`[...document.querySelectorAll(${js(selector)})].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right }; })`);
  const go = async (next: string, ready: string, what: string) => {
    await site.evaluate(`location.hash = ${js(next)}`);
    await app.until(ready, what, 15000);
  };
  const bandPage = (id: string) => `document.querySelector(${js(`.band-page[data-band="${id}"]`)})`;
  const openBand = async (id: string) => {
    await go("#/songs", `!document.querySelector(".band-page")`, "off the band page");
    await go(`#/band/${id}`, `${bandPage(id)}?.dataset.view === "band" && !${bandPage(id)}.textContent.includes("Loading")`, "the band page");
  };
  const gigViewOf = (id: string) => `document.querySelector(${js(`.gig-view[data-gig="${id}"]`)})`;
  const openGigView = (band: string, id: string) =>
    go(`#/gig/${band}/${id}`, `!!${gigViewOf(id)} && !${gigViewOf(id)}.textContent.includes("Loading")`, `the gig view for ${id}`);
  const openPanel = async () => {
    await app.until(`!!document.querySelector(${js(`${STRIP} .band-status-face`)})`, "a face in the strip");
    await site.evaluate(`document.querySelector(${js(`${STRIP} .band-status-face`)}).click()`);
    await app.until(`!!document.querySelector(${js(SHEET)})`, "the band status panel");
  };
  const closePanel = async () => {
    await site.evaluate(`document.querySelector(${js(`${SHEET} [aria-label=Close]`)})?.click()`);
    await app.until(`!document.querySelector(${js(SHEET)})`, "the panel to close");
  };
  /** The computed color a `var(--token)` resolves to where the strip sits, so the check reads the theme, not a hex. */
  const tokenColor = (token: string, property: "color" | "borderTopColor" = "color") =>
    site.evaluate<string>(`(() => {
      const probe = document.createElement("span");
      probe.style.${property === "color" ? "color" : "borderTop"} = ${js(property === "color" ? `var(${token})` : `1px solid var(${token})`)};
      document.querySelector(${js(STRIP)}).appendChild(probe);
      const value = getComputedStyle(probe)[${js(property)}];
      probe.remove();
      return value;
    })()`);

  const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
  const dana = await passwordPlayer(base, origin, "Dana Drums", "danadrums");
  const ana = await passwordPlayer(base, origin, "Ana Lee", "analee");
  const leo = await passwordPlayer(base, origin, "Leo Park", "leopark");
  const kim = await passwordPlayer(base, origin, "Kim Cho", "kimcho");
  const ray = await passwordPlayer(base, origin, "Ray Fox", "rayfox");
  const others = [mike, dana, ana, leo, kim, ray];

  const newBand = async (name: string, members: typeof others) => {
    const bandId = (await terry.call("/api/bands/create", { name })).body.bandId as string;
    const invite = (await terry.call("/api/codes", { kind: "band", bandId })).body.code as string;
    for (const member of members) assert.equal((await member.call("/api/bands/join", { code: invite })).status, 200, `${member.name} joins ${name}`);
    const shared: string[] = [];
    for (const song of seed.songs.slice(0, 2)) {
      const reply = await terry.call("/api/bands/library/share-song", { bandId, song: content(song), choice: "public", localId: null });
      assert.equal(reply.status, 200, `Terry shares ${song.title} into ${name}`);
      shared.push(reply.body.songId);
    }
    const setlist = await terry.call("/api/bands/library/share-setlist", { bandId, name: "Set", songIds: shared, tags: [], choice: "public", localId: null });
    assert.equal(setlist.status, 200, `Terry shares a set into ${name} (${js(setlist.body)})`);
    return { bandId, invite, setlistId: setlist.body.setlistId as string };
  };

  const blue = await newBand("The Blue Notes", others);
  const tide = await newBand("Low Tide", []);
  const quiet = await newBand("Quiet Room", []);

  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await app.library();
  await app.signUp("Sam Rivera");
  const sam = await site.evaluate<{ account?: { userId: string } }>(`fetch("/api/me").then((r) => r.json())`).then((reply) => reply.account);
  assert.ok(sam, "Sam is signed in on the phone");
  for (const band of [blue, tide, quiet]) assert.equal((await appCalls("/api/bands/join", { code: band.invite })).status, 200, "Sam joins");

  const lineup = [terry.userId, sam.userId, mike.userId, dana.userId, ana.userId, leo.userId, kim.userId];
  const friday = viewOf(
    await terry.call("/api/bands/gig/plan", { bandId: blue.bandId, setlistId: blue.setlistId, gigId: gigId(), name: "Friday at the Elks", date: dayFromNow(2), lineup, leader: mike.userId }),
    "Terry plans Friday with Mike leading",
  ).gig.gigId;
  const pack = (who: typeof terry) => who.call("/api/bands/gig/pack", { bandId: blue.bandId, gigId: friday });
  assert.equal((await pack(dana)).status, 200, "Dana downloads the first pack");
  const before = viewOf(await terry.call("/api/bands/gig/open", { bandId: blue.bandId, gigId: friday }), "Friday before the route change").packRev;
  const moved = viewOf(await terry.call("/api/bands/gig/route", { bandId: blue.bandId, gigId: friday, route: "band_wifi" }), "Terry sets Friday to band Wi-Fi");
  assert.ok(moved.packRev > before, `the route change makes a new pack rev (${before} -> ${moved.packRev})`);
  for (const who of [mike, ana]) assert.equal((await pack(who)).status, 200, `${who.name} downloads the new pack`);

  const lowTide = viewOf(
    await terry.call("/api/bands/gig/plan", { bandId: tide.bandId, setlistId: tide.setlistId, gigId: gigId(), name: "Pier night", date: dayFromNow(3), lineup: [terry.userId, sam.userId], leader: terry.userId }),
    "Terry plans Pier night on Auto",
  ).gig;

  await openBand(blue.bandId);
  await app.until(`/Pack 2 of 2 downloaded/.test(${bandPage(blue.bandId)}.querySelector(".next-gig")?.textContent ?? "")`, "Sam's pack on this phone", 20000);
  const fresh = viewOf(await terry.call("/api/bands/gig/open", { bandId: blue.bandId, gigId: friday }), "Friday after the downloads");
  const names = Object.fromEntries(((await terry.call("/api/bands/open", { bandId: blue.bandId })).body.members as { userId: string; name: string }[]).map((m) => [m.userId, m.name]));
  const lineupNames = lineup.map((id) => names[id]);
  const current = new Set(fresh.receipts.filter((r) => r.packRev === fresh.packRev).map((r) => r.userId));
  assert.deepEqual(
    lineup.filter((id) => current.has(id)).map((id) => names[id]).sort(),
    ["Ana Lee", "Mike Keys", "Sam Rivera"],
    "Sam, Mike and Ana hold the current pack; Dana's is stale; Terry, Leo and Kim have none",
  );
  await openBand(blue.bandId);

  await check("the strip shows one face per lineup member with the leader marked, and every name is a real member", async () => {
    await app.until(`document.querySelectorAll(${js(`${STRIP} .band-status-face`)}).length > 0`, "the strip on the band page");
    const faces = await labels(`${STRIP} .band-status-face`);
    assert.equal(faces.length, lineup.length, `one face per lineup player, not per band member (${js(faces)})`);
    assert.deepEqual(faces.filter((label) => label?.endsWith(", leader")), ["Mike Keys, leader"], "only Mike's face is marked leader");
    assert.deepEqual(faces.map((label) => label?.replace(/, leader$/, "")).sort(), [...lineupNames].sort(), "every face is a real lineup member's name");
    assert.ok(!faces.some((label) => label?.startsWith("Ray Fox")), "Ray, in the band but not on the lineup, has no face");
    for (const initials of await texts(`${STRIP} .band-status-face`)) assert.match(initials, /^\p{Lu}{1,2}$/u, "a face shows initials");
    await openPanel();
    assert.deepEqual((await texts(`${SHEET} .band-status-name`)).sort(), [...lineupNames].sort(), "the panel names are the same real members");
    assert.match((await texts(`${SHEET} .band-status-row`)).find((row) => row.includes("Mike Keys")) ?? "", /Leader/, "Mike's row says Leader");
    await closePanel();
  });

  await check("a member whose receipt matches the pack rev shows Downloaded ✓ in the panel and the others Not yet", async () => {
    await openPanel();
    const rows = await site.evaluate<{ name: string; downloaded: string }[]>(
      `[...document.querySelectorAll(${js(`${SHEET} .band-status-row`)})].map((row) => ({ name: row.querySelector(".band-status-name").textContent.trim(), downloaded: row.querySelector(".band-status-downloaded")?.textContent.trim() ?? "" }))`,
    );
    for (const id of lineup) {
      const row = rows.find((item) => item.name === names[id]);
      assert.ok(row, `a row for ${names[id]}`);
      assert.equal(row.downloaded, current.has(id) ? "Downloaded ✓" : "Not yet", `${names[id]} ${current.has(id) ? "holds" : "does not hold"} pack rev ${fresh.packRev}`);
    }
    await closePanel();
  });

  await check("with no sync data there are no bars, no In time, no amber, and the live-gig line shows", async () => {
    await openPanel();
    const sheet = await texts(SHEET);
    assert.ok(!(await has(`${SHEET} .band-status-bars-boxes`)) && !sheet[0].includes("□"), "no sync bars");
    assert.ok(!sheet[0].includes("In time") && !sheet[0].includes("Out of sync"), `no In time and no Out of sync (${sheet[0]})`);
    assert.ok(!(await has(".band-status-amber")) && !(await has(".band-status-face-amber")), "no amber row or face");
    assert.deepEqual([...new Set(await texts(`${SHEET} .band-status-heard`))], ["Heard —"], "Heard is blank");
    assert.deepEqual(await texts(`${SHEET} .band-status-line`), [LIVE_LINE], "the one live-gig line under the rows");
    await closePanel();
  });

  await check("the route word comes from routes.ts", async () => {
    await openPanel();
    assert.equal(ROUTE_WORDS.wifi, CHOICE_WORDS.band_wifi.name, "the band Wi-Fi choice is spelled by the live link word");
    assert.deepEqual([...new Set(await texts(`${SHEET} .band-status-route`))], [CHOICE_WORDS.band_wifi.name], "Friday's rows read the band Wi-Fi word");
    await closePanel();
    await openBand(tide.bandId);
    await openPanel();
    assert.deepEqual([...new Set(await texts(`${SHEET} .band-status-route`))], [CHOICE_WORDS[lowTide.route].name], "Pier night's rows read the Auto word");
    await closePanel();
    const model = readFileSync(join(root, "src", "band-status-model.ts"), "utf8");
    const words = [...Object.values(ROUTE_WORDS), ...Object.values(CHOICE_WORDS).map((choice) => choice.name)];
    assert.deepEqual(words.filter((word) => model.includes(js(word))), [], "the model spells no route word of its own");
    assert.match(model, /from "\.\/routes"/, "the model reads the words from src/routes.ts");
  });

  await check("the strip hides with no planned gig", async () => {
    await openBand(tide.bandId);
    await app.until(`document.querySelectorAll(${js(`${STRIP} .band-status-face`)}).length === 2`, "Low Tide's strip while Pier night is planned");
    await openBand(quiet.bandId);
    await app.until(`/No gig planned/.test(${bandPage(quiet.bandId)}.textContent)`, "Quiet Room says No gig planned");
    assert.ok(!(await has(".band-status-faces")), "no strip with no gig");
    assert.ok(!(await has(".band-status-face")), "no faces with no gig");
    assert.equal((await terry.call("/api/bands/gig/end", { bandId: tide.bandId, gigId: lowTide.gigId })).status, 200, "Terry ends Pier night");
    await openBand(tide.bandId);
    await app.until(`/No gig planned/.test(${bandPage(tide.bandId)}.textContent)`, "Low Tide has no gig left");
    assert.ok(!(await has(".band-status-faces")), "no strip once the only gig is over");
  });

  await check("the strip shows on the band page under the next-gig card and on the gig view", async () => {
    await openBand(blue.bandId);
    await app.until(`!!document.querySelector(${js(STRIP)})`, "the strip on the band page");
    const card = await box(".band-page .next-gig");
    const strip = await box(STRIP);
    assert.ok(card && strip && strip.y >= card.bottom - 0.5, `the strip sits under the next-gig card (card ${js(card)}, strip ${js(strip)})`);
    await openGigView(blue.bandId, friday);
    await app.until(`document.querySelectorAll(${js(`.gig-view ${STRIP} .band-status-face`)}).length === ${lineup.length}`, "the strip on the gig view");
    const faces = await labels(`.gig-view ${STRIP} .band-status-face`);
    assert.deepEqual(faces.map((label) => label?.replace(/, leader$/, "")).sort(), [...lineupNames].sort(), "the gig view shows the same lineup");
    assert.ok(faces.includes("Mike Keys, leader"), "the gig view marks the leader too");
  });

  await check("tapping a face opens the panel and ✕ closes it", async () => {
    await openPanel();
    assert.equal(await site.evaluate<string>(`document.querySelector(${js(SHEET)}).getAttribute("aria-modal")`), "true", "the panel is a modal sheet");
    const size = await site.evaluate<number>(`parseFloat(getComputedStyle(document.querySelector(${js(`${SHEET} .band-status-row`)})).fontSize)`);
    assert.ok(size >= 16, `the panel text is at least 16 px (${size})`);
    await closePanel();
    await openPanel();
    await site.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await app.until(`!document.querySelector(${js(SHEET)})`, "Escape closes the panel");
    await openBand(blue.bandId);
    await openPanel();
    await closePanel();
    assert.ok(await has(STRIP), "the strip stays after the panel closes");
  });

  await check("faces are 48 px and the strip never overlaps the section tabs", async () => {
    for (const where of ["band page", "gig view"]) {
      if (where === "gig view") await openGigView(blue.bandId, friday);
      else await openBand(blue.bandId);
      await app.until(`document.querySelectorAll(${js(`${STRIP} .band-status-face`)}).length === ${lineup.length}`, `the faces on the ${where}`);
      await site.evaluate(`document.fonts.ready.then(() => true)`);
      const faces = await boxes(`${STRIP} .band-status-face`);
      for (const face of faces) {
        assert.ok(Math.abs(face.w - 48) <= 0.5 && Math.abs(face.h - 48) <= 0.5, `${where}: a face is 48 px (${js(face)})`);
        assert.ok(face.x >= 0 && face.right <= WIDTH, `${where}: a face fits across a ${WIDTH} px phone (${js(face)})`);
      }
      assert.ok(await site.evaluate<boolean>(`document.documentElement.scrollWidth <= ${WIDTH}`), `${where}: the page does not scroll sideways`);
      if (where === "band page") {
        const tabs = await box(".band-page .band-tabs");
        const strip = await box(STRIP);
        assert.ok(tabs && strip, "the strip and the tabs are both on the band page");
        assert.ok(strip.bottom <= tabs.y + 0.5, `the strip ends above the section tabs (strip ${js(strip)}, tabs ${js(tabs)})`);
        for (const face of faces) assert.ok(face.bottom <= tabs.y + 0.5, `${where}: no face runs into the tabs (${js(face)})`);
      }
    }
  });

  await check("the old amber inline style is gone", async () => {
    await openBand(blue.bandId);
    await openPanel();
    const inline = await site.evaluate<string[]>(`[...document.querySelectorAll(".band-status-faces [style], .band-status-sheet [style]")].map((el) => el.getAttribute("style"))`);
    assert.deepEqual(inline, [], "no inline styles on the strip or the panel");
    const text = await tokenColor("--text");
    const danger = await tokenColor("--danger");
    const dangerBorder = await tokenColor("--danger", "borderTopColor");
    assert.notEqual(text, danger, "the theme's text and danger tokens differ");
    assert.equal(await site.evaluate<string>(`getComputedStyle(document.querySelector(${js(`${SHEET} .band-status-row`)})).color`), text, "a steady row is the text token");
    const amber = await site.evaluate<{ row: string; face: string }>(`(() => {
      const row = document.querySelector(${js(`${SHEET} .band-status-row`)}).cloneNode(true);
      row.classList.add("band-status-amber");
      document.querySelector(${js(SHEET)}).appendChild(row);
      const face = document.querySelector(${js(`${STRIP} .band-status-face`)}).cloneNode(true);
      face.classList.add("band-status-face-amber");
      document.querySelector(${js(STRIP)}).appendChild(face);
      const seen = { row: getComputedStyle(row).color, face: getComputedStyle(face).borderTopColor };
      row.remove();
      face.remove();
      return seen;
    })()`);
    assert.equal(amber.row, danger, `an amber row is the --danger token (${amber.row})`);
    assert.equal(amber.face, dangerBorder, `an amber face's ring is the --danger token (${amber.face})`);
    await closePanel();
  });

  // A gig turns live when its leader's phone opens it in the band room (PLAN.md 7.10), so these cases send that opening
  // from Node, with no live feed after it: the Room feed is p6-gig-check-in's work.
  const opening = await build({ stdin: { contents: 'export { startGig } from "./src/gig-state.ts";', resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
  const { startGig } = (await import(`data:text/javascript;base64,${Buffer.from(opening.outputFiles[0].text).toString("base64")}`)) as typeof import("../src/gig-state.ts");
  const goLive = async (leader: typeof terry, admin: string, bandId: string, id: string) => {
    const view = viewOf(await leader.call("/api/bands/gig/open", { bandId, gigId: id }), `${leader.name} reads ${id}`) as GigView & { songIds: string[] };
    const ws = new WebSocket(leader.socketUrl(bandId), { headers: { origin, cookie: leader.cookie } } as unknown as string[]);
    const heard: Record<string, any>[] = [];
    ws.addEventListener("message", (event) => heard.push(JSON.parse(String(event.data))));
    try {
      await new Promise((done, fail) => (ws.addEventListener("open", done, { once: true }), ws.addEventListener("error", fail, { once: true })));
      ws.send(js({ kind: "gig-state", gigId: id }));
      for (const end = Date.now() + 5000; !heard.some((m) => m.kind === "gig-state"); await new Promise((done) => setTimeout(done, 50))) {
        if (Date.now() > end) throw new Error(`the room never answered ${leader.name}'s ask (${js(heard)})`);
      }
      const now = Date.now();
      const state = startGig({ gigId: id, order: view.songIds, leader: leader.userId, admin, backup: null, lineup: view.gig.lineup, route: "auto", scrollAlong: true, now: now as never });
      ws.send(js({ kind: "gig-start", state, at: now }));
      for (const end = Date.now() + 5000; viewOf(await leader.call("/api/bands/gig/open", { bandId, gigId: id }), "the gig").gig.status !== "live"; await new Promise((done) => setTimeout(done, 100))) {
        if (Date.now() > end) throw new Error(`the gig never went live (${js(heard)})`);
      }
    } finally {
      ws.close();
    }
  };
  const faceTags = () => site.evaluate<string[]>(`[...new Set([...document.querySelectorAll(${js(`.gig-view ${STRIP} .band-status-face`)})].map((el) => el.tagName.toLowerCase()))]`);

  await check("F1 on the gig view of a live gig with no feed, the admin's tap opens Band status", async () => {
    const own = (await appCalls("/api/bands/create", { name: "Sam's Trio" })).body.bandId as string;
    const code = (await appCalls("/api/codes", { kind: "band", bandId: own })).body.code as string;
    assert.equal((await terry.call("/api/bands/join", { code })).status, 200, "Terry joins Sam's Trio");
    const song = await appCalls("/api/bands/library/share-song", { bandId: own, song: content(seed.songs[0]), choice: "public", localId: null });
    const set = await appCalls("/api/bands/library/share-setlist", { bandId: own, name: "Set", songIds: [song.body.songId], tags: [], choice: "public", localId: null });
    assert.equal(set.status, 200, `Sam shares a set (${js(set.body)})`);
    const planned = viewOf(
      await appCalls("/api/bands/gig/plan", { bandId: own, setlistId: set.body.setlistId, gigId: gigId(), name: "Trio night", date: dayFromNow(0), lineup: [sam.userId, terry.userId], leader: terry.userId }),
      "Sam, the admin, plans Trio night with Terry leading",
    ).gig.gigId;
    await goLive(terry, sam.userId, own, planned);
    await openGigView(own, planned);
    await app.until(`document.querySelectorAll(${js(`.gig-view ${STRIP} .band-status-face`)}).length === 2`, "two faces on the gig view");
    assert.deepEqual(await faceTags(), ["button"], "Sam, the admin, gets faces that open the panel");
    await openPanel();
    assert.deepEqual(await texts(`${SHEET} .band-status-line`), ["Live sync and timing will show once players are connected."], "the panel waits for players");
    await closePanel();
  });

  await check("F3 a member on the gig view when the gig goes live loses Band status without a reload", async () => {
    const planned = viewOf(
      await terry.call("/api/bands/gig/plan", { bandId: quiet.bandId, setlistId: quiet.setlistId, gigId: gigId(), name: "Quiet night", date: dayFromNow(0), lineup: [terry.userId, sam.userId], leader: terry.userId }),
      "Terry plans Quiet night",
    ).gig.gigId;
    await openGigView(quiet.bandId, planned);
    await app.until(`document.querySelectorAll(${js(`.gig-view ${STRIP} .band-status-face`)}).length === 2`, "two faces on the gig view");
    assert.deepEqual(await faceTags(), ["button"], "before the gig goes live, Sam may open the panel");
    await openPanel();
    await goLive(terry, terry.userId, quiet.bandId, planned);
    await app.until(`!document.querySelector(${js(SHEET)})`, "the open panel to shut once the gig is live", 25000);
    assert.deepEqual(await faceTags(), ["span"], "Sam's faces are pictures now");
    await site.evaluate(`document.querySelector(${js(`.gig-view ${STRIP} .band-status-face`)}).click()`);
    await new Promise((done) => setTimeout(done, 600));
    assert.ok(!(await has(SHEET)), "a tap opens nothing");
  });

  // The band page is the other mount of the strip. These cases keep Sam on it, or on a gig view, while Terry's phone
  // changes the gig, with no reload: the page must hear the change by itself.
  const WAITING_LINE = "Live sync and timing will show once players are connected.";
  const bandFaceTags = () => site.evaluate<string[]>(`[...new Set([...document.querySelectorAll(${js(`.band-page ${STRIP} .band-status-face`)})].map((el) => el.tagName.toLowerCase()))]`);
  /** A band with a gig tonight that Terry leads and Sam plays, Sam the band's admin, a member or the gig's backup. */
  const tonight = async (name: string, role: "admin" | "member" | "backup") => {
    let bandId: string;
    let setlistId: string;
    let plan: (path: string, body: object) => Promise<Reply>;
    if (role === "admin") {
      bandId = (await appCalls("/api/bands/create", { name })).body.bandId as string;
      const code = (await appCalls("/api/codes", { kind: "band", bandId })).body.code as string;
      assert.equal((await terry.call("/api/bands/join", { code })).status, 200, `Terry joins ${name}`);
      const song = await appCalls("/api/bands/library/share-song", { bandId, song: content(seed.songs[0]), choice: "public", localId: null });
      const set = await appCalls("/api/bands/library/share-setlist", { bandId, name: "Set", songIds: [song.body.songId], tags: [], choice: "public", localId: null });
      assert.equal(set.status, 200, `Sam shares a set into ${name} (${js(set.body)})`);
      setlistId = set.body.setlistId as string;
      plan = appCalls;
    } else {
      const band = await newBand(name, []);
      assert.equal((await appCalls("/api/bands/join", { code: band.invite })).status, 200, `Sam joins ${name}`);
      ({ bandId, setlistId } = band);
      plan = (path, body) => terry.call(path, body);
    }
    const backup = role === "backup" ? sam.userId : null;
    const gig = viewOf(
      await plan("/api/bands/gig/plan", { bandId, setlistId, gigId: gigId(), name: `${name} tonight`, date: dayFromNow(0), lineup: [terry.userId, sam.userId], leader: terry.userId, backup }),
      `${name}: a gig tonight with Terry leading and Sam as ${role}`,
    ).gig;
    assert.equal(gig.backup, backup, `${name}: the gig's backup is ${backup ? "Sam" : "nobody"}`);
    return { bandId, gigId: gig.gigId, admin: role === "admin" ? sam.userId : terry.userId };
  };
  /** Sam on the band page of `bandId` with Band status open while the gig is still planned. */
  const panelOnBandPage = async (bandId: string) => {
    await openBand(bandId);
    await app.until(`document.querySelectorAll(${js(`.band-page ${STRIP} .band-status-face`)}).length === 2`, "two faces on the band page");
    assert.deepEqual(await bandFaceTags(), ["button"], "before the gig goes live, Sam may open the panel");
    await openPanel();
    assert.deepEqual(await texts(`${SHEET} .band-status-line`), [LIVE_LINE], "the panel reads the planned gig's line");
  };
  const losesBandStatus = async (who: string) => {
    await app.until(`!document.querySelector(${js(SHEET)})`, `${who}'s open panel to shut once the gig is live`, 20000);
    assert.deepEqual(await bandFaceTags(), ["span"], `${who}'s faces are pictures now`);
    await site.evaluate(`document.querySelector(${js(`.band-page ${STRIP} .band-status-face`)}).click()`);
    await new Promise((done) => setTimeout(done, 600));
    assert.ok(!(await has(SHEET)), "a tap opens nothing");
  };

  await check("T1 a member on the band page when the gig goes live loses Band status without a reload", async () => {
    const gig = await tonight("Member Night", "member");
    await panelOnBandPage(gig.bandId);
    await goLive(terry, gig.admin, gig.bandId, gig.gigId);
    await losesBandStatus("Sam the member");
  });

  await check("T2 the backup on the band page when the gig goes live loses Band status without a reload", async () => {
    const gig = await tonight("Backup Night", "backup");
    await panelOnBandPage(gig.bandId);
    await goLive(terry, gig.admin, gig.bandId, gig.gigId);
    await losesBandStatus("Sam the backup");
  });

  await check("T3 the admin on the band page when the gig goes live keeps Band status", async () => {
    const gig = await tonight("Admin Night", "admin");
    await panelOnBandPage(gig.bandId);
    await goLive(terry, gig.admin, gig.bandId, gig.gigId);
    await app.until(`[...document.querySelectorAll(${js(`${SHEET} .band-status-line`)})].map((el) => el.textContent.trim()).join() === ${js(WAITING_LINE)}`, "the admin's open panel to read the live gig's waiting line", 20000);
    assert.deepEqual(await bandFaceTags(), ["button"], "Sam, the admin, keeps faces that open the panel");
    await closePanel();
    await openPanel();
    assert.deepEqual(await texts(`${SHEET} .band-status-line`), [WAITING_LINE], "the panel opens again on the live gig");
    await closePanel();
  });

  await check("T4 a member on the gig view when the leader ends the gig reads That gig is over and a way back", async () => {
    const gig = await tonight("Last Call", "member");
    await goLive(terry, gig.admin, gig.bandId, gig.gigId);
    await openGigView(gig.bandId, gig.gigId);
    await app.until(`document.querySelectorAll(${js(`.gig-view ${STRIP} .band-status-face`)}).length === 2`, "two faces on the live gig view");
    assert.ok(!(await texts(".gig-view"))[0].includes("That gig is over."), "the live gig is not over yet");
    assert.equal((await terry.call("/api/bands/gig/end", { bandId: gig.bandId, gigId: gig.gigId })).status, 200, "Terry ends the gig");
    await app.until(`(${gigViewOf(gig.gigId)}?.textContent ?? "").includes("That gig is over.")`, "the gig view to say the gig is over", 20000);
    assert.deepEqual(await texts(`.gig-view [role=alert]`), ["That gig is over."], "the view says why it stopped");
    const back = await site.evaluate<{ text: string; href: string } | null>(
      `(() => { const a = [...document.querySelectorAll(".gig-view a")].find((el) => el.textContent.trim() === "Back to the band"); return a ? { text: a.textContent.trim(), href: a.getAttribute("href") } : null; })()`,
    );
    assert.ok(back, "a Back to the band link");
    assert.equal(back.href, `#/band/${gig.bandId}`, "the link goes to this gig's band");
    assert.ok(!(await has(`.gig-view ${STRIP}`)), "the ended gig shows no Band status");
  });

  await check("T5 coming back to the app makes the band page ask for its gigs again, with the 15 s refresh held off", async () => {
    const band = await newBand("Back Again", []);
    assert.equal((await appCalls("/api/bands/join", { code: band.invite })).status, 200, "Sam joins Back Again");
    await site.evaluate(`(() => {
      window.__gigLists = 0;
      window.__fetch = window.fetch;
      window.fetch = (input, init) => {
        if (String(input instanceof Request ? input.url : input).includes("/api/bands/gig/list")) window.__gigLists += 1;
        return window.__fetch(input, init);
      };
      window.__setInterval = window.setInterval;
      window.setInterval = (run, ms, ...rest) => (ms === 15000 ? 0 : window.__setInterval(run, ms, ...rest));
      return true;
    })()`);
    try {
      await openBand(band.bandId);
      await app.until(`/No gig planned/.test(${bandPage(band.bandId)}.textContent)`, "Back Again says No gig planned");
      await new Promise((done) => setTimeout(done, 1000));
      const asked = await site.evaluate<number>("window.__gigLists");
      assert.equal(asked, 1, "the band page read its gigs once on open");
      assert.equal(await site.evaluate<string>("document.visibilityState"), "visible", "the page shows");
      await site.evaluate(`document.dispatchEvent(new Event("visibilitychange")), true`);
      await app.until(`window.__gigLists > ${asked}`, "the band page to ask for its gigs again on visibilitychange", 3000);
    } finally {
      await site.evaluate(`(window.fetch = window.__fetch, window.setInterval = window.__setInterval, true)`);
    }
  });

  await check("T6 a pack download that fails on the band page is not tried again by each 15 s refresh", async () => {
    const band = await newBand("Pack Retry", []);
    assert.equal((await appCalls("/api/bands/join", { code: band.invite })).status, 200, "Sam joins Pack Retry");
    const planned = viewOf(
      await terry.call("/api/bands/gig/plan", { bandId: band.bandId, setlistId: band.setlistId, gigId: gigId(), name: "Retry night", date: dayFromNow(1), lineup: [terry.userId, sam.userId], leader: terry.userId }),
      "Terry plans Retry night with Sam on the lineup",
    ).gig.gigId;
    await site.evaluate(`(() => {
      window.__calls = { list: 0, pack: 0 };
      window.__failPack = false;
      window.__ticks = [];
      window.__fetch = window.fetch;
      window.fetch = (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/api/bands/gig/list")) window.__calls.list += 1;
        if (url.includes("/api/bands/gig/pack")) {
          window.__calls.pack += 1;
          if (window.__failPack) return Promise.resolve(new Response(JSON.stringify({ reason: "check" }), { status: 500, headers: { "content-type": "application/json" } }));
        }
        return window.__fetch(input, init);
      };
      window.__setInterval = window.setInterval;
      window.setInterval = (run, ms, ...rest) => (ms === 15000 ? (window.__ticks.push(run), 0) : window.__setInterval(run, ms, ...rest));
      return true;
    })()`);
    const calls = () => site.evaluate<{ list: number; pack: number }>("window.__calls");
    const card = () => site.evaluate<string>(`${bandPage(band.bandId)}?.querySelector(".next-gig")?.textContent ?? ""`);
    /** One 15 s refresh, fired by hand: the band page reads its gigs again, and whatever that reply starts has time to run. */
    const refresh = async () => {
      const { list } = await calls();
      await site.evaluate(`(window.__ticks.at(-1)(), true)`);
      await app.until(`window.__calls.list > ${list}`, "the refresh to read gig/list", 5000);
      await new Promise((done) => setTimeout(done, 1500));
    };
    try {
      await openBand(band.bandId);
      await app.until(`/Pack 2 of 2 downloaded/.test(${bandPage(band.bandId)}.querySelector(".next-gig")?.textContent ?? "")`, "the first auto-download", 20000);
      assert.equal((await calls()).pack, 1, "opening the band page downloads the pack once");
      assert.ok(await site.evaluate<boolean>("window.__ticks.length > 0"), "the band page set its 15 s refresh");
      await site.evaluate("(window.__failPack = true)");
      viewOf(await terry.call("/api/bands/gig/route", { bandId: band.bandId, gigId: planned, route: "band_wifi" }), "Terry's route change makes a new pack rev");
      await refresh();
      assert.equal((await calls()).pack, 2, "the refresh that sees the new pack rev tries it once, and that try fails");
      await refresh();
      await refresh();
      const after = await calls();
      assert.equal(after.pack, 2, `two more refreshes do not fetch the failed pack again (${js(after)})`);
      assert.deepEqual(await texts(".band-page [role=alert]"), [], "the silent auto-download failure shows no error banner");
      assert.match(await card(), /Pack 0 of 2 downloaded/, "the card says the new pack is not on the phone");
    } finally {
      await site.evaluate(`(window.__failPack = false, window.fetch = window.__fetch, window.setInterval = window.__setInterval, true)`);
    }
  });

  await check("no page errors", async () => assert.deepEqual(await app.errors(), [], "the page logged no errors"));
} finally {
  await site.close();
  await worker.dispose();
}

if (failed > 0) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("check:ux-band-status passed");
