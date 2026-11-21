import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW = ".github/workflows/deep-verify.yml";
const SPLITTER = "scripts/ci-shard.mjs";
const PAGES_SHA256 = "96f37f60ba6105fddd3513bc0443e296fb00db8dcd5022810e1fc8c9b2f8be99";
const SHARDS = 4;

type Yaml = string | number | boolean | null | Yaml[] | { [key: string]: Yaml };
type Map = { [key: string]: Yaml };

function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseYaml(src: string): Yaml {
  const raw = src.split("\n");
  const lines = raw.map((l) => {
    const t = stripComment(l).replace(/\s+$/, "");
    return t.trim() ? { indent: t.length - t.trimStart().length, text: t.trim() } : null;
  });
  let i = 0;
  const peek = () => {
    while (i < lines.length && !lines[i]) i++;
    return lines[i] ?? null;
  };
  const isItem = (text: string) => text === "-" || text.startsWith("- ");
  const isKey = (text: string) => /^("[^"]*"|'[^']*'|[^\s"'[{][^:]*?):(\s|$)/.test(text);

  function scalar(s: string): Yaml {
    if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
    if (/^".*"$/.test(s)) return JSON.parse(s);
    if (s.startsWith("[") && s.endsWith("]")) return s.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean).map(scalar);
    if (s === "{}") return {};
    if (/^[{&*!]/.test(s)) throw new Error(`unsupported YAML at line ${i + 1}: ${s}`);
    if (s === "true" || s === "false") return s === "true";
    if (s === "null" || s === "~") return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  }

  function blockScalar(parent: number, folded: boolean): string {
    const body: string[] = [];
    while (i < raw.length && (!raw[i].trim() || raw[i].length - raw[i].trimStart().length > parent)) body.push(raw[i++]);
    while (body.length && !body[body.length - 1].trim()) body.pop();
    const cut = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    const text = body.map((l) => l.slice(cut)).join("\n");
    return folded ? text.replace(/\n(?!\n)/g, " ") : text;
  }

  function after(rest: string, indent: number, sameIndentSeq: boolean): Yaml {
    if (/^[|>][-+]?$/.test(rest)) return blockScalar(indent, rest.startsWith(">"));
    if (rest !== "") return scalar(rest);
    const next = peek();
    if (next && (next.indent > indent || (sameIndentSeq && next.indent === indent && isItem(next.text)))) return block();
    return null;
  }

  function map(indent: number): Map {
    const out: Map = {};
    for (let l = peek(); l && l.indent === indent && !isItem(l.text); l = peek()) {
      const m = /^("([^"]*)"|'([^']*)'|([^:]+?)):(?:\s+(.*))?$/.exec(l.text);
      if (!m) throw new Error(`not a key at line ${i + 1}: ${l.text}`);
      const key = m[2] ?? m[3] ?? m[4];
      i++;
      out[key] = after(m[5] ?? "", indent, true);
    }
    const l = peek();
    if (l && l.indent > indent) throw new Error(`bad indent at line ${i + 1}: ${l.text}`);
    return out;
  }

  function seq(indent: number): Yaml[] {
    const out: Yaml[] = [];
    for (let l = peek(); l && l.indent === indent && isItem(l.text); l = peek()) {
      const rest = l.text === "-" ? "" : l.text.slice(2).trimStart();
      if (isKey(rest)) {
        lines[i] = { indent: indent + (l.text.length - rest.length), text: rest };
        out.push(map(lines[i]!.indent));
      } else {
        i++;
        out.push(after(rest, indent, false));
      }
    }
    return out;
  }

  function block(): Yaml {
    const l = peek()!;
    return isItem(l.text) ? seq(l.indent) : map(l.indent);
  }

  return block();
}

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

const read = (file: string) => readFileSync(join(root, file), "utf8");
const asMap = (v: Yaml | undefined): Map => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const asList = (v: Yaml | undefined): Yaml[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const text = (v: Yaml | undefined) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

const workflowText = existsSync(join(root, WORKFLOW)) ? read(WORKFLOW) : "";
const workflow = (): Map => {
  if (!workflowText) throw new Error(`${WORKFLOW} does not exist`);
  return asMap(parseYaml(workflowText));
};
const jobs = () => asMap(workflow().jobs);
const job = (name: string) => {
  const j = jobs()[name];
  if (!j) throw new Error(`no ${name} job in ${WORKFLOW}`);
  return asMap(j);
};
const steps = (j: Map) => asList(j.steps).map(asMap);
const needs = (j: Map) => asList(j.needs).map(text);
const uploads = (j: Map) => steps(j).filter((s) => text(s.uses).startsWith("actions/upload-artifact@"));

const checkNames = () => Object.keys(JSON.parse(read("package.json")).scripts).filter((k) => k.startsWith("check:"));

type Plan = { shards: { shard: number; names: string }[]; boxOnly: Map };
function plan(): Plan {
  const r = spawnSync("node", [join(root, SPLITTER), "plan", String(SHARDS)], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${SPLITTER} plan ${SHARDS} exited ${r.status}: ${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`);
  const boxOnly: Map = {};
  for (const m of r.stderr.matchAll(/^box-only (check:\S+): (.+)$/gm)) boxOnly[m[1]] = m[2];
  return { shards: JSON.parse(r.stdout), boxOnly };
}

function merge(summaries: Record<number, string[][]>): { status: number; rows: string[][]; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "check-ci-deep-"));
  try {
    for (const [shard, rows] of Object.entries(summaries)) {
      mkdirSync(join(dir, "in", `summary-${shard}`), { recursive: true });
      writeFileSync(join(dir, "in", `summary-${shard}`, "summary.tsv"), rows.map((r) => r.join("\t") + "\n").join(""));
    }
    mkdirSync(join(dir, "in"), { recursive: true });
    const r = spawnSync("node", [join(root, SPLITTER), "merge", join(dir, "in"), join(dir, "summary.tsv")], { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });
    const merged = existsSync(join(dir, "summary.tsv")) ? readFileSync(join(dir, "summary.tsv"), "utf8") : "";
    return { status: r.status ?? -1, rows: merged.split("\n").filter(Boolean).map((l) => l.split("\t")), out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

check("1 deep workflow shards the check suite 4 ways", () => {
  const p: string[] = [];
  const all = jobs();
  for (const name of ["guard", "build", "shard", "report"]) if (!all[name]) p.push(`no ${name} job`);
  if (p.length) return p;
  const build = job("build"), shard = job("shard"), report = job("report");
  const buildRuns = steps(build).map((s) => text(s.run)).join("\n");
  if (!/npm run build/.test(buildRuns)) p.push("the build job does not run npm run build");
  if (!new RegExp(`${SPLITTER.replace(".", "\\.")} plan ${SHARDS}\\b`).test(buildRuns)) p.push(`the build job does not run ${SPLITTER} plan ${SHARDS}`);
  if (!text(asMap(build.outputs).shards)) p.push("the build job has no shards output");
  if (!needs(shard).includes("build")) p.push("shard does not need build");
  const strategy = asMap(shard.strategy);
  if (strategy["fail-fast"] !== false) p.push("shard matrix is not fail-fast: false");
  if (!/fromJSON\(\s*needs\.build\.outputs\.shards\s*\)/.test(text(asMap(strategy.matrix).include))) p.push("shard matrix does not come from the build job's plan");
  const verifyStep = steps(shard).find((s) => /scripts\/verify\.sh/.test(text(s.run)));
  if (!verifyStep) p.push("no shard step runs scripts/verify.sh");
  else if (!/matrix\.names/.test(text(verifyStep.run) + text(verifyStep.env))) p.push("the verify.sh step does not take matrix.names");
  if (!needs(report).includes("shard")) p.push("report does not need shard");
  if (!/always\(\)/.test(text(report.if))) p.push("report does not run when a shard fails (if: always())");
  if (!steps(report).some((s) => new RegExp(`${SPLITTER.replace(".", "\\.")} merge\\b`).test(text(s.run)))) p.push(`report does not run ${SPLITTER} merge`);
  for (const [name, j] of Object.entries(all)) {
    const t = asMap(j)["timeout-minutes"];
    const cap = name === "shard" ? 25 : 10;
    if (typeof t !== "number" || t <= 0 || t > cap) p.push(`job ${name} timeout-minutes is ${text(t) || "missing"} (want 1-${cap})`);
    const st = steps(asMap(j));
    if (st.some((s) => /\bnpm (ci|install|run)\b/.test(text(s.run)))) {
      const node = st.find((s) => text(s.uses).startsWith("actions/setup-node@"));
      if (!node || asMap(node.with).cache !== "npm") p.push(`job ${name} runs npm without actions/setup-node cache: npm`);
    }
  }
  const conc = asMap(workflow().concurrency);
  if (conc["cancel-in-progress"] !== true || !/github\.ref/.test(text(conc.group))) p.push("concurrency does not cancel superseded runs on the same ref");

  const a = plan(), b = plan();
  if (JSON.stringify(a) !== JSON.stringify(b)) p.push("the plan differs between two runs");
  if (a.shards.length !== SHARDS) p.push(`the plan has ${a.shards.length} shards, want ${SHARDS}`);
  const seen = new Map<string, number>();
  for (const s of a.shards) {
    const names = s.names.split(/\s+/).filter(Boolean);
    if (!names.length) p.push(`shard ${s.shard} is empty`);
    for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  const names = checkNames();
  for (const n of names) {
    const count = seen.get(n) ?? 0;
    const box = n in a.boxOnly;
    if (box && count) p.push(`${n} is box-only and also in a shard`);
    if (!box && count !== 1) p.push(`${n} is in ${count} shards, want exactly 1`);
    if (box && !text(a.boxOnly[n]).trim()) p.push(`${n} is box-only with no reason`);
  }
  for (const n of seen.keys()) if (!names.includes(n)) p.push(`the plan runs ${n}, which is not in package.json`);
  if (Object.keys(a.boxOnly).length > names.length / 10) p.push(`${Object.keys(a.boxOnly).length} checks are box-only, more than a tenth of the suite`);
  if (!names.includes("check:ci-deep")) p.push("check:ci-deep is not registered in package.json");

  const rowsFor = (s: { names: string }, code = "0") => [["build", "0", "5s", "1"], ...s.names.split(/\s+/).filter(Boolean).map((n) => [n, code, "1s", "1"])];
  const green = merge(Object.fromEntries(a.shards.map((s) => [s.shard, rowsFor(s)])));
  const expected = names.filter((n) => !(n in a.boxOnly));
  if (green.status !== 0) p.push(`merge of four green shards exited ${green.status}: ${green.out.trim().slice(0, 200)}`);
  const greenChecks = green.rows.filter((r) => r[0].startsWith("check:"));
  if (greenChecks.length !== expected.length || !greenChecks.every((r) => r[1] === "0" && /^[1-4]$/.test(r[4] ?? ""))) p.push("merged summary does not hold every check once with code 0 and its shard number");
  const victim = a.shards[1].names.split(/\s+/)[0];
  const red = merge(Object.fromEntries(a.shards.map((s) => [s.shard, rowsFor(s).map((r) => (r[0] === victim ? [victim, "1", "9s", "2"] : r))])));
  if (red.status === 0) p.push(`merge passed with ${victim} failing`);
  if (!red.rows.some((r) => r[0] === victim && r[1] === "1" && r[4] === String(a.shards[1].shard))) p.push(`merged summary does not show ${victim} failing on shard ${a.shards[1].shard}`);
  const lost = a.shards[2];
  const gap = merge(Object.fromEntries(a.shards.filter((s) => s !== lost).map((s) => [s.shard, rowsFor(s)])));
  if (gap.status === 0) p.push(`merge passed with shard ${lost.shard} missing`);
  const lostNames = lost.names.split(/\s+/).filter(Boolean);
  if (!lostNames.every((n) => gap.rows.some((r) => r[0] === n && r[1] === "missing"))) p.push(`merged summary does not mark shard ${lost.shard}'s checks as missing`);
  return p;
});

check("2 deep workflow triggers only on merge, a manual dispatch, or its own file changing", () => {
  const p: string[] = [];
  const on = asMap(workflow().on);
  const keys = Object.keys(on).sort().join(",");
  if (keys !== "pull_request,push,workflow_dispatch") p.push(`triggers are ${keys || "none"}, want pull_request,push,workflow_dispatch`);
  const push = asMap(on.push);
  if (Object.keys(push).join(",") !== "branches" || asList(push.branches).map(text).join(",") !== "mls-int-20261113") p.push("push is not limited to branches: [mls-int-20261113]");
  if (!asMap(asMap(on.workflow_dispatch).inputs).sha) p.push("workflow_dispatch has no sha input");
  const pr = asMap(on.pull_request);
  const paths = asList(pr.paths).map(text);
  const allowed = [WORKFLOW, "scripts/check-ci-deep.ts", SPLITTER];
  if (!paths.includes(WORKFLOW) || !paths.includes("scripts/check-ci-deep.ts")) p.push("pull_request paths do not include the workflow file and scripts/check-ci-deep.ts");
  for (const path of paths) if (!allowed.includes(path)) p.push(`pull_request path ${path} would run the deep suite on unrelated PRs`);
  if (!paths.length) p.push("pull_request has no paths filter, so every PR push runs it");
  if (pr["paths-ignore"] !== undefined) p.push("pull_request uses paths-ignore");
  return p;
});

check("3 deep workflow never spends money", () => {
  const p: string[] = [];
  const all = jobs(), guard = job("guard"), build = job("build"), shard = job("shard"), report = job("report");
  if (needs(guard).length) p.push("guard is not the first job");
  if (!needs(build).includes("guard") || !/needs\.guard\.outputs\.\w+\s*==\s*'true'/.test(text(build.if))) p.push("build does not wait for the guard's yes");
  if (!/needs\.guard\.outputs\.\w+\s*==\s*'true'/.test(text(report.if))) p.push("report does not wait for the guard's yes");
  if (/always\(\)|!cancelled\(\)|failure\(\)/.test(text(shard.if))) p.push("shard can run after the build is skipped");
  for (const [name, j] of Object.entries(all)) if (asMap(j)["runs-on"] !== "ubuntu-latest") p.push(`job ${name} runs on ${text(asMap(j)["runs-on"])}, want ubuntu-latest`);
  const perms = asMap(workflow().permissions);
  const permText = JSON.stringify(perms);
  if (permText !== JSON.stringify({ contents: "read" }) && permText !== JSON.stringify({ contents: "read", actions: "read" })) p.push(`permissions are ${permText}, want contents: read (and at most actions: read)`);
  for (const [name, j] of Object.entries(all)) if (asMap(j).permissions !== undefined) p.push(`job ${name} sets its own permissions`);
  if (/\bsecrets\./.test(workflowText)) p.push("the workflow reads secrets");

  const guardSteps = steps(guard).filter((s) => text(s.run));
  if (guardSteps.length !== 1) return [...p, `guard has ${guardSteps.length} run steps, want 1`];
  const g = guardSteps[0];
  const env = asMap(g.env);
  const privVar = Object.keys(env).find((k) => /^\$\{\{\s*github\.event\.repository\.private\s*\}\}$/.test(text(env[k])));
  const okVar = Object.keys(env).find((k) => /^\$\{\{\s*vars\.DEEP_CI_PRIVATE_OK\s*\}\}$/.test(text(env[k])));
  if (!privVar || !okVar) return [...p, "guard step env does not read github.event.repository.private and vars.DEEP_CI_PRIVATE_OK"];
  const outKey = /steps\.(\w+)\.outputs\.(\w+)/.exec(text(asMap(guard.outputs)[Object.keys(asMap(guard.outputs))[0]]));
  if (!outKey || text(g.id) !== outKey[1]) return [...p, "guard job output does not come from its run step"];
  const dir = mkdtempSync(join(tmpdir(), "check-ci-deep-guard-"));
  try {
    const cases: [string, string, string][] = [["false", "", "true"], ["false", "false", "true"], ["true", "", "false"], ["true", "false", "false"], ["true", "true", "true"], ["", "", "false"]];
    for (const [priv, ok, want] of cases) {
      const out = join(dir, `out-${priv}-${ok}`);
      writeFileSync(out, "");
      execFileSync("bash", ["-e", "-c", text(g.run)], { env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, [privVar]: priv, [okVar]: ok }, stdio: "pipe" });
      const got = new RegExp(`^${outKey[2]}=(.*)$`, "m").exec(readFileSync(out, "utf8"))?.[1];
      if (got !== want) p.push(`guard with private=${priv || "(unset)"} DEEP_CI_PRIVATE_OK=${ok || "(unset)"} says ${got ?? "nothing"}, want ${want}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return p;
});

check("4 deep workflow uploads per-shard logs only on failure and the merged summary always", () => {
  const p: string[] = [];
  const all = jobs(), shard = job("shard"), report = job("report");
  for (const [name, j] of Object.entries(all)) {
    for (const u of uploads(asMap(j))) {
      const days = asMap(u.with)["retention-days"];
      if (typeof days !== "number" || days < 1 || days > 7) p.push(`job ${name} upload ${text(asMap(u.with).name)} keeps artifacts ${text(days) || "the default 90"} days, want 1-7`);
    }
  }
  const shardUploads = uploads(shard);
  const logs = shardUploads.filter((u) => text(u.if) === "failure()");
  if (!logs.length) p.push("shard has no upload gated on failure()");
  for (const u of shardUploads) {
    const path = text(asMap(u.with).path);
    const isSummary = /summary\.tsv$/.test(path) && /always\(\)/.test(text(u.if));
    if (!isSummary && text(u.if) !== "failure()") p.push(`shard upload ${text(asMap(u.with).name)} (${path}) runs when the shard passes`);
  }
  if (!shardUploads.some((u) => /summary\.tsv$/.test(text(asMap(u.with).path)) && /always\(\)/.test(text(u.if)))) p.push("shard does not always upload its summary.tsv for the report");
  if (!steps(report).some((s) => text(s.uses).startsWith("actions/download-artifact@"))) p.push("report does not download the shard summaries");
  const merged = uploads(report).find((u) => text(asMap(u.with).name) === "deep-summary");
  if (!merged) p.push("report does not upload an artifact named deep-summary");
  else {
    if (!/always\(\)/.test(text(merged.if))) p.push("deep-summary upload is not if: always()");
    if (!/summary\.tsv$/.test(text(asMap(merged.with).path))) p.push("deep-summary does not hold summary.tsv");
  }
  return p;
});

check("5 pages.yml is unchanged", () => {
  const p: string[] = [];
  const pages = read(".github/workflows/pages.yml");
  const sha = createHash("sha256").update(pages).digest("hex");
  if (sha !== PAGES_SHA256) p.push(`pages.yml sha256 is ${sha}, the CI-1 base had ${PAGES_SHA256}`);
  const name = text(workflow().name);
  if (!name || name === text(asMap(parseYaml(pages)).name)) p.push("deep-verify.yml has no name of its own");
  if (/pages:\s*write|deploy-pages|upload-pages-artifact|wrangler\s+deploy|--remote/.test(workflowText)) p.push("deep-verify.yml deploys or writes Pages");
  return p;
});

if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
