import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { Draft, SongVersion } from "../src/song-version.ts";
import type { ScrollVersions, StoredVersion } from "../src/storage.ts";

type Storage = typeof import("../src/storage.ts");
/** A tree's Save model over its storage. `toStored` is private in the tree and exported by the check (see `archive`). */
type VersionModel = Storage & typeof import("../src/song-version.ts") & { toStored: (name: string, draft: Draft) => StoredVersion };

const root = new URL("..", import.meta.url).pathname;
/** U1, the last build before a version could hold only settings. Its `isVersion` requires `bpm` and `marks`. */
const OLDER_BUILD = "34860a0";
/** U3, the interim Preview. It reads a settings-only row's stand-in pace as taught timing, and its Save and Save as rebuild the row from named fields. */
const U3_BUILD = "f0326ae";

let failures = 0;
function check(ok: boolean, message: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures += 1;
}

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  },
});

async function loadStorage(tree: string): Promise<Storage> {
  const result = await build({ entryPoints: [join(tree, "src/storage.ts")], bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

async function loadVersionModel(tree: string): Promise<VersionModel> {
  const contents = `export * from "./src/song-version.ts"; export * from "./src/storage.ts";`;
  const result = await build({
    stdin: { contents, resolveDir: tree, loader: "ts" },
    nodePaths: [join(root, "node_modules")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

/** The tree's `src` and `data` at `commit`. A tree with a Save model gets its private `toStored` exported so the check can drive that build's Save. */
function archive(commit: string, into: string) {
  const tar = execFileSync("git", ["archive", "--format=tar", commit, "src", "data"], { cwd: root });
  execFileSync("tar", ["-x", "-C", into], { input: tar });
  if (existsSync(join(into, "src/song-version.ts"))) appendFileSync(join(into, "src/song-version.ts"), "\nexport { toStored };\n");
}

const olderTree = mkdtempSync(join(tmpdir(), "mls-older-build-"));
const u3Tree = mkdtempSync(join(tmpdir(), "mls-u3-build-"));
try {
  archive(OLDER_BUILD, olderTree);
  const older = await loadStorage(olderTree);
  const current = await loadStorage(root);

  const ref = "local/10";
  const key = `${current.SCROLL_VERSIONS_KEY}.10`;
  const taught: StoredVersion = { name: "V1", bpm: 78, marks: [{ at: 0, progress: 0 }, { at: 100, progress: 1 }] };
  const lowSet: StoredVersion = { name: "Low set", semitones: -2, metronomeBpm: 72, scrollPercent: 90, notation: "notes", data: { tempo: 72 } };
  const take: StoredVersion = { name: "V3", bpm: 80, marks: [{ at: 0, progress: 0 }, { at: 40, progress: 0.5 }, { at: 90, progress: 1 }] };
  const js = (value: unknown) => JSON.stringify(value);
  const names = (value: ScrollVersions) => value.versions.map((version) => version.name);
  const stored = () => JSON.parse(store.get(key) ?? "null") as ScrollVersions | null;

  check(current.saveScrollVersions(ref, { versions: [taught, lowSet], selected: 1 }), "this build saves a taught version and a settings-only version");
  check(js(current.loadScrollVersions(ref)) === js({ versions: [taught, lowSet], selected: 1 }), "this build reads both back as saved, the settings-only one with no timing");
  check(js(stored()?.versions[0]) === js(taught), "a taught version is stored as before");

  const seen = older.loadScrollVersions(ref);
  check(js(names(seen)) === js(["V1", "Low set"]) && seen.selected === 1, `the older build reads 2 of 2 versions with its selection (${js(names(seen))}, selected ${seen.selected})`);

  older.updateScrollVersions(ref, (now) => ({ ...now, selected: 0 }));
  check(js(names(stored()!)) === js(["V1", "Low set"]), `after a Timing pick on the older build the stored versions are ${js(names(stored()!))}`);
  older.updateScrollVersions(ref, (now) => ({ ...now, versions: now.versions.map((each, i) => (i === 0 ? { ...each, name: "Slow" } : each)) }));
  older.updateScrollVersions(ref, (now) => ({ versions: [...now.versions, take], selected: now.versions.length }));
  older.updateScrollVersions(ref, (now) => ({ versions: now.versions.filter((_, i) => i !== 0), selected: now.selected === null || now.selected === 0 ? null : now.selected - 1 }));
  check(js(names(stored()!)) === js(["Low set", "V3"]), `after a rename, a taught take and a delete on the older build the stored versions are ${js(names(stored()!))}`);

  const back = current.loadScrollVersions(ref);
  check(js(back) === js({ versions: [lowSet, take], selected: 1 }), `this build reads what the older build wrote: the settings-only version with its settings and no timing, then the take (${js(back)})`);

  store.clear();
  current.saveScrollVersions(ref, { versions: [lowSet], selected: 0 });
  const onePhone = store.get(key);
  store.clear();
  current.saveScrollVersions(ref, { versions: [lowSet], selected: 0 });
  check(onePhone !== undefined && onePhone === store.get(key), "two phones saving the same settings-only version store the same bytes, so backup combines them as one version");

  archive(U3_BUILD, u3Tree);
  const u3 = await loadVersionModel(u3Tree);
  const model = await loadVersionModel(root);
  const defaults: Draft = { semitones: 0, bpm: null, scrollPercent: 100, notation: "notes", plan: null };
  const shown = (name: string, semitones: number): SongVersion => ({ name, semitones, bpm: 72, scrollPercent: 90, notation: "notes", plan: null, data: { tempo: 72 } });

  store.clear();
  current.saveScrollVersions(ref, { versions: [taught, lowSet], selected: 1 });
  const u3Seen = u3.loadSongVersions(ref);
  check(u3Seen.versions.length === 2 && u3Seen.versions[1].semitones === -2, `the U3 build reads the settings-only version with its settings (${js(u3Seen.versions[1])})`);

  const overwrite = { ...u3.baseline(u3Seen.versions[1], defaults), semitones: -3 };
  u3.updateScrollVersions(ref, (now) => ({ ...now, versions: now.versions.map((each, i) => (i === 1 ? u3.toStored(each.name, overwrite) : each)) }));
  const afterSave = model.loadSongVersions(ref);
  check(js(afterSave.versions[1]) === js(shown("Low set", -3)), `after a Save to this version on the U3 build, this build still reads it as settings-only with the new key (${js(afterSave.versions[1])})`);

  const added = { ...u3.baseline(u3.loadSongVersions(ref).versions[1], defaults), semitones: -5 };
  u3.updateScrollVersions(ref, (now) => ({ versions: [...now.versions, u3.toStored("Low set 2", added)], selected: now.versions.length }));
  const afterSaveAs = model.loadSongVersions(ref);
  check(
    js(afterSaveAs.versions.slice(1)) === js([shown("Low set", -3), shown("Low set 2", -5)]) && afterSaveAs.selected === 2,
    `after a Save as on the U3 build, this build reads both settings-only versions without timing and the new one selected (${js(afterSaveAs)})`,
  );
  check(older.loadScrollVersions(ref).versions.length === 3, "the older build still reads 3 of 3 versions after the U3 build's saves");

  const other = "local/11";
  current.saveScrollVersions(other, { versions: [lowSet], selected: 0 });
  const only = { ...u3.baseline(u3.loadSongVersions(other).versions[0], defaults), scrollPercent: 80 };
  u3.updateScrollVersions(other, (now) => ({ ...now, versions: now.versions.map((each, i) => (i === 0 ? u3.toStored(each.name, only) : each)) }));
  check(!model.hasTiming(other), "a song whose only version is settings-only has no timing on this build after the U3 build saved over it");
} finally {
  rmSync(olderTree, { recursive: true, force: true });
  rmSync(u3Tree, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("ok   settings-only versions survive an older build");
