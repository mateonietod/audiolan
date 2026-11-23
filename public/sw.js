// App shell cache. Network first, so a running server always serves the
// newest files; the cache only makes the installed app open when the server
// is briefly unreachable. Signaling and room lookups are never cached.

const CACHE = 'audiolan-v9';
const SHELL = [
  '/',
  '/styles.css',
  '/fonts/GeistSerif-Regular.woff2',
  '/fonts/Geist-Variable.woff2',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/js/main.js',
  '/js/controls.js',
  '/js/media.js',
  '/js/peers.js',
  '/js/protocol.js',
  '/js/pwa.js',
  '/js/signaling.js',
  '/js/state.js',
  '/js/stats.js',
  '/js/util.js',
  '/js/view.js',
];
const LIVE = new Set(['/rooms', '/health']);
/** The DOM typings do not know service workers; keep the checker out of the way. */
const sw = /** @type {any} */ (self);

sw.addEventListener('install', (/** @type {any} */ event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (/** @type {any} */ event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await sw.clients.claim();
  })());
});

sw.addEventListener('fetch', (/** @type {any} */ event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin || LIVE.has(url.pathname)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await caches.match('/');
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
