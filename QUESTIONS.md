# C21 question: three test faults left in commit 1's `check:mirror` (bd432d0). May CoS apply this test-only patch?

The build (fced55e) is committed. Under the queue rules I did not edit the commit-1 test after it. Each fix below is
to a window, a counter or a page setup that the test made itself. No assertion changes what it requires, and no
expected value moves. With the patch applied, `check:mirror` passes in full here: real tabs twice in a row, the
fake-clock and fake-DOM parts every run (Edge on Windows, with the path shim). Without it, the committed test fails
two fake-clock cases on every run, and one real-tab case on every run under Edge (two when the race in fix 4 hits).

The C20h question this file held before is answered on this base: its `EDGE_MS = 1` padding is in
`scripts/check-sync-check.ts`. Git history keeps its text.

## 1. "a change arriving 200 ms late ..." waits 1.5 s for a change it schedules up to 2.2 s out (fails every run)

The page turn snaps to the beat before the next bar line after `now + lead` (PLAN.md 7.8). On this case's 120 bpm grid
that is 1.65 s after the tap, and the stand-in room delivers it 200 ms after that, at 1.85 s. The case watches only
1.5 s, so it never sees the turn, and `shownAt` stays null.

**Fix (window only):** watch until 1 s past the change's own `at`.

## 2. The flash case counts each 100 ms flash twice (answered in the build, no test patch needed)

It samples every 5 ms and starts a new "onset" whenever a lit sample is more than 50 ms after the first sample of
the current flash. A 100 ms flash then reads as two onsets, so 8 flashes count as 16.

**Answered:** the hand-off flash is now a 50 ms blink (`FLASH_MS` in `src/gig-live.ts`), so case 14 passes as written.
The diff hunk for it below still passes if applied, but it is no longer needed.

## Still on Ubuntu CI at c0c2175 (GitHub Actions Deep verify)

Items 1, 3 and 4 fail there with the same messages as here. Item 3 is not Edge-only: Chrome on Linux leaves the
unfrozen tab's frame loop stopped too. With the build fixes in the commit after c0c2175, these three are the only
`check:mirror` FAIL lines left (28 ok).

## 3. The 30 s freeze leaves the tab hidden, so its frame loop never runs again (fails every run, Edge and Chrome)

In headless Edge, `Page.setWebLifecycleState frozen` hides the page, and `active` does not make it visible again. A
probe showed `requestAnimationFrame` stopped and `setInterval` throttled until `Emulation.setFocusEmulationEnabled`
brought the page back to visible. The harness logs flips, beats and strip words from its frame loop, so nothing new
is logged after the unfreeze. A real phone is visible again when it unlocks. Case 10 runs on the same tab after
case 2, so it fails too.

**Fix (page setup only):** turn focus emulation on after `active`.

## 4. Case 10 waits on the live strip, then reads the frame log, which is up to one frame behind (fails some runs)

`view().strip` is computed when it is called, and the frame loop logs a new strip key on the next frame. The poll
can see "quiet" before the log has it, and then `strips.filter(...).pop()` is undefined. That happened once in three
real-tab runs.

**Fix (wait only):** wait until the strip log has the key.

## Also, a label (no patch asked)

Case 12's label says "the gig's band thread is quiet, and only it", but its assertion (2 unread) mutes every band
thread on stage and keeps DMs. The build follows the assertion: `isMuted(c, now, gigLive)` in `chat-model.ts`
already mutes any band thread when `gigLive` is set, and PLAN.md 8.3 rule 4 says nothing pops up during a gig.

## Patch

```diff
diff --git a/scripts/check-mirror.ts b/scripts/check-mirror.ts
index c620867..8f59583 100644
--- a/scripts/check-mirror.ts
+++ b/scripts/check-mirror.ts
@@ -342,6 +342,7 @@ async function realTabs() {
       assert.ok(counted.ok, js(counted));
       await sleep(Math.max(0, 30_000 - (Date.now() - frozenAt)));
       await samSite.send("Page.setWebLifecycleState", { state: "active" });
+      await samSite.send("Emulation.setFocusEmulationEnabled", { enabled: true });
       const back = await until("Sam synced again on Mike's song", () => view(samSite), (v) => v.confidence === "synced" && v.state?.key === order[4] && v.beats.length > before.beats.length + 2, 30_000);
       const after = back.strips.filter((s) => s.frame > before.frame);
       assert.ok(after.some((s) => s.key === "syncing"), `the strip said Syncing on the way back (${js(after.map((s) => s.key))})`);
@@ -360,13 +361,13 @@ async function realTabs() {
       await call(mikeSite, "close()");
       await mikeSite.close();
       sites.splice(sites.indexOf(mikeSite), 1);
-      const quiet = await until("isn't answering", () => view(samSite), (v) => v.strip.key === "quiet", 25_000);
+      const quiet = await until("isn't answering", () => view(samSite), (v) => v.strips.some((s) => s.key === "quiet"), 25_000);
       const quietLog = quiet.strips.filter((s) => s.key === "quiet").pop()!;
       const quietAfter = (quietLog.local - quietLog.heardAt!) / 1000;
       assert.equal(quiet.strip.words, "Mike's phone isn't answering");
       assert.ok(quietAfter >= 9.9 && quietAfter <= 11, `isn't answering 10 s after the last answer (${quietAfter.toFixed(2)} s)`);
       assert.ok(quietLog.local - closedAt <= 15_000, "and within 15 s of the tab closing");
-      const dropped = await until("dropped", () => view(samSite), (v) => v.strip.key === "dropped", 40_000);
+      const dropped = await until("dropped", () => view(samSite), (v) => v.strips.some((s) => s.key === "dropped"), 40_000);
       const droppedLog = dropped.strips.filter((s) => s.key === "dropped").pop()!;
       const droppedAfter = (droppedLog.local - droppedLog.heardAt!) / 1000;
       assert.equal(dropped.strip.words, `Mike's phone dropped · still on ${songNumber}`);
@@ -683,7 +684,7 @@ async function fakeClock() {
     const at = turned.last.at;
     room.push(turned, at - truth() + 200);
     let shownAt: number | null = null;
-    await advance(1_500, () => {
+    await advance(at - truth() + 1_000, () => {
       if (shownAt === null && L.position(live.view().state, live.bandNow()).section === 3) shownAt = live.bandNow();
     });
     assert.ok(shownAt !== null && shownAt - at >= 199 && shownAt - at <= 200 + FRAME + 1, `the page turn shows on the first frame after it arrives (${shownAt! - at} ms after its at)`);
@@ -766,10 +767,12 @@ async function fakeClock() {
     const grid = running.click[running.click.length - 1].value;
     const firstBeat = Math.ceil((handoffAt - grid.startAt) / BEAT) * BEAT + grid.startAt;
     const on: number[] = [];
+    let lit = false;
     for (let t = handoffAt; t < handoffAt + 8_000; t += 5) {
       const s = L.stripOf(input(viewOf(running, { handoffAt }), t));
       assert.equal(s.tone, "blue", "blue while the backup leads");
-      if (s.flash && (on.length === 0 || t - on[on.length - 1] > 50)) on.push(t);
+      if (s.flash && !lit) on.push(t);
+      lit = s.flash;
     }
     assert.equal(L.FLASH_BARS, 2);
     const expected = Array.from({ length: 8 }, (_, i) => firstBeat + i * BEAT);
```
