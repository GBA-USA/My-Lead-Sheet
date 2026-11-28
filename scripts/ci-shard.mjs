import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SHARDS = 4;
export const DEFAULT_SECONDS = 60;

// Median seconds per check from the deep-summary artifacts of five green Deep verify runs (Nov 28 2026), the same
// numbers as scripts/ci-check-seconds.json (check:ci-shard keeps the two equal). Largest first. A check with no
// entry is planned at DEFAULT_SECONDS; the merge step summary lists those with their measured time.
export const SECONDS = {
  "check:learn": 319, "check:guest": 219, "check:learn-songs": 204, "check:gig-check-in": 177,
  "check:ux-collapse-everywhere": 172, "check:links": 167, "check:ux-theme-sweep": 150,
  "check:ux-sheet-controls-save": 135, "check:mirror": 115, "check:stage": 114, "check:update-now": 98,
  "check:ux-band-status": 94, "check:ux-layout-fix": 94, "check:heard": 92, "check:setlist-builder": 91, "check:ux-metronome-sheet": 88,
  "check:song-info": 67, "check:ux-invite-links": 66, "check:bands": 66, "check:join-links": 61,
  "check:ux-gig-view": 56, "check:new-song": 54, "check:ux-chords-only": 52, "check:song-paste": 52,
  "check:ux-band-page": 50, "check:gig-plan-record": 49, "check:song-import": 43, "check:learn-words": 43,
  "check:offline": 41, "check:song-search": 41, "check:sync-rating": 40, "check:ux-shell-settings": 40,
  "check:chat": 35, "check:setlist-code": 34, "check:password": 32, "check:look-ahead": 31, "check:song-notes": 27,
  "check:ux-plan-gig-route": 25, "check:fanout": 25, "check:library-consistency": 25, "check:search": 25,
  "check:ux-chat-rooms": 23, "check:chordpro-phone": 22, "check:phone-layout": 22, "check:view-pill": 22,
  "check:gig-songs": 21, "check:spike-links": 20, "check:friends": 20, "check:chat-songs": 20, "check:gig-plan": 20,
  "check:ux-theme-tokens": 19, "check:learned": 18, "check:band-library": 17, "check:auth": 16, "check:headers": 14,
  "check:band-status": 14, "check:song-start": 14, "check:list-rows": 14, "check:send-song": 14,
  "check:ux-preview-entry": 13, "check:band-move": 13, "check:band-settings": 13, "check:ux-passkey-msg-fix": 12,
  "check:chords": 12, "check:time": 12, "check:chordpro-worker": 11, "check:codes": 11, "check:bar": 11,
  "check:backup": 11, "check:routes": 10, "check:teach-screen": 9, "check:google": 9, "check:account": 8,
  "check:learn-file": 8, "check:spike-server": 8, "check:privacy": 6, "check:chordpro-plan": 6,
  "check:sync-check": 5, "check:ux-datamuse-fix": 5, "check:sql-audit": 5, "check:beat-red": 4,
  "check:ux-scroll-sync": 4, "check:api": 3, "check:bpm": 1, "check:fit": 1, "check:metronome": 1, "check:teach": 1,
  "check:scroll-sync": 1, "check:screens": 1, "check:chordpro": 1, "check:learn-local": 1, "check:music": 1,
  "check:portable": 1, "check:one-copy": 1, "check:bulk-import-plan": 0, "check:personal-settings": 0,
  "check:ci-deep": 0, "check:gig": 0, "check:share-guard": 0, "check:share-rule": 0, "check:spend-guard": 0,
  "check:chord-grab-plan": 0, "check:legal-audit": 0, "check:scroll": 0, "check:ux-settings-only-old-build": 0,
  "check:data": 0, "check:storage": 0,
};

const BOX_ONLY = {};

export const checkNames = () =>
  Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts).filter((k) => k.startsWith("check:") && !(k in BOX_ONLY));

export function plan(n, table = SECONDS) {
  const seconds = (name) => table[name] ?? DEFAULT_SECONDS;
  const shards = Array.from({ length: n }, (_, i) => ({ shard: i + 1, names: [], seconds: 0 }));
  const order = checkNames().sort((a, b) => seconds(b) - seconds(a) || (a < b ? -1 : 1));
  for (const name of order) {
    const lightest = shards.reduce((best, s) => (s.seconds < best.seconds ? s : best));
    lightest.names.push(name);
    lightest.seconds += seconds(name);
  }
  return shards;
}

function unrecordedLine(rows) {
  const unrecorded = rows.filter((r) => r[0].startsWith("check:") && !(r[0] in SECONDS));
  if (!unrecorded.length) return "Checks with no recorded time: none.";
  return `**Checks with no recorded time** (planned at ${DEFAULT_SECONDS} s; add them to SECONDS in scripts/ci-shard.mjs and scripts/ci-check-seconds.json): ${unrecorded.map((r) => `${r[0]} ${r[2]}`).join(", ")}`;
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
    unrecordedLine(rows),
    "",
    bad.length ? `**${bad.length} failed:** ${bad.map((r) => `${r[0]} (${r[1]}, shard ${r[4]})`).join(", ")}` : `All ${planned.size} checks passed.`,
  ];
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  for (const r of bad) console.log(`FAIL ${r[0]} ${r[1] === "missing" ? "never reported" : `exit ${r[1]} after ${r[3]} attempt(s)`} (shard ${r[4]})`);
  console.log(bad.length ? `merge: ${bad.length} of ${rows.length} rows failed` : `merge: build and all ${planned.size} checks passed in ${shardSeconds.size} shards`);
  return bad.length ? 1 : 0;
}

// The command line runs only as the main script; scripts/check-ci-shard.ts imports plan and SECONDS.
const isMain = () => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (isMain()) {
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
}
