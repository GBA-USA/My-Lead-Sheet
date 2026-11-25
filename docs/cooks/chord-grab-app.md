# Cook brief: `chord-grab-app`

Not queued. This brief waits for the owner's review. Model: Opus. Plan: `docs/PLAN-chord-grab.md`.

```text
## HANDOFF
GOAL: A signed-in player taps Grab on a search result, is taken to a listed chord site, copies the chart there, comes back, and sees the song's chart as the real sheet with the title, artist and length filled in, then taps Save. The song is in My Songs and opens with no network. If the app cannot read the clipboard, a visible Paste button does the same thing in one tap.
DECIDED: one cook, one branch, cook/chord-grab-app off mls-int-20261113 after PR 116 (song-paste-autofill) has merged; the search list stays the song catalog and each row gains a Grab button (plan decision D5); Grab opens the first listed site in the system browser (D12) and waits; on return the app tries a clipboard read and takes the text as a paste through readPaste, the same path PR 116 uses; a visible Paste button is required; the catalog row wins for title, artist and length; a grabbed song carries a credit line in Song.sourceNote (D6); the first Grab shows the note of plan section 5 once, and the privacy page gains its two sentences (D7); the sites and their order are Chordie, GuitarTabs.cc, E-Chords (D4); the app never fetches a chord site's page; the state of a Grab is one value from the driver in src/chord-grab.ts.
REJECTED: a Worker or phone fetch of a chart page; a second editor or a second preview; a second chart reader; a site address or a site id in src/; a song saved before the player taps Save; a page's title written over one the player typed; the clipboard text kept anywhere but the editor's box; an in-app browser or a button injected onto the site; new libraries; edits to worker files; edits outside the owned files.
DONE MEANS: cases A1 to A20 of plan section 1 each have a named check line that failed on the tests-only commit and passes now; the boxes under "Verification (cook 1)" in section 1 are ticked with their evidence in the report; src/App.tsx is at most 500 lines; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-chord-grab.md sections 1, 2, 3 and 5.
NEEDS OWNER: D4 to D7 and D12 answered before this cook starts. The cook changes an interaction, so the owner reviews it on a phone in Preview before merge.
```

# Grab opens the site, and the app pastes on return

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full. The app never fetches a chord site's page. It opens a listed address in the player's browser. Clipboard text stays on the phone.

## What the player can do

1. Type a song in **Find a song to add**. Each row has a **Grab** button.
2. Tap **Grab**. The New song editor opens with the title, artist, and length. The first site opens in the system browser. The status line says **Copy the chart on the site, then come back.** and shows **Paste**, **Cancel**, and **Try another site**.
3. Copy the chart on the site, come back, and, if the chart is not already in the box, tap **Paste**.
4. Tap **Save**. The song is in My Songs and opens with no network.
5. On a sheet with no chart, tap **Grab chords**. In the editor, tap **Grab chords** beside **Paste a sheet**.

## Tests first

Commit 1 holds `scripts/check-chord-grab.ts` and its one `package.json` line, and nothing else. Cases A1 to A20 of plan section 1 fail on that commit. Paste the failing run into the report. Each case prints one named `ok` or `FAIL` line.

Cases A1 to A6 run in node on the address builder and the clipboard driver. The other cases drive headless Chrome through `scripts/chrome.ts` and `scripts/app-page.ts`. The check opens no live chord site. It stubs `window.open` and `navigator.clipboard`. Every chart in the check is written for the check, with made-up words.

## Owned files

| File | Change |
|---|---|
| `src/chord-grab.ts` | Add the types, the address builder, and the clipboard driver. |
| `src/chord-grab.tsx`, `src/chord-grab.css` | New. The **Grab** button, the waiting line, **Paste**, **Try another site**, the first-use note, the `MESSAGES` map from `GrabStop` to words. |
| `src/song-editor.tsx`, `src/song-editor.css` | `SongEdit` gains a start draft. A returned or pasted text goes through `takePaste`, the PR 116 path. The length and the credit line reach the saved song. **Grab chords** sits beside **Paste a sheet**. |
| `src/song-search.tsx`, `src/song-search.css` | The button on a row, **Grab chords** in `NoWordsYet`, the hint line above the list. |
| `src/library-lists.tsx`, `src/App.tsx` | Pass the start draft to the editor. At most three new lines in `src/App.tsx`, which must stay at 500 lines or fewer. |
| `src/data-kinds.ts`, `scripts/build-privacy.ts` | The first-use flag as a data kind, and the two sentences of plan section 5. |
| `data/chord-sites.json` | New. One row for each site: `id`, `name`, `origin`, and the open-address rule. |
| `scripts/check-chord-grab.ts` | New. |
| `scripts/check-one-copy.ts` | New rows only. |
| `package.json` | One line, `check:chord-grab`. |

Do not touch: `src/song-paste.ts`, `src/song-text.ts`, `src/song-search.ts`, `src/sheet.tsx`, `src/storage.ts`, worker files, and earlier check scripts apart from the new rows in `scripts/check-one-copy.ts`.

## Shapes to freeze

The types in plan section 1, and the start draft the editor takes. Cook 2 and the bulk import cook use the same start draft. If `mls-int-20261113` already has a start draft from another cook, use that one and add only the fields it lacks.

## Empty and error states, and the wired flow

Every row of the table "What the player sees when something fails" in plan section 1 has its words on the screen, and the table's last column names the cases that test the row. The words live in one `MESSAGES` map in `src/chord-grab.tsx`.

Each `GrabStop` value has its own row in that table and a non-empty entry in `MESSAGES`. With Grab off (an empty site table), no **Grab** control is drawn anywhere and no site opens. A signed-out visitor never sees the search box, as today. A session that ended during a wait opens the landed sign-in sheet, which can be closed. A storage failure on **Save** keeps the editor open with the landed message.

A Grab ends early in four ways, and each one drops a later clipboard read: a tap on **Cancel**, a keystroke in the editor's text box, the editor closing, and a sign-out or an account switch. No song is added, what the player typed stays in the box, and no chart lands in the next account's editor. Cases A19 and A20 test this through the screen. A5 tests the driver.

**Grab chords** in the editor is drawn only when Grab is on and the title is not blank, and an `off` stop hides it too. Case A18 tests it.

Flow: My Songs, type a title, **Grab**, copy on the site, return or **Paste**, the sheet in the review, **Save**, the sheet opens.

## Checks

`npm run build`, `check:chord-grab`, `check:song-search`, `check:song-paste`, `check:new-song`, `check:chords`, `check:screens`, `check:phone-layout`, `check:privacy`, `check:storage`, `check:one-copy`, `check:portable`.

## Hints

- Worth writing the address builder and the clipboard driver, and cases A1 to A6, before any screen. High.
- Worth knowing that a clipboard read on focus is often refused. **Paste** is a click, and it is the path that must work, especially on an iPhone. High.
- Worth taking the returned text with `takePaste(text, before)`, where `before` is the box as it was before the first Grab. **Try another site** then replaces the first chart and never stacks a second one under it. High.
- Worth keeping the row's own button as it is and adding **Grab** as a second button in the same list item. `check:song-search` taps the row. High.
- The editor's `stored()` builds the song from the form. The length and the credit line are not form fields, so carry them beside the form and add them in `stored()`. Medium.
- `check:privacy` fails on an apostrophe. The two sentences in plan section 5 have none. Medium.
- `check:screens` bans component names as visible words. Read it before naming a label. Medium.
- Count the lines of `src/App.tsx` before the first edit. The cap is 500. Medium.
- React 19 runs click effects after the tap. Open the site inside the click handler. Medium.
- If the build grows past 232 KB gzipped, load `src/chord-grab.tsx` with `import()` when the search box first takes focus. Low.
