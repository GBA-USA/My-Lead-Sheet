import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { CHECKS_DIR, root } from "../checks.mjs";

let failures = 0;
const check = (name: string, problems: () => string[]) => {
  let found: string[];
  try {
    found = problems();
  } catch (error) {
    found = [`could not run: ${(error as Error).message}`];
  }
  if (found.length) failures += 1;
  console.log(`${found.length ? "FAIL" : "ok  "} ${name}${found.length ? `\n       - ${found.join("\n       - ")}` : ""}`);
};

check("1 package.json lists no check:* scripts", () =>
  Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {})
    .filter((key) => key.startsWith("check:"))
    .map((key) => `package.json has "${key}": add scripts/checks/${key.slice("check:".length)}.check.ts instead`),
);

check("2 every scripts/check-* file runs from a scripts/checks file", () => {
  const imported = new Set<string>();
  for (const file of readdirSync(CHECKS_DIR).filter((f) => f.endsWith(".check.ts"))) {
    for (const m of readFileSync(join(CHECKS_DIR, file), "utf8").matchAll(/^import\s+"([^"]+)";/gm)) imported.add(posix.join("scripts/checks", m[1]));
  }
  return readdirSync(join(root, "scripts"))
    .filter((f) => /^check-.+\.(ts|mjs)$/.test(f))
    .filter((f) => !imported.has(`scripts/${f}`))
    .map((f) => `scripts/${f} never runs: add scripts/checks/${f.replace(/^check-|\.(ts|mjs)$/g, "")}.check.ts with import "../${f}";`);
});

const plant = (checks: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "check-registry-"));
  mkdirSync(join(dir, "scripts", "checks"), { recursive: true });
  for (const f of ["checks.mjs", "run-check.mjs", "verify.sh"]) copyFileSync(join(root, "scripts", f), join(dir, "scripts", f));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", scripts: { build: "node -e 0", check: "node scripts/run-check.mjs" } }));
  for (const [name, body] of Object.entries(checks)) writeFileSync(join(dir, "scripts", "checks", `${name}.check.ts`), body);
  return dir;
};
const PLANTED = {
  pass: 'console.log("ok   pass");\n',
  fail: 'console.log("FAIL fail");\nprocess.exit(3);\n',
  args: "console.log(JSON.stringify(process.argv.slice(2)));\n",
};

check("3 npm run check -- <name> runs that one check and keeps its exit code", () => {
  const p: string[] = [];
  const dir = plant(PLANTED);
  try {
    const run = (...args: string[]) => spawnSync(process.execPath, [join(dir, "scripts", "run-check.mjs"), ...args], { cwd: dir, encoding: "utf8" });
    const list = run("--list");
    if (list.stdout.trim().split(/\r?\n/).join(" ") !== "check:args check:fail check:pass") p.push(`--list printed ${JSON.stringify(list.stdout)}`);
    if (run("pass").status !== 0) p.push("a passing check did not exit 0");
    if (run("check:fail").status !== 3) p.push(`a check that exits 3 gave ${run("check:fail").status}`);
    const args = run("args", "--pure", "two");
    if (args.stdout.trim() !== '["--pure","two"]') p.push(`args reached the check as ${args.stdout.trim()}`);
    for (const bad of ["nope", "../checks", "", "Pass"]) {
      const r = run(...(bad ? [bad] : []));
      if (r.status !== 2 || !/checks: args fail pass/.test(r.stderr)) p.push(`name ${JSON.stringify(bad)} gave exit ${r.status} without the list of checks`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return p;
});

check("4 npm run verify finds every scripts/checks file with no list to edit", () => {
  const p: string[] = [];
  const dir = plant(PLANTED);
  try {
    const verify = (...names: string[]) => {
      const logs = join(dir, `logs-${names.length}`);
      const r = spawnSync("bash", ["scripts/verify.sh", ...names], { cwd: dir, encoding: "utf8", env: { ...process.env, VERIFY_LOG_DIR: logs } });
      const tsv = join(logs, "summary.tsv");
      const rows = existsSync(tsv) ? readFileSync(tsv, "utf8").split(/\r?\n/).filter(Boolean).map((l) => l.split("\t")) : [];
      return { status: r.status, rows: rows.map((r) => `${r[0]}=${r[1]}/${r[3]}`).join(" "), out: (r.stdout + r.stderr).trim() };
    };
    const all = verify();
    if (all.rows !== "build=0/1 check:args=0/1 check:fail=3/2 check:pass=0/1") p.push(`verify with no names wrote ${all.rows || "no rows"}: ${all.out.slice(-300)}`);
    if (all.status !== 1 || !/1 of 3 checks failed after one retry: check:fail/.test(all.out)) p.push(`verify with a failing check exited ${all.status}: ${all.out.slice(-200)}`);
    const one = verify("check:pass");
    if (one.status !== 0 || one.rows !== "build=0/1 check:pass=0/1" || !/all 1 checks passed/.test(one.out)) p.push(`verify check:pass exited ${one.status} with ${one.rows}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return p;
});

if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
