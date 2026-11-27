VERDICT: FAIL
P2 | CLASS=other | src/gig-view.tsx:280 | set `admin={false}` on the gig-view BandStatusFaces mount; check:band-status (74 ok) and check:ux-band-status (10 ok) both still pass, so F1 in the gig view (the brief's second mount) has no regression guard
P2 | CLASS=stale-ui | src/gig-view.tsx:141 | a member opens the gig view while the gig is planned, then the leader goes live; `gig/open` is read once, so `status` stays "planned" and the member can still tap a face and open Band status (breaks F3) until reload
P2 | CLASS=other | ../EDGE-CASES.md:14 | fix round c23-fix (5eeebe8..966f73b) added no EDGE-CASES.md row; grep for c23 or band status finds none
Nits: P3 | PR #107 body says "check:ux-band-status is unchanged against mls-int-20261113", but 966f73b changes its repo-root lines (fileURLToPath/join); P3 | PR #107 body says 73 cases, but check:band-status prints 74 ok at 966f73b; P3 | PR #107 head is still 5e02b90, so the body has not been refreshed for this fix round

# Fix pass 1 (c23-fix self-check)

Goal: each finding above has a check case or grep that fails on `966f73b` and passes after the fix. Logs are in `.verify-logs/c23-fix2/` on the laptop.

Commit `6a7f5c3` holds the two new cases alone, in `check:ux-band-status`. Each one takes a real gig live over the band room socket and sends no feed after it.

- First P2 (no guard on the gig-view mount). The case is "F1 on the gig view of a live gig with no feed, the admin's tap opens Band status". Sam is the admin of Sam's Trio and Terry leads. It passes on `966f73b`. With `admin={false}` on the gig-view mount it prints FAIL "Sam, the admin, gets faces that open the panel" (`red-mutation-admin-false.log`). The mutation was reverted at once. It is ok after the fix.
- Second P2 (stale status). The case is "F3 a member on the gig view when the gig goes live loses Band status without a reload". Sam has the panel open on a planned gig, then Terry starts it. On `966f73b` it prints FAIL "timed out waiting for the open panel to shut once the gig is live" (`red-head.log`). The fix is in `src/gig-view.tsx`. The view now reads `gig/open` on open, every 15 s (`STATUS_EVERY_MS`) and when the screen shows again. Before, it read it once. `BandStatusFaces` already shuts an open panel when `opens` turns false. The case is ok after the fix.
- Third P2 (no EDGE-CASES row). `grep -inE "c23|band status" ../EDGE-CASES.md` found nothing (exit 1). Three rows now cover it. EC-09 is the c23-fix round's root cause, a missing feed treated as a permission input. EC-10 is a component mounted from two screens but checked at one. EC-11 is a screen that reads a gig's phase once. The grep finds all three.
- QUESTIONS.md item 2 says a member can keep the panel up to 15 s after the gig goes live.

After the fix, all on Windows with Edge:
- `npm run build` and `check:portable` exit 0.
- `check:ux-band-status` prints 12 ok, three runs in a row.
- `check:band-status` prints 74 ok, three runs in a row.
- `check:guest` prints 34 ok.

`check:gig` stops before its first case. esbuild cannot resolve `/C:/...`, which is the known Windows URL-pathname gap the brief names. The box's Deep verify runs it.

## The PR body for the next push (nits)

PR #107's head is still `5e02b90`, because this cook does not push. Replace two parts of the body when the branch goes up.

- In "The fix in this round", add this bullet. "The gig view's Band status follows the gig live. `gig/open` is read on open, every 15 s and when the screen shows again, so a member's panel shuts when the leader starts the gig, with no reload."
- Replace the first paragraph of "Checks" with this. "`check:band-status` has 74 cases. All 36 case names from `mls-int-20261113` are back as their own cases, and F1 to F5 are added. `check:ux-band-status` keeps all 10 cases from `mls-int-20261113` and adds two. One is F1 on the gig view (the admin's tap opens Band status, which fails with `admin={false}` on that mount). The other is F3 on the gig view (a gig going live shuts a member's panel with no reload). Its only other change is the repo root, now resolved with `fileURLToPath` and `join` so it runs on Windows (966f73b)."
