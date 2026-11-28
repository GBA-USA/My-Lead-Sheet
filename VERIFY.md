VERDICT: PASS
Nits:
P3 | CLASS=other | scripts/check-gig-check-in.ts:1310 | K22, K25 and K27 still use fixed pauses (5000, 1000, 1500/1000 ms) to assert that something is absent. They are slow but they fail when the thing shows up. Left as is. K28 and K29 add no fixed pause.
P3 | CLASS=other | src/gig-live.tsx:296 | A watching socket never beats. It lasts only until `begin` follows on the same line, which joins and beats (K20). Left as is.
P3 | CLASS=other | worker/room.ts:522 | A roster-ask from a gig socket that is not a recipient still builds the roster. This is work only, and nothing reaches the asker (K8). Left as is.
P3 | CLASS=owner | src/gig-check-in.tsx:137 | UI rule 2, two doors to Band status: waits on the owner (QUESTIONS.md, second entry).
P3 | PRE-EXISTING | CLASS=owner | src/leader-fanout.ts:212 | `tap` refuses while `bandNow()` is null, so Hold to take the lead does nothing on a phone with no band clock. Do-not-touch file. Asked in QUESTIONS.md (top entry). K28 gives Ada's phone band time from Lee's socket, as a leader's phone does.
P3 | PRE-EXISTING | CLASS=laptop-only | scripts | check:chords at 320 px (red on merge base 640f930 too), check:mirror, check:gig, check:gig-plan, check:ux-gig-view: laptop-only reds from earlier passes, not rerun here. Linux verify decides.

# Self-check fix pass 2: each finding, its case, the red run, the fix

| Finding | Case | Red on a3670a2 | Fix | Green |
| --- | --- | --- | --- | --- |
| P2 stale-ui: Ada takes the lead on her own phone, no warning, faces name Lee | K28: Ada, the admin, follows with band time from Lee's socket, holds Hold to take the lead; the warning comes within 8 s and her leader face reads "Ada …, leader" | **red**: "the warning on Ada's strip, now the leader's: not within 8 s" (.verify-logs/fix2/k28-red.log). With the warning wait left out, the faces step alone is red: "the leader's face reads \"Lee O'Brien, leader\"" (k28-faces-oldhead.log) | src/gig-live.tsx: the roster copy's leader follows every session change, not only a `gig-state` from the Room, which never echoes a change to its sender. The old `gig-state` branch is gone | k28-green.log, 13.4 s |
| P2 EDGE-CASES.md has no row for pass 1's root causes | grep of EDGE-CASES.md for a `check:gig-check-in` row naming K23, K24, K26 (and K28, K29) | **red**: none of the five | EC-24 (per-account memory, K24/K25), EC-25 (lost update on Save, K26), EC-26 (refused Save says why, K23), EC-27 (sender's cache misses its own change, K28), EC-28 (same-specificity shared class shrinks a target, K29) | all five rows found, no duplicate ids |
| P3 layout-width: warning and Tonight's players not run at 390 px | K29: at 360 and 390 px every button of Tonight's players and the warning is at least 44x44 and on screen, no sideways scroll | **red**: "Dismiss for tonight" draws at 40x40 at 360 px (k29-head.log). `.icon-btn` in styles.css loads later with the same specificity | src/gig-check-in.css: `.check-in-warning .check-in-dismiss`, 48 px with min-width | k29-green.log |

Commits: 6ac2671 (K28, K29, both red on a3670a2), 5e65dac (the two fixes). K1 to K27 are unchanged.

# What was checked

- `npm run verify -- check:gig-check-in check:band-status check:ux-band-status check:one-copy check:portable check:fanout check:stage check:guest`: build and all 8 passed on the first run, no retry (.verify-logs/fix2-verify/summary.tsv). check:gig-check-in ran 29 of 29 cases in 209 s.
- Not checked here: the full `npm run verify` on Linux.
