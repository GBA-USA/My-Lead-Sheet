import assert from "node:assert/strict";
import { checkSend, lineage, type StoredShare } from "../worker/share-guard.ts";

const store = new Map<string, StoredShare>();

// Build test data
store.set("o1", { id: "o1", ownerId: "Alex", parentId: null, choice: "public" });
store.set("o2", { id: "o2", ownerId: "Alex", parentId: null, choice: "private" });
store.set("c1", { id: "c1", ownerId: "Mike", parentId: "o1", choice: "public" });
store.set("c2", { id: "c2", ownerId: "Mike", parentId: "o1", choice: "private" });
store.set("c3", { id: "c3", ownerId: "Dana", parentId: "c1", choice: "public" });
store.set("c4", { id: "c4", ownerId: "Dana", parentId: "c2", choice: "public" });
store.set("c5", { id: "c5", ownerId: "Sam", parentId: "gone", choice: "public" });
store.set("a", { id: "a", ownerId: "Sam", parentId: "b", choice: "public" });
store.set("b", { id: "b", ownerId: "Sam", parentId: "a", choice: "public" });

const storeFunc = (id: string): StoredShare | undefined => store.get(id);

const tests: Array<[string, Parameters<typeof checkSend>[1], ReturnType<typeof checkSend>]> = [
  [
    "no choice",
    { senderId: "Alex", copyId: "o1", choice: null },
    { ok: false, status: 400, code: "choice_required" }
  ],
  [
    "missing copy",
    { senderId: "Alex", copyId: "nonexistent", choice: "public" },
    { ok: false, status: 404, code: "not_found" }
  ],
  [
    "not yours",
    { senderId: "Dana", copyId: "o1", choice: "public" },
    { ok: false, status: 403, code: "not_yours" }
  ],
  [
    "owner shares private original o2 as public",
    { senderId: "Alex", copyId: "o2", choice: "public" },
    { ok: true, reshareable: true }
  ],
  [
    "owner shares o1 private",
    { senderId: "Alex", copyId: "o1", choice: "private" },
    { ok: true, reshareable: false }
  ],
  [
    "Mike reshares c1 public",
    { senderId: "Mike", copyId: "c1", choice: "public" },
    { ok: true, reshareable: true }
  ],
  [
    "Mike reshares c2",
    { senderId: "Mike", copyId: "c2", choice: "public" },
    { ok: false, status: 403, code: "private_copy" }
  ],
  [
    "Dana reshares c3",
    { senderId: "Dana", copyId: "c3", choice: "public" },
    { ok: true, reshareable: true }
  ],
  [
    "Dana reshares c4",
    { senderId: "Dana", copyId: "c4", choice: "public" },
    { ok: false, status: 403, code: "private_ancestor" }
  ],
  [
    "c5",
    { senderId: "Sam", copyId: "c5", choice: "public" },
    { ok: false, status: 403, code: "lineage_broken" }
  ],
  [
    "loop",
    { senderId: "Sam", copyId: "a", choice: "public" },
    { ok: false, status: 403, code: "lineage_broken" }
  ],
  [
    "phone claims claimedReshareable true on c2",
    { senderId: "Mike", copyId: "c2", choice: "public", claimedReshareable: true },
    { ok: false, status: 403, code: "private_copy" }
  ]
];

for (const [name, req, expected] of tests) {
  const result = checkSend(storeFunc, req);
  assert.deepEqual(result, expected, `Test failed: ${name}`);
  console.log(`ok ${name}`);
}

const c3Lineage = lineage(storeFunc, "c3");
assert.notEqual(c3Lineage, null);
assert.deepEqual(
  c3Lineage!.map((s) => s.id),
  ["c3", "c1", "o1"]
);
console.log("ok lineage(c3) ids");

console.log("share-guard: all checks passed");
