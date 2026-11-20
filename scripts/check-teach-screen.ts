import { writeFileSync } from "node:fs";
import { openSite } from "./chrome.ts";

/** Set SHOTS to a folder to save the chooser, the teach bar and the tempo sheet at phone size. */
const shots = process.env.SHOTS;
const root = new URL("..", import.meta.url).pathname;
let failures = 0;
const check = (ok: boolean, message: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
};

const site = await openSite(root, "check-teach-screen");
try {
  await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await site.send("Page.enable");
  await site.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__errors = []; addEventListener("error", (e) => __errors.push(String(e.message))); addEventListener("unhandledrejection", (e) => __errors.push(String(e.reason)));`,
  });
  await site.send("Page.navigate", { url: `${site.origin}/#/song/10` });
  await new Promise((done) => setTimeout(done, 1500));
  const shot = async (name: string) => {
    if (!shots) return;
    const { data } = await site.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${shots}/${name}.png`, Buffer.from(data, "base64"));
  };
  const click = (text: string) =>
    site.evaluate<boolean>(`(() => { const el = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)}); el?.click(); return !!el; })()`);
  const settle = () => new Promise((done) => setTimeout(done, 300));

  const tapLabel = (label: string) =>
    site.evaluate<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)}); el?.click(); return !!el; })()`);
  const box = (selector: string) =>
    site.evaluate<{ x: number; y: number; w: number; h: number } | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);

  check(await tapLabel("Scroll settings"), "the Scroll caret opens the Scroll sheet");
  await settle();
  check(await click("Learn this song"), "Learn this song opens the chooser");
  await settle();
  const rows = await site.evaluate<{ x: number; w: number; h: number }[]>(`[...document.querySelectorAll("[role=dialog] .learn-row")].map((row) => { const r = row.getBoundingClientRect(); return { x: r.x, w: r.width, h: r.height }; })`);
  check(rows.length === 3 && rows.every((row) => row.x >= 0 && row.x + row.w <= 390 && row.h >= 48), `the chooser's three rows fit a 390px phone and are 48px touch targets (${JSON.stringify(rows)})`);
  await shot("learn-chooser-phone");
  check(await site.evaluate<boolean>(`(() => { const el = [...document.querySelectorAll("[role=dialog] .learn-row button")].find((b) => b.textContent.trim().startsWith("Learn by user")); el?.click(); return !!el; })()`), "Learn by user starts a take");
  await settle();

  const boxes = await site.evaluate<Record<string, { x: number; y: number; w: number; h: number } | null>>(`(() => {
    const bar = document.querySelector(".teach-bar");
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    const find = (t) => [...bar.querySelectorAll("button")].find((b) => b.textContent.trim() === t);
    return { Discard: box(find("Discard")), Done: box(find("Done")), Hold: box(find("Hold")), BPM: box(bar.querySelector("input[aria-label=BPM]")), bar: box(bar) };
  })()`);
  const all = ["Discard", "Done", "Hold", "BPM"].map((name) => boxes[name]);
  check(all.every((b) => b && b.x >= 0 && b.x + b.w <= 390), "Discard, Done, Hold and BPM all fit across a 390px phone");
  check(all.every((b) => b && b.h >= 44), "each is a 44px touch target");
  const [discard, done, hold] = all;
  check(!!discard && !!done && !!hold && discard.x + discard.w <= done.x && done.x + done.w <= hold.x && discard.y === hold.y, "Discard, Done and Hold keep their row and order");
  await shot("teach-bar-phone");

  await site.evaluate(`document.querySelector(".teach-bar input[aria-label=BPM]").focus()`);
  await site.send("Input.insertText", { text: "117" });
  await site.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await site.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await settle();
  const metronome = await site.evaluate<string>(`document.querySelector(".teach-bar input[aria-label=BPM]")?.value ?? ""`);
  const focused = await site.evaluate<boolean>(`document.activeElement?.getAttribute("aria-label") === "BPM"`);
  check(metronome === "117", `typing 117 and Enter in a real browser sets the metronome (${metronome})`);
  check(!focused, "Enter leaves the field, so the phone keyboard closes");
  await shot("teach-bar-117");
  await site.evaluate(`document.querySelector(".teach-bar input[aria-label=BPM]").focus()`);
  await site.send("Input.insertText", { text: "90" });
  await site.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await site.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await settle();
  const kept = await site.evaluate<string>(`document.querySelector(".teach-bar input[aria-label=BPM]")?.value ?? ""`);
  check(kept === "117", `Escape throws a typed 90 away in a real browser (${kept})`);

  check(await click("Done"), "Done");
  await settle();
  check(await site.evaluate<boolean>(`(() => { const el = document.querySelector(".controls .metronome-pill"); el?.click(); return !!el; })()`), "the Metronome pill is back after Done");
  await settle();
  const sheetBpm = await site.evaluate<string>(`document.querySelector("[role=dialog] input[aria-label='Metronome speed in bpm']")?.value ?? ""`);
  check(sheetBpm === "117", `the Metronome sheet holds the 117 typed in the take bar (${sheetBpm})`);
  await tapLabel("Close");
  await settle();
  const save = await box(".shell-header .song-line .save-btn");
  check(!!save && save.h >= 48 && save.w >= 48 && save.x + save.w <= 390, `Save in the header is a 48px touch target on the phone (${JSON.stringify(save)})`);
  check(await click("Save"), "Save");
  await settle();
  check(await click("Save as…"), "Save as");
  await settle();
  check(await site.evaluate<boolean>(`(() => { const el = [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "Save"); el?.click(); return !!el; })()`), "Save in the name sheet");
  await settle();
  const versionChip = await box(".shell-header .song-line .version-chip");
  check(!!versionChip && versionChip.h >= 48 && versionChip.x >= 0 && versionChip.x + versionChip.w <= 390, `the version chip in the header is a 48px touch target on the phone (${JSON.stringify(versionChip)})`);
  check(await click("V1 ▾"), "the version chip's list");
  await settle();
  check(await click("Edit tempo…"), "Edit tempo opens");
  await settle();
  const opening = await site.evaluate<string>(`document.querySelector("[role=dialog] input[aria-label='Opening BPM']")?.value ?? ""`);
  check(opening === "117", `the sheet shows the take's opening BPM (${opening})`);
  await click("Add change");
  await settle();
  const fits = await site.evaluate<boolean>(`(() => { const d = document.querySelector("[role=dialog]").getBoundingClientRect(); return d.x >= 0 && d.right <= 390 && d.y >= 0; })()`);
  check(fits, "the tempo sheet fits the phone screen");
  await shot("tempo-sheet-phone");
  const errors = await site.evaluate<string[] | null>(`window.__errors ?? null`);
  check(errors?.length === 0, `no page errors (${errors?.join("; ") ?? "collector missing"})`);
} finally {
  await site.close();
}
if (failures) {
  console.error(`${failures} screen check(s) failed`);
  process.exit(1);
}
console.log("teach screen ok: chooser rows, BPM field beside Hold, Done and Discard at phone size, Enter and Escape with real keys, header Save and chip, tempo sheet fits");
