import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const SHARDS = 4;
const DEFAULT_SECONDS = 20;

const SECONDS = {
  "check:ux-sheet-controls-save": 118, "check:ux-layout-fix": 81, "check:heard": 64, "check:bands": 56,
  "check:ux-band-page": 49, "check:ux-chords-only": 48, "check:offline": 38, "check:ux-shell-settings": 38,
  "check:chat": 35, "check:learn": 34, "check:setlist-code": 32, "check:password": 30, "check:spike-links": 29,
  "check:search": 24, "check:ux-chat-rooms": 22, "check:gig-plan": 19, "check:friends": 18, "check:band-library": 16,
  "check:auth": 15, "check:learned": 15, "check:headers": 13, "check:time": 13, "check:send-song": 12,
  "check:band-move": 11, "check:band-settings": 11, "check:chords": 11, "check:backup": 10, "check:codes": 10,
  "check:bar": 9, "check:spike-server": 8, "check:teach-screen": 8, "check:account": 7, "check:google": 7,
  "check:ux-theme-tokens": 7, "check:api": 3, "check:beat-red": 3, "check:privacy": 3, "check:ci-deep": 1,
};

const BOX_ONLY = {};

const checkNames = () =>
  Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts).filter((k) => k.startsWith("check:") && !(k in BOX_ONLY));

const seconds = (name) => SECONDS[name] ?? DEFAULT_SECONDS;

function plan(n) {
  const shards = Array.from({ length: n }, (_, i) => ({ shard: i + 1, names: [], seconds: 0 }));
  const order = checkNames().sort((a, b) => seconds(b) - seconds(a) || (a < b ? -1 : 1));
  for (const name of order) {
    const lightest = shards.reduce((best, s) => (s.seconds < best.seconds ? s : best));
    lightest.names.push(name);
    lightest.seconds += seconds(name);
  }
  return shards;
}

function merge(dir, out, n) {
  const planned = new Map(plan(n).flatMap((s) => s.names.map((name) => [name, s.shard])));
  const rows = [];
  const dirs = existsSync(dir) ? readdirSync(dir).filter((d) => /^summary-\d+$/.test(d)) : [];
  for (const d of dirs.sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))) {
    const file = join(dir, d, "summary.tsv");
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) rows.push([...line.split("\t").slice(0, 4), d.slice(8)]);
  }
  const reported = new Set(rows.map((r) => r[0]));
  for (const [name, shard] of planned) if (!reported.has(name)) rows.push([name, "missing", "-", "0", String(shard)]);
  writeFileSync(out, rows.map((r) => r.join("\t") + "\n").join(""));

  const bad = rows.filter((r) => r[1] !== "0");
  const shardSeconds = new Map();
  for (const r of rows) if (/^\d+s$/.test(r[2])) shardSeconds.set(r[4], (shardSeconds.get(r[4]) ?? 0) + Number.parseInt(r[2]));
  const lines = [
    `| shard | seconds |`, `|---|---|`, ...[...shardSeconds].map(([s, t]) => `| ${s} | ${t} |`), "",
    bad.length ? `**${bad.length} failed:** ${bad.map((r) => `${r[0]} (${r[1]}, shard ${r[4]})`).join(", ")}` : `All ${planned.size} checks passed.`,
  ];
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  for (const r of bad) console.log(`FAIL ${r[0]} ${r[1] === "missing" ? "never reported" : `exit ${r[1]} after ${r[3]} attempt(s)`} (shard ${r[4]})`);
  console.log(bad.length ? `merge: ${bad.length} of ${rows.length} rows failed` : `merge: build and all ${planned.size} checks passed in ${shardSeconds.size} shards`);
  return bad.length ? 1 : 0;
}

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === "plan" && Number(a) > 0) {
  const shards = plan(Number(a));
  for (const [name, why] of Object.entries(BOX_ONLY)) console.error(`box-only ${name}: ${why}`);
  for (const s of shards) console.error(`shard ${s.shard}: ${s.names.length} checks, about ${s.seconds} s: ${s.names.join(" ")}`);
  console.log(JSON.stringify(shards.map((s) => ({ shard: s.shard, names: s.names.join(" ") }))));
} else if (cmd === "merge" && a && b) {
  process.exit(merge(a, b, Number(c ?? SHARDS)));
} else {
  console.error("usage: ci-shard.mjs plan <shards> | merge <shard-summaries-dir> <out.tsv> [shards]");
  process.exit(2);
}
