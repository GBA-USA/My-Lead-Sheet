import assert from "node:assert/strict";
import { Phone, startApi, TEST_ORIGIN } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, readQr, settle, WIDTH } from "./app-page.ts";
import { openSite } from "./chrome.ts";

const root = new URL("..", import.meta.url).pathname;
/** Set SHOTS to a folder to save the Bands screens at phone size. */
const shots = process.env.SHOTS;
const pass = (message: string) => console.log(`ok   ${message}`);
const NOT_A_MEMBER_CLOSE = 4403;

async function player(base: string, name: string) {
  const phone = new Phone(base);
  const made = await phone.createAccount(name);
  assert.equal(made.status, 200, `${name} signs up`);
  return Object.assign(phone, { name, userId: made.body.account.userId as string });
}
type Player = Awaited<ReturnType<typeof player>>;

type Socket = { ws: WebSocket; opened: boolean; closed: Promise<number> };

function openSocket(phone: Phone, room: string, origin = TEST_ORIGIN): Promise<Socket> {
  const ws = new WebSocket(phone.socketUrl(room), { headers: { origin, cookie: phone.cookie } } as unknown as string[]);
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ws, opened: false, closed }), 5000);
    ws.addEventListener("message", () => (clearTimeout(timer), resolve({ ws, opened: true, closed })), { once: true });
    ws.addEventListener("close", () => (clearTimeout(timer), resolve({ ws, opened: false, closed })), { once: true });
  });
}

/** The close code the server sent. The local dev proxy holds TCP open after a server close, so the client finishes it. */
async function serverClose(socket: Socket, label: string): Promise<number> {
  for (const end = Date.now() + 5000; socket.ws.readyState === WebSocket.OPEN; await new Promise((done) => setTimeout(done, 50))) {
    if (Date.now() > end) throw new Error(`timed out waiting for the server to close ${label}`);
  }
  socket.ws.close();
  return socket.closed;
}

const memberNames = (band: { members: { name: string; role: string }[] }) => band.members.map((m) => `${m.name}${m.role === "admin" ? " (admin)" : ""}`);
const bandsOf = async (who: Player) => (await who.call("/api/bands")).body.bands.map((band: { name: string }) => band.name);
const invite = async (who: Player, bandId: string) => (await who.call("/api/codes", { kind: "band", bandId })).body as { code: string; link: string; status?: never };

async function apiChecks() {
  const { worker, base } = await startApi();
  const sockets: WebSocket[] = [];
  try {
    const terry = await player(base, "Terry Bass");
    const mike = await player(base, "Mike Keys");
    const dana = await player(base, "Dana Drums");
    const ann = await player(base, "Ann Horn");
    const lee = await player(base, "Lee Sax");

    assert.equal((await new Phone(base).call("/api/bands")).status, 401, "a signed-out phone has no bands list");
    assert.equal((await new Phone(base).call("/api/bands/create", { name: "Nobody's Band" })).status, 401, "and can't make a band");
    assert.equal((await terry.call("/api/bands/create", { name: "   " })).body.error, "bad-name", "a band needs a name");

    const made = await terry.call("/api/bands/create", { name: "The Blue Notes" });
    assert.equal(made.status, 200, "Terry makes a band");
    const bandId = made.body.bandId as string;
    assert.deepEqual([made.body.name, made.body.role, memberNames(made.body)], ["The Blue Notes", "admin", ["Terry Bass (admin)"]], "and is its only member and its admin");
    assert.deepEqual(await bandsOf(terry), ["The Blue Notes"], "it is on Terry's Bands list");
    pass("a signed-in player creates a band and is its admin");

    const outsider = await mike.call("/api/codes", { kind: "band", bandId });
    assert.deepEqual([outsider.status, outsider.body.error], [403, "not-a-member"], "someone outside the band can't make its invite code");
    assert.deepEqual((await mike.call("/api/bands/open", { bandId })).body.error, "not-a-member", "or see its members");

    const shown = await invite(terry, bandId);
    assert.ok(shown.link.startsWith(`${TEST_ORIGIN}/c/band.`), `Invite makes a shared band code link (${shown.link})`);
    assert.ok(!/blue|notes|terry/i.test(shown.link) && !shown.link.includes(bandId), "with no band name, person or band id in it");
    assert.equal((await invite(terry, bandId)).code, shown.code, "showing Invite again shows the same live code");

    const preview = await mike.call("/api/bands/code", { code: shown.code });
    assert.deepEqual(preview.body, { name: "The Blue Notes", invitedBy: "Terry Bass", member: false }, "a scanned code shows the band name and who invited you");
    assert.equal((await new Phone(base).call("/api/bands/join", { code: shown.code })).status, 401, "a signed-out phone can't join with it");
    const joined = await mike.call("/api/bands/join", { code: shown.code });
    assert.deepEqual([joined.status, joined.body.role, memberNames(joined.body)], [200, "member", ["Terry Bass (admin)", "Mike Keys"]], "after sign-in the code joins Mike as a member");
    assert.deepEqual(await bandsOf(mike), ["The Blue Notes"], "the band is on Mike's list");
    assert.deepEqual(memberNames((await mike.call("/api/bands/join", { code: shown.code })).body), ["Terry Bass (admin)", "Mike Keys"], "joining twice changes nothing");
    assert.equal((await dana.call("/api/bands/join", { code: shown.link })).body.error, "bad-code", "the server wants the code, not the whole link");
    assert.equal((await dana.call("/api/bands/join", { code: shown.code })).status, 200, "the same link joins Dana too");
    pass("a scanned band code joins after sign-in");

    for (const [what, path, body] of [
      ["make a code", "/api/codes", { kind: "band", bandId }],
      ["reset the link", "/api/bands/reset-link", { bandId }],
      ["make someone admin", "/api/bands/make-admin", { bandId, userId: dana.userId }],
      ["remove someone", "/api/bands/remove", { bandId, userId: terry.userId }],
    ] as const) {
      const tried = await mike.call(path, body);
      assert.deepEqual([tried.status, tried.body.error], [403, "not-admin"], `a member can't ${what}`);
    }
    assert.deepEqual(memberNames((await terry.call("/api/bands/open", { bandId })).body), ["Terry Bass (admin)", "Dana Drums", "Mike Keys"], "so nobody changed");
    const promoted = await terry.call("/api/bands/make-admin", { bandId, userId: mike.userId });
    assert.deepEqual(memberNames(promoted.body), ["Mike Keys (admin)", "Terry Bass (admin)", "Dana Drums"], "the admin makes Mike an admin");
    assert.equal((await mike.call("/api/bands/open", { bandId })).body.role, "admin", "and Mike sees it");
    pass("only an admin invites, resets, makes admins and removes");

    const mikes = await invite(mike, bandId);
    assert.notEqual(mikes.code, shown.code, "each admin shows their own code");
    const reset = await terry.call("/api/bands/reset-link", { bandId });
    assert.deepEqual([reset.status, reset.body.stopped], [200, 2], "Reset link stops both live codes");
    assert.equal((await ann.call("/api/bands/join", { code: shown.code })).body.error, "code-stopped", "an old code no longer joins");
    assert.equal((await ann.call("/api/bands/code", { code: mikes.code })).body.error, "code-stopped", "nor does the other admin's");
    const fresh = await invite(terry, bandId);
    assert.notEqual(fresh.code, shown.code, "Invite then shows a fresh code");
    pass("Reset link stops old codes");

    const danaInBand = await openSocket(dana, bandId);
    const mikeInBand = await openSocket(mike, bandId);
    sockets.push(danaInBand.ws, mikeInBand.ws);
    assert.ok(danaInBand.opened && mikeInBand.opened, "members open the band room's socket");
    const removed = await terry.call("/api/bands/remove", { bandId, userId: dana.userId });
    assert.deepEqual(memberNames(removed.body), ["Mike Keys (admin)", "Terry Bass (admin)"], "Terry removes Dana");
    assert.equal(await serverClose(danaInBand, "Dana's socket"), NOT_A_MEMBER_CLOSE, "Dana's open socket closes at once");
    assert.equal(mikeInBand.ws.readyState, WebSocket.OPEN, "Mike's socket stays open");
    assert.deepEqual([(await dana.call("/api/bands/open", { bandId })).status, (await dana.call("/api/bands/open", { bandId })).body.error], [403, "not-a-member"], "Dana's band calls are refused");
    assert.equal((await dana.call("/api/bands/pack", { bandId })).body.error, "not-a-member", "including the gig pack");
    assert.equal((await dana.call(`/api/rooms/${bandId}`)).status, 403, "and so is the room itself");
    assert.equal((await openSocket(dana, bandId)).opened, false, "a new socket from Dana is refused");
    assert.deepEqual(await bandsOf(dana), [], "the band is off Dana's list");
    assert.equal((await dana.call("/api/bands/join", { code: fresh.code })).body.error, "code-stopped", "a code made before Dana was removed can't bring her back");
    assert.equal((await ann.call("/api/bands/join", { code: fresh.code })).status, 200, "though it still joins Ann");
    const again = await invite(terry, bandId);
    assert.equal(again.code, fresh.code, "Terry's live code is unchanged");
    await terry.call("/api/bands/reset-link", { bandId });
    assert.equal((await dana.call("/api/bands/join", { code: (await invite(terry, bandId)).code })).status, 200, "a code made after the removal lets the admin invite Dana back");
    pass("a removed member's socket closes and their calls are refused");

    const leeCode = await invite(mike, bandId);
    await terry.call("/api/bands/remove", { bandId, userId: mike.userId });
    assert.equal(await serverClose(mikeInBand, "Mike's socket"), NOT_A_MEMBER_CLOSE, "removing an admin closes their socket too");
    assert.equal((await lee.call("/api/bands/join", { code: leeCode.code })).body.error, "code-stopped", "and their invite code stops working");
    pass("a code from an admin who was removed no longer joins");

    assert.deepEqual([(await terry.call("/api/bands/leave", { bandId })).status, (await terry.call("/api/bands/leave", { bandId })).body.error], [409, "last-admin"], "the last admin can't leave while others are in the band");
    const annInBand = await openSocket(ann, bandId);
    sockets.push(annInBand.ws);
    assert.equal((await ann.call("/api/bands/leave", { bandId })).status, 200, "a member leaves");
    assert.equal(await serverClose(annInBand, "Ann's socket"), NOT_A_MEMBER_CLOSE, "which closes her socket");
    assert.deepEqual(await bandsOf(ann), [], "the band is off her list");
    assert.equal((await ann.call("/api/bands/open", { bandId })).body.error, "not-a-member", "and she is out");
    await terry.call("/api/bands/make-admin", { bandId, userId: dana.userId });
    assert.equal((await terry.call("/api/bands/leave", { bandId })).status, 200, "with another admin, Terry can leave");
    assert.deepEqual(memberNames((await dana.call("/api/bands/open", { bandId })).body), ["Dana Drums (admin)"], "leaving Dana as the band's admin");
    pass("members leave, and the last admin must hand over first");

    assert.equal((await terry.call("/api/bands/open", { bandId: "band-a" })).body.error, "bad-request", "a band id that isn't one is refused");
    assert.equal((await terry.call("/api/bands/open", { bandId: "band_AAAAAAAAAAAAAAAAAAAAAA" })).body.error, "no-band", "and so is a band nobody made");
  } finally {
    for (const ws of sockets) ws.close();
    await worker.dispose();
  }
}

async function appChecks() {
  let apiBase = "";
  const site = await openSite(root, "check-bands", () => apiBase);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
  apiBase = base;
  const sockets: WebSocket[] = [];
  try {
    const app = await appPage(site);
    const view = (name: string) => app.until(`document.querySelector(".bands-sheet")?.dataset.view === ${JSON.stringify(name)} && !document.querySelector(".bands-sheet").textContent.includes("Loading")`, `the ${name} view`, 15000);
    const noticed = (pattern: string) => app.until(`new RegExp(${JSON.stringify(pattern)}).test(document.querySelector(".bands-notice")?.textContent ?? "")`, `the notice ${pattern}`);
    const members = () => app.texts(".bands-members li > span:first-child");
    const fitsPhone = async (what: string) => {
      const fit = await app.fits();
      assert.ok(fit.page <= WIDTH && fit.left >= 0 && fit.right <= WIDTH, `${what} fits the phone with no sideways scroll (${JSON.stringify(fit)})`);
    };
    const shownLink = async () => {
      await app.until(`!!document.querySelector(".codes-qr svg")`, "the QR code");
      return readQr(await site.evaluate<string>(`document.querySelector(".codes-qr").innerHTML`));
    };
    const codeIn = (link: string) => link.slice(`${origin}/c/`.length);
    const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
    const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
    const dana = await passwordPlayer(base, origin, "Dana Drums", "danadrums");
    const ann = await passwordPlayer(base, origin, "Ann Horn", "annhorn");
    const namesIn = async (who: Phone, bandId: string) => memberNames((await who.call("/api/bands/open", { bandId })).body);

    const blueNotes = (await terry.call("/api/bands/create", { name: "The Blue Notes" })).body.bandId as string;
    const terrysLink = (await terry.call("/api/codes", { kind: "band", bandId: blueNotes })).body.link as string;
    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await app.library();
    assert.deepEqual(await app.openMenu(), ["Sign in"], "signed out, the More menu has no Bands");
    await app.closeMenu();

    await site.send("Page.navigate", { url: terrysLink });
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "start"`, "the sign-in screen first");
    assert.equal(await site.evaluate<string>("location.search"), "", "the landed code leaves the address bar");
    await app.click("New here? Create an account");
    await app.type("Your name (what bandmates see)", "Sam Rivera");
    await app.click("Sign in with Face ID or fingerprint");
    await view("code");
    assert.equal(await app.text(".bands-sheet .codes-words"), "The Blue Notes Invited by Terry Bass", "after sign-up the code shows the band and who invited you");
    await fitsPhone("Join a band");
    await app.shot(shots && `${shots}/bands-join.png`);
    await app.click("Join");
    await view("band");
    await noticed("You joined The Blue Notes\\.");
    assert.deepEqual(await members(), ["Terry BassAdmin", "Sam Rivera"], "Sam is in the band, with Terry as its admin");
    assert.deepEqual(await namesIn(terry, blueNotes), ["Terry Bass (admin)", "Sam Rivera"], "and Terry's phone sees Sam joined");
    assert.equal(await site.evaluate<number>(`document.querySelectorAll(".bands-sheet .account-primary").length`), 0, "a member sees no Invite or Band settings");
    pass("a band link opened signed out joins after sign-up, in the app");

    await app.click("✕");
    assert.deepEqual(await app.openMenu(), ["Account", "Friends", "Bands"], "signed in, Bands sits after Friends");
    await app.pick("Bands");
    await view("list");
    assert.deepEqual(await app.texts(".bands-list li > span:first-child"), ["The Blue Notes2 members"],"the Bands list shows The Blue Notes");
    await app.type("New band", "Sam's Trio");
    await app.click("Create band");
    await view("band");
    assert.deepEqual(await members(), ["Sam RiveraAdmin"], "a new band has its maker as admin");
    await fitsPhone("a band");
    await app.click("Invite");
    await view("invite");
    assert.equal(await app.text(".bands-sheet .codes-words"), "Join Sam's Trio", "Invite says what the code does");
    const firstLink = await shownLink();
    assert.ok(firstLink.startsWith(`${origin}/c/band.`) && !/sam|trio/i.test(firstLink), `the QR code is a band code link with no names (${firstLink})`);
    assert.equal(await app.text(".codes-link"), firstLink, "the link under it matches");
    await fitsPhone("Invite");
    await app.shot(shots && `${shots}/bands-invite.png`);
    const trio = (await mike.call("/api/bands/join", { code: codeIn(firstLink) })).body.bandId as string;
    assert.ok(trio, "Mike joins with the code on Sam's screen");
    assert.equal((await dana.call("/api/bands/join", { code: codeIn(firstLink) })).status, 200, "so does Dana");
    pass("New band and Invite show a working band code");

    await app.click("Reset link");
    await noticed("Link reset");
    const secondLink = await shownLink();
    assert.notEqual(secondLink, firstLink, "Reset link shows a fresh code");
    assert.equal((await ann.call("/api/bands/join", { code: codeIn(firstLink) })).body.error, "code-stopped", "the old one no longer joins");
    assert.equal((await ann.call("/api/bands/code", { code: codeIn(secondLink) })).status, 200, "the fresh one works");
    pass("Reset link in the app stops the old code");

    await app.click("Back");
    await view("band");
    assert.deepEqual(await members(), ["Sam RiveraAdmin", "Dana Drums", "Mike Keys"], "Mike and Dana are on Sam's Members");
    const danaInBand = await openSocket(dana, trio, origin);
    sockets.push(danaInBand.ws);
    assert.ok(danaInBand.opened, "Dana's phone is in the band room");
    await app.click("Remove", "document.querySelectorAll('.bands-members li')[1]");
    await app.click("Yes, remove", "document.querySelectorAll('.bands-members li')[1]");
    await noticed("Removed Dana Drums\\.");
    assert.deepEqual(await members(), ["Sam RiveraAdmin", "Mike Keys"], "Remove takes Dana off, after a second tap");
    assert.equal(await serverClose(danaInBand, "Dana's socket"), NOT_A_MEMBER_CLOSE, "Dana's socket closes");
    assert.equal((await dana.call("/api/bands/open", { bandId: trio })).body.error, "not-a-member", "and her calls are refused");
    await app.click("Make admin", "document.querySelectorAll('.bands-members li')[1]");
    await noticed("Mike Keys is now an admin\\.");
    assert.deepEqual(await namesIn(mike, trio), ["Mike Keys (admin)", "Sam Rivera (admin)"], "Make admin makes Mike an admin");
    assert.deepEqual(await app.texts(".bands-members li .friends-actions"), ["Remove"], "an admin can still remove another admin, and never sees Remove on their own row");
    await app.shot(shots && `${shots}/bands-members.png`);
    pass("Remove and Make admin work from Members");

    await app.click("All bands");
    await view("list");
    assert.deepEqual(await app.texts(".bands-list li > span:first-child"), ["Sam's TrioAdmin · 2 members", "The Blue Notes2 members"], "the list shows both bands by name, with Sam's role");
    await app.click("Open", `[...document.querySelectorAll(".bands-list li")].find((li) => li.textContent.startsWith("The Blue Notes"))`);
    await view("band");
    assert.equal(await app.text(".bands-sheet h2"), "The Blue Notes", "Open goes to that band");
    await app.click("Leave band");
    await app.click("Yes, leave The Blue Notes");
    await view("list");
    await noticed("You left The Blue Notes\\.");
    assert.deepEqual(await app.texts(".bands-list li > span:first-child"), ["Sam's TrioAdmin · 2 members"], "The Blue Notes is off the list");
    assert.deepEqual(await namesIn(terry, blueNotes), ["Terry Bass (admin)"], "and off Terry's Members");
    await app.shot(shots && `${shots}/bands-list.png`);
    pass("Leave band takes you out");

    await app.click("✕");
    await app.openMenu();
    await app.pick("Account");
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "account"`, "the account screen");
    await app.click("Sign out");
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "start"`, "the sign-in screen");
    await app.click("✕");
    assert.deepEqual(await app.openMenu(), ["Sign in"], "after Sign out the Bands item is gone");
    await app.closeMenu();
    await settle();
    assert.deepEqual(await app.errors(), [], "no page errors");
  } finally {
    for (const ws of sockets) ws.close();
    await site.close();
    await worker.dispose();
  }
}

await apiChecks();
await appChecks();
console.log("check:bands passed");
