// Service worker for the admin SPA. Strategy is network-first with offline
// fallback (the server sends Cache-Control: no-cache + ETag, so 304s stay fast).
// Cache name is bumped on each release that must invalidate stale client caches:
//   v2 - first network-first version (replaced a cache-first SW that shipped stale JS)
//   v3 - force returning clients to drop the old bucket so the "Add user" admin
//        button (and any client still on a pre-v2 cache-first SW) lands.
// Changing this string is what makes the browser detect a new SW + run activate,
// which deletes every cache key != CACHE below.
const CACHE = 'rd-admin-v3';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([
    '/', '/index.html', '/css/variables.css', '/css/reset.css', '/css/main.css',
    '/js/app.js', '/js/api.js', '/js/socket.js', '/js/i18n.js',
    '/js/components/toast.js'
  ])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Don't intercept API or socket.io traffic - those need to hit the network unmediated.
  if (e.request.url.includes('/api/') || e.request.url.includes('/socket.io/')) return;
  // Network-first: respect the server's Cache-Control: no-cache + ETag (304s
  // stay fast); fall back to cache only when offline. Re-populate the cache
  // on every successful fetch so the offline fallback stays current.
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
