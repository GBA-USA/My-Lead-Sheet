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
