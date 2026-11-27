VERDICT: FAIL
P2 | CLASS=data-shape | docs/cooks/chordpro-phone.md:45 | Map row 12 says the phone reads the `/api/chat/setlist-copy` reply in either shape, but `src/setlist-code.tsx` is not an owned file and no P case covers a scan. After cook 3 the new phone sends the header and gets `{ chordpro }`, so `src/setlist-code.tsx:210` runs `addOwnSong({ ...item.song, copy })` on a value with no title or body and `:238` calls `songYouHave(songs, item.song)` on text. Scanning a copy code adds nothing usable. Only W8, on the Worker side, proves row 12.
P2 | CLASS=data-shape | docs/cooks/chordpro-phone.md:45 | `src/guest-rooms.tsx:16` fetches `/api/bands/library` itself, and `:41` reads `item.song.title`. The file is not owned and no P case covers it. After cook 3 the reply is `{ chordpro }`, so every row of a guest's setlist reads "A song the band took out".
P2 | CLASS=data-shape | docs/PLAN-chordpro-backbone.md:257 | The format gives no written form for a chart line that holds a sung line (chords or lyrics) plus `bars`. A sung line lives only in a non-grid section and a bar row only in a grid (table at :251-255), and `{x_join}` across `{end_of_verse}{start_of_grid}` is not defined. Yet C5 requires "each pair", and the brief freezes the format "to the byte". So cook 1 must invent bytes for `{lyrics:"la", bars:"| A |"}` (same for chords alone in a grid section). The brief's pass condition "every line kind" has no evidence for this one.
Nits:
P3 | docs/PLAN-chordpro-backbone.md:195 | "There is no blank line" contradicts :257 "a chart line with no field is written as an empty sung line", which is a blank line. C5 catches a wrong reading, but the spec should say it.
P3 | docs/PLAN-chordpro-backbone.md:225 | An empty heading (C6) has to be `label=""` so it differs from a start with no label (a continuation). The spec never writes that form.
P3 | docs/PLAN-chordpro-backbone.md:500 | The both-keys merge adds an old tab's late edit under a new id but never says which account owns it in per-account mode (`leadSheetsLeftBy`).
P3 | docs/PLAN-chordpro-backbone.md:153 | The plan lists `src/sheet.tsx` "near line 140" for the table from the brief. The heading is at :58 and `BassTable` at :116. Harmless, the plan names symbols.

# Fix pass 1

Goal: every finding above is reproduced by a check case that fails at `b7db81f`, then fixed in the plan and the briefs until the same case passes.

Check: `npm run check:chordpro-plan` (`scripts/check-chordpro-plan.ts`, with the plan's reference codec in `scripts/chordpro-plan-reference.ts`). Commit `90ebafe` holds the check alone. It printed 20 FAIL and exit 1 on the plan as it stood (`.verify-logs/fix1/red-at-b7db81f.log`). After the fix it prints 34 ok, "all passed" and exit 0 (`.verify-logs/fix1/green.log`). Seven one-line mutations of the fixed docs each turn it red again, 7 of 7 (`.verify-logs/fix1/mutate.mjs`, `mutate.log`).

- First and second P2, as one class. The root cause was a map written by hand from memory of the code. The check now finds the places itself: it types the four song replies as "may be text" on the tree at `61f18be`, runs `tsc`, and greps the callers of `content`. That gives 7 files where a song comes in and 5 that send one. `src/setlist-code.tsx` and `src/guest-rooms.tsx` are two of them, and `src/bands.tsx`, `src/library-lists.tsx`, `src/band-setlist-view.tsx` and `src/send-song.tsx` were missing as well. The plan gains the table "Where a song enters and leaves the phone", one door function `songFromSent`, one sender `sent`, and cases P14 to P16. The phone brief owns every file the table changes.
- Third P2. The plan gains "Every mix of the four fields, written": 22 examples, all 16 mixes of chords, lyrics, bars and note, plus five section shapes. A sung line with a bar row ends the sung section, starts a grid with no label, then `{x_join}`, then the row. The check writes each example with the reference codec and compares bytes, then reads it back. C5 and C6 read the same block.
- First P3. "The text as a whole" now says where an empty line may stand: one empty text line is a chart line with no field.
- Second P3. An empty heading is written `label=""`. The example block holds it.
- Third P3. "Whose it is" says a song taken in from an old tab carries the `leadSheetsLeftBy` mark of the old id. P4 proves it.
- Fourth P3. The plan names `src/sheet.tsx:58` and `src/sheet.tsx:116`. The check reads both lines at `61f18be`.

## Found while reproducing, beyond the list

The plan removed the old library key after its move. The old build's `pending` in `src/backup.ts` sends every synced key that is missing on the phone as removed, and an old tab backs up on a timer. Run against the old build's real code at `61f18be`: with the key removed, the next backup of an old tab sends 3 of 3 songs as removed. With the key left as it is, it sends none. With both old keys removed in one turn, it sends nothing at all. The plan now keeps the new library under `leadSheetsLibraryV2` and `leadSheetsBackupV2` and never writes or removes a key the old build reads while the account stays. The check runs this simulation on every run, and mutation M1 proves it bites. New risks R3a, R7a and R7b, case P17 and five lines of section 7 say what stays unproven.

The fuzz also broke one rule of the first format: a note that opened a section looked only at the next line, and a note, a line with no field and a bar row then changed on a second writing. The rule now skips note-alone lines and reads the first other line. 20,000 of 20,000 made-up songs and 31 of 31 real songs hold on the reference.

## Against the brief

The cook brief says no `package.json` edit and docs only. This pass adds one `check:*` line and two files under `scripts/`, because the fix-pass brief asks for a check case per finding and `CLAUDE.md` allows a cook exactly that line. `check:chord-grab-plan` and `check:bulk-import-plan` set the same precedent. No file under `src/` or `worker/` changed.

Also run after the fix, all exit 0: `npm run build`, `check:portable`, `check:one-copy`, `check:chord-grab-plan`, `check:bulk-import-plan`.
