// Hondutel Ubica - service worker.
// Solo guarda la "cascara" de la app (HTML, JS, CSS, iconos).
// NUNCA guarda datos de clientes: las peticiones a Firebase no pasan por esta cache.
const VERSION = 'hu-2.0.1';
const CASCARA = ['./', './index.html', './app.js', './estilos.css', './manifest.webmanifest', './icono-v2-192.png', './icono-v2-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CASCARA)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;  // Firebase: directo a la red
  // Red primero (para recibir actualizaciones); la cache solo si no hay conexion.
  e.respondWith(fetch(e.request)
    .then((r) => { const copia = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copia)); return r; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))));
});
