import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SongContent } from "../src/band-library-model.ts";
import type { ChatMessage } from "../src/chat-model.ts";
import type { GigPack, GigPlan } from "../src/gig-pack.ts";
import { Phone, startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/**
 * C15, Plan a gig and download it (FABLE-PLAN C15, PLAN.md 5 `gigs`, 6, 7.14, 8.2). One case per pass condition,
 * named by it. The cases fix this contract, which the cook builds to. Every reply below that is not a refusal is a
 * `GigView = { gig: GigPlan; receipts: { userId; packRev; at }[] }`, with `GigPlan` from `src/gig-pack.ts`.
 *
 * `POST /api/bands/gig/plan { bandId, setlistId, name, date, lineup?, leader?, backup?, route? }`: an admin plans.
 *   The lineup is every active member unless given, the leader is the planner unless given, the backup is null and
 *   the route "auto" unless given. The band chat gets a message with `kind: "gig"` and `ref: gigId`. A member is
 *   `403 not-allowed`.
 * `POST /api/bands/gig/open { bandId, gigId }`: any member reads the plan; a stranger is `403 not-a-member`.
 * `POST /api/bands/gig/lineup { bandId, gigId, lineup }`: an admin, or the gig's leader while it is planned. Others
 *   `403 not-allowed`. Changing the lineup rotates the gig secret and raises `packRev`.
 * `POST /api/bands/gig/backup { bandId, gigId, backup }`: an admin or the leader; `400 not-on-lineup` when the
 *   backup is not on the lineup; others `403 not-allowed`.
 * `POST /api/bands/gig/route { bandId, gigId, route }`: an admin only, `route` a `RouteChoice`; anyone else
 *   `403 not-allowed`; a word that is not a route `400 bad-request`.
 * `POST /api/bands/gig/pack { bandId, gigId }`: a `GigPack`. A lineup member gets the secret and a receipt for
 *   `packRev`; the same rev again adds no receipt. An admin who is not playing gets the pack with `secret: null` and
 *   no receipt. Any other member is `403 not-on-lineup`; a stranger `403 not-a-member`.
 * `POST /api/codes { kind: "gig", bandId, gigId }`: an admin mints a gig link, landing on `?open=gig&code=`.
 * `POST /api/bands/gig/code { code }`: a lineup member gets the GigView; anyone else `403 not-on-lineup`.
 *
 * On the phone: a setlist row on the band's Setlists tab has "Plan a gig". The form has "Gig name" and "Date", one
 * switch per member (all on), and "Send to band". The band screen then shows the next gig's card, `[data-gig=<gigId>]`,
 * with "Get ready", each lineup player with "Downloaded ✓" or "Not yet", and one button per song that opens its chart
 * from the pack in `mls-phone` / `gigPacks`. Opening a gig link lands a lineup member on that card; anyone else sees
 * "This gig is for tonight's lineup".
 */

type Reply = { status: number; body: Record<string, any> };
type GigView = { gig: GigPlan; receipts: { userId: string; packRev: number; at: number }[] };
type Player = Awaited<ReturnType<typeof passwordPlayer>>;

const root = new URL("..", import.meta.url).pathname;
/** Set SHOTS to a folder to save the gig screens at phone size. */
const shots = process.env.SHOTS;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const js = (value: unknown) => JSON.stringify(value);
const refusal = (reply: Reply) => [reply.status, reply.body.error];

const seed = JSON.parse(readFileSync(`${root}data/library.json`, "utf8")) as { songs: (SongContent & { id: number })[] };
const content = ({ id: _id, ...song }: SongContent & { id: number }): SongContent => song;
const SET_SONGS = seed.songs.slice(0, 3).map(content);

/** A timing version only Sam's phone has. Its name, tempo and tap time are odd enough that any copy of it anywhere is unmistakable. */
const PRIVATE_NAME = "Sam private take 7F3A";
const PRIVATE_VERSION = { name: PRIVATE_NAME, bpm: 97.13, marks: [{ at: 0, progress: 0 }, { at: 123457, progress: 1 }] };
const PRIVATE_MARKS = ["7F3A", "97.13", "123457", "leadSheetsScrollVersions"];

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

async function eventually<T>(read: () => Promise<T>, good: (value: T) => boolean, what: string, ms = 8000): Promise<T> {
  let value = await read();
  for (const end = Date.now() + ms; !good(value) && Date.now() < end; value = await read()) await sleep(100);
  assert.ok(good(value), `${what} (last saw ${js(value)})`);
  return value;
}

/** A phone's own camera app or a plain browser opening the link: no cookie, no Origin, redirects not followed. */
async function land(base: string, code: string) {
  const response = await fetch(new URL(`/c/${code}`, base), { redirect: "manual" });
  return { status: response.status, location: response.headers.get("location") };
}

/** A phone nobody is signed in on, sending the app's Origin like a browser does. */
function signedOutPhone(base: string, origin: string): Phone {
  const phone = new Phone(base);
  const call = phone.call.bind(phone);
  phone.call = (path, body, headers = {}) => call(path, body, { origin, ...headers });
  return phone;
}

function viewOf(reply: Reply, what: string): GigView {
  assert.equal(reply.status, 200, `${what} (${js(reply.body)})`);
  assert.ok(reply.body.gig && Array.isArray(reply.body.receipts), `${what}: the reply is a gig view`);
  return reply.body as GigView;
}

function packOf(reply: Reply, what: string): GigPack {
  assert.equal(reply.status, 200, `${what} (${js(reply.body).slice(0, 200)})`);
  assert.ok(reply.body.gig && Array.isArray(reply.body.songs) && typeof reply.body.packRev === "number", `${what}: the reply is a gig pack`);
  return reply.body as GigPack;
}

let apiBase = "";
const site = await openSite(root, "check-gig-plan", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;
try {
  const app = await appPage(site);
  await site.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const sent = JSON.parse(sessionStorage.getItem("__sent") ?? "[]");
      const keep = (where, body) => {
        sent.push(where + " " + (typeof body === "string" ? body : body == null ? "" : "[" + Object.prototype.toString.call(body) + "]"));
        sessionStorage.setItem("__sent", JSON.stringify(sent));
      };
      const fetchNext = window.fetch;
      window.fetch = (input, init) => (keep("fetch " + (input.url ?? input), init?.body), fetchNext(input, init));
      const wsSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) { keep("socket " + this.url, data); return wsSend.call(this, data); };
    })();`,
  });
  const offline = (on: boolean) => site.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const appCalls = (path: string, body: object) =>
    site.evaluate<Reply>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const view = (name: string) => app.until(`document.querySelector(".bands-sheet, .band-page")?.dataset.view === ${js(name)} && !document.querySelector(".bands-sheet, .band-page").textContent.includes("Loading")`, `the ${name} view`, 15000);
  const tab = (name: string) => app.click(name, `document.querySelector(".band-tabs")`);
  /** Taps the first enabled button whose text starts with `start` inside `scope`. */
  const tap = async (start: string, scope = "document.querySelector('.bands-sheet, .band-page')") => {
    const tapped = await site.evaluate<boolean>(`(() => { const el = [...(${scope}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim().startsWith(${js(start)}) && !b.disabled); el?.click(); return !!el; })()`);
    assert.ok(tapped, `a button starting ${js(start)} to tap`);
    await settle();
  };
  const setField = async (label: string, value: string) => {
    await site.evaluate(
      `(() => { const field = [...document.querySelectorAll("[role=dialog] label, .band-page label")].find((l) => l.textContent.trim() === ${js(label)}).control; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, ${js(value)}); field.dispatchEvent(new Event("input", { bubbles: true })); field.dispatchEvent(new Event("change", { bubbles: true })); })()`,
    );
    await settle();
  };
  const reset = async () => {
    await site.evaluate(`location.hash = "#/songs"`);
    await site.evaluate(`window.__beforeReload = true; location.reload()`);
    await app.until(`!window.__beforeReload && !!document.querySelector(".shell-header [aria-label=Settings]")`, "the library after the reload", 15000);
  };
  const openBand = async () => {
    await app.openBands();
    await view("list");
    await app.click("Open");
    await view("band");
    await tab("Gigs");
  };
  const card = (gigId: string) => `document.querySelector(${js(`.bands-sheet [data-gig=${js(gigId)}], .band-page [data-gig=${js(gigId)}]`)})`;
  const cardText = (gigId: string) => site.evaluate<string>(`${card(gigId)}?.textContent ?? ""`);
  const count = (text: string, word: string) => text.split(word).length - 1;
  /** The packs in the phone's IndexedDB, read without making the database if the app has not yet. */
  const packsOnPhone = () =>
    site.evaluate<GigPack[]>(`(async () => {
      if (!(await indexedDB.databases()).some((db) => db.name === "mls-phone")) return [];
      const db = await new Promise((done, fail) => { const r = indexedDB.open("mls-phone"); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
      try {
        if (!db.objectStoreNames.contains("gigPacks")) return [];
        return await new Promise((done, fail) => { const r = db.transaction("gigPacks").objectStore("gigPacks").getAll(); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
      } finally { db.close(); }
    })()`);
  const me = () => site.evaluate<{ account?: { userId: string; handle: string } }>(`fetch("/api/me").then((r) => r.json())`).then((reply) => reply.account);

  const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
  const dana = await passwordPlayer(base, origin, "Dana Drums", "danadrums");
  const eve = await passwordPlayer(base, origin, "Eve Spam", "evespam");
  const bandId = (await terry.call("/api/bands/create", { name: "The Blue Notes" })).body.bandId as string;
  const invite = (await terry.call("/api/codes", { kind: "band", bandId })).body.code as string;
  for (const member of [mike, dana]) assert.equal((await member.call("/api/bands/join", { code: invite })).status, 200, `${member.name} joins`);
  const shared: string[] = [];
  for (const song of SET_SONGS) {
    const reply = await terry.call("/api/bands/library/share-song", { bandId, song, choice: "public", localId: null });
    assert.equal(reply.status, 200, `Terry shares ${song.title} into the band`);
    shared.push(reply.body.songId);
  }
  const setlist = await terry.call("/api/bands/library/share-setlist", { bandId, name: "Friday set", songIds: shared, tags: ["Bar"], choice: "public", localId: null });
  assert.equal(setlist.status, 200, `Terry shares the Friday set (${js(setlist.body)})`);
  const setlistId = setlist.body.setlistId as string;
  assert.equal((await terry.call("/api/bands/settings", { bandId, scrollWithLeader: true })).status, 200, "Terry turns Scroll with the leader on");
  const plan = (who: Phone, over: Record<string, unknown> = {}) => who.call("/api/bands/gig/plan", { bandId, setlistId, name: "Friday at the Elks", date: "2026-11-27", ...over });
  const open = (who: Phone, gigId: string) => who.call("/api/bands/gig/open", { bandId, gigId });
  const pack = (who: Phone, gigId: string) => who.call("/api/bands/gig/pack", { bandId, gigId });
  const setLineup = (who: Phone, gigId: string, lineup: string[]) => who.call("/api/bands/gig/lineup", { bandId, gigId, lineup });

  await site.send("Network.enable");
  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await site.evaluate("Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((done) => setTimeout(done, 20000, false))])");
  if (!(await site.evaluate<boolean>("!!navigator.serviceWorker.controller"))) await site.send("Page.reload");
  await app.until("!!navigator.serviceWorker?.controller", "the service worker to take control of the page", 60000);
  await app.library();
  const firstId = await site.evaluate<string>(`document.querySelector('a[href^="#/song/"]').getAttribute("href").match(/\\d+/)[0]`);
  await site.evaluate(`localStorage.setItem("leadSheetsScrollVersions.${firstId}", ${js(js({ versions: [PRIVATE_VERSION], selected: 0 }))})`);
  await reset();
  await app.signUp("Sam Rivera");
  const sam = await me();
  assert.ok(sam, "Sam is signed in on the phone");
  assert.equal((await appCalls("/api/bands/join", { code: invite })).status, 200, "Sam joins the band");
  assert.equal((await terry.call("/api/bands/make-admin", { bandId, userId: sam.userId })).status, 200, "Terry makes Sam an admin");
  const members = [terry, sam, mike, dana].map((p) => p.userId).sort();
  const nameOf = new Map<string, string>([[terry.userId, terry.name], [sam.userId, "Sam Rivera"], [mike.userId, mike.name], [dana.userId, dana.name]]);

  let g1 = "";
  let g2 = "";
  let g3 = "";
  /** Friday at the Elks: the gig Sam plans on the phone in the first case, or, when that failed, one Terry plans here so the later cases still try their own claim. */
  const needG1 = async () => {
    if (!g1) g1 = viewOf(await plan(terry, { name: "Friday at the Elks", date: "2026-11-20" }), "Terry plans Friday at the Elks").gig.gigId;
  };
  /** Sunday brunch: planned by Terry with Mike leading, so a leader who is not an admin can be told apart from both. */
  const needG3 = async (): Promise<GigView> => {
    if (g3) return viewOf(await open(mike, g3), "Mike reads Sunday brunch");
    const third = viewOf(await plan(terry, { name: "Sunday brunch", date: "2026-12-13", leader: mike.userId }), "Terry plans Sunday brunch with Mike leading");
    g3 = third.gig.gigId;
    return third;
  };
  await check("an admin or the leader plans a gig from a band setlist and the card is pinned in the band chat", async () => {
    await openBand();
    await tab("Setlists");
    await app.until(`document.querySelectorAll(".band-library-setlists li").length === 1`, "the Friday set on the band's Setlists");
    await tap("Plan a gig", `[...document.querySelectorAll(".band-library-setlists li")].find((li) => li.textContent.includes("Friday set"))`);
    await app.until(`[...document.querySelectorAll("[role=dialog] label")].some((l) => l.textContent.trim() === "Gig name")`, "the Plan a gig form");
    await setField("Gig name", "Friday at the Elks");
    await setField("Date", "2026-11-20");
    await app.shot(shots && `${shots}/gig-plan-form.png`);
    await tap("Send to band");
    await app.until(`!!document.querySelector(".bands-sheet [data-gig], .band-page [data-gig]")`, "the gig card on the band screen", 15000);
    g1 = await site.evaluate<string>(`document.querySelector(".bands-sheet [data-gig], .band-page [data-gig]").dataset.gig`);
    assert.match(await cardText(g1), /Friday at the Elks/, "the card names the gig");
    await app.shot(shots && `${shots}/gig-plan-card.png`);
    const posted = (await mike.call("/api/chat/open", { roomId: bandId })).body.messages as ChatMessage[];
    assert.deepEqual(posted.filter((m) => m.kind === "gig").map((m) => m.ref), [g1], "the band chat holds one gig card pointing at this gig");
    const seen = viewOf(await open(mike, g1), "Mike reads the plan");
    assert.deepEqual([seen.gig.gigId, seen.gig.bandId, seen.gig.setlistId, seen.gig.name, seen.gig.date, seen.gig.leader, seen.gig.status], [g1, bandId, setlistId, "Friday at the Elks", "2026-11-20", sam.userId, "planned"], "planned from the Friday set, with Sam leading");
    assert.deepEqual(refusal(await plan(dana)), [403, "not-allowed"], "Dana, a member, can't plan one");
    assert.deepEqual(refusal(await plan(eve)), [403, "not-a-member"], "nor can a stranger");
    assert.deepEqual(refusal(await open(eve, g1)), [403, "not-a-member"], "or read it");
  });

  await check("every member is on the lineup by default and a switch takes one off", async () => {
    await needG1();
    const first = viewOf(await open(mike, g1), "the plan for Friday at the Elks");
    assert.deepEqual([...first.gig.lineup].sort(), members, "everyone is on the lineup of the gig planned with no changes");
    await reset();
    await openBand();
    await tab("Setlists");
    await tap("Plan a gig", `[...document.querySelectorAll(".band-library-setlists li")].find((li) => li.textContent.includes("Friday set"))`);
    await app.until(`document.querySelectorAll("[role=dialog] input[role=switch]").length === 4`, "one lineup switch per member");
    assert.equal(await site.evaluate<number>(`[...document.querySelectorAll("[role=dialog] input[role=switch]")].filter((s) => s.checked).length`), 4, "all four switches start on");
    const flipped = await site.evaluate<boolean>(`(() => { const s = [...document.querySelectorAll("[role=dialog] input[role=switch]")].find((s) => (s.closest("label") ?? s.closest("li") ?? s.parentElement).textContent.includes("Dana Drums")); s?.click(); return !!s; })()`);
    assert.ok(flipped, "Dana's switch to flip off");
    await settle();
    await setField("Gig name", "Saturday at the Barn");
    await setField("Date", "2026-12-05");
    await tap("Send to band");
    const gigs = await eventually(() => mike.call("/api/chat/open", { roomId: bandId }).then((r) => (r.body.messages as ChatMessage[]).filter((m) => m.kind === "gig").map((m) => m.ref as string)), (list) => list.length === 2, "a second gig card in the chat", 15000);
    g2 = gigs.find((id) => id !== g1)!;
    const second = viewOf(await open(mike, g2), "Mike reads the second plan");
    assert.deepEqual([...second.gig.lineup].sort(), members.filter((id) => id !== dana.userId), "the Saturday lineup is everyone but Dana");
    const third = await needG3();
    assert.deepEqual([[...third.gig.lineup].sort(), third.gig.leader], [members, mike.userId], "everyone is on Sunday brunch and Mike leads");
    const byLeader = viewOf(await setLineup(mike, third.gig.gigId, [terry.userId, sam.userId, mike.userId]), "Mike, the leader, takes Dana off while the gig is planned");
    assert.deepEqual([...byLeader.gig.lineup].sort(), members.filter((id) => id !== dana.userId), "and she is off");
    assert.deepEqual(refusal(await setLineup(dana, third.gig.gigId, members)), [403, "not-allowed"], "Dana, a member who isn't leading, can't change it");
    assert.deepEqual(refusal(await setLineup(eve, third.gig.gigId, members)), [403, "not-a-member"], "nor can a stranger");
  });

  await check("only the admin or the leader can set the backup, and the backup must be on the lineup", async () => {
    const brunch = await needG3();
    const setBackup = (who: Phone, backup: string | null) => who.call("/api/bands/gig/backup", { bandId, gigId: g3, backup });
    assert.equal(brunch.gig.backup, null, "no backup is picked to start with");
    assert.deepEqual(refusal(await setBackup(dana, sam.userId)), [403, "not-allowed"], "Dana, a member, can't pick the backup");
    assert.deepEqual(refusal(await setBackup(mike, dana.userId)), [400, "not-on-lineup"], "Mike, the leader, can't pick someone who isn't playing");
    assert.equal(viewOf(await setBackup(mike, sam.userId), "Mike picks Sam").gig.backup, sam.userId, "the leader picks a backup from the lineup");
    assert.equal(viewOf(await setBackup(terry, terry.userId), "Terry picks himself").gig.backup, terry.userId, "and so can the admin");
    assert.equal(viewOf(await setBackup(terry, null), "Terry clears it").gig.backup, null, "or clear it");
  });

  await check("only the admin picks the connection for tonight and Auto is the default", async () => {
    const brunch = await needG3();
    const setRoute = (who: Phone, route: unknown) => who.call("/api/bands/gig/route", { bandId, gigId: g3, route });
    assert.equal(brunch.gig.route, "auto", "Auto is the default");
    assert.deepEqual(refusal(await setRoute(mike, "band_wifi")), [403, "not-allowed"], "Mike, the leader but not an admin, can't pick it");
    assert.deepEqual(refusal(await setRoute(dana, "band_wifi")), [403, "not-allowed"], "nor can a member");
    assert.equal(viewOf(await setRoute(terry, "band_wifi"), "Terry picks the Wi-Fi link").gig.route, "band_wifi", "the admin picks the route");
    assert.deepEqual(refusal(await setRoute(terry, "hotspot")), [400, "bad-request"], "a word that isn't a route is refused");
    assert.equal(viewOf(await open(mike, g3), "the plan again").gig.route, "band_wifi", "and the stored route stays");
  });

  await check("a lineup phone downloads the pack, goes offline and opens every song", async () => {
    await needG1();
    await reset();
    await openBand();
    await app.until(`!!${card(g1)}`, "the pinned card");
    await tap("Get ready", card(g1));
    await app.until(`${card(g1)}?.textContent.includes("Downloaded ✓")`, "Downloaded ✓ after Get ready", 15000);
    const packs = await eventually(packsOnPhone, (list) => list.some((p) => p.gig.gigId === g1), "the pack in the phone's gigPacks store");
    const mine = packs.find((p) => p.gig.gigId === g1)!;
    assert.deepEqual(mine.songs.map((s) => s.song.title), SET_SONGS.map((s) => s.title), "the pack holds the setlist's songs in order");
    assert.equal(typeof mine.secret, "string", "with the gig secret, since Sam is on the lineup");
    await offline(true);
    try {
      for (const song of SET_SONGS) {
        await tap(song.title, card(g1));
        await app.until(`document.querySelector(".sheet .sheet-name")?.textContent === ${js(song.title)} && !!document.querySelector(".chart")`, `${song.title} rendered with no signal`);
        await app.shot(shots && `${shots}/gig-pack-${song.title.replace(/\W+/g, "-")}.png`);
        await app.click("Back");
        await app.until(`!!${card(g1)}`, "back on the card");
      }
    } finally {
      await offline(false);
    }
  });

  await check("a non-lineup member and a stranger are refused the pack", async () => {
    await needG3();
    viewOf(await setLineup(terry, g3, [terry.userId, sam.userId, mike.userId]), "Terry makes sure Dana is off the Sunday lineup");
    assert.deepEqual(refusal(await pack(dana, g3)), [403, "not-on-lineup"], "Dana, off the Sunday lineup, gets no pack");
    assert.deepEqual(refusal(await pack(eve, g3)), [403, "not-a-member"], "a stranger gets none either");
    assert.deepEqual(refusal(await pack(signedOutPhone(base, origin), g3)), [401, "signed-out"], "nor does a signed-out phone");
    assert.equal(viewOf(await open(dana, g3), "Dana reads the plan").gig.gigId, g3, "though Dana, still a member, can read the plan");
  });

  await check("only lineup packs contain the gig secret, and it changes when someone is taken off", async () => {
    await needG3();
    viewOf(await setLineup(terry, g3, [terry.userId, sam.userId, mike.userId]), "Terry, Sam and Mike are the Sunday lineup");
    const before = packOf(await pack(mike, g3), "Mike downloads the Sunday pack");
    assert.ok(typeof before.secret === "string" && before.secret.length >= 16, `Mike, on the lineup, gets the secret (${js(before.secret)})`);
    const terrys = packOf(await pack(terry, g3), "Terry, the admin, downloads it too");
    assert.equal(terrys.secret, before.secret, "an admin who is playing gets the same secret");
    viewOf(await setLineup(terry, g3, [sam.userId, mike.userId]), "Terry takes himself off the lineup");
    const notPlaying = packOf(await pack(terry, g3), "Terry, the admin who isn't playing, still reads the pack");
    assert.equal(notPlaying.secret, null, "but without the secret");
    const after = packOf(await pack(mike, g3), "Mike downloads again");
    assert.ok(typeof after.secret === "string" && after.secret !== before.secret, "and the secret changed when someone was taken off");
    assert.ok(after.packRev > before.packRev, `with a higher pack rev (${before.packRev} to ${after.packRev})`);
  });

  await check("Downloaded ✓ shows per player from pack receipts", async () => {
    await needG1();
    packOf(await pack(mike, g1), "Mike downloads the Friday pack");
    const seen = viewOf(await open(terry, g1), "Terry reads the plan");
    assert.deepEqual(seen.receipts.map((r) => r.userId).sort(), [mike.userId, sam.userId].sort(), "two receipts: Sam's from Get ready and Mike's");
    await reset();
    await openBand();
    await app.until(`!!${card(g1)}`, "the pinned card");
    const text = await cardText(g1);
    assert.equal(count(text, "Downloaded ✓"), 2, `two players show Downloaded ✓ (${text.slice(0, 200)})`);
    assert.equal(count(text, "Not yet"), 2, "and two show Not yet");
    for (const id of [sam.userId, mike.userId, terry.userId, dana.userId]) assert.match(text, new RegExp(nameOf.get(id)!.split(" ")[0]), `${nameOf.get(id)} is on the card`);
    await app.shot(shots && `${shots}/gig-plan-downloaded.png`);
  });

  await check("a second download of the same pack rev adds no receipt and no duplicate pack", async () => {
    await needG1();
    const before = viewOf(await open(terry, g1), "the receipts before").receipts;
    packOf(await pack(mike, g1), "Mike downloads the same pack again");
    assert.deepEqual(viewOf(await open(terry, g1), "the receipts after").receipts, before, "the receipts are unchanged");
    const packFetches = () => site.evaluate<number>(`JSON.parse(sessionStorage.getItem("__sent") ?? "[]").filter((entry) => /^fetch \\S*\\/api\\/bands\\/gig\\/pack /.test(entry)).length`);
    const fetchedBefore = await packFetches();
    await tap("Get ready", card(g1));
    await eventually(packFetches, (n) => n === fetchedBefore + 1, "Sam's phone asking for the pack once more");
    await app.until(`${card(g1)}?.textContent.includes("Downloaded ✓")`, "the card still showing Downloaded ✓");
    const packs = await packsOnPhone();
    assert.equal(packs.filter((p) => p.gig.gigId === g1).length, 1, "Sam's phone holds one pack for the gig");
    assert.deepEqual(viewOf(await open(terry, g1), "the receipts after Sam's second tap").receipts, before, "and Sam's second tap added no receipt either");
  });

  await check("a gig link lands lineup members on the card and others on 'This gig is for tonight's lineup'", async () => {
    await needG1();
    const made = await terry.call("/api/codes", { kind: "gig", bandId, gigId: g1 });
    assert.equal(made.status, 200, `Terry makes a gig link (${js(made.body)})`);
    const { code, link } = made.body as { code: string; link: string };
    assert.equal(code.split(".")[0], "gig", "the code is a gig code");
    for (const [who, what] of [[sam.userId, "Sam"], [mike.userId, "Mike"], [terry.userId, "Terry"]]) assert.ok(!link.includes(who) && !link.includes(g1) && !link.includes(bandId), `the link carries no id (${what})`);
    const landedAt = await land(base, code);
    assert.deepEqual([landedAt.status, landedAt.location], [302, `${origin}/?open=gig&code=${code}`], "a plain browser is sent to the gig landing");
    assert.equal(viewOf(await dana.call("/api/bands/gig/code", { code }), "Dana, on the Friday lineup, opens the link").gig.gigId, g1, "and gets the gig");
    assert.deepEqual(refusal(await eve.call("/api/bands/gig/code", { code })), [403, "not-on-lineup"], "a stranger is told it is for the lineup");
    viewOf(await setLineup(terry, g1, [sam.userId, mike.userId, terry.userId]), "Terry takes Dana off the Friday lineup");
    assert.deepEqual(refusal(await dana.call("/api/bands/gig/code", { code })), [403, "not-on-lineup"], "and so is Dana now");

    await site.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `new MutationObserver(() => { if (document.querySelector(".account-sheet:not(.bands-sheet):not(.chat-sheet):not(.friends-sheet)")) window.sawSignIn = true; }).observe(document, { childList: true, subtree: true });`,
    });
    await site.send("Page.navigate", { url: link });
    await app.until(`!!${card(g1)}`, "the gig card for a lineup member opening the link", 15000);
    assert.equal(await site.evaluate("window.sawSignIn ?? false"), false, "with no sign-in sheet on the way");
    assert.equal(await site.evaluate<string>("location.search"), "", "the landed code leaves the address bar");

    await site.evaluate(`location.hash = "#/songs"`);
    await app.openMenu();
    await app.pick("Account");
    await app.click("Sign out");
    await app.until(`!document.querySelector(".account-sheet") || document.querySelector(".account-sheet")?.dataset.step === "start"`, "Sam signed out");
    await site.send("Page.navigate", { url: link });
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "start"`, "the sign-in screen first for a signed-out visitor");
    await app.click("✕");
    await app.until(`!document.querySelector(".account-sheet")`, "the sign-in screen closing");
    assert.ok(!(await site.evaluate<boolean>(`!!document.querySelector(".account-sheet")`)), "a signed-out visitor can close the sign-in screen the gig link opened");
    assert.deepEqual(await app.openMenu(), ["Sign in"], "and is back in the app, still signed out");
    await app.closeMenu();
    await site.send("Page.navigate", { url: link });
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "start"`, "the sign-in screen again");
    await app.click("New here? Create an account");
    await app.type("Your name (what bandmates see)", "Pat Lee");
    await app.click("Sign in with Face ID or fingerprint");
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "nudge"`, "the add-a-password nudge");
    await app.click("Not now");
    await app.click("✕");
    await app.until(`document.body.textContent.includes("This gig is for tonight's lineup")`, "the words for someone not on the lineup", 15000);
    assert.ok(!(await site.evaluate<boolean>(`!!${card(g1)}`)), "and no gig card for Pat");
    await app.shot(shots && `${shots}/gig-link-not-lineup.png`);
  });

  await check("the pack carries Scroll with the leader and the band's timing for each song, never a member's private version", async () => {
    await needG1();
    const mikes = packOf(await pack(mike, g1), "Mike's Friday pack");
    assert.equal(mikes.scrollWithLeader, true, "the pack carries the band's Scroll with the leader setting");
    assert.deepEqual(mikes.songs.map((s) => s.bandTiming), SET_SONGS.map(() => null), "no song has band timing, since the band shared none");
    assert.deepEqual(mikes.songs.map((s) => s.songId), shared, "each song is the band song the setlist names");
    assert.equal((await terry.call("/api/bands/settings", { bandId, scrollWithLeader: false })).status, 200, "Terry turns the setting off");
    assert.equal(packOf(await pack(mike, g1), "Mike's pack again").scrollWithLeader, false, "and the pack follows");
    const sent = await site.evaluate<string[]>(`JSON.parse(sessionStorage.getItem("__sent") ?? "[]")`);
    assert.ok(sent.length > 0, "the recorder saw Sam's phone send");
    const outsideBackup = sent.filter((entry) => !/^fetch \S*\/api\/backup /.test(entry));
    for (const [where, text] of [["the pack", js(mikes)], ...outsideBackup.map((entry) => ["what Sam's phone sent", entry])]) {
      for (const mark of PRIVATE_MARKS) assert.ok(!text.includes(mark), `Sam's private timing version (${mark}) never appears in ${where}: ${text.slice(0, 160)}`);
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
console.log("check:gig-plan passed");
