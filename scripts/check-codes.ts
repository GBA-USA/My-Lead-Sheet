import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../functions/c/[[path]].ts";
import { qrMatrix } from "../src/qr-svg.ts";
import { Phone, startApi, TEST_ORIGIN } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, WIDTH } from "./app-page.ts";
import { openSite } from "./chrome.ts";

const MINUTE_MS = 100;
const root = new URL("..", import.meta.url).pathname;
/** Set SHOTS to a folder to save the scanner screens at phone size. */
const shots = process.env.SHOTS;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const pass = (message: string) => console.log(`ok   ${message}`);

/** A phone's own camera app or a plain browser opening the link: no cookie, no Origin, redirects not followed. */
async function land(base: string, code: string) {
  const response = await fetch(new URL(`/c/${code}`, base), { redirect: "manual" });
  return { status: response.status, location: response.headers.get("location"), type: response.headers.get("content-type") ?? "", text: await response.text() };
}

/** The same payload with one character changed at `index` (counted from the end when negative). */
function changed(code: string, index: number) {
  const at = index < 0 ? code.length + index : index;
  return code.slice(0, at) + (code[at] === "A" ? "B" : "A") + code.slice(at + 1);
}

async function apiChecks() {
  const { worker, base } = await startApi({ CODE_MINUTE_MS: String(MINUTE_MS) });
  try {
    const terry = new Phone(base);
    const mike = new Phone(base);
    assert.equal((await terry.createAccount("Terry Bass")).status, 200, "Terry signs up");
    assert.equal((await mike.createAccount("Mike Keys")).status, 200, "Mike signs up");
    const { account } = (await terry.call("/api/me")).body;

    const lasts = (minutes: number, made: { before: number; after: number; expiresAt: number }) =>
      made.expiresAt - made.before >= minutes * MINUTE_MS && made.expiresAt - made.after <= minutes * MINUTE_MS;
    const before = Date.now();
    const inPerson = await terry.call("/api/codes", { kind: "friend-now" });
    const after = Date.now();
    assert.equal(inPerson.status, 200, `Show my code makes a friend code (${JSON.stringify(inPerson.body)})`);
    const { code, link, expiresAt } = inPerson.body;
    assert.equal(link, `${TEST_ORIGIN}/c/${code}`, "the code is a normal link on the app's own origin");
    const parts = code.split(".");
    assert.equal(parts.length, 5, "the payload is kind, id, end time, nonce and signature");
    assert.equal(parts[0], "friend-now", "the payload names its kind");
    for (const secret of [account.userId, account.handle, account.displayName, "terry", "bass"]) {
      assert.ok(!link.toLowerCase().includes(String(secret).toLowerCase()), `the link carries no name or id of its owner (${secret})`);
    }
    assert.ok(lasts(10, { before, after, expiresAt }), `an in-person code ends after 10 minutes (${(expiresAt - after) / MINUTE_MS})`);
    pass("a friend code is a signed /c/ link with its kind and end time and no names");

    const landed = await land(base, code);
    assert.equal(landed.status, 302, "a plain browser opening the link is sent on");
    assert.equal(landed.location, `${TEST_ORIGIN}/?open=friends&code=${code}`, "an in-person friend code lands on Friends");
    const viaPages = await onRequest({
      request: new Request(new URL(`/c/${code}`, base), { redirect: "manual" }),
      env: { API: { fetch: (request: Request) => fetch(request, { redirect: "manual" }) } },
    } as unknown as Parameters<typeof onRequest>[0]);
    assert.equal(viaPages.headers.get("location"), landed.location, "the Pages site forwards /c/ links to the Worker");
    pass("a link opened in a plain browser lands on the screen for its kind");

    const sharedBefore = Date.now();
    const shared = await terry.call("/api/codes", { kind: "friend-link" });
    const sharedAfter = Date.now();
    assert.equal(shared.status, 200, "Share link makes a link code");
    assert.equal(shared.body.code.split(".")[0], "friend-link", "a shared link is its own kind");
    assert.ok(lasts(7 * 24 * 60, { before: sharedBefore, after: sharedAfter, expiresAt: shared.body.expiresAt }), "a shared link lasts 7 days");
    assert.equal((await terry.call("/api/codes", { kind: "friend-link" })).body.code, shared.body.code, "Share link again hands back the same live link");
    assert.equal((await land(base, shared.body.code)).location, `${TEST_ORIGIN}/?open=friends&code=${shared.body.code}`, "a friend link lands on Friends");

    const privateCopy = await terry.call("/api/codes", { kind: "my-setlist", setlistId: "local/3", songIds: ["local/1"], sharedAs: "public", reshareable: false });
    assert.deepEqual([privateCopy.status, privateCopy.body.error], [403, "shared-privately"], "asking for a code on a Private copy is refused by the server");
    const ownSetlist = await terry.call("/api/codes", { kind: "my-setlist", setlistId: "local/3", songIds: ["local/1", "local/7"], sharedAs: "private", reshareable: true });
    assert.equal(ownSetlist.status, 200, "an original setlist gets a code");
    assert.ok(!ownSetlist.body.link.includes("local"), "a setlist code carries no setlist or song id");
    assert.equal((await land(base, ownSetlist.body.code)).location, `${TEST_ORIGIN}/?open=setlists&code=${ownSetlist.body.code}`, "a setlist code lands on Setlists");
    pass("each kind this server makes lands on its screen, and a Private copy gets no code");

    for (const kind of ["gig", "guest", "band-setlist"]) assert.deepEqual((await terry.call("/api/codes", { kind })).body.error, "bad-kind", `${kind} codes, whose screens are not built yet, are not made`);
    assert.equal((await new Phone(base).call("/api/codes", { kind: "friend-now" })).status, 401, "a signed-out phone gets no code");
    assert.equal((await terry.call("/api/codes", { kind: "friend-now" }, { origin: "https://evil.test" })).status, 403, "another site can't ask for a code");

    const tampered = {
      "a changed signature": changed(code, -2),
      "a changed last signature character": changed(code, -1),
      "a changed id": changed(code, parts[0].length + 2),
      "a zero in front of the end time": code.replace(`.${parts[2]}.`, `.0${parts[2]}.`),
      "a later end time": code.replace(`.${parts[2]}.`, `.${Number(parts[2]) + 7 * 24 * 60 * MINUTE_MS}.`),
      "the in-person kind passed off as a pre-approved link": code.replace(/^friend-now\./, "friend-link."),
      "a made-up payload": "friend-now.AAAAAAAAAAAAAAAA.99999999999999.AAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    for (const [what, bad] of Object.entries(tampered)) {
      const page = await land(base, bad);
      assert.equal(page.status, 404, `${what} is refused at the link`);
      assert.match(page.type, /^text\/html/, `${what} gets a page, not JSON`);
      assert.match(page.text, /This code doesn't work/, `${what} says the code doesn't work`);
      assert.ok(!page.text.includes("Terry"), `${what} shows no name`);
      const opened = await mike.call("/api/friends/code", { code: bad });
      assert.deepEqual([opened.status, opened.body.error], [404, "bad-code"], `${what} is refused when scanned`);
      assert.equal((await mike.call("/api/friends/add-by-code", { code: bad })).status, 404, `${what} adds nobody`);
    }
    pass("a tampered code is refused at the link and in the app");

    assert.equal((await mike.call("/api/codes/stop", { code })).status, 404, "Mike can't stop Terry's code");
    assert.equal((await land(base, code)).status, 302, "so the code still works");
    assert.equal((await terry.call("/api/codes/stop", { code })).status, 200, "Terry stops his code");
    assert.equal((await terry.call("/api/codes/stop", { code })).status, 200, "stopping it again is fine");
    const stoppedPage = await land(base, code);
    assert.equal(stoppedPage.status, 410, "a stopped code is refused at the link");
    assert.match(stoppedPage.text, /This code was stopped/, "and says it was stopped");
    assert.deepEqual((await mike.call("/api/friends/code", { code })).body.error, "code-stopped", "a stopped code is refused when scanned");
    assert.deepEqual((await mike.call("/api/friends/add-by-code", { code })).body.error, "code-stopped", "a stopped code adds nobody");
    assert.equal((await terry.call("/api/codes/stop", { code: shared.body.code })).status, 200, "Terry stops his shared link");
    const fresh = await terry.call("/api/codes", { kind: "friend-link" });
    assert.notEqual(fresh.body.code, shared.body.code, "Share link after Stop this code makes a new link");
    assert.equal((await land(base, shared.body.code)).status, 410, "the stopped link stays stopped");
    pass("Stop this code is the owner's alone and holds");

    const short = (await terry.call("/api/codes", { kind: "friend-now" })).body.code;
    assert.equal((await land(base, short)).status, 302, "a fresh in-person code works");
    await sleep(10 * MINUTE_MS + 200);
    const endedPage = await land(base, short);
    assert.equal(endedPage.status, 410, "an expired code is refused at the link");
    assert.match(endedPage.text, /This code has ended/, "and says it has ended");
    assert.deepEqual((await mike.call("/api/friends/code", { code: short })).body.error, "code-ended", "an expired code is refused when scanned");
    assert.deepEqual((await mike.call("/api/friends/add-by-code", { code: short })).body.error, "code-ended", "an expired code adds nobody");
    assert.deepEqual((await terry.call("/api/friends")).body.requests, [], "none of the refused codes left Terry a request");
    pass("an expired code is refused");
  } finally {
    await worker.dispose();
  }
}

/** A clip for Chrome's fake camera in YUV4MPEG2: a blank frame, then `text` as a QR code held for three frames, looped. */
function cameraClip(path: string, text: string) {
  const size = 480;
  const matrix = qrMatrix(text);
  const cell = Math.floor(size / (matrix.length + 8));
  const offset = Math.floor((size - cell * matrix.length) / 2);
  const code = Buffer.alloc(size * size, 235);
  matrix.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (!dark) return;
      for (let dy = 0; dy < cell; dy += 1) code.fill(16, (offset + r * cell + dy) * size + offset + c * cell, (offset + r * cell + dy) * size + offset + (c + 1) * cell);
    }),
  );
  const blank = Buffer.alloc(size * size, 235);
  const chroma = Buffer.alloc((size * size) / 2, 128);
  const frames = [blank, code, code, code].flatMap((luma) => [Buffer.from("FRAME\n"), luma, chroma]);
  writeFileSync(path, Buffer.concat([Buffer.from(`YUV4MPEG2 W${size} H${size} F5:1 Ip A1:1 C420jpeg\n`), ...frames]));
}

async function scannerChecks() {
  const camera = mkdtempSync(join(tmpdir(), "check-codes-camera-"));
  const clip = join(camera, "camera.y4m");
  cameraClip(clip, "not a code yet");
  let apiBase = "";
  const site = await openSite(root, "check-codes", () => apiBase, ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${clip}`]);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
  apiBase = base;
  try {
    const app = await appPage(site);
    const view = (name: string) => app.until(`document.querySelector(".friends-sheet")?.dataset.view === ${JSON.stringify(name)}`, `the ${name} view`, 15000);
    const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
    const requestsOf = async () => (await terry.call("/api/friends")).body.requests.map((person: { name: string }) => person.name);

    const inPerson = (await terry.call("/api/codes", { kind: "friend-now" })).body;
    cameraClip(clip, inPerson.link);
    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await app.library();
    await app.signUp("Sam Rivera");
    await app.openMenu();
    await app.pick("Friends");
    await view("list");
    await app.click("Scan a code");
    await view("scan");
    await app.until(`document.querySelector(".codes-camera")?.videoWidth > 0`, "the camera picture");
    await app.shot(shots && `${shots}/codes-scan.png`);
    await view("code");
    await app.until(`!!document.querySelector(".friends-sheet .codes-words")`, "who the code adds");
    assert.match(await app.text(".friends-sheet .codes-words"), /^Terry Bass @terrybass$/, "the camera read Terry's code and the server named him");
    const fit = await app.fits();
    assert.ok(fit.page <= WIDTH && fit.left >= 0 && fit.right <= WIDTH, `the scanned code fits the phone (${JSON.stringify(fit)})`);
    await app.shot(shots && `${shots}/codes-scanned.png`);
    await app.click("Send request");
    await app.until(`/Request sent\. Terry Bass needs to accept\./.test(document.querySelector(".friends-notice")?.textContent ?? "")`, "the sent notice");
    assert.deepEqual(await requestsOf(), ["Sam Rivera"], "the scan sent Terry a request to accept");
    pass("the scanner reads a code from a fake camera feed");

    const shared = (await terry.call("/api/codes", { kind: "friend-link" })).body;
    await site.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `new MutationObserver(() => { if (document.querySelector(".account-sheet:not(.friends-sheet)")) window.sawSignIn = true; }).observe(document, { childList: true, subtree: true });`,
    });
    await site.send("Page.navigate", { url: shared.link });
    await view("code");
    assert.equal(await site.evaluate("window.sawSignIn ?? false"), false, "a signed-in phone opening the link goes straight to Friends, with no sign-in sheet on the way");
    await app.until(`!!document.querySelector(".friends-sheet .codes-words")`, "who the link adds");
    assert.equal(await site.evaluate<string>("location.search"), "", "the landed code leaves the address bar");
    await app.click("Add friend");
    await app.until(`/You and Terry Bass are friends\./.test(document.querySelector(".friends-notice")?.textContent ?? "")`, "the friends notice");
    assert.deepEqual(await app.texts(".friends-friends li > span:first-child"), ["Terry Bass@terrybass"], "Terry is on Sam's list");
    pass("the same link opens from a plain browser address and lands on Friends");

    await site.send("Page.navigate", { url: shared.link.replace(/.$/, (last: string) => (last === "A" ? "B" : "A")) });
    await app.until(`document.body?.textContent.includes("This code doesn't work")`, "the refused link's page");
    pass("a tampered link opened in a browser says it doesn't work");

    assert.deepEqual(await app.errors(), [], "no page errors");
  } finally {
    await site.close();
    await worker.dispose();
    rmSync(camera, { recursive: true, force: true });
  }
}

await apiChecks();
await scannerChecks();
console.log("check:codes passed");
