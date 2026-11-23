# song-search self-check, pass 1 (f8c6a76)

Goal: from My Songs or Add a song, a player searches a free public catalog, starts a new sheet with title, artist and
length filled in, and taps Find lyrics on the web to search in their own browser and paste the words in.

Run on Terry's Windows laptop, with Edge as `CHROME` and the path shim for old checks. `npm run build`: green.
`check:song-search`: 30 of 31 ok (`.verify-logs/song-search.log`). Before the feature, at 0a12177: 31 FAIL, 1 ok. The
one ok was case 0, the signed-out rule, which already held.

## Open

**P1-1. `check:portable` is red on the two URLs the brief requires.** `src/song-search.ts:7` and `:8`, rule
`literal-origin`. The fix is a one-line exception in an earlier check, which this cook may not edit. QUESTIONS.md item 2
has the patch. A scratch copy with that patch passes on this tree, planted fixtures included. Needs Terry or CoS.

**P2-1. `check:song-search` 8a fails on a commit-1 test bug.** The title is drawn uppercase, so `innerText` never holds
"Fire Away". Every product assertion in 8a passes before that line. QUESTIONS.md item 1 has the patch. Needs Terry or
CoS, because commit-1 tests may not be edited.

## Required cases

| Case | Check | Before | After |
|---|---|---|---|
| Find lyrics URL, encoded, general search | 1a, 1b (unit), 1c (new sheet), 1d (editor) | FAIL | ok |
| No lyrics fetch | 2a (no fetch while building the URL), 2b (scan of the 5 owned src files), 2c (request params), 2d (whole flow: only recording searches left the page, nothing opened, no reply text stored) | FAIL | ok |
| Happy path, fetch mocked | 3a (WS/2 recording search, `fmt=json`, User-Agent), 3b (parsed songs), 3d (rows show title, artist, year, m:ss) | FAIL | ok |
| No results | 4 (unit), 4b (screen says "No songs found" and "Try a different title or artist") | FAIL | ok |
| Offline | 5a (`navigator.onLine` false sends nothing), 5b (fetch rejects), 5c (screen message, no rows, Try again recovers) | FAIL | ok |
| API error | 6a (503), 6b (HTML, `{error}`, bad `recordings`), 6d (screen message, no rows, Try again, not called offline) | FAIL | ok |
| Debounce and 1 s floor | 7a (one request for a typing burst, 400-800 ms after the last key), 7b (a search right after a request waits 1 s), 7c (retries keep 1 s), 7d (stop) | FAIL | ok |
| Tap a result, own song prefilled | 8a (My Songs), 8b (Add a song) | FAIL | 8b ok, 8a see P2-1 |
| 360 and 390 px, 44 px targets | 9a (search box and rows), 9b (Find lyrics on the new sheet), 1d (Find lyrics in the editor) | FAIL | ok |

Mutation: `FLOOR_MS = 0` fails 7b ("left 600 ms after the first") and 7c (gaps 600, 600, 600). The floor cases are not
satisfied by the debounce alone.

## Layout at 360 and 390 px

Each target is at least 48 px tall: the search box, each result row (72 px), Try again, and Find lyrics on the web.
None is shorter than + Add a song (44 px), each stays inside the screen, and the page never scrolls sideways (9a, 9b,
1d). Screenshots: `C:\Users\order\cooks\reports\song-search-probe\`. In pass 1 the catalog rows looked like the
player's own rows below them. They now sit in a bordered box under the line "Tap one to start a new sheet with its
title, artist and length."

## No-lyrics scan

The only network step in the owned files is the catalog's recording search (`deps.fetch` in `src/song-search.ts`). Find
lyrics on the web is a plain `<a target="_blank" rel="noopener noreferrer">`, so the app never loads the results page,
and Google gets no referrer. The scan (2b) allows exactly two URL prefixes and fails on any lyrics host, `site:`,
XMLHttpRequest, sendBeacon, WebSocket or EventSource. A decoy `lyrics` field in the stub reply never reaches
localStorage (2d).

## Must-handle

- Signed out: the box is hidden, the same as + Add a song (case 0). No link enters this feature.
- Account switch on a shared phone: a pick is an ordinary own song from `addOwnSong`, so the existing backup and owner
  rules cover it. The feature stores nothing else. A query lives only in component state.
- Old or wrong links: none added.
- Offline and slow network: offline and error states stay on the search with Try again. Try again goes through the same
  debounce and the shared 1 s floor (7c). A reply to a query the box no longer holds is dropped (6c). A pick is local
  and guarded against a double tap, so a reconnect cannot add a duplicate.
- Permissions: no server route was added.
- Same content is not the same item: a pick never matches against songs the player has. Two picks of one recording
  make two songs, the same as writing one by hand twice.
- Sound setting, rescans, re-tick: not touched by this feature.

## P3, left as is

- P3-1. Chrome drops a `User-Agent` set on `fetch`, so the catalog sees the browser's own agent there. Firefox sends
  ours. The catalog's CORS preflight allows the header (measured: `Access-Control-Allow-Headers: Authorization,
  Content-Type, User-Agent`), so sending it is safe.
- P3-2. The live catalog answered "currently busy" (503) during this cook. The phone shows "The song list didn't
  answer. Try again in a moment."
- P3-3. Checks that start the Worker cannot run here (no wrangler on the laptop): `check:new-song`,
  `check:phone-layout`, `check:ux-collapse-everywhere`, `check:ux-layout-fix`. The first two touch My Songs and the
  New song dialog. By reading them, none counts the dialog's inputs or buttons, and `check:new-song` finds the editor
  by labels the search box does not use.
- P3-4. In New song, the search box hides once Title, Artist or Chart has text, and its query is lost.
