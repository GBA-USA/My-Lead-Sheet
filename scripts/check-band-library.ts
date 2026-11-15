import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Phone, startApi, TEST_ORIGIN } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle, WIDTH } from "./app-page.ts";
import { openSite } from "./chrome.ts";
import type { BandLibrary, BandSetlist, SongContent } from "../src/band-library-model.ts";

const root = new URL("..", import.meta.url).pathname;
/** Set SHOTS to a folder to save the band library screens at phone size. */
const shots = process.env.SHOTS;
const pass = (message: string) => console.log(`ok   ${message}`);

const seed = JSON.parse(readFileSync(`${root}data/library.json`, "utf8")) as { songs: (SongContent & { id: number })[]; setlists: { id: number; name: string; songIds: number[] }[] };
const content = ({ id: _id, ...song }: SongContent & { id: number }): SongContent => song;
const chart = (title: string, artist: string, lyric: string): SongContent => ({
  ...content(seed.songs[0]),
  title,
  artist,
  body: [{ heading: "Verse 1", lines: [{ chords: "G       C", lyrics: lyric }] }],
});

type Player = Awaited<ReturnType<typeof passwordPlayer>>;

const library = async (who: Player, bandId: string) => {
  const reply = await who.call("/api/bands/library", { bandId });
  assert.equal(reply.status, 200, `${who.name} reads the band library (${JSON.stringify(reply.body)})`);
  return reply.body as BandLibrary;
};
const songIn = (lib: BandLibrary, title: string) => lib.songs.find((item) => item.song.title === title)!;
const refusal = (reply: { status: number; body: Record<string, unknown> }) => [reply.status, reply.body.error];

async function band(admin: Player, name: string, members: Player[]) {
  const bandId = (await admin.call("/api/bands/create", { name })).body.bandId as string;
  const code = (await admin.call("/api/codes", { kind: "band", bandId })).body.code as string;
  for (const member of members) assert.equal((await member.call("/api/bands/join", { code })).status, 200, `${member.name} joins ${name}`);
  return bandId;
}

async function apiChecks(base: string, origin: string) {
  const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
  const dana = await passwordPlayer(base, origin, "Dana Drums", "danadrums");
  const ann = await passwordPlayer(base, origin, "Ann Horn", "annhorn");
  const lee = await passwordPlayer(base, origin, "Lee Sax", "leesax");
  const blue = await band(terry, "The Blue Notes", [mike, dana]);
  const side = await band(mike, "Side Project", [ann, terry]);

  const chainBreaker = chart("Chain Breaker", "Terry Bass", "Break every chain tonight");
  const midnight = chart("Midnight Run", "Dana Drums", "Run till the morning light");
  const share = (who: Player, bandId: string, song: SongContent, choice: unknown, extra: Record<string, unknown> = {}) =>
    who.call("/api/bands/library/share-song", { bandId, song, choice, localId: 101, ...extra });

  assert.equal((await new Phone(base).call("/api/bands/library", { bandId: blue })).status, 401, "a signed-out phone can't read a band library");
  assert.deepEqual(refusal(await lee.call("/api/bands/library", { bandId: blue })), [403, "not-a-member"], "nor can someone outside the band");
  assert.deepEqual(refusal(await share(lee, blue, chainBreaker, "public")), [403, "not-a-member"], "or share into it");
  assert.deepEqual(refusal(await share(terry, blue, chainBreaker, null)), [400, "choice_required"], "a share with no Private or Public answer is refused");
  assert.deepEqual(refusal(await share(terry, blue, chainBreaker, "friends")), [400, "choice_required"], "and so is any other answer");
  assert.deepEqual(refusal(await share(terry, blue, { ...chainBreaker, body: "lyrics" as unknown as SongContent["body"] }, "private")), [400, "bad-request"], "a chart that isn't one is refused");
  assert.deepEqual((await library(terry, blue)).songs, [], "nothing was stored");
  pass("only members share, and only after answering Private or Public");

  const shared = await share(terry, blue, chainBreaker, "private");
  assert.equal(shared.status, 200, `Terry shares Chain Breaker into The Blue Notes as Private (${JSON.stringify(shared.body)})`);
  assert.deepEqual([shared.body.sharedAs, shared.body.canSendOn, shared.body.localId, shared.body.rev], ["private", true, 101, 1], "Terry, who shared it, can still send it on");
  for (const member of [mike, dana]) {
    const seen = songIn(await library(member, blue), "Chain Breaker");
    assert.deepEqual(seen.song, chainBreaker, `${member.name} gets the whole chart`);
    assert.deepEqual([seen.sharedByName, seen.sharedAs, seen.canSendOn, seen.localId], ["Terry Bass", "private", false, null], `${member.name} sees it is Terry's Private share and can't send it on`);
  }
  const copied = await mike.call("/api/bands/library/copy-song", { bandId: blue, songId: shared.body.songId });
  assert.equal(copied.status, 200, "Mike adds the Private song to My Songs");
  assert.deepEqual([copied.body.song, copied.body.copy.canSendOn], [chainBreaker, false], "his copy is the whole chart, marked as not his to send on");
  pass("a Private share can be used by every member: read and added to My Songs");

  for (const [how, extra] of [
    ["naming his copy", { copyId: copied.body.copy.id }],
    ["claiming it is reshareable", { copyId: copied.body.copy.id, reshareable: true }],
    ["leaving the copy out, as if it were his own song", {}],
  ] as const) {
    for (const choice of ["public", "private"]) {
      const tried = await share(mike, side, chainBreaker, choice, extra);
      assert.equal(tried.status, 403, `Mike can't send Terry's Private song on to Side Project ${how}, as ${choice} (${JSON.stringify(tried.body)})`);
      assert.match(String(tried.body.error), /^private_(copy|ancestor)$/, "the refusal says it was shared privately");
    }
  }
  const sameOnScreen = {
    ...chainBreaker,
    body: [
      { heading: "Verse 1", lines: [{ lyrics: "Break every chain tonight   ", chords: "G       C", hidden: "x" }, {}] },
      { heading: "", lines: [] },
    ],
  };
  assert.equal((await share(mike, side, sameOnScreen as SongContent, "public")).status, 403, "nor by changing only what never shows: key order, an unknown field, trailing spaces, empty lines");
  assert.equal((await share(mike, blue, chainBreaker, "public")).status, 403, "nor share it again into The Blue Notes");
  assert.deepEqual(refusal(await share(dana, side, chainBreaker, "public", { copyId: copied.body.copy.id })), [403, "not-a-member"], "Dana can't use Mike's copy in a band she isn't in");
  assert.deepEqual(refusal(await share(ann, side, chainBreaker, "public", { copyId: copied.body.copy.id })), [404, "not_found"], "nor can Ann name Mike's copy as hers");
  assert.deepEqual((await library(ann, side)).songs, [], "Side Project still has no songs");
  const terrysOwn = await share(terry, side, chainBreaker, "public");
  assert.deepEqual([terrysOwn.status, terrysOwn.body.sharedAs], [200, "public"], "only Terry can send it on, and he picks again");
  pass("no member can send a Private share on; only the person who shared it can");

  const danas = await share(dana, blue, midnight, "public");
  assert.deepEqual([danas.status, songIn(await library(mike, blue), "Midnight Run").canSendOn], [200, true], "Dana shares Midnight Run as Public, so members may send it on");
  const mikesCopy = (await mike.call("/api/bands/library/copy-song", { bandId: blue, songId: danas.body.songId })).body;
  assert.equal(mikesCopy.copy.canSendOn, true, "Mike's copy of a Public share is his to send on");
  const ironGate = chart("Iron Gate", "Terry Bass", "Open up the iron gate");
  assert.equal((await share(terry, blue, ironGate, "private")).status, 200, "Terry shares Iron Gate as Private, only into The Blue Notes");
  assert.deepEqual(refusal(await share(mike, side, ironGate, "public", { copyId: mikesCopy.copy.id })), [403, "private_copy"], "naming that Public copy doesn't let Mike send a Private chart with it");
  const resent = await share(mike, side, midnight, "private", { copyId: mikesCopy.copy.id });
  assert.deepEqual([resent.status, resent.body.sharedAs], [200, "private"], "Mike sends his copy on to Side Project as Private");
  const annSees = songIn(await library(ann, side), "Midnight Run");
  assert.deepEqual([annSees.sharedByName, annSees.canSendOn], ["Mike Keys", false], "Ann sees Mike's Private share");
  const annsCopy = (await ann.call("/api/bands/library/copy-song", { bandId: side, songId: annSees.songId })).body;
  assert.deepEqual(refusal(await share(ann, side, midnight, "public", { copyId: annsCopy.copy.id })), [403, "private_ancestor"], "so every later copy stays unshareable");
  pass("a Public copy resent as Private can't be passed on again");

  for (const [earlier, earlierBand, later, laterBand, laterBandName, builtIn] of [
    [terry, blue, mike, side, "Side Project", content(seed.songs[1])],
    [mike, side, terry, blue, "The Blue Notes", content(seed.songs[2])],
  ] as const) {
    assert.equal((await share(earlier, earlierBand, builtIn, "private")).status, 200, `${earlier.name} shares the built-in ${builtIn.title} as Private`);
    const own = await share(later, laterBand, builtIn, "private");
    assert.equal(own.status, 200, `${later.name} shares the same built-in ${builtIn.title}, which every phone has, into ${laterBandName} (${JSON.stringify(own.body)})`);
    assert.equal(own.body.canSendOn, true, `and it is ${later.name}'s own to send on`);
  }
  const theMiddle = content(seed.songs[3]);
  const terrysMiddle = await share(terry, blue, theMiddle, "private");
  const mikesMiddle = (await mike.call("/api/bands/library/copy-song", { bandId: blue, songId: terrysMiddle.body.songId })).body;
  const namedMiddle = await share(mike, side, theMiddle, "public", { copyId: mikesMiddle.copy.id });
  assert.equal(namedMiddle.status, 403, `Mike can't send Terry's Private copy of the built-in ${theMiddle.title} on by naming it (${JSON.stringify(namedMiddle.body)})`);
  const ownMiddle = await share(mike, side, theMiddle, "public");
  assert.equal(ownMiddle.status, 200, `but his own built-in ${theMiddle.title} is still his to share after he added Terry's Private copy of it to My Songs (${JSON.stringify(ownMiddle.body)})`);
  pass("a built-in song every phone has stays each player's own, whoever shared it Private first");

  const riverRoad = chart("River Road", "Ann Horn", "Down along the river road");
  assert.equal((await share(mike, side, riverRoad, "private")).status, 200, "Mike types Ann's River Road into Side Project as Private");
  const horns = await band(ann, "Horn Section", []);
  for (const [bandId, where] of [
    [horns, "her own band"],
    [side, "Side Project, beside Mike's Private copy"],
  ] as const) {
    const authors = await share(ann, bandId, riverRoad, "public");
    assert.deepEqual([authors.status, authors.body.canSendOn], [200, true], `Ann, who wrote River Road, shares it into ${where} (${JSON.stringify(authors.body)})`);
  }
  pass("a chart stays its author's to send after a bandmate shares the same chart Private");

  const openRoad = chart("Open Road", "Terry Bass", "Miles to go before the show");
  const retried = [await share(terry, blue, openRoad, "public", { shareId: "share_retry_1" }), await share(terry, blue, openRoad, "public", { shareId: "share_retry_1" })];
  assert.deepEqual(retried.map((reply) => reply.status), [200, 200], `a share sent twice with the same phone-made share id is accepted both times (${JSON.stringify(retried.map((reply) => reply.body))})`);
  assert.equal((await library(terry, blue)).songs.filter((item) => item.song.title === "Open Road").length, 1, "and the band holds one copy of it, not two");
  pass("a retried share with the same share id makes one band song");

  const [first, second] =[songIn(await library(terry, blue), "Midnight Run"), songIn(await library(terry, blue), "Chain Breaker")];
  const setlist = { bandId: blue, name: "Friday at Elks", songIds: [second.songId, first.songId], tags: ["Bar"], choice: "private", localId: 7 };
  assert.deepEqual(refusal(await terry.call("/api/bands/library/share-setlist", { ...setlist, choice: undefined })), [400, "choice_required"], "a setlist share asks Private or Public too");
  assert.deepEqual(
    refusal(await terry.call("/api/bands/library/share-setlist", { ...setlist, songIds: [second.songId, "song_nope"] })),
    [400, "not-a-band-song"],
    "a band setlist only points at band songs",
  );
  const friday = await terry.call("/api/bands/library/share-setlist", setlist);
  assert.deepEqual([friday.status, friday.body.name, friday.body.songIds, friday.body.rev], [200, "Friday at Elks", setlist.songIds, 1], "Terry shares a setlist into the band");
  const fridayForMike = (await library(mike, blue)).setlists[0];
  assert.deepEqual([fridayForMike.name, fridayForMike.sharedAs, fridayForMike.canSendOn], ["Friday at Elks", "private", false], "members see the Private setlist and can't send it on");

  const edit = (who: Player, base: number, name: string) =>
    who.call("/api/bands/library/edit-setlist", { bandId: blue, setlistId: friday.body.setlistId, base, name, songIds: setlist.songIds, tags: ["Bar"] });
  assert.deepEqual(refusal(await edit(mike, 1, "Mike's night")), [403, "not-yours"], "a member can't edit someone else's setlist");
  const racing = await Promise.all([edit(terry, 1, "Friday early"), edit(terry, 1, "Friday late")]);
  assert.deepEqual(racing.map((reply) => reply.status).sort(), [200, 409], "two edits from the same base: one is saved, the other is told it changed");
  const winner = racing.find((reply) => reply.status === 200)!.body as BandSetlist;
  const loser = racing.find((reply) => reply.status === 409)!.body;
  assert.equal(loser.error, "changed", "the late edit gets 'changed'");
  assert.deepEqual([loser.current.name, loser.current.rev], [winner.name, 2], "with the saved setlist, so the phone can show it");
  assert.deepEqual([(await library(dana, blue)).setlists[0].name], [winner.name], "and the band keeps the first edit, not the stale one");
  assert.equal((await edit(terry, 2, "Friday at Elks")).body.rev, 3, "an edit from the latest rev is saved");
  const danasSet = (await dana.call("/api/bands/library/share-setlist", { ...setlist, name: "Dana's warmup", choice: "public" })).body as BandSetlist;
  const adminEdit = await terry.call("/api/bands/library/edit-setlist", { bandId: blue, setlistId: danasSet.setlistId, base: 1, name: "Warmup", songIds: [first.songId], tags: [] });
  assert.deepEqual([adminEdit.status, adminEdit.body.name, adminEdit.body.sharedBy], [200, "Warmup", dana.userId], "the admin can edit any member's setlist");

  const songEdit = (who: Player, base: number, lyric: string) =>
    who.call("/api/bands/library/edit-song", { bandId: blue, songId: second.songId, base, song: chart("Chain Breaker", "Terry Bass", lyric) });
  assert.deepEqual(refusal(await songEdit(dana, 1, "Dana's words")), [403, "not-yours"], "a member can't edit someone else's song");
  assert.equal((await songEdit(terry, 1, "Break every chain, every night")).body.rev, 2, "Terry updates his song");
  const stale = await songEdit(terry, 1, "An older take");
  assert.deepEqual([stale.status, stale.body.current.song.body[0].lines[0].lyrics], [409, "Break every chain, every night"], "an edit from an old rev is refused with the saved song");
  assert.deepEqual(
    refusal(await share(mike, side, chart("Chain Breaker", "Terry Bass", "Break every chain, every night"), "public")),
    [403, "private_copy"],
    "the edited Private song still can't be sent on",
  );
  const backAlley = chart("Back Alley", "Mike Keys", "Nobody walks the back alley");
  assert.equal((await share(mike, side, backAlley, "private")).status, 200, "Mike shares Back Alley into Side Project as Private");
  const terrysAlley = (await terry.call("/api/bands/library/copy-song", { bandId: side, songId: songIn(await library(terry, side), "Back Alley").songId })).body;
  const alleyOn = await share(terry, blue, backAlley, "public", { copyId: terrysAlley.copy.id });
  assert.equal(alleyOn.status, 403, `Terry can't send Back Alley on (${JSON.stringify(alleyOn.body)})`);
  assert.match(String(alleyOn.body.error), /^private_(copy|ancestor)$/, "because it was shared with him privately");
  const staleAlley = await terry.call("/api/bands/library/edit-song", { bandId: blue, songId: second.songId, base: 1, song: backAlley });
  assert.deepEqual(
    [staleAlley.status, staleAlley.body.error, staleAlley.body.current?.rev],
    [409, "changed", 2],
    `a stale edit is told the song changed, even when it pastes in a chart Terry can't send on (${JSON.stringify(staleAlley.body)})`,
  );
  assert.equal(songIn(await library(terry, blue), "Chain Breaker").song.body[0].lines[0].lyrics, "Break every chain, every night", "and the band song is untouched");
  pass("edits check the base rev, and only the sharer or an admin edits");

  await terry.call("/api/bands/remove", { bandId: blue, userId: dana.userId });
  assert.deepEqual(refusal(await dana.call("/api/bands/library", { bandId: blue })), [403, "not-a-member"], "a removed member can't read the library");
  assert.deepEqual(refusal(await dana.call("/api/bands/library/copy-song", { bandId: blue, songId: second.songId })), [403, "not-a-member"], "or copy from it");
  assert.equal(songIn(await library(mike, blue), "Midnight Run").sharedByName, "Dana Drums", "what she shared stays with the band");
  pass("a removed member is out of the band library");
}

async function appChecks(site: Awaited<ReturnType<typeof openSite>>, base: string, origin: string) {
  const app = await appPage(site);
  const view = (name: string) =>
    app.until(`document.querySelector(".bands-sheet")?.dataset.view === ${JSON.stringify(name)} && !document.querySelector(".bands-sheet").textContent.includes("Loading")`, `the ${name} view`, 15000);
  const noticed = (pattern: string) => app.until(`new RegExp(${JSON.stringify(pattern)}).test(document.querySelector(".bands-notice")?.textContent ?? "")`, `the notice ${pattern}`);
  const rows = (list: string) => app.texts(`.band-library-${list} li .band-library-name`);
  const row = (list: string, name: string) =>
    `[...document.querySelectorAll(".band-library-${list} li")].find((li) => li.querySelector(".band-library-name")?.textContent.trim() === ${JSON.stringify(name)})`;
  const fitsPhone = async (what: string) => {
    const fit = await app.fits();
    assert.ok(fit.page <= WIDTH && fit.left >= 0 && fit.right <= WIDTH, `${what} fits the phone with no sideways scroll (${JSON.stringify(fit)})`);
  };
  const tab = (name: string) => app.click(name, `document.querySelector(".band-tabs")`);
  const setField = async (by: "label" | "select", target: string, value: string) => {
    const field =
      by === "label"
        ? `[...document.querySelectorAll("[role=dialog] label")].find((l) => l.textContent.trim() === ${JSON.stringify(target)}).control`
        : `document.querySelector(${JSON.stringify(target)})`;
    await site.evaluate(
      `(() => { const field = ${field}; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, ${JSON.stringify(value)}); field.dispatchEvent(new Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true })); })()`,
    );
    await settle();
  };
  const pickMine = async (title: string) => {
    const picked = await site.evaluate<boolean>(
      `(() => { const row = [...document.querySelectorAll(".band-library-pick-row")].find((b) => b.firstChild.textContent === ${JSON.stringify(title)} && !b.disabled); row?.click(); return !!row; })()`,
    );
    assert.ok(picked, `${title} to pick`);
    await settle();
  };

  const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys2");
  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await app.library();
  await app.signUp("Sam Rivera");
  await app.openMenu();
  await app.pick("Bands");
  await view("list");
  await app.type("New band", "Porch Band");
  await app.click("Create band");
  await view("band");
  const bandId = await site.evaluate<string>(`document.querySelector(".bands-sheet").dataset.band`);
  assert.deepEqual(await app.texts(".band-tabs [role=tab]"), ["Setlists", "Songs", "Members"], "the band screen has Setlists, Songs and Members tabs");

  const fireAway = seed.songs[0].title;
  await tab("Songs");
  assert.match(await app.text(".band-library-songs-empty"), /No songs yet/, "a new band has no songs");
  await app.click("+ Share a song");
  await app.type("Find a song", fireAway);
  await pickMine(fireAway);
  assert.equal(
    await site.evaluate<boolean>(`[...document.querySelectorAll(".band-library-share button")].find((b) => b.textContent.trim() === "Share").disabled`),
    true,
    "Share stays off until Private or Public is picked",
  );
  assert.match(await app.text(".band-library-share"), /The band gets a copy\. Your later changes won't change it\./, "the question says the band gets a copy");
  await app.shot(shots && `${shots}/band-library-share.png`);
  await fitsPhone("the Private or Public question");
  await app.click("Private");
  await app.click("Share");
  await noticed(`Shared ${fireAway} as Private`);
  assert.deepEqual(await rows("songs"), [fireAway], "the shared song is on the band's Songs");
  pass("Share a song asks Private or Public, then puts a copy in the band");

  const invite = await site.evaluate<string>(
    `(async () => (await (await fetch("/api/codes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "band", bandId: ${JSON.stringify(bandId)} }) })).json()).code)()`,
  );
  assert.equal((await mike.call("/api/bands/join", { code: invite })).status, 200, "Mike joins Porch Band");
  const mikesView = songIn(await library(mike, bandId), fireAway);
  assert.deepEqual([mikesView.song.body, mikesView.canSendOn], [seed.songs[0].body, false], "Mike gets Sam's whole chart, and can't send it on");
  const mikeSide = (await mike.call("/api/bands/create", { name: "Mike's Duo" })).body.bandId as string;
  const mikesCopy = (await mike.call("/api/bands/library/copy-song", { bandId, songId: mikesView.songId })).body;
  assert.equal(
    (await mike.call("/api/bands/library/share-song", { bandId: mikeSide, song: mikesCopy.song, choice: "public", localId: 1, copyId: mikesCopy.copy.id })).status,
    403,
    "a direct server call from Mike to pass Sam's Private song on is refused",
  );

  const mikesPrivate = chart("Back Porch Blues", "Mike Keys", "Sitting on the back porch");
  const mikesPublic = chart("Alley Cat", "Mike Keys", "Down the alley late");
  for (const [song, choice] of [
    [mikesPublic, "public"],
    [mikesPrivate, "private"],
  ] as const) {
    assert.equal((await mike.call("/api/bands/library/share-song", { bandId, song, choice, localId: 5 })).status, 200, `Mike shares ${song.title} as ${choice}`);
  }
  await tab("Setlists");
  await tab("Songs");
  await app.until(`document.querySelectorAll(".band-library-songs li").length === 3`, "Mike's songs on Sam's screen");
  assert.deepEqual(await rows("songs"), ["Alley Cat", "Back Porch Blues", fireAway], "songs list A-Z");
  assert.match(await site.evaluate<string>(`${row("songs", "Back Porch Blues")}.textContent`), /Mike Keys · Private/, "a Private share says who shared it and that it is Private");
  assert.equal(await site.evaluate<boolean>(`!!${row("songs", "Back Porch Blues")}.querySelector("[aria-label='Private']")`), true, "with a lock");
  await app.type("Search band songs", "porch");
  assert.deepEqual(await rows("songs"), ["Back Porch Blues"], "the search box filters band songs");
  await setField("label", "Search band songs", "");
  await setField("select", ".band-library-sort", "newest");
  assert.deepEqual(await rows("songs"), ["Back Porch Blues", "Alley Cat", fireAway], "Newest puts the latest share first");
  await app.shot(shots && `${shots}/band-library-songs.png`);
  await fitsPhone("the band's Songs");
  pass("band Songs: who shared it, a lock on Private shares, search and sort");

  await app.click("Add to My Songs", row("songs", "Back Porch Blues"));
  await noticed("Added Back Porch Blues to My Songs");
  const stored = await site.evaluate<{ title: string; copy?: { id: string; canSendOn: boolean } }[]>(
    `JSON.parse(localStorage.getItem("leadSheetsLibrary")).songs.filter((song) => song.title === "Back Porch Blues")`,
  );
  assert.equal(stored.length, 1, "the copy is in My Songs");
  assert.equal(stored[0].copy?.canSendOn, false, "marked as a Private copy");
  await app.click("+ Share a song");
  await app.type("Find a song", "Back Porch");
  assert.match(await app.text(".band-library-pick"), /Back Porch Blues.*Shared with you privately/, "in the share list the Private copy says it can't be shared");
  assert.equal(
    await site.evaluate<boolean>(`[...document.querySelectorAll(".band-library-pick button")].some((b) => b.textContent.includes("Back Porch Blues") && !b.disabled)`),
    false,
    "and can't be picked",
  );
  await app.click("Cancel");
  await app.click("✕");
  await app.until(`[...document.querySelectorAll(".song-list a, .song-list li")].some((el) => el.textContent.includes("Back Porch Blues"))`, "the copy on My Songs");
  pass("Add to My Songs makes a copy that keeps the Private rule");

  await app.openMenu();
  await app.pick("Bands");
  await view("list");
  await app.click("Open");
  await view("band");
  const worship = seed.setlists[0];
  await tab("Setlists");
  await app.click("+ Share a setlist");
  await pickMine(worship.name);
  await app.click("Public");
  await app.click("Share");
  await noticed(`Shared ${worship.name} as Public`);
  assert.deepEqual(await rows("setlists"), [worship.name], "the setlist is on the band's Setlists");
  const afterSet = await library(mike, bandId);
  const bandSet = afterSet.setlists[0];
  assert.deepEqual(
    bandSet.songIds.map((id) => afterSet.songs.find((item) => item.songId === id)!.song.title),
    worship.songIds.map((id) => seed.songs.find((song) => song.id === id)!.title),
    "every song in it was copied into the band, in order",
  );
  pass("Share a setlist copies its songs into the band and asks Private or Public");

  const latest = await mike.call("/api/bands/library/edit-setlist", { bandId, setlistId: bandSet.setlistId, base: 1, name: "Mike's rename", songIds: bandSet.songIds, tags: [] });
  assert.equal(latest.body.error, "not-yours", "Mike can't rename Sam's setlist");
  await tab("Members");
  await app.click("Make admin", "document.querySelectorAll('.bands-members li')[1]");
  await noticed("Mike Keys is now an admin\\.");
  await tab("Setlists");
  await app.click("Edit", row("setlists", worship.name));
  const renamed = await mike.call("/api/bands/library/edit-setlist", { bandId, setlistId: bandSet.setlistId, base: 1, name: "Sunday Worship", songIds: bandSet.songIds.slice(1), tags: ["Church"] });
  assert.equal(renamed.status, 200, "meanwhile Mike, now an admin, edits the same setlist");
  await app.type("Setlist name", " (late)");
  await app.click("Save");
  await app.until(`/changed it first/.test(document.querySelector(".bands-sheet [role=alert]")?.textContent ?? "")`, "the changed-first message");
  assert.deepEqual(await rows("setlists"), ["Sunday Worship"], "Sam's stale edit is not saved, and Sam sees Mike's version");
  assert.equal((await library(mike, bandId)).setlists[0].name, "Sunday Worship", "the server kept Mike's edit");
  await app.click("Edit", row("setlists", "Sunday Worship"));
  await app.click("Move down", `document.querySelector(".band-library-edit li")`);
  await app.click("Save");
  await noticed("Saved Sunday Worship");
  const saved = (await library(mike, bandId)).setlists[0];
  assert.deepEqual([saved.rev, saved.songIds], [3, [renamed.body.songIds[1], renamed.body.songIds[0], ...renamed.body.songIds.slice(2)]], "an edit from the latest rev moves the song");
  await app.click("Church", `document.querySelector(".band-library-chips")`);
  assert.deepEqual(await rows("setlists"), ["Sunday Worship"], "the Church tag chip keeps it");
  await app.click("Mine", `document.querySelector(".band-library-chips")`);
  assert.deepEqual(await rows("setlists"), ["Sunday Worship"], "and so does Mine, since Sam shared it");
  await app.shot(shots && `${shots}/band-library-setlists.png`);
  await fitsPhone("the band's Setlists");
  pass("setlist edits from an old rev are refused and the phone shows the latest");

  await tab("Members");
  assert.deepEqual(await app.texts(".bands-members li > span:first-child"), ["Mike KeysAdmin", "Sam RiveraAdmin"], "Members still lists the band");
  await settle();
  assert.deepEqual(await app.errors(), [], "no page errors");
}

const apiOnly = await startApi({ PASSWORD_PEPPER });
try {
  await apiChecks(apiOnly.base, TEST_ORIGIN);
} finally {
  await apiOnly.worker.dispose();
}

let apiBase = "";
const site = await openSite(root, "check-band-library", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;
try {
  await appChecks(site, base, origin);
} finally {
  await site.close();
  await worker.dispose();
}
console.log("check:band-library passed");
