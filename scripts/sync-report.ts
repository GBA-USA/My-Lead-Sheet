/**
 * The sync report (PLAN.md 7.17): reads Sync check logs and prints, for every run, each pair of phones' screen and click
 * gaps at p95 and max against the PLAN.md 7.15 target for the looser route of the two, and each phone's logged spread.
 * Exits 1 when anything misses its target, so a run can gate a script.
 *
 *   node --experimental-strip-types scripts/sync-report.ts <log.json> [more logs...]
 *
 * A log is what `POST /api/bands/sync/rows` answers (`{ rows: [...] }`), a JSON list of rows, or one row per line.
 */
import { readFileSync } from "node:fs";
import { ROUTE_WORDS } from "../src/routes.ts";
import { readSyncRows, SPREAD_TARGET_MS, SYNC_TARGETS, syncReport, type Spread } from "../src/sync-log.ts";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node --experimental-strip-types scripts/sync-report.ts <log.json> [more logs...]");
  process.exit(2);
}

let rows;
try {
  rows = files.flatMap((file) => readSyncRows(readFileSync(file, "utf8")));
} catch (error) {
  console.error(`sync-report: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
}

const ms = (value: number) => value.toFixed(1);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const gap = (name: string, measured: Spread | null, [p95, max]: readonly [number, number]) =>
  measured ? `${name} p95 ${ms(measured.p95)} / max ${ms(measured.max)} ms (target ${p95} / ${max})` : `${name} not seen by both`;

const reports = syncReport(rows);
for (const run of reports) {
  console.log(`Run ${run.runId}: ${plural(run.phones.length, "phone")}, ${plural(run.pairs.length, "pair")} · ${run.pass ? "PASS" : "FAIL"}`);
  for (const pair of run.pairs) {
    const target = SYNC_TARGETS[pair.route];
    console.log(`  ${pair.a} + ${pair.b} · ${ROUTE_WORDS[pair.route]} · ${gap("screens", pair.screen, target.screen)} · ${gap("clicks", pair.click, target.click)} · ${pair.pass ? "ok" : "FAIL"}`);
  }
  for (const phone of run.phones) {
    const spread = phone.spreadP95 === null ? "spread not logged" : `spread p95 ${ms(phone.spreadP95)} ms (target ${SPREAD_TARGET_MS})`;
    console.log(`  ${[phone.userId, phone.carrier, spread].filter(Boolean).join(" · ")} · ${phone.pass ? "ok" : "FAIL"}`);
  }
}
if (!reports.length) console.log("No runs in the log · FAIL");
process.exit(reports.length && reports.every((run) => run.pass) ? 0 : 1);
