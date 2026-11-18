import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ChatEntry, ChatMessage } from "../src/chat-model.ts";
import { startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/**
 * U4b, chat rooms (UX-PLAN U4b, SCREEN-MAP 6). One case per pass condition, named by it. The cases fix this contract.
 *
 * `#/messages` is a screen `.messages`. Signed out it says "Sign in to see your messages." with a Sign in button. Signed
 * in it lists one `button.chat-row` per room, newest first, each with `.chat-row-initial`, `.chat-row-title`,
 * `.chat-row-preview`, `.chat-row-time`, a `.chat-badge` unread count and a `.chat-muted` "Muted". With more than eight
 * rooms a search box labelled "Search messages" sits above the list. A row opens `#/messages/<roomId>`, a screen
 * `.room[data-room=<roomId>]` with the room's name in its `h2`, a ••• button labelled More (8 hours, 1 week, Always,
 * Unmute, and Open band for a band room), `.chat-messages` holding `li.chat-line` items with `.chat-name` above a run,
 * `.chat-bubble`, `.chat-day` dividers, `.chat-new-line` and `.chat-waiting`, and `form.chat-composer` with a textarea
 * labelled Message and a Send button. The band page's Chat section holds the same `.room[data-room=<bandId>]` with
 * `data-inline` and no `h2`. The gear `.shell-header [aria-label=Settings]` holds a `.chat-badge` while a room is unread.
 */

type Reply = { status: number; body: Record<string, any> };
type Player = Awaited<ReturnType<typeof passwordPlayer>>;

const root = new URL("..", import.meta.url).pathname;
const shots = process.env.SHOTS;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const js = (value: unknown) => JSON.stringify(value);
const newId = () => crypto.randomUUID().replace(/-/g, "");
const DAY_BACK_KEY = "checkDayBack";
const KEYBOARD = 300;

const seed = JSON.parse(readFileSync(`${root}data/library.json`, "utf8")) as { songs: { id: number; title: string }[] };

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

async function band(admin: Player, name: string) {
  const bandId = (await admin.call("/api/bands/create", { name })).body.bandId as string;
  const code = (await admin.call("/api/codes", { kind: "band", bandId })).body.code as string;
  return { bandId, code };
}

let apiBase = "";
const site = await openSite(root, "check-ux-chat-rooms", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;
try {
  const app = await appPage(site);
  await site.send("Network.enable");
  await site.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const viewport = new EventTarget();
      viewport.keyboard = 0;
      Object.defineProperties(viewport, {
        width: { get: () => innerWidth },
        height: { get: () => innerHeight - viewport.keyboard },
        offsetTop: { get: () => 0 },
        offsetLeft: { get: () => 0 },
        pageTop: { get: () => scrollY },
        pageLeft: { get: () => scrollX },
        scale: { get: () => 1 },
      });
      Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
      const fetchNext = window.fetch;
      window.fetch = async (input, init) => {
        const reply = await fetchNext(input, init);
        const back = JSON.parse(sessionStorage.getItem(${js(DAY_BACK_KEY)}) ?? "null");
        if (!back || !String(input?.url ?? input).endsWith("/api/chat/open") || JSON.parse(init?.body ?? "{}").roomId !== back.roomId) return reply;
        const body = await reply.json();
        for (const m of body.messages ?? []) if (m.seq <= back.seq) m.at -= 24 * 3600 * 1000;
        return new Response(JSON.stringify(body), { status: reply.status, headers: reply.headers });
      };
    })();`,
  });
  const offline = (on: boolean) => site.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const appCalls = (path: string, body?: object) =>
    site.evaluate<Reply>(
      body === undefined
        ? `fetch(${js(path)}).then(async (r) => ({ status: r.status, body: await r.json() }))`
        : `fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`,
    );
  const samsChats = async () => (await appCalls("/api/chat")).body.chats as ChatEntry[];
  const textsIn = async (who: Player, roomId: string) => ((await who.call("/api/chat/open", { roomId })).body.messages as ChatMessage[]).map((m) => m.text);
  const post = (who: Player, roomId: string, text: string) => who.call("/api/chat/send", { roomId, msgId: newId(), text });

  const LIST = `document.querySelector(".messages")`;
  const room = (roomId: string) => `document.querySelector(${js(`.room[data-room="${roomId}"]`)})`;
  const onList = () => app.until(`location.hash === "#/messages" && !!${LIST} && !${LIST}.textContent.includes("Loading")`, "the Messages list", 15000);
  const onRoom = (roomId: string) => app.until(`location.hash === ${js(`#/messages/${roomId}`)} && !!${room(roomId)}?.querySelector(".chat-composer") && !${room(roomId)}.textContent.includes("Loading")`, `the room ${roomId}`, 15000);
  const openList = async () => {
    await app.openMenu();
    await app.pick("Messages");
    await onList();
  };
  const rows = () =>
    site.evaluate<{ initial: string; title: string; preview: string; time: string; badge: string; muted: boolean }[]>(
      `[...document.querySelectorAll(".messages .chat-row")].map((row) => ({
        initial: row.querySelector(".chat-row-initial")?.textContent.trim() ?? "",
        title: row.querySelector(".chat-row-title")?.textContent.trim() ?? "",
        preview: row.querySelector(".chat-row-preview")?.textContent.trim() ?? "",
        time: row.querySelector(".chat-row-time")?.textContent.trim() ?? "",
        badge: row.querySelector(".chat-badge")?.textContent.trim() ?? "",
        muted: row.querySelector(".chat-muted")?.textContent.trim() === "Muted",
      }))`,
    );
  const tapRow = async (title: string) => {
    const found = await site.evaluate<boolean>(`(() => { const row = [...document.querySelectorAll(".messages .chat-row")].find((b) => b.querySelector(".chat-row-title")?.textContent.trim() === ${js(title)}); row?.click(); return !!row; })()`);
    assert.ok(found, `a ${title} row to tap`);
    await settle();
  };
  const bubbles = (scope: string) => site.evaluate<string[]>(`[...(${scope}?.querySelectorAll(".chat-bubble") ?? [])].map((b) => b.textContent.trim())`);
  const composer = (scope: string) => `${scope}?.querySelector(".chat-composer textarea")`;
  const setComposer = async (scope: string, text: string) => {
    await site.evaluate(`(() => {
      const box = ${composer(scope)};
      box.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, ${js(text)});
      box.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await settle(150);
  };
  const sendFrom = async (scope: string, text: string) => {
    await setComposer(scope, text);
    await app.click("Send", scope);
  };
  const roomMenu = async (roomId: string) => {
    await site.evaluate(`${room(roomId)}.querySelector("[aria-label=More]").click()`);
    await app.until(`!!${room(roomId)}.querySelector("[role=menu]")`, "the room's ••• menu");
    return app.texts(".room [role=menu] [role=menuitem]");
  };
  const gearBadge = () => site.evaluate<string>(`document.querySelector(".shell-header [aria-label=Settings] .chat-badge")?.textContent.trim() ?? ""`);
  const back = () => site.evaluate(`document.querySelector(".shell-header [aria-label=Back]").click()`);

  const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
  const ann = await passwordPlayer(base, origin, "Ann Horn", "annhorn");
  const lowTides = await band(terry, "The Low Tides");
  assert.equal((await mike.call("/api/bands/join", { code: lowTides.code })).status, 200, "Mike joins The Low Tides");

  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await site.evaluate("Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((done) => setTimeout(done, 20000, false))])");
  if (!(await site.evaluate<boolean>("!!navigator.serviceWorker.controller"))) await site.send("Page.reload");
  await app.until("!!navigator.serviceWorker?.controller", "the service worker to take control of the page", 60000);
  await app.library();

  await check("signed out, `#/messages` shows Sign in and nothing is trapped", async () => {
    for (const hash of ["#/messages", `#/messages/${lowTides.bandId}`]) {
      await site.evaluate(`location.hash = ${js(hash)}`);
      await app.until(`(${LIST}?.textContent ?? "").includes("Sign in to see your messages.")`, `the sign-in words on ${hash}`);
      assert.equal(await site.evaluate<boolean>(`!!document.querySelector(".room")`), false, `no room shows signed out on ${hash}`);
      await app.click("Sign in", LIST);
      await app.until(`document.querySelector(".account-sheet")?.dataset.step === "start"`, "the sign-in sheet");
      await app.click("✕");
      await app.until(`!document.querySelector(".account-sheet")`, "the sign-in sheet closing");
      assert.equal(await site.evaluate<boolean>(`!!document.querySelector("[role=dialog]")`), false, `nothing holds the screen after closing sign-in on ${hash}`);
      assert.equal(await site.evaluate<string>("location.hash"), hash, `closing sign-in stays on ${hash}`);
    }
    await back();
    await app.until(`location.hash === "#/messages"`, "Back from a room to Messages");
    await back();
    await app.until(`location.hash.startsWith("#/settings") && !!document.querySelector(".settings")`, "Back from Messages to Settings");
    await site.evaluate(`location.hash = "#/songs"`);
    await app.until(`!!document.querySelector(".song-list")`, "My Songs after leaving Messages");
  });

  await app.signUp("Sam Rivera");
  const sam = await site.evaluate<{ userId: string; handle: string }>(`fetch("/api/me").then((r) => r.json()).then((reply) => reply.account)`);
  assert.equal((await appCalls("/api/bands/join", { code: lowTides.code })).status, 200, "Sam joins The Low Tides");
  const trio = (await appCalls("/api/bands/create", { name: "Sam's Trio" })).body.bandId as string;
  assert.equal((await terry.call("/api/friends/request", { handle: sam.handle })).status, 200, "Terry asks Sam to be friends");
  assert.equal((await appCalls("/api/friends/accept", { userId: terry.userId })).status, 200, "Sam accepts Terry");
  const terryDm = (await terry.call("/api/chat/dm", { userId: sam.userId })).body.roomId as string;
  await sleep(20);
  assert.equal((await post(terry, lowTides.bandId, "Soundcheck at six")).status, 200, "Terry posts in the band");
  await sleep(20);
  assert.equal((await post(terry, terryDm, "Hi Sam")).status, 200, "Terry writes Sam");

  await check("the room list shows every band room and DM with the last line, time and unread count, newest first", async () => {
    await openList();
    await app.until(`document.querySelectorAll(".messages .chat-row").length === 3`, "three rooms on the list");
    const shown = await rows();
    assert.deepEqual(shown.map((row) => row.title), ["Terry Bass", "The Low Tides", "Sam's Trio"], "the DM, then the band, then the quiet band, newest first");
    assert.deepEqual(shown.map((row) => row.initial), ["T", "T", "S"], "each row starts with the room's initial");
    assert.ok(shown[0].preview.endsWith("Hi Sam") && shown[1].preview.endsWith("Soundcheck at six"), `each row shows its last line (${js(shown)})`);
    assert.equal(shown[2].preview, "Say hello to the band", "a band with no messages yet says so");
    assert.deepEqual(shown.slice(0, 2).map((row) => row.badge), ["1", "1"], "one unread on the DM and on the band");
    assert.equal(shown[2].badge, "", "the quiet band has no count");
    for (const row of shown.slice(0, 2)) assert.match(row.time, /^\d{1,2}:\d{2}\s?(AM|PM)?$/i, `${row.title} shows today's time (${row.time})`);
    assert.equal(await site.evaluate<boolean>(`!!document.querySelector(".messages")?.closest("[role=dialog]") || !!document.querySelector("[role=dialog]")`), false, "Messages is a screen, not a sheet");
    await app.shot(shots && `${shots}/messages-list.png`);
  });

  await check("opening a room clears its unread count and the New messages line sits at the first unread", async () => {
    await post(terry, lowTides.bandId, "Bring the charts");
    await post(terry, lowTides.bandId, "Doors at eight");
    await site.evaluate(`location.hash = "#/songs"`);
    await openList();
    await app.until(`[...document.querySelectorAll(".messages .chat-row")].find((r) => r.querySelector(".chat-row-title")?.textContent === "The Low Tides")?.querySelector(".chat-badge")?.textContent === "3"`, "three unread on the band");
    await tapRow("The Low Tides");
    await onRoom(lowTides.bandId);
    assert.equal(await app.text(".room h2"), "The Low Tides", "the room is titled with the band's name");
    await app.until(`!!${room(lowTides.bandId)}.querySelector(".chat-new-line")`, "the New messages line");
    const above = await site.evaluate<string>(`document.querySelector(".chat-new-line").closest("li").querySelector(".chat-bubble").textContent`);
    assert.equal(above, "Soundcheck at six", "the line sits at the first unread message");
    assert.equal(await site.evaluate<number>(`document.querySelectorAll(".chat-new-line").length`), 1, "and only once");
    await app.shot(shots && `${shots}/room.png`);
    const server = await eventually(samsChats, (list) => list.find((c) => c.roomId === lowTides.bandId)?.lastReadSeq === 3, "the server marks the band read");
    assert.equal(server.find((c) => c.roomId === lowTides.bandId)!.lastSeq, 3, "up to the last message");
    await back();
    await onList();
    await app.until(`!([...document.querySelectorAll(".messages .chat-row")].find((r) => r.querySelector(".chat-row-title")?.textContent === "The Low Tides")?.querySelector(".chat-badge"))`, "the band's count cleared on the list");
  });

  await check("the gear shows a badge when any room has unread", async () => {
    await tapRow("Terry Bass");
    await onRoom(terryDm);
    await eventually(samsChats, (list) => list.every((c) => c.lastReadSeq >= c.lastSeq), "every room read");
    await site.evaluate(`location.hash = "#/songs"`);
    await settle(800);
    assert.equal(await gearBadge(), "", "no badge with nothing unread");
    await post(terry, terryDm, "Are you free Friday?");
    await site.evaluate(`location.hash = "#/setlists"`);
    await app.until(`!!document.querySelector(".shell-header [aria-label=Settings] .chat-badge")`, "the gear's badge", 10000);
    assert.equal(await gearBadge(), "1", "the gear counts the unread message");
    await app.shot(shots && `${shots}/gear-badge.png`);
    await site.evaluate(`location.hash = ${js(`#/messages/${terryDm}`)}`);
    await onRoom(terryDm);
    await app.until(`!document.querySelector(".shell-header [aria-label=Settings] .chat-badge")`, "the badge clearing once the room is read");
    await site.evaluate(`location.hash = "#/songs"`);
    await settle(800);
    assert.equal(await gearBadge(), "", "and it stays clear");
  });

  await check("day dividers appear between days and sender names above runs", async () => {
    await post(mike, lowTides.bandId, "See you there");
    await site.evaluate(`sessionStorage.setItem(${js(DAY_BACK_KEY)}, ${js(js({ roomId: lowTides.bandId, seq: 2 }))})`);
    try {
      await site.evaluate(`location.hash = ${js(`#/messages/${lowTides.bandId}`)}; window.__beforeReload = true; location.reload()`);
      await app.until(`!window.__beforeReload`, "the reload");
      await onRoom(lowTides.bandId);
      await app.until(`${room(lowTides.bandId)}.querySelectorAll(".chat-bubble").length === 4`, "the band's four messages");
      assert.deepEqual(await app.texts(".room .chat-day"), ["Yesterday", "Today"], "a divider for each day, in order");
      assert.deepEqual(await app.texts(".room .chat-name"), ["Terry Bass", "Terry Bass", "Mike Keys"], "a name above each run, and again after a day divider");
      const order = await site.evaluate<string[]>(`[...document.querySelectorAll(".room .chat-day, .room .chat-bubble")].map((el) => el.textContent.trim())`);
      assert.deepEqual(order, ["Yesterday", "Soundcheck at six", "Bring the charts", "Today", "Doors at eight", "See you there"], "the dividers sit between the days");
      await app.shot(shots && `${shots}/room-days.png`);
    } finally {
      await site.evaluate(`sessionStorage.removeItem(${js(DAY_BACK_KEY)})`);
    }
  });

  await check("the band page's Chat section is the same room, and a message sent there appears in `#/messages/:roomId`", async () => {
    await site.evaluate(`location.hash = ${js(`#/band/${lowTides.bandId}?s=chat`)}`);
    const inline = `document.querySelector(${js(`.band-page .room[data-room="${lowTides.bandId}"]`)})`;
    await app.until(`!!${inline}?.querySelector(".chat-composer") && ${inline}.querySelectorAll(".chat-bubble").length >= 4`, "the band's room on the band page", 15000);
    assert.equal(await site.evaluate<boolean>(`${inline}.hasAttribute("data-inline") && !${inline}.querySelector("h2")`), true, "inline, without the room's own header");
    await sendFrom(inline, "From the band page");
    await app.until(`[...${inline}.querySelectorAll(".chat-bubble")].some((b) => b.textContent.includes("From the band page"))`, "the message on the band page");
    const onPage = await bubbles(inline);
    await site.evaluate(`location.hash = ${js(`#/messages/${lowTides.bandId}`)}`);
    await onRoom(lowTides.bandId);
    await app.until(`[...${room(lowTides.bandId)}.querySelectorAll(".chat-bubble")].some((b) => b.textContent.includes("From the band page"))`, "the message in the room screen");
    assert.equal(await site.evaluate<boolean>(`${room(lowTides.bandId)}.hasAttribute("data-inline")`), false, "the room screen is not the inline one");
    assert.deepEqual(await bubbles(room(lowTides.bandId)), onPage, "both show the same messages in the same order");
    assert.deepEqual(await textsIn(terry, lowTides.bandId).then((list) => list.filter((text) => text === "From the band page")), ["From the band page"], "stored once");
    const items = await roomMenu(lowTides.bandId);
    assert.ok(items.includes("Open band"), `a band room's ••• offers Open band (${js(items)})`);
    await app.click("Open band", room(lowTides.bandId));
    await app.until(`location.hash === ${js(`#/band/${lowTides.bandId}?s=chat`)}`, "Open band landing on the band page's Chat");
  });

  await check("the composer grows to four lines, Send is disabled when empty, and the composer stays above the keyboard", async () => {
    await site.evaluate(`location.hash = ${js(`#/messages/${trio}`)}`);
    await onRoom(trio);
    const scope = room(trio);
    const send = `[...${scope}.querySelectorAll(".chat-composer button")].find((b) => b.textContent.trim() === "Send")`;
    const height = async (lines: number) => {
      await setComposer(scope, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n"));
      return site.evaluate<number>(`${composer(scope)}.getBoundingClientRect().height`);
    };
    const [one, two, four, six] = [await height(1), await height(2), await height(4), await height(6)];
    assert.ok(one < two && two < four, `the composer grows with each line (1: ${one}, 2: ${two}, 4: ${four})`);
    assert.ok(Math.abs(six - four) <= 1, `and stops at four lines (4: ${four}, 6: ${six})`);
    assert.equal(await site.evaluate<boolean>(`${send}.disabled`), false, "Send is on with words in the composer");
    for (const blank of ["", "   ", "\n\n"]) {
      await setComposer(scope, blank);
      assert.equal(await site.evaluate<boolean>(`${send}.disabled`), true, `Send is off for ${js(blank)}`);
    }
    await setComposer(scope, "Hi");
    const geometry = () =>
      site.evaluate<{ top: number; bottom: number; header: number; visible: number; height: number }>(`(() => {
        const box = ${scope}.querySelector(".chat-composer").getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, header: document.querySelector(".shell-header").getBoundingClientRect().bottom, visible: visualViewport.height + visualViewport.offsetTop, height: innerHeight };
      })()`);
    const open = await geometry();
    assert.ok(open.height - open.bottom <= 40 && open.top >= open.header, `with no keyboard the composer sits at the bottom of the screen (${js(open)})`);
    await site.evaluate(`visualViewport.keyboard = ${KEYBOARD}; visualViewport.dispatchEvent(new Event("resize"))`);
    await settle(300);
    const up = await geometry();
    assert.ok(up.bottom <= up.visible + 1, `with the keyboard up the composer sits above it (${js(up)})`);
    assert.ok(up.visible - up.bottom <= 40 && up.top >= up.header, `and right on top of it, under the header (${js(up)})`);
    await app.shot(shots && `${shots}/room-keyboard.png`);
    await site.evaluate(`visualViewport.keyboard = 0; visualViewport.dispatchEvent(new Event("resize"))`);
    await settle(300);
    const down = await geometry();
    assert.ok(down.height - down.bottom <= 40, `and back down when the keyboard closes (${js(down)})`);
    await setComposer(scope, "");
  });

  await check("a message sent offline shows Waiting for signal and sends once on reconnect", async () => {
    await site.evaluate(`location.hash = ${js(`#/messages/${terryDm}`)}`);
    await onRoom(terryDm);
    await app.until("!!navigator.serviceWorker?.controller", "the service worker still in control before the signal goes");
    const before = (await textsIn(terry, terryDm)).length;
    await offline(true);
    try {
      await sendFrom(room(terryDm), "Sent with no signal");
      await app.until(`[...${room(terryDm)}.querySelectorAll(".chat-waiting")].some((w) => w.textContent.trim() === "⏱ Waiting for signal")`, "the clock on the waiting message");
      assert.deepEqual((await bubbles(room(terryDm))).slice(-1), ["Sent with no signal"], "the message shows in the room");
      await app.shot(shots && `${shots}/room-waiting.png`);
      assert.equal((await textsIn(terry, terryDm)).length, before, "the server has none of it yet");
    } finally {
      await offline(false);
    }
    await eventually(() => textsIn(terry, terryDm), (list) => list.length === before + 1, "the message goes when signal returns", 20000);
    await app.until(`${room(terryDm)}.querySelectorAll(".chat-waiting").length === 0`, "the clock clearing");
    await sleep(1500);
    assert.deepEqual((await textsIn(terry, terryDm)).filter((text) => text === "Sent with no signal"), ["Sent with no signal"], "it is stored once");
    assert.deepEqual((await bubbles(room(terryDm))).filter((text) => text === "Sent with no signal"), ["Sent with no signal"], "and shows once");
  });

  let annDm = "";
  await check("Message on a friend opens the DM room and makes it when missing", async () => {
    assert.equal((await ann.call("/api/friends/request", { handle: sam.handle })).status, 200, "Ann asks Sam to be friends");
    assert.equal((await appCalls("/api/friends/accept", { userId: ann.userId })).status, 200, "Sam accepts Ann");
    assert.equal((await samsChats()).some((c) => c.kind === "dm" && c.title === "Ann Horn"), false, "Sam and Ann have no DM yet");
    await site.evaluate(`location.hash = "#/songs"`);
    await app.openMenu();
    await app.pick("Friends");
    const annRow = `[...document.querySelectorAll(".friends-friends li")].find((li) => li.textContent.includes("Ann Horn"))`;
    await app.until(`!!${annRow}`, "Ann on the Friends list");
    await app.click("Message", annRow);
    await app.until(`location.hash.startsWith("#/messages/dm_") && document.querySelector(".room h2")?.textContent === "Ann Horn"`, "the DM room with Ann", 15000);
    annDm = (await site.evaluate<string>("location.hash")).slice("#/messages/".length);
    await onRoom(annDm);
    assert.equal(await site.evaluate<boolean>(`!!document.querySelector("[role=dialog]")`), false, "the Friends sheet is gone");
    const made = (await samsChats()).find((c) => c.roomId === annDm);
    assert.deepEqual([made?.kind, made?.title], ["dm", "Ann Horn"], "the DM now exists on the server");
    assert.equal((await ann.call("/api/chat/dm", { userId: sam.userId })).body.roomId, annDm, "and it is the one Ann gets too");
  });

  await check("Mute from the ••• mutes and the list shows Muted", async () => {
    await site.evaluate(`location.hash = ${js(`#/messages/${annDm}`)}`);
    await onRoom(annDm);
    const items = await roomMenu(annDm);
    for (const choice of ["8 hours", "1 week", "Always"]) assert.ok(items.includes(choice), `the ••• offers ${choice} (${js(items)})`);
    assert.ok(!items.includes("Open band"), "a DM has no Open band");
    await app.click("8 hours", room(annDm));
    await app.until(`(${room(annDm)}.querySelector(".room-top")?.textContent ?? "").includes("Muted")`, "the room saying Muted");
    const row = await eventually(samsChats, (list) => (list.find((c) => c.roomId === annDm)?.mutedUntil ?? 0) > Date.now(), "the server keeps the mute");
    assert.ok(row.find((c) => c.roomId === annDm)!.mutedUntil! <= Date.now() + 8 * 3600 * 1000 + 60_000, "for 8 hours");
    await back();
    await onList();
    const shown = await rows();
    assert.deepEqual(shown.filter((r) => r.muted).map((r) => r.title), ["Ann Horn"], "the list shows Muted on Ann's DM only");
    await tapRow("Ann Horn");
    await onRoom(annDm);
    assert.ok((await roomMenu(annDm)).includes("Unmute"), "a muted room offers Unmute");
    await app.click("Unmute", room(annDm));
    await eventually(samsChats, (list) => list.find((c) => c.roomId === annDm)?.mutedUntil === null, "Unmute clears it on the server");
  });

  await check("send-song's Sent lands in the DM room", async () => {
    const song = seed.songs[0];
    await site.evaluate(`location.hash = ${js(`#/song/${song.id}`)}`);
    await app.until(`!!document.querySelector(".sheet .sheet-name")`, "the song on screen");
    let opened = false;
    for (const label of ["More", "Song actions"]) {
      await site.evaluate(`document.querySelector('[aria-label=${js(label)}]')?.click()`);
      await settle();
      opened = await site.evaluate<boolean>(`(() => { const el = [...document.querySelectorAll("[role=menu] [role=menuitem]")].find((b) => b.textContent.trim().startsWith("Send to a friend") && !b.disabled); el?.click(); return !!el; })()`);
      if (opened) break;
      await app.closeMenu();
    }
    assert.ok(opened, "a Send to a friend entry on the song");
    await app.until(`[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim().startsWith("Terry Bass"))`, "the friends to send to", 15000);
    for (const start of ["Terry Bass", "Public", "Send to "]) {
      const tapped = await site.evaluate<boolean>(`(() => { const b = [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim().startsWith(${js(start)}) && !b.disabled); b?.click(); return !!b; })()`);
      assert.ok(tapped, `a button starting ${start} on the send sheet`);
      await settle();
    }
    await onRoom(terryDm);
    await app.until(`[...${room(terryDm)}.querySelectorAll(".song-card")].some((card) => card.textContent.includes(${js(song.title)}) && card.textContent.includes("✓ Sent"))`, "the Sent song card in the DM room", 15000);
    assert.equal(await site.evaluate<boolean>(`!!document.querySelector("[role=dialog]")`), false, "the send sheet is gone");
  });

  await check("with more than eight rooms a search box above the list filters them", async () => {
    const search = `document.querySelector(".messages input[type=search][aria-label='Search messages']")`;
    await site.evaluate(`location.hash = "#/songs"`);
    await openList();
    await app.until(`document.querySelectorAll(".messages .chat-row").length === 4`, "Sam's four rooms");
    assert.equal(await site.evaluate<boolean>(`!!${search}`), false, "four rooms, no search box");
    for (let n = 1; n <= 4; n += 1) assert.equal((await appCalls("/api/bands/create", { name: `Side Band ${n}` })).status, 200, `Sam starts Side Band ${n}`);
    await site.evaluate(`location.hash = "#/songs"`);
    await openList();
    await app.until(`document.querySelectorAll(".messages .chat-row").length === 8`, "eight rooms");
    assert.equal(await site.evaluate<boolean>(`!!${search}`), false, "eight rooms, still no search box");
    assert.equal((await appCalls("/api/bands/create", { name: "Side Band 5" })).status, 200, "Sam starts a ninth room");
    await site.evaluate(`location.hash = "#/songs"`);
    await openList();
    await app.until(`document.querySelectorAll(".messages .chat-row").length === 9 && !!${search}`, "nine rooms and the search box");
    assert.ok(await site.evaluate<boolean>(`${search}.getBoundingClientRect().bottom <= document.querySelector(".messages .chat-row").getBoundingClientRect().top`), "the box sits above the list");
    const find = async (words: string) => {
      await site.evaluate(`(() => { const box = ${search}; box.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(box, ${js(words)}); box.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await settle(200);
      return (await rows()).map((row) => row.title);
    };
    assert.deepEqual(await find("tides"), ["The Low Tides"], "typing part of a name keeps only that room");
    assert.deepEqual(await find("ANN"), ["Ann Horn"], "in any case");
    assert.deepEqual((await find("side band")).sort(), ["Side Band 1", "Side Band 2", "Side Band 3", "Side Band 4", "Side Band 5"], "every match stays");
    assert.deepEqual(await find("zzz"), [], "nothing matches nothing");
    assert.match(await app.text(".messages"), /No rooms match/, "and the list says so");
    assert.equal((await find("")).length, 9, "clearing the box brings every room back");
    await app.shot(shots && `${shots}/messages-search.png`);
  });

  await check("every row and the composer are at least 48 px", async () => {
    await site.evaluate(`location.hash = "#/songs"`);
    await openList();
    const short = await site.evaluate<string[]>(`[...document.querySelectorAll(".messages .chat-row, .messages input")]
      .filter((el) => el.getBoundingClientRect().height < 47.5)
      .map((el) => el.className + " " + Math.round(el.getBoundingClientRect().height))`);
    assert.equal(await site.evaluate<number>(`document.querySelectorAll(".messages .chat-row").length`), 9, "the rows to measure");
    assert.deepEqual(short, [], "every row on the list is at least 48 px tall");
    await tapRow("The Low Tides");
    await onRoom(lowTides.bandId);
    const sizes = await site.evaluate<Record<string, number>>(`(() => {
      const scope = ${room(lowTides.bandId)};
      const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : 0);
      return { composer: h(scope.querySelector(".chat-composer textarea")), send: h([...scope.querySelectorAll(".chat-composer button")].find((b) => b.textContent.trim() === "Send")), more: h(scope.querySelector("[aria-label=More]")) };
    })()`);
    for (const [what, size] of Object.entries(sizes)) assert.ok(size >= 48, `the ${what} is at least 48 px (${size})`);
    await site.evaluate(`location.hash = ${js(`#/band/${lowTides.bandId}?s=chat`)}`);
    const inline = `document.querySelector(".band-page .room")`;
    await app.until(`!!${inline}?.querySelector(".chat-composer textarea")`, "the band page's room");
    assert.ok((await site.evaluate<number>(`${composer(inline)}.getBoundingClientRect().height`)) >= 48, "and the band page's composer too");
  });

  await check("no page errors", async () => assert.deepEqual(await app.errors(), [], "the page logged no errors"));
} finally {
  await site.close();
  await worker.dispose();
}

if (failed > 0) {
  console.log(`check:ux-chat-rooms: ${failed} failed`);
  process.exit(1);
}
console.log("check:ux-chat-rooms passed");
