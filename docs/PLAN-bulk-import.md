# Plan: drop a pile of files, get lead sheets

Written Nov 24, 2026 against `b2b248a` on `mls-int-20261113`. This plan changes no app code.

## Summary and landing order

The goal is one flow. A player picks or drops a pile of mixed files, and each file becomes a lead sheet that is saved on the phone and works offline.

Today a song enters the app one at a time. The player types it, pastes it, or picks it from the song search. The app has no file picker for charts and no drop zone. The only file inputs are a band file in Band settings and an audio file in Learn.

After the cooks below, the flow is this:

1. On My Songs the player taps **Import files**, or drags files onto the page.
2. Each file is read on the phone and turned into text. The text goes through `readPaste` in `src/song-paste.ts`, the same reader that a paste uses.
3. A review list shows one row for each file. A row says **Looks good**, **Check this**, or **Couldn't read**, with the reason in plain words.
4. The player fixes a title on the row, opens a row in the song editor, or skips it.
5. **Save** writes every good row to My Songs in one step. A row with no title is never saved. A song the player already has is flagged and waits for a choice.
6. Every saved song is an ordinary own song. It opens with no network.

Text files, documents, and PDFs with real text never leave the phone. A photo or a scan is the one case that needs a server, and the player is told before anything is sent.

The cooks land in this order.

| Order | Cook | Tier | What the player gains | Waits for |
|---|---|---|---|---|
| 1 | `bulk-import-text` | 1 | The whole flow, for `.txt`, ChordPro, `.html`, `.rtf`, `.docx`, and a `.zip` of those | PR 116 (`song-paste-autofill`) merged |
| 2 | `bulk-import-pdf` | 2 | PDFs with real text, with each chord over its word | cook 1, owner decision D1 |
| 3 | `bulk-import-photo-probe` | 3 | Nothing on screen. A measured answer on which reader and which model can read a photo of a chart, and what a page costs | owner decisions D2 and D4, the sample photos, an API key on the laptop |
| 4 | `bulk-import-photos` | 3 | Photos and scanned PDFs, read by a vision model after a clear notice | cooks 1, 2, and 3, owner decisions D2, D3, D4, and D5 |
| 5 | `bulk-import-app-files` | 4 | MusicXML and the files other chord apps write | cook 1, and the owner's answer on which apps matter |

Cook 3 touches no file that cooks 1 and 2 touch, so it can run beside them. Cook 2 branches after cook 1 merges, because it registers its reader in the table that cook 1 creates. Cook 4 branches after cook 2, because a scanned PDF page is drawn with the PDF library that cook 2 adds.

```text
PR 116 ──► bulk-import-text ──► bulk-import-pdf ──► bulk-import-photos
                    │                                      ▲
                    └──► bulk-import-app-files             │
bulk-import-photo-probe ───────────────────────────────────┘
```

The brief proposed three cooks. This plan has five. Section "Changes to the brief, and why" gives the reason for each split. The short version is that the first cook in the brief carried two separate risks, the review flow and PDF layout, and the PDF half needs a library that `CLAUDE.md` forbids today. A hold on that decision must not hold the flow.

After cook 1 the owner has the whole loop on a phone for text files and Word documents. After cook 2 the same loop covers the PDFs that chord sites and Word produce. Those two cooks need no server, no key, and no money.

## What was measured for this plan

Every number here comes from a run on Nov 24, 2026, on the owner's Windows laptop. Each run happened once. The test chart is one chart written for this plan, with made-up words, four sections, 27 chords placed over words, and 31 chord names in all. One chart is a small sample, so treat each count as a direction. The probe scripts are throwaway files in `%TEMP%\mls-bulk-import-proto` on the laptop, outside the repo. Cooks 1, 2, and 3 each commit a script that repeats their measurement on real files.

A chord counts as on the same letter when the saved sheet shows it over the letter it was written over. It counts as on the same word when it sits anywhere over the right word.

### PDFs with real text

Each PDF was read with `pdfjs-dist` 6.5.438. The probe grouped the text items into lines by their height on the page, placed each chord by its left edge over the nearest letter of the line below, wrote the result as inline bracket chords such as `[G]Walking`, and passed the text through the real `readPaste` and `parseSheet`.

| PDF | Made by | Same letter | Same word |
|---|---|---|---|
| Monospace chart | Edge, print to PDF | 27 of 27 | 27 of 27 |
| Chord site layout, each chord in a box over its words, Arial | Edge, print to PDF | 27 of 27 | 27 of 27 |
| Monospace chart | Word 16, save as PDF | 27 of 27 | 27 of 27 |
| Chart typed by eye in Arial, chords padded with spaces | Edge, print to PDF | 21 of 27 | 25 of 27 |
| The same file, with letter widths taken from a stand-in font | | 25 to 27 of 27 | 27 of 27 |

`readPaste` found the title, artist, key, tempo, and all four headings in every one of these PDFs.

What limits these numbers:

- A PDF gives the start and the width of a run of text, and no position for each letter. For a monospace line every letter has the same width, so even steps are exact.
- For a proportional line, even steps drift along a long lyric line. That drift is the 21 of 27. Measuring the same words in any sans or serif font on the device, then scaling to the run's real width, removed the drift. Four stand-in fonts were tried (Arial, Verdana, Times New Roman, Segoe UI), and each gave 27 of 27 on the same word.
- The stand-in rule must not be used on a monospace line. It dropped the Word monospace PDF from 27 of 27 on the same letter to 19 or 20, depending on the stand-in font.
- A sixth PDF shows the limit of the method. The monospace chart was set in Calibri in Word and saved as PDF, so the page itself shows the chords over the wrong words. The position reading put 6 of 27 chords over the right word, because it reads what the page shows. The column reading of the same text is right. Section 2 handles this case with two readings and a switch.

### Word and RTF files with no library

A `.docx` is a zip that holds XML. The probe read the zip directory by hand, inflated `word/document.xml` with the browser's own `DecompressionStream("deflate-raw")`, and took the text of each paragraph.

| File | Result | Time |
|---|---|---|
| `.docx` saved by Word 16, Courier New | Text equal to the typed chart, font name found | 41 ms, which includes the script's start-up |
| `.docx` saved by Word 16, Calibri | Text equal to the typed chart, font name found | 1 ms |
| `.rtf` saved by Word 16, 51 KB | Text equal to the typed chart | 3 ms |

A document gives text and font names, and no positions. So a chart typed by eye in a proportional font cannot be read by counting columns.

| Chart typed by eye in | Read by column | Measured in the same font | Measured in another font |
|---|---|---|---|
| Arial | 11 of 27 same word | 27 of 27 | 11 to 27 of 27 |
| Calibri | 8 of 27 | 27 of 27 | 21 to 25 of 27 |
| Times New Roman | 9 of 27 | 27 of 27 | 12 to 26 of 27 |

A phone seldom has Calibri. So a Word chart typed in a proportional font is a **Check this** file, and the same document saved as a PDF reads exactly.

### On-device OCR

The probe ran `tesseract.js` 7.0.0 with its English data on images of the same three layouts.

| Image | Chord names read exactly | Chords on the same word | Time on the laptop |
|---|---|---|---|
| Three clean renders, 2000 by 2600 pixels, no camera | 24 to 26 of 31 | 8 to 16 of 27 | 0.6 to 0.9 s |
| Three stand-ins for a phone photo (smaller, turned 1.5 degrees, soft focus, uneven light, JPEG) | 14 to 19 of 31 | 0 to 1 of 27 | 1.0 to 1.2 s |

The misses explain the gap between the two columns. `C` was read as `Cc`, `G` as `6`, and `D/F#` as `DIF#`. One wrong name on a chord row turns the whole row into words, so every chord on that row loses its place. The stand-in is not a real photo, and its uneven light produced noise words that a real photo may not. The clean render is the fair number. It is the best case, and it still loses one chord name in six.

No vision model was run. The laptop has no API key, and the plan has no real photo. Cook 3 exists to measure it.

### Sizes

| Item | Size | Source |
|---|---|---|
| The app's main script today | 225.6 KB gzipped | `npm run build` at `b2b248a` |
| `pdfjs-dist` reader plus its worker file | 136 KB plus 379 KB gzipped | `gzip -c` on the two `min.mjs` files |
| `tesseract.js` core plus English data | 1.06 MB gzipped plus 5.2 MB | the installed files |
| One song in `data/library.json` | 3.6 to 7.2 KB, median 5.3 KB | 15 songs |
| Backup caps on the server | 500 changes in one sync, 5,000 rows, 5 MB for each account | `worker/room-backup.ts` |

## Changes to the brief, and why

The brief gave the planner room to reorder, split, and swap methods. Each change is listed with its reason. None touches a fixed rule: planning only, no queue, title required, portability, offline after save, and no license or share design.

1. **Cook 1 of the brief becomes two cooks.** The brief put the drop zone, the review list, text files, and text PDFs in one cook. This plan lands the flow with text files and documents first, as `bulk-import-text`, and PDFs second, as `bulk-import-pdf`. The flow needs the owner's phone review. The PDF reader needs a library, which `CLAUDE.md` forbids, so it needs decision D1. Each half has its own proof, and a hold on D1 does not hold the flow.
2. **A measuring cook runs before the photo cook.** The brief asked for a recommended pick between on-device OCR and a vision model. On-device OCR was measured here and it fails. The vision model could not be measured, because the laptop has no API key and the plan has no real photo. `bulk-import-photo-probe` commits a script that scores each reader on photos with a known right answer, and reports the cost of a page from the service's own token counts. The photo cook then builds against a measured reader and model.
3. **Vision AI is the pick for photos, as the chief of staff leaned.** The reason is now a number. On a clean render with no camera, on-device OCR read 24 to 26 of 31 chord names, and one wrong name loses a whole row. On-device OCR would also add 6 MB to the app. Section 3 gives the full comparison.
4. **Text files, documents, and text PDFs never use the vision model.** A PDF with real text is read on the phone with exact positions. Sending it to a model would cost money, would send the file off the phone, and would be less exact.
5. **A reader that knows positions writes inline bracket chords.** A PDF reader knows where each chord sits. It writes `[G]Walking down the [D]lantern road`, which `readPaste` already reads, and never a chord row padded with spaces. A chord row would pass through the rules that guess whether a paste is a phone's copy of a chord page, and a guess is not needed when the position is known.
6. **A doubtful file keeps two readings.** When the position reading and the column reading of one file disagree, the row is **Check this** and offers **Try the other reading**. The measurements show a case where each reading is the right one.
7. **A `.zip` is a tier 1 format.** A `.docx` is a zip, so cook 1 already carries a zip reader. A dump often arrives as one zip from a mail or a cloud folder. Each file inside becomes its own row.
8. **Tier 4 is held until the owner names the apps.** MusicXML is specified here. The backup formats of OnSong and SongBook are known to this plan only from memory, and each needs a real file to build against. iReal Pro is added to the list, because bass players use it and its charts are chords only. Text exports from those apps (`.onsong`, `.cho`, `.crd`, `.chopro`, `.pro`, `.chordpro`) are plain text and belong to cook 1.
9. **The file picker has no `accept` filter, and a file's kind is read from its first bytes.** A phone's picker can grey out a file with an extension it does not know, such as `.cho`. A file name can also be wrong. The first bytes of a PDF, a zip, an RTF, a JPEG, and a PNG are fixed and cheap to test.
10. **Fix opens the one song editor.** A row that needs more than a title opens in `SongEditor`, with its own preview and its own save path. No second editor and no second preview are built.
11. **A title can come from the file name.** `Wagon Wheel.txt` has a title. A camera name such as `IMG_2041.jpg` does not, so that row has a blank title and cannot be saved until the player types one. The rule that nothing saves without a title is unchanged.
12. **The review list lives in memory, with no draft store.** Saving good rows is one tap, so the rows at risk are the few that need a fix. After a reload the player picks the same pile again. Rows that were saved come back flagged **You already have this**, so the second pass shows only what is left. A draft store would add a table, a privacy page entry, and an account-switch rule for little gain.
13. **Save writes the library once.** `addOwnSong` rewrites the whole stored library for each song. Cook 1 adds `addOwnSongs`, which adds every song in one write.
14. **The PDF library is not in the offline cache list.** The service worker downloads every listed file again on each deploy. The PDF library is 515 KB gzipped, more than twice the app's main script. It loads the first time a PDF is imported and is cached then. Importing is not a stage task, and a saved sheet needs none of it.
15. **Fixtures are made inside each check, and real files stay off the repo.** A check writes a real `.docx` with `node:zlib` and prints a real PDF with headless Chrome, from charts with made-up words. The owner's real files are copyrighted charts. They stay in a folder outside the repo, and a committed script reads that folder and prints counts with no chart text.
16. **No catalog lookup for each file.** PR 116 looks up a missing title or artist after a paste. A batch of 40 files would send 40 requests to a catalog that allows one a second and often answers 503. The lookup still runs when a row is opened in the editor.
17. **Screen checks use the repo's Chrome driver.** `CLAUDE.md` says no new libraries. Every screen check drives headless Chrome through `scripts/chrome.ts` and `scripts/app-page.ts`.

### Things in the brief or the repo that look wrong

- **`CLAUDE.md` says no new libraries, and the brief asks for PDFs.** Both cannot hold. A hand-written PDF reader would need font decoding, compressed object streams, and encryption handling, and it would be wrong on real files. Decision D1 asks for one named exception.
- **The brief calls `.docx` easiest and most reliable.** The text of a `.docx` is exact. The chord positions are not, when the chart was typed by eye in a proportional font. The column reading put 8 to 11 of 27 chords over the right word. A PDF of the same document is more reliable than the document.
- **PR 116 has not merged.** At the time of reading, `origin/cook/song-paste-autofill` is six commits ahead of `mls-int-20261113` and its PR is open. It edits `src/song-editor.tsx` and `src/storage.ts`, which cook 1 also edits, and it makes `writeOwnSong` refuse a song with no title. Cook 1 branches after it merges.
- **The whole library is one `localStorage` value.** Bulk import is the first feature that can fill it. At the median 5.3 KB a song, 500 songs are about 2.7 MB. From memory, a browser allows about 5 MB for a site. The backup also caps one sync at 500 changes and one account at 5 MB. Cook 1 measures where the write is refused and handles the refusal. A move to a larger store is its own cook and is not in this plan.
- **HEIC is listed as a format.** From memory, only Safari can open a HEIC photo, and an iPhone's picker usually hands the browser a JPEG. Cook 4 opens a HEIC where the browser can, and says so plainly where it cannot.
- **`+ Add a song` is shown only to a signed-in player.** `src/App.tsx` passes `onAdd` only when there is an account. Import follows the same rule, so a signed-out visitor sees no import button. Nothing in import itself needs the server until cook 4.
- **`legal/TERMS-DRAFT.md` is still not in the repo.** The song-search plan flagged it on Nov 23. Section 5 uses the copyright rule as the brief states it.

## Decisions the owner must make

Cooks 1 and 5 need no decision. Cook 2 needs D1. Cooks 3 and 4 need the rest.

| Id | Decision | Recommended answer | What waits for it |
|---|---|---|---|
| D1 | May the app add one library, `pdfjs-dist`, to read PDFs? It is Mozilla's PDF reader, under the Apache 2.0 license. It runs on the phone and sends nothing anywhere. `CLAUDE.md` says no new libraries. | Yes, as a named exception. It loads only when a PDF is imported. | Cook 2, and scanned PDFs in cook 4 |
| D2 | May a photo or a scan that the player picks be sent, through the app's own Worker, to an AI service to be read? The player sees a notice and taps to agree for each batch. The Worker stores no image and no reading. | Yes | Cooks 3 and 4 |
| D3 | Which model reads photos, and what limits bound the spend? Section 3 gives an estimate for each model, from under 1 cent to about 8 cents a page. The limits are pages for each account each day, and pages for the whole app each month. | Decide after cook 3 reports. Until then the plan assumes Claude Opus 5.5, 60 pages a day for an account, and 2,000 pages a month for the app, which is at most about 160 dollars a month at the high estimate. | Cook 4 |
| D4 | May the Worker and the probe script use the official `@anthropic-ai/sdk` package? It is the second library exception. The other path is hand-written requests, which lose the typed errors and the retry rules. | Yes | Cooks 3 and 4 |
| D5 | Should the privacy page say that a photo picked for import is sent to an AI service to be read? | Yes, one entry. The words must be true. They must not say the service keeps nothing, because the service's own terms set that. | Cook 4 |
| D6 | A row that matches a song the player already has is not saved by **Save**. It waits for **Keep both**, **Replace**, or **Skip**. | Yes. Cook 1 builds this default. | Nothing |
| D7 | A sheet read from a photo is always **Check this**, never **Looks good**, and its row shows the photo beside the sheet. | Yes | Nothing |
| D8 | A song the player made is shared whole today, words included. Bulk import will put many copyrighted charts in own libraries. Which sharing rule holds for an imported chart? The song-search plan asked the same question as its D4. | The owner decides before bulk import reaches players. No cook in this plan changes sharing. | Nothing in this plan |
| D9 | Should a signed-out visitor be able to import? Today a signed-out visitor cannot add a song at all. | No change. Import follows `+ Add a song`. | Nothing |
| D10 | The review list is kept in memory alone (change 12). A reload, or a phone that unloads the page in the background, loses every row that was not saved, with any title typed on it. Should the list survive a reload? | No, for now. Saved songs are safe, and the same pile picked again flags them. A stored list needs a store, a privacy page entry, and an account-switch rule. Decide again after the phone review of cook 1. | Nothing. Cook 1 builds this default. |

D1 is the answer the queue needs first. D2 and D4 let cook 3 start as soon as the sample photos exist.

Cook 4 needs one secret, the API key for the reading service. The owner sets it with `wrangler secret put`. No cook writes it to a file, a brief, a log, or a commit.

## 1. End-to-end UX: from a pile of files to saved sheets

### The flow

There is one way to import files. It starts on My Songs.

1. **Open.** Under `+ Add a song` sits a second button, **Import files**. On a computer, dragging files anywhere onto My Songs opens the same sheet with those files. The sheet has one large **Choose files** button, which is also the drop target. No drop zone exists in the app today, so this one is the first and the only one.
2. **Pick.** The phone's own picker opens with multiple selection and no type filter. The player can pick documents, PDFs, and photos in one go. A `.zip` counts as a pile and is opened into its files.
3. **Read.** The sheet reads the files one after another and shows **Reading 7 of 40**. Rows appear as they finish. **Stop** ends the reading and keeps the rows that are done.
4. **Review.** Each file is one row. The row shows the file name, an editable **Title** field, the artist when one was found, and one of three marks.
   - **Looks good.** The sheet has a title, at least one section, and chords, and nothing about it is in doubt.
   - **Check this.** The sheet can be saved, and something needs a look. The row says what in one line.
   - **Couldn't read.** No sheet came out. The row says why in one line. Section 4 lists every reason.
5. **Fix or skip.** Tapping a row opens a preview of the real sheet, drawn with `LeadSheet`. From there **Edit** opens the song editor with the row's sheet, and **Skip** sets the row aside. A skipped row can be brought back with **Undo**.
6. **Save.** One button at the bottom says **Save 31 songs**. It saves every row that is **Looks good** or **Check this**, has a title, and is not a flagged duplicate. It never saves a **Couldn't read** row, a skipped row, or a row with no title.
7. **Done.** The sheet says **31 songs saved** and lists what is left, such as **4 need a title** and **2 couldn't be read**. **Close** returns to My Songs, where the new songs are in the list.

A saved song is an ordinary own song, written by `addOwnSongs` to the same stored library as a typed song. Scroll, metronome, transpose, setlists, and backup treat it as any other song. It needs no network from then on.

### The shapes

Cook 1 adds one pure module, `src/song-import.ts`, with no DOM and no network. It holds the types that every later cook imports.

```ts
/** What a file is, from its first bytes, then its name. */
export type ImportKind = "text" | "html" | "rtf" | "docx" | "zip" | "pdf" | "image" | "musicxml" | "unknown";

/** What a reader got out of one file. `other` is a second reading of the same file, when the reader has one. */
export type Extracted = { text: string; other?: string; doubts: Doubt[]; title?: string };
export type Doubt = "fonts" | "two-readings" | "photo" | "many-pages";

/** One reader for each kind. A reader throws `Unread` with a reason. A kind with no reader yet is `null`. */
export type Reader = (bytes: Uint8Array, name: string) => Promise<Extracted[]>;
export class Unread extends Error { constructor(readonly reason: UnreadReason) { super(reason); } }

/** The song a row would save. The same fields as the editor's form. */
export type Draft = { title: string; artist: string; keyRoot: string; keyMode: KeyMode; bpm: string; timeSignature: string; chart: string; keyNote: string };

export type ImportRow = {
	id: string;
	name: string;
	state:
		| { is: "waiting" }
		| { is: "reading" }
		| { is: "ready"; draft: Draft; other?: Draft; verdict: "good" | "check"; reasons: CheckReason[]; duplicate?: Duplicate; skipped: boolean }
		| { is: "unread"; why: UnreadReason }
		| { is: "saved"; songId: number };
};
```

A reader returns a list, because one file can hold more than one song. A `.zip` gives one entry for each file inside, and a ChordPro file gives one for each `{new_song}` part.

Three pure functions do the judging, and the sheet only draws their results.

| Function | What it decides |
|---|---|
| `kindOf(bytes, name)` | The kind, from the first bytes, then from the extension |
| `draftOf(extracted, name)` | Runs `readPaste` on the text and fills a `Draft`. The title comes from the paste, then from the reader, then from the file name by `titleFromName` |
| `judge(draft, extracted, songs, rows)` | The verdict, the reasons, and the duplicate flag |

`titleFromName` drops the extension, a trailing copy mark such as `(1)`, and words such as `chords` and `lyrics`. It turns `_` and `-` into spaces. It returns an empty title for a name that carries no title, such as `IMG_2041`, `Scan0003`, `Screenshot 2026-11-02`, `Document`, or digits alone.

### What the player sees when something is missing

Each row names the required case that proves it. `npm run check:bulk-import-plan` fails on a row with no case.

| When | What happens | Cases |
|---|---|---|
| Signed out | No **Import files** button, as with `+ Add a song` today. A drag onto the page does nothing. | U1 |
| A second account on the same phone | The review list is in memory and belongs to the sheet. When the session ends or a second account signs in, the sheet closes with no question and its rows are gone. It stays closed until that account taps **Import files**. Saved songs follow the rules for own songs. | U12 |
| No files picked, or the picker is closed | The sheet stays on **Choose files**. | U13 |
| Every file failed | The list shows each reason, and the bottom button is disabled and says **Nothing to save**. | B3 |
| A row with no title | The **Title** field is outlined and says **Add a title**. The row is not counted in **Save 31 songs**. | U3 |
| The phone refuses the write | The rows that were saved are marked saved. The rest stay as they are, under the landed message **This phone couldn't save the song. Free some space and try again.** | B8 |
| The app is unloaded during review | Saved songs are in the library. The player picks the pile again, and each saved song comes back flagged **You already have this**. | B11 |
| Closing with unsaved rows | The sheet asks once, **Leave without saving 6 songs?** | U9 |

The sheet's rows must not outlive the account that picked them. `SongEditors` takes the account's user id and mounts the sheet only while there is one, with `key` set to that id, as `src/App.tsx` does for `MySetlistCodeSheet`. It calls `onClose` when the id changes while the sheet is open.

### Where each part lives

| Part | File | Cook |
|---|---|---|
| Kinds, rows, verdicts, duplicates, title from a file name, limits | `src/song-import.ts` | 1 |
| Readers for text, HTML, RTF, `.docx`, and zip | `src/import-read.ts` | 1 |
| The sheet, the list, the row preview | `src/song-import.tsx`, `src/song-import.css` | 1 |
| One write for many songs | `src/storage.ts` (`addOwnSongs`) | 1 |
| The editor opened on a row | `src/song-editor.tsx` | 1 |
| The button and the page drop | `src/library-lists.tsx`, `src/App.tsx` | 1 |
| Lines and chord positions from placed text | `src/import-layout.ts` | 2 |
| The PDF reader | `src/import-pdf.ts` | 2 |
| A photo made ready to send, the notice | `src/import-photo.ts`, `src/song-import.tsx` | 4 |
| The reading route and its limits | `worker/import-read.ts` | 4 |

### Required screen cases for cook 1

Screen cases run in headless Chrome through `scripts/chrome.ts`, at 360 px and 390 px. The check gives files to the picker with the browser's own file-input command.

- U1. **Import files** shows under `+ Add a song` for a signed-in player and is absent for a signed-out one.
- U2. Five files of five kinds, picked at once, give five rows in the picked order, each with its mark.
- U3. A row's **Title** field edits the title. Clearing it shows **Add a title**, and the count on the save button drops by one.
- U4. Tapping a row shows the real sheet with its headings. **Edit** opens the song editor with the row's title, key, and chart, and **Save** there marks the row saved and returns to the list.
- U5. **Skip** removes a row from the count, and **Undo** brings it back.
- U6. **Save 3 songs** adds three songs to My Songs. After a reload with the network off, each opens with its chart.
- U7. A second tap on the save button, and a second **Save** after it finished, add no song.
- U8. Chords sit over their syllables in the preview and on the saved sheet. The case reuses the measurement in `scripts/chord-anchors.ts`.
- U9. Closing with unsaved rows asks once. **Escape** closes through the same question, by `useEscape`.
- U10. Every control is at least 44 px tall and is not clipped at either width. No row scrolls sideways.
- U11. A drag of two files onto My Songs opens the sheet with two rows.
- U12. With two ready rows showing, the session ends with a 401. The sheet closes with no question. A second account then signs in. The sheet stays closed, that account's **Import files** opens on **Choose files** with no row, and the stored library holds no song from the pile.
- U13. A pick of no files, and a picker that is closed, each leave the sheet on **Choose files** with no row.

### Verification for the flow

- [ ] Unit. `npm run check:song-import` prints cases U1 to U13 as `ok`, with the cases of sections 2 and 4 that belong to cook 1. Commit 1 holds the cases alone, and each fails on that commit.
- [ ] Live. In the built app at 390 px, pick a `.txt`, a ChordPro file, a Word `.docx`, a file named `IMG_0001.txt`, and an empty file. Pass when three rows say **Looks good**, the fourth asks for a title, the fifth says **This file is empty.**, and **Save 3 songs** puts three songs in My Songs that open with the network off.
- [ ] Perf. Metric one is the gzipped size of the main script from `npm run build`. The baseline is 225.6 KB at `b2b248a`, measured again on the branch point. Fail above the baseline plus 15 KB. Metric two is the time from the pick of 100 generated text files to the last row, in Chrome at 4 times CPU slowdown. The flow is new, so there is no trunk baseline. The cook measures it first, writes the number in the report, and fails above 5 seconds.
- [ ] `check:new-song`, `check:song-paste`, `check:song-search`, `check:storage`, `check:chords`, `check:screens`, `check:phone-layout`, and `check:one-copy` pass with no edit to their scripts, apart from new rows in `check:one-copy`.
- [ ] The owner reviews the flow on a phone before merge, because it adds a button to My Songs.

## 2. Text extraction by format tier

### One rule for every reader

A reader turns bytes into the text that `readPaste` takes. It does not find sections, facts, or chord spellings. `readPaste` does that, and it stays the only place that does. No cook changes a rule in `src/song-paste.ts`. Cook 1 adds the `export` keyword to `chordRowOf` and `storedChord` there, so that a reader asks the paste rules what a chord row is and never keeps a second chord rule.

A reader does two things that `readPaste` cannot. It recovers the lines of the file, and it says where each chord sits when the file knows that. A reader that knows a chord's position writes the chord inline in brackets. A reader that has only columns passes the columns through, and adds a doubt when the columns cannot be trusted.

### Tier 1: text files and documents (`bulk-import-text`)

| Kind | Extensions and first bytes | How it becomes text | Doubts |
|---|---|---|---|
| Plain text and ChordPro | `.txt`, `.cho`, `.crd`, `.chopro`, `.chordpro`, `.pro`, `.onsong`, or no known first bytes and no zero byte | `decodeText`. A byte order mark picks UTF-8 or UTF-16. With none, UTF-8 is tried, and a file that is not valid UTF-8 is read as Windows-1252. A ChordPro file is cut at each `{new_song}` or `{ns}` line into one song each. | None |
| HTML | `.html`, `.htm`, or text that starts with `<!doctype html` or `<html` | `DOMParser`. `script`, `style`, `nav`, `header`, `footer`, and `form` are dropped. A block element and a `br` end a line. A `pre` keeps its spaces. The page's `title` is offered as the title. | None |
| RTF | `.rtf`, first bytes `{\rtf` | A small reader. `\par` and `\line` end a line, `\tab` is a tab, `\'hh` and `\uN` are characters, and the font table, pictures, and other hidden groups are dropped. | `fonts`, by the rule below |
| Word | `.docx`, a zip that holds `word/document.xml` | The zip reader, then the XML. Each `w:p` is a line, `w:tab` is a tab, `w:br` ends a line. | `fonts`, by the rule below |
| Zip | `.zip`, first bytes `PK` | The zip reader. Each file inside goes through `kindOf` and its own reader, and gives its own row, named with its path. A zip inside a zip is not opened. | None of its own |

The zip reader is one function, `unzip`, in `src/import-read.ts`. It reads the directory at the end of the file and inflates each entry with `DecompressionStream("deflate-raw")`, which every current browser has. The prototype did this in 40 lines on Word's own files. An old `.doc` file starts with different bytes and is refused with **This is an old Word file. Save it as .docx or PDF and try again.**

**The fonts rule.** A document names the font of each run. When a chord row over a lyric line is set in a font that is not monospace, columns are not positions. The reader then gives two readings.

- The first reading measures widths with the canvas. For each chord row that `chordRowOf` finds over a line of words, it measures the row up to each chord and finds the lyric letter at the same width. It uses the document's own font when `document.fonts.check` says the phone has that font, and a sans font when it does not. It writes the chords inline in brackets.
- The second reading, `other`, is the columns as typed.
- The row is **Check this** with the reason **Chords may sit over the wrong word. A PDF of this document keeps them in place.**

A document set in a monospace font has one reading, the columns, and no doubt. The list of monospace font names is one constant in `src/song-import.ts`.

### Tier 2: PDFs with real text (`bulk-import-pdf`)

The PDF library gives each run of text with its position, its width, and its font. `src/import-layout.ts` turns those runs into chart text. It is pure, with no DOM and no library, so it is tested in node with made-up runs. `src/import-pdf.ts` loads the library with `import()` and feeds it.

The rules of `src/import-layout.ts`, in order:

1. **Lines.** Runs whose baselines are within 2 points are one line. Lines are ordered top to bottom, and runs left to right.
2. **Letter positions.** In a monospace line every letter takes the same share of its run. In a proportional line, each letter's share comes from measuring the run's words in a font on the device, scaled so that the whole run keeps its real width. The measuring function is passed in, so the node cases use a table of widths.
3. **Chord rows.** A line is a chord row when `chordRowOf` from `src/song-paste.ts` says so. The reader and the paste rules then never disagree about what a chord is.
4. **Placing.** A chord row directly above a line of words is merged into that line. Each chord goes in brackets before the letter whose left edge is nearest the chord's left edge. A chord that starts past the end of the words goes after them.
5. **Everything else.** A chord row with no words under it stays a row of chords. A line of words stays as it is. A gap between runs wider than a third of a letter becomes spaces.
6. **Pages.** A line that repeats at the same height on every page, such as a page number or a site footer, is dropped. A blank line marks each page break.
7. **Two readings.** When a chord row arrives as one run with spaces inside it, the reader also builds the column reading. If the two readings put any chord over a different word, the row carries both, with the doubt `two-readings`.

A PDF with more than four pages carries the doubt `many-pages`, and its row offers **Split by page**, which makes one row for each page. No rule guesses where one song ends and the next begins.

A PDF page with no text runs is a scan. Until cook 4 lands, the row says **This PDF is a scan with no text inside. Scans can't be read yet.** A PDF that needs a password is refused with its own reason.

### Tier 4: files from other apps (`bulk-import-app-files`)

MusicXML carries what a lead sheet needs. Each `harmony` element is a chord with a root, a kind, and a bass. Each `lyric` element is a syllable on a note. The reader walks the measures. With lyrics, it writes each syllable and puts each chord in brackets before the syllable sung at that point. With no lyrics, it writes bar rows such as `| G | D | Em | C |`, which `parseSheet` already reads. Title, composer, key, time, and tempo have their own elements. A `.mxl` file is a zip, read with `unzip`.

The other formats are named in section 7 under NEEDS TERRY. Each one needs a real file before a cook can be specified.

### Files

| File | Change | Cook |
|---|---|---|
| `src/song-import.ts` | New. Types, `kindOf`, `decodeText`, `titleFromName`, `draftOf`, `judge`, the limits, the monospace font names. Pure. | 1 |
| `src/import-read.ts` | New. `unzip`, the readers for text, HTML, RTF, and `.docx`, and the `READERS` table from kind to reader. | 1, then one line each in 2, 4, and 5 |
| `src/import-layout.ts` | New. Placed runs to chart text. Pure. | 2 |
| `src/import-pdf.ts` | New. Loads the library, reads the runs, finds scans and locked files. | 2 |
| `vite.config.ts`, `public/sw.js` | The PDF library's two files leave the offline list and are cached on first use. `public/sw.js` writes nothing to the cache after install today. In `fromCache`, the fall-through `?? fetch(request)` puts the response in the cache only when it is `ok` and the request is for one of those two files. Every other request keeps today's path. | 2 |
| `package.json` | One check line in each cook. One dependency line in cook 2. | 1, 2 |
| `scripts/check-song-import.ts`, `scripts/check-song-import-pdf.ts` | New. | 1, 2 |
| `scripts/song-import-live.ts` | New. A script a person runs on a folder outside the repo. It prints one line for each file with its kind, mark, reasons, and chord count, and no chart text. | 1, extended in 2 |

### Required reader cases for cook 1

Unit cases run in node. Cases that need `DOMParser` or the canvas run in headless Chrome. Every chart is written for the check with made-up words. The check builds its own `.docx` and `.zip` with `node:zlib`.

- X1. `kindOf` names each kind from its first bytes when the extension is missing or wrong, and from the extension for plain text.
- X2. `decodeText` reads UTF-8, UTF-8 with a byte order mark, UTF-16 in both byte orders, and Windows-1252 with curly quotes.
- X3. A text chart and a ChordPro chart each give the title, key, tempo, headings, and chords that `readPaste` gives for the same text pasted.
- X4. A ChordPro file with two `{new_song}` parts gives two rows.
- X5. An HTML page with a chart in a `pre`, a menu, and a script gives the chart alone. A page with no `pre` gives one line for each block.
- X6. An RTF file with a font table, a picture group, `\'e9`, and `舗?` gives the typed text.
- X7. A `.docx` built by the check, with one deflated entry, gives the typed lines, with tabs and line breaks kept.
- X8. A `.docx` in a monospace font has no doubt. The same chart in a proportional font has the doubt `fonts` and two readings.
- X9. A `.zip` of three files gives three rows named by path. A damaged file inside gives one **Couldn't read** row and two good rows.
- X10. A file of zero bytes, a file of random bytes, an old `.doc`, and a `.docx` with no `word/document.xml` are each refused with their own reason.
- X11. `titleFromName` gives `Wagon Wheel` for `Wagon_Wheel-chords (1).txt`, and an empty title for `IMG_2041.jpg`, `Scan0003.pdf`, and `12.txt`.
- X12. `src/song-import.ts` and `src/import-read.ts` contain no `fetch`, `XMLHttpRequest`, or `WebSocket`.
- X13. An RTF cut off inside a group, inside a hex escape, and inside a Unicode escape, an HTML page cut off inside a tag, and a `.docx` whose XML is cut off inside a tag each end as a row. No reader loops on them.

### Required cases for cook 2

The check prints its PDFs with headless Chrome from pages written for the check.

- P1. Runs within 2 points are one line. Lines and runs come out in reading order.
- P2. In a monospace chart, every chord is over the letter it was set over.
- P3. In a chord site layout, with each chord in a box over its words, every chord is over the letter it was set over.
- P4. In a proportional chart padded with spaces, every chord is over the word it was set over.
- P5. A chord past the end of the words is kept after them. A chord row with no words under it stays a row.
- P6. A footer on each of three pages is dropped, and the pages are joined with a blank line.
- P7. A chart whose two readings differ has the doubt `two-readings`, and the row's **Try the other reading** swaps the sheet.
- P8. A five-page PDF offers **Split by page**, which gives five rows.
- P9. A PDF with no text is refused as a scan. A locked PDF is refused as locked. A file that is not a PDF is refused as damaged.
- P10. The built `sw.js` does not list the PDF library's files. After one PDF import, a second import with the network off still works.
- P11. A PDF picked beside a `.txt` gives two rows, and a PDF that fails leaves the `.txt` row good.
- P12. With the network off and the PDF library not yet cached, a PDF row says **The PDF reader could not be loaded. Check your connection and try again.** After the network returns, **Try again** reads the file into the same row and adds no second row.

### Verification for cook 2

- [ ] Unit. `npm run check:song-import-pdf` prints P1 to P12 as `ok`. Commit 1 holds the cases alone, and each fails on that commit.
- [ ] Live. In the built app at 390 px, import a chart saved as PDF from Word in Courier New and one printed from a browser in a proportional font. Pass when both rows say **Looks good** and each saved sheet shows every chord over the word it is over on the page.
- [ ] Perf. Metric one is the gzipped size of the main script. The baseline is the size at the branch point. Fail above the baseline plus 3 KB, because the library must sit in its own chunk. Metric two is the time from picking a three-page PDF to its row, with the library already loaded, at 4 times CPU slowdown. The cook measures it first and fails above 3 seconds.
- [ ] `check:offline`, `check:song-import`, `check:chords`, and `check:portable` pass with no edit to their scripts.
- [ ] `scripts/song-import-live.ts` was run on the owner's sample folder, and its table is in the report.

## 3. Photos, scans, and OCR

### Readers compared

| Reader | Reads chord names | Keeps chords over words | Cost | Privacy | Verdict |
|---|---|---|---|---|---|
| On-device OCR, `tesseract.js` | 24 to 26 of 31 on a clean render. 14 to 19 of 31 on a photo stand-in. Measured. | 8 to 16 of 27 on a clean render, because one wrong name loses its row. Measured. | Free to run. 6 MB more to download. | Nothing leaves the phone. | Rejected. It fails on the best case. |
| The phone's own copy-text-from-photo feature, then **Paste a sheet** | Not measured | No. From memory, the copied text drops the spacing between chords. | Free | Nothing leaves the phone. | Stays available with no work. It is right for words alone. |
| A vision model, called by the app's Worker | Not measured. Cook 3 measures it. | Not measured. The model is asked for each chord in brackets at its syllable, so no column counting is involved. | Estimated below. | The photo leaves the phone. | The pick, if cook 3 confirms it. |
| The same model, given a whole scanned PDF | Not measured | The same | The same for each page | The whole file leaves the phone at once. | Rejected. Sending page by page gives progress, a page limit, and smaller uploads. |

The recommended pick is the vision model, behind a notice, as the chief of staff leaned. The reason is the measurement. A chart is a hard page for classic OCR. Chord names are short tokens that are not words, such as `C`, `G`, and `D/F#`, and their meaning depends on what sits under them. On-device OCR misread one name in six on a page with no camera involved.

The pick has one condition. No vision model was run for this plan. Cook 3 runs first and can overturn the pick.

### What a page costs

These are estimates worked out from list prices. They are not measurements. The prices are from the Anthropic price list as cached on Nov 3, 2026.

Assumptions: one page is one image. A full-size image is up to about 4,800 input tokens, and an image scaled to 1568 pixels on its long edge is about 1,600. The instructions add about 400 input tokens. The answer is 1,500 to 3,000 output tokens, which covers the chart and the model's own reasoning.

| Model | Price for a million tokens, in and out | One page | 100 pages |
|---|---|---|---|
| Claude Haiku 5.5 | $0.10 and $0.50 | 0.1 to 0.2 cents | 10 to 20 cents |
| Claude Sonnet 5.5 | $2 and $10 | 1.9 to 4.0 cents | $1.90 to $4.00 |
| Claude Opus 5.5 | $4 and $20 | 3.8 to 8.1 cents | $3.80 to $8.10 |

Cook 3 replaces this table with the token counts that the service reports for real photos. The plan assumes Opus 5.5 until the owner picks, because accuracy is the point of the feature and the cheaper models are unmeasured. The model id is one Worker variable, so the pick is a setting and not a build.

### Privacy

- The photo goes from the phone to the app's Worker, and from the Worker to the reading service. The Worker writes no image and no reading to any table or log. It writes one number, the count of pages an account has read on a day.
- The phone redraws each photo on a canvas before sending. Redrawing drops the data a camera adds to a file, such as the place the photo was taken.
- The reading service keeps what it receives for as long as its own terms say. From memory that is up to 30 days. The owner reads the current terms before D2. No screen may say that nothing is kept.
- A file that is read on the phone is never sent. The notice counts only the photos and scans.

### The notice

Photos and scanned pages wait in the list with the mark **Needs sending**. One notice sits above the list.

> **3 photos need to be sent to be read.** Photos and scans are read by an AI service, so they leave this phone. Your other files were read on this phone.
> **Send 3 to be read** · **Skip the photos**

The player agrees once for each batch. The app does not remember the answer, so no later batch is sent without a tap.

### Design of the photo path (`bulk-import-photos`)

1. `src/import-photo.ts` opens the image with `createImageBitmap`, turns it upright, scales it to the size cook 3 picked, and makes a JPEG. A photo type the browser cannot open is refused with **This photo type can't be opened on this phone. Save it as a JPEG and try again.**
2. A scanned PDF page is drawn to a canvas by the PDF library from cook 2, then takes the same path. One page is one read.
3. The phone posts each image to `POST /api/import/read`, one at a time. `signedIn(c)` guards the route.
4. `worker/import-read.ts` checks the size and the two limits, then asks the model for a structured answer with two fields, `is_chart` and `chordpro`. The instructions say to copy the page as it is printed, to put each chord in brackets before the syllable it sits over, to write section names and printed facts as ChordPro directives, to write `?` for a chord it cannot read, and to add nothing that is not on the page.
5. The phone runs `readPaste` on `chordpro`. The row is **Check this**, with the reason **Read from a photo. Compare it with the page.** The row's preview shows the photo above the sheet.

| The route refuses with | Status | The row says |
|---|---|---|
| `too-large` | 413 | **This photo is too large to send.** |
| `daily-limit` | 429 | **You have reached today's limit for photos. The rest can be read tomorrow.** |
| `month-limit` | 429 | **Photo reading is paused until next month.** |
| `reader-off` | 503 | **Photos can't be read on this server yet.** |
| `unreadable` | 422 | **No chart could be made out in this photo.** |
| `reader-failed` | 502 | **The reader did not answer.** with **Try again** |

Offline, a waiting row says **Needs a connection to be read.** with **Try again**. A retry sends the same row again and can never add a second row. The limits come from two Worker variables, and the count lives in the Directory's SQLite, as rule 2 of `CLAUDE.md` requires. The upstream address is never written in `src/`.

### The measuring cook (`bulk-import-photo-probe`)

The cook commits `scripts/photo-read-probe.ts`, three charts with made-up words as HTML with their right answers, and a results table. It builds no app code.

- **Set A, scored by the script.** The owner prints the three charts, or opens them on a second screen, and photographs each one twice: once flat in good light, once at an angle in dim light. The right answer is known, so the script counts chord names read and chords over the right word, with the same scoring this plan used.
- **Set B, read by a person.** The owner's own photos and scans, from a folder outside the repo. The script prints counts, refusals, and cost, and writes each reading to a second folder outside the repo.
- The script runs each photo through Opus 5.5, Sonnet 5.5, and Haiku 5.5, at full size and at 1568 pixels. It reports the tokens the service counted and the dollars for each page.
- **The pass line.** A reader passes when it puts at least 90 percent of set A's chords over the right word, no photo scores under 80 percent, and it declines no photo. If no model passes, the cook stops and reports, and cook 4 is not queued.

A model may decline to copy out a page of printed lyrics. That risk is not measured. Set B is where it would show, and the script counts every decline.

### Required cases for cook 4

No case reaches the live service. The Worker under test points at a stand-in reader that the check starts.

- V1. A photo row waits as **Needs sending**, and nothing is posted before the tap on **Send**.
- V2. **Skip the photos** sends nothing and leaves the text rows as they were.
- V3. After **Send**, a photo becomes a **Check this** row with its sheet and the photo above it.
- V4. The posted image is a JPEG no larger than the size limit, and it carries no camera data.
- V5. Each refusal in the table above shows its own words, and no refusal shows any part of the image or the reading.
- V6. With the network off, the row says **Needs a connection to be read.** After the network returns, **Try again** gives one row and one request.
- V7. An account at its daily limit is refused, a second account on the same Worker is not, and the count is not raised by a refused read.
- V8. A signed-out request gets 401. A request from another origin is refused as every other route refuses it.
- V9. A scanned three-page PDF gives one row after three reads. With the limit reached after page two, the row keeps two pages and says so.
- V10. After a read, no table in the Directory holds any byte of the image or the reading.
- V11. The privacy page lists the new entry, and `check:privacy` passes.

### Verification for cook 4

- [ ] Unit. `npm run check:song-import-photo` prints V1 to V11 as `ok`. Commit 1 holds the cases alone, and each fails on that commit.
- [ ] Live. On the Preview Worker with the key set, import one phone photo of a printed chart from set A. Pass when the notice appears, the row arrives as **Check this**, and the saved sheet matches the page at the rate cook 3 measured.
- [ ] Perf. The metric is the time from **Send** to the row for one photo on the Preview Worker. The cook measures three photos first and writes the numbers in the report. Fail above 30 seconds for a page, and show the row as waiting the whole time.
- [ ] `check:song-import`, `check:song-import-pdf`, `check:privacy`, `check:api`, `check:spend-guard`, and `check:portable` pass with no edit to their scripts, apart from new entries the privacy check requires.
- [ ] The owner reviews the notice on a phone before merge.

## 4. Batch behavior

### One file can never stop the pile

- Each file is read inside its own `try`. A reader that throws, or that passes 20 seconds, gives a **Couldn't read** row, and the next file starts.
- No timer can stop a reader that runs on the main thread, and the RTF, HTML, and `.docx` readers do. So the size limit is tested before a reader starts, `unzip` stops inflating an entry at the size limit, and each of those readers ends on a file that is cut off at any point.
- Files are read one at a time, and the sheet yields to the screen between files. **Stop** is answered between two files.
- A row is a small state machine: waiting, reading, ready, unread, or saved. Only the reducer in `src/song-import.ts` moves a row, so a row cannot be both saved and waiting.
- Saving is safe to repeat. A saved row holds its song id and is never written again, by a second tap or by a second **Save**.

### Limits

Each limit is one constant in `src/song-import.ts`. A file or a page past a limit gets its own reason, and the rest of the pile goes on.

| Limit | Value | Why |
|---|---|---|
| Files in one pile, after zips are opened | 200 | Review of more than this is not practical on a phone, and the library has a size limit. |
| Size of one file, and of one file inside a zip after it is inflated | 20 MB | A phone can hold this in memory. A small zip can hold a very large file. |
| Pages read from one PDF | 60 | A larger file is a songbook, which the player should split. |
| Characters of text from one file | 200,000 | A chart is a few thousand. More means the file is not a chart. |
| Time for one file | 20 seconds | A stuck reader must not hold the pile. |

### What **Couldn't read** looks like

The row keeps the file name, shows the mark, and gives one line. It has no preview and no **Edit**. It is never saved. A `MESSAGES` map in `src/song-import.tsx` holds the words, keyed by the reason, as `src/friends.tsx` does for refusals.

| Reason | The row says |
|---|---|
| `unsupported` | **This kind of file can't be read yet.** |
| `old-word` | **This is an old Word file. Save it as .docx or PDF and try again.** |
| `empty` | **This file is empty.** |
| `no-text` | **No words or chords were found in this file.** |
| `damaged` | **This file is damaged, or it is not the kind its name says.** |
| `locked` | **This PDF needs a password. Save a copy without one and try again.** |
| `scan` | **This PDF is a scan with no text inside. Scans can't be read yet.** |
| `no-reader` | **The PDF reader could not be loaded. Check your connection and try again.** with **Try again** |
| `too-big` | **This file is larger than 20 MB.** |
| `too-many` | **Only the first 200 files were read. Import the rest in a second pile.** |
| `slow` | **Reading this file took too long.** |

No reason shows any part of the file's content.

### What **Check this** looks like

The row has a sheet and can be saved. It lists each reason that applies.

| Reason | The row says | What the player can do |
|---|---|---|
| `no-title` | **Add a title.** | Type in the **Title** field. The row is not saved until then. |
| `no-chords` | **No chords were found. It will be saved as words.** | Save it, or open it in the editor. |
| `warnings` | **2 lines may have a chord in the wrong place.** | Open it. The editor already marks those lines. |
| `fonts` | **Chords may sit over the wrong word. A PDF of this document keeps them in place.** | **Try the other reading**, or import the PDF. |
| `two-readings` | **This page can be read two ways.** | **Try the other reading**. |
| `many-pages` | **This file has 12 pages. It may hold more than one song.** | **Split by page**. |
| `photo` | **Read from a photo. Compare it with the page.** | Look at the photo above the sheet. |
| `duplicate` | See below. | See below. |

`warnings` counts the warnings that `parseSheet` already gives. No second judge of chord placement is built.

### Duplicates are flagged, never merged in silence

A duplicate is found in three ways.

| Found by | The row says | Default |
|---|---|---|
| The same title and artist as a song in My Songs, by `songYouHave` in `src/search.ts`, the rule the editor uses today | **You already have Paper Boats.** | Not saved by **Save**. The row waits for a choice. |
| The same title and artist as an earlier row in this pile | **Same song as paper-boats.txt in this pile.** | The same |
| The same bytes as an earlier file in this pile, by a SHA-256 of the file | **The same file as paper-boats.txt.** | The row starts skipped. |

A flagged row offers three choices.

- **Keep both** saves the row as a new song under a new id. Two songs with the same title is allowed today, and stays allowed.
- **Replace** puts the row's chart in the place of the song the player has, with `replaceOwnSong`. The song keeps its id, so setlists still point at it. **Replace** is offered only for a song the player made, by `madeHere`. A built-in song or a copy from a band cannot be replaced, and the row then offers only **Keep both** and **Skip**. **Replace** asks once, **Replace the chart of Paper Boats? This can't be undone.**
- **Skip** sets the row aside.

Nothing is ever overwritten without that tap. A new song always gets a new id from the stored library.

This flag is a hint to the player about the player's own library. It decides nothing about sharing or privacy. Rule 5 of `CLAUDE.md` stands: sharing is judged by ids and lineage, and an imported song is a new own song with its own id and no claim about where it came from.

### Saving many songs

- `addOwnSongs(songs)` in `src/storage.ts` adds every song in one write and returns the id of each. It fires `storageChanged` once.
- When the browser refuses that write, the sheet saves the rows one at a time until one is refused. The rows before it are saved. The rest stay as they are, under the landed message. No row is lost and none is written twice.
- When the player is signed in, backup sends the new songs. One sync carries at most 500 changes, and the pile limit is 200, so one import fits one sync.
- The check imports 200 generated songs into a library that already holds 100, in Chrome, and reports the stored size and whether the write was refused.

### Required batch cases for cook 1

- B1. A pile of five files with one reader that throws gives four rows with sheets and one **Couldn't read** row, in the picked order.
- B2. A reader that never returns is stopped at the time limit, and the files after it are read.
- B3. Each reason in the **Couldn't read** table has a file that produces it and shows its words. No unread row shows any text from its file. With no other row in the pile, the bottom button is disabled and says **Nothing to save**.
- B4. Each cook 1 reason in the **Check this** table has a file that produces it.
- B5. A row whose title and artist match a song in My Songs is flagged and is not saved by **Save**. **Keep both** then adds a second song. The first song is byte-for-byte unchanged.
- B6. **Replace** on a song the player made keeps the song's id and its place in a setlist, and changes its chart. **Replace** is not offered for a built-in song.
- B7. Two files with the same bytes give one ready row and one skipped row. Two files with the same title and different bytes give one ready row and one flagged row.
- B8. With the write refused by a full store, the saved rows are marked, the rest stay, the message shows, and a second **Save** after space is freed adds each remaining song once.
- B9. **Stop** during a pile of 20 keeps the rows that are done and reads no more.
- B10. File 201 of a pile gets the `too-many` reason. A zip of 250 files gives 200 rows and one line that says the rest were not read.
- B11. After a save and a reload, picking the same pile again flags every saved song and adds none without a tap.
- B12. `addOwnSongs` with one song that has no title saves the others and returns null for that one.
- B13. A file over the size limit gets the `too-big` reason, and no reader is called for it. The case counts the calls.
- B14. A zip entry that would inflate past the size limit gets the `too-big` reason. `unzip` stops inflating it at the limit, and the other entries are read. A `.docx` whose `word/document.xml` passes the limit is refused as `damaged`.

### Verification for the batch

- [ ] Unit. `npm run check:song-import` prints B1 to B14 as `ok`. Each failed on the tests-only commit.
- [ ] Live, signed in. On a local Worker, import 50 generated songs, let backup run, then sign in on a second browser profile. Pass when the second profile lists the same 50 songs once each.
- [ ] Live. In the built app at 390 px, import a pile of six files where one is a renamed photo and one is a song already in My Songs. Pass when four rows are saved by one tap, the photo row says why it could not be read, the duplicate waits with its three choices, and My Songs holds four new songs and the old song unchanged.
- [ ] Perf. The metric is the time of **Save** for 100 ready rows, in Chrome at 4 times CPU slowdown. The baseline is 100 calls of the landed `addOwnSong` on the branch point, measured first. Fail if `addOwnSongs` is not at least 5 times faster, or if it passes 2 seconds.

## 5. Copyright and sharing

This section states the rule as the brief gives it. It designs no license and no sharing feature.

### The player's own library

- Most files a player imports are copyrighted charts: a PDF from a chord site, a page from a songbook, a chart a bandmate typed from a record.
- Import puts each one in the player's own library, on the player's own phone. That is the personal use the brief allows.
- When the player is signed in, backup copies own songs to the player's own room on the server. The backup is the player's copy, for the player's own phones. It is not a share.
- The app fetches nothing. Every chart enters by the player's own act of picking a file. This matches the rule in the song-search plan that words and web charts enter only by the player's own hand.

### Sharing

- Today a song the player made is shared whole, words included. `content` in `src/band-library.tsx` sends `body`. An imported song is an own song, so it can be sent to a band or a friend like any other.
- The DMCA agent registration gives the app a safe harbor for what its users share, as long as the app follows the takedown process. It is not a license for lyrics or for chord charts. It does not make a shared copyrighted chart lawful. It limits the app's own liability when a user shares one and the app acts on a notice.
- Bulk import raises the volume. One player can add 200 copyrighted charts in a minute, and share them the next minute. The song-search plan raised the same question for pasted charts as its decision D4. It is decision D8 here. The owner decides it before bulk import reaches players.
- No cook in this plan changes what is shared, adds a license notice, or marks a song as imported. Any of those would be a share design, which this cook was told not to invent.

### What the cooks must do

- No real chart goes in the repo. Every fixture is a chart written for its check, with made-up words.
- The owner's sample files stay in a folder outside the repo. `scripts/song-import-live.ts` and `scripts/photo-read-probe.ts` print counts and marks, and never chart text. A reading written for a person to check goes to a folder outside the repo.
- Cook 4 sends a photo of a copyrighted page to a reading service, on the player's request, to copy out what the player already holds. The Worker stores neither the photo nor the reading. The owner should confirm that this use fits the service's terms before D2.
- No screen tells the player that importing or sharing a chart is permitted. The app's terms carry that, and `legal/TERMS-DRAFT.md` is not in the repo for a cook to quote.

## 6. Priority order and copy-ready cook briefs

None of these cooks is queued. Each brief waits in the repo for the owner's review.

### The order, and why

| Order | Cook | Size | Why it sits here |
|---|---|---|---|
| 1 | `bulk-import-text` | Large | It builds the whole flow and every shape the later cooks import. It needs no library, no server, and no decision. |
| 2 | `bulk-import-pdf` | Medium | PDFs are the most common chart file after text. The method is measured. It needs D1 and the reader table from cook 1. |
| 3 | `bulk-import-photo-probe` | Small | It is a script and a table. It settles the one unmeasured choice in the plan, so it should run early, beside cooks 1 and 2. |
| 4 | `bulk-import-photos` | Medium | It is the only cook with a server route, a secret, a cost, and a privacy entry. It builds on a measured reader. |
| 5 | `bulk-import-app-files` | Small to medium | It serves the fewest files, and most of its formats have no sample yet. |

Each brief is a standalone file under `docs/cooks/`. That file is the copy to queue. The HANDOFF block and the short facts are repeated here for review. If the two differ, the file under `docs/cooks/` wins.

| Cook | Brief file | Model |
|---|---|---|
| `bulk-import-text` | `docs/cooks/bulk-import-text.md` | Opus |
| `bulk-import-pdf` | `docs/cooks/bulk-import-pdf.md` | Opus |
| `bulk-import-photo-probe` | `docs/cooks/bulk-import-photo-probe.md` | Opus |
| `bulk-import-photos` | `docs/cooks/bulk-import-photos.md` | Opus |
| `bulk-import-app-files` | `docs/cooks/bulk-import-app-files.md` | Opus |

The model column follows `MODEL-RULES.md` in the laptop's cooks folder. The owner's pick of Nov 18, 2026 says that Fable writes the plan and Opus runs every cook in it. No cook name here contains `fable`, so the launch guard picks Opus. Fable returns only by the standing rule in that file, when a cook is stuck.

### Rules every brief below inherits

- Read `CLAUDE.md` first. Stay inside the owned files. Add one `check:*` line to `package.json` and nothing else there, apart from the one dependency line a brief names.
- Commit 1 holds the tests alone, and each new case fails on it. Later commits do not weaken a case. A case that is wrong goes in `QUESTIONS.md`, which is a shared log, so add the entry at the top.
- The required test cases are the lettered cases in the named section of `docs/PLAN-bulk-import.md`. Each case needs a named line that prints `ok` or `FAIL`.
- No new libraries, apart from the one a brief names with its owner decision. Screen cases use `scripts/chrome.ts` and `scripts/app-page.ts`, as `scripts/check-song-paste.ts` does. Write paths with `fileURLToPath` and `path.join`, and read the browser from `CHROME`.
- Every file's text goes through `readPaste`. No cook changes a rule in `src/song-paste.ts`, adds a second chart parser, or adds a second chord rule.
- The app fetches no chart. A chart enters only from a file the player picked. Every chart in a check is written for the check, with made-up words. No real chart, photo, or reading is committed.
- No outside address and no key in `src/`, in `worker/`, or in any committed file. `npm run check:portable` must pass.
- No internal names on a screen. Do not show a library name, a model name, a reason word such as `no-text`, or a cook id.
- Every new control is styled in the cook's CSS file, is at least 44 px tall, and is checked at 360 px and 390 px.
- Handle the list in `CLAUDE.md` under "Must handle in every feature". The table below says what each rule means for these cooks and names the required cases that prove it.
- Before the report: `npm run build`, the cook's own check, `check:song-paste`, `check:new-song`, `check:storage`, `check:chords`, `check:one-copy`, and `check:portable`.

### Must handle, and the cases that prove it

The table has one row for each rule in `CLAUDE.md` under "Must handle in every feature". `npm run check:bulk-import-plan` fails when a rule has no row, or a row names no case. A rule added to `CLAUDE.md` needs a row and a case here.

| `CLAUDE.md` rule | What it means for these cooks | Cases |
|---|---|---|
| Signed out | A signed-out visitor sees no import button, a drag does nothing, and nobody is trapped in a sheet. The read route of cook 4 answers 401. | U1, V8 |
| Second phone or account switch on a shared phone | When the session ends or a second account signs in, the import sheet closes and its rows are gone. A second account sees no row and saves no song from the first account's pile. The page count of cook 4 is kept for each account. A second phone gets saved songs through backup, which the live box under "Verification for the batch" covers. | U12, V7 |
| Old, expired, reset or wrong links | Import adds no link and no code. The same rule holds for a wrong or damaged file. It gets a clear reason, and no part of the file shows in the refusal. | X10, B3, V5 |
| Offline or slow network | Cook 1 makes no network call. Cook 2 fetches the PDF library once and gives a clear retry when it cannot. Cook 4 gives a clear retry. No retry adds a second row or a second song. | X12, P12, V6 |
| Empty states and error states | Every state in the table "What the player sees when something is missing", and every reason in the tables of sections 3 and 4, has its words on the screen. | U13, B3, B4, P9, V5 |

### 6.1 Brief: `bulk-import-text`

```text
## HANDOFF
GOAL: A signed-in player picks or drops a pile of text files and documents (.txt, ChordPro, .html, .rtf, .docx, or a .zip of them) and gets a review list, one row a file, that says Looks good, Check this or Couldn't read. One tap saves every good row to My Songs, and each saved song opens with no network.
DECIDED: one cook, one branch, cook/bulk-import-text off mls-int-20261113 after PR 116 (song-paste-autofill) has merged; every file's text goes through readPaste, which stays the only reader of chart rules; the review list lives in memory; Fix opens the one SongEditor; a title may come from the file name; a duplicate is flagged by songYouHave and waits for Keep both, Replace or Skip (plan decision D6); Save writes the library once with addOwnSongs; the file picker has no accept filter.
REJECTED: a second chart parser or a second chord rule; a second editor or a second preview; a draft store for the list; any network call; a catalog lookup for each file; PDFs, photos and MusicXML, which are later cooks; new libraries; any change to what is shared; real charts as fixtures; edits outside the owned files.
DONE MEANS: cases U1 to U13, X1 to X13 and B1 to B14 of the plan each have a named check line that failed on the tests-only commit and passes now; every box under "Verification for the flow" in section 1 and "Verification for the batch" in section 4 is ticked with its evidence in the report; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-bulk-import.md sections 1, 2 (tier 1) and 4.
NEEDS OWNER: none to start. The owner reviews the flow on a phone before merge. The sample files of plan section 7 make the live script useful and do not block the cook.
```

- **Tests first.** Commit 1 is `scripts/check-song-import.ts` and its `package.json` line alone. Cases U, X, and B all fail on it.
- **Owned files.** `src/song-import.ts`, `src/import-read.ts`, `src/song-import.tsx`, `src/song-import.css`, and `scripts/song-import-live.ts`, all new. `src/storage.ts` for `addOwnSongs` alone. `src/song-editor.tsx` for the `"import"` sheet and a start draft. `SongEditors` takes the account's user id, mounts the sheet only while there is one with `key` set to that id, and calls `onClose` when the id changes (case U12). `src/song-paste.ts` for two `export` keywords alone. `src/library-lists.tsx` and `src/App.tsx` for the button, the drop, and the user id on the existing `SongEditors` line, with at most three new lines in `src/App.tsx`. New rows in `scripts/check-one-copy.ts`.
- **Do not touch.** Any rule in `src/song-paste.ts`, `src/song-text.ts`, `src/sheet.tsx`, `src/song-search.ts`, `src/song-search.tsx`, `src/backup.ts`, `src/phone-db.ts`, worker files, and earlier check scripts.
- **Checks.** `check:song-import` (new), `check:new-song`, `check:song-paste`, `check:song-search`, `check:storage`, `check:chords`, `check:screens`, `check:phone-layout`, `check:one-copy`, `check:portable`.

### 6.2 Brief: `bulk-import-pdf`

```text
## HANDOFF
GOAL: A PDF with real text inside, from a chord site or from Word, imports with every chord over the word it sits over on the page. It is read on the phone and nothing is uploaded.
DECIDED: one cook, one branch, cook/bulk-import-pdf off mls-int-20261113 after bulk-import-text has merged; pdfjs-dist is the PDF reader (plan decision D1), loaded with import() only when a PDF is picked and kept out of the service worker's file list; chords are placed by position and written as inline brackets; a monospace line uses even letter steps and a proportional line uses widths measured in a font on the device; a file whose two readings differ keeps both; a scan is refused with its own reason until the photo cook lands.
REJECTED: a hand-written PDF parser; any upload of a PDF; a chord row padded with spaces as the reader's output; a guess at where one song ends inside a file; OCR; a second chord rule; any other new library; edits outside the owned files.
DONE MEANS: cases P1 to P12 of plan section 2 each have a named check line that failed on the tests-only commit and passes now; every box under "Verification for cook 2" is ticked with its evidence in the report; the report gives the gzipped size of the main script before and after, and of the PDF chunk; npm run build, check:offline and check:portable are green.
SOURCE: docs/PLAN-bulk-import.md section 2 (tier 2), and the PDF table in "What was measured for this plan".
NEEDS OWNER: D1 must be yes before this cook starts.
```

- **Tests first.** Commit 1 is `scripts/check-song-import-pdf.ts` and its `package.json` check line alone. Cases P1 to P12 fail on it.
- **Owned files.** `src/import-layout.ts` and `src/import-pdf.ts`, new. One line in the `READERS` table of `src/import-read.ts`. `src/song-import.tsx` and `src/song-import.css` for **Split by page**. `vite.config.ts` and `public/sw.js` for the offline list, and for one cache write in `fromCache` that is limited to the library's two files. `package.json` for one check line and the `pdfjs-dist` line. `scripts/song-import-live.ts` for the PDF kind.
- **Do not touch.** `src/song-paste.ts`, `src/song-import.ts` apart from a new reason word, `src/storage.ts`, `src/song-editor.tsx`, `src/App.tsx`, worker files, and earlier check scripts.
- **Checks.** `check:song-import-pdf` (new), `check:song-import`, `check:offline`, `check:chords`, `check:one-copy`, `check:portable`.

### 6.3 Brief: `bulk-import-photo-probe`

```text
## HANDOFF
GOAL: A committed script measures how well each candidate model reads a photo of a chart (chord names read, chords over the right word, declines) and what a page costs, on photos with a known right answer and on the owner's own photos. The photo cook then builds on a number.
DECIDED: one cook, one branch, cook/bulk-import-photo-probe off mls-int-20261113; the script calls the reading service with the official SDK (plan decision D4) and a key from the environment; three models (Claude Opus 5.5, Sonnet 5.5, Haiku 5.5) at two image sizes; set A is three charts with made-up words that the owner photographs, scored by the script; set B is the owner's own files, never committed; the pass line is 90 percent of set A's chords over the right word, no photo under 80 percent, and no decline.
REJECTED: any app code under src/ or worker/; any key, photo or reading in the repo, in a log or in the report; chart text of set B in any output inside the repo; on-device OCR as a build target, which the plan measured and rejected; any screen.
DONE MEANS: cases Q1 to Q6 in the brief each have a named check line that failed on the tests-only commit and passes now; scripts/photo-read-probe.ts runs from one command; docs/bulk-import-photo-probe.md holds the table for set A (each model and size: chord names, same word, declines, tokens, dollars a page) and the counts for set B; the report names the model and size it recommends, or says that no model passed; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-bulk-import.md section 3.
NEEDS OWNER: D2 and D4 must be yes. The six photos of set A and the set B folder, as plan section 7 asks. An API key in the laptop's environment as ANTHROPIC_API_KEY.
```

- **Tests first.** Commit 1 is `scripts/check-photo-probe.ts` and its `package.json` line alone. It tests the scorer and the table writer against a stand-in model, and reaches no service.
- **Owned files.** `scripts/photo-read-probe.ts`, `scripts/check-photo-probe.ts`, `tests/fixtures/import-photo/` (three charts as HTML with their right answers), and `docs/bulk-import-photo-probe.md`, all new. `package.json` for one check line and the SDK as a development dependency.
- **Do not touch.** Everything under `src/`, `worker/`, and `public/`, and earlier check scripts.
- **Checks.** `check:photo-probe` (new), `check:portable`.

### 6.4 Brief: `bulk-import-photos`

```text
## HANDOFF
GOAL: A photo or a scanned PDF in an import pile is read into a lead sheet by a vision model, after the player sees a clear notice and taps to send. The row arrives as Check this, with the photo beside the sheet.
DECIDED: one cook, one branch, cook/bulk-import-photos off mls-int-20261113 after bulk-import-pdf and bulk-import-photo-probe have merged; the model and the image size are the ones the probe report names, held in Worker variables (plan decision D3); the phone posts one page at a time to POST /api/import/read; the Worker stores a page count and nothing else; the player agrees for each batch and the answer is not remembered; a photo row is always Check this (plan decision D7); the privacy page gains one entry (plan decision D5).
REJECTED: on-device OCR; sending any file that was read on the phone; storing an image or a reading on the server; a remembered consent; a key or an outside address in src/ or in any committed file; a whole PDF sent in one request; joining two photos into one song; edits outside the owned files.
DONE MEANS: cases V1 to V11 of plan section 3 each have a named check line that failed on the tests-only commit and passes now; every box under "Verification for cook 4" is ticked with its evidence in the report; no check reaches the live service; tsc -p worker, npm run build, check:privacy and check:portable are green.
SOURCE: docs/PLAN-bulk-import.md section 3; docs/bulk-import-photo-probe.md.
NEEDS OWNER: D2, D3, D4 and D5 must be answered. The owner sets the API key on the Preview Worker with wrangler secret put before the live box. The owner reviews the notice on a phone before merge.
```

- **Tests first.** Commit 1 is `scripts/check-song-import-photo.ts` and its `package.json` line alone. Cases V1 to V11 fail on it. The check starts with `tsc -p worker`.
- **Owned files.** `worker/import-read.ts` and `src/import-photo.ts`, new. `worker/directory.ts` to merge the route and add the count table. `worker/index.ts` and `worker/wrangler.jsonc` for the variables. One line in `READERS`. `src/song-import.ts` for the waiting state and the new reasons. `src/song-import.tsx` and `src/song-import.css` for the notice and the photo in the preview. `src/import-pdf.ts` to draw a scanned page. `src/data-kinds.ts` for the privacy entry. `package.json` for one check line and the SDK line.
- **Do not touch.** `src/song-paste.ts`, `src/storage.ts`, `src/song-editor.tsx`, `src/App.tsx`, `worker/share-guard.ts`, `worker/room-*.ts`, and earlier check scripts apart from entries `check:privacy` requires.
- **Checks.** `check:song-import-photo` (new), `check:song-import`, `check:song-import-pdf`, `check:privacy`, `check:api`, `check:spend-guard`, `check:one-copy`, `check:portable`.

### 6.5 Brief: `bulk-import-app-files`

Queue this brief only after the owner answers question 4 in section 7.

```text
## HANDOFF
GOAL: A MusicXML file (.musicxml, .xml or .mxl) in an import pile becomes a lead sheet with its chords, words, key, time and tempo. Each other chord-app format the owner named has a reader, or a plain refusal that says how to export a file the app can read.
DECIDED: one cook, one branch, cook/bulk-import-app-files off mls-int-20261113 after bulk-import-text has merged; MusicXML is read with DOMParser and unzip; a harmony element becomes a bracket chord at its syllable, or a bar row when the part has no words; a format is built only when the owner supplied a real file of it.
REJECTED: a reader built from memory of a format with no sample file; a database reader for a backup file; notes, rests or staves on the sheet; new libraries; edits outside the owned files.
DONE MEANS: cases M1 to M8 in the brief each have a named check line that failed on the tests-only commit and passes now; the live box in the brief is ticked with its evidence in the report; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-bulk-import.md section 2 (tier 4) and section 7.
NEEDS OWNER: the list of apps and one exported file from each. With no answer, the cook builds MusicXML alone.
```

- **Tests first.** Commit 1 is `scripts/check-song-import-apps.ts` and its `package.json` line alone. Cases M1 to M8 fail on it.
- **Owned files.** `src/import-musicxml.ts`, new. `src/import-read.ts` for one `READERS` line for each new kind. `src/song-import.ts` for the new kinds in `kindOf`, and one reason word for each format that is named and not built. `src/song-import.tsx` for the words of the new reasons. `scripts/song-import-live.ts` for the new kinds.
- **Do not touch.** `src/song-paste.ts`, `src/storage.ts`, `src/song-editor.tsx`, `src/App.tsx`, worker files, and earlier check scripts.
- **Checks.** `check:song-import-apps` (new), `check:song-import`, `check:chords`, `check:one-copy`, `check:portable`.

## 7. Dependency order, cost and risk, and NEEDS TERRY

### Dependency order

| Cook | Branches from | Must be merged first | Owner input that must exist | Review before merge |
|---|---|---|---|---|
| `bulk-import-text` | `mls-int-20261113` | PR 116 | none | The owner, on a phone |
| `bulk-import-pdf` | `mls-int-20261113` | cook 1 | D1 | none beyond the verify |
| `bulk-import-photo-probe` | `mls-int-20261113` | none | D2, D4, the photos, a key on the laptop | none. It adds no app code. |
| `bulk-import-photos` | `mls-int-20261113` | cooks 1, 2, and 3 | D2, D3, D4, D5, the key on the Preview Worker | The owner, on a phone |
| `bulk-import-app-files` | `mls-int-20261113` | cook 1 | the answer to question 4 below | none beyond the verify |

Two phases follow from the table.

- **Phase 1, on the phone alone.** Cooks 1 and 2. No server, no secret, no cost. This phase covers every file that holds real text. Cook 3 can run during this phase.
- **Phase 2, with a server.** Cook 4, and cook 5 whenever its samples exist. Phase 2 starts only after the probe passes and the owner answers D3.

Files that two cooks touch: `src/import-read.ts` gains one `READERS` line in cooks 2, 4, and 5. `src/song-import.tsx` gains **Split by page** in cook 2 and the notice in cook 4. `package.json` gains one line in each cook. Cooks 2 and 5 can run at the same time after cook 1. The one that merges second merges `mls-int-20261113` first and keeps both `READERS` lines.

### Cost

| Item | Cost |
|---|---|
| Running cooks 1, 2, and 5, and using what they build | Nothing beyond the cook itself. All of it runs on the phone. |
| One run of the probe in cook 3 | Six photos of set A and about ten of set B, through three models at two sizes, is about 100 reads. If every read cost the high Opus estimate of 8.1 cents, the run would cost about 8 dollars. Two thirds of the reads use cheaper models. |
| Photo reading for players, after cook 4 | The estimate in section 3 for each page. The monthly limit caps it. At 2,000 pages and the high Opus estimate, the cap is about 160 dollars a month. On Haiku the same cap is about 4 dollars. |
| Download size | Cook 2 adds 515 KB gzipped, fetched only by a phone that imports a PDF. Cook 1 may add at most 15 KB to the main script. |

### Risks

| Risk | What happens | What the plan does |
|---|---|---|
| The library is one `localStorage` value | A large pile fills the store, and the write is refused | The pile limit is 200. Cook 1 measures the refusal point, saves what fits, and keeps the rest in the list. A larger store is a separate cook. |
| PR 116 changes the files cook 1 edits | A merge conflict in `src/song-editor.tsx` or `src/storage.ts` | Cook 1 branches only after PR 116 merges. |
| `src/App.tsx` has 490 lines and a cap of 500 | `check:one-copy` fails | Cook 1 may add three lines there. The sheet mounts through `SongEditors`. |
| The service worker edit in cook 2 | A mistake breaks the offline app | `check:offline` must pass unchanged, and case P10 proves the cache on first use. |
| The PDF library on an older phone browser | The reader fails to load | The library ships a build for older browsers, at 552 KB gzipped. The cook picks the build from the browsers the app supports, and a load failure gives **Couldn't read** with a plain reason. |
| A model declines to copy printed lyrics | Photo rows fail | Cook 3 counts declines on real pages before anything is built. A decline is the `unreadable` refusal. |
| The read route is used as a free reading service | Cost with no player value | Sign-in, the origin check every route has, the size limit, and the two page limits. |
| A file with many songs | One long sheet | **Split by page** for a PDF, `{new_song}` for ChordPro, and no guessing. Question 3 below asks how common this is. |
| A Word chart in a proportional font | Chords over the wrong words | The row is **Check this**, offers the other reading, and tells the player that a PDF reads exactly. |
| The phone's picker with no type filter | An unknown layout of the picker on some phone | The owner's phone review of cook 1 covers iPhone and Android. |

### What stays unproven

- **Every placement number rests on one made-up chart and one run.** Cooks 1 and 2 run `scripts/song-import-live.ts` on the owner's real files. A real file that is marked **Looks good** and has a chord over the wrong word is a reason to stop and ask before merge.
- **No vision model was run.** The pick in section 3 is a judgment, and cook 3 tests it. The cost table is arithmetic on list prices, and the token counts are assumptions.
- **No real photo was read.** The photo stand-in was made by blurring and turning a render. It may be harder or easier than a real photo.
- **Nothing was run on a phone.** Every time in this plan is from a laptop. The picker, the canvas width measure, and the PDF library were not tried in Safari or in Chrome on Android.
- **The fonts on a phone were not checked.** The plan assumes that a phone has no Calibri, from memory.
- **The 5 MB store limit is from memory.** Cook 1 measures the real refusal point in Chrome. Safari may differ.
- **HEIC, the old `.doc` format, and the formats of OnSong, SongBook, and iReal Pro are described from memory.** No file of any of them was opened for this plan.
- **Handwritten charts were not considered in any measurement.**
- **The service's terms on keeping uploads, and on copying out a copyrighted page for its holder, were not read for this plan.** The owner reads them before D2.
- **The RTF reader was tried on one file, written by Word.** Files from other editors may use control words the prototype did not meet.

### NEEDS TERRY

1. **Real messy sample files.** Please put these in one folder on the laptop, outside every repo, and tell the chief of staff the path. They are never committed.
   - The real pile, as it is, if you can share it. A zip is fine.
   - If not the whole pile, at least one of each: a scanned PDF, a phone photo of a paper chart, a Word document, a PDF saved from a chord site, a plain text file, and anything odd that you expect to break.
2. **How many files are in the real pile?** Tens or hundreds. The plan limits one pile to 200 files, and a library of many hundreds of songs needs a larger store first.
3. **Is each file one song?** Or do some files hold a whole songbook.
4. **Which other chord apps do you or your bandmates move files from?** OnSong, SongBook, iReal Pro, MuseScore, forScore, or another. One exported file from each lets cook 5 be specified. With no answer, cook 5 builds MusicXML alone.
5. **Are any of the photos handwritten charts?**
6. **Decisions D1 to D10** in "Decisions the owner must make". D1 unblocks PDFs. D2 and D4 unblock the probe.
7. **For the probe, once its brief is approved:** six photos of three printed pages that the cook provides, and an API key set in the laptop's environment. The key goes in no file.
8. **A monthly spending limit for photo reading**, which sets the page limits in D3.
9. **A phone review** of cook 1 before it merges, and of the notice in cook 4.
