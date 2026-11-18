import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { BandLibrary, SongContent } from "../src/band-library-model.ts";
import { readPayload } from "../src/code-link.ts";
import type { ChatMessage } from "../src/chat-model.ts";
import { startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, readQr, settle } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/**
 * U4, the band page (UX-PLAN U4, SCREEN-MAP 4). One case per pass condition, named by it. The cases fix this contract.
 *
 * `#/bands` lists the bands (`.bands-tab`, one `.song-row` per band). A row lands on `#/band/<bandId>`, a route screen
 * `.band-page[data-band=<bandId>][data-view=band]` with the band's name in its `h2`, an Invite button and a Show as QR
 * button in its header, the next gig card `.next-gig` (`[data-next-gig=<gigId>]` when there is one), an empty
 * `.band-status-slot`, and the tabs `.band-tabs [role=tab]`. The open section is `?s=<songs|setlists|chat|gigs|members>`.
 * Band song and setlist rows each have a `button.band-library-row` holding `.band-library-name`. A band song opens at
 * `#/band/<bandId>/song/<songId>`. A setlist row opens `.band-setlist-view`, whose Live lands on
 * `#/live/band/<bandId>/<setlistId>/<index>`. The Chat section holds the band's thread (`.chat-messages`, the composer
 * labelled Message). Leaving or losing the band lands on `#/bands` with the words in `.bands-notice`.
 * `POST /api/bands/library/copy-song` is `403 band-only`.
 */

type Reply = { status: number; body: Record<string, any> };
type Player = Awaited<ReturnType<typeof passwordPlayer>>;

const root = new URL("..", import.meta.url).pathname;
const shots = process.env.SHOTS;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const js = (value: unknown) => JSON.stringify(value);
const refusal = (reply: Reply) => [reply.status, reply.body.error];
const newId = () => crypto.randomUUID().replace(/-/g, "");
const gigId = () => `gig_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;
const dayFromNow = (days: number) => {
  const day = new Date();
  day.setDate(day.getDate() + days);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};

const seed = JSON.parse(readFileSync(`${root}data/library.json`, "utf8")) as { songs: (SongContent & { id: number })[] };
const content = ({ id: _id, ...song }: SongContent & { id: number }): SongContent => song;
const chart = (title: string, artist: string, lyric: string): SongContent => ({
  ...content(seed.songs[0]),
  title,
  artist,
  body: [{ heading: "Verse 1", lines: [{ chords: "G       C", lyrics: lyric }] }],
});
const SET_SONGS = [chart("Low Tide", "Terry Bass", "Wait for the low tide"), chart("Harbor Lights", "Terry Bass", "Harbor lights are low"), chart("Salt Road", "Terry Bass", "Down the salt road home")];
const TITLES = SET_SONGS.map((song) => song.title);
const SECTIONS = ["Songs", "Setlists", "Chat", "Gigs", "Members"];

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

async function band(admin: Player, name: string, members: Player[]) {
  const bandId = (await admin.call("/api/bands/create", { name })).body.bandId as string;
  const code = (await admin.call("/api/codes", { kind: "band", bandId })).body.code as string;
  for (const member of members) assert.equal((await member.call("/api/bands/join", { code })).status, 200, `${member.name} joins ${name}`);
  return { bandId, code };
}

let apiBase = "";
const site = await openSite(root, "check-ux-band-page", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;
try {
  const app = await appPage(site);
  await site.send("Network.enable");
  await site.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      window.__api = 0;
      const counted = (url) => { if (String(url).includes("/api/")) window.__api += 1; };
      const fetchNext = window.fetch;
      window.fetch = (input, init) => (counted(input?.url ?? input), fetchNext(input, init));
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket { constructor(url, protocols) { counted(url); super(url, protocols); } };
    })();`,
  });
  const offline = (on: boolean) => site.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const appCalls = (path: string, body: object) =>
    site.evaluate<Reply>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const page = (bandId: string) => `document.querySelector(${js(`.band-page[data-band="${bandId}"]`)})`;
  const onPage = (bandId: string, view = "band") =>
    app.until(`${page(bandId)}?.dataset.view === ${js(view)} && !${page(bandId)}.textContent.includes("Loading")`, `the band page of ${bandId} (${view})`, 15000);
  const pageText = (bandId: string) => site.evaluate<string>(`${page(bandId)}?.textContent ?? ""`);
  const tabs = (bandId: string) => site.evaluate<{ text: string; selected: boolean }[]>(`[...(${page(bandId)}?.querySelectorAll(".band-tabs [role=tab]") ?? [])].map((t) => ({ text: t.firstChild?.textContent.trim() ?? "", selected: t.getAttribute("aria-selected") === "true" }))`);
  const section = async (bandId: string, name: string) => {
    await app.click(name, `${page(bandId)}?.querySelector(".band-tabs")`);
    await app.until(`${page(bandId)}?.querySelector(".band-tabs [aria-selected=true]")?.firstChild?.textContent.trim() === ${js(name)}`, `the ${name} section`);
  };
  const openBand = async (bandId: string, name: string) => {
    await site.evaluate(`location.hash = "#/bands"`);
    await app.until(`[...document.querySelectorAll(".bands-tab .song-title")].some((t) => t.textContent.trim() === ${js(name)})`, `${name} on the Bands tab`, 15000);
    await site.evaluate(`[...document.querySelectorAll(".bands-tab .song-row")].find((r) => r.querySelector(".song-title")?.textContent.trim() === ${js(name)}).click()`);
    await onPage(bandId);
  };
  const tapRow = async (bandId: string, list: "songs" | "setlists", title: string) => {
    await app.until(`[...(${page(bandId)}?.querySelectorAll(".band-library-${list} .band-library-row") ?? [])].some((b) => b.querySelector(".band-library-name")?.textContent.trim() === ${js(title)})`, `the ${title} row`, 15000);
    await site.evaluate(`[...${page(bandId)}.querySelectorAll(".band-library-${list} .band-library-row")].find((b) => b.querySelector(".band-library-name")?.textContent.trim() === ${js(title)}).click()`);
    await settle();
  };
  const buttonsIn = (scope: string) => site.evaluate<string[]>(`[...(${scope}?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim())`);
  const phoneDb = <T>(work: string) =>
    site.evaluate<T>(`(async () => {
      if (!(await indexedDB.databases()).some((db) => db.name === "mls-phone")) return [];
      const db = await new Promise((done, fail) => { const r = indexedDB.open("mls-phone"); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
      const all = (store, keys) => new Promise((done, fail) => { const os = db.transaction(store).objectStore(store); const r = keys ? os.getAllKeys() : os.getAll(); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
      try { return await (${work})(all); } finally { db.close(); }
    })()`);
  const bandSongKeys = (bandId: string) => phoneDb<string[]>(`async (all) => (await all("bandSongs", true)).filter((key) => key.startsWith(${js(`${bandId}/`)}))`);
  const packsOf = (bandId: string) => phoneDb<string[]>(`async (all) => (await all("gigPacks")).filter((pack) => pack.gig.bandId === ${js(bandId)}).map((pack) => pack.gig.gigId)`);
  const notice = (words: string) => app.until(`(document.querySelector(".bands-notice")?.textContent ?? "").includes(${js(words)})`, `the words ${words}`, 15000);

  const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
  const lowTides = await band(terry, "The Low Tides", [mike]);
  const shareInto = async (who: { call: Player["call"] } | null, bandId: string, songs: SongContent[], setlist: string) => {
    const call = (path: string, body: object) => (who ? who.call(path, body) : appCalls(path, body));
    const songIds: string[] = [];
    for (const song of songs) {
      const shared = await call("/api/bands/library/share-song", { bandId, song, choice: "public", localId: null });
      assert.equal(shared.status, 200, `${song.title} is shared (${js(shared.body)})`);
      songIds.push(shared.body.songId);
    }
    const set = await call("/api/bands/library/share-setlist", { bandId, name: setlist, songIds, tags: [], choice: "public", localId: null });
    assert.equal(set.status, 200, `${setlist} is shared (${js(set.body)})`);
    return { songIds, setlistId: set.body.setlistId as string };
  };
  const friday = await shareInto(terry, lowTides.bandId, SET_SONGS, "Friday set");

  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await site.evaluate("Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((done) => setTimeout(done, 20000, false))])");
  if (!(await site.evaluate<boolean>("!!navigator.serviceWorker.controller"))) await site.send("Page.reload");
  await app.until("!!navigator.serviceWorker?.controller", "the service worker to take control of the page", 60000);
  await app.library();

  await check("signed out, the Bands tab shows Sign in and nothing is trapped", async () => {
    for (const hash of ["#/bands", `#/band/${lowTides.bandId}`]) {
      await site.evaluate(`location.hash = ${js(hash)}`);
      await app.until(`(document.querySelector(".bands-tab")?.textContent ?? "").includes("Sign in to see your bands.")`, `the sign-in words on ${hash}`);
      await app.click("Sign in", `document.querySelector(".bands-tab")`);
      await app.until(`document.querySelector(".account-sheet")?.dataset.step === "start"`, "the sign-in sheet");
      await app.click("✕");
      await app.until(`!document.querySelector(".account-sheet")`, "the sign-in sheet closing");
      assert.equal(await site.evaluate<boolean>(`!!document.querySelector("[role=dialog]")`), false, `nothing holds the screen after closing sign-in on ${hash}`);
    }
    await site.evaluate(`location.hash = "#/songs"`);
    await app.until(`!!document.querySelector(".song-list")`, "My Songs after leaving the band link");
  });

  await app.signUp("Sam Rivera");
  const sam = await site.evaluate<{ userId: string; handle: string }>(`fetch("/api/me").then((r) => r.json()).then((reply) => reply.account)`);
  assert.equal((await appCalls("/api/bands/join", { code: lowTides.code })).status, 200, "Sam joins The Low Tides");
  const trio = (await appCalls("/api/bands/create", { name: "Sam's Trio" })).body.bandId as string;
  const trioSet = await shareInto(null, trio, [chart("Trio Tune", "Sam Rivera", "Three of us tonight")], "Trio set");

  await check("the band page opens at `#/band/:id` with sections in the order Songs, Setlists, Chat, Gigs, Members", async () => {
    await openBand(lowTides.bandId, "The Low Tides");
    assert.match(await site.evaluate<string>("location.hash"), new RegExp(`^#/band/${lowTides.bandId}(\\?|$)`), "the hash names the band");
    assert.equal(await site.evaluate<boolean>(`!!${page(lowTides.bandId)}.closest("[role=dialog]") || !!document.querySelector("[role=dialog]")`), false, "the band page is a screen, not a sheet");
    assert.equal(await app.text(".band-page h2"), "The Low Tides", "titled with the band's name");
    assert.deepEqual((await tabs(lowTides.bandId)).map((tab) => tab.text), SECTIONS, "the sections in order");
    assert.ok(await site.evaluate<boolean>(`!!${page(lowTides.bandId)}.querySelector(".band-status-slot")`), "with the slot for the status strip");
    await site.evaluate(`window.__beforeReload = true; location.reload()`);
    await app.until(`!window.__beforeReload`, "the reload");
    await onPage(lowTides.bandId);
    assert.deepEqual((await tabs(lowTides.bandId)).map((tab) => tab.text), SECTIONS, "a reload on the band's hash opens the same page");
    await app.shot(shots && `${shots}/band-page.png`);
  });

  await check("no planned gig shows No gig planned and Plan gig for the admin only", async () => {
    await openBand(lowTides.bandId, "The Low Tides");
    await app.until(`(${page(lowTides.bandId)}.querySelector(".next-gig")?.textContent ?? "").includes("No gig planned.")`, "No gig planned for the member");
    assert.ok(!(await buttonsIn(`${page(lowTides.bandId)}.querySelector(".next-gig")`)).includes("Plan gig"), "a member has no Plan gig");
    await openBand(trio, "Sam's Trio");
    await app.until(`(${page(trio)}.querySelector(".next-gig")?.textContent ?? "").includes("No gig planned.")`, "No gig planned for the admin");
    assert.ok((await buttonsIn(`${page(trio)}.querySelector(".next-gig")`)).includes("Plan gig"), "the admin has Plan gig");
    await app.click("Plan gig", `${page(trio)}.querySelector(".next-gig")`);
    await app.until(`${page(trio)}.querySelector(".band-tabs [aria-selected=true]")?.firstChild?.textContent.trim() === "Setlists"`, "Plan gig leading to the band's setlists");
  });

  await check("Band songs stay here shows and Add songs opens the My Songs picker", async () => {
    await openBand(lowTides.bandId, "The Low Tides");
    await section(lowTides.bandId, "Songs");
    await app.until(`${page(lowTides.bandId)}.textContent.includes("Band songs stay here.")`, "the Band songs stay here line");
    await app.click("+ Add songs", page(lowTides.bandId));
    await app.until(`!!${page(lowTides.bandId)}.querySelector(".band-library-pick")`, "the picker");
    const picks = await site.evaluate<string[]>(`[...${page(lowTides.bandId)}.querySelectorAll(".band-library-pick-row")].map((b) => b.firstChild.textContent.trim())`);
    assert.ok(picks.includes(seed.songs[0].title) && picks.length >= seed.songs.length, `the picker lists My Songs (${js(picks.slice(0, 3))}…)`);
    await app.click("Cancel", page(lowTides.bandId));
  });

  await check("a band song has no Add to My Songs, opens locked with no Save or Send, and a direct copy-song is 403 band-only", async () => {
    await openBand(lowTides.bandId, "The Low Tides");
    await section(lowTides.bandId, "Songs");
    await app.until(`${page(lowTides.bandId)}.querySelectorAll(".band-library-songs li").length === 3`, "the three band songs");
    assert.ok(!(await buttonsIn(page(lowTides.bandId))).includes("Add to My Songs"), "no Add to My Songs on the band page");
    const before = await site.evaluate<number>(`JSON.parse(localStorage.getItem("leadSheetsLibrary") ?? '{"songs":[]}').songs.length`);
    await tapRow(lowTides.bandId, "songs", "Harbor Lights");
    await app.until(`location.hash === ${js(`#/band/${lowTides.bandId}/song/${friday.songIds[1]}`)}`, "the band song's hash");
    await app.until(`document.querySelector(".sheet .sheet-name")?.textContent === "Harbor Lights"`, "the band song's chart");
    assert.ok(await site.evaluate<boolean>(`!!document.querySelector(".song-lock[aria-label=Locked]")`), "the song is locked");
    const all = await buttonsIn("document");
    assert.ok(!all.includes("Save") && !all.includes("Save as"), `no Save (${js(all)})`);
    assert.equal(await site.evaluate<boolean>(`!!document.querySelector("[aria-label=Send]")`), false, "no Send button");
    await site.evaluate(`document.querySelector(".shell-header [aria-label=More]")?.click()`);
    await settle();
    const menu = await site.evaluate<string[]>(`[...document.querySelectorAll("[role=menu] [role=menuitem], [role=menu] button")].map((b) => b.textContent.trim())`);
    assert.ok(!menu.some((item) => /^Send/.test(item)), `no Send in More (${js(menu)})`);
    await site.evaluate(`document.querySelector(".shell-header [aria-label=More]")?.click()`);
    const after = await site.evaluate<number>(`JSON.parse(localStorage.getItem("leadSheetsLibrary") ?? '{"songs":[]}').songs.length`);
    assert.equal(after, before, "nothing went into My Songs");
    assert.deepEqual(refusal(await appCalls("/api/bands/library/copy-song", { bandId: lowTides.bandId, songId: friday.songIds[0] })), [403, "band-only"], "a direct copy-song is refused band-only");
    assert.deepEqual(refusal(await terry.call("/api/bands/library/copy-song", { bandId: lowTides.bandId, songId: friday.songIds[0] })), [403, "band-only"], "even for the band's admin");
  });

  await check("a member who is not admin sees Invite but not Reset link", async () => {
    await openBand(lowTides.bandId, "The Low Tides");
    assert.ok((await buttonsIn(`${page(lowTides.bandId)}.querySelector("header")`)).includes("Invite"), "a member sees Invite in the header");
    assert.ok(!(await buttonsIn(page(lowTides.bandId))).includes("Reset link"), "and no Reset link on the page");
    await app.click("Show as QR", page(lowTides.bandId));
    await settle(1000);
    assert.ok(!(await buttonsIn("document")).includes("Reset link"), "nor in Show as QR");
    await app.click("Back", page(lowTides.bandId));
    await onPage(lowTides.bandId);
  });

  const inviteButton = (bandId: string) => `[...${page(bandId)}.querySelectorAll("header button")].find((b) => b.textContent.trim() === "Invite")`;
  await check("Invite opens the share sheet with the band's join link in the same tap", async () => {
    await openBand(trio, "Sam's Trio");
    await settle(1500);
    const calls = await site.evaluate<{ title: string; url: string }[]>(`(() => {
      window.__shared = [];
      Object.defineProperty(navigator, "share", { configurable: true, value: (data) => { window.__shared.push(data); return Promise.resolve(); } });
      ${inviteButton(trio)}.click();
      return window.__shared.map((data) => ({ title: data.title, url: data.url }));
    })()`);
    assert.equal(calls.length, 1, `navigator.share ran inside the tap, before any await (${js(calls)})`);
    assert.equal(calls[0].title, "Join Sam's Trio", "titled with the band");
    assert.ok(calls[0].url.startsWith(`${origin}/c/`), `a /c/ link (${calls[0].url})`);
    assert.equal(readPayload(calls[0].url.slice(`${origin}/c/`.length))?.kind, "band", "of kind band");
  });

  await check("without navigator.share the link is copied and Link copied shows", async () => {
    await openBand(trio, "Sam's Trio");
    await settle(1500);
    await site.evaluate(`(() => {
      window.__copied = null;
      Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text) => { window.__copied = text; return Promise.resolve(); } } });
      ${inviteButton(trio)}.click();
    })()`);
    await app.until(`${page(trio)}.textContent.includes("Link copied")`, "Link copied");
    const copied = await site.evaluate<string>("window.__copied");
    assert.ok(copied?.startsWith(`${origin}/c/`) && readPayload(copied.slice(`${origin}/c/`.length))?.kind === "band", `the band's join link was copied (${copied})`);
  });

  await check("Show as QR renders the QR for the same link", async () => {
    const copied = await site.evaluate<string>("window.__copied");
    await app.click("Show as QR", page(trio));
    await onPage(trio, "invite");
    await app.until(`!!document.querySelector(".codes-qr svg")`, "the QR code");
    assert.equal(readQr(await site.evaluate<string>(`document.querySelector(".codes-qr").innerHTML`)), copied, "the QR is the link Invite shared");
    assert.ok((await buttonsIn(page(trio))).includes("Reset link"), "the admin has Reset link here");
    await app.click("Back", page(trio));
    await onPage(trio);
  });

  await check("the Chat section shows the band thread, sends a message, and the Messages sheet's band row lands on it", async () => {
    await openBand(lowTides.bandId, "The Low Tides");
    await section(lowTides.bandId, "Chat");
    await app.until(`!!${page(lowTides.bandId)}.querySelector(".chat-messages") && !!${page(lowTides.bandId)}.querySelector(".chat-composer")`, "the inline thread");
    await app.type("Message", "Hello band");
    await app.click("Send", page(lowTides.bandId));
    await app.until(`[...${page(lowTides.bandId)}.querySelectorAll(".chat-bubble")].some((b) => b.textContent.includes("Hello band"))`, "Sam's bubble");
    await eventually(async () => ((await terry.call("/api/chat/open", { roomId: lowTides.bandId })).body.messages as ChatMessage[]).map((m) => m.text), (texts) => texts.includes("Hello band"), "Terry reads Sam's message");
    await terry.call("/api/chat/send", { roomId: lowTides.bandId, msgId: newId(), text: "Welcome Sam" });
    await app.until(`[...${page(lowTides.bandId)}.querySelectorAll(".chat-bubble")].some((b) => b.textContent.includes("Welcome Sam"))`, "Terry's message arriving live");
    await site.evaluate(`location.hash = "#/songs"`);
    await app.openMenu();
    await app.pick("Messages");
    await app.until(`location.hash === "#/messages" && document.querySelectorAll(".messages .chat-row").length > 0`, "the Messages list");
    await site.evaluate(`[...document.querySelectorAll(".messages .chat-row")].find((b) => b.querySelector(".chat-row-title")?.textContent === "The Low Tides").click()`);
    await app.until(`location.hash === ${js(`#/messages/${lowTides.bandId}`)}`, "the band row landing on the band's room");
    const bandRoom = `document.querySelector(${js(`.room[data-room="${lowTides.bandId}"]`)})`;
    await app.until(`!document.querySelector("[role=dialog]") && !!${bandRoom}?.querySelector(".chat-messages")`, "the band's room, no sheet");
    await app.until(`[...${bandRoom}.querySelectorAll(".chat-bubble")].some((b) => b.textContent.includes("Hello band")) && [...${bandRoom}.querySelectorAll(".chat-bubble")].some((b) => b.textContent.includes("Welcome Sam"))`, "the band's messages on it");
  });

  await check("an unread band message badges the Chat tab", async () => {
    await site.evaluate(`location.hash = "#/songs"`);
    await settle(500);
    await terry.call("/api/chat/send", { roomId: lowTides.bandId, msgId: newId(), text: "Soundcheck at six" });
    await site.evaluate(`location.hash = ${js(`#/band/${lowTides.bandId}?s=songs`)}`);
    await onPage(lowTides.bandId);
    await app.until(`[...${page(lowTides.bandId)}.querySelectorAll(".band-tabs [role=tab]")].find((t) => t.firstChild?.textContent.trim() === "Chat")?.querySelector(".chat-badge")?.textContent === "1"`, "a 1 on the Chat tab");
    await section(lowTides.bandId, "Chat");
    await app.until(`!${page(lowTides.bandId)}.querySelector(".band-tabs .chat-badge")`, "the badge clearing once read");
  });

  await check("the last section is kept in the hash and restored by back", async () => {
    await openBand(lowTides.bandId, "The Low Tides");
    await section(lowTides.bandId, "Gigs");
    assert.equal(await site.evaluate<string>("location.hash"), `#/band/${lowTides.bandId}?s=gigs`, "the hash keeps the section");
    await site.evaluate(`location.hash = "#/songs"`);
    await app.until(`!!document.querySelector(".song-list")`, "My Songs");
    await site.evaluate(`history.back()`);
    await onPage(lowTides.bandId);
    assert.deepEqual((await tabs(lowTides.bandId)).filter((tab) => tab.selected).map((tab) => tab.text), ["Gigs"], "back returns to Gigs");
    await site.evaluate(`location.hash = "#/songs"`);
    await settle();
    await site.evaluate(`location.hash = ${js(`#/band/${lowTides.bandId}`)}`);
    await onPage(lowTides.bandId);
    assert.deepEqual((await tabs(lowTides.bandId)).filter((tab) => tab.selected).map((tab) => tab.text), ["Gigs"], "the band remembers Gigs when opened again with no section");
  });

  const later = gigId();
  const sooner = gigId();
  await check("the next planned gig shows on top with its pack count, Start gig for the leader and Open gig for a member, nothing for a non-lineup member", async () => {
    const planned = await terry.call("/api/bands/gig/plan", { bandId: lowTides.bandId, setlistId: friday.setlistId, gigId: later, name: "Saturday at the Pier", date: dayFromNow(6), lineup: [terry.userId, mike.userId], leader: terry.userId });
    assert.equal(planned.status, 200, `Terry plans a gig without Sam (${js(planned.body)})`);
    await openBand(lowTides.bandId, "The Low Tides");
    const card = `${page(lowTides.bandId)}.querySelector(".next-gig")`;
    await app.until(`${card}?.dataset.nextGig === ${js(later)}`, "the gig on top");
    assert.match(await site.evaluate<string>(`${card}.textContent`), /Saturday at the Pier/, "named");
    assert.match(await site.evaluate<string>(`${card}.textContent`), /3 songs · You're not playing this one\./, "a non-lineup member sees the song count and that they're not playing");
    const notPlaying = await buttonsIn(card);
    assert.ok(!notPlaying.includes("Start gig") && !notPlaying.includes("Open gig"), `nothing to open for a non-lineup member (${js(notPlaying)})`);

    const soon = await terry.call("/api/bands/gig/plan", { bandId: lowTides.bandId, setlistId: friday.setlistId, gigId: sooner, name: "Friday at the Elks", date: dayFromNow(2), lineup: [terry.userId, sam.userId], leader: terry.userId });
    assert.equal(soon.status, 200, `Terry plans a sooner gig with Sam (${js(soon.body)})`);
    await openBand(lowTides.bandId, "The Low Tides");
    await app.until(`${card}?.dataset.nextGig === ${js(sooner)}`, "the sooner gig on top");
    await app.until(`/3 songs · Pack 3 of 3 downloaded/.test(${card}.textContent)`, "the pack count once this phone holds the pack", 15000);
    const member = await buttonsIn(card);
    assert.ok(member.includes("Open gig") && !member.includes("Start gig"), `a lineup member gets Open gig (${js(member)})`);
    await app.click("Open gig", card);
    await app.until(`location.hash === ${js(`#/band/${lowTides.bandId}?s=gigs`)} && !!${page(lowTides.bandId)}.querySelector(${js(`.gig-card[data-gig="${sooner}"]`)})`, "Open gig landing on its card in Gigs");

    const trioGig = await appCalls("/api/bands/gig/plan", { bandId: trio, setlistId: trioSet.setlistId, gigId: gigId(), name: "Trio night", date: dayFromNow(3), lineup: [sam.userId], leader: sam.userId });
    assert.equal(trioGig.status, 200, `Sam plans a gig he leads (${js(trioGig.body)})`);
    await openBand(trio, "Sam's Trio");
    await app.until(`(${page(trio)}.querySelector(".next-gig")?.textContent ?? "").includes("Trio night")`, "Sam's gig on top");
    assert.ok((await buttonsIn(`${page(trio)}.querySelector(".next-gig")`)).includes("Start gig"), "the leader gets Start gig");
  });

  await check("a band setlist opens the read-only view with Show code, Live, Downloaded marks, and Edit only for admin or sharer", async () => {
    await openBand(lowTides.bandId, "The Low Tides");
    await section(lowTides.bandId, "Setlists");
    await tapRow(lowTides.bandId, "setlists", "Friday set");
    await onPage(lowTides.bandId, "setlist");
    const view = `${page(lowTides.bandId)}.querySelector(".band-setlist-view")`;
    const text = await site.evaluate<string>(`${view}.textContent`);
    assert.match(text, /The Low Tides · 3 songs · from Terry Bass/, "says the band, the count and who shared it");
    assert.match(text, /Band songs stay in The Low Tides\. They don't go into My Songs\./, "with the lock line");
    assert.deepEqual(await site.evaluate<string[]>(`[...${view}.querySelectorAll("ol li .band-library-name")].map((n) => n.textContent.trim())`), TITLES, "numbered songs in order");
    await app.until(`[...${view}.querySelectorAll("ol li")].every((li) => li.textContent.includes("Downloaded ✓"))`, "Downloaded ✓ on each song in this phone's pack");
    const buttons = await buttonsIn(view);
    assert.ok(buttons.includes("Show code") && buttons.includes("Live"), `Show code and Live (${js(buttons)})`);
    assert.ok(!buttons.includes("Edit") && !buttons.includes("Plan a gig"), "no Edit or Plan a gig for a member who didn't share it");
    await app.click("Back", view);
    await onPage(lowTides.bandId);

    const samsSet = await shareInto(null, lowTides.bandId, [], "Sam's set");
    assert.ok(samsSet.setlistId, "Sam shares an empty setlist of his own");
    await openBand(lowTides.bandId, "The Low Tides");
    await section(lowTides.bandId, "Setlists");
    await tapRow(lowTides.bandId, "setlists", "Sam's set");
    await onPage(lowTides.bandId, "setlist");
    assert.ok((await buttonsIn(view)).includes("Edit"), "the sharer gets Edit");
    await openBand(trio, "Sam's Trio");
    await section(trio, "Setlists");
    await tapRow(trio, "setlists", "Trio set");
    await onPage(trio, "setlist");
    const admin = await buttonsIn(`${page(trio)}.querySelector(".band-setlist-view")`);
    assert.ok(admin.includes("Edit") && admin.includes("Plan a gig"), `the admin gets Edit and Plan a gig (${js(admin)})`);
  });

  await check("Live on a band setlist opens the first band song with no server call", async () => {
    await openBand(lowTides.bandId, "The Low Tides");
    await section(lowTides.bandId, "Setlists");
    await tapRow(lowTides.bandId, "setlists", "Friday set");
    await onPage(lowTides.bandId, "setlist");
    await settle(1000);
    await offline(true);
    try {
      const calls = await site.evaluate<number>("window.__api");
      await app.click("Live", `${page(lowTides.bandId)}.querySelector(".band-setlist-view")`);
      await app.until(`location.hash === ${js(`#/live/band/${lowTides.bandId}/${friday.setlistId}/0`)}`, "the band Live hash");
      await app.until(`document.querySelector(".sheet .sheet-name")?.textContent === ${js(TITLES[0])}`, "the first band song");
      assert.equal(await app.text(".live-nav .live-count"), "Friday set · 1/3", "the live bar counts the band setlist");
      await app.click("Next");
      await app.until(`document.querySelector(".sheet .sheet-name")?.textContent === ${js(TITLES[1])}`, "Next to the second song");
      assert.equal(await site.evaluate<number>("window.__api"), calls, "no server call");
    } finally {
      await offline(false);
    }
  });

  await check("a DM'd song in My Songs can be added to a setlist and shared into the band", async () => {
    assert.equal((await terry.call("/api/friends/request", { handle: sam.handle })).status, 200, "Terry asks Sam to be friends");
    assert.equal((await appCalls("/api/friends/accept", { userId: terry.userId })).status, 200, "Sam accepts");
    for (const [song, choice] of [
      [chart("Porch Light", "Terry Bass", "Leave the porch light on"), "public"],
      [chart("Back Steps", "Terry Bass", "Sitting on the back steps"), "private"],
    ] as const) {
      const sent = await terry.call("/api/chat/send-song", { userId: sam.userId, msgId: newId(), shareId: newId(), song, versions: [], data: null, choice });
      assert.equal(sent.status, 200, `Terry sends Sam ${song.title} as ${choice} (${js(sent.body)})`);
    }
    await site.evaluate(`location.hash = "#/songs"`);
    await app.openMenu();
    await app.pick("Messages");
    await app.until(`location.hash === "#/messages" && [...document.querySelectorAll(".messages .chat-row-title")].some((t) => t.textContent === "Terry Bass")`, "Terry's DM on the list", 15000);
    await site.evaluate(`[...document.querySelectorAll(".messages .chat-row")].find((b) => b.querySelector(".chat-row-title")?.textContent === "Terry Bass").click()`);
    for (const title of ["Porch Light", "Back Steps"]) {
      const card = `[...document.querySelectorAll(".room li")].find((li) => li.textContent.includes(${js(title)}))`;
      await app.until(`!!${card} && [...${card}.querySelectorAll("button")].some((b) => b.textContent.trim() === "Add to My Songs")`, `${title}'s card`, 15000);
      await app.click("Add to My Songs", card);
      await app.until(`JSON.parse(localStorage.getItem("leadSheetsLibrary")).songs.some((s) => s.title === ${js(title)})`, `${title} in My Songs`);
    }
    await site.evaluate(`location.hash = "#/songs"`);
    await site.evaluate(`(() => {
      const library = JSON.parse(localStorage.getItem("leadSheetsLibrary"));
      const id = (title) => library.songs.find((s) => s.title === title).id;
      library.setlists.push({ id: 901, name: "Porch set", songIds: [id("Porch Light")] }, { id: 902, name: "Steps set", songIds: [id("Back Steps")] });
      localStorage.setItem("leadSheetsLibrary", JSON.stringify(library));
    })()`);
    await openBand(lowTides.bandId, "The Low Tides");
    await section(lowTides.bandId, "Setlists");
    await app.click("+ Share a setlist", page(lowTides.bandId));
    const pickRow = (name: string) => `[...${page(lowTides.bandId)}.querySelectorAll(".band-library-pick-row")].find((b) => b.firstChild.textContent.trim() === ${js(name)})`;
    await app.until(`!!${pickRow("Porch set")}`, "Porch set in the picker");
    assert.equal(await site.evaluate<boolean>(`${pickRow("Steps set")}.disabled`), true, "a setlist holding a Private DM'd song can't be picked");
    assert.match(await site.evaluate<string>(`${pickRow("Steps set")}.textContent`), /Has a song shared with you privately/, "and says why");
    await site.evaluate(`${pickRow("Porch set")}.click()`);
    await settle();
    await app.click("Public", page(lowTides.bandId));
    await app.click("Share", page(lowTides.bandId));
    const shared = await eventually(
      async () => (await terry.call("/api/bands/library", { bandId: lowTides.bandId })).body as BandLibrary,
      (library) => library.setlists.some((set) => set.name === "Porch set"),
      "Porch set reaching the band",
    );
    const set = shared.setlists.find((item) => item.name === "Porch set")!;
    const song = shared.songs.find((item) => item.songId === set.songIds[0])!;
    assert.deepEqual([song.song.title, song.sharedByName, set.sharedByName], ["Porch Light", "Sam Rivera", "Sam Rivera"], "the band holds Porch Light in Sam's setlist, shared by Sam");
  });

  await check("Leave band removes the band's songs and packs from this phone", async () => {
    const leaveMe = await band(terry, "Leave Me", []);
    assert.equal((await appCalls("/api/bands/join", { code: leaveMe.code })).status, 200, "Sam joins Leave Me");
    const set = await shareInto(terry, leaveMe.bandId, [chart("Exit Song", "Terry Bass", "Out the door")], "Exit set");
    assert.equal((await terry.call("/api/bands/gig/plan", { bandId: leaveMe.bandId, setlistId: set.setlistId, gigId: gigId(), name: "Last show", date: dayFromNow(4), lineup: [terry.userId, sam.userId], leader: terry.userId })).status, 200, "Terry plans a gig with Sam");
    await openBand(leaveMe.bandId, "Leave Me");
    await section(leaveMe.bandId, "Songs");
    await eventually(() => bandSongKeys(leaveMe.bandId), (keys) => keys.length === 1, "the band's song on this phone");
    await eventually(() => packsOf(leaveMe.bandId), (packs) => packs.length === 1, "the gig's pack on this phone", 15000);
    await section(leaveMe.bandId, "Members");
    await app.click("Leave band", page(leaveMe.bandId));
    await app.click("Yes, leave Leave Me", page(leaveMe.bandId));
    await app.until(`location.hash === "#/bands"`, "Bands after leaving");
    await notice("You left Leave Me.");
    assert.deepEqual(await bandSongKeys(leaveMe.bandId), [], "no song of the band is left on this phone");
    assert.deepEqual(await packsOf(leaveMe.bandId), [], "and no pack");
    assert.ok((await bandSongKeys(lowTides.bandId)).length > 0, "another band's songs stay");
  });

  await check("a removed member gets the not-a-member word and lands on Bands", async () => {
    const gone = await band(terry, "Gone Band", []);
    assert.equal((await appCalls("/api/bands/join", { code: gone.code })).status, 200, "Sam joins Gone Band");
    await shareInto(terry, gone.bandId, [chart("Gone Song", "Terry Bass", "Gone by morning")], "Gone set");
    await openBand(gone.bandId, "Gone Band");
    await section(gone.bandId, "Songs");
    await eventually(() => bandSongKeys(gone.bandId), (keys) => keys.length === 1, "the band's song on this phone");
    await site.evaluate(`location.hash = "#/songs"`);
    assert.equal((await terry.call("/api/bands/remove", { bandId: gone.bandId, userId: sam.userId })).status, 200, "Terry removes Sam");
    await site.evaluate(`location.hash = ${js(`#/band/${gone.bandId}?s=songs`)}`);
    await app.until(`location.hash === "#/bands"`, "Bands after the refusal", 15000);
    await notice("You're not in this band any more.");
    assert.deepEqual(await bandSongKeys(gone.bandId), [], "the band's songs leave the phone");
  });

  await check("offline, the band page shows cached band songs and Can't reach the server on live sections", async () => {
    await openBand(lowTides.bandId, "The Low Tides");
    await section(lowTides.bandId, "Songs");
    await eventually(() => bandSongKeys(lowTides.bandId), (keys) => keys.length >= 3, "the band's songs on this phone");
    await offline(true);
    try {
      await site.evaluate(`window.__beforeReload = true; location.reload()`);
      await app.until(`!window.__beforeReload && !!${page(lowTides.bandId)}`, "the band page with no signal", 15000);
      await app.until(`[...${page(lowTides.bandId)}.querySelectorAll(".band-library-songs .band-library-name")].length >= 3`, "the cached band songs", 15000);
      const shown = await site.evaluate<string[]>(`[...${page(lowTides.bandId)}.querySelectorAll(".band-library-songs .band-library-name")].map((n) => n.textContent.trim())`);
      assert.ok(TITLES.every((title) => shown.includes(title)), `the band's songs from this phone (${js(shown)})`);
      for (const name of ["Setlists", "Gigs", "Members"]) {
        await section(lowTides.bandId, name);
        await app.until(`${page(lowTides.bandId)}.textContent.includes("Can't reach the server")`, `Can't reach the server on ${name}`);
      }
    } finally {
      await offline(false);
    }
  });

  await check("every row and button is 48 px", async () => {
    await openBand(lowTides.bandId, "The Low Tides");
    const short: string[] = [];
    for (const name of SECTIONS) {
      await section(lowTides.bandId, name);
      await settle(1000);
      short.push(
        ...(await site.evaluate<string[]>(`[...${page(lowTides.bandId)}.querySelectorAll("button, .friends-list > li, .band-setlist-view li")]
          .filter((el) => el.getClientRects().length > 0)
          .filter((el) => el.getBoundingClientRect().height < 47.5)
          .map((el) => ${js(name)} + ": " + el.tagName + " " + el.textContent.trim().slice(0, 30) + " " + Math.round(el.getBoundingClientRect().height))`)),
      );
    }
    assert.deepEqual(short, [], "every visible row and button on the band page is at least 48 px tall");
  });

  await check("no page errors", async () => assert.deepEqual(await app.errors(), [], "the page logged no errors"));
} finally {
  await site.close();
  await worker.dispose();
}

if (failed > 0) {
  console.log(`check:ux-band-page: ${failed} failed`);
  process.exit(1);
}
console.log("check:ux-band-page passed");
