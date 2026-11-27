VERDICT: FAIL
P1 | CLASS=check-defect | scripts/check-gig-check-in.ts:977 | K3's last line passes a JS expression (`gigView(gigId)`) to `has()`, which runs `document.querySelector` on it and throws `SyntaxError ... is not a valid selector` on every run, so `npm run check:gig-check-in` exits 1 whatever the app does. Seen in .verify-logs/k-real.log and final-gig-check-in.log. A scratch copy with only that line changed to `evaluate<boolean>(`!!${gigView(gigId)}`)` passes all 18 cases three runs in a row. Not edited: the brief forbids editing a case after commit 1; QUESTIONS.md (top entry) asks for the one-line fix. Open until the owner answers.
Nits:
P3 | CLASS=laptop-only | scripts/check-mirror.ts:299 | Case 1 "each tab's band clock is within 8 ms" fails on this Windows laptop: 26.84 ms, then 8.52 ms alone, 13.05 ms with this cook's heartbeat switched off, and 45.35 ms on the merge base 640f930 with none of this cook's code. Not caused by this cook; the Linux Deep verify decides.
P3 | CLASS=laptop-only | scripts/check-gig.ts:12 | Stops at start: esbuild cannot resolve `/C:/.../src/gig-state.ts` from `new URL(...).pathname`. Neither file is changed by this cook.
P3 | CLASS=laptop-only | scripts/check-gig-plan.ts, scripts/check-ux-gig-view.ts | Both stop at start with `ENOENT C:\C:\...\data\library.json` (a `new URL(...).pathname` path on Windows), on this branch and on the merge base alike. src/gig-view.tsx is covered here only by K1, K2, K12 and K18.
P3 | CLASS=ui-rule-2 | src/gig-check-in.tsx:133 | Band status opens from the faces strip (K18) and from the warning's See who (brief item 4). Both are asked for by the brief. Asked in QUESTIONS.md (top entry), not ruled on here.
P3 | CLASS=flaky-unlisted | scripts/check-api.ts | One earlier run failed "room stamps rx 1795814628063 <= tx 1795814628063 inside the round trip" (.verify-logs/r3-check:api.log); the next run and the final run passed. Not on CLAUDE.md's flaky list; named for CoS.
P3 | CLASS=proof | scripts/check-gig-check-in.ts K19 | Added after the build for the Downloaded fix in 435476d: red with the fix removed, green with it (.verify-logs/k19-red.log, k19-green.log). K1 to K18 unchanged (the diff from 60875a9 has no removed line).

# What was checked (assume it is wrong, look for it)

- K1 to K18: all ok on three scratch runs in a row (K3 fixed in the scratch copy only); on the registered check, 17 ok and K3 FAIL for the reason above.
- Mutation table: 17 of 17 turn their cases red (.verify-logs/mutations.txt, mutate-driver*.log).
- A silent phone: K14 and the live run (Not connected 10.1 s after the last beat, Connected 4.5 s after beats resume, one row in 214 looks).
- A quiet roster: K15 count 0 in 30 s, 1 after one join, on every run.
- Paths a roster can take: `pushRoster` is the only sender. Its `to` is the open sockets of this gig (`gigSockets`, which runs `stillIn`, so ended guest passes are closed) whose user is in `gigRoom.roster().to`: active admins and the player leading now (`leadingNow`), read from the Room's tables each time. `roster-ask` is answered only on a socket already in that gig, and only if it is in `to` (the asker skips only the same-key check). Removed members are closed by `closeMember` and are not active. Nothing from the phone names a role.
- SQL: the two new statements in worker/room-gig.ts bind `gigId`, `"active"`, `"admin"` with `?`. No text is built from a value.
- C23's checks: check:band-status and check:ux-band-status green; their files are unchanged against origin/mls-int-20261113.
- 360 px light and dark: Tonight's players, the roster with one Connected, one Not connected and one Not synced, the warning, the silent phone and its return (C:\Users\guard\cooks\reports\p6-gig-check-in-shots).
- Fixed in this pass: Band status showed Connected beside Not yet for a player who downloaded after the screen read the gig (src/gig-check-in.tsx `withCheckIn`), reproduced by a scratch assertion red before and green after.
