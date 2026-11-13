import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { fakeDom, type FakeElement } from "./fake-dom.ts";
import type { ScrollVersions } from "../src/storage.ts";

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
}

const entry = `
  export { App } from "./src/App.tsx";
  export { loadScrollVersions, saveScrollVersions } from "./src/storage.ts";
  export { createElement } from "react";
  export { createRoot } from "react-dom/client";
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: new URL("..", import.meta.url).pathname, loader: "tsx" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"production"' },
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "silent",
});
const bundle = join(mkdtempSync(join(tmpdir(), "check-teach-")), "teach.mjs");
writeFileSync(bundle, bundled.outputFiles[0].text);

const CHAIN_BREAKER = 10;
const RUNTIME = 197;

let now = 0;
let nextId = 1;
const frames = new Map<number, (time: number) => void>();
const store = new Map<string, string>();
const dom = fakeDom();

/** #sheet-scroll: 800px tall over a 5000px page whose chord section runs from 1000px to 4000px. */
const sheet = {
  scrollTop: 0,
  scrollHeight: 5000,
  clientHeight: 800,
  listeners: new Map<string, () => void>(),
  getBoundingClientRect: () => ({ top: 0 }),
  scrollTo: (_x: number, y: number) => void (sheet.scrollTop = y),
  addEventListener: (type: string, run: () => void) => void sheet.listeners.set(type, run),
  removeEventListener: (type: string) => void sheet.listeners.delete(type),
};
const chart = { getBoundingClientRect: () => ({ top: 1000 - sheet.scrollTop }), offsetHeight: 3000 };
const getElementById = (id: string) => (id === "sheet-scroll" ? sheet : id === "chord-section" ? chart : null);
Object.assign(dom.document, {
  getElementById,
  oninput: null,
  querySelectorAll: () => [],
  createElementNS: (_namespace: string, name: string) => dom.document.createElement(name),
});

/** React picks a select's option through select.options, so the fake select keeps the picked value. */
type Select = FakeElement & { picked?: string };
Object.defineProperty(Object.getPrototypeOf(dom.container), "options", {
  get(this: Select) {
    const select = this;
    return this.elements
      .filter((el) => el.nodeName === "OPTION")
      .map((el) => ({
        get value() {
          return el.getAttribute("value") ?? "";
        },
        get selected() {
          return select.picked === this.value;
        },
        set selected(on: boolean) {
          if (on) select.picked = this.value;
        },
        set defaultSelected(_: boolean) {},
      }));
  },
});

const location = { hash: `#/song/${CHAIN_BREAKER}` };
Object.assign(globalThis, {
  window: {
    document: dom.document,
    location,
    HTMLIFrameElement: class {},
    addEventListener() {},
    removeEventListener() {},
    setTimeout: () => nextId++,
    clearTimeout() {},
    setInterval: () => nextId++,
    clearInterval() {},
  },
  document: dom.document,
  history: { replaceState() {} },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
  requestAnimationFrame: (run: (time: number) => void) => {
    frames.set(nextId, run);
    return nextId++;
  },
  cancelAnimationFrame: (id: number) => frames.delete(id),
});
Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now * 1000 } });

/** Loaded after the DOM stand-ins, since React checks for input events once, as it loads. */
const ui: Pick<typeof import("../src/storage.ts"), "loadScrollVersions" | "saveScrollVersions"> & {
  App: unknown;
  createElement: (type: unknown) => unknown;
  createRoot: (container: unknown) => { render: (element: unknown) => void; unmount: () => void };
} = await import(pathToFileURL(bundle).href);

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((done) => setImmediate(done));
};
async function play(seconds: number) {
  const end = now + seconds;
  while (now < end - 1e-9 && frames.size) {
    now += 1 / 60;
    const due = [...frames.values()];
    frames.clear();
    for (const run of due) run(now * 1000);
  }
  await settle();
}

const elements = () => dom.container.elements;
const bar = () => elements().find((el) => el.getAttribute("class") === "teach-bar");
const barText = () => bar()?.textContent ?? "";
const button = (name: string, within: () => FakeElement | undefined = () => dom.container) =>
  within()?.elements.find((el) => el.nodeName === "BUTTON" && (el.getAttribute("aria-label") ?? el.textContent) === name);
const dialog = () => elements().find((el) => el.getAttribute("role") === "dialog");
const nameField = () => dialog()?.elements.find((el) => el.nodeName === "INPUT");
const picked = () => (elements().find((el) => el.getAttribute("aria-label") === "Scroll version") as Select | undefined)?.picked;
const scrollOn = () => !!button("Scroll: On");

async function tap(target: FakeElement | undefined, name: string) {
  if (!target) throw new Error(`no "${name}" button in: ${dom.container.textContent.slice(0, 300)}`);
  dom.click(target);
  await settle();
}
/** Types into a text field the way a browser does: a text input's value changes, then an input event bubbles up. */
async function type(field: FakeElement | undefined, text: string) {
  if (!field) throw new Error("no text field to type into");
  Object.assign(field, { type: "text", value: text });
  const event = { type: "input", target: field, bubbles: true, cancelable: false, defaultPrevented: false, timeStamp: 0, preventDefault() {}, stopPropagation() {} };
  const path: FakeElement[] = [];
  for (let node: FakeElement | null = field; node; node = node.parentNode) path.push(node);
  for (const [nodes, capture] of [[[...path].reverse(), true], [path, false]] as const) {
    for (const node of nodes) for (const listener of node.listeners.filter((each) => each.type === "input" && each.capture === capture)) listener.run(event);
  }
  await settle();
}

const marks = (...at: [number, number][]) => at.map(([time, progress]) => ({ at: time, progress }));
const V1 = { name: "V1", bpm: 78, marks: marks([0, 0], [40, 0.2], [48, 0.2], [RUNTIME + 8, 1]) };
const LEARNED = {
  name: "Slow intro",
  bpm: 78,
  marks: marks([0, 0], [3, 0], [RUNTIME, 1]),
  learned: { beatsPerBar: 4, downbeat: 3, beats: [3, 3.77], sections: [{ heading: "INTRO", at: 3 }], vocals: [] },
};
const saved = () => ui.loadScrollVersions(CHAIN_BREAKER);
const same = (a: ScrollVersions, b: ScrollVersions) => JSON.stringify(a) === JSON.stringify(b);

let root = ui.createRoot(dom.container);
async function open(versions: ScrollVersions) {
  root.unmount();
  ui.saveScrollVersions(CHAIN_BREAKER, versions);
  now += 1;
  sheet.scrollTop = 0;
  root = ui.createRoot(dom.container);
  root.render(ui.createElement(ui.App));
  await settle();
}

async function scenario(name: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    check(false, `${name}: ${(error as Error).message}`);
  }
}

await scenario("Discard while teaching", async () => {
  const before = { versions: [V1], selected: 0 };
  await open(before);
  await tap(button("Teach"), "Teach");
  check(barText().startsWith("Teaching") && scrollOn(), "Teach starts a take and the scroll");
  check(!!button("Discard", bar) && !!button("Done", bar), `while teaching the bar offers Discard and Done (${barText()})`);
  await play(20);
  await tap(button("Hold"), "Hold");
  await play(4);
  await tap(button("Discard", bar), "Discard");
  check(barText().includes("Discard this take?") && !!button("Cancel", bar), `Discard asks once before throwing the take away (${barText()})`);
  check(scrollOn(), "asking does not stop the take yet");
  await tap(button("Cancel", bar), "Cancel");
  check(barText().startsWith("Teaching") && !!button("Continue", bar), "Cancel goes back to the take, still held");
  await tap(button("Discard", bar), "Discard");
  await tap(button("Discard", bar), "Discard (confirm)");
  check(!barText().startsWith("Teaching") && !scrollOn(), "confirming stops the take and the scroll");
  check(!dialog(), "a discarded take opens no save sheet");
  check(same(saved(), before), `Discard leaves the saved versions untouched (${JSON.stringify(saved().versions.map((v) => v.name))}, selected ${saved().selected})`);
});

await scenario("Delete a saved version", async () => {
  await open({ versions: [V1, LEARNED], selected: 1 });
  await tap(button("Delete", bar), "Delete");
  check(barText().includes("Delete Slow intro?"), `Delete names the version and asks once (${barText()})`);
  await tap(button("Cancel", bar), "Cancel");
  check(saved().versions.length === 2 && saved().selected === 1, "Cancel keeps it");
  await tap(button("Delete", bar), "Delete");
  await tap(button("Delete", bar), "Delete (confirm)");
  const after = saved();
  check(after.versions.length === 1 && after.versions[0].name === "V1", `only the learned "Slow intro" is deleted (${JSON.stringify(after.versions.map((v) => v.name))})`);
  check(after.selected === null && picked() === "", `the selection falls back to the default even scroll (selected ${after.selected})`);
  check(!button("Delete", bar), "with Default chosen there is nothing to delete");

  await open({ versions: [V1, LEARNED], selected: 0 });
  await tap(button("Delete", bar), "Delete");
  await tap(button("Delete", bar), "Delete (confirm)");
  check(JSON.stringify(saved().versions.map((v) => v.name)) === '["Slow intro"]' && saved().selected === null, "deleting V1 keeps the other version and resets the selection");
});

await scenario("The take reaches the end", async () => {
  const before = { versions: [V1], selected: null };
  await open(before);
  await tap(button("Teach"), "Teach");
  await play(RUNTIME + 2);
  check(!scrollOn() && !!dialog(), "at the end of the song the save sheet appears");
  check(nameField()?.value === "V2", `its name is the next V# (${nameField()?.value})`);
  check(!!button("Save", dialog) && !!button("Discard", dialog), "it offers Save and Discard");
  check(same(saved(), before), "nothing is saved before Save");
  await type(nameField(), "Sunday");
  await tap(button("Save", dialog), "Save");
  const after = saved();
  check(after.versions.length === 2 && after.versions[1].name === "Sunday" && after.selected === 1, `Save stores the take under the typed name and selects it (${JSON.stringify(after.versions.map((v) => v.name))}, selected ${after.selected})`);
  const last = after.versions[1].marks.at(-1)!;
  check(after.versions[1].bpm === 78 && last.progress === 1 && Math.abs(last.at - RUNTIME) < 0.1, `the saved take ends where the song did (${last.at.toFixed(2)} s)`);
  check(!dialog() && picked() === "1", "the sheet closes and the picker shows Sunday");
});

await scenario("Done, then Discard on the sheet", async () => {
  const before = { versions: [V1], selected: 0 };
  await open(before);
  await tap(button("Teach"), "Teach");
  await play(30);
  await tap(button("Hold"), "Hold");
  await play(5);
  await tap(button("Done", bar), "Done");
  check(!scrollOn() && !!dialog() && nameField()?.value === "V2", "Done stops the scroll and opens the save sheet");
  await tap(button("Discard", dialog), "Discard");
  check(!dialog() && same(saved(), before), "Discard on the sheet stores nothing");
});

await scenario("Done mid-song, then Save", async () => {
  await open({ versions: [], selected: null });
  await tap(button("Teach"), "Teach");
  await play(30);
  await tap(button("Hold"), "Hold");
  await play(5);
  await tap(button("Continue"), "Continue");
  await play(10);
  await tap(button("Done", bar), "Done");
  check(nameField()?.value === "V1", `the first take is named V1 (${nameField()?.value})`);
  await tap(button("Save", dialog), "Save");
  const version = saved().versions[0];
  const [, hold, resume, end] = version?.marks ?? [];
  check(version?.name === "V1" && version.marks.length === 4, `Save keeps the default name and the Hold and Continue marks (${JSON.stringify(version?.marks)})`);
  check(Math.abs(resume.at - hold.at - 5) < 0.1 && resume.progress === hold.progress, "the 5 s hold is kept");
  check(Math.abs(end.at - (RUNTIME + 5)) < 0.1 && end.progress === 1, `the rest of the song plays at the take's pace, not in a rush (ends at ${end.at.toFixed(2)} s, want ${RUNTIME + 5} s)`);
});

await scenario("Stopping the scroll mid-take", async () => {
  const before = { versions: [V1], selected: 0 };
  await open(before);
  await tap(button("Teach"), "Teach");
  await play(10);
  await tap(button("Hold"), "Hold");
  await play(2);
  await tap(button("Continue"), "Continue");
  await play(3);
  sheet.listeners.get("pointerdown")?.();
  await settle();
  check(!scrollOn() && !!dialog(), "grabbing the sheet mid-take offers the save sheet");
  check(same(saved(), before), "and saves nothing yet");
  await tap(button("Save", dialog), "Save");
  check(saved().versions.length === 2 && saved().versions[1].name === "V2", "Save from a stopped take stores it");

  await open(before);
  await tap(button("Teach"), "Teach");
  await play(10);
  await tap(button("Hold"), "Hold");
  await tap(button("Scroll: On"), "Scroll: On");
  check(!scrollOn() && !!dialog(), "Scroll Off mid-take offers the save sheet too");
  await tap(button("Discard", dialog), "Discard");
  check(same(saved(), before), "Discard from it stores nothing");

  await open(before);
  await tap(button("Teach"), "Teach");
  await play(10);
  sheet.listeners.get("pointerdown")?.();
  await settle();
  check(!scrollOn() && !dialog() && !barText().startsWith("Teaching"), "a take with no marks yet just stops, with no sheet");
  check(same(saved(), before), "and stores nothing");
});

root.unmount();
if (failures) {
  console.error(`${failures} teach check(s) failed`);
  process.exit(1);
}
console.log("teach ok: Discard with a confirm, Delete with a confirm, a save sheet at the end, on Done and on a mid-take stop");
