import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import type { LibraryFile } from "../src/types.ts";
import { openSite } from "./chrome.ts";

const root = new URL("..", import.meta.url).pathname;
const seed = JSON.parse(readFileSync(join(root, "data/library.json"), "utf8")) as LibraryFile;
const FIRE_AWAY = 1;
const THE_MIDDLE = 4;
const CHAIN_BREAKER = 10;
const NO_HALF_STEPPIN = 13;
const GIVE_ME_ONE_REASON = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const js = (value: unknown) => JSON.stringify(value);

let failures = 0;
async function test(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${(error as Error).message}`);
  }
}
function expect(ok: boolean, message: string) {
  if (!ok) throw new Error(message);
}

/** Every piece of text a song shows, with where it sits, so a check can name the song and field it found. */
function texts(value: unknown, at: string): [string, string][] {
  if (typeof value === "string") return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((each, i) => texts(each, `${at}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, each]) => texts(each, `${at}.${key}`));
  return [];
}
const songTexts = seed.songs.flatMap((song) => texts(song, `${song.title}`));

const site = await openSite(root, "check-ux-datamuse-fix");
const { send, evaluate } = site;
const pause = (ms: number) => evaluate(`new Promise((resolve) => setTimeout(resolve, ${ms}))`);
async function until(expression: string, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await evaluate<boolean>(expression)) return;
    await pause(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}
let loads = 0;
async function openSong(id: number) {
  await send("Page.navigate", { url: `${site.origin}/?load=${(loads += 1)}#/songs` });
  await until(`document.readyState === "complete"`, "the app");
  await evaluate(`localStorage.clear()`);
  await send("Page.navigate", { url: `${site.origin}/?load=${(loads += 1)}#/song/${id}` });
  await until(`!!document.querySelector("table.bass tbody tr") && !!document.querySelector("#chord-section .chart-heading")`, `song ${id}`);
}
async function transposeUp() {
  const found = await evaluate<boolean>(`(() => { const b = document.querySelector("button[aria-label='Transpose up']"); b?.click(); return !!b; })()`);
  expect(found, "a Transpose up button");
  await pause(120);
}
const placeHeader = () => evaluate<string>(`document.querySelector("table.bass thead th:last-child").textContent`);
const places = () => evaluate<string[]>(`[...document.querySelectorAll("table.bass tbody tr")].map((tr) => tr.lastElementChild.textContent)`);
const noteLines = () => evaluate<string[]>(`[...document.querySelectorAll("#chord-section .chart-note")].map((p) => p.textContent)`);

await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

await test("bass string numbers are G 1st, D 2nd, A 3rd, E 4th in every song", async () => {
  const number: Record<string, string> = { G: "1", D: "2", A: "3", E: "4" };
  const wrong = songTexts.flatMap(([at, text]) =>
    [...text.matchAll(/\b([EADG]) string \((?:top \/ )?(\d)(?:st|nd|rd|th) string\)/g)].filter((m) => number[m[1]] !== m[2]).map((m) => `${at}: "${m[0]}"`),
  );
  expect(wrong.length === 0, `${wrong.length} wrong string numbers, e.g. ${wrong.slice(0, 3).join("; ")}`);
  expect(songTexts.some(([, text]) => /Open A string \(3rd string\)/.test(text)), "no song names the open A string as the 3rd string");
});

await test("while transposed, a note line that names chords or a key shows the original key hint", async () => {
  await openSong(FIRE_AWAY);
  const outro = (lines: string[]) => lines.find((line) => line.includes("END on A")) ?? "";
  expect(!outro(await noteLines()).includes("original key"), `in its own key the outro note already shows a hint: ${outro(await noteLines())}`);
  await transposeUp();
  const shown = outro(await noteLines());
  expect(shown.includes("| F#m | E | A | D E |"), `the outro note's own words changed: ${shown}`);
  expect(shown.includes("original key (A major)"), `transposed to Bb, the outro note reads "${shown}" with no original key hint`);
  await openSong(THE_MIDDLE);
  await transposeUp();
  const plain = (await noteLines()).find((line) => line.startsWith("Two bars each")) ?? "";
  expect(plain === "Two bars each, then back to the verse chords.", `a note that names no chord got a hint: "${plain}"`);
  const lastNote = (await noteLines()).find((line) => line.startsWith("Last bass note: open D string")) ?? "";
  expect(lastNote.includes("original key (D major)"), `the note naming the open D string reads "${lastNote}" with no hint`);
});

await test("slash-chord bass hints use one wording", async () => {
  const over = songTexts.filter(([, text]) => /\b\d+ over \d+\b/.test(text)).map(([at, text]) => `${at}: "${text}"`);
  expect(over.length === 0, `"N over 3" wording left: ${over.join("; ")}`);
  const chainBreaker = seed.songs.find((song) => song.id === CHAIN_BREAKER)!;
  const slash = Object.fromEntries(chainBreaker.bassNotes.map((row) => [row.chord, row.nashville]));
  expect(slash["G/B"] === "5, 3rd in bass" && slash["C/E"] === "1, 3rd in bass", `Chain Breaker slash rows read ${js(slash)}`);
  await openSong(CHAIN_BREAKER);
  const numbers = await evaluate<string[]>(`[...document.querySelectorAll("table.bass tbody tr")].map((tr) => tr.children[1].textContent)`);
  expect(numbers.includes("5/7 (5, 3rd in bass)") && numbers.includes("1/3 (1, 3rd in bass)"), `the table's Nashville cells read ${js(numbers)}`);
});

await test("while transposed, the bass table's Easiest place column names a place for the transposed note", async () => {
  await openSong(GIVE_ME_ONE_REASON);
  const stored = seed.songs.find((song) => song.id === GIVE_ME_ONE_REASON)!.bassNotes.map((row) => row.position);
  expect(js(await places()) === js(stored), `in its own key the column reads ${js(await places())}, not the stored ${js(stored)}`);
  await transposeUp();
  const giveMe = await places();
  expect(js(giveMe) === js(["Open G string (1st string)", "A string, 3rd fret", "Open D string (2nd string)"]), `F# up to G: G7, C7, D7 places read ${js(giveMe)}`);
  expect(!(await placeHeader()).includes("original key"), `the transposed column still says ${await placeHeader()}`);

  await openSong(FIRE_AWAY);
  await transposeUp();
  const fire = await places();
  expect(
    js(fire) === js(["A string, 1st fret", "E string, 1st fret", "Open G string (1st string)", "D string, 1st fret", "A string, 3rd fret"]),
    `A up to Bb: Bb, F, Gm, Eb, Cm places read ${js(fire)}`,
  );

  await openSong(NO_HALF_STEPPIN);
  await transposeUp();
  const pattern = (await places()).slice(3);
  expect(
    js(pattern) === js(["F: E string, 1st fret; Ab: E string, 4th fret", "Bb: A string, 1st fret; Db: A string, 4th fret", "C: A string, 3rd fret; Eb: D string, 1st fret"]),
    `A up to Bb: the two-note pattern rows read ${js(pattern)}`,
  );
});

await test("a band setlist code that never ends does not show an Ends date", async () => {
  const bundle = await build({
    stdin: {
      contents: `import { createElement } from "react";
        import { createRoot } from "react-dom/client";
        import { ShowCode } from "./src/codes.tsx";
        window.__showCode = (kind, expiresAt) => {
          window.fetch = async () => new Response(JSON.stringify({ kind, code: "c0de", link: location.origin + "/c/c0de", expiresAt }), { status: 200, headers: { "content-type": "application/json" } });
          const box = document.createElement("div");
          document.body.replaceChildren(box);
          createRoot(box).render(createElement(ShowCode, { request: { kind }, words: "Friday set · The Band", share: true, onStopped() {}, onError() {} }));
        };`,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const shownFor = async (kind: string, inMs: number) => {
    await send("Page.navigate", { url: `${site.origin}/?load=${(loads += 1)}` });
    await until(`document.readyState === "complete"`, "a page");
    await evaluate(bundle.outputFiles[0].text);
    await evaluate(`window.__showCode(${js(kind)}, Date.now() + ${inMs})`);
    await until(`document.body.textContent.includes("Stop this code")`, `the ${kind} code`);
    return evaluate<string>(`[...document.querySelectorAll(".account-note")].map((p) => p.textContent).join(" | ")`);
  };
  const never = await shownFor("band-setlist", 10 * 365 * DAY_MS);
  expect(!/Ends/.test(never), `a code ten years out reads "${never}"`);
  const week = await shownFor("band", 7 * DAY_MS);
  expect(/Ends \w{3}, \w{3} \d{1,2}/.test(week), `a band invite a week out reads "${week}"`);
});

await site.close();
process.exit(failures ? 1 : 0);
