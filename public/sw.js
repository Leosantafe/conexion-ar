// Service worker: permite instalar la app, abrirla sin conexión y mostrar avisos.
// Estrategia "red primero": siempre intenta la versión nueva y usa la caché como respaldo.
const CACHE = "conexion-ar-v7";
const ASSETS = [
  "./",
  "./index.html",
  "./css/styles.css?v=7",
  "./js/app.js?v=7",
  "./js/crypto.js",
  "./js/firebase-config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});

// Notificación push (llega aunque la app esté cerrada)
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data?.json() || {}; } catch { /* sin datos */ }
  e.waitUntil((async () => {
    // Si la app está abierta y a la vista, no hace falta el aviso
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (clients.some((c) => c.visibilityState === "visible")) return;
    await self.registration.showNotification(data.title || "Conexión AR", {
      body: data.body || "Tienes un mensaje nuevo",
      tag: data.tag || "conexion-ar",
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      renotify: true,
      requireInteraction: data.kind === "call",
      vibrate: data.kind === "call" ? [400, 200, 400, 200, 400] : [200],
    });
  })());
});

// Al tocar el aviso, abrir (o enfocar) la app
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = clients.find((c) => new URL(c.url).origin === location.origin);
    if (open) return open.focus();
    return self.clients.openWindow("./");
  })());
});
