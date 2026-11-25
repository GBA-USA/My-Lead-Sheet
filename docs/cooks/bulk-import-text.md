# Cook brief: `bulk-import-text`

Not queued. This brief waits for the owner's review. Model: Opus. Plan: `docs/PLAN-bulk-import.md`.

```text
## HANDOFF
GOAL: A signed-in player picks or drops a pile of text files and documents (.txt, ChordPro, .html, .rtf, .docx, or a .zip of them) and gets a review list, one row a file, that says Looks good, Check this or Couldn't read. One tap saves every good row to My Songs, and each saved song opens with no network.
DECIDED: one cook, one branch, cook/bulk-import-text off mls-int-20261113 after PR 116 (song-paste-autofill) has merged; every file's text goes through readPaste, which stays the only reader of chart rules; the review list lives in memory; Fix opens the one SongEditor; a title may come from the file name; a duplicate is flagged by songYouHave and waits for Keep both, Replace or Skip (plan decision D6); Save writes the library once with addOwnSongs; the file picker has no accept filter.
REJECTED: a second chart parser or a second chord rule; a second editor or a second preview; a draft store for the list; any network call; a catalog lookup for each file; PDFs, photos and MusicXML, which are later cooks; new libraries; any change to what is shared; real charts as fixtures; edits outside the owned files.
DONE MEANS: cases U1 to U11, X1 to X12 and B1 to B12 of the plan each have a named check line that failed on the tests-only commit and passes now; every box under "Verification for the flow" in section 1 and "Verification for the batch" in section 4 is ticked with its evidence in the report; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-bulk-import.md sections 1, 2 (tier 1) and 4.
NEEDS OWNER: none to start. The owner reviews the flow on a phone before merge. The sample files of plan section 7 make the live script useful and do not block the cook.
```

# Import a pile of text files and documents

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full.

## What the player can do

1. On My Songs, tap **Import files** under `+ Add a song`, or drag files onto the page.
2. Pick any mix of `.txt`, ChordPro, `.html`, `.rtf`, and `.docx` files, or a `.zip` of them.
3. Watch **Reading 7 of 40**, then see one row for each file with **Looks good**, **Check this**, or **Couldn't read**, and the reason in one line.
4. Type a title on a row. Tap a row to see the real sheet. Tap **Edit** to fix it in the song editor. Tap **Skip** to set it aside.
5. For a song already in My Songs, choose **Keep both**, **Replace**, or **Skip**.
6. Tap **Save 31 songs**. The songs are in My Songs and open with no network.

## Tests first

Commit 1 holds `scripts/check-song-import.ts` and its one `package.json` line, and nothing else. Every case fails on that commit. Paste the failing run into the report.

The cases are U1 to U11 in plan section 1, X1 to X12 in plan section 2, and B1 to B12 in plan section 4. Each case prints one named `ok` or `FAIL` line.

The check builds its own files. It writes a real `.docx` and a real `.zip` with `node:zlib`, with at least one deflated entry. It hands files to the picker with the browser's own file-input command through `scripts/chrome.ts`. It starts no Worker, and signs in against a stub `/api/me` as `scripts/check-song-paste.ts` does.

## Owned files

| File | Change |
|---|---|
| `src/song-import.ts` | New. Pure. The types of plan section 1, `kindOf`, `decodeText`, `titleFromName`, `draftOf`, `judge`, the row reducer, the limits, the monospace font names. |
| `src/import-read.ts` | New. `unzip`, the readers for text, HTML, RTF, and `.docx`, and the `READERS` table. |
| `src/song-import.tsx`, `src/song-import.css` | New. The sheet, the list, the row preview, the `MESSAGES` maps. |
| `src/storage.ts` | Add `addOwnSongs`. Nothing else. |
| `src/song-editor.tsx` | `SongEdit` gains `"import"`, `SongEditors` mounts the sheet, and `SongEditor` takes a start draft and a callback for a saved id. |
| `src/song-paste.ts` | Add the `export` keyword to `chordRowOf` and `storedChord`. Change no rule. |
| `src/library-lists.tsx`, `src/App.tsx` | The **Import files** button and the page drop. At most three new lines in `src/App.tsx`, which must stay at 500 lines or fewer. |
| `scripts/check-song-import.ts` | New. |
| `scripts/song-import-live.ts` | New. Reads a folder given as an argument and prints one line for each file: kind, mark, reasons, chord count. It prints no chart text. |
| `scripts/check-one-copy.ts` | New rows for `unzip` and `decodeText`. |
| `package.json` | One line, `check:song-import`. |

Do not touch: any rule in `src/song-paste.ts`, `src/song-text.ts`, `src/sheet.tsx`, `src/song-search.ts`, `src/song-search.tsx`, `src/backup.ts`, `src/phone-db.ts`, worker files, and earlier check scripts apart from the new rows in `scripts/check-one-copy.ts`.

## Shapes to freeze

`ImportKind`, `Extracted`, `Doubt`, `Reader`, `Unread`, `Draft`, and `ImportRow` as plan section 1 gives them. Cooks 2, 4, and 5 import them. `READERS` is a record from kind to reader or `null`. A later cook adds a reader by changing one line.

## Empty and error states, and the wired flow

Every state in the table "What the player sees when something is missing" in plan section 1, and every reason in the two tables of plan section 4, has its words on the screen. A signed-out visitor sees no button and a drag does nothing. Closing with unsaved rows asks once. A refused write keeps every unsaved row in the list under the landed message.

Flow: My Songs, **Import files**, **Choose files**, the list, a title fix, **Save 3 songs**, **Close**, the songs are in My Songs.

## Checks

`npm run build`, `check:song-import`, `check:new-song`, `check:song-paste`, `check:song-search`, `check:storage`, `check:chords`, `check:screens`, `check:phone-layout`, `check:one-copy`, `check:portable`.

## Hints

- Worth writing `src/song-import.ts` and its node cases before any screen. The reducer and `judge` carry the rules, and the sheet only draws them. High.
- Worth one `try` around each file and one timer for each read, in one function. Case B2 fails if a reader can hold the loop. High.
- Worth testing `unzip` on a `.docx` that Word saved, if the laptop has one. The plan's prototype read Word's own files with `DecompressionStream("deflate-raw")` in 40 lines. High.
- Worth reading the kind from the first bytes before the name. A phone can hand over a file with no extension. High.
- Worth keeping the sheet out of the main script with `import()` if the size box fails. The main script is 225.6 KB gzipped today. Medium.
- Count the lines of `src/App.tsx` before the first edit. It has 490 and the limit is 500. Medium.
- React 19 runs click effects after the tap. Open the picker inside the click handler. Medium.
- `check:screens` bans component names as visible words. Read it before naming a label. Medium.
- A table in a `.docx` can hold chords in one row and words in the next. Reading each table row as one line of text is enough for this cook. Low.
