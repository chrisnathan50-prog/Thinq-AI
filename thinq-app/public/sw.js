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
  const opts = { body: data.body || "", icon: "/app/icon-192.png", badge: "/app/badge-96.png", data: { url: data.url || "/app", approvalId: data.approvalId || null } };
  // Drafts waiting for approval: Send / Discard buttons, and the notification stays until it's dealt with.
  if (data.approvalId && Array.isArray(data.actions)) { opts.actions = data.actions; opts.requireInteraction = true; }
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

// Send or Discard tapped on a draft's notification: do it right here, without opening Thinq.
const DONE = { email: "Sent", whatsapp: "Sent on WhatsApp", event: "Added to your calendar", notetaker: "The notetaker is on its way" };
async function actOnApproval(approvalId, action, title) {
  const show = (t, body, extra = {}) => self.registration.showNotification(t, { body, icon: "/app/icon-192.png", badge: "/app/badge-96.png", tag: `approval-${approvalId}`, data: { url: "/app#approvals" }, ...extra });
  try {
    const res = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}/${action === "send" ? "approve" : "decline"}`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ via: "notification" }),
    });
    const out = await res.json().catch(() => ({}));
    if (res.status === 401) return show("Sign in to Thinq", "You've been signed out on this device. Tap to open Thinq and send it from Approvals.");
    if (!res.ok) return show(action === "send" ? "Couldn't send it" : "Couldn't discard it", `${out.error || "Something went wrong."} Tap to open Approvals.`);
    const demo = out.mode === "demo" ? " (demo mode - nothing really went out)" : "";
    await show(action === "send" ? `${DONE[out.kind] || "Done"}${demo}` : "Discarded", title || "");
  } catch {
    await show("You're offline", "Tap to open Thinq and send it from Approvals when you're back online.");
  }
  for (const c of await self.clients.matchAll({ type: "window" })) c.postMessage({ type: "push" }); // refresh an open Thinq tab
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const approvalId = event.notification.data?.approvalId;
  if (approvalId && (event.action === "send" || event.action === "discard")) {
    event.waitUntil(actOnApproval(approvalId, event.action, event.notification.title.replace(/^Ready to send:?\s*/i, "")));
    return;
  }
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
