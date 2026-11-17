import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { ScrollVersions, StoredVersion } from "../src/storage.ts";

type Storage = typeof import("../src/storage.ts");

const root = new URL("..", import.meta.url).pathname;
/** U1, the last build before a version could hold only settings. Its `isVersion` requires `bpm` and `marks`. */
const OLDER_BUILD = "34860a0";

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

const olderTree = mkdtempSync(join(tmpdir(), "mls-older-build-"));
try {
  const archive = execFileSync("git", ["archive", "--format=tar", OLDER_BUILD, "src", "data"], { cwd: root });
  execFileSync("tar", ["-x", "-C", olderTree], { input: archive });
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
} finally {
  rmSync(olderTree, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("ok   settings-only versions survive an older build");
