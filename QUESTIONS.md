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
