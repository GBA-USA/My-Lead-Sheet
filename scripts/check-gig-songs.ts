import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BandSong, SongContent } from "../src/band-library-model.ts";
import { candidates, reorder } from "../src/gig-plan-model.ts";
import type { passwordPlayer } from "./app-page.ts";

/**
 * P7, the admin edits a planned gig's songs straight on the gig (persona PERSONA-FABLE-PLAN P7). One case per pass
 * condition, named by it. Cases marked (pure) run anywhere, `--pure` runs only those; the rest need Chrome and the Worker.
 * The cases fix this contract.
 *
 * `POST /api/bands/gig/songs { bandId, gigId, songIds }` sets the gig's own song order and answers its `GigView`. Every
 * `GigView` carries `songIds`, the gig's order, beside `songCount`. Only a band admin may (`403 not-allowed`), only while
 * the gig is planned: a live gig is `409 set-locked`, an ended one `409 gig-ended`. `songIds` is 1 to 200 distinct
 * strings, else `400 bad-request`; an id that isn't a band song is `400 not-a-band-song`. A change raises `packRev` and
 * keeps the pack secret (the lineup did not change); the same order again changes nothing. The setlist the gig came
 * from is never touched.
 *
 * `reorder(songIds, from, to)` and `candidates(librarySongs, songIds)` in `src/gig-plan-model.ts` are the editor's model:
 * the order with one song moved, and the band songs not yet in the set, in library order.
 *
 * On the phone an admin's gig card `[data-gig]` has "Edit songs". On a live gig it is disabled and the card says "Set is
 * locked once the gig starts". Edit songs opens a form inside the card: one row per song with "Move up", "Move down" and
 * "Remove", a select labelled "Add a band song" offering only band songs not in the set, the line "To add one of your
 * own songs, share it with the band from the Songs tab first.", "Save" and "Cancel". Save closes the form and the card
 * lists the new order. A Save with no answer shows "Can't reach the server. Check your connection and try again." and
 * keeps the edited list for another Save. A card whose pack on this phone is older than the plan shows
 * "Set changed · <n songs>" until the band page has fetched the new pack.
 */

type Reply = { status: number; body: Record<string, any> };
type Player = Awaited<ReturnType<typeof passwordPlayer>>;
type View = { gig: { gigId: string; status: string; setlistId: string }; packRev: number; receipts: { userId: string; packRev: number }[]; songCount: number; songIds: string[] };

const root = fileURLToPath(new URL("..", import.meta.url));
const PURE_ONLY = process.argv.includes("--pure");
/** Set SHOTS to a folder to save the screens at each width. */
const shots = process.env.SHOTS;
const js = (value: unknown) => JSON.stringify(value);
const refusal = (reply: Reply) => [reply.status, reply.body.error];
const gigId = () => `gig_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;

const OFFLINE = "Can't reach the server. Check your connection and try again.";
const OWN_SONGS = "To add one of your own songs, share it with the band from the Songs tab first.";
const LOCKED = "Set is locked once the gig starts";

let failed = 0;
async function check(name: string, run: () => Promise<void> | void) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const SEED = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: (SongContent & { id: number })[] };
const content = ({ id: _id, ...song }: SongContent & { id: number }): SongContent => song;
/** Fire Away, Neon Moon and Say It Ain't So make the setlist; The Middle and Take Me Out are band songs outside it. */
const SONGS = SEED.songs.slice(0, 5).map(content);
/** A built-in song every phone holds that nobody shared with the band. */
const OWN_ONLY = SEED.songs[5].title;

/** The Worker and Chrome load only for the box cases, so `--pure` runs with neither installed. */
const boxTools = async () => ({ ...(await import("./api-session.ts")), ...(await import("./app-page.ts")), ...(await import("./chrome.ts")) });

async function pureCases() {
  await check("remove and reorder update song_order and raise packRev (pure)", () => {
    const set = ["a", "b", "c", "d"];
    assert.deepEqual(reorder(set, 2, 1), ["a", "c", "b", "d"], "Move up swaps a song with the one before it");
    assert.deepEqual(reorder(set, 0, 1), ["b", "a", "c", "d"], "Move down swaps it with the one after");
    assert.deepEqual(reorder(set, 3, 0), ["d", "a", "b", "c"], "a far move shifts the songs between");
    assert.deepEqual(reorder(set, 0, 3), ["b", "c", "d", "a"], "both ways");
    assert.deepEqual(set, ["a", "b", "c", "d"], "the order it was given is left as it was");
    assert.deepEqual(reorder(set, 0, -1), set, "the first song can't move up");
    assert.deepEqual(reorder(set, 3, 4), set, "the last can't move down");
  });

  await check("the Edit songs picker offers band songs only and points at the Songs tab for own songs (pure)", () => {
    const song = (songId: string, title: string) => ({ songId, song: { title, artist: "", body: [] } }) as unknown as BandSong;
    const library = [song("s1", "Fire Away"), song("s2", "Neon Moon"), song("s3", "The Middle"), song("s4", "Take Me Out")];
    assert.deepEqual(candidates(library, ["s2", "s1"]).map((item) => item.songId), ["s3", "s4"], "the band songs not yet in the set, in library order");
    assert.deepEqual(candidates(library, ["s1", "s2", "s3", "s4"]), [], "a full set offers nothing more");
    assert.deepEqual(candidates(library, ["gone"]).map((item) => item.songId), ["s1", "s2", "s3", "s4"], "an id the band no longer has hides nothing");
    assert.deepEqual(candidates([], []), [], "a band with no songs offers none");
  });
}

// ---- box cases: the Worker and the phone in Chrome ---------------------------------------------------------------

async function shareSongs(who: Player, bandId: string, songs: SongContent[]) {
  const songIds: string[] = [];
  for (const song of songs) {
    const shared = await who.call("/api/bands/library/share-song", { bandId, song, choice: "public", localId: null });
    assert.equal(shared.status, 200, `${song.title} is shared (${js(shared.body)})`);
    songIds.push(shared.body.songId);
  }
  return songIds;
}

async function newBand(admin: Player, name: string, members: Player[]) {
  const bandId = (await admin.call("/api/bands/create", { name })).body.bandId as string;
  const code = (await admin.call("/api/codes", { kind: "band", bandId })).body.code as string;
  for (const member of members) assert.equal((await member.call("/api/bands/join", { code })).status, 200, `${member.name} joins ${name}`);
  return { bandId, code };
}

/** The `gigs` table as it shipped before the P2 columns, so a band room saved then can be rebuilt as it was. */
const GIGS_BEFORE = `CREATE TABLE gigs_before (
  gig_id TEXT PRIMARY KEY, setlist_id TEXT NOT NULL, name TEXT NOT NULL, date TEXT NOT NULL, song_order TEXT NOT NULL,
  lineup TEXT NOT NULL, leader TEXT NOT NULL, backup TEXT, route TEXT NOT NULL, epoch INTEGER NOT NULL, rev INTEGER NOT NULL,
  state TEXT, status TEXT NOT NULL, started_at INTEGER, ended_at INTEGER, secret_rev INTEGER NOT NULL
)`;
const COLUMNS_BEFORE = "gig_id, setlist_id, name, date, song_order, lineup, leader, backup, route, epoch, rev, state, status, started_at, ended_at, secret_rev";

async function boxCases() {
  const { appPage, openSite, PASSWORD_PEPPER, passwordPlayer, settle, startApi } = await boxTools();
  const { DatabaseSync } = await import("node:sqlite");
  const state = mkdtempSync(join(tmpdir(), "gig-songs-"));
  let apiBase = "";
  const site = await openSite(root, "check-gig-songs", () => apiBase);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  const env = { APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER };
  let api = await startApi(env, state);
  apiBase = api.base;
  try {
    const app = await appPage(site);
    /**
     * While `sessionStorage.hold` names a route ("gig/pack", "gig/songs"), its requests wait until `__release()`. While
     * `sessionStorage.fail` names one, its requests fail as with no signal. Both outlive a reload.
     */
    await site.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        window.__held = [];
        window.__release = () => { const held = window.__held; window.__held = []; for (const go of held) go(); return held.length; };
        const fetchNext = window.fetch;
        window.fetch = (input, init) => {
          const url = String(input?.url ?? input);
          const named = (key) => { const route = sessionStorage.getItem(key); return !!route && url.includes("/api/bands/" + route); };
          if (named("fail")) return Promise.reject(new TypeError("Failed to fetch"));
          if (named("hold")) return new Promise((done, fail) => window.__held.push(() => fetchNext(input, init).then(done, fail)));
          return fetchNext(input, init);
        };
      })();`,
    });
    const page = (bandId: string) => `document.querySelector(${js(`.band-page[data-band="${bandId}"][data-view="band"]`)})`;
    const card = (bandId: string, id: string) => `${page(bandId)}?.querySelector(${js(`[data-gig="${id}"]`)})`;
    const editor = (bandId: string, id: string) => `${card(bandId, id)}?.querySelector("form")`;
    const cardText = (bandId: string, id: string) => site.evaluate<string>(`${card(bandId, id)}?.textContent ?? ""`);
    const openGigs = async (bandId: string) => {
      await site.evaluate(`location.hash = "#/bands"`);
      await app.until(`!!document.querySelector(".bands-tab")`, "the Bands tab");
      await site.evaluate(`location.hash = ${js(`#/band/${bandId}?s=gigs`)}`);
      await app.until(`!!${page(bandId)} && !${page(bandId)}.textContent.includes("Loading")`, "the band page", 15000);
      await app.until(`${page(bandId)}?.querySelector(".band-tabs [aria-selected=true]")?.firstChild?.textContent.trim() === "Gigs" && !${page(bandId)}.textContent.includes("Loading")`, "the Gigs section", 15000);
    };
    const reload = async () => {
      await site.evaluate(`window.__beforeReload = true; location.reload()`);
      await app.until(`!window.__beforeReload && document.readyState === "complete"`, "the reload", 15000);
    };
    const button = (scope: string, text: string) => `[...(${scope}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === ${js(text)})`;
    /** The songs the card lists, in order, as the titles in each row. */
    const cardSongs = (bandId: string, id: string, titles: string[]) =>
      site.evaluate<string[]>(`[...(${card(bandId, id)}?.querySelectorAll(".gig-card-songs li") ?? [])].map((li) => ${js(titles)}.find((title) => li.textContent.includes(title)) ?? li.textContent.trim())`);
    /** The editor's rows, in order, as the titles in each. */
    const editorSongs = (bandId: string, id: string, titles: string[]) =>
      site.evaluate<string[]>(`[...(${editor(bandId, id)}?.querySelectorAll("li") ?? [])].map((li) => ${js(titles)}.find((title) => li.textContent.includes(title)) ?? li.textContent.trim())`);
    const rowOf = (bandId: string, id: string, title: string) => `[...(${editor(bandId, id)}?.querySelectorAll("li") ?? [])].find((li) => li.textContent.includes(${js(title)}))`;
    const addSelect = (bandId: string, id: string) => `${editor(bandId, id)}?.querySelector("select[aria-label='Add a band song']")`;
    const offered = (bandId: string, id: string) => site.evaluate<string[]>(`[...(${addSelect(bandId, id)}?.options ?? [])].filter((o) => o.value !== "").map((o) => o.textContent.trim())`);
    const add = async (bandId: string, id: string, title: string) => {
      const picked = await site.evaluate<boolean>(`(() => {
        const select = ${addSelect(bandId, id)};
        const option = [...(select?.options ?? [])].find((o) => o.textContent.trim() === ${js(title)});
        if (!option) return false;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, option.value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
      assert.ok(picked, `${title} offered in Add a band song`);
      await settle();
    };
    const lineupRow = (bandId: string, id: string, name: string) => site.evaluate<string>(`[...(${card(bandId, id)}?.querySelectorAll(".gig-card-lineup li") ?? [])].find((li) => li.textContent.includes(${js(name)}))?.textContent ?? ""`);
    const me = () => site.evaluate<{ account?: { userId: string } }>(`fetch("/api/me").then((r) => r.json())`).then((reply) => reply.account);
    const appCalls = (path: string, body: object) =>
      site.evaluate<Reply>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);

    const terry = await passwordPlayer(api.base, origin, "Terry Bass", "terrybass");
    const mike = await passwordPlayer(api.base, origin, "Mike Keys", "mikekeys");
    const dana = await passwordPlayer(api.base, origin, "Dana Drums", "danadrums");
    const players = [terry, mike, dana];
    const blue = await newBand(terry, "The Blue Notes", [mike, dana]);
    const bandId = blue.bandId;
    const [fire, neon, sayIt, middle, takeMe] = await shareSongs(terry, bandId, SONGS);
    const TITLES = SONGS.map((song) => song.title);
    const titleOf = (songId: string) => TITLES[[fire, neon, sayIt, middle, takeMe].indexOf(songId)];
    const set = await terry.call("/api/bands/library/share-setlist", { bandId, name: "Friday set", songIds: [fire, neon, sayIt], tags: [], choice: "public", localId: null });
    assert.equal(set.status, 200, `the Friday set is shared (${js(set.body)})`);
    const setlistId = set.body.setlistId as string;

    const planApi = async (over: Record<string, unknown> = {}) => {
      const reply = await terry.call("/api/bands/gig/plan", { bandId, setlistId, name: "Friday at the Elks", date: "2026-11-27", ...over });
      assert.equal(reply.status, 200, `Terry plans a gig (${js(reply.body)})`);
      return reply.body.gig.gigId as string;
    };
    const songsApi = (who: Player, id: string, songIds: unknown) => who.call("/api/bands/gig/songs", { bandId, gigId: id, songIds });
    const open = async (who: Player, id: string): Promise<View> => {
      const reply = await who.call("/api/bands/gig/open", { bandId, gigId: id });
      assert.equal(reply.status, 200, `the gig opens (${js(reply.body)})`);
      return reply.body as View;
    };
    const pack = async (who: Player, id: string) => {
      const reply = await who.call("/api/bands/gig/pack", { bandId, gigId: id });
      assert.equal(reply.status, 200, `the pack downloads (${js(reply.body).slice(0, 200)})`);
      return reply.body as { songs: { songId: string }[]; packRev: number; secret: string | null };
    };
    const setlistSongs = async () => ((await mike.call("/api/bands/library", { bandId })).body.setlists as { setlistId: string; songIds: string[] }[]).find((item) => item.setlistId === setlistId)?.songIds;

    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await site.evaluate("Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((done) => setTimeout(done, 20000, false))])");
    if (!(await site.evaluate<boolean>("!!navigator.serviceWorker.controller"))) await site.send("Page.reload");
    await app.until("!!navigator.serviceWorker?.controller", "the service worker to take control of the page", 60000);
    await app.library();
    await app.signUp("Sam Rivera");
    const sam = await me();
    assert.ok(sam, "Sam is signed in on the phone");
    assert.equal((await appCalls("/api/bands/join", { code: blue.code })).status, 200, "Sam joins the band");
    assert.equal((await terry.call("/api/bands/make-admin", { bandId, userId: sam.userId })).status, 200, "Terry makes Sam an admin");

    const g1 = await planApi({ gigId: gigId(), name: "Friday at the Elks" });
    const gLive = await planApi({ gigId: gigId(), name: "Saturday at the Barn", date: "2026-11-28" });
    const gOld = await planApi({ gigId: gigId(), name: "Sunday brunch", date: "2026-11-29" });
    const gOne = await planApi({ gigId: gigId(), name: "Acoustic slot", date: "2026-11-30" });
    const gEnded = await planApi({ gigId: gigId(), name: "Last week", date: "2026-11-13" });
    assert.equal((await terry.call("/api/bands/gig/end", { bandId, gigId: gEnded })).status, 200, "Terry ends Last week");

    await check("admin adds a band song to a planned gig; the gig pack and song list include it; the setlist is unchanged", async () => {
      const before = await open(mike, g1);
      assert.deepEqual(before.songIds, [fire, neon, sayIt], "a new gig starts with the setlist's order");
      const added = await songsApi(terry, g1, [fire, neon, sayIt, middle]);
      assert.equal(added.status, 200, `Terry adds The Middle (${js(added.body)})`);
      const view = added.body as View;
      assert.deepEqual([view.gig.gigId, view.songIds, view.songCount], [g1, [fire, neon, sayIt, middle], 4], "the answer is the gig's view with the new order");
      assert.ok(view.packRev > before.packRev, "and a higher pack rev");
      assert.deepEqual((await open(mike, g1)).songIds, [fire, neon, sayIt, middle], "Mike opens the gig with The Middle last");
      const held = await pack(mike, g1);
      assert.deepEqual(held.songs.map((song) => song.songId), [fire, neon, sayIt, middle], "his pack holds it, in order");
      assert.equal(held.packRev, view.packRev, "at the new rev");
      assert.deepEqual(await setlistSongs(), [fire, neon, sayIt], "the Friday set is untouched");
      const again = await songsApi(terry, g1, [fire, neon, sayIt, middle]);
      assert.deepEqual([again.status, (again.body as View).packRev], [200, view.packRev], "the same order again (a retry after a lost reply) changes nothing");

      await openGigs(bandId);
      await app.until(`!!${button(card(bandId, g1), "Edit songs")}`, "Edit songs on Sam's card", 15000);
      await app.click("Edit songs", card(bandId, g1));
      await app.until(`!!${editor(bandId, g1)}`, "the song editor in the card");
      assert.deepEqual(await editorSongs(bandId, g1, TITLES), [TITLES[0], TITLES[1], TITLES[2], TITLES[3]], "the editor starts from the gig's order, not the setlist's");
      await add(bandId, g1, TITLES[4]);
      assert.deepEqual(await editorSongs(bandId, g1, TITLES), TITLES, "Take Me Out is added at the end");
      await app.click("Save", editor(bandId, g1));
      await app.until(`!${editor(bandId, g1)}`, "Save to close the editor", 15000);
      assert.deepEqual((await open(mike, g1)).songIds, [fire, neon, sayIt, middle, takeMe], "the server has it");
      await app.until(`(${card(bandId, g1)}?.querySelectorAll(".gig-card-songs li").length ?? 0) === 5`, "the card to list five songs", 15000);
      assert.deepEqual(await cardSongs(bandId, g1, TITLES), TITLES, "the card lists the new set in order");
      assert.deepEqual(await setlistSongs(), [fire, neon, sayIt], "and the Friday set is still untouched");
    });

    await check("remove and reorder update song_order and raise packRev; a lineup member holding the old pack shows Not yet and 'Set changed · 3 songs' on the card, and the band page fetches the new pack on its next load", async () => {
      await openGigs(bandId);
      await app.until(`(${card(bandId, g1)}?.textContent ?? "").length > 0`, "the Friday card", 15000);
      const now = await open(terry, g1);
      await app.until(`[...(${card(bandId, g1)}?.querySelectorAll(".gig-card-lineup li") ?? [])].some((li) => li.textContent.includes("Sam Rivera") && li.textContent.includes("Downloaded ✓"))`, "Sam's phone to hold the pack", 15000);
      const mikeBefore = await pack(mike, g1);
      assert.equal(mikeBefore.packRev, now.packRev, "Mike holds the pack as it is now");
      await site.evaluate(`sessionStorage.setItem("hold", "gig/pack")`);
      const changed = await songsApi(terry, g1, [takeMe, neon, fire]);
      assert.equal(changed.status, 200, `Terry removes two songs and moves Take Me Out first (${js(changed.body)})`);
      const view = changed.body as View;
      assert.deepEqual([view.songIds, view.songCount], [[takeMe, neon, fire], 3], "the view has the new order");
      assert.equal(view.packRev, now.packRev + 1, "and the pack rev one higher");
      const receipts = Object.fromEntries(view.receipts.map((receipt) => [receipt.userId, receipt.packRev]));
      assert.deepEqual([receipts[mike.userId], receipts[sam.userId]], [now.packRev, now.packRev], "Mike's and Sam's receipts are for the older pack");
      assert.deepEqual((await open(mike, g1)).songIds, [takeMe, neon, fire], "the gig opens in the new order");

      await reload();
      await openGigs(bandId);
      await app.until(`(${card(bandId, g1)}?.textContent ?? "").includes("Set changed · 3 songs")`, "Set changed · 3 songs on the card", 15000);
      assert.ok((await lineupRow(bandId, g1, "Sam Rivera")).includes("Not yet"), "Sam shows Not yet while the new pack waits");
      assert.ok((await lineupRow(bandId, g1, "Mike Keys")).includes("Not yet"), "so does Mike, who holds the old pack");
      await app.until(`window.__held.length > 0`, "the band page asking for the new pack on its own", 15000);
      await site.evaluate(`sessionStorage.removeItem("hold"); window.__release()`);
      await app.until(`!(${card(bandId, g1)}?.textContent ?? "").includes("Set changed")`, "Set changed to go once the new pack is here", 15000);
      await app.until(`[...(${card(bandId, g1)}?.querySelectorAll(".gig-card-lineup li") ?? [])].some((li) => li.textContent.includes("Sam Rivera") && li.textContent.includes("Downloaded ✓"))`, "Sam's Downloaded ✓", 15000);
      assert.deepEqual(await cardSongs(bandId, g1, TITLES), [takeMe, neon, fire].map(titleOf), "the card lists the new pack's songs");
      const after = await open(terry, g1);
      assert.equal(after.receipts.find((receipt) => receipt.userId === sam.userId)?.packRev, view.packRev, "the server has Sam's receipt for the new pack");
      assert.ok((await lineupRow(bandId, g1, "Mike Keys")).includes("Not yet"), "Mike still shows Not yet until his phone fetches it");
      const mikeAfter = await pack(mike, g1);
      assert.deepEqual([mikeAfter.packRev, mikeAfter.songs.map((song) => song.songId)], [view.packRev, [takeMe, neon, fire]], "Mike's next download has the new set");
      assert.equal(mikeAfter.secret, mikeBefore.secret, "with the same secret, since the lineup did not change");
      assert.deepEqual(await setlistSongs(), [fire, neon, sayIt], "the Friday set is untouched");
    });

    await check("the Edit songs picker offers band songs only and points at the Songs tab for own songs", async () => {
      await openGigs(bandId);
      await app.until(`!!${button(card(bandId, g1), "Edit songs")}`, "Edit songs", 15000);
      await app.click("Edit songs", card(bandId, g1));
      await app.until(`!!${editor(bandId, g1)}`, "the song editor");
      assert.ok((await site.evaluate<string>(`${editor(bandId, g1)}.textContent`)).includes(OWN_SONGS), "the editor points at the Songs tab for own songs");
      const libraryOrder = ((await mike.call("/api/bands/library", { bandId })).body.songs as { songId: string }[]).map((item) => item.songId);
      const outside = libraryOrder.filter((id) => [sayIt, middle].includes(id)).map(titleOf);
      assert.deepEqual(await offered(bandId, g1), outside, "Add a band song offers the band songs not in the set, in library order");
      assert.ok(!(await offered(bandId, g1)).includes(OWN_ONLY), `not ${OWN_ONLY}, a song on Sam's phone the band doesn't have`);

      await add(bandId, g1, TITLES[3]);
      assert.deepEqual(await offered(bandId, g1), [TITLES[2]], "an added song leaves the picker");
      assert.equal(libraryOrder.length, 5, "the band has exactly the five shared songs");
      await app.click("Move up", rowOf(bandId, g1, TITLES[3]));
      await app.click("Remove", rowOf(bandId, g1, TITLES[1]));
      const edited = [TITLES[4], TITLES[3], TITLES[0]];
      assert.deepEqual(await editorSongs(bandId, g1, TITLES), edited, "Move up and Remove change the list on screen");
      assert.ok(await site.evaluate<boolean>(`!!${button(rowOf(bandId, g1, TITLES[4]), "Move up")}?.disabled`), "the first song can't move up");
      assert.ok(await site.evaluate<boolean>(`!!${button(rowOf(bandId, g1, TITLES[0]), "Move down")}?.disabled`), "the last can't move down");

      const rev = (await open(terry, g1)).packRev;
      await site.evaluate(`sessionStorage.setItem("fail", "gig/songs")`);
      await app.click("Save", editor(bandId, g1));
      await app.until(`(${card(bandId, g1)}?.textContent ?? "").includes(${js(OFFLINE)})`, "the offline words", 15000);
      assert.deepEqual(await editorSongs(bandId, g1, TITLES), edited, "the edited list stays on screen for a retry");
      assert.equal((await open(terry, g1)).packRev, rev, "nothing was saved");
      await site.evaluate(`sessionStorage.removeItem("fail")`);
      await app.click("Save", editor(bandId, g1));
      await app.until(`!${editor(bandId, g1)}`, "the retried Save to close the editor", 15000);
      const saved = await open(terry, g1);
      assert.deepEqual(saved.songIds, [takeMe, middle, fire], "the retry saved the edited list");
      assert.equal(saved.packRev, rev + 1, "once");

      await app.click("Edit songs", card(bandId, g1));
      await app.until(`!!${editor(bandId, g1)}`, "the editor again");
      await app.click("Remove", rowOf(bandId, g1, TITLES[0]));
      await app.click("Cancel", editor(bandId, g1));
      await app.until(`!${editor(bandId, g1)}`, "Cancel to close the editor");
      assert.equal((await open(terry, g1)).packRev, rev + 1, "Cancel saves nothing");

      const one = await songsApi(terry, gOne, [fire]);
      assert.equal(one.status, 200, "a set cut to one song saves");
      await openGigs(bandId);
      await app.until(`!!${button(card(bandId, gOne), "Edit songs")} && !${button(card(bandId, gOne), "Edit songs")}.disabled`, "Edit songs on a one-song set", 15000);

      const problems: string[] = [];
      await app.click("Edit songs", card(bandId, g1));
      await app.until(`!!${editor(bandId, g1)}`, "the editor for the width sweep");
      for (const width of [344, 390, 820, 884, 1280]) {
        await site.send("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 844 : 800, deviceScaleFactor: 2, mobile: width < 600 });
        await settle(400);
        const found = await site.evaluate<string[]>(`(async () => {
          const form = ${editor(bandId, g1)};
          if (!form) return ["no editor"];
          const out = [];
          if (document.documentElement.scrollWidth > innerWidth + 1) out.push("the page scrolls sideways (" + document.documentElement.scrollWidth + " > " + innerWidth + ")");
          const targets = [...form.querySelectorAll("button, select")].filter((el) => !el.disabled);
          if (targets.length < 5) out.push("only " + targets.length + " controls");
          for (const el of targets) {
            el.scrollIntoView({ block: "center" });
            await new Promise((done) => setTimeout(done, 100));
            const box = el.getBoundingClientRect();
            const what = el.getAttribute("aria-label") ?? el.textContent.trim();
            if (box.right > innerWidth + 1 || box.left < -1) out.push(what + " runs off the side");
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) out.push(what + " covered by " + (hit ? hit.tagName + "." + hit.className : "nothing"));
          }
          return out;
        })()`);
        problems.push(...found.map((problem) => `${width}: ${problem}`));
        await app.shot(shots && `${shots}/gig-songs-editor-${width}.png`);
      }
      await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await app.click("Cancel", editor(bandId, g1));
      assert.deepEqual(problems, [], "every control of the editor fits uncovered at each width");
    });

    // A band room saved before this cook: the Worker stops, the room's gigs table goes back to its shape before the P2
    // columns, Saturday at the Barn is put on stage (no route does that yet, C21 will), and the Worker starts again.
    const oldOrder = (await open(terry, gOld)).songIds;
    await api.worker.dispose();
    let rebuilt = 0;
    for (const file of (readdirSync(state, { recursive: true }) as string[]).filter((name) => name.endsWith(".sqlite")).map((name) => join(state, name))) {
      const db = new DatabaseSync(file);
      try {
        if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gigs'`).get()) continue;
        db.exec(`BEGIN; ${GIGS_BEFORE}; INSERT INTO gigs_before (${COLUMNS_BEFORE}) SELECT ${COLUMNS_BEFORE} FROM gigs; DROP TABLE gigs; ALTER TABLE gigs_before RENAME TO gigs; COMMIT;`);
        rebuilt += Number(db.prepare(`UPDATE gigs SET status = 'live', started_at = ? WHERE gig_id = ?`).run(Date.now(), gLive).changes);
      } finally {
        db.close();
      }
    }
    assert.equal(rebuilt, 1, "the band room's gigs table is back in its old shape, with Saturday on stage");
    api = await startApi(env, state);
    apiBase = api.base;
    for (const player of players) Object.assign(player, { base: api.base });

    await check("a member gets 403 not-allowed; a live gig gets 409 set-locked; an ended gig gets 409 gig-ended; the button is greyed with the lock words", async () => {
      const before = await open(terry, g1);
      assert.deepEqual(refusal(await songsApi(mike, g1, [fire])), [403, "not-allowed"], "Mike, a member, may not change the set");
      assert.deepEqual(refusal(await songsApi(terry, gLive, [fire])), [409, "set-locked"], "a live gig's set is locked");
      assert.deepEqual(refusal(await songsApi(mike, gLive, [fire])), [403, "not-allowed"], "and a member hears only that they may not");
      assert.deepEqual(refusal(await songsApi(terry, gEnded, [fire])), [409, "gig-ended"], "an ended gig is over");
      assert.deepEqual(refusal(await songsApi(terry, gigId(), [fire])), [404, "not-found"], "a gig the band never had is not found");
      const bad: [string, unknown][] = [
        ["an empty set", []],
        ["a song twice", [fire, fire]],
        ["201 songs", Array.from({ length: 201 }, (_, i) => `song_${i}`)],
        ["an id that isn't text", [fire, 7]],
        ["no list at all", "fire"],
      ];
      for (const [what, songIds] of bad) assert.deepEqual(refusal(await songsApi(terry, g1, songIds)), [400, "bad-request"], `${what} is a bad request`);
      assert.deepEqual(refusal(await songsApi(terry, g1, [fire, "song_not_in_this_band"])), [400, "not-a-band-song"], "a song outside the band is refused, not dropped");
      const after = await open(terry, g1);
      assert.deepEqual([after.songIds, after.packRev], [before.songIds, before.packRev], "no refused request changed the set or its rev");
      assert.equal((await open(mike, gLive)).gig.status, "live", "Saturday is on stage");

      await reload();
      await openGigs(bandId);
      await app.until(`!!${button(card(bandId, gLive), "Edit songs")}`, "Edit songs on the live card", 15000);
      assert.ok(await site.evaluate<boolean>(`${button(card(bandId, gLive), "Edit songs")}.disabled`), "Edit songs is greyed on the live gig");
      assert.ok((await cardText(bandId, gLive)).includes(LOCKED), `the card says ${LOCKED}`);
      assert.ok(await site.evaluate<boolean>(`!${button(card(bandId, g1), "Edit songs")}.disabled`), "a planned gig's Edit songs still works");
      assert.ok(!(await cardText(bandId, g1)).includes(LOCKED), "with no lock words");
    });

    await check("a gig planned before this cook still works", async () => {
      const listed = await mike.call("/api/bands/gig/list", { bandId });
      assert.equal(listed.status, 200, `the band's gigs list (${js(listed.body)})`);
      const old = (listed.body.gigs as View[]).find((view) => view.gig.gigId === gOld);
      assert.ok(old, "Sunday brunch is listed");
      assert.deepEqual([old.songIds, old.songCount], [oldOrder, oldOrder.length], "with its songs");
      const edited = await songsApi(terry, gOld, [middle, fire, neon]);
      assert.equal(edited.status, 200, `Terry edits its songs (${js(edited.body)})`);
      assert.deepEqual((await open(mike, gOld)).songIds, [middle, fire, neon], "it opens in the new order");
      const held = await pack(mike, gOld);
      assert.deepEqual(held.songs.map((song) => song.songId), [middle, fire, neon], "Mike's pack has the new set");
      const ended = await terry.call("/api/bands/gig/end", { bandId, gigId: gOld });
      assert.deepEqual([ended.status, ended.body.gig?.status], [200, "ended"], "Terry ends it");
      const past = ((await mike.call("/api/bands/gig/list", { bandId })).body.past as View[]).find((view) => view.gig.gigId === gOld);
      assert.deepEqual([past?.songIds, past?.songCount], [[middle, fire, neon], 3], "and it is in Past with its 3 songs");
      assert.deepEqual(refusal(await songsApi(terry, gOld, [fire])), [409, "gig-ended"], "where its set no longer changes");
    });

    await check("no page errors", async () => assert.deepEqual(await app.errors(), [], "the page logged no errors"));
  } finally {
    await site.close();
    await api.worker.dispose();
    rmSync(state, { recursive: true, force: true, maxRetries: 10 });
  }
}

await pureCases();
if (!PURE_ONLY) await boxCases();
if (failed > 0) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log(PURE_ONLY ? "check:gig-songs pure cases passed" : "check:gig-songs passed");
