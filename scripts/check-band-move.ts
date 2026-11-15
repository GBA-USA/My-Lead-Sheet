import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BandLibrary, BandSong, SongContent } from "../src/band-library-model.ts";
import type { BandFile } from "../worker/room-export.ts";
import { Phone, startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, readQr, settle } from "./app-page.ts";
import { downloadBandFile, importBandFile, moveBand, type Admin } from "./band-move.ts";
import { openSite } from "./chrome.ts";

const root = new URL("..", import.meta.url).pathname;
const pass = (message: string) => console.log(`ok   ${message}`);

const seed = JSON.parse(readFileSync(`${root}data/library.json`, "utf8")) as { songs: (SongContent & { id: number })[] };
const content = ({ id: _id, ...song }: SongContent & { id: number }): SongContent => song;
const chart = (title: string, artist: string, lyric: string): SongContent => ({
  ...content(seed.songs[0]),
  title,
  artist,
  body: [{ heading: "Verse 1", lines: [{ chords: "G       C", lyrics: lyric }] }],
});

/** A timing version only the admin's phone has. Its name, tempo and tap time are odd enough that any copy of it anywhere is unmistakable. */
const PRIVATE_NAME = "Sam private take 7F3A";
const PRIVATE_VERSION = { name: PRIVATE_NAME, bpm: 97.13, marks: [{ at: 0, progress: 0 }, { at: 123457, progress: 1 }] };
const PRIVATE_MARKS = ["7F3A", "97.13", "123457", "leadSheetsScrollVersions"];

type Player = Awaited<ReturnType<typeof passwordPlayer>>;
type Deployment = { base: string; origin: string; worker: Awaited<ReturnType<typeof startApi>>["worker"] };

const admin = (who: Player, where: { base: string; origin: string }): Admin => ({ base: where.base, origin: where.origin, cookie: who.cookie });
const refusal = (reply: { status: number; body: Record<string, unknown> }) => [reply.status, reply.body.error];

async function band(who: Player, name: string, members: Player[]) {
  const bandId = (await who.call("/api/bands/create", { name })).body.bandId as string;
  const code = (await who.call("/api/codes", { kind: "band", bandId })).body.code as string;
  for (const member of members) assert.equal((await member.call("/api/bands/join", { code })).status, 200, `${member.name} joins ${name}`);
  return bandId;
}

async function library(who: Player, bandId: string) {
  const reply = await who.call("/api/bands/library", { bandId });
  assert.equal(reply.status, 200, `${who.name} reads the band library (${JSON.stringify(reply.body)})`);
  return reply.body as BandLibrary;
}

const share = (who: Player, bandId: string, song: SongContent, choice: "public" | "private") => who.call("/api/bands/library/share-song", { bandId, song, choice });
const shareSetlist = (who: Player, bandId: string, name: string, songIds: string[], tags: string[], choice: "public" | "private") =>
  who.call("/api/bands/library/share-setlist", { bandId, name, songIds, tags, choice });

/** Pairs each song in the file with the band song holding the same chart. The check may match by chart; the server never does. */
function arrivals(file: BandFile, lib: BandLibrary): Map<string, BandSong> {
  const map = new Map<string, BandSong>();
  for (const moved of file.songs) {
    const found = lib.songs.find((item) => JSON.stringify(item.song) === JSON.stringify(moved.song));
    assert.ok(found, `${moved.song.title} arrived`);
    map.set(moved.id, found);
  }
  return map;
}

async function apiChecks() {
  const old: Deployment = { origin: "https://old.test", ...(await startApi({ APP_ORIGIN: "https://old.test", RP_ID: "old.test", PASSWORD_PEPPER })) };
  const fresh: Deployment = { origin: "https://new.test", ...(await startApi({ APP_ORIGIN: "https://new.test", RP_ID: "new.test", PASSWORD_PEPPER })) };
  try {
    const terry = await passwordPlayer(old.base, old.origin, "Terry Bass", "terrybass");
    const mike = await passwordPlayer(old.base, old.origin, "Mike Keys", "mikekeys");
    const lee = await passwordPlayer(old.base, old.origin, "Lee Sax", "leesax");
    const blue = await band(terry, "The Blue Notes", [mike]);
    const chainBreaker = chart("Chain Breaker", "Nightshift", "Break every chain tonight");
    const midnight = chart("Midnight Run", "Dawn Patrol", "Run till the morning light");
    const builtIn = content(seed.songs[1]);
    const chainId = (await share(terry, blue, chainBreaker, "private")).body.songId as string;
    const midnightId = (await share(mike, blue, midnight, "public")).body.songId as string;
    const builtInId = (await share(terry, blue, builtIn, "public")).body.songId as string;
    assert.equal((await shareSetlist(mike, blue, "Friday set", [midnightId, builtInId], ["gig", "friday"], "public")).status, 200, "Mike shares a setlist");
    assert.equal((await shareSetlist(terry, blue, "Terry's picks", [chainId, midnightId], [], "private")).status, 200, "Terry shares a Private setlist");

    const exported = await downloadBandFile(admin(terry, old), blue);
    assert.equal(exported.status, 200, `the admin downloads the band file (${JSON.stringify(exported.body).slice(0, 200)})`);
    const file = exported.body;
    assert.deepEqual(refusal(await downloadBandFile(admin(mike, old), blue)), [403, "not-admin"], "a member is refused");
    assert.deepEqual(refusal(await downloadBandFile(admin(lee, old), blue)), [403, "not-a-member"], "someone outside the band is refused");
    assert.deepEqual(refusal(await downloadBandFile({ ...admin(terry, old), cookie: "" }, blue)), [401, "signed-out"], "a signed-out phone is refused");
    assert.deepEqual(refusal(await downloadBandFile(admin(terry, old), "band_nope")), [400, "bad-request"], "a band id that isn't one is refused");
    pass("an admin downloads the band file and a member is refused");

    assert.deepEqual(Object.keys(file).sort(), ["band", "exportedAt", "exportedFrom", "setlists", "songs"], "the file holds the header, songs and setlists, nothing else");
    assert.deepEqual([file.exportedFrom, file.band.name], [`${old.origin}/${blue}`, "The Blue Notes"], "the header names the source deployment and band");
    assert.ok(!Number.isNaN(Date.parse(file.exportedAt)), "and when it was made");
    const text = JSON.stringify(file);
    for (const absent of ["messages", "gigs", "members", "display_name", "Terry Bass\"", "Mike Keys\""]) assert.ok(!text.includes(absent), `the file carries no ${absent}`);
    assert.deepEqual(
      file.songs.map((item) => [item.song.title, item.share.choice, item.versions]),
      [
        ["Chain Breaker", "private", []],
        ["Midnight Run", "public", []],
        [builtIn.title, "public", []],
      ],
      "each song carries its chart, its Private or Public choice and its band timing versions, of which there are none yet",
    );
    assert.deepEqual(
      file.setlists.map((item) => [item.name, item.songIds, item.tags, item.share.choice]),
      [
        ["Friday set", [midnightId, builtInId], ["gig", "friday"], "public"],
        ["Terry's picks", [chainId, midnightId], [], "private"],
      ],
      "each setlist carries its name, songs, tags and choice",
    );
    pass("chat and gig logs are absent from the file");

    const ann = await passwordPlayer(fresh.base, fresh.origin, "Ann Horn", "annhorn");
    const dana = await passwordPlayer(fresh.base, fresh.origin, "Dana Drums", "danadrums");
    const sid = await passwordPlayer(fresh.base, fresh.origin, "Sid Strings", "sidstrings");
    const newBlue = await band(ann, "The Blue Notes", [dana]);
    const danas = await band(dana, "Dana's Own", []);
    assert.deepEqual(refusal(await importBandFile(admin(dana, fresh), newBlue, text)), [403, "not-admin"], "a member can't import");
    assert.deepEqual(refusal(await importBandFile(admin(sid, fresh), newBlue, text)), [403, "not-a-member"], "nor can someone outside the band");
    assert.deepEqual(refusal(await importBandFile({ ...admin(ann, fresh), cookie: "" }, newBlue, text)), [401, "signed-out"], "nor a signed-out phone");
    assert.deepEqual((await library(ann, newBlue)).songs, [], "nothing arrived from the refused tries");

    const imported = await moveBand(admin(terry, old), blue, admin(ann, fresh), newBlue);
    assert.deepEqual([imported.status, imported.body], [200, { songs: { added: 3, skipped: 0 }, setlists: { added: 2, skipped: 0 } }], "the admin of the new band imports the file");
    const arrived = await library(dana, newBlue);
    const byFileId = arrivals(file, arrived);
    for (const moved of file.songs) {
      const song = byFileId.get(moved.id)!;
      assert.notEqual(song.songId, moved.id, `${moved.song.title} has a new id`);
      assert.deepEqual([song.sharedAs, song.canSendOn, song.sharedByName], [moved.share.choice, moved.share.choice === "public", "Ann Horn"], `${moved.song.title} keeps its ${moved.share.choice} flag, and a member may send on only a Public one`);
      const annSees = (await library(ann, newBlue)).songs.find((item) => item.songId === song.songId)!;
      assert.equal(annSees.canSendOn, moved.share.choice === "public", `the importing admin can't send on ${moved.song.title} either, unless it was Public`);
    }
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    assert.deepEqual(
      [...arrived.setlists].sort(byName).map((item) => [item.name, item.songIds, item.tags, item.sharedAs]),
      [...file.setlists].sort(byName).map((item) => [item.name, item.songIds.map((id) => byFileId.get(id)!.songId), item.tags, item.share.choice]),
      "setlists arrive with their songs remapped to the new ids, tags and choice kept",
    );
    const privateCopy = (await dana.call("/api/bands/library/copy-song", { bandId: newBlue, songId: byFileId.get(chainId)!.songId })).body;
    assert.equal(privateCopy.copy.canSendOn, false, "Dana adds the moved Private song to My Songs as not hers to send on");
    const tried = await dana.call("/api/bands/library/share-song", { bandId: danas, song: chainBreaker, choice: "public", copyId: privateCopy.copy.id });
    assert.equal(tried.status, 403, `and the server refuses to pass it on (${JSON.stringify(tried.body)})`);
    assert.match(String(tried.body.error), /^private_(copy|ancestor)$/, "because it was shared privately");
    const publicCopy = (await dana.call("/api/bands/library/copy-song", { bandId: newBlue, songId: byFileId.get(midnightId)!.songId })).body;
    assert.equal((await dana.call("/api/bands/library/share-song", { bandId: danas, song: midnight, choice: "public", copyId: publicCopy.copy.id })).status, 200, "while the moved Public song passes on");
    pass("songs, setlists and timing versions arrive deep-equal with ids remapped and their Private or Public flags kept");

    const again = await importBandFile(admin(ann, fresh), newBlue, text);
    assert.deepEqual([again.status, again.body], [200, { songs: { added: 0, skipped: 3 }, setlists: { added: 0, skipped: 2 } }], "the second import reports everything as already here");
    const after = await library(dana, newBlue);
    assert.deepEqual(
      [after.songs.map((item) => item.songId), after.setlists.map((item) => item.setlistId)],
      [arrived.songs.map((item) => item.songId), arrived.setlists.map((item) => item.setlistId)],
      "and the band holds the same rows as before",
    );
    pass("importing the same file twice adds nothing");

    const broken: [string, string][] = [
      ["text that isn't JSON", "{nope"],
      ["a JSON list", "[]"],
      ["a file with no exportedFrom", JSON.stringify({ ...file, exportedFrom: undefined })],
      ["a song whose chart isn't one", JSON.stringify({ ...file, songs: [{ ...file.songs[0], song: { ...file.songs[0].song, body: "lyrics" } }] })],
      ["a song with no Private or Public choice", JSON.stringify({ ...file, songs: [{ ...file.songs[0], share: { choice: "friends", parentId: null } }] })],
      ["a setlist naming a song the file doesn't hold", JSON.stringify({ ...file, setlists: [{ ...file.setlists[0], songIds: ["song_elsewhere"] }] })],
      ["two songs with the same id", JSON.stringify({ ...file, songs: [file.songs[0], file.songs[0]] })],
    ];
    for (const [what, body] of broken) assert.deepEqual(refusal(await importBandFile(admin(ann, fresh), newBlue, body)), [400, "bad-file"], `${what} is refused as a bad file`);
    const own = await downloadBandFile(admin(ann, fresh), newBlue);
    assert.deepEqual(refusal(await importBandFile(admin(ann, fresh), newBlue, JSON.stringify(own.body))), [400, "own-file"], "the band's own file is refused instead of doubling every song");
    const huge = JSON.stringify({ ...file, exportedAt: "x".repeat(4_000_000) });
    assert.deepEqual(refusal(await importBandFile(admin(ann, fresh), newBlue, huge)), [413, "too-large"], "a file past the size cap is refused");
    assert.deepEqual(await library(dana, newBlue), after, "none of the refused files changed the band");
    const empty = await band(ann, "Empty Stage", []);
    const emptyFile = await downloadBandFile(admin(ann, fresh), empty);
    assert.deepEqual([emptyFile.body.songs, emptyFile.body.setlists], [[], []], "an empty band exports a file with no songs");
    const nothing = await importBandFile(admin(ann, fresh), newBlue, JSON.stringify(emptyFile.body));
    assert.deepEqual([nothing.status, nothing.body], [200, { songs: { added: 0, skipped: 0 }, setlists: { added: 0, skipped: 0 } }], "and importing it is a no-op");
    pass("a file from another band or with a tampered item is refused kindly");
  } finally {
    await old.worker.dispose();
    await fresh.worker.dispose();
  }
}

async function appChecks() {
  let apiBase = "";
  const site = await openSite(root, "check-band-move", () => apiBase);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
  apiBase = base;
  const downloads = mkdtempSync(join(tmpdir(), "band-move-downloads-"));
  const files = mkdtempSync(join(tmpdir(), "band-move-files-"));
  try {
    const app = await appPage(site);
    await site.send("Network.enable");
    await site.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
    const view = (name: string) => app.until(`document.querySelector(".bands-sheet")?.dataset.view === ${JSON.stringify(name)} && !document.querySelector(".bands-sheet").textContent.includes("Loading")`, `the ${name} view`, 15000);
    const status = (words: string) => app.until(`(document.querySelector(".bands-sheet [role=status], .bands-sheet [role=alert]")?.textContent ?? "").includes(${JSON.stringify(words)})`, `the words ${words}`, 15000);
    const pickFile = async (path: string) => {
      const { root: doc } = await site.send("DOM.getDocument", { depth: 1 });
      const { nodeId } = await site.send("DOM.querySelector", { nodeId: doc.nodeId, selector: ".bands-sheet input[type=file]" });
      await site.send("DOM.setFileInputFiles", { nodeId, files: [path] });
    };
    const offline = (on: boolean) => site.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");

    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await app.library();
    const firstSong = await site.evaluate<string>(`document.querySelector('a[href^="#/song/"]').getAttribute("href").match(/\\d+/)[0]`);
    await site.evaluate(`localStorage.setItem("leadSheetsScrollVersions.${firstSong}", ${JSON.stringify(JSON.stringify({ versions: [PRIVATE_VERSION], selected: 0 }))})`);
    await site.send("Page.reload");
    await app.library();
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
    const trio = (await mike.call("/api/bands/join", { code: link.slice(`${origin}/c/`.length) })).body.bandId as string;
    const mikesSong = chart("Harbor Lights", "Mike Keys", "Harbor lights are calling me home");
    assert.equal((await share(mike, trio, mikesSong, "public")).status, 200, "Mike shares a song into Sam's Trio");
    const side = await band(mike, "Side Project", []);
    const sideSongs = [chart("Side One", "Mike Keys", "First side song"), chart("Side Two", "Mike Keys", "Second side song")];
    const sideIds: string[] = [];
    for (const song of sideSongs) sideIds.push((await share(mike, side, song, "private")).body.songId as string);
    assert.equal((await shareSetlist(mike, side, "Side set", sideIds, ["side"], "public")).status, 200, "Mike shares a setlist into Side Project");
    const sideFile = join(files, "Side Project.json");
    writeFileSync(sideFile, JSON.stringify((await downloadBandFile(admin(mike, { base, origin }), side)).body));
    const notAFile = join(files, "notes.json");
    writeFileSync(notAFile, "set list for friday: open with harbor lights");
    assert.deepEqual(refusal(await downloadBandFile(admin(mike, { base, origin }), trio)), [403, "not-admin"], "Mike, a member of Sam's Trio, can't download its file");

    await app.click("Back");
    await view("band");
    await app.click("Band settings");
    await view("settings");
    await app.click("Download band file");
    await status("Downloaded Sam's Trio.json.");
    let saved: string[] = [];
    for (const end = Date.now() + 10000; Date.now() < end && !saved.includes("Sam's Trio.json"); await settle(100)) saved = readdirSync(downloads);
    assert.deepEqual(saved, ["Sam's Trio.json"], "the download is a file named after the band");
    const downloaded = JSON.parse(readFileSync(join(downloads, "Sam's Trio.json"), "utf8")) as BandFile;
    assert.deepEqual([downloaded.exportedFrom, downloaded.band.name, downloaded.songs.map((item) => item.song.title), downloaded.setlists], [`${origin}/${trio}`, "Sam's Trio", ["Harbor Lights"], []], "it holds the band's songs");
    const downloadedText = readFileSync(join(downloads, "Sam's Trio.json"), "utf8");
    for (const mark of PRIVATE_MARKS) assert.ok(!downloadedText.includes(mark), `Sam's private timing version (${mark}) never appears in the band file`);
    assert.ok(!downloadedText.includes("messages") && !downloadedText.includes("gigs"), "and neither do chat or gig logs");
    pass("the Band settings button is admin-only and downloads a file named after the band");

    await pickFile(sideFile);
    await status("Added 2 songs and 1 setlist.");
    const trioLibrary = await library(mike, trio);
    assert.deepEqual(trioLibrary.songs.map((item) => [item.song.title, item.sharedAs, item.canSendOn]).sort(), [["Harbor Lights", "public", true], ["Side One", "private", false], ["Side Two", "private", false]], "Mike sees the imported songs with their flags");
    assert.deepEqual(trioLibrary.setlists.map((item) => [item.name, item.songIds.length]), [["Side set", 2]], "and the setlist");
    await pickFile(sideFile);
    await status("Already here · 2 songs and 1 setlist skipped");
    await pickFile(join(downloads, "Sam's Trio.json"));
    await status("That file came from this band, so there's nothing to import.");
    await pickFile(notAFile);
    await status("That isn't a band file.");
    assert.equal((await library(mike, trio)).songs.length, 3, "none of those changed the band");
    await offline(true);
    await pickFile(sideFile);
    await status("Can't reach the server. Check your connection and try again.");
    await offline(false);
    await pickFile(sideFile);
    await status("Already here · 2 songs and 1 setlist skipped");
    assert.equal((await library(mike, trio)).songs.length, 3, "and coming back online made no duplicates");
    pass("import shows its counts, and already-here, bad-file, own-file and offline each get a clear message");

    assert.deepEqual(await app.errors(), [], "no page errors");
  } finally {
    await site.close();
    await worker.dispose();
  }
}

await apiChecks();
await appChecks();
console.log("check:band-move passed");
