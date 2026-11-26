# Cook brief: `chordpro-phone`

Not queued. This brief waits for the owner's review and for `chordpro-worker` to merge. Model: Opus. Plan: `docs/PLAN-chordpro-backbone.md`.

```text
## HANDOFF
GOAL: The phone saves every song as ChordPro text, reads both shapes, tells the Worker it reads text, and keeps its library under a key an older tab cannot damage. A player sees the same songs, setlists, bands and backups as before, on every phone and across an account switch.
DECIDED: one cook, branch cook/chordpro-phone off mls-int-20261113 after chordpro-worker has merged; a stored song is { id, copy?, chordpro } and the screens keep the parsed Song model; the library key becomes leadSheetsLibraryV2 and the old key is carried over as plan section 3 says, byte for byte on the first load; saving one song rewrites that song alone, and reading rewrites nothing; api() sends X-Song-Shape: chordpro on every call; share, edit, send and the copy code send { chordpro }; every reader on the phone takes both shapes; a parsed song is kept by its text so a song is parsed once; the empty bassNotes list of cook 1 ends here.
REJECTED: converting the library on load; a second library value kept beside the first; writing the old shape anywhere; any worker edit; any edit to printOf or the share rule; a change to a screen's layout; a Download .cho button; new libraries; edits outside the owned files.
DONE MEANS: cases P1 to P13 of the plan each have a named check line that failed on the tests-only commit and passes now; the report shows the time P12 prints and every earlier check that read the old key and why it changed; npm run verify is green, with the auth-family checks under the lock and any failure rerun once and explained.
SOURCE: docs/PLAN-chordpro-backbone.md sections 1 and 3, and risks R3 to R7, R10, R14, R16 and R19.
NEEDS OWNER: Terry's answer to decision T7 before merge, not before the start. The owner deploys the Worker of chordpro-worker before this build reaches a phone.
```

# The phone saves text and reads both shapes

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 5 of the plan. Both apply in full.

## What the player sees

Nothing new on a screen. Songs, setlists, band songs, gig packs, song cards, copy codes and backups all work as before. The proof is in what is stored: a song saved after this cook rests as text, a song saved before it keeps its bytes until its next save, and a tab still running an older build can neither see nor damage the library.

## Tests first

Commit 1 holds `scripts/check-chordpro-phone.ts` and its `package.json` line `check:chordpro-phone`. Nothing else. Every case fails on that commit. Paste the failing run into the report.

The check has three parts:

- **Storage, in Node.** A bundle of `src/storage.ts` and `src/backup.ts` over a fake `localStorage`, as `scripts/check-storage.ts` and `scripts/check-backup.ts` do. Cases P1 to P4, P6, P8 and P12.
- **The old build, in Node.** `src/storage.ts` of the build at `61f18be`, bundled from `git archive` with esbuild as `scripts/check-ux-settings-only-old-build.ts` does, run over the same fake `localStorage` after the new build has moved the library. Case P5.
- **Screens and the Worker.** The built app in the browser from `scripts/chrome.ts`, and the Worker started as `scripts/check-band-library.ts` does. This part begins with `tsc -p worker`. Cases P7, P9 to P11 and P13.

An "old-shape" fixture is a made-up song written the way the build at `61f18be` stores it, with its `bassNotes` list.

## Owned files

| File | Change |
|---|---|
| `src/storage.ts` | `LIBRARY_KEY` is `leadSheetsLibraryV2`, and the old name gets its own constant. The move of plan section 3. `songFromStored` and `songToStored`, the one reader and the one writer of a stored song. Every writer of a song writes text. A parsed song is kept by its text. The `bassNotes` helper of cook 1 goes. |
| `src/backup.ts` | Only where it opens a song's value, such as giving a kept second copy its new id. The text inside is not touched. |
| `src/sign-in-methods.ts` | `api` sends the header on every call. |
| `src/band-library-model.ts` | One function reads a song from a reply or from a phone store, in either shape. The reply types say a song may be `SentSong`. |
| `src/band-library.tsx` | `content` gives `{ chordpro }`. |
| `src/send-song-model.ts` | `songMessageIn` takes a card of either shape. |
| `src/gig-pack.ts`, `src/library-lists.tsx`, `src/band-setlist-view.tsx`, `src/bands.tsx` | Each reads a song from the `gigPacks` or `bandSongs` store through the one function. No store changes its name or version. |
| `src/types.ts` | The header comment: `Song` is the model the screens draw, and the stored form is text. |
| `src/data-kinds.ts` | One entry for `leadSheetsLibraryV2`. The entry for `leadSheetsLibrary` says it is the earlier place and is moved on the next open. |
| `scripts/check-chordpro-phone.ts` | New. |
| `scripts/check-one-copy.ts` | A row each for `songFromStored` and `songToStored`, so no second reader or writer appears. |
| Earlier checks under `scripts/` | Only a line that reads the library key back after a save, or that expects the old shape in what the phone stores or sends. Each one is listed in the report with its reason. |
| `package.json` | One line, `check:chordpro-phone`. |

Do not touch: anything under `worker/`, the writer and the reader in `src/chordpro.ts`, any rule in `src/song-paste.ts`, `src/music.ts`, the layout of `src/sheet.tsx`, `src/phone-db.ts`, `public/sw.js`, `src/App.tsx`, `data/library.json`, and the held work named in plan section 6.

## The rules the phone keeps

- **Reading rewrites nothing.** Opening the app, opening a song, a sync that pulls, and an account switch each leave every stored song's bytes as they were. Backup, `leadSheetsLeftBy` and `leadSheetsSetAside` compare bytes. A song rewritten on read would upload itself from every phone, make false second copies, and show one account's songs to the next (plan risk R5).
- **One song a save.** A save writes the song that was saved as `{ id, copy?, chordpro }`. `id` and `copy` stay outside the text.
- **The move.** First load: copy the old key's value to the new key as the same string, then remove the old key. Do not parse it on the way. Both keys present: follow plan section 3, add and never overwrite. If the browser has no room for either way of moving, show the library from the old key for this load and try again on the next.
- **Built-in songs.** An unedited built-in song stays the build's own copy inside the library value, as today. It never syncs. An edited one is the player's song and is saved as text.
- **Both shapes in.** A pulled backup row, a band song, a gig pack, a kept band song, a song card and a copy code's charts may each arrive in either shape for as long as old rows rest on the server.
- **Sharing.** The phone sends ids and lineage as today. Nothing here compares charts to decide what may be shared (`CLAUDE.md` rule 5).

## Empty and error states

- A refused write shows the message it shows today, and the song stays in the editor.
- A stored value that is neither shape is treated as an item the phone cannot show is treated today. This cook does not change that rule.
- A card or a pack the phone cannot read shows the words it shows today.
- Signed out: the library moves and saves as text with no account. No sheet is added.
- Offline: a send queued in the old shape before the update goes out once, as it is (P10). A gig pack opens with no network in either shape (P9).

## Checks

`npm run verify`, with the auth-family checks under the lock as `CLAUDE.md` says. The closest ones: `check:chordpro-phone`, `check:chordpro`, `check:chordpro-worker`, `check:storage`, `check:backup`, `check:band-library`, `check:send-song`, `check:setlist-code`, `check:chat-songs`, `check:gig-songs`, `check:guest`, `check:offline`, `check:song-import`, `check:new-song`, `check:chords`, `check:privacy`, `check:one-copy`, `check:portable`.

## Hints

- Worth writing `songFromStored`, `songToStored` and the move with their Node cases before any screen file changes. High.
- `loadLibrary` writes the library back when its text differs from what was read. Parsing and writing a mixed library must give the same bytes for every song that was not saved. P2 compares each song's bytes through `ownLibraryItems`. High.
- The library is parsed by several functions on every write (`withOwnLibraryItems`, `freeOwnId`). Keep the parsed song out of those paths. Only `loadLibrary` and the readers for a screen need the model. High.
- Keep the parsed songs in a map from text to model, and hand each screen its own copy or a frozen one, so an edit in memory cannot change the kept one. Drop entries the library no longer holds. High.
- 20 earlier checks seed `leadSheetsLibrary` to set up a phone. The move takes that value in, so most keep working untouched. Run the full verify before changing any of them, and change only the ones that fail. High.
- A page's library starts with the 15 built-in songs. A case that counts songs counts those too. Medium.
- Check scripts are not type-checked. After the stored type changes, search `scripts/` for fixtures of the old shape by hand. Medium.
- `src/App.tsx` is near its 500-line limit. This cook has no reason to open it. Medium.
- The service worker serves the new build to a fresh open and reloads nothing. Do not add a reload. The new key and the backup rule are what keep an open old tab harmless. Medium.
- P12 fakes nothing: count calls to `chordProToSong` through a wrapper in the check's bundle, and time with `process.hrtime`. Low.
