import assert from "node:assert/strict";
import { bandsReducer, fixtureBands, isAdmin } from "../src/bands-model.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}`, e);
    process.exit(1);
  }
}

test("create empty name shows notice", () => {
  const state = structuredClone(fixtureBands);
  const result = bandsReducer(state, { type: "create", name: "" });
  assert.equal(result.notice, "Enter a band name");
  assert.deepEqual(state, fixtureBands);
});

test("create band adds to bands with me as admin", () => {
  const state = structuredClone(fixtureBands);
  const result = bandsReducer(state, { type: "create", name: "Night Owls" });
  assert.equal(result.bands.length, 2);
  assert.equal(result.bands[1].name, "Night Owls");
  assert.equal(result.bands[1].code, "NEW-2");
  assert.equal(result.bands[1].members[0].handle, "@alex");
  assert.equal(result.bands[1].members[0].role, "admin");
  assert.equal(result.notice, "Created Night Owls");
  assert.deepEqual(state, fixtureBands);
});

test("join by code as member", () => {
  const state = structuredClone(fixtureBands);
  const result = bandsReducer(state, { type: "join", code: "ia-5678" });
  assert.equal(result.bands.length, 2);
  const joined = result.bands.find((b) => b.id === "b2");
  assert(joined);
  assert.equal(joined.name, "Iverson Acres");
  const me = joined.members.find((m) => m.handle === "@alex");
  assert(me);
  assert.equal(me.role, "member");
  assert.equal(result.notice, "Joined Iverson Acres");
  assert.deepEqual(state, fixtureBands);
});

test("join by link with /join/ suffix", () => {
  const state = structuredClone(fixtureBands);
  const result = bandsReducer(state, {
    type: "join",
    code: "https://x.app/join/IA-5678",
  });
  assert.equal(result.bands.length, 2);
  const joined = result.bands.find((b) => b.id === "b2");
  assert(joined);
  assert.equal(result.notice, "Joined Iverson Acres");
  assert.deepEqual(state, fixtureBands);
});

test("join same band twice shows Already in", () => {
  const state = structuredClone(fixtureBands);
  let result = bandsReducer(state, { type: "join", code: "IA-5678" });
  result = bandsReducer(result, { type: "join", code: "IA-5678" });
  assert.equal(result.notice, "Already in Iverson Acres");
  assert.deepEqual(state, fixtureBands);
});

test("join invalid code shows not found", () => {
  const state = structuredClone(fixtureBands);
  const result = bandsReducer(state, { type: "join", code: "ZZZ" });
  assert.equal(result.notice, "Code not found");
  assert.deepEqual(state, fixtureBands);
});

test("admin removes member", () => {
  const state = structuredClone(fixtureBands);
  const result = bandsReducer(state, {
    type: "remove",
    bandId: "b1",
    handle: "@mike",
  });
  const band = result.bands.find((b) => b.id === "b1");
  assert(band);
  assert.equal(band.members.length, 1);
  assert.equal(band.members[0].handle, "@alex");
  assert.equal(result.notice, "Removed @mike");
  assert.deepEqual(state, fixtureBands);
});

test("member cannot remove after joining", () => {
  const state = structuredClone(fixtureBands);
  let result = bandsReducer(state, { type: "join", code: "IA-5678" });
  result = bandsReducer(result, {
    type: "remove",
    bandId: "b2",
    handle: "@dana",
  });
  const band = result.bands.find((b) => b.id === "b2");
  assert(band);
  const dana = band.members.find((m) => m.handle === "@dana");
  assert(dana);
  assert.equal(result.notice, "Only an admin can remove members");
  assert.deepEqual(state, fixtureBands);
});

test("promote then leave as former sole admin works", () => {
  const state = structuredClone(fixtureBands);
  let result = bandsReducer(state, {
    type: "promote",
    bandId: "b1",
    handle: "@mike",
  });
  assert.equal(result.notice, "@mike is now an admin");
  result = bandsReducer(result, { type: "leave", bandId: "b1" });
  assert.equal(result.bands.length, 0);
  assert.equal(result.notice, "Left Back Porch");
  assert.deepEqual(state, fixtureBands);
});

test("leave as sole admin with members blocks", () => {
  const state = structuredClone(fixtureBands);
  const result = bandsReducer(state, { type: "leave", bandId: "b1" });
  assert.equal(result.notice, "Make someone else admin first");
  assert.equal(result.bands.length, 1);
  assert.deepEqual(state, fixtureBands);
});

test("leave as member works", () => {
  const state = structuredClone(fixtureBands);
  let result = bandsReducer(state, { type: "join", code: "IA-5678" });
  result = bandsReducer(result, { type: "leave", bandId: "b2" });
  assert.equal(result.bands.length, 1);
  assert.equal(result.notice, "Left Iverson Acres");
  assert.deepEqual(state, fixtureBands);
});

test("input state unchanged after mutations", () => {
  const state = structuredClone(fixtureBands);
  const original = structuredClone(state);
  bandsReducer(state, { type: "create", name: "Test" });
  bandsReducer(state, { type: "join", code: "IA-5678" });
  bandsReducer(state, { type: "remove", bandId: "b1", handle: "@mike" });
  assert.deepEqual(state, original);
});

console.log("\nbands: all checks passed");
