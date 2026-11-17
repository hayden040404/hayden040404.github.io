/* Back Alley Play service worker (scope /play/).
 * Network-first so phones pick up new versions right away; the cache is only an
 * offline fallback. Install bypasses the HTTP cache (cache: 'reload') so a new
 * cache never gets filled with stale files. Only touches backalley-play-* caches.
 */
'use strict';

const CACHE_NAME = 'backalley-play-v5';
const ASSETS = [
  './',
  './index.html',
  './engine.js',
  './ai.js',
  './saves.js',
  './manifest.webmanifest',
  '../score.js'
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
        if (key.indexOf('backalley-play-') === 0 && key !== CACHE_NAME) return caches.delete(key);
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

  event.respondWith(
    fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok && res.type === 'basic' && url.search === '') {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.open(CACHE_NAME).then(function (cache) {
        return cache.match(req, { ignoreSearch: true }).then(function (cached) {
          if (cached) return cached;
          if (req.mode === 'navigate') return cache.match('./index.html').then(function (r) { return r || cache.match('./'); });
          return Response.error();
        });
      });
    })
  );
});
