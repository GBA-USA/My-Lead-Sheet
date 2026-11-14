import assert from "node:assert/strict";
import { settle } from "./app-page.ts";
import { openSite } from "./chrome.ts";

const root = new URL("..", import.meta.url).pathname;

/** Red the way a player names it: a strong red channel, with green and blue well under it. Gold (225, 160, 30) is not red. */
function isRed(css: string): boolean {
  const [r, g, b] = (css.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  return r >= 180 && g <= 80 && b <= 100;
}

const site = await openSite(root, "check-beat-red", undefined, ["--autoplay-policy=no-user-gesture-required"]);
try {
  await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await site.send("Page.navigate", { url: `${site.origin}/#/songs` });
  const until = async (expression: string, what: string) => {
    for (const end = Date.now() + 10000; Date.now() < end; await settle(50)) if (await site.evaluate<boolean>(expression)) return;
    throw new Error(`timed out waiting for ${what}`);
  };
  await until(`!!document.querySelector('a[href^="#/song/"]')`, "the song list");
  await site.evaluate(`location.hash = document.querySelector('a[href^="#/song/"]').getAttribute("href")`);
  await until(`!!document.querySelector(".metro-pad")`, "the metronome on the sheet");
  await site.evaluate(`document.querySelector(".metro-pad").click()`);
  await until(`!!document.querySelector(".metro-pad.is-on")`, "the metronome to turn on");

  const lamp = await site.evaluate<string>(`getComputedStyle(document.querySelector(".metro-pad.is-on .metro-lamp")).backgroundColor`);
  assert.ok(isRed(lamp), `the metronome's blinking lamp is red while it plays (got ${lamp})`);
  console.log(`ok   the blinking lamp on the metronome is red (${lamp})`);

  await until(`document.querySelector(".beat-dot")?.dataset.beat === "on"`, "the beat dot to light");
  const dot = await site.evaluate<string>(`getComputedStyle(document.querySelector(".beat-dot")).backgroundColor`);
  assert.ok(isRed(dot), `the beat dot on the sheet is red when it lights (got ${dot})`);
  console.log(`ok   the beat dot on the sheet is red when it lights (${dot})`);
} finally {
  await site.close();
}
console.log("check:beat-red passed");
