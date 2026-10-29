/* Stock Research service worker — TEST COPY (Supabase sync).
 * Uses a cache name that can never collide with the live app, so the
 * two can sit side by side during testing.
 * Only same-origin shell files are cached. Cross-origin requests —
 * live stock data, the Supabase JS CDN, and every Supabase auth/API
 * call — are never intercepted and never cached: they always go to
 * the network, so an auth response can never be served stale. */
var CACHE = 'stock-research-supabase-test-20261029015114';
var FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './supabase-config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(FILES.map(function (u) { return new Request(u, { cache: 'reload' }); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      // Only delete THIS test app's earlier caches — never the live
      // app's 'stock-research-…' caches on the same origin during tests.
      return Promise.all(keys.filter(function (k) {
        return k !== CACHE && k.indexOf('stock-research-supabase-test') === 0;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // CDN + Supabase + data: network only
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return resp;
      });
    })
  );
});
