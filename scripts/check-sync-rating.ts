import { type Route, type RouteSummary, rateRoute, autoRoute, rowText, applyTestNow } from "../src/sync-rating.ts";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}:`, e);
    process.exit(1);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

test("rateRoute: spread 1.5 p99 80 -> Best", () => {
  const s: RouteSummary = { spreadMs: 1.5, p99Ms: 80, ageDays: 1, tries: [true] };
  assertEqual(rateRoute(s), "Best", "rating");
});

test("rateRoute: spread 4 p99 200 -> Better", () => {
  const s: RouteSummary = { spreadMs: 4, p99Ms: 200, ageDays: 1, tries: [true] };
  assertEqual(rateRoute(s), "Better", "rating");
});

test("rateRoute: spread 7.5 p99 300 -> Good", () => {
  const s: RouteSummary = { spreadMs: 7.5, p99Ms: 300, ageDays: 1, tries: [true] };
  assertEqual(rateRoute(s), "Good", "rating");
});

test("rateRoute: spread 9 p99 100 -> Not steady", () => {
  const s: RouteSummary = { spreadMs: 9, p99Ms: 100, ageDays: 1, tries: [true] };
  assertEqual(rateRoute(s), "Not steady", "rating");
});

test("rateRoute: spread 1.5 p99 80 lateRate 0.02 -> Not steady", () => {
  const s: RouteSummary = { spreadMs: 1.5, p99Ms: 80, lateRate: 0.02, ageDays: 1, tries: [true] };
  assertEqual(rateRoute(s), "Not steady", "rating");
});

test("rateRoute: spread 2 p99 400 -> Not steady", () => {
  const s: RouteSummary = { spreadMs: 2, p99Ms: 400, ageDays: 1, tries: [true] };
  assertEqual(rateRoute(s), "Not steady", "rating");
});

test("rateRoute: undefined -> Not tried yet", () => {
  assertEqual(rateRoute(undefined), "Not tried yet", "rating");
});

test("rateRoute: tries [] -> Not tried yet", () => {
  const s: RouteSummary = { tries: [] };
  assertEqual(rateRoute(s), "Not tried yet", "rating");
});

test("rateRoute: ageDays 31 -> Not tried yet", () => {
  const s: RouteSummary = { spreadMs: 1.5, p99Ms: 80, ageDays: 31, tries: [true] };
  assertEqual(rateRoute(s), "Not tried yet", "rating");
});

test("rateRoute: tries [true, false, false] -> Can't connect here", () => {
  const s: RouteSummary = { spreadMs: 1.5, p99Ms: 80, ageDays: 1, tries: [true, false, false] };
  assertEqual(rateRoute(s), "Can't connect here", "rating");
});

test("rateRoute: tries [false, true] with 1.5 p99 80 -> Best", () => {
  const s: RouteSummary = { spreadMs: 1.5, p99Ms: 80, ageDays: 1, tries: [false, true] };
  assertEqual(rateRoute(s), "Best", "rating");
});

test("autoRoute: picks wifi when wifi Best", () => {
  const m: Partial<Record<Route, RouteSummary>> = {
    wifi: { spreadMs: 1.5, p99Ms: 80, ageDays: 1, tries: [true] },
  };
  assertEqual(autoRoute(m), "wifi", "route");
});

test("autoRoute: picks internet when wifi Can't connect here and internet Better", () => {
  const m: Partial<Record<Route, RouteSummary>> = {
    wifi: { spreadMs: 1.5, p99Ms: 80, ageDays: 1, tries: [true, false, false] },
    internet: { spreadMs: 4, p99Ms: 200, ageDays: 1, tries: [true] },
  };
  assertEqual(autoRoute(m), "internet", "route");
});

test("autoRoute: null when all missing", () => {
  const m: Partial<Record<Route, RouteSummary>> = {};
  assertEqual(autoRoute(m), null, "route");
});

test("rowText: auto -> Best · Wi-Fi link", () => {
  const m: Partial<Record<Route, RouteSummary>> = {
    wifi: { spreadMs: 1.5, p99Ms: 80, ageDays: 1, tries: [true] },
  };
  assertEqual(rowText("auto", m), "Best · Wi-Fi link", "text");
});

test("rowText: wifi with empty map -> Not tried yet · test with a bandmate", () => {
  const m: Partial<Record<Route, RouteSummary>> = {};
  assertEqual(rowText("wifi", m), "Not tried yet · test with a bandmate", "text");
});

test("applyTestNow: fills server and internet, wifi stays absent", () => {
  const m: Partial<Record<Route, RouteSummary>> = {};
  const server: RouteSummary = { spreadMs: 2, p99Ms: 150, ageDays: 1, tries: [true] };
  const internet: RouteSummary = { spreadMs: 3, p99Ms: 180, ageDays: 1, tries: [true] };
  const result = applyTestNow(m, server, internet);
  assert(result.wifi === undefined, "wifi should be absent");
  assertEqual(result.server?.source, "Test now", "server source");
  assertEqual(result.internet?.source, "Test now", "internet source");
});

test("applyTestNow: rowText wifi still Not tried yet · test with a bandmate", () => {
  const m: Partial<Record<Route, RouteSummary>> = {};
  const server: RouteSummary = { spreadMs: 2, p99Ms: 150, ageDays: 1, tries: [true] };
  const internet: RouteSummary = { spreadMs: 3, p99Ms: 180, ageDays: 1, tries: [true] };
  const result = applyTestNow(m, server, internet);
  assertEqual(rowText("wifi", result), "Not tried yet · test with a bandmate", "text");
});

test("applyTestNow: does not mutate input", () => {
  const m: Partial<Record<Route, RouteSummary>> = {};
  const server: RouteSummary = { spreadMs: 2, p99Ms: 150, ageDays: 1, tries: [true] };
  const internet: RouteSummary = { spreadMs: 3, p99Ms: 180, ageDays: 1, tries: [true] };
  applyTestNow(m, server, internet);
  assert(m.server === undefined, "input should not be mutated");
  assert(m.internet === undefined, "input should not be mutated");
});

console.log("sync-rating: all checks passed");
