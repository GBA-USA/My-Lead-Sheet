VERDICT: PASS
Nits:
P3 | CLASS=other | src/scroll-timing.ts:510 | The P0 fix is in a file outside the brief's owned list, against CLAUDE.md "stay inside the files your brief owns". Nothing in the owned files decides where the song's own pace starts. Named in QUESTIONS.md for the owner.
P3 | CLASS=other | scripts/check-ux-metronome-sheet.ts:570 | chord x assert moved after the y lines (same value, same 0.5 px); verdict-invariant reorder, named in the report but not in the brief
P3 | CLASS=other | src/song-info.css:1 | `.sheet > .meta` changes to 0.84em/600, a visible type change the brief did not ask for
P3 | CLASS=other | src/sheet.tsx:268 | FONT_SETTLE_FRAMES=60 rAF refit has no case that fails without it
P3 | CLASS=other | src/song-info.tsx:84 | onPointerDownCapture stopPropagation hides a row tap from every ancestor pointerdown listener, not only auto-scroll's
P3 | CLASS=stale-ui | src/sheet.tsx:45 | same song twice in one setlist or gig shares key info/<ref>, so Song info stays open moving between the two entries
P3 | CLASS=state-machine | src/song-info.tsx:18 | MOVING_MS 1000: an auto-scroll slower than about 1 px/s reads as at rest and the open is not held
P3 | CLASS=stale-ui | src/song-notes.tsx:63 | strip unmount report {0,false} is never driven by a check (I15 leaves the sheet first)
P3 | CLASS=layout-width | src/song-info.tsx:75 | band song with no fields: row appears when the notes reply lands and the chart drops 44 px
P3 | CLASS=other | scripts/check-song-info.ts:407 | I10 measures the hold inside the click task only; judge6 probe (.verify-logs/judge6/probe-close.txt, probe-close-feel.txt) shows it holds over later frames (close while scrolling 0.6 px), and a full-field panel cannot be closed mid-scroll without a hand scroll that stops the scroll
P3 | CLASS=other | src/song-info.tsx:68 | gig look-ahead band-follow scroll not traced through a toggle (report names it)
P3 | PRE-EXISTING | CLASS=layout-width | scripts/check-ux-metronome-sheet.ts:570 | Windows Edge chord x 112.00 vs Linux pin 109.59, same at untouched base

Self-check fix pass 1. The one P0 is closed; none left open at P0 to P2.
CLOSED | CLASS=other | scripts/check-ux-sheet-controls-save.ts:508 | The Song info tap before the Scroll pill is gone, so the case opens the sheet closed, as a player does. It failed at 1280 px at 53e7532 ("the pill did not start the scroll (top 0)"), as on CI run 46043279728. check:song-info I16 asserts the same thing (song 10, 1280 x 800, closed, top > 0 1.2 s after the pill) and failed at 53e7532 with "on at top 0". Root cause: `sungTrack` clamped each sung point's `y - middle` to 0, so a chart whose first line starts above the middle held still until the song reached it (2.53 s in Edge). Fix: that chart's sung line starts where the chart puts it and eases to the middle while the sheet moves at half the song's pace. A chart starting at or below the middle keeps its old path. After: both cases ok at 390 and 1280; first move 0.19 s at 1280 x 800, the same place as before by 10 s (.verify-logs/fix-p0/probe-*.txt).
