// يستقبل الإشعارات ويفتح الأداة على الفلم لما تضغط الإشعار
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "فهّمني", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "فهّمني", {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    lang: "ar",
    dir: "rtl",
    tag: d.url || "mt",
    data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        c.postMessage({ type: "open", url });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
