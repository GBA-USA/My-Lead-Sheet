# Lead Sheets — Phase 1 analysis

The behavior spec is `docs/handoff/lead-sheets-app-handoff.md`. The build plan is `docs/handoff/lead-sheets-build-plan.md`. Where they disagree on behavior, the spec wins. Where they disagree on data, `docs/handoff/lead-sheets-data-export.json` wins. This note covers the three things the plan asked for before Phase 1, and the calls Phase 1 had to make.

## (a) The export is one shape

Top level: `exportedFrom`, `exportedFor`, `exportedAt` (`2026-11-11`), `songCount` 16, `songs` (16), `setlists` (2).

All 16 songs have the same 17 fields in the same order:

`id`, `title`, `artist`, `keyLabel`, `keyRoot`, `keyMode`, `keyNote`, `tempo`, `tempoNote`, `timeSignature`, `feel`, `sourceNote`, `atAGlance`, `howToPlay`, `practiceTip`, `bassNotes`, `body`.

- `id` is an integer. `keyMode` is only `"major"` or `"minor"`. `tempo` is an integer or `null`. Every other scalar is a string (sometimes empty).
- Every bass-note row is `{chord, nashville, bassNote, position}`, all strings.
- Every body section is `{heading, lines}`.
- Every line is a subset of `chords`, `lyrics`, `bars`, `note`. No other fields, no nulls, no markdown. Counts across the export: chords+lyrics 379, bars 41, note 36, lyrics only 13, bars+note 4.
- Setlists are `{id, name, songIds}`. Worship Set is `11, 8, 10, 9`. Biker church is `10, 11, 9, 8`. Every id exists. Neither setlist includes song 12 or 13.

### Anomalies

These are flags, not things the sheet text was rewritten to "fix."

1. **Song 12 is the empty stub.** Title `no half steppin`, artist `sean costello`, key `A major`, tempo `null`, and empty `feel`, `sourceNote`, `atAGlance`, `howToPlay`, `practiceTip`, `bassNotes`, and `body`. It duplicates song 13. The seed at `data/library.json` drops id 12 and keeps id 13 (`No Half Steppin'`, Sean Costello). `songCount` in the seed is 15. The handoff copy of the export is unchanged and still has all 16.

2. **Null tempos on ids 5 and 13 are correct.** Id 5 (`Take Me Out`) has two tempos, recorded in `tempoNote` (`verse ~122 bpm, riff ~104 bpm`). Id 13's recording BPM is unverified; `tempoNote` says so. The export also has `tempo: null` on id 12 because that row is empty. After the drop, the only null tempos are 5 and 13. Nothing in the app invents a BPM for them (the 90 BPM auto-scroll fallback is Phase 2, and it is a scroll fallback, not a displayed tempo).

3. **`keyNote` is usually empty.** It is set on songs 1 (capo charts), 3 (sounds Eb), 7 (`E-centered`, which repeats the parenthetical already in `keyLabel`), 14 (enharmonic Gb), and 15 (Mixolydian / bVII). Stored text is unchanged.

4. **`tempoNote` is set on songs 5, 9, 10, 11, and 13.** Chain Breaker's note (analysis reads 156, play 78) is real. It is not on the Key / Time / Tempo line in the phone screenshot, which reads `Tempo: ~78 bpm`.

5. **Bar lines are not all pipe charts.** Song 8's intro bar string is `Bb   Gm   F   Bb`, on the same line object as a note. It is rendered as stored.

6. **No "(didn't come through)" placeholder is in this export.** Songs 14–16, the generator's proof sheets, are complete. A `note` line is printed verbatim, so a later placeholder would show up as written.

7. **Songs 12 and 13 are not the same string.** `no half steppin` / `sean costello` versus `No Half Steppin'` / `Sean Costello` (ASCII apostrophe). Keeping 13 is the spec's rule.

8. **Nashville spellings stay per song** (`6` and `6m`, `5 over 3`, `5 / b7`, `1, 3rd in bass`, flats). Phase 1 prints the stored column. It does not normalize them.

## (b) Component map

| Spec surface | This phase | Where it lives |
| --- | --- | --- |
| Shell: back, "Lead Sheets", ••• | Built | `App` header. Back returns to the list the song was opened from. There is no second "← Songs" control. |
| My Songs / Setlists tabs | Built | 36px tabs in `App`. |
| My Songs list | Built | `SongList`. Title, artist, key, tempo. Tap opens the sheet. |
| Setlists list | Built | `SetlistList`. Name and songs in performance order. Tap a song to open it. |
| Song view | Built | `LeadSheet`: title, source, key/time/tempo, feel, bass-note table, how to play, chart, at a glance, practice tip. |
| Sticky song header | Built | `SongControls`, outside the scroll region so it sits under the tab bar and cannot slide under it. The sheet scrolls in `#sheet-scroll`. |
| Phone header, three rows | Built | Text size, Screen on, ••• · Notes \| Nashville and scroll on one line · compact transpose strip. |
| Tablet header (768px and up) | Built | Those controls step up; the transpose strip joins the notation/scroll row. Steppers and Original Key stay 32px. |
| A− / A+ | Built | Scales the sheet. Preference key `leadSheetsTextScale`. |
| ••• Edit / Delete | Menu only | `OverflowMenu` on the song header, and the shell ••• while a song is open. |
| Screen on | Control only | Pill on every current screen. Preference key `leadSheetsKeepAwake`, default on. |
| Notes \| Nashville, scroll, transpose | Laid out, not wired | Phase 2. |
| Live Mode | Not built | Phase 2. |
| Add a Song, paste, edit, delete, import/export | Not built | Phases 3 and 4. |

## (c) Calls that need Brian before later phases

None of these blocked Phase 1. What this build did is stated so it can be changed.

1. **Shell ••• on My Songs and Setlists.** The spec lists Edit and Delete for a song, and the screenshots also show a shell •••. While a song is open, both ••• buttons open Edit and Delete. On the two lists, the shell button is there for the header and has no items, because the spec never says what that menu holds.

2. **Where `keyNote` and `tempoNote` print.** The Chain Breaker screenshot's meta line is `Key: C major • Time: 4/4 • Tempo: ~78 bpm`, with no tempo note. Phase 1 prints that pattern (`Tempo: —` when `tempo` is null) and, when a note is non-empty, prints the stored `keyNote` / `tempoNote` at the bottom under "Key & tempo notes." That keeps the caveats on the sheet without pushing the bass table down. Say if they belong under the meta line, or off the sheet entirely.

3. **Text-size steps are not in the spec.** This build uses 85%, 100%, 115%, 130%, 150%, and 170%. 100% is the default. The buttons stop at the ends.

4. **Screen on does not take the wake lock yet.** It stores the preference and changes the pill. Re-acquire on visibility is Phase 2. Until then the screen can still sleep while the pill says On.

5. **A setlist row opens the song.** There is no Live Mode control in this phase.

6. **My Songs has no Add a Song entry in this phase.** Naming a song and pasting a sheet are Phases 4 and 3.

7. **List order is the export order** after dropping id 12, not alphabetical. The list screens themselves were not in the screenshots; they use the same dark shell and gold tab as the song screen.

8. **Chart type at phone width.** Chord and lyric columns stay monospace and the stored spaces are untouched, including leading spaces. The chart font shrinks so a line the length of Chain Breaker's longest line fits in the sheet at 100% (about 9px on a 390px-wide screen). A+ grows it, and only then does that chart area scroll sideways inside the paper. The page and the header do not. Prose notes wrap; they are not forced onto one mono line.

Edit and Delete are visible and do not change the library. The editor, delete, and the duplicate guard around new songs are Phase 3.
