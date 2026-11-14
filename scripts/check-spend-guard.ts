import assert from "node:assert/strict";
import {
  type Budget,
  type Mode,
  type MintRequest,
  type UsageApi,
  CAP_GB,
  MAX_LIVE,
  CREDENTIAL_MS,
  MINUTES_CAP,
  CHECK_EVERY_MS,
  monthOf,
  freshBudget,
  rollMonth,
  pruneLive,
  mint,
  usageCheck,
  refusalText,
} from "../worker/spend-guard.ts";

const now = 1_700_000_000_000; // Nov 15 2023 ~1:13 UTC

class FakeUsageApi implements UsageApi {
  private _usedGb: number | null = null;
  private _revokes = new Map<string, boolean>();
  readCount = 0;

  setUsedGb(gb: number | null): void {
    this._usedGb = gb;
  }

  setRevokeResult(id: string, success: boolean): void {
    this._revokes.set(id, success);
  }

  async readUsedGb(): Promise<number | null> {
    this.readCount++;
    return this._usedGb;
  }

  async revoke(id: string): Promise<boolean> {
    return this._revokes.get(id) ?? true;
  }
}

function testCase1(): void {
  const budget = freshBudget(now);
  const req: MintRequest = {
    callerId: "Alice",
    onLiveLineup: true,
    directFailed: true,
    credentialId: "cred1",
  };
  const result = mint(budget, req, now, "usage");
  assert(result.ok === true);
  assert(result.expiresAt === now + CREDENTIAL_MS);
  assert(result.budget.credentialMinutes === 15);
}

function testCase2(): void {
  const req: MintRequest = {
    callerId: "Bob",
    onLiveLineup: true,
    directFailed: true,
    credentialId: "cred1",
  };

  const budget49 = { ...freshBudget(now), usedGb: 49.9 };
  const result49 = mint(budget49, req, now, "usage");
  assert(result49.ok === true, "Should allow at 49.9");

  const budget50 = { ...freshBudget(now), usedGb: 50 };
  const result50 = mint(budget50, req, now, "usage");
  assert(result50.ok === false);
  assert(result50.code === "relay_full");
}

function testCase3(): void {
  let budget = freshBudget(now);
  const req: MintRequest = {
    callerId: "Carol",
    onLiveLineup: true,
    directFailed: true,
    credentialId: "cred",
  };

  for (let i = 0; i < 6; i++) {
    const r = mint(budget, { ...req, credentialId: `cred${i}` }, now, "usage");
    assert(r.ok === true);
    budget = r.budget;
  }

  const result7 = mint(budget, { ...req, credentialId: "cred6" }, now, "usage");
  assert(result7.ok === false);
  assert(result7.code === "too_many_live");

  const futureNow = now + CREDENTIAL_MS + 1;
  budget = pruneLive(result7.budget, futureNow);
  assert(budget.live.length === 0);

  const resultAfter = mint(budget, { ...req, credentialId: "cred7" }, futureNow, "usage");
  assert(resultAfter.ok === true);
}

function testCase4(): void {
  const budgetFresh = freshBudget(now);
  const req: MintRequest = {
    callerId: "Dave",
    onLiveLineup: false,
    directFailed: true,
    credentialId: "cred1",
  };

  const result = mint(budgetFresh, req, now, "usage");
  assert(result.ok === false);
  assert(result.code === "not_on_lineup");

  const req2: MintRequest = {
    callerId: "Eve",
    onLiveLineup: true,
    directFailed: false,
    credentialId: "cred2",
  };

  const result2 = mint(budgetFresh, req2, now, "usage");
  assert(result2.ok === false);
  assert(result2.code === "direct_not_tried");
}

async function testCase5(): Promise<void> {
  let budget = freshBudget(now);
  const api = new FakeUsageApi();
  api.setUsedGb(50);

  let b = budget;
  for (let i = 0; i < 3; i++) {
    const req: MintRequest = {
      callerId: `User${i}`,
      onLiveLineup: true,
      directFailed: true,
      credentialId: `cred${i}`,
    };
    const r = mint(b, req, now, "usage");
    assert(r.ok === true);
    b = r.budget;
  }

  const checkResult = await usageCheck(b, api, now);
  assert(checkResult.readable === true);
  assert(checkResult.budget.mintingOn === false);
  assert(checkResult.budget.live.length === 0);
  assert(checkResult.revoked.length === 3);

  const req: MintRequest = {
    callerId: "Frank",
    onLiveLineup: true,
    directFailed: true,
    credentialId: "cred_new",
  };
  const mintResult = mint(checkResult.budget, req, now, "usage");
  assert(mintResult.ok === false);
  assert(mintResult.code === "relay_full");
}

async function testCase6(): Promise<void> {
  let budget = freshBudget(now);
  const api = new FakeUsageApi();
  api.setUsedGb(30);

  const checkResult1 = await usageCheck(budget, api, now);
  assert(api.readCount === 1);

  const futureNow = now + CHECK_EVERY_MS - 1000;
  const checkResult2 = await usageCheck(checkResult1.budget, api, futureNow);
  assert(api.readCount === 1, "Should not read again within 10 minutes");
  assert(checkResult2.budget.usedGb === 30);
}

async function testCase7(): Promise<void> {
  let budget = freshBudget(now);
  const api = new FakeUsageApi();
  api.setUsedGb(null);

  const checkResult = await usageCheck(budget, api, now);
  assert(checkResult.readable === false);
  assert(checkResult.budget.mintingOn === true, "mintingOn should not change");
  assert(checkResult.budget.lastChecked === now);
}

function testCase8(): void {
  const startOfMonth = 1_704_067_200_000;
  const budget = { ...freshBudget(startOfMonth), usedGb: 50, mintingOn: false };
  assert(budget.month === "2024-01");

  const nextMonth = 1_706_745_600_000;
  assert(monthOf(nextMonth) === "2024-02");

  const budget2 = rollMonth(budget, nextMonth);
  assert(budget2.month === "2024-02");
  assert(budget2.mintingOn === true);
  assert(budget2.usedGb === 0);

  const req: MintRequest = {
    callerId: "Grace",
    onLiveLineup: true,
    directFailed: true,
    credentialId: "cred1",
  };

  const result = mint(budget2, req, nextMonth, "usage");
  assert(result.ok === true);
}

async function testCase9(): Promise<void> {
  let budget = freshBudget(now);
  let currentTime = now;
  let successCount = 0;

  for (let i = 0; i < 26; i++) {
    const req: MintRequest = {
      callerId: `User${i}`,
      onLiveLineup: true,
      directFailed: true,
      credentialId: `cred${i}`,
    };

    const r = mint(budget, req, currentTime, "minutes");
    if (r.ok) {
      successCount++;
      budget = r.budget;
      if (i % 4 === 3) {
        currentTime += CREDENTIAL_MS + 1;
        budget = pruneLive(budget, currentTime);
      }
    }
  }

  assert(successCount === 26);
  assert(budget.credentialMinutes === 390);

  const req27: MintRequest = {
    callerId: "User26",
    onLiveLineup: true,
    directFailed: true,
    credentialId: "cred26",
  };

  const result27 = mint(budget, req27, currentTime, "minutes");
  assert(result27.ok === false);
  assert(result27.code === "relay_full");
  assert(result27.budget.credentialMinutes === 390);
}

function testCase10(): void {
  const original = freshBudget(now);
  const cloned = structuredClone(original);

  const req: MintRequest = {
    callerId: "Henry",
    onLiveLineup: true,
    directFailed: true,
    credentialId: "cred1",
  };

  const result = mint(original, req, now, "usage");
  assert(result.ok === true);

  assert.deepEqual(original, cloned, "Input budget should not be mutated");
}

function testCase11(): void {
  const text = refusalText("relay_full");
  assert(text === "Relay is full this month · Through the server");
}

async function runTests(): Promise<void> {
  testCase1();
  testCase2();
  testCase3();
  await testCase4();
  await testCase5();
  await testCase6();
  await testCase7();
  testCase8();
  await testCase9();
  testCase10();
  testCase11();

  console.log("check-spend-guard: 11 cases pass");
}

runTests();
