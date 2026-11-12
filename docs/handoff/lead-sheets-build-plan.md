# Lead Sheets — Project Analysis & Build Plan

_Written by Cooper, 2026-11-11, from the working app and a full day of Brian's hands-on feedback. Companion files in this folder: `lead-sheets-app-handoff.md` (the behavior spec — the contract for HOW everything must work), `lead-sheets-data-export.json` (the library data — the contract for WHAT the app holds), `screenshots/` (layout reference)._

_Rule for anyone building from this plan (Cursor included): where this plan and the handoff spec disagree on behavior, the spec wins. Where they disagree on data, the JSON export wins._

---

## 1. What this project is

A personal lead-sheet app for one user: Brian, a bass player learning his instrument, who plays live (including a church worship set on 2026-11-29) from a phone or tablet on a stand. A "lead sheet" here is a specific format Brian prefers over commercial apps (he has tried Set List Helper and prefers this): big-print lyrics with chords printed over the exact words, a bass-notes table giving each chord's root note, Nashville number, and easiest fret position, a short how-to-play note written for a bassist (root on 1, where to add 5ths/octaves, what NOT to play), plus feel, at-a-glance structure, and a practice tip.

Current state (2026-11-11):

- **16 songs** in the library (full inventory in the spec), **2 setlists** (Worship Set: East to West → Truth → Chain Breaker → To The Table; one more in the export).
- Features live and user-verified: transpose with Original Key restore, Notes | Nashville numbers toggle, BPM-derived auto-scroll with fine percentage control, screen wake lock ("Screen on"), setlists, Live Mode, responsive header tuned on a real Android phone, and an LLM-style add-a-song flow (type a name, the app researches and writes the sheet).
- The app currently lives inside Muse as a server-backed artifact. That hosting is the only reason it cannot be shared by link — the app itself is ordinary web technology. This project moves it to a standalone static web app (GitHub Pages) with the same behavior.

## 2. Analysis — what's strong, what's fragile

**Strong:**

- **The data model is the product, and it's clean.** Every song is one record with scalar fields (title, artist, key, tempo, time signature, feel, notes) plus two structured parts: `bassNotes[]` (chord / nashville / bassNote / position) and `body[]` (sections of chord-over-lyric lines, bar lines, or prose notes). It exports to JSON losslessly (see the export file) and re-imports anywhere. Any rebuild should adopt this model verbatim — do not redesign it.
- **All performance features are client-side logic.** Transpose, Nashville conversion, auto-scroll, wake lock, setlists, Live Mode — none of them need a server. They port to a static site intact.
- **The content is verified.** Keys, tempos, and progressions were researched per song against published sources; where no published data exists, the sheet says so instead of inventing (see the caveats in the spec: No Half Steppin', Truth). That honesty is a feature — preserve it in every future generated sheet.

**Fragile (the lessons of 2026-11-11 — three production failures in one day):**

1. **Long work must never run inside a user tap.** The add-a-song start call originally ran song identification inline; phone requests timed out and the app reported "Couldn't start that build" while the server finished the job anyway. A false failure is worse than a real one. Design rule: every tap answers instantly; all research/generation happens in a background job with visible progress.
2. **Background jobs die mid-flight; the system must heal itself.** Writers stalled after 2 of 6 sections and sat in "working" forever because nothing restarted them. Design rule: jobs carry status + heartbeat; anything stale beyond a few minutes is respawned automatically; re-submitting the same song re-attaches to its existing job (dedupe) instead of duplicating it.
3. **Layout is a phone-first problem.** The app was effectively formatted for a tablet and Brian uses his phone. Header crowding, a sticky block sliding under the tab bar, a duplicate back button — all found by his screenshots, not by desktop testing. Design rule: build and verify at ~390px width first; tablet is the easy case. (One known cosmetic defect to fix in the rebuild: a controls div that can scroll sideways at phone width.)
4. **Dirty data exists.** Song id 12 ("no half steppin" by "sean costello", lowercase) duplicates id 13. The rebuild's import step should dedupe it (keep id 13, the proper practice-version sheet).

**The one genuinely hard part:** add-a-song is the only feature that needs an LLM and therefore an API. Inside Muse it was free infrastructure; standalone, it needs a plan (Phase 4 below). Everything else is a static site.

## 3. Target architecture (standalone build)

- **Static single-page app** (React is fine — the original is React — but the framework matters less than the behavior spec). Deployed to GitHub Pages from the repo Steve is creating.
- **Data:** the JSON export ships as the app's seed data (`data/library.json`). On first run the app loads it into browser storage (localStorage or IndexedDB). All later edits/adds/deletes write to that local store — the app is a **private per-user locker**, never a shared or pooled library (this is also the licensing-safe posture: users bring their own songs; nothing is distributed between users).
- **Import/export built in:** export the whole library back to JSON (backup + future migrations), import a JSON file to restore or merge. This keeps Brian's data portable forever, independent of any host.
- **PWA:** installable to a phone/tablet home screen, works offline after first load (gig-proof: no signal required on stage), keeps the wake lock behavior. This is a small amount of work for a large amount of fitness for the actual use case.
- **No accounts, no backend** for Phases 1–3. Brian's data lives on his device; the public URL exposes only the app shell + the seed library he chooses to ship in the repo. (If he later wants the shared copy to be view-only for friends, the same build serves: visitors get the seed library read-only in their own browser storage.)

## 4. Build phases

Each phase ends with Brian checking it on his phone. His screenshot is the acceptance test — do not declare a layout "done" from desktop rendering.

### Phase 1 — Core viewer (the sheet, exactly right)
Library list (My Songs), song view with the full sheet format, setlists list. Sticky compact header per the spec's device-sizing rules: no duplicate back button, tab bar thinned, three slim rows on phones (text size / Screen on / ••• menu · Notes|Nashville + Scroll · compact transpose strip), spread out on tablets. Text size A−/A+. Edit/Delete in the ••• overflow menu.
**Accept:** Brian opens Chain Breaker on his phone: header looks like his approved screenshots, sheet starts immediately below it, nothing clipped, nothing sideways-scrolling.

### Phase 2 — Performance features
Transpose −/+ with key-name update and Original Key restore; Notes | Nashville toggle converting the whole sheet (bass-notes table + chords over lyrics, alignment preserved, slash chords, per-song memory); BPM auto-scroll (base pace = BPM × 0.25 shown as 100%, −/+ in 5% steps, 20–200% range, per-song persistence, 90 BPM fallback for no-tempo songs, pause on grab, stop at bottom); Screen-on wake lock with foreground re-acquire; Live Mode with the same header rules.
**Accept:** Chain Breaker at 100% scrolls at its own 78 BPM pace; flipping to Nashville shows 1-4-5; transposing in Nashville mode changes the key name, not the numbers.

### Phase 3 — Data management
Add a song manually (paste-a-sheet form), Edit song (fix any section — including replacing "(didn't come through)" placeholders), delete, create/rename/reorder setlists. Import/export JSON. Import-time dedupe (kills the id 12/13 duplicate class of problem).
**Accept:** Brian exports his library, and the file re-imports to an identical library.

### Phase 4 — LLM add-a-song (the background-job feature)
Recreate the "just name it" flow with the Nov 11 design rules baked in from line one:
- Start returns instantly with a job id; a background process identifies the song, then writes it **section by section** (each section is a long generation — stepping is structural, not an optimization), showing live progress ("Writing the verse… 3 of 6").
- If the song can't be confidently identified, the app says so plainly and creates nothing. Never invent a key, tempo, or lyric.
- Jobs persist; leaving/closing the app can't kill them; stale jobs (>4 min without progress) auto-resume; re-submitting re-attaches (already_exists) instead of duplicating.
- API approach (pick one at build time): (a) bring-your-own-key — Brian pastes an LLM API key once, stored only in his browser, calls go straight from the device (simplest, no server, fine for a personal app); (b) a tiny serverless proxy holding the key (better if friends ever use their own copies). Recommendation: (a) for Brian's own build; revisit only if this becomes a product.
**Accept:** "give me one reason tracy chapman" and "born on the bayou credence" each run end to end from a phone — instant start, visible progress, finished sheet in the library — and "no half steppin sean costello" is politely declined, not invented.

### Phase 5 — Product polish (only if Brian takes it further)
GitHub Pages custom domain, share links for the read-only copy, onboarding for a second user. Parked unless Brian says go — he has a parked A/B decision (simple share page vs full GitHub Pages product) and development priorities of his own.

## 5. Instructions for Cursor (Steve's analysis pass)

1. Read `lead-sheets-app-handoff.md` (behavior spec) and this plan first; treat the JSON export as the schema contract — generate your TypeScript types from it, don't hand-write a different model.
2. Your analysis should report: (a) confirmation the export's structure is consistent across all 16 songs (flag any field anomalies — e.g., null tempos on ids 5 and 13 are CORRECT, not missing data); (b) a component map from the spec's screens; (c) anything in the spec that is ambiguous enough to need Brian's decision before building.
3. Build Phase 1 first and stop for Brian's phone check before Phase 2. His past feedback (sticky header, scroll on the notation line, squeezed transpose strip, thinned tab bar) is all in the spec — follow it literally; do not "improve" the layout.
4. Keep the honesty rules: no invented song data, no invented sections, placeholders say so.

## 6. Definition of done (whole project)

Brian, on his own phone, with no help: opens the app from a public URL or home-screen icon, finds any song in seconds, flips between Notes and Nashville, transposes without the numbers moving, starts auto-scroll at the song's own pace, plays a setlist in Live Mode without the screen sleeping — and when he names a new song out loud, it is researched and written for him in the background, or honestly declined. At that point the app no longer needs Muse, Steve, or Cooper to run — which is the point of handing it over.
