# Cook brief: `chord-grab-canary`

Not queued. This brief waits for the owner's review. Model: Opus. Plan: `docs/PLAN-chord-grab.md`.

```text
## HANDOFF
GOAL: The Worker checks each listed chord site on a timer with one known song. A site whose chart can no longer be read is skipped by the next Grab with no deploy, and the owner can see each site's state at one address.
DECIDED: one cook, one branch, cook/chord-grab-canary off mls-int-20261113 after chord-grab-worker has merged; a cron trigger every 2 hours runs one site for each run, with at most two requests; the canary calls the same site code a Grab calls; the canary song is a field of each row in data/chord-sites.json and is a public domain song; the Directory keeps one row for each site with a verdict, a time and a count of failed runs; find skips a site after two failed runs and asks every site when all are marked; GET /api/grab/health is open and holds status words only.
REJECTED: a canary that runs in CI in place of the Worker's own; more than two requests in one run; a commercial song as the canary song; storing any page text or chart text; a health reply that holds page text; a test-only route; an address in the workflow file; a mark that can turn Grab off for good; new libraries; a deploy; edits outside the owned files.
DONE MEANS: cases C1 to C10 of plan section 3 each have a named check line that failed on the tests-only commit and passes now; the boxes under "Verification (cook 3)" in section 3 are ticked with their evidence in the report; npm run build and npm run check:portable are green; the workflow file is the last commit, or the report says that the push token lacks the workflow scope and gives the file in full.
SOURCE: docs/PLAN-chord-grab.md sections 2 and 3.
NEEDS OWNER: D11. The workflow file needs the workflow scope on the push token, which the owner grants with gh auth refresh -s workflow, and one repo variable that holds the Preview address of the health route.
```

# The canary

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full. The rule "never store fetched pages" covers the canary too.

## What the owner can do after this cook

1. Open `/api/grab/health` and read each site's verdict, the time of its last check, and its count of failed runs.
2. Get a mail from GitHub when a site has failed twice in a row, or when the canary has not run for a day.
3. Do nothing when a site breaks. The next Grab skips it.

No screen changes in this cook.

## Tests first

Commit 1 holds `scripts/check-grab-canary.ts` and its one `package.json` line, and nothing else. Cases C1 to C10 of plan section 3 fail on that commit. Paste the failing run into the report. Each case prints one named `ok` or `FAIL` line.

The check starts the Worker with `startApi` and points `GRAB_SITES_AT` at a stub server, as `scripts/check-grab-worker.ts` does. It moves the clock by passing the hour to `runCanary`, not by waiting.

## Owned files

| File | Change |
|---|---|
| `worker/grab-canary.ts` | New. `runCanary(env, now)` and the pure `judge(text)`. |
| `worker/directory-grab.ts` | The `grab_health` table, `noteCanary`, and the read that `find` and the health route use. |
| `worker/directory.ts` | Create the table, expose the two methods. |
| `worker/grab.ts` | `GET /api/grab/health`. |
| `worker/grab-sites.ts` | The walk skips a marked site. No recipe changes. |
| `worker/index.ts` | The `scheduled` handler. |
| `worker/wrangler.jsonc` | The cron trigger. |
| `data/chord-sites.json` | The `canary` field of each row. |
| `worker/README.md` | The health route, the timer, the table. |
| `scripts/check-grab-canary.ts` | New. |
| `scripts/chord-grab-live.ts` | A `--health <address>` switch that prints the route's reply. |
| `.github/workflows/grab-canary.yml` | New, and the last commit. |
| `package.json` | One line, `check:grab-canary`. |

Do not touch: `src/`, `public/`, the recipes in `worker/grab-sites.ts`, `worker/room*.ts`, and earlier check scripts.

## Shapes to freeze

```ts
export type Verdict = "ok" | "blocked" | "down" | "no-match" | "no-chart";
/** One line of GET /api/grab/health. A site that was never checked has `verdict: "unknown"` and `checkedAt: null`. */
export type SiteHealth = { id: string; verdict: Verdict | "unknown"; checkedAt: number | null; fails: number };
```

## Empty and error states, and the wired flow

With `GRAB_SITES` empty, a run sends no request and the health route returns an empty list. A site that was never checked says `unknown` and is not skipped. A run that throws leaves the row as it was, so a bug in the canary cannot mark a site. With every site marked, `find` asks them all.

Flow: the timer fires, one site is asked for its canary song, the Directory stores the verdict, `find` reads the marks on the next Grab, the health route shows them.

## The workflow file

The file runs once a day and on demand. It reads the address from a repo variable, fetches the health route, and fails when a site has `fails` of 2 or more or when the newest `checkedAt` is over 24 hours old. It holds no address, because `check:portable` scans `.github/workflows`. A run with no variable set passes with a notice, so a fork does not go red.

Commit the file last. If the push is refused for lack of the `workflow` scope, drop that commit, push the rest, and put the file in the report in full.

## Checks

`npm run build`, `check:grab-canary`, `check:grab-worker`, `check:api`, `check:one-copy`, `check:portable`.

## Hints

- Worth making `runCanary` call the same two functions the routes call, with no copy of the fetch. A canary that tests its own code proves nothing about a Grab. High.
- Worth picking the site from the hour, `Math.floor(now / twoHours) % sites.length`. The run then needs no stored cursor. High.
- Worth picking each site's canary song with one live request, and writing the title and artist that the site files it under into the row. E-Chords builds its address from the artist. High.
- Confirm first that one cron trigger in `worker/wrangler.jsonc` reaches both environments, and that the local Worker can fire `scheduled` for a check. The plan assumed both and tested neither. `check:portable` reads the config for both environments. High.
- `judge` counts chords with `isChord` from `src/song-text.ts`, and a bracket chord counts too. Medium.
- The health route is a `GET`, so the Origin rule for a `POST` does not guard it. It must hold nothing a stranger should not read. Medium.
- A live run of this cook sends 6 requests to real sites. Run it once. Medium.
