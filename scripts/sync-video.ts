/**
 * Film against the log (PLAN.md 7.17): reads a frame list from the 240 fps film of the Sync check and the run's log,
 * finds each phone's flashes, and prints how far each is from the `shown_at` its phone logged. The film wins: a flash
 * more than 5 ms off means the delay tables are corrected and the run repeated. Exits 1 when any flash is off.
 *
 *   node --experimental-strip-types scripts/sync-video.ts --frames <frames.csv> --log <log.json> --run <run id> [--fps 240] [--within 5] [--all]
 *
 * The frame list is CSV, a header `frame,<user id>,<user id>,...`, then one line per frame: its number in the film and
 * the brightness of each phone's screen in it, in any units. Each phone is lit above the midpoint of its own darkest
 * and brightest frame, so a dimmed phone reads the same as a bright one. The camera's clock is not band time, so the
 * film is lined up with the log by the one offset that best fits every flash, and each flash is judged against that.
 */
import { readFileSync } from "node:fs";
import { readSyncRows, SYNC_BEAT_MS } from "../src/sync-log.ts";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}
const framesFile = arg("frames");
const logFile = arg("log");
const runId = arg("run");
const fps = Number(arg("fps") ?? 240);
const withinMs = Number(arg("within") ?? 5);
const all = process.argv.includes("--all");
if (!framesFile || !logFile || !runId || !(fps > 0) || !(withinMs > 0)) {
  console.error("usage: node --experimental-strip-types scripts/sync-video.ts --frames <frames.csv> --log <log.json> --run <run id> [--fps 240] [--within 5] [--all]");
  process.exit(2);
}

/** Each phone's flash onsets on film, in film milliseconds: the first lit frame after a dark one. */
function flashes(csv: string): Map<string, number[]> {
  const [header, ...lines] = csv.split(/\r?\n/).filter((line) => line.trim());
  const users = header.split(",").slice(1).map((cell) => cell.trim());
  const frames = lines.map((line) => line.split(",").map(Number));
  const onsets = new Map<string, number[]>();
  users.forEach((user, column) => {
    const levels = frames.map((cells) => cells[column + 1]);
    const threshold = (Math.min(...levels) + Math.max(...levels)) / 2;
    const found: number[] = [];
    for (let i = 1; i < frames.length; i += 1) {
      if (levels[i] > threshold && levels[i - 1] <= threshold) found.push((frames[i][0] * 1000) / fps);
    }
    onsets.set(user, found);
  });
  return onsets;
}

type Logged = { beat: number; shown: number };
type Flash = { user: string; film: number; beat: number; shown: number; off: number };

const nearest = (shown: Logged[], at: number) => shown.reduce((best, each) => (Math.abs(each.shown - at) < Math.abs(best.shown - at) ? each : best));
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Every flash matched to its phone's nearest logged beat under one film-to-band offset. */
function match(onsets: Map<string, number[]>, logs: Map<string, Logged[]>, offset: number): Flash[] {
  return [...onsets].flatMap(([user, films]) =>
    films.map((film) => {
      const { beat, shown } = nearest(logs.get(user)!, film - offset);
      return { user, film, beat, shown, off: film - offset - shown };
    }),
  );
}

/** Two fits this close, in mean ms per flash, can't be told apart, so the film can't say which flash is which beat. */
const SAME_FIT_MS = 0.5;

/**
 * Tries every pairing of a flash with a logged beat as the offset and keeps the best fit, centered on the median.
 * Every beat is 500 ms from the next, so a fit one beat over is told apart only by the frame-to-frame jitter in the
 * logs. When a fit at another beat is as good, the line-up is ambiguous and nothing is judged.
 */
function lineUp(onsets: Map<string, number[]>, logs: Map<string, Logged[]>): { offset: number; ambiguous: boolean } {
  const flashCount = [...onsets.values()].reduce((sum, films) => sum + films.length, 0);
  const fit = (offset: number) => match(onsets, logs, offset).reduce((sum, flash) => sum + Math.min(Math.abs(flash.off), SYNC_BEAT_MS / 2), 0) / flashCount;
  const tried: { offset: number; fit: number }[] = [];
  for (const [user, films] of onsets) {
    if (!films.length) continue;
    for (const { shown } of logs.get(user)!) {
      const rough = films[0] - shown;
      const offset = rough + median(match(onsets, logs, rough).map((flash) => flash.off));
      tried.push({ offset, fit: fit(offset) });
    }
  }
  tried.sort((a, b) => a.fit - b.fit);
  const [best] = tried;
  const rival = tried.find((each) => Math.abs(each.offset - best.offset) >= SYNC_BEAT_MS / 2);
  return { offset: best.offset, ambiguous: !!rival && rival.fit - best.fit < SAME_FIT_MS };
}

const onsets = flashes(readFileSync(framesFile, "utf8"));
const rows = readSyncRows(readFileSync(logFile, "utf8")).filter((row) => row.run_id === runId);
const logs = new Map<string, Logged[]>();
for (const row of rows) if (row.shown_at !== null) (logs.get(row.user_id) ?? logs.set(row.user_id, []).get(row.user_id)!).push({ beat: row.beat, shown: row.shown_at });

const missing = [...onsets.keys()].filter((user) => !logs.get(user)?.length);
const filmed = new Map([...onsets].filter(([user]) => !missing.includes(user)));
const { offset, ambiguous } = [...filmed.values()].some((films) => films.length) ? lineUp(filmed, logs) : { offset: 0, ambiguous: false };

/** The screen flashes before and after a run too. A flash further than half a beat from the run's logged beats is not judged. */
const inRun = (user: string, film: number) => {
  const shown = logs.get(user)!.map((each) => each.shown);
  return film - offset >= Math.min(...shown) - SYNC_BEAT_MS / 2 && film - offset <= Math.max(...shown) + SYNC_BEAT_MS / 2;
};

const ms = (value: number) => value.toFixed(1);
const signed = (value: number) => `${value < 0 ? "-" : "+"}${ms(Math.abs(value))}`;
const lines: string[] = [];
let pass = missing.length === 0 && filmed.size > 0 && !ambiguous;
for (const user of missing) lines.push(`  ${user} · not in the log for run ${runId} · FAIL`);
if (ambiguous) {
  lines.push("  The film fits the log as well a beat or more over, so it can't say which flash is which beat.");
  lines.push("  Every phone's log should carry its own frame-to-frame jitter in shown_at. Check the log is this film's run.");
}
for (const [user, films] of ambiguous ? [] : filmed) {
  const judged = films.filter((film) => inRun(user, film));
  const mine = match(new Map([[user, judged]]), logs, offset);
  const worst = Math.max(0, ...mine.map((flash) => Math.abs(flash.off)));
  const beats = mine.map((flash) => flash.beat);
  const twice = [...new Set(beats.filter((beat, i) => beats.indexOf(beat) !== i))];
  const ok = judged.length > 0 && worst <= withinMs && twice.length === 0;
  pass &&= ok;
  lines.push(`  ${user} · ${judged.length} flashes · worst ${ms(worst)} ms from the log · ${ok ? "ok" : "FAIL"}`);
  if (judged.length < films.length) lines.push(`    ${user}: ${films.length - judged.length} flashes outside the run, not judged`);
  for (const beat of twice) lines.push(`    ${user} beat ${beat} flashed twice`);
  for (const flash of mine) {
    if (all || Math.abs(flash.off) > withinMs) lines.push(`    ${user} beat ${flash.beat} film ${ms(flash.film)} ms log ${ms(flash.shown)} ms off ${signed(flash.off)} ms`);
  }
}
console.log(`Film run ${runId}: offset ${ms(offset)} ms, ${fps} fps, within ${withinMs} ms · ${pass ? "PASS" : "FAIL"}`);
for (const line of lines) console.log(line);
process.exit(pass ? 0 : 1);
