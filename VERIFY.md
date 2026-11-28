VERDICT: PASS
Nits:
P3 | CLASS=resilience | worker/room.ts:466 | "Asked" lives on the leader socket's attachment, as the brief chose. If the leader's socket drops and comes back, the new socket has not asked, so a player who joins after that blink is not prompted on joining until the leader taps Update now again. Prompts already shown are kept. Read from the code; no case covers a blink between the tap and a late join.
P3 | CLASS=resilience | worker/room.ts:479 | askedBefore honours an "asked" socket only when its player leads now. If an earlier leader leads again on the same socket, their old ask comes back into force for late joiners. At worst a phone that really is on another version gets one prompt it can put off. Read from the code.
P3 | CLASS=check-gap | scripts/check-update-now.ts:758 | U12 tests that the document does not scroll sideways. The strip clips its own overflow, so U12 did not see the version panel wrapping its note and rows into a second column off screen. The live run's screenshots showed it, and it was fixed in 5711cb9 (was P2). The case cannot be edited after commit 1; the fix was checked by eye in leader-update-now-{light,dark}.png.
P3 | CLASS=ui-rule | src/gig-check-in.css:159 | Reload was a word button; UI rule 1 asks for its universal icon. It is now icon-only, with the accessible name "Reload", in 361b533 (was P1 under the UI rules). The rule 3 and rule 4 readings are written in QUESTIONS.md.
P3 | CLASS=network | public/sw.js:6 | If the new index.html takes over 4 s, the service worker's navigation fallback can serve the cached old page after Update now. The player stays on the old version, their row still reads Needs the update, and a second tap tries again. Nothing is lost. sw.js is not this cook's to change.
P3 | CLASS=platform | scripts/check-offline.ts:1 | check:offline, check:gig, check:ux-gig-view and check:backup cannot run as-is on this Windows laptop: they build paths with URL.pathname, which gives C:\C:\. Path-patched temporary copies of all four passed; the Linux Deep verify runs the stock ones.

Checked and found sound:
- U1 to U14 green on the final head, three runs in a row; all 12 mutations turn their cases red.
- No reload without a tap: location.reload is called only from reloadOntoPublished (src/app-build.ts:42), which only Update now on the player's prompt and Reload on the leader's strip call. M9 proves U9 catches a reload on receipt.
- No stored data touched: the reload path writes no key. In U5 and the live run, localStorage is byte for byte equal, with a second account's data on the phone.
- No prompt from a non-leader: the Room reads the leader from the gig's own lineup record (worker/room.ts:463). A lineup member, the backup, a removed member and a guest are refused or reach no one (U6, M2).
- build.json is never cached: it is not precached, sw.js does no runtime caching (fromCache only falls through to fetch), and the phone fetches with cache no-store (M1 proves U4 catches a precached copy).
- The app still opens offline: the path-patched check:offline passed.
- 360 px light and dark: screenshots checked by eye after the fix.

# p2-song-info VERIFY.md from origin/mls-int-20261113 (kept verbatim for the merge into cook/p6-update-now)

VERDICT: PASS
Nits:
P3 | CLASS=other | src/scroll-timing.ts:587 | The P0 fix (pass 1) and the P2 fix (pass 2) sit in a file outside the brief's owned list, against CLAUDE.md "stay inside the files your brief owns". QUESTIONS.md names both for the owner. Every check that touches scroll-timing is green apart from known Windows causes (.verify-logs/fix-p0, .verify-logs/fix-p2/after).
P3 | CLASS=other | scripts/check-ux-metronome-sheet.ts:570 | The chord x assert moved after the y lines (same value, same 0.5 px). The reorder cannot change the verdict and is named in the report, but not in the brief.
P3 | CLASS=other | src/song-info.css:1 | `.sheet > .meta` changes to 0.84em/600, a visible type change the brief did not ask for.
P3 | CLASS=other | src/sheet.tsx:268 | No case fails without the FONT_SETTLE_FRAMES=60 rAF refit.
P3 | CLASS=other | src/song-info.tsx:84 | onPointerDownCapture stopPropagation hides a row tap from every ancestor pointerdown listener, not only auto-scroll's.
P3 | CLASS=stale-ui | src/sheet.tsx:45 | The same song twice in one setlist or gig shares the key info/<ref>, so Song info stays open when moving between the two entries.
P3 | CLASS=state-machine | src/song-info.tsx:18 | MOVING_MS 1000: an auto-scroll slower than about 1 px/s reads as at rest, so the open is not held.
P3 | CLASS=stale-ui | src/song-notes.tsx:63 | No check drives the strip's unmount report {0,false}. I15 leaves the sheet first.
P3 | CLASS=layout-width | src/song-info.tsx:75 | A band song with no fields: the row appears when the notes reply lands and the chart drops 44 px.
P3 | CLASS=other | src/song-info.tsx:68 | The gig look-ahead band-follow scroll is not traced through a toggle (the report names it).
P3 | PRE-EXISTING | CLASS=layout-width | scripts/check-ux-metronome-sheet.ts:570 | Windows Edge chord x reads 112.00 against the Linux pin 109.59, the same as on the untouched base.

Self-check fix pass 2. The one P2 and its test-gap P3 are closed; none left open at P0 to P2.
CLOSED | CLASS=state-machine | src/scroll-timing.ts:587 | The P2: opening Song info 1 s into a scroll from the top dropped the reading row 20.6 px (1280x800) and 27.7 px (390x844) on the next frame. Root cause: `runScroll` worked the path out from where the chart sits in the scroller, and the path's top-of-chart part changes shape, not only place, when the chart moves down. The hold in song-info.tsx was right. Fix: `runScroll` notes the chart's start as a run begins and moves the whole path by however far the chart has moved since. A run in which the chart never moves gets the same path. check:song-info I17 (song 10 from scrollTop 0, every frame of the 600 ms after a real tap within 2 px of an untouched scroll, 390x844 and 1280x800) failed at 8fb07a3 ("27.7 px from where it was 24 ms after the tap, an untouched scroll -1.0 px") and passes with the fix, three runs in a row (26 ok). The judge's probe now reads within 0.6 px of the untouched run at every sample to 6 s at all three widths (.verify-logs/fix-p2/probe-fixed.txt).
CLOSED | CLASS=other | scripts/check-song-info.ts:478 | The test-gap P3 (the hold was measured part-way down, inside the click task only) is covered by I17, which reads every frame after the tap from the top of the chart.
CLOSED | CLASS=other | scripts/check-ux-sheet-controls-save.ts:508 | The prior P0 is fixed. The Song info tap before the pill is gone, and the case failed at 53e7532 and passes at e4b6cf0. I16 (song 10, 1280x800, closed, top > 0 after the pill) failed at 53e7532 and passes now. Auto-scroll stays on after a toggle at every width (probe-head.txt, `on` true in all samples).

# mls-int-20261113 VERIFY.md at 7b60f1c (PR 127 p2-view-pill and earlier, kept verbatim for the merge into cook/p2-song-info)

VERDICT: PASS
Nits:
P3 | PRE-EXISTING | CLASS=other | spike/server/drill.mjs:190 | check:spike-server failed both CI attempts at f63b714 on "relayed-ping spread p95 <= 8 ms" (87.7, 56.91 ms) and once on "room counted 278 leader messages, leader sent 281". This PR does not touch spike/ or worker/. No reproducing case for the spread failure and no fix here, so it can redden CI again. Details below.
P3 | CLASS=layout-width | src/styles.css:683 | Not changed. Folded under 430 px, the pill parts are unequal (46, 57 and 72 px), and from 430 to 539 px the text is 11 px. A layout change is not a small fix here. Left for the owner.
P3 | CLASS=layout-width | src/styles.css:640 | Not changed. Folded at 360 px a long key reads "A (pra?". Same reason.
