import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BandLibrary, SongContent } from "../src/band-library-model.ts";
import type { ChatMessage } from "../src/chat-model.ts";
import type { BandFile } from "../worker/room-export.ts";

/**
 * P5, notes on a band song. One case per pass condition, named by it. `--pure` runs only the cases that need no
 * Worker or Chrome. `--api` adds the Worker cases with no Chrome. With neither, every case runs.
 *
 * The contract the cases fix:
 * - `src/song-notes-model.ts` holds `NOTE_MAX_CHARS` (500) and `visibleNotes(notes, expanded)`: notes come newest
 *   first, and the strip shows `{ shown, more }`, the newest note and how many more while collapsed, every note and 0
 *   when expanded.
 * - `POST /api/bands/notes/list { bandId, songId }` answers `{ notes, canWrite }`. A note is
 *   `{ noteId, songId, authorName, body, createdAt }`, newest first. `canWrite` is true only for a band admin.
 * - `POST /api/bands/notes/add { bandId, songId, body, noteId? }` answers the note. Only an admin writes (403
 *   not-admin); someone not in the band, or removed from it, hears 403 not-a-member; a song id that isn't a band song
 *   is 404 not-found; a blank body or one past 500 characters is 400 bad-request. The body is kept trimmed. The same
 *   `noteId` again stores nothing new and answers the same note. Each stored note puts one line in the band chat,
 *   kind "band-song", `ref` the song id, text "<author> added a note to <title>".
 * - `POST /api/bands/notes/delete { bandId, noteId }` answers `{ ok: true }`, again too; an unknown note is 404
 *   not-found. A deleted note never comes back in the list or the band file.
 * - The band file carries `notes: [{ id, songId, authorName, body, createdAt }]`, `songId` the file's song id. A band
 *   with no notes exports no `notes` key, so its file reads the same as one made before notes. Importing maps each
 *   note to the imported song id and keeps author name, body and created at; importing again adds none twice; a file
 *   with no `notes` still imports; a note on a song the file doesn't hold is 400 bad-file.
 * - The band song screen and the gig-mode sheet show `.song-notes` (heading "Band notes") above `.sheet`, with one
 *   `.song-note` per shown note holding its body, author name and `<time datetime=ISO>`. Collapsed, a `N more` button
 *   expands it and `Show less` folds it again. An admin, and only an admin, sees `Add a note`, which opens a textarea
 *   labelled "Note for the band" (maxlength 500) with `Save note` and `Cancel`, and a `Delete` on each note, which asks
 *   `Yes, delete`. The gig-mode sheet has no Add a note. With no notes a member sees no strip. With no signal, or for a
 *   song the band no longer has, the strip is absent and shows no error.
 */

const mode = process.argv.includes("--pure") ? "pure" : process.argv.includes("--api") ? "api" : "all";
const root = fileURLToPath(new URL("..", import.meta.url));
const js = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const newId = () => crypto.randomUUID().replace(/-/g, "");
const WIDTHS = [344, 390, 820, 884, 1280];

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

function finish(label: string): never {
  if (failed > 0) {
    console.log(`${label}: ${failed} failed`);
    process.exit(1);
  }
  console.log(`${label} passed`);
  process.exit(0);
}

type Note = { noteId: string; songId: string; authorName: string; body: string; createdAt: number };

await check("pure: the strip collapses to the latest note with 'N more', and expanded shows every note newest first", async () => {
  const model = (await import("../src/song-notes-model.ts")) as Record<string, any>;
  const note = (n: number): Note => ({ noteId: `note_${n}`, songId: "song_1", authorName: "Terry Bass", body: `Note ${n}`, createdAt: n });
  const notes = [note(4), note(3), note(2), note(1)];
  assert.equal(model.NOTE_MAX_CHARS, 500, "a note holds up to 500 characters");
  assert.deepEqual(model.visibleNotes(notes, false), { shown: [note(4)], more: 3 }, "collapsed: the newest note and 3 more");
  assert.deepEqual(model.visibleNotes(notes, true), { shown: notes, more: 0 }, "expanded: every note, newest first");
  assert.deepEqual(model.visibleNotes([note(1)], false), { shown: [note(1)], more: 0 }, "one note has no more");
  assert.deepEqual(model.visibleNotes([], false), { shown: [], more: 0 }, "no notes shows nothing");
});

if (mode === "pure") finish("check:song-notes --pure");

const { startApi } = await import("./api-session.ts");
const { appPage, PASSWORD_PEPPER, passwordPlayer, settle } = await import("./app-page.ts");
const { downloadBandFile, importBandFile } = await import("./band-move.ts");

type Player = Awaited<ReturnType<typeof passwordPlayer>>;
type Reply = { status: number; body: Record<string, any> };
type NoteList = { notes: Note[]; canWrite: boolean };

const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: (SongContent & { id: number })[] };
const chart = (title: string, artist: string, lyric: string): SongContent => {
  const { id: _id, ...song } = seed.songs[0];
  return { ...song, title, artist, body: [{ heading: "Verse 1", lines: [{ chords: "G       C", lyrics: lyric }] }] };
};

const refusal = (reply: Reply) => [reply.status, reply.body.error];
const notesOf = (who: Player, bandId: string, songId: string) => who.call("/api/bands/notes/list", { bandId, songId });
const addNote = (who: Player, bandId: string, songId: string, body: unknown, noteId?: string) => who.call("/api/bands/notes/add", { bandId, songId, body, ...(noteId ? { noteId } : {}) });
const deleteNote = (who: Player, bandId: string, noteId: string) => who.call("/api/bands/notes/delete", { bandId, noteId });
const listed = async (who: Player, bandId: string, songId: string) => {
  const reply = await notesOf(who, bandId, songId);
  assert.equal(reply.status, 200, `${who.name} lists the notes (${js(reply.body)})`);
  return reply.body as NoteList;
};
const added = async (who: Player, bandId: string, songId: string, body: string, noteId?: string) => {
  const reply = await addNote(who, bandId, songId, body, noteId);
  assert.equal(reply.status, 200, `${who.name} adds a note (${js(reply.body)})`);
  return reply.body as Note;
};
const library = async (who: Player, bandId: string) => {
  const reply = await who.call("/api/bands/library", { bandId });
  assert.equal(reply.status, 200, `${who.name} reads the band library (${js(reply.body)})`);
  return reply.body as BandLibrary;
};
const noteLines = async (who: Player, bandId: string, songId: string) => {
  const reply = await who.call("/api/chat/open", { roomId: bandId });
  assert.equal(reply.status, 200, `${who.name} opens the band chat (${js(reply.body)})`);
  return (reply.body.messages as ChatMessage[]).filter((m) => m.kind === ("band-song" as ChatMessage["kind"]) && m.ref === songId).map((m) => m.text);
};

let apiBase = "";
const site = mode === "all" ? await (await import("./chrome.ts")).openSite(root, "check-song-notes", () => apiBase) : null;
const origin = site ? site.origin.replace("127.0.0.1", "localhost") : "https://old.test";
const main = await startApi({ APP_ORIGIN: origin, RP_ID: site ? "localhost" : "old.test", PASSWORD_PEPPER });
apiBase = main.base;
const fresh = await startApi({ APP_ORIGIN: "https://new.test", RP_ID: "new.test", PASSWORD_PEPPER });
const admin = (who: Player, base: string, at: string) => ({ base, origin: at, cookie: who.cookie });

try {
  const terry = await passwordPlayer(main.base, origin, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(main.base, origin, "Mike Keys", "mikekeys");
  const lee = await passwordPlayer(main.base, origin, "Lee Sax", "leesax");
  const ann = await passwordPlayer(main.base, origin, "Ann Horn", "annhorn");
  const bandId = (await terry.call("/api/bands/create", { name: "The Low Tides" })).body.bandId as string;
  const code = (await terry.call("/api/codes", { kind: "band", bandId })).body.code as string;
  for (const who of [mike, lee]) assert.equal((await who.call("/api/bands/join", { code })).status, 200, `${who.name} joins The Low Tides`);
  assert.equal((await terry.call("/api/bands/remove", { bandId, userId: lee.userId })).status, 200, "Terry removes Lee");
  const share = async (who: Player, band: string, song: SongContent) => {
    const reply = await who.call("/api/bands/library/share-song", { bandId: band, song, choice: "public" });
    assert.equal(reply.status, 200, `${who.name} shares ${song.title} (${js(reply.body)})`);
    return reply.body.songId as string;
  };
  const fireAway = await share(terry, bandId, chart("Fire Away", "Chris Stapleton", "Fire away, fire away"));
  const chainBreaker = await share(terry, bandId, chart("Chain Breaker", "Terry Bass", "Break every chain tonight"));
  const goneSong = "song_" + "z".repeat(22);
  const notes: Record<string, Note> = {};

  await check("a note added by an admin is listed for a member on the same band song, newest first, with author name and date", async () => {
    const before = Date.now();
    notes.first = await added(terry, bandId, fireAway, "  Watch the push into the chorus  ");
    notes.second = await added(terry, bandId, fireAway, "Bass: walk up on the last bar of verse 2");
    const after = Date.now();
    assert.deepEqual(
      [notes.first.songId, notes.first.authorName, notes.first.body],
      [fireAway, "Terry Bass", "Watch the push into the chorus"],
      "the note names its song and author, and keeps the words trimmed",
    );
    assert.ok(typeof notes.first.noteId === "string" && notes.first.noteId !== notes.second.noteId, "each note has its own id");
    assert.ok(notes.first.createdAt >= before && notes.second.createdAt <= after && notes.first.createdAt <= notes.second.createdAt, "with the time it was added");
    const seen = await listed(mike, bandId, fireAway);
    assert.deepEqual(seen.notes, [notes.second, notes.first], "Mike, a member, sees both, newest first, as they were added");
    assert.equal(seen.canWrite, false, "and may not write");
    assert.equal((await listed(terry, bandId, fireAway)).canWrite, true, "Terry, the admin, may");
    assert.deepEqual((await listed(mike, bandId, chainBreaker)).notes, [], "a note belongs to its own song only");
  });

  await check("each note puts 'Terry Bass added a note to Fire Away' in the band chat as a band-song line; the same noteId again stores one note and one line", async () => {
    assert.deepEqual(await noteLines(mike, bandId, fireAway), ["Terry Bass added a note to Fire Away", "Terry Bass added a note to Fire Away"], "one line per note, pointing at the song");
    const noteId = newId();
    const once = await added(terry, bandId, chainBreaker, "Count in from the drums", noteId);
    const twice = await added(terry, bandId, chainBreaker, "Count in from the drums", noteId);
    assert.deepEqual(twice, once, "a resend after a lost reply answers the note already stored");
    assert.deepEqual((await listed(mike, bandId, chainBreaker)).notes, [once], "and stores it once");
    assert.deepEqual(await noteLines(mike, bandId, chainBreaker), ["Terry Bass added a note to Chain Breaker"], "with one chat line");
    notes.chain = once;
  });

  await check("a non-member and a removed member get 403 not-a-member on list and add", async () => {
    for (const who of [ann, lee]) {
      assert.deepEqual(refusal(await notesOf(who, bandId, fireAway)), [403, "not-a-member"], `${who.name} can't list`);
      assert.deepEqual(refusal(await addNote(who, bandId, fireAway, "Let me in")), [403, "not-a-member"], `${who.name} can't add`);
      assert.deepEqual(refusal(await deleteNote(who, bandId, notes.first.noteId)), [403, "not-a-member"], `${who.name} can't delete`);
    }
    assert.deepEqual((await listed(terry, bandId, fireAway)).notes, [notes.second, notes.first], "nothing changed");
  });

  await check("only an admin can add or delete a note; a member's add or delete is refused with 403 not-admin server-side, and the member's list reply says canWrite false", async () => {
    assert.deepEqual(refusal(await addNote(mike, bandId, fireAway, "Mike wants a solo")), [403, "not-admin"], "Mike's add is refused");
    assert.deepEqual(refusal(await deleteNote(mike, bandId, notes.first.noteId)), [403, "not-admin"], "Mike's delete is refused");
    assert.deepEqual((await listed(mike, bandId, fireAway)).notes, [notes.second, notes.first], "and changed nothing");
    assert.equal((await listed(mike, bandId, fireAway)).canWrite, false, "Mike's list says canWrite false");
    for (const body of ["", "   ", "x".repeat(501), 42, null]) {
      assert.deepEqual(refusal(await addNote(terry, bandId, fireAway, body)), [400, "bad-request"], `a body of ${js(body).slice(0, 20)} is refused`);
    }
    assert.deepEqual(refusal(await addNote(terry, bandId, "x".repeat(65), "Odd id")), [400, "bad-request"], "a song id that isn't one is refused");
    const longest = await added(terry, bandId, fireAway, "y".repeat(500));
    assert.equal(longest.body.length, 500, "500 characters fit");
    assert.deepEqual((await deleteNote(terry, bandId, longest.noteId)).body, { ok: true }, "the admin deletes it");
    assert.equal((await terry.call("/api/bands/make-admin", { bandId, userId: mike.userId })).status, 200, "Terry makes Mike an admin");
    assert.equal((await listed(mike, bandId, fireAway)).canWrite, true, "the server now says Mike may write");
    notes.mike = await added(mike, bandId, fireAway, "Mike: keys lay out in the bridge");
    assert.equal(notes.mike.authorName, "Mike Keys", "and his note carries his name");
  });

  await check("a note on a song id that is not a band song is refused 404 not-found; a deleted note never returns in the list or the export", async () => {
    assert.deepEqual(refusal(await addNote(terry, bandId, goneSong, "For a song we never had")), [404, "not-found"], "adding to a song the band doesn't hold");
    assert.deepEqual(refusal(await notesOf(terry, bandId, goneSong)), [404, "not-found"], "listing one");
    assert.deepEqual(refusal(await deleteNote(terry, bandId, "note_" + "q".repeat(22))), [404, "not-found"], "deleting a note that doesn't exist");
    assert.deepEqual([(await deleteNote(terry, bandId, notes.first.noteId)).body], [{ ok: true }], "Terry deletes the first note");
    assert.deepEqual([(await deleteNote(terry, bandId, notes.first.noteId)).body], [{ ok: true }], "deleting it again answers the same");
    assert.deepEqual((await listed(mike, bandId, fireAway)).notes.map((note) => note.noteId), [notes.mike.noteId, notes.second.noteId], "the deleted note is gone from the list");
    const file = (await downloadBandFile(admin(terry, main.base, origin), bandId)).body as BandFile & { notes?: { body: string }[] };
    const text = js(file);
    assert.ok(!text.includes(notes.first.noteId) && !text.includes("Watch the push into the chorus") && !text.includes("y".repeat(500)), "and from the band file");
  });

  await check("the band export carries notes (song id, author name, body, created at); importing it restores them under the imported song ids; a file exported before this cook, with no notes array, still imports", async () => {
    const exported = await downloadBandFile(admin(terry, main.base, origin), bandId);
    assert.equal(exported.status, 200, `Terry downloads the band file (${js(exported.body).slice(0, 200)})`);
    const file = exported.body as BandFile & { notes: { id: string; songId: string; authorName: string; body: string; createdAt: number }[] };
    assert.ok(Array.isArray(file.notes), "the file has a notes list");
    assert.ok(file.notes.every((note) => js(Object.keys(note).sort()) === js(["authorName", "body", "createdAt", "id", "songId"])), `each note is id, song id, author name, body and created at (${js(file.notes[0])})`);
    const live = [notes.mike, notes.second, notes.chain];
    assert.deepEqual(
      [...file.notes].sort((a, b) => a.body.localeCompare(b.body)).map((note) => [note.songId, note.authorName, note.body, note.createdAt]),
      [...live].sort((a, b) => a.body.localeCompare(b.body)).map((note) => [note.songId, note.authorName, note.body, note.createdAt]),
      "every live note, with the file's song id",
    );
    const fileSongIds = new Set(file.songs.map((song) => song.id));
    assert.ok(file.notes.every((note) => fileSongIds.has(note.songId)), "each note names a song in the file");

    const ann2 = await passwordPlayer(fresh.base, "https://new.test", "Ann Horn", "annhorn");
    const dana = await passwordPlayer(fresh.base, "https://new.test", "Dana Drums", "danadrums");
    const newBand = (await ann2.call("/api/bands/create", { name: "The Low Tides" })).body.bandId as string;
    const newCode = (await ann2.call("/api/codes", { kind: "band", bandId: newBand })).body.code as string;
    assert.equal((await dana.call("/api/bands/join", { code: newCode })).status, 200, "Dana joins the new band");
    const imported = await importBandFile(admin(ann2, fresh.base, "https://new.test"), newBand, js(file));
    assert.equal(imported.status, 200, `Ann imports the file (${js(imported.body)})`);
    assert.deepEqual(imported.body.songs, { added: file.songs.length, skipped: 0 }, "every song arrives");
    const arrived = await library(dana, newBand);
    const idOf = (title: string) => arrived.songs.find((item) => item.song.title === title)!.songId;
    assert.ok(idOf("Fire Away") !== fireAway, "under a new id");
    const fireNotes = await listed(dana, newBand, idOf("Fire Away"));
    assert.deepEqual(
      fireNotes.notes.map((note) => [note.songId, note.authorName, note.body, note.createdAt]),
      [notes.mike, notes.second].map((note) => [idOf("Fire Away"), note.authorName, note.body, note.createdAt]),
      "Dana sees Fire Away's notes under the imported song id, newest first, with author name and date kept",
    );
    assert.deepEqual((await listed(dana, newBand, idOf("Chain Breaker"))).notes.map((note) => note.body), ["Count in from the drums"], "and Chain Breaker's");
    assert.equal(fireNotes.canWrite, false, "Dana, a member there, may not write");

    const again = await importBandFile(admin(ann2, fresh.base, "https://new.test"), newBand, js(file));
    assert.equal(again.status, 200, "importing the same file again");
    assert.equal((await listed(dana, newBand, idOf("Fire Away"))).notes.length, 2, "adds no note twice");

    const { notes: _notes, ...older } = file;
    const oldBand = (await ann2.call("/api/bands/create", { name: "Old File Band" })).body.bandId as string;
    const oldImport = await importBandFile(admin(ann2, fresh.base, "https://new.test"), oldBand, js(older));
    assert.equal(oldImport.status, 200, `a file with no notes array imports (${js(oldImport.body)})`);
    assert.deepEqual(oldImport.body.songs, { added: file.songs.length, skipped: 0 }, "with all its songs");
    const oldSongs = await library(ann2, oldBand);
    for (const song of oldSongs.songs) assert.deepEqual((await listed(ann2, oldBand, song.songId)).notes, [], `and no notes on ${song.song.title}`);

    const badBand = (await ann2.call("/api/bands/create", { name: "Bad Files" })).body.bandId as string;
    const broken: [string, unknown][] = [
      ["notes that aren't a list", "nope"],
      ["a note on a song the file doesn't hold", [{ ...file.notes[0], songId: "song_elsewhere" }]],
      ["a note past 500 characters", [{ ...file.notes[0], body: "z".repeat(501) }]],
      ["a note with no created at", [{ ...file.notes[0], createdAt: "yesterday" }]],
    ];
    for (const [what, value] of broken) {
      assert.deepEqual(refusal(await importBandFile(admin(ann2, fresh.base, "https://new.test"), badBand, js({ ...file, notes: value }))), [400, "bad-file"], `${what} is a bad file`);
    }
    assert.deepEqual((await library(ann2, badBand)).songs, [], "and none of them changed the band");

    const quiet = (await terry.call("/api/bands/create", { name: "Quiet Band" })).body.bandId as string;
    await share(terry, quiet, chart("Hush", "Terry Bass", "Not a word tonight"));
    const quietFile = (await downloadBandFile(admin(terry, main.base, origin), quiet)).body as Record<string, unknown>;
    assert.ok(!("notes" in quietFile), `a band with no notes exports the same keys as a file made before notes (${js(Object.keys(quietFile))})`);
  });

  if (site) {

    const app = await appPage(site);
    await site.send("Network.enable");
    const offline = (on: boolean) => site.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const appCalls = (path: string, body: object) =>
      site.evaluate<Reply>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
    const strip = `document.querySelector(".song-notes")`;
    const shownNotes = () => site.evaluate<string[]>(`[...(${strip}?.querySelectorAll(".song-note") ?? [])].map((li) => li.textContent)`);
    const buttonsIn = (scope: string) => site.evaluate<string[]>(`[...(${scope}?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim())`);
    const openBandSong = async (band: string, songId: string, lyric: string) => {
      await site.evaluate(`location.hash = ${js(`#/band/${band}?s=songs`)}`);
      await app.until(`!!document.querySelector(".band-page") && !document.querySelector(".band-page").textContent.includes("Loading")`, "the band page", 15000);
      await settle(500);
      await site.evaluate(`location.hash = ${js(`#/band/${band}/song/${songId}`)}`);
      await app.until(`!!document.querySelector(".sheet") && document.querySelector(".sheet").textContent.includes(${js(lyric)})`, `the band song with ${lyric}`, 15000);
    };
    const setText = async (selector: string, text: string) => {
      await site.evaluate(`(() => {
        const box = document.querySelector(${js(selector)});
        box.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, ${js(text)});
        box.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await settle(150);
    };
    const layout = () =>
      site.evaluate<{ page: number; width: number; strip: DOMRect | null; sheet: DOMRect | null; before: boolean; out: string[]; small: string[] }>(`(() => {
        const strip = document.querySelector(".song-notes"), sheet = document.querySelector(".sheet");
        const out = [], small = [];
        for (const el of strip ? [strip, ...strip.querySelectorAll("*")] : []) {
          const box = el.getBoundingClientRect();
          if (box.width > 0 && (box.left < -1 || box.right > innerWidth + 1)) out.push(el.className + " " + Math.round(box.left) + ".." + Math.round(box.right));
          if (el.matches("button") && box.height < 44) small.push(el.textContent.trim() + " " + Math.round(box.height));
        }
        return {
          page: document.documentElement.scrollWidth,
          width: innerWidth,
          strip: strip && strip.getBoundingClientRect().toJSON(),
          sheet: sheet && sheet.getBoundingClientRect().toJSON(),
          before: !!strip && !!sheet && !!(strip.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING),
          out,
          small,
        };
      })()`);
    const fitsAt = async (width: number, what: string) => {
      const seen = await layout();
      assert.ok(seen.strip && seen.sheet, `the strip and the chart are both on screen ${what} at ${width} (${js(seen)})`);
      assert.ok(seen.before && seen.strip!.bottom <= seen.sheet!.top + 0.5, `the strip sits above the chart and never covers it ${what} at ${width} (strip ${Math.round(seen.strip!.top)}..${Math.round(seen.strip!.bottom)}, chart from ${Math.round(seen.sheet!.top)})`);
      assert.ok(seen.page <= width, `nothing scrolls sideways ${what} at ${width} (${seen.page})`);
      assert.deepEqual(seen.out, [], `the strip sits inside the screen ${what} at ${width}`);
      assert.deepEqual(seen.small, [], `every strip button is big enough to tap ${what} at ${width}`);
    };

    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await app.library();
    await app.signUp("Sam Rivera");
    assert.equal((await appCalls("/api/bands/join", { code })).status, 200, "Sam joins The Low Tides as a member");
    notes.third = await added(terry, bandId, fireAway, "Ending: hold the last chord four bars");
    notes.fourth = await added(terry, bandId, fireAway, "Intro: bass alone for two bars");
    const fireList = (await listed(terry, bandId, fireAway)).notes;
    assert.equal(fireList.length, 4, "Fire Away has four notes");

    await check("the notes strip collapses to the latest note with 'N more' and never overlaps the chart at 344, 390, 820, 884 and 1280 px", async () => {
      await openBandSong(bandId, fireAway, "Fire away, fire away");
      await app.until(`${strip}?.querySelectorAll(".song-note").length === 1`, "the collapsed strip");
      assert.ok((await app.text(".song-notes")).includes("Band notes"), "headed Band notes");
      const [latest] = await shownNotes();
      assert.ok(latest.includes(fireList[0].body) && latest.includes("Terry Bass"), `the latest note with its author (${latest})`);
      assert.equal(await site.evaluate<string>(`${strip}.querySelector(".song-note time").getAttribute("datetime")`), new Date(fireList[0].createdAt).toISOString(), "and its date");
      const buttons = await buttonsIn(strip);
      assert.ok(buttons.includes("3 more"), `a 3 more button (${js(buttons)})`);
      assert.ok(!buttons.includes("Add a note") && !buttons.includes("Delete"), "and no Add a note or Delete for a member");
      for (const width of WIDTHS) {
        await site.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile: width < 800 });
        await settle(300);
        await fitsAt(width, "collapsed");
        await app.click("3 more", strip);
        await app.until(`${strip}.querySelectorAll(".song-note").length === 4`, `the expanded strip at ${width}`);
        await fitsAt(width, "expanded");
        await app.click("Show less", strip);
        await app.until(`${strip}.querySelectorAll(".song-note").length === 1`, `the strip folding again at ${width}`);
      }
      await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await app.click("3 more", strip);
      const order = await shownNotes();
      assert.deepEqual(order.map((text) => fireList.findIndex((note) => text.includes(note.body))), [0, 1, 2, 3], "expanded, every note shows newest first");
    });

    await check("a member sees no strip on a band song with no notes", async () => {
      const quiet = await share(terry, bandId, chart("Quiet One", "Terry Bass", "Soft and low tonight"));
      await openBandSong(bandId, quiet, "Soft and low tonight");
      await settle(1500);
      assert.equal(await site.evaluate<boolean>(`!!${strip}`), false, "no strip at all");
    });

    await check("with no signal the strip is absent, shows no error and does not retry in a loop", async () => {
      await openBandSong(bandId, chainBreaker, "Break every chain tonight");
      await app.until(`!!${strip}`, "the strip with signal");
      await site.evaluate(`location.hash = ${js(`#/band/${bandId}?s=songs`)}`);
      await app.until(`!!document.querySelector(".band-page")`, "the band page");
      await site.evaluate(`(() => {
        window.__noteLists = 0;
        const plain = window.fetch;
        window.fetch = (input, init) => {
          if (String(input instanceof Request ? input.url : input).includes("/api/bands/notes/list")) window.__noteLists += 1;
          return plain(input, init);
        };
      })()`);
      await offline(true);
      try {
        await site.evaluate(`location.hash = ${js(`#/band/${bandId}/song/${chainBreaker}`)}`);
        await app.until(`!!document.querySelector(".sheet") && document.querySelector(".sheet").textContent.includes("Break every chain tonight")`, "the band song with no signal", 15000);
        await settle(3000);
        assert.equal(await site.evaluate<boolean>(`!!${strip}`), false, "the strip is absent");
        assert.equal(await site.evaluate<boolean>(`!!document.querySelector("#sheet-scroll [role=alert]")`), false, "and no error shows");
        const tries = await site.evaluate<number>("window.__noteLists");
        assert.ok(tries <= 1, `it asked at most once (${tries})`);
      } finally {
        await offline(false);
      }
    });

    await check("the strip is absent for a song the library no longer has", async () => {
      await site.evaluate(`location.hash = ${js(`#/band/${bandId}/song/${goneSong}`)}`);
      await app.until(`document.body.textContent.includes("That song isn't on this phone.")`, "the missing song words", 15000);
      await settle(1500);
      assert.equal(await site.evaluate<boolean>(`!!${strip}`), false, "no strip");
      assert.equal(await site.evaluate<boolean>(`!!document.querySelector("#sheet-scroll [role=alert]")`), false, "and no error");
    });

    await check("notes show collapsed on the band song in gig view, with no Add a note, and never cover the chart", async () => {
      const setlist = await terry.call("/api/bands/library/share-setlist", { bandId, name: "Friday", songIds: [fireAway, chainBreaker], tags: [], choice: "public" });
      assert.equal(setlist.status, 200, `Terry shares a setlist (${js(setlist.body)})`);
      const gig = await terry.call("/api/bands/gig/plan", { bandId, setlistId: setlist.body.setlistId, name: "Friday at Lou's", date: "2026-12-04" });
      assert.equal(gig.status, 200, `Terry plans a gig (${js(gig.body)})`);
      const gigId = gig.body.gig.gigId as string;
      await site.evaluate(`location.hash = ${js(`#/band/${bandId}?s=gigs`)}`);
      await app.until(
        `[...(document.querySelector(${js(`.band-page [data-gig="${gigId}"]`)})?.querySelectorAll(".gig-card-lineup li") ?? [])].some((li) => li.textContent.includes("Sam Rivera") && li.textContent.includes("Downloaded ✓"))`,
        "Sam's phone to hold the gig pack",
        20000,
      );
      await site.evaluate(`location.hash = ${js(`#/gig/${bandId}/${gigId}/0`)}`);
      await app.until(`!!document.querySelector(".sheet") && document.querySelector(".sheet").textContent.includes("Fire away, fire away")`, "Fire Away in gig mode", 15000);
      await app.until(`${strip}?.querySelectorAll(".song-note").length === 1`, "the collapsed strip in gig mode");
      assert.ok((await buttonsIn(strip)).includes("3 more"), "with 3 more");
      for (const width of WIDTHS) {
        await site.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile: width < 800 });
        await settle(300);
        await fitsAt(width, "in gig mode");
      }
      await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    });

    await check("an admin adds a note from the strip, sees it at once, a member's chat gets the line, and offline Save keeps the words and stores once on retry", async () => {
      const trio = (await appCalls("/api/bands/create", { name: "Sam's Trio" })).body.bandId as string;
      const shared = await appCalls("/api/bands/library/share-song", { bandId: trio, song: chart("Harbor Lights", "Sam Rivera", "Harbor lights are calling"), choice: "public" });
      assert.equal(shared.status, 200, `Sam shares a song into Sam's Trio (${js(shared.body)})`);
      const harbor = shared.body.songId as string;
      const trioCode = (await appCalls("/api/codes", { kind: "band", bandId: trio })).body.code as string;
      assert.equal((await mike.call("/api/bands/join", { code: trioCode })).status, 200, "Mike joins Sam's Trio");
      await openBandSong(trio, harbor, "Harbor lights are calling");
      await app.until(`!!${strip}`, "the admin's strip with no notes");
      assert.deepEqual(await shownNotes(), [], "no notes yet");
      assert.deepEqual(await buttonsIn(strip), ["Add a note"], "only Add a note");
      await app.click("Add a note", strip);
      const box = ".song-notes textarea[aria-label='Note for the band']";
      await app.until(`!!document.querySelector(${js(box)})`, "the note box");
      assert.equal(await site.evaluate<number>(`document.querySelector(${js(box)}).maxLength`), 500, "which holds 500 characters");
      await setText(box, "Capo 2 for the whole song");
      await app.click("Save note", strip);
      await app.until(`${strip}.querySelectorAll(".song-note").length === 1`, "the new note in the strip");
      assert.ok((await shownNotes())[0].includes("Capo 2 for the whole song") && (await shownNotes())[0].includes("Sam Rivera"), "with Sam's words and name");
      assert.deepEqual((await listed(mike, trio, harbor)).notes.map((note) => [note.body, note.authorName]), [["Capo 2 for the whole song", "Sam Rivera"]], "Mike sees it");
      assert.deepEqual(await noteLines(mike, trio, harbor), ["Sam Rivera added a note to Harbor Lights"], "and the chat line");

      await app.click("Add a note", strip);
      await app.until(`!!document.querySelector(${js(box)})`, "the note box again");
      await setText(box, "Tag the ending twice");
      await offline(true);
      try {
        await app.click("Save note", strip);
        await app.until(`(${strip}.querySelector("[role=alert]")?.textContent ?? "").includes("Can't reach the server")`, "the offline words");
        assert.equal(await site.evaluate<string>(`document.querySelector(${js(box)}).value`), "Tag the ending twice", "the words are kept");
      } finally {
        await offline(false);
      }
      await app.click("Save note", strip);
      await app.until(`${strip}.querySelectorAll(".song-note").length === 1 && ${strip}.textContent.includes("1 more")`, "the second note, collapsed with 1 more");
      await sleep(500);
      assert.deepEqual((await listed(mike, trio, harbor)).notes.map((note) => note.body), ["Tag the ending twice", "Capo 2 for the whole song"], "stored once, newest first");

      await app.click("Delete", strip);
      await app.click("Yes, delete", strip);
      await app.until(`${strip}.querySelectorAll(".song-note").length === 1 && !${strip}.textContent.includes("more")`, "the deleted note leaving the strip");
      assert.deepEqual((await listed(mike, trio, harbor)).notes.map((note) => note.body), ["Capo 2 for the whole song"], "and the server");
    });

    await check("no page errors", async () => assert.deepEqual(await app.errors(), [], "the page logged no errors"));
  }
} finally {
  await site?.close();
  await main.worker.dispose();
  await fresh.worker.dispose();
}

finish(site ? "check:song-notes" : "check:song-notes --api");
