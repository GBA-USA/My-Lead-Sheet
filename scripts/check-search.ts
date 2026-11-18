import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect, type AddressInfo } from "node:net";
import * as search from "../src/search.ts";
import { matchingSetlists, matchingSongs } from "../src/search.ts";
import type { LibraryFile, Setlist, Song, SongRef } from "../src/types.ts";
import { startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle } from "./app-page.ts";
import { openSite } from "./chrome.ts";

const seed = JSON.parse(readFileSync(new URL("../data/library.json", import.meta.url), "utf8")) as LibraryFile;
const local = (id: number): SongRef => `local/${id}`;
const mine: Song[] = seed.songs.map((song) => ({ ...song, ref: local(song.id) }));
const extra: Song = { ...mine[0], ref: local(900), id: 900, title: "Café Del Mar", artist: "Beyoncé" };
const bandCopy: Song = { ...mine.find((song) => song.id === 10)!, ref: "01JBANDROOM0000000000000000/01JBANDSONG0000000000000000", title: "Zebra Crossing", artist: "The Band" };
const songs = [...mine, extra, bandCopy];
const setlists: Setlist[] = [
  ...seed.setlists.map(({ songIds, ...setlist }) => ({ ...setlist, songRefs: songIds.map(local) })),
  { id: 77, name: "Empty night", songRefs: [] },
];

let failures = 0;
function expect<T>(actual: T[], expected: T[], message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1;
    console.error(`FAIL ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const titles = (query: string) => matchingSongs(songs, query).map((song) => song.title);
const names = (query: string) => matchingSetlists(setlists, songs, query).map((setlist) => setlist.name);

expect(titles(""), songs.map((song) => song.title), "an empty box shows every song in library order");
expect(titles("   "), songs.map((song) => song.title), "a box of spaces shows every song");
expect(titles("NEON moon"), ["Neon Moon"], "matching ignores case");
expect(titles("no half steppin"), ["No Half Steppin'"], "a missing trailing apostrophe still matches");
expect(titles("say it aint so"), ["Say It Ain't So"], "a missing inner apostrophe still matches");
expect(titles("say it ain’t so"), ["Say It Ain't So"], "a curly apostrophe matches a straight one");
expect(titles("cafe"), ["Café Del Mar"], "an unaccented query finds an accented title");
expect(titles("beyonce"), ["Café Del Mar"], "an unaccented query finds an accented artist");
expect(titles("zach williams"), ["To The Table", "Chain Breaker"], "artist matches find every song by that artist");
expect(titles("brooks dunn"), ["Neon Moon"], "punctuation between words is ignored");
expect(titles("chain"), ["Chain Breaker"], "a partial title matches as you type");
expect(titles("xyzzy"), [], "a query that matches nothing returns no songs");

expect(names(""), setlists.map((setlist) => setlist.name), "an empty box shows every setlist, empty ones too");
expect(names("biker"), ["Biker church"], "a setlist matches by its name");
expect(names("WORSHIP"), ["Worship Set"], "setlist name matching ignores case");
expect(names("chain breaker"), ["Worship Set", "Biker church"], "a setlist matches when it holds a matching song");
expect(names("casting crowns"), ["Worship Set", "Biker church"], "a setlist matches when it holds a song by a matching artist");
expect(names("say it aint so"), [], "a song in no setlist matches no setlist");
expect(names("xyzzy"), [], "a query that matches nothing returns no setlists");
expect(names("zebra"), [], "a band's copy with the same id as a song in a setlist does not match that setlist");

const shown = matchingSetlists(setlists, songs, "chain breaker")[0];
expect(shown?.songRefs ?? [], seed.setlists[0].songIds.map(local), "a shown setlist keeps all of its songs in order");

const BLUE = "01JBLUENOTES000000000000000";
const LEFT = "01JOLDBAND00000000000000000";
const seedSong = (id: number) => mine.find((song) => song.id === id)!;
const blueChain: Song = { ...seedSong(10), ref: `${BLUE}/01JSONGCHAINOFFOOLS00000000`, id: 0, title: "Chain of Fools", artist: "Aretha Franklin", keyRoot: "C", keyMode: "minor", keyLabel: "C minor" };
const blueNeon: Song = { ...seedSong(2), ref: `${BLUE}/01JSONGNEONMOON000000000000`, id: 0 };
const mikeChains: Song = { ...seedSong(10), ref: local(902), id: 902, title: "Chains", artist: "The Cookies", keyRoot: "C", keyMode: "minor", keyLabel: "C minor", copy: { id: "01JSHAREMIKE000000000000000", canSendOn: true, from: { name: "Mike" } } };
const fromBand: Song = { ...seedSong(1), ref: local(903), id: 903, title: "Bring It On Home", artist: "Sam Cooke", copy: { id: "01JCOPYBAND0000000000000000", canSendOn: false } };
const leftSong: Song = { ...seedSong(10), ref: `${LEFT}/01JSONGCHAINLIGHTNING000000`, id: 0, title: "Chain Lightning", artist: "Steely Dan" };
const everywhere = [...songs, blueChain, blueNeon, mikeChains, fromBand, leftSong];
const bands = new Map([[BLUE, "The Blue Notes"]]);
const never = () => false;

const chips = (over: Partial<search.SongChips> = {}): search.SongChips => ({ ...search.NO_CHIPS, ...over });
const grouped = (query: string, on: Partial<search.SongChips> = {}, timed: (ref: SongRef) => boolean = never, from = everywhere, held = bands) =>
  search.groupedSongs(from, held, query, chips(on), timed).map((group) => `${group.label}: ${group.songs.map((song) => song.title).join(", ")}`);
const guard = (adding: Pick<Song, "title" | "artist">) => {
  const have = search.songYouHave(mine, adding);
  return have ? [search.youHaveLine(have), have.ref] : [];
};

function newCase(name: string, run: () => void) {
  try {
    run();
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

newCase("grouping", () => {
  expect(grouped("chain"), ["My Songs: Chain Breaker", "The Blue Notes: Chain of Fools", "From Mike: Chains"], "results are grouped by where they live: My Songs, The Blue Notes, From Mike");
  expect(grouped("neon moon"), ["My Songs: Neon Moon", "The Blue Notes: Neon Moon"], "an identical built-in chart in a band is its own result, judged by ref and not by content");
  expect(grouped("sam cooke"), ["My Songs: Bring It On Home"], "a copy added from a band, with no friend named, lives in My Songs");
  expect(grouped("chain", {}, never, mine, new Map()), ["My Songs: Chain Breaker"], "with no bands the My Songs group shows alone, with no empty band headers");
  expect(grouped("xyzzy"), [], "a query that matches nothing returns no groups");
});

newCase("chips", () => {
  expect(grouped("", { band: BLUE }), ["The Blue Notes: Chain of Fools, Neon Moon"], "the band chip keeps only that band's songs");
  expect(grouped("chain", { key: "Cm" }), ["The Blue Notes: Chain of Fools", "From Mike: Chains"], "the key chip keeps only that key");
  expect(grouped("zach", { band: BLUE }), [], "a chip that leaves nothing shows no groups");
  expect([search.keyName(seedSong(11)), search.keyName(seedSong(10))], ["F#m", "C"], "a key chip names the key root, with m for minor");
  expect(grouped("chain", { timed: true }, (ref) => ref === mikeChains.ref), ["From Mike: Chains"], "has timing keeps only songs with a saved version");
});

newCase("duplicate guard", () => {
  expect(guard({ title: "no half steppin", artist: "SEAN COSTELLO" }), ["You already have No Half Steppin' · Open it?", local(13)], "the duplicate guard offers Open it when a folded title and artist match a song you have");
  expect(guard({ title: "No Half Steppin'", artist: "Someone Else" }), [], "the duplicate guard never blocks two different songs with the same title");
});

newCase("another band", () => {
  expect(grouped("steely dan"), [], "search never looks into another band's library");
  expect(grouped("zebra"), [], "a band song from a band this phone holds no name for is not shown");
});

const pure = failures;
console.log(pure ? `${pure} pure search case(s) failed` : "ok   pure search cases: case, accents, apostrophes, setlists, groups, chips, duplicate guard, other bands");

const js = (value: unknown) => JSON.stringify(value);
const root = new URL("..", import.meta.url).pathname;

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let apiBase = "";
const site = await openSite(root, "check-search", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;
try {
  const app = await appPage(site);
  await site.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      window.__api = 0;
      const counted = (url) => { if (String(url).includes("/api/")) window.__api += 1; };
      const fetchNext = window.fetch;
      window.fetch = (input, init) => (counted(input?.url ?? input), fetchNext(input, init));
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket { constructor(url, protocols) { counted(url); super(url, protocols); } };
      const open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) { counted(url); return open.call(this, method, url, ...rest); };
    })();`,
  });
  const offline = (on: boolean) => site.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const appCalls = (path: string, body: object) =>
    site.evaluate<{ status: number; body: any }>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const box = (label: string) => `document.querySelector(${js(`input[aria-label="${label}"]`)})`;
  const typeIn = async (label: string, text: string) => {
    await app.until(`!!${box(label)}`, `the ${label} box`);
    await site.evaluate(`(() => { const field = ${box(label)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, ""); field.dispatchEvent(new Event("input", { bubbles: true })); field.focus(); })()`);
    await settle(100);
    await site.send("Input.insertText", { text });
    await settle();
  };
  const groups = () =>
    site.evaluate<string[]>(`[...document.querySelectorAll(".search-group")].map((g) => g.querySelector(".search-group-head").textContent.trim() + ": " + [...g.querySelectorAll(".song-title")].map((t) => t.textContent.trim()).join(", "))`);
  const bandKeys = () =>
    site.evaluate<string[]>(`(async () => {
      if (!(await indexedDB.databases()).some((db) => db.name === "mls-phone")) return [];
      const db = await new Promise((done, fail) => { const r = indexedDB.open("mls-phone"); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
      try {
        if (!db.objectStoreNames.contains("bandSongs")) return [];
        return await new Promise((done, fail) => { const r = db.transaction("bandSongs").objectStore("bandSongs").getAllKeys(); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
      } finally { db.close(); }
    })()`);
  const tapRow = async (title: string, scope = "document") => {
    const tapped = await site.evaluate<boolean>(`(() => { const row = [...${scope}.querySelectorAll(".song-row")].find((r) => r.querySelector(".song-title")?.textContent.trim() === ${js(title)}); row?.click(); return !!row; })()`);
    assert.ok(tapped, `a ${title} row to tap`);
    await settle();
  };
  const bandsSheet = (name: string) => app.until(`document.querySelector(".bands-sheet, .band-page")?.dataset.view === ${js(name)} && !document.querySelector(".bands-sheet, .band-page").textContent.includes("Loading")`, `the bands ${name} view`, 15000);
  const openBandSongs = async (name: string, bandId: string) => {
    await site.evaluate(`location.hash = "#/bands"`);
    await app.until(`[...document.querySelectorAll(".bands-tab .song-title")].some((t) => t.textContent.trim() === ${js(name)})`, `${name} on the Bands tab`, 15000);
    await tapRow(name, `document.querySelector(".bands-tab")`);
    await bandsSheet("band");
    await app.click("Songs", `document.querySelector(".band-tabs")`);
    await app.until(`!!document.querySelector(".band-library-songs")`, `${name}'s songs`, 15000);
    for (const end = Date.now() + 8000; Date.now() < end && !(await bandKeys()).some((key) => key.startsWith(`${bandId}/`)); ) await settle(100);
    await site.evaluate(`location.hash = "#/bands"`);
  };
  const content = ({ id: _id, ref: _ref, copy: _copy, ...song }: Song) => song;

  const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
  const makeBand = async (name: string, title: string, artist: string) => {
    const bandId = (await terry.call("/api/bands/create", { name })).body.bandId as string;
    const shared = await terry.call("/api/bands/library/share-song", { bandId, song: { ...content(seedSong(10)), title, artist }, choice: "public", localId: null });
    assert.equal(shared.status, 200, `Terry shares ${title} into ${name}`);
    return { bandId, code: (await terry.call("/api/codes", { kind: "band", bandId })).body.code as string };
  };
  const blue = await makeBand("The Blue Notes", "Mustang Sally", "Wilson Pickett");
  const old = await makeBand("Old Band", "Mustang Ranch", "The Old Band Boys");

  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await site.evaluate("Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((done) => setTimeout(done, 20000, false))])");
  if (!(await site.evaluate<boolean>("!!navigator.serviceWorker.controller"))) await site.send("Page.reload");
  await app.until("!!navigator.serviceWorker?.controller", "the service worker to take control of the page", 60000);
  await app.library();
  await app.signUp("Sam Rivera");
  for (const band of [blue, old]) assert.equal((await appCalls("/api/bands/join", { code: band.code })).status, 200, "Sam joins the band");
  await openBandSongs("The Blue Notes", blue.bandId);
  await openBandSongs("Old Band", old.bandId);

  await check("results are grouped by where they live (on the phone, from the band songs this phone holds)", async () => {
    await site.evaluate(`location.hash = "#/songs"`);
    await typeIn("Search songs", "mustang");
    const shown = await groups();
    assert.ok(shown.includes("The Blue Notes: Mustang Sally") && shown.includes("Old Band: Mustang Ranch"), `both bands' songs show while Sam is in both (saw ${js(shown)})`);
  });

  await check("search never looks into another band's library (on the phone, a band Sam left drops out)", async () => {
    await site.evaluate(`location.hash = "#/bands"`);
    await app.until(`[...document.querySelectorAll(".bands-tab .song-title")].some((t) => t.textContent.trim() === "Old Band")`, "Old Band on the Bands tab", 15000);
    await tapRow("Old Band", `document.querySelector(".bands-tab")`);
    await bandsSheet("band");
    await app.click("Members", `document.querySelector(".band-tabs")`);
    await app.click("Leave band");
    await app.click("Yes, leave Old Band");
    await app.until(`location.hash === "#/bands"`, "the Bands tab after leaving");
    for (const end = Date.now() + 8000; Date.now() < end && (await bandKeys()).some((key) => key.startsWith(`${old.bandId}/`)); ) await settle(100);
    await site.evaluate(`location.hash = "#/songs"`);
    await typeIn("Search songs", "mustang");
    assert.deepEqual(await groups(), ["The Blue Notes: Mustang Sally"], "only the band Sam is still in shows");
  });

  await check("search reads nothing from the server", async () => {
    await offline(true);
    try {
      await site.evaluate(`window.__beforeReload = true; location.reload()`);
      await app.until(`!window.__beforeReload && !!document.querySelector(".shell-header [aria-label=Settings]")`, "the library with no signal", 15000);
      const before = await site.evaluate<number>("window.__api");
      await typeIn("Search songs", "mustang");
      await app.until(`document.querySelectorAll(".search-group").length > 0`, "results with no signal");
      assert.deepEqual(await groups(), ["The Blue Notes: Mustang Sally"], "the band's song still shows with no signal");
      assert.equal(await site.evaluate<number>("window.__api"), before, "searching made zero /api/ requests");
    } finally {
      await offline(false);
    }
  });

  await check("no match shows Nothing matches and the chips stay", async () => {
    await typeIn("Search songs", "xyzzy");
    assert.equal(await app.text(".search-empty"), "Nothing matches", "the empty line");
    assert.ok((await app.texts(".search-chips button")).includes("Has timing"), "the Has timing chip is still there");
  });

  await check("has timing keeps only songs with a saved version (on the phone, leadSheetsScrollVersions present)", async () => {
    const version = { versions: [{ name: "V1", bpm: 120, marks: [{ at: 0, progress: 0 }, { at: 200, progress: 1 }] }], selected: 0 };
    await site.evaluate(`localStorage.setItem("leadSheetsScrollVersions.10", ${js(js(version))})`);
    await typeIn("Search songs", "zach williams");
    assert.deepEqual(await groups(), ["My Songs: To The Table, Chain Breaker"], "both of Zach Williams's songs before the chip");
    await app.click("Has timing", `document.querySelector(".search-chips")`);
    assert.deepEqual(await groups(), ["My Songs: Chain Breaker"], "only the song with a saved version after it");
    await app.click("Has timing", `document.querySelector(".search-chips")`);
  });

  await check("Has timing leaves out a song whose only version holds settings", async () => {
    const settings = { versions: [{ name: "Low set", semitones: 1, metronomeBpm: 78, scrollPercent: 100, notation: "notes" }], selected: 0 };
    await site.evaluate(`localStorage.setItem("leadSheetsScrollVersions.9", ${js(js(settings))})`);
    try {
      await typeIn("Search songs", "zach williams");
      await app.click("Has timing", `document.querySelector(".search-chips")`);
      assert.deepEqual(await groups(), ["My Songs: Chain Breaker"], "To The Table holds a key change and no timing, so only Chain Breaker stays");
      await app.click("Has timing", `document.querySelector(".search-chips")`);
    } finally {
      await site.evaluate(`localStorage.removeItem("leadSheetsScrollVersions.9")`);
    }
  });

  await check("a tapped result opens the sheet with its ref", async () => {
    await typeIn("Search songs", "chain breaker");
    await tapRow("Chain Breaker", `document.querySelector(".search-group")`);
    await app.until(`location.hash === "#/song/10" && document.querySelector(".sheet .sheet-name")?.textContent === "Chain Breaker"`, "Chain Breaker's sheet");
    await site.evaluate(`location.hash = "#/songs"`);
    await typeIn("Search songs", "mustang");
    await app.click("The Blue Notes", `document.querySelector(".search-chips")`);
    await tapRow("Mustang Sally", `document.querySelector(".search-group")`);
    await app.until(`document.querySelector(".sheet .sheet-name")?.textContent === "Mustang Sally" && !!document.querySelector(".chart")`, "the band's Mustang Sally sheet");
    const held = (await bandKeys()).filter((key) => key.startsWith(`${blue.bandId}/`));
    assert.deepEqual([await site.evaluate<string>(`document.querySelector(".search-open")?.dataset.ref ?? ""`)], held, "the open sheet is the band song's ref");
    await app.click("Back");
    await app.until(`!!${box("Search songs")}`, "back on My Songs");
  });

  await check("the Setlists tab search still finds setlists", async () => {
    await site.evaluate(`location.hash = "#/setlists"`);
    await typeIn("Search setlists", "chain breaker");
    assert.deepEqual(await app.texts(".setlist h2"), ["Worship Set", "Biker church"], "setlists holding Chain Breaker");
  });

  const myCount = () => site.evaluate<number>(`JSON.parse(localStorage.getItem("leadSheetsLibrary")).songs.length`);
  const bandRow = (artist: string) => `[...document.querySelectorAll(".band-library-songs li")].find((li) => li.textContent.includes(${js(artist)}))`;
  const dmCard = (artist: string) => `[...document.querySelectorAll(".room li")].find((li) => li.textContent.includes(${js(artist)}))`;
  const openBlueSongs = async () => {
    await site.evaluate(`location.hash = "#/bands"`);
    await app.until(`[...document.querySelectorAll(".bands-tab .song-title")].some((t) => t.textContent.trim() === "The Blue Notes")`, "The Blue Notes on the Bands tab", 15000);
    await tapRow("The Blue Notes", `document.querySelector(".bands-tab")`);
    await bandsSheet("band");
    await app.click("Songs", `document.querySelector(".band-tabs")`);
    await app.until(`!!document.querySelector(".band-library-songs")`, "The Blue Notes' songs", 15000);
  };
  const openTerrysDm = async () => {
    await site.evaluate(`location.hash = "#/songs"`);
    await app.openMenu();
    await app.pick("Messages");
    await app.until(`location.hash === "#/messages" && [...document.querySelectorAll(".messages .chat-row-title")].some((t) => t.textContent === "Terry Bass")`, "Terry's DM on the list", 15000);
    await site.evaluate(`[...document.querySelectorAll(".messages .chat-row")].find((b) => b.querySelector(".chat-row-title")?.textContent === "Terry Bass").click()`);
    await app.until(`location.hash.startsWith("#/messages/dm_") && !!document.querySelector(".room .chat-composer")`, "Terry's DM");
  };
  const CHAIN_BREAKERS = [["Chain Breaker", "The Other Chain Gang"], ["chain-breaker", "ZACH WILLIAMS"]] as const;

  await check("a same-title song by a different artist adds with no prompt, and a band song stays in the band", async () => {
    for (const [title, artist] of CHAIN_BREAKERS) {
      const shared = await terry.call("/api/bands/library/share-song", { bandId: blue.bandId, song: { ...content(seedSong(10)), title, artist }, choice: "public", localId: null });
      assert.equal(shared.status, 200, `Terry shares ${title} by ${artist} into The Blue Notes`);
    }
    await openBlueSongs();
    await app.until(`!!${bandRow("ZACH WILLIAMS")} && !!${bandRow("The Other Chain Gang")}`, "both Chain Breaker rows");
    assert.ok(!(await site.evaluate<boolean>(`[...document.querySelectorAll(".band-library-songs button")].some((b) => b.textContent.trim() === "Add to My Songs")`)), "a band song row has no Add to My Songs");
    const me = await site.evaluate<{ userId: string; handle: string }>(`fetch("/api/me").then((r) => r.json()).then((reply) => reply.account)`);
    assert.equal((await terry.call("/api/friends/request", { handle: me.handle })).status, 200, "Terry asks Sam to be friends");
    assert.equal((await appCalls("/api/friends/accept", { userId: terry.userId })).status, 200, "Sam accepts");
    for (const [title, artist] of CHAIN_BREAKERS) {
      const sent = await terry.call("/api/chat/send-song", { userId: me.userId, msgId: crypto.randomUUID().replace(/-/g, ""), shareId: crypto.randomUUID().replace(/-/g, ""), song: { ...content(seedSong(10)), title, artist }, versions: [], data: null, choice: "public" });
      assert.equal(sent.status, 200, `Terry sends Sam ${title} by ${artist} (${js(sent.body)})`);
    }
    await openTerrysDm();
    await app.until(`!!${dmCard("The Other Chain Gang")}?.querySelector("button")`, "The Other Chain Gang's card", 15000);
    const before = await myCount();
    await app.click("Add to My Songs", dmCard("The Other Chain Gang"));
    await app.until(`JSON.parse(localStorage.getItem("leadSheetsLibrary")).songs.length === ${before + 1}`, "the song by a different artist added", 15000);
    assert.ok(!(await site.evaluate<string>(`document.querySelector(".room").textContent`)).includes("You already have"), "with no duplicate prompt");
  });

  await check("the duplicate guard offers Open it when adding a song you already have, and adds nothing until the player chooses", async () => {
    await app.until(`!!${dmCard("ZACH WILLIAMS")}?.querySelector("button")`, "the ZACH WILLIAMS card's Add button", 15000);
    const before = await myCount();
    await app.click("Add to My Songs", dmCard("ZACH WILLIAMS"));
    await app.until(`${dmCard("ZACH WILLIAMS")}?.textContent.includes("You already have Chain Breaker · Open it?")`, "the duplicate prompt on the card");
    await settle(500);
    assert.equal(await myCount(), before, "nothing is added before the player chooses");
    assert.ok(await site.evaluate<boolean>(`[...${dmCard("ZACH WILLIAMS")}.querySelectorAll("button")].some((b) => b.textContent.trim() === "Add anyway")`), "Add anyway is offered");
    await site.evaluate(`[...${dmCard("ZACH WILLIAMS")}.querySelectorAll("a")].find((a) => a.textContent.trim() === "Open").click()`);
    await app.until(`location.hash === "#/song/10" && !document.querySelector(".room") && document.querySelector(".sheet .sheet-name")?.textContent === "Chain Breaker"`, "Open shows the Chain Breaker already in My Songs");
    assert.equal(await myCount(), before, "and Open adds nothing");
  });

  await check("no page errors", async () => assert.deepEqual(await app.errors(), [], "the page logged no errors"));

  await check("a signed-out phone shows no band songs in search after the session ends", async () => {
    await site.evaluate(`location.hash = "#/songs"`);
    await typeIn("Search songs", "mustang");
    assert.deepEqual(await groups(), ["The Blue Notes: Mustang Sally"], "Sam, signed in, finds the band's song");
    await site.send("Network.clearBrowserCookies");
    await site.evaluate(`window.__beforeReload = true; location.reload()`);
    await app.until(`!window.__beforeReload && !!document.querySelector(".shell-header [aria-label=Settings]")`, "the library after the session ended", 15000);
    await app.until(`localStorage.getItem("leadSheetsSignedIn") === null`, "the phone to learn it is signed out", 15000);
    await typeIn("Search songs", "mustang");
    await settle(800);
    assert.deepEqual(await groups(), [], "no band group shows once signed out");
    assert.deepEqual(await app.errors(), [], "the page logged no errors");
  });
  await check("a search typed before a slow launch answers drops the band songs once the phone learns it is signed out", async () => {
    let gate = Promise.resolve();
    let release = () => {};
    const proxy = createServer((request, response) =>
      gate.then(() => {
        const target = new URL(request.url ?? "/", base);
        const out = httpRequest(target, { method: request.method, headers: { ...request.headers, host: target.host } }, (reply) => {
          response.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(response);
        });
        out.on("error", () => {
          response.writeHead(502);
          response.end();
        });
        request.pipe(out);
      }),
    );
    proxy.on("upgrade", (request, socket, head) => {
      const target = new URL(base);
      const upstream = connect(Number(target.port), target.hostname, () => {
        const lines = [`${request.method} ${request.url} HTTP/1.1`];
        for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i].toLowerCase() === "host" ? target.host : request.rawHeaders[i + 1]}`);
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    apiBase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
      await app.signUp("Ann Horn");
      assert.equal((await appCalls("/api/bands/join", { code: blue.code })).status, 200, "Ann joins The Blue Notes");
      await openBlueSongs();
      await site.evaluate(`location.hash = "#/songs"`);
      await typeIn("Search songs", "mustang");
      await app.until(`[...document.querySelectorAll(".search-group-head")].some((h) => h.textContent.trim() === "The Blue Notes")`, "Ann, signed in, finding the band's song");
      gate = new Promise<void>((done) => (release = done));
      await site.send("Network.clearBrowserCookies");
      await site.evaluate(`window.__beforeReload = true; location.reload()`);
      await app.until(`!window.__beforeReload && !!document.querySelector(".shell-header [aria-label=Settings]")`, "the library while every /api/ call is held", 15000);
      await typeIn("Search songs", "mustang");
      await settle(800);
      assert.ok(await site.evaluate<boolean>(`localStorage.getItem("leadSheetsSignedIn") !== null`), "the search was typed while the launch check was still unanswered");
      release();
      await app.until(`localStorage.getItem("leadSheetsSignedIn") === null`, "the launch 401", 15000);
      await settle(1200);
      assert.equal(await site.evaluate<string>(`document.querySelector('input[aria-label="Search songs"]').value`), "mustang", "the box still holds the search");
      assert.deepEqual(await groups(), [], "no band group shows once the phone learns it is signed out, without retyping");
      assert.deepEqual(await app.errors(), [], "the page logged no errors");
    } finally {
      release();
      apiBase = base;
      proxy.close();
    }
  });
} finally {
  await site.close();
  await worker.dispose();
}

if (failures) {
  console.error(`${failures} search check(s) failed`);
  process.exit(1);
}
console.log("search ok: case, accents, apostrophes, punctuation, artist, setlist by name and by song, empty box shows all, groups, chips, duplicate guard, offline, left bands");
