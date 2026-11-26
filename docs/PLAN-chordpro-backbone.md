# Plan: ChordPro as the backbone of song storage

Written Nov 26, 2026 against `61f18be` (`mls-int-20261113` after PR 122). This plan changes no app code.

## Summary and landing order

The goal is one stored form for a song. Every song the app saves or sends is ChordPro text, the format other chord apps read. The app keeps its screens: it parses the text into the chart model it already draws. Nashville numbers come from the key and the chord alone, so a minor chord always shows its `m` (F#m in A is `6m`). The bass-note table is gone, and the sheet is a plain chords-over-words sheet for guitar and piano players.

Today a song is a JSON object with 18 fields. One field, `bassNotes`, feeds a table only a bass player reads, and the Nashville view reads that table to decide whether a minor chord gets an `m`. The same JSON travels to bands, friends, copy codes, gig packs, backups and band files.

After the three cooks below:

1. A song is stored as `{ id, copy?, chordpro }`. The text holds the title, the key, the tempo, every note field, every section and every line.
2. A chord row still sits exactly over its syllable. The text keeps each chord at its column, and section 1 proves it on every real song.
3. Nothing stored today is rewritten in one pass. A song saved before stays as it is, on the phone and on the server, until its next save. Every reader reads both forms.
4. A share's print does not change. The Worker computes the print from the parsed chart, as today.
5. An app build from before this work cannot delete or damage a song it cannot read. Section 3 says how.

The cooks land in this order. Each is verified and merged before the next starts.

| Order | Cook | What it changes | What the player sees | Waits for |
|---|---|---|---|---|
| 1 | `chordpro-codec` | The pure codec `src/chordpro.ts` with its round-trip check. Nashville math in `src/music.ts`. The bass table, `BassNote` and every read of `bassNotes` are removed. No stored byte changes. | The bass table is gone. A minor chord shows `6m` in every song. | nothing |
| 2 | `chordpro-worker` | The Worker reads both song shapes, stores band songs and copy codes as ChordPro text, and answers each phone in the shape that phone asks for. It also holds the rule that stops an old build from syncing a backup it cannot read. | Nothing. Every phone still runs the old shape. | cook 1 |
| 3 | `chordpro-phone` | The phone saves ChordPro, reads both shapes, tells the Worker so, and moves the library to a key an old tab cannot damage. | Nothing new on a screen. Songs sync and share as before. | cook 2 merged and its Worker deployed |

```text
chordpro-codec ──► chordpro-worker ──► chordpro-phone
```

The order follows the risk. Cook 1 is pure code and deletions, and it changes nothing at rest. Cook 2 changes what the server stores but not what any phone receives, so it can sit in Preview for days with old phones. Cook 3 is the only cook where a phone writes the new shape, and by then every server reader already takes it.

The brief suggested three cooks split another way: codec with Nashville, then the bass removal, then all storage in one cook. "Changes to the brief" explains the regrouping.

## What was measured for this plan

Every number here comes from a run on Nov 26, 2026, on the laptop, with Node 24. The inputs are the two files the repo already holds: `data/library.json` (the 15 built-in songs) and `docs/handoff/lead-sheets-data-export.json` (the 16 songs of the original export). The codec that produced the numbers was a throwaway prototype of section 1, kept outside the repo. Cook 1 commits a check that repeats the round trip and prints the sizes.

### Bytes per song

A "stored song" below is `JSON.stringify(song)`, which is what the library and a backup row hold today. The files themselves are larger (118 KB each) because they are indented.

| | Built-in library, 15 songs | Original export, 16 songs |
|---|---|---|
| Stored JSON today | 73,612 chars (74,350 bytes) | 73,250 chars (73,990 bytes) |
| The same without `bassNotes` | 66,524 chars | 66,159 chars |
| As `{ id, chordpro }` | 53,613 chars (54,345 bytes) | 53,168 chars (53,902 bytes) |
| The ChordPro text alone | 52,077 chars | 51,626 chars |
| Saved | 27.2 percent | 27.4 percent |
| One song, JSON today: smallest, middle, largest | 3,590 / 5,266 / 7,185 chars | 274 / 4,992 / 7,160 chars |
| One song, ChordPro text: smallest, middle, largest | 2,405 / 3,602 / 4,641 chars | 69 / 3,585 / 4,624 chars |

The brief gave about 78 KB and about 52 KB for the export. The second number matches. The first measured 73 KB here. Dropping `bassNotes` gives 9.6 of the 27 points. The rest comes from the field names and quotes that every chart line repeats in JSON.

The largest song is 7,185 chars today, against the Worker's limit of 12,000 (`MAX_SONG_CHARS`). As text it is 4,641.

### The round trip

The prototype wrote each song as text and read it back.

| Input | Songs | Same print | Same lines in every section | Same facts | Writing it again gives the same text |
|---|---|---|---|---|---|
| Built-in library | 15 | 15 | 15 | 15 | 15 |
| Original export | 16 | 16 | 16 | 16 | 16 |
| Made-up songs full of hard characters (`[ ] { } \ # " \|`, tabs, line breaks inside a field, empty fields, every mix of the four line fields) | 20,000 | 20,000 | 20,000 | 20,000 | 20,000 |

"Same print" compares the chart the way `printOf` in `worker/room-library.ts` reads it before hashing. For the 31 real songs the run also called the Worker's own `printOf`, bundled with esbuild, before and after: 31 of 31 prints are equal. "Same lines" is stricter: no section and no line is dropped or split, because a saved timing points at a line by its number.

What the built-in library needs from the format:

| Fact | Count |
|---|---|
| Sections | 122 |
| Chart lines | 476 |
| A chord row over words | 379 |
| Of those, a chord sits past the end of the words | 68 |
| Of those, the chord row starts with spaces | 47 |
| A bar row such as `\| A \| E \| F#m \| F#m \|` | 50, in 40 sections |
| Sections that hold bar rows and sung lines together | 8 |
| A note line | 38 |
| Words with no chords | 13 |
| A line that holds two fields at once (a bar row with its note) | 4 |
| Characters that needed an escape | 0 |
| A chord row token that is not a chord | 0 |

Speed in the prototype: 0.10 ms to parse a song and 0.2 ms to write one. A JSON round trip of the same song took 0.06 to 0.08 ms. A library of 500 songs parses in about 50 ms on this laptop. A phone is slower. Cook 3 measures it on the real page and keeps a parsed copy by text, so a song is parsed once.

### Nashville numbers today against pure math

The run compared `toNashvilleSymbol` at `61f18be` with the rule of section 2, on every chord in every chord row and bar row of the built-in library.

| Fact | Count |
|---|---|
| Chords checked | 1,247 |
| Chords whose number changes | 154, in 7 of the 15 songs |
| Changes that are a minor chord gaining its `m` | 154 |
| Any other change | 0 |

The seven songs show `6` for F#m today because their bass table says `6`. Three other songs already show `6m`, because their table says `6m`. The last five have no minor chord. After cook 1 all fifteen follow one rule.

What the chords are: 726 plain major, 261 sevenths, 197 minor, 45 sus, 7 major sevenths, 11 others. A seventh shows as its bare number today (G7 in C is `5`), and that is one chord in five. Decision T2 asks whether that should change.

### What an old build does with a song it cannot read

This was read in the code at `61f18be`. It was not run. Cooks 2 and 3 each prove their half with a bundle of the old build, the way `scripts/check-ux-settings-only-old-build.ts` does.

1. **The library.** `parseStored` in `src/storage.ts` keeps only the songs that pass `isSong`. `loadLibrary` then writes the shorter library back. So an old tab that meets a new-shape song in `leadSheetsLibrary` removes it from the phone.
2. **The backup.** `pending` in `src/backup.ts` sends every key the phone no longer holds as removed. The room stores the removal, and every other phone removes the song.
3. **A pulled backup row.** A row the old build cannot read is skipped, but its print is recorded as agreed. The next sync sends the song as removed, or sends the phone's older copy over it.
4. **A band song or a gig pack.** The old sheet calls `song.body.map` and `song.bassNotes.map`. Without those fields the page throws and shows "Something went wrong showing this page."
5. **A song card in a DM.** `songMessageIn` returns null and the card reads "A song this app can't show." That one fails kindly today.
6. **Updates.** The service worker serves the newest build to a fresh open, network first. Nothing reloads a page that is already open. A tab or a home-screen app left open keeps running the old code.

Items 1 to 3 are how a format change loses songs. Section 3 is built around them.

### Limits a song meets

| Limit | Where | Value |
|---|---|---|
| One song sent to the Worker | `MAX_SONG_CHARS`, `worker/room-library.ts` | 12,000 chars of JSON |
| One request to the Directory | `MAX_BODY_BYTES`, `worker/directory-http.ts` | 16,384 chars |
| One backup value | `MAX_VALUE_CHARS`, `src/backup-keys.ts` | 1,000,000 chars |
| One account's backup | `worker/room-backup.ts` | 5,000 rows and 5,000,000 bytes |
| A band file | `MAX_FILE_CHARS`, `worker/room-export.ts` | 4,000,000 chars |

Other counts that shaped the plan: 36 files read `data/library.json`, and 34 of them are checks. 20 check scripts name the key `leadSheetsLibrary`.

## Changes to the brief, and why

The brief gave the planner room to reorder, merge or split cooks and to swap methods. Each change is listed with its reason. None touches Terry's fixed lines: ChordPro is the backbone, one pure codec for the phone and the Worker, old data converts on read, new writes use ChordPro, no data loss, the share rule decides what it decides today, and no new libraries.

1. **The three cooks are grouped another way.** The brief had codec with Nashville, then the bass removal, then all storage. This plan has codec with Nashville and the bass removal, then the Worker, then the phone. Nashville math and the bass table are one change seen from two sides: the table's cells call the same function, and `scripts/check-music.ts` tests both. Split, cook 1 would rewrite cases that cook 2 deletes. Storage is the risky part, and it has a natural seam: the Worker must take the new shape before any phone sends it. Two smaller cooks there are easier to verify than one large one.
2. **Nothing stored is rewritten when it is read, on the phone as on the server.** The brief said this for server rows. The phone needs it more. Backup compares stored bytes. If a new build rewrote every song on load, every song would look edited on every phone. Each phone would upload its whole library, two phones that held the same song would each keep "a second copy from the other phone", and the marks that keep one account's songs away from the next account on a shared phone (`leadSheetsLeftBy`) would stop matching. So an old-shape song stays as stored until the player saves it again. "Converts on read" means in memory.
3. **The library moves to a new `localStorage` key.** An old tab drops any song it cannot read and writes the shorter library back (measured item 1). No shape under the old key survives that. Under a new key an old tab never sees a ChordPro song.
4. **A phone says which shape it reads, and the Worker answers an old phone in the old shape.** The brief said a writer writes only the new shape. That holds for everything at rest. A reply to an old build is a view of the stored text, made on the way out. Without it an old phone that opens a band or downloads a gig pack shows an error page (measured item 4), and a gig is the wrong place for that.
5. **An old build may not sync an account that a ChordPro build has synced.** This is the only server rule that stops measured items 2 and 3. The old build shows its sync as failed and loses nothing. A reload gives it the new build.
6. **A song card in a DM is written in the sender's shape.** A card is stored once and sent as stored to both phones over the live socket, so the Worker cannot shape it for each reader. A ChordPro build's card holds ChordPro. An old build's card stays as it is today. Otherwise every card sent between cook 2 and cook 3 would read "A song this app can't show" on every phone.
7. **A bar row is a line of a standard grid section, not an `x_` directive.** The brief left this open. Other apps ignore every `x_` directive, so an `x_` bar row would make every intro vanish in them. `{start_of_grid}` is the format's own home for bars.
8. **A section's name is written as `label="VERSE 1"`.** The brief showed `{start_of_verse: Verse 1}`. The grid section reads a bare first word as its shape, so a grid needs the attribute form, and one form for every section is simpler. The ChordPro reference calls the attribute form the robust one.
9. **Three directives the sketch did not list.** `{x_key_note}` holds `keyNote`, which the sketch's list missed. `{x_time}` holds a time signature that is more than two numbers, such as "3/4 — waltz, count 1-2-3". `{x_join}` ties two text lines into one chart line, because four built-in lines hold a bar row and its note together and a saved timing counts lines.
10. **The stored-form reader is its own small parser, next to `src/song-paste.ts`.** The brief rejects a second chart parser without a reason. The reason: `readPaste` guesses. It numbers verses, restyles headings, drops directives and counts what it left out, which is right for text copied from the web. A stored song must come back exactly, every time. The codec reads only what its own writer wrote, shares the one chord rule (`isChord` in `src/song-text.ts`), and changes no rule in `src/song-paste.ts`.
11. **A directive the reader does not know rides along.** A song-level line such as a future `{x_capo_view: shapes}` is kept and written back. So the next new field does not need another round of this migration.
12. **`data/library.json` stays JSON.** It is the source of the built-in songs, not a player's stored song, and 34 checks read it. It loses `bassNotes`. The phone turns a built-in song into text only when the player's library stores a copy.
13. **An old-shape song keeps an empty `bassNotes` list until cook 3.** The sketch removed the field in its second cook. Every type and every read goes in cook 1. But an old build refuses a stored song without the field (measured item 1), so every place that stores or sends an old-shape song still gives it a `bassNotes` list, empty when the song has none. The field ends with the old shape.
14. **The 12,000 limit is measured on the text.** `MAX_SONG_CHARS` counts JSON today. Counted on ChordPro text, the same number gives a real song more room: the text of the 30 measured songs that hold a chart is 71 to 98 percent of their JSON without the bass table. A song in the old shape is still held to the old measure, so nothing that passes today is refused (section 3).
15. **Download .cho is a follow-up.** The writer makes it a few lines of code. But a file can leave the app, so the button must respect Private copies and the band-only rule. That is decision T6 and its own small cook.
16. **No check for the plan itself.** The two earlier plans each added a `check:*-plan` script. This brief forbids a `package.json` edit, so the plan's tables are checked by hand in the report.

### Things in the brief or the repo that look wrong

- The brief's "about 78 KB" for the export measured 73 KB. The ChordPro number matched.
- The sketch says "`bassNotes` and other dropped fields". No other field is dropped. Every other field of `Song` has a directive in section 1.
- The sketch keeps `convertNoteNames` by not naming it. Its only caller is the bass cell, so it goes too.
- **`N.C.` is drawn wrong today.** In Nashville a chart row's `N.C.` shows as `N.1.` in the key of C, and transposed up 2 it shows as `N.D.`. A long chord is cut in two: `Bm7b5` shows as `7 7b5` and `C7sus4` as `17sus4`. The row's pattern in `src/music.ts` is narrower than `parseChord`. Smart paste writes these chords, so a pasted chart can show this now. Cook 1 fixes it as rule 8 of section 2, because a number rule that is wrong on a real row is not done.
- Bass-player wording lives outside the table: the built-in songs' notes, the page description in `index.html`, one line in Settings, and the capo rule D6 ("a bass has no capo"). Decisions T3 to T5 cover them.
- `CLAUDE.md` lists "a minter for `my-setlist` codes" as an obsolete pattern that is refused on purpose. `worker/codes.ts` holds that minter at `61f18be`, and the copy code depends on it. Cook 2 treats the code as the truth and leaves the line of `CLAUDE.md` for its owner.
- The header of `src/types.ts` says the types are "taken from lead-sheets-data-export.json". After cook 3 the stored form is text and `Song` is the in-memory model only. Cook 3 rewrites that comment.

## Decisions for Terry

No cook waits for an answer. Each cook builds the recommended answer, and each answer is one constant or one small follow-up to change.

| Id | Question | Recommended answer | What changes on a no |
|---|---|---|---|
| T1 | In a minor key, do numbers count from the key's own root, as today (in E minor, Em is `1m` and G is `b3`), or from the relative major (Em is `6m` and G is `1`)? | From the key's own root, as today. It is what every minor-key song in the library shows now. | One function in `src/music.ts`, a follow-up of a few lines. |
| T2 | Should a Nashville number show the rest of the chord: G7 as `5` with a 7, Bdim as `7` with a dim mark? Today only minor shows. One chord in five in the library is a seventh. | Not in these cooks. A guitar or piano player may want it, so decide after seeing cook 1 on a phone. | A follow-up cook. It needs a spelling Terry likes: `57`, `5(7)` or `5⁷`. |
| T3 | The built-in songs' notes (How to play, Practice tip, some key notes and headings) speak to a bass player. Keep them, rewrite them, or hide them? | Keep them for now. They are a song's own notes, not a feature, and a player's own songs have none. | A content pass on `data/library.json`, no code. |
| T4 | Three lines of wording name the bass: the first line of `CLAUDE.md`, the page description in `index.html`, and "For a bass tuned down." under Settings. | Cook 1 writes: "A lead-sheet app for guitar and piano players", "Groovist: chords and lyrics for your songs and your band.", and "For an instrument tuned down." | Terry's own words, one line each. |
| T5 | A pasted capo chart shows the chords as they sound, because "a bass has no capo" (decision D6 of the song-search plan). A guitar player often wants the shapes. | Leave it until asked. It is one constant, `CAPO_VIEW` in `src/song-paste.ts`, and no cook here touches it. | A one-line follow-up. |
| T6 | Download .cho: for which songs? | Only a song the player made. Not a copy marked Private, and not a band song, which stays in the band (t814u). | The follow-up cook `chordpro-export` builds what Terry picks. |
| T7 | After one of a player's phones runs the ChordPro build and syncs, an older build on another phone cannot sync until it reloads. It says the backup failed. Nothing is lost, and any reload fixes it. Is that acceptable? | Yes. The other choice lets an old build delete songs it cannot read. | Nothing safe to offer. This is the rule that keeps the data. |
| T8 | How long does the Worker keep answering old builds in the old shape? | 30 days after cook 3 reaches Live, then a small cook removes the old-shape view and the `bassNotes` filler. | The date moves. |

T7 is the one answer worth reading before cook 3 merges. The rest can wait for Terry to see the work.

## 1. The format

The format is ChordPro as its reference pages describe it (read Nov 26, 2026): lines of words with chords in brackets, directives in braces, and sections that start and end with a directive. The app adds a few directives of its own. Each starts with `x_`, the prefix the format reserves for one app's own use and tells other apps to ignore.

One module holds the format: `src/chordpro.ts`. It has no DOM, no storage and no clock, so the Worker imports it the way `worker/room-notes.ts` imports `src/song-notes-model`.

```ts
/** A song as it travels and rests: the chart and its facts, without this phone's `ref`, `id` and `copy`. */
export type SongContent = Omit<Song, "ref" | "id" | "copy">;   // moves here from src/band-library-model.ts, which re-exports it
/** A song on its way to or from the Worker. Cook 1 exports the type and uses it nowhere. */
export type SentSong = { chordpro: string };
export function songToChordPro(song: SongContent): string;
export function chordProToSong(text: string): SongContent;
```

The writer gives one text for one song, always the same bytes. The reader takes any text and never throws. A caller checks what it needs, such as a title.

### The text as a whole

- Lines are joined by `\n`. There is no blank line and no line break at the end.
- The song's facts come first, one directive a line, in the order of the table below.
- Then each section, in chart order.
- A directive is `{name}` or `{name: value}`, with one space after the colon. The value runs to the last `}` on the line, and spaces inside it are kept.

### The song's facts

| Order | Directive | Field of `Song` | Written when | Read as |
|---|---|---|---|---|
| 1 | `{title: …}` | `title` | always | the text |
| 2 | `{artist: …}` | `artist` | not empty | the text, or `""` |
| 3 | `{key: A}` or `{key: F#m}` | `keyRoot`, `keyMode` | always | a root `A` to `G` with `#` or `b`, and `m` for minor. Anything else leaves C major. |
| 4 | `{x_key_label: …}` | `keyLabel` | it differs from `"<keyRoot> <keyMode>"` | the text, or `"<keyRoot> <keyMode>"` |
| 5 | `{x_key_note: …}` | `keyNote` | not empty | the text, or `""` |
| 6 | `{tempo: 116}` | `tempo` | not null | the number, or null |
| 7 | `{x_tempo_note: …}` | `tempoNote` | not empty | the text, or `""` |
| 8 | `{time: 3/4}` | `timeSignature` | it starts with two numbers and a slash | used only when there is no `{x_time}` |
| 9 | `{x_time: 3/4 — waltz, count 1-2-3}` | `timeSignature` | it is anything more than two numbers and a slash | the text. With neither directive, `""`. |
| 10 | `{duration: 4:04}` | `officialRuntimeSec` | not null. Whole seconds are `m:ss`. Any other number is plain seconds. | seconds, or null |
| 11 | `{x_feel: …}` | `feel` | not empty | the text, or `""` |
| 12 | `{x_source_note: …}` | `sourceNote` | not empty | the text, or `""` |
| 13 | `{x_at_a_glance: …}` | `atAGlance` | not empty | the text, or `""` |
| 14 | `{x_how_to_play: …}` | `howToPlay` | not empty | the text, or `""` |
| 15 | `{x_practice_tip: …}` | `practiceTip` | not empty | the text, or `""` |
| 16 | any kept line | `kept` | the song holds one | see "Text the reader does not know" |

`title`, `artist`, `key`, `tempo`, `time` and `duration` are the format's own names, so another app shows them. `bassNotes`, `ref`, `id` and `copy` are never in the text.

### Sections

A section of the chart is one or more ChordPro sections in a row. The first carries the heading as a label. A start with no label carries on the section before it.

```text
{start_of_verse: label="VERSE 1"}      a new section, heading VERSE 1
…
{end_of_verse}
{start_of_grid: label="INTRO (band in)"}   a new section that opens with bar rows
…
{end_of_grid}
{start_of_part}                        no label: more lines of INTRO (band in)
…
{end_of_part}
```

| Kind | Used for |
|---|---|
| `grid` | a run of bar rows |
| `verse`, `chorus`, `bridge` | sung lines and notes, when the heading starts with that word, in any case |
| `part` | sung lines and notes under any other heading (INTRO, PRE-CHORUS, OUTRO, SOLO) |

The kind is worked out from the heading each time, so it holds no fact of its own. It is there for other apps, which draw a chorus their own way. The reader looks at two things only: `grid` or not, and label or no label. A section with no lines is written as an empty section of its kind, so it comes back.

### Chart lines

A chart line holds up to four fields. Each field has one written form.

| Field | Written as | Where |
|---|---|---|
| `chords` and `lyrics` | one sung line: the words, with each chord in brackets at its column | a section that is not a grid |
| `bars` | the row as it is | a grid |
| `note` | `{comment: …}` | whichever section is open. A note that opens a section goes with the line after it. |

A chart line with more than one of these is written in that order, with `{x_join}` on its own line before the second and the third. The reader adds the joined text to the line before it and starts no new line. A chart line with no field at all is written as an empty sung line.

**The sung line keeps every chord on its syllable.** Each run of characters between spaces in the chord row is a token. The writer puts the token in brackets at the token's own column in the words. Where the column is past the end of the words, spaces fill the gap. The reader counts the word characters it has read and puts each token back at that count. So the chord row comes back with the same columns, which is top rule 1 of `CLAUDE.md`.

```text
chords   "A               E              F#m"
lyrics   "Paper boats are sailing to the sea"
text     "[A]Paper boats are [E]sailing to the [F#m]sea"

chords   "D      A                  E"
lyrics   "Fold another one for me"
text     "[D]Fold an[A]other one for me   [E]"
```

A token that `isChord` accepts is written `[A]`. Any other token is written with a star, `[*x2]`, which the format calls an annotation, so another app does not try to transpose it. The reader drops one leading star. Spaces at the end of the words and of the chord row are not kept, which is what `printOf` ignores too.

A sung line with brackets and no words comes back as a chord row alone. A sung line with no brackets comes back as words alone.

### Escaping

The reference pages give no way to write a literal bracket in the words. The codec uses a backslash, which another app would show as a backslash. The built-in library needs none (measured: 0).

| Where | Written | Means |
|---|---|---|
| anywhere | `\\`, `\n`, `\r` | a backslash, a line break and a carriage return inside one field |
| a sung line, in the words or inside a bracket | `\[`, `\]` | a bracket that is not a chord |
| the first character of a sung line or a bar row | `\{`, `\#` | a line that would read as a directive or as a remark |
| a section label | `\"` | a quote in a heading |

The reader's rule is one line: a backslash and any character give that character, except `\n` and `\r`.

### Text the reader does not know

The codec reads what its own writer wrote. For anything else it follows three rules, so that a later build can add to the format without breaking this one.

- A directive it does not know, above the first section, is kept as it is in `Song.kept` (a new optional `string[]`) and written back after the known facts. A build from before a new fact carries that fact through an edit. The writer writes a kept entry only when the reader would keep it again: one line, a whole directive, a name the reader does not know. Any other entry is left out, so a kept line can never open a section or replace a fact.
- A directive it does not know inside a section is skipped.
- A line that starts with `#`, and any text outside a section, is skipped.

`readPaste` stays the reader for text from anywhere else: a web page, a file, another app's ChordPro.

### A worked example

A made-up song. The section headings and line shapes are the ones the built-in library uses.

```text
{title: Paper Boats}
{artist: The Made Up Band}
{key: A}
{tempo: 96}
{x_tempo_note: The last chorus slows down.}
{time: 6/8}
{x_time: 6/8 — count two in a bar}
{duration: 3:12}
{x_feel: Easy sway}
{x_at_a_glance: Intro (A D) → Verse → Chorus → Outro, end on A.}
{start_of_grid: label="INTRO (band in)"}
| A | D | A | E |
{x_join}
{comment: Let the last bar ring.}
{end_of_grid}
{start_of_verse: label="VERSE 1"}
[A]Paper boats are [E]sailing to the [F#m]sea
[D]Fold an[A]other one for me   [E]
(spoken) \[wait\] one more
{end_of_verse}
{start_of_chorus: label="CHORUS — sing it twice"}
[D]Sail on, [A]sail on  [*x2]
{comment: Stop on the last word.}
{end_of_chorus}
{start_of_grid}
| D | A |
{end_of_grid}
```

It reads back as three sections. INTRO holds one chart line with a bar row and its note. VERSE 1 holds two chord rows over words and one line of words. The chorus holds a chord row over words whose last token is not a chord, a note, and a bar row. The text is 705 characters. The same song as JSON is 881.

### The codec's promise

For any song, with any text in any field:

1. **Facts.** Every fact in the table comes back equal. An absent `tempo` or `officialRuntimeSec` comes back null.
2. **Chart.** The sections come back in order with the same headings. Each section has the same number of lines, in order. Each line's `bars` and `note` are equal. Its `chords` and `lyrics` are equal once spaces at the end are ignored. An absent field and an empty one count as equal.
3. **Print.** So `printOf` gives the same print before and after.
4. **One text.** Writing a song that was read from the writer's text gives that text again, byte for byte. Two phones write the same bytes for the same song.
5. **Dropped.** Only `bassNotes`, `ref`, `id` and `copy` are missing from the text.

### Required cases for the codec (cook 1)

Each case is one named `ok` or `FAIL` line of `scripts/check-chordpro.ts`. Every chart is made up for the check, except in C1 and C2, which read the two files the repo already holds.

- C1. Every song of `data/library.json` and of `docs/handoff/lead-sheets-data-export.json` keeps promises 1, 2 and 4.
- C2. For every one of those songs, the Worker's own `printOf` gives the same print before and after. The check bundles `worker/room-library.ts` with esbuild and calls the real function. This plan tried it: 31 of 31.
- C3. A chord inside a word, a chord past the end of the words, and a chord row that starts with spaces each come back at the same column.
- C4. The worked example above is written exactly as shown, and reads back as described.
- C5. Each of the four line fields alone, each pair, and all four together keep the line count. A line with no field keeps it too.
- C6. A section that mixes bar rows and sung lines comes back as one section. A section with no lines, and a section with an empty heading, come back.
- C7. A token that is not a chord (`x2`, `N.C.`, `(hold)`) comes back in place, and is written with a star only when `isChord` refuses it.
- C8. Every character in the escaping table comes back in every field that can hold it.
- C9. Each fact alone: a minor key, a key label that differs, a tempo with a fraction, a time signature with words, a length of 59, 60 and 3,601 seconds, and a length with a fraction.
- C10. A kept line comes back, in place, after an edit of another field. A kept entry that holds a line break, a known name such as `{title: x}`, or `{start_of_verse}` is not written.
- C11. Seeded made-up songs, 2,000 of them, built from the characters of C8, keep promises 1, 2 and 4. The seed is fixed and uses `Math.imul`.
- C12. The reader returns a song for an empty text, for a text of one bracket, and for a text cut off at every position of the worked example. It never throws.
- C13. `src/chordpro.ts` imports nothing but `src/types.ts` and `src/song-text.ts`, and names no `document`, `window` or `localStorage`.
- C14. The check prints the two size totals of this plan's table, and fails if the text is not smaller than the JSON.

## 2. Nashville numbers from pure math

Today `toNashvilleSymbol` in `src/music.ts` asks the song's bass table two things: whether this song writes minors with an `m` (`songUsesMinorSuffix`), and whether the table stores a number for this exact chord (`aliasMap`). So the same chord in the same key shows `6` in one song and `6m` in another. Cook 1 removes both lookups. The number comes from the key root and the chord, and nothing else.

### The rule

1. Read the chord with `parseChord`, as today. Text that is no chord (`N.C.`, a word) is left alone.
2. The number is the step from the key root to the chord root: `1 b2 2 b3 3 4 b5 5 b6 6 b7 7`. This is `degree`, unchanged.
3. A minor chord adds `m`. Minor is what `parseChord` already calls minor: `m`, `min`, `m7`, `m9`, `m7b5`.
4. A slash chord is the chord's number, a slash, and the bass note's step: `number/number`.
5. Nothing else of the chord shows. This is today's behaviour, kept (decision T2).
6. In a minor key the steps count from the key's own root. This is today's behaviour, kept (decision T1).
7. The numbers do not follow Transpose. This is today's behaviour, kept.
8. The sheet finds a chord in a row by the same spelling `parseChord` reads, and it leaves `N.C.` alone. This is a fix. Today the row's pattern (`CHORD_RE`) is narrower than `parseChord`, so it cuts a long chord in two and reads the C inside `N.C.` as a chord.

The "Today" column was run on `displayChordLine` at `61f18be`, with a song that has no table.

| Chord in a chart row | Key | Today | After cook 1 |
|---|---|---|---|
| A | A major | `1` | `1` |
| F#m | A major | `6`, or `6m` when the song's table says so | `6m` |
| Bm | A major | `2`, or `2m` when the song's table says so | `2m` |
| Am7 | C major | `6`, or `6m` when the song's table says so | `6m` |
| Dm9 | C major | `2` | `2m` |
| G/B | C major | `5/7` | `5/7` |
| C/E | C major | `1/3` | `1/3` |
| Am/G | C major | `6/5` | `6m/5` |
| G7 | C major | `5` | `5` |
| Gsus4 | C major | `5` | `5` |
| Cmaj7 | C major | `1` | `1` |
| Bdim | C major | `7` | `7` |
| Bb | C major | `b7` | `b7` |
| F# | C major | `b5` | `b5` |
| Em | E minor | `1` | `1m` |
| G | E minor | `b3` | `b3` |
| Am | E minor | `4` | `4m` |
| D | E minor | `b7` | `b7` |
| Bm7b5 | C major | `7 7b5` (the tail is left behind) | `7m` |
| C6/9 | C major | `1 /9` | `1` |
| C7sus4 | C major | `17sus4` | `1` |
| N.C. | C major | `N.1.` | `N.C.` |
| N.C. | any key, Notes view, transposed up 2 | `N.D.` | `N.C.` |

On the built-in library rules 1 to 7 change 154 of 1,247 chords, all of them a minor chord gaining its `m` (measured). The library holds none of the last five rows, so rule 8 changes nothing there. A pasted chart can hold any of them: `storedChord` in `src/song-paste.ts` writes `N.C.`, `Cm7b5` and `C7sus4` itself.

The longer number still sits over its syllable. `replaceChordTokens` already moves a line right when a token grows and takes the push back at the next gap, and `check:chords` holds that.

### What goes

| File | Removed |
|---|---|
| `src/music.ts` | `splitAliases`, `aliasMap`, `songUsesMinorSuffix`, `SIMPLE_DEGREE`, `convertNoteNames`, `displayBassNote`, `OPEN_STRINGS`, `ORDINALS`, `easiestPlace`, `displayPlace`, `nashvilleNumber`, `displayChordCell`, and the `BassNote` import |
| `src/sheet.tsx` | the "Your bass notes" heading, `BassTable`, and its five imports |
| `src/styles.css` | the `.bass` rules |
| `src/types.ts` | `BassNote` and `Song.bassNotes` |
| `src/storage.ts` | the `bassNotes` line of `isSong`, so a stored song passes with or without the field |
| `data/library.json` | `bassNotes` in each of the 15 songs |
| `scripts/check-library.mjs`, `scripts/check-music.ts`, `scripts/check-ux-datamuse-fix.ts`, `scripts/check-headers.ts`, `scripts/check-storage.ts`, `scripts/check-song-search.ts`, `scripts/check-song-start.ts` | the cases and fixture lines that read `bassNotes`, the table or the removed functions |
| `scripts/check-ux-metronome-sheet.ts`, and any other check that pins a position on the sheet | the pinned numbers, measured again, because everything under the table moves up |

What stays on purpose: every writer of a stored song in `src/storage.ts`, and `content` in `src/band-library.tsx`, give the song a `bassNotes` list, empty when it has none (change 13). One helper does it. A built-in song has no list after this cook, so an edit of one would otherwise be stored without the field and an old tab would drop it. `docs/handoff/lead-sheets-data-export.json` is not touched. It is the record of the old shape, and the round-trip check reads it.

### Required cases for Nashville and the bass removal (cook 1)

Cases N1 to N8 are lines of `scripts/check-music.ts`. Each chart is made up, apart from N2. N11 and N12 are lines of `scripts/check-chordpro.ts`.

- N1. F#m in A major is `6m` for a song with no table at all, and Am7 in C major is `6m`.
- N2. In every built-in song, every minor chord of every chord row and bar row shows an `m`. Seven songs fail this today.
- N3. G/B in C is `5/7`, C/E is `1/3`, and Am/G is `6m/5`.
- N4. In a chord row in C, `G7`, `Gsus4`, `Cmaj7`, `Bdim`, `Caug`, `C6/9` and `C7sus4` each show the bare number with nothing left behind, and `Bm7b5` shows `7m`. Transposed up 2 in Notes, the same row reads `A7`, `Asus4`, `Dmaj7`, `C#dim`, `Daug`, `D6/9`, `D7sus4` and `C#m7b5`.
- N5. Guard, green before and after: Db, Eb, F#, Ab and Bb in C show `b2`, `b3`, `b5`, `b6` and `b7`.
- N6. In E minor: Em is `1m`, G is `b3`, Am is `4m`, D is `b7`. In F# minor: A is `b3`, E is `b7`, F#m is `1m`.
- N7. `N.C.` in a chord row and in a bar row stays `N.C.` in Nashville and under Transpose. A plain word stays as it is. In A major, "Intro (A D) then Verse, end on A." in At a glance still reads "Intro (1 4) then Verse, end on 1.", as it does today.
- N8. A chord row with a minor chord keeps each later chord over its column in Nashville, and two tokens never merge.
- N9. `src/music.ts`, `src/sheet.tsx`, `src/types.ts` and `src/styles.css` name none of the removed things. A line of `scripts/check-one-copy.ts` reads the files.
- N10. A built-in song's sheet has no table and no "Your bass notes" heading, at 360 px and at 390 px. A line of `scripts/check-chords.ts`.
- N11. A new song, an edited built-in song and a song added from a band, each saved by this build, pass `isSong` of the build at `61f18be`. So does a built-in song this build sends. A line of `scripts/check-chordpro.ts`, which bundles that build's `src/storage.ts` the way `scripts/check-ux-settings-only-old-build.ts` does. It is a guard: green on commit 1 and green at the end. It goes red in between if the built-in songs lose their tables before the helper exists.
- N12. Guard, green before and after: a library stored by the build at `61f18be` with no edits opens in this build with no song of the player's own, so nothing is queued for backup. One edited built-in song stays the player's own with its bytes unchanged.

## 3. The stored shape and the migration map

### The shape

```ts
/** A song at rest on the phone. */
type StoredSong = { id: number; copy?: CopyMark; chordpro: string };
/** A song on its way to or from the Worker, wherever a request or a reply holds `song` today. From `src/chordpro.ts`. */
type SentSong = { chordpro: string };
```

The old shape is the JSON object of today, with `title`, `body` and the rest as fields. A reader tells the two apart by one test: the value has a `chordpro` string. In a database column the test is the first two characters. Old JSON starts with `{"`. ChordPro text starts with `{title`.

Each side has one reader and one writer, and every place in the map calls them.

| Side | Reader, takes both shapes | Writer, gives ChordPro |
|---|---|---|
| Phone | `songFromStored` in `src/storage.ts` | `songToStored` in `src/storage.ts` |
| Worker | `songIn` and `storedSong` in `worker/room-library.ts` | `songText` in `worker/room-library.ts` |

`songIn` today checks the title, the artist and the chart, and lets every other field ride along unchecked. After cook 2 it keeps the fields section 1 names. A fact that is missing or of the wrong type takes its empty value. `scripts/check-gig-songs.ts` sends a song of three fields, so a short song must still pass. Any other field is dropped. At `61f18be` the only such field is `bassNotes`.

### Three rules that carry the migration

1. **Read both, write one.** A reader takes either shape. A writer writes ChordPro. The text the Worker stores is always the writer's own text, so two phones that share the same chart store the same bytes.
2. **Reading rewrites nothing.** A song saved before this work keeps its exact bytes, on the phone and on the server, until someone saves it again. Backup compares bytes, and so do the marks that keep one account's songs away from the next account on a shared phone. No row is touched in bulk.
3. **An old build is never handed a song it cannot read.** Three parts do this: the new library key, the reply made in the shape the phone asks for, and the backup rule. They are described after the map.

### The map

Every place a song rests or travels, found by reading each caller of `songIn`, `printOf`, `isSong` and each `JSON.parse` of a song column at `61f18be`.

| # | Place | Old reader | New writer | Cook | Proved by |
|---|---|---|---|---|---|
| 1 | The phone's library: `localStorage` `leadSheetsLibrary`, moved to `leadSheetsLibraryV2` | `songFromStored` reads an old-shape song as it is. The old key is carried over once, byte for byte. | Each save of one song writes that song as `{ id, copy?, chordpro }`. Other songs keep their bytes. | 3 | P1 to P5 |
| 2 | A backup row: `leadSheetsSong.<id>` on the phone, `backup_items` in the player's own room | The Worker stores the value as bytes and never opens it. The phone reads a pulled row with `songFromStored`. | The phone sends the bytes its library holds. | 3, rule in 2 | P6, P7, W9, W10 |
| 3 | Songs set aside for another account: `leadSheetsSetAside.<account>` | The same bytes as a backup row, kept as they are. | The same. | 3 | P8 |
| 4 | A band song: `band_songs.song` in the band's room | `storedSong` reads a row of old JSON. | `share-song` and `edit-song` store `songText(song)`, whichever shape arrived. | 2 | W1 to W4 |
| 5 | A band song's title for a note: `bandSongTitle` in `worker/room-notes.ts` | Calls `storedSong`. | writes nothing | 2 | W4 |
| 6 | Replies that carry a band song: `/api/bands/library`, `share-song`, `edit-song` and its 409 `current` | The phone reads either shape. | The Worker answers in the shape the phone asked for. | 2 | W5, W6 |
| 7 | Band songs kept on the phone: IndexedDB `bandSongs`, filled by `/api/bands/pack` | The phone reads either shape from the store. | The store keeps what the reply gave. | 2 and 3 | W5, P9 |
| 8 | A gig pack: `/api/bands/gig/pack`, kept in IndexedDB `gigPacks`, for a member and for a guest | The same as row 7. A pack downloaded before the update still opens. | The same. | 2 and 3 | W5, P9 |
| 9 | A song card in a DM: `/api/chat/send-song`, stored in the DM room's `messages.body` | `songMessageIn` in `src/send-song-model.ts` reads either shape. | The Worker stores the card in the sender's shape (change 6). | 2 and 3 | W7, P10 |
| 10 | A send waiting for a network: `localStorage` `leadSheetsChatQueue` | A send queued before the update goes out as it is. `songIn` takes it. | A new send holds `{ chordpro }`. | 3 | P10 |
| 11 | A copy code's charts: the mint request for a `my-setlist` code, stored in `setlist_sends.songs` | `storedSong` reads each item of an old row. | The Worker stores `{ chordpro, print, shareId }` for each song. The print is the one computed today. | 2 | W8 |
| 12 | The charts a scanner adds: the reply of `/api/chat/setlist-copy` | The phone reads either shape. | The Worker answers in the shape the phone asked for. The card's `titles` come from the parsed songs. | 2 | W8 |
| 13 | A band file: `/api/bands/export` and the import that reads it | Import takes a file of either shape through `songIn`. | Export always writes `{ chordpro }`. A file is at rest, and a download cannot say what it reads. | 2 | W11 |
| 14 | A new song on the phone: `ownSong` in `src/song-text.ts`, used by the editor, smart paste, song search and bulk import | none | It builds the in-memory model, as today. The library writes the text when it saves. | 3 | P2 |
| 15 | What the phone sends: `content` in `src/band-library.tsx`, used by share, edit, send and the copy code | none | It gives `{ chordpro }`. | 3 | P11 |
| 16 | The built-in songs: `data/library.json`, and the copy of them inside the library value | It is the app's own data and stays JSON (change 12). An unedited built-in song never syncs and is replaced by the build's copy on every load. | An edited built-in song is the player's song and is saved as row 1 says. | 1 and 3 | N11, P3 |

Places that were checked and hold no chart: `leadSheetsSongDraft` (a song's view settings and timings), `leadSheetsSongData`, `leadSheetsScrollVersions`, `leadSheetsSentSongs` (share ids), `song_copies` (prints), `shares`, `band_setlists` (song ids), `song_notes`, and the live gig feed (song ids and positions).

### Keeping an old build safe

**The new key.** `LIBRARY_KEY` becomes `leadSheetsLibraryV2`. On each load, if `leadSheetsLibrary` exists:

- When the new key is empty, the old value is copied to it as it is, then the old key is removed. No song is converted, so no backup print changes. If the browser refuses the copy for space, the old key is removed first and put back if the write still fails. If neither way works, this load shows the library from the old key and the next load tries again.
- When both exist, an old tab wrote the old key after the move. Each song and setlist of the player's under the old key is compared with the new key. The same id with the same bytes is skipped. Anything else is added under a new id, and a setlist added in the same pass points at the new ids. Then the old key is removed. A late edit from an old tab shows as a second copy. Nothing is overwritten and nothing is dropped.

An old tab never sees the new key, so it cannot filter it.

**The shape a phone asks for.** A ChordPro build sends the header `X-Song-Shape: chordpro` on every call, from the one `api` function in `src/sign-in-methods.ts`. The Worker reads it in one helper. A caller that sends it gets `{ chordpro }`. A caller that does not gets the old object, built from the stored text, with an empty `bassNotes` list so the old build's own test passes. This view is made on the way out and stored nowhere.

**The backup rule.** The first backup request that carries the header marks the player's room, in a one-row table named `backup_shape`. From then on that room refuses a backup request without the header, with `409 update-app`. An old build shows its usual "backup failed" and sends nothing, so it cannot record a removal or pull a row it would then send back as removed (measured items 2 and 3). Any reload gives it the new build. This is decision T7.

**The order of deploys.** The Worker of cook 2 is deployed before any phone runs cook 3. One merged branch carries both, so the owner's deploy steps name the Worker first. A phone of cook 3 against a Worker from before cook 2 gets `bad-request` on a share and loses nothing.

### The size limit

`MAX_SONG_CHARS` stays 12,000 and is measured on the text the Worker would store. A song that arrives in the old shape also passes when its JSON is at most 12,000, as today, so no old phone meets a new refusal. Text is not always the smaller form: a row of eight or more chords with no words is longer in brackets (measured: 1.17 times the JSON at eight chords a row). On the 30 real songs that hold a chart the text is 71 to 98 percent of the JSON without the bass table.

### Required cases for the Worker (cook 2)

Lines of `scripts/check-chordpro-worker.ts`, which starts the Worker as `scripts/check-band-library.ts` does. "Old phone" is a `Phone` that sends no header and the old object. "New phone" sends the header and `{ chordpro }`. Every chart is made up.

- W1. A new phone shares a song to a band. The room's `band_songs.song` holds the writer's text, read from the SQLite file as `scripts/check-gig-songs.ts` reads one.
- W2. An old phone shares the same chart to a second band. That row holds the same text, byte for byte.
- W3. The Worker is stopped, a row is set back to the old JSON, and the Worker is started. Both phones read the song. After the reads the row is still the old JSON. After an edit it is text.
- W4. A note is posted and listed on a band song stored as text, and on the one set back to old JSON, so the title lookup reads both shapes.
- W5. The band library, the band pack and a gig pack give the new phone `{ chordpro }` and the old phone the old object. The old object passes `isSong` of the build at `61f18be`, bundled as in N11.
- W6. `edit-song` with a stale base answers 409 with `current` in the caller's shape.
- W7. A song card sent by a new phone is stored with `{ chordpro }`. One sent by an old phone is stored as the old object, and `songMessageIn` of the build at `61f18be` reads it.
- W8. A copy code minted by either phone stores `{ chordpro, print, shareId }`. A row set back to the old shape still gives its charts. The scanner's reply is in the scanner's shape, and the card's titles are right.
- W9. Guard, green before and after: an old phone backs up and pulls as today while no new phone has synced that account.
- W10. After a new phone's first backup request, the old phone's request is refused `409 update-app`, no row changes, and the new phone still syncs. A second account on the same Worker is not marked.
- W11. An exported band file holds `{ chordpro }` for every song. Importing that file, and importing a made-up file of the old shape, each give a band with the same prints.
- W12. The share rule decides the same in both shapes: a Private copy is refused `private_copy` when re-shared to a band as text and as the old object, a built-in chart is common in both, and an own song passes in both. The prints the Worker records for one chart are equal across the two shapes.
- W13. A text of 12,000 chars passes, and one of 12,001 is refused `bad-request`. An old object whose JSON is under the limit and whose text is over it passes. A ChordPro value with no title, and one that is not a string, are refused.
- W14. `worker/` holds one reader of a stored song. No file but `worker/room-library.ts` calls `JSON.parse` on a song column. A line of `scripts/check-one-copy.ts`.

### Required cases for the phone (cook 3)

Lines of `scripts/check-chordpro-phone.ts`. Storage cases run in Node on a bundle of `src/storage.ts` and `src/backup.ts`, as `scripts/check-storage.ts` does. Screen cases run in the browser.

- P1. A library stored by the build at `61f18be` under the old key opens with every song and setlist. The new key holds the old value byte for byte, and the old key is gone.
- P2. Saving one song writes that song as `{ id, copy?, chordpro }` and leaves every other song's bytes alone. A new song from the editor, from smart paste and from bulk import is stored as text.
- P3. An edited built-in song is stored as text. Removing the edit brings the built-in song back.
- P4. With both keys present, a song under the old key with new bytes is added under a new id, one with the same bytes is skipped, a setlist follows its songs, and the old key is removed. A refused write for space leaves the old key as it was.
- P5. The build at `61f18be`, bundled, runs `loadLibrary` and a save in the same `localStorage` after the move. The new key is unchanged.
- P6. Two phones on one account, one holding the old shape and one the new, sync both ways. No "second copy" appears, and an unedited song is not uploaded.
- P7. Every `api` call carries the header, the backup call too.
- P8. An account switch on a shared phone with mixed shapes: the first account's songs are set aside and come back with the same bytes, and the second account sees none of them.
- P9. A gig pack and a kept band song stored in the old shape before the update open on the sheet. So do ones stored as text.
- P10. A song card of either shape opens and adds to My Songs. A send queued in the old shape before the update is delivered once.
- P11. Share to a band, edit a band song, send to a friend and mint a copy code each send `{ chordpro }`.
- P12. Opening a library of 500 made-up songs parses each text once. A second `loadLibrary` with no change parses none. The check prints the time.
- P13. A song saved as text and opened again draws every chord over the same syllable as before the save, measured the way `scripts/check-chords.ts` measures it.

## 4. Risks

Each risk names what the plan does about it and the case that proves it. A risk with no case is repeated in section 7.

| # | Risk | What happens if it goes wrong | What the plan does | Proved by |
|---|---|---|---|---|
| R1 | A share's print changes | The share rule reads a chart as a new one. A Private copy could pass as the player's own, or a built-in chart could stop being common. | `printOf` is not edited. It runs on the parsed chart, and the codec promises the same chart back. | C1, C2, W12 |
| R2 | A cached old build sends the old shape | A share or a send from a phone that has not reloaded is refused. | The Worker reads both shapes until the date of decision T8. | W2, W7, W8 |
| R3 | A cached old build is handed text | Its sheet throws, or its library drops the song and writes the shorter library back. | The reply is made in the shape the phone asks for. The library lives under a key the old build never reads. | W5, W6, P5 |
| R4 | A cached old build syncs a backup it cannot read | It sends the songs as removed, and every phone on the account removes them. | The backup rule refuses it once a ChordPro build has synced. | W9, W10 |
| R5 | A song is rewritten because it was read | Every phone uploads its whole library. Two phones each keep "a second copy from the other phone". On a shared phone the next account sees the last account's songs. | Reading rewrites nothing (rule 2). | P1, P2, P6, P8, W3 |
| R6 | The move to the new key runs out of space | The browser refuses to hold two copies of a large library at once. | The old key is removed first and put back if the write fails. The two steps run in one turn of script with nothing between. | P4 |
| R7 | An old tab keeps saving under the old key | Its saves are invisible to the new build. | Every load of the new build takes in what the old key holds, as new songs, and removes the key. | P4, P5 |
| R8 | The size limit moves | A song that saved yesterday is refused today. | The old shape keeps the old measure. Text is smaller for every real song measured. | W13 |
| R9 | A request grows past the Directory's 16,384 chars | A send with a long chart and its timings is refused. | The same send is smaller as text than it is today. No limit changes. | W13 |
| R10 | A song card from a new build reaches an old build | The card reads "A song this app can't show." | It fails kindly today, and a reload shows it. The card is not converted, because one stored card goes to both phones. | W7, P10 |
| R11 | An old build edits a band song | The bass table of that song is empty afterwards on old builds. | Accepted. The table goes by Terry's decision, and no chart line is lost. | W2 |
| R12 | The writer changes in a later build | Two builds write different bytes for one song. Backup sees an edit where there was none. | The writer is frozen by C4 and promise 4. A change to it is a format change with its own plan. A new fact rides in a kept line instead. | C4, C10 |
| R13 | The text carries a line that breaks the format | A heading or a note holding `}` or a line break splits into two lines, and the song reads back wrong. | Every field is escaped. A kept line is written back only when it is one whole directive line with a name the reader does not know. | C8, C10, C11, C12 |
| R14 | A chord moves off its syllable | Top rule 1 breaks. | The sung line keeps each token's column, and the screens draw the same model as today. | C3, N8, P13 |
| R15 | The Worker spends too long parsing | A band of 200 songs is parsed on every library view. | A new phone gets the stored text with no parse. An old phone costs 0.1 ms a song (measured on the laptop). | unproven on the Worker |
| R16 | The phone spends too long parsing | The song list opens slowly with a large library. | A parsed song is kept by its text, so a song is parsed once a session. | P12 |
| R17 | The Worker is deployed after the phone | A share from a new phone is refused `bad-request`. | The deploy steps put the Worker first. Nothing is lost if they are swapped, and the next deploy fixes it. | unproven by a script |
| R18 | A band file from the new Worker is loaded into an older Worker | The import is refused. | It is refused kindly, with no change to the band. Preview and Live run the same Worker after a deploy. | W11 covers the new Worker only |
| R19 | Checks seed the old key | 20 checks write `leadSheetsLibrary` to set up a phone. | The move takes that value in, so a check that only seeds keeps working. A check that reads the key back after a save is changed in cook 3. | `npm run verify` in cook 3 |
| R20 | Cook 1 changes what an old tab sees in the same key | An old tab and a new tab each write their own built-in songs into the library on load, one with bass tables and one without. | The player's own songs are untouched by that, and each build still passes the other's test. | N11 |
| R21 | Another chord app reads the file differently | A label, a backslash or a grid row shows oddly elsewhere. | Not needed by these three cooks. It matters for Download .cho, and that cook tries a real app first. | unproven |

## 5. The order and the copy-ready cook briefs

### The order, and why

| Order | Cook | Brief file | Model | Starts when |
|---|---|---|---|---|
| 1 | `chordpro-codec` | `docs/cooks/chordpro-codec.md` | Opus | now |
| 2 | `chordpro-worker` | `docs/cooks/chordpro-worker.md` | Opus | cook 1 is verified and merged |
| 3 | `chordpro-phone` | `docs/cooks/chordpro-phone.md` | Opus | cook 2 is verified and merged, and Terry has read decision T7 |

Each brief is a standalone file under `docs/cooks/`. That file is the copy to queue. The HANDOFF block and the short facts are repeated here for review. If the two differ, the file under `docs/cooks/` wins. None of the three is queued by this plan.

The cooks do not run side by side. Cook 2 imports the codec of cook 1. Cook 3 needs the Worker of cook 2 to answer it. Per the model rules, Opus builds each one, and no cook name holds "fable".

### Rules every brief below inherits

- Read `CLAUDE.md` first. Stay inside the owned files. Add one `check:*` line to `package.json` and nothing else there.
- Commit 1 holds the tests alone, and each new case fails on it. A case marked "guard" is green on both sides and says so. Later commits do not weaken a case. A case that is wrong goes in `QUESTIONS.md`, which is a shared log, so add the entry at the top.
- The required cases are the lettered cases of the named section of `docs/PLAN-chordpro-backbone.md`. Each case prints one named `ok` or `FAIL` line.
- The format is section 1 of the plan, to the byte. A cook that finds the format wrong stops and writes the case in `QUESTIONS.md`. It does not change the writer on its own, because two builds must write the same bytes.
- One codec. No cook adds a second reader or writer of the stored form, changes a rule in `src/song-paste.ts`, or adds a second chord rule.
- `printOf` and `worker/share-guard.ts` are not edited. What the share rule decides today, it decides after each cook.
- Nothing stored is rewritten because it was read. No statement updates rows in bulk.
- No new libraries. Every chart in a check is made up for the check, with made-up words. The round-trip cases alone read `data/library.json` and `docs/handoff/lead-sheets-data-export.json`.
- Write paths with `fileURLToPath` and `path.join`, and read the browser from `CHROME`. An old build is bundled from `git archive 61f18be` with esbuild, as `scripts/check-ux-settings-only-old-build.ts` does, with a repo-root working folder.
- No outside address and no key in any committed file. `npm run check:portable` must pass.
- Do not touch the held work: the listening chain (l3 onward), the bulk-import builds for PDFs, photos and app files, and chord-grab. Section 6 names each seam.
- Handle the list in `CLAUDE.md` under "Must handle in every feature". The table below says what each rule means here.

### Must handle, and the cases that prove it

| `CLAUDE.md` rule | What it means for these cooks | Cases |
|---|---|---|
| Signed out | A signed-out visitor's library moves to the new key and saves as text like anyone's. No cook adds a sheet or a wall. A backup refusal reaches only a signed-in phone. | P1, P2 |
| Second phone or account switch on a shared phone | Two phones in different shapes sync with no second copy. An account switch sets songs aside and brings them back with the same bytes, and the next account sees none. The backup rule marks one account, never the phone. | P6, P8, W10 |
| Old, expired, reset or wrong links | No link or code changes. A copy code minted before the update still gives its charts. An old build that meets text fails kindly: a card it cannot show, or a backup that says it failed. | W8, W10, P10 |
| Offline or slow network | A send queued before the update is delivered once after it. A gig pack downloaded before the update opens with no network. | P9, P10 |
| Empty states and error states | A song with no chart, a section with no lines and a text of nothing each read back. The reader never throws. A song over the limit gets the same refusal as today. | C6, C12, W13 |

### 5.1 Brief: `chordpro-codec`

```text
## HANDOFF
GOAL: A pure codec in src/chordpro.ts writes any song as ChordPro text and reads it back with the same facts, the same chart and the same print. Nashville numbers come from the key and the chord alone, so a minor chord always shows its m (F#m in A is 6m). The bass-note table and every read of bassNotes are gone from the sheet.
DECIDED: one cook, branch cook/chordpro-codec off mls-int-20261113; the format is plan section 1, to the byte; the codec reads only what its own writer wrote and shares isChord with src/song-text.ts; Nashville is the eight rules of plan section 2 (a minor key counts from its own root, a seventh or sus shows the bare number); nothing stored or sent changes shape in this cook; a song this build saves or sends still carries an empty bassNotes list, so a build from before this cook reads it; CLAUDE.md's first line, the index.html description and the Settings note take the words of decision T4.
REJECTED: any change to what is stored or sent; worker edits; a change to a rule in src/song-paste.ts; a second chord rule; turning data/library.json into text; a Download .cho button; showing 7, sus or dim on a number (decision T2); real lyrics in a fixture; new libraries; edits outside the owned files.
DONE MEANS: cases C1 to C14 and N1 to N12 of the plan each have a named check line; each failed on the tests-only commit and passes now, apart from the guards N5, N11 and N12, which are green on both; the report shows the size totals C14 prints and the list of old cases removed with the bass table; npm run verify is green, with any failure rerun once and explained.
SOURCE: docs/PLAN-chordpro-backbone.md sections 1 and 2.
NEEDS OWNER: none to start. Terry looks at one song with F#m and one minor-key song on a phone before merge. Decisions T1 to T4 have recommended answers, and the cook builds those.
```

- **Tests first.** Commit 1 is `scripts/check-chordpro.ts` with its `package.json` line, and the new N cases in `scripts/check-music.ts`, `scripts/check-one-copy.ts` and `scripts/check-chords.ts`. Nothing else.
- **Owned files.** `src/chordpro.ts`, new. `src/music.ts`, `src/sheet.tsx`, `src/styles.css`, `src/types.ts`, `src/storage.ts` and `src/band-library.tsx` for the test of a stored song and the empty list, `src/song-text.ts`, `src/band-library-model.ts` for the moved type, `data/library.json`, three lines of wording, and the checks that named the table.
- **Checks.** `npm run verify`. Removing a block from the sheet moves everything under it, so every check that pins a position on the sheet is in play.

### 5.2 Brief: `chordpro-worker`

```text
## HANDOFF
GOAL: The Worker reads a song in either shape, stores band songs and copy-code charts as ChordPro text, answers each phone in the shape that phone asks for, and stops a build that cannot read text from syncing an account's backup once a ChordPro build has synced it. No phone changes, and no player sees a difference.
DECIDED: one cook, branch cook/chordpro-worker off mls-int-20261113 after chordpro-codec has merged; the Worker imports src/chordpro.ts; songIn takes the old object or { chordpro } and every stored song is the writer's own text; a row of old JSON is read as it is and is rewritten only by its next save; a caller that sends X-Song-Shape: chordpro gets { chordpro }, any other caller gets the old object with an empty bassNotes list; a DM song card is stored in the sender's shape; a band file is exported as text and imported in either shape; MAX_SONG_CHARS is measured on the text, and an old object still passes on its JSON; the first backup request with the header marks that account's room, which then refuses a backup request without it as 409 update-app.
REJECTED: any edit to printOf or worker/share-guard.ts; a statement that rewrites rows in bulk; opening or converting a backup value on the server; a second reader of a stored song; any phone change beyond the two data-kinds lines; trusting the header for anything but the shape of a reply and the backup rule; new libraries; edits outside the owned files.
DONE MEANS: cases W1 to W14 of the plan each have a named check line that failed on the tests-only commit and passes now, apart from the guard W9, which is green on both; the report lists every earlier check whose expected reply changed, with the reason; npm run verify is green, with the auth-family checks under the lock and any failure rerun once and explained.
SOURCE: docs/PLAN-chordpro-backbone.md sections 1 and 3, and risks R1 to R4, R8 to R11 and R15.
NEEDS OWNER: none to start. Nothing is deployed by the cook. The owner's deploy steps for the next release put this Worker before the phone build of chordpro-phone.
```

- **Tests first.** Commit 1 is `scripts/check-chordpro-worker.ts`, its `package.json` line, and the W14 line in `scripts/check-one-copy.ts`.
- **Owned files.** `worker/room-library.ts`, `worker/room-notes.ts`, `worker/room-gig.ts`, `worker/room-export.ts`, `worker/directory-inbox.ts`, `worker/directory-http.ts`, `worker/room-backup.ts`, `worker/room.ts`, `worker/room-members.ts`, and `src/data-kinds.ts` for the one new table, `backup_shape`.
- **Checks.** `npm run verify`. The checks closest to the change are `check:band-library`, `check:band-move`, `check:send-song`, `check:setlist-code`, `check:gig-songs`, `check:guest`, `check:backup`, `check:share-guard`, `check:song-notes` and `check:privacy`.

### 5.3 Brief: `chordpro-phone`

```text
## HANDOFF
GOAL: The phone saves every song as ChordPro text, reads both shapes, tells the Worker it reads text, and keeps its library under a key an older tab cannot damage. A player sees the same songs, setlists, bands and backups as before, on every phone and across an account switch.
DECIDED: one cook, branch cook/chordpro-phone off mls-int-20261113 after chordpro-worker has merged; a stored song is { id, copy?, chordpro } and the screens keep the parsed Song model; the library key becomes leadSheetsLibraryV2 and the old key is carried over as plan section 3 says, byte for byte on the first load; saving one song rewrites that song alone, and reading rewrites nothing; api() sends X-Song-Shape: chordpro on every call; share, edit, send and the copy code send { chordpro }; every reader on the phone takes both shapes; a parsed song is kept by its text so a song is parsed once; the empty bassNotes list of cook 1 ends here.
REJECTED: converting the library on load; a second library value kept beside the first; writing the old shape anywhere; any worker edit; any edit to printOf or the share rule; a change to a screen's layout; a Download .cho button; new libraries; edits outside the owned files.
DONE MEANS: cases P1 to P13 of the plan each have a named check line that failed on the tests-only commit and passes now; the report shows the time P12 prints and every earlier check that read the old key and why it changed; npm run verify is green, with the auth-family checks under the lock and any failure rerun once and explained.
SOURCE: docs/PLAN-chordpro-backbone.md sections 1 and 3, and risks R3 to R7, R10, R14, R16 and R19.
NEEDS OWNER: Terry's answer to decision T7 before merge, not before the start. The owner deploys the Worker of chordpro-worker before this build reaches a phone.
```

- **Tests first.** Commit 1 is `scripts/check-chordpro-phone.ts` and its `package.json` line.
- **Owned files.** `src/storage.ts`, `src/backup.ts`, `src/sign-in-methods.ts`, `src/band-library.tsx`, `src/band-library-model.ts`, `src/send-song-model.ts`, `src/gig-pack.ts`, the readers of the two IndexedDB stores, `src/types.ts`, `src/data-kinds.ts`, two rows of `scripts/check-one-copy.ts`, and the earlier checks that read the old key.
- **Checks.** `npm run verify`. The checks closest to the change are `check:storage`, `check:backup`, `check:band-library`, `check:send-song`, `check:setlist-code`, `check:chords`, `check:offline`, `check:song-import`, `check:new-song` and `check:privacy`.

## 6. Seams with held work, and follow-ups

### Seams with held work

No cook here edits held work. These are the files both sides touch, read from the held briefs under `docs/cooks/`. Whichever side lands second follows "Merge seams" in `CLAUDE.md` and reruns both sides' checks.

| Held work | Where it meets this plan | What to check at the merge |
|---|---|---|
| The listening chain (l3 onward) | A saved timing and a heard version point at a chart line by its number. The codec keeps every section and every line in order (promise 2), and `{x_join}` exists for that. Cook 1 edits `src/sheet.tsx`, which the chain's screens draw on. | A timing saved before cook 3 still points at the same line after its song is saved as text. Case P2 covers the song. The chain's own checks (`check:learned`, `check:heard`) cover the pointer. |
| Bulk import: PDFs, photos, app files | Each adds a line to `READERS` in `src/import-read.ts` and saves through `ownSong` and `addOwnSongs` in `src/storage.ts`. Cook 3 changes what `addOwnSongs` writes, not what it takes. | `check:song-import` and each held cook's own check, after cook 3. A held cook that lands after cook 3 builds songs with `ownSong` as before and gets text for free. |
| Bulk import, a ChordPro file | A `.cho` file from another app goes through `readPaste`, as the bulk-import plan says. That stays. A file this app wrote could go to `chordProToSong` and come back exact. | Part of the follow-up `chordpro-export`, which decides how a file says it is this app's own. |
| chord-grab | `chord-grab-app` owns `src/sheet.tsx`, `src/song-text.ts`, `src/storage.ts` and `src/data-kinds.ts` for the credit line and its key. `chord-grab-worker` owns `src/sign-in-methods.ts`. The credit is `Song.sourceNote`, which the text holds as `{x_source_note}`. | The credit of a grabbed song survives a save as text (C9 covers the field). The `api` header of cook 3 and chord-grab's change sit in the same function. `check:privacy` after both sides add keys. |
| The smart paste rules | `CAPO_VIEW` and every rule of `src/song-paste.ts` stay as they are. | `check:song-paste` after each cook. |

### Follow-ups, none queued

| Follow-up | What it does | Waits for |
|---|---|---|
| `chordpro-export` | A Download .cho button on a song the player made, and reading the app's own file back exactly. It first opens the file in one real chord app and records what that app shows. | cook 3, and decision T6 |
| `chordpro-old-shape-end` | Removes the old-shape answer, the `bassNotes` filler and the old-object branch of `songIn`. The readers of stored rows stay, because old rows may rest for years. | 30 days after cook 3 reaches Live (decision T8) |
| Old rows, counted | A read-only count of stored songs still in the old shape, per room, to decide whether anything more is ever needed. It rewrites nothing. | cook 3 on Live |
| Nashville for the rest of the chord | Shows the 7, the sus or the dim on a number, in the spelling Terry picks. | decision T2, after cook 1 is seen on a phone |
| Minor keys from the relative major | One function in `src/music.ts`. | decision T1, only on a no |
| The built-in songs' wording | A pass over `data/library.json` for the notes that speak to a bass player. | decision T3 |
| A capo view for guitar | `CAPO_VIEW` in `src/song-paste.ts`, and where the choice is shown. | decision T5 |
| A smaller library value | The library value carries a copy of the 15 built-in songs, about 66,000 chars that the build already holds. Leaving them out frees that space on every phone. | cook 3 |

## 7. What stays unproven

This plan measured what it could on the laptop. The list below is what it did not prove.

- **What an old build does.** The six behaviours under "What an old build does with a song it cannot read" were read in the code at `61f18be`. None was run. Cases N11, W5, W7, W10 and P5 run that build's own code for the first time.
- **The codec is a prototype.** The numbers come from a throwaway script kept outside the repo. Cook 1 writes the real module, and C1, C2 and C14 repeat the measurements. If a real case disagrees with the prototype, the case is right.
- **No other chord app has read the text.** The format follows the reference pages. Three things may show oddly elsewhere: a section name written as `label="…"` in an app from before that form, a backslash before a bracket, and a grid row with no bar line. Characters such as `<` and `&` may also be read as markup by some apps. None of this matters until a file leaves the app, which is the follow-up `chordpro-export`.
- **Nothing ran on a phone.** Parse time, the size of the library value and the moment of the key move were measured or reasoned on the laptop. P12 prints a time on the check's browser, not on a phone.
- **How much `localStorage` a phone gives.** The plan assumes about 5 MB for one site, from memory. The key move is written to work when two copies do not fit (R6), so the number does not decide anything.
- **Worker time.** The cost of building the old-shape answer for a large band was not measured on a Worker (R15).
- **The order of deploys.** No script can prove the Worker goes out before the phone build (R17). The plan relies on the owner's deploy steps and on a kind refusal when they are swapped.
- **A power cut during the key move.** In the one case where two copies do not fit, the old key is removed a moment before the new one is written. A phone that loses power between those two steps, with no backup, would lose its library. The steps are two lines in one turn of script. The risk is named, not removed.
- **The checks that pin the sheet.** `scripts/check-ux-metronome-sheet.ts` pins positions under the bass table, and other checks may too. The plan did not run the full suite with the table gone. Cook 1 does.
- **How many checks compare a Worker reply to a short made-up song.** After cook 2 an old-shape reply is a whole song with every fact filled. The plan did not count the checks this changes. Cook 2 lists each in its report.
