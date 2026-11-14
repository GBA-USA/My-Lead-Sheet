const BUILD = { version: "dev", files: [] };

const SCOPE = self.registration.scope;
const PREFIX = `lead-sheets ${SCOPE} `;
const CACHE = PREFIX + BUILD.version;
const NAVIGATION_WAIT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(BUILD.files.map((file) => new Request(new URL(file, SCOPE), { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/api/")) return;
  event.respondWith(request.mode === "navigate" ? openPage(request) : fromCache(request));
});

async function fromCache(request) {
  const cache = await caches.open(CACHE);
  return (await cache.match(request, { ignoreVary: true })) ?? fetch(request);
}

/**
 * Network first, so an online open always gets the newest deploy. Only no network, a redirected answer or a slow one falls back to the cached page.
 * Any other HTTP answer passes through, so a 404 still reaches 404.html and its walk back to the app root.
 */
async function openPage(request) {
  const cache = await caches.open(CACHE);
  const cached =
    (await cache.match(request, { ignoreSearch: true, ignoreVary: true })) ?? (await cache.match(new URL("index.html", SCOPE), { ignoreVary: true }));
  const network = fetch(request);
  if (!cached) return network;
  const fresh = network.then((response) => (response.redirected ? cached : response), () => cached);
  const slow = new Promise((resolve) => setTimeout(resolve, NAVIGATION_WAIT_MS, cached));
  return Promise.race([fresh, slow]);
}
