// Makes the app installable as a desktop / home-screen shortcut.
// Always loads fresh pages from the network; the last copy is used only when offline.
var CACHE = 'gw-pages-v4';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || req.mode !== 'navigate' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(req, copy); });
    return res;
  }).catch(function () { return caches.match(req, { ignoreSearch: true }); }));
});
