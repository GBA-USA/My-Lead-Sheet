# Cook brief: `chordpro-codec`

Not queued. This brief waits for the owner's review. Model: Opus. Plan: `docs/PLAN-chordpro-backbone.md`.

```text
## HANDOFF
GOAL: A pure codec in src/chordpro.ts writes any song as ChordPro text and reads it back with the same facts, the same chart and the same print. Nashville numbers come from the key and the chord alone, so a minor chord always shows its m (F#m in A is 6m). The bass-note table and every read of bassNotes are gone from the sheet.
DECIDED: one cook, branch cook/chordpro-codec off mls-int-20261113; the format is plan section 1, to the byte; the codec reads only what its own writer wrote and shares isChord with src/song-text.ts; Nashville is the eight rules of plan section 2 (a minor key counts from its own root, a seventh or sus shows the bare number); nothing stored or sent changes shape in this cook; a song this build saves or sends still carries an empty bassNotes list, so a build from before this cook reads it; CLAUDE.md's first line, the index.html description and the Settings note take the words of decision T4; the plan's reference codec, scripts/chordpro-plan-reference.ts, is replaced by src/chordpro.ts and deleted, and check:chordpro-plan then runs the real codec.
REJECTED: any change to what is stored or sent; worker edits; a change to a rule in src/song-paste.ts; a second chord rule; turning data/library.json into text; a Download .cho button; showing 7, sus or dim on a number (decision T2); real lyrics in a fixture; new libraries; edits outside the owned files.
DONE MEANS: cases C1 to C14 and N1 to N12 of the plan each have a named check line; each failed on the tests-only commit and passes now, apart from the guards N5, N11 and N12, which are green on both; the report shows the size totals C14 prints and the list of old cases removed with the bass table; npm run check:chordpro-plan passes with src/chordpro.ts in place of the reference; npm run verify is green, with any failure rerun once and explained.
SOURCE: docs/PLAN-chordpro-backbone.md sections 1 and 2.
NEEDS OWNER: none to start. Terry looks at one song with F#m and one minor-key song on a phone before merge. Decisions T1 to T4 have recommended answers, and the cook builds those.
```

# The codec, Nashville from pure math, and no bass table

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 5 of the plan. Both apply in full.

## What the player sees

1. A song's sheet goes from the key line and the feel straight to the notes and the chart. The **Your bass notes** heading and its table are gone.
2. In Nashville, F#m in the key of A shows `6m` in every song. Seven built-in songs show a bare `6` today.
3. `N.C.` stays `N.C.` in Nashville and under Transpose. A long chord such as `Bm7b5` shows one number.
4. Nothing else changes. Songs save, sync and share as they did.

## Tests first

Commit 1 holds only tests:

- `scripts/check-chordpro.ts`, new, with its `package.json` line `check:chordpro`. Cases C1 to C14, N11 and N12.
- New lines N1 to N8 in `scripts/check-music.ts`, N9 in `scripts/check-one-copy.ts`, N10 in `scripts/check-chords.ts`.

Every case but the guards N5, N11 and N12 fails on that commit. Paste the failing run into the report. `src/chordpro.ts` does not exist on commit 1, so the check loads it with `import()` inside a `try` and each C case prints its own `FAIL` line.

C5 and C6 read their examples from the plan itself: the fenced block under "Every mix of the four fields, written", parsed the way `scripts/check-chordpro-plan.ts` parses it. The text in that block is the format, byte for byte.

The old cases that test the bass cell, the place column and the table's headers are deleted in a later commit, with the code they test. That is a removal the owner decided, not a weakened case. List each deleted case in the report.

## Owned files

| File | Change |
|---|---|
| `src/chordpro.ts` | New. Pure. `songToChordPro`, `chordProToSong`, the type `SongContent`, which moves here, and the type `SentSong`. It imports only `src/types.ts` and `src/song-text.ts`. |
| `src/band-library-model.ts` | Re-export `SongContent` from its new home. Nothing else. |
| `src/music.ts` | Rules 1 to 8 of plan section 2. Remove every name in the "What goes" table. |
| `src/sheet.tsx`, `src/styles.css` | Remove the heading, `BassTable`, its imports, and the `.bass` rules. |
| `src/types.ts` | Remove `BassNote` and `Song.bassNotes`. Add `kept?: string[]` to `Song`. |
| `src/storage.ts` | `isSong` passes a song with or without `bassNotes`. One helper gives a stored song a `bassNotes` list, empty when it has none, and every writer of a song calls it. Nothing else. |
| `src/band-library.tsx` | `content` calls the same helper, so a sent song carries the list. |
| `src/song-text.ts` | `ownSong` stops writing the list itself, since the helper does. Nothing else. |
| `data/library.json` | Remove `bassNotes` from each of the 15 songs. No other byte of a song changes. |
| `CLAUDE.md`, `index.html`, `src/personal-settings.tsx` | The three lines of decision T4. |
| `scripts/check-chordpro.ts` | New. |
| `scripts/chordpro-plan-reference.ts` | Deleted, in the commit that adds `src/chordpro.ts`. It is the plan's prototype of the codec, and the repo holds one codec. |
| `scripts/check-chordpro-plan.ts` | One change: it takes `songToChordPro`, `chordProToSong` and its three types from `src/chordpro.ts` and `src/types.ts` in place of the reference. No case changes. |
| `scripts/check-music.ts`, `scripts/check-one-copy.ts`, `scripts/check-chords.ts` | The new N cases. In `check-music.ts`, the cases of the removed functions go. |
| `scripts/check-library.mjs`, `scripts/check-headers.ts`, `scripts/check-ux-datamuse-fix.ts`, `scripts/check-storage.ts`, `scripts/check-song-search.ts`, `scripts/check-song-start.ts`, `scripts/check-ux-metronome-sheet.ts` | Only the lines that name `bassNotes`, the table or a removed function, and positions that moved because the table is gone. |
| `package.json` | One line, `check:chordpro`. |

Do not touch: anything under `worker/`, any rule in `src/song-paste.ts`, `src/backup.ts`, `src/phone-db.ts`, `src/send-song-model.ts`, `src/gig-pack.ts`, `src/import-read.ts`, `src/song-import*.ts`, the learn and listen files, `docs/handoff/lead-sheets-data-export.json`, and `LIBRARY_KEY`.

## Shapes to freeze

`SongContent`, `SentSong`, `songToChordPro` and `chordProToSong` as plan section 1 gives them. Cooks 2 and 3 import them. The writer's output is frozen by cases C4, C5 and C6: two builds must write the same bytes for the same song. The examples those cases read are in the plan, and `check:chordpro-plan` keeps running them after this cook.

## The old build still reads what this build writes

A tab left open keeps running the build from before this cook. That build drops a stored song with no `bassNotes` field and writes the shorter library back. So this cook removes the type and every read, and still writes the field on a stored or sent song. Cases N11 and N12 hold this. The field ends in cook 3, when the library moves to a key the old build does not read.

## Empty and error states

The reader never throws (C12). A song with no chart, a section with no lines, and an empty heading each come back (C6). A song with no minor chord, and a song in a minor key, each show the numbers of section 2 (N5, N6).

## Checks

`npm run verify`. Removing a block from the sheet moves everything under it, so every check that pins a position on the sheet is in play. The closest ones: `check:chordpro`, `check:chordpro-plan`, `check:music`, `check:chords`, `check:data`, `check:headers`, `check:ux-datamuse-fix`, `check:ux-metronome-sheet`, `check:storage`, `check:phone-layout`, `check:screens`, `check:one-copy`, `check:portable`.

## Hints

- Worth writing the codec and its Node cases before touching `src/music.ts`. The two halves share no code. High.
- The sung line: split the chord row on spaces only, so a tab stays inside a token. Write the words up to the token's column, pad with spaces when the words are shorter, then the bracket. The reader counts word characters and pads the chord row to that count before each token. Trim spaces at the end of the words before writing. The plan's prototype needed that to make "one text" hold. High.
- `scripts/chordpro-plan-reference.ts` is the codec the plan measured: 31 of 31 real songs and 20,000 of 20,000 made-up ones hold on it. Port it into `src/chordpro.ts`, then delete it. Do not keep both. High.
- A sung line and a bar row on one chart line cross two sections: end the sung section, start a grid with no label, then `{x_join}`, then the row. The reader keeps a waiting `{x_join}` across the end and the start. The plan's examples show the bytes. High.
- A note that opens a section has no section open yet. Skip the lines after it that hold a note alone and look at the first other line: a grid when it is a bar row with no sung line, the heading's kind otherwise. A line with no field counts as a sung line here. The first rule the plan tried looked past that line, and the text then changed on its second writing. High.
- `src/chordpro.ts` imports `./song-text` without an extension, so `scripts/check-chordpro-plan.ts` cannot import it as it imports the reference. Bundle it with esbuild, as that check already bundles the old build. Medium.
- A directive's value runs to the last `}` on the line. Escape `\`, a line break and a carriage return in every value, and read `\n` and `\r` back before any other backslash pair. High.
- C2 calls the Worker's real `printOf`. Bundle `worker/room-library.ts` with esbuild, `platform: "neutral"`, `external: ["cloudflare:*"]`, and the JSON loader for the seed. The plan did this and got 31 equal prints of 31. High.
- Rule 8: widen the row pattern (`CHORD_RE`) to the spelling `parseChord` reads, keep its guards against a letter inside a word, and step over `N.C.` before matching. `namesChords` uses the same pattern, so run `check:song-paste`. High.
- After the seed loses its tables, its fingerprint on the phone changes. `mergeSeed` already swaps an unedited stored copy for the new seed. N12 proves the 15 songs do not turn into the player's own. Medium.
- `scripts/check-library.mjs` compares the seed with the handoff export, which keeps its tables. Compare every field but `bassNotes`. Medium.
- Check scripts are not type-checked. After the type goes, search `scripts/` for `bassNotes` by hand. Medium.
- A pinned pixel number measured in Edge on Windows can read 1 px off on the Linux runner. Measure moved positions the way the check already does, and say in the report where they were measured. Medium.
- A seeded run needs `Math.imul` for its generator, or it cycles. Low.
