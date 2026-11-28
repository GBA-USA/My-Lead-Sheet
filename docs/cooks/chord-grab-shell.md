# Cook brief: `chord-grab-shell`

Not queued. This brief waits for the owner's review. Model: Opus. Plan: `docs/PLAN-chord-grab.md`.

```text
## HANDOFF
GOAL: The installed app can open a listed chord site in an in-app browser our app controls, with a floating Grab button in our chrome. A tap on Grab runs an extractor in that WebView and returns the text to the web app. The existing My Songs flow still works. Nothing is submitted to a store.
DECIDED: one cook, one branch, cook/chord-grab-shell off mls-int-20261113; Capacitor wraps the existing web app (plan decision D12); the Grab button is a native control in our chrome, not a node in the site's document; the wrapper loads the live https address, not a proxied copy; extraction runs only after a tap; the bridge is a no-op in an ordinary browser tab; no store submission (D14); the Worker never fetches a chord site's page, and the phone does not fetch one either.
REJECTED: a proxied page; a bookmarklet as the main path; Chrome Custom Tabs or Safari View Controller as the wrapper; injecting a button that pretends to be the site's; a background scrape while the player browses; sending page HTML to our server; a store submission; a rewrite of the existing web app; edits outside the owned files.
DONE MEANS: cases H1 to H8 of plan section 1 each have a named check line that failed on the tests-only commit and passes now; the boxes under "Verification (cook 1)" in section 1 are ticked with their evidence in the report; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-chord-grab.md sections 1 and 2.
NEEDS OWNER: D12 and D14 answered before this cook starts. The cook is reviewed on a phone dev install before merge.
```

# The in-app browser and the floating Grab button

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full. The Worker never fetches a chord site's page, and the phone does not `fetch` one either. The wrapper loads the live site. Extraction runs only after a tap.

## What the player can do

1. In a dev install, open a listed site in our in-app browser.
2. See a floating **Grab** button in our chrome, not inside the site's page.
3. Tap **Grab** and have the page's text returned to the app. Tap close or **Cancel** to go back with no song added.

## Tests first

Commit 1 holds `scripts/check-grab-shell.ts` and its one `package.json` line, and nothing else. Cases H1 to H8 of plan section 1 fail on that commit. Paste the failing run into the report. Each case prints one named `ok` or `FAIL` line.

## Owned files

Capacitor config, the official iOS and Android project files the tool adds, a small Grab-browser plugin, `src/chord-grab-bridge.ts`, `scripts/check-grab-shell.ts`, `package.json` (the Capacitor wiring this cook must have, plus one `check:grab-shell` line).

Do not touch: `src/song-paste.ts`, `src/song-text.ts`, `src/song-search.ts`, `src/song-search.tsx`, `src/song-editor.tsx`, `src/sheet.tsx`, worker files, and earlier check scripts.

## Empty and error states, and the wired flow

The bridge is a no-op in an ordinary browser tab and reports that the wrapper is missing. Closing the wrapper or **Cancel** returns to the editor and adds no song. An unreadable extract leaves the wrapper open. Page HTML is never sent to our server.

Flow: installed app, open a listed address, floating **Grab**, text returns, or close.

## Checks

`npm run build`, `check:grab-shell`, `check:portable`, and a signed-in smoke of My Songs on the dev install.

## Hints

- Worth putting the **Grab** button in native chrome, not in the site's document, so the site cannot hide it. High.
- Worth loading the live `https` address in the WebView, not a proxied copy. High.
- Worth making the web bridge a no-op when Capacitor is missing, and never falling back to `window.open` as a silent stand-in. High.
- Do not submit to a store in this cook. A local dev install is enough for the live box. High.
- The existing web app stays the UI. This cook adds a shell and a plugin, it does not rewrite My Songs. High.
