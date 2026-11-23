import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { SongContent } from "../src/band-library-model.ts";
import { passwordKey } from "../src/password.ts";
import { Phone, startApi, TEST_ORIGIN } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, readQr, settle } from "./app-page.ts";
import { openSite, type Site } from "./chrome.ts";

/**
 * C21c: a guest pass lets a fill-in player who isn't in the band open tonight's setlist and follow the gig for as long
 * as the admin chose (PLAN.md 7.14). One case per pass condition, named by it. The Worker cases use phones made straight
 * against the API; the sign-up, dismiss, admin screen and offline expiry cases drive the built app in headless Chrome
 * (`CHROME` names the browser). Paths come from fileURLToPath and path.join so the script runs on Windows and Linux.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const js = JSON.stringify;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_ON_LINEUP_CLOSE = 4404;
const ENDED_BY_BAND = "This pass was ended by the band";
const PASS_ENDED = "This pass has ended";

const seed = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: (SongContent & { id: number })[] };
const chart = (index: number, title: string): SongContent => {
  const { id: _id, ...song } = seed.songs[index];
  return { ...song, title, body: [{ heading: "Tag", lines: [{ chords: "G", lyrics: `${title} tag line` }] }, ...song.body] };
};

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

type Reply = { status: number; body: any };
const ok = (reply: Reply, what: string) => {
  assert.equal(reply.status, 200, `${what} (${js(reply.body)})`);
  return reply.body;
};
const refusal = (reply: Reply) => [reply.status, reply.body?.error];
const newPassId = () => `pass_${randomBytes(16).toString("base64url")}`;
const newMsgId = () => randomBytes(9).toString("base64url");
const today = () => new Date().toLocaleDateString("en-CA");

type PassEnds = (choice: { length: "tonight" } | { length: "week" } | { length: "date"; date: string }, gigDate: string, now: number) => number;

/** One export of the phone's code, bundled the way the phone gets it. */
async function loadPhone<T>(contents: string): Promise<T> {
  const bundled = await build({
    stdin: { contents, resolveDir: root, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  const file = join(mkdtempSync(join(tmpdir(), "check-guest-")), "phone.mjs");
  writeFileSync(file, bundled.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const phone = {
  ...(await loadPhone<{ startGig: typeof import("../src/gig-state.ts").startGig }>(`export { startGig } from "./src/gig-state.ts";`)),
  passEnds: await loadPhone<{ passEnds: PassEnds }>(`export { passEnds } from "./src/guest-pass.tsx";`).then(
    (found) => found.passEnds,
    (): PassEnds => () => {
      throw new Error("src/guest-pass.tsx exports passEnds(choice, gigDate, now)");
    },
  ),
};

type Message = { kind: string; [key: string]: any };
type Socket = { ws: WebSocket; messages: Message[]; opened: boolean; closed: Promise<number> };

/** A phone's socket to the band room, keeping every message it hears. */
function openSocket(phone: Phone, room: string, origin: string): Promise<Socket> {
  const ws = new WebSocket(phone.socketUrl(room), { headers: { origin, cookie: phone.cookie } } as unknown as string[]);
  const messages: Message[] = [];
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
  ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ws, messages, opened: false, closed }), 5000);
    ws.addEventListener("message", () => (clearTimeout(timer), resolve({ ws, messages, opened: true, closed })), { once: true });
    ws.addEventListener("close", () => (clearTimeout(timer), resolve({ ws, messages, opened: false, closed })), { once: true });
  });
}

async function heard(socket: Socket, match: (message: Message) => boolean, what: string, ms = 5000): Promise<Message> {
  for (const end = Date.now() + ms; Date.now() < end; await settle(50)) {
    const found = socket.messages.find(match);
    if (found) return found;
  }
  throw new Error(`timed out waiting for ${what} (heard ${js(socket.messages.map((m) => m.kind))})`);
}

/** The close code the server sent. The local dev proxy holds TCP open after a server close, so the client finishes it. */
async function serverClose(socket: Socket, label: string) {
  for (const end = Date.now() + 5000; socket.ws.readyState === WebSocket.OPEN; await settle(50)) {
    if (Date.now() > end) throw new Error(`timed out waiting for the server to close ${label}`);
  }
  socket.ws.close();
  return socket.closed;
}

const joinGig = async (socket: Socket, gigId: string) => {
  socket.ws.send(js({ kind: "join-gig", gigId }));
  return heard(socket, (m) => m.kind === "gig" && m.gigId === gigId, "the room's gig reply");
};

let apiBase = "";
const site: Site | null = await openSite(root, "check-guest", () => apiBase).catch((error: Error) => {
  console.log(`FAIL the browser checks could start: ${error.message.split("\n")[0]}`);
  failed += 1;
  return null;
});
const origin = site ? site.origin.replace("127.0.0.1", "localhost") : TEST_ORIGIN;
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: site ? "localhost" : "app.test", PASSWORD_PEPPER });
apiBase = base;
const sockets: Socket[] = [];
const socket = async (who: Phone, room: string) => {
  const made = await openSocket(who, room, origin);
  sockets.push(made);
  return made;
};

try {
  const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
  const dana = await passwordPlayer(base, origin, "Dana Drums", "danadrums");
  const sam = await passwordPlayer(base, origin, "Sam Rivera", "samrivera");
  const alex = await passwordPlayer(base, origin, "Alex Stone", "alexstone");
  const gus = await passwordPlayer(base, origin, "Gus Horn", "gushorn");
  const quinn = await passwordPlayer(base, origin, "Quinn Lake", "quinnlake");

  const bandId = ok(await terry.call("/api/bands/create", { name: "The Blue Notes" }), "Terry makes The Blue Notes").bandId as string;
  const invite = ok(await terry.call("/api/codes", { kind: "band", bandId }), "a band invite").code as string;
  for (const member of [mike, dana]) ok(await member.call("/api/bands/join", { code: invite }), `${member.name} joins`);
  const share = async (title: string, index: number) =>
    ok(await terry.call("/api/bands/library/share-song", { bandId, song: chart(index, title), choice: "public", localId: null }), `Terry shares ${title}`).songId as string;
  const opener = await share("Elks Opener", 0);
  const closer = await share("Elks Closer", 1);
  const brunch = await share("Brunch Tune", 2);
  const setlist = async (name: string, songIds: string[]) =>
    ok(await terry.call("/api/bands/library/share-setlist", { bandId, name, songIds, tags: [], choice: "public", localId: null }), `Terry shares ${name}`).setlistId as string;
  const fridaySet = await setlist("Friday set", [opener, closer]);
  const otherSet = await setlist("Other set", [brunch]);
  const lineup = [terry.userId, mike.userId, dana.userId];
  const plan = async (name: string, setlistId: string) =>
    ok(await terry.call("/api/bands/gig/plan", { bandId, setlistId, name, date: today(), lineup, leader: terry.userId }), `Terry plans ${name}`).gig.gigId as string;
  const gigId = await plan("Friday at the Elks", fridaySet);
  const brunchGig = await plan("Sunday brunch", otherSet);

  type PassFields = { name?: string; expiresAt?: number; canSeeChat?: boolean; canSeeSetlists?: boolean; passId?: string; gig?: string };
  const makePass = (who: Phone, fields: PassFields = {}) =>
    who.call("/api/bands/guests/create", {
      bandId,
      gigId: fields.gig ?? gigId,
      passId: fields.passId ?? newPassId(),
      name: fields.name ?? "",
      expiresAt: fields.expiresAt ?? Date.now() + DAY_MS,
      canSeeChat: fields.canSeeChat ?? false,
      canSeeSetlists: fields.canSeeSetlists ?? false,
    });
  const passesOf = async (gig = gigId) => ok(await terry.call("/api/bands/guests/list", { bandId, gigId: gig }), "Terry lists the guest passes").passes as any[];
  const land = async (code: string) => {
    const response = await fetch(new URL(`/c/${code}`, base), { redirect: "manual" });
    return { status: response.status, location: response.headers.get("location"), text: await response.text() };
  };

  // Sam's pass, made in the first case, is the one most cases below use; it is revoked last among the Worker cases.
  let samCode = "";
  let samPassId = "";

  await check("passEnds: tonight is 6 AM the morning after the gig, one week is seven days but never before that, a date is 6 AM the morning after it", async () => {
    const now = new Date(2026, 10, 20, 14, 30).getTime();
    const tonight = new Date(2026, 10, 28, 6, 0).getTime();
    assert.equal(phone.passEnds({ length: "tonight" }, "2026-11-27", now), tonight, "Tonight only ends 6 AM after the gig's day");
    assert.equal(phone.passEnds({ length: "week" }, "2026-11-27", now), tonight, "One week made a week before the gig still lasts through gig night");
    assert.equal(phone.passEnds({ length: "week" }, "2026-11-21", now), now + 7 * DAY_MS, "One week is seven days from now");
    assert.equal(phone.passEnds({ length: "date", date: "2026-12-01" }, "2026-11-27", now), new Date(2026, 11, 2, 6, 0).getTime(), "a picked date ends 6 AM the morning after it");
  });

  await check("only the admin makes a guest pass and picks tonight, one week or a date", async () => {
    assert.deepEqual(refusal(await makePass(mike)), [403, "not-admin"], "a member can't make a guest pass");
    assert.deepEqual(refusal(await mike.call("/api/bands/guests/list", { bandId, gigId })), [403, "not-admin"], "or list them");
    assert.equal((await makePass(terry, { expiresAt: Date.now() - 1000 })).status, 400, "a pass that already ended is refused");
    assert.equal((await makePass(terry, { expiresAt: Date.now() + 400 * DAY_MS })).status, 400, "a pass longer than a year is refused");
    assert.equal((await new Phone(base).call("/api/bands/guests/create", { bandId, gigId }, { origin })).status, 401, "a signed-out phone makes no pass");

    const expiresAt = Date.now() + 3 * DAY_MS;
    samPassId = newPassId();
    const made = ok(await makePass(terry, { name: "Sam on sax", expiresAt, passId: samPassId }), "Terry makes a pass");
    assert.equal(made.pass.expiresAt, expiresAt, "the pass keeps the end the admin picked (guest_passes.expires_at)");
    assert.equal(made.expiresAt, expiresAt, "and its code ends with it");
    assert.equal(made.code.split(".")[0], "guest", "the code is a guest code");
    assert.equal(made.link, `${origin}/c/${made.code}`, "with a normal /c/ link");
    assert.ok(!made.link.includes("Sam") && !made.link.includes(bandId) && !made.link.includes(gigId), "the link names no band, gig or person");
    assert.deepEqual([made.pass.canSeeChat, made.pass.canSeeSetlists, made.pass.claimedBy, made.pass.revoked], [false, false, null, false], "both switches start off and nobody holds it yet");
    samCode = made.code;
    const again = ok(await makePass(terry, { name: "Sam on sax", expiresAt, passId: samPassId }), "the same pass sent again");
    assert.equal(again.code, made.code, "a retry with the same pass id hands back the same code, not a second pass");
    const listed = await passesOf();
    assert.equal(listed.filter((pass) => pass.passId === samPassId).length, 1, "the pass is listed once");
    assert.equal(listed.find((pass) => pass.passId === samPassId).name, "Sam on sax", "with its name");
    assert.equal((await land(made.code)).location, `${origin}/?open=gig&code=${made.code}`, "a pass link lands on the gig screen");
  });

  await check("the pass binds to the first account that opens it and a second account with the same code is refused", async () => {
    assert.equal((await new Phone(base).call("/api/guest/claim", { code: samCode }, { origin })).status, 401, "nobody joins as a guest signed out: there is no name-only path");
    const opened = ok(await sam.call("/api/guest/open", { code: samCode }), "Sam opens the pass");
    assert.equal(opened.gigName, "Friday at the Elks", "the pass names its gig");
    const claimed = ok(await sam.call("/api/guest/claim", { code: samCode }), "Sam joins as a guest");
    assert.deepEqual([claimed.bandId, claimed.gigId], [bandId, gigId], "the claim leads to the gig");
    assert.deepEqual(refusal(await alex.call("/api/guest/claim", { code: samCode })), [403, "pass-claimed"], "a second account with the same code is refused");
    assert.deepEqual(refusal(await alex.call("/api/guest/open", { code: samCode })), [403, "pass-claimed"], "and can't even read it");
    assert.ok(!JSON.stringify((await alex.call("/api/guest/open", { code: samCode })).body).includes("Elks"), "the refusal names no gig");
    ok(await sam.call("/api/guest/claim", { code: samCode }), "Sam opening it again still works");
    const held = (await passesOf()).find((pass) => pass.passId === samPassId);
    assert.deepEqual([held.claimedBy, held.claimedName], [sam.userId, "Sam Rivera"], "the admin sees who holds the pass (claimed_by)");

    const raced = ok(await makePass(terry, { name: "Raced" }), "a fresh pass").code as string;
    const [first, second] = await Promise.all([alex.call("/api/guest/claim", { code: raced }), gus.call("/api/guest/claim", { code: raced })]);
    assert.deepEqual([first.status, second.status].sort(), [200, 403], `two accounts opening one code at once: exactly one holds it (${js([first.body, second.body])})`);
    const winner = first.status === 200 ? alex : gus;
    assert.equal((await passesOf()).find((pass) => pass.name === "Raced").claimedBy, winner.userId, "and the server agrees which");
  });

  await check("a forwarded pass link opened on a second phone of the same account works", async () => {
    const pat = await passwordPlayer(base, origin, "Pat Fill", "patfill");
    const patCode = ok(await makePass(terry, { name: "Pat" }), "a pass for Pat").code as string;
    ok(await pat.call("/api/guest/claim", { code: patCode }), "Pat's phone joins as a guest");
    const second = new Phone(base);
    const secondCall = second.call.bind(second);
    second.call = (path, body, headers = {}) => secondCall(path, body, { origin, ...headers });
    const { salt } = ok(await second.call("/api/auth/password/salt", { handle: "patfill" }, { origin }), "Pat's second phone asks for the salt");
    ok(await second.call("/api/auth/password/sign-in", { handle: "patfill", key: await passwordKey("violet tram 42 lantern", salt) }, { origin }), "Pat signs in on a second phone");
    assert.notEqual(second.cookie, pat.cookie, "with a session of its own");
    ok(await second.call("/api/guest/claim", { code: patCode }), "the forwarded link opens on the second phone");
    for (const [label, who] of [["first", pat], ["second", second]] as const) {
      const pack = ok(await who.call("/api/bands/gig/pack", { bandId, gigId }), `Pat's ${label} phone downloads the pack`);
      assert.equal(pack.songs.length, 2, `the ${label} phone has tonight's charts`);
      const room = await socket(who, bandId);
      assert.ok(room.opened, `Pat's ${label} phone gets into the band room`);
      await joinGig(room, gigId);
    }
    const drops = await socket(second, bandId);
    drops.ws.close();
    await drops.closed;
    const back = await socket(second, bandId);
    assert.ok(back.opened && (await heard(back, (m) => m.kind === "hello", "hello")).lineups.includes(gigId), "a phone that drops out and comes back is still let into the gig");
    ok(await second.call("/api/guest/claim", { code: patCode }), "and rescanning the pass still works");
  });

  const samRoom = await socket(sam, bandId);
  const terryRoom = await socket(terry, bandId);
  const mikeRoom = await socket(mike, bandId);

  await check("the guest sees tonight's setlist and charts and follows the mirror", async () => {
    const view = ok(await sam.call("/api/bands/gig/open", { bandId, gigId }), "Sam opens tonight's gig");
    assert.equal(view.gig.name, "Friday at the Elks", "the guest sees the gig");
    assert.deepEqual(view.songIds, [opener, closer], "and tonight's set");
    const pack = ok(await sam.call("/api/bands/gig/pack", { bandId, gigId }), "Sam downloads the pack");
    assert.deepEqual(pack.songs.map((song: { song: SongContent }) => song.song.title), ["Elks Opener", "Elks Closer"], "the pack has tonight's charts");
    const pass = (await passesOf()).find((p) => p.passId === samPassId);
    assert.equal(pack.expiresAt, pass.expiresAt, "the guest's pack carries the pass's end time");
    assert.equal(typeof pack.secret, "string", "and the gig secret, so the guest can join by QR");
    ok(await mike.call("/api/bands/gig/pack", { bandId, gigId }), "Mike downloads too");
    assert.equal((await mike.call("/api/bands/gig/pack", { bandId, gigId })).body.expiresAt, null, "a member's pack has no end time");

    assert.ok(samRoom.opened, "the guest gets into the band room");
    assert.ok((await heard(samRoom, (m) => m.kind === "hello", "hello")).lineups.includes(gigId), "and is told about tonight's gig");
    assert.ok(!(await heard(samRoom, (m) => m.kind === "hello", "hello")).lineups.includes(brunchGig), "but not about the band's other gigs");
    await joinGig(samRoom, gigId);
    await joinGig(terryRoom, gigId);
    await joinGig(mikeRoom, gigId);
    const state = phone.startGig({ gigId, order: [opener, closer], leader: terry.userId, admin: terry.userId, backup: null, lineup, route: "auto", scrollAlong: false, now: Date.now() });
    terryRoom.ws.send(js({ kind: "gig-start", state, at: Date.now() }));
    const copy = await heard(samRoom, (m) => m.kind === "gig-state" && m.state?.gigId === gigId, "the leader's state on the guest's phone");
    assert.equal(copy.state.leader, terry.userId, "the guest follows Terry");
    const live = ok(await sam.call("/api/bands/gig/live", {}), "the guest's live gigs").gigs as { gigId: string; status: string }[];
    assert.ok(live.some((gig) => gig.gigId === gigId && gig.status === "live"), `the guest's phone offers Join gig once it is live (${js(live)})`);
  });

  const gusCode = (await makePass(terry, { name: "Gus", canSeeChat: true, canSeeSetlists: true })).body.code;
  await gus.call("/api/guest/claim", { code: gusCode });
  const gusRoom = await socket(gus, bandId);

  await check("the guest sees no chat, other setlists or members unless the admin switched them on", async () => {
    assert.deepEqual(refusal(await sam.call("/api/bands/open", { bandId })), [403, "guest"], "the guest gets no members list");
    assert.deepEqual(refusal(await sam.call("/api/chat/open", { roomId: bandId })), [403, "guest"], "no band chat with the switch off");
    assert.deepEqual(refusal(await sam.call("/api/chat/send", { roomId: bandId, msgId: newMsgId(), text: "hi all" })), [403, "guest"], "and can't post in it");
    assert.deepEqual(refusal(await sam.call("/api/bands/library", { bandId })), [403, "guest"], "no other setlists with the switch off");
    assert.deepEqual(refusal(await sam.call("/api/bands/gig/open", { bandId, gigId: brunchGig })), [403, "guest"], "no other gig");
    assert.deepEqual(refusal(await sam.call("/api/bands/gig/pack", { bandId, gigId: brunchGig })), [403, "guest"], "and no other gig's charts");

    const view = ok(await sam.call("/api/bands/gig/open", { bandId, gigId }), "Sam's gig view");
    assert.deepEqual(view.names, { [terry.userId]: "Terry", [mike.userId]: "Mike", [dana.userId]: "Dana" }, "the lineup shows first names only");
    for (const word of ["Bass", "Keys", "Drums", "admin"]) assert.ok(!JSON.stringify(view).includes(word), `the guest's gig view holds no full name or role (${word})`);

    const text = `Soundcheck at 7 ${newMsgId()}`;
    ok(await mike.call("/api/chat/send", { roomId: bandId, msgId: newMsgId(), text }), "Mike posts in the band chat");
    await heard(gusRoom, (m) => m.kind === "message" && m.message?.text === text, "the post on the chat-on guest's socket");
    await heard(mikeRoom, (m) => m.kind === "message" && m.message?.text === text, "the post on Mike's socket");
    assert.ok(!samRoom.messages.some((m) => m.kind === "message"), "a chat post never reaches a chat-off guest's socket");

    const chat = ok(await gus.call("/api/chat/open", { roomId: bandId }), "Gus reads the chat with the switch on").messages as { text: string }[];
    assert.ok(chat.some((m) => m.text === text), "and sees Mike's post");
    const library = ok(await gus.call("/api/bands/library", { bandId }), "Gus reads the band's setlists with the switch on");
    assert.ok(library.setlists.some((s: { name: string }) => s.name === "Other set"), "and sees the other setlists");
    assert.deepEqual(refusal(await gus.call("/api/bands/open", { bandId })), [403, "guest"], "the members list stays closed even with both switches on");
  });

  await check("a guest can't lead, be backup, add band songs to My Songs or send them on", async () => {
    assert.deepEqual(refusal(await terry.call("/api/bands/gig/backup", { bandId, gigId, backup: sam.userId })), [400, "not-on-lineup"], "the admin can't name a guest as backup");
    assert.equal(ok(await terry.call("/api/bands/gig/open", { bandId, gigId }), "the gig").gig.backup, null, "so the gig keeps no backup");
    assert.deepEqual(refusal(await sam.call("/api/bands/gig/backup", { bandId, gigId, backup: sam.userId })), [403, "guest"], "the guest can't name themselves backup");
    assert.deepEqual(refusal(await sam.call("/api/bands/gig/lineup", { bandId, gigId, lineup: [...lineup, sam.userId] })), [403, "guest"], "or change the lineup");
    assert.deepEqual(refusal(await sam.call("/api/bands/gig/end", { bandId, gigId })), [403, "guest"], "or end the gig");

    const takeover = { ...phone.startGig({ gigId, order: [opener, closer], leader: sam.userId, admin: terry.userId, backup: null, lineup, route: "auto", scrollAlong: false, now: Date.now() }), epoch: 5, claim: "other" };
    samRoom.ws.send(js({ kind: "gig-start", state: takeover, at: Date.now() }));
    const refused = await heard(samRoom, (m) => m.kind === "gig-refused", "the room's answer to the guest leading");
    assert.equal(refused.refused, "not-allowed", "the room refuses a guest who tries to lead");
    terryRoom.ws.send(js({ kind: "gig-state", gigId }));
    const held = await heard(terryRoom, (m) => m.kind === "gig-state", "the room's copy");
    assert.equal(held.state.leader, terry.userId, "Terry still leads");

    assert.equal((await sam.call("/api/bands/library/copy-song", { bandId, songId: opener })).status, 403, "the guest can't add a band song to My Songs");
    const trio = ok(await sam.call("/api/bands/create", { name: "Sam's Trio" }), "Sam has a band of their own").bandId as string;
    const pack = ok(await sam.call("/api/bands/gig/pack", { bandId, gigId }), "Sam's pack");
    const tonight = pack.songs[0].song as SongContent;
    assert.deepEqual(refusal(await sam.call("/api/bands/library/share-song", { bandId: trio, song: tonight, choice: "public", localId: null })), [403, "guest"], "the guest can't send tonight's chart into another band");
    assert.deepEqual(
      refusal(await sam.call("/api/codes", { kind: "my-setlist", choice: "public", name: "Took it", songs: [{ song: tonight, copyId: null }], setlistCopyId: null })),
      [403, "guest"],
      "or pass it on to a friend in a setlist copy",
    );
    ok(await sam.call("/api/bands/library/share-song", { bandId: trio, song: chart(5, "Sam's Own Tune"), choice: "public", localId: null }), "a chart of Sam's own still shares");
  });

  await check("a guest's socket leaves the gig when the pass ends, and the leader's next move never reaches it", async () => {
    const kit = await passwordPlayer(base, origin, "Kit Moss", "kitmoss");
    const kitEnds = Date.now() + 3000;
    ok(await kit.call("/api/guest/claim", { code: ok(await makePass(terry, { name: "Kit", expiresAt: kitEnds }), "a short pass for Kit").code }), "Kit joins as a guest");
    const kitRoom = await socket(kit, bandId);
    await joinGig(kitRoom, gigId);
    const asked = terryRoom.messages.length;
    terryRoom.ws.send(js({ kind: "gig-state", gigId }));
    let held = (await heard(terryRoom, (m) => m.kind === "gig-state" && terryRoom.messages.indexOf(m) >= asked, "the room's copy for Terry")).state;
    const move = (opId: string) => {
      held = { ...held, rev: held.rev + 1 };
      terryRoom.ws.send(js({ kind: "gig-op", op: { kind: "goTo", key: closer, opId, epoch: held.epoch }, state: held, at: Date.now() }));
      return held.rev;
    };
    const before = move(newMsgId());
    await heard(kitRoom, (m) => m.kind === "gig-state" && m.state?.rev === before, "the leader's move while Kit's pass lasts");
    for (; Date.now() < kitEnds + 300; ) await settle(100);
    const after = move(newMsgId());
    await heard(mikeRoom, (m) => m.kind === "gig-state" && m.state?.rev === after, "the leader's move on Mike's socket");
    assert.equal(await serverClose(kitRoom, "Kit's socket"), NOT_ON_LINEUP_CLOSE, "the ended guest's socket is closed with 4404 at the next move");
    assert.ok(!kitRoom.messages.some((m) => m.kind === "gig-state" && m.state?.rev === after), "and the move after the end never reached it");
  });

  await check("Revoke closes the guest's link mid-gig and replaces the gig secret", async () => {
    const before = ok(await mike.call("/api/bands/gig/pack", { bandId, gigId }), "Mike's pack before");
    assert.deepEqual(refusal(await mike.call("/api/bands/guests/revoke", { bandId, passId: samPassId })), [403, "not-admin"], "a member can't revoke a pass");
    assert.equal(samRoom.ws.readyState, WebSocket.OPEN, "so the guest is still in");
    const mikeHeard = mikeRoom.messages.length;
    const revoked = ok(await terry.call("/api/bands/guests/revoke", { bandId, passId: samPassId }), "Terry revokes Sam's pass");
    assert.equal(revoked.pass.revoked, true, "the pass reads revoked");
    assert.equal(await serverClose(samRoom, "the guest's socket"), NOT_ON_LINEUP_CLOSE, "the guest's open socket closes with 4404 at once");
    assert.equal(mikeRoom.ws.readyState, WebSocket.OPEN, "Mike's socket stays open");
    await heard(mikeRoom, (m) => m.kind === "on-lineup" && m.gigId === gigId && mikeRoom.messages.indexOf(m) >= mikeHeard, "the lineup phones told to fetch again");
    const after = ok(await mike.call("/api/bands/gig/pack", { bandId, gigId }), "Mike's pack after");
    assert.notEqual(after.secret, before.secret, "the gig secret is replaced (secret_rev went up)");
    assert.ok(after.packRev > before.packRev, "and the old pack reads stale, so lineup phones fetch it again");
    assert.deepEqual(refusal(await sam.call("/api/bands/gig/open", { bandId, gigId })), [410, "pass-revoked"], "the guest's calls are refused");
    assert.deepEqual(refusal(await sam.call("/api/bands/gig/pack", { bandId, gigId })), [410, "pass-revoked"], "and so is the pack");
    const back = await socket(sam, bandId);
    assert.ok(!back.opened || !(await heard(back, (m) => m.kind === "hello", "hello")).lineups.includes(gigId), "a new socket isn't let into the gig");
    const page = await land(samCode);
    assert.equal(page.status, 410, "the pass link is refused");
    assert.ok(page.text.includes(ENDED_BY_BAND), `and says the band ended it (${page.text})`);
    assert.ok(!page.text.includes("Elks") && !page.text.includes("Blue Notes"), "with no gig or band in the refusal");
  });

  if (site) {
    const app = await appPage(site);
    // Network.setBlockedURLs does nothing until the Network domain is on.
    await site.send("Network.enable");
    await site.send("Page.addScriptToEvaluateOnNewDocument", {
      // __shown records whether a chart title of tonight's set was ever on screen, from the very first frame.
      source: `window.__shown = []; new MutationObserver(() => { const text = document.body?.textContent ?? ""; for (const title of ["Elks Opener", "Elks Closer"]) if (text.includes(title) && !__shown.includes(title)) __shown.push(title); }).observe(document, { childList: true, subtree: true, characterData: true });`,
    });
    const waitFor = async (expression: string, what: string, ms = 15000) => {
      for (const end = Date.now() + ms; Date.now() < end; await settle(100)) if (await site.evaluate<boolean>(expression).catch(() => false)) return;
      throw new Error(`timed out waiting for ${what} at ${await site.evaluate<string>("location.href").catch(() => "?")}`);
    };
    const signInSheet = `document.querySelector(".account-sheet[data-step]")`;
    const atStep = (step: string) => waitFor(`${signInSheet}?.dataset.step === ${js(step)}`, `the ${step} screen`);
    const bodyText = () => site.evaluate<string>(`document.body.textContent`);
    /** Opens `url` with the server unreachable, and proves it: a call to the API gets no answer at all. */
    const openWithNoSignal = async (url: string) => {
      await site.send("Network.setBlockedURLs", { urls: ["*/api/*", "*/c/*"] });
      await site.send("Page.navigate", { url });
      const probe = await site.evaluate<string>(`fetch("/api/auth/config").then((r) => "answered " + r.status, () => "no network")`);
      assert.equal(probe, "no network", "the server really is unreachable");
    };
    const fresh = async () => {
      await site.send("Network.setBlockedURLs", { urls: [] });
      await site.send("WebAuthn.disable");
      await site.send("WebAuthn.enable");
      await site.send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
      });
      await site.send("Page.navigate", { url: "about:blank" });
      await site.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
      await site.send("Network.clearBrowserCookies");
      await site.send("Page.navigate", { url: `${origin}/#/songs` });
      await app.library();
    };
    let loads = 0;
    /** This browser becomes `who`'s phone: their session cookie, and the mark the app keeps of who signed in here. */
    const signedInAs = async (who: Phone & { userId: string }) => {
      await fresh();
      const [name, value] = who.cookie.split("=");
      await site.send("Network.setCookie", { name, value, url: origin, path: "/", secure: true, httpOnly: true });
      await site.evaluate(`localStorage.setItem("leadSheetsSignedIn", ${js(who.userId)})`);
      await site.send("Page.navigate", { url: `${origin}/?as=${(loads += 1)}#/songs` });
      await app.library();
    };
    const packsOnPhone = () =>
      site.evaluate<{ gig: { gigId: string }; expiresAt: number | null }[]>(`(async () => {
        if (!(await indexedDB.databases()).some((db) => db.name === "mls-phone")) return [];
        const db = await new Promise((done, fail) => { const r = indexedDB.open("mls-phone"); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
        try {
          if (!db.objectStoreNames.contains("gigPacks")) return [];
          return await new Promise((done, fail) => { const r = db.transaction("gigPacks").objectStore("gigPacks").getAll(); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
        } finally { db.close(); }
      })()`);
    const tap = async (start: string, scope = "document") => {
      const tapped = await site.evaluate<boolean>(`(() => { const el = [...(${scope}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim().startsWith(${js(start)}) && !b.disabled); el?.click(); return !!el; })()`);
      assert.ok(tapped, `a button starting ${js(start)} to tap`);
      await settle();
    };
    const hasButton = (start: string, scope = "document") =>
      site.evaluate<boolean>(`[...(${scope}?.querySelectorAll("button") ?? [])].some((b) => b.textContent.trim().startsWith(${js(start)}))`);

    await check("opening a pass with no account leads to sign-up then the gig card, and there is no name-only path", async () => {
      const code = ok(await makePass(terry, { name: "Robin" }), "a pass for a new player").code as string;
      await fresh();
      await site.send("Page.navigate", { url: `${origin}/c/${code}` });
      await waitFor(`location.search.includes("open=gig") || !!${signInSheet}`, "the landing");
      await atStep("start");
      assert.match(await site.evaluate<string>(`${signInSheet}.textContent`), /as a guest/, "the sign-in sheet says it is for joining as a guest");
      const fields = await site.evaluate<string[]>(`[...document.querySelectorAll(".guest-pass input, .guest-pass-sheet input")].map((el) => el.outerHTML)`);
      assert.deepEqual(fields, [], "nothing offers to join with a name and no account");
      await app.click("New here? Create an account", signInSheet);
      await app.type("Your name (what bandmates see)", "Robin Reed");
      await app.click("Sign in with Face ID or fingerprint", signInSheet);
      await waitFor(`["nudge", "account"].includes(${signInSheet}?.dataset.step) || !${signInSheet}`, "the end of Create account");
      if ((await site.evaluate<string>(`${signInSheet}?.dataset.step ?? ""`)) === "nudge") await app.click("Not now", signInSheet);
      await waitFor(`document.body.textContent.includes("Join Friday at the Elks as a guest")`, "Join Friday at the Elks as a guest");
      await tap("Join as a guest");
      await waitFor(`location.hash === ${js(`#/gig/${bandId}/${gigId}`)} && !!document.querySelector(${js(`.gig-view[data-gig="${gigId}"]`)})`, "the gig card");
      await waitFor(`document.querySelector(".gig-view h2")?.textContent === "Friday at the Elks"`, "the gig's name on the card");
      assert.equal((await passesOf()).find((pass) => pass.name === "Robin").claimedName, "Robin Reed", "the pass is bound to the new account");
    });

    await check("a signed-out visitor who opens a pass link can close the sheet and keep using the app", async () => {
      const code = ok(await makePass(terry, { name: "Visitor" }), "a pass").code as string;
      await fresh();
      await site.send("Page.navigate", { url: `${origin}/c/${code}` });
      await atStep("start");
      await app.click("✕", signInSheet);
      await waitFor(`!${signInSheet} && !document.querySelector(".guest-pass-sheet")`, "every sheet closed");
      await app.library();
      assert.equal(await site.evaluate<string | null>(`localStorage.getItem("leadSheetsPendingInvite")`), null, "the pass is not kept to reopen the sheet");
      await site.evaluate(`location.hash = "#/setlists"`);
      await waitFor(`location.hash === "#/setlists" && !${signInSheet}`, "Setlists, with no sheet in the way");
      await site.send("Page.reload");
      await app.library();
      await settle(800);
      assert.ok(!(await site.evaluate<boolean>(`!!${signInSheet}`)), "a reload does not trap the visitor in the sheet again");
      assert.equal((await passesOf()).find((pass) => pass.name === "Visitor").claimedBy, null, "and nobody holds the pass");
    });

    await check("a pass ended while the visitor signs up says so kindly", async () => {
      const made = ok(await makePass(terry, { name: "Late" }), "a pass");
      await fresh();
      await site.send("Page.navigate", { url: made.link });
      await atStep("start");
      ok(await terry.call("/api/bands/guests/revoke", { bandId, passId: made.pass.passId }), "Terry revokes it meanwhile");
      await app.click("New here? Create an account", signInSheet);
      await app.type("Your name (what bandmates see)", "Lee Late");
      await app.click("Sign in with Face ID or fingerprint", signInSheet);
      await waitFor(`["nudge", "account"].includes(${signInSheet}?.dataset.step) || !${signInSheet}`, "the end of Create account");
      if ((await site.evaluate<string>(`${signInSheet}?.dataset.step ?? ""`)) === "nudge") await app.click("Not now", signInSheet);
      await waitFor(`document.body.textContent.includes(${js(ENDED_BY_BAND)})`, ENDED_BY_BAND);
      assert.ok(!(await bodyText()).includes("Friday at the Elks"), "the refusal shows no gig");
    });

    await check("the pass screen says plainly that a screenshot can't be stopped", async () => {
      const empty = ok(await terry.call("/api/bands/create", { name: "No Gigs Yet" }), "a band with no gig planned").bandId as string;
      await signedInAs(terry);
      await site.send("Page.navigate", { url: `${origin}/?b=1#/band/${empty}` });
      await waitFor(`!!document.querySelector(${js(`.band-page[data-band="${empty}"] .band-tabs`)})`, "the empty band page");
      await app.click("Gigs", `document.querySelector(".band-tabs")`);
      await settle(800);
      assert.ok(!(await hasButton("Guests")), "with no gig planned there is no Guests button");

      await site.send("Page.navigate", { url: `${origin}/?b=2#/band/${bandId}` });
      await waitFor(`!!document.querySelector(${js(`.band-page[data-band="${bandId}"] .band-tabs`)})`, "the band page");
      await app.click("Gigs", `document.querySelector(".band-tabs")`);
      const card = `document.querySelector(${js(`.band-page [data-gig="${gigId}"]`)})`;
      await waitFor(`!!${card}`, "tonight's gig card");
      await tap("Guests", card);
      await tap("+ Guest pass", card);
      await app.type("Name (optional)", "Jo on keys");
      await site.evaluate(`[...${card}.querySelectorAll("label")].find((l) => l.textContent.trim().startsWith("Tonight only")).querySelector("input").click()`);
      for (const label of ["One week", "Pick a date", "Can see band chat", "Can see other setlists"]) {
        assert.ok(await site.evaluate<boolean>(`[...${card}.querySelectorAll("label")].some((l) => l.textContent.trim().startsWith(${js(label)}))`), `the pass form offers ${label}`);
      }
      await tap("Show my code", card);
      await waitFor(`!!${card}.querySelector(".codes-qr svg")`, "the pass's QR code");
      const link = readQr(await site.evaluate<string>(`${card}.querySelector(".codes-qr").innerHTML`));
      assert.match(link, /\/c\/guest\./, "the QR code is the guest pass link");
      assert.ok(await hasButton("Share link", card) || (await hasButton("Copy link", card)), "the pass can be sent as a link");
      const words = await site.evaluate<string>(`${card}.textContent`);
      assert.match(words, /screenshot/i, "the pass screen talks about screenshots");
      assert.match(words, /(can't|cannot|nothing can) (be )?stop/i, "and says plainly one can't be stopped");
      const jo = (await passesOf()).find((pass) => pass.name === "Jo on keys");
      assert.ok(jo, "the pass is made on the server");
      assert.equal(jo.expiresAt, phone.passEnds({ length: "tonight" }, today(), Date.now()), "Tonight only ends 6 AM the morning after the gig");
      assert.ok(await hasButton("Revoke", card), "each pass offers Revoke");
    });

    await check("after expires_at the charts are hidden and deleted on the next open with the network off", async () => {
      const quinnEnds = Date.now() + 25_000;
      const quinnPass = ok(await makePass(terry, { name: "Quinn", expiresAt: quinnEnds }), "a short pass for Quinn");
      ok(await quinn.call("/api/guest/claim", { code: quinnPass.code }), "Quinn joins as a guest");
      await signedInAs(quinn);
      await site.send("Page.navigate", { url: `${origin}/?q=1#/gig/${bandId}/${gigId}` });
      await waitFor(`!!document.querySelector(${js(`.gig-view[data-gig="${gigId}"]`)})`, "the guest's gig view");
      await tap("Get ready");
      await waitFor(`document.body.textContent.includes("Elks Opener")`, "tonight's songs on the phone");
      const held = (await packsOnPhone()).find((pack) => pack.gig.gigId === gigId);
      assert.equal(held?.expiresAt, quinnEnds, "the pack on the phone carries the pass's end time");
      for (; Date.now() < quinnEnds + 500; ) await settle(250);
      assert.deepEqual(refusal(await quinn.call("/api/bands/gig/open", { bandId, gigId })), [410, "pass-ended"], "the room refuses the pass once it ended");
      assert.ok((await land(quinnPass.code)).text.includes(PASS_ENDED), "and the link says the pass has ended");

      await openWithNoSignal(`${origin}/?q=2#/gig/${bandId}/${gigId}`);
      await waitFor(`!!document.querySelector(${js(`.gig-view[data-gig="${gigId}"]`)})`, "the gig view, opened with the server unreachable");
      await settle(1000);
      assert.deepEqual(await site.evaluate<string[]>("window.__shown"), [], "no chart of the ended pass shows, not even for one frame");
      assert.equal((await packsOnPhone()).filter((pack) => pack.gig.gigId === gigId).length, 0, "the gigPacks row is gone");
      await site.send("Network.setBlockedURLs", { urls: [] });
      await site.send("Page.navigate", { url: `${origin}/?q=3#/gig/${bandId}/${gigId}` });
      await waitFor(`document.body.textContent.includes(${js(PASS_ENDED)})`, PASS_ENDED);
      assert.deepEqual(await site.evaluate<string[]>("window.__shown"), [], "online again, the charts stay gone");
    });

    await check("a guest pass scanned in the app's Bands scanner opens the guest sheet, not a wrong-code refusal", async () => {
      const uma = await passwordPlayer(base, origin, "Uma Vance", "umavance");
      const link = ok(await makePass(terry, { name: "Uma" }), "a pass for Uma").link as string;
      await signedInAs(uma);
      await app.openBands();
      await waitFor(`document.querySelector(".bands-sheet")?.dataset.view === "list"`, "the Bands sheet");
      await app.click("Scan a code", `document.querySelector(".bands-sheet")`);
      await waitFor(`document.querySelector(".bands-sheet")?.dataset.view === "scan"`, "Scan a code");
      await site.evaluate(`[...document.querySelectorAll(".bands-sheet label")].find((l) => l.textContent.trim() === "Paste a link").control.focus()`);
      await site.send("Input.insertText", { text: link });
      await app.click("Open link", `document.querySelector(".bands-sheet")`);
      await waitFor(
        `document.body.textContent.includes("Join Friday at the Elks as a guest") || document.body.textContent.includes("isn't a band, gig or setlist code")`,
        "the scanner's answer to a guest pass",
      );
      assert.ok(!(await bodyText()).includes("isn't a band, gig or setlist code"), "the scanner does not call a guest pass a wrong code");
      await tap("Join as a guest");
      await waitFor(`location.hash === ${js(`#/gig/${bandId}/${gigId}`)}`, "the gig view after joining from the scanner");
      assert.equal((await passesOf()).find((pass) => pass.name === "Uma").claimedName, "Uma Vance", "the scanned pass is bound to Uma");
    });

    const packsFor = async () => (await packsOnPhone()).filter((pack) => pack.gig.gigId === gigId).length;
    const readyAs = async (who: Phone & { userId: string }, mark: string) => {
      await signedInAs(who);
      await site.send("Page.navigate", { url: `${origin}/?${mark}=1#/gig/${bandId}/${gigId}` });
      await waitFor(`!!document.querySelector(${js(`.gig-view[data-gig="${gigId}"]`)})`, "the guest's gig view");
      await tap("Get ready");
      await waitFor(`document.body.textContent.includes("Elks Opener")`, "tonight's songs on the phone");
      assert.equal(await packsFor(), 1, "the pack is on the guest's phone");
    };
    const gigView = `!!document.querySelector(${js(`.gig-view[data-gig="${gigId}"]`)})`;
    const charts = `/Elks (Opener|Closer)/.test(document.body.textContent)`;

    let wesPassId = "";
    await check("a live pass's charts show with no signal at all, since the pack's own end decides", async () => {
      const wes = await passwordPlayer(base, origin, "Wes Hale", "weshale");
      const wesPass = ok(await makePass(terry, { name: "Wes", expiresAt: Date.now() + 7 * DAY_MS }), "a one-week pass for Wes");
      wesPassId = wesPass.pass.passId;
      ok(await wes.call("/api/guest/claim", { code: wesPass.code }), "Wes joins as a guest");
      await readyAs(wes, "w");
      await openWithNoSignal(`${origin}/?w=2#/gig/${bandId}/${gigId}`);
      await waitFor(gigView, "the gig view, opened with the server unreachable");
      await waitFor(charts, "tonight's charts with no signal", 8000);
      await site.send("Network.setBlockedURLs", { urls: [] });
    });

    await check("a live pass's charts show while the server is slow to answer, and a revoke heard late still takes them off", async () => {
      await site.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/bands/gig/open*" }] });
      try {
        await site.send("Page.navigate", { url: `${origin}/?w=3#/gig/${bandId}/${gigId}` });
        await waitFor(gigView, "the gig view, with the server not answering");
        await waitFor(charts, "tonight's charts while the server hangs", 8000);
        // The sheet has no gig/open of its own, so only the pack's late verdict can take the chart off it.
        await site.send("Page.navigate", { url: `${origin}/?w=4#/gig/${bandId}/${gigId}/0` });
        await waitFor(`location.search === "?w=4" && ${charts}`, "tonight's chart on the sheet while the server hangs", 8000);
        ok(await terry.call("/api/bands/guests/revoke", { bandId, passId: wesPassId }), "Terry revokes Wes's pass meanwhile");
      } finally {
        await site.send("Fetch.disable");
      }
      for (const end = Date.now() + 10_000; (await packsFor()) > 0 && Date.now() < end; ) await settle(250);
      assert.equal(await packsFor(), 0, "the late pass-revoked reply takes the pack off the phone");
      await waitFor(`!${charts}`, "the chart gone from the sheet once the late reply lands", 5000);
    });

    await check("a revoked pass takes its charts off the phone at the next open, and none show while the phone asks", async () => {
      const rae = await passwordPlayer(base, origin, "Rae Lynn", "raelynn");
      const raePass = ok(await makePass(terry, { name: "Rae", expiresAt: Date.now() + 7 * DAY_MS }), "a one-week pass for Rae");
      ok(await rae.call("/api/guest/claim", { code: raePass.code }), "Rae joins as a guest");
      await readyAs(rae, "r");
      ok(await terry.call("/api/bands/guests/revoke", { bandId, passId: raePass.pass.passId }), "Terry revokes Rae's pass");

      await site.send("Page.navigate", { url: `${origin}/?r=2#/gig/${bandId}/${gigId}` });
      await waitFor(`document.body.textContent.includes(${js(ENDED_BY_BAND)})`, ENDED_BY_BAND);
      assert.deepEqual(await site.evaluate<string[]>("window.__shown"), [], "no chart of the revoked pass shows, not even while the phone asks the server");
      assert.equal(await packsFor(), 0, "the gigPacks row is gone");

      await openWithNoSignal(`${origin}/?r=3#/gig/${bandId}/${gigId}`);
      await waitFor(`!!document.querySelector(${js(`.gig-view[data-gig="${gigId}"]`)})`, "the gig view, opened with the server unreachable");
      await settle(1000);
      assert.deepEqual(await site.evaluate<string[]>("window.__shown"), [], "and with no signal afterwards the charts stay gone");
      await site.send("Network.setBlockedURLs", { urls: [] });
    });

    await check("a pass that ends while the gig view is open takes its charts off the screen at that moment", async () => {
      const noa = await passwordPlayer(base, origin, "Noa Wells", "noawells");
      const noaEnds = Date.now() + 20_000;
      ok(await noa.call("/api/guest/claim", { code: ok(await makePass(terry, { name: "Noa", expiresAt: noaEnds }), "a short pass for Noa").code }), "Noa joins as a guest");
      await readyAs(noa, "n");
      for (; Date.now() < noaEnds + 1500; ) await settle(250);
      const text = await bodyText();
      assert.ok(!text.includes("Elks Opener") && !text.includes("Elks Closer"), "no chart of the ended pass is still on screen");
      await waitFor(`document.body.textContent.includes(${js(PASS_ENDED)})`, `${PASS_ENDED}, with no reload`);
      assert.equal(await packsFor(), 0, "and the gigPacks row is gone");
    });

    await check("a guest following the live gig leaves it when the pass ends, and the sheet stops showing tonight's chart", async () => {
      const ivy = await passwordPlayer(base, origin, "Ivy Bell", "ivybell");
      const ivyEnds = Date.now() + 30_000;
      ok(await ivy.call("/api/guest/claim", { code: ok(await makePass(terry, { name: "Ivy", expiresAt: ivyEnds }), "a short pass for Ivy").code }), "Ivy joins as a guest");
      await readyAs(ivy, "i");
      await waitFor(`[...document.querySelectorAll(".gig-strip button")].some((b) => b.textContent.trim() === "Join gig")`, "Join gig on the live strip");
      await tap("Join gig", `document.querySelector(".gig-strip")`);
      await waitFor(`!!document.querySelector(".gig-question") || location.hash.endsWith("/0")`, "the click question or the sheet");
      if (await site.evaluate<boolean>(`!!document.querySelector(".gig-question")`)) await tap("Dot only", `document.querySelector(".gig-question")`);
      await waitFor(`document.querySelector(".gig-strip")?.dataset.strip !== undefined && /Elks (Opener|Closer)/.test(document.body.textContent) && location.hash.endsWith("/0")`, "tonight's chart on the sheet while following");
      for (; Date.now() < ivyEnds + 1500; ) await settle(250);
      assert.ok(!/Elks (Opener|Closer)/.test(await bodyText()), "no chart of the ended pass is still on the sheet");
      assert.equal(await packsFor(), 0, "and the gigPacks row is gone");
    });
  }
} catch (error) {
  failed += 1;
  console.log(`FAIL check:guest could not finish: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  for (const each of sockets) each.ws.close();
  await site?.close().catch(() => {});
  await worker.dispose();
}

if (failed > 0) {
  console.log(`check:guest: ${failed} failed`);
  process.exit(1);
}
console.log("check:guest passed");
