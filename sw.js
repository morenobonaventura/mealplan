/* MealPlan service worker: cache-first for the shell, so the app opens
   instantly and keeps working with no connection at all. */
const CACHE = 'mealplan-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/style.css',
  './assets/js/app.js',
  './assets/js/store.js',
  './assets/js/meals.js',
  './assets/js/planner.js',
  './assets/js/ai.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // never touch OpenRouter calls

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) {
        // Refresh in the background so an updated deploy lands next launch.
        fetch(request).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    }),
  );
});
