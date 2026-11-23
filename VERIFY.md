# song-search fix pass 1 (on top of the self-check below)

The test cases landed first, in c2c0879, and the fix came after. Logs are in `.verify-logs/fix1/` (gitignored). Run on
the Windows laptop with Edge as `CHROME`.

| Finding | Case | At 1cedda1, or under its mutation | After |
|---|---|---|---|
| P2-2, empty print collides | 10, real Worker | head: `403 {"error":"private_copy"}` on Pat's own pick | ok. Bea's Private words still get 403 |
| P2-3 M1, shared floor | 7e | M1: My Songs' box asked 602.6 ms after the dialog's box | ok, at 1000 ms or more |
| P2-3 M2, double tap | 8c | M2: two songs added for two taps | ok, one song |
| P2-3 M3, No words yet | 1e | M3: still shown after a chart is saved in Edit | ok |

- Fix for P2-2, in `worker/room-library.ts`. `isBuiltIn` became `isCommon`, and the empty chart's print joins the
  built-in prints. The file is outside this cook's set, so QUESTIONS.md asks the owner. A named copy still goes
  through `mustAllow` first.
- `check:song-search`: 34 ok, 1 FAIL. The FAIL is 8a, the P2-1 test line, which is unchanged.
- The share guard's other checks were run from temp copies with `fileURLToPath` roots, because the scripts'
  `.pathname` roots break on Windows. Results: share-guard 13 ok, send-song 11 ok, band-library 14 ok,
  setlist-code 11 ok, one-copy all passed. check:codes failed once on "a stopped code is refused when scanned", then
  passed on the rerun and also passed with the Worker change set aside, so that failure was a flake.
- `check:portable` is red only on P1-1's two URLs, as before.
- Still open: P1-1 and P2-1 need the owner, as QUESTIONS.md items 1 and 2.

---

VERDICT: FAIL

# song-search in-cook self-check, tier deep, at 1cedda1

Goal: from My Songs or Add a song, a player searches the public song catalog and starts a new sheet with title, artist
and length filled in. They can also tap Find lyrics on the web to search in their own browser and paste the words in.

Scope: the diff da2ce97..1cedda1 (song-search.ts/.tsx/.css, library-lists.tsx, song-editor.tsx,
check-song-search.ts, package.json). Run on the Windows laptop with Edge as `CHROME`. Probes and logs are in
`.verify-logs/self-check/` (gitignored). The cook's build and named checks were not rerun, because the diff did not change them.
check:song-search ran three more times under mutation (below). Each run matched the head's result line for line.

Verdict: FAIL. Two owner seams the cook left open still block (P1-1, P2-1). This pass found two new P2s: catalog
picks collide by print in the share guard (P2-2), and three new guards have no test (P2-3).

## P1

**P1-1. check:portable is red on the two URLs the brief requires** (carried from the cook, still open). CLASS=origin-host.
`src/song-search.ts:7` `https://www.google.com/search?q=` and `:8` `https://musicbrainz.org/ws/2/recording` hit the
`literal-origin` rule. Repro: `node --experimental-strip-types scripts/check-portable.ts` prints
`2 hard-coded account, host, email or owner strings` (`.verify-logs/portable.log`). The fix is in an earlier check or in
Worker config. This cook owns neither. QUESTIONS.md item 2 has the patch. Needs an owner decision.

## P2

**P2-1. check:song-search 8a is red on a commit-1 test bug** (carried, still open). CLASS=other.
The last line of 8a waits for "Fire Away" in `.shell-title` or `document.body.innerText`. The title is drawn in
`.sheet-title .sheet-name`, and `.sheet-title` has `text-transform: uppercase` (`src/styles.css:1314`), so `innerText`
holds `FIRE AWAY`. Every product assertion before that line passed. Repro: `node --experimental-strip-types
scripts/check-song-search.ts` gives `FAIL 8a ... timed out waiting for the title on the page`, the same line in 4 of 4
runs today. QUESTIONS.md item 1 has the one-line patch. Needs an owner decision, because commit-1 tests are frozen.

**P2-2. Every catalog pick has the same chart print, so one Private copy blocks sending any of your own picks.**
CLASS=data-shape. A pick is the first own song that can have `body: []`. New song refuses an empty chart
(`sheetProblem`: "Add at least one section"). `printOf` (`worker/room-library.ts:382`) hashes only the body, so every
pick of every song by every player prints the same. `guardContent` (`:408`) then finds the player's own new pick
"held" as the friend's Private copy and refuses it. Rule 5 and repeat-mistake 1 in CLAUDE.md forbid deciding "same
item" by content. This feature makes the collision routine, where before it needed two identical charts.
Smallest repro, measured with a real local Worker (`.verify-logs/self-check/empty-print.ts`, about 1 minute):

| Step | Reply |
|---|---|
| A. Pat sends Cal Pat's own pick "Kitchen Floor", Public, before any copy | 200 |
| B. Bea sends Pat Bea's own pick "Fire Away", Private | 200 |
| C. Pat sends Cal a different pick of Pat's own, "Wagon Wheel", Public | **403 private_copy** |
| D. The same as C, Private | **403 private_copy** |
| E. Control: Pat sends Cal an own song with words, Public | 200 |

On the phone Pat reads "This was shared with you privately, so it can't be passed on." (`src/send-song.tsx:26`) about
a song Pat made. Band share-song and copy codes go through the same `guardContent`, so they should refuse the same way.
I inferred that from the code. Only send-song was measured. Pasting words clears it, since the print then changes. The
fix sits outside this cook's files. In the Worker, a print with no shown lines guards nothing, so treat it like a
built-in print. Or the phone keeps a pick from being sent until it has words. Needs an owner decision.

**P2-3. Three new guards have no test. Each mutation below leaves check:song-search exactly as it is at head.** CLASS=state-machine.
`.verify-logs/self-check/mutate.mjs` applies one mutation at a time to `src/song-search.tsx`, runs the check, then
restores the file. The tree was clean after. Each run gave exit 1 with only the known 8a line (`mutate.log`).

- M1. Drop `floor: PHONE_FLOOR`, so each box keeps its own floor. My Songs keeps its search box mounted under the New
  song dialog, so two searchers are live at once. Pass condition 7 says two searches close together send at most one
  request a second. The unit harness gives each searcher a private floor, and the screen cases wait 1.1 s before each
  search, so nothing tests two boxes.
- M2. Drop the double-tap guard `if (picked.current) return;`. 8a and 8b each tap once. A second tap before the hash
  change lands would add a second song (must-handle: no duplicates).
- M3. Show "No words yet" even when the song has words. 1c checks only that it shows on a fresh pick. Nothing checks
  that it leaves once the player pastes a chart. No other script names it (`grep` of `scripts/`).

Fix: add a check case per guard. Each one should fail under its mutation.

## Pass conditions

| # | Condition | Result |
|---|---|---|
| 1 | Find lyrics URL, encoded, fields that exist, plus lyrics | Holds. 1a, 1b, 1c (new sheet), 1d (editor). A plain `<a target=_blank rel="noopener noreferrer">`. |
| 2 | No lyrics fetch, nothing stored | Holds. 2a-2d. The only network step in the owned files is the recording search. |
| 3 | Recording search, fmt=json, User-Agent, rows show title, artist, year, m:ss | Holds, with one note. The User-Agent names `location.origin`, not the brief's literal preview host. CLAUDE.md rule 3 bans a hard-coded host, so CLAUDE.md and the brief disagree here. The code follows CLAUDE.md. Chrome drops a fetch User-Agent anyway (cook P3-1). |
| 4 | No results | Holds. 4, 4b. |
| 5 | Offline | Holds. 5a-5c, and Try again recovers. |
| 6 | API error or malformed reply | Holds. 6a-6d. |
| 7 | At most one request a second, 400-800 ms debounce | Holds for one box (7a-7d). The floor between two boxes is untested (P2-3 M1). |
| 8 | A pick calls addOwnSong and opens the new sheet prefilled | Code holds. 8b ok, 8a red on a test line (P2-1). The new empty-body shape breaks sending (P2-2). |
| 9 | 360 and 390 px, 44 px targets | Holds. 9a, 9b, 1d. Every target is 48 px or more. Cook screenshots: `reports/song-search-probe/`. |

## Wrong-but-passing read

- Stale state: hash changes close the editor (`App.tsx` `[hash]` effect), and My Songs unmounts off `#/songs`. So
  `picked`, the query and old rows reset when the player returns. A reply for a replaced query is dropped (6c).
- Signed out: the box mounts only beside + Add a song (case 0). NoWordsYet needs `madeHere`.
- Account switch: a pick is an ordinary own song in the current account's library. Backup stores raw strings, so an
  empty body survives backup and restore (`src/backup.ts`, no body check).
- Offline: checked at send time, with no request and no rows. Try again goes through the same floor.
- Learn this song on a words-less song: `learn-song.tsx` maps over an empty body, so there is no crash and no sections
  to fill (inferred from code, P3).

## P3, left as is

- P3-1. `plainWords` keeps the catalog's uppercase operators. A query of `NOT` or `AND` alone becomes an invalid search,
  and the player would read "The song list didn't answer" (inferred, not sent to the live catalog).
- P3-2. Once typed in, the catalog box looks the same as Search songs two rows above it at 360 px
  (`probe-results-360.png`). Only the placeholder tells them apart.
- P3-3. In New song, a pick drops any Key, BPM or Time signature the player already set (the box hides only on title,
  artist or chart). That is cook P3-4 extended.
- P3-4. The cook's `probe-song.png` shows the New song dialog, not the new sheet. 9b measures the sheet's link, so the
  missing picture is cosmetic.
