VERDICT: PASS
Nits:
P3 | CLASS=laptop-only | scripts/check-chords.ts | "a row paints past the chart" for Fire Away at 320 px (5 rows) is red twice in .verify-logs/fix1-verify/chords.log and .log.retry. The same 3 FAIL lines show on 96d0569, the head before this pass (.verify-logs/fix1-chords-96d0569.log), and on the merge base 640f930, which has none of this cook's code (.verify-logs/fix1-chords-640f930.log). This pass touched no sheet or layout file. The Linux Deep verify decides.
P3 | CLASS=laptop-only | scripts/check-mirror.ts, check-gig.ts, check-gig-plan.ts, check-ux-gig-view.ts | Pre-existing laptop-only reds, as listed by the earlier pass: unchanged by this pass and not rerun here. check:api, flaky once before, was green here.
P3 | CLASS=owner | src/leader-fanout.ts:212 | Hold to take the lead does nothing for a phone that joined after the leader's phone left: `tap` refuses while `bandNow()` is null. Inferred from the code and K25's first-draft dump (the button showed, the hold technique works in leaderStarts, no gig-op left). The file is on the brief's do-not-touch list. Asked in QUESTIONS.md (top entry). K25 takes the lead from a second socket instead, as K8 does.
P3 | CLASS=other | src/gig-live.tsx:296 | A watching socket never beats. It lasts on a live gig only until `begin` follows on the same line, which sends join-gig and starts the beats (K20 asserts the beat). A planned gig has no roster to read Connected from. Left as is.
P3 | CLASS=other | worker/room.ts:522 | roster-ask from a socket that is not a recipient still builds the roster: work only, nothing reaches it (K8). Left as is.
P3 | CLASS=owner | src/gig-check-in.tsx:137 | UI rule 2, two doors to Band status: waits on the owner (QUESTIONS.md, second entry).

# Self-check fix pass 1: each finding, its case, the head it found, the mutant, the fix

Every case was run on the head it found before any product change. A case that was green there was then run against a
mutant. All mutant results below were rerun on the final head 18ca094, each file restored from HEAD after its run
(.verify-logs/fix1-final.sh, results in fix1-final.txt; M2's first try timed out loading the app before any case ran,
and its rerun is fix1-final-mutant-M2-band-page-null-rerun.log).

| Finding | Case | Head it found | Mutant on 18ca094 | Fix |
| --- | --- | --- | --- | --- |
| P2 K3 passes with `begin` deleted | K20: Bo's phone on the gig's screen sends join-gig, beats, and its strip is a followed one with no Join gig, within 5 s of the start; the hash stays | green | M1, `begin` deleted: red | none needed |
| P2 band page join untested | K21: from `#/band/<id>`, today's planned gig once it starts, and a gig already live when the page opens; the hash stays | green | M2, `watchedGig` returns null: red | none needed |
| P2 three unanswered beats untested | K22: Lee's open room socket goes deaf. At 5 s there is no "Can't reach the band" and the socket is still open. By 15 s the line shows, the rows are old, and the phone closed the socket itself. Then a new socket and fresh rows | green | M3b, never lost: red. (M3, `if (false)`, did not compile and proved nothing) | none needed |
| P2 failed lineup Save untested | K23: offline Save says "Can't reach the server…", reads gig/open after, ticks back to Ada's lineup, server unchanged, next Save works; a Save on a gig Ada just ended says "That gig is over." within 3 s | **red**: the refused Save on an ended gig closed the sheet with no word until the 15 s refresh | M4, `setTicks(back)` deleted: red | src/gig-view.tsx: Tonight's players hands its read of the gig to the same `take` the refresh uses |
| P2 sign-out, account switch | K24: Sign out everywhere (Kit, a throwaway account) turns Kit Not connected within 5 s. On one phone with no reload, Mo closes the gig's strip, signs out with the app's Sign out, and Bo signs in. Bo sees Join gig and joins; the app's Sign out turns Bo Not connected within 5 s | **red**: Bo saw no Join gig, because useLiveGig's closed gigs were not keyed by account, and the watcher reads that list too | M5b, closeUser's pushEveryRoster disabled: **still green**. The Room's close handler pushes the roster for the closed socket too, so room.ts:126 is a second path, not the only one | src/gig-live.tsx: closed and ended gigs reset when the account changes |
| (same) dismissed warning per account | K25: Lee dismisses the warning; Ada signs in on the same phone with no reload, leads, and sees it | green | M6, warning key gigId alone: red | none needed |
| P3 names fetch error swallowed | K27: gig/open fails while Lee starts, so no See who; the line drops and comes back; See who comes and opens Band status | **red** | n/a | src/gig-check-in.tsx: the names are read again when the room line changes |
| P3 TonightSheet seeded once | K26: Ada adds Ray while Lee's sheet is open; Lee unticks Mo and saves; Ray stays on | **red**: Lee's Save dropped Ray, a lost update | n/a | src/gig-check-in.tsx: Save reads the gig and lays only this player's changed ticks on it |

Commits: 9912685 (K20 to K25, K23 and K24 red), 0c1f5c0 (the two P2 fixes), bd11e02 (K26 and K27, red), f8f6646 (the
two P3 fixes). K1 to K19 are unchanged. The check's page script gained two test-only switches: `window.__failPath`
(one fetch path rejects as with no network) and a per-socket `__deaf`. Every file changed is on the brief's owned list.
In src/gig-view.tsx the change is the Tonight's players mount's `onSaved` and the refresh sharing one `take`.

# What was checked (assume it is wrong, look for it)

- check:gig-check-in, all 27 cases ok on three full runs: .verify-logs/fix1-verify/gig-check-in.log (195 s),
  fix1-final-full-2.log, fix1-final-full-3.log. The quiet roster count was 0 in 30 s and 1 after one join.
- Through `npm run verify --`, green: check:band-status, check:ux-band-status, check:one-copy, check:portable,
  check:guest, check:links, check:stage, check:fanout, check:gig-plan-record, check:chordpro-phone,
  check:ux-theme-sweep, check:routes, check:api (.verify-logs/fix1-verify/summary.tsv). check:chords: see the first nit.
- Not checked here: the full `npm run verify` on Linux.
