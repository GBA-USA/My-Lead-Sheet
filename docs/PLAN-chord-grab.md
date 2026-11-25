# Plan: search a song, grab its chord sheet

Written Nov 25, 2026 against `b2b248a`, revised at 11:23 AM ET for copy-and-return (t350u), and revised again at 11:38 AM ET after the owner's next change (t352u). This revision is against `fcffb43` (PR 116 and PR 118 are merged). This plan changes no app code.

## Summary and landing order

The goal is one flow. A player types a song, taps **Grab**, lands on the chord site inside our wrapper, taps our floating **Grab** button, and the app extracts the chart from the page and pastes it into a new sheet. The saved song is in the library and plays with no network.

The first plan (PR 118) had a Worker fetch the page and extract the sheet. The owner then asked that the player go to the site and tap copy, so the retrieval is theirs. The last revision opened the system browser and asked the player to copy by hand. The owner narrowed that at 11:38 AM ET: use our wrapper over the browser, with a floating **Grab** button. A tap on that button extracts the song from the page HTML and pastes it automatically. There is no manual select-and-copy in the happy path.

After the two cooks below, a Grab does this:

1. The player taps **Grab** on a catalog search row.
2. The installed app opens the first listed chord site in an in-app browser our app controls, on a search or chart address built from the title and artist. A floating **Grab** button sits in our chrome, not inside the site's own page.
3. The player looks at the page and, when they see the chart, taps **Grab**. The app reads the page HTML, extracts the chord and lyric block, and runs it through `readPaste`, the same path PR 116 uses, with the catalog row's title, artist, and length already filled in.
4. The editor shows the real sheet. The player reviews and taps **Save**. A title is required. The song is in My Songs and works offline.
5. If the extractor cannot read that page, the wrapper stays open and a **Paste** button is offered as a fallback. The player can select the chart and paste it. That fallback is the exception, not the usual path.

The cooks land in this order.

| Order | Cook | What the player gains | Waits for |
|---|---|---|---|
| 1 | `chord-grab-shell` | The installed app can open a listed site in our in-app browser, with a floating **Grab** button in our chrome | Owner decisions D12 and D14 |
| 2 | `chord-grab-app` | **Grab** on a search row, per-site extraction, auto-paste, the fallback, and the credit line | Cook 1, PR 116 (merged), and owner decisions D4 to D7 |

```text
PR 116 (merged)
chord-grab-shell ──► chord-grab-app
```

The Android share cook from the last revision is not in this landing order. The wrapper works on iPhone and Android, and the fallback lives inside the wrapper. Share is a later add-on if a player wants to grab from ordinary Chrome, outside the app. See section 4.

The server-fetch cook and the canary stay dropped. Those were `chord-grab-worker` and `chord-grab-canary`. The Worker no longer fetches chord sheets. The phone also does not `fetch` a chord site's page. The in-app browser loads the page as a browser, as the player, and extraction runs on the phone after a tap.

The site set and its order stay: Chordie, then GuitarTabs.cc, then E-Chords. Grab never opens Ultimate Guitar. A grabbed song still carries a credit line, such as "Chords from Chordie".

The recommended wrapper is a Capacitor WebView with the **Grab** button in our native chrome. A plain web app cannot do this. Section 2 states why, and the catch.

## What was measured for this plan

The numbers in this section come from Nov 25, 2026, and were gathered for the first plan. Each fetch happened once, from a laptop, for Brown Eyed Girl by Van Morrison. They are not a gate for a Worker, because there is no Worker fetch. They still help: they record the address shapes to open, and they show that text taken from these pages goes through `readPaste` well, which is what the extractor must produce.

| Site | What we will open | What the extractor should take |
|---|---|---|
| Chordie | A search address, then the player taps a result | Chord boxes over words, plus the title and artist |
| GuitarTabs.cc | A search address, then the player taps a result | The chart in a `<pre>`, dropping the old mail header |
| E-Chords | A chart address built from the artist and the title | The chart in a `<pre>`, plus the headings |

Text taken from those three pages went through `readPaste` with no change to the reader. The sheet kept 35 of 37, 37 of 37, and 96 of 96 of the page's chords.

### What was not measured

- **No in-app browser was prototyped.** Cook 1 confirms that a Capacitor WebView can load these three sites, show our floating button, and run a script in the page on a tap. Custom Tabs and Safari View Controller were not tried, and this plan does not use them, because they cannot read the page.
- **No X-Frame-Options or CSP header was recorded** for these sites. That does not matter for a WebView. It is why an iframe inside the current web app will not work. Cook 1 does not need to scrape headers to build the wrapper.
- **The E-Chords page address is built from a guess** that worked for one song. An artist with an accent or a "The" in front is untested. **Try another site** is the way out, then a one-line fix in the site table.
- **`robots.txt` and server rate limits are mostly moot.** The player is visiting the site in a browser on their phone.

## Changes to the brief, and why

The brief for this revision is the owner's change of 11:38 AM ET, Nov 25, 2026. Each change from the last revision is listed with its reason. None touches the fixed rules: the player taps on the page, the Worker never fetches a chord site's page, no outside address in `src/`, offline after Save, a title required to save, and no app code in this cook.

1. **Our wrapper opens the site, with a floating Grab button.** The last revision used the system browser and a hand copy. The owner wants a wrapper and one tap on our button, then an automatic paste. The happy path has no select-and-copy.
2. **A plain web app cannot do that.** A third-party page cannot be iframed (X-Frame-Options and CSP `frame-ancestors`), and even a loaded iframe would not let our script read the page. The system browser, Chrome Custom Tabs, and Safari View Controller can show the site and cannot extract its HTML. Section 2 compares the real options and recommends Capacitor.
3. **Extraction runs on the phone, after a tap.** The first plan's per-site recipes still belong, but they run in the WebView the player is looking at, not on a Worker. The phone does not `fetch` the page.
4. **A fallback stays, and it is not the usual path.** If the extractor cannot read a page, the wrapper stays open and **Paste** is offered. Select-and-copy is only for that case.
5. **The Android share cook leaves the landing order.** The wrapper covers iPhone and Android. Share is useful later if someone is already in ordinary Chrome. It is not needed to complete the flow the owner asked for.
6. **The search list stays the song catalog, and Grab is a button on each row.** The catalog row still gives the title, artist, and length. See decision D5.
7. **The site set and the credit line stay.** Chordie, GuitarTabs.cc, E-Chords. Ultimate Guitar is not opened. See decisions D4 and D6.
8. **Two cooks, shell then feature.** The wrapper is a native shell around the existing web app. The feature cook adds search, recipes, and paste. The shell cook does not submit anything to a store.

### Things in the brief or the repo that look wrong

- **This app is a web app today.** The recommended wrapper only works in an installed native shell. A Preview tab in ordinary Safari or Chrome cannot show the floating **Grab** button on a chord site. Cook 2 can still show **Grab** there, but a tap must say that Grab from the page works in the installed app, and offer the ordinary web search and **Paste a sheet**.
- **The privacy page names no outside service.** Grab should still add two sentences, now about opening a site in our in-app browser. See decision D7.
- **Cooks 2 to 5 of the song search plan have not landed.** `NoWordsYet` is still the panel on an empty sheet. If `song-start-panel` lands first, **Grab chords** becomes the first button of that panel.
- **Pasted words in a share are still undecided.** See decision D10.
- **No Apple or Google store account is required to start these cooks.** A dev or Preview install is enough to test. Live in the stores needs accounts later. See decision D14.

## Decisions the owner must make

No cook needs an API key or a new secret under the recommended answers. Decisions D1, D2, D3, D8, and D11 of the first plan stay dropped. Decision D9 is no longer a gate for the landing cooks.

| Id | Decision | Recommended answer | What waits for it |
|---|---|---|---|
| D4 | The first site set and its order: Chordie, GuitarTabs.cc, E-Chords. Ultimate Guitar is not opened by Grab. | Yes | Cook 2's site table and recipes |
| D5 | A search row gets a **Grab** button, and a tap on the rest of the row still starts an empty sheet. The other choice is one tap target that always grabs. | The separate button. It does what its label says, and every landed search case keeps passing. | Cook 2. The owner reviews it on a phone before merge. |
| D6 | A grabbed song carries one credit line on the sheet, such as "Chords from Chordie". | Yes. It is honest, and it tells the owner where a chart came from if a site writes. | Cook 2 |
| D7 | The first Grab shows a short note once, and the privacy page gains two sentences. Section 5 has the words. | Yes | Cook 2 |
| D9 | Build the Android share entry later? | Not now. The wrapper already covers iPhone and Android. Revisit if people often grab from ordinary Chrome. | Nothing in this landing order |
| D10 | May a grabbed chart, words included, be shared with a band or a friend? Today a song the player made is shared whole. | The owner decides before Grab reaches Live. No cook in this plan changes sharing. | Nothing in this plan |
| D12 | Which wrapper? Capacitor WebView with our floating **Grab** button, a proxied page, or a bookmarklet. | Capacitor. It is the only option that matches a wrapper, a floating button, and an extract of the live page, without a server fetch. Section 2 gives the tradeoffs. | Cook 1 |
| D14 | May these cooks ship a dev and Preview install of the native shell, and leave store submission for later? | Yes. Do not submit to the App Store or Play Store in these cooks. | Cook 1. Store accounts are needed only before Live in the stores. |

## 1. End-to-end UX: from search to a saved sheet

### The flow

Grab starts in the **Find a song to add** box, which already sits on My Songs and in the New song editor. The flow below is what the installed app does. In an ordinary browser tab, a tap on **Grab** does not open the wrapper. It says **Grab from the page works in the installed app.** and leaves **Find chords on the web** and **Paste a sheet** one tap away. Case A7.

1. **Type.** The box lists recordings from the song catalog, as it does today. When Grab is on, each row shows a **Grab** button at its right edge. Case A8.
2. **Tap Grab.** The New song editor opens at once with the row's title, artist, and length. The first-use note, if it has not been shown, appears with **OK**. Then the in-app browser opens the first site, and a floating **Grab** button sits in our chrome. A song the player already has asks first, before the site opens, as a pick does today. Cases A9, A14, A16.
3. **Land on the page.** The player is looking at the live chord site. They may tap a search result on Chordie or GuitarTabs.cc. **Try another site** and a close control stay in our chrome. Case A9.
4. **Tap the floating Grab.** The app reads the page HTML, extracts the chord and lyric block, and takes it as a paste through `readPaste`. The editor comes back to the front with the cleaned chart in the box, the real sheet drawn, and a status line that starts with **Chords from** and the site's public name. Nothing is saved yet. Cases A10, A11, H3.
5. **Or the fallback.** If the extractor cannot read this page, the wrapper stays open. The status line says **We couldn't read this page. Select the chart and tap Paste.** and shows **Paste**. Select-and-copy is only for this case. Cases A12, A13.
6. **Review.** The chips for key and BPM, the capo switch, and **Use it as pasted** work as they do after a paste. **Try another site** opens the next site in the order and does not change the title, artist, or length. Cases A10, A15.
7. **Save.** The song goes to My Songs through `addOwnSong`, and the sheet opens. From here on the song needs no network. Case A17.

A tap on the rest of the row still starts an empty sheet, as today.

Grab has two more entries. Both open the same editor and the same wrapper.

- **An empty sheet.** A song the player made that has no chart shows **Grab chords** as the first control of the `NoWordsYet` panel. The Edit song editor opens, and the wrapper opens. **Save** writes the same song through `replaceOwnSong`. Case A18.
- **Inside the editor.** **Grab chords** sits beside **Paste a sheet** when Grab is on and the title is not blank. An `off` stop hides it with every other Grab control. Case A19.

### The shapes, frozen by cook 1 and cook 2

Cook 1 adds the wrapper's types and the bridge the feature cook calls. Cook 2 adds the site table, the recipes, and the screen driver, in `src/chord-grab.ts`.

```ts
/** A site in the table, as the phone names it. */
export type GrabSite = { id: string; name: string };
/** Why a Grab stopped with no chart. */
export type GrabStop = "unreadable" | "empty" | "offline" | "signed-out" | "off" | "failed" | "web-only";
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
	/** Start a Grab when the editor opens: open the wrapper for this song, or one listed address. */
	grab?: true | { url: string };
};
```

`docs/PLAN-bulk-import.md` may also give the editor a start draft. The cook that merges second uses the one that is there and adds only the fields it lacks.

The catalog row wins for title, artist, and length. Key, BPM, and capo come from `readPaste`. The credit line comes from the site that was open when the player tapped the floating **Grab**.

### What the player sees when something fails

Every case leaves the editor open and usable. **Find chords on the web** and **Paste a sheet** are already in the editor, one tap away.

Each `GrabStop` value has one row, and the `MESSAGES` map of `src/chord-grab.tsx` holds exactly these words. A row with no `GrabStop` is not a stop. The last column names the cases that test the row, and `check:chord-grab-plan` fails when a row names none.

| Case | `GrabStop` | Words on the status line | What else | Cases |
|---|---|---|---|---|
| The extractor could not read this page | `unreadable` | We couldn't read this page. Select the chart and tap **Paste**. | **Paste**, **Try another site** | A12, A13 |
| **Paste** ran, and the clipboard held no chart | `empty` | No chart on the clipboard yet. Select the chart on the page and tap **Paste**. | **Paste** | A13 |
| Offline when the site should open | `offline` | You're offline, so the app can't open the chord site right now. | **Try again** | A13 |
| The session ended | `signed-out` | Sign in again to grab chords. | The landed sign-in sheet opens, and it can be closed | A13, A20 |
| Grab is off in the site table | | Nothing. The **Grab** buttons are not drawn. | | A8, A19 |
| Grab went off after the buttons were drawn. | `off` | Grab is resting for now. Find the chart on the web and paste it. | No button. Every **Grab** button is hidden for the rest of the session. | A13, A19 |
| Opening the site or the wrapper failed in a way this table does not name | `failed` | Something went wrong while grabbing. Try again. | **Try again** | A13 |
| The player tapped **Grab** in an ordinary browser tab | `web-only` | Grab from the page works in the installed app. | **Find chords on the web**, **Paste a sheet** | A7 |
| The player closes the wrapper, or taps **Cancel**, before a chart is taken | | Nothing | No song is added. What the player typed stays in the box. | A20 |
| A second account on the same phone | | No change | A grabbed song is one of the signed-in account's own songs. A sign-out or an account switch while the wrapper is open adds no chart to the next account's editor. | A8, A20 |

### Where each part lives

| Part | File | Cook |
|---|---|---|
| The native shell, the in-app browser, and the floating **Grab** chrome | Capacitor config, the iOS and Android projects, a small Grab-browser plugin | 1 |
| The bridge the web app calls to open a listed address and to extract on a tap | `src/chord-grab-bridge.ts` | 1 |
| Shapes, the site-address builder, the recipes, and the screen driver | `src/chord-grab.ts` | 2 |
| The **Grab** button, the status line, the first-use note | `src/chord-grab.tsx`, `src/chord-grab.css` | 2 |
| The editor takes a start draft and a pasted text through the PR 116 path | `src/song-editor.tsx` | 2 |
| The button on a search row and on the empty-sheet panel | `src/song-search.tsx` | 2 |
| Whether Grab is on, and every chord site address and recipe name | `data/chord-sites.json` | 2 |

Grab is on when the site table has at least one site and the app is running in the native shell. An empty table hides every **Grab** control. In an ordinary browser tab the button may still be shown, but a tap takes the `web-only` path.

### Required test cases for the shell (cook 1)

Cases H1 to H8 run against the Grab-browser bridge. Headless cases stub the native plugin. At least one live case on a dev install is in the verification box, not in this list.

- H1. The wrapper opens a listed `https` address from the site table, and no origin is hardcoded in `src/`.
- H2. A floating **Grab** button is drawn in the app chrome, not as a node in the site's document.
- H3. A tap on the floating **Grab** runs the extractor in the WebView and returns the page HTML or the extracted text to the app, and no request is sent to a Worker to fetch the page.
- H4. Closing the wrapper, or a **Cancel** from the chrome, returns to the editor and adds no song.
- H5. The bridge, when the extractor returns nothing usable, reports an unreadable result and does not close the wrapper.
- H6. The bridge is a no-op in an ordinary browser tab: it reports that the wrapper is missing, and it does not call `window.open` as a silent stand-in.
- H7. A listed site that could not be iframed still opens in the WebView.
- H8. The shell still boots the existing web app, and a signed-in visit to My Songs does not require the wrapper.

### Verification (cook 1)

- [ ] Unit. `npm run check:grab-shell` prints `ok` for H1 to H8. Each case printed `FAIL` on the tests-only commit.
- [ ] Live, on a dev install. Open a listed Chordie, GuitarTabs.cc, or E-Chords address in the wrapper, confirm the floating **Grab** button, tap it, and confirm text returns to the app. Pass when that loop works on at least one of the three sites.
- [ ] The existing web app still builds, and `check:portable` is green. This cook does not submit to a store.

### Required test cases for the screen and recipes (cook 2)

Cases A1 to A6 run in node on the address builder and the recipes. The rest drive headless Chrome with the native bridge stubbed. Every chart in the check is written for the check, with made-up words. The check opens no live chord site.

- A1. The Chordie open address is the search URL from the site table, with the title and artist filled in, and no origin is hardcoded in `src/`.
- A2. The GuitarTabs.cc open address is the search URL from the site table, with the title and artist filled in.
- A3. The E-Chords open address is the built chart path from the site table, with a hyphenated artist and title.
- A4. The Chordie recipe turns each chord box into a bracket in front of its words, keeps a comment line, and drops lines marked as tab.
- A5. The GuitarTabs.cc recipe takes the longest `<pre>`, keeps each chord in its column, and drops the mail header.
- A6. The E-Chords recipe reads the `<pre>` and the title and artist headings, and the result goes through `readPaste` with no change to the reader.
- A7. In an ordinary browser tab, a tap on **Grab** does not open a site and says **Grab from the page works in the installed app.**, and **Find chords on the web** and **Paste a sheet** stay one tap away.
- A8. When Grab is on in the installed app, each search row shows a **Grab** button, and a tap on the rest of the row still starts an empty sheet and opens no site. When the site table is empty, no **Grab** button is drawn.
- A9. A tap on **Grab** opens the New song editor with the row's title, artist, and length, opens the wrapper on the first site, and shows the floating **Grab** button. **Try another site** is in our chrome.
- A10. A successful extract takes the text as a paste, the box holds the cleaned chart, the real sheet is drawn, and the status line starts with **Chords from** and the site's public name. **Use it as pasted** still works.
- A11. The catalog row's title, artist, and length are not overwritten by the page, and the credit line comes from the site that was open.
- A12. When the extractor cannot read the page, the wrapper stays open, the status line says **We couldn't read this page. Select the chart and tap Paste.**, and **Paste** and **Try another site** stay in view.
- A13. Each `GrabStop` row's words appear when that stop is stubbed, and **Find chords on the web**, **Paste a sheet**, **Try again**, **Paste**, and **Grab** appear where the table shows them.
- A14. A song the player already has asks first, before the site opens, as a pick does today. A no leaves the list and opens no site.
- A15. **Try another site** opens the next site in the order and does not change the title, artist, or length.
- A16. The first Grab on a phone shows the first-use note once, with **OK**, and a later Grab does not. The wrapper opens after **OK**.
- A17. A tap on **Save** after a Grab stores the song through `addOwnSong` with a title, a credit line, and the chart, and the sheet opens with the network cut.
- A18. **Grab chords** on an empty sheet opens the Edit song editor, opens the wrapper, and **Save** writes the same song through `replaceOwnSong`.
- A19. **Grab chords** in the editor is drawn only when Grab is on and the title is not blank, it sits beside **Paste a sheet**, and an `off` stop hides it too.
- A20. Closing the wrapper, a **Cancel**, a sign-out, or an account switch before a chart is taken adds no song and puts no chart in the next account's editor.

### Verification (cook 2)

- [ ] Unit. `npm run check:chord-grab` prints `ok` for A1 to A20. Each case printed `FAIL` on the tests-only commit.
- [ ] Live, on a dev install. Search "brown eyed girl", tap **Grab** on the Van Morrison row, land on the site, tap the floating **Grab**, tap **Save**. Pass when the saved sheet has at least 4 sections and 20 chords, and it opens after the network is cut.
- [ ] Perf. The main script is 225.64 KB gzipped at `b2b248a`, read from `npm run build`. The cook fails this box when its build is over 232 KB. A Grab that pulls in more than 6 KB of new web code belongs behind `import()`.
- [ ] The owner taps through the flow on a phone in a Preview or dev install before merge, on an iPhone and, if one is at hand, an Android phone. The phone box is whether the site opened in our wrapper, whether a tap on **Grab** pasted the chart, and whether the fallback appeared when a bad page was tried.

## 2. The wrapper: what a web app can and cannot do

The owner asked for a wrapper over the browser and a floating **Grab** button that extracts the song HTML. That is not something the current web app can do on its own. This section states the real options and the recommended one.

### Why the current web app cannot inject into a chord site

- **An iframe will not load most chord sites.** A page can send `X-Frame-Options: DENY` or `SAMEORIGIN`, or a CSP `frame-ancestors` rule, and the iframe stays blank. We did not need to record those headers to know this is the usual case.
- **Even if an iframe loaded, our script could not read it.** A cross-origin iframe does not let the parent page see the document. There is no legal, supported way for a web app in one origin to reach into another origin's DOM.
- **Opening the system browser cannot host our button.** Once the player is in Safari or Chrome, our app cannot draw a floating **Grab** on that page or read its HTML.
- **Chrome Custom Tabs and Safari View Controller look like an in-app browser, and they have the same limit.** They show the real site and do not let our app run a script in the page or extract the HTML. They are not a wrapper we control.

### The real options

| Option | What the player sees | Can we extract the live page? | Main cost | Verdict |
|---|---|---|---|---|
| Capacitor WebView, with **Grab** in our native chrome | The live site, inside the installed app, with our button on top | Yes. On a tap, the app runs a script in the WebView it owns. | The app must be installed as a native app. It will not work in an ordinary browser tab. Apple and Google store accounts are needed later for Live in the stores. | Recommended |
| A proxied view: our server fetches the page, rewrites it, and we inject a button | A copy of the site, served by us | Yes, but it is our copy, not the live page the player would visit | This is a server fetch again, which the owner moved away from. Site scripts, images, and logins often break. Sites can block our server. | Rejected for this feature |
| A bookmarklet the player taps in ordinary Safari or Chrome | The live site in the system browser, plus a bookmark the player had to install | Yes, if they remember to use the bookmark | On iPhone this is awkward to install and easy to lose. It is not a wrapper, and it is not a floating button we own. | Rejected as the main path |

A Trusted Web Activity on Android shows our own web app in Chrome. It does not wrap a third-party site or let us extract one. It is not an option for Grab.

### The recommended approach, and its main catch

Use Capacitor to wrap the existing web app, and add an in-app browser that is a WebView our app owns. The floating **Grab** button is a native control in our chrome, not a node we insert into the site's document, so the site cannot hide it. On a tap, the app calls `evaluateJavascript` (or the Capacitor equivalent) to read the page and run the recipe for that site. The text stays on the phone and goes through `readPaste`.

The main catch: Grab from the page only works in the installed native app. A Preview tab in ordinary Safari or Chrome cannot do it. These cooks do not submit to the App Store or Play Store. They produce a dev or Preview install the owner can put on a phone. Store submission is a later, separate yes.

### Rules for the wrapper

- The WebView loads the live site at the listed `https` address. It does not load a proxied copy.
- Our chrome holds **Grab**, **Try another site**, and a close control. We do not inject a button that pretends to be the site's own control.
- The extractor runs only after a tap on **Grab**. It does not scrape the page in the background as the player browses.
- The app never sends the page HTML to our server. Only the song the player later saves is kept, under the rules own songs already have.
- No origin or path is hardcoded in `src/`. Listed addresses live in `data/chord-sites.json`.

## 3. The sites, and the extractors

The first plan compared seven sites and picked three. The reasons still hold for which page the wrapper opens, and for what each recipe takes.

| Site | Why it is in the set | How Grab opens it | What the recipe takes |
|---|---|---|---|
| Chordie | A clear title and artist, and chord boxes over words | Search address, player taps a result | Each chord box, as a bracket in front of its words |
| GuitarTabs.cc | A full chart in one block for the test song | Search address, player taps a result | The longest `<pre>`, minus the mail header |
| E-Chords | A chart address that can be built from the name | Built chart address | The `<pre>` and the headings |

Ultimate Guitar is not opened by Grab. A player can still open it themselves and use **Paste a sheet**.

**Try another site** is the fallback when the first page is wrong, thin, or unreadable. There is no server canary. If a site changes its markup, the fix is one recipe and one fixture in cook 2's check.

## 4. Why the Android share cook is not in this landing

The last revision made an Android share target a first path, because the player was in the system browser with a hand copy. This revision puts the player in our wrapper on both iPhone and Android, with one **Grab** tap and an automatic paste. The share cook is not needed to finish that flow.

Share would still help a player who is already in ordinary Chrome and never opens our wrapper. That is a later add-on, not a landing cook. Decision D9 is "not now." No share brief is queued, and no share cases are required in this plan.

## 5. Legal and risk

The planner is not a lawyer. This section says what the feature does and where the risk sits. It is not legal advice, and a lawyer has not read it.

### The terms of use

The player visits the live site in a browser on their phone and taps our **Grab** button so the app can copy the chart they are looking at. That is closer to ordinary browsing plus a copy than a server fetch, and it is still not a license. Some sites may forbid copying their charts, or forbid a WebView. The player is the one who taps. No cook in this plan disguises the app as the site, injects a fake site button, or bypasses a lock, a login, or a CAPTCHA.

### Copyright is still the larger remaining risk

- A chord sheet with words holds the song's lyrics. The lyrics belong to the song's publisher. The app has no lyrics license.
- After **Save**, the lyrics sit in the player's library, in the player's backup, and in a band's room if the player shares the song.
- The copy happens on the phone, after a tap, as the player looks at the page. The app does not fetch the page on a server and does not store a page the player did not save.
- A registered DMCA agent is not a license to copy lyrics. A **Grab** button is not a license either.

No screen, no doc, and no cook in this plan says or implies that Grab is licensed.

### The rules the design keeps

1. **The Worker never fetches a chord site's page.** The phone also does not `fetch` one. The in-app browser loads the page as a browser, and extraction runs on the phone after a tap.
2. **Only the saved song is kept.** Page HTML stays off our server.
3. **No crawl.** Grab opens one page for one tap. The extractor does not run as the player browses.
4. **Our button is clearly ours.** It lives in our chrome.
5. **An off switch.** An empty site table hides **Grab**.
6. **No lyrics for sale.** Grab is not the thing a paid plan sells.
7. **A way to reach the owner.** When a site or a publisher writes, the owner turns Grab off the same day and then answers.

### What the app tells the player

The first Grab on a phone shows this note once, with one **OK** button.

> **Grab opens a public chord site in our in-app browser.** When you see the chart, tap Grab. The app pastes it in. The sheet says where it came from. A chart on the web is someone's own transcription, so check it before a gig. Grab is for your own playing.

Each grabbed song carries one credit line on the sheet, such as "Chords from Chordie". `Song.sourceNote` holds it.

The privacy page gains two sentences. `check:privacy` fails on an apostrophe, so they have none.

> When you tap Grab, the app opens a public chord site in an in-app browser. You tap Grab again to copy the chart you are looking at. The app does not fetch that page on a server, and it keeps only the song you save.

### Who carries the risk

| Risk | What happens | What limits it |
|---|---|---|
| A site changes its markup | The extractor fails | The **Paste** fallback, **Try another site**, then one recipe fix |
| A site blocks a WebView | The page does not load, or it asks for a regular browser | **Try another site**, then the web search and **Paste a sheet** |
| A site or a publisher writes | The letter goes to the contact | Rule 5 and rule 7 |
| A claim over lyrics in backups and band rooms | Saved songs hold words on the server | Decision D10. A lawyer's read before Live. |

### A lower-risk variant the owner can pick later

The app can keep the section names and the chord rows and drop the words from a saved grabbed song. No cook builds this now.

## 6. Priority order and copy-ready cook briefs

None of these cooks is queued. Each brief waits for the owner's review. No build branch is open.

### The order, and why

| Order | Cook | Size | Model | Why it sits here |
|---|---|---|---|---|
| 1 | `chord-grab-shell` | Medium | Opus | The feature cannot run without a WebView we control. It is a native shell around the existing app, not a rewrite. |
| 2 | `chord-grab-app` | Medium | Opus | It is the feature the player sees: search, extract, auto-paste, and the fallback. It needs the shell and PR 116. |

After both cooks the owner has the whole loop on a phone in a dev or Preview install: search, **Grab**, land on the site, tap **Grab**, **Save**, play offline.

The model picks follow `MODEL-RULES.md`. The pick of Nov 18, 2026 makes Fable the planner and Opus the model for every cook in a plan. The standing rule of Nov 23, which moves a cook to Fable after a failed check, names the song search and learn-by-listen cooks. Whether it covers these two is the owner's call, and section 7 asks.

### Rules every brief below inherits

Each brief is ready to copy into the queue. The queue's own header, laptop notes, and report rules go around it unchanged. The same briefs are standalone files under `docs/cooks/`.

- Read `CLAUDE.md` first. Stay inside the owned files. Add one `check:*` line to `package.json` and nothing else there, except the Capacitor wiring cook 1 must add to ship a dev install.
- Commit 1 holds the tests alone, and each new case fails on it. Paste the failing run into the report. Later commits do not weaken a case. A case that is wrong goes in `QUESTIONS.md`, which is a shared log, so add the entry at the top.
- The required test cases are the numbered cases in the named section of `docs/PLAN-chord-grab.md`. Each case needs a named line that prints `ok` or `FAIL`.
- Each step of the Grab flow and each row of a state table in this plan names the cases that test it, and `npm run check:chord-grab-plan` holds that. A cook that adds a state, a row, or a control adds its case to the plan in the same commit.
- A new check passes three runs in a row before the report, on Windows paths and on Linux paths. Write paths with `fileURLToPath` and `path.join`, and read the browser from `CHROME`.
- No new libraries except Capacitor and its official iOS and Android projects in cook 1. Screen cases use `scripts/chrome.ts` and `scripts/app-page.ts`, as `scripts/check-song-search.ts` does.
- **The Worker never fetches a chord site's page.** The phone also does not `fetch` one. The in-app browser loads the page as a browser. Extraction runs on the phone after a tap. Page HTML is never sent to our server.
- **No fetched page in the repo.** Every fixture is written for the check, with made-up words. No real lyrics go in a fixture, a commit, or a report.
- No outside address in `src/` or `worker/`. An address goes in `data/chord-sites.json`. `npm run check:portable` must pass. Cook 1 may keep Capacitor's own config files, and `check:portable` must still pass or be updated in that cook only as far as the official config requires, with the change named in the report.
- A site's public name may show on a screen, as a credit. A site id, a route, a variable name, or a cook id may not.
- Every new control is styled in the cook's CSS or native chrome, is at least 44 px tall, and is checked at 360 px and 390 px.
- Handle the list in `CLAUDE.md` under "Must handle in every feature". For these cooks that means: a signed-out visitor is never trapped, a second account on the phone sees nothing of the first, an offline or slow network gives a clear message and a retry and never a duplicate song, and every empty and error state has words.
- Never deploy to Live, and never submit to a store. A local dev install is fine.

### 6.1 Brief: `chord-grab-shell`

Standalone file: `docs/cooks/chord-grab-shell.md`. Model: Opus.

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

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full.

## What the player can do

1. In a dev install, open a listed site in our in-app browser.
2. See a floating **Grab** button in our chrome, not inside the site's page.
3. Tap **Grab** and have the page's text returned to the app. Tap close or **Cancel** to go back with no song added.

## Tests first

Commit 1 holds `scripts/check-grab-shell.ts` and its one `package.json` line, and nothing else. Cases H1 to H8 of plan section 1 fail on that commit. Paste the failing run into the report. Each case prints one named `ok` or `FAIL` line.

## Owned files

Capacitor config, the official iOS and Android project files the tool adds, a small Grab-browser plugin, `src/chord-grab-bridge.ts`, `scripts/check-grab-shell.ts`, `package.json` (the Capacitor wiring this cook must have, plus one `check:grab-shell` line).

Do not touch: `src/song-paste.ts`, `src/song-text.ts`, `src/song-search.ts`, `src/song-search.tsx`, `src/song-editor.tsx`, `src/sheet.tsx`, worker files, and earlier check scripts.

## Checks

`npm run build`, `check:grab-shell`, `check:portable`, and a signed-in smoke of My Songs on the dev install.

### 6.2 Brief: `chord-grab-app`

Standalone file: `docs/cooks/chord-grab-app.md`. Model: Opus.

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

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full.

## What the player can do

1. Type a song in **Find a song to add**. Each row has a **Grab** button.
2. Tap **Grab**. The New song editor opens, and the first site opens in our in-app browser with a floating **Grab** button.
3. When the chart is on the screen, tap **Grab**. The app pastes the chart into the sheet.
4. If the app cannot read the page, select the chart and tap **Paste**.
5. Tap **Save**. The song is in My Songs and opens with no network.

## Tests first

Commit 1 holds `scripts/check-chord-grab.ts` and its one `package.json` line, and nothing else. Cases A1 to A20 of plan section 1 fail on that commit. Paste the failing run into the report. Each case prints one named `ok` or `FAIL` line.

## Owned files

`src/chord-grab.ts`, `src/chord-grab.tsx`, `src/chord-grab.css`, `src/song-editor.tsx`, `src/song-editor.css`, `src/song-search.tsx`, `src/song-search.css`, `src/library-lists.tsx`, `src/App.tsx` (at most three new lines, and at most 500 lines), `src/data-kinds.ts`, `scripts/build-privacy.ts`, `data/chord-sites.json`, `scripts/check-chord-grab.ts`, `scripts/check-one-copy.ts` (new rows only), `package.json` (one line, `check:chord-grab`).

Do not touch: `src/song-paste.ts`, `src/song-text.ts`, `src/song-search.ts`, `src/sheet.tsx`, `src/storage.ts`, worker files, the native shell except to call `src/chord-grab-bridge.ts`, and earlier check scripts apart from the new rows in `scripts/check-one-copy.ts`.

## Checks

`npm run build`, `check:chord-grab`, `check:grab-shell`, `check:song-search`, `check:song-paste`, `check:new-song`, `check:chords`, `check:screens`, `check:phone-layout`, `check:privacy`, `check:storage`, `check:one-copy`, `check:portable`.

## 7. Dependency order, phasing, cost, risk, and NEEDS TERRY

### Dependency order and phases

| Phase | What happens | Who | Waits for |
|---|---|---|---|
| 0 | The owner answers D12 and D14 | Owner | Nothing |
| 1 | `chord-grab-shell` builds and merges | Cook 1 | Phase 0 |
| 2 | The owner answers D4 to D7, if not already, and `chord-grab-app` builds | Cook 2 | Cook 1 merged, PR 116 (already merged) |
| 3 | The owner reviews Grab on a phone in a dev or Preview install | Owner | Cook 2 |

| Cook | Branches from | Files it may touch | Review-gated |
|---|---|---|---|
| 1 | `mls-int-20261113` | Capacitor config, iOS and Android projects, a Grab-browser plugin, `src/chord-grab-bridge.ts` | Yes, by the owner on a phone dev install |
| 2 | `mls-int-20261113` after cook 1 | `src/`, `data/chord-sites.json`, `scripts/build-privacy.ts` | Yes, by the owner on a phone |

Three merge seams need a second look, as `CLAUDE.md` asks.

- **`src/song-editor.tsx`.** PR 116 has merged. `bulk-import-text` may add a start draft to it, and so does cook 2. The cook that merges second merges `mls-int-20261113` first and uses the start draft that is there.
- **`src/App.tsx`.** The file had 490 lines and a cap of 500 at an earlier tip. `bulk-import-text` may add three lines, and cook 2 three.
- **`package.json`.** Cook 1 adds Capacitor wiring and one check line. Cook 2 adds one `check:*` line. Union the scripts, do not pick one side.

### Cost

- **Money for these cooks.** Nothing under the recommended answers. No key, no paid extract service, no store submission.
- **Money later, before Live in the stores.** A Google Play account is about 25 dollars once. An Apple Developer account is about 99 dollars a year. That is a later yes, not part of these cooks.
- **Upkeep.** A site changes its markup. The fix is one recipe and one fixture. A site blocks a WebView. The fallback and **Try another site** still work.
- **Cooks.** Two medium cooks, on Opus.

### Engineering risks

| Risk | The sign | What then |
|---|---|---|
| Capacitor wrapping breaks an existing phone flow | Landed checks, or the My Songs smoke | Cook 1 keeps the web app as the source of the UI and adds only the Grab browser. A broken smoke is a fail, not a later fix. |
| A site blocks a WebView | The page is blank, or it asks for a regular browser | **Try another site**, then **Paste a sheet**. The report names the site. |
| The first opened page is a search, not the chart | Chordie and GuitarTabs.cc open a search | The player taps a result, then **Grab**. E-Chords may land on the chart. |
| The extractor fails on a real page | The fallback appears | **Paste**, then a recipe fix |
| A new gesture on a pick breaks a landed search case | `check:song-search` | Cook 2 sends nothing new on a row tap. Only the **Grab** button opens the wrapper. |
| The main script grows past 232 KB gzipped | `npm run build` | Put new web Grab code behind `import()` |

### NEEDS TERRY

These are the questions that only the owner can answer. Each has a short answer.

1. **The wrapper.** Capacitor, with our floating **Grab** button, is the recommended way. A proxied page and a bookmarklet are the other real options, and they are a worse fit. Yes to Capacitor, or a different pick. (D12)
2. **Dev and Preview installs only, for these cooks.** No store submission until a later yes. Confirm. (D14)
3. **The site set and its order.** Chordie, then GuitarTabs.cc, then E-Chords, and Ultimate Guitar is not opened by Grab. Yes or no. (D4)
4. **The Grab button on a search row.** A separate **Grab** button, with a tap on the rest of the row starting an empty sheet. Yes, or one tap that always grabs. (D5)
5. **The credit line.** "Chords from Chordie" and the like on the sheet. Yes or no. (D6)
6. **The words on the screen.** The first-use note and the two privacy sentences in section 5. Yes, or the owner's own words. (D7)
7. **The Android share cook.** Not in this landing. Leave it for later, or ask for it now anyway. (D9)
8. **May a grabbed chart be shared with its words?** A, yes, as any own song today. B, chords only in a share. C, decide before Live. (D10)
9. **A lawyer's read?** Should a lawyer read section 5 before Grab reaches anyone but the owner? Yes or no.
10. **Is the app sold, or will it be?** If yes, Grab stays outside what is sold.
11. **The model rule.** Does the Nov 23 rule that moves a cook to Fable after a failed check cover these two cooks? Yes or no.

## 8. What stays unproven

- **Whether each of the three sites loads in a Capacitor WebView**, and whether any of them objects to a WebView. Cook 1's live box is the proof.
- **Whether the first plan's recipes still match today's markup.** They were measured on Nov 25, 2026, from a laptop. Cook 2's live box is the proof on a phone.
- **The E-Chords page address is a guess that worked for one song.**
- **The Chordie chart for the test song had chords on the first verse only.** The player can **Try another site**.
- **Nobody has seen the Grab button on a 360 px search row**, or the floating **Grab** on a small phone in the wrapper. The owner judges the look on a phone.
- **No terms page was read, and no lawyer has read section 5.**
- **Store install and store review are untested.** They are outside these cooks.
