# song-paste-import self-check fix pass 1 of 2 (on top of the self-check below)

Goal: the three P2 findings below are closed. Each one got a check case first, and the case failed on 917a834's
source. Then the code was fixed, and the same case passes. Logs are in `.verify-logs/fix1/` and `.verify-logs/paste/fix1*`
(gitignored). The runs used headless Edge on Windows with the path shim, not Chrome on Linux.

| Finding | New case in `scripts/check-song-paste.ts` | 917a834 source | Fix | After |
|---|---|---|---|---|
| P2-1, a stale capo note | 23: New song (capo paste, Show guitar shapes, empty the box, keyboard paste of a chart with no capo, Save), then Edit song on a saved capo song, the same steps | FAIL, "new song: the preview drops the capo note" (`before2.log`). M2 runs the Edit song half alone and it fails too (`mutate.log`) | `formWithPaste` clears a `Capo N` note when a paste fills the whole box and finds no capo (`src/song-editor.tsx`) | ok |
| P2-2, a respelled chord slides off its letter in silence | 6b: `CM7 F` over `Lovely day for it`, and `Capo 2` with `Em D C G` over `Paper boats on the water`. The editor's warnings must name the word | FAIL, warnings `[]` (`before2.log`). M1 runs the capo row alone and it fails too | `write` keeps `placeChords`' warning. A row that warns goes into the box as a bracket line, `[Cmaj7]Love[F]ly day for it`, which `parseSheet` warns about (`src/song-paste.ts`). See QUESTIONS.md | ok |
| P2-3, "Nothing here" untested | 24: `Key: G` / `Tempo: 120 bpm` stays in the box as pasted, with the words, and Key and BPM unchanged | ok, because the behavior already worked. M3 removes `takePaste`'s nothing-left branch and 24 fails ("timed out waiting for the nothing-here words") | none | ok |

- Two of my first test lines were wrong and I fixed them before the fail-before run that counts. Case 23 matched
  "Capo" in a song titled "Capo Boats". Case 6b compared the lyric byte for byte, but `placeChords` widens a real word
  gap later in the capo row, which case 6 already allows. `before.log` and `after.log` are those first runs.
- After the fix: `check:song-paste` 26 ok, `check:new-song` 28 ok, `check:song-search` 46 ok, `check:music`,
  `check:portable` and `check:one-copy` pass, and `npm run build` and `tsc --noEmit` are green.
- `check:chords` has 3 FAIL lines (Fire Away @320px x1), identical to the cook's `fin-chords.log`. These are the
  known Windows font rows.
- Case 21, which this pass did not touch, timed out "waiting for the service worker" in 2 runs back to back (33 s
  each, right after the build and the other checks). It passed in 3 other runs (18 to 19 s), one through the same
  runner. I read this as load (inferred), not proven.
- Not done (P3): single-dash tab lines and chips that follow `pasting` rather than `fresh`.

VERDICT: PASS for P2-1, P2-2 and P2-3, pending the next self-check.

---

VERDICT: FAIL

# song-paste-import self-check at 917a834, tier deep

Goal: a player pastes a chart copied from the web and gets a correct lead sheet, with sections, chords over their
words, key, BPM and capo, shown as the real sheet before Save. This check reads the diff `1e95d14..917a834` (8 files),
walks the brief's pass conditions, and runs the riskiest paths in the built app. No code was changed. The cook's own
check runs were not repeated, because the diff did not touch any earlier check or its fixtures.

Evidence is in `.verify-logs/self-check/` (gitignored). `unit.mjs` and `unit.log` hold the `readPaste` probes in node.
`probe.ts` and `probe.log` hold the screen probe (headless Edge on Windows with the path shim, at 360 and 390 px, against
a stub `/api/me`).

## Pass conditions

| Condition | Result | Evidence |
|---|---|---|
| Cases 1 to 22 each have a named line that failed on the tests-only commit | Met | `.verify-logs/paste/commit1.log` has 24 FAIL lines (1 to 22, perf, module load) at 5458580 |
| They pass now, and `npm run build` is green | Met (the cook's run, not repeated) | |
| Unit box: cases 1 to 14 print `ok` | Met (the cook's run) | |
| Live box: Capo, `[Chorus]`, `C(add9)`, Save, headings, capo note, chords over their words | Met by case 21 (`LIVE` chart, real clipboard, offline reload) | |
| Perf box | Met, with a stricter baseline | The cook compares against the same text typed in. Trunk's tap was 87 ms against 33 ms typed on commit 1, so typed + 100 ms is the tighter bar |
| `check:new-song`, `check:song-search`, `check:chords`, `check:music` unedited | Met | No earlier check script is in the diff |
| Owned files only, one package.json line | Met | The diff touches only the owned files, plus a QUESTIONS.md entry, which the rules allow |
| `SongFacts`, `Pasted`, `LeftOut` as in the plan; one apply function | Met | `formWithPaste` in `src/song-editor.tsx:54`. `readPaste` has an extra optional `view` argument, which leaves the frozen shape alone |
| Empty or refused clipboard says "Paste your sheet into the box." and focuses the box | Met (case 20) | |
| A paste that leaves nothing keeps the raw text and says "Nothing here looks like a chart…" | Works, but untested (P2-3) | probe B |
| Storage failure on Save keeps the editor open | Met | The Save path now goes through `stored()`. `check:new-song` lines 882 and 902 cover `NOT_SAVED` and ran unedited |
| Signed out, second account, offline | No change | Same `addOwnSong` path, no network call (case 14), offline reload (case 21) |

## Findings

### P2-1. The capo note outlives its chart and is saved on a song that has no capo

CLASS=state-machine

`formWithPaste` (`src/song-editor.tsx:62`) writes `keyNote` only when the new paste has a capo. Nothing clears it when
the capo chart leaves the box. The editor has no field for `keyNote`, so the player cannot remove it. The saved sheet
can then say "The chords are guitar shapes." over chords that are not shapes. A bass player who believes that note
plays the whole song in the wrong key.

Smallest repro (probe A, the same at 360 and 390 px):
1. New song. **Paste a sheet** with `Capo: 2nd fret` / `[Verse 1]` / `G      C       D` / `Paper boats on the river`.
2. Tap **Show guitar shapes**. The preview note reads `Capo 2. The chords are guitar shapes.`
3. Empty the box. Paste `[Chorus]` / `G           C` / `Float away into the light` with the keyboard. It is cleaned, and the status reads `Found key C major.`
4. The preview still shows `Capo 2. The chords are guitar shapes.` Save. The stored `keyNote` and the saved sheet both say it.

The same happens in Edit song for a song saved with a capo note. Likely fix: when a paste replaces the whole box
(`before` is empty) and has no capo, clear a note that matches `/^Capo \d+/`. Add a screen case for this repro.

### P2-2. A respelled chord that grows into its neighbour inside one word moves off its syllable, with no warning

CLASS=data-shape

`write` in `src/song-paste.ts:236` takes `placeChords(...).line` and drops its `warning`. When two chords sit inside one
word and the first one grows (`CM7` to `Cmaj7`, or `Em` to `F#m` under a capo), `placeChords` finds no word gap and
pushes the second chord right. The box then holds a plain chord row over a lyric, so `parseSheet` raises no warning
either. The chord moves off its letter and no one is told. That breaks top rule 1. Case 6 covers growth only when there
is a word gap to widen.

Smallest repro (probe C): **Paste a sheet** with `Key: C` / `[Verse 1]` / `CM7 F` / `Lovely day for it`. `F` was over
the `l` of `Lovely` (column 4). The box becomes `Cmaj7 F`, which puts `F` over the gap before `day` (column 6). The
warnings list is empty, and the status says only `Found key C major.` The same in node: `Capo 2` / `Em D C G` /
`Paper boats on the water` gives `F#m E D A`, with `E` moved from the `e` of `Paper` to its `r`.

Likely fix: keep the warning and show it in the status line, or keep the pasted chord's column. Add the no-gap case to
case 6.

### P2-3. The brief's "nothing left after cleaning" state has no check line

CLASS=other

The brief names this state and its words: "Nothing here looks like a chart. It is in the box as pasted." It works
(probe B: `Key: G` / `Tempo: 120 bpm` stays in the box as pasted, with that message, and Key and BPM unchanged). No case
in `scripts/check-song-paste.ts` reaches it, so a regression would pass every check.

## P3, no change needed to pass

- A tab line with single dashes, such as `e|-3-5-7-|`, is not seen as tab, because `TAB_LINE` also needs `--`
  (`src/song-paste.ts:204`). It stays in the chart as a lyric line (unit probe: 1 of 4 lines counted). Nothing is lost,
  but the cleaning is incomplete.
- The status line and the chips come from `pasting`, not `fresh`. After the player deletes the pasted chart, **Use G
  major** still offers the key of a chart that is no longer in the box.
- The status words "Taken as words." and the scroll of the preview into view are not asserted by any check.

## Plan and code disagree (owner)

- QUESTIONS.md entry 1: a paste with nothing to clean stays as pasted, so `[Intro]` is not restyled to `INTRO`. Plan
  section 2 case 3 restyles every heading. The cook chose this so that `check:new-song` 2b passes unedited. The choice
  is sound, but the owner should confirm it.
- QUESTIONS.md entry 2: case 13 reads built-in charts back with `Xsus` read as `Xsus4`, not byte for byte.

## Hands-on run

The riskiest path was the capo switch and a later paste over the same form, because it is the only place where the
editor holds state that the box does not show. `probe.ts` ran it at 360 and 390 px in the built app, with real taps,
the keyboard paste handler and Save, and read localStorage afterwards. That is where P2-1 came from. Probe C (P2-2) and
probe B (P2-3) ran in the same session. `window.__errors` stayed empty.
