# legal-quickfix self-check (branch cook/legal-quickfix, Nov 27 2026)

VERDICT: PASS
Pass 1 of 2. No P0, P1 or P2. Logs are in `C:\Users\order\cooks\reports\legal-quickfix-proof\` (outside the worktree).
Nits:
P3 | CLASS=other | scripts/check-legal-audit.ts:361 | With the Terms file missing, T3's detail reads "0 @ found". T1 names the real cause, and T3 still fails, so the case can still fail.
P3 | PRE-EXISTING | CLASS=other | scripts/build-privacy.ts:16 | `CONTACT_PLACEHOLDER` goes into the page without `escape`. It is a fixed string with no `&<>"'`, so nothing renders wrong today. Only `VITE_PRIVACY_CONTACT` is dynamic, and it is escaped.
P3 | CLASS=other | scripts/build-privacy.ts:54 | The page says "write to the contact below", and the contact names Brian Pruitt with details still to be added, so a reader cannot write yet. That waits on Terry and Brian (LEGAL-TODO rows 2 and 4). No address was made up.
P3 | CLASS=other | legal/TERMS-DRAFT.md:7 | After the literal swap, the placeholder list reads "[COMPANY NAME], Brian Pruitt (contact details to be added), and [STATE] will be filled in". The brief forbids any other change to the Terms, so it is left for a later edit (LEGAL-TODO row 3).

- Every new case fails before and passes after, on this Windows laptop with Edge and no path shim. Root case: red at 42b9884 ("root is /C:/.../lq-snap-42b9884/"), green from 15e48a2. MusicBrainz, STUN and Brian Pruitt contact cases: red at 15e48a2, green at fbb1372. T1-T4: red at 42b9884 and 15e48a2, green from e0e1750.
- Nine mutations on a HEAD snapshot each turn their own case red (M1 MusicBrainz line gone, M2 STUN line gone, M3 an https address on the page, M4 the old placeholder, M5 an @ in the placeholder, M6 the `.pathname` root, M7 one `[CONTACT EMAIL]` back, M8 an @ in the Terms, M9 `[COMPANY NAME]` filled in). The restored snapshot is green again.
- No case is weakened. The older "placeholder text, not an address" case still reads the live `CONTACT_PLACEHOLDER` and still forbids `@`.
- Does not apply: parameterized SQL and leader-only routes (no Worker or SQL change), CAN-SPAM (the app sends no email), auto-renewal (no paid plan). No analytics SDK, no new font host, no login wall or age step, and DMCA and copyright are untouched.

VERDICT: PASS
Nits:
P3 | PRE-EXISTING | CLASS=other | spike/server/drill.mjs:190 | check:spike-server failed both CI attempts at f63b714 on "relayed-ping spread p95 <= 8 ms" (87.7, 56.91 ms) and once on "room counted 278 leader messages, leader sent 281". This PR does not touch spike/ or worker/. No reproducing case for the spread failure and no fix here, so it can redden CI again. Details below.
P3 | CLASS=layout-width | src/styles.css:683 | Not changed. Folded under 430 px, the pill parts are unequal (46, 57 and 72 px), and from 430 to 539 px the text is 11 px. A layout change is not a small fix here. Left for the owner.
P3 | CLASS=layout-width | src/styles.css:640 | Not changed. Folded at 360 px a long key reads "A (pra?". Same reason.

# p2-view-pill deep fix round (PR 127, CI Deep verify run 46075520876 at f63b714)

- check:scroll-sync. Red at f63b714: exit 1 on "there is no album or radio-edit choice", because the raw-markup `/album|radio/i` match reads the DECIDED pill's `role="radio"` as a radio-edit choice (`.verify-logs/fix-deep127/red-scroll-sync-f63b714.log`). Fix in the check only, QUESTIONS.md item 1: `offersAlbumOrRadio` sets aside the role attributes of the one "Chord view" group, and four planted choices must still fail. Green: 11 of 11 ok, exit 0 (`green-scroll-sync.log`). Mutants `strip-all-roles`, `delete-pill` and `every-chord-view-group` each exit 1 on their own sample (`mutant-*.log`). No `src/` change.
- check:spike-server. Not caused by this PR. `git diff 6fdff5a f63b714 -- spike worker` is empty. It passes here at f63b714, exit 0. In CI it needed its retry on mls-int run 46058335766 and on p2-song-info run 46071174653, and passed on the first try in the same shard slot in run 46070754795. Under 16 CPU burners on this box it failed, exit 1, with "room counted 280 leader messages, leader sent 281" (`spike-server-under-load.log`). That is one of the two CI messages. The other, "relayed-ping spread p95 <= 8 ms", failed both CI attempts (87.7 and 56.91 ms) but not here: 3.47 ms under the same burners. Its cause is inferred, not reproduced: the code is identical to base, and the check passes in the same shard slot in other runs. Not changed here. It can redden CI again whatever this PR holds. Follow-up for the spike owner (inferred from the code, not traced): `spike/server/drill.mjs:166` reads `/stats` while followers are still pinging, so pongs the leader sends after that read count in `leaderSent` and not in `stats.leader`.

## Quick fix round verdict at f63b714 (superseded)

Its P0 (scripts/check-scroll-sync.ts:262) is closed by the deep fix round, QUESTIONS.md item 1. The quick round restored the line byte for byte and left the case red for the owner. Its two P3 nits are carried into the verdict above.

# p2-view-pill fix round (PR 127 laptop verify at 4efb12d)

Goal: each finding of the PR 127 laptop verify gets a case that fails on 4efb12d, then the smallest fix that makes the same case pass. Logs are in `.verify-logs/fix127/` (gitignored).

- P0, check:scroll-sync. Repro: a "Pace" radiogroup with Full and Short planted in SongControls. With the loosened 4efb12d line the case passes, exit 0 (`p0-pace-loosened.log`). With the restored line it fails, exit 1 (`p0-pace-restored.log`). `git diff 5e0549b^ -- scripts/check-scroll-sync.ts` is empty. Without the plant, the restored line also fails on the pill itself (`after-scroll-sync.log`, 1 failed). That conflict between the brief and the case is QUESTIONS.md item 1.
- P2, Up/Down. Cases first: V3 now presses ArrowDown and ArrowUp on Nashville and expects focus, choice and sheet to stay on Nashville. On 4efb12d V3 fails with "ArrowDown leaves focus on Nashville ("Chords only")" (`red-view-pill.log`). The fix maps keys in one table, `PILL_STEPS` (Left -1, Right +1), in `src/controls.tsx`, as brief item 4 says. Up and Down stay free for page-turn pedals. After the fix check:view-pill prints 16 of 16 ok, three runs in a row, exit 0 (`green-view-pill-1..3.log`). Mutation: adding `ArrowDown: 1` to the table turns only V3 red (`mutant-down.log`). QUESTIONS.md item 2 lets the owner choose the ARIA Up/Down instead.
- P2, EDGE-CASES.md. `C:\Users\guard\cooks\EDGE-CASES.md` gains EC-18 to EC-22: a themed color transition, a content regex matching an ARIA role, a long label beside a `flex: none` control, a breakpoint that does not fit at its own width, and a key handler taking keys no case presses. `grep -c -i -E "pill|transition|radio|long key|430"` counted 0 before and 5 after (`red-edge-cases.log`, `green-edge-cases.log`). The file is in no git repo, so no commit holds the rows.
- P3, full width under 430 px. V6 now asserts that at 360 and 390 px the pill's width equals the controls' content width within 1 px. It passes on 4efb12d too, because the layout was right and only the assertion was missing.
- P3, mutation proof strength (V6 `white-space`, V11 fill). Not changed. Both mutations already turn a case red.
- P3, check-ux-chords-only and check-ux-sheet-controls-save edits. Not changed. The verify judged neither a loosening. An owner may name them.
- P3, missing cook report. This section and the logs above are the evidence for this round. The earlier Gemini rounds are not re-run here.

Also run after the fix, all exit 0: `npm run build`, `check:portable`, `check:one-copy`. `check:scroll-sync` exits 1 on the one restored case and passes its other cases.

# Independent verify of PR 127 at 4efb12d

Its findings and notes are in the fix-round brief and in `C:\Users\guard\cooks\wt-verify-pr127\VERIFY.md`. The prior file follows verbatim.

# Prior VERIFY.md at 4efb12d (kept verbatim below)

VERDICT: FAIL
P2 | CLASS=other | scripts/check-legal-audit.ts:282 | The fix round weakened its own red case instead of fixing the doc. At 8ef171c D1 required the cited row to contain the host `musicbrainz.org` (red.log:53). 384ecc9 changed the matcher to the bare word `musicbrainz`. LEGAL-TODO.md has 0 occurrences of `musicbrainz.org`, so the 8ef171c D1 still fails on head with "row 5 does not mention musicbrainz.org". The fix brief required "the same case passes". The brief says a wrong case goes to QUESTIONS.md, not a looser matcher.
P2 | CLASS=other | scripts/check-legal-audit.ts:40 | The second prior P2 is only closed for DNS names. `ABSOLUTE_URL` needs a letter TLD (`\.[a-z]{2,}`), so a planted `dist/assets/i.js` with `s=document.createElement("script");s.src="https://203.0.113.5/x.js";document.head.append(s)` gives 0 findings (measured on a temp copy of the scanner). An injected script from an unlisted IP-literal host passes R2 and R2b, and LEGAL-TODO.md:15 still says the check "fails if any of those change".
P2 | CLASS=other | C:\Users\guard\cooks\EDGE-CASES.md:- | The fix round added no EDGE-CASES.md row (REVIEW.md P2). The file was last written Nov 27 04:40, before 384ecc9 (12:21), and has no row for "a scanner keyed on file extension misses HTML built in a .ts file" or "protocol-relative URL". The repo has no EDGE-CASES.md.
Nits:
P3 | CLASS=other | scripts/check-legal-audit.ts:94 | `distUrlRules` reads only .js, .html and .css. Planting `dist/manifest.webmanifest` with `{"icons":[{"src":"https://cdn.example.net/i.png"}]}` gives 0 findings, and the browser fetches manifest icons from that host.
P3 | CLASS=other | scripts/check-legal-audit.ts:71 | A Worker page in a .ts file with an inline `<script>` that sets `s.src='https://cdn.example.net/x.js'` or calls `navigator.sendBeacon('https://px.example.net/p')` gives 0 findings. The URL audit covers only dist/. Today's only Worker page (worker/codes.ts:202) has no inline script.
P3 | CLASS=other | scripts/check-legal-audit.ts:286 | D2 reads only worker/directory-account.ts. A signed-in profile route added in another Worker file (for example `POST /api/me/rename` in worker/directory.ts) passes D2 while LEGAL-TODO row 1 goes stale.
P3 | CLASS=other | VERIFY.md:1 | The diff replaces the base branch's VERIFY.md, which held another cook's chordpro findings. The merge into origin/mls-int-20261113 will drop them.
P3 | PRE-EXISTING | CLASS=other | scripts/check-privacy.ts:9 | `new URL("..", import.meta.url).pathname` is `/C:/...` on Windows, so check:privacy fails on the laptop (EC-06). Off-limits to this cook, listed as LEGAL-TODO row 7.

# Fix pass 2

Goal: every finding above is reproduced by a case that fails on the head before the fix, then fixed until the same case passes, with no case edited in between.

Two cases-first rounds. `f6e1e5e` holds the first cases alone, and on it `check:legal-audit` printed 9 FAIL and exit 1 (`.verify-logs/legal-fix2/red.log`). `8e7856f` fixed them. A review of that fix found four more gaps (below), so `613508f` adds cases alone, with 3 FAIL and exit 1 (`red2.log`). `0146ac6` fixes them. `e0d9813` adds L54 to pin one part of the fix that no case pinned. On `e0d9813` the check prints 67 ok, "passed" and exit 0 (`final-legal-audit.log`). From `f6e1e5e` to the head, `scripts/check-legal-audit.ts` removes 11 lines and edits no case (`removed-since-red.log`). Nine are scanner code (the file filters, `ABSOLUTE_URL`, the dist-only URL rule, D2's route key and its one-file read). One is the R2b label, which now names the Worker and `functions`. One is an existing check. D1's skip line `if (!cited) continue;` now also skips an audit row whose URL has no `//` host. For such a row D1's host is the empty string, which every row contains, so D1 could not fail there. D4 checks those rows instead, and M9 shows D4 bites. The added lines are cases L48 to L54, D4, the STUN audit row and scanner code. L51, L52 and L54 pass on the commit that adds them, because the fix they pin was already in. M1, M2 and M5 show each turns red without its part of the fix. Nine one-line mutations of the scanner and of LEGAL-TODO.md each turn a named case red, 9 of 9 (`mutate.mjs`, `mutate.log`).

- First P2. D1's host line and report line are back to the 8ef171c text byte for byte. D1 needs the cited row to contain the host `musicbrainz.org`. On the head it failed with "row 5 does not mention musicbrainz.org". The fix is in the doc. LEGAL-TODO row 5 now says "MusicBrainz (`musicbrainz.org`)". The loosened matcher from `384ecc9` is gone. Mutation M8 (row 5 without the host) turns D1 red. D1's skip line also passes over an audit row whose URL has no `//` host, because for those D1's `hostname` is empty and every row would match. D4 checks those rows instead (see the STUN item below).
- Second P2. L40 plants the reviewer's `s.src="https://203.0.113.5/x.js"`. L41 plants a protocol-relative IPv4 with a port. L42 plants an IPv6 host and a one-word host together, and L51 and L52 plant each alone, so dropping either branch fails a case (M1, M2). The root cause was a matcher keyed on host shape (a letter TLD). After a scheme, `ABSOLUTE_URL` now takes any host, whether a name, an IPv4 or a bracketed IPv6, with an optional port. A protocol-relative URL needs a dotted name or an IP, so `//` comments stay out. L47 shows that a version string such as `"1.2.3.4"` and local paths still pass.
- Third P2. `C:\Users\guard\cooks\EDGE-CASES.md` gains EC-12 to EC-16. They cover a scanner keyed on file extension, a protocol-relative URL, a matcher keyed on host shape, a fix round that loosened its own red case, and a matcher keyed on scheme. That folder is not a git repo, so the rows are in no commit. Before, `grep -c -i -E 'file extension|protocol-relative|host shape|loosen'` counted 0 (`red-docs.log`). After, it counts 4 (`green-docs.log`), and EC-16 came later. No check case reads that file, because CI has no copy of it.
- First P3. L43 plants the reviewer's `dist/manifest.webmanifest` icon, and L44 plants an SVG `<image href>` from an outside host. The class is a scanner keyed on file extension. In `dist/`, every file is now read unless it is binary or a source map (`NOT_TEXT`), and the URL rule has no extension filter of its own. L54 plants a `browserconfig.xml` tile icon, a type no rule names, and M5 (reading `dist/` by extension again) turns it red. Outside `dist/`, `TEXT_FILE` gains `.svg`.
- Second P3. L45 (an inline script sets `s.src`) and L46 (`navigator.sendBeacon`) plant a Worker page in `worker/landing.ts`. The URL audit now covers the script files of `worker/` and `functions/` as well as `dist/`. Neither holds an outside URL today. A server-side fetch or a doc link in a comment added there later needs an audit row, so a sibling cook may see R2b go red at merge for that reason. `worker/README.md` and `worker/wrangler.jsonc` are not read.
- Third P3. D3 plants `worker/directory.ts` with `POST /api/me/rename` in the `async "…"(c)` form and `POST /api/me/handle` in the `"…": Object.assign(async …)` form of `worker/codes.ts:117`. D2 now reads every script file under `worker/` and takes both forms. M7 (D2 reads `directory-account.ts` only) turns D3 red. On the real tree D2 still finds the same three routes, and row 1 names them. `8e7856f` also cut a route's body at the `}` that closes its object. Measured without the cut, D2 found the same three routes, so `0146ac6` removed it again.
- Fourth P3. This file keeps the base branch's VERIFY.md verbatim at the end, under its own heading, with fix pass 1's findings and notes above it. `git diff --numstat 4d4ba74 577a046 -- VERIFY.md` was `17 26` (26 base lines removed, `red-verify-numstat.log`). Against the head it is `66 0` (`green-verify-numstat.log`). Restoring the base file would also have kept the base lines, but it would have hidden this cook's findings from whoever reads VERIFY.md next.
- Fifth P3, pre-existing. Not changed. `scripts/check-privacy.ts` is off-limits to this cook and is already LEGAL-TODO row 7. On this laptop it still fails (`final-privacy.log`).

## Found while fixing, beyond the list

The new LEGAL-TODO closing sentence first claimed the audit "fails on any outside address". That was not true for `ws`, `wss`, `stun` or `turn`. L48 to L50 plant one of each and failed on `8e7856f`. Once the matcher read them, R2b failed on the real build with `stun:stun.cloudflare.com:3478` (`mid2.log`). That is `FREE_STUN` in `src/sync-history.ts:38`, which every live-gig link (`src/gig-live.tsx:220`) and Test now (`src/connection-setting.tsx:59`) use. It is an outside server that sees the phone's address, and the audit and the privacy page named it nowhere. It now has a `KNOWN_URLS` row citing new LEGAL-TODO row 8, for Terry to decide on a privacy line as in row 5. D4 checks that row 8 names the host, and it failed before row 8 was written (`mid2-d4.log`). M9 turns it red again. L53 shows that `{stun:C.stun}` object keys in the bundle are not read as addresses. The closing sentence now calls the check a tripwire, names the files and URL forms it reads, and names the forms it does not see. Probed on a temp copy of the scanner, these give 0 findings: a protocol-relative address after the first `srcset` entry, `"stun:relay:3478"` and a source map. Escaped slashes are listed as unseen from reading the regex (inferred). The probe of that form lost its backslashes in shell quoting.

## Verify on this laptop

`npm run verify` (`scripts/verify.sh`) ran on `b5f38ee`. The scanner commits after it change only `scripts/check-legal-audit.ts` and `LEGAL-TODO.md`, which only `check:legal-audit` reads. The runner stopped inside `check:ux-invite-links`, the 89th check, without its closing line, so the 12 checks it never reached ran through the same runner afterward (`verify/`, `verify-rest/`). Of 100 checks, 51 pass and 49 fail after the one retry. Five are the auth family, which exit 127 because Git Bash has no `flock`. 33 fail on the Windows path bug of EC-06 and LEGAL-TODO row 7 (`/C:/...` or `C:\C:\...`). 10 more, such as `check:bar`, `check:fit` and `check:ci-deep`, fail on an esbuild "Build failed" or a check of their own, and each also fails on base. The same 49 ran on the base `4d4ba74` through the same runner, and 48 fail there too. The one that passed on base, `check:mirror`, failed its clock-drift assertion on head (14 ms and 30 ms against 8 ms) while other runs loaded the box. Rerun alone on `e0d9813` it passes (`mirror-rerun.log`), and it reads no file this diff touches. On `e0d9813`, `check:legal-audit`, `check:portable` and `check:one-copy` exit 0 (`final-*.log`). No pass of this check suite is green on this laptop, on the head or on the base.

No file under `src/` or `worker/` changed. The diff touches `scripts/check-legal-audit.ts`, `LEGAL-TODO.md` and `VERIFY.md`. Nothing in `scripts/` or `package.json` reads them except `check:legal-audit` itself. `check-song-search.ts` and `song-search-live.ts` name VERIFY.md only in comments.

# Self-check pass 1 and fix pass 1 (as committed at 577a046)

VERDICT: FAIL
P2 | CLASS=other | scripts/check-legal-audit.ts:75 | The brief names "the Worker's HTML responses" and `@import url(http`, but `css-remote-load` runs only on .css/.html files, and the Worker's only HTML page is built in a .ts file (`worker/codes.ts:202`). A planted `worker/landing.ts` with `<style>@import url("https://fonts.example.net/a.css")</style>`, an `@font-face src:url(https://fonts.example.net/a.woff2)`, `<img src="https://px.example.net/p.gif">` or `<iframe src="https://embed.example.net/x">` gives 0 findings (measured on a temp copy of the scanner). Only `<link>`, `<script>` and the listed hosts are caught there, and R2 passes while claiming to cover the Worker pages.
P2 | CLASS=other | scripts/check-legal-audit.ts:38 | R2b says "every outside URL in the built bundle has an audit row", but `ABSOLUTE_URL` needs `https?://`. Planting `dist/assets/i.js` with `s=document.createElement("script");s.src="//cdn.example.net/x.js"` gives 0 findings, so a dependency that injects a protocol-relative script from an unlisted host passes R2 and R2b. LEGAL-TODO.md:16 then claims "check:legal-audit fails if any of those change".
Nits:
P3 | CLASS=other | LEGAL-TODO.md:7 | Row 1 says "No route edits a profile after sign-up except the password (worker/directory-account.ts:477)". The `google-link` flow (`worker/directory-account.ts:76,266,416`) lets a signed-in player attach Google, which stores an email (`:259`), after sign-up. The field list is still complete. Only the "after sign-up" claim is wrong.
P3 | CLASS=other | scripts/check-legal-audit.ts:36 | The MusicBrainz `KNOWN_URLS` reason says "LEGAL-TODO row 3", but MusicBrainz is row 5. Row 3 is the missing Terms draft.
P3 | CLASS=other | scripts/check-legal-audit.ts:41 | The R5 label rule needs a capital first letter and a fixed word list. `<button>subscribe now</button>` in dist/index.html and `children:"Go Premium"` in the bundle both give 0 findings. This is acceptable for a guard while item 5 is not-applicable, but a real paywall needs a human review.
P3 | CLASS=other | scripts/check-legal-audit.ts:13 | `TEXT_FILE` skips .jsx and .cjs, so `import "@sentry/react"` in `src/a.jsx` is not seen by `tracker-import`. The repo has no .jsx or .cjs files today, and the dist bundle scan is the backstop.
P3 | PRE-EXISTING | CLASS=other | scripts/check-privacy.ts:9 | `new URL("..", import.meta.url).pathname` is `/C:/...` on Windows, so check:privacy fails on the laptop before it reads a file (EC-06). It is off-limits to this cook and listed as LEGAL-TODO row 7.

# Fix pass 1

Goal: every finding above is reproduced by a `check:legal-audit` case that fails at `8ef171c`, then fixed until the same case passes.

Commit `8ef171c` holds the cases alone. On it the check printed 11 FAIL and exit 1 (`.verify-logs/legal-fix1/red.log`). After `384ecc9` it prints 50 ok, "passed" and exit 0 on a fresh `npm run build` (`.verify-logs/legal-fix1/green.log`). The real tree stays clean under the wider rules.

- First P2. L30 to L33 plant a Worker page in a `.ts` file with a `<style>` `@import`, an `@font-face` `url()`, an `<img>` and an `<iframe>` from outside hosts. `css-remote-load` now runs on every scanned file. A lookbehind keeps `new URL(` and `.url(` out. A new `third-party-embed` rule covers img, image, iframe, frame, video, audio, source, track, embed, object, input and form `src`, `srcset`, `data`, `poster`, `href` and `action`. L39 shows a same-origin `<img>`, a local `url()`, `new URL()` and a tapped `<a href>` still pass.
- Second P2. L34 plants `s.src="//cdn.example.net/x.js"` in `dist/assets/i.js`. `ABSOLUTE_URL` now also reads a `//host/path` that follows a quote, `(` or `=`. A protocol-relative URL is allowed only when its audited prefix matches with the scheme dropped.
- First P3. D2 reads the routes in `worker/directory-account.ts`. Every route that calls `signedIn(c)` and stores a sign-in field must be named in LEGAL-TODO row 1. Today that is passkey add, Google link and password. Row 1 now names all three, plus the email refresh on every Google sign-in. Mutations: the old row 1 fails D2, and a planted `POST /api/me/rename` fails D2.
- Second P3. D1 checks that each `KNOWN_URLS` reason citing a LEGAL-TODO row points at a row that names the service. The reason now says row 5. Mutation: putting back "row 3" fails D1.
- Third P3. L35 (`<button>subscribe now</button>`) and L36 (`"Go Premium"`). HTML control text is visible by construction, so it matches without a capital. Bundle strings keep the capital rule, because L28's lowercase ids must pass. Go, Get, Try or Join followed by Pro, Premium or Plus joins the word list. LEGAL-TODO's closing line says the rule is a tripwire and a real paywall needs a person to read it.
- Fourth P3. L37 (`.jsx`) and L38 (`.cjs`). `TEXT_FILE` and the script-file rules now take `.[cm]?[jt]sx?`.
- Fifth P3, pre-existing. Not changed. `scripts/check-privacy.ts` is off-limits to this cook and is already LEGAL-TODO row 7.

Also run, all exit 0: `npm run build`, `check:portable`, `check:one-copy`. No file under `src/` or `worker/` changed.

# Base branch VERIFY.md (chordpro-phone cook, kept verbatim for the merge into mls-int-20261113)

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

# p2-view-pill VERIFY.md (PR 127 head, kept verbatim for the merge into mls-int-20261113)

VERDICT: PASS

Nits:
P3 | CLASS=verification-scope | scripts/check-view-pill.ts:1 | Headless Chrome cannot launch inside this Windows sandbox, so V1ΓÇôV12, G1, the 9 mutations, and browser-based existing checks were statically verified (syntax check + TypeScript check + CSS cascade/contrast math) rather than executed live; full execution runs outside the sandbox via the harness and Linux Deep verify.
P3 | CLASS=build-sandbox | package.json:7 | `tsc --noEmit` exited 0; `vite build` failed twice inside the sandbox with transient Windows sandbox `EPERM: operation not permitted, mkdir 'node_modules\.vite-temp'`. Must be confirmed outside the sandbox.
P3 | CLASS=existing-check-layout | scripts/check-ux-chords-only.ts:304 | Updated open-state placement assertion at 360/390 px from beside-Key (with horizontal scroll) to own-row-below-Key with all three parts visible at once (`allSeen`), and kept folded-state beside-Key check intact; strictly tighter than before, reflecting the brief's DECIDED layout under 430 px.
P3 | CLASS=existing-check-layout | scripts/check-ux-sheet-controls-save.ts:472 | Updated `.controls` row-count expectation from literal `2` to `pixels < 430 ? 3 : 2` (exact equality) at lines 472 and 590 because the view pill takes its own row under 430 px (390 px) while remaining 2 rows at 1280 px.
P3 | CLASS=scope-boundary | src/bands.tsx:625-628 | When `/api/bands/open` fails offline, `offlineSongs` renders cached band songs using `<span className="band-library-name">{item.song.title}</span><small>{item.song.artist}</small>` without key/tempo. Left untouched because `src/bands.tsx` is outside the owned files for this cook.

# Self-check summary (Phase 2)

Reviewed all modified and added files (`src/song-row.tsx`, `src/song-row.css`, `src/library-lists.tsx`, `src/band-library.tsx`, `src/band-setlist-view.tsx`, `scripts/check-list-rows.ts`, `package.json`) against R1ΓÇôR10, the four song lists, signed-in/signed-out, empty/error states, 360 px layout rules, theme token usage, and the mutation table.

- **Verified in Windows sandbox (after final edit):**
  - `npx tsc --noEmit`: exit 0
  - `npx tsc -p worker`: exit 0
  - `npx vite build --configLoader native --outDir "$env:TEMP\vite-final"`: exit 0 (`170 modules transformed`)
  - `npm run check:one-copy`: exit 0 (all checks ok)
  - `npm run check:portable`: exit 0
  - SSR component & route verification (Node `esbuild` + `react-dom/server`): all 16 routes of `check:screens` and rendered markup for R1, R2, R3, R4, R5, R6, R7, R9 (button wrapper & signed-out hiding), R10 (`withSongData`) passed; all 6 mutations turned their target cases red.
- **Blocked by Windows sandbox / Windows path bugs (left for harness + Linux Deep verify):**
  - `npm run build`, `check:list-rows`, `check:phone-layout`, `check:song-import`, `check:new-song`, `check:chordpro-phone`, `check:library-consistency` hit `EPERM: operation not permitted, mkdir` inside the worktree (`node_modules\.vite-temp` and `worker\.wrangler\tmp`) because the sandbox shell ACL on the worktree is `(S,X)`, and headless Edge (`CHROME`) cannot spawn renderer processes inside the Windows AppContainer sandbox.
  - `check:search`, `check:band-library`, `check:ux-band-page`, `check:screens` fail at base on Windows due to pre-existing `new URL("..", import.meta.url).pathname` (`C:\C:\` / rollup `UNRESOLVED_ENTRY` / esbuild `resolveDir` errors).
