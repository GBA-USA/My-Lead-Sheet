# C20h question: two fixture faults in commit 1's `check:sync-check` (3e4995a). May CoS apply this test-only patch?

The build (e9a3df1, d8fc388) is committed and complete. Per the queue rules I did not edit the commit-1 test after
the build. No assertion changes. Both fixes are to fixture data or a window edge the test built itself.

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
