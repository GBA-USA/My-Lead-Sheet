# song-paste-import self-check fix pass 2 of 2 (on top of the self-check below)

Goal: a capo note made by a paste goes with its chart however the player replaces the chart, or the player can see it
and remove it. The self-check's P2-1 rests on one premise: that the editor can tell from text events when the capo
chart has left the box. That premise is false. Select all then type, cut, and undo all look like edits. So the root
fix makes the note a control, and a paste over the whole box counts as a fresh paste. Logs are in `.verify-logs/fix2/`
(gitignored). The runs used headless Edge on Windows with the path shim, not Chrome on Linux.

| Path | Case in `scripts/check-song-paste.ts` | 4d10cab source (`before.log`) | Fix (`src/song-editor.tsx`) | After |
|---|---|---|---|---|
| Repro D: Select all, then Paste a chart with no capo | 25: the paste is taken, cleaned (`Tuning:` left out), replaces the box, the preview and status name no capo, Save stores `""` | FAIL, "the app takes a paste over the whole box" | `onPaste` takes a paste whose selection covers the whole box as a paste into an empty box (`takePaste(text, "")`) | ok |
| Repro E: empty the box and type a chart | 26: the paste status goes, Remove capo note shows, one tap drops the note from the preview, Save stores `""`. Then Edit song on a saved capo song shows the row, and Remove plus Save stores `""` | FAIL, "the paste status goes once the box no longer holds the paste" | The paste panel renders on `fresh`, not `pasting`. A `Capo <n>` key note shows above the box with Remove capo note | ok |
| The new button at 360 and 390 px | 22 now also measures Remove capo note | FAIL, "Remove capo note is visible at 360 px" | Reuses `.song-editor-paste-actions` (44 px buttons) | ok |

- Case 26 failed on its first line at 4d10cab, so the mutations in `mutate.log` and `mutate-m6.log` prove its later
  lines. Each one makes its case fail. M1 sets `fresh = pasting`, and 26 fails on the status. M2 removes the row, and 22
  and 26 fail. M3 makes Remove do nothing, and 26 fails on the preview. M4 drops the whole-box rule, and 25 fails on the
  take. M5 keeps what the box held, and 25 fails on the replace. M6 hides the row in Edit song only, and 26 fails on
  Edit song.
- After the fix: `check:song-paste` 28 ok (`after.log`). `check:new-song` 28 ok, `check:song-search` 46 ok, and
  `check:music`, `check:screens`, `check:portable`, `check:one-copy` and `check:ux-theme-tokens` pass. `tsc --noEmit`
  and `vite build` are green.
- `check:chords` has the same 3 FAIL lines twice (Fire Away @320px x1, `chords.log` and `chords-2.log`). They are
  identical to the base runs in `.verify-logs/paste/base-chords*.log`, which are the known Windows font rows.
- P3 probe F: `takePaste`'s comment now says a paste that leaves nothing "fills no field". The capo note clear is
  `formWithPaste`'s documented whole-box rule. No case was added for it.
- Not done (P3): single-dash tab lines. Owner questions are in QUESTIONS.md, fix pass 2.

VERDICT: PASS for P2-1, pending the next self-check.

---

VERDICT: FAIL

# song-paste-import self-check at 4d10cab, tier deep

Goal: a player pastes a chart copied from the web and gets a correct lead sheet, with sections, chords over their
words, key, BPM and capo, shown as the real sheet before Save. This self-check reads the whole diff `1e95d14..4d10cab`
and, more closely, the fix pass `917a834..4d10cab`, which closed the three P2 findings of the 917a834 self-check. No
code was changed. The cook's check runs were not repeated. The fix pass changed only `scripts/check-song-paste.ts`
among the checks, and its fail-before and pass-after logs are already in `.verify-logs/fix1/`.

Evidence is in `.verify-logs/self-check2/` (gitignored). `probe.ts` and `probe.log` hold the screen probe. It ran in
headless Edge on Windows with the path shim, at 360 and 390 px, against a stub `/api/me`. `openSite` built the app from
this head's source. `window.__errors` stayed empty.

## Pass conditions

| Condition | Result | Evidence |
|---|---|---|
| Cases 1 to 22 each have a named line that failed on the tests-only commit | Met | `.verify-logs/paste/commit1.log`, 24 FAIL lines at 5458580 (checked at 917a834, the cases are unchanged since) |
| The fix pass cases fail before and pass after | Met | `fix1/before2.log` has FAIL 6b and FAIL 23 at 917a834's source. 24 passed there because the behavior already worked, and mutation M3 makes it fail. `fix1/after3.log` has 26 ok and no FAIL |
| No earlier case weakened | Met | The fix pass removes only the old `keyboard` helper, which moved up the file, and one narrower type line |
| Unit, live and perf boxes, `npm run build` green | Met (the cook's runs, not repeated) | |
| Owned files only, one package.json line | Met | `VERIFY.md` and `QUESTIONS.md` are the shared report files |
| One apply function | Met | `formWithPaste`, `src/song-editor.tsx:54` |
| The 917a834 P2-2 (a squeezed chord moved in silence) | Closed | Probe G: `CM7 F` over `Lovely day for it` goes in as `[Cmaj7]Love[F]ly day for it`, and the editor lists `Line 2: Chords too close inside 'Lovely'`. Probe H: the capo row warns about `'Paper'`. Show guitar shapes gives back the plain two-line row with no warning, and the switch back restores the bracket line and its warning. Nothing overflows at 360 or 390. The box scrolls sideways because it has `wrap="off"`, which was already true before this diff |
| The 917a834 P2-3 ("Nothing here" untested) | Closed | Case 24, proven by mutation M3 |
| The 917a834 P2-1 (a stale capo note) | Closed for one path only, see P2-1 below | |
| Signed out, second account, offline | No change | The save still goes through `addOwnSong`, and the paste makes no network call |

## Findings

### P2-1. The capo note still outlives its chart when the player replaces the chart another way

CLASS=state-machine

The fix clears a `Capo N` note only when `formWithPaste` runs with an empty `before`. That happens on a paste into an
emptied box, or on a Paste a sheet tap with an empty box. It assumes the capo chart can leave the box only that way.
That premise is false. A box that holds text gives a keyboard paste to the browser (`onPaste` returns early when
`form.chart.trim()` is not empty), so Select all then Paste never reaches `formWithPaste`. Typing a chart into the
emptied box also never reaches it. On both paths the note stays. It is saved and drawn on the song sheet. The editor
has no `keyNote` field, so the player cannot remove it. The status line also keeps saying `Found key A major, capo 2.`
over a chart with no capo, because it reads `pasting`, which only the next paste replaces.

Before this diff a new song never had a key note, so this is new behavior. Case 23 covers only the emptied-box paste.

Smallest repro (probe D, the same at 360 and 390 px):
1. New song. Paste a sheet with `Capo: 2nd fret` / `[Verse 1]` / `G      C       D` / `Paper boats on the river`.
2. In the box, Select all, then Paste `[Chorus]` / `G           C` / `Float away into the light`.
3. The preview still shows `Capo 2 for guitar`, and the status still says `Found key A major, capo 2.`
4. Save. The stored `keyNote` is `Capo 2 for guitar`, and the saved sheet shows it.

Probe E gives the same result when the player empties the box and types the second chart.

Suggested fix, at the root: the note is form state the player can neither see as a control nor remove. Show a
paste-made capo note in the editor with a remove button, and hide the paste status line once `fresh` is null. A smaller
step is to treat a keyboard paste whose selection covers the whole box as a paste into an empty box. That also cleans
that paste. It closes repro D but not repro E. Add a screen case for each path you close.

## P3, no change needed to pass

- Probe F. In Edit song on a capo song, emptying the box and tapping Paste a sheet with `Key: G` / `Tempo: 120 bpm`
  clears the capo note. `takePaste` says that a paste that leaves nothing goes in "with no field changed". Clearing it is
  defensible, because the capo chart is gone, but the comment and the brief's words disagree with the code, and no case
  covers it.
- A keyboard paste over a box that holds text, Select all included, goes in raw with no cleaning. The brief asks for
  cleaning only on Paste a sheet, so this is a gap in convenience only.
- Still open from 917a834: a tab line with single dashes is not seen as tab. The chips, and now also the status line,
  follow `pasting` rather than `fresh`.

## Plan and code disagree (owner)

- QUESTIONS.md, fix pass 1. A squeezed chord row goes in as a bracket line with the editor's warning, and the preview
  still draws the second chord pushed right until the player fixes the line. The other choice was the two-line form plus
  a warning in the status line.
- QUESTIONS.md, the cook's entries 1 and 2 (a clean chart stays as pasted, and `Xsus` reads back as `Xsus4`). These are
  unchanged since 917a834.

## Hands-on run

The riskiest path was still the capo note, because it is the only form state that the box does not show. The fix
handled one way out of the capo chart, so the probe tried the other ways a phone offers. Probe A is the fixed repro, and
it now stores an empty note at both widths. Probes D and E are the two paths above, and both store the stale note at both
widths. Probes G and H drive the bracket-line fallback through the real Paste a sheet tap and the capo switch. Probe F is
the Edit song case with a paste that leaves nothing.
