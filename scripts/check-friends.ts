import assert from "node:assert/strict";
import { friendsReducer, fixtureFriends } from "../src/friends-model.ts";

function test(name: string, fn: () => void): void {
  fn();
  console.log(`ok ${name}`);
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

test("accept moves @sam into friends and clears request", () => {
  const initial = deepClone(fixtureFriends);
  const result = friendsReducer(initial, {
    type: "accept",
    id: "req1",
  });
  assert.equal(result.friends.length, 3);
  assert.ok(result.friends.some((f) => f.handle === "@sam"));
  assert.equal(result.incoming.length, 0);
  assert.deepEqual(initial, fixtureFriends);
});

test("ignore drops request without adding", () => {
  const initial = deepClone(fixtureFriends);
  const result = friendsReducer(initial, {
    type: "ignore",
    id: "req1",
  });
  assert.equal(result.friends.length, 2);
  assert.equal(result.incoming.length, 0);
  assert.deepEqual(initial, fixtureFriends);
});

test('add "lee" -> outgoing ["@lee"]', () => {
  const initial = deepClone(fixtureFriends);
  const result = friendsReducer(initial, {
    type: "add",
    handle: "lee",
  });
  assert.deepEqual(result.outgoing, ["@lee"]);
  assert.equal(result.notice, "Request sent to @lee");
  assert.deepEqual(initial, fixtureFriends);
});

test('add "" -> notice "Enter a handle"', () => {
  const initial = deepClone(fixtureFriends);
  const result = friendsReducer(initial, {
    type: "add",
    handle: "",
  });
  assert.equal(result.notice, "Enter a handle");
  assert.deepEqual(initial, fixtureFriends);
});

test('add "@mike" -> "Already friends"', () => {
  const initial = deepClone(fixtureFriends);
  const result = friendsReducer(initial, {
    type: "add",
    handle: "@mike",
  });
  assert.equal(result.notice, "Already friends");
  assert.deepEqual(initial, fixtureFriends);
});

test('add twice -> "Request already sent"', () => {
  const initial = deepClone(fixtureFriends);
  const after1 = friendsReducer(initial, {
    type: "add",
    handle: "jane",
  });
  const after2 = friendsReducer(after1, {
    type: "add",
    handle: "jane",
  });
  assert.equal(after2.notice, "Request already sent");
  assert.deepEqual(initial, fixtureFriends);
});

test('scanned "@lee" -> lee NOT in friends, "@lee" in outgoing', () => {
  const initial = deepClone(fixtureFriends);
  const result = friendsReducer(initial, {
    type: "scanned",
    handle: "@lee",
  });
  assert.ok(!result.friends.some((f) => f.handle === "@lee"));
  assert.ok(result.outgoing.includes("@lee"));
  assert.equal(
    result.notice,
    "Request sent to @lee — they need to accept"
  );
  assert.deepEqual(initial, fixtureFriends);
});

test('scanned "@mike" -> "Already friends"', () => {
  const initial = deepClone(fixtureFriends);
  const result = friendsReducer(initial, {
    type: "scanned",
    handle: "@mike",
  });
  assert.equal(result.notice, "Already friends");
  assert.deepEqual(initial, fixtureFriends);
});

console.log("friends: all checks passed");
