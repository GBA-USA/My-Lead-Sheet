import {
  fixtureGigPlan,
  fixtureMembers,
  gigPlanReducer,
  isPackReady,
  type GigPlanAction,
} from "../src/gig-plan-model.ts";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}: ${e}`);
    process.exit(1);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function deepEqual<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

test("fixture fields", () => {
  assert(fixtureGigPlan.gigId === "g1", "gigId");
  assert(fixtureGigPlan.title === "Friday at the Barn", "title");
  assert(
    deepEqual(fixtureGigPlan.lineup, ["@alex", "@mike", "@dana"]),
    "lineup"
  );
  assert(fixtureGigPlan.leader === "@alex", "leader");
  assert(fixtureGigPlan.backupLeader === "@mike", "backupLeader");
  assert(fixtureGigPlan.connection === "wifi", "connection");
  assert(deepEqual(fixtureGigPlan.packSongIds, ["s1", "s2", "s3"]), "packSongIds");
  assert(deepEqual(fixtureGigPlan.downloaded, []), "downloaded");
  assert(fixtureGigPlan.admin === "@alex", "admin");
  assert(fixtureMembers.length === 4, "fixtureMembers length");
});

test("setLeader to @sam (not in lineup) -> notice", () => {
  const state = {
    plan: structuredClone(fixtureGigPlan),
    notice: "",
  };
  const result = gigPlanReducer(state, {
    type: "setLeader",
    handle: "@sam",
  });
  assert(
    result.notice === "Pick someone in the lineup",
    `notice is "${result.notice}"`
  );
  assert(result.plan.leader === "@alex", "leader unchanged");
});

test("toggleLineup @sam then setLeader @sam works", () => {
  let state = {
    plan: structuredClone(fixtureGigPlan),
    notice: "",
  };
  state = gigPlanReducer(state, { type: "toggleLineup", handle: "@sam" });
  assert(state.plan.lineup.includes("@sam"), "@sam in lineup");
  state = gigPlanReducer(state, { type: "setLeader", handle: "@sam" });
  assert(state.plan.leader === "@sam", "leader is @sam");
  assert(state.notice === "", "notice cleared");
});

test("setLeader to current backup @mike clears backupLeader", () => {
  const state = {
    plan: structuredClone(fixtureGigPlan),
    notice: "",
  };
  const result = gigPlanReducer(state, {
    type: "setLeader",
    handle: "@mike",
  });
  assert(result.plan.leader === "@mike", "leader is @mike");
  assert(result.plan.backupLeader === null, "backupLeader cleared");
});

test("setBackup equal to leader -> notice", () => {
  const state = {
    plan: structuredClone(fixtureGigPlan),
    notice: "",
  };
  const result = gigPlanReducer(state, {
    type: "setBackup",
    handle: "@alex",
  });
  assert(
    result.notice === "Backup must be someone other than the leader",
    `notice is "${result.notice}"`
  );
  assert(result.plan.backupLeader === "@mike", "backupLeader unchanged");
});

test("removing the leader from lineup sets leader null", () => {
  const state = {
    plan: structuredClone(fixtureGigPlan),
    notice: "",
  };
  const result = gigPlanReducer(state, {
    type: "toggleLineup",
    handle: "@alex",
  });
  assert(!result.plan.lineup.includes("@alex"), "@alex removed from lineup");
  assert(result.plan.leader === null, "leader set to null");
});

test("non-admin @mike setConnection -> notice and unchanged", () => {
  const state = {
    plan: structuredClone(fixtureGigPlan),
    notice: "",
  };
  const result = gigPlanReducer(state, {
    type: "setConnection",
    by: "@mike",
    connection: "hotspot",
  });
  assert(
    result.notice === "Only the admin picks the connection",
    `notice is "${result.notice}"`
  );
  assert(result.plan.connection === "wifi", "connection unchanged");
});

test("admin @alex sets hotspot", () => {
  const state = {
    plan: structuredClone(fixtureGigPlan),
    notice: "",
  };
  const result = gigPlanReducer(state, {
    type: "setConnection",
    by: "@alex",
    connection: "hotspot",
  });
  assert(result.plan.connection === "hotspot", "connection is hotspot");
  assert(result.notice === "", "notice cleared");
});

test("markDownloaded s9 -> Song is not in the pack", () => {
  const state = {
    plan: structuredClone(fixtureGigPlan),
    notice: "",
  };
  const result = gigPlanReducer(state, {
    type: "markDownloaded",
    songId: "s9",
  });
  assert(
    result.notice === "Song is not in the pack",
    `notice is "${result.notice}"`
  );
});

test("mark s1..s3 -> isPackReady true", () => {
  let state = {
    plan: structuredClone(fixtureGigPlan),
    notice: "",
  };
  state = gigPlanReducer(state, { type: "markDownloaded", songId: "s1" });
  state = gigPlanReducer(state, { type: "markDownloaded", songId: "s2" });
  state = gigPlanReducer(state, { type: "markDownloaded", songId: "s3" });
  assert(isPackReady(state.plan), "isPackReady is true");
});

test("togglePack s2 off removes it from downloaded", () => {
  let state = {
    plan: structuredClone(fixtureGigPlan),
    notice: "",
  };
  state = gigPlanReducer(state, { type: "markDownloaded", songId: "s1" });
  state = gigPlanReducer(state, { type: "markDownloaded", songId: "s2" });
  state = gigPlanReducer(state, { type: "markDownloaded", songId: "s3" });
  state = gigPlanReducer(state, { type: "togglePack", songId: "s2" });
  assert(!state.plan.packSongIds.includes("s2"), "s2 removed from pack");
  assert(!state.plan.downloaded.includes("s2"), "s2 removed from downloaded");
  assert(isPackReady(state.plan), "remaining pack songs s1 and s3 are downloaded, so still ready");
});

test("input not mutated (deepEqual vs structuredClone)", () => {
  const original = structuredClone(fixtureGigPlan);
  const state = {
    plan: structuredClone(fixtureGigPlan),
    notice: "",
  };
  gigPlanReducer(state, { type: "toggleLineup", handle: "@sam" });
  gigPlanReducer(state, { type: "setLeader", handle: "@mike" });
  gigPlanReducer(state, { type: "setConnection", by: "@alex", connection: "hotspot" });
  assert(deepEqual(fixtureGigPlan, original), "fixture not mutated");
});

console.log("gig-plan: all checks passed");
