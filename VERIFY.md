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
