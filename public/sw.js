/* Health Dashboard service worker.
   Network-first for the page (data must be fresh); the last good copy is kept
   so the app still opens offline. Never caches /status, /refresh, or anything
   that came back as a redirect (an expired login session). */
const CACHE = "health-v2";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// ---- Web Push: rule-triggered morning push + bedtime nudge sent by the Worker cron
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Health", {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: d.tag || "health",
    renotify: true,
    data: { url: d.url || "/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  // tell the Worker which push was opened (state/push-log.json); the Access
  // cookie rides along because the request is same-origin
  // the endpoint lets a password-mode deployment (no login email) find whose device this is
  const opened = self.registration.pushManager.getSubscription().then((sub) => fetch("/push/opened", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag: e.notification.tag || "", endpoint: sub ? sub.endpoint : null }),
  })).catch(() => {});
  e.waitUntil(Promise.all([opened, self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ("focus" in c) { c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  })]));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/status" || url.pathname === "/refresh") return;

  // only the dashboard is kept for offline use; /settings and /login always go to the network
  if (req.mode === "navigate" && url.pathname !== "/" && url.pathname !== "/dashboard.html") return;
  const isPage = url.pathname === "/" || url.pathname === "/dashboard.html";
  if (isPage) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.ok && !res.redirected && res.type === "basic") cache.put("/", res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match("/");
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }

  if (/\.(png|webmanifest|woff2)$/.test(url.pathname)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && !res.redirected) cache.put(req, res.clone());
      return res;
    })());
  }
});
