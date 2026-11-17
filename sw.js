/* Back Alley Scorecard service worker.
 * Network-first for app files so phones pick up new versions right away;
 * the cache is only an offline fallback. Install bypasses the HTTP cache
 * (cache: 'reload') so a new cache never gets filled with stale files.
 */
'use strict';

const CACHE_NAME = 'backalley-v12';
const ASSETS = [
  './',
  './index.html',
  './score.js',
  './manifest.webmanifest'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        return Promise.all(ASSETS.map(function (url) {
          return fetch(new Request(url, { cache: 'reload' })).then(function (res) {
            if (!res.ok) throw new Error('Failed to fetch ' + url);
            return cache.put(url, res);
          });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME) return caches.delete(key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;

  // Network first (revalidating past the HTTP cache), fall back to the cache offline.
  event.respondWith(
    fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok && res.type === 'basic' && url.search === '') {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (cached) {
        if (cached) return cached;
        if (req.mode === 'navigate') return caches.match('./index.html').then(function (r) { return r || caches.match('./'); });
        return Response.error();
      });
    })
  );
});
