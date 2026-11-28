# Cook brief: `chord-grab-app`

Not queued. This brief waits for the owner's review. Model: Opus. Plan: `docs/PLAN-chord-grab.md`.

```text
## HANDOFF
GOAL: A signed-in player taps Grab on a search result, lands on a listed chord site in our in-app browser, taps the floating Grab button, and sees the song's chart as the real sheet with the title, artist and length filled in, then taps Save. The song is in My Songs and opens with no network. If the extractor cannot read the page, a Paste fallback stays in the wrapper.
DECIDED: one cook, one branch, cook/chord-grab-app off mls-int-20261113 after chord-grab-shell and PR 116 (song-paste-autofill) have merged; the search list stays the song catalog and each row gains a Grab button (plan decision D5); Grab opens the wrapper on the first listed site; a tap on the floating Grab extracts the chord and lyric block with the per-site recipes and takes it as a paste through readPaste, the same path PR 116 uses; a Paste fallback is only for an unreadable page; the catalog row wins for title, artist and length; a grabbed song carries a credit line in Song.sourceNote (D6); the first Grab shows the note of plan section 5 once, and the privacy page gains its two sentences (D7); the sites and their order are Chordie, GuitarTabs.cc, E-Chords (D4); Ultimate Guitar is not opened; the Worker never fetches a chord site's page; the state of a Grab is one value from the driver in src/chord-grab.ts.
REJECTED: a Worker or phone fetch of a chart page; a second editor or a second preview; a second chart reader; a site address or a site id in src/; a song saved before the player taps Save; a page's title written over one the player typed; an extraction that runs before the player taps Grab; a share target in this cook; new libraries; edits to the native shell except to call the bridge; edits outside the owned files.
DONE MEANS: cases A1 to A20 of plan section 1 each have a named check line that failed on the tests-only commit and passes now; the boxes under "Verification (cook 2)" in section 1 are ticked with their evidence in the report; src/App.tsx is at most 500 lines; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-chord-grab.md sections 1, 2, 3 and 5.
NEEDS OWNER: D4 to D7 answered, and chord-grab-shell merged, before this cook starts. The cook changes an interaction, so the owner reviews it on a phone in a Preview or dev install before merge.
```

# Grab opens the wrapper, extracts the chart, and pastes it

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full. The Worker never fetches a chord site's page. Extraction runs only after a tap on the floating **Grab** button. The happy path has no manual select-and-copy.

## What the player can do

1. Type a song in **Find a song to add**. Each row has a **Grab** button.
2. Tap **Grab**. The New song editor opens, and the first site opens in our in-app browser with a floating **Grab** button.
3. When the chart is on the screen, tap **Grab**. The app pastes the chart into the sheet.
4. If the app cannot read the page, select the chart and tap **Paste**.
5. Tap **Save**. The song is in My Songs and opens with no network.

## Tests first

Commit 1 holds `scripts/check-chord-grab.ts` and its one `package.json` line, and nothing else. Cases A1 to A20 of plan section 1 fail on that commit. Paste the failing run into the report. Each case prints one named `ok` or `FAIL` line.

Cases A1 to A6 run in node on the address builder and the recipes. The other cases drive headless Chrome with the native bridge stubbed. Every chart in the check is written for the check, with made-up words. The check opens no live chord site.

## Owned files

| File | Change |
|---|---|
| `src/chord-grab.ts` | Add the types, the address builder, the recipes, and the screen driver. |
| `src/chord-grab.tsx`, `src/chord-grab.css` | New. The **Grab** button, the status line, the first-use note, the `MESSAGES` map from `GrabStop` to words. |
| `src/song-editor.tsx`, `src/song-editor.css` | `SongEdit` gains a start draft. Extracted text goes through `takePaste`, the PR 116 path. |
| `src/song-search.tsx`, `src/song-search.css` | The button on a row, **Grab chords** in `NoWordsYet`. |
| `src/library-lists.tsx`, `src/App.tsx` | Pass the start draft to the editor. At most three new lines in `src/App.tsx`, which must stay at 500 lines or fewer. |
| `src/data-kinds.ts`, `scripts/build-privacy.ts` | The first-use flag, and the two sentences of plan section 5. |
| `data/chord-sites.json` | New. One row for each site: `id`, `name`, `origin`, the open-address rule, and the recipe name. |
| `scripts/check-chord-grab.ts` | New. |
| `scripts/check-one-copy.ts` | New rows only. |
| `package.json` | One line, `check:chord-grab`. |

Do not touch: `src/song-paste.ts`, `src/song-text.ts`, `src/song-search.ts`, `src/sheet.tsx`, `src/storage.ts`, worker files, the native shell except to call `src/chord-grab-bridge.ts`, and earlier check scripts apart from the new rows in `scripts/check-one-copy.ts`.

## Shapes to freeze

The types in plan section 1, and the start draft the editor takes. If `mls-int-20261113` already has a start draft from another cook, use that one and add only the fields it lacks.

## Empty and error states, and the wired flow

Every row of the table "What the player sees when something fails" in plan section 1 has its words on the screen. The words live in one `MESSAGES` map in `src/chord-grab.tsx`. In an ordinary browser tab, a tap on **Grab** takes the `web-only` path and does not open a site.

Flow: My Songs, type a title, **Grab**, land on the site, tap the floating **Grab**, the sheet in the review, **Save**, the sheet opens.

## Checks

`npm run build`, `check:chord-grab`, `check:grab-shell`, `check:song-search`, `check:song-paste`, `check:new-song`, `check:chords`, `check:screens`, `check:phone-layout`, `check:privacy`, `check:storage`, `check:one-copy`, `check:portable`.

## Hints

- Worth writing the three recipes and cases A1 to A6 in node before any screen. High.
- Worth taking extracted text with `takePaste(text, before)`, where `before` is the box as it was before the first Grab. High.
- Worth keeping the row's own button as it is and adding **Grab** as a second button in the same list item. `check:song-search` taps the row. High.
- `check:privacy` fails on an apostrophe. The two sentences in plan section 5 have none. Medium.
- Count the lines of `src/App.tsx` before the first edit. The cap is 500. Medium.
