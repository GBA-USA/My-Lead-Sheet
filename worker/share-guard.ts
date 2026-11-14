export type ShareChoice = "public" | "private";
export type StoredShare = { id: string; ownerId: string; parentId: string | null; choice: ShareChoice };
export type ShareStore = (id: string) => StoredShare | undefined;
export type SendRequest = { senderId: string; copyId: string; choice: ShareChoice | null; claimedReshareable?: boolean };
export type GuardResult = { ok: true; reshareable: boolean } | { ok: false; status: 400 | 403 | 404; code: "choice_required" | "not_found" | "not_yours" | "private_copy" | "private_ancestor" | "lineage_broken" };

export function lineage(store: ShareStore, copyId: string, maxDepth: number = 64): StoredShare[] | null {
  const result: StoredShare[] = [];
  const seen = new Set<string>();
  let current = store(copyId);

  if (!current) return null;

  let depth = 0;
  while (current) {
    if (seen.has(current.id)) return null;
    if (depth > maxDepth) return null;

    seen.add(current.id);
    result.push(current);

    if (current.parentId === null) break;

    current = store(current.parentId);
    if (!current) return null;
    depth++;
  }

  return result;
}

export function checkSend(store: ShareStore, req: SendRequest): GuardResult {
  if (req.choice !== "public" && req.choice !== "private") {  // anything else from the phone (null, undefined, junk) is no choice
    return { ok: false, status: 400, code: "choice_required" };
  }

  const copy = store(req.copyId);
  if (!copy) {
    return { ok: false, status: 404, code: "not_found" };
  }

  if (copy.ownerId !== req.senderId) {
    return { ok: false, status: 403, code: "not_yours" };
  }

  const lin = lineage(store, req.copyId);
  if (lin === null) {
    return { ok: false, status: 403, code: "lineage_broken" };
  }

  if (copy.parentId === null) {
    return { ok: true, reshareable: req.choice === "public" };
  }

  if (copy.choice === "private") {
    return { ok: false, status: 403, code: "private_copy" };
  }

  for (let i = 1; i < lin.length; i++) {
    if (lin[i].choice === "private") {
      return { ok: false, status: 403, code: "private_ancestor" };
    }
  }

  return { ok: true, reshareable: req.choice === "public" };
}
