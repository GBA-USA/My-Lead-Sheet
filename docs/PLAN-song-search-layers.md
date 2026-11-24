# Plan: search a song, get a playable lead sheet

Written Nov 23, 2026 against `6e95630` (song search, PR 108, is merged). This plan changes no app code.

## Summary and landing order

The goal is one flow. A player types a song, taps a result, and holds a playable lead sheet that is saved on the phone and works offline.

Today a pick gives a sheet with a title, an artist, and a length. The chart is empty, the key says C, and the BPM is blank. The player then reads a hint, opens More, opens Edit, and taps Paste a sheet. The paste reader breaks on most charts copied from the web. Section "What was measured" lists the breaks.

After the five cooks below, a pick does this:

1. The app asks an open music database for the BPM and the key of that recording, for at most 2.5 seconds.
2. The app looks in a chord collection that ships inside the app. A match fills every section with its chords.
3. The app saves the song and opens the sheet.
4. A sheet with no chart shows three buttons: **Find chords on the web**, **Paste what you copied**, and **Learn this song**.
5. A paste of any common chart format becomes sections, chords over words, key, BPM, and capo. The player sees the real sheet before Save.

The cooks land in this order.

| Order | Cook | Layer | What the player gains | Waits for |
|---|---|---|---|---|
| 1 | `song-paste-import` | 1 | A pasted web chart becomes a correct sheet | nothing |
| 2 | `song-facts-lookup` | 2 | BPM and key arrive with the pick | owner decision D1 |
| 3 | `song-start-panel` | 1 and 3 | One tap from an empty sheet to web search, paste, or listen | cook 1 |
| 4 | `song-open-chords` | 2 | Chords arrive with the pick for about 900 older hits | owner decision D2, cook 2 |
| 5 | `song-learn-seam` | 3 | A listen fills the searched song, not a second song | learn cook L9, cook 3 |

Cooks 1 and 2 can run at the same time. They share two small seams. Each adds one line to `package.json`, and each adds the same `SongFacts` type block to `src/song-text.ts`. The cook that merges second keeps one copy. Cook 3 branches after cook 1 merges. Cook 4 branches after cook 2 merges, because both edit the function that builds a song from a pick. Cook 5 waits for the learn cook L9, which has not landed.

```text
song-paste-import ──► song-start-panel ──► song-learn-seam (also needs L9)
song-facts-lookup ──► song-open-chords
```

The order follows the measurements. Paste gives the whole chart for any song. The BPM lookup found a tempo for 12 of 15 test songs. The chord collection held 1 of the same 15. The brief listed BPM and open chords as one cook. This plan splits them, because they differ in value, in risk, and in the decision the owner must make.

## What was measured for this plan

Every number here comes from a run on Nov 23, 2026. Each run happened once. The test set is the 15 songs in `data/library.json`, which is the owner's taste and is small. Treat each count as a direction. The probe scripts were throwaway files outside the repo. Cook 2 and cook 4 each commit a script that repeats their measurement.

### The paste reader today

I ran `parseSheet` from `src/song-text.ts` on eight pasted charts. These inputs come out wrong.

| Pasted text | What `parseSheet` gives today |
|---|---|
| Header lines such as `Capo: 2nd fret`, `Key: G`, `Tempo: 120 bpm` | A made-up `Verse 1` that holds the header lines as words. No key, BPM, or capo is read. |
| ChordPro directives such as `{title: X}`, `{key: G}`, `{start_of_chorus}` | Each directive becomes a line of words. The chorus gets no heading. |
| `Intro: G D Em C` | One line of words under a made-up `Verse 1`. |
| A chord row with one odd token, such as `x2`, `C(add9)`, `G*`, `(D)`, or `F♯m` | The whole row becomes words, so every chord on the row is lost. |
| `G - D - Em - C (x2)` | Words. |
| Tab lines such as `B\|---0---3---\|` | A capital string name becomes a section heading. |
| `(Bridge)` | Words inside the section above. |

These inputs already work: `[Verse 1]`, `Verse 1:`, a chord row over a lyric row, inline `[G]` brackets, and bar rows that start with `|`.

### BPM and key from an open database

AcousticBrainz holds a BPM and a key for recordings, under the id that the song catalog returns. Two request shapes were tried.

| Shape | Songs with any answer |
|---|---|
| Reuse the 15 rows the search already listed, keep the rows with the same title, send one request | 13 of 15 |
| Ask the catalog again for title and artist, limit 25, then send one request | 12 of 15 |

The second shape was scored against the BPM and the key in `data/library.json`. BPM is the median of the answers. Key is the vote weighted by the database's own strength score.

| Field | Right | One tap away | Wrong | No answer |
|---|---|---|---|---|
| BPM, 10 songs that have a library tempo and an answer | 6 within 3 percent | 2 are exactly double | 2 | 3 of the 15 songs |
| Key, 12 songs with an answer | 7 | | 5 | 3 of the 15 songs |

What limits these numbers:

- The database stopped taking new recordings in 2022. A song released after that has no answer.
- The first shape did not check the artist, so a cover with the same title can vote. Cook 2 keeps rows that match both title and artist.
- Five requests failed during the second run, counted across both services. Each was retried up to three times. A missing answer can be a failed request.
- The two double readings are the known half-time case. The library says 76 and the database says 152.
- Three of the five wrong keys are near misses. Two name the fourth of the true key, and one names its relative major. The other two are far off.

The service answered with `Access-Control-Allow-Origin: *` and `X-RateLimit-Limit: 100` for a window of about 10 seconds. It needs no key.

### Open chord collections

| Collection | License, read from its own page | Songs | Size as app-ready JSON |
|---|---|---|---|
| McGill Billboard | CC0 | 739 distinct songs in 890 files, hits from 1958 to 1991 | 1.0 MB, 83 KB gzipped, from a prototype converter |
| Rock Corpus 2.1 | CC BY 4.0, commercial use allowed with credit | 200 songs, 1949 to 2002 | Source text is 60 KB, 17 KB gzipped |
| Both | | 926 distinct songs, 14 shared | About 100 KB gzipped, estimated |

One of the 15 library songs is in either collection. That song is Brown Eyed Girl, in Rock Corpus. Both collections hold chords, sections, key, and meter. Neither chord file holds words.

GetSongBPM answered `401` with `{"error":"API Key is missing."}` and `Access-Control-Allow-Origin: *`. Its terms page sits behind a bot check, so its terms in this plan are from memory.

## Changes to the brief, and why

The brief gave the planner room to reorder, split, and swap methods. Each change is listed with its reason. None touches the four fixed rules: legal, portability, offline, and no app code in this cook.

1. **Paste goes first, and open chords go fourth.** The brief asked for the fastest path to a playable sheet. Paste works for every song. The chord collections held 1 of 15 test songs.
2. **Layer 2 becomes two cooks.** `song-open-chords-bpm` is split into `song-facts-lookup` and `song-open-chords`. The first calls a live service and needs a yes from the owner on that service. The second ships data inside the app and needs a yes on two licenses. A hold on one decision must not hold the other cook.
3. **A fifth small cook is added, `song-start-panel`.** Smart paste alone still leaves the player three taps and a paragraph of instructions away from the paste button. The panel puts web search, paste, and listen on the empty sheet.
4. **AcousticBrainz is the BPM and key source, not GetSongBPM.** AcousticBrainz data is CC0. It needs no key, it allows requests from a browser, and it is looked up by the recording id that `src/song-search.ts` already holds. GetSongBPM needs an API key, which is a secret, so the phone cannot call it. The Worker would have to forward each request. From memory, GetSongBPM also requires a visible link back to its site. GetSongBPM stays as decision D3 for songs released after 2022.
5. **The UI flow tests use the repo's own Chrome driver, not Playwright.** `CLAUDE.md` says no new libraries. Every screen check in `scripts/` drives headless Chrome through `scripts/chrome.ts` and `scripts/app-page.ts`. The flows the brief asked for are all required. Only the tool differs.
6. **A pick still saves the song at once.** A draft that waits for Save was considered and rejected. The player leaves the app to copy a chart in the browser. A phone can unload the app during that visit, and an unsaved draft would be lost. A saved song survives, and the address `#/song/<id>` brings the player back to it.
7. **The lookups run before the save, with a short limit.** The song is written once, with everything that was found. A lookup that fills a saved song later cannot tell a key the player chose from the default `C`, so it could overwrite a choice.
8. **No second preview screen.** The song editor already draws the real sheet under the text box with `LeadSheet`. Smart paste opens that editor in a short layout with the preview on top. One save path stays.
9. **Find chords on the web is added beside Find lyrics on the web.** The brief describes pasting a chart copied from the guided web search. Today only a lyrics search exists. The new link is the same kind of general web search, opened in the player's own browser.
10. **A capo is shown as the chords sound.** The owner plays bass, and a bass has no capo. A chart that says capo 2 with a G shape sounds A. The paste preview raises the chords by the capo and offers one switch back to the shapes.
11. **Layer 3 builds no listening code.** The learn cooks own it. Cooks L3, L5, L8, and L9 have not landed. This plan fixes the seam between search and learn so that neither side copies the other's helpers.

### Things in the brief or the repo that look wrong

- `legal/TERMS-DRAFT.md` is not in the repo at `6e95630` or on any branch. This plan uses the rule as the brief states it. The file should be committed, so that a cook can read section 2.
- The cook briefs for the learn work say that lyrics never travel in a share. Today a song the player made is shared whole, words included. `content` in `src/band-library.tsx` sends `body`. Smart paste makes pasted words common. See decision D4.
- The song catalog and the new BPM service both see the phone's network address and the song asked for. The privacy page does not name either service. See decision D5.

## Decisions the owner must make

No cook needs an API key or any other secret under the recommended answers.

| Id | Decision | Recommended answer | What waits for it |
|---|---|---|---|
| D1 | May the phone ask AcousticBrainz for BPM and key? It is a free public service that MetaBrainz runs. The data is CC0. The phone sends recording ids and nothing about the player. | Yes | Cook 2 |
| D2 | May the app ship chord data from McGill Billboard (CC0) and Rock Corpus (CC BY 4.0)? Both are chords, sections, key, and meter for commercial songs, with no words. Rock Corpus needs a credit line, which this plan puts on each sheet built from it and on the app's credits. | Yes to both, after the owner checks them against section 2 of the terms draft | Cook 4 |
| D3 | Add GetSongBPM as a second BPM source for songs after 2022? It needs a sign-up, a key held as a Worker secret, a Worker route that forwards the request, and, from memory, a visible link to its site. | Not now. Decide after cook 2 has run on real songs for a week. | Nothing |
| D4 | A song the player made is shared whole, pasted words included. The learn briefs say words never travel in a share. Which rule holds for a pasted chart? | The owner decides before smart paste reaches players. No cook in this plan changes sharing. | Nothing in this plan |
| D5 | Should the privacy page name the song catalog and the BPM service? | Yes, one sentence each | A one-line follow-up, or one more owned file in cook 2 |
| D6 | A pasted chart with a capo shows the chords as they sound, with a switch to the shapes. | Yes. Cook 1 builds this default. A no flips one constant. | Nothing |
| D7 | A pick may wait up to 2.5 seconds for BPM and key before the sheet opens. | Yes. The number is one constant in cook 2. | Nothing |

D1 and D2 are the two answers the queue needs. Cook 1 and cook 3 can start with none.

## 1. End-to-end UX: from search to lead sheet

### The flow

There is one way to add a song by search. It starts in the **Find a song to add** box, which already sits on My Songs and in the New song editor.

1. **Type.** The box lists recordings from the song catalog, as it does today. A row whose song is in the shipped chord collection shows the words **Chords included**.
2. **Tap a row.** The row shows **Building your sheet** for at most 2.5 seconds. In that time the app does the three legal lookups:
   - The catalog row gives title, artist, and length. This is already built.
   - The shipped chord collection gives sections, chords, key, meter, and tempo, when it holds the song. The collection is inside the app, so this step uses no network.
   - The open database gives BPM and key for the recording, in one request.
3. **The sheet opens, already saved.** `addOwnSong` writes it to this phone's library. From here on the song works with no network.
4. **Finish the sheet.** A sheet with no words shows the start panel, which has three buttons:
   - **Find chords on the web** opens a general web search in the player's browser. **Find lyrics on the web** sits beside it.
   - **Paste what you copied** reads the clipboard and opens the editor with the pasted chart cleaned up and drawn as the real sheet. **Save** keeps it.
   - **Learn this song** opens the existing Learn chooser.
5. **Play.** Scroll, metronome, transpose, and setlists work as they do for any song.

The app fetches three things on its own: catalog facts, open chord data, and BPM and key. It never fetches words or a chord page. Words and web charts enter only when the player pastes them.

### One shape for what a source knows

Paste, the chord collection, and the BPM lookup all produce the same value. Cook 1 adds the type to `src/song-text.ts`, beside `SongMeta`.

```ts
/** What one source knows about a song. A missing field means the source does not know. */
export type SongFacts = {
	title?: string;
	artist?: string;
	keyRoot?: string;
	keyMode?: KeyMode;
	tempo?: number;
	timeSignature?: string;
	lengthSec?: number;
	capo?: number;
	sections?: ChartSection[];
	/** A credit the license asks for. It is stored in `Song.sourceNote`, which the sheet already draws. */
	credit?: string;
};
```

No field is added to `Song`. A capo is stored as words in `Song.keyNote`, which the sheet already draws.

Cook 2 adds `src/song-build.ts` with two pure functions. `mergeFacts(...sources)` takes each field from the first source that knows it, so the order of the arguments is the rule. `songFromFacts(facts)` returns the song that `addOwnSong` takes.

| Field | When a pick is built, the first source that knows it wins |
|---|---|
| Title, artist, length | The catalog row |
| Sections and chords | The chord collection |
| Key and meter | The chord collection, then the BPM service for key, then `C major` and `4/4` |
| Tempo | The chord collection, then the BPM service, then blank |

A paste into the editor follows one rule. A blank field is filled. A field the player has not touched in a new song is filled. Any other difference is shown as a chip that takes one tap, such as **Use G major**. The player's typed value is never replaced without a tap.

### What the player sees when something is missing

| Case | What happens |
|---|---|
| Offline when typing | The landed message and **Try again**. Nothing changes. |
| The BPM service is slow, down, or has no answer | The sheet opens after 2.5 seconds at most, with a blank BPM and key `C`. The Learn chooser still has tap tempo and listen, and both work offline. There is no retry button. A saved song does not keep its catalog id, and a retry seldom finds data that the first request did not. |
| The found BPM is double or half | The start panel and the paste preview show the other reading as a chip, from `tempoChoices` in `src/bpm-detect.ts`. |
| No chords in the collection | The start panel. This is the common case. |
| The clipboard cannot be read | The editor opens with the message the landed editor uses, **Paste your sheet into the box.** |
| The phone unloads the app while the player is in the browser | The song is already saved. The player returns to the same sheet. |
| Signed out | No change. Adding a song keeps the rule that `+ Add a song` uses today. |
| A second account on the same phone | No change. The song is one of this account's own songs, and the backup rules for own songs apply. |

### Where each part lives

| Part | File | Cook |
|---|---|---|
| Web search links for lyrics and chords | `src/song-search.ts` | landed, cook 3 adds chords |
| Paste reader | `src/song-paste.ts` | 1 |
| Editor paste, then its short layout | `src/song-editor.tsx` | 1, then 3 |
| BPM and key client | `src/song-facts.ts` | 2 |
| Build a song from a pick | `src/song-build.ts` | 2, then 4 |
| Start panel on the sheet | `src/song-start.tsx` | 3 |
| Chord collection and its reader | `data/open-charts.json`, `src/open-charts.ts` | 4 |
| Every outside address | `data/song-search.json` | 2 and 4 |

## 2. Layer 1: smart paste importer (`song-paste-import`)

### Design

`parseSheet` in `src/song-text.ts` stays the only reader of chart text, and the editor's text box stays the one editable copy of a chart. Smart paste is a step in front of them. A new pure function turns any pasted text into the chart text that `parseSheet` already reads, and returns the facts it found on the way.

```ts
// src/song-paste.ts
export type LeftOut = { count: number; what: "tab lines" | "lines above the first section" | "directives" };
export type Pasted = { facts: SongFacts; chart: string; leftOut: LeftOut[] };
export function readPaste(text: string): Pasted;
export function keyFromChords(sections: ChartSection[]): Pick<SongFacts, "keyRoot" | "keyMode"> | null;
```

`readPaste` applies these rules in order.

| Rule | Pasted | Result |
|---|---|---|
| Clean characters | `\r\n`, tabs, no-break spaces, zero-width characters, `♯`, `♭` | Plain text. `♯` becomes `#` and `♭` becomes `b`. |
| ChordPro facts | `{title:}`, `{t:}`, `{artist:}`, `{subtitle:}`, `{key:}`, `{tempo:}`, `{time:}`, `{capo:}` | A fact. The line leaves the chart. |
| ChordPro sections | `{start_of_chorus}`, `{soc}`, `{start_of_verse}`, `{sov}`, `{start_of_bridge}`, `{sob}`, and each `{end_of_...}` | A heading line, or a blank line for an end. |
| ChordPro comments | `{comment: Verse 2}`, `{c: Play softly}` | A heading when the text is a section name. A `Note:` line when it is not. Any other directive is left out and counted. |
| Header facts | `Key: G`, `Key of Em`, `Tempo: 120 bpm`, `BPM 96`, `Capo: 2nd fret`, `Capo 3`, `Time: 6/8` | A fact. The line leaves the chart. |
| Headings | `[Verse 1]`, `Verse 1:`, `(Bridge)`, `chorus`, `Chorus x2` | A heading in the library's style, such as `VERSE 1` and `CHORUS`. A repeat count becomes a `Note:` line. |
| Heading with chords | `Intro: G D Em C`, `[Intro] G D Em C` | The heading, then the chords as a row below it. |
| Chord spelling | See the next table | The stored spelling, at the same start column. |
| Chord row marks | `G - D - Em - C (x2)`, `G D Em C x2`, `G  D  (hold)` | The chord row, with the mark as a `Note:` line under it. |
| Tab blocks | `e\|--3--\|`, `B\|--0--\|`, and the lines that follow | Left out and counted. Never a heading. |
| Lines above the first section | A site's title line, `Tuning:`, a difficulty line | Left out and counted when the paste has chords or headings. A paste of words alone keeps every line. |

A chord row is a line where every token is a chord in any spelling below, or a row mark. One odd token no longer turns the row into words.

| Pasted chord | Stored as | Pasted chord | Stored as |
|---|---|---|---|
| `C(add9)` | `Cadd9` | `CM7`, `CΔ` | `Cmaj7` |
| `G*`, `(D)` | `G`, `D` | `C-7`, `Cmin7` | `Cm7` |
| `Dsus` | `Dsus4` | `C°`, `Co` | `Cdim` |
| `Cø`, `Cm7(b5)` | `Cm7b5` | `C+` | `Caug` |

Each stored spelling must pass the `CHORD` rule in `src/song-text.ts` and must transpose with `transposeChordSymbol` in `src/music.ts`. Where the two rules reject a real chord, such as `G6/9` or `E7#9`, the cook widens the rules in their one home. The cook does not add a second chord rule to `src/song-paste.ts`.

**Columns.** In a chord row over a lyric row, a respelled chord keeps its start column. A shorter spelling is padded with spaces. A longer spelling that would touch the next chord moves the later chords right by the same rule that `fromBrackets` uses, which adds spaces at a word gap in the lyric. This keeps top rule 1 of `CLAUDE.md`.

**Capo.** With `capo` found, `readPaste` raises every chord by the capo with `transposeChordSymbol`, and `Song.keyNote` becomes `Capo 2 for guitar`. A switch in the preview, **Show guitar shapes**, puts the pasted shapes back.

**Key.** A key in the header wins. With none, `keyFromChords` scores the 24 keys by how many chords belong to each, and gives extra weight to the first and the last chord. It returns null for a chart with no chords.

### The editor

- **Paste a sheet** runs `readPaste` on the clipboard text. The text box takes `chart`. The facts fill fields by the rule in section 1.
- A paste typed into an empty text box with the keyboard is cleaned the same way. A paste into a box that already has text is left as typed.
- A status line says what was found and what was left out, such as **Found key G, 120 bpm, capo 2. Left out 6 tab lines.**
- **Use it as pasted** puts the raw text in the box, for the case where the cleaning is wrong.
- After a paste, the editor scrolls the preview into view.
- The short layout, for a paste that starts on the sheet, belongs to cook 3. Its one caller is built there. In that layout the status line, the chips, and the preview are on top, **Save** and **Edit text** are below, and **Edit text** shows the full editor.

### Files

| File | Change |
|---|---|
| `src/song-paste.ts` | New. `readPaste`, `keyFromChords`. Pure, with no DOM and no network. |
| `src/song-text.ts` | Add `SongFacts`. Widen `CHORD` only where case 4 needs it. |
| `src/music.ts` | Only where a stored spelling fails to transpose. |
| `src/song-editor.tsx`, `src/song-editor.css` | The paste button, the status line, the chips, and the capo switch. |
| `scripts/check-song-paste.ts` | New. Every case below. |
| `package.json` | One line, `check:song-paste`. |

### Required test cases

Unit cases, in node with no browser. Every chart in the check is written for the check with made-up words.

1. Header facts are read and leave the chart, for each form in the rule table.
2. ChordPro facts, sections, and comments follow the rule table. An unknown directive is left out and counted.
3. Every heading form gives a library-style heading. A heading with chords gives the heading and a chord row.
4. Each pasted spelling gives its stored spelling. Each stored spelling passes `CHORD`, and comes back unchanged after it is raised two semitones and lowered two.
5. A chord row with row marks keeps its chords, and the mark becomes the note.
6. In a chord row over a lyric row, every chord starts over the same letter after the paste as before it. The case covers a spelling that shrinks, one that grows, and one that grows into its neighbor.
7. Tabs, no-break spaces, zero-width characters, `♯`, `♭`, and `\r\n` are cleaned.
8. A four-line bass tab and a six-line guitar tab are left out and counted. No tab line becomes a heading.
9. Lines above the first section are left out of a chart with chords, and kept in a paste of words alone.
10. A capo raises every chord by default, sets the note, and the switch gives the shapes back.
11. `keyFromChords` gives G major for `G D Em C`, A minor for `Am F C G`, E major for `E A B7`, and null for no chords.
12. A paste of words alone gives sections split at blank lines, and no facts.
13. `readPaste` is stable. Reading its own output gives the same chart.
14. `src/song-paste.ts` contains no `fetch`, `XMLHttpRequest`, `WebSocket`, or `import(`.

Screen cases, in headless Chrome through `scripts/chrome.ts`, at 360 px and 390 px.

15. In New song, **Paste a sheet** with a clipboard that holds a web-style chart fills Key and BPM, shows the status line, and draws `VERSE 1` and `CHORUS` in the preview.
16. Chords sit over their syllables in the preview and on the saved sheet. The case reuses the measurement in `scripts/chord-anchors.ts`.
17. On a song whose key is A minor, a pasted chart in G leaves the key alone and shows **Use G major**. One tap sets it.
18. The capo switch changes the chords in the preview.
19. **Use it as pasted** puts the raw text in the box.
20. With the clipboard refused, the editor says **Paste your sheet into the box.**, and a keyboard paste into the empty box is cleaned.
21. After **Save**, the sheet shows the chart. After a reload with the network off, it still does.
22. Every new control is at least 44 px tall and is not clipped at either width.

### Verification

- [ ] Unit. `npm run check:song-paste` prints cases 1 to 14 as `ok`. Commit 1 holds the cases alone, and each fails on that commit.
- [ ] Live. In the built app at 390 px, copy a chart with `Capo`, `[Chorus]`, and `C(add9)` from a text file, tap **Paste a sheet**, and tap **Save**. Pass when the saved sheet shows the section headings, the capo note, and each chord over the word it was pasted over.
- [ ] Perf. Metric: the time from the tap on **Paste a sheet** to the drawn preview for a 300-line chart, in Chrome at 4 times CPU slowdown. Probe: a timed case in `scripts/check-song-paste.ts`. Baseline: the same tap on trunk, measured first and written in the report. Fail above the baseline plus 100 ms.
- [ ] `check:new-song`, `check:song-search`, `check:chords`, and `check:music` pass with no edit to their scripts.

## 3. Layer 2: automatic BPM and key, and open chord-only data

### 3.1 BPM and key lookup (`song-facts-lookup`)

#### Sources compared

| Source | License and cost | Browser requests | Key or proxy | Limits | Verdict |
|---|---|---|---|---|---|
| AcousticBrainz | CC0, free. Measured Nov 23. | Allowed from any origin. Measured. | None | 100 requests in about 10 seconds for each address. Measured from the reply headers. No new recordings since 2022, and no promise that the service stays up. | Use it. |
| GetSongBPM | Free with a sign-up. From memory, a visible link to its site is required. | Allowed from any origin. Measured. | An API key. The key is a secret, so the Worker must forward each request. | From memory, about 3,000 requests an hour. | Decision D3, not now. |
| The song catalog itself, MusicBrainz | CC0 | Allowed, already in use | None | 1 request a second | It holds no BPM and no key. |
| Deezer, Spotify | Closed terms | Not usable from a browser, or closed to new apps. From memory. | Yes | | Rejected. Neither is open data. |
| A BPM table shipped in the app | CC0, built from the AcousticBrainz data dumps | None needed | None | The dumps are far larger than a cook can process in one sitting | A later cook, only when the live service fails often. See section 6. |
| Tap tempo and listen, `src/bpm-finder.tsx` | Already in the app | None | None | The player does the work | The offline fallback. Already built. |

#### Design

The search already lists up to 15 recordings. Many of them are the same song on other releases. Cook 2 uses that list and sends no second catalog request.

1. On a pick, keep the listed rows whose title and artist match the pick under `fold` from `src/search.ts`. Put the pick first. Keep at most 25, which is the service's limit for one request.
2. Send one request: `<recordingFacts>?recording_ids=<id>;<id>&features=rhythm.bpm;tonal.key_key;tonal.key_scale;tonal.key_strength`.
3. Tempo is the median `rhythm.bpm`, rounded, then passed through `fieldBpm` from `src/bpm-detect.ts`, so that it is a value the BPM field accepts.
4. Key is the `key_key` and `key_scale` pair with the largest sum of `key_strength`. `D#`, `G#`, and `A#` are respelled `Eb`, `Ab`, and `Bb`, because `KEY_ROOTS` in `src/song-text.ts` holds only those spellings, and the stored-song check drops a song with any other root.
5. The request has a 2.5 second limit and is aborted at the limit, as `catalogSearcher` aborts at 8 seconds. Offline, a non-200 reply, a body in the wrong shape, and a timeout all give empty facts. None of them shows an error. The pick goes on.

```ts
// src/song-facts.ts
export type FactsDeps = Pick<SearchDeps, "fetch" | "setTimeout" | "clearTimeout" | "online">;
/** BPM and key for the first recordings that have them. Empty when nothing is known or the service does not answer in time. */
export function songFacts(deps: FactsDeps, recordingIds: string[]): Promise<SongFacts>;

// src/song-build.ts
export function mergeFacts(...sources: SongFacts[]): SongFacts;
export function songFromFacts(facts: SongFacts): Omit<Song, "ref" | "id">;
```

`pick` in `src/song-search.tsx` becomes: guard against a second tap, show **Building your sheet** on the row, await `songFacts`, call `addOwnSong(songFromFacts(mergeFacts(found, fromCatalog)))`, then go to the song. `addCatalogSong` goes away. `songFromFacts` is its one replacement.

#### The config entry

`data/song-search.json` gains one key. `check:portable` scans `src/`, and the address is not there.

```json
{
	"lyricsSearch": "https://www.google.com/search?q=",
	"recordingSearch": "https://musicbrainz.org/ws/2/recording",
	"recordingFacts": "https://acousticbrainz.org/api/v1/low-level"
}
```

#### Files

| File | Change |
|---|---|
| `src/song-facts.ts` | New. The request, the reading of the reply, and the limit. Pure, with injected `fetch` and timers. |
| `src/song-build.ts` | New. `mergeFacts` and `songFromFacts`. |
| `src/song-text.ts` | The `SongFacts` type block alone, the same block that cook 1 adds. |
| `src/song-search.tsx`, `src/song-search.css` | `pick` awaits the facts. The row shows **Building your sheet**. |
| `data/song-search.json` | The `recordingFacts` key. |
| `scripts/check-song-facts.ts` | New. Every case below, with `fetch` stubbed. |
| `scripts/song-facts-live.ts` | New. Repeats the measurement in this plan against the live services and prints the table. It is a script a person runs, not a `check:*`. |
| `package.json` | One line, `check:song-facts`. |

#### Required test cases

1. The request goes to the `recordingFacts` address with the ids joined by `;` and the four features, and with at most 25 ids.
2. Only rows with the same title and artist as the pick are sent, and the pick is first. A cover by another artist is not sent.
3. Tempo is the rounded median. Three replies of 100, 102, and 180 give 102.
4. Key is the strongest pair. `D#` minor is stored as `Eb` minor. Every root the function can return is in `KEY_ROOTS`.
5. A reply with no entry for any id gives empty facts, and the song is saved with a blank BPM and key `C major`.
6. Offline, a 500 reply, a body that is not the expected shape, and a reply after 2.5 seconds each give empty facts. The request is aborted at the limit. No error text shows.
7. A second tap during **Building your sheet** adds no second song.
8. `mergeFacts` takes each field from the first source that knows it.
9. `songFromFacts` gives a song that the stored-song check in `src/storage.ts` keeps, for full facts and for empty facts.
10. Screen case at 360 px and 390 px. A pick with a stubbed service opens a sheet that shows the BPM and the key. A stubbed service that never answers opens the sheet within 3 seconds.
11. A scan shows no outside address in `src/song-facts.ts` or `src/song-build.ts`, and `npm run check:portable` passes.
12. `check:song-search` passes. Its case 8 expects a pick to open the sheet with title, artist, and length, and that stays true. The page stub in that check refuses and logs every host except the catalog, so the facts request fails at once there and gives empty facts. If a case that counts logged requests fails for that reason alone, the cook filters that count by address, changes nothing else in the script, and says so in the report.

#### Verification

- [ ] Unit. `npm run check:song-facts` prints cases 1 to 9 and 11 as `ok`, and each failed on the tests-only commit.
- [ ] Live. Run `node --experimental-strip-types scripts/song-facts-live.ts` once. Pass when at least 10 of the 15 library songs get an answer. In the built app, search a song from before 2020 and tap it. Pass when the sheet opens with a BPM.
- [ ] Perf. Metric: the time from the tap on a row to the open sheet. Probe: screen case 10 with the service stubbed at 0 ms, 1 second, and no answer. Baseline: the same tap on trunk, measured first. Fail when the stub with no answer opens the sheet later than 3 seconds, or when the 0 ms stub adds more than 200 ms to the baseline.
- [ ] The player-facing change, the wait on the row, is reviewed by the owner before merge.

### 3.2 Open chord-only datasets (`song-open-chords`)

#### Collections compared

| Collection | License | Songs | Words inside? | Verdict |
|---|---|---|---|---|
| McGill Billboard | CC0. Read from its page on Nov 23. The authors ask for a citation. | 739 distinct, US chart hits from 1958 to 1991 | No. Chords, sections, meter, tonic, and times. | Ship it. |
| Rock Corpus 2.1 | CC BY 4.0. Read from its page on Nov 23. Commercial use is allowed with credit. | 200, from a magazine's list of top songs, 1949 to 2002 | Not in the harmony files. The same archive has melody files, and the site has a lyrics page. The build reads neither. | Ship the harmony files, second. |
| Chordonomicon | Stated as open. From memory. | About 666,000 | No | Rejected. It was collected from a chord site, which the legal rule forbids as a source. It also has no titles. |
| Hooktheory | Closed terms | Large | No | Rejected. Not open data. |
| Isophonics, RWC, Robbie Williams, JAAH | Research or non-commercial terms. From memory. | Under 400 together | No | Rejected until someone reads each license and finds it open for commercial use. |
| Any chord or tab site | Closed | | Yes | Forbidden by the legal rule. |

#### Sources

- McGill Billboard: `https://ddmal.ca/research/The_McGill_Billboard_Project_(Chord_Analysis_Dataset)/`. Take the index file and the `salami_chords` archive. The older address under `ddmal.music.mcgill.ca` answers 404.
- Rock Corpus: `http://rockcorpus.midside.com/`. Take `rock_corpus_v2-1.zip`. Use the folder `rs200_harmony`, and `timing_data` for tempo. Each song has two harmony files, one from each author. Use the `_dt` files, and name the choice in the report.

#### Coverage, stated plainly

The two shipped collections hold 926 distinct songs. One of the 15 library songs is among them. A player who asks for a US hit from before 1992 has a fair chance. A player who asks for a song from after 2002 has none. My guess is under 1 in 10 for a mixed cover-band set. Cook 4 commits `scripts/open-charts-coverage.ts`, which prints the hit count for any list of titles and artists, so the owner can measure a real setlist.

A hit is still worth building. The sheet opens with every section and every chord in song order, which is what a bass player reads. It costs no network and no tap.

#### Ship in the app, do not fetch

| Option | Result |
|---|---|
| Fetch from the sources when a player picks | Rejected. The sources are a file-sharing link and a university page. Neither is a service. |
| Ship as a separate chunk, loaded with `import()` | Chosen. The prototype put all 739 Billboard charts in 83 KB gzipped. The service worker already caches every build file, so the lookup works offline. The main bundle does not grow. |

#### Design

A build script converts the two collections once. Its output is committed.

```ts
// data/open-charts.json is an array of these
type OpenChart = {
	title: string;
	artist: string;
	keyRoot: string;
	keyMode: KeyMode;
	timeSignature: string;
	tempo: number | null;
	from: "billboard" | "rock-corpus";
	sections: [heading: string, barRows: string[]][];
};

// src/open-charts.ts
/** The shipped chart for this song as facts, or null. The first call loads the chunk. */
export function openChart(title: string, artist: string): Promise<SongFacts | null>;
```

- **Match.** `fold` from `src/search.ts` on title and on artist, after a leading `the` and any text in parentheses are dropped. This is a lookup in public data. It is not a sharing or privacy decision, so top rule 5 of `CLAUDE.md` does not apply.
- **Rows.** Each phrase becomes one `bars` line such as `| D C | G | D C | G |`, in the style of the bar rows in `data/library.json`. Sections are written out in song order with no repeat signs, because the sheet scrolls in song order.
- **Billboard chords.** `A:min7/b3` becomes `Am7/C`. The bass after the slash is a scale degree in the source and a note name in the app. A bass player needs that note.
- **Billboard key and tempo.** `# tonic:` gives the root. The mode is minor when the tonic chord is minor more often than major. Tempo is bars times beats, divided by the time between the first and the last phrase.
- **Rock Corpus chords.** The source is a small grammar of Roman numerals with a key, such as `S: [G] $In $Vr`. The script expands the grammar and turns each numeral into a chord in that key. The names `In`, `Vr`, `Ch`, `Br`, and `Solo` become `INTRO`, `VERSE`, `CHORUS`, `BRIDGE`, and `SOLO`.
- **Credit.** A Rock Corpus song gets `credit: "Chords from the Rock Corpus by Trevor de Clercq and David Temperley, CC BY 4.0."`. A Billboard song gets `credit: "Chords from the McGill Billboard collection."`. The sheet already draws `Song.sourceNote`. A paste that replaces the whole chart clears the credit.
- **Where the files live.** `data/open-charts.json` stays in `data/`. `check:portable` scans `src/` and `public/` for owner names, and a title or an artist in this file could match that scan one day.
- **In the search list.** A row whose song is in the collection shows **Chords included**. The chunk loads when the search box first takes focus.

#### Files

| File | Change |
|---|---|
| `scripts/build-open-charts.ts` | New. Reads the unpacked archives from a folder given as an argument, and writes `data/open-charts.json`. It stops with an error on any chord that the `CHORD` rule rejects. |
| `data/open-charts-sources.json` | New. The download addresses, the license of each, and the citation text. |
| `data/open-charts.json` | New. Built, then committed. About 1.2 MB. |
| `src/open-charts.ts` | New. `openChart`, with the chunk behind `import()`. |
| `src/song-build.ts`, `src/song-search.tsx` | `openChart` joins the merge. The row mark. |
| `scripts/check-open-charts.ts`, `scripts/open-charts-coverage.ts` | New. |
| `package.json` | One line, `check:open-charts`. |

No `check:portable` entry is needed, because no address is used at run time. The download addresses are in `data/`, for the person who rebuilds the file.

#### Required test cases

1. The converter turns a small Billboard fixture into the expected sections, key, meter, and tempo. The fixture is written for the check.
2. Slash chords come out as note names: `A:min7/b3` gives `Am7/C`, and `C:maj/5` gives `C/G`.
3. The converter turns a small Rock Corpus fixture, with a nested `$` reference and a `*2` repeat, into the expected chords in the stated key.
4. Every chord in `data/open-charts.json` passes the `CHORD` rule and transposes two semitones up and back.
5. No entry in `data/open-charts.json` has a `lyrics` key, and every row starts with `|`. The script opens no file outside the two harmony folders.
6. `openChart` finds a song when the typed title differs in case, in punctuation, in a leading `the`, and in text in parentheses. It returns null for a song that is not there.
7. A pick of a shipped song saves a sheet with its sections, key, meter, tempo, and credit. The chart facts win over the BPM service.
8. A pick of a song that is not shipped behaves as cook 2 left it.
9. Screen case at 360 px and 390 px. The row says **Chords included**. The sheet shows the sections and the credit line. After a reload with the network off, the saved sheet still opens with its chart.
10. The main bundle is no more than 2 KB larger than on trunk. The chart chunk is under 150 KB gzipped.
11. Every song saved from the collection is kept by the stored-song check in `src/storage.ts`.

#### Verification

- [ ] Unit. `npm run check:open-charts` prints cases 1 to 8 and 11 as `ok`.
- [ ] Live. In the built app, search `Sweet Home Alabama` and tap the row marked **Chords included**. Pass when the sheet opens with `INTRO`, `VERSE`, and `CHORUS` bar rows and the credit line, and the Nashville view shows numbers.
- [ ] Perf. Metric: gzipped bytes of the main bundle and of the chart chunk, read from the `vite build` report. Baseline: trunk, measured first. One build at `6e95630` on Nov 23 reported 214.43 kB gzipped for the main bundle. Fail by case 10.
- [ ] The owner has answered D2, and the report quotes the two license lines that the script read.

## 4. Layer 3: handoff to learn-by-listen

### What exists and what does not

Learn this song exists. It opens from the caret beside the Scroll pill, through `ScrollSheet` and `LearnChooser`. The listen in `src/learn-song.tsx` hears tempo, bars, and length. It names chords only from the chords the chart already has, because `heardBars` in `src/learn-chords.ts` takes the chart's chords as its list of candidates. I read this from the code and did not run it.

So a listen on a sheet with no chart can set the BPM and the length today, and cannot build chords. Chords heard without a chart are learn cook L3. Words lined up in time are L8. A new song from a listen is L9. The learn cooks merged so far are LT-A, L0, and L2.

This layer therefore builds no listening code. It fixes four seams, so that search and learn share one copy of everything.

### Seam 1. One entry to learn

The start panel's **Learn this song** button opens the same `LearnChooser` that the Scroll caret opens. It does not mount a second chooser.

- `ScrollSheet` in `src/scroll-sheet.tsx` gains a prop that opens it on the chooser.
- The `scrollSheet` state in `src/App.tsx` changes from a boolean to `false | "speed" | "learn"`.
- `SongBody` in `src/library-lists.tsx` passes the panel one callback.

Cook 3 builds this seam. `src/App.tsx` has 487 lines, and `check:one-copy` fails it above 500. The change is two edited lines and at most two new ones.

### Seam 2. One home for each helper

| Helper | Home | Who imports it |
|---|---|---|
| `lyricsSearchUrl`, and the new `chordsSearchUrl` | `src/song-search.ts` | The start panel, the song editor, and the Words step of L9 |
| The link that opens a web search | One component in `src/song-search.tsx`, with the label and the address as props | The same three |
| `readPaste` | `src/song-paste.ts` | The song editor, and the Words step of L9 |
| `LearnChooser` | `src/learn-chooser.tsx` | `ScrollSheet` alone |
| `mergeFacts`, `songFromFacts` | `src/song-build.ts` | The search pick, and the save path of L9 |

Cook 3 adds one row for each helper to `scripts/check-one-copy.ts`, in the form its other rows use. A second copy of any of them then fails `check:one-copy`.

### Seam 3. What the chart gives the listen

A sheet built by paste or from the chord collection has section headings and chords. Those are the two things the landed listen needs. `chartChords` reads the chords, and `placeHeadings` places the headings. So this order already works with no new code: search, then paste or the shipped chords, then Learn this song to time the sections to the recording. The start panel's text says this once the sheet has a chart.

The words step of L9 lays pasted words over heard chords. When the song already has chords from the collection and the player pastes words alone, that same step is what puts each chord over its syllable. Until L8 and L9 land, a paste of words alone goes under the bar rows, and the editor's status line says so.

### Seam 4. A listen fills the searched song

The L9 brief saves a new song named after the audio file. A player who came from search already has a saved song with the right title, artist, and length. Without a rule, the listen would leave two songs. Cook 5 changes the save path of L9 as follows.

- When Learn this song is opened on a song that `madeHere` accepts and that has no chart, **Save** calls `replaceOwnSong` on that song. It does not call `addOwnSong`.
- The heard key and tempo fill the song by the rule of section 1. A blank field is filled, and any other difference is a chip.
- Title, artist, and length stay as the search set them.
- A song with a chart keeps the L4 flow. A listen with no song open keeps the L9 flow.

Cook 5 cannot start before L9 lands. Its brief names the files of L9 as they are described in the L9 brief. The cook follows the tree it finds.

### What the start panel says before the learn cooks land

The panel must not promise chords from a listen. Its listen line reads **Listen to set the tempo and the length.** Cook 5 changes the line when the listen can build a chart.

### Required test cases

Cook 3 owns cases 1 to 4. Cook 5 owns cases 5 to 8.

1. A tap on **Learn this song** in the start panel opens the dialog titled Learn this song, and the page holds one such dialog.
2. The chooser opened from the panel sets the BPM through its tempo row, and the sheet shows the new BPM.
3. `check:one-copy` fails when `lyricsSearchUrl`, `readPaste`, or `LearnChooser` is defined in a second file. The cook proves each row once by planting a copy, and pastes the failing line into the report.
4. On a sheet with a pasted chart, the landed listen review lists that chart's headings. The stand-in listen from `scripts/check-learn.ts` drives it.
5. A listen saved on a searched song with no chart leaves one song with that title. The count of own songs does not change.
6. Title, artist, and length are unchanged after that save. A blank BPM is filled.
7. A listen saved with no song open still adds one song, as L9 specifies.
8. The Words step calls `readPaste`. A pasted `[Chorus]` block is labeled `CHORUS`, and a pasted `Capo 2` line does not become words.

### Verification

- [ ] Unit. The named cases pass in `scripts/check-song-start.ts` for cook 3 and in the L9 check for cook 5.
- [ ] Live. On a searched song with no chart, tap **Learn this song**, choose the tempo row, and tap along. Pass when the sheet shows the tapped BPM and My Songs holds one copy of the song.
- [ ] Perf. No timed path changes in either cook, so there is no number to hold. The cook says so in the report, and `check:learn` passes unchanged.

## 5. Priority order and copy-ready cook briefs

### The order, and why

| Order | Cook | Size | Why it sits here |
|---|---|---|---|
| 1 | `song-paste-import` | Medium | It gives a whole chart for any song. It needs no network and no decision. Every later cook reuses its `SongFacts` type. |
| 2 | `song-facts-lookup` | Small | It fills BPM for most songs with one request. It runs beside cook 1. The two share one line each in `package.json` and one identical type block. |
| 3 | `song-start-panel` | Small | It removes the three taps between the empty sheet and the paste. It needs the paste entry from cook 1. |
| 4 | `song-open-chords` | Medium | It is the largest build for the smallest share of songs. It edits `src/song-build.ts`, which cook 2 creates. |
| 5 | `song-learn-seam` | Small | It cannot start before L9. |

After cooks 1 and 3, the owner has the whole loop on a phone: search, tap, find the chart on the web, paste, save, play offline. Cook 2 adds the BPM. Queue cooks 1 and 2 now, and cook 3 as soon as cook 1 merges.

### Rules every brief below inherits

Each brief is ready to copy into the queue. The queue's own header, laptop notes, and report rules go around it unchanged.

- Read `CLAUDE.md` first. Stay inside the owned files. Add one `check:*` line to `package.json` and nothing else there.
- Commit 1 holds the tests alone, and each new case fails on it. Later commits do not weaken a case. A case that is wrong goes in `QUESTIONS.md`, which is a shared log, so add the entry at the top.
- The required test cases are the numbered cases in the named section of `docs/PLAN-song-search-layers.md`. Each case needs a named line that prints `ok` or `FAIL`.
- No new libraries. Screen cases use `scripts/chrome.ts` and `scripts/app-page.ts`, as `scripts/check-song-search.ts` does. Write paths with `fileURLToPath` and `path.join`, and read the browser from `CHROME`.
- The app never fetches, stores, or shows words or chord pages from a site. Words and web charts enter only by the player's paste. Every chart in a check is written for the check, with made-up words.
- No outside address in `src/`. An address goes in `data/song-search.json`. `npm run check:portable` must pass.
- No internal names on a screen. Do not show a service name, a collection's file name, or a cook id.
- Every new control is styled in the cook's CSS file, is at least 44 px tall, and is checked at 360 px and 390 px.
- Handle the list in `CLAUDE.md` under "Must handle in every feature". For these cooks that means: signed out keeps the rule of `+ Add a song`, a second account on the phone sees none of the first account's songs, offline and slow networks give a clear message or a silent fallback and never a duplicate song, and every empty and error state has words.
- Before the report: `npm run build`, the cook's own check, `check:song-search`, `check:new-song`, `check:chords`, `check:one-copy`, and `check:portable`.

### 5.1 Brief: `song-paste-import`

```text
## HANDOFF
GOAL: A player pastes a chart copied from the web, in any common format, and gets a correct lead sheet: sections, chords over their words, key, BPM and capo, shown as the real sheet before Save.
DECIDED: one cook, one branch, cook/song-paste-import off mls-int-20261113; the paste reader is a step in front of parseSheet, which stays the only reader of chart text; the editor's own preview is the preview; a capo shows chords as they sound (plan decision D6).
REJECTED: a second chart parser; a second preview screen; a second chord rule in src/song-paste.ts; any network call; any site-specific cleaning that names a site; new libraries; edits outside the owned files; edits to earlier check scripts.
DONE MEANS: cases 1 to 22 of plan section 2 each have a named check line that failed on the tests-only commit and passes now; the four boxes under "Verification" in section 2 are ticked with their evidence in the report; npm run build is green.
SOURCE: docs/PLAN-song-search-layers.md sections 1 and 2.
NEEDS OWNER: none to start. Decision D4 (pasted words in a share) is open and is not this cook's to change.

# Smart paste importer

## What the player can do
1. In New song or Edit song, tap Paste a sheet. A chart copied from a web page comes in clean: header lines such as Key, Tempo and Capo fill the fields, section names become headings, odd chord spellings are kept as chords, tab lines and site text above the first section are left out.
2. See a status line that says what was found and what was left out, and the real sheet drawn from the result.
3. Tap a chip to take a key or BPM that differs from the song's. Tap Show guitar shapes to undo the capo. Tap Use it as pasted when the cleaning is wrong.
4. Tap Save. The song is in the library and opens with no network.

## Owned files
src/song-paste.ts (new: readPaste, keyFromChords; pure), src/song-text.ts (add the SongFacts type; widen CHORD only where case 4 needs it), src/music.ts (only where a stored chord spelling fails to transpose), src/song-editor.tsx and src/song-editor.css (the paste button, the status line, the chips, the capo switch), scripts/check-song-paste.ts (new), package.json (one line).

Do not touch: src/App.tsx, src/sheet.tsx, src/song-search.ts, src/song-search.tsx, src/library-lists.tsx, src/learn-*.ts and .tsx, worker files, earlier check scripts.

## Shapes to freeze
SongFacts, Pasted and LeftOut exactly as plan sections 1 and 2 give them. Cooks 2, 3, 4 and 5 import them.
Keep the code that applies a Pasted value to the form in one function inside src/song-editor.tsx. Cook 3 calls it when the editor opens with a pasted text.

## Empty and error states, and the wired flow
An empty clipboard or a refused read says "Paste your sheet into the box." and puts the cursor in the box, as today. A paste with no chords and no headings is taken as words. A paste that leaves nothing after cleaning keeps the raw text in the box and says "Nothing here looks like a chart. It is in the box as pasted." A storage failure on Save keeps the editor open with the landed message. The button label stays "Paste a sheet", which check:new-song reads.
Flow: My Songs, + Add a song or More then Edit, Paste a sheet, read the preview, Save, the sheet opens.

## Hints
- Worth running today's parseSheet on your fixtures first. The table "The paste reader today" in the plan lists seven inputs that fail, and each one is a case that must fail on commit 1. High.
- Worth keeping readPaste a text-to-text step, because the text box must stay the one editable copy of the chart. High.
- Worth one table of [pasted, stored] chord spellings that drives case 4 and the reader, so a new spelling is one row. High.
- Worth reusing the spacing rule of fromBrackets for a spelling that grows, because a chord that moves off its syllable breaks top rule 1. High.
- Worth calling readPaste only on a paste and never on a key press, because parseSheet already runs on every key. Medium.
- React 19 runs click effects after the tap. Read the clipboard inside the click handler. Medium.
```

### 5.2 Brief: `song-facts-lookup`

```text
## HANDOFF
GOAL: When a player taps a search result, the new sheet opens with the song's BPM and key already filled in, found in one request to an open music database, and the tap never waits more than 2.5 seconds for it.
DECIDED: one cook, one branch, cook/song-facts-lookup off mls-int-20261113; AcousticBrainz is the source (plan decision D1); the recording ids come from the rows the search already listed, with no second catalog request; the song is written once, after the lookup; the limit is one constant (plan decision D7).
REJECTED: GetSongBPM and any source that needs a key; a Worker route; a second catalog client; a lookup that changes a saved song later; an error message for a failed lookup; a retry button; new libraries; edits outside the owned files.
DONE MEANS: cases 1 to 12 of plan section 3.1 each have a named check line that failed on the tests-only commit and passes now; the four boxes under "Verification" in section 3.1 are ticked with their evidence in the report; scripts/song-facts-live.ts was run once and its table is in the report; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-song-search-layers.md sections 1 and 3.1, and the measurements in "What was measured for this plan".
NEEDS OWNER: D1 must be yes before this cook starts. D5 (a privacy page sentence) is open; if it is yes, src/data-kinds.ts or the file that holds the privacy text joins the owned files.

# BPM and key with the pick

## What the player can do
1. Tap a search result. The row says Building your sheet for a moment.
2. The sheet opens with title, artist, length, and, when the database knows the recording, BPM and key.
3. With no answer, or with no network to the database, the sheet opens the same way with a blank BPM. Nothing on the screen says that a lookup failed.

## Owned files
src/song-facts.ts (new: the request, the reply reader, the limit; injected fetch and timers), src/song-build.ts (new: mergeFacts, songFromFacts), src/song-search.tsx and src/song-search.css (pick awaits the facts; the Building your sheet state on the row; addCatalogSong is replaced by songFromFacts), data/song-search.json (the recordingFacts key), scripts/check-song-facts.ts (new), scripts/song-facts-live.ts (new, a script a person runs), package.json (one line).
scripts/check-song-search.ts: only to filter a request count by address, and only if a count case fails because its page stub logs the new host. Say so in the report.

src/song-text.ts: only the SongFacts type block, placed after SongMeta, exactly as plan section 1 gives it. Cook 1 adds the same block. The cook that merges second merges mls-int first and keeps one copy.

Do not touch: src/song-search.ts (import SearchDeps; do not edit), src/search.ts (import fold; do not edit), src/App.tsx, src/song-editor.tsx, worker files.

## Empty and error states, and the wired flow
Offline, a reply that is not 200, a body in the wrong shape, and no reply in 2.5 seconds all give empty facts, and the request is aborted. A second tap while a row is building does nothing. A storage failure keeps the landed message. A pick of a song the player already has still asks first, before any request.
Flow: My Songs, type a title, tap a row, Building your sheet, the sheet opens with BPM and key.

## Hints
- Worth copying the shape of catalogSearcher: injected fetch, clock and timers, so no test reaches the live service. High.
- Worth passing the tempo through fieldBpm and the root through the KEY_ROOTS spelling, because the stored-song check drops a song with a root it does not know. High.
- Worth matching rows on title and artist, because the plan's first measurement let a cover vote. High.
- Worth keeping scripts/song-facts-live.ts close to scripts/song-search-live.ts. Keep live runs few. The catalog answers 503 often. Medium.
- A double or half BPM is expected for about one song in five. Do not try to fix it here. Cook 3 shows the other reading as a chip. Medium.
```

### 5.3 Brief: `song-start-panel`

```text
## HANDOFF
GOAL: A sheet with no words shows one panel with the three ways to finish it: find the chart on the web, paste what was copied, or learn the song by listening. Each is one tap, and a paste from the panel shows the real sheet before Save.
DECIDED: one cook, one branch, cook/song-start-panel off mls-int-20261113 after song-paste-import has merged; the panel replaces NoWordsYet; a pick still saves the song at once; the Learn button opens the one LearnChooser in ScrollSheet; the short paste layout is the song editor with its fields folded away.
REJECTED: a draft song that waits for Save; a second Learn chooser; a second preview screen; a retry button for BPM; a line that promises chords from a listen; a new localStorage key; new libraries; edits outside the owned files.
DONE MEANS: cases S1 to S11 below each have a named check line that failed on the tests-only commit and passes now; the boxes under "Verification" in plan section 4 that name cook 3 are ticked; src/App.tsx is at most 500 lines; npm run build is green.
SOURCE: docs/PLAN-song-search-layers.md sections 1, 2 and 4.
NEEDS OWNER: none to start. The panel changes what a new sheet looks like, so the owner reviews it on a phone before merge.

# The start panel on a sheet with no words

## What the player can do
1. Open a song they made that has no chart. The panel says No words yet, and shows Find chords on the web, Find lyrics on the web, Paste what you copied, and Learn this song.
2. Tap Find chords on the web. Their browser opens a general web search for "<title>" "<artist>" chords.
3. Come back and tap Paste what you copied. The editor opens in the short layout: what was found, the chips, the real sheet, Save, and Edit text.
4. On a sheet with a BPM, tap the chip for the half or double reading when the tempo feels wrong.
5. On a sheet with chords and no words, see one short line with Find lyrics on the web and Paste what you copied.

## Owned files
src/song-start.tsx (new: the panel), src/song-search.ts (add chordsSearchUrl beside lyricsSearchUrl), src/song-search.tsx (one link component for both searches; NoWordsYet moves out), src/song-search.css, src/library-lists.tsx (mount the panel in SongBody and pass its callbacks), src/song-editor.tsx and src/song-editor.css (the SongEdit variant { paste: string } and the short layout), src/scroll-sheet.tsx (a prop that opens it on the chooser), src/App.tsx (the scrollSheet state becomes false, "speed" or "learn"; SongBody gets its callbacks; at most two new lines), scripts/check-one-copy.ts (new rows only), scripts/check-song-start.ts (new), package.json (one line).

Do not touch: src/song-paste.ts, src/song-facts.ts, src/song-build.ts, src/learn-song.tsx, src/learn-chooser.tsx, src/sheet.tsx, worker files, earlier check scripts except the new rows in check-one-copy.

## Required test cases
S1. chordsSearchUrl(title, artist) is the web search address from data/song-search.json plus the encoded text "<title>" "<artist>" chords. A blank field is left out.
S2. A song the player made with no chart shows the panel with the words No words yet and the four controls. A built-in song and a copy from a band show no panel.
S3. Find chords on the web is a link to the address of S1 that opens in a new tab. The page sends no request when it is tapped.
S4. Paste what you copied, with a chart on the clipboard, opens the short layout with the status line and the drawn headings. Save shows the chart on the sheet, and the panel is gone.
S5. With the clipboard refused, the full editor opens and says Paste your sheet into the box.
S6. Edit text shows the full editor with the cleaned chart in the box.
S7. A song at 152 BPM shows a chip for 76. One tap sets 76 on the sheet and on the metronome.
S8. A song with bar rows and no words shows the short line. A paste of words alone offers Add below the chart, and the bar rows stay.
S9. Cases 1 to 4 of plan section 4.
S10. At 360 px and 390 px every control in the panel and in the short layout is at least 44 px tall and is not clipped.
S11. check:song-search passes with no edit to its script, case 1e included, and check:one-copy passes with src/App.tsx at 500 lines or fewer.

## Empty and error states, and the wired flow
A song with no title and no artist shows the panel without the two web links. A paste that leaves nothing after cleaning opens the full editor with the raw text. Cancel in the short layout changes nothing on the song. A storage failure on Save keeps the layout open with the landed message. Signed out, a player still sees the panel on a song they made, and every control works without the server.
Flow: search, tap a row, the sheet opens, Find chords on the web, copy, come back, Paste what you copied, Save, play.

## Hints
- Worth reading the clipboard inside the tap on Paste what you copied and passing the text to the editor, because Safari allows the read only inside the tap. High.
- Worth keeping the phrase No words yet in the panel's first line, because case 1e of check:song-search reads it. High.
- Worth sending the BPM chip through the handler the Learn chooser's tempo row already uses, so the metronome follows. High.
- Worth one link component with a label and an address, because the L9 Words step will import it too. Medium.
- Count the lines of src/App.tsx before the first edit. It has 487 and the limit is 500. Medium.
```

### 5.4 Brief: `song-open-chords`

```text
## HANDOFF
GOAL: When a player taps a search result for a song that is in the app's shipped chord collection, the sheet opens with every section and every chord in song order, with its key, meter and tempo, and with the credit the license asks for. The lookup uses no network.
DECIDED: one cook, one branch, cook/song-open-chords off mls-int-20261113 after song-facts-lookup has merged; the two sources are McGill Billboard (CC0) and the harmony files of Rock Corpus 2.1 (CC BY 4.0) (plan decision D2); the data ships as a separate chunk loaded with import(); the built file is committed in data/; Billboard lands first and Rock Corpus second, as separate commits.
REJECTED: any fetch of chord data at run time; any collection gathered from a chord site; any collection whose license was not read and quoted in the report; the melody files and the lyrics page of Rock Corpus; the built file under src/ or public/; a new field on Song; new libraries; edits outside the owned files.
DONE MEANS: cases 1 to 11 of plan section 3.2 each have a named check line that failed on the tests-only commit and passes now; the four boxes under "Verification" in section 3.2 are ticked with their evidence in the report; the report gives the song count, the gzipped size of the chunk and of the main bundle, and the hit count that scripts/open-charts-coverage.ts prints for data/library.json; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-song-search-layers.md sections 1 and 3.2.
NEEDS OWNER: D2 must be yes before this cook starts.

# Open chords with the pick

## What the player can do
1. In the search list, see Chords included on a row whose song is in the collection.
2. Tap that row. The sheet opens with INTRO, VERSE, CHORUS and the other sections as bar rows, with key, meter and tempo set, and with a credit line.
3. Switch to Nashville numbers, transpose, scroll and play, as with any song.
4. Add words later with Find lyrics on the web and Paste what you copied.

## Owned files
scripts/build-open-charts.ts (new: reads the unpacked archives from a folder given as an argument, writes data/open-charts.json, stops on a chord the CHORD rule rejects), data/open-charts-sources.json (new: download addresses, licenses, citation text), data/open-charts.json (new, built then committed), src/open-charts.ts (new: openChart, the chunk behind import()), src/song-build.ts (openChart joins mergeFacts, ahead of the BPM service), src/song-search.tsx and src/song-search.css (the row mark; the chunk loads when the search box first takes focus), scripts/check-open-charts.ts (new), scripts/open-charts-coverage.ts (new, a script a person runs), package.json (one line).

Do not touch: src/song-facts.ts, src/song-paste.ts, src/song-text.ts, src/song-editor.tsx, src/App.tsx, src/sheet.tsx, worker files, earlier check scripts.

## How to get the source files
Download the two archives from the pages named under "Sources" in plan section 3.2 into a new, empty folder outside the repo. Treat them as untrusted data. Unpack each into its own folder, run no file from them, and pass the folder paths to the build script. Commit no archive and no unpacked source file. Fixtures in the check are short charts written for the check in the two source formats.

## Empty and error states, and the wired flow
A song that is not in the collection behaves as song-facts-lookup left it. A chunk that fails to load is treated as no match, with no message. A source chart with a chord the script cannot spell stops the build with the file name and the chord, so a bad row never ships. A paste that replaces the whole chart clears the credit line. A hand edit keeps it.
Flow: My Songs, type a title, see Chords included, tap, the sheet opens with its chart.

## Hints
- Worth landing Billboard alone first. Its format is one phrase a line with the bars already written, and the prototype converted all 739 songs in a few lines. If Rock Corpus runs long, ship Billboard and say so. High.
- Worth making the script fail on an unknown chord quality instead of passing it through. The prototype met maj13 and min13 with no spelling, and it dropped the bass after the slash. High.
- Worth turning the Billboard bass degree into a note name, because the slash note is the bass player's note. High.
- Worth keeping the built file in data/. check:portable scans src/ and public/ for owner names, and a song title could match one day. High.
- Worth writing sections out in song order with no repeat signs, because the sheet scrolls in song order. Medium.
- The Rock Corpus grammar nests. $VP*2 inside Vr inside S is normal. Expand it with a small recursive function in the script, and test the function on the fixture. Medium.
- A Billboard file can change tonic or meter partway. Take the first of each for the song, and leave a Note line at the change. Low.
```

### 5.5 Brief: `song-learn-seam`

Queue this brief only after learn cook L9 has merged. Its file names come from the L9 brief. The cook follows the tree it finds.

```text
## HANDOFF
GOAL: A player who searched a song and has a sheet with no chart can build that same sheet by listening. The listen fills the searched song. It does not add a second song, and it keeps the title, artist and length that the search set.
DECIDED: one cook, one branch, cook/song-learn-seam off mls-int-20261113 after L9 and song-start-panel have merged; a listen opened on a song the player made with no chart saves with replaceOwnSong; the Words step cleans pasted words with readPaste; the start panel's listen line changes to say that a listen builds the chart.
REJECTED: any change to the listening or analysis code; a second chooser; a second paste reader; a second web search helper; a change to a listen that starts with no song open; new libraries; edits outside the owned files.
DONE MEANS: cases 5 to 8 of plan section 4 each have a named check line that failed on the tests-only commit and passes now; the live box under "Verification" in section 4 is ticked with its evidence in the report; check:learn, check:learned and check:one-copy pass; npm run build is green.
SOURCE: docs/PLAN-song-search-layers.md section 4, seams 2 and 4; the L9 brief.
NEEDS OWNER: the owner's phone run of the L9 flow (gate P2 in the learn plan) should pass before this cook is queued.

# A listen fills the searched song

## What the player can do
1. Search a song, tap a row, and land on a sheet with no chart.
2. Tap Learn this song, then Learn by listen. Play the recording near the phone.
3. Paste the words on the Words step. A pasted web page of words comes in clean.
4. Review and Save. The same sheet now has its sections, chords and words. My Songs holds one copy.

## Owned files
src/learn-new-song.tsx (the save path: replaceOwnSong when the listen was opened on a song the player made with no chart; readPaste on the pasted words; the shared web search link), src/learn-song.tsx (pass the open song to the save path), src/song-start.tsx (the listen line), scripts/check-learn-new.ts (new cases only), package.json (no change expected).

Do not touch: src/learn-analyze.ts, src/learn-chords.ts, src/learn-worker.ts, src/song-paste.ts, src/song-search.ts, src/App.tsx, worker files.

## Empty and error states, and the wired flow
A storage failure on Save keeps the Review open with the L9 message, and the searched song is unchanged. Cancel at any step leaves the searched song as it was. A heard key or tempo that differs from a value the song already has is offered as a chip and is not written without a tap. A song that already has a chart keeps the L4 review flow.
Flow: search, tap a row, Learn this song, Learn by listen, Words, Line them up, Review, Save, the same sheet opens with its chart.

## Hints
- Worth building the saved song with mergeFacts and songFromFacts from src/song-build.ts, with the open song's facts first, so the rule for which value wins has one home. High.
- Worth testing with the stand-in listen that the L9 check injects. No test needs a microphone. High.
- Worth reading the L9 report first. If L9 already saves into the open song, this cook is cases 5 to 8 and the panel line alone. Medium.
```

## 6. What stays unproven

- **The BPM and key numbers rest on 15 songs and one run.** Cook 2 reruns the measurement with its committed script. Fewer than 10 of 15 with an answer is a reason to stop and ask before merge.
- **Key from the open database was right for 7 of 12 songs.** A wrong key shows wrong Nashville numbers. The plan accepts this because the default `C` is wrong more often, and because a pasted chart or a shipped chart replaces the key. If the owner finds wrong keys worse than a blank, cook 2 can ship BPM alone by dropping two features from the request.
- **AcousticBrainz may shut down.** It has taken no new data since 2022. The app loses nothing but the automatic BPM, because every failure is silent and tap tempo stays. The next step then is a BPM table built from the CC0 data dumps and shipped like the chord collection. That build needs a machine with room for the dumps, so it is not queued here.
- **GetSongBPM's terms are from memory.** Its terms page was behind a bot check on Nov 23. Read the terms before any work on decision D3.
- **Chord collection coverage for the owner's real sets is not measured.** One of 15 is the only number. Cook 4's coverage script takes any list of titles.
- **The licenses of the rejected collections were not read in this cook.** Each is marked "from memory". One of them could be usable. Reading them is a research task, and it holds up nothing.
- **Whether chord annotations of commercial songs fit section 2 of the terms draft is the owner's call.** The brief allows open-licensed chord-only data, and both licenses were read from their own pages. The terms draft itself is not in the repo, so this plan could not check its wording.
- **No paste rule was tried on a real phone.** The clipboard read differs between Safari and Chrome. Cook 3 puts the read inside the tap for that reason, and the owner's phone review of cook 3 is the proof.
- **The listen on a sheet with no chart was read from the code and not run.** Section 4 says what the code implies. Cook 3's case 2 covers the tempo row alone.
- **The Rock Corpus converter was not prototyped.** The Billboard converter was. The Rock Corpus grammar is small, and its numerals carry figures such as `d7`, `64`, and `/vi` that need a spelling table. This is the reason it lands second inside cook 4.
