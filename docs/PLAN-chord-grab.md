# Plan: search a song, grab its chord sheet

Written Nov 25, 2026 against `b2b248a`, and revised the same day at 11:23 AM ET after the owner's change (t350u). This revision is against `fcffb43` (PR 116, song-paste-autofill, and PR 118, the first grab plan, are both merged). This plan changes no app code.

## Summary and landing order

The goal is one flow. A player types a song, taps **Grab**, is taken to the chord site, copies the chart themselves, comes back, and the app pastes it in. The saved song is in the library and plays with no network.

Today a pick gives a sheet with a title, an artist, and a length. The chart is empty. The player then opens a web search, copies a chart, comes back, and pastes it. Smart paste reads that copy well since PR 115, and PR 116 fills the title and the other facts from the paste. The trip is still manual: the player has to find the page.

The first plan (PR 118) had the app's Cloudflare Worker search the sites, fetch the chart page, and extract the sheet. The owner changed that on Nov 25, 2026: the app takes the player to the site, the player taps copy, and the app pastes the chart when they return. The point is that the player actively retrieves the lyrics. It is not the app alone. The Worker no longer fetches chord sheets. The Nov 24 lift of the "never fetch page content" rule is not used for this feature.

After the two cooks below, a Grab does this:

1. The player taps **Grab** on a catalog search row.
2. The app opens the first listed chord site in the system browser, on a search or chart address built from the title and artist. The phone does not fetch the page's HTML, and neither does a Worker.
3. The player lands on the page and copies the chart: the site's own copy or print button when it has one, or select the chart and copy, or, on Android in an installed app, Share to the app.
4. The player returns to the app. On focus the app tries to read the clipboard and runs the text through `readPaste`, the same path PR 116 uses for a paste, with the catalog row's title, artist, and length already filled in. If the browser will not give the clipboard, a visible **Paste** button does the same thing in one tap.
5. The player reviews the real sheet and taps **Save**. A title is required. The song is in My Songs and works offline.

The cooks land in this order.

| Order | Cook | What the player gains | Waits for |
|---|---|---|---|
| 1 | `chord-grab-app` | **Grab** opens the site, return-and-paste, the **Paste** fallback, and the credit line | PR 116 (merged), and owner decisions D4 to D7 and D12 |
| 2 | `chord-grab-share` | On Android, a chart selected on the site and shared to the app becomes a sheet | Cook 1, owner decision D9 |

```text
PR 116 (merged)
chord-grab-app ──► chord-grab-share
```

Two cooks from the first plan are dropped. `chord-grab-worker` fetched and parsed chart pages on the server, which the owner no longer wants. `chord-grab-canary` watched that parse for layout breaks, so it goes with it. Rate limits and `robots.txt` notes from the first plan are mostly moot, because the player is browsing the site as a person.

The site set and its order stay: Chordie, then GuitarTabs.cc, then E-Chords. A grabbed song still carries a credit line, such as "Chords from Chordie".

## What was measured for this plan

The numbers in this section come from Nov 25, 2026, and were gathered for the first plan, when the Worker was going to fetch pages. Each fetch happened once, from a laptop on a home connection, for Brown Eyed Girl by Van Morrison. This revision does not build a server fetch, so the numbers are not a gate. They still help in two ways: they show that text copied from these pages goes through `readPaste` well, and they record the search and chart address shapes the app will open.

### The test fetches

Seventeen requests went to seven sites. Each site got at most three. Five sites answered a plain request: Chordie, GuitarTabs.cc, E-Chords, Ultimate Guitar, and Cifra Club. Ultimate Guitar and Cifra Club are not in the first site set. The replies were deleted after the run.

| Site | What we will open | What the page held |
|---|---|---|
| Chordie | A search address with the title and artist, then the player taps a result | Chord boxes over words, a title, an artist |
| GuitarTabs.cc | A search address with the title and artist, then the player taps a result | The chart in a `<pre>`, with an old mail header at the top |
| E-Chords | A chart address built from the artist and the title | The chart in a `<pre>`, with the title and artist in headings |

Text taken from those three pages went through `readPaste` with no change to the reader. The sheet kept 35 of 37, 37 of 37, and 96 of 96 of the page's chords on the first two and on E-Chords. That still matters, because a player's copy of the same page takes the same path.

### What was not measured, and what is now moot

- **No site's own copy or print button was tried.** Cook 1 checks each of the three sites on a phone and writes what the player can tap. Until then the waiting screen tells the player to use the site's copy or print control if it has one, or to select the chart and copy.
- **Clipboard read on return was not tried** on iPhone, Android, or a desktop browser. Cook 1 treats a refused or empty read as normal and keeps **Paste** in view. Section 1 states the permission rules.
- **`robots.txt` and server rate limits are mostly moot.** The player is visiting the site in their own browser. The app does not fetch the page and does not crawl.
- **No request will be sent from a Cloudflare Worker** for this feature. A laptop answer from the first plan is not used as a Worker forecast, because there is no Worker fetch to forecast.
- **No terms page was read.** Section 5 states the remaining risk.
- **The E-Chords page address is built from a guess at the site's rule for names.** It worked for one song. An artist with an accent or a "The" in front is untested. Cook 1's cases include the built path, and the owner can **Try another site** if the page is wrong.
- **Share target facts are from memory.** Chrome's rules for installing the app, the fields a share carries, and Safari's lack of a share target were not checked on a phone. Cook 2 checks them before it builds.

## Changes to the brief, and why

The brief for this revision is the owner's change of Nov 25, 2026. Each change from the first plan is listed with its reason. None touches the fixed rules: the player copies the chart, the app never fetches a chord site's page, no outside address in `src/`, offline after Save, a title required to save, and no app code in this cook.

1. **The app takes the player to the site.** The first plan fetched the page and extracted the chart. The owner wants the player on the page, tapping copy, so the retrieval is theirs. Grab now opens the site in the system browser.
2. **The Worker no longer fetches chord sheets.** The `chord-grab-worker` and `chord-grab-canary` cooks are dropped. Nothing in this plan adds a `/api/grab/` route or stores a page.
3. **Return-and-paste is the path back.** On focus the app tries to read the clipboard and runs `readPaste`, the same path PR 116 uses. Browsers often refuse a clipboard read that is not a tap, so a visible **Paste** button is required, not optional.
4. **The Android share target becomes a first path, not a backup.** A selected chart shared to the app is the chart, with no network and no clipboard permission. A shared link is no longer fetched. It opens the page for the player to copy, or it says the app cannot read that page. Share still works only on Android, in an installed app. iPhone and desktop use return-and-paste and the **Paste** button. See decision D9.
5. **The search list stays the song catalog, and Grab is a button on each row.** This choice from the first plan still holds. The catalog row gives the exact title, artist, and length, and the length sets the scroll pace. A tap on the rest of the row still starts an empty sheet. See decision D5.
6. **The site set and its order stay Chordie, GuitarTabs.cc, E-Chords.** The first plan's reasons still hold for which page to open. Ultimate Guitar is not opened by Grab. **Try another site** walks the order. See decision D4.
7. **The credit line stays.** A grabbed song carries one line such as "Chords from Chordie". It is honest, and it tells the owner where a chart came from if a site writes. See decision D6.
8. **Smart paste still runs on the phone.** The clipboard or the share is text, and the phone calls `readPaste`. The reader keeps one copy, `check:song-paste` keeps covering it, and the editor's text box stays the one editable copy of the chart.
9. **The system browser opens the site, not an in-app browser.** An in-app browser could host a Grab button of our own, but this app is a web app today and has no store wrapper. The system browser makes it clear the player is on the site. See decision D12.
10. **Two cooks, not four.** The screen cook is the feature. The share cook is the Android path. No Worker cook and no canary.

### Things in the brief or the repo that look wrong

- **`env.production` is another person's Cloudflare account.** That mattered when the Worker fetched pages. It no longer does for Grab, because Grab sends no request to a chord site from that account.
- **The privacy page names no outside service.** Decision D5 of `docs/PLAN-song-search-layers.md` asked for one sentence about the song catalog and is still open. Grab should still add two sentences, now about opening a site in the player's browser. See decision D7.
- **Cooks 2 to 5 of the song search plan have not landed.** `NoWordsYet` is still the panel on an empty sheet. This plan builds on the tree as it is. If `song-start-panel` lands first, **Grab chords** becomes the first button of that panel.
- **The manifest has one SVG icon.** From memory, Chrome on Android wants PNG icons before it installs an app in the way a share target needs. Cook 2 checks this on a real phone before it builds anything else.
- **The standing planner add-on asks for seed tests under `tests/seed/`.** The brief for this cook allows doc files only. The test cases are numbered in sections 1 and 4, and commit 1 of each build cook holds them.
- **Pasted words in a share are still undecided.** Decision D4 of the song search plan is open. Grab makes charts with words common. See decision D10.

## Decisions the owner must make

No cook needs an API key or a new secret under the recommended answers. Decisions D1, D2, D3, D8, and D11 of the first plan (Worker on/off, `robots.txt`, an honest User-Agent, server rate limits, and the canary workflow) are dropped. They applied to a server fetch this plan no longer builds.

| Id | Decision | Recommended answer | What waits for it |
|---|---|---|---|
| D4 | The first site set and its order: Chordie, GuitarTabs.cc, E-Chords. Ultimate Guitar is not opened by Grab. | Yes | Cook 1's site table |
| D5 | A search row gets a **Grab** button, and a tap on the rest of the row still starts an empty sheet. The other choice is one tap target that always grabs. | The separate button. It does what its label says, and every landed search case keeps passing. | Cook 1. The owner reviews it on a phone before merge. |
| D6 | A grabbed song carries one credit line on the sheet, such as "Chords from Chordie". | Yes. It is honest, and it tells the owner where a chart came from if a site writes. | Cook 1 |
| D7 | The first Grab shows a short note once, and the privacy page gains two sentences. Section 5 has the words. | Yes | Cook 1 |
| D9 | Build the Android share entry? It works on Android in an installed app, and not on an iPhone. | Yes if the owner or the band uses Android. No if every phone is an iPhone. iPhone and desktop still get return-and-paste and **Paste**. | Cook 2 |
| D10 | May a grabbed chart, words included, be shared with a band or a friend? Today a song the player made is shared whole. | The owner decides before Grab reaches Live. No cook in this plan changes sharing. | Nothing in this plan |
| D12 | Does Grab open the site in the system browser, or in an in-app browser with a Grab button of our own? | The system browser. This app is a web app and has no store wrapper. The system browser makes it clear the player is on the site. An in-app Grab button can wait until the app is in a store shell. | Cook 1 |

## 1. End-to-end UX: from search to a saved sheet

### The flow

Grab starts in the **Find a song to add** box, which already sits on My Songs and in the New song editor.

1. **Type.** The box lists recordings from the song catalog, as it does today. When Grab is on, each row shows a **Grab** button at its right edge. Case A7.
2. **Tap Grab.** The New song editor opens at once with the row's title, artist, and length. The first site in the order opens in the system browser, on a search or chart address built from that title and artist. A status line under the fields says **Copy the chart on the site, then come back.** and has **Paste**, **Cancel**, and **Try another site**. Nothing is saved yet. A song the player already has asks first, before the site opens, as a pick does today. Cases A8, A13, A19.
3. **Copy on the site.** The player uses the site's own copy or print button when it has one, or selects the chart and copies, or, on Android, shares the selection to the app. The app does not fetch the page and does not put a button on the site. Cases A8, A16.
4. **Return.** When the app is focused again, it tries to read the clipboard. Chart text is taken as a paste through `readPaste`. The status line then says what a paste says, with the source in front, such as **Chords from** and the site's name. The text box holds the cleaned chart, and the real sheet is drawn under it. If the read is refused or the clipboard holds no chart, the waiting words stay and **Paste** remains in view. Cases A9, A16, A17.
5. **Or tap Paste.** A tap on **Paste** reads the clipboard in the click, which is the path browsers allow, and then follows the same paste path as a return read. Cases A9, A17.
6. **Review.** The chips for key and BPM, the capo switch, and **Use it as pasted** work as they do after a paste. **Try another site** opens the next site in the order and does not change the title, artist, or length. Cases A9, A11.
7. **Save.** The song goes to My Songs through `addOwnSong`, and the sheet opens. From here on the song needs no network. Case A10.

A tap on the rest of the row still starts an empty sheet, as today.

Grab has two more entries. Both open the same editor, so the states and the words have one home.

- **An empty sheet.** A song the player made that has no chart shows **Grab chords** as the first control of the `NoWordsYet` panel. The Edit song editor opens, and the site opens. **Save** writes the same song through `replaceOwnSong`. Case A14.
- **Inside the editor.** **Grab chords** sits beside **Paste a sheet** when Grab is on and the title is not blank. An `off` stop hides it with every other Grab control. Case A18.

The first-use note of decision D7 is shown once, the first time the player taps **Grab**, with one **OK** button. The site opens after **OK**. Case A15.

### The shapes, frozen by cook 1

Cook 1 adds these types to a new file, `src/chord-grab.ts`.

```ts
/** A site in the table, as the phone names it. */
export type GrabSite = { id: string; name: string };
/** Why a Grab stopped with no chart. */
export type GrabStop = "empty" | "denied" | "offline" | "signed-out" | "off" | "failed";
/** Where one Grab stands. The screen draws this value and holds no other state for it. */
export type GrabState =
	| { kind: "idle" }
	| { kind: "away"; site: GrabSite }
	| { kind: "got"; site: GrabSite; text: string }
	| { kind: "stopped"; why: GrabStop };
```

The address to open is built from `data/chord-sites.json` and the row's title and artist. No origin or path lives in `src/`.

```ts
/** What an editor opens with when something other than the player's typing starts the song. */
export type SongStart = {
	title?: string;
	artist?: string;
	lengthSec?: number | null;
	/** Text to take as a paste when the editor opens. */
	paste?: string;
	/** Start a Grab when the editor opens: open the site for this song, or one listed address. */
	grab?: true | { url: string };
};
```

`docs/PLAN-bulk-import.md`, already merged, may also give the editor a start draft. The cook that merges second uses the one that is there and adds only the fields it lacks.

One rule decides each field. The catalog row wins for title, artist, and length. Key, BPM, and capo come from `readPaste`, and they follow the paste rule that is already built. A blank or untouched field is filled, and any other difference is a chip. The credit line comes from the site that was opened, even if the clipboard itself names nothing.

### What the player sees when something fails

Every case leaves the editor open and usable. **Find chords on the web** and **Paste a sheet** are already in the editor, one tap away. **Paste** stays on the waiting line unless a row below says it does not.

Each `GrabStop` value has one row, and the `MESSAGES` map of `src/chord-grab.tsx` holds exactly these words. A row with no `GrabStop` is not a stop. The last column names the cases that test the row, and `check:chord-grab-plan` fails when a row names none.

| Case | `GrabStop` | Words on the status line | What else | Cases |
|---|---|---|---|---|
| The clipboard is empty, or it holds no chart | `empty` | No chart on the clipboard yet. Copy the chart on the site, come back, and tap **Paste**. | **Paste**, **Open the site again**, **Try another site** | A6, A12, A17 |
| The browser refused the clipboard read | `denied` | The app can't read the clipboard. Tap **Paste** to put the chart in. | **Paste** | A5, A12, A17 |
| Offline when the site should open | `offline` | You're offline, so the app can't open the chord site right now. | **Try again** | A12 |
| The session ended | `signed-out` | Sign in again to grab chords. | The landed sign-in sheet opens, and it can be closed | A12, A20 |
| Grab is off in the site table | | Nothing. The **Grab** buttons are not drawn. | | A7, A18 |
| Grab went off after the buttons were drawn: the owner emptied the site table and deployed. | `off` | Grab is resting for now. Find the chart on the web and paste it. | No button. Every **Grab** button is hidden for the rest of the session. | A12, A18 |
| Opening the site failed in a way this table does not name | `failed` | Something went wrong while grabbing. Try again. | **Try again** | A12 |
| The pasted text has no chart after cleaning | | Nothing here looks like a chart. It is in the box as pasted. | The landed paste message | A6, A12 |
| The player taps **Cancel**, types in the editor's text box, or closes the editor, while waiting | | Nothing | A later clipboard read is dropped, and no song is added. What the player typed stays in the box. | A5, A19, A20 |
| A second account on the same phone | | No change | A grabbed song is one of the signed-in account's own songs. A sign-out or an account switch while waiting drops a later clipboard read, so no chart lands in the next account's editor. | A7, A20 |

### Where each part lives

| Part | File | Cook |
|---|---|---|
| Shapes, the site-address builder, and the clipboard driver | `src/chord-grab.ts` | 1 |
| The **Grab** button, the waiting line, **Paste**, **Try another site**, the first-use note | `src/chord-grab.tsx`, `src/chord-grab.css` | 1 |
| The editor takes a start draft and a pasted text through the PR 116 path | `src/song-editor.tsx` | 1 |
| The button on a search row and on the empty-sheet panel | `src/song-search.tsx` | 1 |
| Whether Grab is on, and every chord site address | `data/chord-sites.json` | 1 |
| The Android share entry | `public/manifest.webmanifest`, `public/sw.js`, `src/share-entry.ts` | 2 |

Grab is on when the site table has at least one site. An empty table hides every **Grab** control. Live can stay off until the owner says yes by shipping Preview with the three sites and Live with an empty list, if the two environments already use separate data. If they share one file, cook 1 names the off switch it used in the report, and the owner confirms it before Live.

### Required test cases for the screen (cook 1)

Cases A1 to A6 run in node on the address builder and the clipboard driver. The rest drive headless Chrome. The check opens no live chord site. It stubs `window.open` and `navigator.clipboard`. Every chart in the check is written for the check, with made-up words.

- A1. The Chordie open address is the search URL from the site table, with the title and artist filled in, and no origin is hardcoded in `src/`.
- A2. The GuitarTabs.cc open address is the search URL from the site table, with the title and artist filled in.
- A3. The E-Chords open address is the built chart path from the site table, with a hyphenated artist and title.
- A4. The clipboard driver, given chart text, returns a `got` state with that text, and no request leaves the phone.
- A5. The clipboard driver, when the read is refused, returns a `denied` stop, and a later **Paste** with the same text returns a `got` state. A **Cancel** during a wait drops a later read and adds no song.
- A6. The clipboard driver, given empty text or text with no chords and no headings, returns an `empty` stop, and the landed paste message is used when a paste cleans to nothing.
- A7. When Grab is on, each search row shows a **Grab** button, and a tap on the rest of the row still starts an empty sheet and opens no site. When the site table is empty, no **Grab** button is drawn.
- A8. A tap on **Grab** opens the New song editor with the row's title, artist, and length, opens the first site, and the status line says **Copy the chart on the site, then come back.** and shows **Paste**, **Cancel**, and **Try another site**.
- A9. After a successful clipboard read or a tap on **Paste**, the box holds the cleaned chart, the real sheet is drawn, and the status line starts with **Chords from** and the site's public name. **Use it as pasted** still works.
- A10. A tap on **Save** after a Grab stores the song through `addOwnSong` with a title, a credit line, and the chart, and the sheet opens with the network cut.
- A11. **Try another site** opens the next site in the order and does not change the title, artist, or length.
- A12. Each `GrabStop` row's words appear when that stop is stubbed, and **Find chords on the web** and **Paste a sheet** stay one tap away. **Try again**, **Open the site again**, **Try another site**, and **Grab** appear where the table shows them.
- A13. A song the player already has asks first, before the site opens, as a pick does today. A no leaves the list and opens no site.
- A14. **Grab chords** on an empty sheet opens the Edit song editor, opens the site, and **Save** writes the same song through `replaceOwnSong`.
- A15. The first Grab on a phone shows the first-use note once, with **OK**, and a later Grab does not. The site opens after **OK**.
- A16. When the app is focused after the site opened, it tries to read the clipboard and, on chart text, runs the same path as **Paste**.
- A17. When the focus read is refused or returns no chart, the waiting words stay, **Paste** still works from the click, and **Open the site again** is in view.
- A18. **Grab chords** in the editor is drawn only when Grab is on and the title is not blank, it sits beside **Paste a sheet**, and an `off` stop hides it too.
- A19. A tap on **Cancel** or closing the editor while waiting drops a later clipboard read, adds no song, and keeps what the player typed.
- A20. A sign-out or an account switch while waiting drops a later clipboard read, so no chart lands in the next account's editor.

### Verification (cook 1)

- [ ] Unit. `npm run check:chord-grab` prints `ok` for A1 to A20. Each case printed `FAIL` on the tests-only commit.
- [ ] Live. The app in headless Chrome, with `window.open` and the clipboard stubbed. Search "brown eyed girl", tap **Grab** on the Van Morrison row, stub a chart paste, tap **Save**. Pass when the saved sheet has at least 4 sections and 20 chords, and it opens after the network is cut.
- [ ] Perf. The main script is 225.64 KB gzipped at `b2b248a`, read from `npm run build`. The cook fails this box when its build is over 232 KB. A Grab that pulls in more than 6 KB of new code belongs behind `import()`.
- [ ] The owner taps through the flow on a phone in Preview before merge, on both an iPhone and, if one is at hand, an Android phone. This cook changes an interaction. The phone box is whether the site opened, whether a copy on the site came back, and whether **Paste** worked when the auto-read did not.

## 2. Opening the site

### The site table

`data/chord-sites.json` holds one row for each site: `id`, `name`, `origin`, and the rule for the address to open. Chordie and GuitarTabs.cc use a search address with the title and artist filled in, and the player taps a result. E-Chords uses a chart address built from a hyphenated artist and title. **Try another site** walks this order: Chordie, GuitarTabs.cc, E-Chords.

The phone opens the address with `window.open` or an equivalent tap-through to the system browser. It does not `fetch` the page, and no Worker does either.

### Clipboard read on return

On `visibilitychange` or window `focus`, after a site has been opened for this Grab, the app calls `navigator.clipboard.readText` when it exists. Chart text goes through the same `takePaste` path PR 116 uses. The clipboard text never leaves the phone.

These permission rules are part of the design, not afterthoughts:

- A clipboard read often needs a secure context and, on many browsers, a user gesture. A read on focus may be refused. That is a `denied` or `empty` stop, not a crash, and **Paste** stays in view.
- **Paste** is a click, which is the gesture browsers allow. It is required on every waiting screen.
- On iPhone, a read on focus is likely to fail. The reliable path is **Paste**, and the player may see the system's paste prompt. Cook 1 does not invent a hidden paste trick that iOS later breaks.
- On desktop, the same pair applies: try a read on focus, keep **Paste**.
- On Android, the share path of cook 2 can avoid the clipboard. The **Paste** button still stays, for a player who copied instead of shared.

### Required notes for the address builder (already in A1 to A3)

The builder is pure. It reads the site table and the title and artist, and it returns an `https` address on that site's host, or nothing. A title that cannot be put in a path, such as an empty title, opens no site and leaves the editor with the `failed` words.

## 3. The sites, and why this order stays

The first plan compared seven sites and picked three. The reasons still hold for which page Grab opens, even though the app no longer fetches those pages.

| Site | Why it is in the set | How Grab opens it |
|---|---|---|
| Chordie | A clear title and artist, chord boxes over words, and a search the player can use | Search address, player taps a result |
| GuitarTabs.cc | A full chart in one block for the test song | Search address, player taps a result |
| E-Chords | A chart address that can be built from the name, so the player may land on the page itself | Built chart address |

Ultimate Guitar is not opened by Grab. The first plan left it out because its search is disallowed to robots and because the owner did not pick it. This revision does not add it. A player can still open it themselves and paste, or, on Android, share the selected chart.

**Try another site** is the fallback when the first page is wrong, thin, or missing the song. There is no canary, because there is no server parse to go stale. If a site changes its search address, cook 1's table is the one-line fix.

## 4. Share-to-app on Android

### What a share can and cannot do

A share target is a manifest entry that puts an installed web app in the phone's share sheet. The facts in this list are from memory. None was checked on a phone in this cook, and cook 2 checks each one first.

- **Android.** Chrome offers an installed app as a share target. The app must be installed from Chrome, not opened in a tab.
- **iPhone.** Safari has no share target for a web app, in a tab or on the Home Screen. Nothing in this section can be built for an iPhone. The path there is the one cook 1 already built: copy the chart, come back, and use the auto-read or **Paste**.
- **Desktop.** No share target is built. The path is the same as on an iPhone: return-and-paste and **Paste**.
- **What arrives.** A share carries a title, a text, and an address. Chrome often puts a page's address in the text field. A share of selected words puts the words in the text field.

A shared chart and a shared link are different.

| What was shared | What the app does | Needs a network | Cases |
|---|---|---|---|
| Selected chart text | Takes the text as a paste, as after **Paste** | No | S4 |
| A link to a chart page on a listed site | Opens that page for the player to copy, then waits as a Grab does | Only to open the page | S5 |
| A link to any other page | The app can't read that page. Select the chart on the page and copy it, then tap **Paste**. | No | S6 |
| Nothing usable | The New song editor, with "Paste your sheet into the box." | No | S4 |
| Anything, while signed out | The landed sign-in sheet. Closing it leaves the app usable and shows "Sign in to add the shared chart." The share opens after a sign-in on the same page. | No | S8 |
| A link, with no network | You're offline, so the app can't open that page right now. **Try again** | Yes, to open | S7 |
| Selected chart text, with no network | The review, as after a paste | No | S3 |

A text that holds a chart and a link is a text share, because the chart needs no network. A text that holds only a link, or a title and a link, is a link share. The app never fetches a shared link.

### Design

1. **The manifest entry.** `public/manifest.webmanifest` gains a `share_target` with `method: "POST"`, an action inside the app's scope, and the three fields.
2. **The service worker answers the share.** `public/sw.js` passes every request that is not a `GET` to the network today. It gains one branch. A `POST` to the share action is read in the service worker, kept in the phone's cache under one key, and answered with a redirect to the app's start page. The shared text never travels to a server. A `GET` share would put the chart in the address of a request to the host.
3. **The app takes the share once.** A new file, `src/share-entry.ts`, reads the cache entry at start and deletes it. A pure function sorts what arrived.

```ts
export type Shared =
	| { kind: "text"; text: string; title: string }
	| { kind: "link"; url: string }
	| { kind: "empty" };
```

4. **The editor opens.** A text share opens the New song editor with the text taken as a paste. A link share of a listed site opens it as a Grab of that one address, so the player copies on the page and returns. Both use the start draft that cook 1 adds to the editor.

### Required test cases for the share entry (cook 2)

Commit 1 holds `scripts/check-grab-share.ts` and its one `package.json` line, and nothing else. Cases S1 to S10 fail on that commit.

- S1. The sorting function labels a body that is only an address as `link`, a body that holds a chart as `text`, and an empty body as `empty`.
- S2. The service worker branch reads a `POST` to the share action, keeps the body under one key, and redirects to the app's start page, and it leaves every `GET` as it is today.
- S3. A selected chart, with the network cut, opens the New song editor with the sheet drawn, and no request leaves the phone.
- S4. Selected chart text opens the review, as after **Paste**. Nothing usable opens the New song editor with "Paste your sheet into the box."
- S5. A link to a listed site opens that page and the waiting line of a Grab, and does not fetch the page.
- S6. A link to any other page shows "The app can't read that page. Select the chart on the page and copy it, then tap **Paste**."
- S7. A link, with no network, shows "You're offline, so the app can't open that page right now." and **Try again**.
- S8. A share while signed out opens the landed sign-in sheet, which can be closed, and shows "Sign in to add the shared chart."
- S9. The share is read once. After the read, the cache no longer holds it, and the address bar holds no shared text.
- S10. A second account on the phone never sees a share that arrived for the first.

### Verification (cook 2)

- [ ] Unit. `npm run check:grab-share` prints `ok` for S1 to S10. Each case printed `FAIL` on the tests-only commit.
- [ ] `check:offline` passes with no edit to its script.
- [ ] The owner runs the phone box on an Android phone in Preview before merge: install the app, open a chart, select it, Share, pick the app, **Save**.

## 5. Legal and risk

The planner is not a lawyer. This section says what the feature does and where the risk sits. It is not legal advice, and a lawyer has not read it.

### The terms of use

The first plan treated a server fetch of a chart page as a likely break of most chord sites' terms, and the owner accepted that risk on Nov 24, 2026, for that design. This revision does not do that fetch. The player opens the site in their own browser and copies the chart, which is the same act as today's paste flow, with the app having opened the page and then pasted the copy.

That is closer to ordinary browsing than a server fetch, and it is still not a license. Some sites may forbid copying their charts. The player is the one who copies. No cook in this plan disguises the app as the site, injects a button onto the site, or bypasses a lock, a login, or a CAPTCHA.

### Copyright is still the larger remaining risk

- A chord sheet with words holds the song's lyrics. The lyrics belong to the song's publisher. The app has no lyrics license.
- After **Save**, the lyrics sit in the player's library, in the player's backup on the app's server, and in a band's room if the player shares the song.
- The copy itself is the player's act, as it already is when they paste a chart today. The app does not fetch the page and does not store a page the player did not save.
- A registered DMCA agent gives a service a notice and takedown process for material that its users store on it. It is not a license to copy lyrics, and it is not a license to open a site or to paste a chart. A Grab button is not a license either.

No screen, no doc, and no cook in this plan says or implies that Grab is licensed.

### The rules the design keeps

1. **The app never fetches a chord site's page.** Not from the phone, and not from a Worker. It may open a listed address in the player's browser.
2. **Only the saved song is kept.** Clipboard text, share text, and any page the player viewed stay off the app's server. The saved song is the player's own song, under the storage and backup rules that own songs already have.
3. **No crawl.** Grab opens one page for one tap. No cook builds a list of a site's songs or a fetch of a row the player did not ask for.
4. **An off switch.** An empty site table hides **Grab**.
5. **No lyrics for sale.** Grab is not the thing a paid plan sells, and no screen or store text promises lyrics.
6. **A way to reach the owner.** The contact on the privacy page is where a site or a publisher writes. When one writes, the owner turns Grab off the same day and then answers.

### What the app tells the player

The first Grab on a phone shows this note once, with one **OK** button.

> **Grab opens a public chord site in your browser.** Copy the chart there, then come back. The app pastes it in. The sheet says where it came from. A chart on the web is someone's own transcription, so check it before a gig. Grab is for your own playing.

Each grabbed song carries one credit line on the sheet, such as "Chords from Chordie". `Song.sourceNote` holds it, and the sheet already draws that field.

The privacy page gains two sentences. `check:privacy` fails on an apostrophe, so they have none.

> When you tap Grab, the app opens a public chord site in your browser. You copy the chart. The app does not fetch that page, and it keeps only the song you save.

### Who carries the risk

| Risk | What happens | What limits it |
|---|---|---|
| A site changes its search or chart address | The opened page is wrong or missing | **Try another site**, then the web search and the paste. One line in the site table fixes it. |
| A site or a publisher writes to the owner | The letter goes to the contact | Rule 4 and rule 6 |
| A claim over lyrics in backups and band rooms | Saved songs hold words on the server | Decision D10. A lawyer's read before Live. |
| A browser blocks the clipboard | The auto-read fails | **Paste**, and on Android the share path |

### A lower-risk variant the owner can pick later

The app can keep the section names and the chord rows and drop the words from a saved grabbed song. A chart with no words holds no lyrics. That takes away most of the copyright exposure of a saved song. The player then adds words by paste, as today. No cook builds this now.

## 6. Priority order and copy-ready cook briefs

None of these cooks is queued. Each brief waits for the owner's review. No build branch is open.

### The order, and why

| Order | Cook | Size | Model | Why it sits here |
|---|---|---|---|---|
| 1 | `chord-grab-app` | Medium | Opus | It is the feature the player sees: open the site, return-and-paste, and **Paste**. PR 116 has already merged. |
| 2 | `chord-grab-share` | Small | Opus | It is the Android path, and it needs the editor entry of cook 1. Decision D9 can drop it. |

After cook 1 the owner has the whole loop on a phone in Preview: search, **Grab**, copy on the site, return or **Paste**, **Save**, play offline. Cook 2 adds the Android share.

The model picks follow `MODEL-RULES.md`. The pick of Nov 18, 2026 makes Fable the planner and Opus the model for every cook in a plan. The standing rule of Nov 23, which moves a cook to Fable after a failed check, names the song search and learn-by-listen cooks. Whether it covers these two is the owner's call, and section 7 asks.

### Rules every brief below inherits

Each brief is ready to copy into the queue. The queue's own header, laptop notes, and report rules go around it unchanged. The same briefs are standalone files under `docs/cooks/`.

- Read `CLAUDE.md` first. Stay inside the owned files. Add one `check:*` line to `package.json` and nothing else there.
- Commit 1 holds the tests alone, and each new case fails on it. Paste the failing run into the report. Later commits do not weaken a case. A case that is wrong goes in `QUESTIONS.md`, which is a shared log, so add the entry at the top.
- The required test cases are the numbered cases in the named section of `docs/PLAN-chord-grab.md`. Each case needs a named line that prints `ok` or `FAIL`.
- Each step of the Grab flow and each row of a state table in this plan names the cases that test it, and `npm run check:chord-grab-plan` holds that. A cook that adds a state, a row, or a control adds its case to the plan in the same commit.
- A new check passes three runs in a row before the report, on Windows paths and on Linux paths. Write paths with `fileURLToPath` and `path.join`, and read the browser from `CHROME`.
- No new libraries. Screen cases use `scripts/chrome.ts` and `scripts/app-page.ts`, as `scripts/check-song-search.ts` does.
- **The app never fetches a chord site's page.** Not from the phone, and not from a Worker. It may open a listed address in the player's browser. Clipboard text and share text stay on the phone.
- **No fetched page in the repo.** Every fixture is written for the check, with made-up words. No real lyrics go in a fixture, a commit, or a report.
- No outside address in `src/` or `worker/`. An address goes in `data/chord-sites.json`. `npm run check:portable` must pass.
- A site's public name may show on a screen, as a credit. A site id, a route, a variable name, or a cook id may not.
- Every new control is styled in the cook's CSS file, is at least 44 px tall, and is checked at 360 px and 390 px.
- Handle the list in `CLAUDE.md` under "Must handle in every feature". For these cooks that means: a signed-out visitor is never trapped, a second account on the phone sees nothing of the first, an offline or slow network gives a clear message and a retry and never a duplicate song, and every empty and error state has words.
- Never deploy. `wrangler dev --local` is fine.

### 6.1 Brief: `chord-grab-app`

Standalone file: `docs/cooks/chord-grab-app.md`. Model: Opus.

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

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full.

## What the player can do

1. Type a song in **Find a song to add**. Each row has a **Grab** button.
2. Tap **Grab**. The New song editor opens with the title, artist, and length. The first site opens. The status line says **Copy the chart on the site, then come back.** and shows **Paste**, **Cancel**, and **Try another site**.
3. Copy the chart on the site, come back, and, if the chart is not already in the box, tap **Paste**.
4. Tap **Save**. The song is in My Songs and opens with no network.

## Tests first

Commit 1 holds `scripts/check-chord-grab.ts` and its one `package.json` line, and nothing else. Cases A1 to A20 of plan section 1 fail on that commit. Paste the failing run into the report. Each case prints one named `ok` or `FAIL` line.

## Owned files

`src/chord-grab.ts`, `src/chord-grab.tsx`, `src/chord-grab.css`, `src/song-editor.tsx`, `src/song-editor.css`, `src/song-search.tsx`, `src/song-search.css`, `src/library-lists.tsx`, `src/App.tsx` (at most three new lines, and at most 500 lines), `src/data-kinds.ts`, `scripts/build-privacy.ts`, `data/chord-sites.json`, `scripts/check-chord-grab.ts`, `scripts/check-one-copy.ts` (new rows only), `package.json` (one line, `check:chord-grab`).

Do not touch: `src/song-paste.ts`, `src/song-text.ts`, `src/song-search.ts`, `src/sheet.tsx`, `src/storage.ts`, worker files, and earlier check scripts apart from the new rows in `scripts/check-one-copy.ts`.

## Checks

`npm run build`, `check:chord-grab`, `check:song-search`, `check:song-paste`, `check:new-song`, `check:chords`, `check:screens`, `check:phone-layout`, `check:privacy`, `check:storage`, `check:one-copy`, `check:portable`.

### 6.2 Brief: `chord-grab-share`

Standalone file: `docs/cooks/chord-grab-share.md`. Model: Opus.

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

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full.

## What the player can do

1. On a chart page in Chrome on Android, select the chart, tap Share, and pick the app. The chart opens as a sheet to review, with or without a network.
2. Share a link to a listed site, and the app opens that page for the player to copy.
3. Tap **Save**. The song is in My Songs.

An iPhone has no share target for a web app. Nothing in this cook changes what an iPhone does.

## Tests first

Commit 1 holds `scripts/check-grab-share.ts` and its one `package.json` line, and nothing else. Cases S1 to S10 of plan section 4 fail on that commit. Paste the failing run into the report. Each case prints one named `ok` or `FAIL` line.

## Owned files

`public/manifest.webmanifest`, `public/sw.js`, `src/share-entry.ts`, `src/chord-grab.tsx` (the words for a shared link the app cannot read), `src/song-editor.tsx` only if the start draft lacks a field this cook needs, `src/App.tsx` or `src/main.tsx` (at most three new lines in `src/App.tsx`, which must stay at 500 lines or fewer), `scripts/check-grab-share.ts`, `package.json` (one line, `check:grab-share`).

Do not touch: `src/song-paste.ts`, `src/chord-grab.ts` apart from an import, worker files, `data/chord-sites.json`, `scripts/check-offline.ts`, and earlier check scripts.

## Checks

`npm run build`, `check:grab-share`, `check:offline`, `check:chord-grab`, `check:new-song`, `check:song-paste`, `check:one-copy`, `check:portable`.

## 7. Dependency order, phasing, cost, risk, and NEEDS TERRY

### Dependency order and phases

| Phase | What happens | Who | Waits for |
|---|---|---|---|
| 0 | The owner answers D4 to D7 and D12 | Owner | Nothing |
| 1 | `chord-grab-app` builds and merges | Cook 1 | Phase 0, and PR 116 (already merged) |
| 2 | The owner reviews Grab on a phone in Preview | Owner | Cook 1 |
| 3 | `chord-grab-share` builds, if D9 is yes | Cook 2 | Cook 1 merged, and D9 is yes |

| Cook | Branches from | Files it may touch | Review-gated |
|---|---|---|---|
| 1 | `mls-int-20261113` | `src/`, `data/chord-sites.json`, `scripts/build-privacy.ts` | Yes, by the owner on a phone |
| 2 | `mls-int-20261113` after cook 1 | `public/manifest.webmanifest`, `public/sw.js`, `src/` | Yes, by the owner on an Android phone |

Three merge seams need a second look, as `CLAUDE.md` asks.

- **`src/song-editor.tsx`.** PR 116 has merged. `bulk-import-text` may add a start draft to it, and so does cook 1. The cook that merges second merges `mls-int-20261113` first and uses the start draft that is there.
- **`src/App.tsx`.** The file had 490 lines and a cap of 500 at the first plan's tip. `bulk-import-text` may add three lines, cook 1 three, and cook 2 three.
- **`package.json`.** Each cook adds one `check:*` line.

### Cost

- **Money.** Nothing under the recommended answers. No key, no paid service, and no Worker fetch to put on a paid plan.
- **Upkeep.** A site changes its search or chart address. The fix is one line in `data/chord-sites.json`. There is no HTML recipe to break.
- **Cooks.** One medium and one small, on Opus.

### Engineering risks

| Risk | The sign | What then |
|---|---|---|
| The browser refuses a clipboard read on return | Common on iPhone, and likely on desktop without a tap | **Paste** is required, and cook 1 tests the refused path |
| The first opened page is a search, not the chart | Chordie and GuitarTabs.cc open a search | The player taps a result, or **Try another site**. E-Chords may land on the chart. |
| The built E-Chords address is wrong for some names | An artist with "The" or an accent | **Try another site**, then a one-line fix in the site table |
| A new gesture on a pick breaks a landed search case | `check:song-search` | Cook 1 sends nothing new on a row tap. Only the **Grab** button opens a site. |
| The service worker change breaks offline | `check:offline` | Cook 2 adds one branch for one `POST` and changes no `GET` |
| Chrome will not install the app without PNG icons | The owner's Android phone box | Cook 2 checks first and, if needed, renders PNG icons from the SVG with the repo's Chrome driver, and adds no image library |

### NEEDS TERRY

These are the questions that only the owner can answer. Each has a short answer.

1. **The site set and its order.** Chordie, then GuitarTabs.cc, then E-Chords, and Ultimate Guitar is not opened by Grab. Yes or no. (D4)
2. **The Grab button.** A separate **Grab** button on each search row, with a tap on the rest of the row starting an empty sheet. Yes, or one tap that always grabs. (D5)
3. **The credit line.** "Chords from Chordie" and the like on the sheet. Yes or no. (D6)
4. **The words on the screen.** The first-use note and the two privacy sentences in section 5. Yes, or the owner's own words. (D7)
5. **System browser or an in-app browser?** The recommended answer is the system browser. (D12)
6. **Which phones for the share cook?** Android, iPhone, or both, for the owner and for the band. An iPhone gets nothing from cook 2, and already gets return-and-paste and **Paste** from cook 1. (D9)
7. **May a grabbed chart be shared with its words?** A, yes, as any own song today. B, chords only in a share. C, decide before Live. (D10)
8. **A lawyer's read?** Should a lawyer read section 5 before Grab reaches anyone but the owner? Yes or no.
9. **Is the app sold, or will it be?** If yes, Grab stays outside what is sold.
10. **The model rule.** Does the Nov 23 rule that moves a cook to Fable after a failed check cover these two cooks? Yes or no.

## 8. What stays unproven

- **Whether each site has its own copy or print button**, and how easy it is to select the chart on a phone. Cook 1 writes what it finds on a phone. Until then the waiting screen tells the player to copy.
- **Whether a clipboard read on focus works** on the owner's iPhone, Android phone, or desktop browser. The design assumes it often fails, and **Paste** is the path that must work.
- **Share target facts are from memory.** Cook 2 checks them on an Android phone before it builds.
- **The E-Chords page address is a guess that worked for one song.** An artist with an accent or a "The" in front is untested.
- **The Chordie chart for the test song had chords on the first verse only.** One page cannot say whether that is common. If it is, the player can **Try another site**, and GuitarTabs.cc can be moved first in the table.
- **Nobody has seen the Grab button on a 360 px row.** The row is one wide button today. Cook 1 checks the sizes, and the owner judges the look on a phone.
- **No terms page was read, and no lawyer has read section 5.** The section states the risk as this revision understands it.
