# song-paste-format-fix-2 self-check

Goal: a phone copy from a chord-site page (one chord or lyric fragment per line, blanks between) becomes a real lead
sheet, with lyric lines under the right chords, real section names, title and artist when present, comments as notes
and no divider junk.

Verdict: PASS. No open P0, P1 or P2. Nine P3 items are listed at the end.

The runs used headless Edge on Windows with the path shim. The box verify uses Chrome on Linux. Logs, the probe, the
mutation list and six screenshots are in `C:\Users\order\cooks\reports\song-paste-format-fix-2\`.

## What the copy looks like

The reported paste shows how the page is built (inferred from that one paste and the earlier Sweet Home screenshot).
The page holds each chord in a box of its own, and the first word after a chord in a second box. The phone gives every
box a line. The text between two boxes arrives as it stands, with one line for each page line it covers. So:

- `C`, ` `, `Blue`, ` jean `, `F`, `baby,` is one page line. The one-space line is the page's own space.
- An empty line is a page line break. So is the break between two lines of one text run, as in ` me,` then `   `.
- A run with no chord box, such as the comment lines before `CHORUS:`, arrives as ordinary lines.

## What changed

`readPaste` in `src/song-paste.ts` runs a new first pass, `pageCopy`. It returns null unless two lone chords stand next
to a line of spaces or a piece with a space on both ends. For any other paste `rejoin` from PR #114 runs as before.

- Page lines are rebuilt from the pieces. Each chord sits over the first letter of the next piece. A chord inside a
  word stays over its syllable, and the word stays whole (`auditorium`, `hums`).
- A gap of two spaces or more before a chord starts a new row, which gives `Blue jean baby,` and `L.A. lady,` their
  own rows. One space does not. The brief's rule said any whitespace-only line ends a lyric line. Read that way, the
  one-space line between `L.A.` and `F` would split `L.A. lady,`, which the brief also rules out.
- A line with no chord box that names a fretboard shape, or a chord by more than its letter, is a note. A chord row
  set apart from its words by such lines takes the words. `G/B G/B` sits over `softly,` and `slowly`, as on the page.
- On a page that names its sections, a blank line starts no section. On a page that names none, it parts stanzas.
- A word that reads as a chord (`A`) stays a word when the rest of its line follows it.

Two rules apply to every paste. A line of only dashes or other rule characters leaves the chart. A heading right under
a row of chords alone gets a blank line above it, because `parseSheet` reads a heading under a chord row as that row's
words. `Pasted`, `SongFacts` and `LeftOut` are unchanged, and no `LeftOut` value was added.

## Fail before, pass after

Base source is 95432ec (origin/mls-int-20261113). The base runs used a `git archive` of d963e70, which is the base
source plus the new cases.

| Case | Base source | HEAD `4025d8c` |
|---|---|---|
| 12k. the reported paste (`tiny-dancer-ug-phone.txt`, sha256 pinned) | FAIL, 65 sections | ok |
| 12l. a made-up page copy with site lines, intro instructions and a tab | FAIL, lines joined and `Caro lina` split | ok |
| 12m. a rule of dashes and a heading under chords alone, typed | FAIL, CHORUS read as words | ok |
| 12n. a page copy with no section names (added after the fix) | FAIL | ok |
| 12o. a typed chart with one stray line of spaces; a clean chart with a heading under chords (added after the fix) | FAIL | ok |

12n and 12o pass on the fix commit 6452184, so they have no fail-before commit of their own. The mutation run below is
their proof.

Final HEAD run: `npm run build` exit 0. check:song-paste 47 ok. check:song-search 52 ok. check:new-song 31 ok.
check:one-copy 18 ok. check:portable, check:privacy and check:screens exit 0. check:chords passed 2 of 3 runs, see
below. The 15 built-in charts read back the same in case 13.

## Proof beyond the cases

- Mutation run. `unit.mjs <tree> mutations.json` runs the 30 unit cases against one-line changes of
  `src/song-paste.ts`, held in memory. 27 of 27 are killed. The first run left six alive. Four got cases (12n, 12o).
  The code behind the other two was removed in 4025d8c, with one more test the scanner never needed.
- Real app. `probe.ts` pastes each fixture through **Paste a sheet** in New song at 360 px and 390 px, then saves at
  360 px. 22 of 22 checks pass. The preview and the saved sheet show Verse 1, VERSE 2, PRE-CHORUS and CHORUS, the
  first chords sit over `Blue`, `baby,`, `L.A.` and `lady,`, no page scrolls sideways, and no error boundary shows.
  The second fixture fills Title, Artist and Key. Copy the probe into a tree's `.verify-logs/self-check/` to rerun it.
- Fuzz. `fuzz.mjs` cuts, drops, repeats and trims lines of both fixtures, 20,000 variants. None throws.

## Runs that failed and why

- check:song-paste case 21 timed out once waiting for the service worker, in the run right after `npm run build` and
  seven other checks. The rerun passed, and so did the final run. My notes list that timeout from two earlier cooks.
- check:chords fails three Fire Away rows at 320 px on this laptop. Interleaved runs gave 4 fails of 6 on this branch
  and 5 fails of 6 on the base tree, with the FAIL lines byte for byte the same. The check never calls `readPaste`.

## A rule I tried and removed

A general rule made any pasted line that names a chord a note. Case 13 caught it. Two built-in charts hold sung lines
that name a chord (`... slow down on the last E7 ...`, `... (end on Bb)`). The rule now applies only inside a page
copy, to lines with no chord box.

## P3

1. The row split follows the brief. The page itself held `Blue jean baby,  L.A. lady,` on one line. A page that puts
   two spaces before every inline chord would get one row for each chord. The reported chorus uses one space.
2. The app's own output, pasted again, can read differently. 477 of 20,000 fuzz variants did, against 587 on the base
   source. `rejoin` takes rows of one chord over lower-case words for a PR #114 style copy. The app reads only the
   raw paste, so this needs a player to copy the box and paste it back.
3. A line break the copy does not show can join two lines. It needs a page with no indent, a line that ends in a
   letter with no chord on its last word, and a next line that starts in lower case under a chord.
4. Words after the last chord of a line, then more chords, put those chords on a row of their own.
5. One real paste is the evidence for the page model. A copy that lost its spaces-only lines is read by `rejoin`, as
   before this cook.
6. A row with no chord box keeps one leading space when the page had it (` Ballerina,`), and a chord played before a
   line indents its words (`Dm7 E7` over `    dancing in the sand`).
7. `We had a busy day {So` and `today` are the page's own text and stay as they are.
8. With no heading above them, intro instructions are still left out as lines above the first section.
9. A row of chord boxes with no words is written with one space between chords, not the page's columns.
