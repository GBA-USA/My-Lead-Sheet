import { writeFileSync } from "node:fs";
import { openSite } from "./chrome.ts";

/** Set SHOTS to a folder to save the teach bar and the tempo sheet at phone size. */
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

  check(await click("Customize scroll ▾"), "Customize scroll opens");
  await settle();
  check(await click("Learn by user (scroll it yourself)"), "Learn by user starts a take");
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
  const metronome = await site.evaluate<string>(`document.querySelector(".metronome")?.dataset.bpm ?? ""`);
  const focused = await site.evaluate<boolean>(`document.activeElement?.getAttribute("aria-label") === "BPM"`);
  check(metronome === "117", `typing 117 and Enter in a real browser sets the metronome (${metronome})`);
  check(!focused, "Enter leaves the field, so the phone keyboard closes");
  await shot("teach-bar-117");
  await site.evaluate(`document.querySelector(".teach-bar input[aria-label=BPM]").focus()`);
  await site.send("Input.insertText", { text: "90" });
  await site.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await site.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await settle();
  const kept = await site.evaluate<string>(`document.querySelector(".metronome")?.dataset.bpm ?? ""`);
  check(kept === "117", `Escape throws a typed 90 away in a real browser (${kept})`);

  check(await click("Done"), "Done");
  await settle();
  check(await click("Save"), "Save");
  await settle();
  check(await click("Timing: V1 ▾"), "Timing menu");
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
console.log("teach screen ok: BPM field beside Hold, Done and Discard at phone size, Enter and Escape with real keys, tempo sheet fits");
