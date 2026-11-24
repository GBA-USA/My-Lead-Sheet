# song-paste-format-fix self-check

Goal: a chart pasted from a typical chord-site page becomes a correct lead sheet (title, artist, real sections, chords
over the right words, no site junk), and the web-search link looks for a chord chart, not lyrics.

Verdict: PASS. No open P0, P1 or P2. Three P3 items are listed below.

The runs used headless Edge on Windows with the path shim. The box verify uses Chrome on Linux. Logs are in
`.verify-logs/` (gitignored).

## What changed

`readPaste` in `src/song-paste.ts` has a new first pass, `rejoin`. A phone that copies a chord page puts each chord, and
the words under it, on lines of their own, with a blank line where the page broke a lyric line. That gave one Verse per
fragment. `rejoin` puts each run back together as a chord row over one whole lyric line, each chord over the first letter
of the words it sat on. The reader then runs as before, so capo, respelling and `placeChords` are unchanged.

- A block is a page copy only when its words run on in lower case or come two lines in a row. Typed short lines with
  one chord each stay as typed (12f).
- Site lines are matched by shape, never by a site's name: a `n/5` rating, `n votes`, sign-in and songbook prompts,
  `Tabbed by`, and lone buttons such as Print. Above the chart they count as lines above the first section, as before.
  Below it they count as the new `LeftOut` value `site lines`. The editor's status map gains its singular,
  `site line`. The existing values are unchanged.
- A `<title> chords` line above the chart gives `facts.title`. `by <artist>`, or the line under it, gives
  `facts.artist`. A ChordPro `{title:}` or `{artist:}` wins.
- Words in a played part (Intro, Solo, Interlude, Instrumental, Riff, Break) become notes. A blank line before more
  playing stays inside the part, and any other blank ends it as before.
- Single lines of words with a blank after each make one section per stanza. Two blanks end a stanza.
- A bare `[Verse]` is numbered like `{start_of_verse}`, so two of them are VERSE 1 and VERSE 2.

The link is "Find chords on the web" and searches `"title" "artist" chords`: `chartSearchUrl`, `FindChords`,
`.find-chords`, data key `chartSearch`. The retry code, `ANSWER_MS` and `FLOOR_MS` are not touched.

## Fail before, pass after

Base `23afabf` (origin/mls-int-20261113). The base run used a `git archive` of the base with the head's check files.

| Case | Base source | HEAD `fe88b59` |
|---|---|---|
| 12b. chord page with site lines: title, artist, Intro notes, Verse and Chorus with chords on their syllables | FAIL, title and artist from the header | ok |
| 12c. chord-over-words stanza, typed or as a page copy, is one section | FAIL, page copy: one section | ok |
| 12d. ChordPro among site lines | FAIL, the two sections and no other | ok |
| 12e. words with site lines and a blank after every line | FAIL, no site line in the chart | ok |
| 12f. short lines typed one chord each stay as typed | ok on base, FAIL on `b500820` | ok |
| check:song-search 1a, 1b, 2a, 1c, 9b, 1d | FAIL, chartSearchUrl missing and old label | ok |

Final HEAD run: `npm run build` exit 0. check:song-paste 36 ok, check:song-search 52 ok, check:new-song 31 ok,
check:chords, check:one-copy (18 ok) and check:portable all pass. The library charts read back the same in case 13.

## Mutation proof

`.verify-logs/mutate.mjs` runs the unit cases against one-line mutations of `src/song-paste.ts` and restores the file
from memory. Baseline 19 ok (before 12f). All 10 were killed: site lines (12d, 12e), header facts (12b), rejoin
(12b, 12c, 12e), played-part notes (12b), lower-case join (12b), blank-per-line rule (12e), played-part blanks (12b),
bare Verse numbering (12b), artist line (12b), chord column (12b, 12c).

## Runs that failed and why

- check:chords (Fire Away @320px, 3 rows) and check:new-song case 5 each failed once on the first HEAD run. One rerun
  passed both, and the final run passed both. The base passed both. My notes already list check:chords as unsteady on
  this laptop.
- Case P (perf, paste within 100 ms of typed at 4x CPU) failed twice in a row at 153 and 155 ms. HEAD has also given
  50, 40, 64, 42 and 43 ms, and the base gave 50 and 119 ms. In Node, readPaste on that 300-line chart takes a median
  of 1.29 ms on HEAD against 0.93 ms on base (measured). An instrumented copy of the check, with Title filled, showed
  one layout and 46 ms of task time for the tap. So I read P as bimodal on this laptop, not slowed by this change.
  This is inferred: the slow mode's cause was not found.

## P3

1. The exact text of Terry's paste is not known. The fixtures follow the screenshot's shape. Terry's Preview kept the
   header lines, which readPaste on the base drops, so that paste may not have gone through Paste a sheet at all
   (inferred). A paste with no section markers still drops the intro instructions above the first chord row as lines
   above the first section. It no longer turns them into verses.
2. Fragment words lose the spacing the page had: `miss` `'ole'` `'` `bamy` joins as `miss'ole' ' bamy`. A lone `A`
   word in a page copy reads as the chord A.
3. Site-line patterns could drop a lyric line that is only "Share" or "Print", or one that holds the word "songbook".
