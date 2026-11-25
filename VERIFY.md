VERDICT: PASS

# song-paste-autofill self-check at ad7c26e

Goal: after a smart paste, the editor fills title, artist, key, tempo, time signature and capo from the paste, or
offers a lookup's guesses when title or artist is still missing. The details section is folded by default. No song
saves without a title.

No P0, P1 or P2 is open. Seven P3s are listed below. Two of them are decisions for the owner.

Diff checked: `b2b248a..ad7c26e`. It touches `src/song-editor.tsx`, `src/song-editor.css`, `src/song-search.ts`,
`src/storage.ts`, one word in `src/song-search.tsx`, the three check scripts and two fixtures. Every run used headless
Edge on Windows. The box verify uses Chrome on Linux. No run reached the live catalog: each screen check installs a
catalog stub in the page before any app script. The tools and logs are in `.verify-logs/cook/`, which git ignores.

## Pass conditions from the brief

| Condition | Result | Evidence |
|---|---|---|
| A paste with title and artist lines, Key, Capo, BPM and Time fills those facts | met | `check:song-paste` 14b and 31 |
| A bare paste, lookup mocked, offers guesses and writes none until tapped | met | `check:song-paste` 32, 32b, 35, 36 |
| The lookup saves nothing by itself | met | 32 and 32b compare the stored library before and after |
| An offline or failed lookup leaves the form usable, fills no guess, throws nothing | met | `check:song-paste` 33, `check:song-search` 11d |
| Details folded by default on New song and Edit song, with a one-line summary | met, with one reading | `check:new-song` 7 (two cases), `check:song-paste` 31. See P3-1 |
| Details open and the Title field pointed to when the title is missing | met | 31, 32, 33 and `check:new-song` 7 |
| Save blocked with a clear message when the title is blank | met | 33 and `check:new-song` 7. Save says "Add a title" and puts the caret in the Title field |
| `addOwnSong` and `replaceOwnSong` refuse a title of spaces | met | `check:new-song` 7 and 7b |
| A song stored earlier with no title still loads | met | `check:new-song` 7, last assertion |
| Existing `check:song-paste`, `check:song-search`, `check:new-song` cases pass | met | 60, 59 and 36 ok at ad7c26e, 0 FAIL. The cases of b2b248a are unchanged |
| `npm run build` green | met | `final-build.log` |
| `check:one-copy`, `check:portable` | met | 18 ok. `check:portable` exit 0 |
| `check:chords` | flaky on this laptop, same on the base | P3-5 |

## What was run

| Run | Result |
|---|---|
| Tests-only snapshot of 95244a8 | The 17 new cases fail. The 52, 52 and 31 cases that were there before pass |
| ad7c26e | `check:song-search` 60 ok, `check:song-paste` 59 ok, `check:new-song` 36 ok, build green |
| Neighbour checks at ad7c26e | `one-copy`, `portable`, `screens`, `privacy`, `ux-theme-tokens`, `search`, `storage` pass |
| Mutation proof, `mutate.mjs` | 29 one-line source mutations, 29 killed. The first run killed 24 of 28. Cases 35, 36 and 7b were added for the four that lived |
| Probe, `probe.ts` | 22 of 22. Screenshots at 360 px and 390 px, a keyboard paste, Cancel during a lookup, Edit song with a title and no artist, a long title in the fold |

## P3-1. A blank New song starts with the details open

The brief says the details are closed by default and also open when the title is missing. A New song has no title
when it opens, so the fold starts open with the Title field marked. It folds once a paste gives a title, and on a
tap. Edit song starts folded. If the owner wants a blank New song folded too, the summary line needs words for a
song with no title, and `check:new-song` 7 pins the current reading.

## P3-2. The lookup sends one or two sung lines to the public catalog without a tap

The handoff decided this. After a paste with no title, the editor waits 600 ms and asks the catalog for the line the
chart sings most, then one more line at most. Each request holds one line. The editor shows "Looking up the title
and artist…" while it runs. The app's privacy copy does not mention the catalog at all, before or after this change.
A tap-first lookup is a small change in `look` in `src/song-editor.tsx` if the owner prefers one.

## P3-3. How often the lookup finds a real song is not measured

The brief forbids a live catalog run. The lookup reuses the query shape that `scripts/song-search-live.ts` measured for
a typed title. That shape lists a recording only when its title holds the asked words, and the lookup keeps a guess
only when the title is the asked words and no more. So it finds a song whose title is sung as a whole line, and no
song whose title is part of a longer line. Every case here stubs the catalog. One run of
`scripts/song-search-live.ts` with a sung line would give the real rate.

## P3-4. A song stored with no title before this change cannot be kept by a friend's phone

`writeOwnSong` now refuses a blank title for every caller, as the brief asks. A song saved before this change with a
title of spaces still loads and still sends. The phone that receives it says "This phone couldn't add ." The sender
fixes it by giving the song a title in Edit, which now requires one.

## P3-5. `check:chords` fails on this laptop at the same rate with and without the change

Its three FAIL lines are "a row paints past the chart: Fire Away @320px x1", the first view of the run. In one folder,
base and head source in turn, six runs each, the base failed 4 and the head failed 5, with identical lines
(`chords-compare.tsv`). Earlier separate runs read 1 of 3 on the base and 3 of 3 on the head. The change touches no
sheet code or sheet style. This is the Windows Edge flake earlier cooks recorded. The Linux box is the judge.

## P3-6. One word changed in a file the brief does not own

`src/song-search.tsx` gains `export` on `browserSearcher`. The editor's lookup must share the phone's one request a
second floor with the two search boxes, and that floor lives in that file.

## P3-7. "Looking up…" shows for one to three seconds and then goes when nothing is found

A lookup with no guess ends silently, so the line appears and leaves. It sits under the Preview heading, above the
chart, so nothing the player is reading above it moves.

## Fix round after the deep verify at 4f108e1

The deep verify ran the lookup against the live catalog and opened three P2s. This section replaces P3-3 above. Each
finding has a `check:song-search` case that fails at 4f108e1.

| Finding | Change | Case |
|---|---|---|
| P2-1. A guess names the wrong artist for most songs | `titleQuery` in `src/song-search.ts` asks for a title so that the catalog scores a recording higher when it was released as a single and in more countries. `songsOf` lists recordings with the same score most released first | 11i fails at 4f108e1. The lookup lines of `scripts/song-search-live.ts` hold the live rate |
| P2-2. A sung line with a contraction is asked without its apostrophe | `titleLines` returns the line as the chart sings it. `askedWords` is the one place that cleans a line for the catalog. It keeps apostrophes and asks a curly one as a straight one | 11j fails at 4f108e1 |
| P2-3. The 2 to 8 word rule has no test | Test only | 11k passes at 4f108e1 and fails there with `TITLE_WORDS = { min: 1, max: 80 }` |

### The live rate

One full run of `node --experimental-strip-types scripts/song-search-live.ts` on Nov 25, 2026. The log is
`.verify-logs/fix-pr116/after-live.log`.

| Lookup | Lookups | The expected artist is a guess | The expected artist is the first guess |
|---|---|---|---|
| The verify's 14 songs, the title as the only sung line | 14 | 14 | 12 |
| Six songs that were not used to shape the query | 6 | 6 | 6 |
| A typed title with no artist | 3 | 3 | 2 |

The deep verify measured 3 of 11 and 0 of 3 for the first and third rows at 4f108e1. The 10 search box lines of the
script still pass. Every guess for a line with a contraction spells the title with its apostrophe.

What bounds the rate. The catalog lists a title's recordings in score order, and the old query's score did not tell a
well-known recording from a cover, so the 15 rows that came back were 15 of several hundred in no useful order. The
catalog holds 2,828 recordings with "Stand by Me" in the title. The new query makes the catalog's score count how
widely a recording was released, so the 15 rows are the most widely released ones.

What else the number could be measuring.

- Catalog errors. Every lookup ended `found`. A busy reply is retried by the searcher.
- Run to run noise. Four lookups were run a second time and gave the same guesses.
- A query shaped to the test songs. The query was written once and first tried on five of the 14 songs. The most
  released rule for equal scores was chosen after seeing all 14. The six songs of the second row were chosen after
  both were fixed.
- An easy chart. Each chart sings the title as its only line, which is the best case. See the first open item below.

The cost is the size of the reply. The catalog sends every release of each recording, and the best-known recordings
have the most releases. The largest reply of the run was "Stand by Me" at 2,073 kB, which is 323 kB compressed and
took about 1 second here. The old query's reply for that title was 23 kB. On a slow phone network a lookup for a very
well-known song can pass the 8 second limit. The lookup then says it failed and shows Try again, as `check:song-paste`
33 covers.

### Still open after this round

- A chart whose most-sung line is not its title can still be offered a different song that has that line as its
  title. The deep verify saw this for 2 of 3 such charts. This round does not change it. The guess shows its title and
  artist, and nothing is written until the player taps it.
- "Sweet Caroline" and "Wagon Wheel" list the expected artist as the third guess, after two other well-known
  recordings.
- With an artist known and no title, the lookup still compares that artist with the 15 rows that come back. A
  little-known artist's recording of a common title is not among them.
- The search box query is unchanged. Its rows now list most released first when the catalog scores them the same.

### What was run at the fix

| Run | Result |
|---|---|
| `npm run build` | green |
| `check:song-search` | 63 ok, 0 FAIL. At 4f108e1 with the three new cases, 61 ok and 2 FAIL (11i, 11j) |
| `check:song-paste` | 59 ok, 0 FAIL |
| `check:new-song` | 36 ok, 0 FAIL |
| Six mutations of the fix, `.verify-logs/fix-pr116/mutate.mjs` | each fails 11i, 11j or 11k |

## Deep fix after the deep verify at e48e5e6

The verify found one P2. The last clause of `titleQuery`, `OR recording:"…"^=0`, makes every recording of the title
match. Without it, only a recording that was released as a single or in a place of `WIDE` is listed. No check and no
live line noticed when the clause was deleted. The query was already right, so this round changes tests only.

| Change | Proof |
|---|---|
| Case 11i reads the asked query the way the catalog reads it, `A AND (B OR C …)`. It asserts that an album track released only in Finland is listed, and so is a US single. A clause the check cannot read fails the case | With the clause deleted (mutation N1 of `.verify-logs/fix-deep/mutate.mjs`), 11i fails. At this head it passes |
| `SUNG` in `scripts/song-search-live.ts` adds "Hän tanssi kanssa enkeleiden" by Yö, a Finland-only album track | Live on Nov 25, 2026, Yö is guess 2 of 3 with the clause. With the clause deleted the lookup says none and the line FAILs |

| Run | Result |
|---|---|
| `check:song-search` | 63 ok, 0 FAIL |
| `mutate.mjs N0 N1 N5 N6` | N0 passes. N1 fails 11i. N5 and N6 (the weights 2 and 1) still pass. The live script is what holds the weights, as before |

---

Merged from origin/mls-int-20261113: the self-check of the chord-grab plan docs, kept whole. Its own first line read
"VERDICT: FAIL" at 828a005, before its Fix pass 1 below. The verdict of this PR is the first line of this file.

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
