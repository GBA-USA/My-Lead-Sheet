# Cook brief: `chordpro-phone`

Not queued. This brief waits for the owner's review and for `chordpro-worker` to merge. Model: Opus. Plan: `docs/PLAN-chordpro-backbone.md`.

```text
## HANDOFF
GOAL: The phone saves every song as ChordPro text, reads both shapes, tells the Worker it reads text, and keeps its library under a key an older tab cannot damage. A player sees the same songs, setlists, bands and backups as before, on every phone and across an account switch.
DECIDED: one cook, branch cook/chordpro-phone off mls-int-20261113 after chordpro-worker has merged; a stored song is { id, copy?, chordpro } and the screens keep the parsed Song model; the library lives under leadSheetsLibraryV2 and the backup state under leadSheetsBackupV2, each first filled byte for byte from the old key; the keys the old build reads are left as they are until the account on the phone changes, and what an old tab saves there is taken in as plan section 3 says; saving one song rewrites that song alone, and reading rewrites nothing; api() sends X-Song-Shape: chordpro on every call; a song from a reply, a phone store or a card is read through one function at the door, in each file the plan's table names, and no screen type changes; share, send and the copy code send { chordpro } through one function next to content, which keeps its meaning; a parsed song is kept by its text so a song is parsed once; the empty bassNotes list of cook 1 ends here.
REJECTED: converting the library on load; writing or removing a key the old build reads while the account stays; writing the old shape anywhere; any worker edit; any edit to printOf or the share rule; a change to a screen's layout; a Download .cho button; new libraries; edits outside the owned files.
DONE MEANS: cases P1 to P17 of the plan each have a named check line that failed on the tests-only commit and passes now; npm run check:chordpro-plan still passes; the report shows the time P12 prints and every earlier check that read the old key and why it changed; npm run verify is green, with the auth-family checks under the lock and any failure rerun once and explained.
SOURCE: docs/PLAN-chordpro-backbone.md sections 1 and 3, and risks R3 to R7 with R3a, R7a and R7b, R10, R14, R16 and R19.
NEEDS OWNER: Terry's answer to decision T7 before merge, not before the start. The owner deploys the Worker of chordpro-worker before this build reaches a phone.
```

# The phone saves text and reads both shapes

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 5 of the plan. Both apply in full.

## What the player sees

Nothing new on a screen. Songs, setlists, band songs, gig packs, song cards, copy codes and backups all work as before. The proof is in what is stored: a song saved after this cook rests as text, a song saved before it keeps its bytes until its next save, and a tab still running an older build can neither see nor damage the library.

## Tests first

Commit 1 holds `scripts/check-chordpro-phone.ts` and its `package.json` line `check:chordpro-phone`. Nothing else. Every case fails on that commit. Paste the failing run into the report.

The check has three parts:

- **Storage, in Node.** A bundle of `src/storage.ts` and `src/backup.ts` over a fake `localStorage`, as `scripts/check-storage.ts` and `scripts/check-backup.ts` do. Cases P1 to P4, P6, P8, P12 and P17. For P17 the fake `localStorage` refuses a write past a size the case sets.
- **The old build, in Node.** `src/storage.ts` and `src/backup.ts` of the build at `61f18be`, bundled from `git archive` with esbuild as `scripts/check-ux-settings-only-old-build.ts` does, run over the same fake `localStorage` after the new build has opened. Case P5, and the last step of P8 and of P17. `scripts/check-chordpro-plan.ts` already runs that build's backup this way.
- **Screens and the Worker.** The built app in the browser from `scripts/chrome.ts`, and the Worker started as `scripts/check-band-library.ts` does. This part begins with `tsc -p worker`. Cases P7, P9 to P11 and P13 to P16.

An "old-shape" fixture is a made-up song written the way the build at `61f18be` stores it, with its `bassNotes` list. For P14 to P16 a band song or a copy code "stored as old JSON" is a row set back by hand in the room's SQLite file, the way cook 2's W3 does it.

## Owned files

| File | Change |
|---|---|
| `src/storage.ts` | `LIBRARY_KEY` is `leadSheetsLibraryV2`, and the old name gets its own constant. The first copy, the taking in of an old tab's saves, and the one-library path of plan section 3. `songFromStored` and `songToStored`, the one reader and the one writer of a stored song. Every writer of a song writes text. A parsed song is kept by its text. The `bassNotes` helper of cook 1 goes. |
| `src/backup.ts` | `BACKUP_KEY` is `leadSheetsBackupV2`. An account change removes the three old-build keys. Besides that, only where it opens a song's value, such as giving a kept second copy its new id. The text inside is not touched. |
| `src/backup-keys.ts` | Only if a new key would otherwise be read as a backed-up value. None of `leadSheetsLibraryV2`, `leadSheetsBackupV2`, `leadSheetsLibraryTaken`, `leadSheetsLibrary` and `leadSheetsBackup` is one. |
| `src/sign-in-methods.ts` | `api` sends the header on every call. |
| `src/band-library-model.ts` | `WireSong` and `songFromSent`, the one door. `BandSong` keeps `song: SongContent`. |
| `src/band-library.tsx` | `sent`, next to `content`. `shareSong` calls `sent`. `content` does not change. |
| `src/send-song.tsx` | The send request calls `sent`. |
| `src/send-song-model.ts` | `songMessageIn` takes a card of either shape and gives the model. `SongSend.song` is `SentSong`. |
| `src/setlist-code.tsx` | The mint request calls `sent`. The reply of `/api/chat/setlist-copy` is read through `songFromSent` before `songYouHave` and `addOwnSong` see a chart. |
| `src/guest-rooms.tsx` | The reply of `/api/bands/library` is read through `songFromSent`. |
| `src/bands.tsx` | Both library calls and both store reads go through `songFromSent`. `holdBandSongs` gets the reply's songs as they came. |
| `src/gig-pack.ts`, `src/library-lists.tsx`, `src/band-setlist-view.tsx` | Each reads a song from the `gigPacks` or `bandSongs` store, or from the gig pack reply, through `songFromSent`. No store changes its name or version. |
| `src/phone-db.ts` | Types only: what the two stores hold, and what `holdBandSongs` takes, is `WireSong`. No store, key or version changes. |
| `src/types.ts` | The header comment: `Song` is the model the screens draw, and the stored form is text. |
| `src/data-kinds.ts` | One entry each for `leadSheetsLibraryV2`, `leadSheetsBackupV2` and `leadSheetsLibraryTaken`. The entries for `leadSheetsLibrary` and `leadSheetsBackup` say each is the earlier place, kept for a page opened before the update. |
| `scripts/check-chordpro-phone.ts` | New. |
| `scripts/check-one-copy.ts` | A row each for `songFromStored`, `songToStored`, `songFromSent` and `sent`, so no second reader, writer or door appears. |
| Earlier checks under `scripts/` | Only a line that reads the library key or the backup key back after a save, or that expects the old shape in what the phone stores or sends. Each one is listed in the report with its reason. |
| `package.json` | One line, `check:chordpro-phone`. |

Do not touch: anything under `worker/`, the writer and the reader in `src/chordpro.ts`, any rule in `src/song-paste.ts`, `src/music.ts`, the layout of `src/sheet.tsx`, `public/sw.js`, `src/App.tsx`, `data/library.json`, `scripts/check-chordpro-plan.ts`, and the held work named in plan section 6. `src/song-editor.tsx` and `src/song-import.tsx` call `content` and need no change, because `content` keeps its meaning. No other screen file changes either: `src/gig-plan.tsx`, `src/gig-songs.tsx` and `src/stage-bar.tsx` read a song that has already come through a door.

## The rules the phone keeps

- **Reading rewrites nothing.** Opening the app, opening a song, a sync that pulls, and an account switch each leave every stored song's bytes as they were. Backup, `leadSheetsLeftBy` and `leadSheetsSetAside` compare bytes. A song rewritten on read would upload itself from every phone, make false second copies, and show one account's songs to the next (plan risk R5).
- **One song a save.** A save writes the song that was saved as `{ id, copy?, chordpro }`. `id` and `copy` stay outside the text.
- **At the door.** A song from a reply, a phone store or a card is read through `songFromSent` in the file that makes the call or reads the store. The plan's table "Where a song enters and leaves the phone" lists each place, and `check:chordpro-plan` fails if the build at `61f18be` has one the table lacks. Past the door a screen holds `SongContent`, as today.
- **The old build's keys.** Never write `leadSheetsLibrary` or `leadSheetsBackup`, and remove them only at an account change or on a phone with no room for two libraries. An old tab that finds its library gone sends every song to the backup as removed (plan measured item 7). First open: copy each old value to its new key as the same string, without parsing it, before the app asks who is signed in. After that, take in what an old tab saved as plan section 3 says: by the notes in `leadSheetsLibraryTaken`, add and never overwrite.
- **Built-in songs.** An unedited built-in song stays the build's own copy inside the library value, as today. It never syncs. An edited one is the player's song and is saved as text.
- **Both shapes in.** A pulled backup row, a band song, a gig pack, a kept band song, a song card and a copy code's charts may each arrive in either shape for as long as old rows rest on the server.
- **Sharing.** The phone sends ids and lineage as today. Nothing here compares charts to decide what may be shared (`CLAUDE.md` rule 5).

## Empty and error states

- A refused write shows the message it shows today, and the song stays in the editor.
- A stored value that is neither shape is treated as an item the phone cannot show is treated today. This cook does not change that rule.
- A card or a pack the phone cannot read shows the words it shows today.
- A guest's Band setlists keep their two states: "The band has no setlists yet." and the error with Try again. "A song the band took out" shows only for a song the band no longer holds (P15).
- A scanner whose copy cannot be added still reads "This phone couldn't add" with the setlist's name, as today (P16).
- Signed out: the library is copied and saves as text with no account. No sheet is added.
- Offline: a send queued in the old shape before the update goes out once, as it is (P10). A gig pack opens with no network in either shape (P9).

## Checks

`npm run verify`, with the auth-family checks under the lock as `CLAUDE.md` says. The closest ones: `check:chordpro-phone`, `check:chordpro-plan`, `check:chordpro`, `check:chordpro-worker`, `check:storage`, `check:backup`, `check:band-library`, `check:send-song`, `check:setlist-code`, `check:chat-songs`, `check:gig-songs`, `check:guest`, `check:offline`, `check:song-import`, `check:new-song`, `check:chords`, `check:privacy`, `check:one-copy`, `check:portable`.

## Hints

- Worth writing `songFromStored`, `songToStored`, the first copy and the taking in with their Node cases before any screen file changes. High.
- Worth writing `songFromSent` and `sent` next, then changing the doors one file at a time with `tsc` after each. Typing what `api()` returns for the four song replies as "may be text" makes the compiler point at every door. High.
- `loadLibrary` writes the library back when its text differs from what was read. Parsing and writing a mixed library must give the same bytes for every song that was not saved. P2 compares each song's bytes through `ownLibraryItems`. High.
- The library is parsed by several functions on every write (`withOwnLibraryItems`, `freeOwnId`). Keep the parsed song out of those paths. Only `loadLibrary` and the readers for a screen need the model. High.
- Keep the parsed songs in a map from text to model, and hand each screen its own copy or a frozen one, so an edit in memory cannot change the kept one. Drop entries the library no longer holds. High.
- `backupOn` returns early when the stored state already names the account. So the first copy of the backup state has to land before `backupOn` runs, or the first open reads as an account change and removes the old keys. High.
- `readAll` in `src/backup.ts` backs up every `localStorage` key that `backupKindOf` knows. Make sure it knows none of the five library and backup keys. `check:privacy` and P6 show it. High.
- A band song is stored on the phone as the reply gave it. Hand `holdBandSongs` the songs before they go through the door, and do not write a parsed song back as an object. Medium.
- The old key can hold a large library. Look at it when the page opens and on a `storage` event for that key, not on every `loadLibrary`. Medium.
- 20 earlier checks seed `leadSheetsLibrary` to set up a phone. The first copy takes that value in, so most keep working untouched. Run the full verify before changing any of them, and change only the ones that fail. High.
- A page's library starts with the 15 built-in songs. A case that counts songs counts those too. Medium.
- Check scripts are not type-checked. After the stored type changes, search `scripts/` for fixtures of the old shape by hand. Medium.
- `src/App.tsx` is near its 500-line limit. This cook has no reason to open it. Medium.
- The service worker serves the new build to a fresh open and reloads nothing. Do not add a reload. The new keys, the untouched old keys and the backup rule are what keep an open old tab harmless. Medium.
- P12 fakes nothing: count calls to `chordProToSong` through a wrapper in the check's bundle, and time with `process.hrtime`. Low.
