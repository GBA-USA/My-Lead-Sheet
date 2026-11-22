/**
 * check:routes (C18): the connection setting, the admin's choice for a gig, and the fallback policy.
 *
 * The policy (`src/route-policy.ts`) is a pure function of `{ setting, gigRoute, attempt, now, lastRetry }`, so most of
 * this check is a drills table run with a fake clock, like `check:gig`. Two headless Chrome pages follow: the real app for
 * Settings > Connection across a reload, and a page that mounts the same Connection entry with a gig in progress at 390 px.
 * Routes are Wi-Fi link, Over the internet and the server only (Terry t28u): no relay anywhere.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { Attempt, Link } from "../src/links/link.ts";
import type { LinkRoute, RouteChoice } from "../src/routes.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const js = (value: unknown) => JSON.stringify(value);
const settle = (ms = 250) => new Promise((done) => setTimeout(done, ms));

let failures = 0;
async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${String((error as Error)?.message ?? error).split("\n").slice(0, 6).join("\n     ")}`);
  }
}
function same(actual: unknown, expected: unknown, what: string) {
  if (js(actual) !== js(expected)) throw new Error(`${what}: got ${js(actual)}, want ${js(expected)}`);
}
function truly(ok: unknown, what: string) {
  if (!ok) throw new Error(what);
}

// ---------------------------------------------------------------- words the player sees, from the plan (PLAN.md 7.5, 7.12)

const WIFI_APART = "This Wi-Fi keeps phones apart";
const NO_DIRECT = "No direct path over the internet";
const NOT_ON_WIFI = "This phone isn't on Wi-Fi";
const WORDS = { wifi: "Wi-Fi link", internet: "Over the internet", server: "Through the server" } as const;
const CHOICE_NAMES = ["Auto", "Wi-Fi link", "Over the internet", "Server"];
const CANT_CONNECT = "Can't connect · keeping the beat";
/** No screen shows an id, a clock offset, an epoch, the word follower, or a relay (PLAN.md 7.5, Terry t28u). */
const FORBIDDEN = /\b(ids?|offsets?|epochs?|followers?|relay|relays|turn)\b|[0-9a-f]{8}-[0-9a-f]{4}|\bundefined\b|\bnull\b|\bNaN\b/i;

// ---------------------------------------------------------------- the pure policy, bundled so its imports resolve on Windows and Linux

type Policy = typeof import("../src/route-policy.ts");
async function loadPolicy(): Promise<Policy> {
  const bundled = await build({ entryPoints: [join(root, "src", "route-policy.ts")], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
  const file = join(mkdtempSync(join(tmpdir(), "check-routes-")), "route-policy.mjs");
  writeFileSync(file, bundled.outputFiles[0].text);
  return (await import(pathToFileURL(file).href)) as Policy;
}
let policy: Policy | null = null;
let loadError = "";
try {
  policy = await loadPolicy();
} catch (error) {
  loadError = String((error as Error)?.message ?? error).split("\n")[0];
}
const P = (): Policy => {
  if (!policy) throw new Error(`src/route-policy.ts did not load: ${loadError}`);
  return policy;
};

/** A link the attempt holds, open unless said otherwise. The policy only reads its route and state. */
function link(route: LinkRoute, state: Link["state"] = "open"): Link {
  return { route, state, reason: null, send() {}, onMessage: () => () => {}, ping: () => Promise.reject(new Error("fake")), close() {} };
}
function attempt(chosen: LinkRoute | null, reasons: Attempt["reasons"] = {}, tried: LinkRoute[] = ["wifi", "internet", "server"]): Attempt {
  return { tried, chosen: chosen ? link(chosen) : null, reasons };
}
type In = { setting?: RouteChoice; gigRoute?: RouteChoice | null; attempt: Attempt; now?: number; lastRetry?: number };
const decide = (input: In) => P().decide({ setting: "auto", gigRoute: null, now: 0, lastRetry: 0, ...input });
const strip = (input: In) => P().stripLine(decide(input));
const order = (choice: RouteChoice) => P().schedule(choice).map((step) => step.route);
const startsAt = (choice: RouteChoice) => Object.fromEntries(P().schedule(choice).map((step) => [step.route, step.at]));

const drills: [string, () => void][] = [
  // 1. Auto
  [
    "1a. Auto tries every address at once: the Wi-Fi link and the internet both start at 0 s, the server after 10 s",
    () => {
      same(order("auto"), ["wifi", "internet", "server"], "Auto's order");
      same(startsAt("auto"), { wifi: 0, internet: 0, server: 10_000 }, "when each route starts");
    },
  ],
  [
    "1b. Auto prefers the Wi-Fi link: on it, no reason and no retry",
    () => same(decide({ attempt: attempt("wifi") }), { use: "wifi", word: WORDS.wifi, reason: null, retryAt: null }, "on the Wi-Fi link"),
  ],
  [
    "1c. Auto over the internet says why the Wi-Fi link is not in use and retries it",
    () => same(decide({ attempt: attempt("internet", { wifi: WIFI_APART }), now: 2_000, lastRetry: 0 }), { use: "internet", word: WORDS.internet, reason: WIFI_APART, retryAt: 60_000 }, "over the internet"),
  ],
  [
    "1d. Auto on the server says why the nearest better route failed and retries",
    () =>
      same(decide({ attempt: attempt("server", { wifi: WIFI_APART, internet: NO_DIRECT }), now: 10_000, lastRetry: 0 }), { use: "server", word: WORDS.server, reason: NO_DIRECT, retryAt: 60_000 }, "on the server"),
  ],
  [
    "1e. Auto with nothing open yet is connecting, uses nothing and schedules no retry while the attempt runs",
    () => {
      const out = decide({ attempt: attempt(null, {}, ["wifi", "internet"]), now: 9_999, lastRetry: 0 });
      same([out.use, out.retryAt], [null, null], "use and retryAt while connecting");
      truly(out.word && !Object.values(WORDS).includes(out.word as never), `a connecting word that names no route, got ${js(out.word)}`);
    },
  ],
  [
    "1f. a link that is not open is never used",
    () => {
      const half = { tried: ["wifi", "internet"] as LinkRoute[], chosen: link("wifi", "connecting"), reasons: {} };
      same(decide({ attempt: half }).use, null, "a connecting Wi-Fi link");
      same(decide({ attempt: { ...half, chosen: link("internet", "closed") } }).use, null, "a closed internet link");
    },
  ],

  // 2. forced routes
  [
    "2a. a forced Wi-Fi link gets 5 s, then over the internet gets 8 s, then the server",
    () => {
      same(order("band_wifi"), ["wifi", "internet", "server"], "order");
      same(startsAt("band_wifi"), { wifi: 0, internet: 5_000, server: 13_000 }, "when each route starts");
    },
  ],
  [
    "2b. a forced internet route gets 8 s, then the Wi-Fi link gets 5 s, then the server",
    () => {
      same(order("direct_cell"), ["internet", "wifi", "server"], "order");
      same(startsAt("direct_cell"), { internet: 0, wifi: 8_000, server: 13_000 }, "when each route starts");
    },
  ],
  [
    "2c. a forced server starts on the server, then the others in order",
    () => {
      same(order("server"), ["server", "wifi", "internet"], "order");
      const at = startsAt("server");
      truly(at.server === 0 && at.wifi > 0 && at.internet - at.wifi === 5_000, `server at 0, then the Wi-Fi link for its 5 s, then the internet: ${js(at)}`);
    },
  ],
  [
    "2d. on the forced route there is nothing to get back to; one step down there is",
    () => {
      same(decide({ setting: "direct_cell", attempt: attempt("internet", { wifi: WIFI_APART }) }), { use: "internet", word: WORDS.internet, reason: null, retryAt: null }, "forced internet, on the internet");
      same(decide({ setting: "server", attempt: attempt("server") }), { use: "server", word: WORDS.server, reason: null, retryAt: null }, "forced server, on the server");
      same(decide({ setting: "band_wifi", attempt: attempt("internet", { wifi: WIFI_APART }) }), { use: "internet", word: WORDS.internet, reason: WIFI_APART, retryAt: 60_000 }, "forced Wi-Fi link, over the internet");
      same(decide({ setting: "direct_cell", attempt: attempt("wifi", { internet: NO_DIRECT }) }), { use: "wifi", word: WORDS.wifi, reason: NO_DIRECT, retryAt: 60_000 }, "forced internet, on the Wi-Fi link");
    },
  ],
  [
    "2e. every route failing says Can't connect · keeping the beat",
    () => {
      for (const setting of ["auto", "band_wifi", "direct_cell", "server"] as RouteChoice[]) {
        const out = decide({ setting, attempt: attempt(null, { wifi: WIFI_APART, internet: NO_DIRECT, server: "No signal" }), now: 20_000 });
        same(out.use, null, `${setting}: use`);
        same(P().stripLine(out), CANT_CONNECT, `${setting}: the strip`);
      }
    },
  ],

  // 3. getting back, with a fake clock
  [
    "3a. a phone on a fallback retries the chosen or a better route every 60 s, and asking twice never doubles a retry",
    () => {
      const onServer = attempt("server", { wifi: WIFI_APART, internet: NO_DIRECT });
      same(decide({ attempt: onServer, now: 0, lastRetry: 0 }).retryAt, 60_000, "first retry due");
      same(decide({ attempt: onServer, now: 59_999, lastRetry: 0 }).retryAt, 60_000, "not due a moment before");
      same(decide({ attempt: onServer, now: 60_000, lastRetry: 0 }).retryAt, 60_000, "due at 60 s");
      same(decide({ attempt: onServer, now: 60_000, lastRetry: 60_000 }).retryAt, 120_000, "once retried at 60 s, the next is at 120 s");
      same(decide({ attempt: onServer, now: 60_000, lastRetry: 60_000 }), decide({ attempt: onServer, now: 60_000, lastRetry: 60_000 }), "the same input gives the same answer");
      same(P().retryRoutes("auto", "server"), ["wifi", "internet"], "from the server, Auto retries both better routes");
      same(P().retryRoutes("band_wifi", "internet"), ["wifi"], "a forced Wi-Fi link over the internet retries the Wi-Fi link");
      same(P().retryRoutes("direct_cell", "wifi"), ["internet"], "a forced internet route on the Wi-Fi link retries the internet");
      same(P().retryRoutes("auto", "wifi"), [], "on the best route there is nothing to retry");
    },
  ],
  [
    "3b. make-before-break: the old route stays in use through a retry until the better link is open",
    () => {
      type Tick = { at: number; lastRetry: number; attempt: Attempt; use: LinkRoute; retryAt: number | null };
      const ticks: Tick[] = [
        { at: 0, lastRetry: 0, attempt: attempt("server", { wifi: WIFI_APART, internet: NO_DIRECT }), use: "server", retryAt: 60_000 },
        { at: 60_000, lastRetry: 60_000, attempt: { tried: ["wifi", "internet"], chosen: link("server"), reasons: {} }, use: "server", retryAt: 120_000 },
        { at: 60_500, lastRetry: 60_000, attempt: { tried: ["wifi", "internet"], chosen: link("server"), reasons: {} }, use: "server", retryAt: 120_000 },
        { at: 61_200, lastRetry: 60_000, attempt: { tried: ["wifi", "internet"], chosen: link("internet"), reasons: { wifi: WIFI_APART } }, use: "internet", retryAt: 120_000 },
        { at: 120_000, lastRetry: 120_000, attempt: { tried: ["wifi"], chosen: link("internet"), reasons: {} }, use: "internet", retryAt: 180_000 },
        { at: 121_000, lastRetry: 120_000, attempt: { tried: ["wifi"], chosen: link("wifi"), reasons: {} }, use: "wifi", retryAt: null },
        { at: 400_000, lastRetry: 120_000, attempt: { tried: ["wifi"], chosen: link("wifi"), reasons: {} }, use: "wifi", retryAt: null },
      ];
      for (const tick of ticks) {
        const out = decide({ attempt: tick.attempt, now: tick.at, lastRetry: tick.lastRetry });
        same([out.use, out.retryAt], [tick.use, tick.retryAt], `at ${tick.at / 1000} s`);
      }
    },
  ],

  // 4. the gig
  [
    "4a. in a gig the admin's choice wins over the phone's own setting",
    () => {
      const onServer = attempt("server", { wifi: NOT_ON_WIFI, internet: NO_DIRECT });
      const inGig = decide({ setting: "server", gigRoute: "band_wifi", attempt: onServer, now: 1_000, lastRetry: 0 });
      same([inGig.use, inGig.retryAt], ["server", 60_000], "the admin chose the Wi-Fi link, so the server is a fallback");
      const own = decide({ setting: "server", gigRoute: null, attempt: onServer, now: 1_000, lastRetry: 0 });
      same([own.use, own.reason, own.retryAt], ["server", null, null], "after the gig the phone's Server setting is back");
      same(order("band_wifi")[0], "wifi", "the gig's own schedule starts on its route");
    },
  ],
  [
    "4b. the policy reads the setting and never changes it",
    () => {
      const input = { setting: "direct_cell" as RouteChoice, gigRoute: "server" as RouteChoice, attempt: attempt("internet"), now: 5, lastRetry: 0 };
      const before = js(input);
      P().decide(input);
      same(js(input), before, "the input after deciding");
    },
  ],
  [
    "4c. a gig route this phone cannot use falls back and says why",
    () => {
      const reasons = { ...P().networkReasons("cellular") };
      same(reasons, { wifi: NOT_ON_WIFI }, "a phone on cell data has no Wi-Fi");
      same(P().networkReasons("wifi"), {}, "a phone on Wi-Fi");
      same(P().networkReasons(undefined), {}, "a browser that does not say");
      same(strip({ setting: "auto", gigRoute: "band_wifi", attempt: attempt("internet", reasons) }), `${WORDS.internet} · ${NOT_ON_WIFI}`, "the strip");
    },
  ],

  // 6. the strip
  [
    "6. the strip shows the route and the reason in plain words",
    () => {
      same(strip({ attempt: attempt("internet", { wifi: WIFI_APART }) }), "Over the internet · This Wi-Fi keeps phones apart", "over the internet");
      same(strip({ attempt: attempt("wifi") }), "Wi-Fi link", "on the Wi-Fi link");
      same(strip({ attempt: attempt("server", { wifi: WIFI_APART, internet: NO_DIRECT }) }), "Through the server · No direct path over the internet", "on the server");
      same(P().tonightLine("band_wifi"), "Tonight the admin chose Wi-Fi link", "the gig line");
      same(P().tonightLine("direct_cell"), "Tonight the admin chose Over the internet", "the gig line for the internet");
    },
  ],
  [
    "8a. no policy words contain an id, offset, epoch, follower or relay",
    () => {
      const said: string[] = [];
      const reasons = [{}, { wifi: WIFI_APART }, { wifi: WIFI_APART, internet: NO_DIRECT }, { wifi: WIFI_APART, internet: NO_DIRECT, server: "No signal" }];
      for (const setting of ["auto", "band_wifi", "direct_cell", "server"] as RouteChoice[]) {
        said.push(P().tonightLine(setting));
        for (const chosen of [null, "wifi", "internet", "server"] as (LinkRoute | null)[]) for (const r of reasons) said.push(strip({ setting, attempt: attempt(chosen, r), now: 30_000 }));
      }
      const bad = said.filter((line) => FORBIDDEN.test(line) || !line.trim());
      same(bad, [], "lines with forbidden words or nothing");
    },
  ],
];

// ---------------------------------------------------------------- one table of words: the new files import them, never copy them

async function sourceChecks() {
  await check("5a. the Connection screen and the policy take their route words from src/routes.ts and say nothing of a relay", () => {
    for (const file of ["src/route-policy.ts", "src/connection-setting.tsx"]) {
      const source = readFileSync(join(root, file), "utf8");
      truly(/from "\.\/routes"/.test(source), `${file} imports from ./routes`);
      for (const words of [...Object.values(WORDS), "Works with any Wi-Fi"]) truly(!source.includes(`"${words}`), `${file} copies ${js(words)} instead of importing it`);
      truly(!/relay|turn:/i.test(source), `${file} mentions a relay`);
    }
  });
  await check("5b. leadSheetsConnection is listed in what this phone keeps", () => {
    const kinds = readFileSync(join(root, "src/data-kinds.ts"), "utf8");
    truly(/key: "leadSheetsConnection",\s*place: "phone"/.test(kinds), "a phone entry for leadSheetsConnection in DATA_KINDS");
    const storage = readFileSync(join(root, "src/storage.ts"), "utf8");
    truly(/"leadSheetsConnection"/.test(storage) && /export function loadConnection\b/.test(storage) && /export function saveConnection\b/.test(storage), "storage.ts loads and saves leadSheetsConnection");
  });
}

// ---------------------------------------------------------------- Chrome: the real app, Settings > Connection

type Site = import("./chrome.ts").Site;
const DIALOG = `document.querySelector("[role=dialog]")`;

function pageTools(site: Site) {
  const evaluate = <T>(expression: string) => site.evaluate<T>(expression);
  const until = async (expression: string, what: string, ms = 10_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await settle(100)) if (await evaluate<boolean>(`!!(${expression})`).catch(() => false)) return;
    throw new Error(`timed out waiting for ${what} at ${await evaluate<string>("location.href").catch(() => "?")}`);
  };
  const connectionRow = `[...document.querySelectorAll(".settings button")].find((b) => b.textContent.trim().startsWith("Connection"))`;
  const openConnection = async () => {
    await until(connectionRow, "the Connection row in Settings");
    await evaluate(`${connectionRow}.click()`);
    await until(`${DIALOG} && ${DIALOG}.querySelectorAll("input[type=radio]").length === 4`, "the Connection screen with four choices");
  };
  const rows = () =>
    evaluate<{ name: string; line: string; rating: string; slots: string[]; checked: boolean; disabled: boolean }[]>(`[...${DIALOG}.querySelectorAll("label")].filter((l) => l.querySelector("input[type=radio]")).map((l) => ({
      name: l.querySelector("[data-slot=name]")?.textContent.trim() ?? "",
      line: l.querySelector("[data-slot=line]")?.textContent.trim() ?? "",
      rating: l.querySelector("[data-slot=rating]")?.textContent.trim() ?? "missing",
      slots: [...l.querySelectorAll("[data-slot]")].map((s) => s.dataset.slot),
      checked: l.querySelector("input").checked,
      disabled: l.querySelector("input").matches(":disabled"),
    }))`);
  const choose = async (name: string) => {
    const ok = await evaluate<boolean>(
      `(() => { const l = [...${DIALOG}.querySelectorAll("label")].find((x) => x.querySelector("[data-slot=name]")?.textContent.trim() === ${js(name)}); l?.querySelector("input").click(); return !!l; })()`,
    );
    truly(ok, `a ${name} choice to tap`);
    await settle();
  };
  const close = async () => {
    await evaluate(`${DIALOG}?.querySelector("[aria-label=Close]")?.click()`);
    await until(`!${DIALOG}`, "the Connection screen to close");
  };
  const words = () => evaluate<string>(`document.body.innerText`);
  return { evaluate, until, openConnection, rows, choose, close, words };
}

async function appCase(openSite: typeof import("./chrome.ts").openSite, startApi: typeof import("./api-session.ts").startApi, pepper: string) {
  let apiBase = "";
  const site = await openSite(root, "check-routes-app", () => apiBase);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER: pepper });
  apiBase = base;
  const page = pageTools(site);
  try {
    await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await site.send("Page.enable");
    const load = async (hash: string) => {
      await site.send("Page.navigate", { url: `${origin}/${hash}` });
      await page.until(`document.readyState === "complete" && document.querySelector(".shell-header")`, `${hash} to load`, 20_000);
    };
    await load("#/settings");

    await check("5. the setting persists across reload (Settings > Connection, signed out)", async () => {
      await page.evaluate(`localStorage.setItem("leadSheetsTextScale", "2")`);
      await load("#/settings");
      const personal = `[localStorage.getItem("leadSheetsTextScale"), localStorage.getItem("leadSheetsMetronome")]`;
      const kept = await page.evaluate<(string | null)[]>(personal);
      await page.openConnection();
      const first = await page.rows();
      same(first.map((row) => row.name), CHOICE_NAMES, "the four choices");
      same(first.find((row) => row.checked)?.name, "Auto", "the default");
      await page.choose("Server");
      same(await page.evaluate("localStorage.getItem('leadSheetsConnection')"), "server", "the stored choice");
      await page.close();
      await site.send("Page.reload");
      await page.until(`document.readyState === "complete" && document.querySelector(".settings")`, "Settings after the reload", 20_000);
      await page.openConnection();
      same((await page.rows()).find((row) => row.checked)?.name, "Server", "the choice after the reload");
      same(await page.evaluate(personal), kept, "text size and metronome settings untouched by a route change");
      same(kept[0], "2", "the text size set before");
      await page.close();
    });

    await check("5c. a stored choice this build does not know (an old relay value) opens as Auto", async () => {
      await page.evaluate(`localStorage.setItem("leadSheetsConnection", "relay")`);
      await site.send("Page.reload");
      await page.until(`document.readyState === "complete" && document.querySelector(".settings")`, "Settings after the reload", 20_000);
      await page.openConnection();
      same((await page.rows()).find((row) => row.checked)?.name, "Auto", "the choice shown");
      await page.close();
    });

    await check("8b. Settings and the Connection screen outside a gig show no id, offset, epoch, follower or relay, and show the rating of a phone with no history", async () => {
      await page.openConnection();
      const rows = await page.rows();
      same(rows.map((row) => row.slots), rows.map(() => ["name", "line", "rating"]), "each row is name, line, rating");
      truly(rows.every((row) => row.rating.startsWith("Not tried yet")), `each rating slot reads Not tried yet on a phone with no history: ${js(rows.map((row) => row.rating))}`);
      truly(rows.every((row) => row.line.length > 0 && !row.disabled), "every choice has its line and can be picked");
      const text = await page.evaluate<string>(`${DIALOG}.innerText`);
      truly(!FORBIDDEN.test(text), `forbidden words on the Connection screen: ${js(text.match(FORBIDDEN)?.[0])}`);
      truly(!/Tonight the admin chose/.test(text), "no gig line outside a gig");
      await page.close();
      const row = await page.evaluate<string>(`[...document.querySelectorAll(".settings button")].find((b) => b.textContent.trim().startsWith("Connection")).innerText`);
      truly(!FORBIDDEN.test(row) && /Server|Auto|Wi-Fi link|Over the internet/.test(row), `the Settings row names the choice in plain words: ${js(row)}`);
    });
  } finally {
    await site.close();
    await worker.dispose();
  }
}

// ---------------------------------------------------------------- Chrome: the same entry during a gig, at 390 px

function writeGigPage() {
  const logs = join(root, ".verify-logs");
  mkdirSync(logs, { recursive: true });
  const dir = mkdtempSync(join(logs, "check-routes-page-"));
  const from = (file: string) => relative(dir, join(root, file)).replaceAll("\\", "/");
  writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>routes</title><div id="root"></div><script type="module" src="./page.tsx"></script>`);
  writeFileSync(
    join(dir, "page.tsx"),
    `import { createRoot } from "react-dom/client";
import "${from("src/styles.css")}";
import { ConnectionEntry, setTonight } from "${from("src/connection-setting.tsx")}";
import { decide, stripLine } from "${from("src/route-policy.ts")}";

const fake = (route) => ({ route, state: "open", reason: null, send() {}, onMessage: () => () => {}, ping: () => Promise.reject(), close() {} });
const line = stripLine(decide({ setting: "server", gigRoute: "band_wifi", attempt: { tried: ["wifi", "internet"], chosen: fake("internet"), reasons: { wifi: ${js(WIFI_APART)} } }, now: 3000, lastRetry: 0 }));
window.gig = {
  start: () => setTonight({ route: "band_wifi", line }),
  end: () => setTonight(null),
};
createRoot(document.getElementById("root")).render(<div className="settings"><ConnectionEntry /></div>);
`,
  );
  return dir;
}

async function gigCase(openSite: typeof import("./chrome.ts").openSite) {
  const dir = writeGigPage();
  const site = await openSite(dir, "check-routes-gig");
  const page = pageTools(site);
  try {
    await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await site.send("Page.navigate", { url: `${site.origin}/` });
    await page.until(`window.gig && document.querySelector(".settings button")`, "the page", 20_000);
    await page.evaluate(`localStorage.setItem("leadSheetsConnection", "server")`);
    await site.send("Page.reload");
    await page.until(`window.gig && document.querySelector(".settings button")`, "the page after the reload", 20_000);

    await check("7. during a gig the Connection screen says 'Tonight the admin chose Wi-Fi link' and the choices are greyed out (390 px)", async () => {
      await page.evaluate("window.gig.start()");
      await page.openConnection();
      const text = await page.words();
      truly(text.includes("Tonight the admin chose Wi-Fi link"), `the gig line on screen: ${js(text)}`);
      const rows = await page.rows();
      same(rows.map((row) => row.disabled), [true, true, true, true], "every choice is disabled");
      same(rows.find((row) => row.checked)?.name, "Wi-Fi link", "the admin's choice is the one shown");
      const grey = await page.evaluate<boolean>(
        `[...${DIALOG}.querySelectorAll("label")].filter((l) => l.querySelector("input[type=radio]")).every((l) => { let el = l; while (el && el !== document.body) { if (Number(getComputedStyle(el).opacity) < 1) return true; el = el.parentElement; } return false; })`,
      );
      truly(grey, "the choices are drawn greyed out");
      const fits = await page.evaluate<{ page: number; right: number }>(`({ page: document.documentElement.scrollWidth, right: ${DIALOG}.getBoundingClientRect().right })`);
      truly(fits.page <= 390 && fits.right <= 390, `the screen fits 390 px: ${js(fits)}`);
      await page.choose("Over the internet");
      same(await page.evaluate("localStorage.getItem('leadSheetsConnection')"), "server", "a tap on a greyed choice changes nothing");
    });

    await check("6b. during a gig the Connection screen names the route in use and why", async () => {
      const text = await page.words();
      truly(text.includes("Over the internet · This Wi-Fi keeps phones apart"), `the route and reason on screen: ${js(text)}`);
    });

    await check("8c. the Connection screen during a gig shows no id, offset, epoch, follower or relay", async () => {
      const text = await page.words();
      truly(!FORBIDDEN.test(text), `forbidden words on screen: ${js(text.match(FORBIDDEN)?.[0])}`);
      await page.close();
    });

    await check("4d. after the gig the phone's own setting returns, and leadSheetsConnection never changed", async () => {
      await page.evaluate("window.gig.end()");
      await page.openConnection();
      const rows = await page.rows();
      same(rows.find((row) => row.checked)?.name, "Server", "the phone's own choice");
      same(rows.map((row) => row.disabled), [false, false, false, false], "every choice can be picked again");
      truly(!(await page.words()).includes("Tonight the admin chose"), "no gig line after the gig");
      same(await page.evaluate("localStorage.getItem('leadSheetsConnection')"), "server", "the stored choice");
      await page.close();
    });
  } finally {
    await site.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- run

for (const [name, run] of drills) await check(name, run);
await sourceChecks();

const { openSite } = await import("./chrome.ts");
const { startApi } = await import("./api-session.ts");
const { PASSWORD_PEPPER } = await import("./app-page.ts");
for (const [name, run] of [
  ["the real app", () => appCase(openSite, startApi, PASSWORD_PEPPER)],
  ["the gig page", () => gigCase(openSite)],
] as const) {
  try {
    await run();
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} could not run\n     ${String((error as Error)?.message ?? error).split("\n").slice(0, 4).join("\n     ")}`);
  }
}

console.log(failures ? `check:routes: ${failures} failed` : "check:routes: all passed");
process.exit(failures ? 1 : 0);
