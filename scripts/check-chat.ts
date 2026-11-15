import assert from "node:assert/strict";
import {
  MUTE_1W,
  MUTE_8H,
  MUTE_ALWAYS,
  NOT_A_MEMBER_CLOSE,
  enqueue,
  firstUnreadSeq,
  flushQueue,
  isMuted,
  mutedUntilFor,
  sortChats,
  unread,
  withMessages,
  type ChatEntry,
  type ChatMessage,
  type Queued,
} from "../src/chat-model.ts";
import { Phone, startApi, TEST_ORIGIN } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle, WIDTH } from "./app-page.ts";
import { openSite } from "./chrome.ts";

const root = new URL("..", import.meta.url).pathname;
/** Set SHOTS to a folder to save the Messages screens at phone size. */
const shots = process.env.SHOTS;
const pass = (message: string) => console.log(`ok   ${message}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function player(base: string, name: string) {
  const phone = new Phone(base);
  const made = await phone.createAccount(name);
  assert.equal(made.status, 200, `${name} signs up`);
  return Object.assign(phone, { name, handle: made.body.account.handle as string, userId: made.body.account.userId as string });
}
type Player = Awaited<ReturnType<typeof player>>;

type Socket = { ws: WebSocket; opened: boolean; closed: Promise<number>; received: Record<string, unknown>[] };

function openSocket(phone: Phone, room: string, origin = TEST_ORIGIN): Promise<Socket> {
  const ws = new WebSocket(phone.socketUrl(room), { headers: { origin, cookie: phone.cookie } } as unknown as string[]);
  const received: Record<string, unknown>[] = [];
  ws.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))));
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ws, opened: false, closed, received }), 5000);
    ws.addEventListener("message", () => (clearTimeout(timer), resolve({ ws, opened: true, closed, received })), { once: true });
    ws.addEventListener("close", () => (clearTimeout(timer), resolve({ ws, opened: false, closed, received })), { once: true });
  });
}

/** The close code the server sent. The local dev proxy holds TCP open after a server close, so the client finishes it. */
async function serverClose(socket: Socket, label: string): Promise<number> {
  for (const end = Date.now() + 5000; socket.ws.readyState === WebSocket.OPEN; await sleep(50)) {
    if (Date.now() > end) throw new Error(`timed out waiting for the server to close ${label}`);
  }
  socket.ws.close();
  return socket.closed;
}

async function eventually<T>(read: () => Promise<T>, good: (value: T) => boolean, what: string, ms = 5000): Promise<T> {
  let value = await read();
  for (const end = Date.now() + ms; !good(value) && Date.now() < end; value = await read()) await sleep(100);
  assert.ok(good(value), `${what} (last saw ${JSON.stringify(value)})`);
  return value;
}

const entry = (over: Partial<ChatEntry>): ChatEntry => ({ roomId: "r", kind: "band", title: "Band", lastSeq: 0, lastReadSeq: 0, mutedUntil: null, preview: "", lastAt: 0, ...over });
const msg = (seq: number, text = `m${seq}`): ChatMessage => ({ seq, msgId: `id${seq}`, fromId: "u1", fromName: "Ann", text, at: seq });
const queued = (msgId: string): Queued => ({ msgId, roomId: "r", text: msgId, at: 0, from: "u1" });

async function modelChecks() {
  assert.equal(unread(entry({ lastSeq: 12, lastReadSeq: 9 })), 3, "unread counts the messages past the last read one");
  assert.equal(unread(entry({ lastSeq: 12, lastReadSeq: 20 })), 0, "and is never negative");
  assert.equal(firstUnreadSeq(entry({ lastSeq: 12, lastReadSeq: 9 })), 10, "the New messages line goes above the first unread message");
  assert.equal(firstUnreadSeq(entry({ lastSeq: 5, lastReadSeq: 5 })), null, "and is absent when everything is read");
  const chats = [entry({ roomId: "a", lastAt: 1 }), entry({ roomId: "b", lastAt: 3 }), entry({ roomId: "c", lastAt: 2 })];
  assert.deepEqual(sortChats(chats).map((c) => c.roomId), ["b", "c", "a"], "the list is newest first");
  assert.deepEqual(chats.map((c) => c.roomId), ["a", "b", "c"], "without reordering the input");
  const now = 1_700_000_000_000;
  assert.equal(mutedUntilFor("8h", now), now + MUTE_8H, "8 hours mutes for 8 hours");
  assert.equal(mutedUntilFor("1w", now), now + MUTE_1W, "1 week for a week");
  assert.equal(mutedUntilFor("always", now), MUTE_ALWAYS, "Always for good, as a JSON-safe number");
  assert.equal(mutedUntilFor("off", now), null, "and Unmute clears it");
  const muted = entry({ mutedUntil: now + MUTE_8H });
  assert.ok(isMuted(muted, now + MUTE_8H - 1) && !isMuted(muted, now + MUTE_8H), "a mute ends when its time is up");
  assert.ok(isMuted(entry({ mutedUntil: MUTE_ALWAYS }), now + 50 * 365 * 24 * 3600 * 1000), "Always is still muted decades later");
  assert.ok(isMuted(entry({}), now, true) && !isMuted(entry({ kind: "dm" }), now, true), "a live gig mutes the band's thread, not a DM");
  assert.deepEqual(withMessages([msg(1), msg(3)], [msg(2), msg(3), msg(4)]).map((m) => m.seq), [1, 2, 3, 4], "merged messages are in seq order with no repeats");
  assert.equal(enqueue([], queued("   ")).length, 0, "a blank message is not queued");
  assert.deepEqual(enqueue([queued("a")], queued("b")).map((q) => q.msgId), ["a", "b"], "the queue keeps writing order");

  const sent: string[] = [];
  const dropped: string[] = [];
  const report = { sent: (item: Queued) => sent.push(item.msgId), dropped: (item: Queued) => dropped.push(item.msgId) };
  const offline = new Error("offline");
  const refused = new Error("not-a-member");
  const answers = new Map<string, Error>([["b", offline]]);
  const send = async (item: Queued) => {
    const error = answers.get(item.msgId);
    if (error) throw error;
    return msg(sent.length + 1, item.text);
  };
  const unanswered = (error: unknown) => error === offline;
  let left = await flushQueue([queued("a"), queued("b"), queued("c")], send, unanswered, report);
  assert.deepEqual([sent, left.map((q) => q.msgId)], [["a"], ["b", "c"]], "a send with no answer stops the run, so later messages wait behind it");
  answers.set("b", refused);
  left = await flushQueue(left, send, unanswered, report);
  assert.deepEqual([sent, dropped, left], [["a", "c"], ["b"], []], "a refused message is dropped and the rest go on in order");
  pass("the chat model: unread, order, mute, merge and the queue");
}

const chatsOf = async (who: Player) => (await who.call("/api/chat")).body.chats as ChatEntry[];
const rowOf = async (who: Player, roomId: string) => (await chatsOf(who)).find((c) => c.roomId === roomId);
const textsIn = async (who: Player, roomId: string, after = 0) => ((await who.call("/api/chat/open", { roomId, after })).body.messages as ChatMessage[]).map((m) => m.text);
const send = (who: Player, roomId: string, msgId: string, text: string) => who.call("/api/chat/send", { roomId, msgId, text });

async function apiChecks() {
  const { worker, base } = await startApi();
  const sockets: WebSocket[] = [];
  try {
    const terry = await player(base, "Terry Bass");
    const mike = await player(base, "Mike Keys");
    const dana = await player(base, "Dana Drums");
    const ann = await player(base, "Ann Horn");
    const eve = await player(base, "Eve Spam");

    assert.equal((await new Phone(base).call("/api/chat")).status, 401, "a signed-out phone has no Messages list");
    assert.equal((await new Phone(base).call("/api/chat/send", { roomId: "band_AAAAAAAAAAAAAAAAAAAAAA", msgId: "abcdefgh", text: "hi" })).status, 401, "and can't post");

    const band = await terry.call("/api/bands/create", { name: "The Blue Notes" });
    const bandId = band.body.bandId as string;
    const code = (await terry.call("/api/codes", { kind: "band", bandId })).body.code as string;
    assert.equal((await mike.call("/api/bands/join", { code })).status, 200, "Mike joins");
    assert.deepEqual((await chatsOf(terry)).map((c) => [c.kind, c.title, unread(c)]), [["band", "The Blue Notes", 0]], "a new band is on its maker's Messages list");
    assert.deepEqual((await chatsOf(mike)).map((c) => [c.kind, c.title, unread(c)]), [["band", "The Blue Notes", 0]], "and on a member's once they join");
    pass("a band thread is listed from the moment you are in the band");

    for (const [what, reply] of [
      ["read", await dana.call("/api/chat/open", { roomId: bandId })],
      ["post in", await send(dana, bandId, "danamessage1", "Let me in")],
    ] as const) {
      assert.deepEqual([reply.status, reply.body.error], [403, "not-a-member"], `someone outside the band can't ${what} its thread`);
    }
    assert.deepEqual(await textsIn(terry, bandId), [], "and nothing of hers was stored");

    const first = await send(terry, bandId, "terrymessage1", "Rehearsal Friday at 7");
    assert.equal(first.status, 200, "Terry posts in the band");
    assert.deepEqual([first.body.message.seq, first.body.message.fromName, first.body.message.text], [1, "Terry Bass", "Rehearsal Friday at 7"], "and gets the stored message back");
    const again = await send(terry, bandId, "terrymessage1", "Rehearsal Friday at 7");
    assert.equal(again.body.message.seq, 1, "sending the same msgId again returns the same message");
    assert.deepEqual(await textsIn(mike, bandId), ["Rehearsal Friday at 7"], "so the thread holds it once");
    const mikesRow = (await rowOf(mike, bandId))!;
    assert.deepEqual([unread(mikesRow), mikesRow.preview, mikesRow.lastSeq], [1, "Terry Bass: Rehearsal Friday at 7", 1], "Mike's list shows one unread with the preview");
    assert.equal(unread((await rowOf(terry, bandId))!), 0, "Terry's own message is not unread for Terry");
    pass("the same msgId twice stores one message, and unread counts it once");

    const mikeInBand = await openSocket(mike, bandId);
    sockets.push(mikeInBand.ws);
    assert.ok(mikeInBand.opened, "Mike's phone is on the band room's socket");
    const second = await send(terry, bandId, "terrymessage2", "Bring the charts");
    const live = await eventually(async () => mikeInBand.received.find((m) => m.kind === "message"), (m) => !!m, "the message reaches Mike's socket");
    assert.deepEqual((live!.message as ChatMessage).seq, second.body.message.seq, "with the same seq the sender was given");
    assert.equal((await mike.call("/api/chat/read", { roomId: bandId, seq: 2 })).status, 200, "Mike marks it read");
    assert.equal(unread((await rowOf(mike, bandId))!), 0, "and his unread count is 0");
    assert.equal((await send(mike, bandId, "mikemessage1", "On it")).body.message.seq, 3, "Mike replies");
    assert.deepEqual(await textsIn(terry, bandId, 2), ["On it"], "open after a seq returns only what came later");
    assert.deepEqual(await textsIn(terry, bandId), ["Rehearsal Friday at 7", "Bring the charts", "On it"], "the whole thread stays in order");
    pass("a posted message reaches open sockets and read moves the count");

    const until = Date.now() + MUTE_8H;
    assert.equal((await mike.call("/api/chat/mute", { roomId: bandId, mutedUntil: until })).status, 200, "Mike mutes the band");
    assert.equal((await rowOf(mike, bandId))!.mutedUntil, until, "his list shows until when");
    assert.equal((await rowOf(terry, bandId))!.mutedUntil, null, "Terry's does not");
    await mike.call("/api/chat/mute", { roomId: bandId, mutedUntil: null });
    assert.equal((await rowOf(mike, bandId))!.mutedUntil, null, "Unmute clears it");
    assert.equal((await mike.call("/api/chat/mute", { roomId: bandId, mutedUntil: "forever" })).body.error, "bad-request", "a mute needs a time or null");
    pass("mute is per person and per thread");

    for (const [what, body] of [
      ["an empty message", { roomId: bandId, msgId: "terrymessage3", text: "   " }],
      ["a message over the limit", { roomId: bandId, msgId: "terrymessage3", text: "x".repeat(2001) }],
      ["a short msgId", { roomId: bandId, msgId: "x", text: "hi" }],
      ["a room id that isn't one", { roomId: "nope", msgId: "terrymessage3", text: "hi" }],
    ] as const) {
      assert.equal((await terry.call("/api/chat/send", body)).body.error, "bad-request", `${what} is refused`);
    }
    assert.equal((await textsIn(terry, bandId)).length, 3, "and none of them was stored");

    await terry.call("/api/bands/remove", { bandId, userId: mike.userId });
    assert.equal(await serverClose(mikeInBand, "Mike's socket"), NOT_A_MEMBER_CLOSE, "removing Mike closes his band socket at once");
    const stillHere = await send(mike, bandId, "mikemessage2", "Still here?");
    assert.deepEqual([stillHere.status, stillHere.body.error], [403, "not-a-member"], "his next post is refused");
    assert.equal((await mike.call("/api/chat/open", { roomId: bandId })).body.error, "not-a-member", "and so is reading");
    assert.deepEqual(await chatsOf(mike), [], "the band is off his Messages list");
    assert.equal((await rowOf(terry, bandId))!.lastSeq, 3, "while Terry's list still has the thread");
    assert.equal((await openSocket(mike, bandId)).opened, false, "a new socket from Mike is refused");
    pass("a removed member is refused at once");

    await mike.call("/api/friends/request", { handle: terry.handle });
    await terry.call("/api/friends/accept", { userId: mike.userId });
    const dm = await terry.call("/api/chat/dm", { userId: mike.userId });
    assert.equal(dm.status, 200, "Terry opens a DM with his friend Mike");
    const dmId = dm.body.roomId as string;
    assert.ok(/^dm_[A-Za-z0-9_-]{22}$/.test(dmId) && dm.body.title === "Mike Keys", `the DM room is named for the pair, not a person (${dmId})`);
    assert.equal((await mike.call("/api/chat/dm", { userId: terry.userId })).body.roomId, dmId, "Mike asking for Terry gets the same thread");
    assert.equal((await terry.call("/api/chat/dm", { userId: mike.userId })).body.roomId, dmId, "and asking twice makes no second one");
    assert.deepEqual((await chatsOf(terry)).map((c) => [c.kind, c.title]), [["dm", "Mike Keys"], ["band", "The Blue Notes"]], "the empty DM is on Terry's list, newest first");
    assert.deepEqual(await textsIn(mike, dmId), [], "Mike can read the empty thread");
    const hey = await send(terry, dmId, "terrydm1", "Hey Mike");
    assert.equal(hey.body.message.seq, 1, "Terry writes first");
    const mikesDm = await eventually(() => rowOf(mike, dmId), (row) => !!row, "the DM reaches Mike's list");
    assert.deepEqual([mikesDm!.kind, mikesDm!.title, unread(mikesDm!), mikesDm!.preview], ["dm", "Terry Bass", 1, "Terry Bass: Hey Mike"], "titled with Terry's name, one unread");
    assert.equal((await send(mike, dmId, "mikedm0001", "Hey!")).status, 200, "Mike answers");
    assert.deepEqual(await textsIn(terry, dmId), ["Hey Mike", "Hey!"], "both see the one thread");
    pass("one DM thread per pair of friends");

    const peek = await dana.call("/api/chat/open", { roomId: dmId });
    assert.deepEqual([peek.status, peek.body.error], [403, "not-a-member"], "someone else can't read a DM");
    assert.equal((await send(dana, dmId, "danadm0001", "hi")).body.error, "not-a-member", "or post in it");
    assert.equal((await openSocket(dana, dmId)).opened, false, "or join its socket");
    const stranger = await terry.call("/api/chat/dm", { userId: ann.userId });
    assert.deepEqual([stranger.status, stranger.body.error], [403, "not-friends"], "a DM with someone who is neither a friend nor a bandmate is refused");
    assert.equal((await terry.call("/api/chat/dm", { userId: terry.userId })).body.error, "yourself", "nobody DMs themselves");
    assert.equal((await terry.call("/api/chat/dm", { userId: "nobody" })).status, 404, "or an unknown person");
    assert.equal((await ann.call("/api/bands/join", { code })).status, 200, "Ann joins the band");
    assert.equal((await terry.call("/api/chat/dm", { userId: ann.userId })).status, 200, "and bandmates can DM without being friends");
    assert.equal((await terry.call("/api/bands/remove", { bandId, userId: ann.userId })).status, 200, "Terry removes Ann");
    assert.equal((await ann.call("/api/chat/dm", { userId: terry.userId })).body.error, "not-friends", "out of the band, the DM is refused again");
    pass("DMs are for friends and bandmates only");

    await eve.call("/api/friends/request", { handle: terry.handle });
    await terry.call("/api/friends/block", { userId: eve.userId });
    assert.equal((await eve.call("/api/chat/dm", { userId: terry.userId })).body.error, "not-friends", "a blocked person can't open a DM");
    await terry.call("/api/friends/block", { userId: mike.userId });
    assert.equal((await send(mike, dmId, "mikedm0002", "Hello?")).body.error, "not-friends", "blocking a friend stops their posts in the old DM");
    assert.equal((await send(terry, dmId, "terrydm2", "Go away")).body.error, "not-friends", "and the blocker's own");
    assert.equal((await mike.call("/api/chat/open", { roomId: dmId })).body.error, "not-friends", "and neither can read the old thread any more");
    pass("a block closes the DM both ways");
  } finally {
    for (const ws of sockets) ws.close();
    await worker.dispose();
  }
}

async function appChecks() {
  let apiBase = "";
  const site = await openSite(root, "check-chat", () => apiBase);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
  apiBase = base;
  try {
    const app = await appPage(site);
    const view = (name: string) => app.until(`document.querySelector(".chat-sheet")?.dataset.view === ${JSON.stringify(name)} && !document.querySelector(".chat-sheet").textContent.includes("Loading")`, `the ${name} view`, 15000);
    const bubbles = () => app.texts(".chat-bubble");
    const waiting = () => site.evaluate<number>(`document.querySelectorAll(".chat-waiting").length`);
    const fitsPhone = async (what: string) => {
      const fit = await app.fits();
      assert.ok(fit.page <= WIDTH && fit.left >= 0 && fit.right <= WIDTH, `${what} fits the phone with no sideways scroll (${JSON.stringify(fit)})`);
    };
    const offline = (on: boolean) => site.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const appCalls = (path: string, body: object) =>
      site.evaluate<{ status: number; body: Record<string, any> }>(
        `fetch(${JSON.stringify(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`,
      );
    const openRow = async (title: string) => {
      const found = await site.evaluate<boolean>(`(() => { const row = [...document.querySelectorAll(".chat-row")].find((b) => b.querySelector(".chat-row-title")?.textContent === ${JSON.stringify(title)}); row?.click(); return !!row; })()`);
      assert.ok(found, `a ${title} row to tap`);
      await settle();
    };
    const openMessages = async () => {
      await app.openMenu();
      await app.pick("Messages");
      await view("list");
    };
    const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
    const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
    const terryReads = async (roomId: string) => ((await terry.call("/api/chat/open", { roomId })).body.messages as ChatMessage[]);

    await site.send("Network.enable");
    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await site.evaluate("Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((done) => setTimeout(done, 20000, false))])");
    if (!(await site.evaluate<boolean>("!!navigator.serviceWorker.controller"))) await site.send("Page.reload");
    await app.until("!!navigator.serviceWorker?.controller", "the service worker to take control of the page", 60000);
    await app.library();
    assert.deepEqual(await app.openMenu(), ["Sign in"], "signed out, the More menu has no Messages");
    await app.closeMenu();
    await app.signUp("Sam Rivera");
    assert.deepEqual(await app.openMenu(), ["Account", "Friends", "Bands", "Messages"], "signed in, Messages sits after Bands");
    await app.pick("Messages");
    await view("list");
    assert.match(await app.text(".chat-sheet"), /No messages yet/, "a new player has no threads");
    await fitsPhone("Messages");
    await app.shot(shots && `${shots}/chat-empty.png`);
    await app.click("✕");
    pass("Messages opens from the More menu");

    const bandId = (await terry.call("/api/bands/create", { name: "The Blue Notes" })).body.bandId as string;
    const code = (await terry.call("/api/codes", { kind: "band", bandId })).body.code as string;
    assert.equal((await appCalls("/api/bands/join", { code })).status, 200, "Sam joins Terry's band");
    await openMessages();
    assert.deepEqual(await app.texts(".chat-row-title"), ["The Blue Notes"], "the band is on Sam's Messages list");
    await openRow("The Blue Notes");
    await view("thread");
    assert.equal(await app.text(".chat-sheet h2"), "The Blue Notes", "the thread opens");
    await app.type("Message", "Hello band");
    await app.click("Send");
    await app.until(`[...document.querySelectorAll(".chat-bubble")].some((b) => b.textContent.includes("Hello band"))`, "Sam's bubble");
    const stored = await eventually(() => terryReads(bandId), (list) => list.length === 1, "Terry's phone sees Sam's message");
    assert.deepEqual([stored[0].fromName, stored[0].text], ["Sam Rivera", "Hello band"], "from Sam, as typed");
    assert.equal(await waiting(), 0, "nothing is waiting to send");
    await terry.call("/api/chat/send", { roomId: bandId, msgId: "terryhello0001", text: "Welcome Sam" });
    await app.until(`[...document.querySelectorAll(".chat-bubble")].some((b) => b.textContent.includes("Welcome Sam"))`, "Terry's message arriving live", 8000);
    assert.deepEqual(await app.texts(".chat-name"), ["You", "Terry Bass"], "each bubble names who wrote it");
    await fitsPhone("a thread");
    await app.shot(shots && `${shots}/chat-thread.png`);
    pass("a thread sends and receives live");

    await app.until("!!navigator.serviceWorker?.controller", "the service worker still in control before the signal goes");
    await offline(true);
    await app.type("Message", "first offline");
    await app.click("Send");
    await app.type("Message", "second offline");
    await app.click("Send");
    await app.until(`document.querySelectorAll(".chat-waiting").length === 2`, "two messages waiting");
    assert.deepEqual((await bubbles()).slice(-2), ["first offline", "second offline"], "both show in the thread, in order");
    await app.shot(shots && `${shots}/chat-waiting.png`);
    assert.equal((await terryReads(bandId)).length, 2, "the server has neither yet");
    await offline(false);
    const after = await eventually(() => terryReads(bandId), (list) => list.length >= 4, "the queue sends when signal returns", 20000);
    assert.deepEqual(after.map((m) => m.text), ["Hello band", "Welcome Sam", "first offline", "second offline"], "once each, in writing order");
    assert.equal(new Set(after.map((m) => m.msgId)).size, 4, "with four distinct ids");
    await app.until(`document.querySelectorAll(".chat-waiting").length === 0`, "the clocks clearing");
    await sleep(1500);
    assert.equal((await terryReads(bandId)).length, 4, "and nothing is sent twice");
    pass("messages written offline go out once, in order, when signal returns");

    await app.click("Mute");
    await app.click("8 hours");
    await app.until(`document.querySelector(".chat-sheet")?.textContent.includes("Muted")`, "the muted state");
    await app.click("Back");
    await view("list");
    assert.equal(await site.evaluate<number>(`document.querySelectorAll(".chat-row .chat-muted").length`), 1, "the muted thread shows it on the list");
    await app.click("✕");
    await terry.call("/api/chat/send", { roomId: bandId, msgId: "terryhello0002", text: "Another one" });
    await openMessages();
    assert.deepEqual(await app.texts(".chat-row .chat-badge"), ["1"], "a new message shows as one unread on the list");
    await app.shot(shots && `${shots}/chat-list.png`);
    await openRow("The Blue Notes");
    await view("thread");
    assert.ok(await site.evaluate<boolean>(`(() => { const line = document.querySelector(".chat-new-line"); return !!line && line.parentElement.querySelector(".chat-bubble").textContent === "Another one"; })()`), "the New messages line sits above the unread message");
    await app.click("Back");
    await view("list");
    await app.until(`document.querySelectorAll(".chat-row .chat-badge").length === 0`, "the badge clearing");
    pass("mute, unread badge and the New messages line");

    await app.click("✕");
    await app.openMenu();
    await app.pick("Bands");
    await app.until(`document.querySelector(".bands-sheet")?.dataset.view === "list" && document.querySelectorAll(".bands-list li").length > 0`, "the Bands list");
    await app.click("Open");
    await app.until(`document.querySelectorAll(".bands-members li").length === 2`, "the Members list");
    await app.click("Message", `[...document.querySelectorAll(".bands-members li")].find((li) => li.textContent.startsWith("Terry Bass"))`);
    await view("thread");
    assert.equal(await app.text(".chat-sheet h2"), "Terry Bass", "Message on a bandmate opens a DM with them");
    assert.ok(!(await site.evaluate<boolean>(`!!document.querySelector(".bands-sheet")`)), "and the Bands sheet is gone");
    await app.type("Message", "Hi Terry");
    await app.click("Send");
    const dm = await eventually(() => terry.call("/api/chat").then((r) => (r.body.chats as ChatEntry[]).find((c) => c.kind === "dm")), (row) => !!row, "the DM reaches Terry");
    assert.deepEqual([dm!.title, dm!.preview], ["Sam Rivera", "Sam Rivera: Hi Terry"], "titled with Sam's name");
    pass("Message from a band's Members list opens the DM");

    await app.click("✕");
    const me = () => site.evaluate<{ account: { userId: string; handle: string } }>(`fetch("/api/me").then((r) => r.json())`).then((reply) => reply.account);
    const sam = await me();
    assert.equal((await mike.call("/api/friends/request", { handle: sam.handle })).status, 200, "Mike asks Sam to be friends");
    assert.equal((await appCalls("/api/friends/accept", { userId: mike.userId })).status, 200, "Sam accepts Mike's request");
    await app.openMenu();
    await app.pick("Friends");
    await app.until(`document.querySelectorAll(".friends-friends li").length === 1`, "Mike on the Friends list");
    await app.click("Message", "document.querySelector('.friends-friends li')");
    await view("thread");
    assert.equal(await app.text(".chat-sheet h2"), "Mike Keys", "Message on a friend opens a DM with them");
    assert.equal((await mike.call("/api/chat/dm", { userId: sam.userId })).status, 200, "and Mike can open the same one");
    pass("Message from Friends opens the DM");

    await app.click("Back");
    await view("list");
    assert.deepEqual(await app.texts(".chat-row-title"), ["Mike Keys", "Terry Bass", "The Blue Notes"], "the list has both DMs and the band, newest first");
    await openRow("The Blue Notes");
    await view("thread");
    await offline(true);
    await app.type("Message", "Sam's late one");
    await app.click("Send");
    await app.until(`document.querySelectorAll(".chat-waiting").length === 1`, "Sam's message waiting");
    // Chrome lets a send that failed under offline emulation out once the emulation ends, so nothing answers the API during the switch.
    apiBase = "http://127.0.0.1:9";
    await site.send("Page.navigate", { url: "about:blank" });
    await site.send("Network.clearBrowserCookies");
    await offline(false);
    await sleep(1000);
    apiBase = base;
    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await app.library();
    await eventually(me, (who) => who === undefined, "the server to say nobody is signed in on this phone");
    await app.signUp("Pat Lee");
    const pat = await me();
    assert.equal((await appCalls("/api/bands/join", { code })).status, 200, "Pat joins the band on the same phone");
    await openMessages();
    await openRow("The Blue Notes");
    await view("thread");
    assert.equal(await waiting(), 0, "Pat's thread shows nothing of Sam's waiting");
    await sleep(1500);
    const bandLines = (await terryReads(bandId)).map((m) => `${m.fromName}: ${m.text}`);
    assert.ok(!bandLines.some((line) => !line.startsWith("Sam Rivera:") && line.endsWith("Sam's late one")), `Sam's unsent message is never sent as anyone but Sam while Pat is signed in (${JSON.stringify(bandLines)})`);
    assert.match(await site.evaluate<string>(`localStorage.getItem("leadSheetsChatQueue") ?? ""`), /Sam's late one/, "and is still kept for Sam");
    pass("another account on the same phone never sends what Sam wrote offline");

    await terry.call("/api/bands/remove", { bandId, userId: pat.userId });
    await app.until(`document.querySelector(".chat-sheet")?.textContent.includes("not in this band")`, "the thread closing on removal", 8000);
    await view("list");
    assert.match(await app.text(".chat-sheet"), /No messages yet/, "the band leaves Pat's list");
    pass("a removed member's open thread closes at once");

    await app.click("✕");
    await settle();
    assert.deepEqual(await app.errors(), [], "no page errors");
  } finally {
    await site.close();
    await worker.dispose();
  }
}

await modelChecks();
await apiChecks();
await appChecks();
console.log("check:chat passed");
