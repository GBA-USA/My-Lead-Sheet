# Cook brief: `bulk-import-pdf`

Not queued. This brief waits for the owner's review and for decision D1. Model: Opus. Plan: `docs/PLAN-bulk-import.md`.

```text
## HANDOFF
GOAL: A PDF with real text inside, from a chord site or from Word, imports with every chord over the word it sits over on the page. It is read on the phone and nothing is uploaded.
DECIDED: one cook, one branch, cook/bulk-import-pdf off mls-int-20261113 after bulk-import-text has merged; pdfjs-dist is the PDF reader (plan decision D1), loaded with import() only when a PDF is picked and kept out of the service worker's file list; chords are placed by position and written as inline brackets; a monospace line uses even letter steps and a proportional line uses widths measured in a font on the device; a file whose two readings differ keeps both; a scan is refused with its own reason until the photo cook lands.
REJECTED: a hand-written PDF parser; any upload of a PDF; a chord row padded with spaces as the reader's output; a guess at where one song ends inside a file; OCR; a second chord rule; any other new library; edits outside the owned files.
DONE MEANS: cases P1 to P11 of plan section 2 each have a named check line that failed on the tests-only commit and passes now; every box under "Verification for cook 2" is ticked with its evidence in the report; the report gives the gzipped size of the main script before and after, and of the PDF chunk; npm run build, check:offline and check:portable are green.
SOURCE: docs/PLAN-bulk-import.md section 2 (tier 2), and the PDF table in "What was measured for this plan".
NEEDS OWNER: D1 must be yes before this cook starts.
```

# Import PDFs that hold real text

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full. The one library this cook may add is `pdfjs-dist`.

## What the player can do

1. Pick PDFs in the same pile as any other file.
2. See each PDF as a row. A chart from a chord site or from Word says **Looks good**, with each chord over its word.
3. On a row that says **This page can be read two ways**, tap **Try the other reading** and keep the one that matches the page.
4. On a PDF with many pages, tap **Split by page** to get one row for each page.
5. See a plain reason for a scan, a locked file, or a damaged file. The other rows are not affected.

## Tests first

Commit 1 holds `scripts/check-song-import-pdf.ts` and its one `package.json` check line, and nothing else. Every case fails on that commit. The `pdfjs-dist` dependency line comes in commit 2.

The cases are P1 to P11 in plan section 2. The cases for `src/import-layout.ts` run in node on made-up runs of text, with a table of letter widths passed in as the measuring function. The check prints its PDFs with headless Chrome from pages written for the check, so no PDF file is committed.

## Owned files

| File | Change |
|---|---|
| `src/import-layout.ts` | New. Pure. Placed runs of text to chart text, by the seven rules of plan section 2. |
| `src/import-pdf.ts` | New. Loads the library with `import()`, reads each page's runs, finds scans and locked files, builds the two readings. |
| `src/import-read.ts` | One line. The `pdf` entry of `READERS`. |
| `src/song-import.ts` | A new reason word where one is needed. Nothing else. |
| `src/song-import.tsx`, `src/song-import.css` | **Split by page**, and the words for the new reasons. |
| `vite.config.ts`, `public/sw.js` | The PDF library's two files leave the offline list. The service worker caches them the first time they are fetched. |
| `scripts/check-song-import-pdf.ts` | New. |
| `scripts/song-import-live.ts` | The PDF kind. |
| `package.json` | One line, `check:song-import-pdf`, and the `pdfjs-dist` dependency. |

Do not touch: `src/song-paste.ts`, `src/storage.ts`, `src/song-editor.tsx`, `src/App.tsx`, worker files, and earlier check scripts.

## Empty and error states, and the wired flow

A PDF with no text on any page says **This PDF is a scan with no text inside. Scans can't be read yet.** A PDF with text on some pages reads those pages and says how many pages were left out. A locked PDF, a damaged file, a file past 60 pages, and a read past 20 seconds each have their own reason from plan section 4. If the library fails to load, the row says **The PDF reader could not be loaded. Check your connection and try again.**, and **Try again** reads the same row. No failure in a PDF changes any other row.

Flow: My Songs, **Import files**, pick a PDF and a text file, two rows, **Save 2 songs**.

## Checks

`npm run build`, `check:song-import-pdf`, `check:song-import`, `check:offline`, `check:chords`, `check:one-copy`, `check:portable`.

## Hints

- Worth building `src/import-layout.ts` first, against the numbers in the plan. Even steps on a monospace line gave 27 of 27. The measured-width rule on a proportional line gave 27 of 27 on the same word. The measured-width rule on a monospace line dropped to 19 of 27, so the choice of rule for each line matters. High.
- Worth telling a monospace line by its runs, where width divided by length is the same for every run of a font, and not by the font's name. A PDF often renames its fonts. High.
- Worth writing chords inline in brackets. A chord row padded with spaces goes through the page-copy rules of `readPaste`, which guess. High.
- The library needs its worker file as a separate asset. Vite gives an address for it with a `?url` import. High.
- Worth reading how `stampServiceWorker` in `vite.config.ts` builds the file list before editing it. The list is every file in the build folder. Medium.
- The library ships a second build for older browsers. It is 552 KB gzipped against 515 KB. Pick one from the browsers the app supports, and say which in the report. Medium.
- Skip the library's character map and standard font folders. A PDF that needs them is a **Check this** or a **Couldn't read**, and the folders add over 2 MB. Low.
