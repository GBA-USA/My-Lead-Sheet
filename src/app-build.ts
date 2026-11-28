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

/** How long a new service worker gets to fetch every file of the published version before the update counts as failed. */
const NEW_WORKER_WAIT_MS = 120_000;

/**
 * True once the newest service worker is the active one, so the next page load is answered from its copy of the
 * published files even when the network is too slow to wait for. False when the new worker failed to install, or did
 * not finish within `ms`: the worker still active then holds the old version, and a reload would land back on it.
 */
function newestWorkerActive(registration: ServiceWorkerRegistration, ms: number): Promise<boolean> {
  const leaving = registration.active;
  let sawIncoming = false;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), ms);
    const look = () => {
      if (settled) return;
      const incoming = registration.installing ?? registration.waiting;
      if (incoming) {
        sawIncoming = true;
        incoming.addEventListener("statechange", look, { once: true });
        return;
      }
      const active = registration.active;
      if (active && active.state !== "activated") {
        active.addEventListener("statechange", look, { once: true });
        return;
      }
      settle(!sawIncoming || active !== leaving);
    };
    look();
  });
}

/**
 * Reloads onto the published version, only once this phone can fetch it and it differs from this page's. The service
 * worker is asked to update, and the reload waits until the new worker is in charge: before that the old one answers
 * the reload and, on a slow network, opens its own old copy. Nothing stored on the phone is touched.
 */
export async function reloadOntoPublished(): Promise<ReloadOutcome> {
  const published = await publishedBuild();
  if (published === null) return "offline";
  if (published === BUILD_ID) return "current";
  const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  if (registration) {
    try {
      await registration.update();
    } catch {
      return "offline";
    }
    if (!(await newestWorkerActive(registration, NEW_WORKER_WAIT_MS))) return "offline";
  }
  location.reload();
  return "reloading";
}
