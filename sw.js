/* Garde l'appli et les polices disponibles hors réseau. Les appels au backend (POST) ne passent pas par ce cache. */
var CACHE = 'speed-v1';
var SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'js/config.js', 'js/api.js', 'js/app.js',
  'js/demo-shim.js', 'backend/Code.js', 'assets/icon.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(function (res) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
    return res;
  }).catch(function () {
    return caches.match(e.request);
  }));
});
