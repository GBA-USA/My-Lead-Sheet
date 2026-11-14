import { fixtureChats, fixtureMessages, unread, sortChats, isBold, mute, isMuted, firstUnreadSeq, side, nameAbove, queueSend, flush, MUTE_8H, MUTE_1W, ME } from "../src/chat-model.ts";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, actual?: unknown, expected?: unknown) {
  if (condition) {
    console.log(`ok ${name}`);
    passed++;
  } else {
    console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    failed++;
  }
}

// Test unread counts
const bandChat = fixtureChats.find((c) => c.kind === "band")!;
const dmChat = fixtureChats.find((c) => c.kind === "dm")!;
assert("unread band = 3", unread(bandChat) === 3, unread(bandChat), 3);
assert("unread dm = 0", unread(dmChat) === 0, unread(dmChat), 0);

// Test unread never negative
const negChat = { ...bandChat, lastReadSeq: 20 };
assert("unread never negative", unread(negChat) === 0, unread(negChat), 0);

// Test sortChats newest first
const sorted = sortChats(fixtureChats);
assert("sortChats newest first", sorted[0].lastAt > sorted[1].lastAt && sorted[1].lastAt > sorted[2].lastAt);

// Test input unchanged
const original = [...fixtureChats];
sortChats(fixtureChats);
assert("sortChats input unchanged", JSON.stringify(fixtureChats) === JSON.stringify(original));

// Test isBold
assert("isBold band", isBold(bandChat), isBold(bandChat), true);
assert("isBold dm", !isBold(dmChat), isBold(dmChat), false);

// Test mute values
const now = 1700000000000;
const muted8h = mute(bandChat, "8h", now);
assert("mute 8h value", muted8h.mutedUntil === now + MUTE_8H, muted8h.mutedUntil, now + MUTE_8H);

const muted1w = mute(bandChat, "1w", now);
assert("mute 1w value", muted1w.mutedUntil === now + MUTE_1W, muted1w.mutedUntil, now + MUTE_1W);

const mutedAlways = mute(bandChat, "always", now);
assert("mute always value", mutedAlways.mutedUntil === Infinity, mutedAlways.mutedUntil, Infinity);

// Test isMuted after 8h passes
const muteAfter = mute(bandChat, "8h", now);
assert("isMuted false after 8h passes", !isMuted(muteAfter, now + MUTE_8H + 1000, false), isMuted(muteAfter, now + MUTE_8H + 1000, false), false);

// Test isMuted band on gigLive
assert("isMuted band when gigLive", isMuted(bandChat, now, true), isMuted(bandChat, now, true), true);

// Test isMuted dm on gigLive
assert("isMuted dm false when gigLive", !isMuted(dmChat, now, true), isMuted(dmChat, now, true), false);

// Test firstUnreadSeq
assert("firstUnreadSeq band = 10", firstUnreadSeq(bandChat) === 10, firstUnreadSeq(bandChat), 10);
assert("firstUnreadSeq dm = null", firstUnreadSeq(dmChat) === null, firstUnreadSeq(dmChat), null);

// Test side and nameAbove
const alexMsg = fixtureMessages[0];
const mikeMsg = fixtureMessages[1];
assert("side ME -> mine", side(alexMsg) === "mine", side(alexMsg), "mine");
assert("side Mike -> theirs", side(mikeMsg) === "theirs", side(mikeMsg), "theirs");
assert("nameAbove ME -> You", nameAbove(alexMsg) === "You", nameAbove(alexMsg), "You");
assert("nameAbove Mike -> Mike", nameAbove(mikeMsg) === "Mike", nameAbove(mikeMsg), "Mike");

// Test queueSend offline -> waiting
const q0 = queueSend([], "r-test", "hello", false, "local-1");
assert("queueSend offline -> waiting", q0[0].state === "waiting", q0[0].state, "waiting");

// Test queueSend online -> sent
const q1 = queueSend([], "r-test", "hello", true, "local-2");
assert("queueSend online -> sent", q1[0].state === "sent", q1[0].state, "sent");

// Test blank text ignored
const q2 = queueSend([], "r-test", "   ", true, "local-3");
assert("queueSend blank text ignored", q2.length === 0, q2.length, 0);

// Test flush waiting -> sent
const qWithWaiting = [
  { localId: "local-1", roomId: "r-test", text: "msg1", state: "waiting" as const },
  { localId: "local-2", roomId: "r-test", text: "msg2", state: "sent" as const },
];
const flushed = flush(qWithWaiting);
assert("flush changes waiting to sent", flushed[0].state === "sent", flushed[0].state, "sent");
assert("flush keeps sent as sent", flushed[1].state === "sent", flushed[1].state, "sent");

// Test flush keeps order
assert("flush keeps order", flushed[0].localId === "local-1" && flushed[1].localId === "local-2");

// Test flush does not mutate input
assert("flush does not mutate input", qWithWaiting[0].state === "waiting", qWithWaiting[0].state, "waiting");

if (failed > 0) {
  console.log(`\nchat: ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\nchat: all checks passed`);
