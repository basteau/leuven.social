// Offline support. Hashed build assets are cache-first; pages and everything under /data/ (the
// city, and walk mode's plates) are network-first so a rebake shows up on the next online visit.
// Bump CACHE to drop everything after a format change.
const CACHE = 'leuven-v20'; // walk format v2: plates keep no height

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

// Responses go back at once; writing them to the cache continues in the background.
async function networkFirst(event) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(event.request);
    if (response.ok) event.waitUntil(cache.put(event.request, response.clone()));
    return response;
  } catch (error) {
    const cached = await cache.match(event.request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (response.ok) event.waitUntil(cache.put(event.request, response.clone()));
  return response;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(event));
  } else if (event.request.mode === 'navigate' || url.pathname.startsWith('/data/')) {
    event.respondWith(networkFirst(event));
  }
});

// The page sends what the current build loaded: cache it (the first visit happens before this
// worker controls the page) and drop hashed assets from older builds.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'cache' || !Array.isArray(event.data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const keep = new Set(event.data.urls.map((url) => new URL(url, self.location.origin).href));
      await Promise.all(
        [...keep].map(async (url) => (await cache.match(url)) || cache.add(url).catch(() => {})),
      );
      const stale = (await cache.keys()).filter(
        (request) => new URL(request.url).pathname.startsWith('/assets/') && !keep.has(request.url),
      );
      await Promise.all(stale.map((request) => cache.delete(request)));
    })(),
  );
});
