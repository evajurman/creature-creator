// CritterKiln's service worker: keeps the app working offline. vite.config.ts
// fills in the version and the list of built files when it writes dist/sw.js.

const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const APP = `critterkiln-${VERSION}`;
// fonts and icons from other sites, kept from the last time they loaded
const EXTRA = 'critterkiln-extra';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(APP)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== APP && k !== EXTRA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    // the newest page when online, so updates arrive; the saved one offline
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(APP).then((c) => c.put('./', copy));
          return res;
        })
        .catch(() => caches.match('./', { cacheName: APP, ignoreVary: true })),
    );
  } else if (url.origin === location.origin) {
    // built files have their hash in the name, so a saved copy is always right
    // (ignoreVary: the page asks for them crossorigin, and servers answer "Vary: Origin")
    e.respondWith(caches.match(req, { ignoreVary: true }).then((hit) => hit ?? fetch(req)));
  } else if (url.protocol.startsWith('http')) {
    // fonts and icons: the saved copy straight away, refreshed in the background
    e.respondWith(
      caches.open(EXTRA).then(async (c) => {
        const hit = await c.match(req, { ignoreVary: true });
        const fresh = fetch(req)
          .then((res) => {
            if (res.ok || res.type === 'opaque') c.put(req, res.clone());
            return res;
          })
          .catch(() => hit ?? Response.error());
        return hit ?? fresh;
      }),
    );
  }
});
