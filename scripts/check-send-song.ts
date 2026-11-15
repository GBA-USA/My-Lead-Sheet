import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SongContent } from "../src/band-library-model.ts";
import type { ChatEntry, ChatMessage } from "../src/chat-model.ts";
import type { ScrollVersion } from "../src/scroll-timing.ts";
import type { ShareChoice } from "../src/share-rule.ts";
import type { Song, SongData } from "../src/types.ts";
import { Phone, startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/**
 * C12b, Send a song to a friend (FABLE-PLAN C12b, PLAN.md 5 and 9.2). One case per pass condition, named by it. The
 * cases fix this contract, which the cook builds to:
 *
 * `POST /api/chat/send-song` with `{ userId, msgId, shareId, song, versions, data, choice, copyId?, updateOf? }`.
 * `userId` is the friend; the server finds or makes the one DM, as `/api/chat/dm` does. `msgId` and `shareId` are made
 * on the phone, so a retry stores one message. `versions` are the ticked timing versions only. `choice` is "private"
 * or "public"; anything else is `400 choice_required`. `copyId` names a copy the sender holds: for a song that arrived
 * in a DM, the `shareId` of that message; for a band song, `copy.id`. `updateOf` is the `shareId` of an earlier send
 * of the same song. Replies: `200 { roomId, message }` with `message.kind === "song"`, `message.ref === shareId` and
 * `message.text` the SongMessage JSON; `401 signed-out`; `403 not-friends`; `403 private_copy` or `private_ancestor`.
 *
 * On the phone: "Send to a friend…" is a menu item in one of the ••• menus on an own song's page. The sheet lists
 * friends as buttons, each timing version as a labelled tick, Private and Public, and Send, which stays off until
 * Private or Public is picked. A song card in the DM has "Add to My Songs"; an update card has "Keep mine",
 * "Take <sender>'s" and "Keep both". A copy added from a friend carries `copy.from.name` and, when Private, shows
 * the lock and no Send, Share or Show code.
 */

type SongMessage = { song: SongContent; versions: ScrollVersion[]; data: SongData | null; shareId: string; updateOf: string | null; sharedAs: ShareChoice; reshareable: boolean };
type StoredSong = Song & { copy?: { id: string; canSendOn: boolean; from?: { name: string } } };
type Reply = { status: number; body: Record<string, any> };

const root = new URL("..", import.meta.url).pathname;
/** Set SHOTS to a folder to save the send screens at phone size. */
const shots = process.env.SHOTS;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const js = (value: unknown) => JSON.stringify(value);

const seed = JSON.parse(readFileSync(`${root}data/library.json`, "utf8")) as { songs: (SongContent & { id: number })[] };
const content = ({ id: _id, ...song }: SongContent & { id: number }): SongContent => song;
const chart = (title: string, artist: string, lyric: string): SongContent => ({
  ...content(seed.songs[0]),
  title,
  artist,
  body: [{ heading: "Verse 1", lines: [{ chords: "G       C", lyrics: lyric }] }],
});
const lyricOf = (song: SongContent) => song.body[0]?.lines[0]?.lyrics ?? "";
const newId = () => crypto.randomUUID().replace(/-/g, "");
const refusal = (reply: Reply) => [reply.status, reply.body.error];

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

type Player = Awaited<ReturnType<typeof passwordPlayer>>;
type SendBody = { userId: string; msgId: string; shareId: string; song: SongContent; versions: ScrollVersion[]; data: SongData | null; choice: ShareChoice | null; copyId?: string | null; updateOf?: string | null };

const sendBody = (to: { userId: string }, song: SongContent, over: Partial<SendBody> = {}): SendBody => ({ userId: to.userId, msgId: newId(), shareId: newId(), song, versions: [], data: null, choice: "public", ...over });
const send = (from: Phone, to: { userId: string }, song: SongContent, over: Partial<SendBody> = {}) => from.call("/api/chat/send-song", sendBody(to, song, over));
const songMessages = async (who: Phone, roomId: string) => ((await who.call("/api/chat/open", { roomId })).body.messages ?? []).filter((m: ChatMessage) => m.kind === "song") as ChatMessage[];
const songIn = (message: ChatMessage) => JSON.parse(message.text) as SongMessage;
const dmOf = async (a: Phone, b: { userId: string }) => (await a.call("/api/chat/dm", { userId: b.userId })).body.roomId as string;
const dmTitles = async (who: Phone) => ((await who.call("/api/chat")).body.chats as ChatEntry[]).filter((c) => c.kind === "dm").map((c) => c.title);

/** Asserts a song send landed: 200, a song message whose ref is the share id, and the body as sent. */
function landed(reply: Reply, body: SendBody, what: string): SongMessage {
  assert.equal(reply.status, 200, `${what} (${js(reply.body)})`);
  const message = reply.body.message as ChatMessage;
  assert.deepEqual([message?.kind, message?.ref], ["song", body.shareId], `${what}: the stored message is a song card for this share`);
  const stored = songIn(message);
  assert.deepEqual([stored.shareId, stored.sharedAs, stored.song.title], [body.shareId, body.choice, body.song.title], `${what}: the card holds the share as sent`);
  return stored;
}

/** A phone nobody is signed in on, sending the app's Origin like a browser does. */
function signedOutPhone(base: string, origin: string): Phone {
  const phone = new Phone(base);
  const call = phone.call.bind(phone);
  phone.call = (path, body, headers = {}) => call(path, body, { origin, ...headers });
  return phone;
}

async function friends(a: Player, b: Player) {
  assert.equal((await a.call("/api/friends/request", { handle: b.handle })).status, 200, `${a.name} asks ${b.name}`);
  assert.equal((await b.call("/api/friends/accept", { userId: a.userId })).status, 200, `${b.name} accepts ${a.name}`);
}

const VERSION_A = { name: "Sam take 1 7F3A", bpm: 97.13, marks: [{ at: 0, progress: 0 }, { at: 123457, progress: 1 }] };
const VERSION_B = { name: "Sam take 2 9C1D", bpm: 101.5, marks: [{ at: 0, progress: 0 }, { at: 98765, progress: 1 }] };

let apiBase = "";
const site = await openSite(root, "check-send-song", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;
try {
  const app = await appPage(site);
  const appCalls = (path: string, body: object) =>
    site.evaluate<Reply>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const stored = () => site.evaluate<StoredSong[]>(`JSON.parse(localStorage.getItem("leadSheetsLibrary") ?? "{}").songs ?? []`);
  const dialogButtons = (scope = "document.querySelector('[role=dialog]')") => site.evaluate<{ text: string; disabled: boolean }[]>(`[...(${scope}?.querySelectorAll("button") ?? [])].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }))`);
  /** Taps the first enabled button whose text starts with `start`, anywhere or inside `scope`. */
  const tap = async (start: string, scope = "document") => {
    const tapped = await site.evaluate<boolean>(`(() => { const el = [...(${scope}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim().startsWith(${js(start)}) && !b.disabled); el?.click(); return !!el; })()`);
    assert.ok(tapped, `a button starting ${js(start)} to tap`);
    await settle();
  };
  const menuItems = () => app.texts("[role=menu] [role=menuitem]");
  /** The ••• menus on a song's page: the shell's More and the Song actions menu. Returns the items of each. */
  const songMenus = async () => {
    const found: Record<string, string[]> = {};
    for (const label of ["More", "Song actions"]) {
      const opened = await site.evaluate<boolean>(`(() => { const b = document.querySelector('[aria-label=${js(label)}]'); b?.click(); return !!b; })()`);
      if (!opened) continue;
      await app.until(`!!document.querySelector("[role=menu]")`, `the ${label} menu`);
      found[label] = await menuItems();
      await app.closeMenu();
    }
    return found;
  };
  const openSendToFriend = async () => {
    for (const label of ["More", "Song actions"]) {
      await site.evaluate(`document.querySelector('[aria-label=${js(label)}]')?.click()`);
      await app.until(`!!document.querySelector("[role=menu]")`, `the ${label} menu`);
      const hit = await site.evaluate<boolean>(`(() => { const el = [...document.querySelectorAll("[role=menu] [role=menuitem]")].find((b) => /^Send to a friend(…|\\.\\.\\.)$/.test(b.textContent.trim()) && !b.disabled); el?.click(); return !!el; })()`);
      if (hit) {
        await app.until(`!!document.querySelector("[role=dialog]")`, "the Send to a friend sheet");
        return;
      }
      await app.closeMenu();
    }
    throw new Error("neither ••• menu on the song page has a Send to a friend… entry");
  };
  const openSong = async (id: number) => {
    await site.evaluate(`location.hash = ${js(`#/song/${id}`)}`);
    await app.until(`!!document.querySelector(".sheet .sheet-name")`, `song ${id} on screen`);
  };
  const reset = async () => {
    await site.evaluate(`location.hash = "#/songs"`);
    await site.evaluate("location.reload()");
    await app.library();
  };
  const openDm = async (title: string) => {
    await app.openMenu();
    await app.pick("Messages");
    await app.until(`document.querySelector(".chat-sheet")?.dataset.view === "list" && !document.querySelector(".chat-sheet").textContent.includes("Loading")`, "the Messages list", 15000);
    const found = await site.evaluate<boolean>(`(() => { const row = [...document.querySelectorAll(".chat-row")].find((b) => b.querySelector(".chat-row-title")?.textContent === ${js(title)}); row?.click(); return !!row; })()`);
    assert.ok(found, `a ${title} row on the Messages list`);
    await app.until(`document.querySelector(".chat-sheet")?.dataset.view === "thread"`, `the ${title} thread`);
  };
  const me = () => site.evaluate<{ account?: { userId: string; handle: string } }>(`fetch("/api/me").then((r) => r.json())`).then((reply) => reply.account);

  const terry = await passwordPlayer(base, origin, "Terry", "terry");
  const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
  const ann = await passwordPlayer(base, origin, "Ann Horn", "annhorn");
  const dana = await passwordPlayer(base, origin, "Dana Drums", "danadrums");
  const eve = await passwordPlayer(base, origin, "Eve Spam", "evespam");
  await friends(terry, mike);
  await friends(terry, ann);
  await friends(mike, ann);
  await friends(ann, dana);
  assert.equal((await dana.call("/api/friends/request", { handle: terry.handle })).status, 200, "Dana asks Terry, who never answers");

  await site.send("Network.enable");
  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await site.evaluate("Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((done) => setTimeout(done, 20000, false))])");
  if (!(await site.evaluate<boolean>("!!navigator.serviceWorker.controller"))) await site.send("Page.reload");
  await app.until("!!navigator.serviceWorker?.controller", "the service worker to take control of the page", 60000);
  await app.library();
  const firstId = Number(await site.evaluate<string>(`document.querySelector('a[href^="#/song/"]').getAttribute("href").match(/\\d+/)[0]`));
  const first = seed.songs.find((song) => song.id === firstId)!;
  const other = seed.songs.find((song) => song.id !== firstId)!;
  await site.evaluate(`localStorage.setItem(${js(`leadSheetsScrollVersions.${firstId}`)}, ${js(js({ versions: [VERSION_A, VERSION_B], selected: 0 }))})`);
  await reset();
  await app.signUp("Sam Rivera");
  const sam = await me();
  assert.ok(sam, "Sam is signed in on the phone");
  for (const friend of [terry, mike]) {
    assert.equal((await friend.call("/api/friends/request", { handle: sam.handle })).status, 200, `${friend.name} asks Sam`);
    assert.equal((await appCalls("/api/friends/accept", { userId: friend.userId })).status, 200, `Sam accepts ${friend.name}`);
  }

  await check("the send can't finish until Private or Public is picked", async () => {
    await openSong(firstId);
    await openSendToFriend();
    await tap("Mike Keys", "document.querySelector('[role=dialog]')");
    const before = (await dialogButtons()).find((b) => b.text === "Send");
    assert.ok(before, "a Send button on the sheet");
    assert.equal(before!.disabled, true, "Send is off with no Private or Public picked");
    await tap("Public", "document.querySelector('[role=dialog]')");
    assert.equal((await dialogButtons()).find((b) => b.text === "Send")!.disabled, false, "and on once Public is picked");
    await app.shot(shots && `${shots}/send-song-sheet.png`);
    for (const choice of [null, "friends", undefined]) {
      assert.deepEqual(refusal(await send(terry, mike, chart("Chain Breaker", "Terry", "Break every chain tonight"), { choice: choice as ShareChoice | null })), [400, "choice_required"], `a direct send with choice ${js(choice)} is refused`);
    }
    assert.deepEqual(await songMessages(mike, await dmOf(terry, mike)), [], "and no song message was stored");
  });

  await check("only ticked versions arrive, and unticked versions and other songs never appear in the message", async () => {
    await reset();
    await openSong(firstId);
    await openSendToFriend();
    await tap("Mike Keys", "document.querySelector('[role=dialog]')");
    const ticked = await site.evaluate<boolean>(`(() => { const l = [...document.querySelectorAll("[role=dialog] label")].find((l) => l.textContent.includes(${js(VERSION_A.name)})); l?.click(); return !!l; })()`);
    assert.ok(ticked, `a tick for the timing version ${VERSION_A.name}`);
    await settle();
    await tap("Public", "document.querySelector('[role=dialog]')");
    await tap("Send", "document.querySelector('[role=dialog]')");
    const roomId = await dmOf(mike, sam);
    const [message] = await eventually(() => songMessages(mike, roomId), (list) => list.length === 1, "Mike's phone sees one song message from Sam", 15000);
    const body = songIn(message);
    assert.equal(body.song.title, first.title, "the card carries the chart of the song Sam sent");
    assert.deepEqual(body.versions.map((v) => v.name), [VERSION_A.name], "with the ticked version only");
    const text = message.text;
    assert.ok(!text.includes(VERSION_B.name) && !text.includes("9C1D") && !text.includes(String(VERSION_B.marks[1].at)), "the unticked version is nowhere in the message");
    assert.ok(!text.includes(other.title), `another song (${other.title}) is nowhere in the message`);
    assert.deepEqual([message.fromName, body.sharedAs, body.reshareable], ["Sam Rivera", "public", true], "sent by Sam as Public, so Mike may pass it on");
  });

  const privateSong = chart("Back Porch Blues", "Terry", "Sitting on the back porch");
  await check("a Private copy has no Send, Share or Show code, and the server refuses a resend", async () => {
    const sent = sendBody(sam, privateSong, { choice: "private" });
    landed(await terry.call("/api/chat/send-song", sent), sent, "Terry sends Sam Back Porch Blues as Private");
    await reset();
    await openDm("Terry");
    await app.until(`[...document.querySelectorAll(".chat-sheet button")].some((b) => b.textContent.trim() === "Add to My Songs")`, "the song card with Add to My Songs", 15000);
    await app.shot(shots && `${shots}/send-song-card.png`);
    await tap("Add to My Songs", "document.querySelector('.chat-sheet')");
    const row = await eventually(() => stored().then((songs) => songs.find((song) => song.title === privateSong.title)), (song) => !!song, "the copy in My Songs");
    assert.deepEqual([row!.copy?.canSendOn, row!.copy?.from?.name], [false, "Terry"], "the copy is marked Private and from Terry");
    await reset();
    await openSong(row!.id);
    assert.ok(await site.evaluate<boolean>(`!!document.querySelector('[aria-label="Private"]')`), "Sam's sheet shows the lock");
    const menus = await songMenus();
    const offered = Object.values(menus).flat();
    assert.ok(offered.length > 0, "the song page has a ••• menu");
    assert.deepEqual(offered.filter((item) => /^(Send|Share|Show code)/.test(item)), [], `no Send, Share or Show code on a Private copy (menus: ${js(menus)})`);
    const resend = await appCalls("/api/chat/send-song", sendBody(mike, privateSong, { choice: "public", copyId: row!.copy!.id }));
    assert.deepEqual(refusal(resend), [403, "private_copy"], "and the server refuses Sam's direct resend of the copy");
    assert.ok(!(await songMessages(mike, await dmOf(mike, sam))).some((m) => songIn(m).song.title === privateSong.title), "so Mike never gets it");
  });

  const openRoad = chart("Open Road", "Terry", "Miles to go before the show");
  const openRoadEdited = chart("Open Road", "Terry", "Miles to go, then one more show");
  const firstSend = sendBody(sam, openRoad, { choice: "public" });
  await check("Add to My Songs makes a copy marked From Terry that stays after Terry edits the original", async () => {
    landed(await terry.call("/api/chat/send-song", firstSend), firstSend, "Terry sends Sam Open Road as Public");
    await reset();
    await openDm("Terry");
    await app.until(`[...document.querySelectorAll(".chat-sheet button")].filter((b) => b.textContent.trim() === "Add to My Songs").length >= 1`, "Open Road's card", 15000);
    const added = await site.evaluate<boolean>(`(() => { const b = [...document.querySelectorAll(".chat-sheet button")].find((b) => b.textContent.trim() === "Add to My Songs" && b.closest("li")?.textContent.includes("Open Road")); b?.click(); return !!b; })()`);
    assert.ok(added, "Add to My Songs on Open Road's card (the card sits in its message's li)");
    const row = await eventually(() => stored().then((songs) => songs.find((song) => song.title === "Open Road")), (song) => !!song, "Open Road in My Songs");
    assert.deepEqual([row!.copy?.from?.name, lyricOf(row!), row!.copy?.canSendOn], ["Terry", lyricOf(openRoad), true], "the copy says From Terry, holds the chart Terry sent, and may be passed on");
    const update = sendBody(sam, openRoadEdited, { choice: "public", updateOf: firstSend.shareId });
    const updated = landed(await terry.call("/api/chat/send-song", update), update, "Terry edits Open Road and sends the update");
    assert.equal(updated.updateOf, firstSend.shareId, "the update names the earlier send");
    const roomId = await dmOf(terry, sam);
    await eventually(() => songMessages(terry, roomId), (list) => list.some((m) => songIn(m).updateOf === firstSend.shareId), "the update is in the thread");
    const same = (await stored()).filter((song) => song.title === "Open Road");
    assert.deepEqual(same.map(lyricOf), [lyricOf(openRoad)], "Sam's copy still holds the chart Terry first sent, not the edit");
  });

  await check("an update offers Keep mine, Take Terry's or Keep both, and Keep both leaves two songs", async () => {
    await reset();
    await openDm("Terry");
    await app.until(`[...document.querySelectorAll(".chat-sheet button")].some((b) => b.textContent.trim() === "Keep both")`, "the update card", 15000);
    const names = (await dialogButtons("document.querySelector('.chat-sheet')")).map((b) => b.text);
    for (const choice of ["Keep mine", "Take Terry's", "Keep both"]) assert.ok(names.includes(choice), `the update card offers ${choice} (saw ${js(names)})`);
    await app.shot(shots && `${shots}/send-song-update.png`);
    await tap("Keep both", "document.querySelector('.chat-sheet')");
    const both = await eventually(() => stored().then((songs) => songs.filter((song) => song.title.startsWith("Open Road") && song.copy?.from?.name === "Terry")), (songs) => songs.length === 2, "two Open Road songs from Terry", 10000);
    assert.deepEqual(both.map(lyricOf).sort(), [lyricOf(openRoad), lyricOf(openRoadEdited)].sort(), "one with the first chart and one with the edit");
  });

  console.log("skip deleting the original leaves the friend's copy: My Songs has no delete for own songs yet, see QUESTIONS.md in the cook pack");

  const riverRoad = chart("River Road", "Terry", "Down along the river road");
  await check("a Public copy sent on asks Private or Public again and a Private resend makes every later copy unshareable", async () => {
    const toMike = sendBody(mike, riverRoad, { choice: "public" });
    const mikes = landed(await terry.call("/api/chat/send-song", toMike), toMike, "Terry sends Mike River Road as Public");
    assert.equal(mikes.reshareable, true, "Mike's copy may be passed on");
    assert.deepEqual(refusal(await send(mike, ann, riverRoad, { copyId: toMike.shareId, choice: null })), [400, "choice_required"], "Mike sending it on is asked Private or Public again");
    const toAnn = sendBody(ann, riverRoad, { choice: "private", copyId: toMike.shareId });
    const anns = landed(await mike.call("/api/chat/send-song", toAnn), toAnn, "Mike sends his copy on to Ann as Private");
    assert.equal(anns.reshareable, false, "Ann's copy may not be passed on");
    for (const [who, choice, how] of [
      [dana, "public", "to Dana as Public, naming her copy"],
      [dana, "private", "to Dana as Private, naming her copy"],
      [terry, "public", "back to Terry, naming her copy"],
    ] as const) {
      const tried = await send(ann, who, riverRoad, { copyId: toAnn.shareId, choice });
      assert.equal(tried.status, 403, `Ann can't send River Road ${how} (${js(tried.body)})`);
      assert.match(String(tried.body.error), /^private_(copy|ancestor)$/, "because it reached her privately");
    }
    const asOwn = await send(ann, dana, riverRoad, { choice: "public" });
    assert.equal(asOwn.status, 403, `nor by leaving the copy out, as if River Road were her own (${js(asOwn.body)})`);
    assert.deepEqual(await songMessages(dana, await dmOf(ann, dana)), [], "Dana never gets a song message");
  });

  await check("the same msgId twice stores one song message", async () => {
    const body = sendBody(mike, chart("Iron Gate", "Terry", "Open up the iron gate"), { choice: "public" });
    const first = await terry.call("/api/chat/send-song", body);
    const again = await terry.call("/api/chat/send-song", body);
    landed(first, body, "the first send is stored");
    assert.equal(again.status, 200, `the second send with the same msgId is accepted (${js(again.body)})`);
    assert.equal(again.body.message.seq, first.body.message.seq, "and returns the same message");
    const mine = (await songMessages(mike, await dmOf(terry, mike))).filter((m) => m.msgId === body.msgId);
    assert.equal(mine.length, 1, "so the thread holds one Iron Gate card");
  });

  await check("a signed-out phone, a stranger and a non-friend get no song message", async () => {
    const song = chart("Neon Night", "Terry", "Lights along the strip");
    assert.deepEqual(refusal(await send(signedOutPhone(base, origin), terry, song)), [401, "signed-out"], "a signed-out phone can't send");
    assert.deepEqual(refusal(await send(eve, terry, song)), [403, "not-friends"], "a stranger can't send Terry a song");
    assert.deepEqual(refusal(await send(dana, terry, song)), [403, "not-friends"], "someone whose friend request Terry hasn't accepted can't either");
    assert.deepEqual(refusal(await send(terry, eve, song)), [403, "not-friends"], "and Terry can't send to someone who isn't his friend");
    const titles = await dmTitles(terry);
    assert.ok(!titles.includes("Eve Spam") && !titles.includes("Dana Drums"), `no DM with either reached Terry's Messages list (${js(titles)})`);
  });

  await check("a built-in song both friends already have is still Terry's own to send", async () => {
    const builtIn = content(seed.songs[1]);
    const mikes = sendBody(terry, builtIn, { choice: "private" });
    landed(await mike.call("/api/chat/send-song", mikes), mikes, `Mike sends Terry the built-in ${builtIn.title} as Private`);
    const toAnn = sendBody(ann, builtIn, { choice: "public" });
    const anns = landed(await terry.call("/api/chat/send-song", toAnn), toAnn, `Terry sends Ann his own built-in ${builtIn.title}, which every phone has`);
    assert.deepEqual([anns.sharedAs, anns.reshareable], ["public", true], "as Public, and Ann may pass it on");
    const back = sendBody(mike, builtIn, { choice: "public" });
    landed(await terry.call("/api/chat/send-song", back), back, "and Terry can send it to Mike too, whoever sent it Private first");
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
console.log("check:send-song passed");
