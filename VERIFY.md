# song-search-busy-retry self-check

Goal: when the public song list is briefly busy (HTTP 503 or 429), search waits and retries instead of showing "The
song list didn't answer." at once.

Verdict: PASS. No open P0, P1 or P2. Two P3 items are listed below.

The runs used headless Edge on Windows. The box verify uses Chrome on Linux. Logs are in `.verify-logs/` (gitignored).

## What changed

`read()` in `src/song-search.ts` now loops. A 503 or 429 reply waits, then asks the same URL again, at most twice.

- The wait is the longer of two values. One is the Retry-After header in whole seconds, 1 s when the header is
  missing or unreadable, and 2 s at most. The other is what is left of the 1 s floor.
- A retry whose wait would reach the 8 s answer limit is not started. The box says `failed` at once.
- After the wait, the shared floor is read again. A second box may have asked during the wait.
- A search that was replaced or stopped asks no more. The check is `live()`, which is `mine === current`.
- Every other non-OK status still fails at once. `ANSWER_MS` and `FLOOR_MS` keep their values.

## Fail before, pass after

The base is `8bc74ff` (origin/mls-int-20261113). The base run used the base source with the check from test commit
`4916706`. The HEAD run used the HEAD check, which adds 6l and 6m.

| Case | Base source (`before.txt`) | HEAD (`final-check.txt`) |
|---|---|---|
| 6h. a 503, then a 200, shows the songs and never says failed | FAIL, "a busy reply keeps the box searching" | ok |
| 6i. three 503s say failed after three requests, inside 8 s | FAIL, "three tries in all" | ok |
| 6j. a 429 waits its Retry-After (cap 2 s, default 1 s, floor 1 s) | FAIL, "Retry-After 5: still searching during the wait" | ok |
| 6k. a new query or `stop()` during the wait ends the old search | FAIL, "the busy reply started a wait" | ok |
| 6a. a persistent 503 says failed (now 5 s on the clock), and a 500 fails at once | ok | ok |

The base run read 46 ok and 4 FAIL. HEAD reads 52 ok and 0 FAIL. `npm run build` exits 0.
`check:one-copy` (18 ok, run with the Windows path shim) and `check:portable` also pass.

## Mutation proof

`.verify-logs/mutate.mjs` runs the whole check against one-line mutations of `src/song-search.ts` and restores the file
from memory. The unmutated baseline read 52 ok. Each mutation failed its own case (`mutate.txt`).

| Mutation | Fails |
|---|---|
| M1 `BUSY_RETRIES = 1` | 6i |
| M2 `BUSY_RETRIES = 3` | 6i |
| M3 drop `!live()` | 6k |
| M4 cap 5 s | 6j |
| M5 drop the deadline check | 6l |
| M6 drop the floor recheck | 6m |
| M7 503 only | 6j |
| M8 ignore the header value | 6j, 6m |

M5 and M6 survived the first four cases. 6l and 6m were added in a later commit for them. The tests-only commit is
unchanged.

## Open items

- P3, inferred. `Retry-After` is not a CORS-safelisted response header. The browser hides it unless the catalog lists it
  in `Access-Control-Expose-Headers`. Then `headers.get` returns null and the phone waits the 1 s default. That value
  matches the `retry-after: 1` the catalog sent in the report. The live catalog was not asked, as the brief says.
- P3. A search replaced during a wait leaves its wait timer and its 8 s limit timer scheduled. Both fire later, see that
  the search was replaced, and do nothing. Nothing is reported and nothing is sent.
