import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { build as bundle } from "esbuild";
import type { LibraryFile } from "../src/types.ts";
import { startApi } from "./api-session.ts";
import { PASSWORD_PEPPER, passwordPlayer } from "./app-page.ts";
import { chordAnchors, type Row } from "./chord-anchors.ts";
import { openSite } from "./chrome.ts";

const root = new URL("..", import.meta.url).pathname;
execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", "worker"], { cwd: root, stdio: "inherit" });

const seed = JSON.parse(readFileSync(join(root, "data/library.json"), "utf8")) as LibraryFile;
const CHAIN_BREAKER = 10;
const TAKE_ME_OUT = 5;
const WIDTHS = [390, 1280];
/** U3b took the metronome block (158.38 px at 390, 142.19 px at 1280 with its margin) off the card, above the chart. */
const FIRST_CHORD_IN_CARD: Record<number, { x: number; y: number }> = { 390: { x: 109.59, y: 1312.64 }, 1280: { x: 121.59, y: 727.86 } };
const js = (value: unknown) => JSON.stringify(value);
const settle = (ms = 250) => new Promise((done) => setTimeout(done, ms));

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
type Model = typeof import("../src/song-version.ts") & typeof import("../src/storage.ts");
let model: Model | null = null;
let missing = "";
try {
  const built = await bundle({
    stdin: { contents: 'export * from "./src/song-version.ts"; export * from "./src/storage.ts";', resolveDir: root, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  model = (await import(`data:text/javascript,${encodeURIComponent(built.outputFiles[0].text)}`)) as Model;
} catch (error) {
  missing = `the Save model does not build (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
}
const needModel = (): Model => {
  if (!model) throw new Failed(missing);
  return model;
};

class Failed extends Error {}
let failures = 0;
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
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length) failures += 1;
  console.log(problems.length ? `FAIL ${name}: ${problems.join("; ")}` : `ok   ${name}`);
}

const marks = (...at: [number, number][]) => at.map(([time, progress]) => ({ at: time, progress }));
const TAUGHT = { name: "V1", bpm: 78, marks: marks([0, 0], [12.5, 0.2], [30, 0.2], [190, 1]) };
const TEMPO_MAPPED = { ...TAUGHT, name: "Slow intro", tempo: [{ at: 0, bpm: 72 }, { at: 40, bpm: 78 }] };
const LEARNED_V2 = {
  name: "V2",
  bpm: 76,
  marks: marks([0, 0], [188.4, 1]),
  tempo: [{ at: 0, bpm: 76 }],
  learned: { beatsPerBar: 4, downbeat: 1.92, beats: [1.92, 2.71, 3.5, 4.29], sections: [{ heading: "VERSE 1", at: 0, heard: ["G", null, "C"] }, { heading: "CHORUS", at: 42.1 }], vocals: [{ start: 3.1, end: 20.4 }] },
};
const LEARNED = { name: "V1", bpm: 78, marks: marks([0, 0], [3, 0], [197, 1]), learned: { beatsPerBar: 4, downbeat: 3, beats: [3, 3.77], sections: [{ heading: "INTRO", at: 3 }], vocals: [] } };
const SUNDAY = { name: "Sunday", bpm: 78, marks: marks([0, 0], [40, 0.2], [205, 1]) };

const STAND_INS = `(() => {
  window.__errors = [];
  addEventListener("error", (event) => window.__errors.push(String(event.message)));
  addEventListener("unhandledrejection", (event) => window.__errors.push(String(event.reason)));
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => ({ getTracks: () => [{ stop() {} }] }) });
  AudioContext.prototype.createMediaStreamSource = () => ({ connect() {} });
  AudioContext.prototype.createScriptProcessor = function () {
    return (window.__mic = { rate: this.sampleRate, connect() {}, onaudioprocess: null });
  };
  window.__playSong = (parts) => {
    const { rate } = window.__mic;
    const beat = 0.5;
    const beats = parts * 8 * 4;
    const samples = new Float32Array(Math.round((2 + beats * beat + 2) * rate));
    for (let k = 0; k < beats; k++) {
      const from = Math.round((2 + k * beat) * rate);
      const loud = [0.2, 0.5, 0.3, 0.6][Math.floor(k / 32) % 4];
      for (let i = 0; i < 0.3 * rate; i++) samples[from + i] += loud * Math.sin((2 * Math.PI * 60 * i) / rate) * Math.exp(-i / (0.08 * rate));
    }
    for (let at = 0; at < samples.length; at += 4096) {
      const chunk = samples.subarray(at, at + 4096);
      window.__mic.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } });
    }
  };
})()`;

let apiBase = "";
const site = await openSite(root, "check-ux-sheet-controls-save", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", PASSWORD_PEPPER });
apiBase = base;
const evaluate = <T>(expression: string) => site.evaluate<T>(expression);

async function until(expression: string, what: string, ms = 6000) {
  for (const end = Date.now() + ms; Date.now() < end; await settle(100)) if (await evaluate<boolean>(expression)) return;
  throw new Failed(`timed out waiting for ${what} at ${await evaluate<string>("location.hash")}`);
}
const HEADER = `document.querySelector(".shell-header")`;
const CONTROLS = `document.querySelector(".controls")`;
const DIALOG = `document.querySelector("[role=dialog]")`;
const buttonIn = (scope: string, text: string) =>
  `[...(${scope}?.querySelectorAll("button") ?? [])].find((b) => (b.textContent.trim() === ${js(text)} || b.getAttribute("aria-label") === ${js(text)}) && b.getClientRects().length > 0)`;
const has = (text: string, scope = "document") => evaluate<boolean>(`!!${buttonIn(scope, text)}`);
async function tap(text: string, scope = "document") {
  const found = await evaluate<boolean>(`(() => { const el = ${buttonIn(scope, text)}; if (!el || el.disabled) return false; el.click(); return true; })()`);
  if (!found) throw new Failed(`no ${text} to tap at ${await evaluate<string>("location.hash")}`);
  await settle();
}
const keyName = () => evaluate<string>(`document.querySelector(".controls .key-name")?.textContent?.trim() ?? ""`);
const stored = (key: string) => evaluate<string | null>(`localStorage.getItem(${js(key)})`);
const VERSIONS = `leadSheetsScrollVersions.${CHAIN_BREAKER}`;
const DRAFT = `leadSheetsSongDraft.${CHAIN_BREAKER}`;
const REF = `local/${CHAIN_BREAKER}` as const;
const REFUSAL = "Couldn't save. Free some space and try again.";
const FULL_PHONE = `Storage.prototype.setItem = function () { throw new DOMException("full", "QuotaExceededError"); }`;
const FULL_FOR_VERSIONS = `(() => {
  const real = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (String(key).startsWith("leadSheetsScrollVersions")) throw new DOMException("full", "QuotaExceededError");
    return real.call(this, key, value);
  };
})()`;
const alerts = () => evaluate<string>(`[...document.querySelectorAll("[role=alert]")].filter((el) => el.getClientRects().length > 0).map((el) => el.textContent.trim()).join(" | ")`);
/** Copies the phone's stored drafts into the node store, so `loadDraft` reads what the phone holds whatever the key shape. Returns their keys. */
async function phoneDrafts() {
  const entries = await evaluate<[string, string][]>(`Object.entries(localStorage).filter(([key]) => key.startsWith("leadSheetsSongDraft"))`);
  store.clear();
  for (const [key, value] of entries) store.set(key, value);
  return entries.map(([key]) => key);
}
/** Puts the node store's drafts on the phone in place of its own. */
async function putDrafts() {
  const mine = [...store];
  const theirs = await evaluate<string[]>(`Object.keys(localStorage).filter((key) => key.startsWith("leadSheetsSongDraft"))`);
  await evaluate(`${theirs.map((key) => `localStorage.removeItem(${js(key)})`).join("; ")}; ${mine.map(([key, value]) => `localStorage.setItem(${js(key)}, ${js(value)})`).join("; ")}; 0`);
}
const chip = () => evaluate<string>(`document.querySelector(".shell-header button.version-chip")?.textContent?.trim() ?? ""`);
const saveShown = () => has("Save", HEADER);
const revertShown = () => has("Revert", HEADER);
const scrollOn = () => evaluate<boolean>(`!!document.querySelector(".scroll-pill")?.textContent.includes("On")`);

async function load(hash: string) {
  await site.send("Page.navigate", { url: `${origin}/${hash}` });
  await until(`location.hash === ${js(hash.split("?")[0])} || location.hash === ${js(hash)}`, `the address ${hash}`);
  await site.send("Page.reload");
  await until(`!!document.querySelector(".shell-header") && document.readyState === "complete"`, `${hash} to load`, 15000);
  await evaluate(`document.fonts.ready.then(() => true)`);
  await settle(400);
}
async function freshPhone(hash = `#/song/${CHAIN_BREAKER}`, setup = "") {
  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await until(`document.readyState === "complete"`, "the page");
  await evaluate(`localStorage.clear(); ${setup}`);
  await load(hash);
}
async function go(hash: string) {
  await evaluate(`location.hash = ${js(hash)}`);
  await settle(400);
}
const width = async (pixels: number) => site.send("Emulation.setDeviceMetricsOverride", { width: pixels, height: pixels < 600 ? 844 : 800, deviceScaleFactor: 2, mobile: pixels < 600 });
async function saveAs(name: string) {
  await tap("Save", HEADER);
  await tap("Save as…");
  await until(`!!${DIALOG}?.querySelector("input[aria-label='Version name']")`, "the Save as name field");
  await evaluate(`(() => {
    const input = ${DIALOG}.querySelector("input[aria-label='Version name']");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${js(name)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await tap("Save", DIALOG);
}
async function openChooser() {
  await tap("Scroll settings", CONTROLS);
  await until(`!!${DIALOG}`, "the Scroll sheet");
  await tap("Learn this song", DIALOG);
  await until(`${DIALOG}?.querySelector("h2")?.textContent === "Learn this song"`, "the Learn chooser");
}
const chooserRows = () =>
  evaluate<{ text: string; disabled: boolean }[]>(`[...(${DIALOG}?.querySelectorAll(".learn-row") ?? [])].map((row) => ({ text: row.innerText.replace(/\\s+/g, " ").trim(), disabled: !!row.querySelector("button")?.disabled }))`);
const boxes = (selector: string) =>
  evaluate<{ name: string; group: number; x: number; y: number; w: number; h: number }[]>(`(() => {
    const groups = [...document.querySelectorAll("[role=group]")];
    return [...document.querySelectorAll(${js(selector)})].filter((el) => el.getClientRects().length > 0).map((el) => { const r = el.getBoundingClientRect(); return { name: el.getAttribute("aria-label") || el.textContent.trim(), group: groups.indexOf(el.closest("[role=group]")), x: r.x, y: r.y, w: r.width, h: r.height }; });
  })()`);
const SONG_CONTROLS = ".controls button, .controls input, .shell-header .text-size button, .shell-header .song-line button";

async function signIn(name: string, handle: string) {
  const player = await passwordPlayer(base, origin, name, handle);
  const [cookieName, cookieValue] = player.cookie.split(/=(.*)/s);
  await site.send("Network.setCookie", { name: cookieName, value: cookieValue, url: origin, httpOnly: true, secure: true, sameSite: "Lax" });
  return player;
}

try {
  await width(390);
  await site.send("Page.enable");
  await site.send("Network.enable");
  await site.send("Page.addScriptToEvaluateOnNewDocument", { source: STAND_INS });

  await test("a song with no changes shows no Save and no Revert", async () => {
    const { loadDraft } = needModel();
    await freshPhone();
    expect(!(await saveShown()) && !(await revertShown()), "Save or Revert shows on an untouched song");
    expect(loadDraft(null, `local/${CHAIN_BREAKER}`) === null && (await stored(DRAFT)) === null, "an untouched song has a stored draft");
    await tap("Notes", `document.querySelector("[role=group][aria-label='Notes or Nashville']")`);
    expect(!(await saveShown()), "tapping the notation already chosen shows Save");
  });

  await test("transposing shows Save and Revert, Revert returns the key and hides both", async () => {
    await freshPhone();
    const original = await keyName();
    await tap("Transpose up", CONTROLS);
    expect((await keyName()) !== original, `the key still reads ${original} after Transpose up`);
    expect((await saveShown()) && (await revertShown()), "Save and Revert do not both show after transposing");
    await tap("Revert", HEADER);
    expect((await keyName()) === original, `Revert left the key at ${await keyName()}, not ${original}`);
    expect(!(await saveShown()) && !(await revertShown()), "Save or Revert still shows after Revert");
    expect((await stored(DRAFT)) === null, "Revert left a draft stored");
  });

  await test("Save as with a name makes a version, selects it, shows the chip, and hides Save", async () => {
    await freshPhone();
    expect((await chip()) === "", "a chip shows before any version exists");
    await tap("Transpose up", CONTROLS);
    await tap("Save", HEADER);
    expect(await has("Save to this version"), "the Save menu has no Save to this version row");
    expect(await evaluate<boolean>(`!!${buttonIn("document", "Save to this version")}?.disabled`), "Save to this version is on with no version yet");
    await tap("Save as…");
    const offered = await evaluate<string>(`${DIALOG}?.querySelector("input[aria-label='Version name']")?.value ?? ""`);
    expect(offered === "V1", `the name field offers ${offered}, not V1`);
    await tap("Cancel", DIALOG);
    await saveAs("Low set");
    const { loadSongVersions } = needModel();
    store.clear();
    store.set(VERSIONS, (await stored(VERSIONS)) ?? "");
    const saved = loadSongVersions(`local/${CHAIN_BREAKER}`);
    expect(saved.versions.length === 1 && saved.versions[0].name === "Low set" && saved.versions[0].semitones === 1 && saved.selected === 0, `stored ${js(saved)}`);
    expect((await chip()) === "Low set ▾", `the chip reads ${await chip()}`);
    expect(!(await saveShown()) && !(await revertShown()), "Save or Revert still shows after Save as");
  });

  await test("a second change then Save to this version writes it and the chip name is unchanged", async () => {
    await tap("Transpose up", CONTROLS);
    expect(await saveShown(), "a second change does not show Save");
    await tap("Save", HEADER);
    await tap("Save to this version");
    const { loadSongVersions } = needModel();
    store.set(VERSIONS, (await stored(VERSIONS)) ?? "");
    const saved = loadSongVersions(`local/${CHAIN_BREAKER}`);
    expect(saved.versions.length === 1 && saved.versions[0].semitones === 2, `stored ${js(saved.versions)}`);
    expect((await chip()) === "Low set ▾", `the chip reads ${await chip()}`);
    expect(!(await saveShown()), "Save still shows after Save to this version");
  });

  await test("the draft persists across leaving the song and reload, and Save shows again", async () => {
    await freshPhone();
    await tap("Transpose up", CONTROLS);
    await tap("Transpose up", CONTROLS);
    const moved = await keyName();
    await go("#/songs");
    await go(`#/song/${CHAIN_BREAKER}`);
    expect((await keyName()) === moved && (await saveShown()), `after leaving, the key reads ${await keyName()} (want ${moved}) and Save shows: ${await saveShown()}`);
    await load(`#/song/${CHAIN_BREAKER}`);
    expect((await keyName()) === moved && (await saveShown()) && (await revertShown()), `after a reload, the key reads ${await keyName()} and Save shows: ${await saveShown()}`);
  });

  await test("Delete on the only version hides the chip and Revert goes to the defaults", async () => {
    await freshPhone();
    const original = await keyName();
    await tap("Transpose up", CONTROLS);
    await saveAs("Only");
    await tap("Only ▾", HEADER);
    await tap("Delete Only…");
    await tap("Delete", HEADER);
    expect((await chip()) === "", `the chip still reads ${await chip()}`);
    const left = JSON.parse((await stored(VERSIONS)) ?? "{}");
    expect((left.versions ?? []).length === 0, `versions are still stored: ${js(left)}`);
    await tap("Transpose down", CONTROLS);
    await tap("Revert", HEADER);
    expect((await keyName()) === original && !(await saveShown()), `Revert went to ${await keyName()}, not the song's ${original}`);
  });

  await test("old `leadSheetsScrollVersions` rows load as versions and still scroll", async () => {
    const { loadSongVersions } = needModel();
    store.clear();
    store.set("leadSheetsScrollVersions.13", js({ versions: [TAUGHT, TEMPO_MAPPED, LEARNED_V2], selected: 2 }));
    const old = loadSongVersions("local/13");
    expect(old.selected === 2 && old.versions.map((version) => version.name).join() === "V1,Slow intro,V2", `names or selection lost: ${js(old)}`);
    expect(old.versions.every((version) => version.semitones === null && version.bpm === null && version.scrollPercent === null && version.notation === null), "an old row has attributes set");
    expect(js(old.versions[1].plan) === js({ bpm: 78, marks: TAUGHT.marks, tempo: TEMPO_MAPPED.tempo }) && js(old.versions[2].learned) === js(LEARNED_V2.learned), "an old row's timing or learned part changed");
    expect(store.get("leadSheetsScrollVersions.13") === js({ versions: [TAUGHT, TEMPO_MAPPED, LEARNED_V2], selected: 2 }), "reading rewrote the old rows");
    await freshPhone(`#/song/${CHAIN_BREAKER}`, `localStorage.setItem(${js(VERSIONS)}, ${js(js({ versions: [LEARNED], selected: 0 }))})`);
    expect((await chip()) === "V1 · learned ▾", `the chip reads ${await chip()}`);
    await evaluate(`document.querySelector(".scroll-pill").click()`);
    await settle(1500);
    const top = await evaluate<number>(`document.getElementById("sheet-scroll").scrollTop`);
    expect((await scrollOn()) && top > 0, `the old learned version does not scroll (on ${await scrollOn()}, top ${top})`);
    await evaluate(`document.querySelector(".scroll-pill").click()`);
    expect(!(await saveShown()), "playing an old version shows Save");
  });

  await test("the draft is per account on a shared phone", async () => {
    const { loadDraft, saveDraft } = needModel();
    store.clear();
    const ref = `local/${CHAIN_BREAKER}` as const;
    await freshPhone();
    await tap("Transpose up", CONTROLS);
    await tap("Transpose up", CONTROLS);
    await tap("Transpose up", CONTROLS);
    const mine = await stored(DRAFT);
    store.set(DRAFT, mine ?? "");
    const draft = loadDraft(null, ref);
    expect(draft?.semitones === 3, `the signed-out draft reads ${js(draft)}`);
    expect(saveDraft("user-a", ref, draft) && loadDraft("user-b", ref) === null && loadDraft("user-a", ref)?.semitones === 3, "account B sees account A's draft, or A lost it");
    expect(loadDraft(null, ref)?.semitones === 3, "account A's save replaced the signed-out draft");
    store.clear();
    saveDraft("user-b", ref, draft);
    await putDrafts();
    await load(`#/song/${CHAIN_BREAKER}`);
    expect(!(await saveShown()), "a signed-out phone shows another account's draft");
    await evaluate(`localStorage.setItem(${js(DRAFT)}, ${js(mine)})`);
    await load(`#/song/${CHAIN_BREAKER}`);
    expect(await saveShown(), "the signed-out draft is gone");
  });

  await test("a full storage on Save shows Couldn't save. Free some space and try again. and the draft stays", async () => {
    await freshPhone();
    await tap("Transpose up", CONTROLS);
    await evaluate(FULL_FOR_VERSIONS);
    await saveAs("Full");
    const shown = await alerts();
    expect(shown.includes(REFUSAL), `the alert reads ${js(shown)}`);
    await evaluate(`${buttonIn(DIALOG, "Cancel")}?.click()`);
    await settle();
    expect((await saveShown()) && (await stored(DRAFT)) !== null && (await stored(VERSIONS)) === null, "the draft did not stay after a refused Save");
  });

  await test("a take's Done and a learn review's Save land in the draft, not in storage, until the header Save", async () => {
    await freshPhone();
    await openChooser();
    await tap("Learn by user", DIALOG);
    await until(`!!document.querySelector(".teach-bar")`, "the take bar");
    await settle(1200);
    await tap("Done", `document.querySelector(".teach-bar")`);
    expect((await stored(VERSIONS)) === null, "Done stored a version");
    expect((await saveShown()) && !(await evaluate<boolean>(`!!${DIALOG}`)), "Done opened a sheet or did not show Save");
    await saveAs("Taught");
    const taught = JSON.parse((await stored(VERSIONS)) ?? "{}");
    expect(taught.versions?.[0]?.name === "Taught" && (taught.versions?.[0]?.marks?.length ?? 0) >= 2, `the header Save stored ${js(taught)}`);

    await freshPhone(`#/song/${CHAIN_BREAKER}`);
    await openChooser();
    await tap("Learn by listen", DIALOG);
    await until(`!!document.querySelector(".learn")`, "the Learn sheet");
    const ways = await evaluate<string[]>(`[...document.querySelectorAll(".learn :is(input, button)")].map((el) => el.getAttribute("aria-label") ?? el.textContent.trim())`);
    expect(js(ways) === js(["Pick the song's file", "Listen with the mic", "Cancel"]), `Learn by listen opened on ${js(ways)}, not its two ways in with the file first and Cancel`);
    await settle(250);
    expect(await evaluate<boolean>(`!window.__mic`), "the mic was asked for before the player picked it");
    await tap("Listen with the mic", `document.querySelector(".learn")`);
    await until(`!!window.__mic`, "the mic");
    await evaluate(`window.__playSong(document.querySelectorAll(".chart-heading").length)`);
    await tap("Stop", `document.querySelector(".learn")`);
    await until(`!!document.querySelector(".learn-sections")`, "the Review");
    await tap("Save", `document.querySelector(".learn")`);
    expect((await stored(VERSIONS)) === null && (await stored(`leadSheetsSongData.${CHAIN_BREAKER}`)) === null, "the review's Save stored something");
    expect((await saveShown()) && !(await evaluate<boolean>(`!!document.querySelector(".learn")`)), "the review's Save left the sheet open or did not show Save");
    await saveAs("Heard");
    const heard = JSON.parse((await stored(VERSIONS)) ?? "{}");
    expect(heard.versions?.[0]?.name === "Heard" && !!heard.versions?.[0]?.learned, `the header Save stored ${js(heard)}`);
  });

  await test("changing the metronome bpm, the scroll speed or Notes | Nashville shows Save, and Save as keeps all three in the new version", async () => {
    await freshPhone();
    const inMetronome = async <T>(run: () => Promise<T>) => {
      await evaluate(`document.querySelector(".controls .metronome-pill").click()`);
      await until(`!!${DIALOG}?.querySelector(".metro-pad")`, "the Metronome sheet");
      const out = await run();
      await tap("Close", DIALOG);
      return out;
    };
    const bpm = () => inMetronome(() => evaluate<string>(`${DIALOG}.querySelector("input[aria-label='Metronome speed in bpm']").value`));
    const percent = async () => {
      await tap("Scroll settings", CONTROLS);
      const shown = await evaluate<string>(`${DIALOG}?.querySelector(".percent")?.textContent?.trim() ?? ""`);
      await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
      await settle();
      return shown;
    };
    const notation = () => evaluate<string>(`document.querySelector("[role=group][aria-label='Notes or Nashville'] [aria-pressed=true]")?.textContent ?? ""`);
    const start = { bpm: await bpm(), percent: await percent(), notation: await notation() };
    await inMetronome(() => tap("Faster metronome", DIALOG));
    expect(await saveShown(), "a metronome change does not show Save");
    await tap("Revert", HEADER);
    await tap("Scroll settings", CONTROLS);
    await tap("Scroll faster", DIALOG);
    await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    await settle();
    expect(await saveShown(), "a scroll speed change does not show Save");
    await tap("Revert", HEADER);
    await tap("Nashville", CONTROLS);
    expect(await saveShown(), "Notes | Nashville does not show Save");
    await inMetronome(() => tap("Faster metronome", DIALOG));
    await tap("Scroll settings", CONTROLS);
    await tap("Scroll faster", DIALOG);
    await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    await settle();
    const changed = { bpm: await bpm(), percent: await percent(), notation: await notation() };
    expect(changed.bpm !== start.bpm && changed.percent !== start.percent && changed.notation !== start.notation, `not all three changed: ${js({ start, changed })}`);
    await saveAs("Gig set");
    await tap("Gig set ▾", HEADER);
    await tap("Default (even pace)");
    const back = { bpm: await bpm(), percent: await percent(), notation: await notation() };
    expect(js(back) === js(start), `Default shows ${js(back)}, not ${js(start)}`);
    await tap("Default ▾", HEADER);
    await tap("Gig set");
    const again = { bpm: await bpm(), percent: await percent(), notation: await notation() };
    expect(js(again) === js(changed) && !(await saveShown()), `picking Gig set shows ${js(again)}, not ${js(changed)}`);
  });

  for (const pixels of WIDTHS) {
    await width(pixels);
    const at = ` (${pixels} px)`;

    await test(`the song screen has two control rows and the header holds A− A+${at}`, async () => {
      await freshPhone();
      const rows = await evaluate<number>(`new Set([...document.querySelectorAll(".controls button, .controls input, .controls [role=group]")].filter((el) => el.getClientRects().length).map((el) => { const r = el.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })).size`);
      expect(rows === 2, `the controls sit on ${rows} rows`);
      expect((await has("Smaller text", HEADER)) && (await has("Larger text", HEADER)), "A− A+ are not in the header");
      expect(!(await has("Smaller text", CONTROLS)) && !(await has("Original Key")), "A− or an Original Key button is still in the rows");
    });

    await test(`Key −, +, and a tap on the readout return to the original key${at}`, async () => {
      await freshPhone();
      const original = await keyName();
      await tap("Transpose down", CONTROLS);
      const down = await keyName();
      await tap("Transpose up", CONTROLS);
      await tap("Transpose up", CONTROLS);
      const up = await keyName();
      expect(down !== original && up !== original && up !== down, `the key read ${original}, ${down}, ${up}`);
      await evaluate(`document.querySelector(".controls button.key-readout").click()`);
      await settle();
      expect((await keyName()) === original, `the readout tap went to ${await keyName()}, not ${original}`);
    });

    await test(`the Scroll pill starts and stops the scroll and the caret opens the Scroll sheet without starting it${at}`, async () => {
      await freshPhone();
      await tap("Scroll settings", CONTROLS);
      const sheet = await evaluate<string>(`${DIALOG}?.querySelector("h2")?.textContent ?? ""`);
      expect(sheet === "Scroll" && !(await scrollOn()), `the caret opened ${js(sheet)} and the scroll is on: ${await scrollOn()}`);
      expect((await has("Scroll slower", DIALOG)) && (await has("Scroll faster", DIALOG)) && (await has("Learn this song", DIALOG)), "the Scroll sheet lacks speed or Learn this song");
      await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
      await settle();
      expect(!(await evaluate<boolean>(`!!${DIALOG}`)), "Escape left the Scroll sheet open");
      await evaluate(`document.querySelector(".scroll-pill").click()`);
      await settle(1200);
      const top = await evaluate<number>(`document.getElementById("sheet-scroll").scrollTop`);
      expect((await scrollOn()) && top > 0, `the pill did not start the scroll (top ${top})`);
      await evaluate(`document.querySelector(".scroll-pill").click()`);
      await settle();
      expect(!(await scrollOn()), "the pill did not stop the scroll");
    });

    await test(`no Timing picker exists on a song without versions, and the chip's list selects, renames, retimes and deletes a version${at}`, async () => {
      await freshPhone();
      const timing = await evaluate<number>(`[...document.querySelectorAll("button")].filter((b) => /^Timing/.test(b.textContent.trim())).length`);
      expect(timing === 0 && (await chip()) === "", `a song with no versions shows a Timing control or a chip (${await chip()})`);
      await freshPhone(`#/song/${CHAIN_BREAKER}`, `localStorage.setItem(${js(VERSIONS)}, ${js(js({ versions: [LEARNED, SUNDAY], selected: 0 }))})`);
      await tap("V1 · learned ▾", HEADER);
      const items = await evaluate<string[]>(`[...document.querySelectorAll("[role=menu] [role^=menuitem]")].map((el) => el.textContent.trim())`);
      expect(js(items) === js(["✓ V1 · learned", "Sunday", "Default (even pace)", "Rename V1…", "Edit tempo…", "Delete V1…"]), `the list reads ${js(items)}`);
      const inside = await evaluate<boolean>(`(() => { const r = document.querySelector("[role=menu]").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`);
      expect(inside, "the list runs off the screen");
      await tap("Sunday");
      expect((await chip()) === "Sunday ▾" && JSON.parse((await stored(VERSIONS)) ?? "{}").selected === 1, `picking Sunday left the chip at ${await chip()}`);
      await tap("Sunday ▾", HEADER);
      await tap("Rename Sunday…");
      await until(`document.activeElement?.getAttribute("aria-label") === "Version name"`, "the rename field");
      await evaluate(`document.execCommand("selectAll")`);
      await site.send("Input.insertText", { text: "Gig" });
      await site.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await site.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await settle();
      expect((await chip()) === "Gig ▾" && JSON.parse((await stored(VERSIONS)) ?? "{}").versions?.[1]?.name === "Gig", `Rename left the chip at ${await chip()}`);
      await tap("Gig ▾", HEADER);
      await tap("Edit tempo…");
      const opening = await evaluate<string>(`${DIALOG}?.querySelector("input[aria-label='Opening BPM']")?.value ?? ""`);
      expect(opening === "78", `the tempo sheet shows ${opening}, not the version's 78`);
      const fits = await evaluate<boolean>(`(() => { const d = ${DIALOG}.getBoundingClientRect(); return d.x >= 0 && d.right <= innerWidth && d.y >= 0; })()`);
      expect(fits, "the tempo sheet runs off the screen");
      await evaluate(`(() => {
        const input = ${DIALOG}.querySelector("input[aria-label='Opening BPM']");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "90");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await tap("Save", DIALOG);
      const retimed = JSON.parse((await stored(VERSIONS)) ?? "{}").versions?.[1];
      expect(js(retimed?.tempo) === js([{ at: 0, bpm: 90 }]), `Edit tempo stored ${js(retimed)}`);
      await tap("Gig ▾", HEADER);
      await tap("Delete Gig…");
      expect(await has("Cancel", HEADER), "Delete does not ask first");
      await tap("Delete", HEADER);
      const after = JSON.parse((await stored(VERSIONS)) ?? "{}");
      expect(js(after.versions?.map((version: { name: string }) => version.name)) === js(["V1"]) && after.selected === null && (await chip()) === "Default ▾", `Delete left ${js(after)} and the chip at ${await chip()}`);
    });

    await test(`Learn this song shows three rows, Learn by user greyed without length and BPM${at}`, async () => {
      await freshPhone();
      await openChooser();
      const rows = await chooserRows();
      expect(rows.length === 3 && rows[0].text.startsWith("Learn by listen") && rows[1].text.startsWith("Learn by user") && rows[2].text.includes("Find BPM") && rows.every((row) => !row.disabled), `the chooser rows read ${js(rows)}`);
      await freshPhone(`#/song/${TAKE_ME_OUT}`);
      await openChooser();
      const greyed = await chooserRows();
      expect(greyed[1]?.disabled === true && greyed[1].text.includes("Needs the song's length and BPM") && !greyed[0]?.disabled, `with no tempo the rows read ${js(greyed)}`);
    });

    await test(`Find BPM opens the finder and Cancel returns to the sheet${at}`, async () => {
      await freshPhone();
      await openChooser();
      await tap("Find BPM", DIALOG);
      expect(await evaluate<boolean>(`!!${DIALOG}?.querySelector("[role=group][aria-label='Find BPM']")`), "Find BPM opened no finder");
      await tap("Cancel", `${DIALOG}?.querySelector("[role=group][aria-label='Find BPM']")`);
      expect(!(await evaluate<boolean>(`!!document.querySelector("[role=group][aria-label='Find BPM']")`)) && (await evaluate<string>(`${DIALOG}?.querySelector("h2")?.textContent ?? ""`)) === "Learn this song", "Cancel did not return to the chooser");
    });

    await test(`every control is 48 px with 8 px gaps${at}`, async () => {
      await freshPhone(`#/song/${CHAIN_BREAKER}`, `localStorage.setItem(${js(VERSIONS)}, ${js(js({ versions: [SUNDAY], selected: 0 }))})`);
      await tap("Transpose up", CONTROLS);
      const found = await boxes(SONG_CONTROLS);
      const small = found.filter((box) => box.h < 47.5 || box.w < 47.5);
      expect(found.length >= 10 && small.length === 0, `under 48 px: ${js(small.map((box) => `${box.name} ${Math.round(box.w)}x${Math.round(box.h)}`))} of ${found.length}`);
      const tight: string[] = [];
      for (const a of found) for (const b of found) {
        if (a === b || (a.group >= 0 && a.group === b.group) || Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) > 4 || b.x < a.x) continue;
        const gap = b.x - (a.x + a.w);
        if (gap < 7.5) tight.push(`${a.name} | ${b.name} ${gap.toFixed(1)}`);
      }
      expect(tight.length === 0, `gaps under 8 px: ${js(tight)}`);
    });

    await test(`the chart's first chord stays at the same x and y as before the regroup${at}`, async () => {
      await freshPhone();
      const rows = await evaluate<number>(`new Set([...document.querySelectorAll(".controls button, .controls [role=group]")].filter((el) => el.getClientRects().length).map((el) => Math.round(el.getBoundingClientRect().top))).size`);
      expect(rows === 2, `the rows are not regrouped (${rows} rows)`);
      const first = await evaluate<{ x: number; y: number; row: Row }>(`(() => {
        const sheet = document.querySelector("article.sheet").getBoundingClientRect();
        const pair = document.querySelector(".chart .pair");
        const chords = pair.querySelector(".chords");
        const lyrics = pair.querySelector(".lyrics");
        const range = (node, from, to) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return r.getBoundingClientRect(); };
        const text = chords.textContent;
        const lyric = lyrics.textContent;
        const left = lyrics.getBoundingClientRect().left;
        const advance = range(lyrics.firstChild, 0, lyric.length).width / lyric.length;
        const at = [...text.matchAll(/\\S+/g)].map((chord) => Math.round((range(chords.firstChild, chord.index, chord.index + 1).left - left) / advance));
        const glyph = range(chords.firstChild, text.search(/\\S/), text.search(/\\S/) + 1);
        return { x: glyph.left - sheet.left, y: glyph.top - sheet.top, row: { chords: text, lyrics: lyric, at } };
      })()`);
      const want = FIRST_CHORD_IN_CARD[pixels];
      expect(Math.abs(first.x - want.x) < 0.5 && Math.abs(first.y - want.y) < 0.5, `the first chord sits at ${first.x.toFixed(2)},${first.y.toFixed(2)} in the card, not ${want.x},${want.y}`);
      const song = seed.songs.find((each) => each.id === CHAIN_BREAKER)!;
      const line = song.body.flatMap((section) => section.lines).find((each) => each.chords !== undefined && each.lyrics !== undefined)!;
      expect(chordAnchors([first.row])[0] === chordAnchors([{ chords: line.chords!, lyrics: line.lyrics }])[0], `the first chord moved off its syllable: ${chordAnchors([first.row])[0]}`);
    });

    await test(`Save, Revert and the chip are 48 px and never cover the title${at}`, async () => {
      await freshPhone(`#/song/${CHAIN_BREAKER}`, `localStorage.setItem(${js(VERSIONS)}, ${js(js({ versions: [{ ...SUNDAY, name: "Sunday morning gig take with the whole band" }], selected: 0 }))})`);
      await tap("Transpose up", CONTROLS);
      const found = await boxes(".shell-header .song-line button");
      const named = found.map((box) => box.name).join(" | ");
      expect(found.length === 3 && found.every((box) => box.h >= 47.5 && box.w >= 47.5), `Save, Revert and the chip measure ${js(found.map((box) => `${box.name.slice(0, 12)} ${Math.round(box.w)}x${Math.round(box.h)}`))}`);
      expect(found.every((box) => box.x >= 0 && box.x + box.w <= pixels), `a header button runs off the screen: ${named}`);
      const titles = await evaluate<string[]>(`[".shell-header .shell-title", ".sheet .sheet-name"].filter((selector) => {
        const el = document.querySelector(selector);
        const r = el.getBoundingClientRect();
        return [0.1, 0.5, 0.9].some((across) => !el.contains(document.elementFromPoint(r.left + r.width * across, r.top + r.height / 2)));
      })`);
      expect(titles.length === 0, `covered: ${js(titles)}`);
    });
  }

  const sam = await signIn("Sam Rivera", "samrivera");
  const mike = await passwordPlayer(base, origin, "Mike", "mikebass");
  await sam.call("/api/friends/request", { handle: mike.handle });
  await mike.call("/api/friends/accept", { userId: sam.userId });
  const signedIn = `localStorage.setItem("leadSheetsSignedIn", "1");`;
  const withCopies = (library: string) =>
    `${signedIn} const stored = ${library}; stored.songs.push(${js({ ...seed.songs.find((song) => song.id === CHAIN_BREAKER), id: 901, title: "Mike's Chain", copy: { id: "copy-dm", canSendOn: false, from: { name: "Mike" } } })}, ${js({ ...seed.songs.find((song) => song.id === CHAIN_BREAKER), id: 902, title: "Band Chain", copy: { id: "copy-band", canSendOn: true } })}); localStorage.setItem("leadSheetsLibrary", JSON.stringify(stored));`;

  await test("a locked song (a DM copy and a band song) shows no Save, no Revert, no Send, and its transposition is gone after leaving", async () => {
    await freshPhone("#/songs", signedIn);
    const library = await stored("leadSheetsLibrary");
    await freshPhone("#/songs", withCopies(library ?? "{}"));
    for (const id of [901, 902]) {
      await go(`#/song/${id}`);
      await until(`!!document.querySelector(".sheet .sheet-name")`, `song ${id}`);
      expect(await evaluate<boolean>(`!!document.querySelector(".shell-header [aria-label=Locked]")`), `song ${id} shows no lock in the header`);
      const original = await keyName();
      await tap("Transpose up", CONTROLS);
      expect((await keyName()) !== original, `Transpose up does nothing on locked song ${id}`);
      expect(!(await saveShown()) && !(await revertShown()) && !(await has("Send", CONTROLS)), `locked song ${id} shows Save, Revert or Send`);
      expect((await evaluate<number>(`Object.keys(localStorage).filter((key) => key.startsWith("leadSheetsSongDraft.${id}")).length`)) === 0, `locked song ${id} stored a draft`);
      await go("#/songs");
      await go(`#/song/${id}`);
      expect((await keyName()) === original, `locked song ${id} kept ${await keyName()} after leaving`);
    }
    await go(`#/song/${CHAIN_BREAKER}`);
    expect(await has("Send", CONTROLS), "the player's own song has no Send on the row while signed in");
  });

  const noSignal = (on: boolean) => site.send("Network.setBlockedURLs", { urls: on ? ["*/api/*"] : [] });

  await test("signed in with /api/* unreachable at launch, the account's draft shows and nothing lands in the signed-out entry", async () => {
    await freshPhone(`#/song/${CHAIN_BREAKER}`, signedIn);
    await until(`!!${buttonIn(CONTROLS, "Send")}`, "the account to answer", 10000);
    await tap("Transpose up", CONTROLS);
    await tap("Transpose up", CONTROLS);
    const moved = await keyName();
    await noSignal(true);
    try {
      await load(`#/song/${CHAIN_BREAKER}`);
      expect((await keyName()) === moved && (await saveShown()), `with no signal the song opens in ${await keyName()}, not the account's draft ${moved}, and Save shows: ${await saveShown()}`);
      await tap("Transpose down", CONTROLS);
      const keys = await phoneDrafts();
      const { loadDraft } = needModel();
      expect(keys.length === 1 && loadDraft(sam.userId, REF)?.semitones === 1 && loadDraft(null, REF) === null, `with no signal the change was stored under ${js(keys)} as ${js(loadDraft(sam.userId, REF))}, not under the account alone`);
    } finally {
      await noSignal(false);
    }
  });

  await test("a phone signed in by an older build, with /api/* unreachable at launch, keeps its change off the signed-out entry", async () => {
    await noSignal(true);
    try {
      await freshPhone(`#/song/${CHAIN_BREAKER}`, signedIn);
      const original = await keyName();
      await tap("Transpose up", CONTROLS);
      expect((await keyName()) !== original && (await saveShown()), `with no signal Transpose up left ${await keyName()} and Save shows: ${await saveShown()}`);
      expect((await stored(DRAFT)) === null, `with no account to name, the change was stored as ${await stored(DRAFT)}`);
    } finally {
      await noSignal(false);
    }
    await load(`#/song/${CHAIN_BREAKER}`);
    await until(`!!${buttonIn(CONTROLS, "Send")}`, "the account to answer", 10000);
    await phoneDrafts();
    expect(needModel().loadDraft(null, REF) === null, `the signed-out entry holds ${js(needModel().loadDraft(null, REF))} once the account answered`);
  });

  await test("a Revert on a full phone stays reverted after reload when another account has a draft for the song", async () => {
    await freshPhone(`#/song/${CHAIN_BREAKER}`, signedIn);
    await until(`!!${buttonIn(CONTROLS, "Send")}`, "the account to answer", 10000);
    const original = await keyName();
    await tap("Transpose up", CONTROLS);
    await tap("Transpose up", CONTROLS);
    const theirs = await keyName();
    await evaluate(`localStorage.removeItem("leadSheetsSignedIn")`);
    await load(`#/song/${CHAIN_BREAKER}`);
    if (await saveShown()) throw new Failed("signed out, the phone shows the account's draft");
    await tap("Transpose down", CONTROLS);
    await evaluate(FULL_PHONE);
    await tap("Revert", HEADER);
    expect((await keyName()) === original && !(await saveShown()), `on the full phone Revert left ${await keyName()} and Save shows: ${await saveShown()}`);
    await load(`#/song/${CHAIN_BREAKER}`);
    expect((await keyName()) === original && !(await saveShown()) && !(await revertShown()), `after a reload the key reads ${await keyName()} (want ${original}) and Save shows: ${await saveShown()}`);
    await evaluate(signedIn);
    await load(`#/song/${CHAIN_BREAKER}`);
    await until(`!!${buttonIn(CONTROLS, "Send")}`, "the account to answer again", 10000);
    expect((await keyName()) === theirs && (await saveShown()), `back in the account the key reads ${await keyName()}, not its draft ${theirs}, and Save shows: ${await saveShown()}`);
  });

  await test("a pick on a full phone drops the stored draft when another account has one for the song", async () => {
    await freshPhone(`#/song/${CHAIN_BREAKER}`, `${signedIn} localStorage.setItem(${js(VERSIONS)}, ${js(js({ versions: [SUNDAY], selected: null }))})`);
    await until(`!!${buttonIn(CONTROLS, "Send")}`, "the account to answer", 10000);
    await tap("Transpose up", CONTROLS);
    await evaluate(`localStorage.removeItem("leadSheetsSignedIn")`);
    await load(`#/song/${CHAIN_BREAKER}`);
    const original = await keyName();
    await tap("Transpose down", CONTROLS);
    await evaluate(`(() => {
      const real = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (String(key).startsWith("leadSheetsSongDraft")) throw new DOMException("full", "QuotaExceededError");
        return real.call(this, key, value);
      };
    })()`);
    await tap("Default ▾", HEADER);
    await tap("Sunday");
    expect((await chip()) === "Sunday ▾" && (await keyName()) === original && !(await saveShown()), `after the pick the chip reads ${await chip()}, the key ${await keyName()} and Save shows: ${await saveShown()}`);
    await load(`#/song/${CHAIN_BREAKER}`);
    expect((await keyName()) === original && !(await saveShown()), `after a reload the key reads ${await keyName()} (want ${original}) and Save shows: ${await saveShown()}`);
  });

  await test("after a refused Save, Revert clears Couldn't save", async () => {
    await freshPhone();
    await tap("Transpose up", CONTROLS);
    await evaluate(FULL_FOR_VERSIONS);
    await saveAs("Full");
    if (!(await alerts()).includes(REFUSAL)) throw new Failed(`the refused Save shows ${js(await alerts())}`);
    await tap("Cancel", DIALOG);
    await tap("Revert", HEADER);
    expect(!(await alerts()).includes(REFUSAL) && !(await saveShown()), `after Revert the line reads ${js(await alerts())} and Save shows: ${await saveShown()}`);
  });

  /** An API that holds every request until `release`, then answers each the same way. It stands in for the Worker through `apiBase` until `close`. */
  async function gatedApi(status: number, body: unknown) {
    let release = () => {};
    const gate = new Promise<void>((open) => (release = open));
    const api = createServer((_request, response) => {
      gate.then(() => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(js(body));
      });
    });
    await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
    apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    return {
      release,
      close: () => {
        apiBase = base;
        api.close();
        api.closeAllConnections();
      },
    };
  }

  await test("after a refused Save, a 401 that signs the phone out on the same song takes Couldn't save away with the draft", async () => {
    const api = await gatedApi(401, { error: "signed-out" });
    try {
      await freshPhone(`#/song/${CHAIN_BREAKER}`, `localStorage.setItem("leadSheetsSignedIn", ${js(sam.userId)})`);
      await tap("Transpose up", CONTROLS);
      await evaluate(FULL_FOR_VERSIONS);
      await saveAs("Full");
      await tap("Cancel", DIALOG);
      if (!(await alerts()).includes(REFUSAL) || !(await saveShown()) || (await stored("leadSheetsSignedIn")) !== sam.userId) {
        throw new Failed(`before the answer the line reads ${js(await alerts())}, Save shows: ${await saveShown()}, mark ${await stored("leadSheetsSignedIn")}`);
      }
      api.release();
      await until(`localStorage.getItem("leadSheetsSignedIn") === null`, "the 401 to sign the phone out", 10000);
      await settle(400);
      expect(!(await saveShown()) && !(await revertShown()), `signed out, Save shows: ${await saveShown()} and Revert shows: ${await revertShown()}`);
      expect(!(await alerts()).includes(REFUSAL), `signed out with no draft, the line still reads ${js(await alerts())}`);
    } finally {
      api.close();
    }
  });

  /**
   * Signed in under `mark` with one saved version and `seed` already on the phone, transpose up, open Save as, then let
   * the 401 sign the phone out while the dialog stands. If it still stands, press its Save, and Cancel whatever remains.
   * Returns what the player ends with.
   */
  async function signOutWithSaveAsOpen({ fullPhone = false, mark = sam.userId, seed = "" } = {}) {
    const dialogOpen = () => evaluate<boolean>(`!!${DIALOG}`);
    const versions = async () => (JSON.parse((await stored(VERSIONS)) ?? "null") as { versions: { name: string; semitones?: number }[]; selected: number | null } | null)?.versions ?? [];
    const api = await gatedApi(401, { error: "signed-out" });
    try {
      await freshPhone(`#/song/${CHAIN_BREAKER}`, `localStorage.setItem("leadSheetsSignedIn", ${js(mark)}); ${seed}`);
      await evaluate(`localStorage.setItem(${js(VERSIONS)}, ${js(js({ versions: [TAUGHT], selected: null }))})`);
      await load(`#/song/${CHAIN_BREAKER}`);
      const original = await keyName();
      await tap("Transpose up", CONTROLS);
      const raised = await keyName();
      await tap("Save", HEADER);
      await tap("Save as…");
      await until(`!!${DIALOG}?.querySelector("input[aria-label='Version name']")`, "the Save as name field");
      if ((await stored("leadSheetsSignedIn")) !== mark) throw new Failed(`the account answered before Save as opened (mark ${await stored("leadSheetsSignedIn")})`);
      api.release();
      await until(`localStorage.getItem("leadSheetsSignedIn") === null`, "the 401 to sign the phone out", 10000);
      await settle(400);
      if (fullPhone) await evaluate(FULL_FOR_VERSIONS);
      const standing = await dialogOpen();
      const before = await versions();
      if (standing) await tap("Save", DIALOG);
      if (await dialogOpen()) await tap("Cancel", DIALOG);
      const added = (await versions()).slice(before.length).map((each) => [each.name, each.semitones ?? null]);
      return { original, raised, standing, before, added, after: await versions(), alerts: await alerts(), save: await saveShown(), revert: await revertShown(), key: await keyName(), draft: await stored(DRAFT) };
    } finally {
      api.close();
    }
  }

  await test("a 401 that signs the phone out while Save as is open leaves no Couldn't save without Save or Revert when the phone is full", async () => {
    const end = await signOutWithSaveAsOpen({ fullPhone: true });
    expect(!(end.alerts.includes(REFUSAL) && !end.save && !end.revert), `signed out with no draft, Save shows: ${end.save}, Revert shows: ${end.revert}, the line reads ${js(end.alerts)}`);
  });

  await test("a 401 that signs the phone out while Save as is open saves no version other than the one the player opened Save as for", async () => {
    const end = await signOutWithSaveAsOpen();
    expect(end.added.length === 0, `the dialog saved ${js(end.added)} after the draft (key ${end.raised}) left with the 401, and the sheet reads ${end.key}`);
  });

  /** Signed out, makes the given key changes and returns the draft the phone stores for them, and whether Save shows over it. */
  async function signedOutDraft(...taps: string[]) {
    await freshPhone();
    for (const label of taps) await tap(label, CONTROLS);
    const draft = await stored(DRAFT);
    if (!draft) throw new Failed("a signed-out change stores no draft");
    return { draft, key: await keyName(), save: await saveShown(), seed: `localStorage.setItem(${js(DRAFT)}, ${js(draft)})` };
  }
  const ended = (end: Awaited<ReturnType<typeof signOutWithSaveAsOpen>>) =>
    `the dialog stood: ${end.standing}, it wrote ${js(end.added)}, the key reads ${end.key}, Save shows: ${end.save}, the line reads ${js(end.alerts)}`;

  await test("a 401 sign-out with Save as open and no signed-out draft closes the dialog, writes nothing and shows the song's own key", async () => {
    const end = await signOutWithSaveAsOpen();
    expect(!end.standing && end.added.length === 0, ended(end));
    expect(end.key === end.original && !end.save && end.draft === null, `signed out with no draft, ${ended(end)}, stored draft ${js(end.draft)}`);
  });

  await test("a 401 sign-out with Save as open and a signed-out draft that differs closes the dialog, writes nothing and shows that draft with its Save", async () => {
    const theirs = await signedOutDraft("Transpose up", "Transpose up");
    const end = await signOutWithSaveAsOpen({ seed: theirs.seed });
    expect(!end.standing && end.added.length === 0, ended(end));
    expect(end.key === theirs.key && end.save && end.draft === theirs.draft, `signed out over the +2 draft, ${ended(end)} (want ${theirs.key})`);
  });

  await test("a 401 sign-out with Save as open and a signed-out draft equal to the defaults closes the dialog, writes nothing and shows no Save", async () => {
    const theirs = await signedOutDraft("Transpose up", "Transpose down");
    if (theirs.save) throw new Failed(`an up-and-down draft shows Save at ${theirs.key}`);
    const end = await signOutWithSaveAsOpen({ seed: theirs.seed });
    expect(!end.standing && end.added.length === 0, ended(end));
    expect(end.key === theirs.key && !end.save && end.draft === theirs.draft, `signed out over the unchanged draft, ${ended(end)} (want ${theirs.key})`);
  });

  await test("a 401 sign-out with Save as open on a change made before the phone could name its account closes the dialog, writes nothing and keeps the change as the signed-out draft", async () => {
    const end = await signOutWithSaveAsOpen({ mark: "1" });
    expect(!end.standing && end.added.length === 0, ended(end));
    const kept = (JSON.parse(end.draft ?? "null") as { semitones?: number } | null)?.semitones ?? null;
    expect(end.key === end.raised && end.save && kept === 1, `signed out, the change made before the account answered reads ${end.key} (want ${end.raised}), Save shows: ${end.save}, stored signed-out draft semitones ${kept}`);
  });

  await test("with a signed-out draft on the same song, a 401 while Save as is open closes the dialog and shows that draft with its own Save", async () => {
    const dialogOpen = () => evaluate<boolean>(`!!${DIALOG}`);
    const versions = async () => (JSON.parse((await stored(VERSIONS)) ?? "null") as { versions: { name: string; semitones?: number }[] } | null)?.versions ?? [];
    await freshPhone();
    await tap("Transpose up", CONTROLS);
    await tap("Transpose up", CONTROLS);
    const signedOutDraft = await stored(DRAFT);
    const signedOutKey = await keyName();
    if (!signedOutDraft) throw new Failed("no signed-out draft to seed");
    const api = await gatedApi(401, { error: "signed-out" });
    try {
      await freshPhone(`#/song/${CHAIN_BREAKER}`, `localStorage.setItem("leadSheetsSignedIn", ${js(sam.userId)}); localStorage.setItem(${js(DRAFT)}, ${js(signedOutDraft)})`);
      await evaluate(`localStorage.setItem(${js(VERSIONS)}, ${js(js({ versions: [TAUGHT], selected: null }))})`);
      await load(`#/song/${CHAIN_BREAKER}`);
      await tap("Transpose up", CONTROLS);
      const raised = await keyName();
      const accountDraft = (JSON.parse((await stored(`${DRAFT}.${sam.userId}`)) ?? "null") as { semitones?: number } | null)?.semitones ?? null;
      if (raised === signedOutKey || accountDraft === null) throw new Failed(`the account's change reads ${raised} with draft semitones ${accountDraft}`);
      await tap("Save", HEADER);
      await tap("Save as…");
      await until(`!!${DIALOG}?.querySelector("input[aria-label='Version name']")`, "the Save as name field");
      if ((await stored("leadSheetsSignedIn")) !== sam.userId) throw new Failed(`the account answered before Save as opened (mark ${await stored("leadSheetsSignedIn")})`);
      api.release();
      await until(`localStorage.getItem("leadSheetsSignedIn") === null`, "the 401 to sign the phone out", 10000);
      await settle(400);
      const standing = await dialogOpen();
      const behind = await keyName();
      const before = await versions();
      if (standing) await tap("Save", DIALOG);
      if (await dialogOpen()) await tap("Cancel", DIALOG);
      const added = (await versions()).slice(before.length).map((each) => [each.name, each.semitones ?? null]);
      expect(!standing, `Save as still stands after the 401, opened on ${raised} (account draft semitones ${accountDraft}), and the sheet behind it reads ${behind}`);
      expect(added.every(([, semitones]) => semitones === accountDraft), `the dialog's Save wrote ${js(added)}, but Save as was opened on ${raised} (semitones ${accountDraft})`);
      expect((await keyName()) === signedOutKey && (await saveShown()), `signed out, the key reads ${await keyName()} (want the signed-out draft's ${signedOutKey}) and Save shows: ${await saveShown()}`);
    } finally {
      api.close();
    }
  });

  await test("a phone signed in by an older build keeps a change made before /api/me answers", async () => {
    const slow = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      setTimeout(() => {
        const upstream = httpRequest(new URL(request.url ?? "/", base), { method: request.method, headers: { ...request.headers, host: new URL(base).host } }, (reply) => {
          response.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(response);
        });
        upstream.on("error", () => response.destroy());
        request.pipe(upstream);
      }, path === "/api/me" ? 4000 : 0);
    });
    await new Promise<void>((done) => slow.listen(0, "127.0.0.1", done));
    apiBase = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    try {
      await freshPhone(`#/song/${CHAIN_BREAKER}`, signedIn);
      const original = await keyName();
      await tap("Transpose up", CONTROLS);
      const moved = await keyName();
      if (moved === original || (await stored("leadSheetsSignedIn")) !== "1") throw new Failed(`the account answered before the change (mark ${await stored("leadSheetsSignedIn")}, key ${moved})`);
      await until(`localStorage.getItem("leadSheetsSignedIn") === ${js(sam.userId)}`, "the account to answer", 10000);
      await settle(400);
      expect((await keyName()) === moved && (await saveShown()), `once the account answered the key reads ${await keyName()}, not the change ${moved}, and Save shows: ${await saveShown()}`);
      await phoneDrafts();
      const { loadDraft } = needModel();
      expect(loadDraft(sam.userId, REF)?.semitones === 1 && loadDraft(null, REF) === null, `the change is stored as ${js(loadDraft(sam.userId, REF))} for the account and ${js(loadDraft(null, REF))} signed out`);
      await load(`#/song/${CHAIN_BREAKER}`);
      await until(`!!${buttonIn(CONTROLS, "Send")}`, "the account to answer after a reload", 10000);
      expect((await keyName()) === moved && (await saveShown()), `after a reload the key reads ${await keyName()}, not the change ${moved}`);
    } finally {
      apiBase = base;
      slow.close();
    }
  });

  for (const pixels of WIDTHS) {
    await width(pixels);
    const at = ` (${pixels} px)`;

    await test(`the live route hides Learn by listen and Send${at}`, async () => {
      await freshPhone("#/live/1/0", signedIn);
      await until(`!!document.querySelector(".sheet .sheet-name")`, "the live song");
      expect(!(await has("Send", CONTROLS)), "the live route shows Send");
      await openChooser();
      const rows = await chooserRows();
      expect(rows.length === 2 && !rows.some((row) => row.text.startsWith("Learn by listen")), `the live chooser rows read ${js(rows)}`);
    });

    await test(`Send on the row opens the Send sheet and its button reads Send to Mike${at}`, async () => {
      await freshPhone(`#/song/${CHAIN_BREAKER}`, signedIn);
      await until(`!!${buttonIn(CONTROLS, "Send")}`, "the Send button");
      await tap("Send", CONTROLS);
      await until(`${DIALOG}?.textContent.includes("Mike")`, "the friend list", 10000);
      await tap("Mike", DIALOG);
      await until(`!!${buttonIn(DIALOG, "Public")}`, "Private or Public");
      await tap("Public", DIALOG);
      const label = await evaluate<string>(`[...${DIALOG}.querySelectorAll("button.account-primary")].map((b) => b.textContent.trim()).join(" | ")`);
      expect(label === "Send to Mike", `the send button reads ${js(label)}`);
    });
  }

  await test("no page errors", async () => {
    const errors = await evaluate<string[]>("window.__errors ?? []");
    expect(errors.length === 0, errors.join("; "));
  });
} finally {
  await site.close();
  await worker.dispose();
}

if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log("ux-sheet-controls-save ok: two rows, the Save model, locks, the Scroll sheet and the Learn chooser");
