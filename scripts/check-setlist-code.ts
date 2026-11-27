import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { SongContent } from "../src/band-library-model.ts";
import type { ChatMessage } from "../src/chat-model.ts";
import { Phone, startApi, TEST_ORIGIN } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, readQr, settle } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/**
 * C13b, setlist codes and the Bands tab (FABLE-PLAN C13b, PLAN.md 9.3, 8.1). One case per pass condition, named by
 * it. The cases fix this contract, which the cook builds to.
 *
 * `POST /api/codes { kind: "band-setlist", bandId, setlistId }`: a member who may pass the setlist on gets a code whose
 *   `target_id` is `<bandId>/<setlistId>`, landing `?open=setlists&code=`. A Private band setlist is `403 private_copy`
 *   for everyone but the member who shared it. Asking again hands back the same live code.
 * `POST /api/bands/setlist-code { code }`: an active member gets `{ bandId, setlistId }`. Anyone else gets `403` with
 *   the body `{ error: "not-in-band" }` and nothing more. A code of another kind is `400 not-a-setlist-code`.
 * `POST /api/codes { kind: "my-setlist", choice, name, songs: [{ song, copyId }], setlistCopyId }`: `choice` is asked
 *   first (`400 choice_required`). The songs are the ticked ones. A copy that may not be passed on is `403 private_copy`.
 * `POST /api/chat/setlist-code { code }`: the scanner gets the copy as a `kind: "setlist"` card in their DM with the
 *   code's owner, `{ roomId }`. The card text is JSON `{ name, titles, copyId, sharedAs, reshareable }`. The same
 *   scan again stores nothing more. The owner is `400 yourself`, someone who may not DM them `403 not-friends`.
 * `POST /api/chat/setlist-copy { copyId }`: only the scanner who holds `copyId` gets `{ name, songs: [{ song, copyId }],
 *   reshareable }`. Anyone else is `404 not-found`.
 *
 * On the phone: the tabs are My Songs, Setlists, Bands. The Bands tab (`.bands-tab`) lists each band as a button that
 * starts with its name, and signed out says "Sign in to see your bands." with Sign
 * in. A band's tabs are Songs, Setlists, Chat, Gigs, Members. A band setlist row is `[data-setlist=<id>]`, has Show
 * code or "Add a song first", and the row a code landed on has `aria-current="true"`. A personal setlist has Show
 * code, which opens `.setlist-code-sheet` with one ticked box per song, Private and Public, then Show code. A DM card
 * is `.setlist-card` with Add to My Songs, then "In your Setlists".
 */

type Reply = { status: number; body: Record<string, any> };
type Player = Phone & { name: string; userId: string };
type Card = { name: string; titles: string[]; copyId: string; sharedAs: string; reshareable: boolean };

const root = new URL("..", import.meta.url).pathname;
/** Set SHOTS to a folder to save the setlist code screens at phone size. */
const shots = process.env.SHOTS;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const js = (value: unknown) => JSON.stringify(value);
const refusal = (reply: Reply) => [reply.status, reply.body.error];
const NOT_IN_BAND = "This setlist belongs to a band you're not in";
const API_MINUTE_MS = 1;

const seed = JSON.parse(readFileSync(`${root}data/library.json`, "utf8")) as { songs: (SongContent & { id: number })[] };
const chart = (index: number, title: string, line: string): SongContent => {
  const { id: _id, ...song } = seed.songs[index];
  return { ...song, title, body: [{ heading: "Verse", lines: [{ chords: "G      C", lyrics: line }] }, ...song.body] };
};
const BAND_SONGS = [chart(0, "Blue Notes Alpha", "alpha line"), chart(1, "Blue Notes Bravo", "bravo line"), chart(2, "Blue Notes Charlie", "charlie line")];
const TICKED_A = chart(3, "Sunday Opener", "opener line");
const UNTICKED = chart(4, "Unticked Marker 9Q2", "marker lyric 9Q2");
const TICKED_C = chart(5, "Sunday Closer", "closer line");
const SECRET = [chart(6, "Terry Secret One", "secret one"), chart(7, "Terry Secret Two", "secret two")];

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

function tamperedFrom(code: string, otherKind: string) {
  const parts = code.split(".");
  return {
    "a changed signature": changed(code, -2),
    "a changed last signature character": changed(code, -1),
    "a changed id": changed(code, parts[0].length + 2),
    "a zero in front of the end time": code.replace(`.${parts[2]}.`, `.0${parts[2]}.`),
    "a later end time": code.replace(`.${parts[2]}.`, `.${Number(parts[2]) + 1000}.`),
    "the kind swapped": code.replace(/^[a-z-]+\./, `${otherKind}.`),
    "a made-up payload": `${parts[0]}.AAAAAAAAAAAAAAAA.99999999999999.AAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
  };
}

const ok = (reply: Reply, what: string) => {
  assert.equal(reply.status, 200, `${what} (${js(reply.body).slice(0, 200)})`);
  return reply.body;
};

const cardsIn = (messages: ChatMessage[]) => messages.filter((message) => message.kind === "setlist");
const cardOf = (message: ChatMessage) => JSON.parse(message.text) as Card;

const { worker: apiWorker, base: apiBase } = await startApi({ CODE_MINUTE_MS: String(API_MINUTE_MS) });
let chromeBase = "";
const site = await openSite(root, "check-setlist-code", () => chromeBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker: chromeWorker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
chromeBase = base;

try {
  const player = async (name: string): Promise<Player> => {
    const phone = new Phone(apiBase);
    assert.equal((await phone.createAccount(name)).status, 200, `${name} signs up`);
    return Object.assign(phone, { name, userId: (await phone.call("/api/me")).body.account.userId as string });
  };
  const [terry, mike, dana, rita, ann] = [await player("Terry Bass"), await player("Mike Keys"), await player("Dana Stranger"), await player("Rita Gone"), await player("Ann Friend")];
  const bandId = ok(await terry.call("/api/bands/create", { name: "The Blue Notes" }), "Terry makes the band").bandId as string;
  const invite = ok(await terry.call("/api/codes", { kind: "band", bandId }), "Terry's invite").code as string;
  for (const member of [mike, rita]) ok(await member.call("/api/bands/join", { code: invite }), `${member.name} joins`);
  ok(await terry.call("/api/bands/remove", { bandId, userId: rita.userId }), "Terry removes Rita");
  const bandSongIds: string[] = [];
  for (const song of BAND_SONGS) bandSongIds.push(ok(await terry.call("/api/bands/library/share-song", { bandId, song, choice: "public", localId: null }), `Terry shares ${song.title}`).songId);
  const shareSetlist = async (name: string, songIds: string[], choice: string) =>
    ok(await terry.call("/api/bands/library/share-setlist", { bandId, name, songIds, tags: [], choice, localId: null }), `Terry shares ${name}`).setlistId as string;
  const friday = await shareSetlist("Friday set", bandSongIds, "public");
  const quiet = await shareSetlist("Quiet set", bandSongIds.slice(0, 1), "private");
  const friendLink = ok(await terry.call("/api/codes", { kind: "friend-link" }), "Terry's friend link").code as string;
  ok(await ann.call("/api/friends/add-by-code", { code: friendLink }), "Ann adds Terry by his link");

  const bandCode = (who: Player, setlistId: string) => who.call("/api/codes", { kind: "band-setlist", bandId, setlistId });
  const openBandCode = (who: Phone, code: string) => who.call("/api/bands/setlist-code", { code });
  const myCode = (who: Player, choice: string | null, name: string, songs: { song: SongContent; copyId: string | null }[], setlistCopyId: string | null = null) =>
    who.call("/api/codes", { kind: "my-setlist", choice, name, songs, setlistCopyId });
  const scan = (who: Phone, code: string) => who.call("/api/chat/setlist-code", { code });
  const thread = async (who: Phone, roomId: string) => ok(await who.call("/api/chat/open", { roomId }), "the DM opens").messages as ChatMessage[];

  let sundayCode = "";
  let sundayCard: Card | null = null;

  const app = await appPage(site);
  await site.send("Network.enable");
  const offline = (on: boolean) => site.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const appCalls = (path: string, body: object) =>
    site.evaluate<Reply>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const bandsView = (name: string) =>
    app.until(`document.querySelector(".bands-sheet, .band-page")?.dataset.view === ${js(name)} && !document.querySelector(".bands-sheet, .band-page").textContent.includes("Loading")`, `the ${name} view`, 15000);
  const bandTab = (name: string) => app.click(name, `document.querySelector(".band-tabs")`);
  const setlistRow = (setlistId: string) => `document.querySelector(${js(`.band-library-setlists [data-setlist="${setlistId}"]`)})`;
  const buttonsIn = (scope: string) => site.evaluate<string[]>(`[...(${scope}?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim())`);
  const sheetText = (selector: string) => site.evaluate<string>(`document.querySelector(${js(selector)})?.textContent ?? ""`);
  const codecBundle = await build({
    entryPoints: [join(fileURLToPath(new URL("..", import.meta.url)), "src/chordpro.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  const { chordProToSong } = (await import(
    `data:text/javascript;base64,${Buffer.from(codecBundle.outputFiles[0].text).toString("base64")}`
  )) as { chordProToSong(text: string): SongContent };
  const stored = async () => {
    const raw = await site.evaluate<{ songs: any[]; setlists: any[] }>(`JSON.parse(localStorage.getItem("leadSheetsLibraryV2"))`);
    return {
      ...raw,
      songs: raw.songs.map((entry) =>
        typeof entry?.chordpro === "string"
          ? { ...chordProToSong(entry.chordpro), id: entry.id, ...(entry.copy ? { copy: entry.copy } : {}) }
          : entry,
      ),
    };
  };
  const shownCode = async () => {
    await app.until(`!!document.querySelector(".codes-qr svg")`, "the QR code", 15000);
    const link = readQr(await site.evaluate<string>(`document.querySelector(".codes-qr").innerHTML`));
    return link.split("/c/")[1];
  };
  const finishSignUp = async (name: string) => {
    const atStep = (step: string) => app.until(`document.querySelector(".account-sheet")?.dataset.step === ${js(step)}`, `the ${step} screen`);
    await atStep("start");
    await app.click("New here? Create an account");
    await app.type("Your name (what bandmates see)", name);
    await app.click("Sign in with Face ID or fingerprint");
    await atStep("nudge");
    await app.click("Not now");
    await atStep("account");
    await app.click("✕");
  };
  const topTab = async (name: string) => {
    await site.evaluate(`document.getElementById(${js(`tab-${name}`)}).click()`);
    await settle();
  };
  const openBandFromTab = async () => {
    await topTab("bands");
    await app.until(`[...document.querySelectorAll(".bands-tab button")].some((b) => b.textContent.startsWith("The Blue Notes"))`, "The Blue Notes on the Bands tab", 15000);
    await site.evaluate(`[...document.querySelectorAll(".bands-tab button")].find((b) => b.textContent.startsWith("The Blue Notes")).click()`);
    await bandsView("band");
  };
  const closeSheets = async () => {
    await site.evaluate(`document.querySelectorAll("[role=dialog] .account-close").forEach((b) => b.click())`);
    await settle();
  };

  const pTerry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
  const pMike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
  const pBand = ok(await pTerry.call("/api/bands/create", { name: "The Blue Notes" }), "Terry makes the band on the phone's server").bandId as string;
  const pInvite = ok(await pTerry.call("/api/codes", { kind: "band", bandId: pBand }), "Terry's invite there").code as string;
  ok(await pMike.call("/api/bands/join", { code: pInvite }), "Mike joins there");
  const pSongIds: string[] = [];
  for (const song of BAND_SONGS) pSongIds.push(ok(await pTerry.call("/api/bands/library/share-song", { bandId: pBand, song, choice: "public", localId: null }), `Terry shares ${song.title} there`).songId);
  const pShare = async (name: string, songIds: string[], choice: string) =>
    ok(await pTerry.call("/api/bands/library/share-setlist", { bandId: pBand, name, songIds, tags: [], choice, localId: null }), `Terry shares ${name} there`).setlistId as string;
  const pFriday = await pShare("Friday set", pSongIds, "public");
  const pQuiet = await pShare("Quiet set", pSongIds.slice(0, 1), "private");
  const pEmpty = await pShare("Empty set", [], "public");

  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await app.library();

  await check("the top menu has Songs, Setlists and Bands tabs, and Bands lists the player's bands", async () => {
    assert.deepEqual(await app.texts(".tabs [role=tab]"), ["My Songs", "Setlists", "Bands"], "three tabs: My Songs, Setlists, Bands");
    await topTab("bands");
    assert.equal(await site.evaluate<string>("location.hash"), "#/bands", "the Bands tab has its own address");
    await app.until(`document.querySelector(".bands-tab")?.textContent.includes("Sign in to see your bands.")`, "the signed-out Bands screen");
    await app.shot(shots && `${shots}/bands-tab-signed-out.png`);
    await app.click("Sign in", `document.querySelector(".bands-tab")`);
    await finishSignUp("Sam Rivera");
    ok(await appCalls("/api/bands/join", { code: pInvite }), "Sam joins The Blue Notes");
    await topTab("songs");
    await topTab("bands");
    await app.until(`[...document.querySelectorAll(".bands-tab button")].some((b) => b.textContent.startsWith("The Blue Notes"))`, "The Blue Notes on the Bands tab", 15000);
    const listed = await site.evaluate<string[]>(`[...document.querySelectorAll(".bands-tab button")].map((b) => b.textContent.trim()).filter((t) => t.startsWith("The Blue Notes"))`);
    assert.equal(listed.length, 1, `the Bands tab lists Sam's one band (${js(listed)})`);
    await app.shot(shots && `${shots}/bands-tab.png`);
  });

  await check("opening a band shows Songs, Setlists, Chat, Gigs and Members, and band songs are not added to My Songs", async () => {
    const before = await stored();
    await openBandFromTab();
    assert.deepEqual(await app.texts(".band-tabs [role=tab]"), ["Songs", "Setlists", "Chat", "Gigs", "Members"], "the band page sections");
    await bandTab("Songs");
    await app.until(`document.querySelectorAll(".band-library-songs li").length === 3`, "the band's three songs");
    assert.deepEqual((await app.texts(".band-library-songs .band-library-name")).sort(), BAND_SONGS.map((song) => song.title).sort(), "Songs lists the band's charts");
    const after = await stored();
    assert.equal(after.songs.length, before.songs.length, "opening the band's Songs adds nothing to My Songs");
    for (const song of BAND_SONGS) assert.ok(!after.songs.some((mine) => mine.title === song.title), `${song.title} is not in My Songs`);
    await bandTab("Gigs");
    await app.until(`document.querySelector(".band-page")?.textContent.includes("No gigs planned yet.")`, "the empty Gigs section");
    await bandTab("Members");
    await app.until(`document.querySelectorAll(".bands-members li").length === 3`, "the three members");
    await bandTab("Setlists");
    await app.until(`!!${setlistRow(pFriday)}`, "the band's setlists");
    await app.click("+ New setlist", `document.querySelector(".band-page")`);
    await app.type("Setlist name", "Sam picks");
    await site.evaluate(
      `(() => { const field = document.querySelector("[aria-label='Add a band song']"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(field, ${js(pSongIds[1])}); field.dispatchEvent(new Event("change", { bubbles: true })); })()`,
    );
    await settle();
    await app.click("Save", `document.querySelector(".band-page")`);
    await app.click("Public", `document.querySelector(".band-page")`);
    await app.click("Share", `document.querySelector(".band-page")`);
    await app.until(`[...document.querySelectorAll(".band-library-setlists li")].some((li) => li.textContent.includes("Sam picks") && li.textContent.includes("Blue Notes Bravo"))`, "Sam's new band setlist");
    await bandTab("Chat");
    await app.until(`!!document.querySelector(".band-page .chat-messages") && document.querySelector(".band-page h2")?.textContent === "The Blue Notes"`, "the band thread", 15000);
    assert.equal(await site.evaluate<boolean>(`!!document.querySelector("[role=dialog] .chat-messages")`), false, "the chat opens on the band page, not in a sheet");
    await closeSheets();
    assert.equal((await stored()).songs.length, before.songs.length, "nothing on the band page added a song to My Songs");
  });

  await check("a member opens a band setlist code and lands on that setlist", async () => {
    const made = ok(await bandCode(mike, friday), "Mike asks for a code for the Friday set");
    assert.equal((await bandCode(mike, friday)).body.code, made.code, "asking again hands back the same live code");
    const landed = await land(apiBase, made.code);
    assert.deepEqual([landed.status, landed.location], [302, `${TEST_ORIGIN}/?open=setlists&code=${made.code}`], "the link lands on Setlists");
    for (const who of [mike, terry]) assert.deepEqual(ok(await openBandCode(who, made.code), `${who.name} opens it`), { bandId, setlistId: friday }, `${who.name} gets the band and the setlist`);

    await openBandFromTab();
    await bandTab("Setlists");
    await app.until(`!!${setlistRow(pEmpty)}`, "the empty setlist row");
    assert.ok(!(await buttonsIn(setlistRow(pEmpty))).includes("Show code"), "an empty setlist has no Show code");
    assert.match(await site.evaluate<string>(`${setlistRow(pEmpty)}.textContent`), /Add a song first/, "and says Add a song first");
    await offline(true);
    await app.click("Show code", setlistRow(pFriday));
    await app.until(`document.querySelector(".band-page")?.textContent.includes("Can't reach the server")`, "the offline words");
    assert.equal(await site.evaluate<boolean>(`!!document.querySelector(".codes-qr")`), false, "offline, no QR code is shown");
    await offline(false);
    await bandsView("band");
    await bandTab("Setlists");
    await app.until(`!!${setlistRow(pFriday)}`, "the Friday set row again");
    await app.click("Show code", setlistRow(pFriday));
    const code = await shownCode();
    assert.equal(await sheetText(".band-page .codes-words"), "Friday set · The Blue Notes", "the QR says which setlist and band");
    await app.shot(shots && `${shots}/band-setlist-code.png`);
    assert.deepEqual(ok(await pMike.call("/api/bands/setlist-code", { code }), "Mike scans Sam's QR"), { bandId: pBand, setlistId: pFriday }, "the QR opens the Friday set for Mike");
    await closeSheets();

    const link = ok(await pMike.call("/api/codes", { kind: "band-setlist", bandId: pBand, setlistId: pFriday }), "Mike's code on the phone's server").link as string;
    await site.send("Page.navigate", { url: link });
    await app.until(`document.querySelector(${js(`.band-library-setlists [data-setlist="${pFriday}"][aria-current="true"]`)}) !== null`, "the landed setlist, marked", 15000);
    assert.equal(await site.evaluate<string>("location.search"), "", "the landed code leaves the address bar");
    await app.shot(shots && `${shots}/band-setlist-landed.png`);
    await closeSheets();
  });

  await check("a copy code for my own setlist delivers only the ticked songs and asks Private or Public first", async () => {
    const songs = [TICKED_A, TICKED_C].map((song) => ({ song, copyId: null }));
    assert.deepEqual(refusal(await myCode(terry, null, "Sunday set", songs)), [400, "choice_required"], "no code before Private or Public is picked");
    const made = ok(await myCode(terry, "public", "Sunday set", songs), "Terry ticks two of three and picks Public");
    sundayCode = made.code;
    const { roomId } = ok(await scan(ann, made.code), "Ann scans it");
    const cards = cardsIn(await thread(ann, roomId));
    assert.equal(cards.length, 1, "one setlist card in Ann's DM with Terry");
    assert.equal(cards[0].fromId, terry.userId, "from Terry");
    sundayCard = cardOf(cards[0]);
    assert.deepEqual([sundayCard.name, sundayCard.titles, sundayCard.sharedAs, sundayCard.reshareable], ["Sunday set", [TICKED_A.title, TICKED_C.title], "public", true], "the card names the setlist and the ticked songs");
    assert.equal(cards[0].ref, sundayCard.copyId, "the card points at Ann's copy");
    for (const text of [cards[0].text, js(await thread(ann, roomId))]) {
      assert.ok(!text.includes(UNTICKED.title) && !text.includes("marker lyric 9Q2"), "the unticked song appears nowhere in the DM");
      assert.ok(!text.includes("opener line"), "the card carries no chart");
    }
    const copy = ok(await ann.call("/api/chat/setlist-copy", { copyId: sundayCard.copyId }), "Ann takes the copy");
    assert.deepEqual(copy.songs.map((item: { song: SongContent }) => item.song.title), [TICKED_A.title, TICKED_C.title], "the copy holds the two ticked songs, in order");
    assert.deepEqual(copy.songs[0].song.body, TICKED_A.body, "each as the chart Terry ticked");
    assert.ok(!js(copy).includes("9Q2"), "and nothing of the unticked one");
    ok(await scan(ann, made.code), "Ann scans it again");
    assert.equal(cardsIn(await thread(ann, roomId)).length, 1, "a second scan stores no second card");
    assert.deepEqual(refusal(await scan(terry, made.code)), [400, "yourself"], "Terry scanning his own code gets nothing");
    assert.deepEqual(refusal(await scan(dana, made.code)), [403, "not-friends"], "a stranger gets no copy");
    for (const who of [terry, mike]) assert.deepEqual(refusal(await who.call("/api/chat/setlist-copy", { copyId: sundayCard.copyId })), [404, "not-found"], `${who.name} can't take Ann's copy`);

    await topTab("setlists");
    await app.until(`!!document.querySelector("section.setlist[aria-label='Worship Set']")`, "the Worship Set");
    await app.click("Show code", `document.querySelector("section.setlist[aria-label='Worship Set']")`);
    await app.until(`document.querySelectorAll(".setlist-code-sheet input[type=checkbox]").length === 4`, "one box per song");
    assert.ok(await site.evaluate<boolean>(`[...document.querySelectorAll(".setlist-code-sheet input[type=checkbox]")].every((box) => box.checked)`), "every song starts ticked");
    await site.evaluate(`[...document.querySelectorAll(".setlist-code-sheet label")].find((l) => l.textContent.includes("Truth")).click()`);
    await settle();
    const showDisabled = () => site.evaluate<boolean>(`[...document.querySelectorAll(".setlist-code-sheet button")].find((b) => b.textContent.trim() === "Show code")?.disabled ?? null`);
    assert.equal(await showDisabled(), true, "Show code waits for Private or Public");
    await app.click("Public", `document.querySelector(".setlist-code-sheet")`);
    assert.equal(await showDisabled(), false, "then it can be tapped");
    await app.click("Show code", `document.querySelector(".setlist-code-sheet")`);
    const code = await shownCode();
    await app.shot(shots && `${shots}/my-setlist-code.png`);
    const { roomId: samRoom } = ok(await pTerry.call("/api/chat/setlist-code", { code }), "Terry scans Sam's QR");
    const card = cardOf(cardsIn(ok(await pTerry.call("/api/chat/open", { roomId: samRoom }), "Terry's DM with Sam").messages)[0]);
    const taken = ok(await pTerry.call("/api/chat/setlist-copy", { copyId: card.copyId }), "Terry takes the copy");
    assert.deepEqual(taken.songs.map((item: { song: SongContent }) => item.song.title), ["East to West", "Chain Breaker", "To The Table"], "Terry gets only the songs Sam left ticked");
    await closeSheets();

    const secret = ok(await pTerry.call("/api/codes", { kind: "my-setlist", choice: "private", name: "Secret set", songs: SECRET.map((song) => ({ song, copyId: null })), setlistCopyId: null }), "Terry makes a Private copy code");
    for (const round of [1, 2]) {
      await site.send("Page.navigate", { url: secret.link });
      await app.until(`!!document.querySelector(".room .setlist-card")`, "the setlist card in Sam's DM", 15000);
      if (round === 1) {
        assert.match(await sheetText(".room .setlist-card"), /Secret set/, "the card names the setlist");
        await app.click("Add to My Songs", `document.querySelector(".room .setlist-card")`);
        await app.shot(shots && `${shots}/setlist-card.png`);
      }
      await app.until(`document.querySelector(".room .setlist-card")?.textContent.includes("In your Setlists")`, "the card saying it is in Sam's Setlists");
      await closeSheets();
    }
    await site.evaluate(`location.hash = "#/setlists"`);
    const library = await stored();
    const kept = library.setlists.filter((setlist) => setlist.name === "Secret set");
    assert.equal(kept.length, 1, "opening the code twice and adding keeps one setlist");
    assert.deepEqual([kept[0].copy?.canSendOn, kept[0].copy?.from?.name], [false, "Terry Bass"], "the setlist is a Private copy from Terry");
    const keptSongs = kept[0].songIds.map((id: number) => library.songs.find((song) => song.id === id));
    assert.deepEqual(keptSongs.map((song: any) => [song?.title, song?.copy?.from?.name, song?.copy?.canSendOn]), SECRET.map((song) => [song.title, "Terry Bass", false]), "its songs are in My Songs, from Terry, Private");
  });

  await check("a Private setlist gets no code", async () => {
    assert.deepEqual(refusal(await bandCode(mike, quiet)), [403, "private_copy"], "a member asking for a code for Terry's Private band setlist is refused");
    ok(await bandCode(terry, quiet), "Terry, who shared it, gets one");
    const secret = ok(await myCode(terry, "private", "Secret set", [{ song: SECRET[0], copyId: null }]), "Terry makes a Private copy code");
    const { roomId } = ok(await scan(ann, secret.code), "Ann scans it");
    const card = cardsIn(await thread(ann, roomId)).map(cardOf).find((item) => item.name === "Secret set")!;
    assert.deepEqual([card.sharedAs, card.reshareable], ["private", false], "Ann's copy is Private");
    const copy = ok(await ann.call("/api/chat/setlist-copy", { copyId: card.copyId }), "Ann takes it");
    const asked = (setlistCopyId: string | null, copyId: string | null) => myCode(ann, "public", "Secret set", [{ song: copy.songs[0].song, copyId }], setlistCopyId);
    assert.deepEqual(refusal(await asked(card.copyId, copy.songs[0].copyId)), [403, "private_copy"], "Ann asking for a code for her Private copy is refused");
    assert.deepEqual(refusal(await asked(null, null)), [403, "private_copy"], "and so is the same chart sent without naming the copy");
    assert.ok(sundayCard, "the Public Sunday set reached Ann");
    const sunday = ok(await ann.call("/api/chat/setlist-copy", { copyId: sundayCard!.copyId }), "Ann's Public copy");
    ok(await myCode(ann, "private", "Sunday set", sunday.songs.map((item: { song: SongContent; copyId: string }) => ({ song: item.song, copyId: item.copyId })), sundayCard!.copyId), "a Public copy gets a code");

    await openBandFromTab();
    await bandTab("Setlists");
    await app.until(`!!${setlistRow(pQuiet)}`, "the Quiet set row");
    assert.ok(!(await buttonsIn(setlistRow(pQuiet))).includes("Show code"), "Sam's view of Terry's Private band setlist has no Show code");
    assert.ok((await buttonsIn(setlistRow(pFriday))).includes("Show code"), "while the Public one has it");
    assert.deepEqual(refusal(await appCalls("/api/codes", { kind: "band-setlist", bandId: pBand, setlistId: pQuiet })), [403, "private_copy"], "and the phone asking anyway is refused");
    await closeSheets();
    await topTab("setlists");
    await app.until(`!!document.querySelector("section.setlist[aria-label='Secret set']")`, "Sam's Secret set");
    assert.ok(!(await buttonsIn(`document.querySelector("section.setlist[aria-label='Secret set']")`)).includes("Show code"), "Sam's Private copy has no Show code");
    const library = await stored();
    const held = library.setlists.find((setlist) => setlist.name === "Secret set");
    const heldSongs = held.songIds.map((id: number) => library.songs.find((song) => song.id === id));
    const { ref: _r, id: _i, copy: _c, ...first } = heldSongs[0];
    assert.deepEqual(
      refusal(await appCalls("/api/codes", { kind: "my-setlist", choice: "public", name: "Secret set", songs: [{ song: first, copyId: heldSongs[0].copy.id }], setlistCopyId: held.copy.id })),
      [403, "private_copy"],
      "the phone asking for a code for its Private copy is refused",
    );
  });

  await check("a tampered, expired or stopped setlist code is refused at the link and in the app", async () => {
    const band = ok(await bandCode(mike, friday), "Mike's Friday set code").code as string;
    assert.ok(sundayCode, "Terry's Sunday set code exists");
    const cases = [
      { kind: "band-setlist", code: band, other: "my-setlist", open: (code: string) => openBandCode(mike, code) },
      { kind: "my-setlist", code: sundayCode, other: "band-setlist", open: (code: string) => scan(ann, code) },
    ];
    for (const { kind, code, other, open } of cases) {
      for (const [what, bad] of Object.entries(tamperedFrom(code, other))) {
        const page = await land(apiBase, bad);
        assert.equal(page.status, 404, `${kind}: ${what} is refused at the link`);
        assert.match(page.type, /^text\/html/, `${kind}: ${what} gets a page`);
        assert.match(page.text, /This code doesn't work/, `${kind}: ${what} says it doesn't work`);
        assert.match(page.text, /Open Groovist/, `${kind}: ${what} links back to the app`);
        for (const secret of ["Blue Notes", "Friday", "Sunday", "Terry"]) assert.ok(!page.text.includes(secret), `${kind}: ${what} shows no ${secret}`);
        assert.deepEqual(refusal(await open(bad)), [404, "bad-code"], `${kind}: ${what} is refused in the app`);
      }
    }
    assert.deepEqual(refusal(await openBandCode(ann, sundayCode)), [400, "not-a-setlist-code"], "a copy code is not a band setlist code");
    assert.deepEqual(refusal(await scan(mike, band)), [400, "not-a-setlist-code"], "a band setlist code is not a copy code");

    assert.equal((await terry.call("/api/codes/stop", { code: band })).status, 404, "Terry can't stop Mike's code");
    ok(await mike.call("/api/codes/stop", { code: band }), "Mike stops his code");
    const stopped = await land(apiBase, band);
    assert.equal(stopped.status, 410, "a stopped band setlist code is refused at the link");
    assert.match(stopped.text, /This code was stopped/, "and says it was stopped");
    assert.deepEqual(refusal(await openBandCode(terry, band)), [410, "code-stopped"], "and in the app");
    assert.notEqual(ok(await bandCode(mike, friday), "Mike asks again").code, band, "after Stop, a new code is made");

    const short = ok(await myCode(terry, "public", "Short set", [{ song: TICKED_A, copyId: null }]), "Terry makes a copy code").code as string;
    ok(await terry.call("/api/codes/stop", { code: short }), "Terry stops it");
    assert.deepEqual(refusal(await scan(ann, short)), [410, "code-stopped"], "a stopped copy code gives no copy");
    const ending = ok(await myCode(terry, "public", "Ending set", [{ song: TICKED_A, copyId: null }]), "Terry makes another").code as string;
    await sleep(7 * 24 * 60 * API_MINUTE_MS + 400);
    const ended = await land(apiBase, ending);
    assert.equal(ended.status, 410, "an ended copy code is refused at the link");
    assert.match(ended.text, /This code has ended/, "and says it has ended");
    assert.match(ended.text, /Open Groovist/, "with the way back to the app");
    assert.deepEqual(refusal(await scan(ann, ending)), [410, "code-ended"], "and gives no copy in the app");

    const pStopped = ok(await pTerry.call("/api/codes", { kind: "band-setlist", bandId: pBand, setlistId: pFriday }), "Terry's code on the phone's server").link as string;
    ok(await pTerry.call("/api/codes/stop", { code: pStopped.split("/c/")[1] }), "Terry stops it");
    await site.send("Page.navigate", { url: `${origin}/?open=setlists&code=${pStopped.split("/c/")[1]}` });
    await app.until(`document.querySelector(".bands-sheet")?.textContent.includes("This code was stopped. Ask for a fresh one.")`, "the stopped words in the app");
    assert.ok(!(await sheetText(".bands-sheet")).includes("Friday set"), "the refusal names no setlist");
    await closeSheets();
  });

  await check("a signed-out visitor who opens a setlist link can sign in or close the sheet and keep using the app", async () => {
    const link = ok(await pMike.call("/api/codes", { kind: "band-setlist", bandId: pBand, setlistId: pFriday }), "Mike's Friday set link").link as string;
    await site.send("Network.clearBrowserCookies");
    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await app.library();
    await site.send("Page.navigate", { url: link });
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "start"`, "the sign-in sheet", 15000);
    await app.click("✕", `document.querySelector(".account-sheet")`);
    await app.until(`!document.querySelector(".account-sheet")`, "the sheet closed");
    await settle(800);
    assert.equal(await site.evaluate<boolean>(`!!document.querySelector("[role=dialog]")`), false, "no other sheet opens after Close");
    await topTab("setlists");
    await app.until(`document.querySelectorAll("section.setlist").length >= 2`, "the Setlists tab");
    assert.ok(await site.evaluate<boolean>(`location.hash === "#/setlists" && !document.querySelector("[role=dialog]")`), "the app keeps working signed out");

    await site.send("Page.navigate", { url: link });
    await finishSignUp("Pat Lee");
    await app.until(`document.querySelector(".bands-sheet")?.textContent.includes(${js(NOT_IN_BAND)})`, "the landing after signing in", 15000);
    await closeSheets();
  });

  await check("a non-member gets 'This setlist belongs to a band you're not in' and the response holds no name or song", async () => {
    const code = ok(await bandCode(mike, friday), "Mike's code").code as string;
    for (const who of [dana, rita]) {
      const reply = await openBandCode(who, code);
      assert.equal(reply.status, 403, `${who.name} is refused`);
      assert.deepEqual(reply.body, { error: "not-in-band" }, `${who.name}'s reply holds the refusal and nothing else`);
    }
    assert.deepEqual(refusal(await openBandCode(new Phone(apiBase), code)), [401, "signed-out"], "a signed-out phone is asked to sign in");
    assert.deepEqual(refusal(await bandCode(dana, friday)), [403, "not-a-member"], "a stranger can't make a code for the band's setlist");

    const link = ok(await pMike.call("/api/codes", { kind: "band-setlist", bandId: pBand, setlistId: pFriday }), "Mike's link").link as string;
    await site.send("Page.navigate", { url: link });
    await app.until(`document.querySelector(".bands-sheet")?.textContent.includes(${js(NOT_IN_BAND)})`, "the not-in-band words for Pat", 15000);
    const text = await sheetText(".bands-sheet");
    for (const secret of ["Friday set", "The Blue Notes", ...BAND_SONGS.map((song) => song.title)]) assert.ok(!text.includes(secret), `the phone shows no ${secret}`);
    await app.shot(shots && `${shots}/setlist-not-in-band.png`);
    await closeSheets();
  });

  await check("a guest opens only their gig's setlist", async () => {
    const second = await shareSetlist("Second set", bandSongIds.slice(1), "public");
    for (const setlistId of [friday, second]) {
      const code = ok(await bandCode(terry, setlistId), "Terry's code").code as string;
      assert.deepEqual(refusal(await openBandCode(dana, code)), [403, "not-in-band"], "someone with no guest pass is refused either setlist");
    }
    console.log("pending  a guest opens only their gig's setlist: guest passes arrive with C21c, so the guest on gig g1 opening s1 and refused s2 is not checked yet");
  });

  await check("the setlist code carries no band name, setlist name or song", async () => {
    const band = ok(await bandCode(mike, friday), "a band setlist code");
    const mine = ok(await myCode(terry, "public", "Sunday set", [{ song: TICKED_A, copyId: null }]), "a copy code");
    for (const [kind, made] of [["band-setlist", band], ["my-setlist", mine]] as const) {
      const parts = made.code.split(".");
      assert.equal(parts.length, 5, `${kind}: the payload is kind, id, end time, nonce and signature`);
      assert.equal(parts[0], kind, `${kind}: the payload names its kind`);
      assert.equal(made.link, `${TEST_ORIGIN}/c/${made.code}`, `${kind}: the link is the payload on the app's origin`);
      for (const secret of ["blue notes", "friday", "sunday", TICKED_A.title.toLowerCase(), bandId.toLowerCase(), friday.toLowerCase(), terry.userId.toLowerCase(), mike.userId.toLowerCase(), "terry", "mike"]) {
        assert.ok(!made.link.toLowerCase().includes(secret), `${kind}: the link carries no ${secret}`);
      }
    }
  });

  await check("no page errors", async () => assert.deepEqual(await app.errors(), [], "the page logged no errors"));
} finally {
  await site.close();
  await chromeWorker.dispose();
  await apiWorker.dispose();
}

if (failed > 0) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("check:setlist-code passed");
