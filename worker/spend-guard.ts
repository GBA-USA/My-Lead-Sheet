export type Budget = {
  month: string;
  usedGb: number;
  live: { id: string; expiresAt: number }[];
  credentialMinutes: number;
  mintingOn: boolean;
  lastChecked: number;
};

export type Mode = "usage" | "minutes";

export const CAP_GB = 50;
export const MAX_LIVE = 6;
export const CREDENTIAL_MS = 15 * 60_000;
export const MINUTES_CAP = 400;
export const CHECK_EVERY_MS = 10 * 60_000;

export function monthOf(now: number): string {
  const d = new Date(now);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function freshBudget(now: number): Budget {
  return {
    month: monthOf(now),
    usedGb: 0,
    live: [],
    credentialMinutes: 0,
    mintingOn: true,
    lastChecked: 0,
  };
}

export function rollMonth(b: Budget, now: number): Budget {
  const current = monthOf(now);
  if (current !== b.month) {
    return freshBudget(now);
  }
  return b;
}

export function pruneLive(b: Budget, now: number): Budget {
  const live = b.live.filter((entry) => entry.expiresAt > now);
  return { ...b, live };
}

export type MintRequest = {
  callerId: string;
  onLiveLineup: boolean;
  directFailed: boolean;
  credentialId: string;
};

export type MintResult =
  | { ok: true; budget: Budget; expiresAt: number }
  | {
      ok: false;
      budget: Budget;
      code:
        | "relay_full"
        | "too_many_live"
        | "not_on_lineup"
        | "direct_not_tried";
    };

export function mint(
  b: Budget,
  req: MintRequest,
  now: number,
  mode: Mode
): MintResult {
  let budget = rollMonth(b, now);
  budget = pruneLive(budget, now);

  if (!req.onLiveLineup) {
    return { ok: false, budget, code: "not_on_lineup" };
  }

  if (!req.directFailed) {
    return { ok: false, budget, code: "direct_not_tried" };
  }

  if (!budget.mintingOn) {
    return { ok: false, budget, code: "relay_full" };
  }

  if (mode === "usage" && budget.usedGb >= CAP_GB) {
    return { ok: false, budget, code: "relay_full" };
  }

  if (mode === "minutes" && budget.credentialMinutes + 15 > MINUTES_CAP) {
    return { ok: false, budget, code: "relay_full" };
  }

  if (budget.live.length >= MAX_LIVE) {
    return { ok: false, budget, code: "too_many_live" };
  }

  const expiresAt = now + CREDENTIAL_MS;
  const newLive = [
    ...budget.live,
    { id: req.credentialId, expiresAt },
  ];
  const newBudget: Budget = {
    ...budget,
    live: newLive,
    credentialMinutes: budget.credentialMinutes + 15,
  };

  return { ok: true, budget: newBudget, expiresAt };
}

export type UsageApi = {
  readUsedGb(month: string): Promise<number | null>;
  revoke(id: string): Promise<boolean>;
};

export async function usageCheck(
  b: Budget,
  api: UsageApi,
  now: number
): Promise<{ budget: Budget; revoked: string[]; readable: boolean }> {
  let budget = rollMonth(b, now);
  budget = pruneLive(budget, now);

  if (now - budget.lastChecked < CHECK_EVERY_MS) {
    return { budget, revoked: [], readable: true };
  }

  const used = await api.readUsedGb(budget.month);

  if (used === null) {
    return {
      budget: { ...budget, lastChecked: now },
      revoked: [],
      readable: false,
    };
  }

  let newBudget: Budget = {
    ...budget,
    usedGb: used,
    lastChecked: now,
  };

  let revoked: string[] = [];

  if (used >= CAP_GB) {
    newBudget = { ...newBudget, mintingOn: false };

    const revokeResults = await Promise.all(
      budget.live.map((entry) => api.revoke(entry.id))
    );

    revoked = budget.live
      .map((entry, idx) => (revokeResults[idx] ? entry.id : null))
      .filter((id) => id !== null) as string[];

    newBudget = {
      ...newBudget,
      live: budget.live.filter((_entry, idx) => !revokeResults[idx]),
    };
  }

  return { budget: newBudget, revoked, readable: true };
}

export function refusalText(code: string): string {
  if (code === "relay_full") {
    return "Relay is full this month · Through the server";
  }
  if (code === "too_many_live") {
    return "Too many active credentials.";
  }
  if (code === "not_on_lineup") {
    return "Not on a live lineup.";
  }
  if (code === "direct_not_tried") {
    return "Direct attempt not tried yet.";
  }
  return "Unknown refusal.";
}
