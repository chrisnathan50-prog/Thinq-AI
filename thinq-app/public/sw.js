// Thinq's service worker: shows push notifications (reminders, email alerts, calendar heads-ups) even when
// Thinq isn't open, and opens the right chat when one is tapped. It doesn't cache anything.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Notes when the last push arrived and whether showing it worked, so the app can tell "your browser never
// got it" apart from "your computer hid it" (Connections → Notifications → Send a test).
async function note(entry) {
  try {
    const cache = await caches.open("thinq-push-log");
    await cache.put("/app/__push-log", new Response(JSON.stringify({ at: new Date().toISOString(), ...entry })));
  } catch {}
}

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Thinq", body: event.data?.text() || "" }; }
  const opts = { body: data.body || "", icon: "/app/icon-192.png", badge: "/app/badge-96.png", data: { url: data.url || "/app" } };
  if (data.tag) { opts.tag = data.tag; opts.renotify = true; }
  event.waitUntil((async () => {
    try {
      await self.registration.showNotification(data.title || "Thinq", opts);
      await note({ ok: true, tag: data.tag || null });
    } catch (err) {
      await note({ ok: false, error: `${err.name}: ${err.message}` });
      await self.registration.showNotification("Thinq", { body: data.body || data.title || "You have a new notification." });
    }
    // The number on the app icon (iPhone Home Screen app, installed desktop app): what needs attention.
    if (typeof data.badge === "number" && "setAppBadge" in self.navigator) {
      try { await (data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()); } catch {}
    }
    // Let an open Thinq tab know too.
    for (const c of await self.clients.matchAll({ type: "window" })) c.postMessage({ type: "push", title: data.title });
  })());
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
