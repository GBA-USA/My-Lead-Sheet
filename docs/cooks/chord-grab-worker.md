# Cook brief: `chord-grab-worker`

Not queued. This brief waits for the owner's review. Model: Opus. Plan: `docs/PLAN-chord-grab.md`.

```text
## HANDOFF
GOAL: The app's Worker can find a song on the listed chord sites, in fallback order, and return one chart page as plain text that readPaste turns into a sheet. Nothing fetched is stored, and the Worker fetches no address outside the site table.
DECIDED: one cook, one branch, cook/chord-grab-worker off mls-int-20261113; two POST routes under /api/grab/ answered in the Worker's entry, with one small Directory call for the session and the counts; the site table is data/chord-sites.json and the site code is one record in worker/grab-sites.ts; the sites and their order are Chordie, GuitarTabs.cc, E-Chords (plan decision D4); robots.txt is honored (D2); the client is honest (D3); the limits are those of D8; GRAB_SITES is the off switch, set for env.test and empty for env.production (D1); smart paste runs on the phone.
REJECTED: storing or caching any page, search HTML or chart text; a fetch of an address that is not in the site table; a browser disguise, a proxy, a cookie replay or a CAPTCHA solver; a search of Ultimate Guitar; the fetch inside the Directory object; HTMLRewriter or any parser the node check cannot run; a second chart reader or any edit to src/song-paste.ts; a site named in src/ or worker/; a fetched page as a fixture; new libraries; a deploy; edits outside the owned files.
DONE MEANS: cases W1 to W18 of plan section 2 each have a named check line that failed on the tests-only commit and passes now; the boxes under "Verification (cook 1)" in section 2 are ticked with their evidence in the report; scripts/chord-grab-live.ts was run once from the laptop and its table is in the report; npm run build and npm run check:portable are green.
SOURCE: docs/PLAN-chord-grab.md sections 1 (the shapes), 2, 3 and 5.
NEEDS OWNER: D1 to D4 and D8 answered before this cook starts. After it merges and Preview is deployed, gate G1 (plan section 7) is run once.
```

# The Worker finds and fetches a chart

Read `CLAUDE.md` first, then "Rules every brief below inherits" in section 6 of the plan. Both apply in full. The owner lifted the rule "the app never fetches chord pages" for this feature. The rule "never store fetched pages" stays.

## What the app can do after this cook

1. `POST /api/grab/find` with a title and an artist returns the first listed site that has the song, and up to 8 rows.
2. `POST /api/grab/page` with one of those addresses returns the page's title, artist, and chart as plain text.
3. `GET /api/auth/config` says whether Grab is on.

No screen changes in this cook.

## Tests first

Commit 1 holds `scripts/check-grab-worker.ts` and its one `package.json` line, and nothing else. Cases W1 to W18 of plan section 2 fail on that commit. Paste the failing run into the report. Each case prints one named `ok` or `FAIL` line.

Cases W1 to W8 run in node on the recipes. Every fixture is HTML that the check writes in the shape of the site's page, with made-up words. Cases W9 to W18 start the Worker with `startApi` from `scripts/api-session.ts` and point `GRAB_SITES_AT` at a stub server on `127.0.0.1` that the check starts.

## Owned files

| File | Change |
|---|---|
| `data/chord-sites.json` | New. One row for each site: `id`, `name`, `origin`, `find` or `built`, `page`. |
| `src/chord-grab.ts` | New. The types of plan section 1 and nothing else. |
| `worker/grab.ts` | New. The two routes, the guards, the limits, the User-Agent. |
| `worker/grab-sites.ts` | New. `RECIPES`, and the walk through the sites in order. |
| `worker/grab-html.ts` | New. Pure helpers that every recipe shares. |
| `worker/directory-grab.ts` | New. The `grab_use` table and `allowGrab`. |
| `worker/directory.ts` | Create the table, expose `allowGrab`. |
| `worker/index.ts` | The `/api/grab/` branch, and the new `Env` fields. |
| `worker/directory-account.ts` | The `grab` field of `GET /api/auth/config`. Nothing else. |
| `src/sign-in-methods.ts` | The `grab` field of `AuthConfig`. Nothing else. |
| `worker/wrangler.jsonc` | `GRAB_SITES`, `GRAB_SITES_AT`, and `GRAB_HOUR_MS` in both environments. `GRAB_SITES` holds the three ids for `env.test` and is empty for `env.production`. |
| `worker/README.md` | The routes and the variables. |
| `scripts/check-grab-worker.ts` | New. |
| `scripts/chord-grab-live.ts` | New. A script a person runs. |
| `scripts/check-one-copy.ts` | New rows only. |
| `package.json` | One line, `check:grab-worker`. |

Do not touch: `src/song-paste.ts`, `src/song-text.ts`, `src/song-search.ts`, `src/song-search.tsx`, `src/song-editor.tsx`, `public/`, `worker/room*.ts`, `worker/codes.ts`, `worker/session.ts`, and earlier check scripts apart from the new rows in `scripts/check-one-copy.ts`.

## Shapes to freeze

`GrabSite`, `GrabMatch`, `GrabFound`, `GrabbedChart`, `GrabStop`, and `GrabState` exactly as plan section 1 gives them. Cooks 2, 3, and 4 import them. The refusal reasons and their statuses are the table in plan section 2. The phone branches on those words.

`RECIPES` is a record from site id to a recipe. A later cook adds a site with one row, one recipe, one fixture, and one canary song.

## Refusals and the wired flow

Every refusal in the table of plan section 2 has a case. A refusal holds a reason word and, for `slow-down`, a `waitMs`. It holds no page text and no address.

Flow: sign in, `find` with a title and an artist, take the first row's address, `page` with that address, pass the text to `readPaste`.

## The live script

`scripts/chord-grab-live.ts` is not a `check:*` script. It has two modes.

- With no switch, it sends five songs from `data/library.json` straight to the three sites through the recipes. That is at most 30 requests. It prints one line for each site and song: the answer, the chords on the sheet, the time. A hand run names a generic client and no origin, as `scripts/song-search-live.ts` does.
- With `--worker <address>`, it enters that server as a preview account and sends the same five songs through `find` and `page`. Gate G1 uses this mode. The cook does not run it against a deployed server.

Run the first mode once and put the table in the report. Do not run it in a loop.

## Checks

`npm run build`, `check:grab-worker`, `check:api`, `check:auth` under the flock, `check:headers`, `check:song-paste`, `check:one-copy`, `check:portable`.

## Hints

- Worth writing the three recipes and cases W1 to W8 in node before any route. The plan's prototype needed about ten lines for each site. High.
- Worth sending a boxed site as bracket text, `[G]Hey where did we [C]go`. `parseSheet` reads brackets, and a chord in a bracket cannot drift off its syllable. High.
- Worth dropping tags without touching a space on the two `<pre>` sites. The columns are the alignment. High.
- Worth reading the reply through a reader that stops at 1 MB. Do not call `response.text()` on a body of unknown size. High.
- Worth importing `fold` from `src/search.ts` for the title match. Do not copy it. High.
- `/api/grab/` is answered in `worker/index.ts`. Do not add it to `DIRECTORY_PATH`. The landed Origin check sits inside the `DIRECTORY_PATH` branch, so the new branch calls `fromApp` itself, before it reads the session. A request with the wrong Origin gets 403 before 401, so a check call sends the test Origin. Medium.
- `allowGrab` reads the session and writes the count in one synchronous segment, as the comment on `signedIn` in `worker/directory-http.ts` asks. Medium.
- An old site can send Latin-1. Decode with the charset of the reply's header. Medium.
- For W17, `startApi` takes a folder for saved state. Search every file in that folder for the marker word. Medium.
- The E-Chords address is built from lower-case words joined by hyphens. The plan tried one song. Try an artist with "The" in front in the live run. Medium.
- The plan's probe sent Chordie a longer search address than the one in the site table. Try the short one first. Low.
