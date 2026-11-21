import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMessage, Queued } from "../src/chat-model.ts";
import type { BandLibrary, SongContent } from "../src/band-library-model.ts";

/**
 * P4, point at songs in the band thread. One case per pass condition, named by it. `--pure` runs only the cases that
 * need no Worker or Chrome, so they run on any laptop.
 *
 * The contract the cases fix:
 * - `linkify(text, origin)` in `src/chat-model.ts` gives the text back as parts, `{ text }` for words and
 *   `{ text, href, external }` for an http(s) link. Joined, the parts' text is the message unchanged. A bubble draws a
 *   link part as `<a>`; an `external` one has `target="_blank"` and `rel` with `noopener`, an in-app one has no target.
 * - `parseMentions(text, members)` gives the ids of the members named as `@<name>`, once each, the longest name winning.
 * - A band-song card is `kind: "band-song"`, `ref` the band song id, `text` the line "🎵 <title> · <artist>". It is
 *   posted with `POST /api/chat/send` and `card: { kind: "band-song", songId }`, and a queued one waits with `card`.
 *   The thread draws it as `.chat-band-song`: a link to `#/band/<bandId>/song/<songId>` while the song is in the band,
 *   and the words "No longer in this band" with no link when it is not.
 * - The band page's composer has a `+ Song` button that opens `.chat-song-picker`, one button per band song. Typing
 *   `@` opens `.chat-mentions`, one button per other band member, or the words "No band members match". A DM has neither.
 * - Every message carries `mentions`, the ids it names. A line that names the reader has the class `chat-line-mention`.
 */

const pure = process.argv.includes("--pure");
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

const model = (await import("../src/chat-model.ts")) as Record<string, any>;
const ORIGIN = "https://app.test";

await check("pure: a URL in a message renders as a link; javascript: and other schemes stay text", () => {
  const linkify = model.linkify as (text: string, origin: string) => { text: string; href?: string; external?: boolean }[];
  assert.deepEqual(linkify("chart at https://example.com/a?b=1. ok", ORIGIN), [
    { text: "chart at " },
    { text: "https://example.com/a?b=1", href: "https://example.com/a?b=1", external: true },
    { text: ". ok" },
  ], "an https link becomes a link part, and the full stop after it stays words");
  assert.deepEqual(linkify("(see http://example.org/x)", ORIGIN), [{ text: "(see " }, { text: "http://example.org/x", href: "http://example.org/x", external: true }, { text: ")" }], "http too, without the closing bracket");
  for (const words of ["javascript:alert(1)", "data:text/html,<b>hi</b>", "ftp://example.com/file", "mailto:a@b.co", "file:///etc/passwd", "vbscript:msgbox", "https://", "no links here"]) {
    assert.deepEqual(linkify(words, ORIGIN), [{ text: words }], `${js(words)} stays words`);
  }
  const inApp = `${ORIGIN}/#/band/band_x/song/s1`;
  assert.deepEqual(linkify(`open ${inApp}`, ORIGIN), [{ text: "open " }, { text: inApp, href: inApp, external: false }], "a link to this app opens in place");
  assert.deepEqual(linkify("https://app.test.evil.example/#/band/x", ORIGIN).map((part) => part.external), [true], "a look-alike site is another site");
  const mixed = "a https://one.example b javascript:https://two.example c HTTPS://THREE.EXAMPLE/";
  assert.equal(linkify(mixed, ORIGIN).map((part) => part.text).join(""), mixed, "the parts put back together are the message unchanged");
  assert.ok(linkify(mixed, ORIGIN).every((part) => part.href === undefined || /^https?:\/\//.test(part.href)), "every href is http or https");
  assert.deepEqual(linkify("", ORIGIN), [], "an empty message has no parts");
});

await check("pure: parseMentions gives the mentioned member ids, longest name first, once each", () => {
  const parseMentions = model.parseMentions as (text: string, members: { userId: string; name: string }[]) => string[];
  const members = [
    { userId: "u_terry", name: "Terry Bass" },
    { userId: "u_mikekeys", name: "Mike Keys" },
    { userId: "u_mike", name: "Mike" },
  ];
  assert.deepEqual(parseMentions("@Mike Keys bring the capo", members), ["u_mikekeys"], "the longest name that fits wins");
  assert.deepEqual(parseMentions("@mike you too", members), ["u_mike"], "case does not matter");
  assert.deepEqual(parseMentions("hey @Terry Bass and @Mike Keys, @Terry Bass again", members), ["u_terry", "u_mikekeys"], "each member once, in order");
  assert.deepEqual(parseMentions("write me at sam@Terry Bass", members), [], "an @ inside a word is not a mention");
  assert.deepEqual(parseMentions("@Terry Bassist", members), [], "a name must end where the word ends");
  assert.deepEqual(parseMentions("@Nobody here", members), [], "a name not in the band names nobody");
  assert.deepEqual(parseMentions("no mentions", members), [], "words with no @ name nobody");
  assert.deepEqual(parseMentions("@Mike Keys", []), [], "a room with no members to name names nobody");
});

await check("pure: previewText shows a band-song card's line, as for words", () => {
  const previewText = model.previewText as (m: Pick<ChatMessage, "kind" | "text">) => string;
  assert.equal(previewText({ kind: "band-song" as ChatMessage["kind"], text: "🎵 Fire Away · Chris Stapleton" }), "🎵 Fire Away · Chris Stapleton");
  assert.equal(previewText({ kind: "text", text: "Soundcheck at six" }), "Soundcheck at six", "words are unchanged");
});

await check("pure: a queued band-song card keeps its card, per owner", () => {
  const enqueue = model.enqueue as (queue: Queued[], item: Queued) => Queued[];
  const card = { kind: "band-song", songId: "song_1" };
  const item = { msgId: "m12345678", roomId: "band_x", text: "  🎵 Fire Away · Chris Stapleton ", at: 1, from: "u_sam", card } as Queued;
  assert.deepEqual(enqueue([], item), [{ ...item, text: "🎵 Fire Away · Chris Stapleton" }], "the card waits with its line");
});

if (pure) {
  if (failed > 0) {
    console.log(`check:chat-songs --pure: ${failed} failed`);
    process.exit(1);
  }
  console.log("check:chat-songs --pure passed");
  process.exit(0);
}

const { startApi } = await import("./api-session.ts");
const { appPage, PASSWORD_PEPPER, passwordPlayer, settle } = await import("./app-page.ts");
const { openSite } = await import("./chrome.ts");

type Player = Awaited<ReturnType<typeof passwordPlayer>>;
type Reply = { status: number; body: Record<string, any> };

const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: (SongContent & { id: number })[] };
const chart = (title: string, artist: string, lyric: string): SongContent => {
  const { id: _id, ...song } = seed.songs[0];
  return { ...song, title, artist, body: [{ heading: "Verse 1", lines: [{ chords: "G       C", lyrics: lyric }] }] };
};

async function eventually<T>(read: () => Promise<T>, good: (value: T) => boolean, what: string, ms = 8000): Promise<T> {
  let value = await read();
  for (const end = Date.now() + ms; !good(value) && Date.now() < end; value = await read()) await sleep(100);
  assert.ok(good(value), `${what} (last saw ${js(value)})`);
  return value;
}

let apiBase = "";
const site = await openSite(root, "check-chat-songs", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;
try {
  const app = await appPage(site);
  await site.send("Network.enable");
  const offline = (on: boolean) => site.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const appCalls = (path: string, body: object) =>
    site.evaluate<Reply>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const messagesOf = async (who: Player, roomId: string) => {
    const reply = await who.call("/api/chat/open", { roomId });
    assert.equal(reply.status, 200, `${who.name} opens ${roomId} (${js(reply.body)})`);
    return reply.body.messages as ChatMessage[];
  };
  const post = (who: Player, roomId: string, text: string, card?: object) => who.call("/api/chat/send", { roomId, msgId: newId(), text, ...(card ? { card } : {}) });
  const refusal = (reply: Reply) => [reply.status, reply.body.error];

  const inline = `document.querySelector(".band-page .room")`;
  const composer = (scope: string) => `${scope}?.querySelector(".chat-composer textarea")`;
  const setComposer = async (scope: string, text: string) => {
    await site.evaluate(`(() => {
      const box = ${composer(scope)};
      box.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, ${js(text)});
      box.setSelectionRange(box.value.length, box.value.length);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await settle(150);
  };
  const lineWith = (scope: string, words: string) => `[...(${scope}?.querySelectorAll("li.chat-line") ?? [])].find((li) => li.textContent.includes(${js(words)}))`;
  const openBandChat = async (bandId: string) => {
    await site.evaluate(`location.hash = ${js(`#/band/${bandId}?s=chat`)}`);
    await app.until(`!!${composer(inline)} && !${inline}.textContent.includes("Loading")`, "the band page's room", 15000);
  };
  const tapIn = async (scope: string, words: string) => {
    const tapped = await site.evaluate<boolean>(`(() => { const el = [...(${scope}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.includes(${js(words)}) && !b.disabled); el?.click(); return !!el; })()`);
    assert.ok(tapped, `a ${words} button to tap`);
    await settle();
  };
  const picker = `document.querySelector(".band-page .chat-song-picker")`;
  const mentionList = `document.querySelector(".band-page .chat-mentions")`;

  const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
  const ann = await passwordPlayer(base, origin, "Ann Horn", "annhorn");
  const bandId = (await terry.call("/api/bands/create", { name: "The Low Tides" })).body.bandId as string;
  const code = (await terry.call("/api/codes", { kind: "band", bandId })).body.code as string;
  assert.equal((await mike.call("/api/bands/join", { code })).status, 200, "Mike joins The Low Tides");
  const share = async (song: SongContent, localId: number) => {
    const reply = await terry.call("/api/bands/library/share-song", { bandId, song, choice: "public", localId });
    assert.equal(reply.status, 200, `Terry shares ${song.title} (${js(reply.body)})`);
    return reply.body.songId as string;
  };
  const fireAway = await share(chart("Fire Away", "Chris Stapleton", "Fire away, fire away"), 201);
  const chainBreaker = await share(chart("Chain Breaker", "Terry Bass", "Break every chain tonight"), 202);
  const library = (await terry.call("/api/bands/library", { bandId })).body as BandLibrary;
  assert.deepEqual(library.songs.map((item) => item.song.title).sort(), ["Chain Breaker", "Fire Away"], "the band has two songs");

  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await site.evaluate("Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((done) => setTimeout(done, 20000, false))])");
  if (!(await site.evaluate<boolean>("!!navigator.serviceWorker.controller"))) await site.send("Page.reload");
  await app.until("!!navigator.serviceWorker?.controller", "the service worker to take control of the page", 60000);
  await app.library();
  await app.signUp("Sam Rivera");
  const sam = await site.evaluate<{ userId: string; handle: string }>(`fetch("/api/me").then((r) => r.json()).then((reply) => reply.account)`);
  assert.equal((await appCalls("/api/bands/join", { code })).status, 200, "Sam joins The Low Tides");
  assert.equal((await ann.call("/api/friends/request", { handle: sam.handle })).status, 200, "Ann asks Sam to be friends");
  assert.equal((await appCalls("/api/friends/accept", { userId: ann.userId })).status, 200, "Sam accepts Ann, who is not in the band");
  const annDm = (await ann.call("/api/chat/dm", { userId: sam.userId })).body.roomId as string;
  const trio = (await appCalls("/api/bands/create", { name: "Sam's Trio" })).body.bandId as string;

  await check("a URL in a message renders as a link; javascript: and other schemes stay text", async () => {
    const inApp = `${origin}/#/band/${bandId}/song/${fireAway}`;
    const words = `Chart: https://example.com/fire-away. Also javascript:alert(1) and ${inApp}`;
    assert.equal((await post(terry, bandId, "Soundcheck at six")).status, 200, "Terry writes a plain line");
    assert.equal((await post(terry, bandId, words)).status, 200, "Terry writes a line with links");
    await openBandChat(bandId);
    await app.until(`!!${lineWith(inline, "Chart:")}`, "the line with links");
    assert.equal(await site.evaluate<string>(`${lineWith(inline, "Soundcheck")}.querySelector(".chat-bubble").textContent`), "Soundcheck at six", "an old plain line renders unchanged");
    assert.equal(await site.evaluate<number>(`${lineWith(inline, "Soundcheck")}.querySelectorAll("a").length`), 0, "with no links in it");
    assert.equal(await site.evaluate<string>(`${lineWith(inline, "Chart:")}.querySelector(".chat-bubble").textContent`), words, "the words read the same with links in them");
    const anchors = await site.evaluate<{ href: string; text: string; target: string | null; rel: string }[]>(
      `[...${lineWith(inline, "Chart:")}.querySelectorAll("a")].map((a) => ({ href: a.getAttribute("href"), text: a.textContent, target: a.getAttribute("target"), rel: a.getAttribute("rel") ?? "" }))`,
    );
    assert.equal(anchors.length, 2, `two links, and javascript: is not one (${js(anchors)})`);
    assert.deepEqual([anchors[0].href, anchors[0].text, anchors[0].target], ["https://example.com/fire-away", "https://example.com/fire-away", "_blank"], "another site opens in a new tab");
    assert.ok(anchors[0].rel.split(/\s+/).includes("noopener"), `with rel noopener (${anchors[0].rel})`);
    assert.equal(anchors[1].target, null, "a link to this app has no target");
    assert.ok(anchors.every((a) => /^https?:\/\//.test(a.href)), "every href is http or https");
    await site.evaluate("window.__stayed = true");
    await site.evaluate(`[...${lineWith(inline, "Chart:")}.querySelectorAll("a")][1].click()`);
    await app.until(`location.hash === ${js(`#/band/${bandId}/song/${fireAway}`)}`, "the in-app link opening the band song");
    assert.equal(await site.evaluate<boolean>("window.__stayed === true"), true, "in place, with no page load");
    await app.until(`document.body.textContent.includes("Fire away, fire away")`, "the band copy of Fire Away");
  });

  await check("a band-song card posted from + Song opens #/band/<bandId>/song/<songId> for another member", async () => {
    await openBandChat(bandId);
    assert.equal(await site.evaluate<number>(`[...${inline}.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Send").length`), 1, "Send is still the one Send button");
    await app.click("+ Song", inline);
    await app.until(`!!${picker} && ${picker}.textContent.includes("Fire Away") && ${picker}.textContent.includes("Chain Breaker")`, "the band song picker with both songs");
    await tapIn(picker, "Fire Away");
    await app.until(`!${picker}`, "the picker closing");
    const posted = await eventually(() => messagesOf(mike, bandId), (list) => list.some((m) => m.kind === ("band-song" as ChatMessage["kind"])), "the card reaching the band");
    const card = posted.find((m) => m.kind === ("band-song" as ChatMessage["kind"]))!;
    assert.deepEqual([card.fromId, card.ref, card.text], [sam.userId, fireAway, "🎵 Fire Away · Chris Stapleton"], "the card holds the song id and one plain line");
    assert.ok(!js(card).includes("Fire away, fire away"), "and no chart");

    const twice = [await post(terry, bandId, "🎵 Chain Breaker · Terry Bass", { kind: "band-song", songId: chainBreaker }), await post(terry, bandId, "🎵 Chain Breaker · Terry Bass", { kind: "band-song", songId: chainBreaker })];
    assert.deepEqual(twice.map((reply) => reply.status), [200, 200], `Terry posts the same song twice (${js(twice.map((reply) => reply.body))})`);
    assert.notEqual(twice[0].body.message.seq, twice[1].body.message.seq, "and both are stored, since a second card for a song is a new message");
    const again = await post(terry, bandId, "🎵 Chain Breaker · Terry Bass", { kind: "band-song", songId: chainBreaker });
    const resend = await terry.call("/api/chat/send", { roomId: bandId, msgId: again.body.message.msgId, text: "🎵 Chain Breaker · Terry Bass", card: { kind: "band-song", songId: chainBreaker } });
    assert.equal(resend.body.message.seq, again.body.message.seq, "a resend with the same msgId stores nothing new");

    await app.until(`${inline}.querySelectorAll("a.chat-band-song").length >= 2`, "Terry's cards in Sam's thread");
    const href = await site.evaluate<string>(`[...${inline}.querySelectorAll("li.chat-line-theirs a.chat-band-song")].at(-1).getAttribute("href")`);
    assert.equal(href, `#/band/${bandId}/song/${chainBreaker}`, "Terry's card links to the band copy");
    await site.evaluate(`[...${inline}.querySelectorAll("li.chat-line-theirs a.chat-band-song")].at(-1).click()`);
    await app.until(`location.hash === ${js(`#/band/${bandId}/song/${chainBreaker}`)}`, "the card opening the band song");
    await app.until(`document.body.textContent.includes("Break every chain tonight")`, "the band copy of Chain Breaker for Sam");
  });

  await check("a band-song card is refused outside a band, with a bad id, or from someone not in the band", async () => {
    const good = { kind: "band-song", songId: fireAway };
    assert.deepEqual(refusal(await ann.call("/api/chat/send", { roomId: annDm, msgId: newId(), text: "🎵 Fire Away", card: good })), [400, "bad-request"], "not in a DM");
    for (const songId of ["x".repeat(65), "", "../../etc", 42, null]) {
      assert.deepEqual(refusal(await post(terry, bandId, "🎵 Odd", { kind: "band-song", songId })), [400, "bad-request"], `not with the id ${js(songId)}`);
    }
    for (const kind of ["song", "gig", "setlist", "text", undefined]) {
      assert.deepEqual(refusal(await post(terry, bandId, "🎵 Odd", { kind, songId: fireAway })), [400, "bad-request"], `not as a ${js(kind)} card`);
    }
    assert.deepEqual(refusal(await post(ann, bandId, "🎵 Fire Away", good)), [403, "not-a-member"], "not from someone outside the band");
  });

  await check("a band-song card whose ref is not in the band library shows 'No longer in this band', not an error", async () => {
    const gone = "song_" + "z".repeat(20);
    assert.equal((await post(terry, bandId, "🎵 Gone Song · Nobody", { kind: "band-song", songId: gone })).status, 200, "the server takes a well-formed id it does not hold");
    await openBandChat(bandId);
    await app.until(`!!${lineWith(inline, "Gone Song")}?.querySelector(".chat-band-song") && ${lineWith(inline, "Gone Song")}.textContent.includes("No longer in this band")`, "the missing card's words");
    const shown = await site.evaluate<{ tag: string; links: number; buttons: number }>(`(() => {
      const card = ${lineWith(inline, "Gone Song")}.querySelector(".chat-band-song");
      return { tag: card.tagName, links: card.closest("li").querySelectorAll("a").length, buttons: card.closest("li").querySelectorAll("button").length };
    })()`);
    assert.deepEqual([shown.links, shown.buttons], [0, 0], `nothing to tap on it (${js(shown)})`);
    assert.equal(await site.evaluate<boolean>(`!!${inline}.querySelector("[role=alert]")`), false, "and no error shows");
  });

  await check("@name autocompletes band members only; the message stores the mentioned user ids; the mentioned member's thread highlights the line and another member's does not", async () => {
    await openBandChat(bandId);
    await setComposer(inline, "@");
    await app.until(`!!${mentionList}`, "the @ list");
    assert.deepEqual((await app.texts(".band-page .chat-mentions button")).sort(), ["Mike Keys", "Terry Bass"], "the other band members, not Sam and not Ann");
    await setComposer(inline, "@mi");
    assert.deepEqual(await app.texts(".band-page .chat-mentions button"), ["Mike Keys"], "typing narrows the list");
    await setComposer(inline, "@ann");
    await app.until(`${mentionList}?.textContent.includes("No band members match")`, "the empty @ list");
    assert.deepEqual(await app.texts(".band-page .chat-mentions button"), [], "Ann is a friend, not a band member");
    await setComposer(inline, "@mi");
    await tapIn(mentionList, "Mike Keys");
    assert.equal(await site.evaluate<string>(`${composer(inline)}.value`), "@Mike Keys ", "picking a member writes the name");
    await app.until(`!${mentionList}`, "the @ list closing after a pick");
    await setComposer(inline, "@Mike Keys bring the capo");
    await app.click("Send", inline);
    const stored = await eventually(() => messagesOf(terry, bandId), (list) => list.some((m) => m.text === "@Mike Keys bring the capo"), "the mention reaching the band");
    assert.deepEqual((stored.find((m) => m.text === "@Mike Keys bring the capo") as ChatMessage & { mentions: string[] }).mentions, [mike.userId], "the message stores Mike's id");

    assert.equal((await post(terry, bandId, "@Sam Rivera you're on bass tonight")).status, 200, "Terry names Sam");
    const toAnn = await post(terry, bandId, "@Ann Horn is not in this band");
    assert.deepEqual(toAnn.body.message.mentions, [], "naming someone outside the band names nobody");
    const plain = await post(terry, bandId, "Doors at eight");
    assert.deepEqual(plain.body.message.mentions, [], "a line with no @ names nobody");
    await app.until(`!!${lineWith(inline, "you're on bass tonight")}`, "Terry's line naming Sam");
    assert.equal(await site.evaluate<boolean>(`${lineWith(inline, "you're on bass tonight")}.classList.contains("chat-line-mention")`), true, "Sam's thread highlights the line naming Sam");
    assert.equal(await site.evaluate<boolean>(`${lineWith(inline, "bring the capo")}.classList.contains("chat-line-mention")`), false, "and not the line naming Mike");
    assert.equal(await site.evaluate<boolean>(`${lineWith(inline, "Doors at eight")}.classList.contains("chat-line-mention")`), false, "nor a line naming nobody");
    assert.deepEqual((await messagesOf(mike, bandId)).filter((m) => (m as ChatMessage & { mentions: string[] }).mentions.includes(mike.userId)).map((m) => m.text), ["@Mike Keys bring the capo"], "Mike's thread names Mike on one line only");
  });

  await check("a DM has no + Song and no @ list", async () => {
    await site.evaluate(`location.hash = ${js(`#/messages/${annDm}`)}`);
    const dm = `document.querySelector(${js(`.room[data-room="${annDm}"]`)})`;
    await app.until(`!!${composer(dm)}`, "the DM with Ann");
    await setComposer(dm, "@");
    await settle(300);
    assert.equal(await site.evaluate<boolean>(`!!document.querySelector(".chat-mentions")`), false, "no @ list in a DM");
    assert.equal(await site.evaluate<boolean>(`[...${dm}.querySelectorAll("button")].some((b) => b.textContent.trim() === "+ Song")`), false, "no + Song in a DM");
    await setComposer(dm, "");
  });

  await check("+ Song in a band with no songs says so", async () => {
    await openBandChat(trio);
    await app.click("+ Song", inline);
    await app.until(`${picker}?.textContent.includes("No songs in this band yet.")`, "the empty picker");
  });

  await check("a band-song card sent offline waits and goes once on reconnect", async () => {
    await openBandChat(bandId);
    await app.until("!!navigator.serviceWorker?.controller", "the service worker in control before the signal goes");
    const cardsOf = async () => (await messagesOf(terry, bandId)).filter((m) => m.kind === ("band-song" as ChatMessage["kind"]) && m.fromId === sam.userId).length;
    const before = await cardsOf();
    await offline(true);
    try {
      await app.click("+ Song", inline);
      await app.until(`!!${picker}`, "the picker offline");
      await tapIn(picker, "Chain Breaker");
      await app.until(`[...${inline}.querySelectorAll("li.chat-line-mine")].some((li) => li.textContent.includes("Chain Breaker · Terry Bass") && !!li.querySelector(".chat-waiting"))`, "the waiting card");
      const queued = await site.evaluate<Queued[]>(`JSON.parse(localStorage.getItem("leadSheetsChatQueue") ?? "[]")`);
      assert.deepEqual(queued.map((item) => [item.from, item.card]), [[sam.userId, { kind: "band-song", songId: chainBreaker }]], "the card waits on this phone under Sam");
    } finally {
      await offline(false);
    }
    await eventually(cardsOf, (n) => n === before + 1, "the card going when signal returns", 20000);
    await app.until(`${inline}.querySelectorAll(".chat-waiting").length === 0`, "the clock clearing");
    await sleep(1500);
    assert.equal(await cardsOf(), before + 1, "once, with no copy on reconnect");
  });

  await check("a removed member can't post a band-song card", async () => {
    assert.equal((await terry.call("/api/bands/remove", { bandId, userId: mike.userId })).status, 200, "Terry removes Mike");
    assert.deepEqual(refusal(await post(mike, bandId, "🎵 Fire Away · Chris Stapleton", { kind: "band-song", songId: fireAway })), [403, "not-a-member"], "Mike's card is refused");
  });

  await check("the composer, + Song picker and @ list fit at 344, 390, 820, 884 and 1280 px", async () => {
    await openBandChat(bandId);
    for (const width of WIDTHS) {
      await site.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile: width < 800 });
      await settle(300);
      await app.click("+ Song", inline);
      await app.until(`!!${picker}`, `the picker at ${width}`);
      const measure = () =>
        site.evaluate<{ page: number; out: string[]; small: string[] }>(`(() => {
          const out = [], small = [];
          for (const el of document.querySelectorAll(".band-page .chat-composer button, .band-page .chat-composer textarea, .band-page .chat-song-picker, .band-page .chat-song-picker button, .band-page .chat-mentions, .band-page .chat-mentions button")) {
            const box = el.getBoundingClientRect();
            if (box.left < -1 || box.right > innerWidth + 1) out.push(el.className + " " + Math.round(box.left) + ".." + Math.round(box.right));
            if (el.matches("button, textarea") && box.height < 44) small.push(el.textContent.trim() + " " + Math.round(box.height));
          }
          return { page: document.documentElement.scrollWidth, out, small };
        })()`);
      const withPicker = await measure();
      assert.ok(withPicker.page <= width, `nothing scrolls sideways at ${width} (${withPicker.page})`);
      assert.deepEqual(withPicker.out, [], `the composer and picker sit on screen at ${width}`);
      assert.deepEqual(withPicker.small, [], `and every control is big enough to tap at ${width}`);
      await site.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      await app.until(`!${picker}`, `Escape closing the picker at ${width}`);
      await setComposer(inline, "@");
      await app.until(`!!${mentionList}`, `the @ list at ${width}`);
      const withList = await measure();
      assert.ok(withList.page <= width && withList.out.length === 0, `the @ list sits on screen at ${width} (${js(withList)})`);
      await setComposer(inline, "");
    }
    await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  });

  await check("no page errors", async () => assert.deepEqual(await app.errors(), [], "the page logged no errors"));
} finally {
  await site.close();
  await worker.dispose();
}

if (failed > 0) {
  console.log(`check:chat-songs: ${failed} failed`);
  process.exit(1);
}
console.log("check:chat-songs passed");
