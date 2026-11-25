import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) => readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n");
const PLAN = "docs/PLAN-chord-grab.md";
const plan = read(PLAN);

let failures = 0;
const check = (ok: boolean, message: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
};

const COOKS = [
  { letter: "A", brief: "chord-grab-app" },
  { letter: "S", brief: "chord-grab-share" },
];

type Design = { what: string; heading: string; letter: string } & ({ kind: "list" } | { kind: "table"; firstColumn: string });
const DESIGNED: Design[] = [
  { what: "the Grab flow", heading: "### The flow", letter: "A", kind: "list" },
  { what: "the table of what the player sees when a Grab fails", heading: "### What the player sees when something fails", letter: "A", kind: "table", firstColumn: "Case" },
  { what: "the table of what a share shows", heading: "### What a share can and cannot do", letter: "S", kind: "table", firstColumn: "What was shared" },
];

const cases = new Map<string, string>();
const repeated: string[] = [];
for (const [, id, text] of plan.matchAll(/^- ([A-Z]\d+)\. (.+)$/gm)) {
  if (cases.has(id)) repeated.push(id);
  cases.set(id, text);
}
const idsOf = (letter: string) => [...cases.keys()].filter((id) => id.startsWith(letter));
const last = (letter: string) => idsOf(letter).length;

const section = (heading: string) => {
  const lines = plan.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && /^#{2,3} /.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
};

const cells = (row: string) => row.split("|").slice(1, -1).map((cell) => cell.trim());
const short = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}...` : text);
const labels = (text: string) => [...text.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]).filter((label) => !label.endsWith("."));

type Line = { name: string; text: string; ids: string[] };

function designedLines(design: Design): { lines: Line[]; problem?: string } {
  const body = section(design.heading);
  if (design.kind === "list") {
    const items = body.filter((line) => /^(\d+\.|-) \*\*/.test(line));
    return {
      lines: items.map((text) => {
        const tag = /Cases? ([A-Z]\d+(?:, [A-Z]\d+)*)\.$/.exec(text);
        return { name: /\*\*([^*]+)\*\*/.exec(text)![1], text: tag ? text.slice(0, tag.index) : text, ids: tag ? tag[1].split(", ") : [] };
      }),
      problem: items.length ? undefined : `no step or entry found under "${design.heading}"`,
    };
  }
  const header = body.findIndex((line) => line.startsWith("|") && cells(line)[0] === design.firstColumn);
  if (header < 0) return { lines: [], problem: `no table whose first column is "${design.firstColumn}" under "${design.heading}"` };
  const rows: string[][] = [];
  for (let i = header + 2; i < body.length && body[i].startsWith("|"); i++) rows.push(cells(body[i]));
  const column = cells(body[header]).indexOf("Cases");
  return {
    lines: rows.map((row) => ({
      name: row[0],
      text: row.filter((_, i) => i !== column).join(" | "),
      ids: column < 0 ? [] : (row[column] ?? "").split(/,\s*/).filter(Boolean),
    })),
    problem: column < 0 ? `it has no Cases column, so none of its ${rows.length} rows names a case` : undefined,
  };
}

for (const { letter } of COOKS) {
  const ids = idsOf(letter);
  const inOrder = ids.length > 0 && ids.every((id, i) => id === `${letter}${i + 1}`) && !repeated.some((id) => id.startsWith(letter));
  check(inOrder, `cases ${letter}1 to ${letter}${ids.length} are numbered in order with no gap and no repeat`);
}

for (const design of DESIGNED) {
  const { lines, problem } = designedLines(design);
  let bad = 0;
  const fail = (message: string) => {
    bad += 1;
    check(false, `${design.what}: ${message}`);
  };
  if (problem) fail(problem);
  for (const line of lines) {
    const known = line.ids.filter((id) => cases.has(id));
    const unknown = line.ids.filter((id) => !cases.has(id));
    if (unknown.length) fail(`"${short(line.name)}" names ${unknown.join(", ")}, which the case list does not hold`);
    else if (!line.ids.length && !problem) fail(`"${short(line.name)}" names no case`);
    const pool = known.length ? known : idsOf(design.letter);
    const where = known.length ? `none of the cases it names (${known.join(", ")}) says` : `no ${design.letter} case says`;
    for (const label of new Set(labels(line.text))) {
      if (!pool.some((id) => cases.get(id)!.includes(`**${label}**`))) fail(`"${short(line.name)}" shows **${label}**, and ${where} **${label}**`);
    }
  }
  if (!bad) check(true, `${design.what}: each of its ${lines.length} lines names a case that exists, and each control on a line is in a case that line names`);
}

const stops = [.../export type GrabStop = ([^;]+);/.exec(plan)?.[1].matchAll(/"([a-z-]+)"/g) ?? []].map((m) => m[1]);
const stopRows = designedLines(DESIGNED[1]).lines.map((line) => /^[^|]*\| `([a-z-]+)`/.exec(line.text)?.[1]).filter(Boolean);
check(
  stops.length > 0 && stops.every((stop) => stopRows.filter((row) => row === stop).length === 1) && stopRows.every((row) => stops.includes(row!)),
  `each GrabStop value has exactly one row of words (values: ${stops.join(", ") || "none"}; rows: ${stopRows.join(", ") || "none"})`,
);

const handoff = (text: string) => /^## HANDOFF\n(?:.*\n)*?NEEDS OWNER:.*$/m.exec(text)?.[0] ?? "";
for (const { letter, brief } of COOKS) {
  const file = `docs/cooks/${brief}.md`;
  const standalone = read(file);
  const start = plan.search(new RegExp(`^### 6\\.\\d Brief: \`${brief}\`$`, "m"));
  const inPlan = start < 0 ? "" : plan.slice(start, plan.indexOf("\n### ", start + 1) < 0 ? undefined : plan.indexOf("\n### ", start + 1));
  check(handoff(inPlan) !== "" && handoff(inPlan) === handoff(standalone), `the HANDOFF of ${file} equals the one in section 6 of the plan`);

  const n = last(letter);
  const claims = [
    { where: `DONE MEANS of ${file}`, found: new RegExp(`^DONE MEANS: cases ${letter}1 to ${letter}(\\d+) `, "m").exec(standalone) },
    { where: `DONE MEANS of the plan's ${brief} brief`, found: new RegExp(`^DONE MEANS: cases ${letter}1 to ${letter}(\\d+) `, "m").exec(inPlan) },
    { where: `"Tests first" of ${file}`, found: new RegExp(`Cases ${letter}1 to ${letter}(\\d+)[^.]* fail on that commit`).exec(standalone) },
    { where: `"Tests first" of the plan's ${brief} brief`, found: new RegExp(`Cases ${letter}1 to ${letter}(\\d+)[^.]* fail on that commit`).exec(inPlan) },
    { where: `the Unit box of the plan's ${brief} verification`, found: new RegExp(`prints \`ok\` for ${letter}1 to ${letter}(\\d+)\\.`).exec(plan) },
  ];
  const off = claims.filter(({ found }) => Number(found?.[1]) !== n).map(({ where, found }) => `${where} says ${found ? `${letter}${found[1]}` : "nothing"}`);
  check(off.length === 0, `every place that says how far the ${brief} cases run says ${letter}1 to ${letter}${n}${off.length ? ` (${off.join("; ")})` : ""}`);
}

const neverFetch = plan.includes("The app never fetches a chord site's page") && plan.includes("The Worker no longer fetches chord sheets");
check(neverFetch, "the plan states that the app never fetches a chord site's page, and that the Worker no longer fetches chord sheets");
const dropped = plan.includes("`chord-grab-worker`") && plan.includes("dropped") && plan.includes("`chord-grab-canary`");
check(dropped, "the plan records that chord-grab-worker and chord-grab-canary are dropped");

if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
