# My-Lead-Sheet rules

Read this first. A bass player's lead-sheet app: a React phone app in `src/`, a Cloudflare Worker with two
SQLite-backed Durable Objects (Directory and Room) in `worker/`, and executable checks in `scripts/`.
The plan is `/workspace/mls-social-plan-2026-11-13/PLAN.md`. Where this file and the plan disagree, say so in your report.

## Verify

- `npm run verify` builds, then runs every `check:*` script in package.json. Logs land in `.verify-logs/`
  (gitignored; `VERIFY_LOG_DIR` moves them). A failed check is retried once. Exit code is non-zero if any still fails.
- One check: `npm run check:<name>`, for example `npm run check:one-copy`. A subset through the same
  runner: `npm run verify -- check:codes check:bands`.
- Headless Chrome checks use `scripts/chrome.ts`, which reads `CHROME` (default `/usr/bin/google-chrome`).
- Auth-family checks (`check:auth`, `check:account`, `check:google`, `check:password`, `check:backup`) are the
  slow, timing-sensitive ones (600,000-round PBKDF2 sign-ins, password wait rules, a mock Google) and fail under
  load, so on a shared box they run one at a time under `flock /tmp/mls-auth-checks.lock`. `scripts/verify.sh`
  does this for you. Running one by hand on a shared box: `flock /tmp/mls-auth-checks.lock npm run check:password`.
- Known flaky under load: `check:spike-links` (WebRTC "no path" timeout), `check:password`, `check:band-settings`.
  `check:google` hung once with an empty log while headless Chrome spawned gpu processes in a loop (repo-setup,
  Nov 15 2026). Rerun once before calling a failure real. A second failure is yours to explain.
- `scripts/verify.sh` stops a check that runs past `VERIFY_CHECK_TIMEOUT` seconds (default 1200) with its whole
  process group, so a hung Chrome or Worker cannot hold the auth lock forever. Exit code 124 in summary.tsv
  means the timeout stopped it. The longest honest check seen is 652s.
- A new feature ships with a check that fails before and passes after. Checks print `ok  ` / `FAIL` lines and
  exit 1 on any FAIL (see `scripts/check-one-copy.ts` for the smallest one).
- Deep cooks run under a Stop hook that re-runs `npm run verify` before you may finish. Fix the code; never edit
  `.claude/` or the checks to get past it.

## Top rules

1. Chords stay exactly over their syllable. Anything touching the sheet or layout keeps `check:chords` green.
2. Real data lives in Durable Object SQLite (Directory for accounts, friends, codes, band index; Room for one
   band, DM or personal room). `localStorage` is only this phone's offline cache and backup (`src/storage.ts`,
   `src/backup.ts`). No mock or local-only storage for shared data.
3. No hard-coded Cloudflare account ids, domains, origins or emails. They come from `worker/wrangler.jsonc` vars
   and `env`. `check:portable` enforces this.
4. The server enforces permissions. Admin, member, removed member and guest are decided in the Worker
   (`worker/room-members.ts`, `worker/share-guard.ts`), never trusted from the phone.
5. Sharing and privacy are judged by ids and lineage (`worker/share-guard.ts` `lineage`, `checkSend`), never by
   matching content or print. Two players can hold identical charts, such as the built-in library.
6. A friend code scanned in person sends a request the other person accepts. Never instant friends.

## Current patterns, one example each

- Screen: `src/friends.tsx`. A sheet component, mounted from `src/App.tsx`, `useEscape(onClose)` for Escape,
  `api` from `src/sign-in-methods.ts`, a `MESSAGES` map from refusal reason to the words the player sees.
- Worker route: `worker/room-members.ts` `BAND_ROUTES`. A `Record<string, Route>` keyed `"POST /api/bands/join"`,
  merged into `ROUTES` in `worker/directory.ts`. `signedIn(c)` from `worker/directory-http.ts` gives the user or
  refuses. Refuse with `throw new Refused(reason, status)` from `worker/refused.ts`; the reason is the machine word
  the phone branches on.
- Shared helpers, one home each (`check:one-copy` guards these):
  - `useEscape` in `src/hooks.ts`
  - `readJsonObject(request, maxChars)` in `worker/refused.ts`
  - `cookieValue(header, name)` in `worker/session.ts`
  - `normalizeHandle` and `handleFromName` in `src/handle.ts`
  - hash routes `parseHash` and `songHref` in `src/route.ts`
- Codes and links: kinds in `src/code-link.ts` `CODE_KINDS`; the Worker mints only kinds with an entry in
  `worker/codes.ts` `MINTERS`, every other kind is `400 bad-kind`. `liveCode` checks the signature before the table.
- Checks: `scripts/check-<name>.ts`, run with `node --experimental-strip-types`, registered as `check:<name>`
  in package.json. A check that starts the Worker begins with `tsc -p worker` so the Worker type-checks first.

## Obsolete patterns, do not reintroduce

- An inline `keydown` Escape effect in a sheet. Use `useEscape`.
- Parsing the `Cookie` header inline with `split(";")`. Use `cookieValue`.
- Ad-hoc `JSON.parse(await request.text())` in a route. Use `readJsonObject`.
- A minter for `my-setlist` codes. That kind is refused on purpose; verify cooks check for `400 bad-kind`.
- Deciding "same song" or "already shared" by comparing print, title or content. Use ids and lineage.
- Copying a helper into a second file. Add it to its home and import it.

## Merge seams

After merging another branch (`origin/mls-int-20261113` or a sibling cook) re-check imports that moved homes,
ids and keys that both sides touch (codes `target_id`, route keys, localStorage keys, table columns), and rerun
the checks that cover both sides, not only your own.

## Must handle in every feature

- Signed out: a visitor opening any link (band, friend, code, setlist) can sign in or close the sheet and
  continue. Never trapped.
- Second phone or account switch on a shared phone: edits kept, nothing leaks between accounts.
- Old, expired, reset or wrong links fail kindly: a clear message, no blank page, no data in the refusal.
- Offline or slow network wherever the feature talks to the server: queue or a clear retry, no duplicates on
  reconnect.
- Empty states and error states, not only the happy path.

## Working rules for cooks

- Stay inside the files your brief owns. Add your `check:*` line to package.json and nothing else there.
- No new libraries. Copy the pattern of the file your brief names.
- Never deploy, never `wrangler deploy` or `--remote`. `wrangler dev --local` is fine.
- Never kill a process you did not start. Stop only PIDs you started.

## Rules added after repeat mistakes

Add a line here when a verify catches the same class of bug a second time. Oldest first.

1. Sharing or privacy decided by content match instead of ids and lineage (band-library-verify P2-1).
2. A signed-out visitor trapped in the sign-in sheet after opening a link (bands-verify P2-1).
3. Merge seams left unchecked: imports, codes `target_id` and the backup-send path after merging a sibling
   branch broke `check:band-settings` (int-merge, PR #48).
4. A helper copied into a second file instead of imported from its home: 11 copies found (cleanup-mid,
   `check:one-copy`).
5. Calling a failure a flake, or a flake a regression, without the one rerun that tells them apart
   (cleanup-merge `check:spike-links`, teachtempo-verify `check:bar`).
6. Auth-family checks run alongside other cooks' checks and failing under load, so every brief since
   bands-verify runs them under the flock (bands-verify, bands-verify2).
