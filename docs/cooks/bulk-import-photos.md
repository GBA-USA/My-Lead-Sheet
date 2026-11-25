# Cook brief: `bulk-import-photos`

Not queued. This brief waits for the owner's review, for decisions D2 to D5, and for a passing probe report. Model: Opus. Plan: `docs/PLAN-bulk-import.md`.

```text
## HANDOFF
GOAL: A photo or a scanned PDF in an import pile is read into a lead sheet by a vision model, after the player sees a clear notice and taps to send. The row arrives as Check this, with the photo beside the sheet.
DECIDED: one cook, one branch, cook/bulk-import-photos off mls-int-20261113 after bulk-import-pdf and bulk-import-photo-probe have merged; the model and the image size are the ones the probe report names, held in Worker variables (plan decision D3); the phone posts one page at a time to POST /api/import/read; the Worker stores a page count and nothing else; the player agrees for each batch and the answer is not remembered; a photo row is always Check this (plan decision D7); the privacy page gains one entry (plan decision D5).
REJECTED: on-device OCR; sending any file that was read on the phone; storing an image or a reading on the server; a remembered consent; a key or an outside address in src/ or in any committed file; a whole PDF sent in one request; joining two photos into one song; edits outside the owned files.
DONE MEANS: cases V1 to V11 of plan section 3 each have a named check line that failed on the tests-only commit and passes now; every box under "Verification for cook 4" is ticked with its evidence in the report; no check reaches the live service; tsc -p worker, npm run build, check:privacy and check:portable are green.
SOURCE: docs/PLAN-bulk-import.md section 3; docs/bulk-import-photo-probe.md.
NEEDS OWNER: D2, D3, D4 and D5 must be answered. The owner sets the API key on the Preview Worker with wrangler secret put before the live box. The owner reviews the notice on a phone before merge.
```

# Read photos and scans, after a clear notice

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full. The one library this cook may add is `@anthropic-ai/sdk`, in the Worker. Never deploy. `wrangler dev --local` is fine.

## What the player can do

1. Pick photos and scanned PDFs in the same pile as any other file.
2. See those rows wait as **Needs sending**, under one notice that says how many files would leave the phone.
3. Tap **Send 3 to be read**, or **Skip the photos**. Nothing is sent before the tap.
4. See each photo arrive as a **Check this** row. Tap it to see the photo above the sheet, and fix what the reader got wrong.
5. See a plain reason when a photo cannot be read, when the day's limit is reached, or when there is no connection. **Try again** reads the same row.

## Tests first

Commit 1 holds `scripts/check-song-import-photo.ts` and its one `package.json` check line, and nothing else. Every case fails on that commit. The check begins with `tsc -p worker`.

The cases are V1 to V11 in plan section 3. The check starts the Worker with `wrangler dev --local` and points it at a stand-in reader that the check itself serves. The stand-in returns fixed readings, a refusal, an error, and a slow answer. No case sends anything to the live service, and no case needs a key.

## Owned files

| File | Change |
|---|---|
| `worker/import-read.ts` | New. The route `POST /api/import/read`, the size check, the two limits, the model request, the refusal words. |
| `worker/directory.ts` | Merge the route into `ROUTES`. Create the count table. |
| `worker/index.ts`, `worker/wrangler.jsonc` | The variables: the model id, the image size, pages a day for an account, pages a month for the app, and an empty override for the reader's address that only checks set. |
| `src/import-photo.ts` | New. Opens an image, turns it upright, scales it, makes a JPEG, posts it, and maps each refusal to a reason. |
| `src/import-pdf.ts` | Draws a page with no text to a canvas, and hands it to the photo path. |
| `src/import-read.ts` | One line. The `image` entry of `READERS`. |
| `src/song-import.ts` | The waiting state for a row that needs sending, and the new reason words. |
| `src/song-import.tsx`, `src/song-import.css` | The notice, **Try again**, and the photo above the sheet in the row preview. |
| `src/data-kinds.ts` | One entry for the privacy page. |
| `scripts/check-song-import-photo.ts` | New. |
| `package.json` | One line, `check:song-import-photo`, and the `@anthropic-ai/sdk` dependency if cook 3 added it only for development. |

Do not touch: `src/song-paste.ts`, `src/storage.ts`, `src/song-editor.tsx`, `src/App.tsx`, `worker/share-guard.ts`, `worker/room-*.ts`, and earlier check scripts apart from entries that `check:privacy` requires.

## The route

- `signedIn(c)` gives the user or refuses. The body is read with `readJsonObject(request, maxChars)`. Every refusal is `throw new Refused(reason, status)`, with the reasons and statuses in the table of plan section 3.
- The limits are checked before the model is asked. The count is raised only after a reading comes back.
- The count table holds the user id, the day, and a number. No other column. No image, no reading, and no file name is written to any table or log.
- The model request asks for a structured answer with `is_chart` and `chordpro`, with the instruction from plan section 3. A refusal stop reason, `is_chart` false, and an empty `chordpro` are all the `unreadable` refusal.
- With no key set, the route answers `reader-off`, so a Worker without the secret fails kindly.

## Empty and error states, and the wired flow

Each refusal in the table of plan section 3 shows its own words. Offline, a waiting row says **Needs a connection to be read.** A retry sends the same row and can never add a second row. A scanned PDF that reaches the limit partway keeps the pages it has and says how many were left out. A photo type the browser cannot open is refused on the phone, before any request. **Skip the photos** leaves every other row untouched. Closing the sheet stops any read that is waiting.

Flow: My Songs, **Import files**, pick two photos and a text file, the notice, **Send 2 to be read**, three rows, fix one chord in the editor, **Save 3 songs**.

## Checks

`npm run build`, `check:song-import-photo`, `check:song-import`, `check:song-import-pdf`, `check:privacy`, `check:api`, `check:spend-guard`, `check:one-copy`, `check:portable`.

## Hints

- Worth reading `docs/bulk-import-photo-probe.md` first. The model, the image size, and the instruction that passed are the ones to build. High.
- Worth following the current Claude API documentation for the request. Thinking cannot be turned off on these models, so set the effort level explicitly. Check the stop reason before reading the content. High.
- A new `/api` prefix needs its entry in the Worker's path list for the Directory, or the request never reaches the route. High.
- Redrawing a photo on a canvas drops the camera's own data, the place included. Case V4 checks that the posted bytes carry none. High.
- `check:portable` scans `worker/` for a literal outside address. The SDK holds the service's address itself. The override variable for checks is empty in `wrangler.jsonc`. High.
- Worth keeping the photo's bytes in memory only for the life of the sheet, for the preview. Do not write them to any store. Medium.
- A bare request in a check sends the app's test origin, and the origin check answers 403 before the sign-in check answers 401. Order the cases for that. Medium.
