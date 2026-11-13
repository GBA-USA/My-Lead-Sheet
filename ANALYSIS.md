# Lead Sheets — analysis

The behavior spec is `docs/handoff/lead-sheets-app-handoff.md`. The build plan is `docs/handoff/lead-sheets-build-plan.md`. Where they disagree on behavior, the spec wins. Where they disagree on data, `docs/handoff/lead-sheets-data-export.json` wins. This note covers the three things the plan asked for before Phase 1, the calls Phase 1 had to make, and what the code builds now (Phases 1 and 2 plus the sheet metronome).

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

2. **Null tempos on ids 5 and 13 are correct.** Id 5 (`Take Me Out`) has two tempos, recorded in `tempoNote` (`verse ~122 bpm, riff ~104 bpm`). Id 13's recording BPM is unverified; `tempoNote` says so. The export also has `tempo: null` on id 12 because that row is empty. After the drop, the only null tempos are 5 and 13. Nothing in the app invents a BPM for them. The 90 BPM auto-scroll fallback is a scroll speed, not a displayed tempo, and the metronome stays unset for them until a speed is typed.

3. **`keyNote` is usually empty.** It is set on songs 1 (capo charts), 3 (sounds Eb), 7 (`E-centered`, which repeats the parenthetical already in `keyLabel`), 14 (enharmonic Gb), and 15 (Mixolydian / bVII). Stored text is unchanged.

4. **`tempoNote` is set on songs 5, 9, 10, 11, and 13.** Chain Breaker's note (analysis reads 156, play 78) is real. It is not on the Key / Time / Tempo line in the phone screenshot, which reads `Tempo: ~78 bpm`.

5. **Bar lines are not all pipe charts.** Song 8's intro bar string is `Bb   Gm   F   Bb`, on the same line object as a note. It is rendered as stored.

6. **No "(didn't come through)" placeholder is in this export.** Songs 14–16, the generator's proof sheets, are complete. A `note` line is printed verbatim, so a later placeholder would show up as written.

7. **Songs 12 and 13 are not the same string.** `no half steppin` / `sean costello` versus `No Half Steppin'` / `Sean Costello` (ASCII apostrophe). Keeping 13 is the spec's rule.

8. **Nashville spellings stay per song** (`6` and `6m`, `5 over 3`, `5 / b7`, `1, 3rd in bass`, flats). The stored text is not rewritten. The table's Nashville column prints the key-degree number (`5/7` for G/B in C) and, when the stored phrase differs, the phrase beside it in grey.

## (b) Component map

| Spec surface | State | Where it lives |
| --- | --- | --- |
| Shell: back, "Lead Sheets", ••• | Built | `App` header. Back returns to the list the song was opened from, and from Live Mode to Setlists. There is no second "← Songs" control. |
| My Songs / Setlists tabs | Built | 36px tabs in `App`. Hidden in Live Mode. |
| My Songs list | Built | `SongList`. Title, artist, key, tempo. Tap opens the sheet. |
| Setlists list | Built | `SetlistList`. Name, songs in performance order, and a Live link per setlist. Tap a song to open it. |
| Song view | Built | `LeadSheet`: title, source, key/time/tempo, metronome, feel, bass-note table, how to play, chart, at a glance, practice tip, key & tempo notes. |
| Sticky song header | Built | `SongControls`, outside the scroll region so it sits under the tab bar and cannot slide under it. The sheet scrolls in `#sheet-scroll`. |
| Phone header, three rows | Built | Text size, Screen on, ••• · Notes \| Nashville and scroll on one line · compact transpose strip. |
| Tablet header (768px and up) | Built | Those controls step up; the transpose strip joins the notation/scroll row. Steppers and Original Key stay 32px. |
| A− / A+ | Built | Scales the sheet. Preference key `leadSheetsTextScale`. |
| ••• Edit / Delete | Menu only | `OverflowMenu` on the song header, and the shell ••• while a song is open. Both items close the menu and do not change the library. |
| Screen on | Built | `useWakeLock`. While the pill is On it asks for the screen wake lock, and asks again when the page becomes visible. Missing support and refusals are silent. Preference key `leadSheetsKeepAwake`, default on. |
| Notes \| Nashville | Built | Saved per song in `leadSheetsNotation`. Nashville mode prints key-degree numbers on the chart, at a glance, and the table. |
| Transpose | Built | Per open song, not saved, back to 0 on a song change. Original Key resets it. It moves the key line, chart, at a glance, and the table's chord and bass-note columns. How to play, the practice tip, and the "easiest place" column stay in the original key and say so. |
| Auto-scroll | Built | `useAutoScroll` scrolls `#sheet-scroll` at the stored tempo (90 BPM when it is null) × 0.25 px/s × the scroll percentage (20–200%, steps of 5, saved per song in `leadSheetsScrollPercent`). Grabbing, the wheel, or a manual scroll pauses it. It stops at the bottom. |
| Metronome | Built | `MetronomeControl` on the sheet, under the key/time/tempo line. Opens on the song's stored BPM, or unset when that is null. Tap the number to change speed, double-tap Metronome to start or stop. The speed is not saved and does not feed auto-scroll. While it plays, a small red dot at the sheet's top right lights on each click. If the browser refuses to start audio, the pad goes back to Stopped. |
| Live Mode | Built | `#/live/<setlist>/<index>`. Plays a setlist as full sheets with Prev / Next and `name · n/total`. |
| Add a Song, paste, edit, delete, import/export | Not built | Phases 3 and 4. |

## (c) Calls that need Brian before later phases

None of these blocked Phase 1. What the build does is stated so it can be changed.

1. **Shell ••• on My Songs and Setlists.** The spec lists Edit and Delete for a song, and the screenshots also show a shell •••. While a song is open, both ••• buttons open Edit and Delete. On the two lists, the shell button is there for the header and has no items, because the spec never says what that menu holds.

2. **Where `keyNote` and `tempoNote` print.** The Chain Breaker screenshot's meta line is `Key: C major • Time: 4/4 • Tempo: ~78 bpm`, with no tempo note. Phase 1 prints that pattern (`Tempo: —` when `tempo` is null) and, when a note is non-empty, prints the stored `keyNote` / `tempoNote` at the bottom under "Key & tempo notes." That keeps the caveats on the sheet without pushing the bass table down. Say if they belong under the meta line, or off the sheet entirely.

3. **Text-size steps are not in the spec.** This build uses 85%, 100%, 115%, 130%, 150%, and 170%. 100% is the default. The buttons stop at the ends.

4. **Screen on is a preference, not a guarantee.** The pill shows the saved choice. If the browser has no wake lock or refuses it, the pill still says On and the screen can sleep. The spec asks for silence here, so there is no hint.

5. **A setlist row opens the song.** Live Mode starts from the Live link beside the setlist name.

6. **My Songs has no Add a Song entry in this phase.** Naming a song and pasting a sheet are Phases 4 and 3.

7. **List order is the export order** after dropping id 12, not alphabetical. The list screens themselves were not in the screenshots; they use the same dark shell and gold tab as the song screen.

8. **Chart type at phone width.** Chord and lyric columns stay monospace and the stored spaces are untouched, including leading spaces. The chart font shrinks so a line the length of Chain Breaker's longest line fits in the sheet at 100% (about 9px on a 390px-wide screen). A+ grows it, and only then does that chart area scroll sideways inside the paper. The page and the header do not. Prose notes wrap; they are not forced onto one mono line.

Edit and Delete are visible and do not change the library. The editor, delete, and the duplicate guard around new songs are Phase 3.
