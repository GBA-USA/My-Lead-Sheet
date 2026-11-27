VERDICT: PASS (self-check fix pass 1 of 2; the findings below are the self-check's, each with what this pass did)

# Self-check fix pass 1: each finding, its case, red before, green after

Each case was run on the head it found before any product change. A case that was green there was then run against
the mutant the finding names (or the closest one), with the file restored from HEAD after each run
(`.verify-logs/fix1-mutants.sh`, `fix1-mutants2.sh`, results in `fix1-mutants.txt` and `fix1-mutants2.txt`).

| Finding | Case | On the head it found | Mutant | Fix |
| --- | --- | --- | --- | --- |
| P2 K3 passes with `begin` deleted | K20: Bo's phone on the gig's screen sends `join-gig`, beats, and its strip is a followed one with no Join gig, within 5 s of the start | green | M1, `begin` line deleted: red, "follows the gig within 5 s … not within 4.8 s" | none needed |
| P2 band page join untested | K21: from `#/band/<id>`, today's planned gig once it starts, and a gig already live when the page opens; the hash stays | green | M2, `watchedGig` returns null: red | none needed |
| P2 three unanswered beats untested | K22: Lee's open room socket goes deaf (open, hears and sends nothing). No "Can't reach the band" at 5 s, the socket still open. The line shows by 15 s and the phone closed the socket itself. Then a new socket and fresh rows | green | M3b, never lost (`>= BEATS_UNANSWERED * 1000`): red. M3, `if (false)`, did not compile (TS6133) and proved nothing | none needed |
| P2 failed lineup Save untested | K23: offline Save shows `Can't reach the server…`, reads `gig/open` after, ticks go back to Ada's lineup (Mo and Ray), server unchanged, next Save works. Then a Save on a gig Ada just ended says "That gig is over." within 3 s | **red**: the refused Save on an ended gig closed the sheet with no word until the 15 s refresh | M4, `setTicks(back)` deleted: red | `src/gig-view.tsx`: Tonight's players hands its read of the gig to the same `take` the refresh uses, which says the gig is over |
| P2 sign-out, account switch | K24: Sign out everywhere (Kit, a throwaway account) turns Kit Not connected within 5 s. On one phone with no reload, Mo closes the gig's strip, signs out with the app's Sign out and Bo signs in. Bo sees Join gig and joins; the app's Sign out turns Bo Not connected within 5 s | **red**: Bo saw no Join gig, because `useLiveGig`'s closed gigs were not keyed by account (the watcher reads the same list) | M5b, `closeUser`'s `pushEveryRoster` disabled: **still green**. The Room's close handler pushes the roster for the closed socket too, so room.ts:126 is a second path, not the only one | `src/gig-live.tsx`: the closed and ended gigs reset when the account changes |
| (same) dismissed warning per account | K25: Lee dismisses the warning; Ada signs in on the same phone with no reload, leads (taken over from her other phone, as K8's Bo does) and sees the warning | green | M6, warning key `gigId` alone: red | none needed |
| P3 names fetch error swallowed | K27: `gig/open` fails while Lee starts; no See who; the line drops and comes back; See who comes and opens Band status | **red** | n/a | `src/gig-check-in.tsx`: the names are read again when the room line changes |
| P3 TonightSheet seeded once | K26: Ada adds Ray while Lee's sheet is open; Lee unticks Mo and saves; Ray stays on | **red**: Lee's Save dropped Ray, a lost update | n/a | `src/gig-check-in.tsx`: Save reads the gig and lays only this player's changed ticks on it |

Logs: `.verify-logs/fix1-new-head.log` (K20 to K25 on the found head), `fix1-k25-head.log`, `fix1-k23-k24-fixed.log`,
`fix1-k26-k27-head.log`, `fix1-k26-k27-fixed.log`, `fix1-mutant-*.log`, and the verify subset in `fix1-verify/`.

Commits: 9912685 (K20 to K25, K23 and K24 red), 0c1f5c0 (the two P2 fixes), bd11e02 (K26 and K27, red),
f8f6646 (the two P3 fixes). K1 to K19 are unchanged. The check's page script gained two test-only switches,
`window.__failPath` (one fetch path rejects as with no network) and a per-socket `__deaf`.

# Nits left, and why

- P3 `src/gig-live.tsx:289` a watching socket never beats. A watcher on a live gig lasts only until `begin` follows
  it on the same line, which sends `join-gig` and starts the beats (K20 asserts the beat). On a planned gig there is
  no roster to read Connected from. Left as is.
- P3 `worker/room.ts:522` roster-ask from a socket that is not a recipient still builds the roster: work only, no
  leak (K8 asserts nothing reaches it). Left as is.
- P3 UI rule 2, two doors to Band status: waits on the owner (QUESTIONS.md, top entry).
- P3 pre-existing laptop-only reds in check:mirror, check:gig, check:gig-plan, check:ux-gig-view, and the one
  check:api flake: unchanged by this pass (check:api was green here). check:chords joins that list, see below. The
  Linux Deep verify decides.

# What was checked (assume it is wrong, look for it)

- `npm run check:gig-check-in`, all 27 cases ok in one run (195 s, `.verify-logs/fix1-verify/gig-check-in.log`),
  quiet roster count 0 in 30 s and 1 after one join.
- Through `npm run verify --`, 15 checks (`.verify-logs/fix1-verify/summary.tsv`). Green: check:gig-check-in,
  check:band-status, check:ux-band-status, check:one-copy, check:portable, check:guest, check:links, check:stage,
  check:fanout, check:gig-plan-record, check:chordpro-phone, check:ux-theme-sweep, check:routes, check:api.
- check:chords red twice, both times "a row paints past the chart" for Fire Away at 320 px (5 rows). The same 3 FAIL lines
  appear on 96d0569, the head before this pass (`.verify-logs/fix1-chords-96d0569.log`), and on the merge base
  640f930, which has none of this cook's code (`fix1-chords-640f930.log`). This pass touched no sheet or layout file.
  Laptop-only, like check:mirror; the Linux Deep verify decides.
- Not checked here: the full `npm run verify` on Linux, and K25 with a real takeover from the shared phone itself.
  With the leader's phone signed out there is no band clock, and the earlier gig code does not send a takeover
  without one. K25 has Ada take over from a second socket instead.
