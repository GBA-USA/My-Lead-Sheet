# Cook brief: `chord-grab-app`

Not queued. This brief waits for the owner's review. Model: Opus. Plan: `docs/PLAN-chord-grab.md`.

```text
## HANDOFF
GOAL: A signed-in player taps Grab on a search result, sees the song's chart as the real sheet with the title, artist and length filled in, and taps Save. The song is in My Songs and opens with no network. When no site has the chart, the player sees why and is one tap from the web search and the paste.
DECIDED: one cook, one branch, cook/chord-grab-app off mls-int-20261113 after chord-grab-worker and PR 116 (song-paste-autofill) have merged and gate G1 (plan section 7) has passed; the search list stays the song catalog and each row gains a Grab button (plan decision D5); Grab opens the one SongEditor with a start draft, and the grabbed text is taken as a paste through readPaste; the first row is fetched at once and the others sit under Try another version; the catalog row wins for title, artist and length; a grabbed song carries a credit line in Song.sourceNote (D6); the first Grab shows the note of plan section 5 once, and the privacy page gains its two sentences (D7); the state of a Grab is one value from grabber in src/chord-grab.ts.
REJECTED: a second editor or a second preview; a second chart reader; a site address or a site id in src/; a request from the phone to a chord site; a song saved before the player taps Save; a page's title written over one the player typed; the grabbed text kept anywhere but the editor's box; any new localStorage key except the first-use flag; new libraries; edits to worker files; edits outside the owned files.
DONE MEANS: cases A1 to A17 of plan section 1 each have a named check line that failed on the tests-only commit and passes now; the boxes under "Verification (cook 2)" in section 1 are ticked with their evidence in the report; src/App.tsx is at most 500 lines; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-chord-grab.md sections 1 and 5.
NEEDS OWNER: D5 to D7 answered, and gate G1 (plan section 7) passed, before this cook starts. A G1 table that stops the feature means this cook does not run. The cook changes an interaction, so the owner reviews it on a phone in Preview before merge.
```

# Grab in the search list

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full. The owner lifted the rule "the app never fetches chord pages" for this feature. The phone still contacts no chord site. It asks the app's own Worker.

## What the player can do

1. Type a song in **Find a song to add**. Each row has a **Grab** button.
2. Tap **Grab**. The New song editor opens with the title, artist, and length. It says **Looking for chords…**, then shows the chart as the real sheet, with **Chords from** and the site's name on the status line.
3. Tap **Try another version** to swap the chart, or **Look on another site**. Tap a chip to take a key or a BPM. Edit anything.
4. Tap **Save**. The song is in My Songs and opens with no network.
5. On a sheet with no chart, tap **Grab chords**. In the editor, tap **Grab chords** beside **Paste a sheet**.

## Tests first

Commit 1 holds `scripts/check-chord-grab.ts` and its one `package.json` line, and nothing else. Cases A1 to A17 of plan section 1 fail on that commit. Paste the failing run into the report. Each case prints one named `ok` or `FAIL` line.

Cases A1 to A6 run in node on `grabber` with a stub `api` and stub timers. The other cases drive headless Chrome through `scripts/chrome.ts` and `scripts/app-page.ts`. The check starts no Worker. It answers `/api/me`, `/api/auth/config`, and `/api/grab/*` from a stub, as `scripts/check-song-search.ts` answers the catalog. Every chart in the check is written for the check, with made-up words.

## Owned files

| File | Change |
|---|---|
| `src/chord-grab.ts` | Add `grabber(deps)`. Keep the types as cook 1 froze them. |
| `src/chord-grab.tsx`, `src/chord-grab.css` | New. The **Grab** button, the status line, **Try another version**, the first-use note, the `MESSAGES` map from `GrabStop` to words. |
| `src/song-editor.tsx`, `src/song-editor.css` | `SongEdit` gains a start draft. A grabbed text goes through `takePaste`. The length and the credit line reach the saved song. **Grab chords** sits beside **Paste a sheet**. |
| `src/song-search.tsx`, `src/song-search.css` | The button on a row, **Grab chords** in `NoWordsYet`, the hint line above the list. |
| `src/library-lists.tsx`, `src/App.tsx` | Pass the start draft to the editor. At most three new lines in `src/App.tsx`, which must stay at 500 lines or fewer. |
| `src/data-kinds.ts`, `scripts/build-privacy.ts` | The first-use flag as a data kind, and the two sentences of plan section 5. |
| `scripts/check-chord-grab.ts` | New. |
| `scripts/check-one-copy.ts` | New rows only. |
| `package.json` | One line, `check:chord-grab`. |

Do not touch: `src/song-paste.ts`, `src/song-text.ts`, `src/song-search.ts`, `src/sheet.tsx`, `src/storage.ts`, worker files, `data/chord-sites.json`, and earlier check scripts apart from the new rows in `scripts/check-one-copy.ts`.

## Shapes to freeze

The start draft the editor takes. Cook 4 and the bulk import cook use the same one.

```ts
/** What an editor opens with when something other than the player's typing starts the song. */
export type SongStart = {
	title?: string;
	artist?: string;
	lengthSec?: number | null;
	/** Text to take as a paste when the editor opens. */
	paste?: string;
	/** Start a Grab when the editor opens: the song's own title and artist, or one page address. */
	grab?: true | { url: string };
};
```

If `mls-int-20261113` already has a start draft from another cook, use that one and add only the fields it lacks.

## Empty and error states, and the wired flow

Every row of the table "What the player sees when something fails" in plan section 1 has its words on the screen and a case in A12. The words live in one `MESSAGES` map in `src/chord-grab.tsx`.

Each `GrabStop` value has its own row in that table and a non-empty entry in `MESSAGES`. With Grab off, no **Grab** control is drawn anywhere and no request leaves. Grab can also go off after the buttons are drawn, when the server passes its daily count or the owner empties `GRAB_SITES`. That 503 `grab-off` shows the `off` words and hides every **Grab** control for the rest of the session. A 500, or a reply the phone cannot read, shows the `failed` words with **Try again**. A signed-out visitor never sees the search box, as today. A session that ended during a Grab opens the landed sign-in sheet, which can be closed. A storage failure on **Save** keeps the editor open with the landed message. Typing in the search box, closing the editor, or leaving the screen during a Grab drops the replies and adds no song.

Flow: My Songs, type a title, **Grab**, **Looking for chords…**, the sheet in the review, **Save**, the sheet opens.

## Checks

`npm run build`, `check:chord-grab`, `check:song-search`, `check:song-paste`, `check:new-song`, `check:chords`, `check:screens`, `check:phone-layout`, `check:privacy`, `check:storage`, `check:one-copy`, `check:portable`.

## Hints

- Worth writing `grabber` and cases A1 to A6 before any screen. Copy the shape of `catalogSearcher`: injected `api` and timers, a counter that drops a late reply. High.
- Worth knowing that a signed-in player's app never reads `/api/auth/config` today. Only `usePreviewEntry` reads it when signed out, and the account sheet reads it in `src/account.tsx`. So read `/api/auth/config` once after sign-in through `src/sign-in-methods.ts`, keep the answer as one session switch in `src/chord-grab.tsx`, and let an `off` stop turn the same switch off. `check:song-search` case 2d logs only cross-origin calls, and its stub passes every same-origin fetch through, so this read does not trip it. A caught 404 from a stub server adds no page error either. A row tap must still send nothing new. High.
- Worth taking the grabbed text with `takePaste(text, before)`, where `before` is the box as it was before the first Grab. **Try another version** then replaces the first chart and never stacks a second one under it. High.
- Worth keeping the row's own button as it is and adding **Grab** as a second button in the same list item. `check:song-search` taps the row. High.
- The editor's `stored()` builds the song from the form. The length and the credit line are not form fields, so carry them beside the form and add them in `stored()`. Medium.
- `check:privacy` fails on an apostrophe. The two sentences in plan section 5 have none. Medium.
- `check:screens` bans component names as visible words. Read it before naming a label. Medium.
- Count the lines of `src/App.tsx` before the first edit. It had 490 at `b2b248a`, and the cap is 500. Medium.
- React 19 runs click effects after the tap. Start the Grab inside the click handler. Medium.
- If the build grows past 232 KB gzipped, load `src/chord-grab.tsx` with `import()` when the search box first takes focus. Low.
