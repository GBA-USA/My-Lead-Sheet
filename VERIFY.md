VERDICT: FAIL

# song-paste-format-fix-2 self-check at ff8f5a9, tier deep

Goal: a phone copy from a chord-site page becomes a real lead sheet. Lyric lines sit under the right chords, the
page's section names become sections, title and artist are filled when present, comments become notes and dividers
are dropped.

One P2 is open. The new `pageCopy` pass also fires on an ordinary typed chart whose blank lines hold a space. That
chart loses a section heading and moves chords off their syllables. The base kept the same chart exactly as pasted.

Diff checked: `95432ec..ff8f5a9`, which touches `src/song-paste.ts`, `scripts/check-song-paste.ts`, two fixtures and
VERIFY.md. Runs used headless Edge on Windows with the path shim. Probes are in `.verify-logs/self-check-opus/`.

## Pass conditions from the brief

| Condition | Result | Evidence |
|---|---|---|
| tiny-dancer fixture fails on base, passes on head | met | cook log `before-d963e70.log` FAIL 12k, 12l, 12m; head log 47 ok |
| fixture is the t300u paste, verbatim | met | sha256 `37f328d9…1d18` for the brief's ref, the worktree file and `HEAD:` blob (measured) |
| "C F" over "Blue jean baby," style rows | met | 12k asserts the rows and chord columns |
| Verse 2, Pre-Chorus, Chorus recognized, no verse per fragment | met | 12k asserts 4 sections, each line 2+ words |
| dividers dropped | met | 12k, 12m |
| voicing and comment prose are notes | met | 12k asserts each prose line is a note on the pre-chorus |
| Sweet Home shaped fixture passes (chrome out, title and artist, intro notes, stanzas, chords) | met | 12l |
| existing check:song-paste and check:song-search pass, build green | met | cook logs: 47 ok, 52 ok, `built in 1.94s`. I did not rerun them because the diff after those runs is docs only |
| committed on the branch, REPORT starts with filled HANDOFF | met | `reports/REPORT-song-paste-format-fix-2.md` opens with it |
| HANDOFF in the last commit message body | not met | `git log -1 ff8f5a9` and `4025d8c` bodies hold no `GOAL:` line. P3, a process slip |
| VERIFY.md has no open P0-P2 | not met | P2-1 below |

## P2-1. A typed chart with space-filled blank lines is read as a phone copy

CLASS=data-shape

`pageCopy` (src/song-paste.ts:529-531) takes a paste as a page copy when two lone-chord lines are each followed by a line
of only spaces. That is also how a common typed chart looks. Many charts end a stanza on a lone chord, and copies from
notes apps, email and web pages often leave a space or a no-break space on a blank line. In such a chart, the state
after a chord and its spaces is `lead`. The next line with no space in it is then taken as "the one word after the
chord" (src/song-paste.ts:575-590). A one-word heading such as `Chorus` or `[Chorus]` is glued onto the chord row. The
column-spaced chord row under it is joined into the words with its spaces folded, so each chord loses its column.

Smallest repro (also `.verify-logs/self-check-opus/probe.mjs` case A, at both trees):

```
Verse 1
G           C
Amazing grace how sweet
D
␠
Verse 2
G           C
That saved a wretch
D
␠
Chorus
C        G
I once was lost
```

(`␠` is a line holding one space.)

- Base 95432ec gives the chart back unchanged, with 3 sections.
- Head gives `D` over `ChorusC G` as a sung line, then `I once was lost` with no chords. That is 2 sections, and the
  chorus heading and its chords are gone.
- With `[Chorus]` in place of `Chorus` (case D), the heading survives, but `C        G` becomes `C G`. The G moves
  from column 9 to column 2, over a different word. That breaks top rule 1.
- With no headings (case B), the three stanzas fold into one Verse 1, because the space lines are read as gaps inside
  a row, not as stanza breaks.

Hands-on run in the real app (`.verify-logs/self-check-opus/app.ts`, New song, Paste a sheet, 360 and 390 px).
Measured, the same at both widths:

- The preview shows headings `VERSE 1, VERSE 2` and a row `D` over `ChorusC G`.
- The status line reads only `Found key G major.`, so nothing tells the player that a section was lost.
- `Use it as pasted` brings back all three sections. A player who saves without comparing keeps the broken chart.
- No sideways scroll and no error boundary at either width.

Untested. 12o covers a single stray space line, which stays below the two-sign threshold. No case has two lone
chords followed by space lines in a typed chart.

Possible fix, a guess and not tried. A sign could require the line after the space line to be a word piece. In a real
page copy that is a fragment, not a heading or a column-spaced chord row. Or `pageCopy` could refuse to fold any line
that `headingOf` or `chordRowOf` reads, wherever the state machine is. A 12p case with the repro above should fail
before the fix and pass after it.

## Other paths

- Sign-out, offline, second phone. Not reached. `readPaste` is pure text to text with no storage or network, and the
  editor calls it only on a paste or a view switch (src/song-editor.tsx:177, 189).
- Stale state. None found. `switchTo` reruns `readPaste` on the raw text, so a view switch cannot show an old result.
- Widths. No CSS or layout in the diff. My probe and the cook's 22-check probe show no sideways scroll at 360 and 390.
- Error paths. The cook's fuzz ran 20,000 variants of both fixtures with no throw. I did not repeat it.

## P3

1. The HANDOFF block is in REPORT but not in the last commit body, as the brief asks.
2. `DIVIDER` applies to every paste and drops a line of `___`, `===`, `***` or `~~~` with no LeftOut count. Only
   dashes are tested (12k, 12m). A `____` fill-in line in a worksheet-style chart would vanish silently.
3. The cook's nine P3 items in the previous VERIFY.md (row split on two spaces, re-paste drift, hidden line breaks,
   and so on) still stand. I did not re-derive them.

## Fix pass 1, at 2d2c5d4

- P2-1, fixed. A lone chord over a line of spaces is a page-copy sign only when the line after the spaces is the next
  box: one word that is no chord and no heading, or a lone chord that is itself a sign. Case 12p pastes five typed
  charts of the repro's shape, including a one-sign chart, plus a page's chord-only intro. At ff8f5a9 source 12p fails
  and the other unit cases pass. Here all 31 pass. Each repro form reads the same as at base 95432ec (measured with
  `.verify-logs/fix1-cases.mjs`). The real-app probe `.verify-logs/fix1/app.ts` at 360 and 390 px shows all three
  headings, every row in its columns, the box equal to the paste and no sideways scroll.
- P3-1, no change. `git log -1 --format=%B ff8f5a9` holds the HANDOFF block with one `GOAL:` line. 2d2c5d4 carries an
  updated one.
- P3-2, fixed for underscores. A line of underscores stays as a fill-in blank. Rules of `-`, `=`, `*` and `~` still
  leave the chart. 12m now asserts both and fails at ff8f5a9.
- P3-3, not re-derived.

Runs: check:song-paste 48 ok with Edge, check:song-search 52 ok, build exit 0. 33 one-line mutations all fail a case
(`.verify-logs/fix1/mutations.log`). The seeded 20,000-variant fuzz has 0 throws, 475 unstable here and 468 at ff8f5a9.
The churn is 33 variants that turned unstable and 26 that turned stable, all cut fragments, such as two space lines in
a row between chords (`.verify-logs/fix1/fuzz-diff.log`).
