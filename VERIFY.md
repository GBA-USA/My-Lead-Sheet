VERDICT: FAIL

# Self-check: chord-grab-plan-fable at 828a005, tier deep

Goal of the cook: one build-ready plan at `docs/PLAN-chord-grab.md` and four copy-ready build briefs under `docs/cooks/`, for search-and-grab from chord sites. Docs only, nothing queued.

The diff adds five files and nothing else (`git diff --name-status b2b248a 828a005`). The base `b2b248a` is the tip of `origin/mls-int-20261113`. Build and `check:portable` already ran at this commit, and the diff changes no check or fixture, so no check was rerun.

One P2 fails the verdict. A Grab can reach two stop values that the plan gives no words. The rest of the plan holds up against the tree, and the hands-on run backs its central claim.

## Pass conditions from the brief

| Condition | Result | Evidence |
|---|---|---|
| Plan at `docs/PLAN-chord-grab.md`, briefs under `docs/cooks/` | Met | 5 files added |
| No app code, Worker, `package.json`, queue or dependency change | Met | diff file list; `queue.json` names only `chord-grab-plan-fable` |
| Build cooks not queued, no build branch | Met | `git branch -a --list "*chord-grab*"` shows only the plan branch |
| Written in sections | Met | Cook transcript: a 68-line skeleton Write, then 21 Edits of 1 to 103 lines, then one Write per brief |
| Few test fetches, no scraping code in the repo | Met | 17 requests to 7 sites, at most 3 for each. The probe and prototype lived in `/tmp`. `/tmp/chord-grab-probe-*` is deleted. `/tmp/chord-grab-proto/proto.mjs` remains and holds no page text. |
| Outside addresses in a data file, not `src/` | Met | `data/chord-sites.json` is designed. `worker/README.md` confirms `check:portable` skips `data/` |
| Offline after save | Met | Case A10 reloads with the network cut |
| Terms risk stated, DMCA agent not a license | Met | Section 5 |
| Shape of `PLAN-song-search-layers.md` | Met | Summary, measurements, changes, decisions, design sections, briefs with the six-line HANDOFF |
| Seven required sections | Met | Sections 1 to 7, plus section 8 "What stays unproven" |
| Each brief: HANDOFF, tests first, owned files and do-not-touch, checks, model | Met | The six HANDOFF lines of each standalone file equal the plan's block, compared line by line. All 14 existing `check:*` names in the brief lists exist in `package.json`. |
| Model picks per `MODEL-RULES.md` | Met | The Nov 18 t441u pick (Fable plans, Opus builds) and the Nov 23 escalation scope are quoted correctly |
| Inherited "the app never fetches chord pages" rule not copied | Met | It appears only as the rule the owner lifted |
| No secrets, no names or emails | Met | Grep for emails, 32-hex ids, `workers.dev`, `pages.dev`, owner names: none |

Repo facts the briefs rely on, each read in the tree: `readSession`, `readJsonObject`, `Refused`, `startApi`, `catalogSearcher`, `takePaste`, `NoWordsYet`, `addOwnSong`, `replaceOwnSong`, `Song.sourceNote` (drawn at `src/sheet.tsx:50`), `officialRuntimeSec`, `RP_NAME`, `APP_ORIGIN`, `PRIVACY_CONTACT`, `GOOGLE_ISSUER`, Worker type imports from `src/chat-model.ts`, `resolveJsonModule` in `worker/tsconfig.json`, `src/App.tsx` at 490 lines, one SVG icon in the manifest, `public/sw.js` passing non-GET through, 225.64 KB gzipped in the cook's own build log, and PR 116 as the open `cook/song-paste-autofill`.

## Hands-on run: the riskiest claim

The whole design rests on this claim: text the Worker sends goes through `readPaste` and `parseSheet` unchanged and keeps each chord over its syllable. The prototype counted chords but did not check positions (plan section 8 says so). I checked positions on made-up words.

Probe: `.verify-logs/self-check-deep/grab-shapes.mjs` (bundles the app's own `src/song-paste.ts` and `src/song-text.ts` with esbuild). Output: `.verify-logs/self-check-deep/grab-shapes.out`.

- Bracket text, which is the Chordie recipe's output (`[G]Paper boats on [C]Tuesday`): every chord lands on its word. Sections come out as "Verse 1" and "Chorus".
- Bracketed section names (`[Verse]`, `[Chorus]`) are read as headings, not as chords. Chords stay aligned. The headings come back uppercased as "VERSE 1" and "CHORUS". That is the reader's own normalizing, not a defect. It is the probe's one FAIL line, and the FAIL comes from my case-sensitive expectation.
- Column text, which is the `<pre>` recipes' output: every chord stays in its column over its word.
- `Intro G C G D` with no colon is dropped, as the plan says for E-Chords. `readPaste` reports it as `{"count":1,"what":"lines above the first section"}`, so the player is told.

So the claim "a grab needs no second parser" holds for the three shapes the recipes will send.

## Findings

### P2-1. Two stop values have no words, and one of them is reachable from the designed off switch

CLASS=stale-ui

`GrabStop` (plan section 1) has `"off"` and `"failed"`. The failure table ("What the player sees when something fails") covers `off` only at load time: "Grab is off on this server: Nothing. The Grab buttons are not drawn." `failed` has no row. Cases A3, A4 and A12 test only the table's rows, so `check:chord-grab` would pass with a blank status line.

`off` is reached after the buttons are drawn in two designed ways:
- The server passes its daily cap of 2,000 calls (section 2: "then refuses with `grab-off` until the next UTC day").
- The owner removes a site, or empties `GRAB_SITES`, and deploys. This is section 5 rule 5, and rule 7 says the owner does it the same day a site writes. The open app read `grab: true` from `/api/auth/config` before the deploy and keeps drawing **Grab**.

Smallest repro, on paper against the spec. Load the app with `/api/auth/config` answering `grab: true`. Make `/api/grab/find` answer 503 `{ "error": "grab-off" }`. Tap **Grab**. The editor opens with **Looking for chords…**. The state goes to `{ kind: "stopped", why: "off" }`, and the table gives it no words. A 500, or a reply the phone cannot read, gives `failed` with no words either.

Fix in the plan: add two rows. `off` mid-session: "Grab is resting for now. Find the chart on the web and paste it." Also hide the **Grab** buttons for the rest of the session. `failed`: "Something went wrong while grabbing. Try again.", with **Try again**. Then extend A4 with "a 503 `grab-off` gives `off`, a 500 gives `failed`", and A12 with both words.

### P3-1. D8's server cap is in a different unit from the one section 2 builds

CLASS=data-shape. D8 asks the owner to approve "2,000 requests to chord sites a day for the server". Section 2 builds "2,000 `find` and `page` calls a day". One `find` can send up to three site requests, so the cap the owner approves is not the cap that ships. Section 7's cost line ("a few thousand requests a day") matches section 2, not D8. Fix: state D8 in calls, or count site requests in `grab_use`.

### P3-2. Cook 2's copy-ready brief leaves out gate G1

CLASS=state-machine. Section 7's phase table says cook 2 waits for G1, and G1's last row can stop the feature. The summary table and the HANDOFF `DECIDED` and `NEEDS OWNER` lines of `docs/cooks/chord-grab-app.md` name only cook 1, PR 116 and D5 to D7. Someone who queues from the brief alone builds the screen before G1. Fix: add "and gate G1 passed" to the brief's `NEEDS OWNER` and to the "Waits for" cell of row 2.

### P3-3. A hint in the app brief rests on a false premise

CLASS=other. `docs/cooks/chord-grab-app.md` hint 2 (rated High) says the search box must not fetch `/api/auth/config` because of `check:song-search` case 2d, and says to "read whether Grab is on from the config the app already loads". Both parts are wrong:
- Case 2d logs only cross-origin calls. `scripts/check-song-search.ts:638` passes every same-origin fetch through. `openSite` serves `/api/*` on the page origin (`scripts/chrome.ts:54`).
- A caught 404 adds no page error, since `app.errors()` collects only `error` and `unhandledrejection`.
- A signed-in player's app never loads `/api/auth/config` today. The only reads are `usePreviewEntry` when signed out and the account sheet (`src/account.tsx:99`, `:214`).

A cook that follows the hint finds no config to pass down. Case A7 would catch it, at the cost of a round. Fix: "read `/api/auth/config` once after sign-in, which case 2d does not see, or add `grab` to the `/api/me` reply."

### P3-4. The probe's User-Agent was not the honest client the plan specifies

CLASS=other. The cook's curl probe sent `Mozilla/5.0 (compatible; lead-sheet-research/0.1)`. The plan calls this "a generic research client". Case W18 requires that the Worker's User-Agent "does not hold the word Mozilla". The site answers in the measurement table came from a browser-shaped User-Agent the build will never send, and "What was not measured" does not say so. G1 and cook 1's laptop live script re-measure with the real client, so the risk is contained. Fix: give the exact User-Agent in "The test fetches", and add "the honest User-Agent of D3 was not tried" under "What was not measured".

### P3-5. "The landed Origin rule already keeps other sites out" is not true for `/api/grab/`

CLASS=origin-host. In `worker/index.ts:63-64` the Origin check sits inside the `DIRECTORY_PATH` branch. The plan routes `/api/grab/` before that branch. Step 1 of `find` ("Check the Origin") and case W15 still require the check, so the build is safe. The sentence in section 2 "Routes" should say the new branch calls `fromApp` itself.

## Where the plan and CLAUDE.md differ

`CLAUDE.md` names `BAND_ROUTES`, merged into the Directory's `ROUTES`, as the Worker route pattern. The plan answers `/api/grab/*` in the Worker's entry with one Directory call for the session and the counts. Its change 5 gives the reason: a page fetch inside the single Directory object would make every account's request wait. I agree with the change. The owner should know it departs from the named pattern.

## Not findings, checked

- Signed-out, second account, offline and empty states each have a row or a case. Exception: P2-1.
- 360 px and 390 px are covered by case A16. Section 8 says nobody has seen the row at 360 px.
- A share wipes an unsaved draft, and an app unload during review loses edits. Both are stated as accepted limits.
- `check:privacy` and apostrophes: the two privacy sentences have none.
- The bulk-import seam on `SongStart` is real (`docs/PLAN-bulk-import.md:671` on `cook/bulk-import-plan-fable` also adds a start draft). The plan names it.

Nothing was committed, pushed or deployed by this self-check.

# Fix pass 1

Probe: `.verify-logs/fix1/plan-findings.mjs`, one case per finding, read from the plan and the four briefs. It printed 26 FAIL at 828a005 (`.verify-logs/fix1/before-828a005.out`) and 30 ok after the fix (`.verify-logs/fix1/after.out`). The four HANDOFF-equality cases passed both times. They guard the copy that P3-2 edits.

- P2-1. The failure table gains a `GrabStop` column, so each stop names its row. New rows: `off` mid-session ("Grab is resting for now. Find the chart on the web and paste it.", which hides every Grab button for the rest of the session) and `failed` ("Something went wrong while grabbing. Try again.", with **Try again**). A4 and A12 test both. The share table sends any other stop of a link Grab to these words.
- P3-1. D8 and decision 13 count `find` and `page` calls. D8 and section 7 give the site bound, at most 6,000 requests a day.
- P3-2. Row 2 of the summary and the app brief's `DECIDED` and `NEEDS OWNER` wait for gate G1, in the plan's copy and the standalone file.
- P3-3. Hint 2 of the app brief now says to read `/api/auth/config` once after sign-in, and that case 2d sees only cross-origin calls. The risk row in section 7 says the same.
- P3-4. "The test fetches" gives the exact User-Agent. "What was not measured" says the honest User-Agent of D3 was not tried.
- P3-5. The routes section, the `wrong-origin` row and the worker brief's hint say the `/api/grab/` branch calls `fromApp` itself.

`npm run check:portable` passed after the fix. Docs only, so no other check was rerun.
