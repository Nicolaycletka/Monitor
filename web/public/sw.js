/* Кеш оболочки. Всё относительно scope, поэтому работает и в подкаталоге. */
const CACHE = "bt-shell-v1";
const SCOPE = self.registration.scope;              // .../monitor/
const SCOPE_PATH = new URL(SCOPE).pathname;         // /monitor/

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll([SCOPE, SCOPE + "manifest.webmanifest"]))
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith(SCOPE_PATH + "api/")) return;

  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match(SCOPE)));
    return;
  }

  e.respondWith(
    caches.match(e.request).then((hit) => {
      const fresh = fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || fresh;
    })
  );
});
