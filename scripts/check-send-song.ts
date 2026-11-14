import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { SendPick } from "../src/send-song-model.ts";

// src files import siblings without extensions, so bundle them (same pattern as check-scroll.ts).
type Mod = typeof import("../src/send-song-model.ts") & typeof import("../src/send-song.tsx") & { renderToStaticMarkup: (el: unknown) => string; createElement: (c: unknown, p: unknown) => unknown };
const bundled = await build({
  stdin: { contents: 'export * from "./src/send-song-model.ts"; export * from "./src/send-song.tsx"; export { renderToStaticMarkup } from "react-dom/server"; export { createElement } from "react";', resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic", logLevel: "silent",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const file = join(mkdtempSync(join(tmpdir(), "check-send-song-")), "m.mjs");
writeFileSync(file, bundled.outputFiles[0].text);
const m = (await import(pathToFileURL(file).href)) as Mod;
const { fixtureSong, canSend, buildMessage, addToMySongs, applyUpdate } = m;
const sheet = m.renderToStaticMarkup(m.createElement(m.SendSongSheet, {}));
if (!/Private/.test(sheet) || !/Public/.test(sheet) || !/<button[^>]*disabled[^>]*>Send<\/button>/.test(sheet)) { console.error("FAIL sheet renders Private/Public with Send disabled"); process.exit(1); }
console.log("ok sheet renders with Send disabled until a choice");

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}:`, e);
    process.exit(1);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

test("canSend false with no choice", () => {
  const pick: SendPick = { chart: false, versionIds: [], data: false, choice: null };
  assert(canSend(pick) === false, "should be false");
});

test("buildMessage no choice error", () => {
  const pick: SendPick = { chart: true, versionIds: ["v1"], data: false, choice: null };
  const result = buildMessage(fixtureSong, pick, true);
  assert(!result.ok, "should not be ok");
  assert(result.error === "Pick Private or Public", `got: ${result.error}`);
});

test("buildMessage nothing ticked error", () => {
  const pick: SendPick = { chart: false, versionIds: [], data: false, choice: "public" };
  const result = buildMessage(fixtureSong, pick, true);
  assert(!result.ok, "should not be ok");
  assert(result.error === "Tick at least one thing to send", `got: ${result.error}`);
});

test("buildMessage only v1 ticked", () => {
  const pick: SendPick = { chart: false, versionIds: ["v1"], data: false, choice: "public" };
  const result = buildMessage(fixtureSong, pick, true);
  assert(result.ok, "should be ok");
  assert(result.payload.versions.length === 1, "should have exactly one version");
  assert(result.payload.versions[0].id === "v1", "version should be v1");
  assert(!("chart" in result.payload) || result.payload.chart === undefined, "chart should not be in payload");
  assert(!("data" in result.payload) || result.payload.data === undefined, "data should not be in payload");
});

test("Private original reshareable false", () => {
  const pick: SendPick = { chart: true, versionIds: ["v1"], data: true, choice: "private" };
  const result = buildMessage(fixtureSong, pick, true);
  assert(result.ok, "should be ok");
  assert(result.reshareable === false, "reshareable should be false for private");
});

test("Public original reshareable true", () => {
  const pick: SendPick = { chart: true, versionIds: ["v1"], data: true, choice: "public" };
  const result = buildMessage(fixtureSong, pick, true);
  assert(result.ok, "should be ok");
  assert(result.reshareable === true, "reshareable should be true for public");
});

test("Private copy cannot be resent", () => {
  const pick: SendPick = { chart: true, versionIds: ["v1"], data: true, choice: "private" };
  const result = buildMessage(fixtureSong, pick, true);
  assert(result.ok, "first send should be ok");

  const payload = result.payload;
  const copiedSong = addToMySongs(payload, result.reshareable, "Mike");
  assert(copiedSong.reshareable === false, "copy should not be reshareable");

  const resendPick: SendPick = { chart: true, versionIds: ["v1"], data: true, choice: "public" };
  const resendResult = buildMessage(copiedSong, resendPick, false);
  assert(!resendResult.ok, "should not be able to resend private copy as public");
  assert(resendResult.error === "This song can't be shared", `got: ${resendResult.error}`);
});

test("Public copy of a Public share reshareable true", () => {
  const pick: SendPick = { chart: true, versionIds: ["v1"], data: true, choice: "public" };
  const result = buildMessage(fixtureSong, pick, true);
  assert(result.ok, "should be ok");

  const payload = result.payload;
  const copiedSong = addToMySongs(payload, result.reshareable, "Mike");
  assert(copiedSong.reshareable === true, "copy should be reshareable");

  const resendPick: SendPick = { chart: true, versionIds: ["v1"], data: true, choice: "public" };
  const resendResult = buildMessage(copiedSong, resendPick, false);
  assert(resendResult.ok, "should be able to resend public copy");
  assert(resendResult.reshareable === true, "reshareable should be true");
});

test("Copy marked fromName Mike", () => {
  const pick: SendPick = { chart: true, versionIds: ["v1"], data: true, choice: "public" };
  const result = buildMessage(fixtureSong, pick, true);
  assert(result.ok, "should be ok");

  const copiedSong = addToMySongs(result.payload, result.reshareable, "Mike");
  assert(copiedSong.fromName === "Mike", `fromName should be "Mike", got: ${copiedSong.fromName}`);
});

test("Mutating payload after addToMySongs doesn't change copy", () => {
  const pick: SendPick = { chart: true, versionIds: ["v1"], data: true, choice: "public" };
  const result = buildMessage(fixtureSong, pick, true);
  assert(result.ok, "should be ok");

  const payload = result.payload;
  const copiedSong = addToMySongs(payload, result.reshareable, "Mike");

  payload.title = "MUTATED";
  payload.data!.bpm = 9999;
  payload.versions[0].label = "MUTATED";

  assert(copiedSong.title === "No Half Steppin'", "title should not change");
  assert(copiedSong.data.bpm === 92, "bpm should still be 92");
  assert(copiedSong.versions[0].label === "Main take", "version label should not change");
});

test("applyUpdate keep-mine returns [mine]", () => {
  const pick: SendPick = { chart: true, versionIds: ["v1"], data: true, choice: "public" };
  const result = buildMessage(fixtureSong, pick, true);
  assert(result.ok, "should be ok");

  const updated = applyUpdate(fixtureSong, result.payload, "keep-mine");
  assert(updated.length === 1, "should return 1 song");
  assert(updated[0] === fixtureSong, "should return the original song");
});

test("applyUpdate take-theirs returns [mine with ticked parts replaced]", () => {
  const pick: SendPick = { chart: true, versionIds: ["v2"], data: false, choice: "public" };
  const result = buildMessage(fixtureSong, pick, true);
  assert(result.ok, "should be ok");

  const copiedSong = addToMySongs(result.payload, true, "");
  const updated = applyUpdate(copiedSong, result.payload, "take-theirs");
  assert(updated.length === 1, "should return 1 song");
  assert(updated[0].versions.length === 1, "should have 1 version");
  assert(updated[0].versions[0].id === "v2", "should have v2");
  assert(updated[0].chart === "[C]Hello", "chart should be preserved");
  assert(updated[0].reshareable === true, "reshareable should be preserved");
  assert(updated[0].fromName === "", "fromName should be preserved");
});

test("applyUpdate keep-both returns [mine, copy with title suffixed]", () => {
  const pick: SendPick = { chart: true, versionIds: ["v1"], data: true, choice: "public" };
  const result = buildMessage(fixtureSong, pick, true);
  assert(result.ok, "should be ok");

  const copiedSong = addToMySongs(result.payload, true, "Mike");
  const updated = applyUpdate(copiedSong, result.payload, "keep-both");
  assert(updated.length === 2, "should return 2 songs");
  assert(updated[0] === copiedSong, "first should be the original");
  assert(updated[1].title === result.payload.title + " (update)", "second title should have (update) suffix");
  assert(updated[1].fromName === "Mike", "second should preserve fromName");
});

console.log("send-song: all checks passed");
