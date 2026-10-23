// Service worker: permite instalar la app, abrirla sin conexión y mostrar avisos.
// Estrategia "red primero": siempre intenta la versión nueva y usa la caché como respaldo.
const CACHE = "conexion-ar-v12";
const ASSETS = [
  "./",
  "./index.html",
  "./css/styles.css?v=12",
  "./js/app.js?v=12",
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
    const ringing = data.kind === "call";
    await self.registration.showNotification(data.title || "Conexión AR", {
      body: data.body || "Tienes un mensaje nuevo",
      tag: data.tag || "conexion-ar",
      data: { chat: data.chat || "" },
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      renotify: true, // cada aviso repetido de la llamada vuelve a sonar y vibrar
      requireInteraction: ringing,
      vibrate: ringing ? [600, 200, 600, 200, 600, 200, 600] : [200],
    });
  })());
});

// Al tocar el aviso, abrir (o enfocar) la app directamente en esa sala
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const chat = e.notification.data?.chat || "";
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = clients.find((c) => new URL(c.url).origin === location.origin);
    if (open) {
      if (chat) open.postMessage({ type: "open-chat", chat });
      return open.focus();
    }
    return self.clients.openWindow(chat ? `./?abrir=${chat}` : "./");
  })());
});
