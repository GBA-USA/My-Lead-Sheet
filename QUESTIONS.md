# L1 questions: frozen L1.2 and four Chrome checks meet code L1 does not own

L1 is built and its cases pass, except for two seams with code this cook does not own. Each one needs a decision from its owner. Neither one needs Terry.

## 1. Frozen L1.2 fails because of the L2 tempo tracker, not the listen

Frozen L1.2 in `scripts/check-learn.ts` changes 122 to 150 BPM 8 s before the end of a 60 s file. It expects the change in `analysis.tempos`. The listen delivers every sample to the worker, but the engine reads only "122.2 BPM at 3.00 s".

The cause is in `src/learn-analyze.ts`. Since L2 (`928cb32`), `trackBeats` follows a local tempo only within 20% of the song's tempo (`FOLLOW_LOCAL`, `nearOctave`). 150 is 23% over 122. At the LT-A freeze (`f336126`) the tracker followed any local tempo, which is why LT-A's prototype passed L1.2.

The position of the change does not matter. This engine probe uses the same song as L1.2 at 22050 Hz:

| Song | Change | Found in `analysis.tempos` |
| --- | --- | --- |
| 60 s | 122 to 150 at 52 s (frozen L1.2) | no |
| 60 s | 122 to 150 at 30 s | no |
| 120 s | 122 to 150 at 60 s | no |
| 90 s | 122 to 150 at 30 s | yes, because 150 is the song's tempo |
| 60 s | 122 to 138 at 52 s | yes, at 52.6 s |

The condition L1.2 names, "the last ten seconds count", holds. A new case shows it: a change to 138 BPM 8 s before the end of a picked file is found at 52.62 s. Frozen L1.2 stays marked "pending until l1". It still runs and prints its FAIL, but that FAIL does not fail `check:learn`.

One of these settles it:

- The L2 owner lets the tracker follow a lasting change past 20%, and keeps L2's push and drift cases green. Then remove the mark from L1.2.
- The LT-A owner re-freezes L1.2 with a change the tracker follows, such as 138 BPM. That is the case this cook added.

## 2. Four Chrome checks expect Learn by listen to open the mic at once

The plan's flow opens the Learn sheet on two ways in: "Pick the song's file" and "Listen with the mic". Frozen L1.8 needs the wake lock asked for inside a tap on a mic button in the sheet. Before L1, **Learn by listen** started the mic as the sheet opened.

These checks still tap **Learn by listen** and then wait for the mic. They pass on the base `1eeb615` and time out "waiting for the mic" on this branch:

- `check:bar` ("Learn by listen" scenario)
- `check:heard`
- `check:learned`
- `check:ux-sheet-controls-save` ("a take's Done and a learn review's Save land in the draft")

Each one needs one more line right after its **Learn by listen** tap:

```ts
await click('[role=dialog] button[aria-label="Listen with the mic"]');
```

In `check:bar` and `check:ux-sheet-controls-save`, write it as `` await evaluate(`document.querySelector('[role=dialog] button[aria-label="Listen with the mic"]').click()`) ``, because their tap helpers match text, not a selector.

On a scratch copy of this branch with only those four lines added, the four checks match the base line for line: `check:bar` 41 ok, `check:heard` 28 ok, `check:learned` 52 ok, and `check:ux-sheet-controls-save` 47 ok. `check:ux-sheet-controls-save` also prints the same two "first chord" FAIL lines as the base, which are the known Windows font gap. This cook does not own these checks, so the four lines are not on this branch.

---

# C20h question: two fixture faults in commit 1's `check:sync-check` (3e4995a). May CoS apply this test-only patch?

The build (e9a3df1, d8fc388) is committed and complete. Per the queue rules I did not edit the commit-1 test after
the build. No assertion changes. Both fixes are to fixture data or a window edge the test built itself.

**For the screen mount (PR #98 deep fix):** `SyncCheckSheet` takes a `metronome` prop. Pass App's own
`useMetronome` result (`metronome={metronome}` in `src/App.tsx`). The speaker delay is saved through it, so no other
metronome setting writes over it. A second `useMetronome` would bring the P2-1 bug back.

## 1. The sync-video fixture can't say which flash is which beat (7 cases fail every run)

**Cases:** the six sync-video cases after "sync-video headline is FAIL", from "A: 17 flashes found" to "--all prints
every flash time".

**What goes wrong:** beats are 500 ms apart, and in the fixture phones A and C log `shown_at` exactly on the grid,
while B differs only on even beats. So the film lines up with the log equally well at the right offset and two beats
over. One fit calls C's late flash beat 7, the other beat 5, and nothing in the frame list or the log picks between
them. `scripts/sync-video.ts` now says the line-up is ambiguous rather than guessing, so these cases fail. A real
log can't look like this: every phone's `shown_at` carries its own 60 Hz frame jitter, and that pins the offset.

**Fix (fixture only):** give each phone's logged `shown_at` its own jitter, as a real phone's has.

## 2. The run's click window ends exactly on the last beat (1 case fails every run)

**Case:** "during the run: clicks on every band beat".

**What goes wrong:** the fixture's band times are epoch-scale (about 1.7e12 ms), where a double resolves to 2^-8 ms.
The last beat's heard click computes to 0.0039 ms past `endsAt - BEAT_MS`, so `at <= toBand` drops it, and the case
counts 19 clicks for 20 beats. All 20 are heard. The same run's "each beat's clicked_at ... within 0.1 ms" case passes
for all 20 beats. A probe printed both edges at +0.00390625 ms. The idle-window case already pads its edges.

**Fix (setup only):** pad the window by 1 ms on each side. Beats are 500 ms apart, so no other beat comes in.

## Patch

```diff
--- a/scripts/check-sync-check.ts
+++ b/scripts/check-sync-check.ts
@@ -193,7 +193,8 @@
   const FLASH_MS = 100;
   /** Film starts 2249.3 band ms in, so beats 0-2 are before it and each phone shows 17 flashes (beats 3-19). */
   const FILM_START_BAND = 2249.3;
-  const logged = (user: string, n: number) => beatAt(n) + (user === "B" && n % 2 === 0 ? 1.5 : 0);
+  /** Each phone's own frame-to-frame jitter in shown_at, as a real log has, so the film lines up on one beat only. */
+  const logged = (user: string, n: number) => beatAt(n) + (user === "B" && n % 2 === 0 ? 1.5 : 0) + ((n * 7 + user.charCodeAt(0)) % 16) * 0.5;
   const log = ["A", "B", "C"].flatMap((user) => BEATS.map((n) => row("film", user, n, user === "A" ? "leader" : "wifi", { shown_at: logged(user, n) })));
   /** Brightness when lit and dark: B is a dimmed phone, so a fixed threshold would miss it. */
   const LEVELS: Record<string, [number, number]> = { A: [250, 12], B: [60, 20], C: [200, 30] };
@@ -679,7 +680,7 @@
   const runClickFrom = scheduled.length;
   const runSeen = await advance((serverRun.endsAt - bandNow()) / 1000 + 8);
   flashesOnBeats("during the run: flashes on every band beat", runSeen.filter((frame) => bandAt(frame.at * 1000) <= serverRun!.endsAt + 300), bandAt);
-  clicksOnBeats("during the run: clicks on every band beat", runClickFrom, runStart, serverRun.endsAt - BEAT_MS, 0);
+  clicksOnBeats("during the run: clicks on every band beat", runClickFrom, runStart - 1, serverRun.endsAt - BEAT_MS + 1, 0);
   const logged = posts.filter((post) => post.path === "/api/bands/sync/log").flatMap((post) => (post.body.beats as Row[]).map((beat) => ({ ...beat, runId: post.body.runId, bandId: post.body.bandId })));
   const beatsLogged = logged.map((beat) => beat.beat).sort((x, y) => x - y);
   check("every beat of the run is sent once: beats 0-19", JSON.stringify(beatsLogged) === JSON.stringify(BEATS), JSON.stringify(beatsLogged));
```

## Proof

- The committed check on this branch prints 109 ok and 8 FAIL: the 7 sync-video cases and the run's click window.
- A throwaway copy with exactly this patch printed 117 ok and 0 FAIL, exit 0, in 3 of 3 runs on this laptop.
  It was deleted afterwards and never committed.
- Mutations on the patched copy, one at a time, each turned a case red: writes accepted after the run, the speaker
  delay not passed to the click, the p95 rank off by one, and rows logged outside a run.

---

# C19 question: two setup faults in commit 1's `check:fanout` (209ab90). May CoS apply this test-only patch?

The build (860e7c0) is committed and complete. Per the queue rules I did not edit the commit-1 test after the build.
No assertion about the fan-out changes. Both fixes concern how the test makes or names a route.

## 1. Case 4 never switches Fran to the internet (fails every run)

**Case:** "4. a route switch mid-click leaves the logged click times unchanged".

**What goes wrong:** `switchToInternet()` turns on `__blockLocal` on Fran's tab only, then closes her data channel.
C17 re-introduces the link, but the leader's tab still sends its host candidates. Fran's ICE agent pairs its own host
address with the leader's host address, and the link comes back labeled Wi-Fi. The case waits 20 s for `internet` and
times out. `check:links` case 2 blocks host candidates on both tabs for this reason.

Measured: failed in 4 of 4 runs of the committed file, each time with `"chosen":{"route":"wifi","state":"open"}`.

**Fix (setup only)** in `scripts/check-fanout.ts`, around lines 752-753:

```diff
+    await leaderSite.evaluate("window.__blockLocal = true");
     await call(franSite, "switchToInternet()");
     await until("Fran's link over the internet", () => view(franSite), (v) => v.chosen?.route === "internet" && v.chosen.state === "open", 20_000);
+    await leaderSite.evaluate("window.__blockLocal = false");
```

Blocking only affects connections made after it, so Gus's open Wi-Fi link is untouched.

**Proof:** a throwaway copy with only those two lines added, run on this laptop against the build with Edge as `CHROME`
and the Windows path shim, printed 24 of 24 ok, `check:fanout ok`. Case 4 passed with the switch from Wi-Fi to the
internet mid-click: every click consecutive, each at the leader's grid time, and shown within 60 ms of it. The copy was
deleted afterwards and never committed.

## 2. Case 2 (and the setup wait before case 5) names the direct route `wifi` exactly (failed 1 run in 5)

**Case:** "2. the same rev on two links applies once", line 669, and the setup wait at line 622.

**What goes wrong:** on one machine, C17's combined attempt sometimes settles on the STUN pair, so a direct link is
labeled "Over the internet" rather than "Wi-Fi link". In one run of five, Fran heard rev 4 as
`[{"result":"applied","via":"internet"},{"result":"duplicate","via":"room"}]`. That is the behavior the case is
about (one apply, a direct copy plus the room's copy), but the assertion wants `via === "wifi"`. The same race could
time out the setup wait, which counts `route === "wifi"` links at the leader. That is my inference. It has not
happened yet.

**Fix (setup only, the claim is unchanged: a direct link plus the room):**

```diff
@@ line 622
-  await until("two Wi-Fi links at the leader", () => view(leaderSite), (v) => v.followers.filter((f) => f.route === "wifi" && f.state === "open").length === 2, 15_000);
+  await until("two direct links at the leader", () => view(leaderSite), (v) => v.followers.filter((f) => f.route !== "server" && f.state === "open").length === 2, 15_000);
@@ line 669
-          assert.ok(copies.some((h) => h.via === "wifi") && copies.some((h) => h.via === "room"), `${names[i + 1]} rev ${done.rev}: both carriers (${js(copies)})`);
+          assert.ok(copies.some((h) => h.via === "wifi" || h.via === "internet") && copies.some((h) => h.via === "room"), `${names[i + 1]} rev ${done.rev}: both carriers (${js(copies)})`);
```

**Proof:** the failing run's log is quoted above. Four other runs passed case 2 with `via: "wifi"`. Not run with the
change. Reading the assertion, the failing run's entries satisfy it, and a follower heard only through the room still
fails it.

---

# C18b question: check:routes case 8b still expects an empty rating slot

`scripts/check-routes.ts` (C18, not mine to edit) case "8b. Settings and the Connection screen outside a gig show no id, offset, epoch, follower or relay, and leave the rating slot empty" asserts `[data-slot=rating]` is "" on every row, with the message "the rating slot is empty until C18b". C18b is this cook. Its pass condition 2 is that all four rows now show a rating, so 8b fails by design on this branch:

    the rating slot is empty until C18b: got ["Not tried yet","Not tried yettest with a bandmate","Not tried yet","Not tried yet"], want ["","","",""]

Everything else in 8b (no id, offset, epoch, follower or relay words; the slots are still name, line, rating) passes. I did not edit the check. Proposed one-line change for whoever owns it: expect the four rows to read `Not tried yet` (the Wi-Fi link row also reads `test with a bandmate`), or drop the last assertion. The rating cell is `<span data-slot="rating"><span data-word>…</span><small data-age>…</small></span>`.

---

# P5 song notes: one question on a test

`check:song-notes`, case "a note added by an admin is listed for a member on the same band song, newest first, with
author name and date", asserts `before <= createdAt <= after`. `before` and `after` come from `Date.now()` in the
Node test process. `createdAt` comes from `Date.now()` in workerd, a separate process.

On this Windows laptop the full check failed this assertion once in four runs ("with the time it was added"). The
other three runs passed all 14 cases. A probe of 40 idle adds found no note outside `[before, after]`. So the failure
appears only under load. It may come from workerd's coarser clock on Windows, but that is a guess.

The test is wrong in a small way: it needs the two processes' clocks to agree to the millisecond. Commit 1 may not be
edited, so I left it. Proposed fix for whoever owns the tests: allow a tolerance, for example
`createdAt >= before - 1000 && createdAt <= after + 1000`. Keep the ordering check (`first.createdAt <=
second.createdAt`), which uses one clock. The box (Linux) has not shown it yet. Its fresh-tree verify decides whether
this is a laptop-only flake.

# P6 question: check:new-song case 5 matches the friend button by its whole text

Resolved Nov 21, 2026: applied as written in the PR #88 fix round (pre-approved). `check:new-song` case 5 now finds Mike by name.

**Asking:** may the build change two lines in `scripts/check-new-song.ts` (a commit 1 test) so case 5 finds the friend by name the way `check:send-song` does?

## What is wrong

Case 5, "an own song can be shared to a band and sent to a friend with the existing flows", waits at `scripts/check-new-song.ts:514` for a button whose whole text is `Mike Keys`, then taps it at line 515. The send sheet's friend button (`src/send-song.tsx:200-203`, which this cook does not own) shows the name with the handle under it: its text is `Mike Keys@mikekeys`, and its `aria-label` is `Mike Keys`. The wait never matches, so the case times out at "Mike in the friend list". The app is fine. `check:send-song` already taps this button with `startsWith`.

## The fix asked for

```ts
// line 514
await page.until(`[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim().startsWith("Mike Keys"))`, "Mike in the friend list");
// line 515
await site.evaluate(`document.querySelector("[role=dialog] [aria-label='Mike Keys']").click()`); await settle();
```

Nothing else changes. The case's assertions stay as they are: the DM card holds Pat's own chart sent Public, and the band library takes the song with a 200.

## Evidence

- `check:new-song` as committed, on this laptop with headless Edge: 16 ok and 1 FAIL. The FAIL is case 5: "timed out waiting for Mike in the friend list".
- A throwaway copy with only lines 514 and 515 changed as above prints `ok   5. an own song can be shared to a band and sent to a friend with the existing flows` and `check:new-song passed` (all 17 cases). The copy was deleted after the run. Nothing else in the tree changed.

**Answer:** approved. The PR #87 fix round applied the two lines in commit 0c48d57.

---

# QUESTIONS: P2 gig plan

## Two setup bugs in commit 1 (e1997b9). May CoS apply this setup-only patch to `scripts/check-gig-plan-record.ts`?

Resolved Nov 21, 2026: applied as written in the corrective for ux-p2-gig-plan-verify (pre-approved, runbook step 9). The full box run is 15 of 15 ok. The `chrome.ts` bug below was already fixed on the base.

The build (1096d39) is committed and complete. Per the queue rules I did not edit the commit-1 test after the build.
No assertion changes. Both fixes are setup.

### 1. The box cases never start

The file calls `await boxCases()` near line 112, before `const boxTools`, `const SONGS` and the other top-level
constants below it are initialized. The full run stops at once:

```
ReferenceError: Cannot access 'boxTools' before initialization
    at boxCases (scripts/check-gig-plan-record.ts:151:84)
```

`--pure` is unaffected and passes (3 of 3). Fix: move the run block and the summary to the end of the file.

### 2. Sam's typed sign-up makes a later reload open a real "Leave site?" dialog

`app.signUp` types the name with `Input.insertText`, which gives the page user activation. The check reloads once
afterwards (line 268) to drop it. In Edge the activation survived that reload (inferred from the run below). The draft
case then reloads with a changed form (line 423). The app asks the browser to warn, as pass condition 8 requires, so a
real dialog opens. Every later `Runtime.evaluate` waits on it, and the check hangs until the runner's timeout.

Measured: a copy with only fix 1 printed 7 ok up to "Plan again pre-fills everything but the date". It then sat at the
draft case for over 10 minutes with no output, and I stopped it. Fix: sign Sam up the way `app.signUp` does, but set the
name through the value setter (as the check's own `setField` does) so the page never gets a real keystroke.

### Patch

```diff
@@ -110,12 +110,2 @@ await check("Plan again pre-fills everything but the date (pure)", () => {
 
-if (!PURE_ONLY) {
-  await boxCases();
-  await beforeColumns();
-}
-
-if (failed > 0) {
-  console.log(`${failed} failed`);
-  process.exit(1);
-}
-console.log(PURE_ONLY ? "check:gig-plan-record pure cases passed" : "check:gig-plan-record passed");
 
@@ -260,3 +250,15 @@ async function boxCases() {
     await app.library();
-    await app.signUp("Sam Rivera");
+    /** app.signUp, with the name set like setField instead of typed, so the page never gets a real keystroke. */
+    await app.openMenu();
+    await app.pick("Sign in");
+    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "start"`, "the start screen");
+    await app.click("New here? Create an account");
+    await site.evaluate(`(() => { const field = [...document.querySelectorAll("[role=dialog] label")].find((l) => l.textContent.trim() === "Your name (what bandmates see)").control; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, "Sam Rivera"); field.dispatchEvent(new Event("input", { bubbles: true })); })()`);
+    await settle();
+    await app.click("Sign in with Face ID or fingerprint");
+    await app.until(`["nudge", "account"].includes(document.querySelector(".account-sheet")?.dataset.step)`, "the end of Create account");
+    if ((await site.evaluate<string>(`document.querySelector(".account-sheet").dataset.step`)) === "nudge") await app.click("Not now");
+    await app.until(`document.querySelector(".account-sheet")?.dataset.step === "account"`, "the account screen");
+    await app.click("✕");
+    await app.closeMenu();
     const sam = await me();
@@ -672 +674,12 @@ async function beforeColumns() {
 }
+
+if (!PURE_ONLY) {
+  await boxCases();
+  await beforeColumns();
+}
+
+if (failed > 0) {
+  console.log(`${failed} failed`);
+  process.exit(1);
+}
+console.log(PURE_ONLY ? "check:gig-plan-record pure cases passed" : "check:gig-plan-record passed");
```

**Proof:** a throwaway copy with exactly this patch, run on this laptop against the build with Edge as `CHROME`:
15 of 15 ok, `check:gig-plan-record passed`. That covers pass conditions 1 to 8, the five widths, no page errors, and
the old-row fixture. Deleted afterwards, never committed.

## Base-tree bug outside this cook: every `scripts/chrome.ts` browser check throws on start

Lint commit 5501704 changed `let sessionId` to `const sessionId: string | undefined = undefined` in
`scripts/chrome.ts` line 105. Line 120 still assigns it, so `openSite` throws
`TypeError: Assignment to constant variable.` before any page opens. That breaks every Chrome check on
`mls-int-20261113` on the box too, not only mine. The fix is the old `let sessionId: string | undefined;`. That file is not
mine, so I left it. My proof run above used a throwaway copy of `chrome.ts` with that one word changed.

---

# QUESTIONS: P1b join-links follow-up

## One test in commit 1 (75a65bd) has a setup bug. May CoS apply this one-line fix?

**Case:** `check:join-links` › "a refused or offline paste says why in the app and joins nobody".

**What goes wrong:** the case starts a second Worker with the browser's `APP_ORIGIN` (`http://localhost:<port>`), then signs a player up there with `new Phone(base).createAccount(...)`. `Phone` always sends `Origin: https://app.test`, so that Worker refuses the sign-up, and the case throws `Cannot read properties of undefined (reading 'user')` before its first assertion about the app.

This is a test-setup mistake, not a behavior gap. The landing-page case uses the same pattern and passes, because its Worker keeps the default `https://app.test` origin.

**Fix (setup only, no assertion changes)** in `scripts/check-join-links.ts`:

```diff
-      const lost = new Phone(elsewhere.base);
-      ok(await lost.createAccount("Gone Row"), "a player whose codes this server never saw");
+      const lost = await passwordPlayer(elsewhere.base, origin, "Gone Row", "gonerow");
```

`passwordPlayer` is the helper the same file already uses for Terry and Mike. It sends the browser's origin.

**Proof:** I ran a throwaway copy with only that change (deleted afterwards, never committed). Result on this laptop, Edge as `CHROME`: 14 of 14 ok, `check:join-links passed`. On the committed file, the result is 13 ok and 1 FAIL (this case).

Per the queue rules I did not edit the commit-1 test after the build started. The build is committed and complete.
