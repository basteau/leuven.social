// Offline support. Hashed build assets are cache-first; pages, icons (their names carry no hash)
// and everything under /data/ (the city, and walk mode's plates) are network-first, so a rebake
// or a new icon shows up on the next online visit. Bump CACHE to drop everything after a format
// change.
const CACHE = 'leuven-v21'; // walk format v3: shop name boards

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

/**
 * Data is kept under its plain URL: a retry asks for `city.bin?retry=2` only to get past a
 * failure in the HTTP cache, so it's the same file, kept once and found offline under any query.
 */
function cacheKey(url) {
  const key = new URL(url, self.location.origin);
  if (key.pathname.startsWith('/data/')) key.search = '';
  return key.href;
}

// Responses go back at once; writing them to the cache continues in the background.
async function networkFirst(event) {
  const cache = await caches.open(CACHE);
  const key = cacheKey(event.request.url);
  try {
    const response = await fetch(event.request);
    if (response.ok) event.waitUntil(cache.put(key, response.clone()));
    return response;
  } catch (error) {
    const cached = await cache.match(key);
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
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(event));
  } else if (
    event.request.mode === 'navigate' ||
    url.pathname.startsWith('/data/') ||
    url.pathname.startsWith('/icons/')
  ) {
    event.respondWith(networkFirst(event));
  }
});

/** A build file's name as the page, a chunk or a stylesheet writes it: `walk-BERdOFcB.js`. */
const ASSET_NAME = /[\w-]+\.(?:js|css|woff2?|png|svg|webp)\b/g;
const TEXT = /html|javascript|css/;

/**
 * The current build's assets: what this visit loaded, and every file those name, however deep
 * (the page names the entry, the entry the engine and the menu, the engine walk mode, walk mode
 * the bikes). A lazy chunk this visit didn't need still belongs to the build, so walking keeps
 * working offline after a visit that never walked.
 */
async function currentBuild(cache, loaded, build = new Set(loaded)) {
  const named = async (url) => {
    const response = await cache.match(url);
    if (!response || !TEXT.test(response.headers.get('content-type') ?? '')) return [];
    const names = (await response.text()).matchAll(ASSET_NAME);
    return [...names].map(([name]) => new URL(`/assets/${name}`, self.location.origin).href);
  };
  const found = (await Promise.all(loaded.map(named))).flat().filter((url) => !build.has(url));
  if (!found.length) return build;
  for (const url of found) build.add(url);
  return currentBuild(cache, [...new Set(found)], build);
}

// The page sends what the current build loaded: cache it (the first visit happens before this
// worker controls the page), then drop hashed assets no file of this build names (older builds')
// and data that older workers kept under a query.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'cache' || !Array.isArray(event.data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const urls = event.data.urls.map((url) => new URL(url, self.location.origin).href);
      await Promise.all(
        urls.map(async (url) => {
          const key = cacheKey(url);
          if (await cache.match(key)) return;
          const response = await fetch(url).catch(() => undefined);
          if (response?.ok) await cache.put(key, response);
        }),
      );
      const build = await currentBuild(cache, urls.map(cacheKey));
      const stale = (await cache.keys()).filter(({ url }) => {
        const { pathname, search } = new URL(url);
        if (pathname.startsWith('/assets/')) return !build.has(url);
        return pathname.startsWith('/data/') && search !== '';
      });
      await Promise.all(stale.map((request) => cache.delete(request)));
    })(),
  );
});
