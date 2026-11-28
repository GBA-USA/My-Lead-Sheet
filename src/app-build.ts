import { asBuildId } from "./gig-check-in-model";

/**
 * The version this page runs, compiled in by vite.config.ts from the same value the build publishes as build.json.
 * Null only where the page was bundled some other way, so it reports no version rather than a wrong one.
 */
export const BUILD_ID: string | null = typeof __BUILD_ID__ === "string" ? asBuildId(__BUILD_ID__) : null;

/**
 * The version the app's own site publishes now, or null when it cannot be fetched, as offline, a 404 or `vite dev`.
 * It is never a cached answer: the service worker keeps no copy of build.json, so it passes the request to the network,
 * and no-store skips the browser's own cache. The address is the page's own base, never a written-out origin.
 */
export async function publishedBuild(): Promise<string | null> {
  try {
    const reply = await fetch(new URL("build.json", document.baseURI), { cache: "no-store" });
    if (!reply.ok) return null;
    const body: unknown = await reply.json();
    return typeof body === "object" && body !== null ? asBuildId((body as { id?: unknown }).id) : null;
  } catch {
    return null;
  }
}

/** What a reload onto the published version came to: it could not reach it, this page already runs it, or it is reloading. */
export type ReloadOutcome = "offline" | "current" | "reloading";

/**
 * Reloads onto the published version, only once this phone can fetch it and it differs from this page's. The service
 * worker is asked to update first; it takes over at once and opens pages network first, so the reload lands on the new
 * version. Nothing stored on the phone is touched.
 */
export async function reloadOntoPublished(): Promise<ReloadOutcome> {
  const published = await publishedBuild();
  if (published === null) return "offline";
  if (published === BUILD_ID) return "current";
  try {
    await (await navigator.serviceWorker?.getRegistration())?.update();
  } catch {
    // An update the worker cannot make now still leaves the reload network first.
  }
  location.reload();
  return "reloading";
}
