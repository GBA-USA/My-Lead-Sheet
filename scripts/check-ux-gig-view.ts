import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SongContent } from "../src/band-library-model.ts";
import type { GigPack, GigPlan } from "../src/gig-pack.ts";
import { Phone, startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle } from "./app-page.ts";
import { chordAnchors, type Row } from "./chord-anchors.ts";
import { openSite } from "./chrome.ts";

/**
 * U6, the gig view and the gig-mode sheet (UX-PLAN U6, SCREEN-MAP 5). One case per pass condition, named by it. The
 * cases fix this contract.
 *
 * The gig view at `#/gig/<bandId>/<gigId>` is `.gig-view[data-gig=<gigId>]` in the app's scroll area, with the gig's
 * name in its `h2` and `.gig-count` "N songs on this phone". `.gig-progress` holds one `span` per song, the current one
 * `[aria-current=step]`. `.gig-now` holds `.gig-kicker` "NOW · 1 OF 3", `.gig-title`, Open sheet and Metronome buttons.
 * `.gig-next` holds the next `.gig-title`. `.band-status-slot` is an empty slot. `.gig-set li` lists the whole set in
 * order; every row but Now is a button for whoever may move the set, and plain text for a member. The bottom bar
 * `.live-nav` holds Prev (`[aria-label="Previous song"]`) and
 * Next (`[aria-label="Next song"]`) at 64 px for whoever may move the set, and is absent for a member, who reads
 * "Following the leader starts when the gig goes live." End shows for the leader, backup or an admin, asks "End the
 * gig for everyone?" with Yes, end and Keep going, then lands on `#/band/<bandId>`. Offline, End is disabled with
 * "Needs a connection". With no pack on this phone the view says "This song isn't on this phone." with Get ready.
 *
 * The gig-mode sheet at `#/gig/<bandId>/<gigId>/<index>` and the setlist's `#/live/<id>/<index>` show `LeadSheet`
 * (`.sheet .sheet-name`) under the song header and a bottom bar `.live-nav` with Prev, "Scroll: On|Off" and Next at
 * 64 px, with no `.controls`, Key, Notes, Metronome pill or Send. Back from the sheet is the gig view at the same index.
 * The gig routes and `#/live` keep the stage palette under day mode (`.app` is `.gig-stage`); leaving restores it.
 *
 * `POST /api/bands/gig/end { bandId, gigId }`: the leader, backup or an admin ends the gig; `gig/open` then returns
 * `status: "ended"`. Anyone else is `403 not-allowed`; a stranger `403 not-a-member`.
 */

type Reply = { status: number; body: Record<string, any> };
type GigView = { gig: GigPlan; packRev: number; receipts: { userId: string; packRev: number; at: number }[] };

const root = new URL("..", import.meta.url).pathname;
const shots = process.env.SHOTS;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const js = (value: unknown) => JSON.stringify(value);
const refusal = (reply: Reply) => [reply.status, reply.body.error];
const gigId = () => `gig_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;
const dayFromNow = (days: number) => {
  const day = new Date();
  day.setDate(day.getDate() + days);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};

const seed = JSON.parse(readFileSync(`${root}data/library.json`, "utf8")) as { songs: (SongContent & { id: number })[]; setlists: { id: number; songIds: number[] }[] };
const content = ({ id: _id, ...song }: SongContent & { id: number }): SongContent => song;
const SET_SONGS = seed.songs.slice(0, 3);
const TITLES = SET_SONGS.map((song) => song.title);
const FIRST = SET_SONGS[0];
const marks = (...at: [number, number][]) => at.map(([time, progress]) => ({ at: time, progress }));
/** Timing that reaches the chart's end in six seconds at the song's own tempo, so which version scrolls shows within a breath. */
const BAND_TIMING = { name: "Band", bpm: FIRST.tempo, marks: marks([0, 0], [6, 1]) };
const OWN_TIMING = { name: "Mine", bpm: FIRST.tempo, marks: marks([0, 0], [14, 1]) };
const LEARNED = {
  name: "Heard",
  bpm: FIRST.tempo,
  marks: marks([0, 0], [3, 0], [197, 1]),
  learned: { beatsPerBar: 4, downbeat: 3, beats: Array.from({ length: 24 }, (_, i) => 3 + i * 0.5), sections: [{ heading: "Verse 1", at: 3 }, { heading: "Chorus", at: 9 }], vocals: [] },
};
const FOLLOWING = "Following the leader starts when the gig goes live.";
const NEEDS_CONNECTION = "Needs a connection";
const NOT_ON_PHONE = "This song isn't on this phone.";
const STAGE_BG = "rgb(19, 18, 13)";

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

function viewOf(reply: Reply, what: string): GigView {
  assert.equal(reply.status, 200, `${what} (${js(reply.body)})`);
  assert.ok(reply.body.gig && Array.isArray(reply.body.receipts), `${what}: the reply is a gig view`);
  return reply.body as GigView;
}

let apiBase = "";
const site = await openSite(root, "check-ux-gig-view", () => apiBase, ["--autoplay-policy=no-user-gesture-required"]);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;
try {
  const app = await appPage(site);
  const offline = (on: boolean) => site.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const appCalls = (path: string, body: object) =>
    site.evaluate<Reply>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const text = (selector: string) => site.evaluate<string>(`document.querySelector(${js(selector)})?.textContent ?? ""`);
  const has = (selector: string) => site.evaluate<boolean>(`!!document.querySelector(${js(selector)})`);
  const buttons = (scope = "document") => site.evaluate<string[]>(`[...${scope}.querySelectorAll("button")].map((b) => b.textContent.trim() || b.getAttribute("aria-label"))`);
  const disabled = (selector: string) => site.evaluate<boolean | null>(`document.querySelector(${js(selector)})?.disabled ?? null`);
  const hash = () => site.evaluate<string>("location.hash");
  const go = async (next: string, ready: string, what: string) => {
    await site.evaluate(`location.hash = ${js(next)}`);
    await app.until(ready, what, 15000);
  };
  const reload = async () => {
    await site.evaluate(`window.__beforeReload = true; location.reload()`);
    await app.until(`!window.__beforeReload && !!document.querySelector(".shell-header")`, "the reload", 15000);
  };
  const gigViewOf = (id: string) => `document.querySelector(${js(`.gig-view[data-gig="${id}"]`)})`;
  const onGigView = (id: string) => app.until(`!!${gigViewOf(id)} && !${gigViewOf(id)}.textContent.includes("Loading")`, `the gig view for ${id}`, 15000);
  const nowTitle = () => text(".gig-now .gig-title");
  const nextTitle = () => text(".gig-next .gig-title");
  const currentStep = () => site.evaluate<number>(`[...document.querySelectorAll(".gig-progress > span")].findIndex((s) => s.getAttribute("aria-current") === "step")`);
  const bandPage = (id: string) => `document.querySelector(${js(`.band-page[data-band="${id}"]`)})`;
  const openBand = (id: string) => go(`#/band/${id}`, `${bandPage(id)}?.dataset.view === "band" && !${bandPage(id)}.textContent.includes("Loading")`, "the band page");
  const sheetRows = () =>
    site.evaluate<Row[]>(`[...document.querySelectorAll(".chart .pair")].filter((pair) => pair.querySelector(".chords")?.firstChild && pair.querySelector(".lyrics")?.firstChild).map((pair) => {
      const chords = pair.querySelector(".chords");
      const lyrics = pair.querySelector(".lyrics");
      const range = (node, from, to) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return r.getBoundingClientRect(); };
      const text = chords.textContent;
      const lyric = lyrics.textContent;
      const left = lyrics.getBoundingClientRect().left;
      const advance = range(lyrics.firstChild, 0, lyric.length).width / lyric.length;
      return { chords: text, lyrics: lyric, at: [...text.matchAll(/\\S+/g)].map((chord) => Math.round((range(chords.firstChild, chord.index, chord.index + 1).left - left) / advance)) };
    })`);
  const barButtons = () => site.evaluate<{ text: string; height: number }[]>(`[...document.querySelectorAll(".live-nav button")].map((b) => ({ text: b.textContent.trim(), height: b.getBoundingClientRect().height }))`);
  const stageBar = async (where: string) => {
    const bar = await barButtons();
    assert.deepEqual(bar.map((b) => b.text.split(":")[0]), ["Prev", "Scroll", "Next"], `${where}: the bar has Prev, Scroll, Next (${js(bar)})`);
    for (const button of bar) assert.ok(button.height >= 63.5, `${where}: ${button.text} is 64 px tall (${button.height})`);
    assert.ok(!(await has(".controls")) && !(await has("[aria-label='Transpose up']")) && !(await has(".notes-switch")), `${where}: no Key or Notes controls`);
    assert.ok(!(await has(".metronome-pill")) && !(await has(".send-btn")) && !(await has(".scroll-caret")), `${where}: no Metronome pill, Send or Scroll sheet`);
  };
  /** The packs in the phone's IndexedDB, and a way to put an edited one back. */
  const packsOnPhone = () =>
    site.evaluate<GigPack[]>(`(async () => {
      const db = await new Promise((done, fail) => { const r = indexedDB.open("mls-phone"); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
      try {
        if (!db.objectStoreNames.contains("gigPacks")) return [];
        return await new Promise((done, fail) => { const r = db.transaction("gigPacks").objectStore("gigPacks").getAll(); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
      } finally { db.close(); }
    })()`);
  const putPack = (pack: GigPack) =>
    site.evaluate(`(async () => {
      const db = await new Promise((done, fail) => { const r = indexedDB.open("mls-phone"); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
      try {
        await new Promise((done, fail) => { const t = db.transaction("gigPacks", "readwrite"); t.objectStore("gigPacks").put(${js(pack)}, ${js(pack.gig.gigId)}); t.oncomplete = () => done(null); t.onerror = () => fail(t.error); });
      } finally { db.close(); }
    })()`);
  const editPack = async (id: string, change: (pack: GigPack) => void) => {
    const pack = (await packsOnPhone()).find((item) => item.gig.gigId === id);
    assert.ok(pack, `the pack for ${id} on this phone`);
    change(pack);
    await putPack(pack);
  };
  const me = () => site.evaluate<{ account?: { userId: string } }>(`fetch("/api/me").then((r) => r.json())`).then((reply) => reply.account);

  const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
  const dana = await passwordPlayer(base, origin, "Dana Drums", "danadrums");
  const eve = await passwordPlayer(base, origin, "Eve Spam", "evespam");
  const bandId = (await terry.call("/api/bands/create", { name: "The Blue Notes" })).body.bandId as string;
  const invite = (await terry.call("/api/codes", { kind: "band", bandId })).body.code as string;
  for (const member of [mike, dana]) assert.equal((await member.call("/api/bands/join", { code: invite })).status, 200, `${member.name} joins`);
  const shared: string[] = [];
  for (const song of SET_SONGS) {
    const reply = await terry.call("/api/bands/library/share-song", { bandId, song: content(song), choice: "public", localId: null });
    assert.equal(reply.status, 200, `Terry shares ${song.title} into the band`);
    shared.push(reply.body.songId);
  }
  const setlist = await terry.call("/api/bands/library/share-setlist", { bandId, name: "Friday set", songIds: shared, tags: [], choice: "public", localId: null });
  assert.equal(setlist.status, 200, `Terry shares the Friday set (${js(setlist.body)})`);
  const setlistId = setlist.body.setlistId as string;
  assert.equal((await terry.call("/api/bands/settings", { bandId, scrollWithLeader: true })).status, 200, "Terry turns Scroll with the leader on");
  const bandRef = `${bandId}/${shared[0]}`;

  await site.send("Network.enable");
  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await app.library();
  await app.signUp("Sam Rivera");
  const sam = await me();
  assert.ok(sam, "Sam is signed in on the phone");
  assert.equal((await appCalls("/api/bands/join", { code: invite })).status, 200, "Sam joins the band");
  const everyone = [terry.userId, sam.userId, mike.userId, dana.userId];
  const plan = (over: Record<string, unknown>) => terry.call("/api/bands/gig/plan", { bandId, setlistId, gigId: gigId(), lineup: everyone, ...over });
  const open = (who: Phone, id: string) => who.call("/api/bands/gig/open", { bandId, gigId: id });
  const end = (who: Phone, id: string) => who.call("/api/bands/gig/end", { bandId, gigId: id });
  const friday = viewOf(await plan({ name: "Friday at the Elks", date: dayFromNow(2), leader: sam.userId, backup: mike.userId }), "Terry plans Friday with Sam leading").gig.gigId;
  const sunday = viewOf(await plan({ name: "Sunday brunch", date: dayFromNow(9), leader: mike.userId }), "Terry plans Sunday with Mike leading").gig.gigId;
  await openBand(bandId);
  const card = `${bandPage(bandId)}.querySelector(".next-gig")`;
  await app.until(`/Pack 3 of 3 downloaded/.test(${card}?.textContent ?? "")`, "the Friday pack on this phone", 20000);
  await eventually(packsOnPhone, (packs) => packs.some((pack) => pack.gig.gigId === sunday), "the Sunday pack on this phone", 20000);

  await check("Start gig opens the gig view with the first song as Now and the pack count", async () => {
    await openBand(bandId);
    await app.until(`${card}?.dataset.nextGig === ${js(friday)}`, "Friday on top");
    await app.click("Start gig", card);
    await app.until(`location.hash === ${js(`#/gig/${bandId}/${friday}`)}`, "the gig view hash");
    await onGigView(friday);
    assert.match(await text(`.gig-view[data-gig="${friday}"] h2`), /Friday at the Elks/, "the gig's name is the title");
    assert.equal(await text(".gig-count"), "3 songs on this phone", "the pack count");
    assert.equal(await text(".gig-now .gig-kicker"), "NOW · 1 OF 3", "the Now kicker");
    assert.equal(await nowTitle(), TITLES[0], "the first song is Now");
    assert.equal(await nextTitle(), TITLES[1], "the second is Next");
    assert.ok(await has(".band-status-slot"), "the status slot is there for U7");
    await app.shot(shots && `${shots}/gig-view.png`);
  });

  await check("Next and Prev move Now, Next and the progress, and are disabled at the ends", async () => {
    await go(`#/gig/${bandId}/${friday}`, `!!${gigViewOf(friday)}`, "the gig view");
    await onGigView(friday);
    assert.equal(await disabled("[aria-label='Previous song']"), true, "Prev is disabled on the first song");
    assert.equal(await disabled("[aria-label='Next song']"), false, "Next is enabled on the first song");
    assert.equal(await currentStep(), 0, "the first segment is current");
    await app.click("Next", `document.querySelector(".live-nav")`);
    await app.until(`document.querySelector(".gig-now .gig-title")?.textContent === ${js(TITLES[1])}`, "the second song as Now");
    assert.equal(await nextTitle(), TITLES[2], "the third is Next");
    assert.equal(await currentStep(), 1, "the second segment is current");
    assert.equal(await text(".gig-now .gig-kicker"), "NOW · 2 OF 3", "the kicker counts along");
    await app.click("Next", `document.querySelector(".live-nav")`);
    await app.until(`document.querySelector(".gig-now .gig-title")?.textContent === ${js(TITLES[2])}`, "the last song as Now");
    assert.equal(await disabled("[aria-label='Next song']"), true, "Next is disabled on the last song");
    assert.ok(!(await has(".gig-next .gig-title")), "nothing is Next after the last song");
    await app.click("Prev", `document.querySelector(".live-nav")`);
    await app.until(`document.querySelector(".gig-now .gig-title")?.textContent === ${js(TITLES[1])}`, "Prev back to the second song");
    assert.equal(await currentStep(), 1, "the segment follows Prev");
  });

  await check("a Later row jumps for the leader and does nothing for a member", async () => {
    await go(`#/gig/${bandId}/${friday}`, `!!${gigViewOf(friday)}`, "the gig view");
    await onGigView(friday);
    await app.until(`document.querySelector(".gig-now .gig-title")?.textContent === ${js(TITLES[1])}`, "the leader's place in the set kept");
    const later = await site.evaluate<string[]>(`[...document.querySelectorAll(".gig-set li")].map((li) => li.textContent.trim())`);
    assert.ok(later.some((row) => row.includes(TITLES[2])), `the third song is in Later (${js(later)})`);
    await app.click(TITLES[2], `document.querySelector(".gig-set")`);
    await app.until(`document.querySelector(".gig-now .gig-title")?.textContent === ${js(TITLES[2])}`, "the tapped song as Now");
    assert.equal(await currentStep(), 2, "the segment jumps too");

    await go(`#/gig/${bandId}/${sunday}`, `!!${gigViewOf(sunday)}`, "Sunday's gig view, where Sam is a member");
    await onGigView(sunday);
    assert.equal(await nowTitle(), TITLES[0], "a member sees the first song as Now");
    assert.equal(await site.evaluate<number>(`document.querySelectorAll(".gig-set li button").length`), 0, "a member's Later rows are not buttons");
    await site.evaluate(`[...document.querySelectorAll(".gig-set li")].find((li) => li.textContent.includes(${js(TITLES[2])})).click()`);
    await settle(400);
    assert.equal(await nowTitle(), TITLES[0], "a member's tap on a Later row changes nothing");
  });

  await check("Open sheet shows the lead sheet with lyrics and chords over syllables at the current song and back returns to the gig view at the same index", async () => {
    const solo = `#/song/${SET_SONGS[1].id}`;
    await go(solo, `document.querySelector(".sheet .sheet-name")?.textContent === ${js(TITLES[1])} && document.querySelectorAll(".chart .pair").length > 0`, "the solo sheet");
    await settle(300);
    const soloRows = await sheetRows();
    assert.ok(soloRows.length > 0, "the solo sheet has lyric rows");
    await go(`#/gig/${bandId}/${friday}`, `!!${gigViewOf(friday)}`, "the gig view");
    await onGigView(friday);
    await app.click(TITLES[1], `document.querySelector(".gig-set")`);
    await app.until(`document.querySelector(".gig-now .gig-title")?.textContent === ${js(TITLES[1])}`, "the second song as Now");
    await app.click("Open sheet", `document.querySelector(".gig-now")`);
    await app.until(`location.hash === ${js(`#/gig/${bandId}/${friday}/1`)} && document.querySelector(".sheet .sheet-name")?.textContent === ${js(TITLES[1])}`, "the stage sheet at the current song");
    await settle(300);
    const stageRows = await sheetRows();
    assert.ok(stageRows.length > 0 && stageRows.some((row) => row.lyrics.trim().length > 0), "the stage sheet has lyrics");
    assert.deepEqual(chordAnchors(stageRows), chordAnchors(soloRows), "every chord sits on the same syllable as on the solo sheet");
    await app.shot(shots && `${shots}/gig-sheet.png`);
    await site.evaluate(`document.querySelector(".shell-header [aria-label=Back]").click()`);
    await app.until(`location.hash === ${js(`#/gig/${bandId}/${friday}`)}`, "back on the gig view");
    await onGigView(friday);
    assert.equal(await nowTitle(), TITLES[1], "at the same index");
  });

  await check("the stage bar has Prev, Scroll, Next at 64 px and no Key, Notes, Metronome or Send controls", async () => {
    await go(`#/gig/${bandId}/${friday}/0`, `document.querySelector(".sheet .sheet-name")?.textContent === ${js(TITLES[0])}`, "the stage sheet");
    await stageBar("the gig-mode sheet");
    assert.equal(await disabled("[aria-label='Previous song']"), true, "Prev is disabled on the first song");
    await app.click("Next", `document.querySelector(".live-nav")`);
    await app.until(`location.hash === ${js(`#/gig/${bandId}/${friday}/1`)} && document.querySelector(".sheet .sheet-name")?.textContent === ${js(TITLES[1])}`, "Next on the sheet moves the set");
    assert.ok(!(await has(".song-line")), "no Save, Revert or version line on stage");
  });

  await check("the cue bar shows while a learned version plays on stage", async () => {
    await site.evaluate(`localStorage.setItem(${js(`leadSheetsScrollVersions.${bandRef}`)}, ${js(js({ versions: [LEARNED], selected: 0 }))})`);
    await editPack(friday, (pack) => {
      pack.scrollWithLeader = false;
    });
    await reload();
    await go(`#/gig/${bandId}/${friday}/0`, `document.querySelector(".sheet .sheet-name")?.textContent === ${js(TITLES[0])}`, "the stage sheet at the first song");
    await app.click("Scroll: Off", `document.querySelector(".live-nav")`);
    await app.until(`!!document.querySelector(".cue-anchor")`, "the cue strip while the learned version plays");
    await eventually(() => text(".cue"), (cue) => /in \d bars?$/.test(cue), "a section cue such as Chorus in 3 bars", 12000);
    await app.click("Scroll: On", `document.querySelector(".live-nav")`);
  });

  await check("Scroll on stage uses band timing when Scroll with the leader is on and a band version exists, else the player's selected version, else even pace", async () => {
    const openStage = async () => {
      await reload();
      await go(`#/gig/${bandId}/${friday}/0`, `document.querySelector(".sheet .sheet-name")?.textContent === ${js(TITLES[0])}`, "the stage sheet at the first song");
      await site.evaluate(`document.getElementById("sheet-scroll").scrollTop = 0`);
      await settle(200);
    };
    const scrollOn = () => site.evaluate<boolean>(`[...document.querySelectorAll(".live-nav button")].some((b) => b.textContent.trim() === "Scroll: On")`);
    const endsWithin = async (ms: number) => {
      const started = Date.now();
      await app.click("Scroll: Off", `document.querySelector(".live-nav")`);
      await eventually(scrollOn, (on) => !on, `the scroll to reach the end within ${ms} ms`, ms);
      return Date.now() - started;
    };

    await site.evaluate(`localStorage.setItem(${js(`leadSheetsScrollVersions.${bandRef}`)}, ${js(js({ versions: [OWN_TIMING], selected: 0 }))})`);
    await editPack(friday, (pack) => {
      pack.scrollWithLeader = true;
      pack.songs[0].bandTiming = BAND_TIMING;
    });
    await openStage();
    const band = await endsWithin(11000);
    assert.ok(band >= 4000, `band timing ends after its six seconds, not at once (${band} ms)`);

    await editPack(friday, (pack) => {
      pack.scrollWithLeader = false;
    });
    await openStage();
    const own = await endsWithin(20000);
    assert.ok(own >= 11000, `with Scroll with the leader off, the player's 14-second version scrolls (${own} ms)`);

    await editPack(friday, (pack) => {
      pack.scrollWithLeader = true;
      pack.songs[0].bandTiming = null;
    });
    await site.evaluate(`localStorage.removeItem(${js(`leadSheetsScrollVersions.${bandRef}`)})`);
    await openStage();
    await app.click("Scroll: Off", `document.querySelector(".live-nav")`);
    await settle(16000);
    assert.ok(await scrollOn(), "with no band version and no own version the even pace is still going after 16 seconds");
    await app.click("Scroll: On", `document.querySelector(".live-nav")`);
  });

  await check("a member sees no End and no Prev/Next and reads the following line", async () => {
    await go(`#/gig/${bandId}/${sunday}`, `!!${gigViewOf(sunday)}`, "Sunday's gig view");
    await onGigView(sunday);
    const seen = await buttons();
    assert.ok(!seen.includes("End"), `no End for a member (${js(seen)})`);
    assert.ok(!seen.includes("Previous song") && !seen.includes("Next song") && !(await has(".live-nav")), `no Prev or Next for a member (${js(seen)})`);
    assert.ok((await text(`.gig-view[data-gig="${sunday}"]`)).includes(FOLLOWING), "the following line");
    assert.equal(await nowTitle(), TITLES[0], "the Now card still shows the set");
    await app.shot(shots && `${shots}/gig-view-member.png`);
  });

  await check("End asks once, ends the gig for everyone (a second phone's open returns ended), and lands on the band page", async () => {
    await go(`#/gig/${bandId}/${friday}`, `!!${gigViewOf(friday)}`, "Friday's gig view");
    await onGigView(friday);
    await app.click("End");
    await app.until(`document.body.textContent.includes("End the gig for everyone?")`, "the question");
    await app.click("Keep going");
    assert.ok(!(await site.evaluate<boolean>(`document.body.textContent.includes("End the gig for everyone?")`)), "Keep going withdraws the question");
    assert.equal(viewOf(await open(mike, friday), "Mike reads the gig").gig.status, "planned", "nothing ended yet");
    await app.click("End");
    await app.until(`document.body.textContent.includes("End the gig for everyone?")`, "the question again");
    await app.click("Yes, end");
    await app.until(`location.hash.startsWith(${js(`#/band/${bandId}`)})`, "landing on the band page", 15000);
    assert.equal(viewOf(await open(mike, friday), "Mike's phone opens the gig").gig.status, "ended", "the gig is over for everyone");
    await app.until(`${card}?.dataset.nextGig === ${js(sunday)}`, "the next gig card moves on to Sunday", 15000);
  });

  await check("a non-leader's direct end is refused with not-allowed", async () => {
    assert.deepEqual(refusal(await end(dana, sunday)), [403, "not-allowed"], "Dana, on the lineup but not leading, can't end it");
    assert.deepEqual(refusal(await end(eve, sunday)), [403, "not-a-member"], "a stranger can't either");
    assert.equal(viewOf(await open(mike, sunday), "Mike reads Sunday").gig.status, "planned", "Sunday is still on");
  });

  await check("the gig screens stay in stage mode with day mode on, and leaving restores day mode", async () => {
    const appBg = () => site.evaluate<string>(`getComputedStyle(document.querySelector(".app")).backgroundColor`);
    const theme = () => site.evaluate<string>(`document.documentElement.dataset.theme`);
    await site.evaluate(`localStorage.setItem("leadSheetsTheme", "day")`);
    await reload();
    try {
      await openBand(bandId);
      assert.equal(await theme(), "day", "day mode is on");
      const day = await appBg();
      assert.notEqual(day, STAGE_BG, `the band page is in day mode (${day})`);
      await go(`#/gig/${bandId}/${sunday}`, `!!${gigViewOf(sunday)}`, "Sunday's gig view");
      await onGigView(sunday);
      assert.equal(await appBg(), STAGE_BG, "the gig view keeps the stage palette");
      assert.equal(await theme(), "day", "without touching the saved theme");
      await go(`#/gig/${bandId}/${sunday}/0`, `document.querySelector(".sheet .sheet-name")?.textContent === ${js(TITLES[0])}`, "the stage sheet");
      assert.equal(await appBg(), STAGE_BG, "the gig-mode sheet keeps the stage palette");
      await app.shot(shots && `${shots}/gig-sheet-day.png`);
      await openBand(bandId);
      assert.equal(await appBg(), day, "leaving restores day mode");
    } finally {
      await site.evaluate(`localStorage.removeItem("leadSheetsTheme")`);
      await reload();
    }
  });

  const late = viewOf(await plan({ name: "Late show", date: dayFromNow(12), leader: sam.userId }), "Terry plans the Late show with Sam leading").gig.gigId;
  await check("a song missing from the pack shows the Get ready line", async () => {
    assert.ok(!(await packsOnPhone()).some((pack) => pack.gig.gigId === late), "this phone has no pack for the Late show yet");
    await go(`#/gig/${bandId}/${late}`, `!!${gigViewOf(late)}`, "the Late show's gig view");
    await onGigView(late);
    await app.until(`${gigViewOf(late)}.textContent.includes(${js(NOT_ON_PHONE)})`, "the not-on-this-phone line");
    assert.ok(!(await has(".gig-now .gig-title")), "no song is Now before the pack is here");
    await app.click("Get ready", gigViewOf(late));
    await app.until(`document.querySelector(".gig-now .gig-title")?.textContent === ${js(TITLES[0])}`, "the first song as Now once the pack is on the phone", 15000);
    assert.equal(await text(".gig-count"), "3 songs on this phone", "and the count");
  });

  await check("the whole flow works offline after the pack is on the phone, except End which says Needs a connection", async () => {
    await openBand(bandId);
    await settle(500);
    await offline(true);
    try {
      await go(`#/gig/${bandId}/${late}`, `!!${gigViewOf(late)}`, "the Late show's gig view with no signal");
      await onGigView(late);
      assert.equal(await nowTitle(), TITLES[0], "the Now card comes from the pack");
      await app.click("Next", `document.querySelector(".live-nav")`);
      await app.until(`document.querySelector(".gig-now .gig-title")?.textContent === ${js(TITLES[1])}`, "Next with no signal");
      await app.click("Open sheet", `document.querySelector(".gig-now")`);
      await app.until(`document.querySelector(".sheet .sheet-name")?.textContent === ${js(TITLES[1])} && document.querySelectorAll(".chart .pair").length > 0`, "the stage sheet with no signal");
      await stageBar("the gig-mode sheet offline");
      await site.evaluate(`document.querySelector(".shell-header [aria-label=Back]").click()`);
      await onGigView(late);
      assert.equal(await nowTitle(), TITLES[1], "back on the gig view at the same song");
      const seen = await buttons(gigViewOf(late));
      assert.ok(seen.includes("End"), `End is still there (${js(seen)})`);
      assert.equal(await site.evaluate<boolean>(`[...${gigViewOf(late)}.querySelectorAll("button")].find((b) => b.textContent.trim() === "End").disabled`), true, "but disabled with no signal");
      assert.ok((await text(`.gig-view[data-gig="${late}"]`)).includes(NEEDS_CONNECTION), "and it says why");
      await app.shot(shots && `${shots}/gig-view-offline.png`);
    } finally {
      await offline(false);
    }
    await app.until(`![...${gigViewOf(late)}.querySelectorAll("button")].find((b) => b.textContent.trim() === "End").disabled`, "End back once the signal returns");
  });

  await check("`#/live` shows the same bar without the status slot and without End", async () => {
    const live = seed.setlists[0];
    await go(`#/live/${live.id}/0`, `!!document.querySelector(".sheet .sheet-name") && !!document.querySelector(".live-nav")`, "a setlist live");
    await stageBar("#/live");
    assert.match(await text(".live-nav .live-count"), /· 1\/\d+$/, "the bar still counts the setlist");
    assert.ok(!(await has(".band-status-slot")), "no status slot");
    assert.ok(!(await buttons()).includes("End"), "no End");
    await app.click("Next", `document.querySelector(".live-nav")`);
    await app.until(`location.hash === ${js(`#/live/${live.id}/1`)}`, "Next moves the setlist");
    await app.shot(shots && `${shots}/live-sheet.png`);
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
console.log("check:ux-gig-view passed");
