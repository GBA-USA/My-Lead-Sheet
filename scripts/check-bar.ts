import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build as bundle } from "esbuild";
import { openSite } from "./chrome.ts";

/** Set SHOTS to a folder to save the bar closed, each menu open, teaching, and the metronome with its beat dot. */
const shots = process.env.SHOTS;
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const CHAIN_BREAKER = 10;
const TAKE_ME_OUT = 5;
const EAST_TO_WEST = 11;

const root = new URL("..", import.meta.url).pathname;
const modules = await bundle({
  stdin: { contents: 'export * from "./src/storage.ts";', resolveDir: root, loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const app = (await import(`data:text/javascript,${encodeURIComponent(modules.outputFiles[0].text)}`)) as typeof import("../src/storage.ts");

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
}

const STAND_INS = `(() => {
  window.__errors = [];
  addEventListener("error", (event) => window.__errors.push(String(event.message)));
  addEventListener("unhandledrejection", (event) => window.__errors.push(String(event.reason)));
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => ({ getTracks: () => [{ stop() {} }] }) });
  addEventListener("click", () => (window.__tapping = true), true);
  addEventListener("click", () => (window.__tapping = false));
  const Real = AudioContext;
  window.AudioContext = class extends Real {
    constructor(...args) {
      super(...args);
      window.__audioInTap = window.__tapping;
    }
  };
  AudioContext.prototype.createMediaStreamSource = () => ({ connect() {} });
  AudioContext.prototype.createScriptProcessor = function () {
    return (window.__mic = { connect() {}, onaudioprocess: null });
  };
})()`;

const marks = (...at: [number, number][]) => at.map(([time, progress]) => ({ at: time, progress }));
const LEARNED = {
  name: "V1",
  bpm: 78,
  marks: marks([0, 0], [3, 0], [197, 1]),
  learned: { beatsPerBar: 4, downbeat: 3, beats: [3, 3.77], sections: [{ heading: "INTRO", at: 3 }], vocals: [] },
};
const TAUGHT = { name: "Sunday", bpm: 78, marks: marks([0, 0], [40, 0.2], [205, 1]) };

const site = await openSite(root, "check-bar");
const { send, evaluate } = site;
const pause = (ms: number) => evaluate(`new Promise((resolve) => setTimeout(resolve, ${ms}))`);
const until = async (expression: string, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (await evaluate<boolean>(expression)) return;
    await pause(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const find = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.innerText.trim() === ${JSON.stringify(text)})`;
/** A real tap at the element's centre, so outside-tap and focus behave as on a phone. */
const tap = async (selector: string, text: string) => {
  const box = await evaluate<{ x: number; y: number } | null>(`(() => {
    const el = ${find(selector, text)};
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  if (!box) throw new Error(`no ${selector} "${text}" to tap`);
  await tapAt(box.x, box.y);
};
const tapAt = async (x: number, y: number) => {
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  await pause(60);
};
const key = async (name: string, code = name) => {
  const text = name === "Enter" ? "\r" : undefined;
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: name, code, text: type === "keyDown" ? text : undefined, windowsVirtualKeyCode: { Enter: 13, Escape: 27, Tab: 9 }[name] });
  await pause(60);
};
const shoot = async (name: string) => {
  if (!shots) return;
  const shot = await send("Page.captureScreenshot", { format: "png" });
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, `${name}.png`), Buffer.from(shot.data, "base64"));
};
const stored = (songId: number) => evaluate<{ versions: { name: string }[]; selected: number | null }>(`JSON.parse(localStorage.getItem("${app.SCROLL_VERSIONS_KEY}.${songId}"))`);

type Bar = { rows: number; height: number; controls: string[]; overflow: boolean; shortest: number };
const bar = () =>
  evaluate<Bar>(`(() => {
    const bar = document.querySelector(".teach-bar");
    const controls = [...bar.querySelectorAll("button, input, select")].filter((el) => !el.closest(".menu"));
    const tops = new Set(controls.map((el) => Math.round(el.getBoundingClientRect().top)));
    const overflow = bar.scrollWidth > bar.clientWidth || controls.some((el) => { const box = el.getBoundingClientRect(); return box.left < 0 || box.right > innerWidth; });
    return { rows: tops.size, height: Math.round(bar.getBoundingClientRect().height), controls: controls.map((el) => el.innerText.trim() || el.getAttribute("aria-label")), overflow, shortest: Math.min(...controls.map((el) => el.getBoundingClientRect().height)) };
  })()`);
type Menu = { items: string[]; checked: string[]; disabled: string[]; notes: string[]; shortest: number; inside: boolean; expanded: string[] };
const menus = () =>
  evaluate<Menu[]>(`[...document.querySelectorAll("[role=menu]")].map((menu) => {
    const items = [...menu.querySelectorAll("[role^=menuitem]")];
    const box = menu.getBoundingClientRect();
    return {
      items: items.map((el) => el.innerText.trim()),
      checked: items.filter((el) => el.getAttribute("aria-checked") === "true").map((el) => el.innerText.trim()),
      disabled: items.filter((el) => el.disabled).map((el) => el.innerText.trim() + " / " + (document.getElementById(el.getAttribute("aria-describedby"))?.innerText ?? "")),
      notes: [...menu.querySelectorAll(".menu-note")].map((el) => el.innerText.trim()),
      shortest: Math.min(...items.map((el) => el.getBoundingClientRect().height)),
      inside: box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
      expanded: [...document.querySelectorAll("[aria-haspopup=menu][aria-expanded=true]")].map((el) => el.innerText.trim() || el.getAttribute("aria-label")),
    };
  })`);

let loads = 0;
async function openSong(id: number, versions: object | null, scale = 1, route = `#/song/${id}`, others: number[] = []) {
  await send("Page.navigate", { url: `${site.origin}/?load=${(loads += 1)}#/songs` });
  await until(`document.readyState === "complete"`, "the app");
  await evaluate(`(() => {
    localStorage.clear();
    localStorage.setItem("${app.TEXT_SCALE_KEY}", "${app.TEXT_SCALES.indexOf(scale as (typeof app.TEXT_SCALES)[number])}");
    ${versions ? [id, ...others].map((song) => `localStorage.setItem("${app.SCROLL_VERSIONS_KEY}.${song}", ${JSON.stringify(JSON.stringify(versions))});`).join("") : ""}
  })()`);
  await send("Page.navigate", { url: `${site.origin}/?load=${(loads += 1)}${route}` });
  await until(`!!document.querySelector(".teach-bar") && !!document.querySelector(".chart-heading")`, `song ${id}`);
  await evaluate(`document.fonts.ready.then(() => true)`);
  await pause(100);
}

const CHIP = "Timing: V1 · learned ▾";
const CUSTOMIZE = "Customize scroll ▾";
const BUTTONS = ".teach-bar button";
const ITEMS = "[role=menu] button";

async function scenario(name: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    check(false, `${name}: ${(error as Error).message}`);
  }
}

try {
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: STAND_INS });
  await send("Emulation.setDeviceMetricsOverride", PHONE);

  await scenario("the closed bar", async () => {
    await openSong(CHAIN_BREAKER, { versions: [LEARNED, TAUGHT], selected: 0 });
    const closed = await bar();
    await shoot("bar-closed");
    check(closed.rows === 1 && JSON.stringify(closed.controls) === JSON.stringify([CHIP, CUSTOMIZE]), `the bar is one row of two controls, ${CHIP} and ${CUSTOMIZE} (${closed.rows} rows: ${closed.controls.join(" | ")})`);
    check(closed.height <= 46 && !closed.overflow, `the bar is ${closed.height} px tall at 390 px wide and nothing spills out of it`);
    check(closed.shortest >= 44, `every control in the bar is a touch target at least 44 px tall (${closed.shortest} px)`);
  });

  await scenario("the Timing menu", async () => {
    await openSong(CHAIN_BREAKER, { versions: [LEARNED, TAUGHT], selected: 0 });
    await tap(BUTTONS, CHIP);
    const [open] = await menus();
    await shoot("menu-timing-open");
    const want = ["✓ V1 · learned", "Sunday", "Default (even pace)", "Rename V1…", "Edit tempo…", "Delete V1…"];
    check(JSON.stringify(open?.items) === JSON.stringify(want), `the Timing menu lists ${want.join(", ")} (${open?.items.join(", ")})`);
    check(JSON.stringify(open?.checked) === '["✓ V1 · learned"]' && JSON.stringify(open?.expanded) === JSON.stringify([CHIP]), `V1 is the checked choice and the chip says it is expanded (${open?.checked}, ${open?.expanded})`);
    check(open.shortest >= 44 && open.inside, `menu items are at least 44 px tall and the menu stays on screen (${open.shortest} px)`);
    const divider = await evaluate<string>(`(() => { const line = document.querySelector("[role=menu] .menu-divider[role=separator]"); return line ? line.previousElementSibling.innerText.trim() + " | " + line.nextElementSibling.innerText.trim() : "none"; })()`);
    check(divider === "Default (even pace) | Rename V1…", `a divider separates the choices from Rename, Edit tempo and Delete (${divider})`);

    await key("Escape");
    check((await menus()).length === 0, "Escape closes the menu");
    await tap(BUTTONS, CHIP);
    await tapAt(195, 700);
    check((await menus()).length === 0, "a tap on the sheet closes the menu");

    await evaluate(`${find(BUTTONS, CHIP)}.focus()`);
    await key("Enter");
    await key("Tab");
    const focused = await evaluate<string>(`document.activeElement.getAttribute("role") + " " + document.activeElement.innerText.trim()`);
    check((await menus()).length === 1 && focused === "menuitemradio ✓ V1 · learned", `the keyboard opens the chip with Enter and Tab reaches the first item (${focused})`);
    await key("Escape");

    await tap(BUTTONS, CHIP);
    await tap(ITEMS, "Sunday");
    check((await bar()).controls[0] === "Timing: Sunday ▾" && (await stored(CHAIN_BREAKER)).selected === 1 && (await menus()).length === 0, "picking Sunday chooses it, saves it and closes the menu");

    await tap(BUTTONS, "Timing: Sunday ▾");
    await tap(ITEMS, "Default (even pace)");
    check((await bar()).controls[0] === "Timing: Default ▾" && (await stored(CHAIN_BREAKER)).selected === null, "picking Default goes back to the even pace");
    await tap(BUTTONS, "Timing: Default ▾");
    const fallback = (await menus())[0];
    check(JSON.stringify(fallback.items) === '["V1 · learned","Sunday","✓ Default (even pace)"]', `with Default chosen there is nothing to rename or delete (${fallback.items.join(", ")})`);
    await tap(ITEMS, "V1 · learned");
  });

  await scenario("Rename and Delete", async () => {
    await tap(BUTTONS, CHIP);
    await tap(ITEMS, "Rename V1…");
    check(await evaluate<boolean>(`document.activeElement?.getAttribute("aria-label") === "Version name" && document.activeElement.value === "V1"`), "Rename opens the name field on V1");
    await evaluate(`document.execCommand("selectAll")`);
    await send("Input.insertText", { text: "Gig" });
    await key("Enter");
    check((await bar()).controls[0] === "Timing: Gig · learned ▾" && (await stored(CHAIN_BREAKER)).versions[0].name === "Gig", "Enter saves the new name");

    await tap(BUTTONS, "Timing: Gig · learned ▾");
    await tap(ITEMS, "Delete Gig…");
    const asking = await evaluate<string>(`document.querySelector(".teach-bar").innerText.replace(/\\s+/g, " ").trim()`);
    check(asking === "Delete Gig? Delete Cancel", `Delete asks once (${asking})`);
    await tap(BUTTONS, "Cancel");
    check((await stored(CHAIN_BREAKER)).versions.length === 2, "Cancel keeps it");
    await tap(BUTTONS, "Timing: Gig · learned ▾");
    await tap(ITEMS, "Delete Gig…");
    await tap(BUTTONS, "Delete");
    const after = await stored(CHAIN_BREAKER);
    check(JSON.stringify(after.versions.map((version) => version.name)) === '["Sunday"]' && after.selected === null && (await bar()).controls[0] === "Timing: Default ▾", `confirming deletes Gig and goes back to Default (${JSON.stringify(after)})`);
  });

  await scenario("the Customize scroll menu and Learn by user", async () => {
    await openSong(CHAIN_BREAKER, { versions: [LEARNED, TAUGHT], selected: 0 });
    await tap(BUTTONS, CUSTOMIZE);
    const [open] = await menus();
    await shoot("menu-customize-open");
    check(JSON.stringify(open?.items) === '["Learn by user (scroll it yourself)","Learn by listen (play the song)"]' && open.disabled.length === 0, `Customize scroll offers Learn by user and Learn by listen (${open?.items.join(", ")})`);
    check(open.shortest >= 44 && open.inside, `its items are at least 44 px tall and on screen (${open.shortest} px)`);

    await tap(ITEMS, "Learn by user (scroll it yourself)");
    const teachingBar = await bar();
    await shoot("teaching");
    check(JSON.stringify(teachingBar.controls) === '["Discard","Done","Hold","BPM"]' && teachingBar.rows === 1, `Learn by user starts teaching: Teaching with Discard, Done, Hold and the BPM field in one row (${teachingBar.rows} rows: ${teachingBar.controls.join(", ")})`);
    check(teachingBar.height <= 46 && !teachingBar.overflow && teachingBar.shortest >= 44, `the teaching bar is ${teachingBar.height} px tall, nothing spills out, and every control is at least 44 px tall (${teachingBar.shortest} px)`);
    check(await evaluate<boolean>(`document.querySelector(".teach-status")?.innerText === "Teaching" && !!${find("button", "Scroll: On")}`), "the take scrolls the sheet");
    await tap(BUTTONS, "Hold");
    const holding = await bar();
    check(holding.controls.includes("Continue") && holding.rows === 1 && !holding.overflow, `Hold still pauses the take and Continue keeps the bar on one row (${holding.rows} rows: ${holding.controls.join(", ")})`);
    await tap(BUTTONS, "Discard");
    await tap(BUTTONS, "Discard");
    check((await bar()).controls[0] === CHIP, "Discard ends the take and the chip comes back");
  });

  await scenario("one menu at a time", async () => {
    await tap("[aria-label='Song actions']", "");
    await tap(BUTTONS, CHIP);
    const open = await menus();
    check(open.length === 1 && open[0].items[0] === "✓ V1 · learned", `opening the chip closes the song actions menu (${open.length} open)`);
    await tap(BUTTONS, CUSTOMIZE);
    check((await menus()).length === 1 && (await menus())[0].items[0].startsWith("Learn by user"), "opening Customize scroll closes the Timing menu");
    await key("Escape");
  });

  await scenario("Learn by listen", async () => {
    check(await evaluate<boolean>(`!window.__mic`), "the mic is not asked for before Learn by listen");
    await tap(BUTTONS, CUSTOMIZE);
    await tap(ITEMS, "Learn by listen (play the song)");
    await until(`!!window.__mic`, "the mic");
    check(await evaluate<boolean>(`document.querySelector(".learn[role=dialog]")?.innerText.includes("Play the whole song near the phone")`), "Learn by listen opens the Learn sheet and starts listening");
    check(await evaluate<boolean>(`window.__audioInTap === true`), "its audio starts inside the tap itself, where browsers allow it");
    await tap(".learn-actions button", "Cancel");
    await pause(200);
    const errors = await evaluate<string[]>(`window.__errors`);
    check(await evaluate<boolean>(`!document.querySelector("[role=dialog]")`), "Cancel closes it");
    check(errors.length === 0, `opening and closing the Learn sheet throws nothing (${errors.join("; ") || "no page errors"})`);
  });

  await scenario("a live setlist", async () => {
    await openSong(CHAIN_BREAKER, { versions: [LEARNED, TAUGHT], selected: 0 }, 1, "#/live/2/0", [EAST_TO_WEST]);
    await tap(BUTTONS, CUSTOMIZE);
    check(JSON.stringify((await menus())[0]?.items) === '["Learn by user (scroll it yourself)"]', "a live setlist offers Learn by user but not Learn by listen");
    await tap(BUTTONS, CHIP);
    await tap(ITEMS, "Delete V1…");
    await tap("[aria-label='Next song']", "Next");
    await until(`location.hash === "#/live/2/1"`, "the next song");
    const next = await bar();
    check(next.controls[0] === CHIP && (await stored(EAST_TO_WEST)).versions.length === 2, `a Delete left unconfirmed does not follow to the next song (${next.controls.join(" | ")})`);
  });

  await scenario("a song with no tempo", async () => {
    await openSong(TAKE_ME_OUT, null);
    const closed = await bar();
    check(JSON.stringify(closed.controls) === JSON.stringify(["Timing: Default ▾", CUSTOMIZE]) && closed.rows === 1, `with no versions the chip reads Timing: Default (${closed.controls.join(" | ")})`);
    await tap(BUTTONS, "Timing: Default ▾");
    check(JSON.stringify((await menus())[0]?.items) === '["✓ Default (even pace)"]', "its menu has only the even pace, checked");
    await tap(BUTTONS, CUSTOMIZE);
    const [open] = await menus();
    check(JSON.stringify(open?.disabled) === `["Learn by user (scroll it yourself) / Needs the song's length and BPM"]` && open.items[1] === "Learn by listen (play the song)", `with no tempo Learn by user is disabled with its reason, Learn by listen is not (${open?.disabled}, ${open?.items})`);
    await key("Escape");
  });

  await scenario("fit", async () => {
    const long = { ...TAUGHT, name: "Sunday morning gig take with the whole band" };
    for (const [scale, width] of [[1.7, 390], [1.7, 320]] as const) {
      await send("Emulation.setDeviceMetricsOverride", { ...PHONE, width });
      await openSong(CHAIN_BREAKER, { versions: [LEARNED, long], selected: 1 }, scale);
      const fitted = await bar();
      check(!fitted.overflow && fitted.rows === 1, `at text size ${scale} and ${width} px wide, a long version name fits on one row without spilling (${fitted.rows} rows, ${fitted.controls[0]})`);
    }
    await send("Emulation.setDeviceMetricsOverride", PHONE);
  });

  await scenario("the beat dot", async () => {
    await openSong(CHAIN_BREAKER, null);
    await tap(".metro-pad", (await evaluate<string>(`document.querySelector(".metro-pad").innerText.trim()`)));
    const running = await evaluate<boolean>(`document.querySelector(".metro-pad").getAttribute("aria-pressed") === "true"`);
    const dot = () => evaluate<{ top: number; right: number; sheetTop: number; sheetRight: number; size: number; color: string } | null>(`(() => {
      const dot = document.querySelector(".beat-dot");
      if (!dot) return null;
      const box = dot.getBoundingClientRect();
      const sheet = document.getElementById("sheet-scroll").getBoundingClientRect();
      return { top: Math.round(box.top), right: Math.round(box.right), sheetTop: Math.round(sheet.top), sheetRight: Math.round(sheet.right), size: box.width, color: getComputedStyle(dot).backgroundColor };
    })()`);
    if (!running) {
      check(!(await dot()), "where audio cannot start the pad stays off and there is no dot");
      return;
    }
    await until(`document.querySelector(".beat-dot")?.dataset.beat === "on"`, "the dot to light");
    await shoot("metronome-dot");
    const atTopRight = (box: Awaited<ReturnType<typeof dot>>) =>
      !!box && box.size === 12 && box.color === "rgb(215, 38, 61)" && box.right <= box.sheetRight && box.right > box.sheetRight - 40 && box.top - box.sheetTop < 40;
    const seen = [];
    for (const scrollTop of [0, 900, 1800]) {
      await evaluate(`document.getElementById("sheet-scroll").scrollTop = ${scrollTop}`);
      await pause(100);
      seen.push(await dot());
    }
    check(seen.every(atTopRight), `while the metronome runs a 12 px red dot sits at the sheet's top right at scroll 0, 900 and 1800 (${seen.map((box) => box && `${box.top - box.sheetTop},${box.sheetRight - box.right}`).join(" ")} px from the top and right)`);
    check(JSON.stringify(seen[1]) === JSON.stringify(seen[2]), "once the sheet scrolls the dot stays put");
    await evaluate(`document.getElementById("sheet-scroll").scrollTop = 0`);
    await pause(100);
    await tap(".metro-pad", (await evaluate<string>(`document.querySelector(".metro-pad").innerText.trim()`)));
    check(!(await dot()), "stopping the metronome removes the dot");
  });
} finally {
  await site.close();
}

if (failures) {
  console.error(`${failures} bar check(s) failed`);
  process.exit(1);
}
console.log("bar ok: one row, a Timing chip and Customize scroll menu that open, list, pick, rename, delete, teach and listen");
