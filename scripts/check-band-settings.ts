import assert from "node:assert/strict";
import { Phone, startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, readQr } from "./app-page.ts";
import { openSite } from "./chrome.ts";

const root = new URL("..", import.meta.url).pathname;
/** Set SHOTS to a folder to save Band settings at phone size. */
const shots = process.env.SHOTS;
const pass = (message: string) => console.log(`ok   ${message}`);

/** A timing version only Sam's phone has. Its name, tempo and tap time are odd enough that any copy of it anywhere is unmistakable. */
const PRIVATE_NAME = "Sam private take 7F3A";
const PRIVATE_VERSION = { name: PRIVATE_NAME, bpm: 97.13, marks: [{ at: 0, progress: 0 }, { at: 123457, progress: 1 }] };
const PRIVATE_MARKS = ["7F3A", "97.13", "123457", "leadSheetsScrollVersions"];

async function player(base: string, name: string) {
  const phone = new Phone(base);
  const made = await phone.createAccount(name);
  assert.equal(made.status, 200, `${name} signs up`);
  return Object.assign(phone, { name, userId: made.body.account.userId as string });
}

function openSocket(phone: Phone, room: string, origin: string): Promise<{ ws: WebSocket; first: string }> {
  const ws = new WebSocket(phone.socketUrl(room), { headers: { origin, cookie: phone.cookie } } as unknown as string[]);
  return new Promise((resolve, reject) => {
    ws.addEventListener("message", (event) => resolve({ ws, first: String(event.data) }), { once: true });
    ws.addEventListener("close", () => reject(new Error("the band room refused a member's socket")), { once: true });
  });
}

async function apiChecks() {
  const { worker, base } = await startApi();
  try {
    const terry = await player(base, "Terry Bass");
    const mike = await player(base, "Mike Keys");
    const lee = await player(base, "Lee Sax");
    const bandId = (await terry.call("/api/bands/create", { name: "The Blue Notes" })).body.bandId as string;
    await mike.call("/api/bands/join", { code: (await terry.call("/api/codes", { kind: "band", bandId })).body.code });
    const packOf = async (who: Phone) => (await who.call("/api/bands/pack", { bandId })).body;

    assert.equal((await terry.call("/api/bands/open", { bandId })).body.scrollWithLeader, false, "a new band starts with Scroll with the leader off");
    assert.deepEqual(await packOf(mike), { bandId, name: "The Blue Notes", scrollWithLeader: false }, "the gig pack carries the setting, off");

    const on = await terry.call("/api/bands/settings", { bandId, scrollWithLeader: true });
    assert.deepEqual([on.status, on.body.scrollWithLeader], [200, true], "the admin turns it on");
    assert.equal((await mike.call("/api/bands/open", { bandId })).body.scrollWithLeader, true, "it is stored on the band room, so a member reads it back");
    assert.deepEqual(await packOf(mike), { bandId, name: "The Blue Notes", scrollWithLeader: true }, "and every member's gig pack carries it");
    const off = await terry.call("/api/bands/settings", { bandId, scrollWithLeader: false });
    assert.deepEqual([off.status, off.body.scrollWithLeader], [200, false], "the admin turns it off again");
    assert.equal((await packOf(terry)).scrollWithLeader, false, "and the pack follows");
    pass("the admin turns Scroll with the leader on and off, and the gig pack carries it");

    const tried = await mike.call("/api/bands/settings", { bandId, scrollWithLeader: true });
    assert.deepEqual([tried.status, tried.body.error], [403, "not-admin"], "a member's attempt is refused");
    assert.equal((await packOf(terry)).scrollWithLeader, false, "and changes nothing");
    assert.deepEqual((await lee.call("/api/bands/settings", { bandId, scrollWithLeader: true })).body.error, "not-a-member", "someone outside the band is refused");
    assert.deepEqual((await lee.call("/api/bands/pack", { bandId })).body.error, "not-a-member", "and gets no pack");
    assert.deepEqual((await terry.call("/api/bands/settings", { bandId, scrollWithLeader: "yes" })).body.error, "bad-request", "the setting is on or off, nothing else");
    pass("a member's or stranger's attempt is refused");
  } finally {
    await worker.dispose();
  }
}

async function appChecks() {
  let apiBase = "";
  const site = await openSite(root, "check-band-settings", () => apiBase);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
  apiBase = base;
  const sockets: WebSocket[] = [];
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
        const xhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) { this.__url = url; return xhrOpen.call(this, method, url, ...rest); };
        const xhrSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (body) { keep("xhr " + this.__url, body); return xhrSend.call(this, body); };
        const wsSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) { keep("socket " + this.url, data); return wsSend.call(this, data); };
        const beacon = navigator.sendBeacon?.bind(navigator);
        if (beacon) navigator.sendBeacon = (url, data) => (keep("beacon " + url, data), beacon(url, data));
      })();`,
    });
    const view = (name: string) => app.until(`document.querySelector(".bands-sheet")?.dataset.view === ${JSON.stringify(name)} && !document.querySelector(".bands-sheet").textContent.includes("Loading")`, `the ${name} view`, 15000);
    const toggle = () => site.evaluate(`document.querySelector(".bands-sheet input[role=switch]").click()`);
    const switchIs = (on: boolean) => app.until(`(() => { const s = document.querySelector(".bands-sheet input[role=switch]"); return s && s.checked === ${on} && !s.disabled; })()`, `the switch ${on ? "on" : "off"}`);
    const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");

    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await app.library();
    const firstSong = await site.evaluate<string>(`document.querySelector('a[href^="#/song/"]').getAttribute("href").match(/\\d+/)[0]`);
    await site.evaluate(`localStorage.setItem("leadSheetsScrollVersions.${firstSong}", ${JSON.stringify(JSON.stringify({ versions: [PRIVATE_VERSION], selected: 0 }))})`);
    await site.send("Page.reload");
    await app.library();
    await site.evaluate(`location.hash = "#/song/${firstSong}"`);
    await app.until(`document.body.textContent.includes(${JSON.stringify(PRIVATE_NAME)})`, "the private version on Sam's sheet");
    await site.evaluate(`location.hash = "#/songs"`);
    await app.library();
    pass("Sam's phone holds a private timing version the app loads");

    await app.signUp("Sam Rivera");
    await app.openMenu();
    await app.pick("Bands");
    await view("list");
    await app.type("New band", "Sam's Trio");
    await app.click("Create band");
    await view("band");
    await app.click("Invite");
    await view("invite");
    await app.until(`!!document.querySelector(".codes-qr svg")`, "the QR code");
    const link = readQr(await site.evaluate<string>(`document.querySelector(".codes-qr").innerHTML`));
    const bandId = (await mike.call("/api/bands/join", { code: link.slice(`${origin}/c/`.length) })).body.bandId as string;
    const packOf = async () => (await mike.call("/api/bands/pack", { bandId })).body;
    await app.click("Back");
    await view("band");
    await app.click("Band settings");
    await view("settings");
    assert.match(await app.text(".bands-sheet"), /Scroll with the leader/, "Band settings shows Scroll with the leader");
    assert.match(await app.text(".bands-sheet"), /Nobody's private versions are shared\./, "and says nobody's private versions are shared");
    await switchIs(false);
    await toggle();
    await switchIs(true);
    assert.equal((await packOf()).scrollWithLeader, true, "Sam turns it on, and Mike's gig pack carries it");
    await app.shot(shots && `${shots}/band-settings-on.png`);
    await toggle();
    await switchIs(false);
    assert.equal((await packOf()).scrollWithLeader, false, "Sam turns it off, and Mike's pack follows");
    await toggle();
    await switchIs(true);
    pass("the admin turns the setting on and off from Band settings");

    const tried = await mike.call("/api/bands/settings", { bandId, scrollWithLeader: false });
    assert.equal(tried.body.error, "not-admin", "Mike, a member, can't change it");
    await site.evaluate(`location.reload()`);
    await app.library();
    await app.openMenu();
    await app.pick("Bands");
    await view("list");
    await app.click("Open");
    await view("band");
    await app.click("Band settings");
    await view("settings");
    await switchIs(true);
    pass("a member's attempt is refused, and the admin's phone still reads it on after a reload");

    const pack = await packOf();
    assert.deepEqual(Object.keys(pack).sort(), ["bandId", "name", "scrollWithLeader"], "the band's gig pack holds only the band id, name and setting");
    const memberSocket = await openSocket(mike, bandId, origin);
    sockets.push(memberSocket.ws);
    const sent = await site.evaluate<string[]>(`JSON.parse(sessionStorage.getItem("__sent") ?? "[]")`);
    assert.ok(sent.some((entry) => entry.includes(`"scrollWithLeader":true`)), `the recorder saw Sam's phone send the setting (${sent.length} sends)`);
    for (const [where, text] of [["the gig pack", JSON.stringify(pack)], ["the band room's socket message", memberSocket.first], ...sent.map((entry) => ["what Sam's phone sent", entry])]) {
      for (const mark of PRIVATE_MARKS) assert.ok(!text.includes(mark), `Sam's private timing version (${mark}) never appears in ${where}: ${text.slice(0, 160)}`);
    }
    pass(`Sam's private timing version never appears in the pack, the room's socket message, or any of ${sent.length} things Sam's phone sent`);

    assert.deepEqual(await app.errors(), [], "no page errors");
  } finally {
    for (const ws of sockets) ws.close();
    await site.close();
    await worker.dispose();
  }
}

await apiChecks();
await appChecks();
console.log("check:band-settings passed");
