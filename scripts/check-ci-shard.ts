import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Deep verify runs every check:* split 4 ways by scripts/ci-shard.mjs. This check keeps that split honest:
// the planner's seconds table matches the times recorded on green Deep verify runs, the largest shard stays
// within 10% of the mean (shard 1 used to hit the 25-minute job limit), and no check is ever dropped.

const root = fileURLToPath(new URL("..", import.meta.url));
const SPLITTER = join(root, "scripts", "ci-shard.mjs");
const SHARDS = 4;
const BOUND = 1.1;
// What a check with no recorded time is assumed to cost when the plan is measured.
const UNRECORDED = 60;

const recorded: Record<string, number> = JSON.parse(readFileSync(join(root, "scripts", "ci-check-seconds.json"), "utf8"));
const checkNames = Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts).filter((k) => k.startsWith("check:"));

type Shard = { shard: number; names: string[] };

let failures = 0;
const check = (problems: string[], message: string) => {
  if (problems.length) failures += 1;
  console.log(`${problems.length ? "FAIL" : "ok  "} ${message}${problems.length ? `\n       - ${problems.join("\n       - ")}` : ""}`);
};

const realSeconds = (s: Shard) => s.names.reduce((t, n) => t + (recorded[n] ?? UNRECORDED), 0);

function balance(shards: Shard[]): { problems: string[]; line: string } {
  if (shards.length !== SHARDS) return { problems: [`the plan has ${shards.length} shards, want ${SHARDS}`], line: "" };
  const secs = shards.map(realSeconds);
  const mean = secs.reduce((a, b) => a + b, 0) / secs.length;
  const max = Math.max(...secs);
  const line = `recorded shard seconds ${secs.join(" / ")}, largest ${max} is ${(max / mean).toFixed(3)} x the mean ${mean.toFixed(1)}`;
  return { problems: max <= BOUND * mean ? [] : [`${line}, want at most ${BOUND} x`], line };
}

function coverage(shards: Shard[]): string[] {
  const p: string[] = [];
  const seen = new Map<string, number>();
  for (const s of shards) {
    if (!s.names.length) p.push(`shard ${s.shard} is empty`);
    for (const n of s.names) seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  for (const n of checkNames) if (seen.get(n) !== 1) p.push(`${n} is in ${seen.get(n) ?? 0} shards, want exactly 1`);
  for (const n of seen.keys()) if (!checkNames.includes(n)) p.push(`the plan runs ${n}, which is not in package.json`);
  return p;
}

// Cases 2 and 3 read the plan the Deep verify build job reads: the stdout of `ci-shard.mjs plan 4`.
const r = spawnSync(process.execPath, [SPLITTER, "plan", String(SHARDS)], { cwd: root, encoding: "utf8" });
let cliPlan: Shard[] = [];
const cliProblems: string[] = [];
try {
  if (r.status !== 0) throw new Error(`exited ${r.status}: ${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`);
  cliPlan = (JSON.parse(r.stdout) as { shard: number; names: string }[]).map((s) => ({ shard: s.shard, names: s.names.split(/\s+/).filter(Boolean) }));
} catch (error) {
  cliProblems.push(`ci-shard.mjs plan ${SHARDS} could not run: ${(error as Error).message}`);
}

const cliBalance = balance(cliPlan);
check(cliProblems.length ? cliProblems : cliBalance.problems, `2 plan(${SHARDS}) largest shard is at most ${BOUND} x the mean (${cliBalance.line || "no plan"})`);
check(cliProblems.length ? cliProblems : coverage(cliPlan), `3 plan(${SHARDS}) runs each of the ${checkNames.length} check:* scripts in package.json exactly once`);

// Cases 1 and 4 call the real planner module. Imported after cases 2 and 3 have printed, so a splitter
// that runs its command line on import still reports them first.
const splitter: {
  SECONDS: Record<string, number>;
  DEFAULT_SECONDS: number;
  plan: (n: number, table?: Record<string, number>) => { shard: number; names: string[]; seconds: number }[];
} = await import(pathToFileURL(SPLITTER).href);

const differ = Object.entries(recorded)
  .filter(([n, s]) => splitter.SECONDS?.[n] !== s)
  .map(([n, s]) => `${n} recorded ${s} s, SECONDS has ${splitter.SECONDS?.[n] ?? "no entry"}`);
check(differ, `1 SECONDS in ci-shard.mjs holds the recorded seconds of all ${Object.keys(recorded).length} checks in scripts/ci-check-seconds.json`);
for (const n of checkNames) if (!(n in (splitter.SECONDS ?? {}))) console.log(`warn unrecorded ${n} (default ${splitter.DEFAULT_SECONDS} s)`);

const run = (name: string, fn: () => string[]) => {
  try {
    return fn();
  } catch (error) {
    return [`${name} could not run: ${(error as Error).message}`];
  }
};

check(
  run("4a", () => {
    const exported = splitter.plan(SHARDS).map((s) => ({ shard: s.shard, names: s.names }));
    return JSON.stringify(exported) === JSON.stringify(cliPlan) ? [] : ["the exported plan(4) differs from what ci-shard.mjs plan 4 prints"];
  }),
  `4a the exported plan(${SHARDS}) is the plan the command line prints`,
);

let mutantLine = "";
check(
  run("4b", () => {
    const table = { ...splitter.SECONDS, "check:guest": 20, "check:learn-songs": 20 };
    const mutant = balance(splitter.plan(SHARDS, table).map((s) => ({ shard: s.shard, names: s.names })));
    mutantLine = mutant.line;
    return mutant.problems.length ? [] : [`case 2 stays green when the plan thinks check:guest and check:learn-songs take 20 s (${mutant.line})`];
  }),
  `4b case 2 goes red with check:guest and check:learn-songs back at 20 s (${mutantLine || "no plan"})`,
);

check(
  run("4c", () => {
    if (cliPlan.length < 2 || !cliPlan[1].names.length) return ["no shard 2 to drop a check from"];
    const victim = cliPlan[1].names[0];
    const dropped = cliPlan.map((s, i) => ({ shard: s.shard, names: i === 1 ? s.names.slice(1) : s.names }));
    const doubled = cliPlan.map((s, i) => ({ shard: s.shard, names: i === 2 ? [...s.names, victim] : s.names }));
    const p: string[] = [];
    if (!coverage(dropped).some((x) => x.startsWith(`${victim} is in 0 shards`))) p.push(`case 3 stays green with ${victim} dropped from shard 2`);
    if (!coverage(doubled).some((x) => x.startsWith(`${victim} is in 2 shards`))) p.push(`case 3 stays green with ${victim} in shards 2 and 3`);
    return p;
  }),
  "4c case 3 goes red when a planned check is dropped or run twice",
);

if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
