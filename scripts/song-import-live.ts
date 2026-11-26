import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Import files, run on a folder of the player's own files outside the repo, to judge the readers on real charts
 * without committing any. One line for each row: its name, kind, mark, reasons and chord count. It prints no chart
 * text. Node has no `DOMParser` or canvas, so an HTML file reads as Couldn't read here and a document set in a
 * proportional font shows `fonts` with one reading; the screen reads both in full.
 *
 *   node --experimental-strip-types scripts/song-import-live.ts <folder>
 */

const folder = process.argv[2];
if (!folder) {
  console.error("Give a folder: node --experimental-strip-types scripts/song-import-live.ts <folder>");
  process.exit(1);
}

type Draft = { chart: string };
type Row = { id: string; name: string; state: { is: string; why?: string; verdict?: string; reasons?: string[]; draft?: Draft } };
type Pile = { rows: Row[]; past: number };
type Picked = { name: string; size: number; bytes: () => Promise<Uint8Array> };
type Module = {
  readFiles: (files: Picked[], emit: (event: { do: string; [key: string]: unknown }) => void) => Promise<void>;
  pileReducer: (pile: Pile, action: object) => Pile;
  EMPTY_PILE: Pile;
  kindOf: (bytes: Uint8Array, name: string) => string;
  chordCount: (chart: string) => number;
};

const root = fileURLToPath(new URL("..", import.meta.url));
const bundle = await build({
  stdin: { contents: `export * from "./src/song-import.ts"; export { readFiles } from "./src/import-read.ts";`, resolveDir: root, loader: "ts" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  loader: { ".css": "empty", ".woff2": "empty", ".woff": "empty" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "silent",
});
const mod: Module = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
// The stored library is read to find a song the player has; here there is none.
(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const paths = walk(folder);
const kinds = new Map<string, string>();
const files: Picked[] = paths.map((path) => {
  const name = relative(folder, path).replaceAll("\\", "/");
  const bytes = new Uint8Array(readFileSync(path));
  kinds.set(name, mod.kindOf(bytes, name));
  return { name, size: bytes.length, bytes: async () => bytes };
});

let pile = mod.EMPTY_PILE;
await mod.readFiles(files, (event) => (pile = mod.pileReducer(pile, event.do === "read" ? { ...event, songs: [] } : event)));

const MARK: Record<string, string> = { good: "Looks good", check: "Check this" };
for (const row of pile.rows) {
  const kind = kinds.get(row.name) ?? `${kinds.get(row.name.split("/")[0]) ?? "zip"} entry`;
  const { state } = row;
  if (state.is === "unread") console.log([row.name, kind, "Couldn't read", state.why, 0].join("\t"));
  else if (state.is === "ready") console.log([row.name, kind, MARK[state.verdict!], state.reasons!.join(",") || "-", mod.chordCount(state.draft!.chart)].join("\t"));
}
if (pile.past > 0) console.log(`${pile.past} more files were past the limit of the pile`);
console.log(`${pile.rows.length} rows from ${files.length} files`);
