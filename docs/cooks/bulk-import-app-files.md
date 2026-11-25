# Cook brief: `bulk-import-app-files`

Not queued. This brief waits for the owner's review and for the owner's answer on which chord apps matter. Model: Opus. Plan: `docs/PLAN-bulk-import.md`.

```text
## HANDOFF
GOAL: A MusicXML file (.musicxml, .xml or .mxl) in an import pile becomes a lead sheet with its chords, words, key, time and tempo. Each other chord-app format the owner named has a reader, or a plain refusal that says how to export a file the app can read.
DECIDED: one cook, one branch, cook/bulk-import-app-files off mls-int-20261113 after bulk-import-text has merged; MusicXML is read with DOMParser and unzip; a harmony element becomes a bracket chord at its syllable, or a bar row when the part has no words; a format is built only when the owner supplied a real file of it.
REJECTED: a reader built from memory of a format with no sample file; a database reader for a backup file; notes, rests or staves on the sheet; new libraries; edits outside the owned files.
DONE MEANS: cases M1 to M8 in the brief each have a named check line that failed on the tests-only commit and passes now; the live box in the brief is ticked with its evidence in the report; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-bulk-import.md section 2 (tier 4) and section 7.
NEEDS OWNER: the list of apps and one exported file from each. With no answer, the cook builds MusicXML alone.
```

# Import MusicXML and files from other chord apps

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full.

## What the player can do

1. Pick a MusicXML file in the same pile as any other file.
2. See it as a row with its title, key, time, and tempo filled in, its chords over its words, or its chords in bars when the file has no words.
3. Pick a file from another chord app. See a sheet if the format is built, or one line that says how to export a text file or a PDF from that app.

## Tests first

Commit 1 holds `scripts/check-song-import-apps.ts` and its one `package.json` line, and nothing else. Every case fails on that commit. Every MusicXML file in the check is written for the check, with made-up words and a made-up tune.

- M1. `kindOf` names MusicXML from its root element, `score-partwise` or `score-timewise`, and a `.mxl` from the zip entry that its `META-INF/container.xml` names.
- M2. A part with `harmony` elements and no words gives bar rows, one bar for each measure, with a section break at each double bar or rehearsal mark.
- M3. A part with words gives each line of words with each chord in brackets before the syllable sung where the chord falls.
- M4. A `harmony` with a root, an alteration, a kind, and a bass gives the stored chord spelling, for major, minor, dominant seventh, major seventh, minor seventh, diminished, half-diminished, augmented, suspended fourth, and a slash bass. Each spelling passes `isChord`.
- M5. Title, composer, key, time, and tempo are read from `work-title` or `movement-title`, `creator`, `key`, `time`, and `sound`. A missing one is left blank.
- M6. A file with two parts uses the first part that has `harmony` elements. A file with none is refused with **This file has notes and no chords, so there is no chart to make.**
- M7. A damaged XML file and a `.mxl` with no score inside are refused as damaged, and the other rows in the pile are not affected.
- M8. Each format the owner named and this cook did not build is refused with its own line that names the export to use.

## Owned files

| File | Change |
|---|---|
| `src/import-musicxml.ts` | New. `DOMParser`, then the measures, then chart text. |
| `src/import-read.ts` | One `READERS` line for each new kind. |
| `src/song-import.ts` | The new kinds in `kindOf`, and one reason word for each format that is named and not built. |
| `src/song-import.tsx` | The words for the new reasons. |
| `scripts/check-song-import-apps.ts` | New. |
| `scripts/song-import-live.ts` | The new kinds. |
| `package.json` | One line, `check:song-import-apps`. |

Do not touch: `src/song-paste.ts`, `src/storage.ts`, `src/song-editor.tsx`, `src/App.tsx`, worker files, and earlier check scripts.

## Formats beyond MusicXML

The plan knows these formats only from memory. Build one only from a real file the owner supplied, kept outside the repo. Write down what the file holds in the report before writing its reader.

| App | What to expect, from memory | Without a sample file |
|---|---|---|
| OnSong | Text files with a title line, an artist line, and ChordPro-style brackets. Cook 1 already reads these as text. Its backup file is a database. | Refuse the backup with a line that says to export songs as text or PDF. |
| SongBook | A backup file that is an archive of song text. | Refuse with a line that says to export as ChordPro. |
| iReal Pro | Chord-only charts in a coded text form, inside a link or an HTML export. | Refuse with a line that says to export as PDF or MusicXML. |

## Verification

- [ ] Unit. `npm run check:song-import-apps` prints M1 to M8 as `ok`. Each failed on the tests-only commit.
- [ ] Live. In the built app at 390 px, import a MusicXML lead sheet exported from a notation program. Pass when the row says **Looks good** or **Check this** with a true reason, and the saved sheet shows the same chords in the same bars as the program does.
- [ ] Perf. No timed path changes outside the new reader. The cook measures the read of a 200-measure file once at 4 times CPU slowdown, writes the number in the report, and fails above 3 seconds.

## Checks

`npm run build`, `check:song-import-apps`, `check:song-import`, `check:chords`, `check:one-copy`, `check:portable`.

## Hints

- Worth writing bar rows in the form the built-in songs use, because `parseSheet` already reads a line that starts with `|`. High.
- Worth one table from MusicXML chord kind to stored spelling, checked by case M4, so a new kind is one row. High.
- A lyric syllable carries `begin`, `middle`, `end`, or `single`. Join `begin` to `end` with no space, so a chord can land inside a word. Medium.
- A repeat or an ending in the file is written out in song order, because the sheet scrolls in song order. Medium.
- A `.mxl` file is a zip. Use `unzip` from `src/import-read.ts`, and do not copy it. Medium.
