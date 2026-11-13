import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { LibraryFile } from "../src/types.ts";

const seed = JSON.parse(readFileSync(new URL("../data/library.json", import.meta.url), "utf8")) as LibraryFile;

let failures = 0;
function check(ok: boolean, message: string) {
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${message}`);
  }
}

const entry = `
  import { createElement } from "react";
  import { renderToStaticMarkup } from "react-dom/server";
  import { App } from "./src/App.tsx";
  import { OverflowMenu } from "./src/controls.tsx";
  const noop = () => {};
  export const renderApp = () => renderToStaticMarkup(createElement(App));
  export const renderOpenMenu = () =>
    renderToStaticMarkup(createElement(OverflowMenu, { label: "More", open: true, onToggle: noop, onClose: noop, onEdit: noop, onDelete: noop }));
`;
const result = await build({
  stdin: { contents: entry, resolveDir: new URL("..", import.meta.url).pathname, loader: "tsx" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  loader: { ".css": "empty" },
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "silent",
});
const bundle = join(mkdtempSync(join(tmpdir(), "check-screens-")), "ui.mjs");
writeFileSync(bundle, result.outputFiles[0].text);
const ui: { renderApp: () => string; renderOpenMenu: () => string } = await import(pathToFileURL(bundle).href);

const store = new Map<string, string>();
const page = { hash: "" };
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  },
  window: { location: page, addEventListener() {}, removeEventListener() {} },
});

function render(hash: string): string {
  page.hash = hash;
  return ui.renderApp();
}

render("#/songs");
const stored = JSON.parse(store.get("leadSheetsLibrary")!);
stored.setlists.push({ id: 77, name: "Empty night", songIds: [] });
store.set("leadSheetsLibrary", JSON.stringify(stored));
const count = (html: string, pattern: RegExp) => html.match(new RegExp(pattern, "g"))?.length ?? 0;
const attrs = (html: string, tag: RegExp) => [...html.matchAll(tag)].map((match) => match[0]);
const attr = (element: string, name: string) => element.match(new RegExp(`${name}="([^"]*)"`))?.[1];

const firstSetlist = seed.setlists[0];
const routes = ["#/songs", "#/setlists", `#/song/${seed.songs[0].id}`, "#/song/999", `#/live/${firstSetlist.id}/0`, `#/live/${firstSetlist.id}/99`, "#/live/77/0", "#/live/404/0"];

for (const hash of routes) {
  const html = render(hash);
  check(count(html, /<h1[ >]/) === 1, `${hash} has exactly one h1 (found ${count(html, /<h1[ >]/)})`);
  const tabs = attrs(html, /<a [^>]*role="tab"[^>]*>/g);
  if (hash.startsWith("#/live")) continue;
  check(tabs.length === 2, `${hash} shows two tabs`);
  for (const tab of tabs) {
    const panel = attr(tab, "aria-controls");
    const panelTag = panel ? html.match(new RegExp(`<[^>]* id="${panel}"[^>]*>`))?.[0] : undefined;
    check(!!panelTag && attr(panelTag, "role") === "tabpanel", `${hash} tab ${attr(tab, "href")} controls a tabpanel`);
    check(!!panelTag && attr(panelTag, "aria-labelledby") !== undefined && html.includes(`id="${attr(panelTag, "aria-labelledby")}"`), `${hash} tabpanel is labelled by its tab`);
    check(attr(tab, "id") !== undefined, `${hash} tab ${attr(tab, "href")} has an id`);
  }
  const focusable = tabs.filter((tab) => attr(tab, "tabindex") === "0");
  check(focusable.length === 1 && attr(focusable[0], "aria-selected") === "true", `${hash} only the selected tab is in the tab order`);
  check(tabs.filter((tab) => attr(tab, "tabindex") === "-1").length === 1, `${hash} the other tab is out of the tab order`);
}

const empty = render("#/live/77/0");
check(empty.includes("This setlist is empty."), "an empty setlist says it is empty");
check(!empty.includes("1/0"), "an empty setlist does not count 1/0");
check(!empty.includes("isn&#x27;t in this library") && !empty.includes("isn't in this library"), "an empty setlist is not called missing");
check(!empty.includes("Next song"), "an empty setlist hides Prev and Next");
check(render("#/live/404/0").includes("That setlist isn&#x27;t in this library."), "a setlist id that does not exist is still called missing");
check(count(render("#/setlists"), /This setlist is empty\./) === 1, "the Setlists tab says the empty setlist is empty");

const pastEnd = render(`#/live/${firstSetlist.id}/99`);
check(pastEnd.includes(`${firstSetlist.songIds.length}/${firstSetlist.songIds.length}`), "a live index past the end counts the last song");

const menu = ui.renderOpenMenu();
const items = attrs(menu, /<button [^>]*role="menuitem"[^>]*>[^<]*/g);
check(items.length === 2 && items.every((item) => /\sdisabled=""/.test(item)), "Edit and Delete are disabled");
check(items.every((item) => !item.includes("danger")), "Delete no longer looks destructive");
check(menu.includes("Coming in a later version"), "the menu says Edit and Delete are coming later");
check(!/>Add</.test(render("#/songs")), "there is still no Add button");

if (failures) {
  console.error(`${failures} screen check(s) failed`);
  process.exit(1);
}
console.log(`screens ok: ${routes.length} routes, one h1 each, tabs point at their panel, empty setlist, disabled Edit/Delete`);
