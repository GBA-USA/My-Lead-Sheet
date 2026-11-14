import { defaultPersonalSettings, savePersonal, loadPersonal, setSetting, joinGig, type FixtureStore, type PersonalSettings } from "../src/personal-settings-model.ts";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

let testCount = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok ${name}`);
    testCount++;
  } catch (e) {
    console.error(`FAIL ${name}:`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

test("load from empty store returns defaults", () => {
  const store: FixtureStore = { saved: null };
  const loaded = loadPersonal(store);
  assert(deepEqual(loaded, defaultPersonalSettings), "should match defaults");
});

test("click setting round-trips", () => {
  let store: FixtureStore = { saved: null };
  let settings = loadPersonal(store);
  settings = setSetting(settings, "click", "dot-only");
  store = savePersonal(store, settings);
  const reloaded = loadPersonal(store);
  assert(reloaded.click === "dot-only", "should be dot-only");
});

test("textSize setting round-trips", () => {
  let store: FixtureStore = { saved: null };
  let settings = loadPersonal(store);
  settings = setSetting(settings, "textSize", 24);
  store = savePersonal(store, settings);
  const reloaded = loadPersonal(store);
  assert(reloaded.textSize === 24, "should be 24");
});

test("chordStyle setting round-trips", () => {
  let store: FixtureStore = { saved: null };
  let settings = loadPersonal(store);
  settings = setSetting(settings, "chordStyle", "nashville");
  store = savePersonal(store, settings);
  const reloaded = loadPersonal(store);
  assert(reloaded.chordStyle === "nashville", "should be nashville");
});

test("transpose setting round-trips", () => {
  let store: FixtureStore = { saved: null };
  let settings = loadPersonal(store);
  settings = setSetting(settings, "transpose", 5);
  store = savePersonal(store, settings);
  const reloaded = loadPersonal(store);
  assert(reloaded.transpose === 5, "should be 5");
});

test("textSize 99 clamps to 32", () => {
  let settings: PersonalSettings = { ...defaultPersonalSettings };
  settings = setSetting(settings, "textSize", 99);
  assert(settings.textSize === 32, "should be clamped to 32");
});

test("textSize 3 clamps to 12", () => {
  let settings: PersonalSettings = { ...defaultPersonalSettings };
  settings = setSetting(settings, "textSize", 3);
  assert(settings.textSize === 12, "should be clamped to 12");
});

test("transpose 20 clamps to 11", () => {
  let settings: PersonalSettings = { ...defaultPersonalSettings };
  settings = setSetting(settings, "transpose", 20);
  assert(settings.transpose === 11, "should be clamped to 11");
});

test("transpose -20 clamps to -11", () => {
  let settings: PersonalSettings = { ...defaultPersonalSettings };
  settings = setSetting(settings, "transpose", -20);
  assert(settings.transpose === -11, "should be clamped to -11");
});

test("transpose 2.6 rounds to 3", () => {
  let settings: PersonalSettings = { ...defaultPersonalSettings };
  settings = setSetting(settings, "transpose", 2.6);
  assert(settings.transpose === 3, "should be rounded to 3");
});

test("bad JSON defaults", () => {
  const store: FixtureStore = { saved: "{invalid json" };
  const loaded = loadPersonal(store);
  assert(deepEqual(loaded, defaultPersonalSettings), "should return defaults");
});

test("partial JSON keeps other defaults", () => {
  const store: FixtureStore = { saved: JSON.stringify({ click: "dot-only" }) };
  const loaded = loadPersonal(store);
  assert(loaded.click === "dot-only", "click should be dot-only");
  assert(loaded.textSize === defaultPersonalSettings.textSize, "textSize should be default");
  assert(loaded.chordStyle === defaultPersonalSettings.chordStyle, "chordStyle should be default");
  assert(loaded.transpose === defaultPersonalSettings.transpose, "transpose should be default");
});

test("joinGig ignores attempted and returns imposed", () => {
  const personal: PersonalSettings = { ...defaultPersonalSettings };
  const originalPersonal = JSON.stringify(personal);
  const result = joinGig(personal, {
    gigId: "gig1",
    imposed: { connectionRoute: "wifi", scrollWithLeader: true },
    attempted: { textSize: 30, chordStyle: "nashville" }
  });
  assert(deepEqual(result.personal, personal), "personal should be unchanged");
  assert(JSON.stringify(personal) === originalPersonal, "personal should not be mutated");
  assert(result.imposed.connectionRoute === "wifi", "imposed.connectionRoute should be wifi");
  assert(result.imposed.scrollWithLeader === true, "imposed.scrollWithLeader should be true");
  assert(!("attempted" in result.imposed), "imposed should not have attempted");
});

console.log("personal-settings: all checks passed");
