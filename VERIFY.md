VERDICT: PASS
Nits:
P3 | CLASS=state-machine | src/stage-bar.tsx:190 | The reset runs on any InGig mount where `leading` is false, so a member who set a solo speed and then joins on stage is put back to 100% too. It matches the intent (an on-stage member has no speed control), but no case covers it. Round-1 P2 is fixed: before eedcd08 H8 gives a ratio of 1.299 / 1.282 (.verify-logs/fix1/h8b-before.log), after it about 1.0 in 3 of 3 runs (h8b-after-1..3.log).
P3 | CLASS=other | scripts/check-gig-corners.ts:1124 | 1fae611 widens H8's tolerance from 0.05 to 0.1. H8 is new on this branch, not on the base, so this is not a P0, and 0.1 still catches the 1.2x leak (it measured 1.28-1.30).
P3 | CLASS=other | scripts/check-gig-corners.ts:544 | C6 counts only `gig*` room kinds and reads Sam's rate from his gig state, not from a drawn sheet. The row's wording is still met (mutation C6a goes red, H6c catches other kinds). The owner question in QUESTIONS.md is still open.
P3 | CLASS=other | src/reading-row.ts:40 | `unheard` listens before the scrollTop write. A clamped write fires no event, so a real scroll event can be swallowed for up to two frames.
P3 | CLASS=layout-width | src/styles.css:1227 | The 80 px bottom room and the title cap's 16 px base are literals. At 360 px each pair is exactly a third of the screen wide, with no margin.
P3 | CLASS=other | src/gig-corners.tsx:27 | The speed pair's − / + sit right above the stage bar's bpm − / + with the same glyphs. Only the accessible names tell them apart.
P3 PRE-EXISTING | CLASS=other | src/App.tsx:295 | The gig top line still writes `~120 bpm` (rule 11). tempoText lives in src/storage.ts, outside this cook, and the owner question is open.
