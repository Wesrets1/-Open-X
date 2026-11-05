/* Service worker — offline shell caching.
   Bump VERSION on every release so clients pick up new assets. */
const VERSION = 'status-v12';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/views.js',
  './js/components.js',
  './js/engine.js',
  './js/tools.js',
  './js/llm.js',
  './js/prompts.js',
  './js/demo.js',
  './js/worlds.js',
  './js/reactions.js',
  './js/display.js',
  './js/db.js',
  './js/memory.js',
  './js/crowd.js',
  './js/demoKey.js',
  './js/config.js',
  './js/util.js',
  './js/debug.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never cache API traffic.
  if (url.pathname.includes('/chat/completions')) return;
  if (url.origin !== self.location.origin) return;

  // Network-first for the app shell: nav requests and JS/CSS must never
  // serve stale code after a deploy.
  const isShellAsset = /\.(?:js|css|html?|webmanifest)$/i.test(url.pathname) ||
    url.pathname.endsWith('/') ||
    url.pathname === '/';

  if (isShellAsset) {
    e.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first for everything else (icons, images, manifest).
  e.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(request, copy));
      }
      return res;
    }))
  );
});
