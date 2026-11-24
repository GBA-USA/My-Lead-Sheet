VERDICT: FAIL

# song-paste-format-fix-2 self-check at c4f0c97, tier deep

Goal: a phone copy from a chord-site page becomes a real lead sheet. Lyric lines sit under the right chords, the
page's section names become sections, title and artist are filled when present, comments become notes and dividers
are dropped.

Two P2s are open. Fix pass 1 (2d2c5d4) closed the exact repro of the earlier P2, but not its class. A typed chart
whose blank lines hold a space is still read as a phone copy when the line after the space is any one-word line that
`headingOf` does not know. That covers a heading outside the section-word list (`Riff`, `Turnaround:`, `Post-Chorus`,
`Breakdown`) and a one-word sung line (`Oh`). The heading is lost and the chord row under it becomes words with its
columns folded. The second sign path, a lone chord after words with a space on both sides, joins two sung lines of a
typed chart into one. Base 95432ec gives back every one of these charts unchanged.

Diff checked: `95432ec..c4f0c97`, which touches `src/song-paste.ts`, `scripts/check-song-paste.ts`, two fixtures and
VERIFY.md. Since the earlier self-check at ff8f5a9 the product change is 2d2c5d4 (the `leads` and `piece` sign rule) and
case 12p. The checks were not rerun, because the brief says they already ran at this commit. Probes are in
`.verify-logs/self-check-c4f/`. Runs used headless Edge on Windows with the path shim.

## Pass conditions from the brief

| Condition | Result | Evidence |
|---|---|---|
| tiny-dancer fixture fails on base, passes on head | met | cook log `before-d963e70.log` FAIL 12k, 12l, 12m; 12k unchanged since d963e70 |
| fixture is the t300u paste, verbatim | met | sha256 pinned in 12k, matched at ff8f5a9; the fixture is untouched since |
| "C F" over "Blue jean baby," style rows | met | 12k |
| Verse 2, Pre-Chorus, Chorus recognized, no verse per fragment | met | 12k |
| dividers dropped | met | 12k, 12m |
| voicing and comment prose are notes | met | 12k |
| Sweet Home shaped fixture passes | met | 12l |
| existing check:song-paste and check:song-search pass, build green | met | already run at this commit (brief); fix1 logs show 48 ok and 52 ok |
| committed on the branch, REPORT starts with filled HANDOFF | met | `reports/REPORT-song-paste-format-fix-2.md` opens with `## HANDOFF` |
| HANDOFF in the last commit message body | partly | 2d2c5d4 holds one `GOAL:` line. c4f0c97, a docs-only commit, holds none. P3 |
| VERIFY.md has no open P0-P2 | not met | P2-1 and P2-2 below |

## P2-1. A one-word line the heading reader does not know still makes a typed chart a page copy

CLASS=data-shape

The 2d2c5d4 sign needs a lone chord, then a line of spaces, then a `piece`: one word that is no chord and no
`headingOf` heading (src/song-paste.ts:489, 537). `headingOf` knows only the closed `SECTION_WORD` list
(src/song-text.ts:14) plus boxed and round-bracketed names. So a bare one-word heading outside that list is a
`piece`, and so is a one-word sung line. Two such stanza ends make two signs. From there the state machine is the
same one the earlier P2 hit. After the word comes `lead`, and the column-spaced chord row is said into the words with
its spaces folded.

Smallest repro (`␠` is a line holding one space; `.verify-logs/self-check-c4f/probe.mjs` case R2, at both trees):

```
Verse 1
G           C
Amazing grace how sweet
D
␠
Turnaround:
G  C  D
␠
Verse 2
G           C
That saved a wretch
D
␠
Post-Chorus
C        G
I once was lost
```

- Base 95432ec gives the chart back unchanged.
- Head gives `D` over the sung words `Turnaround:G C D`, and `D` over `Post-ChorusC G`, then `I once was lost` with no
  chords. Both headings are gone, and the G of `C        G` moves from column 9 to column 13 of a word line. Top rule 1
  breaks.
- The same happens with `Riff` (R1), `Breakdown` (R3) and a one-word sung line `Oh` (H2). All four forms are measured.
  The probe log shows each one.

Hands-on run in the real app (`.verify-logs/self-check-c4f/app.ts`, New song, Paste a sheet, at 360 and 390 px, log in
`app.log`). Measured, the same at both widths:

- The preview headings are `VERSE 1, VERSE 2`. The rows include `["D", "Turnaround:G C D"]` and `["D", "Post-ChorusC G"]`.
- The status reads only `Found key G major.`, so nothing tells the player a section was lost.
- `Use it as pasted` is offered. A player who saves without comparing keeps the broken chart.
- No sideways scroll at either width.

Untested. Every 12p form uses a heading in `SECTION_WORD`, a boxed heading, no heading, or `Amen` with a single sign.

Premise. Both fix rounds assumed that a closed test on the line after the stanza end can tell a page box from a typed
chart line. Any one-word line that is neither a chord nor a known section word breaks that test. My guess at a fix,
not tried: test what a typed chart has and a page copy never has. A phone copy gives each chord a line of its own, so a
line that `chordRowOf` reads as two or more chords with column gaps never comes from a page box. `pageCopy` could keep
such a row and the line before it as typed, wherever the state machine is. It could also refuse the copy reading when
a paste holds such a row after a sign. That rule needs a check against the "ordinary chord-over-lyric rows mixed in" of
the tiny-dancer fixture. A 12q case with R1, R2, R3 and H2 should fail at c4f0c97 and pass after.

## P2-2. Sung lines with a space at both ends join into one line

CLASS=data-shape

The other sign is a lone chord after words that start and end with a space (`spaced`, src/song-paste.ts:534-538). A
typed chart whose lyric lines are indented one space and keep a trailing space reads that way at every one-chord row.
Two such rows make it a page copy.

Repro (probe case S1):

```
Verse 1
G           C
 Amazing grace how sweet the sound␠
D
 That saved a wretch like me␠
G           C
 I once was lost but now␠
D
 Was blind but now I see␠
```

- Base gives it back unchanged, with 4 lines in Verse 1.
- Head gives two sung lines, `Amazing grace how sweet the sound That saved a wretch like me` with D at column 34, and
  the same for the second pair. The D still sits over `That`, but the chart's line breaks are lost, and on a 360 px
  phone the 61-character line no longer reads as the lyric line the player typed.
- Without the `Verse 1` heading (S2) the result is the same.

How often charts look like this is a guess. Indenting a lyric to sit under a pickup chord is common. A trailing space on
every line is less so, but copies from web pages and some PDF readers leave one. Untested. No case pastes a typed chart
whose lyric lines carry spaces at both ends.

## Other paths

- Sign-out, offline, second phone. Not reached. `readPaste` maps text to text with no storage or network.
- Stale state. None found. A view switch reruns `readPaste` on the raw paste.
- Widths. No CSS in the diff. The real-app run at 360 and 390 px shows no sideways scroll.
- Error paths. No throw in any probe. The fix1 seeded fuzz shows 0 throws in 20,000 variants. I did not repeat it.
- Checks. Not rerun, as the brief says. The diff after the last check run is docs only.

## P3

1. c4f0c97 is the last commit and its body holds no HANDOFF block. 2d2c5d4, the last code commit, holds one.
2. The earlier P3 items (row split on two spaces, re-paste drift, hidden line breaks and the rest) still stand. I did
   not re-derive them.

## Fix pass 2, after 7de7cbf

Premise of both earlier fixes: a test on the lines after a lone chord can tell a page box from a typed chart line.
I tested it with `.verify-logs/fix2/diag.mjs`. Each typed repro has 2 to 4 rows of chords in columns. In each, the
stanza-ending lone chord sits right under a chord row and its words. In the two real copies, no lone chord sits under
such a pair, and no lone chord sits over a line of two words or more that starts at column 0. The sign test now
leaves the next lines alone and asks what sits above the chord.

- P2-1, fixed. `pageCopy` returns null when a lone chord comes right under a typed pair. A typed pair is a row of two
  chords or more over any words, or one chord over a line of two words or more that starts at column 0. `readPaste`
  then reads the paste as before the page-copy pass. Case 12q holds the Riff, Turnaround:/Post-Chorus, Breakdown and
  "Oh" forms, plus "Oh" over no chords and lines typed one chord each. It fails at c4f0c97 and passes here.
- P2-2, fixed by the same rule. The lone `D` under `G           C` and its spaced lyric line is a typed chart's own.
  Case 12r holds both repro forms. It fails at c4f0c97 and passes here.
- Rejected. I first also refused a copy whose box word runs into a row of chords in columns. The seeded fuzz showed
  that this refuses real copies. A page's `G/B     G/B*` row can follow a box word straight on. It made 5 to 14
  variants newly unstable, so I dropped it.
- P3-1. This commit is the last one and its body holds the HANDOFF.
- P3-2, not re-derived.

Runs on this commit, measured:

- check:song-paste 50 ok with Edge, check:song-search 52 ok, build exit 0.
- Case 21 (the service worker after a reload) failed once before the fix and once under mutant M2, and passed on each
  rerun. It is a flake. The diff does not touch it.
- Three mutations of the new rule each fail the case aimed at them (`.verify-logs/fix2/M1.log` to `M3.log`):
  - M1 drops the rule and fails 12q and 12r.
  - M2 drops the one-chord half and fails 12q's lines typed one chord each.
  - M3 drops the chord-row half and fails 12q and 12r.
- The self-check's own probe: all seven forms read the same as the paste. The real-app probe
  `.verify-logs/self-check-c4f/app.ts` gives a box equal to the paste at 360 and 390 px, with no sideways scroll
  (`.verify-logs/fix2/app.log`).
- The seeded fuzz has 0 throws in 20,000 variants and 472 unstable, against 475 at c4f0c97. Against c4f0c97 it shows
  0 newly unstable and 3 newly stable (`.verify-logs/fix2/fuzz-diff3.log`).
- check:chords and check:one-copy die on the Windows `C:\C:\` root before any case. They are not in the diff.
