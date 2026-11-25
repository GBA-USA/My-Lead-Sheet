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
