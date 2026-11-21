import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SongContent } from "../src/band-library-model.ts";
import type { ChatMessage } from "../src/chat-model.ts";
import { againDraft, draftChanged, draftProblem, draftReducer, fitDraft, gigDraftKey, gigLine, newDraft, planBody, type GigDraft, type GigPlan } from "../src/gig-plan-model.ts";
import type { passwordPlayer } from "./app-page.ts";

/**
 * P2, gigs and rehearsals become real plans and real records (persona PERSONA-FABLE-PLAN P2). One case per pass
 * condition, named by it. Cases marked (pure) run anywhere, `--pure` runs only those; the rest need Chrome and the Worker.
 * The cases fix this contract.
 *
 * `POST /api/bands/gig/plan` also takes `kind` ("gig" or "rehearsal", "gig" when left out), `startTime` and `callTime`
 * ("HH:MM", 24-hour), `venue` and `address` (up to 120 characters) and `notes` (up to 500). Each is optional; left out,
 * null or "" stores null. Anything else is `400 bad-request`. Every `GigPlan` the routes and packs answer carries them,
 * `kind` "gig" and nulls on a gig planned without them, also one planned before the columns existed.
 * `POST /api/bands/gig/list` answers `{ gigs, past }`: `gigs` not ended, `past` ended and newest first. Every view has
 * `songCount`, the songs in the gig's own song order. The band chat's gig card text holds `gigLine(plan)`.
 *
 * `gigLine(plan)` in `src/gig-plan-model.ts` is the one line the card, the chat card and the live screen title show:
 * "Rehearsal · Sat Nov 21 · 7:00 PM (call 6:15) · Elks Lodge". The call time carries AM or PM only when it differs from
 * the start's; with no start it reads "Call 6:15 PM".
 *
 * On the phone the Plan gig form adds a Gig / Rehearsal choice (a label "Gig" and a label "Rehearsal"), and fields
 * labelled "Start time", "Call time", "Venue", "Address" and "Notes". The gig card shows the line, the address and the
 * notes. Gigs shows "Past" below the upcoming cards once a gig has ended: each past card `[data-gig]` shows
 * "<n> songs" and who played, and an admin's has "Plan again". Errors from Send to band show inside the form, near the
 * button. A refusal while another account is signed in on this browser shows "You're signed in as someone else in
 * another tab. Reload to continue." with a "Reload" button. A Send with no answer in 15 s shows "Taking too long. Try
 * again." and Send works again. The unsent form is kept in localStorage under `leadSheetsGigDraft.<owner>.<gigId>`,
 * restored on reload, offered back with "Keep editing your draft?" ("Keep editing" or "Start over") when the admin
 * starts another plan in the band, and removed on Send or Cancel. A changed form asks the browser to warn on unload.
 */

type Reply = { status: number; body: Record<string, any> };
type Player = Awaited<ReturnType<typeof passwordPlayer>>;
type Plan = GigPlan & { kind: string; startTime: string | null; callTime: string | null; venue: string | null; address: string | null; notes: string | null };
type View = { gig: Plan; packRev: number; receipts: unknown[]; songCount: number };

const root = fileURLToPath(new URL("..", import.meta.url));
const PURE_ONLY = process.argv.includes("--pure");
/** Set SHOTS to a folder to save the screens at each width. */
const shots = process.env.SHOTS;
const js = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const refusal = (reply: Reply) => [reply.status, reply.body.error];
const gigId = () => `gig_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;

const LINE = "Rehearsal · Sat Nov 21 · 7:00 PM (call 6:15) · Elks Lodge";
const STALE = "You're signed in as someone else in another tab. Reload to continue.";
const SLOW = "Taking too long. Try again.";
const DETAILS = { kind: "rehearsal", startTime: "19:00", callTime: "18:15", venue: "Elks Lodge", address: "12 Main St, Springfield", notes: "Bring the DI box." };
const NO_DETAILS = { kind: "gig", startTime: null, callTime: null, venue: null, address: null, notes: null };
const detailsOf = (gig: Plan) => ({ kind: gig.kind, startTime: gig.startTime, callTime: gig.callTime, venue: gig.venue, address: gig.address, notes: gig.notes });

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

// ---- pure cases --------------------------------------------------------------------------------------------------

const PLAN: GigPlan = { gigId: "gig_old", bandId: "band", setlistId: "set", name: "Thursday rehearsal", date: "2026-11-21", lineup: ["terry", "mike", "dana"], leader: "mike", backup: "dana", route: "band_wifi", status: "ended" };

await check("a rehearsal shows as Rehearsal on the card, the chat line and the live screen title (pure)", () => {
  assert.equal(gigLine({ ...PLAN, ...DETAILS } as GigPlan), LINE, "the rehearsal line");
  assert.equal(gigLine({ date: "2026-11-27" } as GigPlan), "Gig · Fri Nov 27", "a gig from an old pack, with no kind or times, reads as a gig on its day");
  assert.equal(gigLine({ date: "2026-11-21", kind: "gig", startTime: "12:00", callTime: "11:30", venue: null } as GigPlan), "Gig · Sat Nov 21 · 12:00 PM (call 11:30 AM)", "a call before noon for a noon start says AM");
  assert.equal(gigLine({ date: "2026-12-31", kind: "gig", startTime: "00:30", callTime: null, venue: "The Barn" } as GigPlan), "Gig · Thu Dec 31 · 12:30 AM · The Barn", "half past midnight");
  assert.equal(gigLine({ date: "2026-11-21", kind: "rehearsal", startTime: null, callTime: "18:15", venue: null } as GigPlan), "Rehearsal · Sat Nov 21 · Call 6:15 PM", "a call time with no start");
});

await check("draft survives a reload and is offered back; a reload or tab close with a non-blank draft warns (pure)", () => {
  const fresh = newDraft(["terry", "mike", "dana"], "terry");
  assert.deepEqual([fresh.kind, fresh.startTime, fresh.callTime, fresh.venue, fresh.address, fresh.notes], ["gig", "", "", "", "", ""], "a new draft is a gig with nothing else filled in");
  let draft: GigDraft = draftReducer(fresh, { type: "kind", kind: "rehearsal" });
  for (const [field, value] of [["startTime", "19:00"], ["callTime", "18:15"], ["venue", "Elks Lodge"], ["address", "12 Main St"], ["notes", "Bring the DI box."]] as const) draft = draftReducer(draft, { type: "detail", field, value });
  assert.deepEqual([draft.kind, draft.startTime, draft.callTime, draft.venue, draft.address, draft.notes], ["rehearsal", "19:00", "18:15", "Elks Lodge", "12 Main St", "Bring the DI box."], "each new action sets its field");
  assert.deepEqual([draft.name, draft.date, draft.lineup, draft.leader], [fresh.name, fresh.date, fresh.lineup, fresh.leader], "and leaves the rest alone");
  const ready = draftReducer(draftReducer(fresh, { type: "name", name: "Friday" }), { type: "date", date: "2026-11-27" });
  assert.equal(draftProblem(ready), null, "name, date and lineup are enough; the new fields stay optional");
  assert.equal(draftProblem({ ...ready, venue: "Elks Lodge", notes: "x" }), null, "filled-in details change nothing");
  assert.equal(draftProblem({ ...draft, date: "2026-11-27" }), "Give the gig a name.", "a rehearsal still needs a name");
  assert.equal(draftChanged(fresh, newDraft(["terry", "mike", "dana"], "terry")), false, "an untouched form is not a draft");
  assert.equal(draftChanged(draftReducer(fresh, { type: "detail", field: "venue", value: "Elks Lodge" }), fresh), true, "typing a venue is");
  const offOn = draftReducer(draftReducer(fresh, { type: "toggleLineup", userId: "dana" }), { type: "toggleLineup", userId: "dana" });
  assert.equal(draftChanged(offOn, fresh), false, "switching someone off and on again changes nothing");
  assert.equal(gigDraftKey("user_sam", "gig_abc"), "leadSheetsGigDraft.user_sam.gig_abc", "the key carries the account and the gig");
  assert.notEqual(gigDraftKey("user_sam", "gig_abc"), gigDraftKey("user_dana", "gig_abc"), "so two accounts on one phone never share a draft");
  assert.deepEqual(planBody({ ...ready, venue: "  Elks Lodge ", startTime: "", notes: "   " }), { ...ready, kind: "gig", venue: "Elks Lodge", startTime: null, callTime: null, address: null, notes: null }, "Send turns blank details into null and trims the rest");
});

await check("Plan again pre-fills everything but the date (pure)", () => {
  const again = againDraft({ ...PLAN, ...DETAILS } as GigPlan);
  assert.deepEqual(again, { name: "Thursday rehearsal", date: "", lineup: ["terry", "mike", "dana"], leader: "mike", backup: "dana", route: "band_wifi", ...DETAILS }, "the past gig's plan with the date cleared");
  const old = againDraft(PLAN);
  assert.deepEqual([old.kind, old.startTime, old.venue, old.notes], ["gig", "", "", ""], "a gig planned before the new fields comes back as a gig with them blank");
  const fitted = fitDraft(again, ["terry", "dana", "sam"]);
  assert.deepEqual([fitted.lineup, fitted.leader, fitted.backup], [["terry", "dana"], null, "dana"], "someone no longer in the band comes off the lineup, and a leader who left must be picked again");
});

// ---- box cases: the Worker and the phone in Chrome ---------------------------------------------------------------

async function shareSet(who: { call: Player["call"] }, bandId: string, songs: SongContent[], name: string) {
  const songIds: string[] = [];
  for (const song of songs) {
    const shared = await who.call("/api/bands/library/share-song", { bandId, song, choice: "public", localId: null });
    assert.equal(shared.status, 200, `${song.title} is shared (${js(shared.body)})`);
    songIds.push(shared.body.songId);
  }
  const set = await who.call("/api/bands/library/share-setlist", { bandId, name, songIds, tags: [], choice: "public", localId: null });
  assert.equal(set.status, 200, `${name} is shared (${js(set.body)})`);
  return set.body.setlistId as string;
}

async function newBand(admin: Player, name: string, members: Player[]) {
  const bandId = (await admin.call("/api/bands/create", { name })).body.bandId as string;
  const code = (await admin.call("/api/codes", { kind: "band", bandId })).body.code as string;
  for (const member of members) assert.equal((await member.call("/api/bands/join", { code })).status, 200, `${member.name} joins ${name}`);
  return { bandId, code };
}

const SEED = JSON.parse(readFileSync(join(root, "data", "library.json"), "utf8")) as { songs: (SongContent & { id: number })[] };
const content = ({ id: _id, ...song }: SongContent & { id: number }): SongContent => song;
const SONGS = SEED.songs.slice(0, 3).map(content);

/** The Worker and Chrome load only for the box cases, so `--pure` runs with neither installed. */
const boxTools = async () => ({ ...(await import("./api-session.ts")), ...(await import("./app-page.ts")), ...(await import("./chrome.ts")) });

async function boxCases() {
  const { appPage, openSite, PASSWORD_PEPPER, passwordPlayer, settle, startApi } = await boxTools();
  let apiBase = "";
  const site = await openSite(root, "check-gig-plan-record", () => apiBase);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
  apiBase = base;
  try {
    const app = await appPage(site);
    await site.send("Network.enable");
    /** Holds `gig/plan` requests while `__stallPlan` is on, until `__releasePlan()`, so the app sees a request that never answers. */
    await site.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        window.__stallPlan = false;
        window.__heldPlans = [];
        window.__releasePlan = () => { const held = window.__heldPlans; window.__heldPlans = []; for (const go of held) go(); return held.length; };
        const fetchNext = window.fetch;
        window.fetch = (input, init) => {
          const url = String(input?.url ?? input);
          if (url.includes("/api/bands/gig/plan") && window.__stallPlan) return new Promise((done, fail) => window.__heldPlans.push(() => fetchNext(input, init).then(done, fail)));
          return fetchNext(input, init);
        };
      })();`,
    });
    const appCalls = (path: string, body: object) =>
      site.evaluate<Reply>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
    const hash = () => site.evaluate<string>("location.hash");
    const page = (bandId: string, view = "band") => `document.querySelector(${js(`.band-page[data-band="${bandId}"][data-view="${view}"]`)})`;
    const onPage = (bandId: string, view = "band") => app.until(`!!${page(bandId, view)} && !${page(bandId, view)}.textContent.includes("Loading")`, `the ${view} screen of ${bandId}`, 15000);
    const plan = (bandId: string) => page(bandId, "plan");
    const form = (bandId: string) => `${plan(bandId)}?.querySelector("form")`;
    const fieldOf = (bandId: string, label: string) => `[...(${plan(bandId)}?.querySelectorAll("label") ?? [])].find((l) => l.textContent.trim() === ${js(label)})?.control`;
    const atForm = (bandId: string) => app.until(`!!${fieldOf(bandId, "Gig name")}`, "the Plan gig form", 15000);
    const openPlan = async (bandId: string, setlistId: string, id = gigId()) => {
      await site.evaluate(`location.hash = ${js(`#/band/${bandId}/plan/${id}?setlist=${setlistId}`)}`);
      await onPage(bandId, "plan");
      return id;
    };
    const setField = async (bandId: string, label: string, value: string) => {
      const set = await site.evaluate<boolean>(
        `(() => { const field = ${fieldOf(bandId, label)}; if (!field) return false; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, ${js(value)}); field.dispatchEvent(new Event("input", { bubbles: true })); field.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
      );
      assert.ok(set, `the ${label} field on the Plan gig screen`);
      await settle();
    };
    const valueOf = (bandId: string, label: string) => site.evaluate<string | null>(`${fieldOf(bandId, label)}?.value ?? null`);
    /** The Gig / Rehearsal choice: a label (around a radio) or a button with that word. */
    const choose = async (bandId: string, word: string) => {
      const chose = await site.evaluate<boolean>(
        `(() => { const el = [...(${plan(bandId)}?.querySelectorAll("label, button") ?? [])].find((e) => e.textContent.trim() === ${js(word)}); el?.click(); return !!el; })()`,
      );
      assert.ok(chose, `a ${word} choice on the form`);
      await settle();
    };
    const chosen = (bandId: string, word: string) =>
      site.evaluate<boolean>(
        `(() => { const el = [...(${plan(bandId)}?.querySelectorAll("label, button") ?? [])].find((e) => e.textContent.trim() === ${js(word)}); if (!el) return false; return el.tagName === "LABEL" ? !!(el.control ?? el.querySelector("input"))?.checked : el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-checked") === "true"; })()`,
      );
    const sendButton = (bandId: string) => `[...(${form(bandId)}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Send to band")`;
    const sendEnabled = (bandId: string) => site.evaluate<boolean>(`!!${sendButton(bandId)} && !${sendButton(bandId)}.disabled`);
    const formText = (bandId: string) => site.evaluate<string>(`${form(bandId)}?.textContent ?? ""`);
    /** Whether `words` show inside the form and stay on screen with Send when Send is scrolled into view. */
    const besideSend = (bandId: string, words: string) =>
      site.evaluate<boolean>(`(async () => {
        const send = ${sendButton(bandId)};
        const line = [...(${form(bandId)}?.querySelectorAll("*") ?? [])].find((el) => el.children.length === 0 && el.textContent.trim() === ${js(words)});
        if (!send || !line) return false;
        send.scrollIntoView({ block: "center" });
        await new Promise((done) => setTimeout(done, 200));
        const box = line.getBoundingClientRect();
        return box.height > 0 && box.top >= 0 && box.bottom <= innerHeight;
      })()`);
    const notice = (words: string) => app.until(`(document.querySelector(".bands-notice")?.textContent ?? "").includes(${js(words)})`, `the words ${words}`, 15000);
    const openGigs = async (bandId: string) => {
      await site.evaluate(`location.hash = "#/bands"`);
      await app.until(`!!document.querySelector(".bands-tab")`, "the Bands tab");
      await site.evaluate(`location.hash = ${js(`#/band/${bandId}?s=gigs`)}`);
      await onPage(bandId);
      await app.until(`${page(bandId)}?.querySelector(".band-tabs [aria-selected=true]")?.firstChild?.textContent.trim() === "Gigs" && !${page(bandId)}.textContent.includes("Loading")`, "the Gigs section", 15000);
    };
    const card = (bandId: string, id: string) => `${page(bandId)}?.querySelector(${js(`[data-gig="${id}"]`)})`;
    const cardText = (bandId: string, id: string) => site.evaluate<string>(`${card(bandId, id)}?.textContent ?? ""`);
    /** The Past heading in Gigs, and the gig ids of the cards before and after it. */
    const gigsLayout = (bandId: string) =>
      site.evaluate<{ past: boolean; before: string[]; after: string[] }>(`(() => {
        const screen = ${page(bandId)};
        const heading = [...(screen?.querySelectorAll("h2, h3, h4") ?? [])].find((h) => h.textContent.trim() === "Past");
        const cards = [...(screen?.querySelectorAll("[data-gig]") ?? [])].filter((el) => !el.closest(".next-gig"));
        const after = (el) => !!heading && !!(heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
        return { past: !!heading, before: cards.filter((el) => !after(el)).map((el) => el.dataset.gig), after: cards.filter(after).map((el) => el.dataset.gig) };
      })()`);
    const draftKeys = () => site.evaluate<string[]>(`Object.keys(localStorage).filter((key) => key.startsWith("leadSheetsGigDraft.")).sort()`);
    const warnsOnUnload = () => site.evaluate<boolean>(`!window.dispatchEvent(new Event("beforeunload", { cancelable: true }))`);
    const reload = async () => {
      await site.evaluate(`window.__beforeReload = true; location.reload()`);
      await app.until(`!window.__beforeReload && document.readyState === "complete"`, "the reload", 15000);
    };
    const me = () => site.evaluate<{ account?: { userId: string } }>(`fetch("/api/me").then((r) => r.json())`).then((reply) => reply.account);

    const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
    const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
    const dana = await passwordPlayer(base, origin, "Dana Drums", "danadrums");
    const blue = await newBand(terry, "The Blue Notes", [mike, dana]);
    const bandId = blue.bandId;
    const setlistId = await shareSet(terry, bandId, SONGS, "Friday set");

    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await site.evaluate("Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((done) => setTimeout(done, 20000, false))])");
    if (!(await site.evaluate<boolean>("!!navigator.serviceWorker.controller"))) await site.send("Page.reload");
    await app.until("!!navigator.serviceWorker?.controller", "the service worker to take control of the page", 60000);
    await app.library();
    /** app.signUp, with the name set like setField instead of typed, so the page never gets a real keystroke. */
    await app.openMenu();
    await app.pick("Sign in");
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "start"`, "the start screen");
    await app.click("New here? Create an account");
    await site.evaluate(`(() => { const field = [...document.querySelectorAll("[role=dialog] label")].find((l) => l.textContent.trim() === "Your name (what bandmates see)").control; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, "Sam Rivera"); field.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await settle();
    await app.click("Sign in with Face ID or fingerprint");
    await app.until(`["nudge", "account"].includes(document.querySelector(".account-sheet")?.dataset.step)`, "the end of Create account");
    if ((await site.evaluate<string>(`document.querySelector(".account-sheet").dataset.step`)) === "nudge") await app.click("Not now");
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "account"`, "the account screen");
    await app.click("✕");
    await app.closeMenu();
    const sam = await me();
    assert.ok(sam, "Sam is signed in on the phone");
    assert.equal((await appCalls("/api/bands/join", { code: blue.code })).status, 200, "Sam joins the band");
    assert.equal((await terry.call("/api/bands/make-admin", { bandId, userId: sam.userId })).status, 200, "Terry makes Sam an admin");
    const names = ["Terry Bass", "Sam Rivera", "Mike Keys", "Dana Drums"];
    /** A fresh document, so nothing typed during sign-up counts as a tap that would let a beforeunload warning open a dialog. */
    await reload();

    const planApi = (who: Player, over: Record<string, unknown> = {}) => who.call("/api/bands/gig/plan", { bandId, setlistId, name: "Friday at the Elks", date: "2026-11-27", ...over });
    const open = async (who: Player, id: string): Promise<View> => {
      const reply = await who.call("/api/bands/gig/open", { bandId, gigId: id });
      assert.equal(reply.status, 200, `the gig opens (${js(reply.body)})`);
      return reply.body as View;
    };
    const list = async (who: Player) => {
      const reply = await who.call("/api/bands/gig/list", { bandId });
      assert.equal(reply.status, 200, `the gig list (${js(reply.body)})`);
      assert.ok(Array.isArray(reply.body.gigs) && Array.isArray(reply.body.past), `the list answers { gigs, past } (${js(reply.body).slice(0, 200)})`);
      return reply.body as { gigs: View[]; past: View[] };
    };
    const gigCards = async (id: string) => ((await mike.call("/api/chat/open", { roomId: bandId })).body.messages as ChatMessage[]).filter((m) => m.kind === "gig" && m.ref === id);

    let g1 = "";
    /** Thursday rehearsal, planned on the phone in the first case or, when that failed, by Terry here, so later cases still try their own claim. */
    const needG1 = async () => {
      if (g1) return;
      g1 = gigId();
      assert.equal((await planApi(terry, { gigId: g1, name: "Thursday rehearsal", date: "2026-11-21", ...DETAILS })).status, 200, "Terry plans Thursday rehearsal");
    };

    await check("plan form saves type, start time, call time, venue, address and notes and the card shows them", async () => {
      const id = await openPlan(bandId, setlistId);
      await atForm(bandId);
      assert.equal(await chosen(bandId, "Gig"), true, "Gig is chosen to start with");
      await setField(bandId, "Gig name", "Thursday rehearsal");
      await setField(bandId, "Date", "2026-11-21");
      await choose(bandId, "Rehearsal");
      assert.equal(await chosen(bandId, "Rehearsal"), true, "Rehearsal is chosen after the tap");
      assert.equal(await site.evaluate<string>(`${fieldOf(bandId, "Start time")}?.type`), "time", "Start time is the phone's own time picker");
      assert.equal(await site.evaluate<string>(`${fieldOf(bandId, "Call time")}?.type`), "time", "and so is Call time");
      await setField(bandId, "Start time", DETAILS.startTime);
      await setField(bandId, "Call time", DETAILS.callTime);
      await setField(bandId, "Venue", DETAILS.venue);
      await setField(bandId, "Address", DETAILS.address);
      await setField(bandId, "Notes", DETAILS.notes);
      await app.click("Send to band", form(bandId));
      await notice("Sent Thursday rehearsal to the band.");
      g1 = id;
      assert.deepEqual(detailsOf((await open(mike, id)).gig), DETAILS, "Mike reads every new field back");
      await openGigs(bandId);
      await app.until(`!!${card(bandId, id)}`, "the Thursday rehearsal card", 15000);
      const text = await cardText(bandId, id);
      for (const shown of [LINE, DETAILS.address, DETAILS.notes]) assert.ok(text.includes(shown), `the card shows ${js(shown)} (${text.slice(0, 300)})`);

      const bad: [string, Record<string, unknown>][] = [
        ["a kind that is neither", { kind: "concert" }],
        ["a start time that isn't HH:MM", { startTime: "7pm" }],
        ["an hour past 23", { startTime: "25:00" }],
        ["a call time that is a number", { callTime: 1815 }],
        ["a venue of 121 characters", { venue: "v".repeat(121) }],
        ["an address of 121 characters", { address: "a".repeat(121) }],
        ["notes of 501 characters", { notes: "n".repeat(501) }],
        ["an address that isn't text", { address: ["12 Main St"] }],
      ];
      for (const [what, over] of bad) assert.deepEqual(refusal(await planApi(terry, over)), [400, "bad-request"], `${what} is a bad request`);
      const longest = await planApi(terry, { name: "Longest fields", venue: "v".repeat(120), address: "a".repeat(120), notes: "n".repeat(500) });
      assert.equal(longest.status, 200, `120, 120 and 500 characters are allowed (${js(longest.body).slice(0, 200)})`);
      const plain = await planApi(terry, { name: "Plain gig", venue: "", notes: null });
      assert.equal(plain.status, 200, "a blank venue and null notes are fine");
      assert.deepEqual(detailsOf((plain.body as View).gig), NO_DETAILS, "and read back as a gig with nulls");
      await app.shot(shots && `${shots}/gig-record-card.png`);
    });

    await check("a rehearsal shows as Rehearsal on the card, the chat line and the live screen title", async () => {
      await needG1();
      const posted = await gigCards(g1);
      assert.equal(posted.length, 1, "one gig card in the band chat");
      assert.ok(posted[0].text.includes(LINE), `the chat card's words hold the line (${js(posted[0].text)})`);
      await openGigs(bandId);
      await app.until(`!!${card(bandId, g1)}`, "the card");
      assert.ok((await cardText(bandId, g1)).includes(LINE), "the card shows the same line");
      await site.evaluate(`location.hash = ${js(`#/gig/${bandId}/${g1}`)}`);
      await app.until(`!!document.querySelector(${js(`.gig-view[data-gig="${g1}"] header`)})`, "the live screen", 15000);
      await app.until(`document.querySelector(${js(`.gig-view[data-gig="${g1}"] header`)}).textContent.includes(${js(LINE)})`, "the line in the live screen's title", 15000);
      assert.ok((await site.evaluate<string>(`document.querySelector(${js(`.gig-view[data-gig="${g1}"] header`)}).textContent`)).includes("Thursday rehearsal"), "with the gig's name");
    });

    let gB = "";
    await check("ending a gig moves it to Past; it is not deleted", async () => {
      await needG1();
      gB = gigId();
      assert.equal((await planApi(terry, { gigId: gB, name: "Barn dance", date: "2026-11-27", venue: "The Barn" })).status, 200, "Terry plans the Barn dance");
      await openGigs(bandId);
      await app.until(`!!${card(bandId, gB)}`, "the Barn dance card", 15000);
      assert.equal((await gigsLayout(bandId)).past, false, "no Past while no gig has ended");
      const before = await list(mike);
      assert.ok(before.gigs.every((view) => view.songCount === 3), `every upcoming gig counts its 3 songs (${js(before.gigs.map((v) => v.songCount))})`);
      for (const id of [g1, gB]) assert.equal((await terry.call("/api/bands/gig/end", { bandId, gigId: id })).status, 200, "Terry ends a gig");
      const after = await list(mike);
      assert.ok(!after.gigs.some((view) => [g1, gB].includes(view.gig.gigId)), "neither ended gig is upcoming");
      const past = after.past.map((view) => view.gig.gigId).filter((id) => [g1, gB].includes(id));
      assert.deepEqual(past, [gB, g1], "both are in Past, newest first");
      assert.ok(after.past.every((view) => view.gig.status === "ended" && view.songCount === 3), "each past gig is ended and still counts its songs");
      assert.equal((await open(mike, g1)).gig.status, "ended", "an ended gig still opens: it was kept, not deleted");
      assert.equal((await open(mike, g1)).gig.venue, DETAILS.venue, "with its venue");
      await openGigs(bandId);
      await app.until(`${js([g1, gB])}.every((id) => !!${page(bandId)}?.querySelector("[data-gig=\\"" + id + "\\"]"))`, "both past cards", 15000);
      const layout = await gigsLayout(bandId);
      assert.ok(layout.past, "Gigs shows Past");
      assert.deepEqual(layout.after.filter((id) => [g1, gB].includes(id)), [gB, g1], "below the heading, newest first");
      assert.ok(!layout.before.some((id) => [g1, gB].includes(id)), "and not among the upcoming cards");
      const text = await cardText(bandId, g1);
      assert.ok(text.includes("3 songs"), `the past card shows the set size (${text.slice(0, 300)})`);
      for (const name of names) assert.ok(text.includes(name), `and ${name}, who played`);
      await app.shot(shots && `${shots}/gig-record-past.png`);
    });

    await check("Plan again pre-fills everything but the date", async () => {
      await needG1();
      if (!(await site.evaluate<boolean>(`!!${card(bandId, g1)}`))) {
        await terry.call("/api/bands/gig/end", { bandId, gigId: g1 });
        await openGigs(bandId);
      }
      await app.until(`!!${card(bandId, g1)}`, "the past card", 15000);
      await app.click("Plan again", card(bandId, g1));
      await app.until(`location.hash.startsWith(${js(`#/band/${bandId}/plan/gig_`)})`, "the Plan gig route", 15000);
      const at = await hash();
      const again = /\/plan\/(gig_[A-Za-z0-9_-]{22})/.exec(at)?.[1] ?? "";
      assert.ok(again && again !== g1, `a fresh gig id (${at})`);
      assert.ok(at.endsWith(`?setlist=${setlistId}`), "from the same setlist");
      await onPage(bandId, "plan");
      await atForm(bandId);
      assert.ok(!(await site.evaluate<string>(`${plan(bandId)}.textContent`)).includes("Keep editing your draft?"), "it opens straight on the form");
      const past = (await open(mike, g1)).gig;
      assert.deepEqual(
        { name: await valueOf(bandId, "Gig name"), date: await valueOf(bandId, "Date"), rehearsal: await chosen(bandId, "Rehearsal"), startTime: await valueOf(bandId, "Start time"), callTime: await valueOf(bandId, "Call time"), venue: await valueOf(bandId, "Venue"), address: await valueOf(bandId, "Address"), notes: await valueOf(bandId, "Notes"), leader: await valueOf(bandId, "Leader") },
        { name: "Thursday rehearsal", date: "", rehearsal: true, startTime: DETAILS.startTime, callTime: DETAILS.callTime, venue: DETAILS.venue, address: DETAILS.address, notes: DETAILS.notes, leader: past.leader },
        "everything but the date comes from the past gig",
      );
      const switches = await site.evaluate<number>(`[...${plan(bandId)}.querySelectorAll("input[role=switch]")].filter((s) => s.checked).length`);
      assert.equal(switches, past.lineup.length, "with the same lineup switched on");
      await setField(bandId, "Date", "2026-11-28");
      await app.click("Send to band", form(bandId));
      await notice("Sent Thursday rehearsal to the band.");
      const made = (await open(mike, again)).gig;
      assert.deepEqual([made.date, made.setlistId, [...made.lineup].sort(), made.leader, detailsOf(made)], ["2026-11-28", setlistId, [...past.lineup].sort(), past.leader, DETAILS], "the new gig has the old plan on the new date");
      assert.equal((await open(mike, g1)).gig.status, "ended", "and the past gig stays as it was");
    });

    await check("draft survives a reload and is offered back; a reload or tab close with a non-blank draft warns", async () => {
      if (g1) assert.ok(!(await draftKeys()).some((key) => key.endsWith(`.${g1}`)), "Send to band removed the sent plan's draft");
      const id = await openPlan(bandId, setlistId);
      await atForm(bandId);
      const mine = async () => (await draftKeys()).filter((key) => key.endsWith(`.${id}`));
      assert.equal(await warnsOnUnload(), false, "an untouched form never warns");
      assert.deepEqual(await mine(), [], "and keeps no draft");
      await setField(bandId, "Gig name", "Draft night");
      await setField(bandId, "Venue", "Back room");
      const key = `leadSheetsGigDraft.${sam.userId}.${id}`;
      assert.deepEqual(await mine(), [key], "the draft is kept under this account and gig");
      assert.equal(await warnsOnUnload(), true, "a changed form asks the browser to warn on reload or close");
      await reload();
      await onPage(bandId, "plan");
      await atForm(bandId);
      assert.deepEqual([await valueOf(bandId, "Gig name"), await valueOf(bandId, "Venue")], ["Draft night", "Back room"], "the draft is back after a reload");

      await site.evaluate(`location.hash = ${js(`#/band/${bandId}?s=setlists`)}`);
      await onPage(bandId);
      await app.until(`[...(${page(bandId)}?.querySelectorAll(".band-library-setlists li") ?? [])].some((li) => li.textContent.includes("Friday set"))`, "the Friday set row", 15000);
      await app.click("Plan a gig", `[...${page(bandId)}.querySelectorAll(".band-library-setlists li")].find((li) => li.textContent.includes("Friday set"))`);
      await app.until(`(${plan(bandId)}?.textContent ?? "").includes("Keep editing your draft?")`, "the draft offered back", 15000);
      await app.click("Keep editing", plan(bandId));
      await atForm(bandId);
      assert.ok((await hash()).includes(`/plan/${id}`), "Keep editing goes back to the draft's gig");
      assert.deepEqual([await valueOf(bandId, "Gig name"), await valueOf(bandId, "Venue")], ["Draft night", "Back room"], "with what was typed");

      await site.evaluate(`location.hash = ${js(`#/band/${bandId}?s=gigs`)}`);
      await onPage(bandId);
      await openPlan(bandId, setlistId);
      await app.until(`(${plan(bandId)}?.textContent ?? "").includes("Keep editing your draft?")`, "the draft offered again", 15000);
      await app.click("Start over", plan(bandId));
      await atForm(bandId);
      assert.equal(await valueOf(bandId, "Gig name"), "", "Start over is a blank form");
      assert.deepEqual(await mine(), [], "and the old draft is gone");
      await site.evaluate(`location.hash = ${js(`#/band/${bandId}?s=gigs`)}`);
      await onPage(bandId);
      await openPlan(bandId, setlistId);
      await atForm(bandId);
      assert.ok(!(await site.evaluate<string>(`${plan(bandId)}.textContent`)).includes("Keep editing your draft?"), "a form left untouched is not offered back");

      const before = await draftKeys();
      await setField(bandId, "Gig name", "Never sent");
      assert.equal((await draftKeys()).length, before.length + 1, "typing keeps a draft");
      await app.click("Cancel", form(bandId));
      await onPage(bandId);
      assert.deepEqual(await draftKeys(), before, "Cancel removes it");
    });

    await check("a hung request re-enables Send with Try again after the timeout", async () => {
      const id = await openPlan(bandId, setlistId);
      await atForm(bandId);
      await setField(bandId, "Gig name", "Slow night");
      await setField(bandId, "Date", "2026-12-04");
      await site.evaluate("window.__stallPlan = true");
      const sentAt = Date.now();
      await app.click("Send to band", form(bandId));
      await sleep(3000);
      assert.equal(await sendEnabled(bandId), false, "Send waits while the request is out");
      await app.until(`(${form(bandId)}?.textContent ?? "").includes(${js(SLOW)})`, "the timeout line", 25000);
      const waited = Date.now() - sentAt;
      assert.ok(waited >= 14000, `the line comes after the 15 s timeout (${waited} ms)`);
      assert.equal(await sendEnabled(bandId), true, "and Send works again");
      assert.ok(await besideSend(bandId, SLOW), "the line is next to Send");
      assert.equal(await site.evaluate<number>("window.__releasePlan()"), 1, "one request was held");
      await site.evaluate("window.__stallPlan = false");
      await sleep(1500);
      await app.click("Send to band", form(bandId));
      await notice("Sent Slow night to the band.");
      const { gigs } = await list(mike);
      assert.deepEqual(gigs.filter((view) => view.gig.name === "Slow night").map((view) => view.gig.gigId), [id], "one Slow night, under the form's gig id, though both requests reached the server");
      assert.equal((await gigCards(id)).length, 1, "and one card in the band chat");
    });

    await check("Send to band with a session for another account shows a message next to the button, not nothing", async () => {
      const id = await openPlan(bandId, setlistId);
      await atForm(bandId);
      await setField(bandId, "Gig name", "Stale night");
      await setField(bandId, "Date", "2026-12-11");
      const cookies = (await site.send("Network.getCookies", { urls: [origin] })).cookies as { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite?: string; expires: number }[];
      const samCookie = cookies.find((c) => c.name === "mls_session");
      assert.ok(samCookie, "Sam's session cookie in the browser");
      const put = (value: string) => {
        const { name, domain, path, secure, httpOnly, sameSite, expires } = samCookie;
        return site.send("Network.setCookie", { name, value, domain, path, secure, httpOnly, ...(sameSite ? { sameSite } : {}), ...(expires > 0 ? { expires } : {}) });
      };
      try {
        await put(dana.cookie.split("=").slice(1).join("="));
        assert.equal((await me())?.userId, dana.userId, "another tab signed Dana in on this browser");
        await app.click("Send to band", form(bandId));
        await app.until(`(${form(bandId)}?.textContent ?? "").includes(${js(STALE)})`, "the stale-tab words", 15000);
        assert.ok(await besideSend(bandId, STALE), "the words are next to Send");
        assert.ok(await site.evaluate<boolean>(`[...${form(bandId)}.querySelectorAll("button")].some((b) => b.textContent.trim() === "Reload")`), "with a Reload button");
        assert.equal(await sendEnabled(bandId), true, "and Send is not stuck");
        assert.deepEqual(refusal(await terry.call("/api/bands/gig/open", { bandId, gigId: id })), [404, "not-found"], "no gig was made for Dana");
        await site.evaluate(`window.__beforeReload = true; [...${form(bandId)}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Reload").click()`);
        await app.until(`!window.__beforeReload && document.readyState === "complete"`, "Reload reloading the page", 15000);
        await onPage(bandId, "plan");
        const asDana = await site.evaluate<string>(`${plan(bandId)}.textContent`);
        assert.ok(asDana.includes("Only a band admin can do that."), `Dana, a member, sees she can't plan (${asDana.slice(0, 200)})`);
        assert.ok(!asDana.includes("Stale night") && !(await site.evaluate<boolean>(`[...document.querySelectorAll("input")].some((i) => i.value === "Stale night")`)), "and none of Sam's draft");
      } finally {
        await put(samCookie.value);
      }
      await reload();
      await onPage(bandId, "plan");
      await atForm(bandId);
      assert.equal(await valueOf(bandId, "Gig name"), "Stale night", "back as Sam, the draft is still there");
      await app.click("Send to band", form(bandId));
      await notice("Sent Stale night to the band.");

      const side = await newBand(terry, "Side Project", [mike]);
      const sideSet = await shareSet(terry, side.bandId, SONGS.slice(0, 1), "Short set");
      assert.equal((await appCalls("/api/bands/join", { code: side.code })).status, 200, "Sam joins Side Project");
      assert.equal((await terry.call("/api/bands/make-admin", { bandId: side.bandId, userId: sam.userId })).status, 200, "as an admin");
      await openPlan(side.bandId, sideSet);
      await atForm(side.bandId);
      await setField(side.bandId, "Gig name", "Side gig");
      await setField(side.bandId, "Date", "2026-12-18");
      assert.equal((await terry.call("/api/bands/remove", { bandId: side.bandId, userId: sam.userId })).status, 200, "Terry removes Sam meanwhile");
      await app.click("Send to band", form(side.bandId));
      await app.until(`(${form(side.bandId)}?.textContent ?? "").includes("You're not in this band any more.")`, "the refusal's own words", 15000);
      assert.ok(await besideSend(side.bandId, "You're not in this band any more."), "next to Send");
      assert.ok(!(await formText(side.bandId)).includes(STALE), "not the stale-tab words, since Sam is still the one signed in");
    });

    await check("at 344, 390, 820, 884 and 1280 the new plan fields, Send and the Past card fit uncovered", async () => {
      await needG1();
      const problems: string[] = [];
      const uncovered = (scope: string, labels: string[], buttons: string[]) =>
        site.evaluate<string[]>(`(async () => {
          const screen = ${scope};
          if (!screen) return ["no screen"];
          const out = [];
          if (document.documentElement.scrollWidth > innerWidth + 1) out.push("the page scrolls sideways (" + document.documentElement.scrollWidth + " > " + innerWidth + ")");
          const targets = [
            ...${js(labels)}.map((label) => [label, [...screen.querySelectorAll("label")].find((l) => l.textContent.trim() === label)?.control ?? [...screen.querySelectorAll("label, button")].find((e) => e.textContent.trim() === label)]),
            ...${js(buttons)}.map((text) => [text, [...screen.querySelectorAll("button")].find((b) => b.textContent.trim() === text)]),
          ];
          for (const [what, el] of targets) {
            if (!el) { out.push("no " + what); continue; }
            el.scrollIntoView({ block: "center" });
            await new Promise((done) => setTimeout(done, 150));
            const box = el.getBoundingClientRect();
            if (box.right > innerWidth + 1 || box.left < -1) out.push(what + " runs off the side");
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) out.push(what + " covered by " + (hit ? hit.tagName + "." + hit.className : "nothing"));
          }
          return out;
        })()`);
      await openPlan(bandId, setlistId);
      await atForm(bandId);
      for (const width of [344, 390, 820, 884, 1280]) {
        await site.send("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 844 : 800, deviceScaleFactor: 2, mobile: width < 600 });
        await settle(400);
        problems.push(...(await uncovered(plan(bandId), ["Gig", "Rehearsal", "Start time", "Call time", "Venue", "Address", "Notes"], ["Send to band"])).map((p) => `${width} plan: ${p}`));
        await app.shot(shots && `${shots}/gig-record-plan-${width}.png`);
      }
      await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await app.click("Cancel", form(bandId));
      await openGigs(bandId);
      for (const width of [344, 390, 820, 884, 1280]) {
        await site.send("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 844 : 800, deviceScaleFactor: 2, mobile: width < 600 });
        await settle(400);
        problems.push(...(await uncovered(card(bandId, g1), [], ["Plan again"])).map((p) => `${width} past card: ${p}`));
        await app.shot(shots && `${shots}/gig-record-past-${width}.png`);
      }
      await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      assert.deepEqual(problems, [], "nothing new is covered or runs off the side");
    });

    await check("no page errors", async () => assert.deepEqual(await app.errors(), [], "the page logged no errors"));
  } finally {
    await site.close();
    await worker.dispose();
  }
}

/** The `gigs` table as it shipped before the P2 columns, so a band room saved then can be rebuilt as it was. */
const GIGS_BEFORE = `CREATE TABLE gigs (
  gig_id TEXT PRIMARY KEY, setlist_id TEXT NOT NULL, name TEXT NOT NULL, date TEXT NOT NULL, song_order TEXT NOT NULL,
  lineup TEXT NOT NULL, leader TEXT NOT NULL, backup TEXT, route TEXT NOT NULL, epoch INTEGER NOT NULL, rev INTEGER NOT NULL,
  state TEXT, status TEXT NOT NULL, started_at INTEGER, ended_at INTEGER, secret_rev INTEGER NOT NULL
)`;
const COLUMNS_BEFORE = "gig_id, setlist_id, name, date, song_order, lineup, leader, backup, route, epoch, rev, state, status, started_at, ended_at, secret_rev";

/**
 * A band room saved before the new columns: the Worker runs with saved state, Terry plans a gig with the body phones
 * send today, the Worker stops, the room's `gigs` table is rebuilt in its old shape, and the Worker starts again on it.
 */
async function beforeColumns() {
  const { PASSWORD_PEPPER, passwordPlayer, Phone, startApi, TEST_ORIGIN } = await boxTools();
  const { DatabaseSync } = await import("node:sqlite");
  const state = mkdtempSync(join(tmpdir(), "gig-plan-record-"));
  const players: Player[] = [];
  const onBase = (player: Player, base: string): Player => {
    const phone = new Phone(base);
    phone.cookie = player.cookie;
    const call = phone.call.bind(phone);
    phone.call = (path, body, headers = {}) => call(path, body, { origin: TEST_ORIGIN, ...headers });
    return Object.assign(phone, { name: player.name, handle: player.handle, userId: player.userId });
  };
  try {
    let bandId = "";
    let oldGig = "";
    const first = await startApi({ PASSWORD_PEPPER }, state);
    try {
      const terry = await passwordPlayer(first.base, TEST_ORIGIN, "Terry Bass", "terrybass");
      const mike = await passwordPlayer(first.base, TEST_ORIGIN, "Mike Keys", "mikekeys");
      players.push(terry, mike);
      bandId = (await newBand(terry, "The Old Notes", [mike])).bandId;
      const setlistId = await shareSet(terry, bandId, SONGS, "Old set");
      const made = await terry.call("/api/bands/gig/plan", { bandId, setlistId, name: "Old Friday", date: "2026-11-13" });
      assert.equal(made.status, 200, `Terry plans Old Friday (${js(made.body)})`);
      oldGig = made.body.gig.gigId;
    } finally {
      await first.worker.dispose();
    }
    const rooms = (readdirSync(state, { recursive: true }) as string[]).filter((file) => file.endsWith(".sqlite")).map((file) => join(state, file));
    let rebuilt = 0;
    for (const file of rooms) {
      const db = new DatabaseSync(file);
      try {
        if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gigs'`).get()) continue;
        rebuilt += (db.prepare(`SELECT count(*) AS n FROM gigs`).get() as { n: number }).n;
        db.exec(`BEGIN; ${GIGS_BEFORE.replace("CREATE TABLE gigs", "CREATE TABLE gigs_before")}; INSERT INTO gigs_before (${COLUMNS_BEFORE}) SELECT ${COLUMNS_BEFORE} FROM gigs; DROP TABLE gigs; ALTER TABLE gigs_before RENAME TO gigs; COMMIT;`);
      } finally {
        db.close();
      }
    }
    const second = await startApi({ PASSWORD_PEPPER }, state);
    try {
      const [terry, mike] = players.map((player) => onBase(player, second.base));
      await check("gigs created before the new columns still list, open, start and end", async () => {
        assert.equal(rebuilt, 1, `every room's gigs table was put back in its old shape, holding the one gig (${rooms.length} saved files)`);
        const listed = await mike.call("/api/bands/gig/list", { bandId });
        assert.equal(listed.status, 200, `the band's gigs list (${js(listed.body)})`);
        const upcoming = (listed.body.gigs as View[]).find((view) => view.gig.gigId === oldGig);
        assert.ok(upcoming, "Old Friday is listed");
        assert.deepEqual(detailsOf(upcoming.gig), NO_DETAILS, "as a gig with no time, venue, address or notes");
        assert.equal(upcoming.songCount, 3, "with its 3 songs");
        const opened = await mike.call("/api/bands/gig/open", { bandId, gigId: oldGig });
        assert.equal(opened.status, 200, "it opens");
        assert.deepEqual(detailsOf(opened.body.gig), NO_DETAILS, "and reads the same");
        const pack = await mike.call("/api/bands/gig/pack", { bandId, gigId: oldGig });
        assert.equal(pack.status, 200, `Mike, on the lineup, downloads it to start it (${js(pack.body).slice(0, 200)})`);
        assert.deepEqual([pack.body.songs.length, pack.body.gig.kind], [3, "gig"], "with its songs, as a gig");
        const ended = await terry.call("/api/bands/gig/end", { bandId, gigId: oldGig });
        assert.deepEqual([ended.status, ended.body.gig?.status], [200, "ended"], "Terry ends it");
        const after = await mike.call("/api/bands/gig/list", { bandId });
        assert.deepEqual((after.body.past as View[] | undefined)?.map((view) => view.gig.gigId), [oldGig], "and it moves to Past");
        const again = await terry.call("/api/bands/gig/plan", { bandId, setlistId: pack.body.gig.setlistId, name: "New Friday", date: "2026-11-20", ...DETAILS });
        assert.equal(again.status, 200, "the same room then takes a gig with every new field");
        assert.deepEqual(detailsOf(again.body.gig), DETAILS, "and keeps them");
      });
    } finally {
      await second.worker.dispose();
    }
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

if (!PURE_ONLY) {
  await boxCases();
  await beforeColumns();
}

if (failed > 0) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log(PURE_ONLY ? "check:gig-plan-record pure cases passed" : "check:gig-plan-record passed");
