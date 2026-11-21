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

Until this is answered, `check:new-song` fails on case 5 alone.
