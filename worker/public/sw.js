// يستقبل الإشعارات ويفتح الأداة على الفلم لما تضغط الإشعار
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// ───── رقم الإشعارات على أيقونة التطبيق (١، ٢، ٣…)
const BADGE = "/__badge";
async function badgeGet() {
  try { const r = await (await caches.open("mt-badge")).match(BADGE); return r ? parseInt(await r.text(), 10) || 0 : 0; } catch { return 0; }
}
async function badgeSet(n) {
  try { await (await caches.open("mt-badge")).put(BADGE, new Response(String(n))); } catch {}
  try { if (n > 0) await self.navigator.setAppBadge?.(n); else await self.navigator.clearAppBadge?.(); } catch {}
}

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "فهّمني", body: e.data ? e.data.text() : "" }; }
  // إذا الإشعار بدون عنوان، نخليه فاضي: الآيفون يعرض اسم التطبيق والنص بس
  e.waitUntil(badgeGet().then((n) => badgeSet(n + 1)).then(() => self.registration.showNotification(typeof d.title === "string" ? d.title : "فهّمني", {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    lang: "ar",
    dir: "rtl",
    tag: d.url || "mt",
    data: { url: d.url || "/" },
  })));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(badgeSet(0));
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
