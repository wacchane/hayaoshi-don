/*
 * 早押しドンの Service Worker。
 *
 * アプリシェルは cache-first。回線が細い会場でも即座に立ち上がり、
 * 起動後は MQTT の WebSocket だけがネットワークを使う。
 * CACHE の版を上げると、次回起動時に古い版がまとめて捨てられる。
 */
var CACHE = 'hayaoshi-don-v1';

var SHELL = [
  './',
  './index.html',
  './app.js',
  './mqtt-mini.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') { return; }

  var url = new URL(req.url);

  // Google Fonts は取れたら保存し、次からはキャッシュを返す
  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return res;
        }).catch(function () { return hit; });
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) { return; }

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) { return hit; }
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        // ページ遷移の失敗はアプリシェルで受ける
        if (req.mode === 'navigate') { return caches.match('./index.html'); }
        return Response.error();
      });
    })
  );
});
