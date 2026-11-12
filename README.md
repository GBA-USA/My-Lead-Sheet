# Lead Sheets

A personal bass-player lead-sheet library for Brian Prewitt. Phase 1 is a static single-page app: My Songs, the full sheet, and the setlist list. The library lives in this browser only. There is no shared song pool.

## Run

```bash
npm install
npm run check:data
npm run dev
```

`npm run build` writes a GitHub Pages bundle to `dist/` (`base` is relative, so it works as a project site). The seed file is `data/library.json`.

## On a phone

After the Pages workflow on `main` succeeds, the site is:

https://bprewitt11-creator.github.io/My-Lead-Sheet/

Song links use the hash (`#/song/10`), so they load from that same page. `public/404.html` sends any other path back to the site root. Pages has to use GitHub Actions as its source (Settings → Pages) before the deploy step can publish.

## Phase 1

- Library list, song view, setlists list.
- Sticky song header: text size, Screen on, overflow menu, Notes | Nashville, scroll, and the compact transpose strip. Phone width uses three slim rows. At 768px and up the transpose strip joins the notation and scroll row.
- A− / A+ scales the sheet. Edit and Delete are in the ••• menu.
- First visit copies the seed library into `localStorage` (`leadSheetsLibrary`). Song id 12, the empty duplicate of id 13, is not in the seed.

Transpose, Nashville conversion, auto-scroll, the wake lock, Live Mode, editing, and adding songs are later phases. Screen on stores `leadSheetsKeepAwake` and does not call the Wake Lock API yet.

The behavior spec, the build plan, the original export, and the phone screenshots are in `docs/handoff/`. See `ANALYSIS.md` for the data check and the open questions.
