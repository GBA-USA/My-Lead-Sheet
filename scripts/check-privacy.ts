import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";
import { build } from "vite";
import { DATA_KINDS, PRIVACY_HREF } from "../src/data-kinds.ts";
import { CONTACT_PLACEHOLDER } from "./build-privacy.ts";
import { openSite } from "./chrome.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${message}`);
  }
}

check(existsSync(join(root, "src")) && existsSync(join(root, "worker")), `the privacy scan root is a real folder that holds src and worker (root is ${root})`);
if (failures > 0) {
  console.error("check:privacy failed: the scan root is not the repo folder, so no stored key can be read");
  process.exit(1);
}

const SONG_SEARCH_LINE = "When you search for a song, the app sends the title you typed to MusicBrainz (musicbrainz.org), a public music catalog.";
const LIVE_GIG_LINE = "A live-gig link between bandmates, and Test now and Test with a bandmate in the connection setting, ask stun.cloudflare.com for the public network address of this phone.";
const PASTE_LOOKUP_LINE = "When you paste a chart with no title or artist, the app looks it up on MusicBrainz. It sends the chart's title, or, when the chart has none, up to two of its sung lines.";

/** What the real `pasteLookup` sends the catalog for a pasted chart with no title, by a searcher that finds nothing. */
async function sentForUntitledPaste(): Promise<string[]> {
  const built = await bundle({ entryPoints: [join(root, "src", "song-search.ts")], bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" });
  const { pasteLookup } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
  const sent: string[] = [];
  const searcher = { titled: (asked: string, report: (state: { kind: string; query: string }) => void) => (sent.push(asked), report({ kind: "none", query: asked })) };
  const sections = [
    { heading: "Verse", lines: [{ chords: [], lyrics: "walking down the lonely road" }] },
    { heading: "Chorus", lines: [{ chords: [], lyrics: "hold me close tonight" }, { chords: [], lyrics: "hold me close tonight" }] },
  ];
  pasteLookup(searcher, { title: "", artist: "" }, sections, () => {});
  return sent;
}
const untitledPasteSends = await sentForUntitledPaste();

/** The STUN servers the real Test with a bandmate hands the phone's peer connection, with the config Settings > Connection opens it with. */
async function stunAskedByBandmateTest(): Promise<string[]> {
  const entry = 'export { showSide } from "./src/sync-bandmate.tsx"; export { FREE_STUN } from "./src/sync-history.ts";';
  const built = await bundle({ stdin: { contents: entry, resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic", logLevel: "silent" });
  const asked: string[] = [];
  const quiet = { addEventListener() {}, removeEventListener() {}, close() {} };
  const fakes: Record<string, unknown> = {
    window: globalThis,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    RTCPeerConnection: class {
      localDescription = null;
      constructor(config: { iceServers?: { urls: string | string[] }[] }) {
        for (const server of config?.iceServers ?? []) asked.push(...[server.urls].flat());
      }
      addEventListener() {}
      removeEventListener() {}
      createDataChannel() { return quiet; }
      async setRemoteDescription() {}
      async createAnswer() { return { type: "answer", sdp: "v=0" }; }
      async setLocalDescription() {}
      async addIceCandidate() {}
      close() {}
      async getStats() { return new Map(); }
    },
  };
  const saved = Object.keys(fakes).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(fakes)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    const { showSide, FREE_STUN } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
    let hear: (message: unknown) => void = () => {};
    const room = { listen: (listener: typeof hear) => ((hear = listener), () => {}), send() {}, close() {} };
    const stop = showSide({ room, config: { stun: FREE_STUN, testMs: 1000, timeoutMs: 1000 }, onStatus() {}, onDone() {} });
    hear({ kind: "intro", from: "bandmate", body: { a: "internet:privacy-check", sdp: { type: "offer", sdp: "v=0" } } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
  } finally {
    for (const [name, was] of saved) {
      if (was) Object.defineProperty(globalThis, name, was);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
  return asked;
}
const bandmateTestStun = await stunAskedByBandmateTest();

const STUN_LINE_COVERS = ["connection-setting.tsx", "gig-live.tsx"];
const stunUsers = filesUnder(join(root, "src"))
  .filter((file) => !file.endsWith("sync-history.ts") && /\bFREE_STUN\b/.test(readFileSync(file, "utf8")))
  .map((file) => file.slice(join(root, "src").length + 1).replaceAll("\\", "/"))
  .sort();
check(
  stunUsers.join(",") === STUN_LINE_COVERS.join(","),
  `every src file that uses FREE_STUN is one whose paths the privacy page's STUN line names (found ${stunUsers.join(", ")}; name a new one's path in scripts/build-privacy.ts, then add it to STUN_LINE_COVERS)`,
);

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).map((file) => join(dir, file)).filter((file) => statSync(file).isFile());
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((found) => found[1].replace(/\.$/, ""));
}

/** Every localStorage key and IndexedDB database under src/, and every table and Durable Object storage key under worker/. */
function storedKeys(tree: string): Set<string> {
  const keys = new Set<string>();
  for (const file of filesUnder(join(tree, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const key of matches(text, /indexedDB\.open\(\s*["'`]([^"'`$]+)/g)) keys.add(key);
    if (!text.includes("localStorage")) continue;
    for (const key of matches(text, /\bconst\s+\w*_KEY\s*=\s*["'`]([^"'`$]+)["'`]/g)) keys.add(key);
    for (const key of matches(text, /localStorage\.(?:getItem|setItem|removeItem)\(\s*["'`]([^"'`$]+)/g)) keys.add(key);
  }
  for (const file of filesUnder(join(tree, "worker"))) {
    const text = readFileSync(file, "utf8");
    for (const key of matches(text, /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?(\w+)/gi)) keys.add(key);
    for (const key of matches(text, /storage\.(?:get|put|delete)\(\s*["'`]([^"'`$]+)/g)) keys.add(key);
  }
  return keys;
}

const fixture = mkdtempSync(join(tmpdir(), "privacy-fixture-"));
const seed = (path: string, text: string) => {
  mkdirSync(dirname(join(fixture, path)), { recursive: true });
  writeFileSync(join(fixture, path), text);
};
seed("src/app.ts", 'export const THEME_KEY = "leadSheetsTheme";\nlocalStorage.setItem(`leadSheetsDraft.${id}`, "1");\n');
seed("src/clock.ts", 'const db = indexedDB.open("leadSheetsClock", 1);\n');
check(storedKeys(fixture).size === 3, "a tree with no worker/ folder still scans src/");
seed("worker/directory.ts", 'sql.exec(`CREATE TABLE IF NOT EXISTS users (user_id TEXT)`);\nawait this.ctx.storage.put("relay_budget", budget);\n');
seed("worker/schema.sql", "create table google_logins (google_sub text);\n");
const fixtureKeys = [...storedKeys(fixture)].sort().join(",");
check(
  fixtureKeys === "google_logins,leadSheetsClock,leadSheetsDraft,leadSheetsTheme,relay_budget,users",
  `the scan finds seeded localStorage, IndexedDB, table and storage keys (found ${fixtureKeys})`,
);
rmSync(fixture, { recursive: true, force: true });

const described = new Set(DATA_KINDS.map((kind) => kind.key));
const stored = storedKeys(root);
check(stored.size > 0, "the scan finds the app's localStorage keys");
for (const key of stored) check(described.has(key), `stored key "${key}" is described in src/data-kinds.ts`);
for (const key of described) check(stored.has(key), `data kind "${key}" is still stored somewhere`);

const contact = `privacy check contact ${process.pid}`;
process.env.VITE_PRIVACY_CONTACT = contact;
const site = await openSite(root, "privacy");
try {
  const page = await fetch(`${site.origin}/${PRIVACY_HREF}`);
  const html = await page.text();
  check(page.ok && /text\/html/.test(page.headers.get("content-type") ?? ""), `the built site serves /${PRIVACY_HREF} as HTML (${page.status})`);
  check(html.includes(`<p id="contact">${contact}</p>`), "the privacy page shows the contact from VITE_PRIVACY_CONTACT");
  for (const kind of DATA_KINDS) check(html.includes(kind.what), `the privacy page describes ${kind.key}`);
  check(/name, your email address/.test(html) && /Deleting your data/.test(html), "the privacy page covers Google sign-in and deleting data");
  check(html.includes(SONG_SEARCH_LINE), "the privacy page says song search sends the typed title to MusicBrainz (musicbrainz.org)");
  check(html.includes(LIVE_GIG_LINE), "the privacy page says a live-gig link, Test now and Test with a bandmate ask stun.cloudflare.com for the public network address of this phone");
  const stunLine = /<p>[^<]*stun\.cloudflare\.com[^<]*<\/p>/.exec(html)?.[0] ?? "";
  check(
    bandmateTestStun.some((url) => url.includes("stun.cloudflare.com")) === stunLine.includes("Test with a bandmate"),
    `the privacy page's STUN line names Test with a bandmate exactly when it asks stun.cloudflare.com (asked ${JSON.stringify(bandmateTestStun)}, line "${stunLine}")`,
  );
  check(
    (untitledPasteSends.length > 0) === html.includes(PASTE_LOOKUP_LINE),
    `the privacy page says a pasted chart with no title sends its sung lines to MusicBrainz exactly when the app sends them (sent ${JSON.stringify(untitledPasteSends)})`,
  );
  check(!/\/\/|stun:/i.test(html), "the privacy page names outside hosts as plain text, with no web or stun: address");

  await site.send("Page.navigate", { url: `${site.origin}/#/songs` });
  let opened = "";
  for (let tries = 0; tries < 100 && !opened.endsWith(`/${PRIVACY_HREF}`); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    opened = await site
      .evaluate<string>(
        `(() => { const link = document.querySelector('a[href="${PRIVACY_HREF}"]'); if (link && location.hash) link.click(); return location.pathname; })()`,
      )
      .catch(() => "");
  }
  check(opened.endsWith(`/${PRIVACY_HREF}`), `My Songs links to the privacy page (ended on ${opened || "nothing"})`);
  check((await site.evaluate<string>("document.getElementById('contact')?.textContent ?? ''").catch(() => "")) === contact, "the link opens the built privacy page");
} finally {
  await site.close();
}

delete process.env.VITE_PRIVACY_CONTACT;
const plain = mkdtempSync(join(tmpdir(), "privacy-plain-"));
await build({ root, logLevel: "silent", build: { outDir: plain, emptyOutDir: true } });
const plainPage = join(plain, PRIVACY_HREF);
const plainHtml = existsSync(plainPage) ? readFileSync(plainPage, "utf8") : "";
check(plainHtml.includes(`<p id="contact">${CONTACT_PLACEHOLDER}</p>`) && !plainHtml.includes("@"), "a build without VITE_PRIVACY_CONTACT shows placeholder text, not an address");
const plainContact = /<p id="contact">([^<]*)<\/p>/.exec(plainHtml)?.[1] ?? "";
check(
  /\bBrian Pruitt\b/.test(plainContact) && /\b(?:to be added|pending)\b/.test(plainContact) && !plainContact.includes("@") && !CONTACT_PLACEHOLDER.includes("@"),
  `a build without VITE_PRIVACY_CONTACT names Brian Pruitt as the contact with details still to be added, and no address (reads "${plainContact}")`,
);
rmSync(plain, { recursive: true, force: true });

if (failures > 0) {
  console.error(`check:privacy failed (${failures})`);
  process.exit(1);
}
console.log(`check:privacy passed: ${stored.size} stored keys described, /${PRIVACY_HREF} built with the contact var and linked from My Songs`);
