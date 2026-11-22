/**
 * check:sync-check, the C20h sync proof harness (PLAN.md 7.17, FABLE-PLAN.md C20h). No real phones: every number
 * here is a known answer built from the requirement, so a report proven on these fixtures can be trusted on film.
 *
 * 1. The Sync check flashes on every band beat (the frame closest to it) and `followBand` clicks it.
 * 2. It shows the route word from `ROUTE_WORDS` and the sync bars from `syncBars`.
 * 3. Line up with the band saves `speakerDelayMs` on this phone, apart from `syncOffsetMs`, and the click moves by it.
 * 4. `sync_log` gets a row per beat per phone only during a run, keyed and stamped by the server.
 * 5. `scripts/sync-report.ts` prints each pair's p95 and max against the PLAN 7.15 targets.
 * 6. `scripts/sync-video.ts` reads a frame list and finds every flash within 5 ms of the log, or names the one that isn't.
 * 7. `docs/sync-results.md` has a row per 7.17 setup, Auto and forced, bright and dim, all "not yet measured".
 * Relay setups and the relay target row are dropped (Terry t28u).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { fakeDom, type FakeElement } from "./fake-dom.ts";
import { ROUTE_WORDS } from "../src/routes.ts";
import { DATA_KINDS } from "../src/data-kinds.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "check-sync-check-"));

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${!pass && detail ? ` (${detail})` : ""}`);
  if (!pass) failures += 1;
}
async function part(name: string, run: () => Promise<void> | void) {
  try {
    await run();
  } catch (error) {
    check(`${name}: runs`, false, error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}
const near = (actual: number | undefined | null, expected: number, within = 0.051) => typeof actual === "number" && Math.abs(actual - expected) <= within;

async function bundle(name: string, contents: string): Promise<any> {
  const out = await build({
    stdin: { contents, resolveDir: root, loader: "tsx" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    loader: { ".css": "empty" },
    external: ["cloudflare:workers"],
    define: { "process.env.NODE_ENV": '"production"' },
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: "silent",
  });
  const file = join(scratch, `${name}.mjs`);
  writeFileSync(file, out.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

function runScript(script: string, args: string[]) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(root, "scripts", script), ...args], { encoding: "utf8", cwd: root });
  return { status: result.status, out: `${result.stdout ?? ""}`, err: `${result.stderr ?? ""}` };
}
const writeJson = (name: string, value: unknown) => {
  const file = join(scratch, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
};

/** One sync_log row in its frozen shape (PLAN.md 5). */
type Row = {
  run_id: string;
  user_id: string;
  beat: number;
  route: string;
  carrier: string;
  at: number;
  shown_at: number | null;
  clicked_at: number | null;
  offset_ms: number;
  spread_ms: number | null;
  rtt_ms: number | null;
  frame_ms: number | null;
};
const FROZEN_COLUMNS = ["run_id", "user_id", "beat", "route", "carrier", "at", "shown_at", "clicked_at", "offset_ms", "spread_ms", "rtt_ms", "frame_ms"];
const BEAT_MS = 500;
const beatAt = (n: number) => 1000 + BEAT_MS * n;
const row = (run: string, user: string, n: number, route: string, more: Partial<Row> = {}): Row => ({
  run_id: run,
  user_id: user,
  beat: n,
  route,
  carrier: "",
  at: beatAt(n),
  shown_at: beatAt(n),
  clicked_at: beatAt(n),
  offset_ms: 0,
  spread_ms: 1,
  rtt_ms: 20,
  frame_ms: 16.7,
  ...more,
});
const BEATS = Array.from({ length: 20 }, (_, n) => n);
const shuffled = <T,>(items: T[]) => items.map((item, i) => ({ item, key: (i * 7919) % 101 })).sort((a, b) => a.key - b.key).map(({ item }) => item);

// ---------------------------------------------------------------------------------------------------------------
// 5. sync-report.ts on fixture logs with known answers.
// ---------------------------------------------------------------------------------------------------------------
await part("sync-report", () => {
  // r-wifi: A leads, B and C on the Wi-Fi link. B's screen is 0.5n ms late and its click 0.2n ms late.
  // Over 20 beats the nearest-rank p95 is the 19th smallest: screens 9.0 (max 9.5), clicks 3.6 (max 3.8).
  // C's spread runs 0.3k ms, so its p95 is 5.4 ms, over the 5 ms bar.
  const wifi = [
    ...BEATS.map((n) => row("r-wifi", "A", n, "leader", { spread_ms: 0 })),
    ...BEATS.map((n) => row("r-wifi", "B", n, "wifi", { shown_at: beatAt(n) + 0.5 * n, clicked_at: beatAt(n) + 0.2 * n })),
    ...BEATS.map((n) => row("r-wifi", "C", n, "wifi", { spread_ms: 0.3 * n })),
  ];
  // r-mixed: D leads, E is on the Wi-Fi link for 5 beats then over the internet, F on the server with one beat unseen.
  // D+E is held to the internet target (the looser route E used): screens 18 / 19 pass 18 / 32, clicks 9.0 / 9.5 fail 8 / 18.
  // E+F is held to the server target: screens 19 / 19 (19 beats) pass 20 / 35, clicks 9.0 / 9.5 pass 10 / 20.
  const mixed = [
    ...BEATS.map((n) => row("r-mixed", "D", n, "leader")),
    ...BEATS.map((n) => row("r-mixed", "E", n, n < 5 ? "wifi" : "internet", { shown_at: beatAt(n) + n, clicked_at: beatAt(n) + 0.5 * n })),
    ...BEATS.map((n) => row("r-mixed", "F", n, "server", n === 3 ? { shown_at: null } : {})),
  ];
  // r-pass: G leads, H on the Wi-Fi link 1 ms late on screen and 0.5 ms on the click.
  const passing = [
    ...BEATS.map((n) => row("r-pass", "G", n, "leader")),
    ...BEATS.map((n) => row("r-pass", "H", n, "wifi", { shown_at: beatAt(n) + 1, clicked_at: beatAt(n) + 0.5 })),
  ];

  const all = runScript("sync-report.ts", [writeJson("report-all.json", shuffled([...wifi, ...mixed, ...passing]))]);
  const lines = all.out.split(/\r?\n/);
  const header = (run: string) => lines.map((line) => line.match(new RegExp(`^Run ${run}: (\\d+) phones?, (\\d+) pairs? · (PASS|FAIL)$`))).find(Boolean);
  const pair = (a: string, b: string) => {
    const pattern = new RegExp(
      `^  ${a} \\+ ${b} · (.+?) · screens p95 ([\\d.]+) / max ([\\d.]+) ms \\(target (\\d+) / (\\d+)\\) · clicks p95 ([\\d.]+) / max ([\\d.]+) ms \\(target (\\d+) / (\\d+)\\) · (ok|FAIL)$`,
    );
    const found = lines.map((line) => line.match(pattern)).find(Boolean);
    if (!found) return null;
    const [, word, s95, sMax, sT95, sTMax, c95, cMax, cT95, cTMax, verdict] = found;
    return { word, screen: [Number(s95), Number(sMax)], screenTarget: [Number(sT95), Number(sTMax)], click: [Number(c95), Number(cMax)], clickTarget: [Number(cT95), Number(cTMax)], verdict };
  };
  const phone = (id: string) => {
    const found = lines.map((line) => line.match(new RegExp(`^  ${id} · (?:[^·]+ · )?spread p95 ([\\d.]+) ms \\(target 5\\) · (ok|FAIL)$`))).find(Boolean);
    return found ? { spread: Number(found[1]), verdict: found[2] } : null;
  };
  const samePair = (name: string, got: ReturnType<typeof pair>, want: NonNullable<ReturnType<typeof pair>>) =>
    check(
      name,
      !!got &&
        got.word === want.word &&
        got.verdict === want.verdict &&
        [0, 1].every((i) => near(got.screen[i], want.screen[i]) && near(got.click[i], want.click[i]) && got.screenTarget[i] === want.screenTarget[i] && got.clickTarget[i] === want.clickTarget[i]),
      `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
    );

  check("sync-report exits 1 when any run misses a target", all.status === 1, `exit ${all.status}, stderr ${all.err.slice(0, 400)}`);
  const wifiHead = header("r-wifi");
  check("r-wifi: 3 phones, 3 pairs, FAIL (C's spread)", !!wifiHead && wifiHead[1] === "3" && wifiHead[2] === "3" && wifiHead[3] === "FAIL", all.out.slice(0, 600));
  samePair("r-wifi A+B: Wi-Fi link target 17 / 30 and 5 / 10, screens 9.0 / 9.5, clicks 3.6 / 3.8, ok", pair("A", "B"), {
    word: ROUTE_WORDS.wifi, screen: [9, 9.5], screenTarget: [17, 30], click: [3.6, 3.8], clickTarget: [5, 10], verdict: "ok",
  });
  samePair("r-wifi A+C: all in time, ok", pair("A", "C"), { word: ROUTE_WORDS.wifi, screen: [0, 0], screenTarget: [17, 30], click: [0, 0], clickTarget: [5, 10], verdict: "ok" });
  samePair("r-wifi B+C: the same gap as A+B, ok", pair("B", "C"), { word: ROUTE_WORDS.wifi, screen: [9, 9.5], screenTarget: [17, 30], click: [3.6, 3.8], clickTarget: [5, 10], verdict: "ok" });
  const spreadC = phone("C");
  check("r-wifi C: spread p95 5.4 ms is over 5 ms, FAIL", !!spreadC && near(spreadC.spread, 5.4) && spreadC.verdict === "FAIL", JSON.stringify(spreadC));
  const spreadB = phone("B");
  check("r-wifi B: spread p95 1.0 ms, ok", !!spreadB && near(spreadB.spread, 1) && spreadB.verdict === "ok", JSON.stringify(spreadB));

  const mixedHead = header("r-mixed");
  check("r-mixed: 3 phones, 3 pairs, FAIL (D+E clicks)", !!mixedHead && mixedHead[1] === "3" && mixedHead[2] === "3" && mixedHead[3] === "FAIL", all.out.slice(0, 600));
  samePair("r-mixed D+E: held to the internet target, the looser route E used; clicks 9.0 over 8, FAIL", pair("D", "E"), {
    word: ROUTE_WORDS.internet, screen: [18, 19], screenTarget: [18, 32], click: [9, 9.5], clickTarget: [8, 18], verdict: "FAIL",
  });
  samePair("r-mixed D+F: server target, ok", pair("D", "F"), { word: ROUTE_WORDS.server, screen: [0, 0], screenTarget: [20, 35], click: [0, 0], clickTarget: [10, 20], verdict: "ok" });
  samePair("r-mixed E+F: the looser of internet and server; the unseen beat is left out, ok", pair("E", "F"), {
    word: ROUTE_WORDS.server, screen: [19, 19], screenTarget: [20, 35], click: [9, 9.5], clickTarget: [10, 20], verdict: "ok",
  });

  const passHead = header("r-pass");
  check("r-pass: 2 phones, 1 pair, PASS", !!passHead && passHead[1] === "2" && passHead[2] === "1" && passHead[3] === "PASS", all.out.slice(0, 600));
  const only = runScript("sync-report.ts", [writeJson("report-pass.json", { rows: passing })]);
  check("sync-report exits 0 when every pair and phone meets its target", only.status === 0 && /^Run r-pass: 2 phones, 1 pair · PASS$/m.test(only.out), `exit ${only.status}: ${only.out}${only.err}`);
  check("no report line names the relay", !/relay/i.test(all.out), all.out);
});

// ---------------------------------------------------------------------------------------------------------------
// 6. sync-video.ts on fixture frames with known answers.
// ---------------------------------------------------------------------------------------------------------------
await part("sync-video", () => {
  const FPS = 240;
  const FLASH_MS = 100;
  /** Film starts 2249.3 band ms in, so beats 0-2 are before it and each phone shows 17 flashes (beats 3-19). */
  const FILM_START_BAND = 2249.3;
  const logged = (user: string, n: number) => beatAt(n) + (user === "B" && n % 2 === 0 ? 1.5 : 0);
  const log = ["A", "B", "C"].flatMap((user) => BEATS.map((n) => row("film", user, n, user === "A" ? "leader" : "wifi", { shown_at: logged(user, n) })));
  /** Brightness when lit and dark: B is a dimmed phone, so a fixed threshold would miss it. */
  const LEVELS: Record<string, [number, number]> = { A: [250, 12], B: [60, 20], C: [200, 30] };
  const frames = (errorMs: (user: string, n: number) => number) => {
    const users = ["A", "B", "C"];
    const lines = [`frame,${users.join(",")}`];
    const lastMs = beatAt(19) + 300 - FILM_START_BAND;
    for (let i = 0; (i * 1000) / FPS <= lastMs; i += 1) {
      const t = (i * 1000) / FPS;
      const cells = users.map((user) => {
        const lit = BEATS.some((n) => {
          const flash = logged(user, n) + errorMs(user, n) - FILM_START_BAND;
          return t >= flash && t < flash + FLASH_MS;
        });
        return LEVELS[user][lit ? 0 : 1];
      });
      lines.push(`${i},${cells.join(",")}`);
    }
    const file = join(scratch, `frames-${lines.length}-${errorMs("C", 7)}.csv`);
    writeFileSync(file, `${lines.join("\n")}\n`);
    return file;
  };
  const logFile = writeJson("video-log.json", log);
  const perPhone = (out: string, user: string) => {
    const found = out.match(new RegExp(`^  ${user} · (\\d+) flashes · worst ([\\d.]+) ms from the log · (ok|FAIL)$`, "m"));
    return found ? { flashes: Number(found[1]), worst: Number(found[2]), verdict: found[3] } : null;
  };

  // C's flash for beat 7 shows 9 ms later on film than its log says. Everything else is off only by the 240 fps frame.
  const late = runScript("sync-video.ts", ["--frames", frames((user, n) => (user === "C" && n === 7 ? 9 : 0)), "--log", logFile, "--run", "film", "--fps", String(FPS)]);
  check("sync-video exits 1 when a flash is more than 5 ms from the log", late.status === 1, `exit ${late.status}: ${late.out}${late.err.slice(0, 400)}`);
  check("sync-video headline is FAIL", /^Film run film: .*· FAIL$/m.test(late.out), late.out);
  const a = perPhone(late.out, "A");
  const b = perPhone(late.out, "B");
  const c = perPhone(late.out, "C");
  check("A: 17 flashes found (film starts at beat 3), all within one 240 fps frame, ok", !!a && a.flashes === 17 && a.worst <= 1000 / FPS + 0.05 && a.verdict === "ok", JSON.stringify(a));
  check("B (dimmed, 1.5 ms log jitter): 17 flashes, ok", !!b && b.flashes === 17 && b.worst <= 1000 / FPS + 0.05 && b.verdict === "ok", JSON.stringify(b));
  check("C: 17 flashes, worst about 9 ms, FAIL", !!c && c.flashes === 17 && c.worst > 5 && c.worst < 13.5 && c.verdict === "FAIL", JSON.stringify(c));
  check("C's beat 7 is named as the flash off the log", /^    C beat 7 film [\d.]+ ms log [\d.]+ ms off \+[\d.]+ ms$/m.test(late.out), late.out);
  check("no other flash is named", (late.out.match(/^    \S+ beat \d+ /gm) ?? []).length === 1, late.out);

  const clean = runScript("sync-video.ts", ["--frames", frames(() => 0), "--log", logFile, "--run", "film", "--fps", String(FPS)]);
  check("sync-video exits 0 and says PASS when every flash is within 5 ms", clean.status === 0 && /^Film run film: .*· PASS$/m.test(clean.out), `exit ${clean.status}: ${clean.out}${clean.err.slice(0, 400)}`);
  const allFlashes = runScript("sync-video.ts", ["--frames", frames(() => 0), "--log", logFile, "--run", "film", "--fps", String(FPS), "--all"]);
  check("--all prints every flash time: 51 lines for 3 phones x 17 beats", (allFlashes.out.match(/^    \S+ beat \d+ film [\d.]+ ms log [\d.]+ ms off [+-][\d.]+ ms$/gm) ?? []).length === 51, allFlashes.out.slice(0, 800));
});

// ---------------------------------------------------------------------------------------------------------------
// 7. docs/sync-results.md: a row per setup in 7.17, marked not yet measured.
// ---------------------------------------------------------------------------------------------------------------
await part("sync-results doc", () => {
  const SETUPS_WITH_AUTO = [
    "Wi-Fi link, band's own router",
    "Wi-Fi link, venue-style Wi-Fi that lets phones see each other",
    "Venue-style Wi-Fi that keeps phones apart",
    "Venue-style Wi-Fi with a sign-in page",
    "Venue-style Wi-Fi with UDP blocked",
    "Wi-Fi link, leader's iPhone hotspot",
    "Wi-Fi link, Android hotspot",
    "Over the internet, cell, Verizon",
    "Over the internet, cell, AT&T",
    "Over the internet, cell, T-Mobile",
    "Server",
  ];
  const MIXED = ["Mixed run: 2 Wi-Fi link, 1 over the internet on cell, 1 server", "Real venue Wi-Fi, if one is at hand"];
  const text = readFileSync(join(root, "docs", "sync-results.md"), "utf8");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\|\s*Setup\s*\|/.test(line));
  check("the doc has a results table headed Setup", start >= 0);
  const head = lines[start].split("|").slice(1, -1).map((cell) => cell.trim());
  check("its columns are Setup, Route, Brightness, then the measurements", head[0] === "Setup" && head[1] === "Route" && head[2] === "Brightness" && head.length >= 6, head.join(" | "));
  const rows: string[][] = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith("|"); i += 1) rows.push(lines[i].split("|").slice(1, -1).map((cell) => cell.trim()));
  const of = (setup: string) => rows.filter((cells) => cells[0] === setup);
  for (const setup of SETUPS_WITH_AUTO) {
    const mine = of(setup);
    const has = (route: (word: string) => boolean, brightness: string) => mine.some((cells) => route(cells[1]) && cells[2] === brightness);
    check(
      `"${setup}": Auto and forced, each at Full and Dim`,
      has((word) => word === "Auto", "Full") && has((word) => word === "Auto", "Dim") && has((word) => word !== "Auto" && word !== "", "Full") && has((word) => word !== "Auto" && word !== "", "Dim"),
      JSON.stringify(mine),
    );
  }
  for (const setup of MIXED) {
    const mine = of(setup);
    check(`"${setup}": a Full and a Dim row`, mine.some((cells) => cells[2] === "Full") && mine.some((cells) => cells[2] === "Dim"), JSON.stringify(mine));
  }
  const known = new Set([...SETUPS_WITH_AUTO, ...MIXED]);
  check("every row is a 7.17 setup", rows.every((cells) => known.has(cells[0])), rows.filter((cells) => !known.has(cells[0])).map((cells) => cells[0]).join("; "));
  check("every measurement in every row says not yet measured", rows.length > 0 && rows.every((cells) => cells.slice(3).every((cell) => cell === "not yet measured")));
  check("no row is a relay setup (Terry t28u)", !rows.some((cells) => /relay/i.test(cells.join(" "))));
});

// ---------------------------------------------------------------------------------------------------------------
// 4. sync_log in the Room: rows only during a run, keyed and stamped by the server.
// ---------------------------------------------------------------------------------------------------------------
await part("sync_log", async () => {
  const w = await bundle(
    "worker",
    `export { createSyncLogTables, syncLogRoom, syncLogRoutes, SYNC_LOG_GRACE_MS } from "./worker/room-sync-log.ts";
     export { createMemberTables, bandRoom } from "./worker/room-members.ts";
     export { SYNC_RUN_MS } from "./src/sync-log.ts";`,
  );
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  /** Durable Object SQL storage over node:sqlite: `exec` with bindings, a cursor with `toArray`, `one` and `rowsWritten`. */
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      const reads = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query);
      const rows = reads ? (statement.all(...(bindings as never[])) as Record<string, unknown>[]) : [];
      const rowsWritten = reads ? 0 : Number(statement.run(...(bindings as never[])).changes);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0];
        },
        rowsWritten,
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  };
  const BAND = "band_SyncCheckBand000000000";
  const band = { sql, bandId: BAND };
  w.createMemberTables(sql);
  w.createSyncLogTables(sql);
  const t0 = 1_800_000_000_000;
  w.bandRoom.create(band, { userId: "u-admin", name: "Ann" }, "The Sync Band", t0);
  w.bandRoom.join(band, { userId: "u-bob", name: "Bob" }, { inviterId: "u-admin", madeAt: t0 }, t0);
  w.bandRoom.join(band, { userId: "u-cat", name: "Cat" }, { inviterId: "u-admin", madeAt: t0 }, t0);
  w.bandRoom.remove(band, "u-admin", "u-cat", t0);

  const count = () => Number(sql.exec(`SELECT count(*) AS n FROM sync_log`).one().n);
  const refusal = (run: () => unknown) => {
    try {
      run();
      return "none";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const columns = sql.exec(`PRAGMA table_info(sync_log)`).toArray() as { name: string; pk: number }[];
  check("sync_log has exactly the frozen columns, in order", JSON.stringify(columns.map((c) => c.name)) === JSON.stringify(FROZEN_COLUMNS), columns.map((c) => c.name).join(","));
  check(
    "sync_log is keyed (run_id, user_id, beat)",
    JSON.stringify(columns.filter((c) => c.pk > 0).sort((x, y) => x.pk - y.pk).map((c) => c.name)) === JSON.stringify(["run_id", "user_id", "beat"]),
  );

  const beat = (n: number, more: Record<string, unknown> = {}) => ({
    beat: n, route: "wifi", carrier: "Verizon", at: 0, shown_at: 3.25, clicked_at: -1.5, offset_ms: 412.5, spread_ms: 1.25, rtt_ms: 18.5, frame_ms: 16.6, ...more,
  });
  check("before any run, a write is refused no-sync-run", refusal(() => w.syncLogRoom.write(band, "u-bob", "run_nothing", [beat(0)], t0)) === "no-sync-run");
  check("before any run, no run is live", w.syncLogRoom.current(band, "u-bob", t0) === null);
  check("before any run, sync_log has zero rows", count() === 0);
  check("a member who is not an admin cannot start a run", refusal(() => w.syncLogRoom.start(band, "u-bob", t0)) === "not-admin");
  check("a removed member cannot start a run", refusal(() => w.syncLogRoom.start(band, "u-cat", t0)) === "not-a-member");

  const run = w.syncLogRoom.start(band, "u-admin", t0);
  check("the admin starts a run: an id, a start after now on a beat, 60 s long", typeof run.runId === "string" && run.runId.length > 8 && run.startAt >= t0 && run.startAt % BEAT_MS === 0 && run.endsAt - run.startAt === w.SYNC_RUN_MS && w.SYNC_RUN_MS === 60_000, JSON.stringify(run));
  check("a second tap on Start gives the same run, not a second one", w.syncLogRoom.start(band, "u-admin", t0 + 500).runId === run.runId);
  check("a member sees the live run", w.syncLogRoom.current(band, "u-bob", t0 + 1000)?.runId === run.runId);
  check("a removed member is refused the live run", refusal(() => w.syncLogRoom.current(band, "u-cat", t0)) === "not-a-member");

  const during = run.startAt + 2000;
  const first = w.syncLogRoom.write(band, "u-bob", run.runId, [beat(0, { at: run.startAt }), beat(1, { at: run.startAt + 500 }), beat(2, { at: run.startAt + 1000, shown_at: null })], during);
  check("during the run a member's three beats are stored", first.stored === 3 && count() === 3, JSON.stringify(first));
  const again = w.syncLogRoom.write(band, "u-bob", run.runId, [beat(0, { at: run.startAt }), beat(1, { at: run.startAt + 500 }), beat(2, { at: run.startAt + 1000, shown_at: null })], during + 100);
  check("sending the same beats again stores nothing new (no duplicates on reconnect)", again.stored === 0 && count() === 3, JSON.stringify(again));
  check("a removed member's beats are refused", refusal(() => w.syncLogRoom.write(band, "u-cat", run.runId, [beat(3)], during)) === "not-a-member" && count() === 3);
  check("a beat past the run's end is refused bad-request", refusal(() => w.syncLogRoom.write(band, "u-bob", run.runId, [beat(w.SYNC_RUN_MS / BEAT_MS)], during)) === "bad-request" && count() === 3);
  check("a write to another run id is refused no-sync-run", refusal(() => w.syncLogRoom.write(band, "u-bob", "run_other", [beat(3)], during)) === "no-sync-run" && count() === 3);
  const stored = w.syncLogRoom.rows(band, "u-admin", run.runId) as Row[];
  const zero = stored.find((each) => each.beat === 0);
  check(
    "rows read back with the run, the caller's user id and every field",
    stored.length === 3 && !!zero && zero.run_id === run.runId && zero.user_id === "u-bob" && zero.route === "wifi" && zero.carrier === "Verizon" && zero.at === run.startAt &&
      zero.shown_at === 3.25 && zero.clicked_at === -1.5 && zero.offset_ms === 412.5 && zero.spread_ms === 1.25 && zero.rtt_ms === 18.5 && zero.frame_ms === 16.6 && stored.find((each) => each.beat === 2)?.shown_at === null,
    JSON.stringify(stored),
  );
  check("a removed member cannot read the rows", refusal(() => w.syncLogRoom.rows(band, "u-cat", run.runId)) === "not-a-member");
  const lastWrite = run.endsAt + w.SYNC_LOG_GRACE_MS;
  check("the last beats can still land just after the run ends", w.syncLogRoom.write(band, "u-admin", run.runId, [beat(119, { at: run.endsAt - 500 })], lastWrite).stored === 1 && count() === 4);
  check("after the run and its grace, a write is refused no-sync-run", refusal(() => w.syncLogRoom.write(band, "u-bob", run.runId, [beat(4)], lastWrite + 1)) === "no-sync-run" && count() === 4);
  check("after the run, no run is live", w.syncLogRoom.current(band, "u-bob", run.endsAt + 1) === null);
  const next = w.syncLogRoom.start(band, "u-admin", lastWrite + 10);
  check("a new run after the last one ended is a new run", next.runId !== run.runId);

  // The routes: the server, not the phone, says whose beats they are, and the body is parsed at the boundary.
  sql.exec(`CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, handle TEXT NOT NULL, display_name TEXT NOT NULL, session_version INTEGER NOT NULL)`);
  sql.exec(`INSERT INTO users (user_id, handle, display_name, session_version) VALUES ('u-bob', 'bob', 'Bob', 1), ('u-admin', 'ann', 'Ann', 1)`);
  const calls: { method: string; bandId: string; userId: string }[] = [];
  const roomFor = (_c: unknown, bandId: string) => ({
    syncStart: async (userId: string, now: number) => (calls.push({ method: "start", bandId, userId }), w.syncLogRoom.start(band, userId, now)),
    syncCurrent: async (userId: string, now: number) => (calls.push({ method: "current", bandId, userId }), w.syncLogRoom.current(band, userId, now)),
    syncWrite: async (userId: string, runId: string, beats: unknown[], now: number) => (calls.push({ method: "write", bandId, userId }), w.syncLogRoom.write(band, userId, runId, beats, now)),
    syncRows: async (userId: string, runId: string) => (calls.push({ method: "rows", bandId, userId }), w.syncLogRoom.rows(band, userId, runId)),
  });
  const routes = w.syncLogRoutes(roomFor);
  const context = (userId: string | null, body: Record<string, unknown>, now: number) => ({
    sql, storage: {}, env: {}, now, request: new Request("http://localhost/"), body, session: userId ? { userId, version: 1, issuedAt: now } : null,
  });
  const routeRefusal = async (call: Promise<unknown>) => {
    try {
      await call;
      return "none";
    } catch (error) {
      return (error as { reason?: string }).reason ?? (error instanceof Error ? error.message : String(error));
    }
  };
  check("the four sync routes are there", ["POST /api/bands/sync/start", "POST /api/bands/sync/current", "POST /api/bands/sync/log", "POST /api/bands/sync/rows"].every((key) => typeof routes[key] === "function"), Object.keys(routes).join(", "));
  const live = next;
  const forged = await routes["POST /api/bands/sync/log"](context("u-bob", { bandId: BAND, runId: live.runId, beats: [{ ...beat(5, { at: live.startAt + 2500 }), user_id: "u-admin", run_id: "run_forged" }] }, live.startAt + 3000));
  const forgedRow = (w.syncLogRoom.rows(band, "u-admin", live.runId) as Row[]).find((each) => each.beat === 5);
  check("a beat sent with someone else's user id is stored as the caller's", (forged.body as { stored: number }).stored === 1 && forgedRow?.user_id === "u-bob" && forgedRow.run_id === live.runId, JSON.stringify(forgedRow));
  check("the route hands the room the signed-in user and the band from the body", calls.some((call) => call.method === "write" && call.userId === "u-bob" && call.bandId === BAND));
  check("a beat on the relay is refused bad-request at the boundary", (await routeRefusal(routes["POST /api/bands/sync/log"](context("u-bob", { bandId: BAND, runId: live.runId, beats: [beat(6, { route: "relay" })] }, live.startAt + 3000)))) === "bad-request");
  check("a beat with no number for at is refused bad-request", (await routeRefusal(routes["POST /api/bands/sync/log"](context("u-bob", { bandId: BAND, runId: live.runId, beats: [beat(6, { at: "soon" })] }, live.startAt + 3000)))) === "bad-request");
  check("beats that are not a list are refused bad-request", (await routeRefusal(routes["POST /api/bands/sync/log"](context("u-bob", { bandId: BAND, runId: live.runId, beats: "all of them" }, live.startAt + 3000)))) === "bad-request");
  check("a signed-out phone is refused signed-out", (await routeRefusal(routes["POST /api/bands/sync/current"](context(null, { bandId: BAND }, live.startAt)))) === "signed-out");
  check("a member asking the start route is refused not-admin", (await routeRefusal(routes["POST /api/bands/sync/start"](context("u-bob", { bandId: BAND }, live.startAt)))) === "not-admin");
  const current = await routes["POST /api/bands/sync/current"](context("u-bob", { bandId: BAND }, live.startAt));
  check("the current route answers { run } for a member", (current.body as { run: { runId: string } | null }).run?.runId === live.runId, JSON.stringify(current.body));
  const read = await routes["POST /api/bands/sync/rows"](context("u-admin", { bandId: BAND, runId: live.runId }, live.endsAt + 1));
  check("the rows route answers { rows } for the report", Array.isArray((read.body as { rows: unknown[] }).rows) && (read.body as { rows: unknown[] }).rows.length === 1, JSON.stringify(read.body));
});

// ---------------------------------------------------------------------------------------------------------------
// Data kinds and saved prefs: the new table is listed, and the speaker delay is kept apart from the dot nudge.
// ---------------------------------------------------------------------------------------------------------------
await part("data kinds", () => {
  check("sync_log is listed as server data", DATA_KINDS.some((kind) => kind.key === "sync_log" && kind.place === "server"));
  const metronome = DATA_KINDS.find((kind) => kind.key === "leadSheetsMetronome");
  check("the metronome settings entry names the speaker delay from Line up with the band", !!metronome && /speaker delay/i.test(metronome.what) && /Line up with the band/.test(metronome.what), metronome?.what);
});

// ---------------------------------------------------------------------------------------------------------------
// 1-3. The Sync check screen in a fake page: band clock, audio clock and 60 Hz frames all driven by the test.
// ---------------------------------------------------------------------------------------------------------------
await part("sync check screen", async () => {
  const FRAME = 1 / 60;
  const EPSILON = 1e-9;
  let now = 0;
  const timers = new Map<number, { at: number; every: number | null; run: () => void }>();
  let nextTimer = 1;
  let frames: ((at: number) => void)[] = [];
  const addTimer = (run: () => void, ms: number, every: boolean) => {
    const id = nextTimer++;
    timers.set(id, { at: now + Math.max(0, ms) / 1000, every: every ? Math.max(ms, 1) / 1000 : null, run });
    return id;
  };

  /** Each click as scheduled: its audio start time and frequency, and when its gain was cut, if it was. */
  const scheduled: { time: number; hz: number; gain: { cutAt: number | null } }[] = [];
  const OUTPUT_LATENCY = 0.01;
  class FakeAudioContext {
    static last: FakeAudioContext;
    state = "suspended";
    outputLatency = OUTPUT_LATENCY;
    baseLatency = 0.005;
    destination = {};
    constructor() {
      FakeAudioContext.last = this;
    }
    get currentTime() {
      return now;
    }
    getOutputTimestamp() {
      return { contextTime: now - OUTPUT_LATENCY, performanceTime: now * 1000 };
    }
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
    createOscillator() {
      const osc = {
        type: "",
        hz: 0,
        gain: { cutAt: null as number | null },
        frequency: { setValueAtTime: (hz: number) => void (osc.hz = osc.hz || hz), exponentialRampToValueAtTime() {} },
        connect: (gain: { cutAt: number | null }) => void (osc.gain = gain),
        disconnect() {},
        start: (time: number) => void scheduled.push({ time, hz: osc.hz, gain: osc.gain }),
        stop() {},
        onended: null,
      };
      return osc;
    }
    createGain() {
      const gain = { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, cutAt: null as number | null, connect() {}, disconnect: () => void (gain.cutAt ??= now) };
      return gain;
    }
  }
  /** Page seconds at which the output presents a click scheduled at audio time `time`. */
  const presented = (time: number) => time + OUTPUT_LATENCY;
  const heardClicks = (from: number) => scheduled.slice(from).filter((click) => click.gain.cutAt === null || click.gain.cutAt > click.time);

  const dom = fakeDom();
  const store = new Map<string, string>();
  Object.assign(globalThis, {
    window: {
      document: dom.document,
      AudioContext: FakeAudioContext,
      HTMLIFrameElement: class {},
      setTimeout: (run: () => void, ms: number) => addTimer(run, ms, false),
      setInterval: (run: () => void, ms: number) => addTimer(run, ms, true),
      clearTimeout: (id: number) => timers.delete(id),
      clearInterval: (id: number) => timers.delete(id),
      addEventListener() {},
      removeEventListener() {},
    },
    document: dom.document,
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (run: (at: number) => void) => frames.push(run),
    cancelAnimationFrame() {},
  });
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now * 1000, timeOrigin: 0 } });

  /** The fake server: what each phone posted, and the run it hands out. Offline makes the log route fail like no signal. */
  const posts: { path: string; body: any }[] = [];
  let serverRun: { runId: string; startAt: number; endsAt: number } | null = null;
  let logOffline = false;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (path: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      posts.push({ path: String(path), body });
      if (path === "/api/bands/sync/start") return reply({ run: serverRun });
      if (path === "/api/bands/sync/current") return reply({ run: serverRun && bandNow() < serverRun.endsAt ? serverRun : null });
      if (path === "/api/bands/sync/log") {
        if (logOffline) throw new TypeError("Failed to fetch");
        return reply({ stored: body.beats.length });
      }
      if (path === "/api/bands/sync/rows") return reply({ rows: [] });
      return reply({ error: "not-found" }, 404);
    },
  });

  const ui = await bundle(
    "screen",
    `export { SyncCheckSheet } from "./src/sync-check.tsx";
     export * as model from "./src/metronome.ts";
     export * as band from "./src/band-time.ts";
     export { METRONOME_PREFS_KEY } from "./src/storage.ts";
     export { createElement } from "react";
     export { createRoot } from "react-dom/client";`,
  );
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((done) => setImmediate(done));
  };

  type Seen = { at: number; flash: string };
  /** Advances the clock, firing timers and one animation frame per 60 Hz tick, and records the flash on each frame. */
  async function advance(seconds: number, seen: Seen[] = []) {
    const end = now + seconds;
    while (now < end - EPSILON) {
      const chunkEnd = Math.min(end, now + 0.1);
      let frameAt = Math.ceil(now / FRAME + EPSILON) * FRAME;
      while (frameAt <= chunkEnd + EPSILON) {
        const due = [...timers.entries()].sort((x, y) => x[1].at - y[1].at)[0];
        if (due && due[1].at <= frameAt) {
          now = Math.max(now, due[1].at);
          if (due[1].every == null) timers.delete(due[0]);
          else due[1].at += due[1].every;
          due[1].run();
          continue;
        }
        now = frameAt;
        const queued = frames;
        frames = [];
        queued.forEach((draw) => draw(now * 1000));
        seen.push({ at: now, flash: flashState() });
        frameAt += FRAME;
      }
      now = chunkEnd;
      await settle();
    }
    return seen;
  }

  const elements = () => dom.container.elements;
  const flashState = () => elements().find((el) => (el.getAttribute("class") ?? "").split(" ").includes("sync-flash"))?.getAttribute("data-flash") ?? "none";
  const text = () => dom.container.textContent;
  const button = (name: string) => elements().find((el) => el.nodeName === "BUTTON" && (el.textContent === name || el.getAttribute("aria-label") === name));
  const tap = async (el: FakeElement | undefined, name: string) => {
    if (!el) throw new Error(`no ${name} button`);
    dom.click(el);
    await settle();
  };
  const barsLabel = () => elements().find((el) => (el.getAttribute("aria-label") ?? "").startsWith("Sync: "))?.getAttribute("aria-label") ?? "none";
  const onsets = (seen: Seen[]) => seen.filter((frame, i) => i > 0 && frame.flash === "on" && seen[i - 1].flash !== "on").map((frame) => frame.at);
  const savedPrefs = () => JSON.parse(store.get(ui.METRONOME_PREFS_KEY) ?? "null");

  const ORIGIN = 1_731_560_000_000;
  const line = { at: ORIGIN, offset: 412_345.678, skew: 30e-6 };
  const bandAt = (perfMs: number): number => ui.band.bandAt(line, ORIGIN + perfMs);
  const bandNow = () => bandAt(now * 1000);
  const FRAME_MS = FRAME * 1000;

  /** Every beat between two times flashes exactly once, on the frame closest to it, and nothing else flashes. */
  const flashesOnBeats = (name: string, seen: Seen[], toBand: (perfMs: number) => number) => {
    const from = toBand(seen[0].at * 1000) + FRAME_MS;
    const to = toBand(seen[seen.length - 1].at * 1000) - 200;
    const flashes = onsets(seen).map((at) => toBand(at * 1000)).filter((at) => at >= from - FRAME_MS && at <= to + FRAME_MS);
    const beats: number[] = [];
    for (let n = Math.ceil(from / BEAT_MS); n * BEAT_MS <= to; n += 1) beats.push(n * BEAT_MS);
    const missed = beats.filter((at) => !flashes.some((flash) => Math.abs(flash - at) <= FRAME_MS / 2 + 0.01));
    const stray = flashes.filter((flash) => !beats.some((at) => Math.abs(flash - at) <= FRAME_MS / 2 + 0.01));
    check(`${name}: ${beats.length} beats, each flashes on the frame closest to it`, beats.length > 0 && missed.length === 0 && stray.length === 0 && flashes.length === beats.length, `missed ${missed.length}, stray ${stray.length}, ${flashes.length} flashes`);
  };
  /** Every beat between two times is clicked once, presented `speakerMs` before its band time so it is heard on it. */
  const clicksOnBeats = (name: string, fromClick: number, fromBand: number, toBand: number, speakerMs: number) => {
    const heard = heardClicks(fromClick).map((click) => bandAt(presented(click.time) * 1000) + speakerMs).filter((at) => at >= fromBand && at <= toBand);
    const beats: number[] = [];
    for (let n = Math.ceil(fromBand / BEAT_MS); n * BEAT_MS <= toBand; n += 1) beats.push(n * BEAT_MS);
    const worst = Math.max(...beats.map((at) => Math.min(...heard.map((each) => Math.abs(each - at)))));
    check(`${name}: ${beats.length} clicks, each within 0.1 ms of its band beat`, beats.length > 0 && heard.length === beats.length && worst <= 0.1, `${heard.length} heard for ${beats.length} beats, worst ${worst.toFixed(3)} ms`);
  };

  const container = dom.container;
  let root = ui.createRoot(container);
  let closed = 0;
  const render = (props: Record<string, unknown>) => root.render(ui.createElement(ui.SyncCheckSheet, { names: {}, onClose: () => (closed += 1), ...props }));

  // Saved before the screen opens: a Bluetooth dot nudge the speaker delay must not touch.
  store.set(ui.METRONOME_PREFS_KEY, JSON.stringify({ indicator: true, sound: true, syncMode: "on", syncOffsetMs: 30 }));

  // --- Alone: no leader, so the screen flashes on this phone's own click and says there is nothing to compare.
  render({ bandId: null, admin: false, link: null });
  await settle();
  const aloneFrom = scheduled.length;
  await advance(0.5);
  const alone = await advance(3);
  check('alone: the screen says "Alone · nothing to compare"', text().includes("Alone · nothing to compare"), text().slice(0, 300));
  flashesOnBeats("alone: flashes on this phone's own beat", alone, (perfMs) => perfMs);
  const aloneClicks = heardClicks(aloneFrom).map((click) => presented(click.time) * 1000).filter((at) => at >= alone[0].at * 1000 && at <= alone[alone.length - 1].at * 1000 - 200);
  const aloneFlashes = onsets(alone).map((at) => at * 1000);
  check("alone: every flash is on one of this phone's own clicks", aloneClicks.length > 0 && aloneFlashes.length >= aloneClicks.length && aloneClicks.every((click) => aloneFlashes.some((flash) => Math.abs(flash - click) <= FRAME_MS / 2 + 0.01)), `${aloneClicks.length} clicks, ${aloneFlashes.length} flashes`);
  check("alone with no band: nothing is sent to the server", posts.length === 0, posts.map((post) => post.path).join(", "));
  await tap(button("Close"), "Close");
  check("Close calls onClose", closed === 1);
  root.unmount();
  await settle();
  const afterClose = scheduled.length;
  await advance(2);
  check("after the screen closes no click is scheduled", scheduled.length === afterClose, `${scheduled.length - afterClose} scheduled after close`);

  // --- Linked on the Wi-Fi link, as an admin. No run yet: flashes and clicks follow band time, nothing is logged.
  const wifi = { route: "wifi", bandAt, offsetMs: line.offset, spreadMs: 4, rttMs: 12 };
  root = ui.createRoot(container);
  render({ bandId: "band_SyncCheckBand000000000", admin: true, link: wifi });
  await settle();
  const idleClickFrom = scheduled.length;
  await advance(0.5);
  const idleFromBand = bandNow();
  const idle = await advance(4);
  check("linked: the screen shows the Wi-Fi link route word", text().includes(ROUTE_WORDS.wifi), text().slice(0, 300));
  check("linked: 4 ms spread shows 3 of 4 sync bars", barsLabel() === "Sync: 3 of 4 bars", barsLabel());
  check("linked: it does not say alone", !text().includes("Alone"));
  flashesOnBeats("linked, no run: flashes on every band beat", idle, bandAt);
  clicksOnBeats("linked, no run: followBand clicks every band beat", idleClickFrom, idleFromBand + 150, bandNow() - 200, 0);
  check("before a run no beat is sent to sync_log", !posts.some((post) => post.path === "/api/bands/sync/log"));
  check("an admin sees Start a 60 s run", !!button("Start a 60 s run"));

  // --- The admin starts a run. The fake server gives a 10 s run (20 beats) starting on a beat 2 s from now.
  const runStart = Math.ceil((bandNow() + 2000) / BEAT_MS) * BEAT_MS;
  serverRun = { runId: "run_first", startAt: runStart, endsAt: runStart + 10_000 };
  await tap(button("Start a 60 s run"), "Start a 60 s run");
  check("Start posts the band to the start route", posts.some((post) => post.path === "/api/bands/sync/start" && post.body?.bandId === "band_SyncCheckBand000000000"));
  const runClickFrom = scheduled.length;
  const runSeen = await advance((serverRun.endsAt - bandNow()) / 1000 + 8);
  flashesOnBeats("during the run: flashes on every band beat", runSeen.filter((frame) => bandAt(frame.at * 1000) <= serverRun!.endsAt + 300), bandAt);
  clicksOnBeats("during the run: clicks on every band beat", runClickFrom, runStart, serverRun.endsAt - BEAT_MS, 0);
  const logged = posts.filter((post) => post.path === "/api/bands/sync/log").flatMap((post) => (post.body.beats as Row[]).map((beat) => ({ ...beat, runId: post.body.runId, bandId: post.body.bandId })));
  const beatsLogged = logged.map((beat) => beat.beat).sort((x, y) => x - y);
  check("every beat of the run is sent once: beats 0-19", JSON.stringify(beatsLogged) === JSON.stringify(BEATS), JSON.stringify(beatsLogged));
  check("each sent beat names the run and the band, and no user id (the server stamps that)", logged.length > 0 && logged.every((beat) => beat.runId === "run_first" && beat.bandId === "band_SyncCheckBand000000000" && !("user_id" in beat)));
  check("each beat's at is its band time on the run's grid", logged.every((beat) => near(beat.at, runStart + beat.beat * BEAT_MS, 1e-6)));
  check("each beat's shown_at is the band time of the frame that showed it, within half a frame", logged.every((beat) => beat.shown_at !== null && Math.abs(beat.shown_at - beat.at) <= FRAME_MS / 2 + 0.01), JSON.stringify(logged.map((beat) => beat.shown_at === null ? null : +(beat.shown_at - beat.at).toFixed(2))));
  check("each beat's clicked_at is when its click reached the listener, within 0.1 ms of the beat", logged.every((beat) => beat.clicked_at !== null && Math.abs(beat.clicked_at - beat.at) <= 0.1), JSON.stringify(logged.map((beat) => beat.clicked_at === null ? null : +(beat.clicked_at - beat.at).toFixed(3))));
  check("each beat carries the route, offset, spread, rtt and frame time", logged.every((beat) => beat.route === "wifi" && beat.offset_ms === line.offset && beat.spread_ms === 4 && beat.rtt_ms === 12 && near(beat.frame_ms, FRAME_MS, 0.01)));
  const loggedAfterRun = posts.filter((post) => post.path === "/api/bands/sync/log").length;
  await advance(8);
  check("after the run no more beats are sent (zero rows outside the check)", posts.filter((post) => post.path === "/api/bands/sync/log").length === loggedAfterRun);

  // --- The route word and bars follow the link.
  render({ bandId: "band_SyncCheckBand000000000", admin: true, link: { ...wifi, route: "internet", spreadMs: 9 } });
  await advance(0.5);
  check("over the internet: the screen shows that route word", text().includes(ROUTE_WORDS.internet), text().slice(0, 300));
  check("9 ms spread shows Out of sync", barsLabel() === "Sync: Out of sync", barsLabel());
  render({ bandId: "band_SyncCheckBand000000000", admin: true, link: { ...wifi, route: "server", spreadMs: 1 } });
  await advance(0.5);
  check("on the server: the screen shows that route word and 4 bars", text().includes(ROUTE_WORDS.server) && barsLabel() === "Sync: 4 of 4 bars", `${barsLabel()} ${text().slice(0, 300)}`);
  check("no route word for the relay anywhere on the screen", !/relay/i.test(text()));
  render({ bandId: "band_SyncCheckBand000000000", admin: true, link: wifi });
  await advance(0.5);

  // --- Line up with the band: "My click is late" raises the speaker delay, so the click goes out earlier by it.
  check("Line up with the band is on the screen", text().includes("Line up with the band"));
  const steps = 8;
  for (let i = 0; i < steps; i += 1) await tap(button("My click is late"), "My click is late");
  const delay = steps * ui.model.SPEAKER_DELAY_STEP_MS;
  check(`eight taps save a ${delay} ms speaker delay on this phone`, savedPrefs()?.speakerDelayMs === delay && delay > 0, JSON.stringify(savedPrefs()));
  check("the Bluetooth dot nudge is kept as it was", savedPrefs()?.syncOffsetMs === 30 && savedPrefs()?.syncMode === "on");
  check(`the screen shows Speaker delay ${delay} ms`, text().includes(`Speaker delay ${delay} ms`), text().slice(0, 400));
  const movedFrom = scheduled.length;
  await advance(0.3);
  const movedBand = bandNow();
  await advance(3);
  clicksOnBeats(`after Line up: each click goes out ${delay} ms before its beat`, movedFrom, movedBand, bandNow() - 200, delay);
  root.unmount();
  await settle();
  root = ui.createRoot(container);
  render({ bandId: "band_SyncCheckBand000000000", admin: true, link: wifi });
  await advance(0.3);
  check("the speaker delay is still there when the screen opens again", text().includes(`Speaker delay ${delay} ms`), text().slice(0, 400));
  for (let i = 0; i < steps; i += 1) await tap(button("My click is early"), "My click is early");
  check("My click is early brings it back to 0", savedPrefs()?.speakerDelayMs === 0, JSON.stringify(savedPrefs()));
  root.unmount();
  await settle();

  // --- A member, offline for the log: the beat keeps flashing, the rows are dropped, and the count shows after.
  logOffline = true;
  const offlineStart = Math.ceil((bandNow() + 1500) / BEAT_MS) * BEAT_MS;
  serverRun = { runId: "run_offline", startAt: offlineStart, endsAt: offlineStart + 5_000 };
  root = ui.createRoot(container);
  render({ bandId: "band_SyncCheckBand000000000", admin: false, link: wifi });
  await settle();
  check("a member sees no Start button", !button("Start a 60 s run"));
  const offlineSeen = await advance((serverRun.endsAt - bandNow()) / 1000 + 8);
  check("the member's phone finds the run the admin started", posts.some((post) => post.path === "/api/bands/sync/current"));
  flashesOnBeats("offline log: the beat keeps flashing through the run", offlineSeen.filter((frame) => bandAt(frame.at * 1000) >= offlineStart && bandAt(frame.at * 1000) <= serverRun!.endsAt), bandAt);
  check("offline log: after the run the screen says 10 beats not logged", text().includes("10 beats not logged"), text().slice(0, 400));
  root.unmount();
  await settle();
  logOffline = false;

  // --- Saved prefs: one bad field never resets the others, and the speaker delay defaults to 0.
  const { model } = ui;
  check("speakerDelayMs defaults to 0", model.DEFAULT_METRONOME_PREFS.speakerDelayMs === 0);
  const old = model.parseMetronomePrefs({ indicator: false, sound: true, syncMode: "on", syncOffsetMs: 50 });
  check("prefs saved before Line up existed keep their dot nudge and get a 0 speaker delay", old.speakerDelayMs === 0 && old.syncOffsetMs === 50 && old.indicator === false);
  const bad = model.parseMetronomePrefs({ speakerDelayMs: "soon", syncOffsetMs: 20 });
  check("a bad speaker delay falls back to 0 and leaves the nudge", bad.speakerDelayMs === 0 && bad.syncOffsetMs === 20);
  const big = model.parseMetronomePrefs({ speakerDelayMs: 1e6 });
  check("a huge speaker delay is held to the maximum", big.speakerDelayMs === model.SPEAKER_DELAY_MAX_MS && model.SPEAKER_DELAY_MAX_MS > 0);
});

console.log(failures ? `check:sync-check: ${failures} FAIL` : "check:sync-check passed");
process.exit(failures ? 1 : 0);
