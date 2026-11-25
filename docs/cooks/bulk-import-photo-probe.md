# Cook brief: `bulk-import-photo-probe`

Not queued. This brief waits for the owner's review, for decisions D2 and D4, and for the sample photos. Model: Opus. Plan: `docs/PLAN-bulk-import.md`.

```text
## HANDOFF
GOAL: A committed script measures how well each candidate model reads a photo of a chart (chord names read, chords over the right word, declines) and what a page costs, on photos with a known right answer and on the owner's own photos. The photo cook then builds on a number.
DECIDED: one cook, one branch, cook/bulk-import-photo-probe off mls-int-20261113; the script calls the reading service with the official SDK (plan decision D4) and a key from the environment; three models (Claude Opus 5.5, Sonnet 5.5, Haiku 5.5) at two image sizes; set A is three charts with made-up words that the owner photographs, scored by the script; set B is the owner's own files, never committed; the pass line is 90 percent of set A's chords over the right word, no photo under 80 percent, and no decline.
REJECTED: any app code under src/ or worker/; any key, photo or reading in the repo, in a log or in the report; chart text of set B in any output inside the repo; on-device OCR as a build target, which the plan measured and rejected; any screen.
DONE MEANS: cases Q1 to Q6 in the brief each have a named check line that failed on the tests-only commit and passes now; scripts/photo-read-probe.ts runs from one command; docs/bulk-import-photo-probe.md holds the table for set A (each model and size: chord names, same word, declines, tokens, dollars a page) and the counts for set B; the report names the model and size it recommends, or says that no model passed; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-bulk-import.md section 3.
NEEDS OWNER: D2 and D4 must be yes. The six photos of set A and the set B folder, as plan section 7 asks. An API key in the laptop's environment as ANTHROPIC_API_KEY.
```

# Measure how well a vision model reads a photo of a chart

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. This cook builds a script and a table. It changes no file under `src/`, `worker/`, or `public/`.

## What the cook delivers

1. Three charts with made-up words, as HTML pages, each with its right answer as chart text with inline bracket chords. One is monospace. One has each chord in a box over its words, as a chord site prints it. One is typed by eye in a proportional font.
2. A request to the owner, in the first report: print the three pages or open them on a second screen, and photograph each twice. Once flat in good light. Once at an angle in dim light.
3. `scripts/photo-read-probe.ts`, which takes the set A folder, the set B folder, and an output folder, all outside the repo.
4. `docs/bulk-import-photo-probe.md`, with the results table and no chart text from set B.

## Tests first

Commit 1 holds `scripts/check-photo-probe.ts` and its one `package.json` line, and nothing else. The check uses a stand-in model that returns fixed readings, and it reaches no service.

- Q1. The scorer gives every chord as read and as over the right word when the reading equals the right answer.
- Q2. A reading with one chord over the next word scores one miss on the same word, and none on chord names.
- Q3. A reading with one chord name wrong scores one miss on chord names.
- Q4. A decline, an empty answer, and an answer that is not a chart each score zero and are counted as declines.
- Q5. The table writer prints one row for each model and size, with chord names, same word, declines, input tokens, output tokens, and dollars a page from a price table in the script.
- Q6. With set B as input, no line of the table and no line of standard output holds any text of a reading. The readings go only to the output folder.

## Owned files

| File | Change |
|---|---|
| `scripts/photo-read-probe.ts` | New. A script a person runs. |
| `scripts/check-photo-probe.ts` | New. |
| `tests/fixtures/import-photo/` | New. Three HTML charts with made-up words, and their right answers. |
| `docs/bulk-import-photo-probe.md` | New. The results. |
| `package.json` | One line, `check:photo-probe`, and `@anthropic-ai/sdk` as a development dependency. |

Do not touch: everything under `src/`, `worker/`, and `public/`, and earlier check scripts.

## How the script reads a photo

- It sends one image and one instruction for each read, and asks for a structured answer with two fields, `is_chart` and `chordpro`.
- The instruction is the one in plan section 3: copy the page as printed, put each chord in brackets before the syllable it sits over, write section names and printed facts as ChordPro directives, write `?` for a chord that cannot be read, and add nothing that is not on the page.
- It runs each photo at full size and scaled to 1568 pixels on the long edge.
- It reads the token counts from the service's own answer, and never estimates them.
- It scores set A by passing the reading through `readPaste` and `parseSheet`, then comparing each chord's word with the right answer. Bundle those two with esbuild, as `scripts/check-song-paste.ts` does.
- A refusal, an answer cut off at the token limit, and an error after the SDK's own retries are each counted. None stops the run.

## The pass line, and what to do on each side of it

A model and size pass when at least 90 percent of set A's chords are over the right word, no photo is under 80 percent, and no photo is declined. The report recommends the cheapest pair that passes, and gives the full table so the owner can pick another. If nothing passes, the report says so plainly, and `bulk-import-photos` is not queued.

## Checks

`npm run build`, `check:photo-probe`, `check:portable`.

## Hints

- Worth following the current Claude API documentation for the request shape. Thinking cannot be turned off on these models, so set the effort level explicitly and start at low. Check the stop reason before reading the content. High.
- Worth keeping the key out of every output. Read it from the environment, and print no request headers. High.
- Keep live runs few. One full run is about 100 reads and costs at most about 8 dollars. Run set A once, read the table, then decide whether set B needs every model. High.
- Worth writing the price table as one constant with the date it was read, because prices change. Medium.
- A model may decline to copy a page of printed lyrics. Count it, and quote the stop reason in the report, without the page's text. Medium.
