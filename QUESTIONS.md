# QUESTIONS: P1b join-links follow-up

## One test in commit 1 (75a65bd) has a setup bug. May CoS apply this one-line fix?

**Case:** `check:join-links` › "a refused or offline paste says why in the app and joins nobody".

**What goes wrong:** the case starts a second Worker with the browser's `APP_ORIGIN` (`http://localhost:<port>`), then signs a player up there with `new Phone(base).createAccount(...)`. `Phone` always sends `Origin: https://app.test`, so that Worker refuses the sign-up, and the case throws `Cannot read properties of undefined (reading 'user')` before its first assertion about the app.

This is a test-setup mistake, not a behavior gap. The landing-page case uses the same pattern and passes, because its Worker keeps the default `https://app.test` origin.

**Fix (setup only, no assertion changes)** in `scripts/check-join-links.ts`:

```diff
-      const lost = new Phone(elsewhere.base);
-      ok(await lost.createAccount("Gone Row"), "a player whose codes this server never saw");
+      const lost = await passwordPlayer(elsewhere.base, origin, "Gone Row", "gonerow");
```

`passwordPlayer` is the helper the same file already uses for Terry and Mike. It sends the browser's origin.

**Proof:** I ran a throwaway copy with only that change (deleted afterwards, never committed). Result on this laptop, Edge as `CHROME`: 14 of 14 ok, `check:join-links passed`. On the committed file, the result is 13 ok and 1 FAIL (this case).

Per the queue rules I did not edit the commit-1 test after the build started. The build is committed and complete.
