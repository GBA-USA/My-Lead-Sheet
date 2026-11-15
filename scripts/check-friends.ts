import assert from "node:assert/strict";
import jsQR from "jsqr";
import { Phone, startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle, WIDTH } from "./app-page.ts";
import { openSite } from "./chrome.ts";

const MINUTE_MS = 100;
const root = new URL("..", import.meta.url).pathname;
/** Set SHOTS to a folder to save the menu and Friends screens at phone size. */
const shots = process.env.SHOTS;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const pass = (message: string) => console.log(`ok   ${message}`);

type Person = { userId: string; handle: string; name: string };

async function player(base: string, name: string) {
  const phone = new Phone(base);
  const made = await phone.createAccount(name);
  assert.equal(made.status, 200, `${name} signs up`);
  return Object.assign(phone, { name, handle: made.body.account.handle as string, userId: made.body.account.userId as string });
}
type Player = Awaited<ReturnType<typeof player>>;

const names = (people: Person[]) => people.map((person) => person.name);
async function listsOf(who: Player) {
  const { status, body } = await who.call("/api/friends");
  assert.equal(status, 200, `${who.name} reads their friends`);
  return { friends: names(body.friends), requests: names(body.requests) };
}
const code = async (who: Player, kind: "friend-now" | "friend-link") => (await who.call("/api/codes", { kind })).body.code as string;

async function apiChecks() {
  const { worker, base } = await startApi({ CODE_MINUTE_MS: String(MINUTE_MS) });
  try {
    const terry = await player(base, "Terry Bass");
    const mike = await player(base, "Mike Keys");
    const dana = await player(base, "Dana Drums");
    const ann = await player(base, "Ann Horn");
    const lee = await player(base, "Lee Sax");
    const eve = await player(base, "Eve Spam");

    assert.equal((await new Phone(base).call("/api/friends")).status, 401, "a signed-out phone has no friends list");

    const byName = await mike.call("/api/friends/request", { handle: ` @${terry.handle.toUpperCase()} ` });
    assert.deepEqual([byName.status, byName.body.outcome], [200, "requested"], "an @name request is sent, whatever its case and spaces");
    assert.deepEqual(await listsOf(mike), { friends: [], requests: [] }, "the asker has no new friend yet");
    assert.deepEqual(await listsOf(terry), { friends: [], requests: ["Mike Keys"] }, "the request waits for Terry");
    assert.deepEqual((await mike.call("/api/friends/request", { handle: terry.handle })).body.outcome, "requested", "asking twice still waits");
    assert.deepEqual((await terry.call("/api/friends/accept", { userId: mike.userId })).body.friends.map((p: Person) => p.name), ["Mike Keys"], "Terry accepts");
    assert.deepEqual(await listsOf(mike), { friends: ["Terry Bass"], requests: [] }, "and both are friends");
    assert.deepEqual((await mike.call("/api/friends/request", { handle: terry.handle })).body.outcome, "already-friends", "asking a friend says so");
    assert.deepEqual((await mike.call("/api/friends/request", { handle: "nobodyhere" })).body.error, "no-such-handle", "an unknown @name is refused");
    assert.deepEqual((await mike.call("/api/friends/request", { handle: mike.handle })).body.error, "yourself", "nobody can friend themselves");
    assert.deepEqual((await mike.call("/api/friends/accept", { userId: dana.userId })).body.error, "no-request", "accepting a request nobody sent is refused");
    pass("an @name request waits for accept");

    const inPerson = await code(terry, "friend-now");
    const preview = await dana.call("/api/friends/code", { code: inPerson });
    assert.deepEqual([preview.body.kind, preview.body.name, preview.body.handle], ["friend-now", "Terry Bass", terry.handle], "scanning Terry's code shows who it adds, once the server checked it");
    const scanned = await dana.call("/api/friends/add-by-code", { code: inPerson });
    assert.deepEqual([scanned.status, scanned.body.outcome], [200, "requested"], "a code scanned in person sends a request (t555u)");
    assert.deepEqual(await listsOf(dana), { friends: [], requests: [] }, "the scanner is not friends at once");
    assert.deepEqual(await listsOf(terry), { friends: ["Mike Keys"], requests: ["Dana Drums"] }, "the code's owner gets a request to accept");
    await terry.call("/api/friends/accept", { userId: dana.userId });
    assert.deepEqual((await listsOf(dana)).friends, ["Terry Bass"], "after Terry accepts they are friends");
    assert.deepEqual((await terry.call("/api/friends/add-by-code", { code: inPerson })).body.error, "yourself", "scanning your own code adds nobody");
    pass("a code scanned in person sends a request that waits for accept, never instant friends");

    const link = await code(terry, "friend-link");
    const opened = await ann.call("/api/friends/add-by-code", { code: link });
    assert.deepEqual([opened.status, opened.body.outcome], [200, "friends"], "a link code sends a request Terry already approved");
    assert.deepEqual((await listsOf(ann)).friends, ["Terry Bass"], "so Ann and Terry are friends");
    assert.ok((await listsOf(terry)).friends.includes("Ann Horn"), "on both sides");
    pass("a link code sends a pre-approved request");

    await lee.call("/api/friends/request", { handle: terry.handle });
    assert.deepEqual((await terry.call("/api/friends/decline", { userId: lee.userId })).body.requests, [], "Terry declines Lee");
    assert.deepEqual((await listsOf(lee)).friends, [], "a declined request makes no friend");
    await lee.call("/api/friends/request", { handle: dana.handle });
    assert.deepEqual((await dana.call("/api/friends/request", { handle: lee.handle })).body.outcome, "friends", "two people asking each other are friends");
    pass("decline drops a request, and asking each other makes friends");

    const stopped = await code(terry, "friend-link");
    await terry.call("/api/codes/stop", { code: stopped });
    assert.deepEqual((await lee.call("/api/friends/add-by-code", { code: stopped })).body.error, "code-stopped", "a stopped link is refused");
    const short = await code(terry, "friend-now");
    await sleep(10 * MINUTE_MS + 200);
    assert.deepEqual((await lee.call("/api/friends/add-by-code", { code: short })).body.error, "code-ended", "an expired code is refused");
    assert.deepEqual(await listsOf(terry), { friends: ["Ann Horn", "Dana Drums", "Mike Keys"], requests: [] }, "neither refused code reached Terry");
    pass("an expired or stopped code is refused");

    await eve.call("/api/friends/request", { handle: terry.handle });
    assert.deepEqual((await terry.call("/api/friends/block", { userId: eve.userId })).body.requests, [], "Terry blocks Eve from her request");
    const freshLink = await code(terry, "friend-link");
    const freshNow = await code(terry, "friend-now");
    for (const [way, attempt] of [
      ["an @name request", () => eve.call("/api/friends/request", { handle: terry.handle })],
      ["a code scanned in person", () => eve.call("/api/friends/add-by-code", { code: freshNow })],
      ["a pre-approved link", () => eve.call("/api/friends/add-by-code", { code: freshLink })],
    ] as const) {
      const tried = await attempt();
      assert.deepEqual([tried.status, tried.body.outcome], [200, "requested"], `${way} from a blocked user looks sent, so the block isn't revealed`);
      assert.deepEqual(await listsOf(eve), { friends: [], requests: [] }, `${way} makes Eve no friend`);
      assert.deepEqual((await listsOf(terry)).requests, [], `${way} reaches Terry as nothing`);
    }
    assert.deepEqual((await eve.call("/api/friends/block", { userId: terry.userId })).status, 200, "Eve blocking back changes nothing");
    assert.deepEqual((await terry.call("/api/friends/request", { handle: eve.handle })).body.outcome, "requested", "and the blocker can't add her either");
    assert.deepEqual((await listsOf(eve)).requests, [], "so Eve gets no request");

    await terry.call("/api/friends/block", { userId: mike.userId });
    assert.ok(!(await listsOf(terry)).friends.includes("Mike Keys"), "blocking a friend ends the friendship");
    assert.deepEqual((await listsOf(mike)).friends, [], "on both sides");
    assert.deepEqual((await mike.call("/api/friends/add-by-code", { code: freshLink })).body.outcome, "requested", "a blocked friend can't come back by link");
    assert.deepEqual((await listsOf(mike)).friends, [], "and stays off the list");
    assert.deepEqual((await terry.call("/api/friends/block", { userId: "nobody" })).body.error, "not-found", "blocking an unknown id is refused");
    pass("a blocked user can't add you any way");
  } finally {
    await worker.dispose();
  }
}

/** Reads the QR code on screen the way another phone's camera would: from the drawn squares, not from the app's state. */
function readQr(svg: string): string {
  const size = Number(/width="(\d+)"/.exec(svg)![1]);
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const [, x, y, side] of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="\d+" fill="black"/g)) {
    for (let row = Number(y); row < Number(y) + Number(side); row += 1) {
      for (let col = Number(x); col < Number(x) + Number(side); col += 1) pixels.fill(0, (row * size + col) * 4, (row * size + col) * 4 + 3);
    }
  }
  const found = jsQR(pixels, size, size);
  assert.ok(found, "the QR code on screen decodes");
  return found.data;
}

async function appChecks() {
  let apiBase = "";
  const site = await openSite(root, "check-friends", () => apiBase);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
  apiBase = base;
  try {
    const app = await appPage(site);
    const view = (name: string) => app.until(`document.querySelector(".friends-sheet")?.dataset.view === ${JSON.stringify(name)}`, `the ${name} view`);
    const listed = (which: "friends" | "requests") => app.texts(`.friends-${which} li > span:first-child`);
    const noticed = (pattern: string) => app.until(`new RegExp(${JSON.stringify(pattern)}).test(document.querySelector(".friends-notice")?.textContent ?? "")`, `the notice ${pattern}`);
    const fitsPhone = async (what: string) => {
      const fit = await app.fits();
      assert.ok(fit.page <= WIDTH && fit.left >= 0 && fit.right <= WIDTH, `${what} fits the phone with no sideways scroll (${JSON.stringify(fit)})`);
    };
    const openFriends = async () => {
      await app.openMenu();
      await app.pick("Friends");
      await view("list");
      await app.until(`!document.querySelector(".friends-sheet")?.textContent.includes("Loading")`, "the friends list");
    };
    const reopenFriends = async () => {
      await app.click("✕");
      await openFriends();
    };
    const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
    const dana = await passwordPlayer(base, origin, "Dana Drums", "danadrums");
    const eve = await passwordPlayer(base, origin, "Eve Spam", "evespam");
    const ann = await passwordPlayer(base, origin, "Ann Horn", "annhorn");
    const namesOf = async (who: Phone, which: "friends" | "requests") => names((await who.call("/api/friends")).body[which]);

    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await app.library();
    assert.deepEqual(await app.openMenu(), ["Sign in"], "signed out, the More menu holds only Sign in");
    await app.shot(shots && `${shots}/menu-signed-out.png`);
    await app.closeMenu();
    const early = await site.evaluate<string[]>(`performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => name.includes("/api/"))`);
    assert.deepEqual(early, [], "signed-out use still calls no API");
    pass("signed out, there is no Friends item and the app is unchanged");

    await app.signUp("Sam Rivera");
    assert.deepEqual(await app.openMenu(), ["Account", "Friends"], "signed in, Friends sits next to Account");
    await app.shot(shots && `${shots}/menu-signed-in.png`);
    await app.closeMenu();
    await site.send("Page.reload");
    await app.library();
    await app.until(`(document.querySelector(".shell-header [aria-label=More]").click(), [...document.querySelectorAll("[role=menu] [role=menuitem]")].some((b) => b.textContent === "Friends"))`, "Friends after a reload");
    await app.closeMenu();
    pass("signed in, the More menu offers Friends, also after a reload");

    await openFriends();
    assert.match(await app.text(".friends-sheet"), /No friends yet/, "a new player has no friends yet");
    await fitsPhone("Friends");
    await app.shot(shots && `${shots}/friends-empty.png`);
    await app.type("Add by @name", "@mikekeys");
    await app.click("Send request");
    await noticed("Request sent\\. @mikekeys needs to accept\\.");
    assert.deepEqual(await namesOf(mike, "requests"), ["Sam Rivera"], "the @name request reached Mike");
    assert.deepEqual(await listed("friends"), [], "and waits for him: Sam has no friend yet");
    await mike.call("/api/friends/accept", { userId: (await mike.call("/api/friends")).body.requests[0].userId });
    await reopenFriends();
    assert.deepEqual(await listed("friends"), ["Mike Keys@mikekeys"], "once Mike accepts, he is on Sam's list");
    pass("Add by @name sends a request that waits for accept");

    const sam = (await mike.call("/api/friends")).body.friends[0] as Person;
    await dana.call("/api/friends/request", { handle: sam.handle });
    await reopenFriends();
    assert.deepEqual(await listed("requests"), ["Dana Drums@danadrums"], "Dana's request waits in Requests");
    await app.shot(shots && `${shots}/friends-request.png`);
    await app.click("Accept", "document.querySelector('.friends-requests')");
    await app.until(`document.querySelectorAll(".friends-friends li").length === 2`, "Dana on the list");
    assert.deepEqual(await listed("friends"), ["Dana Drums@danadrums", "Mike Keys@mikekeys"], "Accept makes Dana a friend");
    assert.deepEqual(await namesOf(dana, "friends"), ["Sam Rivera"], "on both sides");
    pass("a request waiting in Requests can be accepted");

    await app.click("Show my code");
    await view("show");
    await app.until(`!!document.querySelector(".codes-qr svg")`, "the QR code");
    assert.equal(await app.text(".codes-words"), "Add Sam Rivera as a friend", "the code says what it does");
    assert.match(await app.text(".friends-sheet"), /Ends \d/, "and when it ends");
    await fitsPhone("Show my code");
    await app.shot(shots && `${shots}/friends-show-code.png`);
    const shownLink = readQr(await site.evaluate<string>(`document.querySelector(".codes-qr").innerHTML`));
    assert.ok(shownLink.startsWith(`${origin}/c/friend-now.`), `the QR code is an in-person code link (${shownLink})`);
    assert.ok(!/sam|rivera/i.test(shownLink), "with no name in it");
    const shown = shownLink.slice(`${origin}/c/`.length);
    assert.deepEqual((await eve.call("/api/friends/add-by-code", { code: shown })).body.outcome, "requested", "Eve scans Sam's code in person and it sends a request");
    assert.deepEqual(await namesOf(eve, "friends"), [], "so Eve is not Sam's friend yet");
    await app.click("Stop this code");
    await view("list");
    await noticed("Code stopped");
    assert.deepEqual((await ann.call("/api/friends/add-by-code", { code: shown })).body.error, "code-stopped", "after Stop this code nobody can use it");
    pass("Show my code shows a working in-person code that sends a request, and Stop this code ends it");

    assert.deepEqual(await listed("requests"), ["Eve Spam@evespam"], "Eve's scan waits in Requests");
    await app.click("Block", "document.querySelector('.friends-requests')");
    await app.until(`!document.querySelector(".friends-requests")`, "Requests cleared");
    await eve.call("/api/friends/request", { handle: sam.handle });
    await reopenFriends();
    assert.ok(!(await app.texts(".friends-sheet li")).some((row) => row.includes("Eve")), "a blocked player's next request never shows");
    pass("Block from Requests keeps that player out");

    await app.click("Share link");
    await view("show");
    await app.until(`!!document.querySelector(".codes-link")`, "the shared link");
    const sharedLink = await app.text(".codes-link");
    assert.equal(readQr(await site.evaluate<string>(`document.querySelector(".codes-qr").innerHTML`)), sharedLink, "the link and its QR code match");
    await app.shot(shots && `${shots}/friends-share-link.png`);
    assert.deepEqual((await ann.call("/api/friends/add-by-code", { code: sharedLink.slice(`${origin}/c/`.length) })).body.outcome, "friends", "Ann opens the shared link and is Sam's friend at once");
    await app.click("Back");
    await reopenFriends();
    assert.deepEqual(await listed("friends"), ["Ann Horn@annhorn", "Dana Drums@danadrums", "Mike Keys@mikekeys"], "Ann is on Sam's list");
    pass("Share link sends a pre-approved request");

    await app.click("Block", "document.querySelector('.friends-friends li')");
    await app.click("Yes, block", "document.querySelector('.friends-friends li')");
    await app.until(`document.querySelectorAll(".friends-friends li").length === 2`, "Ann off the list");
    assert.deepEqual(await namesOf(ann, "friends"), [], "blocking a friend ends it on both sides");
    pass("a friend can be blocked, after a second tap");

    await app.click("✕");
    await app.openMenu();
    await app.pick("Account");
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "account"`, "the account screen");
    await app.click("Sign out");
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "start"`, "the sign-in screen");
    await app.click("✕");
    assert.deepEqual(await app.openMenu(), ["Sign in"], "after Sign out the Friends item is gone");
    await app.closeMenu();
    await site.send("Page.reload");
    await app.library();
    await settle(500);
    assert.deepEqual(await app.openMenu(), ["Sign in"], "and stays gone after a reload");
    pass("signing out takes Friends away again");

    assert.deepEqual(await app.errors(), [], "no page errors");
  } finally {
    await site.close();
    await worker.dispose();
  }
}

await apiChecks();
await appChecks();
console.log("check:friends passed");
