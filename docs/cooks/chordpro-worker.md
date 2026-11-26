# Cook brief: `chordpro-worker`

Not queued. This brief waits for the owner's review and for `chordpro-codec` to merge. Model: Opus. Plan: `docs/PLAN-chordpro-backbone.md`.

```text
## HANDOFF
GOAL: The Worker reads a song in either shape, stores band songs and copy-code charts as ChordPro text, answers each phone in the shape that phone asks for, and stops a build that cannot read text from syncing an account's backup once a ChordPro build has synced it. No phone changes, and no player sees a difference.
DECIDED: one cook, branch cook/chordpro-worker off mls-int-20261113 after chordpro-codec has merged; the Worker imports src/chordpro.ts; songIn takes the old object or { chordpro } and every stored song is the writer's own text; a row of old JSON is read as it is and is rewritten only by its next save; a caller that sends X-Song-Shape: chordpro gets { chordpro }, any other caller gets the old object with an empty bassNotes list; a DM song card is stored in the sender's shape; a band file is exported as text and imported in either shape; MAX_SONG_CHARS is measured on the text, and an old object still passes on its JSON; the first backup request with the header marks that account's room, which then refuses a backup request without it as 409 update-app.
REJECTED: any edit to printOf or worker/share-guard.ts; a statement that rewrites rows in bulk; opening or converting a backup value on the server; a second reader of a stored song; any phone change beyond the two data-kinds lines; trusting the header for anything but the shape of a reply and the backup rule; new libraries; edits outside the owned files.
DONE MEANS: cases W1 to W14 of the plan each have a named check line that failed on the tests-only commit and passes now, apart from the guard W9, which is green on both; the report lists every earlier check whose expected reply changed, with the reason; npm run verify is green, with the auth-family checks under the lock and any failure rerun once and explained.
SOURCE: docs/PLAN-chordpro-backbone.md sections 1 and 3, and risks R1 to R4, R8 to R11 and R15.
NEEDS OWNER: none to start. Nothing is deployed by the cook. The owner's deploy steps for the next release put this Worker before the phone build of chordpro-phone.
```

# The Worker reads both shapes and stores text

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 5 of the plan. Both apply in full.

## What the player sees

Nothing. Every phone still sends and receives the old shape after this cook. A band song shared or edited after it rests as text in the band's room. The cook is done when an old phone cannot tell the difference and a phone that sends the header gets text.

## Tests first

Commit 1 holds `scripts/check-chordpro-worker.ts`, its `package.json` line `check:chordpro-worker`, and the W14 line in `scripts/check-one-copy.ts`. Nothing else. Every case but the guard W9 fails on that commit. Paste the failing run into the report.

The check starts with `tsc -p worker`, then starts the Worker as `scripts/check-band-library.ts` does. It uses two kinds of `Phone` from `scripts/api-session.ts`:

- The **old phone** sends no header and the old object.
- The **new phone** passes `{ "x-song-shape": "chordpro" }` as the third argument of `call`, and sends `{ chordpro }`.

To see a stored row, and to set one back to the old shape, the check stops the Worker, opens the room's SQLite file with `node:sqlite`, and starts the Worker again on the same state folder. `scripts/check-gig-songs.ts` does this near its "saved before this cook" case.

Cases W5 and W7 hand the Worker's old-shape answer to code of the build at `61f18be`, bundled from `git archive` with esbuild as `scripts/check-ux-settings-only-old-build.ts` does: `isSong` through that build's `src/storage.ts`, and `songMessageIn` from that build's `src/send-song-model.ts`.

## Owned files

| File | Change |
|---|---|
| `worker/room-library.ts` | `songIn` takes both shapes and gives the parsed song. `storedSong(text)` reads a column of either shape. `songText(song)` is the writer. One function makes the old-shape answer. `band_songs.song` and each item of `setlist_sends.songs` are written as text. The limit is measured as plan section 3 says. |
| `worker/room-notes.ts`, `worker/room-gig.ts` | Read a band song through `storedSong`. |
| `worker/room-export.ts` | Export `{ chordpro }`. Import either shape through `songIn`. |
| `worker/directory-inbox.ts` | A song card is stored in the sender's shape. The setlist card's titles come from parsed songs. The reply of `setlist-copy` is in the caller's shape. |
| `worker/directory-http.ts` | One helper that says whether the caller asked for text. |
| `worker/room-backup.ts` | The table `backup_shape`, the mark, and the refusal `409 update-app`. The value of a backup row is never opened. |
| `worker/room.ts`, `worker/room-members.ts` | Only what is needed to answer `/api/bands/pack` and the gig pack in the caller's shape. |
| `src/data-kinds.ts` | One entry for `backup_shape`, in plain words. One changed line for `band_songs` if its words name the shape. |
| `scripts/check-chordpro-worker.ts` | New. |
| `scripts/check-one-copy.ts` | The W14 line. |
| Earlier checks under `scripts/` | Only an expected reply that changed because an old-shape answer is now a whole song. Each one is listed in the report with its reason. |
| `package.json` | One line, `check:chordpro-worker`. |

Do not touch: the body of `printOf`, `isCommon`, `guardContent`, `worker/share-guard.ts`, `worker/codes.ts`, `src/chordpro.ts`, any other file under `src/`, `data/library.json`, and the held work named in plan section 6.

## Shapes to freeze

- The header: `X-Song-Shape: chordpro`. Any other value, or none, means the old shape.
- A sent song: `SentSong` from `src/chordpro.ts`, wherever a request or a reply holds `song` today.
- An item of `setlist_sends.songs`: `{ chordpro, print, shareId }`.
- The backup refusal: status 409, reason `update-app`.

Cook 3 builds against these four.

## The rules the server keeps

- **The server decides.** The header chooses the shape of a reply and arms the backup rule. It gives no permission and skips no check. Membership, the share rule and the limits run before the reply is shaped (`CLAUDE.md` rule 4).
- **The share rule decides the same.** `printOf` runs on the parsed chart of either shape. A print stored today for a chart is the print computed for it after this cook (W12). Sharing is still judged by ids and lineage (rule 5).
- **Lazy.** A read never writes. An old row turns into text when a member edits that song, and at no other time.
- **Parameterized SQL.** Every new statement binds its values.

## Empty and error states

- `{ chordpro }` that is not a string, has no title, has a title over 200 chars, or is over the limit: `400 bad-request`, as a bad song is today (W13).
- A stored row that is neither JSON nor text the reader knows still gives a song. The reader never throws, so a band's library never fails to list because of one row.
- An old phone refused by the backup rule gets `409 update-app` and no rows. Nothing about the account is in the refusal (W10).
- A copy code minted before this cook still gives its charts (W8).

## Checks

`npm run verify`, with the auth-family checks under the lock as `CLAUDE.md` says. The closest ones: `check:chordpro-worker`, `check:chordpro`, `check:band-library`, `check:band-move`, `check:send-song`, `check:setlist-code`, `check:chat-songs`, `check:gig-songs`, `check:guest`, `check:backup`, `check:share-guard`, `check:song-notes`, `check:privacy`, `check:one-copy`, `check:portable`.

## Hints

- Worth one small module-level pair in `worker/room-library.ts`, `storedSong` and `songText`, written and tested before any route changes. Every route then changes by one call. High.
- A column of old JSON starts with `{"`. The writer's text starts with `{title`. Test the first two characters, not a `try` around `JSON.parse`. High.
- `songIn` lets unknown fields ride along today. After this cook it keeps the fields plan section 1 names and gives a missing or wrong fact its empty value. `scripts/check-gig-songs.ts` sends a song of three fields, so do not refuse a short song. High.
- Some earlier checks compare a whole reply with the song they sent. `scripts/check-band-library.ts` does, with a built-in song. An old-shape answer is now a whole song with every fact and an empty `bassNotes` list. Compare the chart and the facts that were sent. Do not loosen anything else, and list each such change. High.
- Let the room answer with the stored song and shape the reply in one place on the way out. A room method that grows a "shape" argument in ten places is the wrong turn. The 409 of `edit-song` carries `current`, so the refusal path needs the same shaping (W6). High.
- A song card's body is one stored string that goes to both phones over the socket. Do not shape it for the reader. Store what the sender's shape says (plan change 6). High.
- The backup request reaches the room through `enterRoom` in `worker/index.ts`, which forwards the request with its headers. The room can read the header from the request it already has. Medium.
- The mark is one row. Set it with `INSERT OR IGNORE`, and read it before the changes are applied, inside the same transaction as the rest of the request. Medium.
- `check:privacy` finds every `CREATE TABLE` and fails when `src/data-kinds.ts` does not describe it. Medium.
- `CLAUDE.md` lists a minter for `my-setlist` codes as obsolete. `worker/codes.ts` holds one, and the copy code needs it. Trust the code, and say so in the report. Medium.
- A new phone's library reply can return the stored text with no parse. Only an old phone's answer, and an old row, cost a parse. Low.
