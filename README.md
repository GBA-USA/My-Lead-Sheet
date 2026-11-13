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

Phase 2 is in the song header and Live Mode: transpose, Notes | Nashville, BPM auto-scroll, the screen wake lock, and playing a setlist. Editing, delete, and adding songs are still later phases. Screen on stores `leadSheetsKeepAwake` and, while it is On, asks the browser to keep the screen awake.

The song sheet has its own metronome, under the Key / Time / Tempo line. It opens on the song's stored BPM. Tap the number to change that speed, double-tap Metronome to start or stop, and use Stop while it is playing. The speed is a performance setting only: it is not written back onto the song, and a song with `tempo: null` stays unset until you type one. Auto-scroll keeps using the stored tempo (90 BPM only when tempo is null) and the scroll percentage. Changing the metronome does not change auto-scroll, and changing the scroll percentage does not change the metronome.

The behavior spec, the build plan, the original export, and the phone screenshots are in `docs/handoff/`. See `ANALYSIS.md` for the data check and the open questions.
