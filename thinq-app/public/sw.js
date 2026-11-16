// Thinq's service worker: shows push notifications (reminders, email alerts, calendar heads-ups) even when
// Thinq isn't open, and opens the right chat when one is tapped. It doesn't cache anything.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Thinq", body: event.data?.text() || "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "Thinq", {
    body: data.body || "",
    tag: data.tag,
    icon: "/app/icon-192.png",
    badge: "/app/badge-96.png",
    data: { url: data.url || "/app" },
    renotify: Boolean(data.tag),
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/app", self.location.origin);
  event.waitUntil((async () => {
    if (target.origin !== self.location.origin) return self.clients.openWindow(target.href); // e.g. a meeting link
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const app = open.find((c) => new URL(c.url).pathname.startsWith("/app"));
    if (app) {
      await app.focus();
      return app.navigate(target.href).catch(() => {});
    }
    return self.clients.openWindow(target.href);
  })());
});
