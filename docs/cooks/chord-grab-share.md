# Cook brief: `chord-grab-share`

Not queued. This brief waits for the owner's review, and for a yes on decision D9. Model: Opus. Plan: `docs/PLAN-chord-grab.md`.

```text
## HANDOFF
GOAL: On an Android phone with the app installed, a player shares a chart selected on any page from the browser to the app. The New song editor opens with the chart as the real sheet. A shared chart needs no network. A shared link to a listed site opens that page for the player to copy. A shared link the app cannot read says so and points at Paste.
DECIDED: one cook, one branch, cook/chord-grab-share off mls-int-20261113 after chord-grab-app has merged; the manifest gains a share_target with POST; the service worker answers that POST on the phone, so the shared text reaches no server; the app takes the share once at start; a shared chart goes through readPaste and a shared link to a listed site opens that page as a Grab; both open the editor through the start draft of chord-grab-app; the app never fetches a shared link; nothing is built for an iPhone.
REJECTED: a GET share target, which puts the chart in a request address; any request that carries shared text to a server; a fetch of a shared link; a second editor; a second place that keeps the share after it is read; a change to how the service worker serves any GET; new libraries; edits to worker files; edits outside the owned files.
DONE MEANS: cases S1 to S10 of plan section 4 each have a named check line that failed on the tests-only commit and passes now; the boxes under "Verification (cook 2)" in section 4 are ticked with their evidence in the report, with the owner's phone box left for the owner; check:offline passes with no edit to its script; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-chord-grab.md sections 1 and 4.
NEEDS OWNER: D9 must be yes. The owner runs the phone box on an Android phone in Preview before merge.
```

# Share a chart to the app

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full. The app never fetches a shared link. Shared text stays on the phone.

## What the player can do

1. On a chart page in Chrome on Android, select the chart, tap Share, and pick the app. The chart opens as a sheet to review, with or without a network.
2. Share a link to a listed site, and the app opens that page for the player to copy.
3. Tap **Save**. The song is in My Songs.

An iPhone has no share target for a web app. Nothing in this cook changes what an iPhone does. The path there is cook 1: copy, come back, and use the auto-read or **Paste**.

## Check the phone facts first

Plan section 4 lists facts from memory. Confirm each before any other work, and put what was found in the report.

1. Chrome on Android offers an installed web app as a share target, and what the install needs from the manifest.
2. Which of the three fields hold the address when a page is shared, and which hold the words when a selection is shared.
3. Whether the manifest's one SVG icon is enough for the install.

If the first fact is false on the test phone, stop and write `QUESTIONS.md`.

## Tests first

Commit 1 holds `scripts/check-grab-share.ts` and its one `package.json` line, and nothing else. Cases S1 to S10 of plan section 4 fail on that commit. Paste the failing run into the report. Each case prints one named `ok` or `FAIL` line.

Case S1 runs in node. The other cases drive headless Chrome. A case stands in for the phone's share sheet by submitting a form `POST` to the share action from the app's own page. The check answers `/api/me` from a stub, as `scripts/check-chord-grab.ts` does, and never stubs a page-fetch route, because there is none.

## Owned files

| File | Change |
|---|---|
| `public/manifest.webmanifest` | The `share_target`. PNG icons only if the phone test asks for them. |
| `public/sw.js` | One branch for the share `POST`. Keep the `BUILD` line as it is. |
| `src/share-entry.ts` | New. Take the share once, and the pure sorting function. |
| `src/chord-grab.tsx` | The words for a shared link the app cannot read. |
| `src/song-editor.tsx` | Only if the start draft lacks a field this cook needs. |
| `src/App.tsx` or `src/main.tsx` | Call the entry at start. At most three new lines in `src/App.tsx`, which must stay at 500 lines or fewer. |
| `scripts/check-grab-share.ts` | New. |
| `package.json` | One line, `check:grab-share`. |

Do not touch: `src/song-paste.ts`, `src/chord-grab.ts` apart from an import, worker files, `data/chord-sites.json`, `scripts/check-offline.ts`, and earlier check scripts.

## Shapes to freeze

`Shared` as plan section 4 gives it. A text that holds a chart and an address is `text`. A text that is only an address, or a title line and an address, is `link`.

## Empty and error states, and the wired flow

Every row of the table in plan section 4 has its words on the screen and a case. A share with nothing usable opens the New song editor with "Paste your sheet into the box." A signed-out visitor sees the landed sign-in sheet and can close it. The share is held in memory for that page and is dropped on a reload. A second account on the phone never sees a share that arrived for the first.

The share is read once. After the read, the phone's cache no longer holds it, and the address bar holds no shared text.

Flow: Chrome, Share, the app, the New song editor with the sheet, **Save**, the sheet opens.

## Checks

`npm run build`, `check:grab-share`, `check:offline`, `check:chord-grab`, `check:new-song`, `check:song-paste`, `check:one-copy`, `check:portable`.

## Hints

- Worth reading `public/sw.js` whole first. Its `fetch` handler returns at once for any request that is not a `GET`. The new branch goes in front of that line and matches one method and one path. High.
- Worth answering the share `POST` with a redirect to the app's start page. The page then loads from the cache as on any offline start. High.
- Worth keeping the share in the service worker's own cache under one fixed key, and deleting it in the same step that reads it. High.
- Worth making the sorting function pure and testing it in node before any browser case. High.
- In headless Edge on the laptop, a blocked address does not block every request. Cut the network with the offline emulation for S3 and S7, and prove it with a probe fetch. Medium.
- If the phone asks for PNG icons, render them from `public/favicon.svg` with the repo's Chrome driver. Add no image library. Medium.
- Count the lines of `src/App.tsx` before the first edit. Medium.
