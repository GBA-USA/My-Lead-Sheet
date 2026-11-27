VERDICT: PASS
Nits:
P3 | CLASS=scope-boundary | src/bands.tsx:625-628 | When `/api/bands/open` fails offline, `offlineSongs` renders cached band songs using `<span className="band-library-name">{item.song.title}</span><small>{item.song.artist}</small>` without key/tempo. Left untouched because `src/bands.tsx` is outside the owned files for this cook.

# Self-check summary (Phase 2)

Reviewed all modified and added files (`src/song-row.tsx`, `src/song-row.css`, `src/library-lists.tsx`, `src/band-library.tsx`, `src/band-setlist-view.tsx`, `scripts/check-list-rows.ts`, `package.json`) against R1–R10, the four song lists, signed-in/signed-out, empty/error states, 360 px layout rules, theme token usage, and the mutation table.

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
