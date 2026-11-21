/**
 * U-SCROLL-SYNC on the stage: with Scroll on at #/live/1/0, the live − / + group stays off the stage bar. At 360, 390
 * and 412 px wide, each with no bottom inset and with a phone's 34 px, and at 1280 px: the group's box misses Prev,
 * the Scroll pill, the set line and Next, a tap at each button's centre reaches that button, every tap target is at
 * least 44 px, Prev and Next are no smaller than at rest, and a tap on Next goes to the next song. The song page keeps the
 * group in its bottom corner. Taps are real pointer events. Set SHOTS to a folder to save each Live screen while scrolling.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSite } from "./chrome.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.env.SHOTS;
const MIN_TAP = 44;
const LIVE = "#/live/1/0";
/** The bar's Prev and Next. The Scroll pill between them narrows by itself when "Off" turns to "On". */
const STEPS = ["Prev", "Next"];
const SIZES = [
  { width: 360, height: 800, bottom: 0, mobile: true },
  { width: 360, height: 800, bottom: 34, mobile: true },
  { width: 390, height: 844, bottom: 0, mobile: true },
  { width: 390, height: 844, bottom: 34, mobile: true },
  { width: 412, height: 915, bottom: 0, mobile: true },
  { width: 412, height: 915, bottom: 34, mobile: true },
  { width: 1280, height: 800, bottom: 0, mobile: false },
];
type Size = (typeof SIZES)[number];
type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Part = Box & { name: string; button: boolean; onTop: string | null };
type Seen = { view: { width: number; height: number }; hash: string; bar: (Part | { name: string; missing: true })[]; group: (Box & { buttons: Part[] }) | null };

/** The stage bar's parts and the − / + group as drawn, and for each, what a tap at its centre would land on (null when it is that part). */
const SEEN = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const name = (el) => el.getAttribute("aria-label") || el.textContent.trim() || el.className;
  const onTop = (el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && (hit === el || el.contains(hit)) ? null : hit ? name(hit.closest("button, [role=group], nav") || hit) : "nothing";
  };
  const bar = document.querySelector(".live-nav");
  const parts = [["Prev", "[aria-label='Previous song']"], ["the Scroll pill", ".scroll-pill"], ["the set line", ".live-count"], ["Next", "[aria-label='Next song']"]];
  const group = document.querySelector(".scroll-speed");
  return {
    view: { width: innerWidth, height: innerHeight },
    hash: location.hash,
    bar: parts.map(([label, selector]) => {
      const el = bar && bar.querySelector(selector);
      return el ? { name: label, button: el.tagName === "BUTTON", onTop: onTop(el), ...box(el) } : { name: label, missing: true };
    }),
    group: group ? { ...box(group), buttons: [...group.querySelectorAll("button")].map((b) => ({ name: name(b), button: true, onTop: onTop(b), ...box(b) })) } : null,
  };
})()`;

let failures = 0;
async function test(name: string, run: () => Promise<string[]>) {
  try {
    const wrong = await run();
    if (wrong.length === 0) return console.log(`ok   ${name}`);
    failures += 1;
    console.log(`FAIL ${name}\n     ${wrong.join("\n     ")}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
  }
}

const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const spot = (b: Box) => `x ${Math.round(b.left)} to ${Math.round(b.right)}, y ${Math.round(b.top)} to ${Math.round(b.bottom)}`;
const found = (part: Seen["bar"][number]): part is Part => !("missing" in part);

const site = await openSite(root, "check-ux-scroll-sync");
try {
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const until = async (expression: string, what: string, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await site.evaluate<boolean>(expression)) return true;
    throw new Error(`timed out waiting for ${what}`);
  };
  const painted = () => site.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))");
  const seen = () => site.evaluate<Seen>(SEEN);
  const tap = async (part: Box) => {
    const [x, y] = [part.left + part.width / 2, part.top + part.height / 2];
    for (const type of ["mousePressed", "mouseReleased"]) await site.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  };
  const size = async (screen: Size) => {
    await site.send("Emulation.setDeviceMetricsOverride", { width: screen.width, height: screen.height, deviceScaleFactor: 2, mobile: screen.mobile });
    await site.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: screen.bottom } });
  };
  const open = async (hash: string, ready: string) => {
    await site.evaluate(`location.hash = "#/setlists"`);
    await until(`location.hash === "#/setlists" && !document.querySelector(".scroll-speed")`, "the setlists screen");
    await site.evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await until(ready, hash, 15000);
    await site.evaluate("document.fonts.ready.then(() => true)");
    await painted();
  };

  await size(SIZES[0]);
  await site.send("Page.navigate", { url: `${site.origin}/#/setlists` });
  await until(`!!document.querySelector(".shell-header")`, "the app");

  for (const each of SIZES) {
    const where = `Live ${each.width}×${each.height}${each.bottom ? `, ${each.bottom} px bottom inset` : ""}`;
    await test(`${where}: with Scroll on, the − / + group clears Prev, the Scroll pill, the set line and Next, every tap target is at least 44 px, and a tap on Next goes to the next song`, async () => {
      await size(each);
      await open(LIVE, `!!document.querySelector(".live-nav .scroll-pill") && !!document.querySelector("#chord-section .chart-section")`);
      const rest = await seen();
      const wrong: string[] = [];
      if (rest.view.width !== each.width) wrong.push(`the page is ${rest.view.width} px wide, not ${each.width}`);
      if (rest.group) wrong.push("the − / + group shows before Scroll is on");
      const pill = rest.bar.find((part) => part.name === "the Scroll pill");
      if (!pill || !found(pill)) return [...wrong, "no Scroll pill on the stage bar"];
      await tap(pill);
      await until(`!!document.querySelector(".scroll-speed")`, "the − / + group after a tap on the stage bar's Scroll pill", 5000);
      await painted();
      const on = await seen();
      if (shots && each.mobile) writeFileSync(join(shots, `live-scrolling-${each.width}${each.bottom ? `-inset${each.bottom}` : ""}.png`), Buffer.from((await site.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
      const group = on.group!;
      const view = on.view;
      if (group.left < -0.5 || group.top < -0.5 || group.right > view.width + 0.5 || group.bottom > view.height + 0.5) wrong.push(`the group is not fully on screen (${spot(group)})`);
      for (const part of on.bar) {
        if (!found(part)) {
          wrong.push(`no ${part.name} on the stage bar`);
          continue;
        }
        if (overlap(group, part)) wrong.push(`the group (${spot(group)}) covers ${part.name} (${spot(part)})`);
        if (part.button && part.onTop) wrong.push(`a tap at the centre of ${part.name} lands on ${part.onTop}`);
        const before = rest.bar.find((old) => old.name === part.name);
        if (STEPS.includes(part.name) && before && found(before) && (part.width < before.width - 0.5 || part.height < before.height - 0.5)) {
          wrong.push(`${part.name} shrank from ${Math.round(before.width)}×${Math.round(before.height)} at rest to ${Math.round(part.width)}×${Math.round(part.height)}`);
        }
      }
      if (group.buttons.length < 3) wrong.push(`the group has ${group.buttons.length} buttons, not − , the speed and +`);
      for (const button of group.buttons) if (button.onTop) wrong.push(`a tap at the centre of ${button.name} lands on ${button.onTop}`);
      for (const part of [...on.bar.filter(found).filter((part) => part.button), ...group.buttons]) {
        if (part.width < MIN_TAP || part.height < MIN_TAP) wrong.push(`${part.name} is ${Math.round(part.width)}×${Math.round(part.height)} px, under ${MIN_TAP} px`);
      }
      const next = on.bar.find((part) => part.name === "Next");
      if (next && found(next)) {
        await tap(next);
        const moved = await until(`location.hash === "#/live/1/1"`, "song 2", 3000).catch(() => false);
        if (!moved) {
          const after = await seen();
          wrong.push(`a tap at the centre of Next stayed on ${after.hash} (it landed on ${next.onTop ?? "Next"}; the speed reads ${after.group?.buttons.find((b) => /^Speed/.test(b.name))?.name ?? "nothing"})`);
        }
      }
      return wrong;
    });
  }

  const phone = SIZES[3];
  await test(`song page ${phone.width}×${phone.height}, ${phone.bottom} px bottom inset: with Scroll on, the − / + group keeps its bottom-right corner`, async () => {
    await size(phone);
    await open("#/song/1", `!!document.querySelector(".controls .scroll-pill") && !!document.querySelector("#chord-section .chart-section")`);
    const pill = await site.evaluate<Box>(`(() => { const r = document.querySelector(".controls .scroll-pill").getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
    await tap(pill);
    await until(`!!document.querySelector(".scroll-speed")`, "the − / + group after a tap on Scroll", 5000);
    await painted();
    const { group, view } = await seen();
    const wrong: string[] = [];
    if (!group) return ["no − / + group while scrolling"];
    const [right, bottom] = [view.width - group.right, view.height - group.bottom];
    if (Math.abs(right - 12) > 0.5 || Math.abs(bottom - 12 - phone.bottom) > 0.5) wrong.push(`the group sits ${Math.round(right)} px from the right and ${Math.round(bottom)} px from the bottom, not 12 and ${12 + phone.bottom}`);
    for (const button of group.buttons) if (button.onTop) wrong.push(`a tap at the centre of ${button.name} lands on ${button.onTop}`);
    return wrong;
  });
} finally {
  await site.close();
}

if (failures) {
  console.log(`${failures} ux-scroll-sync check(s) failed`);
  process.exit(1);
}
console.log("ux-scroll-sync: all checks passed");
