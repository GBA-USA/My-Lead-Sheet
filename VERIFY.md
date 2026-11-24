# song-search in-cook self-check fix pass 2 of 2 (on top of self-check 6 below)

Goal: close the self-check 6 findings that sit inside this cook's files. The only blocking finding is the owner's
keep-or-revert call on the `worker/room-library.ts` edit (85c9c5e), and a cook pass cannot clear it. No decision was
found in the prompt, QUESTIONS.md or `briefs/BRIEF-*song-search*`. So this pass took the two P3s that are cook work.
The cases landed first, in their own commit (a5974e3), then the fix (cf46dce). Logs are in `.verify-logs/fix2-p3/`
(gitignored). Run on the Windows laptop with Edge as `CHROME`.

| Finding | Case | At 89c201b with the case | Under the mutation, on the fix | After |
|---|---|---|---|---|
| P3-8, 6e holds only the fetch open, so a limit on the fetch alone would pass | 6f, a 200 whose body stalls after `{"recordings":[` | ok (the code was right, only untested) | M1, the limit bounds only `deps.fetch`: `FAIL 6f ... 10 s after the request left, the box says so` | ok |
| P3-9, a request that times out is never aborted | 6g, the hung request's signal is aborted at the limit, and a request that answers in time is not | `FAIL 6g ... the request carries an abort signal` (40 ok, 1 FAIL, `head.log`) | M2, report failed with no abort: `FAIL 6g ... the hung request is aborted` | ok |

- The fix is in `src/song-search.ts`. `ask` gives each request an `AbortController`, and the request gets its signal.
  When the 8 s limit fires, it reports `failed` first and then aborts. A reply that lands in time clears the limit,
  so nothing aborts it. In the browser the abort also ends a stalled body read.
- Each mutation fails only its own case (`mutate.log`). The tree was clean after.
- `check:song-search` 41 ok, "all ok", exit 0 (`after.log`). `npm run build` exit 0. `tsc --noEmit -p .` exit 0.
  `check:portable` passed ("tree clean").
- Self-check 6's probe was rerun on the rebuilt App (`probe/probe-360.log`, `probe/probe-390.log`). Steps A to G
  show the same states at both widths, with no page errors. Only the timestamps differ. Try again showed at 8101 ms
  (360) and is still 109x48, on top at its center.
- A copy of the probe also logs each request's signal (`probe/probe-abort-360.log`). Every request carried one. The
  stalled request 1 was aborted 8002 ms after it left. The slow reply was not aborted. The stall left behind when the
  player went to Setlists was aborted 8016 ms after it left.
- P3-10 (a real reply slower than 8 s reads as "didn't answer") is a product trade-off. This pass leaves it as is.
- Still open for the owner: keep or revert the `worker/room-library.ts` edit (85c9c5e, QUESTIONS.md top entry).

VERDICT: FAIL, on the owner seam only. No P0-P3 from self-check 6 is open inside this cook's files except P3-10.

---

VERDICT: FAIL

# song-search in-cook self-check 6, tier deep, at ddcfb87

Goal: from My Songs or Add a song, a player searches the public song catalog and starts a new sheet with title, artist
and length filled in, and can tap Find lyrics on the web to paste the words in. This pass verifies the diff
da2ce97..ddcfb87. Since self-check 5 (9864cf8), the changes are case 6e (8f8c6a7), the 8 s answer limit in
`src/song-search.ts` (e192409) and VERIFY.md (ddcfb87). Run on the Windows laptop with Edge as `CHROME`. The probe and
its logs are in `.verify-logs/self-check6/` (gitignored).

Verdict: FAIL, on the owner seam only. P2-7 is closed, measured at 360 and 390 px. No P0-P2 is open inside this cook's
owned files. The diff still edits `worker/room-library.ts` (85c9c5e), which the brief rejects ("edits outside the owned
files", "Do not touch ... worker files"). No keep-or-revert decision was found in the prompt, QUESTIONS.md or any brief.
A cook pass cannot clear this. Reverting the edit brings back P2-2, and the other fix needs `src/send-song.tsx` and the
share screens, which this cook does not own either.

## Owner seam (blocks the verdict, not a cook fix)

**The Worker edit has no owner decision.** CLASS=other. Repro: `git diff da2ce97..ddcfb87 --stat -- worker` shows
`worker/room-library.ts | 19 +-`. QUESTIONS.md's top entry asks to keep or revert it. `check:song-search` case 10
covers the edit both ways (Pat's own empty pick passes, and Bea's Private words are still refused). P3-6 below
(self-check 2) is part of the same decision.

## Checks

- `check:song-search` was not rerun. Fix pass 1 ran it at this code: 39 ok, "all ok", in `.verify-logs/fix-p27/final.log`,
  written at 19:21, after e192409 (19:20). 6e failed at 9864cf8 with the case in place (`fix-p27/head.log`).
- No other check's script or fixtures changed since self-check 5.

## Pass conditions at ddcfb87

The only product change since self-check 5 is `ask` in `src/song-search.ts:90-96`. It races the whole `read` (the fetch
and the body) against an 8 s limit set with `deps.setTimeout`, and the limit reports `failed`.

| # | Condition | Result |
|---|---|---|
| 1, 2 | Find lyrics URL, no lyrics fetch | Holds. Unchanged since self-check 5. |
| 3 | Recording search, fmt=json, User-Agent, rows | Holds. The User-Agent names `location.origin`, as before (CLAUDE.md rule 3 and the brief's literal host disagree, and the code follows CLAUDE.md). |
| 4 | No results | Holds (4, 4b). |
| 5 | Offline, a clear message, no crash, no fake rows | Holds. A refused fetch says offline (5a-5c). A hung request now says failed with Try again at 8 s (6e, probe B). |
| 6 | API error or malformed reply | Holds (6a-6d). A body that stalls after a 200 also ends in failed (probe B, untested, see P3-8). |
| 7 | At most one request a second, 400-800 ms debounce | Holds (7a-7e). Try again after the limit goes out at 8.7 s, well past the floor (probe F). |
| 8 | A pick goes through the existing add-own-song path and opens the sheet prefilled | Holds (8a-8f). Unchanged. |
| 9 | 360 and 390 px, 44 px targets | Holds. Try again is 109x48, on top at its center, with no sideways scroll at both widths (probe B, `failed-360.png`). |

## Hands-on run: a reply that stalls, then a slow reply

`.verify-logs/self-check6/probe.ts` runs the real App, built from this tree by `openSite`, in Edge with a stub `/api/me`
and a stub catalog. Request 1 sends a 200 with headers and the first bytes of a body that never ends. Request 2 answers
after 5 s. Request 3 stalls while the player leaves My Songs. Run with `PROBE_WIDTH=360` and `PROBE_WIDTH=390`. Both widths gave
the same result (`probe-360.log`, `probe-390.log`).

| Step | Result at 360 and 390 |
|---|---|
| A. 3 s after request 1 | `Searching…`, no Try again, 1 request |
| B. Wait for Try again | It shows 8066 ms (360) and 8018 ms (390) after request 1, with "The song list didn't answer. Try again in a moment." and 1 request |
| C. Two taps on Try again 80 ms apart, 3 s into the 5 s reply | `Searching…`, 2 requests. The first tap removes the button, so the second tap finds nothing to press |
| D. 6 s into the 5 s reply | the Wagon Wheel row shows. The limit does not cut off a slow reply that arrives in time |
| E. Type, request 3 stalls, go to Setlists, come back after 9 s | an empty box, no message, no rows, no stray report from the stalled request |
| F, G | 3 requests in all, no page errors |

## Wrong-but-passing read

- State machine: the limit's handle is set inside the Promise executor, which runs at once, so `.finally` always clears
  the right timer. After the race settles, a late reply from the abandoned `read` goes nowhere. A newer search or `stop`
  still drops a settled result through `mine === current` (6e, probe E).
- Stale UI: Try again calls `change(query)`, the same path as typing, so it clears the offer and the problem line.
- Offline and second phone: `online()` is read only when the request leaves, as before. The limit holds no stored
  state, so an account switch or a second phone does not affect it.
- Data loss: none. The limit only changes what the box shows.

## Untested new behavior

- None at P2. 6e pins the limit to between 3 s and 10 s, no second request by itself, the floor on Try again, and the
  dropped late reply.

## P3, new this pass

- P3-8. 6e holds the fetch promise itself open. A later change that limits only `deps.fetch` and leaves
  `response.json()` unlimited would keep 6e green and hang again on a stalled body. Probe B shows the head handles that
  case. Inferred, not run as a mutation.
- P3-9. A request that times out is never aborted, so its connection stays open until the network gives up. Each Try
  again on a hung network adds one more. Over HTTP/1.1, enough of them could queue a later request behind the open
  ones. The limit would still report `failed`, so the player is never stuck. Inferred.
- P3-10. A real reply slower than 8 s is dropped and reads as "didn't answer". Try again recovers. This is a product
  trade-off. Not measured against the live catalog.

---

# song-search in-cook self-check fix pass 1 of 2 (on top of self-check 5 below)

Goal: a catalog request that never answers must end in a clear message and Try again, not "Searching…" with no end.
The case landed first, in its own commit, then the fix. Logs are in `.verify-logs/fix-p27/` (gitignored). Run on the
Windows laptop with Edge as `CHROME`.

| Finding | Case | At 9864cf8 with the case | After |
|---|---|---|---|
| P2-7, a hung request stays in `searching` | 6e, fake clock, the first fetch never settles | `FAIL 6e ... 10 s after the request left, the box says so` (38 ok, 1 FAIL, `head.log`) | ok (39 ok, all ok, `after.log`) |

- 6e checks five things. The box still says searching 3 s after the request left. It says `failed` by 10 s. It sends
  no second request by itself. Try again goes out 1 s or more after the hung request and gets the catalog's answer.
  The hung request's late rows never show.
- The fix is in `src/song-search.ts`. `ask` races the fetch and the read of its body against an 8 s limit set with
  `deps.setTimeout`, and the limit reports `failed`. The existing "The song list didn't answer. Try again in a moment."
  line and Try again then show. The limit is cleared when the request settles. A later search or `stop` still drops
  the late reply through the `mine === current` test.
- Self-check 5's probe was rerun on the rebuilt App at 360 and 390 px (`probe-360.log`, `probe-390.log`). In step B,
  both widths show the message and Try again, with 1 request and no page errors. Steps C to E are unchanged, and the
  late reply is still dropped.
- `npm run build` exit 0. `check:portable` passed ("tree clean"). `tsc --noEmit -p .` exit 0.
- Still open for the owner: keep or revert the `worker/room-library.ts` edit (85c9c5e, QUESTIONS.md top entry).

VERDICT: FAIL, on owner seams only. No P0-P2 is open inside this cook's files.

---

# song-search in-cook self-check 5, tier deep, at 9864cf8

Goal: from My Songs or Add a song, a player searches the public song catalog and starts a new sheet with title, artist
and length filled in, and can tap Find lyrics on the web to paste the words in. This pass verifies the diff
da2ce97..9864cf8. Since self-check 4 (8c01032), the changes are corrective 3 (4ed7935, d164fac) and VERIFY.md
(9864cf8). Corrective 3 moved the two endpoints into `data/song-search.json` and changed 8a's last wait. The build and
named checks were not rerun, because corrective 3 ran them at this code (`check:portable` tree clean, `check:song-search`
38 ok, `.verify-logs/ci-fix3/`). `dist/` was built at 19:13, after 4ed7935. Run on the Windows laptop with Edge as
`CHROME`. The probe and its logs are in `.verify-logs/self-check5/` (gitignored).

Verdict: FAIL. P2-7 is still open at head and reproduces at 360 and 390 px. Corrective 3's brief limited that pass to
the two CI failures, so P2-7 was out of its scope. Corrective 3 cleared P1-1 and P2-1, and its brief is the owner's
approval for both. The Worker edit (85c9c5e) still has no keep-or-revert decision.

## P2

**P2-7 (carried, still open). A catalog request that never answers leaves "Searching…" on screen with no message and
no Try again.** CLASS=state-machine. `ask` in `src/song-search.ts:93` awaits `deps.fetch` with no time limit. A message
and Try again appear only when the fetch throws (offline) or the reply is bad (failed). If the request goes out but no
reply comes back, the box stays in `searching`. The brief's must-handle asks for "Offline and slow network ... (clear
message, no duplicates, a retry that respects the 1 req/sec floor)", and CLAUDE.md's must-handle says the same. No case
covers this. Cases 5a-5c reject the fetch, and 6a-6d answer it badly.
Smallest repro: `.verify-logs/self-check5/probe.ts`. It runs the real built App in Edge with a stub `/api/me` and a
catalog stub that holds the first request open. Run it as `PROBE_WIDTH=360` and as `PROBE_WIDTH=390`. Both widths gave
the same result (`probe-360.log`, `probe-390.log`).

| Step | Result at 360 and at 390 |
|---|---|
| A. Type "wagon wheel", wait 1.5 s | `Searching…`, no Try again, no rows, 1 request |
| B. Wait 20 s more | `Searching…`, no Try again, no rows, still 1 request (`hung-360.png`, `hung-390.png`) |
| C. Add a trailing space (the catalog now answers) | the row shows. That is the only way out, and nothing on screen says so |
| D. Retype "wagon wheel o" | the row shows. Request 3 went out 1517 ms after request 2, so the floor holds |
| E. Release the hung request 1 | its late reply is dropped, and D's rows stay |
| F. Page errors | none |

Fix inside the owned files: race the fetch against a limit set with `deps.setTimeout`, for example 8 s, and report
`failed` so the existing Try again shows. Add a unit case under the fake clock that holds the fetch open, expects
`failed` once the limit passes, and expects no second request before the floor. A later search or `stop` already drops
the late reply (step E).

## Pass conditions at 9864cf8

The only product-code change since self-check 3 is where `song-search.ts` gets its two URLs. Each condition below was
walked again against that change.

| # | Condition | Result |
|---|---|---|
| 1 | Find lyrics URL, `https://www.google.com/search?q=` plus the encoded query | Holds. The prefix now comes from `data/song-search.json`. 1a pins the full URL with its own literal, so a wrong value in the data file turns 1a red. |
| 2 | No lyrics fetch or store | Holds (2a-2d). The data file holds only the two endpoints. 2a's OWNED scan does not list it, but 1a and 3a pin both of its values. |
| 3 | Recording search, fmt=json, User-Agent, rows | Holds. 3a pins the endpoint. The probe's stub answers only `https://musicbrainz.org/ws/2/recording`, and the built App's requests reached it, so the JSON import works in the real bundle (measured). The brief's User-Agent names the literal preview host, but the code uses `location.origin`. CLAUDE.md rule 3 bans a hard-coded host, so the two disagree and the code follows CLAUDE.md. |
| 4 | No results | Holds (4, 4b). |
| 5 | Offline, a clear message, no crash, no fake rows | Holds when the fetch is refused (5a-5c). When the fetch hangs, the message never comes (P2-7). |
| 6 | API error or malformed reply | Holds (6a-6d). |
| 7 | At most one request a second, 400-800 ms debounce | Holds (7a-7e). Probe step D measured 1517 ms between requests. |
| 8 | A pick goes through the existing add-own-song path and opens the sheet prefilled | Holds. 8a now waits until `.sheet .sheet-name` reads exactly `Fire Away`. That wait is stricter than the old `innerText` one, and it is the selector `check:new-song` uses. It no longer reads `.shell-title`, which shows the app name. 8b-8f unchanged. |
| 9 | 360 and 390 px, 44 px targets | Holds. No layout changed since self-check 3, whose probe B measured both widths. The probe here shows the searching note unclipped at both widths. |

## Untested new behavior

- The data-file move has coverage. 1a, 3a and the page stubs use their own literals.
- 8a's new line checks behavior players can see (the sheet's title), and corrective 3 recorded it red before its fix.
- P2-7's hang path has no case. It is counted once, above.

## Wrong-but-passing read

- Stale state, account switch, signed out and data loss: no change since self-check 3. The URL move is a build-time
  constant and holds no state.
- Seam for L9: `song-search.ts` now has a bare JSON import. It loads through esbuild and Vite, which is how
  `check:song-search` (`scripts/check-song-search.ts:98`) and the app load it. A later check that imports it straight
  into `node --experimental-strip-types` would need an import attribute. `src/storage.ts` already has the same shape with
  `data/library.json`, so this is P3 (inferred, not run).

## Owner seams

- P1-1 (`check:portable`): closed. The brief `BRIEF-song-search-fix3.md` asked to move both origins out of `src/`
  without weakening `check-portable.ts`. The data-file import does that, and the layer plan's brief calls it "the way
  song-search does". `check-portable.ts` is unchanged in this diff.
- P2-1 (8a): closed. The fix3 brief allowed fixing the test ("fix the real cause (app or test)"). The edit tightens the
  wait and does not weaken it.
- Still open: keep or revert the `worker/room-library.ts` edit (85c9c5e, QUESTIONS.md top entry). It is outside the
  owned files. `check:song-search` case 10 covers it. No decision was found in the prompt, QUESTIONS.md or the briefs.
- The brief's standing rule sends song-search to Fable on any further failing pass. P2-7 is a self-check finding, not
  a failed check, so whether the rule applies is the runner's call.

---

# song-search corrective 3: the two CI deep verify failures (run 45288550775)

Goal: clear the only two red checks in CI run 45288550775 and leave the rest of song-search as it is. These close
P1-1 and P2-1 below. P2-7 (a hung catalog request) is still open, because this pass covers only the two CI failures.

- **check:portable** (P1-1). Cause: `src/song-search.ts` held the web search URL and the catalog URL as literals, and
  `literal-origin` bans every `https://` in `src/`. Fix: the two endpoints moved to `data/song-search.json`, and
  `src/song-search.ts` imports them at build time. `src/storage.ts` already reads `data/library.json` the same way.
  `check-portable.ts` is unchanged. `check-song-search.ts` still pins both URLs with its own literals (1a, 3a, 2b,
  the page stub), so a wrong value in the data file turns those cases red.
- **check:song-search 8a** (P2-1). Cause: the last line of 8a waited for "Fire Away" in `.shell-title` or
  `document.body.innerText`. `.shell-title` shows the app name on a song page. `.sheet-title` is
  `text-transform: uppercase`, so `innerText` holds `FIRE AWAY` in Chrome on Linux and in Edge on Windows. The app was
  right and the test read the wrong element. Fix: 8a now waits until `.sheet .sheet-name` has the exact text
  `Fire Away`, the selector `check:new-song` uses. The timeout is unchanged.

Run on the Windows laptop with Edge as `CHROME`. Logs are in `.verify-logs/ci-fix3/` (gitignored).
- `npm run build` exit 0.
- `node --experimental-strip-types scripts/check-portable.ts` passed: "tree clean".
- `check:song-search` 38 ok, "all ok", exit 0. At 8c01032 it failed 8a in 4 of 4 local runs and on both CI tries.

# song-search in-cook self-check 4, tier deep, at 8c01032

Goal: from My Songs or Add a song, a player searches the public song catalog and starts a new sheet with title, artist
and length filled in, and can tap Find lyrics on the web to paste the words in. This pass verifies the diff
da2ce97..8c01032. Since self-check 3 (ab03d9a) only case 8f (4af7ec2) and VERIFY.md changed. No product code changed.
The build and named checks were not rerun, because fix pass 3 ran them at this code. Run on the Windows laptop with Edge
as `CHROME`. The probe and its log are in `.verify-logs/self-check4/` (gitignored).

Verdict: FAIL. There is one new P2 in this cook's own files. A catalog reply that never comes leaves "Searching…" on
screen with no message and no Try again (P2-7, measured). The owner seams are still open: P1-1, P2-1, and the
keep-or-revert on the Worker edit. No owner decision was found in the prompt, in QUESTIONS.md or in the briefs.

## P2

**P2-7. A hung catalog request shows "Searching…" with no end and no retry.** CLASS=state-machine. `ask` in
`src/song-search.ts:91` awaits `deps.fetch` with no time limit. Only a thrown fetch (offline) or a bad reply (failed)
brings up a message and Try again. With signal but no answer, which is common on a stage or in a basement, the box stays
in `searching`. The brief's must-handle says "Offline and slow network wherever the feature talks to ... MusicBrainz
(clear message, no duplicates, a retry that respects the 1 req/sec floor)". CLAUDE.md's must-handle says the same. No
case covers it: 5a-5c reject the fetch, and 6a-6d answer it badly. The only escape is to edit the box. A trailing space
is enough, but nothing on screen says so. This is the same class as c21c's gig/open with no timeout.
Smallest repro (`.verify-logs/self-check4/probe.ts`, real built App in Edge at 360 px, stub `/api/me`, a catalog stub
that holds the first request open). See `probe.log`.

| Step | Result |
|---|---|
| A. Type "wagon wheel", 1.5 s later | `Searching…`, no Try again, no rows, 1 request |
| B. 30 s more | `Searching…`, no Try again, no rows, still 1 request (`hung-360.png`) |
| C. Add a trailing space (the catalog now answers) | the row shows, request 2 sent 31.6 s after the first |
| D. Retype "wagon wheel o" | the row shows, request 3 sent 1518 ms after request 2 (the floor holds) |
| E. Release the hung request 1 | its late reply is dropped, and the rows stay D's |
| F. Page errors | none |

Fix inside the owned files: race the fetch against a limit taken from `deps.setTimeout`, for example 8 s, and report
`failed` (or a slow-network line) so the existing Try again shows. Then add a unit case under the fake clock that
holds the fetch open and expects `failed` after the limit, with no second request before the floor. The hang is cleared
by a later search or by `stop`, so the late reply stays dropped, as E shows.

## Pass conditions at 8c01032

Product code is the same as at ab03d9a, so conditions 1 to 9 stand as self-check 3 and fix pass 3 walked them.

| # | Condition | Result |
|---|---|---|
| 5 | Offline, a clear message, no crash, no fake rows | Holds for a refused fetch (5a-5c). A hung fetch never reaches the message (P2-7). |
| 8 | A pick goes through the existing add-own-song path and opens the sheet prefilled | Holds in both flows, now tested in both. 8f is proven by fix pass 3's mutation E1 (`fix3/mutate.log`: 8f FAIL under `songs={[]}`, ok at head). 8a is still red on its test line (P2-1). |
| others | | Unchanged since self-check 3. |

## Wrong-but-passing read

- Data shape: a pick writes `officialRuntimeSec` on the song itself. Storage validates it (`storage.ts:106`), and the
  inbox send path keeps it (`worker/directory-inbox.ts:108`). So the length survives a send and a backup.
- Stale state, account switch and data loss: no change since self-check 3. `asking` clears on typing and unmount. The
  guard reads the current account's `library.songs`.
- 360 and 390: no layout changed since self-check 3, whose probe B measured the offer at both widths.
- `songYouHave` matches title and artist. This is New song's own guard reused as a prompt to open the held song. It
  decides nothing about sharing or privacy, so CLAUDE.md rule 5 does not apply.

## Owner seams, still open

- P1-1, `check:portable` red on the two URLs the brief requires (QUESTIONS.md item 2).
- P2-1, `check:song-search` 8a red on a commit-1 test line (QUESTIONS.md item 1).
- Keep or revert the `worker/room-library.ts` edit, 85c9c5e (QUESTIONS.md top entry).
- The brief's standing rule sends song-search to Fable on any further failing pass. P2-7 is a self-check finding, not a
  failing check. Whether it triggers that rule is the runner's call.

---

# song-search fix pass 3 (on top of self-check 3 below)

This pass changes only the check. The code was already right at ab03d9a, and the gap was a missing test. Logs are in
`.verify-logs/fix3/` (gitignored). Run on the Windows laptop with Edge as `CHROME`.

| Finding | Case | At ab03d9a with the case | Under the mutation | After |
|---|---|---|---|---|
| P2-6, New song's held-song guard untested | 8f, a pick of the built-in Fire Away / Chris Stapleton through `DIALOG_BOX` | ok (the code holds) | E1, `<SongSearch songs={[]} />` in `song-editor.tsx`: `FAIL 8f ... the tap stays in Add a song` | ok |

- 8f opens + Add a song and searches in the dialog's own box. It taps the held row and checks four things. The hash
  stays `#/songs`. Nothing is added. The dialog says "You already have Fire Away". Open goes to the held song's href,
  the dialog closes, and still nothing is added. Add anyway in the dialog was probed by hand in self-check 3 (step E).
  Its code path is the same `pick(song, true)` that 8d covers.
- `check:song-search` at head with 8f: 37 ok, 1 FAIL (`head.log`). Under E1: 8a and 8f FAIL (`mutate.log`). The tree
  was clean after. The 8a line is P2-1's test line and has not changed.
- P3-7 (offer inset and label alignment inside the result box) is cosmetic and not fixed here.
- Still open for the owner: P1-1, P2-1, and the keep-or-revert on the Worker edit (QUESTIONS.md).

VERDICT: FAIL, on owner seams only. No P0-P2 is open inside this cook's files.

---

VERDICT: FAIL

# song-search in-cook self-check 3, tier deep, at ab03d9a

Goal: from My Songs or Add a song, a player searches the public song catalog and starts a new sheet with title, artist
and length filled in, and can tap Find lyrics on the web to paste the words in. This pass verifies the diff
da2ce97..ab03d9a, mostly fix pass 2 (9c77321..ab03d9a: `song-search.tsx`, one line each in `library-lists.tsx` and
`song-editor.tsx`, cases 8c to 8e). The build and named checks were not rerun, because fix pass 2 already ran them at
this code (ab03d9a changes only VERIFY.md). `check:song-search` ran once more, under one mutation. Run on the Windows
laptop with Edge as `CHROME`. The probe, mutation and logs are in `.verify-logs/self-check3/` (gitignored).

Verdict: FAIL. One new P2 in this cook's files: New song's catalog box now asks "You already have" before a pick, but no
case tests that box (P2-6, measured by mutation). The code itself is right there (probe below). The owner seams are
still open: P1-1, P2-1, and keep-or-revert on the Worker edit. No owner decision was found in QUESTIONS.md or the briefs.

## P2

**P2-6. The held-song guard in New song's catalog box is untested.** CLASS=state-machine. Fix pass 2 passes `songs` into
both mounts. Case 8d drives only the My Songs box (`BOX`). No case picks a held song through `DIALOG_BOX`, so the
`song-editor.tsx:142` wiring can break without any check noticing. This is a different gap from P2-4, which 8d now covers
for My Songs.
Smallest repro (`.verify-logs/self-check3/mutate.mjs`, `mutate.log`): in `src/song-editor.tsx` change
`<SongSearch songs={songs} />` to `<SongSearch songs={[]} />`, then run `check:song-search`. It prints only
`FAIL 8a ... timed out waiting for the title on the page`, the same known line as at head. The tree was clean after.
With that mutation, a New song pick of Fire Away / Chris Stapleton adds an empty duplicate with no warning, which is
P2-4 again in the other flow.
Fix: one screen case like 8d through `DIALOG_BOX`. It should fail under this mutation.

## Pass conditions at ab03d9a

Conditions 1 to 7 and 9 were walked in self-check 2 at the same code for those paths. Fix pass 2 touched only the pick.

| # | Condition | Result |
|---|---|---|
| 8 | A pick goes through the existing add-own-song path and opens the sheet prefilled | Holds in both flows. A pick now asks `songYouHave` first, the same as Save. My Songs: 8d and 8e. New song: probe below, untested (P2-6). 8a is still red on its test line (P2-1). |
| 9 | 360 and 390 px, 44 px targets | The new offer holds. Open is 71x44 and Add anyway 123x44 at both widths, inside the dialog and the result box, on top at their centers, with no sideways scroll (probe B). |

## Hands-on run: a held-song pick inside New song

`.verify-logs/self-check3/probe.ts` ran the real built App in Edge, with a stub `/api/me` and a stub catalog reply with
two recordings: Fire Away / Chris Stapleton (held, built-in) and a long live title (not held). Results are in `probe.log`.

| Step | Result |
|---|---|
| A. Before | Fire Away held at `#/song/1`, 15 songs stored |
| B. New song, search, tap the held row, at 360 and 390 | "You already have Fire Away · Open it?" under the row, hash stays `#/songs`, still 15 |
| C. Open | `#/song/1`, the dialog closes, still 15 |
| D. Type again | the offer clears |
| E. Tap, then Add anyway twice | `#/song/17`, the dialog closes, 16 (one copy), No words yet shown |
| F. Tap the row nobody holds | opens at once, `#/song/18`, 17 |
| G. Page errors | none |

Screenshots: `dialog-offer-360.png`, `dialog-offer-390.png`.

## Wrong-but-passing read

- Stale state: `asking` clears on any typing and on unmount. The dialog closes on Open and on a pick, through the hash
  effect (probe C and E). Both mounts get `library.songs` (`App.tsx:413`, `song-editor.tsx:52`), the list Save checks, so
  a song added a moment ago counts on the next pick with no reload.
- Account switch: `songs` is the current account's library, so the offer can only name a song this account holds.
- Offline: the guard reads local songs only. A held pick asks the same way offline.
- Data loss: none found. Open writes nothing, and the add-failed path is covered by 8e.

## P3, new this pass

- P3-7. Inside the result box, the offer line has no inset, so "You already have" touches the box's left border. Open's
  label also sits at the top of its 44 px box while Add anyway's is centered, so the two labels do not line up. At 390 px,
  Open wraps up beside the line and Add anyway drops below it (`dialog-offer-*.png`). The cause is that `.you-have-it`
  and `.account-secondary` come from `search.css` and `account.css`, and `song-search.css` adds no rule for them inside
  `.song-search-results`. Usable and legible, so this is cosmetic. Whether Save's own offer has the same label offset is
  inferred, not measured.

---

# song-search fix pass 2 (on top of self-check 2 below)

The cases landed first, in their own commit, then the fix. Logs are in `.verify-logs/fix2/` (gitignored). Run on the
Windows laptop with Edge as `CHROME`.

| Finding | Case | At 9c77321 with the case, or under its mutation | After |
|---|---|---|---|
| P2-4, a pick skips "You already have" | 8d, a pick of the built-in Fire Away / Chris Stapleton | head: `FAIL 8d ... the tap stays on My Songs` (the tap added a copy and opened it) | ok |
| P2-5, add-failed untested | 8e, `Storage.prototype.setItem` throws for the library key | holds at head (the code was right, only untested). N2, delete the `id === null` line: `FAIL 8e ... the page stays on My Songs` | ok |

- The fix is in `src/song-search.tsx`. `SongSearch` takes the `songs` its mount already holds: My Songs' list, or New
  song's `songs`, the same list `save` checks. `pick` asks `songYouHave` first. A held song shows `YouHaveIt` under
  the tapped row, with Open going to the held song and Add anyway adding one copy. Typing again clears the offer.
  `library-lists.tsx` and `song-editor.tsx` each pass `songs` in, one line each.
- 8d also checks that Open and Add anyway are 44 px or more at 360 px, that Open adds nothing, and that a double tap of
  Add anyway adds one song. 8e also checks that a later pick works once the phone can write again.
- 8c now picks a song no one holds ("Wagon Wheel" through a per-case stub reply), since after the fix 8a's pick makes
  the old row 0 a held song.
- Mutations (`.verify-logs/fix2/mutate.mjs`, `mutate.log`, one at a time, tree restored after). Each fails its case,
  plus only the known 8a line: N1 no guard on a pick (8d), N2 no add-failed line (8e), N3 Add anyway asks again (8d),
  M1 no shared floor (7e), M2 no double-tap guard (8c and 8d), M3 No words yet with words (1e).
- `npm run build` exit 0. `check:song-search` is 36 ok and 1 FAIL. The FAIL is 8a, P2-1's test line, unchanged.
  At head with the new cases it was 35 ok, 2 FAIL (8a, 8d). `check:new-song` passed. `check:one-copy` and
  `check:screens` crash on Windows at their `.pathname` root before testing anything. From temp copies with a
  `fileURLToPath` root, both passed (one-copy "all passed", screens "16 routes").
- Still open for the owner: P1-1, P2-1, and the keep-or-revert on the Worker edit (QUESTIONS.md). P3-5 (`lengthText`
  copies `formatRuntime`) needs a file outside this cook's set.

VERDICT: FAIL, on owner seams only. No P0-P2 is open inside this cook's files.

---

VERDICT: FAIL

# song-search in-cook self-check 2, tier deep, at 9c77321

Goal: from My Songs or Add a song, a player searches the public song catalog and starts a new sheet with title, artist
and length filled in, and can tap Find lyrics on the web to paste the words in. This pass verifies the diff
da2ce97..9c77321 only. Code last changed at 85c9c5e, so the build and named checks were not rerun (the resume rerun
below holds at this tree's code). Run on the Windows laptop with Edge as `CHROME`. The probe and its log are in
`.verify-logs/self-check2/` (gitignored).

Verdict: FAIL. Two new P2s in this cook's own files: a catalog pick skips the "You already have" guard that New song's
Save runs (P2-4, measured), and the pick's add-failed path has no test (P2-5). The two owner seams are still open
(P1-1 and P2-1 below, QUESTIONS.md items 1 and 2), and so is the owner's keep-or-revert on the Worker edit.

## P2

**P2-4. A catalog pick adds a duplicate blank song with no warning, even when the player already holds that song.**
CLASS=state-machine. `pick` in `src/song-search.tsx:53` calls `addOwnSong` directly. New song's `save`
(`src/song-editor.tsx:114`) asks `songYouHave` first and offers "You already have … · Open it?". The brief says a pick
goes through "the existing add-own-song path", and that path includes this guard. The built-in library ships
"Fire Away / Chris Stapleton", which the catalog returns under the same title and artist, so a player who searches the
catalog for a song they hold gets an empty sheet beside their full chart. Each later pick adds another one. No case
covers it: 8a, 8b and 8c search for "Pat Bass" songs that no library holds.
Hands-on repro (`.verify-logs/self-check2/probe.ts`, real built App in Edge at 360 px, stub `/api/me` and a stub catalog
reply of one recording, "Fire Away" by Chris Stapleton, 3:52), `probe.log`:

| Step | Result |
|---|---|
| A. My Songs before | 1 row: Fire Away / Chris Stapleton, A major ~116 bpm (built-in) |
| B. New song, Title Fire Away, Artist Chris Stapleton, a chart, Save | "You already have Fire Away · Open it?" |
| C1. My Songs, Find a song to add "fire away", tap the row | no warning, opens `#/song/17`, No words yet |
| C2. Back to My Songs, the same again | no warning, opens `#/song/18`, No words yet |
| D. My Songs after | 3 rows of Fire Away / Chris Stapleton, two of them C major, Tempo —, empty |

Fix inside the owned files: check `songYouHave` on the pick and show `YouHaveIt` (Open it, or add anyway), the same as
`save`. Add a screen case that picks a song the library holds and fails at this head.
C2 also shows that `picked` does not go stale. My Songs unmounts on `#/song/<id>`, so the second pick works.

**P2-5. The pick's add-failed path is new and untested.** CLASS=other. `src/song-search.tsx:56` shows "This phone
couldn't add the song. Free some space and try again." when `addOwnSong` returns null (storage full or refused). No
script holds that text, and no case makes the write fail (`grep -rln "couldn't add" scripts/` is empty). p6's own
add-failed message is tested in `check:new-song`, so this was the precedent. Smallest repro, by reading the code: delete
line 56, and `id` null reaches `songHref(null)`, which opens `#/song/null` with no song saved. check:song-search does
not exercise that line, so its result cannot change. I did not run that mutation. Fix: one screen case that fills or
stubs `localStorage.setItem` to throw, taps a row, and expects the message, no new song and the page still on My Songs.

## Pass conditions, walked again at 9c77321

| # | Condition | Result |
|---|---|---|
| 1 | Find lyrics URL | Holds (1a-1d). A plain new-tab link with no referrer. |
| 2 | No lyrics fetch or store | Holds (2a-2d). |
| 3 | Recording search, fmt=json, User-Agent, rows | Holds. The User-Agent names `location.origin` and not the brief's literal preview host. CLAUDE.md rule 3 and the brief disagree here, and the code follows CLAUDE.md. |
| 4 | No results | Holds (4, 4b). |
| 5 | Offline | Holds (5a-5c). |
| 6 | API error or malformed | Holds (6a-6d). |
| 7 | One request a second, 400-800 ms debounce | Holds (7a-7e), including two boxes sharing `PHONE_FLOOR`. |
| 8 | Pick adds through the existing path and opens the sheet prefilled | Prefill holds (8a code, 8b, 8c). It skips the existing path's duplicate guard (P2-4), and 8a's last line is still red (P2-1). |
| 9 | 360 and 390 px, 44 px targets | Holds (9a, 9b, 1d). The probe's 360 px screenshot shows the box under + Add a song, unclipped. |

## Wrong-but-passing read

- Stale state: none found. The editor closes on any hash change (`App.tsx` `[hash]` effect), and My Songs unmounts on
  `#/song/<id>`, so the query, rows and `picked` reset (probe C2). A reply for a replaced query or an unmounted box is
  dropped (`stop` on unmount, 6c, 7d).
- Signed out: the box mounts only with + Add a song (case 0). `NoWordsYet` needs `madeHere`.
- Second phone or account switch: a pick is an ordinary own song in the current account's library, so it leaks nothing.
- Offline: no request and no rows. Try again respects the floor (7c).
- Data loss: none found. A pick drops a Key, BPM or Time signature already set in New song (P3-3 below).

## P3, new this pass

- P3-5. `lengthText` (`src/song-search.ts:43`) copies `formatRuntime` (`src/song-data-editor.tsx:8`). CLAUDE.md
  repeat-mistake 4 asks for one home. song-search.ts must stay free of React and CSS for L9 and the check's neutral
  bundle, so the right home is a pure file both import. `song-data-editor.tsx` is outside this cook's files, so this
  needs the owner. `check:one-copy` does not guard it.
- P3-6. The Worker edit (85c9c5e) makes an empty chart's print common, so an empty Private copy is judged only through
  the copy the phone names, the same as a built-in chart already is. A phone that leaves the copy unnamed can pass on
  the friend's title, artist and notes. Built-in charts already had that gap. I inferred both from `guardContent` and
  did not measure them. This is part of the owner's keep-or-revert
  decision. It is not a new finding against the cook.

---

# song-search resume rerun at 38f5fb9 (no code change)

After a limit pause, the head was rerun on the Windows laptop with Edge as `CHROME`. `npm run build` exit 0.
`check:song-search` 34 ok, 1 FAIL (8a, P2-1's test line), in 39 s. `check:portable` red on the same two P1-1 lines.
Logs are `.verify-logs/resume-*.log`. Both self-check passes are used. What stays open needs the owner: P1-1, P2-1
and the Worker edit from fix pass 1 (QUESTIONS.md, top entry and items 1 and 2).

VERDICT: FAIL, on owner seams only. No P0-P2 is open inside this cook's files.

---

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
