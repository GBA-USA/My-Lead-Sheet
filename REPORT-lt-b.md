## HANDOFF
GOAL: LT-B finish. The first LT-B cook (4 commits on cook/lt-b up to c94c23d) hit the 90-minute cap near the end. Finish it: commit the staged guard fix, prove the last two guards, run the final checks, write the REPORT, commit.
DECIDED: Opus (claude-opus-5-5) at max effort (MODEL-RULES.md, Terry t98s491); same worktree and branch cook/lt-b; no new features; stay in the files LT-B already owns
REJECTED: restarting LT-B from scratch; ScheduleWakeup or any background wait (run each long step in the foreground, one per Bash call, timeout 600000); push, deploy, wrangler, Live, Cloudflare Access; editing check scripts LT-B does not own
DONE MEANS: staged scripts/check-learn.ts fix committed; mutations M5 and M6 run and each makes its guard fail (or named with why); npm run build plus check:learn, check:heard, check:learn-songs, check:learn-words pass on the clean tree; REPORT-lt-b.md written in the worktree root starting with this HANDOFF block filled in; final commit on cook/lt-b.
SOURCE: C:\Users\order\cooks\briefs\BRIEF-lt-b.md (full LT-B brief and pass conditions); draft report C:\Users\order\cooks\scratch-lt-b\REPORT-lt-b.draft.md; mutation runner C:\Users\order\cooks\scratch-lt-b\tools\mutate.mjs; results so far C:\Users\order\cooks\scratch-lt-b\logs\mut\mutations.tsv (M1-M4 done, all caught)
NEEDS TERRY: none; keep moving
STATUS: Done. `4058dc7` commits the staged guard fix. M5 makes L5.5 fail and M6 makes L5.11 fail, so all six guards are proved by mutation (M1 to M6). `npm run build`, check:learn, check:heard, check:learn-songs and check:learn-words pass on the clean tree at `4058dc7`. This report is in the last commit on cook/lt-b, with a copy at `C:\Users\order\cooks\reports\REPORT-lt-b.md`, where the brief asked for it. Nothing is pushed.
EXPECTED FAILS: by design. Every L3, L5 and L8 case prints FAIL with "(pending until l3)", "(pending until l5)" or "(pending until l8)" and is not counted. check:heard 5, check:learn 7 (plus the old L1.2), check:learn-songs 13 (plus the old re-chart line), check:learn-words 13. A mark that holds fails its check, so each wave-B cook removes its own marks.
OPEN: five places where the tree and the plan disagree (I followed the tree), and five small crossings outside the named files. Both lists are below. The model escalation rule did not fire. No check this cook touched failed on a clean tree, in either session. The one red check on this laptop, check:chords, fails the same 3 lines on the untouched base.

## The LT-B brief's handoff
GOAL: LT-B, tests first for wave B, helper, Opus at max effort. Split `src/learn-analyze.ts` into the frozen `hearChords`, `hearSections`, `hearLines`; freeze `HeardCell`, `plays`, `lines` and the `storage.ts` mapping; write `splitLyrics`; write the failing L3, L5 and L8 cases.
DECIDED: Opus (claude-opus-5-5) at max effort runs this cook (MODEL-RULES.md, Terry t98s491; plan said Fable, but no resets are left and that planner model burns the weekly faster); one cook, one branch, commits only on cook/lt-b; stay in the owned files
REJECTED: Fable and Haiku (MODEL-RULES.md has no allow line for this cook); new libraries or servers; edits outside the owned files; editing check scripts this cook does not own; the chart as a default answer; any lyrics fetch; push, deploy, wrangler, Live, Cloudflare Access
DONE MEANS: Every numbered pass condition has its named test passing (or each unmet one named with why); `npm run build` green; work committed on the branch; REPORT written starting with this filled HANDOFF block.
SOURCE: LEARN-PLAN.md v2 section LT-B (Fable, Nov 16, 2026, 12:05 AM ET) with Terry's answers (STATUS t786u, t788u, t11u; CUT-LIST t816u, t818u, t838u); base origin/mls-int-20261113 at launch (it will include the B4p stack, #89 and #90; afe9c10 at Nov 21, 12:01 AM ET), plus any learn cooks this queue already merged locally
NEEDS TERRY: none; keep moving
STATUS: Done. The freeze keeps today's numbers. The nine splitLyrics cases pass. Each wave-B pass condition has its named case, and each case fails until its cook lands, as a tests-first helper's cases must. Each guard holds and fails under its mutation. `npm run build` is green, and the work is five commits plus this report on cook/lt-b.

## Commits

On `cook/lt-b`, base `5987ec7` (local `mls-int-20261113`, wave A merged: L0, L1, L2, LT-A). Not pushed.

1. `f7986bd` freeze(lt-b): split the engine into hearChords, hearSections and hearLines
2. `6151c02` test(lt-b): check:learn-words, splitLyrics cases and the L8 cases first
3. `eb0e6cb` feat(lt-b): splitLyrics reads pasted words into tagged blocks
4. `c94c23d` test(lt-b): the L3, L5 and L8 cases in check:heard, check:learn and check:learn-songs
5. `4058dc7` test(lt-b): time L3.12 and L8.10 with process.hrtime; check:learn fakes performance.now
6. The last commit adds this report.

## What changed

**The freeze (`f7986bd`), no behavior change.**
- `src/learn-sections.ts` (new): `novelty`, `sectionBoundaries`, `placeHeadings` and the texture half of `beatFeatures` (`beatTexture`) moved here unchanged, with `Bands` and `BeatFeatures`. `hearSections(features, beats, downbeatPhase, beatsPerBar, lyricBlocks)` returns the whole song as one section: `VERSE`, group `A`, band `check`.
- `src/learn-chords.ts`: `hearChords(chroma, low, beats, downbeatPhase, beatsPerBar)` returns one change opening each bar (and the pickup before bar 1), chord `null`, confidence 0. `LowView` is the frozen low view: `SongListener.push` hands it every sample, and until L3 fills it, it keeps nothing. `heardBars` and `SURE` stay, because the Review still uses them.
- `src/learn-words.ts` (new): `LyricBlock`, `splitLyrics`, `splitSyllables`, `hearLines` and `buildChart(sections, changes, lines, lyrics): ChartSection[]`. All stubs on the freeze.
- `src/learn-analyze.ts`: `analyze(beatsPerBar, lyrics = null)` calls `splitLyrics`, `hearChords`, `hearSections` and `hearLines` and returns their results in `changes`, `sections` and `lines`. `learnedVersion` writes kept bars as `HeardCell`s with band `likely`, and writes `plays` and `lines` (on the version's clock) when the Review passes them.
- `src/scroll-timing.ts`: `HeardCell { chord; band: Band | "set"; was? }`. `Learned.sections[].heard?: HeardCell[]`, plus `plays?`, `lines?` and `offset?`.
- `src/storage.ts` (the one edit): `isLearned` accepts `heard` as chord names or as cells, checks `plays`, `lines` and `offset`, and drops a version whose play or line names a section it does not have. `loadScrollVersions` maps a stored name to `{ chord, band: "likely" }`. `saveScrollVersions` keeps `heard` as chord names on disk and writes a `cells` list beside it only when a band is not likely.

**splitLyrics (`eb0e6cb`).** Blank lines and tag lines part the blocks. It reads `[Chorus]`, `Chorus:`, `(Chorus)`, `[Verse 2: Singer]`, `[Hook]`, `[Refrain]`, `[Pre Chorus]`, `[Middle 8]`, `[Guitar Solo]`, `[Interlude]` and a bare label line into a label and a number. A square-bracket tag that names no section, such as `[Post-Chorus]`, parts a block with label null. A block or a line marked `(x2)`, `[x2]`, `(2x)`, `x2` or `×2` comes back that many times. A tag with no words, or "Repeat chorus", sings the words of the last block with that label (Terry t838u). A verse tag with no words stays empty. The words are kept as written. Only the space around a line, the tags and the repeat marks are dropped.

**The cases (`6151c02`, `c94c23d`, `4058dc7`).** One case or more per pass condition, listed below. `4058dc7` fixes two guards. check:learn replaces `performance.now` with its frame clock, so L3.12 and L8.10 read 0 ms in every run before it and could not fail. They now time the pass with `process.hrtime.bigint()`.

## Tests: fail before, pass after

**The freeze keeps today's numbers.** Run on this laptop with Edge and the path shim, base `5987ec7` against the freeze `f7986bd`:

| check | base | freeze |
| --- | --- | --- |
| check:learn | 169 ok, pending L1.2 FAIL | 169 ok, pending L1.2 FAIL. Every line the same but L1.10's sampled progress text (0.98 against 0.99). L1.14 2924 ms against 2845 ms. |
| check:heard | 31 ok | 31 ok, lines byte-identical |
| check:learned | 58 ok | 58 ok |
| check:learn-songs | 67 ok, pending re-chart FAIL | 67 ok. The pending re-chart line now says "the listen timed no words", because a `buildChart` exists. |
| check:storage | ok | ok (with its updated cases) |
| check:one-copy, teach, scroll, bpm, portable, privacy | pass | pass |
| check:chords | 0 FAIL first run, 3 FAIL on rerun | 3 FAIL, byte-identical to base's rerun: Fire Away at 320 px, the known Windows font flake |
| npm run build | green | green |

**The storage mapping.** The new check:storage cases fail on base with 13 FAIL lines, each for its own reason (names stay names, any `plays` is accepted, no `cells`), and pass on the freeze. A probe (`scratch-lt-b/tools/old-build-probe.mjs`) saved versions with the new `storage.ts` and loaded them with base's. Base keeps all three (likely cells, colored cells with a pick, plays and lines and offset) and shows the plain heard row. After base writes them back, the new build loads them as saved, colors included.

**splitLyrics.** The nine L8.2 cases in check:learn-words fail at `6151c02` (the stub) and pass at `eb0e6cb`.

**The wave-B cases.** Each pending case fails on the freeze for the reason it names. Guards hold on the freeze and fail under a mutation that breaks what they guard (scripts in `C:\Users\order\cooks\scratch-lt-b\tools\mutate.mjs`, logs in `scratch-lt-b\logs\mut`).

The pending cases. Each one prints FAIL with its mark at `4058dc7`, and none is counted:

| check | cases | mark |
| --- | --- | --- |
| check:heard | L3.1, L3.7, L3.8, L3.9, L3.10 | l3 |
| check:learn-songs | L3.2, L3.3, L3.4, L3.5, L3.6, and L5.10's last chorus with its own Am | l3 |
| check:learn-songs | L5.2, L5.4, L5.6, L5.7 | l5 |
| check:learn-songs | L8.3 (clean set and mic case), L8.4, and the old re-chart line | l8 |
| check:learn | L5.1, L5.6 (tagged, untagged and pre-chorus), L5.8, L5.9, L5.12 | l5 |
| check:learn | the old L1.2, as LT-A left it | l1 |
| check:learn-words | L8.1 (two lines), L8.4, L8.5 (four lines), L8.6 (two lines), L8.7, L8.8, L8.9, and the chorus pasted once | l8 |

The guards. Each one holds at `4058dc7`. A mutation replaces one string in a scratch copy, runs the guard's check, and restores the file. Every mutated run exits 1, and its guard prints FAIL:

| guard | check | mutation | under the mutation |
| --- | --- | --- | --- |
| L3.11, the side view stays unused | check:learn-songs | M1: `src/learn-worker.ts` pushes a stereo message's left channel into the ear | L3.11 FAIL, the only counted FAIL |
| L3.12, the chord pass budget | check:learn | M2: a 7000 ms `Date.now` busy-wait in `hearChords` on a song over 500 beats | L3.12 FAIL, 7044 ms against a 6557 ms budget. L1.14 fails too, 9822 ms against 5245 ms, because the worker runs the same pass. |
| L8.10, the words pass budget | check:learn | M3: a 2000 ms busy-wait in `hearLines` when words are given | L8.10 FAIL, 2000 ms against a 1185 ms budget, the only counted FAIL |
| L5.3, at most one false boundary a song | check:learn-songs | M4: `hearSections` cuts a section every 8 bars | L5.3 FAIL, 24 songs with 2 to 6 false boundaries. L5.5 fails too, on the short last section of Two a Bar. |
| L5.5, no section under four bars | check:learn-songs | M5: `hearSections` opens with a 2-bar INTRO | L5.5 FAIL, "Amazing Grace, Slow beats 0 to 6" and the same INTRO in every song, the only counted FAIL |
| L5.11, a nudge stops one beat short of a neighbour | check:learn | M6: the nudge's `latest` in `src/learn-song.tsx` drops its `- 1` | L5.11 FAIL, CHORUS reaches beat 108, which is OUTRO's beat, the only counted FAIL |

M1's log is from 05:24, after `c94c23d` landed at 05:20. Its check and its mutated file are the same at `4058dc7`. M2 to M4 ran in `scratch-lt-b\mut`, which held `c94c23d` plus the staged fix, the same tree as `4058dc7`. The first session was stopped during M5, before the runner restored its file, so that tree kept the M5 edit in `src/learn-sections.ts`. M5 and M6 ran in a fresh `git archive` of `4058dc7` at `scratch-lt-b\mut-4058dc7`, whose 325 files match the commit. The old tree's one mutated file is restored.

## Scorecard numbers

No gate belongs to LT-B. These are wave B's gates before wave B, so L3, L5 and L8 have a before. B1 to B5 come from check:learn-songs, which has these cases from `c94c23d`, and A3 from check:learn's L1.14, on this laptop. The first session's run and the run at `4058dc7` give the same B1 to B5 numbers.

| gate | measure | before wave B |
| --- | --- | --- |
| B1 chords | clean root, major or minor, mic root | 0%, 0%, 0% (no chord named) |
| B2 calibration | green right, yellow right, unsure on clean | no green or yellow calls, 100% unsure |
| B4 sections | boundaries within one bar, repeat grouping, labels with words, labels from audio | 0% of 88, 12% of pairs, 31%, 33% |
| B5 words | line start error, chords on the exact syllable | no lines timed |
| A3 speed | L1.14 4:19 in the worker | 2445 ms against a 4630 ms budget at `4058dc7`. The freeze read 2845 ms against 5247 ms, and base 2924 ms. |

Six L1.14 runs on this laptop whose timed path no mutation touched read from 2425 to 2924 ms: base, the freeze, `c94c23d`, the M3 and M6 runs, and `4058dc7`. Their budgets read from 4630 to 6668 ms. The spread is wider than the 79 ms gap between base and freeze, so these runs show no speed change from the freeze.

## Where the tree and the plan disagree (I followed the tree)

1. **No count for "the novelty picks".** The plan has `hearSections` return the novelty picks. In this tree LT-A kept `Analysis.novelty` and the Review places chart headings with `placeHeadings` and the chart's count. `hearSections` has no count, so on the freeze it returns the whole song as one unsure VERSE. `placeHeadings` moved with `novelty` to `src/learn-sections.ts`, the file L5 owns, so L5 can replace it in place.
2. **No chart for "today's behavior as one change per bar".** Today's per-bar reading (`heardBars`) only names chords from the chart, and `hearChords` takes no chart. On the freeze it gives today's reading with no chart to read from: one change a bar, naming nothing. The Review keeps `heardBars`, so check:heard keeps its numbers. L3's wired flow says "the Review's bar row is derived from changes". That needs a `src/learn-song.tsx` edit that L3's owned files do not list. LT-C's Review split is the natural place.
3. **`lyricBlocks` is `LyricBlock[]`, not `string[][]`.** L5.6 reads `[Chorus]` tags, and a `string[][]` has dropped them. `hearSections` takes `splitLyrics`' blocks.
4. **`low` had no source.** No low view existed and L3 owns neither `SongListener` nor the worker. I froze `LowView` in `src/learn-chords.ts`, L3's file: the listener hands it every sample and it keeps nothing yet. L3 fills it (and may move its body to `src/learn-bass.ts`).
5. **The heard row on disk.** The plan's literal mapping would store `HeardCell[]` in `heard`. Today's build drops a version whose `heard` is not names, and its next write stores the shorter list. When only one phone changed a key since the last sync, backup takes that phone's value and every other phone writes it (`src/backup.ts` line 382), so the version is gone everywhere. That is the same hazard `withChordsOnly` and `EVEN_PACE` guard against. So `heard` stays names on disk with `cells` beside it, and `isLearned` still accepts `HeardCell[]` in `heard`. In memory the shape is exactly the plan's.

## Crossings outside the named files

- `src/sheet.tsx`, one expression: `heardRow(heard.map((cell) => cell.chord))`. The frozen `HeardCell[]` does not compile into `heardRow`'s string list, so the build would break without it. The row it draws is unchanged. L4b's second commit replaces this line with `<HeardRow>`. C18b and C21b, the 5b and 6b owners of this file, have landed.
- `src/learn-song.tsx`, one import line: `placeHeadings` from its new home.
- `src/learn-worker.ts`, one line: `analyze(message.beatsPerBar, message.lyrics)`. Without it L5 and L8 never see the player's words in the worker, and they own neither file.
- `scripts/check-storage.ts`: its heard-bar cases pinned the old in-memory strings. They now pin the frozen cells, the old-data mapping, the on-disk names and the new field checks.
- `package.json`: the `check:learn-words` line.

Not done, because this cook may not edit the file: a `check:one-copy` row that keeps `splitLyrics` in `src/learn-words.ts` alone. Worth adding by whoever owns that check.

## Checks not run, and Windows notes

- All runs used Edge on Windows with `C:\Users\order\cooks\briefs\reports\u8-v2-win-shim.mjs`, one check at a time, through `scratch-lt-b\tools\run-checks.sh`. The box verify uses Chrome on Linux.
- `npm run verify` was not run (bash plus flock). The fresh-tree verify reruns the suite.
- check:chords fails 3 Fire Away rows at 320 px here on base and head alike.
- The new `scripts/check-learn-words.ts` builds its paths with `fileURLToPath` and `path.join` and needs no browser, so it runs as is on Windows and Linux. Plain `npm run check:learn-words`, with no shim, gives the same result as the shimmed run.
- A `check:mirror` run from Nov 23, 1:27 PM (node PID 8936 and its headless Edge processes) was alive during the finish session's runs. It used 0.03 s of CPU in 5 s, so it was idle. This cook did not start it and did not stop it.

## Final checks on the clean tree

Run at `4058dc7` with a clean `git status`, one at a time in the foreground. The four checks ran through `scratch-lt-b\tools\run-checks.sh`. Logs are in `scratch-lt-b\logs\final`.

| run | exit | ok | FAIL lines, all pending | time |
| --- | --- | --- | --- | --- |
| `npm run build` | 0 | | | 6 s |
| check:learn | 0 | 172 | 8: seven l5 and the old L1.2 | 227 s |
| check:heard | 0 | 31 | 5, all l3 | 73 s |
| check:learn-songs | 0 | 70 | 14: six l3, four l5, four l8 | 134 s |
| check:learn-words | 0 | 11 | 13, all l8 | 28 s |

The guards at `4058dc7`: L3.11, L5.3, L5.5 and L5.11 hold. L1.14 reads 2445 ms against 4630 ms, L3.12 38 ms against 5787 ms, and L8.10 0 ms against 1031 ms.

## Leftover risk

- **The pending marks.** A wave-B cook must remove a mark when its case holds, or its check fails. check:learn keeps LT-A's lenient rule for the old `pending until l1` mark and applies the strict rule only to the new `l5` marks.
- **Contracts pinned by the cases.** L5.8 reads `data-band` on each heading's item, L5.12 expects number buttons 1 to 4 in the picker, L8.5 expects one built section per heard section. Each is written in the case's comment. A cook who needs another shape changes the case in its own file and says so.
- **The plan's text versus the cases.** L3.8's "Am or C/E" cannot be the reading over an A bass. The case accepts Am, Am7 or C on top, with both an A-minor and a C reading offered and confidence under the green floor. L5.6's "black" labels are checked as band `sure`, because `HeardSection.band` has no `set`. Drawing them black is the Review's job once words reach it (L9). L5.10's "Differs from the chorus at 1:18" is L4's why sheet. The case covers the part a listen gives, the last chorus's own Am, and is marked l3. L8.7's `Learned.lines` comes from the Review's Save, which sends no words yet, so the case checks that every lyric line gets a heard line. "A library song" became the generated songs' library-shaped charts, because no library song has audio.
- **Thin cases.** L8.9 rests on 3 changes in 2 songs (Susanna Strummed at 76, Holy, Holy, Holy). The chorus-pasted-once case, L5.9 and L5.10 rest on Gather at the River alone.
- **`--fit` on the freeze** would write green and yellow from 101, because every call has confidence 0. Only L3 runs it.
- **The guards' budgets.** L3.12 and L8.10 read "L1's number" as the recorded baseline L1.14 uses. L1.14 still binds the whole listen at 1.2 times.
- **L8.10 times two stubs.** It reads 0 ms at `4058dc7`, because `hearLines` and `buildChart` return at once. M3 shows its clock moves. The guard starts to bind when L8 fills those two functions.

## pstack skills loaded

First session: `/pstack:poteto-mode`, with the Claude Code adapter. Read and applied: technical-writing, unslop, principle-foundational-thinking, principle-boundary-discipline, principle-migrate-callers-then-delete-legacy-apis, principle-test-behavior-not-implementation, principle-sequence-verifiable-units, principle-prove-it-works, principle-laziness-protocol, principle-encode-lessons-in-structure.

Finish session: `/pstack:poteto-mode`, with the Claude Code adapter and the session-pickup playbook. Read and applied: principle-prove-it-works, principle-explain-the-number, principle-sequence-verifiable-units, technical-writing, unslop. The `/deslop` step was skipped, because the cursor-team-kit plugin is not installed on this laptop.
