import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) => readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n");

const PLAN = "docs/PLAN-bulk-import.md";
const MISSING_TABLE = "What the player sees when something is missing";
const MUST_HANDLE_TABLE = "Must handle, and the cases that prove it";
const MUST_HANDLE_RULES = "Must handle in every feature";

const briefs = readdirSync(join(root, "docs/cooks"))
  .filter((name) => /^bulk-import-.*\.md$/.test(name))
  .sort()
  .map((name) => `docs/cooks/${name}`);
const text = new Map([PLAN, ...briefs].map((file) => [file, read(file)]));
const plan = text.get(PLAN)!;

let failures = 0;
const check = (ok: boolean, message: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
};

type Table = { heading: string; header: string[]; rows: string[][] };

function tablesOf(markdown: string): Table[] {
  const tables: Table[] = [];
  let heading = "";
  let open: string[][] | null = null;
  for (const line of [...markdown.split("\n"), ""]) {
    if (line.startsWith("|")) {
      open ??= [];
      open.push(line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
      continue;
    }
    if (open) tables.push({ heading, header: open[0], rows: open.slice(2) });
    open = null;
    const title = /^#+ (.*)$/.exec(line);
    if (title) heading = title[1];
  }
  return tables;
}

const defined = new Map<string, number[]>();
const define = (letter: string, n: string) => defined.set(letter, [...(defined.get(letter) ?? []), Number(n)]);
for (const body of text.values()) for (const [, letter, n] of body.matchAll(/^- ([A-Z])(\d+)\. /gm)) define(letter, n);
for (const [, n] of plan.matchAll(/^\| D(\d+) \|/gm)) define("D", n);
const last = (letter: string) => defined.get(letter)?.length ?? 0;
const isDefined = (id: string) => (defined.get(id[0]) ?? []).includes(Number(id.slice(1)));
const idsIn = (cell: string) => cell.match(/\b[A-Z]\d+\b/g) ?? [];

for (const [letter, ids] of [...defined].sort()) {
  check(ids.every((n, i) => n === i + 1), `${letter}1 to ${letter}${ids.length} are each defined once, in order (found: ${ids.join(", ")})`);
  const stale: string[] = [];
  for (const [file, body] of text) {
    body.split("\n").forEach((line, i) => {
      for (const [, end] of line.matchAll(new RegExp(`\\b${letter}1 to ${letter}?(\\d+)\\b`, "g"))) if (Number(end) !== ids.length) stale.push(`${letter}${end} at ${file}:${i + 1}`);
    });
  }
  check(stale.length === 0, `every "${letter}1 to" range in the plan and the briefs ends at ${letter}${ids.length} (stale: ${stale.join(", ") || "none"})`);
}

const handoff = (body: string) => [...body.matchAll(/```text\n(## HANDOFF\n[\s\S]*?)\n```/g)].map((m) => m[1]);
const planHandoffs = handoff(plan);
const doneMeans = planHandoffs.map((block) => /^DONE MEANS: .*$/m.exec(block)?.[0] ?? "").join("\n");
for (const file of briefs) {
  const blocks = handoff(text.get(file)!);
  check(blocks.length === 1 && planHandoffs.includes(blocks[0]), `the HANDOFF block of ${file} equals its copy in the plan`);
}
for (const letter of [...defined.keys()].filter((l) => l !== "D").sort()) {
  check(new RegExp(`\\b${letter}1 to ${letter}${last(letter)}\\b`).test(doneMeans), `a DONE MEANS line requires ${letter}1 to ${letter}${last(letter)}`);
}

const tables = tablesOf(plan);
const casesOf = (table: Table | undefined, row: string[]) => (table?.header.at(-1) === "Cases" ? idsIn(row.at(-1) ?? "") : []);
const named = (ids: string[]) => ids.length > 0 && ids.every(isDefined);

for (const table of tables.filter((t) => t.header.at(-1) === "Cases" && t.heading !== MISSING_TABLE && t.heading !== MUST_HANDLE_TABLE)) {
  for (const row of table.rows) check(named(casesOf(table, row)), `"${table.heading}": "${row[0]}" names a required case (${casesOf(table, row).join(", ") || "none"})`);
}

const missing = tables.find((t) => t.heading === MISSING_TABLE);
check((missing?.rows.length ?? 0) > 0, `the plan has the table "${MISSING_TABLE}"`);
for (const row of missing?.rows ?? []) check(named(casesOf(missing, row)), `"${MISSING_TABLE}": "${row[0]}" names a required case (${casesOf(missing, row).join(", ") || "none"})`);

const flat = (words: string) => words.replace(/\s+/g, " ").trim();
const rules = (read("CLAUDE.md").split(`## ${MUST_HANDLE_RULES}\n`)[1] ?? "")
  .split(/\n## /)[0]
  .split(/\n(?=- )/)
  .map((rule) => flat(rule.replace(/^- /, "")))
  .filter(Boolean);
const mustHandle = tables.find((t) => t.heading === MUST_HANDLE_TABLE);
check(rules.length > 0, `CLAUDE.md lists rules under "${MUST_HANDLE_RULES}" (${rules.length})`);
for (const rule of rules) {
  const row = mustHandle?.rows.find((r) => r[0].length >= 10 && rule.startsWith(flat(r[0])));
  const ids = row ? casesOf(mustHandle, row) : [];
  check(named(ids), `CLAUDE.md "${rule.slice(0, 48)}…" has a row under "${MUST_HANDLE_TABLE}" that names a required case (${ids.join(", ") || "none"})`);
}
check((mustHandle?.rows.length ?? 0) === rules.length, `"${MUST_HANDLE_TABLE}" has one row for each CLAUDE.md rule (${mustHandle?.rows.length ?? 0} of ${rules.length})`);

if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
