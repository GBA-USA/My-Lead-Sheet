import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startApi } from "./api-session.ts";
import { PASSWORD_PEPPER } from "./app-page.ts";
import { openSite } from "./chrome.ts";

const root = new URL("..", import.meta.url).pathname;
const WIDTH = 390;
let failures = 0;

let apiBase = "";
const site = await openSite(root, "check-ux-shell-settings", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;

const js = (value: unknown) => JSON.stringify(value);
const settle = (ms = 250) => new Promise((done) => setTimeout(done, ms));

class Failed extends Error {}
let problems: string[] = [];
const expect = (ok: boolean, detail: string) => {
  if (!ok) problems.push(detail);
  return ok;
};
async function test(name: string, run: () => Promise<void>) {
  problems = [];
  try {
    await run();
  } catch (error) {
    problems.push(error instanceof Failed ? error.message : String(error instanceof Error ? error.message : error));
  }
  if (problems.length) failures += 1;
  console.log(problems.length ? `FAIL ${name}: ${problems.join("; ")}` : `ok   ${name}`);
}

async function until(expression: string, what: string, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await settle(100)) if (await site.evaluate<boolean>(expression)) return;
  throw new Failed(`timed out waiting for ${what} at ${await site.evaluate<string>("location.hash")}`);
}
const evaluate = <T>(expression: string) => site.evaluate<T>(expression);
const SETTINGS = `document.querySelector(".settings")`;
const SHEET = `document.querySelector("[role=dialog]")`;
async function tap(text: string, scope = "document") {
  const found = await evaluate<boolean>(
    `(() => { const el = [...(${scope}?.querySelectorAll("button, a") ?? [])].find((b) => (b.textContent.trim() === ${js(text)} || b.getAttribute("aria-label") === ${js(text)}) && !b.disabled); el?.click(); return !!el; })()`,
  );
  if (!found) throw new Failed(`no ${text} to tap at ${await evaluate<string>("location.hash")}`);
  await settle();
}
const pressed = (group: string, scope = "document") =>
  evaluate<string[]>(`[...(${scope}?.querySelector(${js(`[role=group][aria-label="${group}"]`)})?.querySelectorAll("button[aria-pressed=true]") ?? [])].map((b) => b.textContent.trim())`);
const stored = (key: string) => evaluate<string | null>(`localStorage.getItem(${js(key)})`);
const text = (selector: string) => evaluate<string>(`document.querySelector(${js(selector)})?.textContent?.trim() ?? ""`);

async function load(hash: string) {
  await site.send("Page.navigate", { url: `${origin}/${hash}` });
  await site.send("Page.reload");
  await until(`!!document.querySelector(".shell-header") && document.readyState === "complete"`, `${hash} to load`, 15000);
  await settle(400);
}
async function freshPhone(hash = "#/songs") {
  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await until(`document.readyState === "complete"`, "the page");
  await evaluate(`localStorage.clear()`);
  await load(hash);
}
const gear = `document.querySelector(".shell-header [aria-label=Settings]")`;
async function openSettings() {
  await until(`!!${gear}`, "the gear in the header");
  await evaluate(`${gear}.click()`);
  await until(`location.hash.startsWith("#/settings") && !!${SETTINGS}`, "Settings");
}
const settingsRows = () => evaluate<string[]>(`[...(document.querySelector(".settings [role=group][aria-label=Account]")?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim())`);
const step = () => evaluate<string>(`document.querySelector(".account-sheet")?.dataset.step ?? ""`);
const atStep = (name: string) => until(`document.querySelector(".account-sheet")?.dataset.step === ${js(name)}`, `the ${name} sign-in screen`);
const sheetText = () => evaluate<string>(`${SHEET}?.innerText ?? ""`);
const closeSheet = () => tap("Close", SHEET);
const apiCalls = () => evaluate<number>(`performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/api/")).length`);
async function typeInto(label: string, value: string) {
  await evaluate(`[...document.querySelectorAll("[role=dialog] label")].find((l) => l.textContent.trim() === ${js(label)}).control.focus()`);
  await site.send("Input.insertText", { text: value });
}
const sheetFont = () => evaluate<string>(`getComputedStyle(document.querySelector("article.sheet")).fontSize`);
const ROUTES = ["#/songs", "#/setlists", "#/bands", "#/song/10", "#/live/1/0", "#/settings"];

try {
  await site.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 844, deviceScaleFactor: 2, mobile: true });
  await site.send("Page.enable");
  await site.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__errors = []; addEventListener("error", (e) => __errors.push(String(e.message))); addEventListener("unhandledrejection", (e) => __errors.push(String(e.reason)));
      window.__wake = { requests: 0, released: 0 };
      Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: (type) => {
        __wake.requests += 1;
        const sentinel = { type, released: false, release() { if (!this.released) { this.released = true; __wake.released += 1; } return Promise.resolve(); }, addEventListener() {}, removeEventListener() {} };
        return Promise.resolve(sentinel);
      } } });`,
  });
  await site.send("WebAuthn.enable");
  await site.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await test("the header, document.title and the manifest say Groovist, and no screen says My Lead Sheet", async () => {
    await freshPhone("#/songs");
    expect((await text(".shell-header .shell-title")) === "Groovist", `the list header says ${await text(".shell-header .shell-title")}`);
    expect((await evaluate<string>("document.title")) === "Groovist", `the list title is ${await evaluate<string>("document.title")}`);
    await load("#/song/10");
    expect((await evaluate<string>("document.title")) === "Chain Breaker — Groovist", `a song's title is ${await evaluate<string>("document.title")}`);
    const manifest = await evaluate<{ name: string; short_name: string }>(`fetch(document.querySelector("link[rel=manifest]").href).then((r) => r.json())`);
    expect(manifest.name === "Groovist" && manifest.short_name === "Groovist", `the manifest says ${manifest.name} / ${manifest.short_name}`);
    const built = await evaluate<string>(`fetch("/").then((r) => r.text())`);
    expect(/<title>Groovist<\/title>/.test(built), "index.html's <title> says Groovist");
    for (const hash of ROUTES) {
      await load(hash);
      const shown = await evaluate<string>("document.body.innerText");
      expect(!/My Lead Sheet|Lead Sheets/.test(shown), `${hash} says the old name`);
    }
    const files = ["src", "worker"].flatMap((dir) => readdirSync(join(root, dir)).filter((name) => /\.tsx?$/.test(name)).map((name) => `${dir}/${name}`));
    const oldName = files.filter((file) => file.startsWith("src/") && readFileSync(join(root, file), "utf8").includes("My Lead Sheet"));
    expect(oldName.length === 0, `phone code still says My Lead Sheet in ${oldName.join(", ")}`);
  });

  await test("the wake lock is requested on every screen and no screen-on control exists anywhere", async () => {
    await freshPhone("#/songs");
    await evaluate(`localStorage.setItem("leadSheetsKeepAwake", "false")`);
    for (const hash of ROUTES) {
      await load(hash);
      const wake = await evaluate<{ requests: number; released: number }>("window.__wake");
      expect(wake.requests >= 1 && wake.requests - wake.released >= 1, `${hash} loaded with ${wake.requests} requests, ${wake.released} released`);
    }
    await load("#/songs");
    for (const hash of ROUTES) {
      await evaluate(`location.hash = ${js(hash)}`);
      await settle(400);
      const wake = await evaluate<{ requests: number; released: number }>("window.__wake");
      expect(wake.requests - wake.released >= 1, `the lock is let go on the way to ${hash}`);
      const pill = await evaluate<string[]>(`[...document.querySelectorAll("button, [role=switch], label")].map((el) => el.textContent.trim()).filter((t) => /screen on|keep (the )?screen|stay awake/i.test(t))`);
      expect(pill.length === 0 && !(await evaluate<boolean>(`/Screen on/i.test(document.body.innerText)`)), `${hash} still has a screen-on control (${pill.join(", ")})`);
    }
  });

  await test("each theme chip sets the attribute, shows its sample, and survives a reload", async () => {
    await freshPhone("#/songs");
    await openSettings();
    const looks = new Set<string>();
    for (const [label, theme] of [["Day", "day"], ["Red-green safe", "cb-rg"], ["Blue-yellow safe", "cb-by"], ["High contrast", "contrast"], ["Stage", "stage"]]) {
      await tap(label, `document.querySelector(".settings [role=group][aria-label=Theme]")`);
      const attribute = await evaluate<string>("document.documentElement.dataset.theme");
      expect(attribute === theme, `${label} set data-theme=${attribute}`);
      expect((await pressed("Theme")).join() === label, `${label} is not the pressed chip (${await pressed("Theme")})`);
      expect((await stored("leadSheetsTheme")) === theme, `${label} saved ${await stored("leadSheetsTheme")}`);
      const look = await evaluate<string | null>(`(() => {
        const sample = document.querySelector(".settings [aria-label='Theme sample']");
        if (!sample || sample.getBoundingClientRect().height === 0) return null;
        return [sample, ...sample.querySelectorAll("*")].map((el) => { const s = getComputedStyle(el); return s.color + s.backgroundColor; }).join("|");
      })()`);
      expect(look !== null, `${label} shows no sample`);
      if (look) looks.add(look);
    }
    expect(looks.size === 5, `the sample looks the same in some themes (${looks.size} looks for 5 themes)`);
    await tap("Day", `document.querySelector(".settings [role=group][aria-label=Theme]")`);
    await load("#/settings");
    expect((await evaluate<string>("document.documentElement.dataset.theme")) === "day", "Day did not survive a reload");
    expect((await pressed("Theme")).join() === "Day", `after a reload the pressed chip is ${await pressed("Theme")}`);
    await tap("Stage", `document.querySelector(".settings [role=group][aria-label=Theme]")`);
  });

  await test("Text size in Settings and A− A+ on a song move the same value", async () => {
    await freshPhone("#/songs");
    await openSettings();
    await tap("Larger text", SETTINGS);
    expect((await stored("leadSheetsTextScale")) === "2", `Settings A+ stored ${await stored("leadSheetsTextScale")}`);
    const settingsLarger = await evaluate<string>(`getComputedStyle(document.querySelector(".settings [aria-label='Text size sample']")).fontSize`);
    await evaluate(`location.hash = "#/song/10"`);
    await until(`!!document.querySelector("article.sheet")`, "the song");
    const songLarger = await sheetFont();
    expect(songLarger === settingsLarger && songLarger !== "16px", `the song shows ${songLarger} after Settings showed ${settingsLarger}`);
    await tap("Smaller text", `document.querySelector(".controls")`);
    await tap("Smaller text", `document.querySelector(".controls")`);
    expect((await stored("leadSheetsTextScale")) === "0", `the song's A− stored ${await stored("leadSheetsTextScale")}`);
    const songSmaller = await sheetFont();
    await evaluate(`history.back()`);
    await openSettingsIfNeeded();
    const settingsSmaller = await evaluate<string>(`getComputedStyle(document.querySelector(".settings [aria-label='Text size sample']")).fontSize`);
    expect(settingsSmaller === songSmaller, `Settings shows ${settingsSmaller} after the song went to ${songSmaller}`);
    expect(await evaluate<boolean>(`!!document.querySelector(".settings [aria-label='Smaller text']")?.disabled`), "Settings A− is not off at the smallest size");
  });

  await test("Chords default applies to a song never switched and not to one that was", async () => {
    await freshPhone("#/song/2");
    await tap("Notes", `document.querySelector("[role=group][aria-label='Notes or Nashville']")`);
    await evaluate(`location.hash = "#/songs"`);
    await openSettings();
    await tap("Nashville", `document.querySelector(".settings [role=group][aria-label=Chords]")`);
    expect((await pressed("Chords", SETTINGS)).join() === "Nashville", `the Chords default shows ${await pressed("Chords", SETTINGS)}`);
    await evaluate(`location.hash = "#/song/10"`);
    await until(`!!document.querySelector("article.sheet")`, "song 10");
    expect((await pressed("Notes or Nashville")).join() === "Nashville", `a song never switched opens in ${await pressed("Notes or Nashville")}`);
    expect((await stored("leadSheetsNotation.10")) === null, "opening a song wrote its notation");
    await evaluate(`location.hash = "#/song/2"`);
    await settle(400);
    expect((await pressed("Notes or Nashville")).join() === "Notes", `a song switched to Notes opens in ${await pressed("Notes or Nashville")}`);
    await load("#/song/10");
    expect((await pressed("Notes or Nashville")).join() === "Nashville", "the Chords default did not survive a reload");
  });

  await test("Transpose default −1 opens a song one semitone down, and the readout tap returns to the default", async () => {
    await freshPhone("#/songs");
    await openSettings();
    await tap("Transpose default down", SETTINGS);
    const shown = await evaluate<string>(`document.querySelector(".settings [role=group][aria-label=Transpose]")?.innerText ?? ""`);
    expect(/−1|-1/.test(shown), `the Transpose default shows ${shown}`);
    await evaluate(`location.hash = "#/song/10"`);
    await until(`!!document.querySelector(".key-name")`, "the key readout");
    expect((await text(".key-name")) === "B major", `C major opened as ${await text(".key-name")}`);
    await tap("Transpose up", `document.querySelector(".controls")`);
    expect((await text(".key-name")) === "C major", `Transpose up shows ${await text(".key-name")}`);
    await tap("Original Key", `document.querySelector(".controls")`);
    expect((await text(".key-name")) === "B major", `Original Key went to ${await text(".key-name")}, not the default`);
    await evaluate(`location.hash = "#/live/1/0"`);
    await settle(400);
    const live = await text(".key-name");
    await evaluate(`location.hash = "#/songs"`);
    expect(live !== "" && live !== (await liveKeyWritten()), `a setlist song opened in its written key (${live})`);
  });

  await test("signed out, Settings shows Sign in and nothing is trapped", async () => {
    await freshPhone("#/songs");
    await openSettings();
    expect((await settingsRows()).join() === "Sign in", `signed out the account rows are ${await settingsRows()}`);
    await tap("Sign in", SETTINGS);
    await until(`!!document.querySelector(".account-sheet")`, "the sign-in sheet");
    await closeSheet();
    expect(await evaluate<boolean>(`!document.querySelector("[role=dialog]") && location.hash.startsWith("#/settings") && !!${SETTINGS}`), "closing the sign-in sheet does not return to Settings");
    await tap("Sign in", SETTINGS);
    await until(`!!document.querySelector(".account-sheet")`, "the sign-in sheet again");
    await site.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await settle();
    expect(await evaluate<boolean>(`!document.querySelector("[role=dialog]")`), "Escape does not close the sign-in sheet");
    await tap("Back", `document.querySelector(".shell-header")`);
    await until(`location.hash === "#/songs" && !!document.querySelector(".song-row")`, "Songs after Back");
    await openSettings();
  });

  await test("Forgot your login? opens the placeholder and Back returns, with no network call", async () => {
    await freshPhone("#/songs");
    await openSettings();
    await tap("Sign in", SETTINGS);
    await atStep("start");
    await settle(500);
    const before = await apiCalls();
    await tap("Forgot your login?", SHEET);
    await atStep("forgot");
    const line = "Password and login reset is coming. For now, sign in another way you set up, or create a new account.";
    expect((await sheetText()).includes(line), `the placeholder says ${await sheetText()}`);
    await tap("Back", SHEET);
    await atStep("start");
    await settle(300);
    expect((await apiCalls()) === before, `the placeholder made ${(await apiCalls()) - before} API calls`);
    await tap("Sign in with a password", SHEET);
    await atStep("password");
    await tap("Forgot your login?", SHEET);
    await atStep("forgot");
    await tap("Back", SHEET);
    await atStep("password");
    await closeSheet();
  });

  await test("Create account ends on the add-a-password nudge", async () => {
    await freshPhone("#/songs");
    await openSettings();
    await tap("Sign in", SETTINGS);
    await atStep("start");
    await tap("New here? Create an account", SHEET);
    await atStep("create");
    await typeInto("Your name (what bandmates see)", "Sam Rivera");
    await tap("Sign in with Face ID or fingerprint", SHEET);
    await until(`["nudge", "codes", "account"].includes(document.querySelector(".account-sheet")?.dataset.step)`, "the end of Create account", 8000);
    expect((await step()) === "nudge", `Create account ended on ${await step()}`);
    expect((await sheetText()).includes("Add a password too, so you can sign in on a new phone"), `the nudge says ${await sheetText()}`);
    await tap("Add a password", SHEET);
    await atStep("set-password");
    expect((await text(".account-sheet h2")) === "Add a password", `Add a password opened ${await text(".account-sheet h2")}`);
    await tap("Back", SHEET);
    await atStep("account");
  });

  await test("no backup-code link, screen or section exists, and both backup-code routes return 404", async () => {
    await until(`!!document.querySelector(".account-sheet")`, "the signed-in account sheet");
    if ((await step()) !== "account") throw new Failed("the account sheet is not open from the last case");
    expect(!/backup code/i.test(await sheetText()), `the account screen mentions backup codes: ${await sheetText()}`);
    const routes = await evaluate<number[]>(`Promise.all([
      fetch("/api/me/backup-codes", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.status),
      fetch("/api/auth/backup-code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "samrivera", code: "0000-0000-0000" }) }).then((r) => r.status),
    ])`);
    expect(routes.join() === "404,404", `signed in, the backup-code routes answer ${routes.join(" and ")}`);
    await tap("Sign out", SHEET);
    await atStep("start");
    expect(!/backup code/i.test(await sheetText()), `the sign-in screen mentions backup codes: ${await sheetText()}`);
    await tap("Sign in with a password", SHEET);
    await atStep("password");
    expect(!/backup code/i.test(await sheetText()), `the password screen mentions backup codes: ${await sheetText()}`);
    const signedOut = await evaluate<number>(`fetch("/api/auth/backup-code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "samrivera", code: "0000-0000-0000" }) }).then((r) => r.status)`);
    expect(signedOut === 404, `signed out, /api/auth/backup-code answers ${signedOut}`);
    await tap("Back", SHEET);
    await atStep("start");
    await tap("Sign in with Face ID or fingerprint", SHEET);
    await atStep("account");
    await closeSheet();
  });

  await test("the Account, Friends and Messages rows open their sheets and close back to Settings", async () => {
    await until(`!!${SETTINGS} || !!${gear}`, "Settings or a list");
    if (!(await evaluate<boolean>(`!!${SETTINGS}`))) await openSettings();
    await until(`${js(["Account", "Friends", "Messages"].join())} === [...(document.querySelector(".settings [role=group][aria-label=Account]")?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()).join()`, "the signed-in account rows");
    const account = await evaluate<string>(`document.querySelector(".settings [role=group][aria-label=Account]")?.innerText ?? ""`);
    expect(account.includes("Signed in as Sam Rivera · @samrivera"), `the Account group says ${account}`);
    for (const [row, sheet] of [["Account", ".account-sheet"], ["Friends", ".friends-sheet"], ["Messages", ".chat-sheet"]]) {
      await tap(row, `document.querySelector(".settings [role=group][aria-label=Account]")`);
      await until(`!!document.querySelector(${js(sheet)})`, `the ${row} sheet`);
      await closeSheet();
      expect(await evaluate<boolean>(`!document.querySelector("[role=dialog]") && location.hash.startsWith("#/settings") && !!${SETTINGS}`), `closing ${row} does not return to Settings`);
    }
  });

  await test("the gear opens Settings from Songs, Setlists, Bands and the band page", async () => {
    for (const tab of ["songs", "setlists", "bands"]) {
      await evaluate(`location.hash = ${js(`#/${tab}`)}`);
      await settle(400);
      await openSettings();
      await tap("Back", `document.querySelector(".shell-header")`);
      expect((await evaluate<string>("location.hash")) === `#/${tab}`, `Back from Settings opened from ${tab} went to ${await evaluate<string>("location.hash")}`);
    }
    const made = await evaluate<number>(`fetch("/api/bands/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "The Low Tides" }) }).then((r) => r.status)`);
    expect(made === 200, `making a band answered ${made}`);
    await load("#/bands");
    await until(`[...document.querySelectorAll(".song-row")].some((b) => b.textContent.includes("The Low Tides"))`, "the band in the Bands tab", 8000);
    await evaluate(`[...document.querySelectorAll(".song-row")].find((b) => b.textContent.includes("The Low Tides")).click()`);
    await until(`document.querySelector(".bands-sheet")?.dataset.view === "band" && !!document.querySelector(".bands-sheet [aria-label=Settings]")`, "the band page's gear", 8000);
    await evaluate(`document.querySelector(".bands-sheet [aria-label=Settings]").click()`);
    await until(`location.hash.startsWith("#/settings") && !!${SETTINGS} && !document.querySelector("[role=dialog]")`, "Settings from the band page");
    await tap("Back", `document.querySelector(".shell-header")`);
    expect((await evaluate<string>("location.hash")) === "#/bands", `Back from Settings opened on the band page went to ${await evaluate<string>("location.hash")}`);
  });

  await test("every switch and row is 48 px", async () => {
    for (const signedIn of [true, false]) {
      if (!signedIn) await freshPhone("#/songs");
      await load("#/settings");
      await until(`!!${SETTINGS}`, "Settings");
      if (signedIn) await until(`/Signed in as/.test(document.querySelector(".settings").innerText)`, "the signed-in Settings");
      const small = await evaluate<string[]>(`[...document.querySelectorAll(".settings button, .settings a, .settings [role=switch]")].map((el) => [el, el.getBoundingClientRect()]).filter(([, box]) => box.height < 48 || box.left < 0 || box.right > ${WIDTH}).map(([el, box]) => (el.textContent.trim() || el.getAttribute("aria-label")) + " " + Math.round(box.width) + "x" + Math.round(box.height) + " at " + Math.round(box.left))`);
      const count = await evaluate<number>(`document.querySelectorAll(".settings button, .settings a").length`);
      expect(count >= 15, `${signedIn ? "signed in" : "signed out"} Settings has only ${count} controls`);
      expect(small.length === 0, `${signedIn ? "signed in" : "signed out"}, under 48 px or off the 390 px screen: ${small.join(", ")}`);
      expect(await evaluate<boolean>(`document.documentElement.scrollWidth <= ${WIDTH}`), "Settings scrolls sideways");
    }
  });

  const errors = await evaluate<string[]>("window.__errors");
  if (errors.length) {
    failures += 1;
    console.log(`FAIL no page errors: ${errors.join("; ")}`);
  }
} finally {
  await site.close();
  await worker.dispose();
}

async function openSettingsIfNeeded() {
  await settle(400);
  if (!(await evaluate<boolean>(`!!${SETTINGS}`))) await openSettings();
}

async function liveKeyWritten() {
  return evaluate<string>(`(() => { const l = JSON.parse(localStorage.getItem("leadSheetsLibrary")); const set = l.setlists.find((s) => s.id === 1); return l.songs.find((s) => s.id === set.songIds[0]).keyLabel; })()`);
}

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("check:ux-shell-settings passed");
