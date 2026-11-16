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

const bundled = await build({ entryPoints: [new URL("../src/storage.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "neutral", loader: { ".json": "json" } });
const app: Storage = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

test("settings persist per account on a shared phone", () => {
  const problems: string[] = [];
  const expect = (ok: boolean, detail: string) => ok || problems.push(detail);
  store.clear();
  const fresh = app.loadPersonal(null);
  expect(same(fresh, { chordStyle: "notes", transpose: 0 }), `a phone that never saved starts at Notes and 0 (${JSON.stringify(fresh)})`);
  expect(app.savePersonal("user-a", { chordStyle: "nashville", transpose: -2 }), "Terry's save is kept");
  expect(same(app.loadPersonal("user-b"), fresh), `Mike signing in on the same phone does not get Terry's settings (${JSON.stringify(app.loadPersonal("user-b"))})`);
  app.savePersonal("user-b", { chordStyle: "notes", transpose: 1 });
  expect(same(app.loadPersonal("user-a"), { chordStyle: "nashville", transpose: -2 }), `Terry's settings come back after Mike's (${JSON.stringify(app.loadPersonal("user-a"))})`);
  expect(same(app.loadPersonal(null), fresh), `signed out, the phone shows neither account's settings (${JSON.stringify(app.loadPersonal(null))})`);
  app.savePersonal(null, { chordStyle: "nashville", transpose: -1 });
  expect(same(app.loadPersonal("user-c"), { chordStyle: "nashville", transpose: -1 }), "a first sign-in keeps what the player set while signed out");
  expect(same(app.loadPersonal("user-a"), { chordStyle: "nashville", transpose: -2 }), "a signed-out change does not touch Terry's settings");
  const raw = store.get(app.PERSONAL_KEY) ?? "";
  expect(raw.includes("user-a") && raw.includes("user-b"), `both accounts' settings are stored under ${app.PERSONAL_KEY}`);
  store.set(app.PERSONAL_KEY, JSON.stringify({ "user-a": { chordStyle: "roman", transpose: 40 } }));
  expect(same(app.loadPersonal("user-a"), { chordStyle: "notes", transpose: 11 }), `a bad stored value reads as the default chords and the nearest transpose (${JSON.stringify(app.loadPersonal("user-a"))})`);
  store.set(app.PERSONAL_KEY, "{not json");
  expect(same(app.loadPersonal("user-a"), fresh), "unreadable stored settings read as the defaults");
  return problems;
});

test("joinGig keeps the player's own click and text size", () => {
  const mine: PersonalSettings = { click: "dot-only", textSize: 4, chordStyle: "nashville", transpose: -1 };
  const before = JSON.stringify(mine);
  const joined = joinGig(mine, { gigId: "gig-1", imposed: { connectionRoute: "hotspot", scrollWithLeader: true }, attempted: { click: "out-loud", textSize: 0 } });
  const problems: string[] = [];
  if (!same(joined.personal, mine)) problems.push(`the gig changed the player's settings to ${JSON.stringify(joined.personal)}`);
  if (JSON.stringify(mine) !== before) problems.push("joinGig changed the settings it was given");
  if (!same(joined.imposed, { connectionRoute: "hotspot", scrollWithLeader: true })) problems.push(`the gig's own rules came back as ${JSON.stringify(joined.imposed)}`);
  return problems;
});

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("check:personal-settings passed");
