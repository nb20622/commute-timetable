// version.js is an ES module and cannot be loaded with importScripts().
// Keep this value synchronized with APP_VERSION in version.js.
const APP_VERSION = "2026-06-14-2";
const CACHE_PREFIX = "commute-timetable-";
const CACHE_NAME = `${CACHE_PREFIX}${APP_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./version.js",
  "./manifest.json",
  "./service-worker.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./data/keihan_nishisanso_to_sekime_weekday.csv",
  "./data/keihan_moriguchishi_to_sekime_weekday.csv",
  "./data/metro_sekime_seiiku_to_imazato_weekday.csv",
  "./data/metro_imazato_to_shinfukae_weekday.csv",
];

function createReloadRequest(url) {
  return new Request(
    new URL(url, self.registration.scope),
    { cache: "reload" },
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const requests = PRECACHE_URLS.map(createReloadRequest);
    await cache.addAll(requests);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => (
          name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME
        ))
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (
    request.method !== "GET"
    || new URL(request.url).origin !== self.location.origin
  ) {
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }

    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});

async function refreshPrecache() {
  // Fetch everything before writing anything so a failed refresh leaves the
  // existing offline cache intact.
  const refreshed = await Promise.all(PRECACHE_URLS.map(async (url) => {
    const request = createReloadRequest(url);
    const response = await fetch(request);
    if (!response.ok) {
      throw new Error(`Failed to refresh ${url}: HTTP ${response.status}`);
    }
    return { request, response };
  }));

  const cache = await caches.open(CACHE_NAME);
  await Promise.all(
    refreshed.map(({ request, response }) => cache.put(request, response)),
  );
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (event.data?.type === "REFRESH_CACHE") {
    event.waitUntil((async () => {
      try {
        await refreshPrecache();
        event.ports[0]?.postMessage({ ok: true });
      } catch (error) {
        event.ports[0]?.postMessage({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })());
  }
});
