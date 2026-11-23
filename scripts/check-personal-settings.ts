import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { joinGig, type PersonalSettings } from "../src/personal-settings-model.ts";

type Storage = typeof import("../src/storage.ts");

let failures = 0;
function test(name: string, run: () => string[]) {
  let problems: string[];
  try {
    problems = run();
  } catch (error) {
    problems = [error instanceof Error ? error.message : String(error)];
  }
  if (problems.length) failures += 1;
  console.log(problems.length ? `FAIL ${name}: ${problems.join("; ")}` : `ok   ${name}`);
}

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  },
});

const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/storage.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "neutral", loader: { ".json": "json" } });
const app: Storage = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

test("settings persist per account on a shared phone", () => {
  const problems: string[] = [];
  const expect = (ok: boolean, detail: string) => ok || problems.push(detail);
  store.clear();
  const fresh = app.loadPersonal(null);
  expect(same(fresh, { chordStyle: "notes", transpose: 0, clickAsked: false }), `a phone that never saved starts at Notes and 0, not yet asked about the click (${JSON.stringify(fresh)})`);
  expect(app.savePersonal("user-a", { chordStyle: "nashville", transpose: -2, clickAsked: false }), "Terry's save is kept");
  expect(same(app.loadPersonal("user-b"), fresh), `Mike signing in on the same phone does not get Terry's settings (${JSON.stringify(app.loadPersonal("user-b"))})`);
  app.savePersonal("user-b", { chordStyle: "notes", transpose: 1, clickAsked: false });
  expect(same(app.loadPersonal("user-a"), { chordStyle: "nashville", transpose: -2, clickAsked: false }), `Terry's settings come back after Mike's (${JSON.stringify(app.loadPersonal("user-a"))})`);
  expect(same(app.loadPersonal(null), fresh), `signed out, the phone shows neither account's settings (${JSON.stringify(app.loadPersonal(null))})`);
  app.savePersonal(null, { chordStyle: "nashville", transpose: -1, clickAsked: false });
  expect(same(app.loadPersonal("user-c"), { chordStyle: "nashville", transpose: -1, clickAsked: false }), "a first sign-in keeps what the player set while signed out");
  expect(same(app.loadPersonal("user-a"), { chordStyle: "nashville", transpose: -2, clickAsked: false }), "a signed-out change does not touch Terry's settings");
  const raw = store.get(app.PERSONAL_KEY) ?? "";
  expect(raw.includes("user-a") && raw.includes("user-b"), `both accounts' settings are stored under ${app.PERSONAL_KEY}`);
  store.set(app.PERSONAL_KEY, JSON.stringify({ "user-a": { chordStyle: "roman", transpose: 40, clickAsked: "yes" } }));
  expect(same(app.loadPersonal("user-a"), { chordStyle: "notes", transpose: 11, clickAsked: false }), `a bad stored value reads as the default chords, the nearest transpose and not asked (${JSON.stringify(app.loadPersonal("user-a"))})`);
  store.set(app.PERSONAL_KEY, "{not json");
  expect(same(app.loadPersonal("user-a"), fresh), "unreadable stored settings read as the defaults");
  return problems;
});

test("joinGig imposes only the gig's route and the band's scroll setting, and keeps the player's own Sound, Dot and text size", () => {
  const mine: PersonalSettings = { sound: false, indicator: false, textSize: 4, chordStyle: "nashville", transpose: -1, clickAsked: true };
  const before = JSON.stringify(mine);
  const problems: string[] = [];
  for (const route of ["auto", "band_wifi", "direct_cell", "server"] as const) {
    for (const scrollWithLeader of [true, false]) {
      const joined = joinGig(mine, { gigId: "gig-1", imposed: { route, scrollWithLeader } });
      if (!same(joined.personal, mine)) problems.push(`the gig changed the player's settings to ${JSON.stringify(joined.personal)}`);
      if (!same(joined.imposed, { route, scrollWithLeader })) problems.push(`the gig's own rules came back as ${JSON.stringify(joined.imposed)}`);
    }
  }
  if (JSON.stringify(mine) !== before) problems.push("joinGig changed the settings it was given");
  return problems;
});

test("the click question's 'asked' is kept per account on a shared phone", () => {
  const problems: string[] = [];
  const expect = (ok: boolean, detail: string) => ok || problems.push(detail);
  store.clear();
  app.savePersonal("user-a", { ...app.loadPersonal("user-a"), clickAsked: true });
  expect(app.loadPersonal("user-a").clickAsked === true, "Terry's phone remembers it asked Terry");
  expect(app.loadPersonal("user-b").clickAsked === false, "Mike signing in on the same phone is asked for himself");
  expect(app.loadPersonal(null).clickAsked === false, "signed out, nobody's answer shows");
  return problems;
});

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("check:personal-settings passed");
