import assert from "node:assert/strict";
import {
  canEditBandSettings,
  setScrollWithLeader,
  fixtureSettingsBand,
  type SettingsBand,
} from "../src/band-settings-model.ts";

function testFixtureDefault() {
  assert.equal(
    fixtureSettingsBand.settings.scrollWithLeader,
    false,
    "fixture default is off"
  );
  console.log("ok testFixtureDefault");
}

function testAdminCanEdit() {
  const result = setScrollWithLeader(fixtureSettingsBand, "@alex", true);
  assert.equal(result.ok, true, "admin @alex can edit");
  assert.equal(
    result.band.settings.scrollWithLeader,
    true,
    "setting turned on"
  );
  console.log("ok testAdminCanEdit");
}

function testNonAdminCannotEdit() {
  const result = setScrollWithLeader(fixtureSettingsBand, "@mike", true);
  assert.equal(result.ok, false, "@mike cannot edit");
  assert.equal(
    result.band,
    fixtureSettingsBand,
    "band unchanged (same object)"
  );
  console.log("ok testNonAdminCannotEdit");
}

function testAdminTurnsOff() {
  const afterOn = setScrollWithLeader(fixtureSettingsBand, "@alex", true);
  assert.equal(afterOn.ok, true, "admin turns on");
  assert.equal(afterOn.band.settings.scrollWithLeader, true);

  const afterOff = setScrollWithLeader(afterOn.band, "@alex", false);
  assert.equal(afterOff.ok, true, "admin turns off");
  assert.equal(afterOff.band.settings.scrollWithLeader, false);
  console.log("ok testAdminTurnsOff");
}

function testNonAdminUnchanged() {
  const before = structuredClone(fixtureSettingsBand);
  const result = setScrollWithLeader(fixtureSettingsBand, "@mike", true);
  assert.equal(result.ok, false);
  assert.deepEqual(result.band, before, "band unchanged");
  console.log("ok testNonAdminUnchanged");
}

function testFixtureNotMutated() {
  const before = structuredClone(fixtureSettingsBand);
  setScrollWithLeader(fixtureSettingsBand, "@alex", true);
  setScrollWithLeader(fixtureSettingsBand, "@alex", false);
  setScrollWithLeader(fixtureSettingsBand, "@mike", true);
  assert.deepEqual(
    fixtureSettingsBand,
    before,
    "input fixture unchanged after all calls"
  );
  console.log("ok testFixtureNotMutated");
}

testFixtureDefault();
testAdminCanEdit();
testNonAdminCannotEdit();
testAdminTurnsOff();
testNonAdminUnchanged();
testFixtureNotMutated();

console.log("band-settings: all checks passed");
