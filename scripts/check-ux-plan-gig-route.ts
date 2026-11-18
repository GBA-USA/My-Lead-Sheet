import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SongContent } from "../src/band-library-model.ts";
import { startApi } from "./api-session.ts";
import { appPage, PASSWORD_PEPPER, passwordPlayer, settle } from "./app-page.ts";
import { openSite } from "./chrome.ts";

/**
 * U5, Plan gig as its own screen and the pack downloads (UX-PLAN U5, SCREEN-MAP 4). One case per pass condition, named
 * by it. The cases fix this contract.
 *
 * Plan gig lives at `#/band/<bandId>/plan/<gigId>`: a screen `.band-page[data-band=<bandId>][data-view=plan]` in the
 * app's scroll area, never over a backdrop. It holds the form (`[role=dialog]` titled by its `h2` "Plan gig"): "From
 * <setlist>", Gig name, Date, a switch per member, Leader, Backup leader, Connection for tonight, Send to band and
 * Cancel. The next-gig card's Plan gig and a setlist row's Plan a gig both land there. With no band setlist the screen
 * says "Share a setlist first." and its "Go to Setlists" button lands on `#/band/<bandId>?s=setlists`. Send to band
 * returns to the band page with "Sent <gig> to the band." in `.bands-notice`; Cancel returns and sends nothing.
 *
 * A band setlist's read-only view `.band-setlist-view` shows, when a gig is planned from it, each song with
 * "Downloaded ✓" or a Download button, and Download all at the bottom. Both make one `POST /api/bands/gig/pack`.
 * Offline, the page says "Can't download now · try on Wi-Fi". A member's direct open of the plan route shows
 * "Only a band admin can do that." and no form.
 */

type Reply = { status: number; body: Record<string, any> };
type Player = Awaited<ReturnType<typeof passwordPlayer>>;

const root = new URL("..", import.meta.url).pathname;
const shots = process.env.SHOTS;
const js = (value: unknown) => JSON.stringify(value);
const refusal = (reply: Reply) => [reply.status, reply.body.error];
const gigId = () => `gig_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;
const dayFromNow = (days: number) => {
  const day = new Date();
  day.setDate(day.getDate() + days);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};

const seed = JSON.parse(readFileSync(`${root}data/library.json`, "utf8")) as { songs: (SongContent & { id: number })[] };
const content = ({ id: _id, ...song }: SongContent & { id: number }): SongContent => song;
const FRIDAY = seed.songs.slice(0, 3).map(content);
const SUNDAY = seed.songs.slice(3, 5).map(content);
const LATE = seed.songs.slice(5, 7).map(content);
const WIFI_LINE = "Can't download now · try on Wi-Fi";

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

async function band(admin: Player, name: string, members: Player[]) {
  const bandId = (await admin.call("/api/bands/create", { name })).body.bandId as string;
  const code = (await admin.call("/api/codes", { kind: "band", bandId })).body.code as string;
  for (const member of members) assert.equal((await member.call("/api/bands/join", { code })).status, 200, `${member.name} joins ${name}`);
  return { bandId, code };
}

async function share(who: { call: Player["call"] }, bandId: string, songs: SongContent[], name: string) {
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

let apiBase = "";
const site = await openSite(root, "check-ux-plan-gig-route", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;
try {
  const app = await appPage(site);
  await site.send("Network.enable");
  await site.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      window.__calls = { pack: 0, plan: 0 };
      window.__holdPack = null;
      const fetchNext = window.fetch;
      window.fetch = async (input, init) => {
        const url = String(input?.url ?? input);
        if (url.includes("/api/bands/gig/pack")) { window.__calls.pack += 1; if (window.__holdPack) await window.__holdPack; }
        if (url.includes("/api/bands/gig/plan")) window.__calls.plan += 1;
        return fetchNext(input, init);
      };
    })();`,
  });
  const offline = (on: boolean) => site.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const appCalls = (path: string, body: object) =>
    site.evaluate<Reply>(`fetch(${js(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${js(js(body))} }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const calls = () => site.evaluate<{ pack: number; plan: number }>("({ ...window.__calls })");
  const hash = () => site.evaluate<string>("location.hash");
  const page = (bandId: string, view = "band") => `document.querySelector(${js(`.band-page[data-band="${bandId}"][data-view="${view}"]`)})`;
  const onPage = (bandId: string, view = "band") => app.until(`!!${page(bandId, view)} && !${page(bandId, view)}.textContent.includes("Loading")`, `the ${view} screen of ${bandId}`, 15000);
  const plan = (bandId: string) => page(bandId, "plan");
  const planText = (bandId: string) => site.evaluate<string>(`${plan(bandId)}?.textContent ?? ""`);
  const buttonsIn = (scope: string) => site.evaluate<string[]>(`[...(${scope}?.querySelectorAll("button") ?? [])].filter((b) => b.getClientRects().length > 0).map((b) => b.textContent.trim())`);
  const openBand = async (bandId: string) => {
    await site.evaluate(`location.hash = "#/bands"`);
    await app.until(`!!document.querySelector(".bands-tab")`, "the Bands tab");
    await site.evaluate(`location.hash = ${js(`#/band/${bandId}`)}`);
    await onPage(bandId);
  };
  const section = async (bandId: string, name: string) => {
    await app.click(name, `${page(bandId)}?.querySelector(".band-tabs")`);
    await app.until(`${page(bandId)}?.querySelector(".band-tabs [aria-selected=true]")?.firstChild?.textContent.trim() === ${js(name)}`, `the ${name} section`);
  };
  const openSetlist = async (bandId: string, name: string) => {
    await openBand(bandId);
    await section(bandId, "Setlists");
    await app.until(`[...(${page(bandId)}?.querySelectorAll(".band-library-setlists .band-library-row") ?? [])].some((b) => b.querySelector(".band-library-name")?.textContent.trim() === ${js(name)})`, `the ${name} row`, 15000);
    await site.evaluate(`[...${page(bandId)}.querySelectorAll(".band-library-setlists .band-library-row")].find((b) => b.querySelector(".band-library-name")?.textContent.trim() === ${js(name)}).click()`);
    await onPage(bandId, "setlist");
  };
  const setlistView = (bandId: string) => `${page(bandId, "setlist")}?.querySelector(".band-setlist-view")`;
  const rows = (bandId: string) => site.evaluate<string[]>(`[...(${setlistView(bandId)}?.querySelectorAll("ol li") ?? [])].map((li) => li.textContent.trim())`);
  const atPlan = async (bandId: string) => {
    await app.until(`location.hash.startsWith(${js(`#/band/${bandId}/plan/gig_`)})`, "the Plan gig route", 15000);
    await onPage(bandId, "plan");
  };
  const tapPlanOnCard = async (bandId: string) => {
    await app.until(`!!${page(bandId)}?.querySelector(".next-gig")`, "the next-gig card", 15000);
    await app.click("Plan gig", `${page(bandId)}.querySelector(".next-gig")`);
    await atPlan(bandId);
  };
  const tapPlanOnRow = async (bandId: string, name: string) => {
    await openBand(bandId);
    await section(bandId, "Setlists");
    await app.until(`[...(${page(bandId)}?.querySelectorAll(".band-library-setlists li") ?? [])].some((li) => li.textContent.includes(${js(name)}))`, `the ${name} row`, 15000);
    await app.click("Plan a gig", `[...${page(bandId)}.querySelectorAll(".band-library-setlists li")].find((li) => li.textContent.includes(${js(name)}))`);
    await atPlan(bandId);
  };
  const setField = async (bandId: string, label: string, value: string) => {
    const set = await site.evaluate<boolean>(
      `(() => { const field = [...(${plan(bandId)}?.querySelectorAll("label") ?? [])].find((l) => l.textContent.trim() === ${js(label)})?.control; if (!field) return false; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, ${js(value)}); field.dispatchEvent(new Event("input", { bubbles: true })); field.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
    );
    assert.ok(set, `the ${label} field on the Plan gig screen`);
    await settle();
  };
  const notice = (words: string) => app.until(`(document.querySelector(".bands-notice")?.textContent ?? "").includes(${js(words)})`, `the words ${words}`, 15000);
  const gigsOf = async (who: Player, bandId: string) => ((await who.call("/api/bands/gig/list", { bandId })).body.gigs as { gig: { gigId: string; name: string } }[]).map((item) => item.gig);

  const terry = await passwordPlayer(base, origin, "Terry Bass", "terrybass");
  const mike = await passwordPlayer(base, origin, "Mike Keys", "mikekeys");
  const blue = await band(terry, "The Blue Notes", [mike]);
  const fridaySet = await share(terry, blue.bandId, FRIDAY, "Friday set");
  const sundaySet = await share(terry, blue.bandId, SUNDAY, "Sunday set");
  const lateSet = await share(terry, blue.bandId, LATE, "Late set");
  const pier = gigId();
  const late = gigId();
  const tides = await band(terry, "The Low Tides", []);
  const tidesSet = await share(terry, tides.bandId, FRIDAY, "Tides set");

  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await site.evaluate("Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((done) => setTimeout(done, 20000, false))])");
  if (!(await site.evaluate<boolean>("!!navigator.serviceWorker.controller"))) await site.send("Page.reload");
  await app.until("!!navigator.serviceWorker?.controller", "the service worker to take control of the page", 60000);
  await app.library();

  await check("signed out, the Plan gig route shows Sign in and closing it leaves nothing on screen", async () => {
    await site.evaluate(`location.hash = ${js(`#/band/${blue.bandId}/plan/${gigId()}?setlist=${fridaySet}`)}`);
    await app.until(`(document.querySelector(".bands-tab")?.textContent ?? "").includes("Sign in to see your bands.")`, "the sign-in words on the plan route");
    await app.click("Sign in", `document.querySelector(".bands-tab")`);
    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "start"`, "the sign-in sheet");
    await app.click("✕");
    await app.until(`!document.querySelector(".account-sheet")`, "the sign-in sheet closing");
    assert.equal(await site.evaluate<boolean>(`!!document.querySelector("[role=dialog]")`), false, "nothing holds the screen after closing sign-in");
    await site.evaluate(`location.hash = "#/songs"`);
    await app.until(`!!document.querySelector(".song-list")`, "My Songs after leaving the plan link");
  });

  await app.signUp("Sam Rivera");
  const sam = await site.evaluate<{ userId: string }>(`fetch("/api/me").then((r) => r.json()).then((reply) => reply.account)`);
  assert.equal((await appCalls("/api/bands/join", { code: blue.code })).status, 200, "Sam joins The Blue Notes");
  assert.equal((await terry.call("/api/bands/make-admin", { bandId: blue.bandId, userId: sam.userId })).status, 200, "Terry makes Sam an admin of The Blue Notes");
  assert.equal((await appCalls("/api/bands/join", { code: tides.code })).status, 200, "Sam joins The Low Tides as a member");
  const planned = await terry.call("/api/bands/gig/plan", { bandId: blue.bandId, setlistId: sundaySet, gigId: pier, name: "Saturday at the Pier", date: dayFromNow(6), lineup: [terry.userId, mike.userId], leader: terry.userId });
  assert.equal(planned.status, 200, `Terry plans the Pier gig from the Sunday set without Sam (${js(planned.body)})`);
  const latePlanned = await terry.call("/api/bands/gig/plan", { bandId: blue.bandId, setlistId: lateSet, gigId: late, name: "Late show", date: dayFromNow(9), lineup: [terry.userId, mike.userId], leader: terry.userId });
  assert.equal(latePlanned.status, 200, `Terry plans the Late show from the Late set without Sam (${js(latePlanned.body)})`);

  let sent = "";
  await check("Plan gig opens at its route from the next-gig card and from a setlist row with that setlist named", async () => {
    await openBand(blue.bandId);
    await app.until(`${page(blue.bandId)}?.querySelector(".next-gig")?.dataset.nextGig === ${js(pier)}`, "the Pier gig on the card");
    await tapPlanOnCard(blue.bandId);
    assert.equal(await site.evaluate<boolean>(`!!${plan(blue.bandId)}.closest(".account-backdrop") || !!document.querySelector(".account-backdrop")`), false, "the plan is a screen, not a sheet over the band page");
    assert.equal(await site.evaluate<string>(`${plan(blue.bandId)}.querySelector("[role=dialog] h2")?.textContent.trim() ?? ""`), "Plan gig", "titled Plan gig");
    assert.match(await planText(blue.bandId), /From Sunday set/, "the card's plan starts from the next gig's setlist");
    const fromCard = await hash();
    await site.evaluate(`window.__beforeReload = true; location.reload()`);
    await app.until(`!window.__beforeReload`, "the reload");
    await onPage(blue.bandId, "plan");
    assert.equal(await hash(), fromCard, "a reload keeps the route");
    assert.match(await planText(blue.bandId), /From Sunday set/, "and a direct open renders the same form with no band page before it");

    await tapPlanOnRow(blue.bandId, "Friday set");
    assert.match(await planText(blue.bandId), /From Friday set/, "a setlist row's plan names that setlist");
    assert.ok(!(await planText(blue.bandId)).includes("Sunday set"), "and no other");
    await app.shot(shots && `${shots}/plan-gig-route.png`);
  });

  await check("Send to band returns to the band page with the notice and the card shows the gig", async () => {
    if (!(await site.evaluate<boolean>(`!!${plan(blue.bandId)} && ${plan(blue.bandId)}.textContent.includes("From Friday set")`))) await tapPlanOnRow(blue.bandId, "Friday set");
    sent = (await hash()).match(/\/plan\/([\w-]+)/)![1];
    await setField(blue.bandId, "Gig name", "Friday at the Elks");
    await setField(blue.bandId, "Date", dayFromNow(2));
    await app.click("Send to band", plan(blue.bandId));
    await onPage(blue.bandId);
    assert.match(await hash(), new RegExp(`^#/band/${blue.bandId}(\\?|$)`), "back on the band page");
    await notice("Sent Friday at the Elks to the band.");
    await app.until(`${page(blue.bandId)}.querySelector(".next-gig")?.dataset.nextGig === ${js(sent)}`, "the new gig on the card", 15000);
    assert.match(await site.evaluate<string>(`${page(blue.bandId)}.querySelector(".next-gig").textContent`), /Friday at the Elks/, "the card names it");
    assert.deepEqual((await gigsOf(terry, blue.bandId)).filter((gig) => gig.gigId === sent).map((gig) => gig.name), ["Friday at the Elks"], "the band has the gig under the route's id");
  });

  await check("Cancel returns to the band page and sends nothing", async () => {
    const before = (await gigsOf(terry, blue.bandId)).length;
    await openBand(blue.bandId);
    await tapPlanOnCard(blue.bandId);
    const planCalls = (await calls()).plan;
    await setField(blue.bandId, "Gig name", "Never sent");
    await setField(blue.bandId, "Date", dayFromNow(3));
    await app.click("Cancel", plan(blue.bandId));
    await onPage(blue.bandId);
    assert.match(await hash(), new RegExp(`^#/band/${blue.bandId}(\\?|$)`), "back on the band page");
    assert.equal((await calls()).plan, planCalls, "no plan request left the phone");
    assert.equal((await gigsOf(terry, blue.bandId)).length, before, "and the band has no new gig");
  });

  await check("with no band setlist the screen says Share a setlist first. and its button opens the Setlists section", async () => {
    const empty = (await appCalls("/api/bands/create", { name: "Empty Room" })).body.bandId as string;
    await openBand(empty);
    await app.until(`(${page(empty)}.querySelector(".next-gig")?.textContent ?? "").includes("No gig planned.")`, "No gig planned");
    await tapPlanOnCard(empty);
    assert.match(await planText(empty), /Share a setlist first\./, "the screen says to share a setlist first");
    assert.equal(await site.evaluate<boolean>(`!!${plan(empty)}.querySelector("form")`), false, "with no form to fill");
    await app.click("Go to Setlists", plan(empty));
    await onPage(empty);
    assert.equal(await hash(), `#/band/${empty}?s=setlists`, "the button lands on the band's Setlists");
    await app.until(`${page(empty)}.querySelector(".band-tabs [aria-selected=true]")?.firstChild?.textContent.trim() === "Setlists"`, "the Setlists section selected");
  });

  await check("Download all fetches the pack once and every row shows Downloaded ✓", async () => {
    await openSetlist(blue.bandId, "Sunday set");
    await app.until(`[...(${setlistView(blue.bandId)}?.querySelectorAll("ol li") ?? [])].length === ${SUNDAY.length}`, "the Sunday set's songs");
    assert.ok((await rows(blue.bandId)).every((row) => row.includes("Download") && !row.includes("Downloaded ✓")), `each song offers Download before the pack is here (${js(await rows(blue.bandId))})`);
    const before = (await calls()).pack;
    await app.click("Download all", setlistView(blue.bandId));
    await app.until(`[...${setlistView(blue.bandId)}.querySelectorAll("ol li")].every((li) => li.textContent.includes("Downloaded ✓"))`, "Downloaded ✓ on every row", 15000);
    await settle(1000);
    assert.equal((await calls()).pack - before, 1, "one pack request for the whole setlist");
    await app.shot(shots && `${shots}/setlist-downloaded.png`);
  });

  await check("offline Download shows the Wi-Fi line and no row flips", async () => {
    await openSetlist(blue.bandId, "Late set");
    await app.until(`[...(${setlistView(blue.bandId)}?.querySelectorAll("ol li button") ?? [])].filter((b) => b.textContent.trim() === "Download").length === ${LATE.length}`, "a Download button on each Late set song");
    await offline(true);
    try {
      await site.evaluate(`[...${setlistView(blue.bandId)}.querySelectorAll("ol li button")].find((b) => b.textContent.trim() === "Download").click()`);
      await app.until(`(${page(blue.bandId, "setlist")}?.textContent ?? "").includes(${js(WIFI_LINE)})`, "the Wi-Fi line", 15000);
      await settle(1000);
      const after = await rows(blue.bandId);
      assert.ok(after.length === LATE.length && after.every((row) => row.includes("Download") && !row.includes("Downloaded ✓")), `no row flips to Downloaded ✓ (${js(after)})`);
    } finally {
      await offline(false);
    }
  });

  await check("after Send to band the card shows Pack 0 of N downloaded and fills as receipts arrive", async () => {
    await site.evaluate(`window.__holdPack = new Promise((done) => { window.__releasePack = done; }), true`);
    try {
      await tapPlanOnRow(blue.bandId, "Friday set");
      const brunch = (await hash()).match(/\/plan\/([\w-]+)/)![1];
      await setField(blue.bandId, "Gig name", "Sunday brunch");
      await setField(blue.bandId, "Date", dayFromNow(1));
      await app.click("Send to band", plan(blue.bandId));
      await onPage(blue.bandId);
      const card = `${page(blue.bandId)}.querySelector(".next-gig")`;
      await app.until(`${card}?.dataset.nextGig === ${js(brunch)}`, "the new gig on the card at once", 15000);
      assert.match(await site.evaluate<string>(`${card}.textContent`), new RegExp(`${FRIDAY.length} songs · Pack 0 of ${FRIDAY.length} downloaded`), "the card starts at Pack 0");
      await site.evaluate(`window.__holdPack = null; window.__releasePack()`);
      await app.until(`new RegExp(${js(`Pack ${FRIDAY.length} of ${FRIDAY.length} downloaded`)}).test(${card}.textContent)`, "the card filling once the pack arrives", 15000);
      await section(blue.bandId, "Gigs");
      await app.until(`[...(${page(blue.bandId)}.querySelector(${js(`.gig-card[data-gig="${brunch}"]`)})?.querySelectorAll(".gig-card-lineup li") ?? [])].some((li) => li.textContent.includes("Sam Rivera") && li.textContent.includes("Downloaded ✓"))`, "Sam's receipt on the gig card", 15000);
    } finally {
      await site.evaluate(`window.__releasePack?.(); window.__holdPack = null`);
    }
  });

  await check("a non-admin never sees Plan gig and a direct open of the route shows Only a band admin can do that", async () => {
    await openBand(tides.bandId);
    await app.until(`!!${page(tides.bandId)}.querySelector(".next-gig")`, "the Low Tides card");
    assert.ok(!(await buttonsIn(`${page(tides.bandId)}.querySelector(".next-gig")`)).includes("Plan gig"), "no Plan gig on a member's card");
    await section(tides.bandId, "Gigs");
    assert.ok(!(await buttonsIn(page(tides.bandId))).some((text) => text.startsWith("Plan")), "no Plan button in Gigs");
    await section(tides.bandId, "Setlists");
    await app.until(`(${page(tides.bandId)}.textContent ?? "").includes("Tides set")`, "the Tides set row");
    assert.ok(!(await buttonsIn(page(tides.bandId))).includes("Plan a gig"), "no Plan a gig on a member's setlist rows");
    await site.evaluate(`location.hash = ${js(`#/band/${tides.bandId}/plan/${gigId()}?setlist=${tidesSet}`)}`);
    await onPage(tides.bandId, "plan");
    await app.until(`(${plan(tides.bandId)}?.textContent ?? "").includes("Only a band admin can do that.")`, "the refusal words", 15000);
    assert.equal(await site.evaluate<boolean>(`!!${plan(tides.bandId)}.querySelector("form")`), false, "and no form");
    assert.deepEqual(refusal(await appCalls("/api/bands/gig/plan", { bandId: tides.bandId, setlistId: tidesSet, gigId: gigId(), name: "Sneaky", date: dayFromNow(4) })), [403, "not-allowed"], "the server refuses a member's plan");
  });

  await check("the form's controls are 48 px at 390 and the date field is native", async () => {
    await openBand(blue.bandId);
    await tapPlanOnCard(blue.bandId);
    await settle(500);
    const short = await site.evaluate<string[]>(`[...${plan(blue.bandId)}.querySelectorAll("form button, form select, form input:not([type=checkbox]):not([type=radio]), form label:has(input[type=checkbox]), form label:has(input[type=radio])")]
      .filter((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().height < 47.5)
      .map((el) => el.tagName + " " + el.textContent.trim().slice(0, 30) + " " + Math.round(el.getBoundingClientRect().height))`);
    assert.deepEqual(short, [], "every control on the Plan gig form is at least 48 px tall");
    const date = await site.evaluate<{ type: string; tag: string } | null>(`(() => { const field = [...${plan(blue.bandId)}.querySelectorAll("label")].find((l) => l.textContent.trim() === "Date")?.control; return field ? { type: field.type, tag: field.tagName } : null; })()`);
    assert.deepEqual(date, { type: "date", tag: "INPUT" }, "the Date field is the phone's own date picker");
  });

  await check("at 344, 390, 820, 884 and 1280 the Plan gig heading, date field and Send are uncovered and each connection's line sits under its name", async () => {
    const problems: string[] = [];
    for (const width of [344, 390, 820, 884, 1280]) {
      await site.send("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 844 : 800, deviceScaleFactor: 2, mobile: width < 600 });
      await site.evaluate(`document.getElementById("sheet-scroll")?.scrollTo(0, 0)`);
      await settle(500);
      const found = await site.evaluate<string[]>(`(async () => {
        const screen = ${plan(blue.bandId)};
        if (!screen) return ["no plan screen"];
        const out = [];
        const uncovered = async (el, what, scroll = true) => {
          if (scroll) el.scrollIntoView({ block: "center" });
          await new Promise((done) => setTimeout(done, 150));
          const box = el.getBoundingClientRect();
          const middle = box.top + box.height / 2;
          const inset = Math.min(box.height / 2, box.width / 2);
          for (const [x, y] of [[box.left + inset, middle], [box.left + box.width / 2, middle], [box.right - inset, middle]]) {
            const hit = document.elementFromPoint(x, y);
            if (!hit || !(el === hit || el.contains(hit) || hit.contains(el) && hit.tagName === "LABEL")) out.push(what + " covered by " + (hit ? hit.tagName + "." + hit.className : "nothing"));
          }
        };
        const heading = screen.querySelector("[role=dialog] h2");
        if (heading) await uncovered(heading, "heading", false); else out.push("no heading");
        const date = [...screen.querySelectorAll("label")].find((l) => l.textContent.trim() === "Date")?.control;
        if (date) await uncovered(date, "date field"); else out.push("no date field");
        const send = [...screen.querySelectorAll("button")].find((b) => b.textContent.trim() === "Send to band");
        if (send) await uncovered(send, "Send to band"); else out.push("no Send to band");
        const options = [...screen.querySelectorAll("fieldset label")].filter((l) => l.querySelector("input[type=radio]"));
        if (options.length !== 4) out.push(options.length + " connection choices");
        for (const option of options) {
          const line = option.querySelector("small");
          const name = [...option.childNodes].find((node) => node.nodeType === 3 && node.textContent.trim());
          if (!line || !name) { out.push("a choice without its name and line: " + option.textContent.trim()); continue; }
          const range = document.createRange();
          range.selectNodeContents(name);
          if (line.getBoundingClientRect().top < range.getBoundingClientRect().bottom - 1) out.push(name.textContent.trim() + " runs into its line");
        }
        return out;
      })()`);
      problems.push(...found.map((problem) => `${width}: ${problem}`));
      await app.shot(shots && `${shots}/plan-gig-${width}.png`);
    }
    await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    assert.deepEqual(problems, [], "nothing covers the form and every connection choice reads name over line");
  });

  await check("no page errors", async () => assert.deepEqual(await app.errors(), [], "the page logged no errors"));
} finally {
  await site.close();
  await worker.dispose();
}

if (failed > 0) {
  console.log(`check:ux-plan-gig-route: ${failed} failed`);
  process.exit(1);
}
console.log("check:ux-plan-gig-route passed");
