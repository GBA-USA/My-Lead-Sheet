# Plan: search a song, grab its chord sheet

Written Nov 25, 2026 against `b2b248a` (PR 115, the second smart paste fix, is merged). This plan changes no app code.

## Summary and landing order

The goal is one flow. A player types a song, taps **Grab** on a result, sees the real lead sheet, and taps **Save**. The saved song is in the library and plays with no network.

Today a pick gives a sheet with a title, an artist, and a length. The chart is empty. The player then opens a web search in the browser, copies a chart, comes back, and pastes it. Smart paste reads that copy well since PR 115. The trip to the browser and back is the part this plan removes.

The owner lifted the rule "the app never fetches chord pages" for this feature on Nov 24, 2026. The rule "never store fetched pages" stays. Section 5 states the legal risk plainly.

After the four cooks below, a Grab does this:

1. The phone sends the song's title and artist to the app's own Cloudflare Worker. The phone never contacts a chord site.
2. The Worker asks the chord sites in a fixed order and stops at the first site that lists the song.
3. The Worker fetches the one chart page the player asked for, takes the chart text out of the HTML, and sends the text to the phone. The Worker keeps nothing.
4. The phone runs the text through `readPaste` in `src/song-paste.ts`, the same reader a paste uses. The song editor opens with the title, the artist, and the length filled in and the real sheet drawn.
5. The player taps **Save**. A title is required. The song is in My Songs and works offline.
6. When no site answers, the player sees why in one line, and the web search and the paste are one tap away, as today.

The cooks land in this order.

| Order | Cook | What the player gains | Waits for |
|---|---|---|---|
| 1 | `chord-grab-worker` | Nothing on the screen yet. The Worker can find and fetch a chart. | Owner decisions D1 to D4 and D8 |
| 2 | `chord-grab-app` | **Grab** in the search list, the review, and the save | Cook 1, gate G1 passed, PR 116 (`song-paste-autofill`), and owner decisions D5 to D7 |
| 3 | `chord-grab-canary` | A broken site is skipped, and the owner is warned | Cook 1 |
| 4 | `chord-grab-share` | On Android, a chart page or a selected chart shared to the app becomes a sheet | Cook 2, owner decision D9 |

```text
PR 116 ─────────────────────┐
chord-grab-worker ──► chord-grab-app ──► chord-grab-share
        └──► chord-grab-canary
```

Cooks 2 and 3 can run at the same time. Cook 2 edits `src/` and cook 3 edits `worker/`. Each adds one line to `package.json`.

One gate sits between cook 1 and the final site order. This plan could test the sites only from a laptop. A Cloudflare Worker sends its requests from Cloudflare's own network, and a site can treat that traffic differently. Gate G1 is one run of the script that cook 1 commits, pointed at the Preview Worker. G1 fixes the order. Section 7 gives the gate.

The numbers behind the order are in the next section. Five of seven sites answered a plain server request from the laptop. Text taken from four of them went through `readPaste` with no change to the reader. The sheet kept 35 of 37, 37 of 37, 98 of 102, and 96 of 96 of the page's chords.

## What was measured for this plan

Every number here comes from Nov 25, 2026. Each fetch happened once, from a laptop on a home connection. The test song is Brown Eyed Girl by Van Morrison, which is in `data/library.json`. One song and one run give a direction, not a rate. The probe and the prototype were throwaway files outside the repo. The saved replies were deleted after the run. Cook 1 commits a script that repeats the measurement.

### The test fetches

Seventeen requests went to seven sites. Each site got at most three. Every request sent the User-Agent `Mozilla/5.0 (compatible; lead-sheet-research/0.1)`, sent no cookie, and ran no script. That User-Agent starts like a browser's. The Worker will not send it, since case W18 bans the word "Mozilla".

| Site | What was asked | Answer | In front of the site |
|---|---|---|---|
| Chordie | Search page | 200, 6 KB, the result rows are in the HTML | nginx |
| Chordie | One chart page | 200, 58 KB, the chart is in the HTML | nginx |
| GuitarTabs.cc | Search page | 200, 36 KB, 28 links for the song | nginx |
| GuitarTabs.cc | One chart page | 200, 39 KB, the chart is in a `<pre>` | nginx |
| E-Chords | One chart page, by an address built from artist and title | 200, 359 KB, the chart is in a `<pre>` | Cloudflare |
| E-Chords | Search page | 200, and no result link in the HTML | Cloudflare |
| Ultimate Guitar | Search page | 200, 157 KB, 54 results inside a JSON attribute | Cloudflare |
| Ultimate Guitar | One chart page | 200, 154 KB, the chart is inside a JSON attribute | Cloudflare |
| Songsterr | Search, a JSON address | 200, JSON, the song is listed with `hasChords: true` | nginx |
| Songsterr | One chords page | 200, 78 KB, and no chart. The page holds an id for a second file. | nginx |
| Cifra Club | One chart page, by an address built from artist and title | 403, "Access Denied" | Akamai |
| AZChords | Search page, at a guessed address | 404. The guess was wrong, and the site was not tried again. | Cloudflare |

The other five requests read `robots.txt` on the five sites that answered.

| Site | What its `robots.txt` says to every client |
|---|---|
| Chordie | `Allow: /` |
| GuitarTabs.cc | Disallows the print page, the login page, and a view counter. Search and chart pages are allowed. |
| E-Chords | Disallows `/search`, any address with `?q=`, and `/api/`. Chart pages under `/chords/` are allowed. It names ten crawlers and asks them to wait 10 seconds between requests. |
| Ultimate Guitar | Disallows `/search.php`. The file is for the `www` host. The chart pages are on a second host, whose file was not fetched. |
| Songsterr | Disallows `/api/`, which is the search address that was tried. Chords pages are allowed. |

### What each site's page holds

| Site | Where the chart is | Title and artist | What a version row gives |
|---|---|---|---|
| Chordie | One `div` for each line, marked as text, comment, or tab. Each chord sits in a box with the words under it. | `h1`, and a link beside it | Title, artist, a score out of 5, the chords used |
| GuitarTabs.cc | The longest `<pre>`. Each chord is a link. The first lines are an old mail header. | `h1`, as "Artist - Title Chords & Tabs" | Artist, title with a version number, a type column |
| E-Chords | The one `<pre>`. Each chord is a `span` with a `data-chord` attribute. | `h1` and `h2` | Not used. The page address is built from artist and title. |
| Ultimate Guitar | A JSON object in one attribute. The chart marks chords with `[ch]` and tab blocks with `[tab]`. | Fields in the same JSON, with the key | Type, version, rating, votes, key, page address |

### The saved pages through the app's paste reader

The prototype took the chart text out of the four saved chart pages with about ten lines of code for each site. It then ran `readPaste` and `parseSheet` from this repo on the text. Neither function was changed.

| Site | Chords on the page | Chords on the sheet | Sections | Lines with words | What was lost |
|---|---|---|---|---|---|
| Chordie | 37 | 35 | 2 | 28 | A row of two chords between two tab blocks |
| GuitarTabs.cc | 37 | 37 | 15 | 31 | Nothing. A line "Tab from" and its address became a section name, and the mail header gave a wrong title. |
| E-Chords | 102 | 98 | 6 | 24 | The intro row, which has no colon after "Intro" |
| Ultimate Guitar | 96 | 96 | 6 | 32 | Nothing. Sixteen tab lines were left out, as a paste does. |

Three facts follow.

- The reader the app already has is enough. A grab needs no second parser.
- Each site needs a few cleaning rules that name the site, such as the mail header. Those rules belong in the Worker's site code. `src/song-paste.ts` matches by shape and names no site, and it stays that way.
- A site that draws each chord in a box is best sent as bracket text, `[G]Hey where did we [C]go`. `parseSheet` already reads brackets, and a chord in a bracket cannot drift off its syllable.

The prototype also timed the text extraction on the laptop, 31 runs for each page, on a machine with 12 cores and no other load measured.

| Page | Size | Extraction, median | Range | What bounds it |
|---|---|---|---|---|
| GuitarTabs.cc | 39 KB | 0.02 ms | 0.02 to 0.27 | One regular expression over the page |
| Chordie | 58 KB | 0.08 ms | 0.07 to 0.39 | One regular expression for each line |
| E-Chords | 359 KB | 0.24 ms | 0.24 to 0.47 | One regular expression over the page |
| Ultimate Guitar | 154 KB | 4.29 ms | 3.75 to 5.52 | Decoding the attribute and `JSON.parse` |

`worker/README.md` says the Worker runs on the Workers Free plan. From memory, that plan allows 10 ms of CPU for one request. The three `<pre>` and box sites use under 3 percent of that on the laptop. The JSON site uses about 43 percent. A Worker is not the laptop, so these numbers set no limit. They show which kind of page is cheap.

### What was not measured

- **No request was sent from a Cloudflare Worker.** This cook may not deploy. A laptop on a home connection is the friendliest client a site sees. The brief says Ultimate Guitar blocks servers, and Ultimate Guitar answered the laptop. So a laptop answer does not predict a Worker answer. Gate G1 measures it.
- **No terms page was read.** Section 5 treats every site's terms as forbidding this fetch, which is the brief's own statement.
- **No second song was tried.** A song with an odd title, a cover, or a non-English song can list badly. Cook 1's live script takes any list of songs.
- **Cifra Club was tried once, with the User-Agent above.** A full browser disguise was not tried, because the plan rejects disguises. See decision D3.
- **The honest User-Agent of decision D3 was not tried.** Every answer above came to the browser-shaped User-Agent of the test fetches. A site that filters on the User-Agent can answer the Worker's own differently. Cook 1's live script and gate G1 send the real one.

## Changes to the brief, and why

The brief gave the planner room to reorder, split, and swap methods. Each change is listed with its reason. None touches the fixed rules: no stored pages, no fetching at scale, no outside address in `src/`, offline after Save, a title required to save, and no app code in this cook.

1. **The search list stays the song catalog, and Grab is a button on each row.** The starting design sent the typed line to the Worker and listed chord pages. Three reasons changed that. The catalog row gives the exact title, artist, and length, and the length sets the scroll pace, which no chord page gives. The search box asks on every pause in typing, so a typed line sent to several chord sites would multiply the requests, while one Grab is one tap. An exact title and artist let the Worker build a page address on a site that needs no search, and let it rank a site's rows.
2. **One Grab brings the best version at once.** The starting design listed the matches and waited for a second tap. The Worker returns the site's rows, the phone fetches the first row, and the review lists the others under **Try another version**. The player reaches a sheet in one tap and loses no choice.
3. **Smart paste runs on the phone.** The Worker returns plain chart text, and the phone calls `readPaste`. The reader keeps one copy, `check:song-paste` keeps covering it, and the editor's text box stays the one editable copy of the chart.
4. **Rules that name a site live in the Worker.** The prototype found a mail header on one site and tab blocks marked in the HTML on another. The Worker's site code drops them. `src/song-paste.ts` gains nothing.
5. **The fetch runs in the Worker's entry, not in the Directory object.** The Directory is one object for every account. A page fetch and its parsing there would make every other request wait. The entry does the fetch. The Directory answers one small call that checks the session and counts the use.
6. **The fetch route is not an open fetcher.** It takes a page address only when the host and the path match a row of the site table, and it follows a redirect only inside that host. Without this rule any signed-in account could make the Worker fetch any address.
7. **The Worker is an honest client, and a block is final.** The starting design says to try the next site when one blocks. This plan adds the other half. The Worker names the app in its User-Agent, and no cook builds a browser disguise, a proxy, a cookie replay, or a CAPTCHA solver. See decision D3.
8. **`robots.txt` is honored.** Two of the five sites disallow their search pages. Decision D2 keeps the Worker off those pages. E-Chords needs no search. Ultimate Guitar does, so Ultimate Guitar leaves the search set.
9. **The fallback order is Chordie, GuitarTabs.cc, E-Chords.** Section 3 gives the reasons. Gate G1 can reorder them with one line.
10. **The canary runs inside the Worker, on a timer, one site for each run.** A canary in GitHub Actions would test from a different network than a real Grab uses. The Worker's canary also lets the search skip a broken site with no deploy.
11. **The share backup is narrower than the starting design hoped.** When a site blocks the Worker, a shared link to that site fails for the same reason. Only shared or pasted text gets through. Share target also works only on Android, in an installed app. Section 4 says so plainly, and decision D9 asks whether to build it.
12. **Grab has an off switch for each environment.** One Worker variable lists the sites that are on. An empty list turns Grab off and hides the button. Live stays off until the owner says yes. See decision D1.
13. **"Not at scale" is a number.** An account may grab 20 times an hour and 60 times a day. The whole server may answer 2,000 `find` and `page` calls a day. See decision D8.
14. **Four cooks, not one.** The Worker, the screen, the canary, and the share entry each end in their own check. The Worker cook must land and be measured from Preview before the site order is final, and the screen cook waits for PR 116. One cook would hold everything behind both.

### Things in the brief or the repo that look wrong

- **"Ultimate Guitar is known to block servers" was not confirmed and not refuted.** Ultimate Guitar answered both laptop requests with a full page. A Worker may still be refused. No cook should build on either belief before gate G1.
- **`env.production` is another person's Cloudflare account.** `worker/README.md` says so. Every fetch leaves from the account that runs the Worker, so that account's owner carries the exposure of section 5. Their yes is part of decision D1.
- **The Worker is on the Workers Free plan.** A page that hides its chart in JSON costs about 4 ms of CPU on the laptop. Adding such a site later can mean a paid plan. See section 7.
- **The privacy page names no outside service.** Decision D5 of `docs/PLAN-song-search-layers.md` asked for one sentence about the song catalog and is still open. Grab adds a second service. See decision D7.
- **Cooks 2 to 5 of the song search plan have not landed.** `NoWordsYet` is still the panel on an empty sheet. This plan builds on the tree as it is. If `song-start-panel` lands first, **Grab chords** becomes the first button of that panel.
- **The manifest has one SVG icon.** From memory, Chrome on Android wants PNG icons before it installs an app in the way a share target needs. Cook 4 checks this on a real phone before it builds anything else.
- **The standing planner add-on asks for seed tests under `tests/seed/`.** The brief for this cook allows doc files only. The test cases are numbered in sections 1 to 4, and commit 1 of each build cook holds them.
- **Pasted words in a share are still undecided.** Decision D4 of the song search plan is open. Grab makes charts with words common. See decision D10.

## Decisions the owner must make

No cook needs an API key or a new secret under the recommended answers.

| Id | Decision | Recommended answer | What waits for it |
|---|---|---|---|
| D1 | Where is Grab on? One Worker variable, `GRAB_SITES`, lists the sites for each environment. | On in Preview. Off in Live until the owner and the owner of the Live account both say yes. | The value cook 1 commits for `env.test`. Live needs no code change. |
| D2 | Does the Worker honor each site's `robots.txt`? Honoring it keeps the Worker off the search pages of Ultimate Guitar and E-Chords. | Yes | Cook 1's site table |
| D3 | Is the Worker an honest client? It names the app and a contact address in its User-Agent, sends no browser disguise, and treats a block as final. | Yes. A disguise turns a broken term of use into a deliberate way around a block. This plan builds none. | Cook 1 |
| D4 | The first site set and its order: Chordie, GuitarTabs.cc, E-Chords. Ultimate Guitar is not searched. | Yes, and gate G1 may reorder | Cook 1 |
| D5 | A search row gets a **Grab** button, and a tap on the rest of the row still starts an empty sheet. The other choice is one tap target that always grabs. | The separate button. It does what its label says, and every landed search case keeps passing. | Cook 2. The owner reviews it on a phone before merge. |
| D6 | A grabbed song carries one credit line on the sheet, such as "Chords from Chordie". | Yes. It is honest, and it tells the owner where a chart came from if a site complains. | Cook 2 |
| D7 | The first Grab shows a short note once, and the privacy page gains two sentences. Section 5 has the words. | Yes | Cook 2 |
| D8 | The limits: 20 grabs an hour and 60 a day for one account, and 2,000 `find` and `page` calls a day for the server. A `find` sends at most three requests to sites and a `page` sends one, so the cap holds the sites under 6,000 requests a day. | Yes. Each is one constant. | Cook 1 |
| D9 | Build the share entry? It works on Android in an installed app, and not on an iPhone. | Yes if the owner or the band uses Android. No if every phone is an iPhone. | Cook 4 |
| D10 | May a grabbed chart, words included, be shared with a band or a friend? Today a song the player made is shared whole. | The owner decides before Grab reaches Live. No cook in this plan changes sharing. | Nothing in this plan |
| D11 | How is the owner warned when a site breaks? A scheduled GitHub workflow can read the Worker's health route and fail red. It needs the `workflow` scope on the push token and one repo variable for the Preview address. | Yes. Without it the health route still exists, and the search still skips a broken site. | The last commit of cook 3 |

D1 to D4 and D8 are the answers cook 1 needs. Cook 2 needs D5 to D7. Section 7 lists the questions that only the owner can answer.

## 1. End-to-end UX: from search to a saved sheet

### The flow

Grab starts in the **Find a song to add** box, which already sits on My Songs and in the New song editor.

1. **Type.** The box lists recordings from the song catalog, as it does today. When the server says Grab is on, each row shows a **Grab** button at its right edge.
2. **Tap Grab.** The New song editor opens at once with the row's title, artist, and length. A status line under the fields says **Looking for chords…** and has a **Cancel** button. Nothing is saved yet. A song the player already has asks first, before any request, as a pick does today.
3. **The chart arrives.** The status line says **Getting the chart…** and then what a paste says, with the source in front, such as **Chords from Chordie. 6 sections. Left out 16 tab lines.** The text box holds the cleaned chart, and the real sheet is drawn under it.
4. **Review.** The chips for key and BPM, the capo switch, and **Use it as pasted** work as they do after a paste. **Try another version** lists the site's other rows and ends with **Look on another site**, which asks the next site in the order. A tap on a row replaces the grabbed chart and nothing else.
5. **Save.** The song goes to My Songs through `addOwnSong`, and the sheet opens. From here on the song needs no network.

A tap on the rest of the row still starts an empty sheet, as today.

Grab has two more entries. Both open the same editor, so the states and the words have one home.

- **An empty sheet.** A song the player made that has no chart shows **Grab chords** as the first control of the `NoWordsYet` panel. The Edit song editor opens with the grab started. **Save** writes the same song through `replaceOwnSong`.
- **Inside the editor.** **Grab chords** sits beside **Paste a sheet** when Grab is on and the title is not blank.

The song search plan rejected a draft that waits for **Save**, because the player left the app to copy a chart. With Grab the player stays in the app. If the phone unloads the app during the review, one tap repeats the Grab.

### The shapes, frozen by cook 1

Cook 1 adds these types to a new file, `src/chord-grab.ts`. The Worker imports them, as it already imports types from `src/chat-model.ts`.

```ts
/** A site in the table, as the phone names it. */
export type GrabSite = { id: string; name: string };
/** One chart page a site lists for the song. `label` is what the site calls the version. */
export type GrabMatch = { url: string; label: string; score?: number };
/** The first site that lists the song, and its rows, best first. */
export type GrabFound = { site: GrabSite; matches: GrabMatch[] };
/** One chart page as plain text. Nothing else leaves the Worker. */
export type GrabbedChart = { site: GrabSite; url: string; title: string; artist: string; text: string };
/** Why a Grab stopped with no chart. */
export type GrabStop = "none" | "blocked" | "offline" | "slow-down" | "signed-out" | "off" | "failed";
/** Where one Grab stands. The screen draws this value and holds no other state for it. */
export type GrabState =
	| { kind: "idle" }
	| { kind: "looking" }
	| { kind: "fetching"; found: GrabFound }
	| { kind: "got"; chart: GrabbedChart; found: GrabFound | null }
	| { kind: "stopped"; why: GrabStop };
```

Cook 2 adds `grabber(deps)` to the same file. It takes an injected `api` and timers, as `catalogSearcher` does. `grab({ title, artist })` asks the Worker to find the song, then asks for the first row's page. When that page fails, it asks for the next site and tries again. `take(match)` fetches one more row for **Try another version**. `stop()` drops the replies of a Grab the player left.

Cook 2 also gives the editor one start draft, which cook 4 reuses.

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

`docs/PLAN-bulk-import.md`, on its own branch, also gives the editor a start draft. The cook that merges second uses the one that is there and adds only the fields it lacks.

One rule decides each field. The catalog row wins for title, artist, and length. The page's title and artist fill a blank field only. Key, BPM, and capo come from `readPaste`, and they follow the paste rule that is already built. A blank or untouched field is filled, and any other difference is a chip.

### What the player sees when something fails

Every case leaves the editor open and usable. **Find chords on the web** and **Paste a sheet** are already in the editor, one tap away.

Each `GrabStop` value has one row, and the `MESSAGES` map of `src/chord-grab.tsx` holds exactly these words. A row with no `GrabStop` is not a stop.

| Case | `GrabStop` | Words on the status line | What else |
|---|---|---|---|
| No site lists the song | `none` | No chart found for this song on the sites the app can read. | **Start an empty sheet** saves the title, artist, and length, as a row tap does |
| Every site refused or timed out | `blocked` | The chord sites didn't answer. Find the chart on the web and paste it. | **Try again** |
| A page was fetched and held no chart | | The next row or the next site is tried without a word. When none is left, the `none` words show. | |
| Offline, or the Worker did not answer | `offline` | You're offline, so the app can't look for chords right now. | **Try again** |
| The account passed its limit | `slow-down` | That's a lot of grabs. Try again in a few minutes. | No button. The wait comes from the Worker. |
| The session ended | `signed-out` | Sign in again to grab chords. | The landed sign-in sheet opens, and it can be closed |
| Grab is off when the app reads `/api/auth/config` | | Nothing. The **Grab** buttons are not drawn. | |
| Grab went off after the buttons were drawn: the server passed its daily count, or the owner emptied or cut `GRAB_SITES` and deployed. The Worker says 503 `grab-off`. | `off` | Grab is resting for now. Find the chart on the web and paste it. | No button. The stop turns off the same switch that `/api/auth/config` set, so every **Grab** button is hidden for the rest of the session, until the app is opened again. |
| The Worker sent a 500, a reply that is not JSON, or a reason this table does not name, such as `bad-request` or `wrong-origin` | `failed` | Something went wrong while grabbing. Try again. | **Try again** |
| The grabbed text has no chart after cleaning | | Nothing here looks like a chart. It is in the box as pasted. | The landed paste message |
| The player types in the box, or closes the editor, while a Grab runs | | Nothing | The replies are dropped, and no song is added |
| A second account on the same phone | | No change | A grabbed song is one of the signed-in account's own songs |

### Where each part lives

| Part | File | Cook |
|---|---|---|
| Shapes, then the driver | `src/chord-grab.ts` | 1, then 2 |
| The Grab button, the status line, **Try another version**, the first-use note | `src/chord-grab.tsx`, `src/chord-grab.css` | 2 |
| The editor takes a start draft and a grabbed text | `src/song-editor.tsx` | 2 |
| The button on a search row and on the empty-sheet panel | `src/song-search.tsx` | 2 |
| Whether Grab is on | `GET /api/auth/config`, read through `src/sign-in-methods.ts` once after sign-in, and turned off for the session by an `off` stop | 1, then 2 |
| Every chord site address | `data/chord-sites.json` | 1 |

### Required test cases for the screen (cook 2)

Cases A1 to A6 run in node on `grabber` with a stub `api`. The rest drive headless Chrome, with `/api/grab/*` answered by a stub in the page.

- A1. A found song gives `looking`, `fetching`, then `got` with the first row's chart.
- A2. A first page that fails with `no-chart` makes the driver ask for the next site, and the second site's chart arrives.
- A3. `no-match` from every site gives `stopped` with `none`. A refusal from every site gives `blocked`.
- A4. A request that never got an answer gives `offline`. A 429 gives `slow-down`. A 401 gives `signed-out`. A 503 `grab-off` gives `off`. A 500 gives `failed`, and so do a 200 that is not JSON and a 400 `bad-request`.
- A5. `stop()` during `looking` drops the late reply. No state is reported after it.
- A6. `take(match)` gives `got` with that row's chart and keeps the same `found`.
- A7. With Grab on, each search row has a **Grab** button. With Grab off, none is drawn and no request leaves.
- A8. A tap on **Grab** opens the New song editor with the row's title and artist, and the status line shows the looking words.
- A9. The stub chart lands in the box, the sheet draws its headings, and the status line starts with **Chords from** and the site's name.
- A10. **Save** adds one song. Its `officialRuntimeSec` is the row's length, and its `sourceNote` is the credit line. With the network cut, a reload opens the same sheet.
- A11. **Try another version** lists the other rows. A tap replaces the chart in the box. A title the player typed stays. **Look on another site** sends `find` with `after` set to the current site.
- A12. Each row of the table above shows its words, and each `GrabStop` value has a non-empty entry in `MESSAGES`. **Start an empty sheet** adds a song with no chart. With Grab on at load, a 503 `grab-off` shows the `off` words, and then no search row and no empty-sheet panel draws a **Grab** button. A 500 shows the `failed` words and **Try again**, and the tap sends one new `find`.
- A13. A song the player already has asks first, and the stub sees no request before the answer.
- A14. On an empty sheet, **Grab chords** opens Edit song. **Save** keeps the song's id, and My Songs holds one copy.
- A15. The first Grab on this phone shows the note of section 5 once. The second Grab does not.
- A16. At 360 px and 390 px every new control is at least 44 px tall and is not clipped.
- A17. `check:song-search`, `check:song-paste`, and `check:new-song` pass with no edit to their scripts.

### Verification (cook 2)

- [ ] Unit. `npm run check:chord-grab` prints `ok` for A1 to A17. Each case printed `FAIL` on the tests-only commit.
- [ ] Live. `wrangler dev --local` with cook 1's Worker, and the app in headless Chrome. Search "brown eyed girl", tap **Grab** on the Van Morrison row, tap **Save**. Pass when the saved sheet has at least 4 sections and 20 chords, and it opens after the network is cut.
- [ ] Perf. The main script is 225.64 KB gzipped at `b2b248a`, read from `npm run build`. The cook fails this box when its build is over 232 KB. A Grab that pulls in more than 6 KB of new code belongs behind `import()`.
- [ ] The owner taps through the flow on a phone in Preview before merge. This cook changes an interaction.

## 2. Worker search and fetch

### Routes

Two new routes do the work. Both are `POST`. `worker/index.ts` sends `/api/grab/` to a new file, `worker/grab.ts`, before it tries the Directory routes. The landed Origin check sits inside the `DIRECTORY_PATH` branch of `worker/index.ts`, so it never sees these routes. The new branch calls `fromApp` itself, as step 1 of `find` says, and case W15 tests it.

| Route | Body | Answer |
|---|---|---|
| `POST /api/grab/find` | `{ title, artist, after? }` | `GrabFound`: the first site that lists the song, and up to 8 rows. `after` is a site id, and the walk starts behind it. |
| `POST /api/grab/page` | `{ url }` | `GrabbedChart`: that page's title, artist, and chart text |
| `GET /api/auth/config` | | The landed reply gains `grab: boolean` |

A refusal is `throw new Refused(reason, status)`, and the phone branches on the reason.

| Reason | Status | When |
|---|---|---|
| `wrong-origin` | 403 | `fromApp` refuses the `POST`, called by the `/api/grab/` branch |
| `signed-out` | 401 | No session, or a session that was replaced |
| `grab-off` | 503 | `GRAB_SITES` is empty, or the server passed its daily count |
| `bad-request` | 400 | No title, or a body over 2 KB |
| `slow-down` | 429 | The account passed a limit. The reply carries `waitMs`. |
| `not-a-chart-page` | 400 | The address fails the site table |
| `no-match` | 404 | `find`: a site answered, and none lists the song |
| `sites-down` | 502 | `find`: no site answered |
| `site-blocked` | 502 | `page`: the site said 403 or 429, or sent a challenge page |
| `site-down` | 504 | `page`: no answer in 6 seconds, or a 5xx |
| `no-chart` | 422 | `page`: the page was read and holds no chart, or the site said 404 |

### The site table

Every outside address is in `data/chord-sites.json`. `check:portable` scans `src/` and `worker/` for literal addresses, and it does not scan `data/`. The Worker imports the file, as `src/song-search.ts` imports `data/song-search.json`. The phone never reads it.

```json
{
	"sites": [
		{ "id": "chordie", "name": "Chordie", "origin": "https://www.chordie.com",
			"find": "/results.php?q={title}+{artist}", "page": "^/source-songs/\\d+/$" },
		{ "id": "guitartabs", "name": "GuitarTabs.cc", "origin": "https://www.guitartabs.cc",
			"find": "/search.php?tabtype=any&band={artist}&song={title}", "page": "^/tabs/[a-z0-9]/[a-z0-9_]+/[a-z0-9_]+_crd(_ver_\\d+)?\\.html$" },
		{ "id": "echords", "name": "E-Chords", "origin": "https://www.e-chords.com",
			"built": "/chords/{artist-slug}/{title-slug}", "page": "^/chords/[a-z0-9-]+/[a-z0-9-]+$" }
	]
}
```

A row has `find` or `built`, never both. `find` is a search page. `built` is a page address made from the song, for a site whose search page `robots.txt` closes. The addresses above are the ones this plan's probe used. The probe sent Chordie a longer search address, so cook 1 confirms the short form with its live script.

The code that reads a site's HTML is not data. It lives in `worker/grab-sites.ts`, in one record keyed by the same ids.

```ts
type Want = { title: string; artist: string };
type Recipe = {
	/** The site's rows for the song, best first, from its search page. A site with a built address has none. */
	matches?: (html: string, want: Want) => GrabMatch[];
	/** The chart page as text, or null when the page holds no chart. */
	chart: (html: string) => { title: string; artist: string; text: string } | null;
};
export const RECIPES: Record<string, Recipe> = { chordie, guitartabs, echords };
```

Adding a site is one row, one recipe, one fixture, and one canary song. No other file branches on a site id. The helpers that every recipe shares, such as decoding entities and dropping tags, go in `worker/grab-html.ts`. They are pure, so the check runs them in node.

Two Worker variables steer the table. Both are declared in `env.test` and `env.production`, as `check:portable` requires.

| Variable | What it does |
|---|---|
| `GRAB_SITES` | The site ids that are on, in fallback order, such as `chordie,guitartabs,echords`. Empty turns Grab off. An id that is not in the table is ignored. |
| `GRAB_SITES_AT` | Empty in both environments. A check sets it to a local stub's address, and the Worker then asks `<value>/<id>` in place of each site's origin. `GOOGLE_ISSUER` works the same way for the mock Google. |

### One Grab, step by step

`find` does this.

1. Check the Origin, read the session with `readSession`, and read the body with `readJsonObject(request, 2048)`.
2. Call `allowGrab(userId, version, "find")` on the Directory. The Directory checks that the session is current, counts the call, and refuses with `signed-out`, `slow-down`, or `grab-off`.
3. Walk the sites of `GRAB_SITES` in order, starting behind `after`. Cook 3 makes the walk skip a site that the canary marked broken.
4. For a site with `find`, fetch the search page with a 5 second limit and read at most 1 MB. Pass the HTML to `matches`. The recipe keeps the rows whose folded title matches, and whose artist matches when one was given.
5. For a site with `built`, make the address and send a `HEAD` request. A 200 is one row. The page itself is not fetched until the phone asks for it.
6. Return the first site that has a row. When the walk ends with none, refuse with `no-match` or `sites-down`.

`page` does this.

1. The same guards, then `allowGrab(userId, version, "page")`.
2. Parse `url` with `new URL`. Refuse with `not-a-chart-page` unless the scheme is `https`, the address has no port and no user, the host equals one site's host, and the path matches that site's `page` pattern. Drop the query and the hash.
3. Fetch the page with a 6 second limit and read at most 1 MB. Refuse when the final address left the site's host.
4. Pass the HTML to `chart`. A null is `no-chart`.
5. Reply with the title, the artist, and the text, cut at 60,000 characters, with `Cache-Control: no-store`.

The Worker sends one request to a site for each step. It fetches a page only when the phone asks for that page, and it does not retry.

### Guards

- **Nothing about a page is stored.** The Worker writes no page, no search HTML, and no chart text to a Durable Object, to KV, to R2, or to the Cache API. A log line holds a site id and a reason word, never page text. The chart exists in the Worker for the length of one request.
- **The only rows written are counts.** The Directory gains one table, `grab_use`, with an account id, a time bucket, and a count, and one row for the server's daily count.
- **The limits of decision D8.** One account may call `page` 20 times an hour and 60 times a day, and `find` 40 times an hour. The server may answer 2,000 `find` and `page` calls a day, and then refuses with `grab-off` until the next UTC day. Each number is a constant in `worker/grab.ts`. A variable, `GRAB_HOUR_MS`, shortens the hour for a check, as `CODE_MINUTE_MS` does for codes.
- **An honest client.** The User-Agent is built from `RP_NAME`, `APP_ORIGIN`, and `PRIVACY_CONTACT`, so a site can see who asks and can reach the owner. It holds no browser name.
- **Signed in only.** The search box is already signed in only. A visitor with no session gets `signed-out` and the landed sign-in sheet, which can be closed.

### Required test cases for the Worker (cook 1)

Cases W1 to W8 run in node on the recipes. Every fixture is HTML written for the check in the shape of the site's page, with made-up words. No fetched page is committed. Cases W9 to W18 start the Worker with `startApi` from `scripts/api-session.ts` and point `GRAB_SITES_AT` at a stub server on `127.0.0.1`.

- W1. The Chordie recipe turns each chord box into a bracket in front of its words, keeps a comment line as its own line, and drops the lines marked as tab.
- W2. The GuitarTabs.cc recipe takes the longest `<pre>`, keeps each chord in its column, and drops the mail header and the "Tab from" line.
- W3. The E-Chords recipe reads the `<pre>`, the `h1`, and the `h2`.
- W4. Each recipe's text goes through `readPaste` and `parseSheet`. Every fixture chord is on the sheet, over the syllable the fixture put it over.
- W5. `matches` keeps the song's chord rows, best first, and drops another song's rows and the tab, bass, and ukulele rows. A page with no result gives an empty list.
- W6. Entities decode, named and numbered. A `<script>` or a `<style>` inside the chart block never reaches the text.
- W7. A page with no chart block gives null from every recipe.
- W8. The site table and `RECIPES` hold the same ids. Every row has `find` or `built` and not both. Every `page` pattern compiles and matches its fixture address.
- W9. `find` returns the first site's rows, and the stub log shows that the second site was not asked.
- W10. A first site that says 403 gives the second site's rows. A first site that holds the request past the limit does the same. Every site refusing gives 502 `sites-down`. Every site answering with no row gives 404 `no-match`.
- W11. `after` starts the walk behind the named site.
- W12. `page` returns the title, the artist, and the text for a listed address. The reply has `Cache-Control: no-store`.
- W13. `page` refuses with `not-a-chart-page`, and the stub sees no request, for each of these: another host, a listed host with a path that is no chart page, `http`, an address with a port, an address with a user, a host that only starts with a listed host, and a bare IP address. A redirect that leaves the host is refused.
- W14. A site's 403 gives `site-blocked`. A 500 and a held request give `site-down`. A page with no chart gives 422 `no-chart`. A 3 MB body is cut at the limit and gives `no-chart` with no crash.
- W15. Signed out is 401. A wrong Origin is 403. With `GRAB_SITES` empty, both routes give 503 `grab-off` and `/api/auth/config` says `grab: false`. With sites listed it says `grab: true`.
- W16. The 21st `page` call inside one hour is 429 `slow-down` with a `waitMs`. After the shortened hour it passes. A second account is not slowed.
- W17. Nothing is stored. The fixture chart holds a marker word. After a `find` and a `page`, no file under the Worker's local state folder holds that word.
- W18. The User-Agent the stub saw holds the `RP_NAME` and the contact from the variables, and does not hold the word "Mozilla".

### Verification (cook 1)

- [ ] Unit. `npm run check:grab-worker` prints `ok` for W1 to W18. Each case printed `FAIL` on the tests-only commit.
- [ ] Live, the sites. `node --experimental-strip-types scripts/chord-grab-live.ts` sends five songs from `data/library.json` to each of the three sites from the laptop, 30 requests in all. Pass when at least two sites give a chart of 20 chords or more for four of the five songs. The table goes in the report.
- [ ] Live, the Worker. `wrangler dev --local`, a signed-in session, then `find` and `page` for one song. Pass when the reply text goes through `readPaste` to at least 4 sections.
- [ ] Perf. One laptop request took 0.2 to 0.9 seconds in this plan's probe, measured once for each address. The live script times `find` plus `page` for each song. The box fails when the median of five is over 5 seconds.
- [ ] `npm run build`, `check:portable`, `check:one-copy`, `check:api`, and `check:auth` under the flock pass.

Gate G1 is not the cook's to run. Section 7 gives it.

## 3. Site research, fallback order, and the canary

### The sites, and what to do with each

The section "What was measured for this plan" has the raw results. This table is the reading of them.

| Site | Place | Why |
|---|---|---|
| Chordie | First | It answered. Its `robots.txt` allows everything. No bot service sits in front of it. The HTML marks each line as text, comment, or tab, and holds each chord in a box with its words, so the chart leaves as bracket text and no chord can drift. A search row gives title, artist, and a score. One weakness: Chordie indexes charts from other sites, and a chart can be thin. The test chart had chords on the first verse only. |
| GuitarTabs.cc | Second | It answered. Its `robots.txt` allows the search and the chart pages. Its pages are the smallest and the cheapest to read. It lists several versions of a song. Its charts are old text files with a mail header, which the recipe drops. |
| E-Chords | Third | It answered. Chart pages are allowed and the search is closed, so the Worker builds the page address from artist and title and needs an artist. Cloudflare sits in front of it, so a refusal of Worker traffic is more likely than for the first two. The page is 359 KB. |
| Ultimate Guitar | Not searched | It has the best charts. The test chart has 4,288 votes. Its `robots.txt` closes the search, the brief says it refuses servers, and its page costs about 4 ms of CPU. Its charts still reach the app by paste, which reads a phone copy of its page since PR 115. A row that only fetches a shared Ultimate Guitar link is an option after gate G1. That row needs the `robots.txt` of the chart host read first. |
| Songsterr | Not now | The chords page holds no chart. The chart is a second file, and the search address is closed by `robots.txt`. |
| Cifra Club | No | It refused an honest client with 403. |
| AZChords | Untested | The one request used a wrong address. |

The order follows five questions, asked in this order. Does the site answer? Does its `robots.txt` allow the pages the Worker needs? Does the chart keep each chord over its syllable? How much does a page cost to read? How likely is the site to refuse Cloudflare's network?

The order is the value of `GRAB_SITES`, so a change is one line in `worker/wrangler.jsonc` and no code. Gate G1 measures the first and the last question from the Preview Worker and can change the order.

### How a block and a layout change look to the Worker

| What the site sends | What the Worker says | What it means |
|---|---|---|
| 403 or 429, or a reply with a `cf-mitigated` header | `site-blocked` | The site refuses this client |
| No answer in time, or a 5xx | `site-down` | The site is slow or down |
| 200 and the recipe finds no chart block | `no-chart` | The layout changed, or the reply is a challenge page |
| 200 on the search page and the recipe finds no row | `no-match` | The song is not there, or the search layout changed |

A changed search layout looks the same as a missing song for one request. The canary tells them apart, because the canary asks for a song that every site has.

### The canary

The canary is a timer inside the Worker. It runs the same functions a real Grab runs, from the same network.

- **The timer.** A cron trigger in `worker/wrangler.jsonc` fires every 2 hours. The Worker's `scheduled` handler calls `runCanary` in a new file, `worker/grab-canary.ts`.
- **One site for each run.** A run picks one site of `GRAB_SITES` by the hour and sends at most two requests, one to find the canary song and one for its first page. Three sites are each checked every 6 hours, which is 8 requests a day to one site. One site for each run also keeps a run inside the CPU limit of the Workers Free plan.
- **The canary song.** Each row of `data/chord-sites.json` gains a `canary` field with a title and an artist. The recommended song is Amazing Grace. Every site has it, and its words are in the public domain, so the timer never fetches commercial lyrics.
- **The verdict.** A chart passes with at least 8 chords and 4 lines of words. The verdict is one of `ok`, `blocked`, `down`, `no-match`, and `no-chart`.
- **What is kept.** The Directory gains one table, `grab_health`, with a site id, the verdict, the time of the check, and `fails`, the count of runs in a row that were not `ok`. No page text is kept.
- **The skip.** `find` skips a site whose `fails` is 2 or more. The canary keeps checking a skipped site, and one `ok` sets `fails` back to 0. When every site is marked, `find` ignores the marks and asks them all, so a stale mark cannot turn Grab off.
- **The warning.** `GET /api/grab/health` lists each site with its verdict, its time, and its `fails`. It holds status words only and needs no session. A scheduled GitHub workflow reads it once a day and fails when a site has `fails` of 2 or more, or when the newest check is over a day old. GitHub mails the failed run to the repo's owner. The address comes from a repo variable, because `check:portable` scans the workflow folder. See decision D11.

The canary has a limit. It asks for one song and counts chords. It cannot see a recipe that reads most charts and breaks on one kind. The phone's own fallback covers that case for the player, and the fixtures of cook 1 cover the shapes that were seen.

### Required test cases for the canary (cook 3)

- C1. `judge` passes a chart with 8 chords and 4 lines of words, fails one with 7 chords, and fails the text of a challenge page.
- C2. Three runs two hours apart visit three different sites. The stub log shows at most two requests for a run.
- C3. A stub that says 403 gives `blocked`. A held request gives `down`. A search page with no row gives `no-match`. A page with no chart block gives `no-chart`. A good page gives `ok`.
- C4. `fails` rises by one on each verdict that is not `ok`, and an `ok` sets it to 0.
- C5. `find` does not ask a site whose `fails` is 2, and asks it again after an `ok`.
- C6. With every site marked, `find` asks them all.
- C7. `GET /api/grab/health` lists each site of `GRAB_SITES`. A site that was never checked says `unknown`.
- C8. Nothing is stored. After a run, no file under the Worker's local state folder holds the fixture's marker word.
- C9. With `GRAB_SITES` empty, a run sends no request.
- C10. The Worker's `scheduled` handler runs one canary step.

### Verification (cook 3)

- [ ] Unit. `npm run check:grab-canary` prints `ok` for C1 to C10. Each case printed `FAIL` on the tests-only commit.
- [ ] Live. `wrangler dev --local` with the scheduled test switch. Fire the handler three times, then read `/api/grab/health`. Pass when each of the three sites has a verdict and at least two say `ok`. The run sends 6 requests to real sites.
- [ ] Perf. The stub log of C2 is the probe. The box fails when one run sends more than two requests.
- [ ] `npm run build`, `check:grab-worker`, `check:portable`, and `check:api` pass.

## 4. Share-to-app backup

### What a share can and cannot do

A share target is a manifest entry that puts an installed web app in the phone's share sheet. The facts in this list are from memory. None was checked on a phone in this cook, and cook 4 checks each one first.

- **Android.** Chrome offers an installed app as a share target. The app must be installed from Chrome, not opened in a tab.
- **iPhone.** Safari has no share target for a web app, in a tab or on the Home Screen. Nothing in this section can be built for an iPhone. The backup there is the one that exists today: copy the chart, come back, tap **Paste a sheet**.
- **What arrives.** A share carries a title, a text, and an address. Chrome often puts a page's address in the text field. A share of selected words puts the words in the text field.

A shared link and a shared text are different backups.

| What was shared | What the app needs | Works when the site blocks the Worker | Works offline |
|---|---|---|---|
| A link to a chart page | The Worker must fetch the page, through `POST /api/grab/page` | No. The Worker is refused for a shared link as for a Grab. | No |
| The chart, selected on the page | Nothing. The phone already holds the text. | Yes | Yes |

So the link share helps in one case. The player is already on a page of a listed site, such as a version the search did not list. The text share is the real backup for a blocked site, and it is the paste flow with two taps fewer.

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

4. **The editor opens.** A text share opens the New song editor with the text taken as a paste. A link share opens it with a Grab of that one page. Both use the start draft that cook 2 adds to the editor.

A text that holds a chart and a link is a text share, because the chart needs no network. A text that holds only a link, or a title and a link, is a link share.

| Case | What the player sees |
|---|---|
| A link to a chart page on a listed site | The review, as after a Grab |
| A link to any other page | The app can't read that page. Select the chart on the page and copy it, then tap **Paste a sheet**. |
| A link the site refused | The same words |
| Any other stop of the link's Grab, such as `slow-down`, `off`, or `failed` | The words of that `GrabStop` in the section 1 table |
| A link, with no network | You're offline, so the app can't fetch that page right now. **Try again** |
| Selected chart text | The review, as after a paste |
| Nothing usable | The New song editor, with "Paste your sheet into the box." |
| Signed out | The landed sign-in sheet. Closing it leaves the app usable and shows "Sign in to add the shared chart." The share opens after a sign-in on the same page. |

Two limits stay. A share starts the app on a fresh page, so an editor draft that was open and not saved is lost, as with any reload. The manifest has one SVG icon, and Chrome may want PNG icons before it installs the app. The cook renders them from `public/favicon.svg` with the repo's Chrome driver if the phone test asks for them.

### Required test cases for the share entry (cook 4)

- S1. The sorting function: an address field gives `link`. A text that is only an address gives `link`. A title line and an address give `link`. A text with chart lines gives `text`. A chart with an address in it gives `text`. Nothing gives `empty`.
- S2. The built manifest has a `share_target` with `POST`, an action inside the scope, and the three fields.
- S3. With the network cut, a form `POST` to the share action lands on the app, and the page stub sees no request that holds the shared text.
- S4. A shared chart opens the New song editor with the cleaned chart and the paste status line. **Save** adds one song.
- S5. A shared link to a listed site, with `/api/grab/page` stubbed, opens the review with the credit line.
- S6. `not-a-chart-page` and `site-blocked` show the words of the table, and **Paste a sheet** is on the screen.
- S7. With the network cut, a shared link shows the offline words and **Try again**, and a shared chart still opens.
- S8. Signed out, the sign-in sheet opens and can be closed. The app is usable after the close. After a sign-in the shared chart opens.
- S9. The share is taken once. A reload does not open the editor again, and the address bar holds no shared text.
- S10. A share that arrives while a song is open lands on the editor, and the open song is unchanged in the library.
- S11. A second account on the phone does not see a share that arrived for the first.
- S12. `check:offline` passes with no edit to its script.

### Verification (cook 4)

- [ ] Unit. `npm run check:grab-share` prints `ok` for S1 to S12. Each case printed `FAIL` on the tests-only commit.
- [ ] Live, the owner's. On an Android phone with the Preview app installed, open a Chordie chart page in Chrome, tap Share, and pick the app. Then select a chart on any chord page and share the selection. Pass when each lands a sheet with at least 4 sections.
- [ ] Perf. The main script may grow by at most 2 KB gzipped over the base the cook branched from, read from `npm run build`.
- [ ] `check:offline`, `check:chord-grab`, `check:new-song`, and `check:portable` pass.

## 5. Legal and risk

The planner is not a lawyer. This section says what the feature does and where the risk sits. It is not legal advice, and a lawyer has not read it.

### The terms of use, which the owner accepted

The brief states that most chord sites, Ultimate Guitar included, forbid this kind of fetch in their terms. The owner accepted that risk on Nov 24, 2026. No terms page was read in this cook.

Grab breaks those terms each time it runs. The likely results, in order, are that the site blocks the Worker, that the site writes to ask the app to stop, and that the site makes a claim for breach. The Worker signs in nowhere and gets past no lock, and decision D3 keeps it that way.

### Copyright is the larger risk

- A chord sheet with words holds the song's lyrics. The lyrics belong to the song's publisher. From memory, the largest chord site pays publishers for a license. The app has none.
- When a player taps **Grab**, the app's server copies a page that holds lyrics and sends the lyrics to the phone. After **Save**, the lyrics sit in the player's library, in the player's backup on the app's server, and in a band's room if the player shares the song.
- So each Grab is a copy of lyrics with no license, made by the app's server. A term of use is a contract with one site. Copyright is a right the publisher holds against anyone. From memory, publishers forced tab and chord sites offline in 2005 and 2006 over this.
- Four things lower the exposure and do not remove it. One page is fetched for one tap. Nothing is kept except the song the player saves. The app does not charge for lyrics. The sheet credits the site.

### What a DMCA agent and a Grab button are not

- A registered DMCA agent gives a service a notice and takedown process for material that its users store on it. It is not a license to copy lyrics, and it grants no right to fetch a page.
- The shelter that comes with it may not cover Grab at all. The app's own server fetches the page, as a feature the app built. Whether a fetch at a player's tap counts as the player's act is a question for a lawyer.
- A Grab button is not a license. A player's tap gives the app no right that the player does not have.

No screen, no doc, and no cook in this plan says or implies that Grab is licensed.

### The rules the design keeps

1. **Never store fetched pages.** No page, no search HTML, and no chart text is written on the server. Cases W17 and C8 test this rule.
2. **Only the saved song is kept.** It is the player's own song, under the storage and backup rules that own songs already have.
3. **One page for one tap.** The limits of decision D8 cap an account and the server. No cook builds a crawl, a list of a site's songs, or a fetch of a row the player did not ask for. The canary asks for a public domain song.
4. **An honest client.** The Worker names the app and a contact. A block is final. `robots.txt` is honored.
5. **An off switch.** Removing a site's id from `GRAB_SITES` stops every fetch to that site at the next deploy. An empty value turns Grab off and hides the button.
6. **No lyrics for sale.** Grab is not the thing a paid plan sells, and no screen or store text promises lyrics.
7. **A way to reach the owner.** The contact on the privacy page is where a site or a publisher writes. When one writes, the owner turns that site off the same day and then answers.

### What the app tells the player

The first Grab on a phone shows this note once, with one **OK** button.

> **Grab pulls a chart from a public chord site.** The sheet says where it came from. A chart on the web is someone's own transcription, so check it before a gig. Grab is for your own playing.

Each grabbed song carries one credit line on the sheet, such as "Chords from Chordie". `Song.sourceNote` holds it, and the sheet already draws that field.

The privacy page gains two sentences. `check:privacy` fails on an apostrophe, so they have none.

> When you tap Grab, our server asks public chord sites for the song you picked. Those sites see our server and not your phone, and we keep no copy of their pages.

### Who carries the risk

| Risk | What happens | What limits it |
|---|---|---|
| A site blocks the Worker | Grab from that site stops. The canary marks the site, and the search skips it. | The next site, then the web search and the paste |
| A site or a publisher writes to the owner | The letter goes to the contact, or to Cloudflare as an abuse report against the account that runs the Worker | Rule 5 and rule 7 |
| The account that runs the Worker is acted on | Cloudflare can limit a Worker after abuse reports. The Live Worker runs in another person's account. | Decision D1 keeps Live off until that person agrees |
| A claim over lyrics in backups and band rooms | Saved songs hold words on the server | Decision D10. A lawyer's read before Live. |

### A lower-risk variant the owner can pick later

The Worker can drop the words and send only the section names and the chord rows. A chart with no words holds no lyrics. That takes away most of the copyright exposure of this section and leaves the terms of use. The player then adds words by paste. The change is one flag in the Worker, and no cook builds it now.

## 6. Priority order and copy-ready cook briefs

None of these cooks is queued. Each brief waits for the owner's review. No build branch is open.

### The order, and why

| Order | Cook | Size | Model | Why it sits here |
|---|---|---|---|---|
| 1 | `chord-grab-worker` | Medium | Opus | Every other cook calls its routes. It also commits the live script that gate G1 runs, and G1 fixes the site order. |
| 2 | `chord-grab-app` | Medium | Opus | It is the feature the player sees. It needs the routes and the editor as PR 116 leaves it. |
| 3 | `chord-grab-canary` | Small | Opus | It needs the site code of cook 1 and no screen. It can run beside cook 2. |
| 4 | `chord-grab-share` | Small | Opus | It gives the least, works on Android only, and needs the editor entry of cook 2. Decision D9 can drop it. |

After cooks 1 and 2 the owner has the whole loop on a phone in Preview: search, **Grab**, review, **Save**, play offline.

The model picks follow `MODEL-RULES.md`. The pick of Nov 18, 2026 makes Fable the planner and Opus the model for every cook in a plan. The standing rule of Nov 23, which moves a cook to Fable after a failed check, names the song search and learn-by-listen cooks. Whether it covers these four is the owner's call, and section 7 asks.

### Rules every brief below inherits

Each brief is ready to copy into the queue. The queue's own header, laptop notes, and report rules go around it unchanged. The same briefs are standalone files under `docs/cooks/`.

- Read `CLAUDE.md` first. Stay inside the owned files. Add one `check:*` line to `package.json` and nothing else there.
- Commit 1 holds the tests alone, and each new case fails on it. Paste the failing run into the report. Later commits do not weaken a case. A case that is wrong goes in `QUESTIONS.md`, which is a shared log, so add the entry at the top.
- The required test cases are the numbered cases in the named section of `docs/PLAN-chord-grab.md`. Each case needs a named line that prints `ok` or `FAIL`.
- A new check passes three runs in a row before the report, on Windows paths and on Linux paths. Write paths with `fileURLToPath` and `path.join`, and read the browser from `CHROME`.
- No new libraries. Screen cases use `scripts/chrome.ts` and `scripts/app-page.ts`, as `scripts/check-song-search.ts` does.
- **The fetch rule.** The Worker may search the listed chord sites and fetch the one page a player asks for. Nothing that was fetched is stored. No page, no search HTML, and no chart text goes into a Durable Object, KV, R2, the Cache API, or a log line.
- **No fetched page in the repo.** Every fixture is written for the check in the shape of the site's page, with made-up words. No real lyrics go in a fixture, a commit, or a report.
- **No disguise.** Never a browser User-Agent, a proxy, a replayed cookie, or a CAPTCHA solver. A refused request is a result to report.
- **Live runs are few.** A live script sends at most the number of requests its brief names. It never runs in a loop, and it is never a `check:*` script.
- No outside address in `src/` or `worker/`. An address goes in `data/chord-sites.json`. `npm run check:portable` must pass.
- A site's public name may show on a screen, as a credit. A site id, a route, a variable name, or a cook id may not.
- Every new control is styled in the cook's CSS file, is at least 44 px tall, and is checked at 360 px and 390 px.
- Handle the list in `CLAUDE.md` under "Must handle in every feature". For these cooks that means: a signed-out visitor is never trapped, a second account on the phone sees nothing of the first, an offline or slow network gives a clear message and a retry and never a duplicate song, and every empty and error state has words.
- Never deploy. `wrangler dev --local` is fine.

### 6.1 Brief: `chord-grab-worker`

Standalone file: `docs/cooks/chord-grab-worker.md`. Model: Opus.

```text
## HANDOFF
GOAL: The app's Worker can find a song on the listed chord sites, in fallback order, and return one chart page as plain text that readPaste turns into a sheet. Nothing fetched is stored, and the Worker fetches no address outside the site table.
DECIDED: one cook, one branch, cook/chord-grab-worker off mls-int-20261113; two POST routes under /api/grab/ answered in the Worker's entry, with one small Directory call for the session and the counts; the site table is data/chord-sites.json and the site code is one record in worker/grab-sites.ts; the sites and their order are Chordie, GuitarTabs.cc, E-Chords (plan decision D4); robots.txt is honored (D2); the client is honest (D3); the limits are those of D8; GRAB_SITES is the off switch, set for env.test and empty for env.production (D1); smart paste runs on the phone.
REJECTED: storing or caching any page, search HTML or chart text; a fetch of an address that is not in the site table; a browser disguise, a proxy, a cookie replay or a CAPTCHA solver; a search of Ultimate Guitar; the fetch inside the Directory object; HTMLRewriter or any parser the node check cannot run; a second chart reader or any edit to src/song-paste.ts; a site named in src/ or worker/; a fetched page as a fixture; new libraries; a deploy; edits outside the owned files.
DONE MEANS: cases W1 to W18 of plan section 2 each have a named check line that failed on the tests-only commit and passes now; the boxes under "Verification (cook 1)" in section 2 are ticked with their evidence in the report; scripts/chord-grab-live.ts was run once from the laptop and its table is in the report; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-chord-grab.md sections 1 (the shapes), 2, 3 and 5.
NEEDS OWNER: D1 to D4 and D8 answered before this cook starts. After it merges and Preview is deployed, gate G1 (plan section 7) is run once.

# The Worker finds and fetches a chart

## What the app can do after this cook
1. POST /api/grab/find with a title and an artist returns the first listed site that has the song, and up to 8 rows.
2. POST /api/grab/page with one of those addresses returns the page's title, artist and chart as plain text.
3. GET /api/auth/config says whether Grab is on. No screen changes in this cook.

## Tests first
Commit 1 holds scripts/check-grab-worker.ts and its one package.json line, and nothing else. Cases W1 to W18 fail on that commit. Paste the failing run into the report.

## Owned files
data/chord-sites.json (new), src/chord-grab.ts (new: the types of plan section 1 and nothing else), worker/grab.ts (new: the routes, the guards, the limits, the User-Agent), worker/grab-sites.ts (new: RECIPES and the walk), worker/grab-html.ts (new: pure HTML helpers), worker/directory-grab.ts (new: the grab_use table and allowGrab), worker/directory.ts (create the table, expose allowGrab), worker/index.ts (the /api/grab/ branch and the new Env fields), worker/directory-account.ts (the grab field of GET /api/auth/config and nothing else), src/sign-in-methods.ts (the grab field of AuthConfig and nothing else), worker/wrangler.jsonc (GRAB_SITES, GRAB_SITES_AT and GRAB_HOUR_MS in both environments), worker/README.md (the routes and the variables), scripts/check-grab-worker.ts (new), scripts/chord-grab-live.ts (new, a script a person runs), scripts/check-one-copy.ts (new rows only), package.json (one line).

Do not touch: src/song-paste.ts, src/song-text.ts, src/song-search.ts, src/song-search.tsx, src/song-editor.tsx, public/, worker/room*.ts, worker/codes.ts, worker/session.ts, earlier check scripts apart from the new rows in check-one-copy.

## Checks
npm run build, check:grab-worker, check:api, check:auth (under the flock), check:headers, check:song-paste, check:one-copy, check:portable.
```

### 6.2 Brief: `chord-grab-app`

Standalone file: `docs/cooks/chord-grab-app.md`. Model: Opus.

```text
## HANDOFF
GOAL: A signed-in player taps Grab on a search result, sees the song's chart as the real sheet with the title, artist and length filled in, and taps Save. The song is in My Songs and opens with no network. When no site has the chart, the player sees why and is one tap from the web search and the paste.
DECIDED: one cook, one branch, cook/chord-grab-app off mls-int-20261113 after chord-grab-worker and PR 116 (song-paste-autofill) have merged and gate G1 (plan section 7) has passed; the search list stays the song catalog and each row gains a Grab button (plan decision D5); Grab opens the one SongEditor with a start draft, and the grabbed text is taken as a paste through readPaste; the first row is fetched at once and the others sit under Try another version; the catalog row wins for title, artist and length; a grabbed song carries a credit line in Song.sourceNote (D6); the first Grab shows the note of plan section 5 once, and the privacy page gains its two sentences (D7); the state of a Grab is one value from grabber in src/chord-grab.ts.
REJECTED: a second editor or a second preview; a second chart reader; a site address or a site id in src/; a request from the phone to a chord site; a song saved before the player taps Save; a page's title written over one the player typed; the grabbed text kept anywhere but the editor's box; any new localStorage key except the first-use flag; new libraries; edits to worker files; edits outside the owned files.
DONE MEANS: cases A1 to A17 of plan section 1 each have a named check line that failed on the tests-only commit and passes now; the boxes under "Verification (cook 2)" in section 1 are ticked with their evidence in the report; src/App.tsx is at most 500 lines; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-chord-grab.md sections 1 and 5.
NEEDS OWNER: D5 to D7 answered, and gate G1 (plan section 7) passed, before this cook starts. A G1 table that stops the feature means this cook does not run. The cook changes an interaction, so the owner reviews it on a phone in Preview before merge.

# Grab in the search list

## What the player can do
1. Type a song in Find a song to add. Each row has a Grab button.
2. Tap Grab. The New song editor opens with the title, artist and length, says Looking for chords, then shows the chart as the real sheet with "Chords from" and the site's name.
3. Tap Try another version to swap the chart. Tap a chip to take a key or a BPM. Edit anything.
4. Tap Save. The song is in My Songs and opens with no network.
5. On a sheet with no chart, tap Grab chords. In the editor, tap Grab chords beside Paste a sheet.

## Tests first
Commit 1 holds scripts/check-chord-grab.ts and its one package.json line, and nothing else. Cases A1 to A17 fail on that commit. Paste the failing run into the report. The check starts no Worker. It answers /api/me, /api/auth/config and /api/grab/* from a stub, as scripts/check-song-search.ts answers the catalog.

## Owned files
src/chord-grab.ts (add grabber; keep the types as cook 1 froze them), src/chord-grab.tsx and src/chord-grab.css (new: the Grab button, the status line, Try another version, the first-use note, the MESSAGES map), src/song-editor.tsx and src/song-editor.css (SongEdit gains a start draft; a grabbed text goes through takePaste; the length and the credit line reach the saved song; Grab chords beside Paste a sheet), src/song-search.tsx and src/song-search.css (the button on a row, Grab chords in NoWordsYet, the hint line), src/library-lists.tsx and src/App.tsx (pass the start draft to the editor; at most three new lines in src/App.tsx), src/data-kinds.ts (the first-use flag) and scripts/build-privacy.ts (the two sentences), scripts/check-chord-grab.ts (new), scripts/check-one-copy.ts (new rows only), package.json (one line).

Do not touch: src/song-paste.ts, src/song-text.ts, src/song-search.ts, src/sheet.tsx, src/storage.ts, worker files, data/chord-sites.json, earlier check scripts apart from the new rows in check-one-copy.

## Checks
npm run build, check:chord-grab, check:song-search, check:song-paste, check:new-song, check:chords, check:screens, check:phone-layout, check:privacy, check:storage, check:one-copy, check:portable.
```

### 6.3 Brief: `chord-grab-canary`

Standalone file: `docs/cooks/chord-grab-canary.md`. Model: Opus.

```text
## HANDOFF
GOAL: The Worker checks each listed chord site on a timer with one known song. A site whose chart can no longer be read is skipped by the next Grab with no deploy, and the owner can see each site's state at one address.
DECIDED: one cook, one branch, cook/chord-grab-canary off mls-int-20261113 after chord-grab-worker has merged; a cron trigger every 2 hours runs one site for each run, with at most two requests; the canary calls the same site code a Grab calls; the canary song is a field of each row in data/chord-sites.json and is a public domain song; the Directory keeps one row for each site with a verdict, a time and a count of failed runs; find skips a site after two failed runs and asks every site when all are marked; GET /api/grab/health is open and holds status words only.
REJECTED: a canary that runs in CI in place of the Worker's own; more than two requests in one run; a commercial song as the canary song; storing any page text or chart text; a health reply that holds page text; a test-only route; an address in the workflow file; a mark that can turn Grab off for good; new libraries; a deploy; edits outside the owned files.
DONE MEANS: cases C1 to C10 of plan section 3 each have a named check line that failed on the tests-only commit and passes now; the boxes under "Verification (cook 3)" in section 3 are ticked with their evidence in the report; npm run build and npm run check:portable are green; the workflow file is the last commit, or the report says that the push token lacks the workflow scope and gives the file in full.
SOURCE: docs/PLAN-chord-grab.md sections 2 and 3.
NEEDS OWNER: D11. The workflow file needs the workflow scope on the push token, which the owner grants with gh auth refresh -s workflow, and one repo variable that holds the Preview address of the health route.

# The canary

## What the owner can do after this cook
1. Open /api/grab/health and read each site's verdict, the time of its last check, and its count of failed runs.
2. Get a mail from GitHub when a site has failed twice in a row, or when the canary has not run for a day.
3. Do nothing when a site breaks. The next Grab skips it.

## Tests first
Commit 1 holds scripts/check-grab-canary.ts and its one package.json line, and nothing else. Cases C1 to C10 fail on that commit. Paste the failing run into the report.

## Owned files
worker/grab-canary.ts (new: runCanary, judge), worker/directory-grab.ts (the grab_health table, noteCanary, and the read that find and the health route use), worker/directory.ts (create the table, expose the two methods), worker/grab.ts (the health route), worker/grab-sites.ts (the walk skips a marked site; no recipe changes), worker/index.ts (the scheduled handler), worker/wrangler.jsonc (the cron trigger), data/chord-sites.json (the canary field of each row), worker/README.md, scripts/check-grab-canary.ts (new), scripts/chord-grab-live.ts (a --health switch that prints the route's reply), .github/workflows/grab-canary.yml (new, the last commit), package.json (one line).

Do not touch: src/, public/, the recipes in worker/grab-sites.ts, worker/room*.ts, earlier check scripts.

## Checks
npm run build, check:grab-canary, check:grab-worker, check:api, check:one-copy, check:portable.
```

### 6.4 Brief: `chord-grab-share`

Standalone file: `docs/cooks/chord-grab-share.md`. Model: Opus. Queue this brief only when decision D9 is yes.

```text
## HANDOFF
GOAL: On an Android phone with the app installed, a player shares a chart page, or a chart selected on any page, from the browser to the app. The New song editor opens with the chart as the real sheet. A shared chart needs no network. A shared link that the app cannot read says so and points at Paste a sheet.
DECIDED: one cook, one branch, cook/chord-grab-share off mls-int-20261113 after chord-grab-app has merged; the manifest gains a share_target with POST; the service worker answers that POST on the phone, so the shared text reaches no server; the app takes the share once at start; a shared chart goes through readPaste and a shared link goes through POST /api/grab/page; both open the editor through the start draft of chord-grab-app; nothing is built for an iPhone.
REJECTED: a GET share target, which puts the chart in a request address; any request that carries shared text to a server; a fetch of a shared link outside the site table; a second editor; a second place that keeps the share after it is read; a change to how the service worker serves any GET; new libraries; edits to worker files; edits outside the owned files.
DONE MEANS: cases S1 to S12 of plan section 4 each have a named check line that failed on the tests-only commit and passes now; the boxes under "Verification (cook 4)" in section 4 are ticked with their evidence in the report, with the owner's phone box left for the owner; check:offline passes with no edit to its script; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-chord-grab.md sections 1 and 4.
NEEDS OWNER: D9 must be yes. The owner runs the phone box on an Android phone in Preview before merge.

# Share a chart to the app

## What the player can do
1. On a chart page in Chrome on Android, tap Share and pick the app. A page from a listed site opens as a sheet to review.
2. Select a chart on any page, tap Share, and pick the app. The chart opens as a sheet to review, with or without a network.
3. Tap Save. The song is in My Songs.

## Tests first
Commit 1 holds scripts/check-grab-share.ts and its one package.json line, and nothing else. Cases S1 to S12 fail on that commit. Paste the failing run into the report.

## Owned files
public/manifest.webmanifest (the share_target, and PNG icons only if the phone test asks for them), public/sw.js (one branch for the share POST; keep the BUILD line as it is), src/share-entry.ts (new: take the share once, and the sorting function), src/chord-grab.tsx (the words for a shared link the app cannot read), src/song-editor.tsx (only if the start draft needs one more field for a single page address), src/App.tsx or src/main.tsx (call the entry at start; at most three new lines in src/App.tsx), scripts/check-grab-share.ts (new), package.json (one line).

Do not touch: src/song-paste.ts, src/chord-grab.ts apart from an import, worker files, data/chord-sites.json, scripts/check-offline.ts, earlier check scripts.

## Checks
npm run build, check:grab-share, check:offline, check:chord-grab, check:new-song, check:song-paste, check:one-copy, check:portable.
```

## 7. Dependency order, phasing, cost, risk, and NEEDS TERRY

### Dependency order and phases

| Phase | What happens | Who | Waits for |
|---|---|---|---|
| 0 | The owner answers D1 to D4 and D8 | Owner | Nothing |
| 1 | `chord-grab-worker` builds and merges | Cook 1 | Phase 0 |
| G1 | The live script runs once against the Preview Worker | Whoever runs the laptop, not a cook | Cook 1 merged and Preview deployed |
| 2 | `chord-grab-app` and `chord-grab-canary` build side by side | Cooks 2 and 3 | G1 for cook 2, with PR 116 and D5 to D7. Cook 1 alone for cook 3. |
| 3 | The owner reviews Grab on a phone in Preview | Owner | Cook 2 |
| 4 | `chord-grab-share` builds | Cook 4 | Cook 2 merged, and D9 is yes |

| Cook | Branches from | Files it may touch | Review-gated |
|---|---|---|---|
| 1 | `mls-int-20261113` | `worker/`, `data/chord-sites.json`, the types in `src/chord-grab.ts`, one field in `src/sign-in-methods.ts` | No |
| 2 | `mls-int-20261113` after cook 1 and PR 116 | `src/`, `scripts/build-privacy.ts` | Yes, by the owner on a phone |
| 3 | `mls-int-20261113` after cook 1 | `worker/`, `data/chord-sites.json`, one workflow file | No |
| 4 | `mls-int-20261113` after cook 2 | `public/manifest.webmanifest`, `public/sw.js`, `src/` | Yes, by the owner on an Android phone |

Three merge seams need a second look, as `CLAUDE.md` asks.

- **`src/song-editor.tsx`.** PR 116 is changing it now. `bulk-import-text` adds a start draft to it, and so does cook 2. The cook that merges second merges `mls-int-20261113` first and uses the start draft that is there.
- **`src/App.tsx`.** The file has 490 lines and a cap of 500. `bulk-import-text` may add three lines, cook 2 three, and cook 4 three.
- **`package.json`.** Each cook adds one `check:*` line.

### Gate G1: do the sites answer the Worker?

Run this once, after cook 1 has merged and the laptop has deployed Preview.

1. Run `node --experimental-strip-types scripts/chord-grab-live.ts --worker <the Preview address>`. The script enters Preview as a preview account and sends `find` and `page` for five songs through the Preview Worker. That is at most 30 requests to the sites.
2. Read the table. Each site has a line with its answers, the chords on each sheet, and the time of each call.
3. Watch the Worker's log during the run for a call that passed the CPU limit.

| Result | What to do |
|---|---|
| All three sites answer | Keep the order. Queue cook 2. |
| One site refuses the Worker | Take its id out of `GRAB_SITES` for `env.test`. Queue cook 2. |
| A site answers and its sheets are thin | Move it behind the others in `GRAB_SITES` |
| A call passed the CPU limit | Take that site out, or move the Worker to a paid plan |
| One site or none answers | Stop. Grab has too little ground from a Worker. Go back to the owner with three paths: ask a site for permission, lean on the paste and the share entry, or drop the feature. A proxy outside Cloudflare is a way around a block, and decision D3 rejects it. |

### Cost

- **Money.** Nothing under the recommended answers. No key, no paid service. A paid Workers plan is needed only if G1 shows a CPU problem. From memory it costs about 5 dollars a month.
- **Worker use.** One Grab is two Worker calls and two Directory calls. The server cap of 2,000 calls a day is small beside the free plan's daily request limit. `find` sends at most three requests to sites, and `page` sends one.
- **Site traffic.** At the cap, the three sites together get at most 6,000 requests a day, and nearer 4,000 when each `find` is followed by its `page`. The canary adds 24.
- **Upkeep.** A site changes its layout, and a recipe breaks. Each break is one small fix cook: a recipe, a fixture, a live run. The planner's guess is a few breaks a year for three sites.
- **Cooks.** Two medium and two small, on Opus.

### Engineering risks

| Risk | The sign | What then |
|---|---|---|
| Sites refuse Cloudflare's network | Gate G1 | The table of G1 |
| A layout changes | The canary says `no-chart` or `no-match` twice | The search skips the site. A fix cook updates the recipe. |
| The first chart is thin or wrong | The owner's phone review | **Try another version** and **Look on another site** in the review. The order can change in `GRAB_SITES`. |
| The wrong song is grabbed, such as a cover | The review shows the sheet before **Save** | The player picks another version or cancels |
| A new request on a pick breaks a landed search case | `check:song-search` case 2d compares every cross-origin request that is not a catalog call with an empty list. Same-origin calls pass through its stub unseen. | Cook 2 sends nothing new on a row tap. Only the **Grab** button sends a request. |
| Preview gives any visitor an account | Many accounts could pass the limit for one account | The server cap of 2,000 a day holds for all of them together |
| The service worker change breaks offline | `check:offline` | Cook 4 adds one branch for one `POST` and changes no `GET` |

### NEEDS TERRY

These are the questions that only the owner can answer. Each has a short answer.

1. **Where is Grab on?** Preview only for now, yes or no. Has the owner of the Live account agreed to run these fetches from that account? (D1)
2. **Honor `robots.txt`?** Yes or no. A no puts a search of Ultimate Guitar back on the table. (D2)
3. **An honest client, and a block is final?** Yes or no. (D3)
4. **Which phones?** Android, iPhone, or both, for the owner and for the band. An iPhone gets nothing from cook 4. (D9)
5. **May a grabbed chart be shared with its words?** A, yes, as any own song today. B, chords only in a share. C, decide before Live. (D10)
6. **A lawyer's read?** Should a lawyer read section 5 before Grab reaches anyone but the owner? Yes or no.
7. **Is the app sold, or will it be?** If yes, Grab stays outside what is sold.
8. **Is a contact address set in Preview?** The Worker names `PRIVACY_CONTACT` to the chord sites.
9. **The canary's mail.** Will the owner run `gh auth refresh -s workflow` and add the repo variable? Yes or no. (D11)
10. **Would chords with no words be enough?** If yes, the lower-risk variant of section 5 becomes the default.
11. **The words on the screen.** The **Grab** button on each row, the credit line, the first-use note, and the two privacy sentences. Yes, or the owner's own words. (D5 to D7)
12. **The model rule.** Does the Nov 23 rule that moves a cook to Fable after a failed check cover these four cooks? Yes or no.

## 8. What stays unproven

- **Whether any site answers a Cloudflare Worker.** Every fetch in this plan left from a laptop. Gate G1 is the test, and its table can stop the feature.
- **The numbers rest on one song and one run.** Brown Eyed Girl is a famous song in English. Cook 1's live script tries five songs. A site that fails on songs with odd titles will show there.
- **The chord counts say how many chords survive, not whether each sits over the right syllable.** The prototype counted. It did not compare positions. Case W4 compares positions on fixtures, and the owner's phone review is the proof on real charts.
- **The CPU numbers are from a laptop.** The Workers Free limit of 10 ms is from memory. G1 reads the real number from the Worker's log.
- **Every Cloudflare limit in section 7 is from memory.** The daily request limit, the limit on requests to other sites inside one call, and the price of the paid plan were not looked up.
- **The share target facts are from memory.** Chrome's rules for installing the app, the fields a share carries, and Safari's lack of a share target were not checked on a phone. Cook 4 checks them before it builds.
- **No terms page was read, and no lawyer has read section 5.** The section states the risk as the brief gave it and as the planner understands it.
- **The cron trigger and the `scheduled` handler were not prototyped.** The plan assumes that one trigger in `worker/wrangler.jsonc` serves both environments and that the local Worker can fire the handler for a check. Cook 3 confirms both first.
- **The search address for Chordie in the site table is shorter than the one the probe sent.** Cook 1's live script confirms it.
- **The E-Chords page address is built from a guess at the site's rule for names.** It worked for one song. An artist with an accent or a "The" in front is untested.
- **The Chordie chart for the test song had chords on the first verse only.** One page cannot say whether that is common. If it is, GuitarTabs.cc goes first.
- **Nobody has seen the Grab button on a 360 px row.** The row is one wide button today. Cook 2 checks the sizes, and the owner judges the look on a phone.
