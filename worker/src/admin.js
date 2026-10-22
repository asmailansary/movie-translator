/**
 * صفحة الأدمن: الإعدادات، الأيقونة، الإشعارات للكل، الإحصائيات
 * الدخول بكلمة سر ADMIN_KEY (سر في Cloudflare)
 */
import { notifyAll } from "./push.js";

export const SETTINGS_KEY = "config/settings.json";

export const DEFAULT_SETTINGS = {
  name: "فهّمني",
  tagline: "أي فلم أو مقطع… نفهّمك إياه بلهجتك 🍿",
  splash: "نفهّمك أي فلم بلهجتك 🍿",
  theme: "dark",            // dark | light | auto
  user_theme_toggle: true,  // زر ليلي/أبيض للمستخدم
  splash_ms: 1700,          // مدة شاشة الافتتاح
  tap_sound: true,          // صوت النقر
  tap_volume: 60,           // ارتفاع صوت النقر (٠-١٠٠)
  custom_tap: false,        // صوت نقر مرفوع من الأدمن؟
  tap_v: 0,
  intro_on: false,          // انترو قبل الفلم
  custom_intro: false,      // فيه انترو مرفوع؟
  intro_v: 0,
  intro_every: "always",    // always = قبل كل فلم، daily = مرة باليوم لكل جهاز
  intro_where: "all",       // all = الأفلام والمقاطع، films = الأفلام بس
  intro_skip: true,         // زر «تخطّي»
  accent: "#e0a84a",
  dark_bg: "#0d0b09",       // لون خلفية الوضع الليلي
  icon_v: 0,                // يزيد كل ما تغيّرت الأيقونة
  custom_icon: false,       // فيه أيقونة مرفوعة من الأدمن؟
  snap_url: "https://snapchat.com/t/T4QBeB0D",
  show_social: true,
  show_dub: true,
  show_snap: true,
  dialects_enabled: ["fusha", "najdi", "hijazi", "khaleeji", "yemeni", "egyptian", "shami", "iraqi"],
  default_dialect: "najdi",
  font_size: 12,
  daily_per_device: 8,
  daily_total: 30,
  maintenance: false,
  maintenance_msg: "نسوي تحديثات حلوة للأداة 🛠️ ارجع لنا بعد شوي",
  announcement: "",
  texts: {
    movie_label: "رابط الفلم من يوتيوب 🎬",
    clip_label: "رابط المقطع من السوشل 📱",
    go_btn: "ترجم وشغّل 🎬",
    clip_intro: "نقدر فضولك تعرف وش ينقال ازهل الموضوع عندنا👨🏻‍🎨",
    dub_msg: "شغالين على الدبلجة واذا صارت متوفرة بنعلمك💬",
    download_confirm: "ترا بيتحمل ملف الترجمة باللهجة اللي انت مختارها ({dialect}) فا تأكد بالاول وش انت ناوي عليه 🚀",
    snap_title: "تحتاج مساعدة؟",
    snap_sub: "كلمني على سناب، حياك 🤍",
    fav_empty: "ما عندك أفلام محفوظة للحين. اضغط ❤️ وانت تتفرج ونحفظ لك الفلم ومكانك فيه.",
    switch_btn: "تبديل الترجمة 🤹🏻",
    ready_toast: "فلمك جاهز 🍿 يلا نبدأ!",
    push_ready_title: "فلمك جاهز 🍿",
    push_ready_body: "{name} صار جاهز بالترجمة، يلا نبدأ؟ 🎬",
    push_clip_title: "مقطعك جاهز 👀",
    push_clip_body: "{name} صار مفهوم بلهجتك، تعال شوف وش ينقال 👨🏻‍🎨",
  },
};

const TEXT_MAX = 300;
const DIALECT_KEYS = DEFAULT_SETTINGS.dialects_enabled;

let cache = { at: 0, value: null };
export async function getSettings(env) {
  if (cache.value && Date.now() - cache.at < 15000) return cache.value;
  const obj = await env.BUCKET.get(SETTINGS_KEY);
  const saved = obj ? await obj.json() : {};
  const value = { ...DEFAULT_SETTINGS, ...saved, texts: { ...DEFAULT_SETTINGS.texts, ...(saved.texts || {}) } };
  cache = { at: Date.now(), value };
  return value;
}

/** ينظّف أي إعداد جاي من صفحة الأدمن قبل ما ينحفظ */
function clean(input, current) {
  const out = { ...current };
  const str = (v, max = TEXT_MAX) => String(v ?? "").slice(0, max);
  const bool = (v) => v === true || v === "true";
  const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  if ("name" in input) out.name = str(input.name, 30).trim() || DEFAULT_SETTINGS.name;
  if ("tagline" in input) out.tagline = str(input.tagline, 120);
  if ("splash" in input) out.splash = str(input.splash, 120);
  if ("theme" in input && ["dark", "light", "auto"].includes(input.theme)) out.theme = input.theme;
  if ("accent" in input && /^#[0-9a-fA-F]{6}$/.test(input.accent)) out.accent = input.accent;
  if ("dark_bg" in input && /^#[0-9a-fA-F]{6}$/.test(input.dark_bg)) out.dark_bg = input.dark_bg;
  if ("snap_url" in input) {
    const u = str(input.snap_url, 200);
    out.snap_url = /^https:\/\/([a-z0-9-]+\.)*snapchat\.com\//i.test(u) ? u : current.snap_url;
  }
  for (const k of ["show_social", "show_dub", "show_snap", "maintenance", "user_theme_toggle", "tap_sound", "intro_on", "intro_skip"]) if (k in input) out[k] = bool(input[k]);
  if (input.intro_every === "always" || input.intro_every === "daily") out.intro_every = input.intro_every;
  if (input.intro_where === "all" || input.intro_where === "films") out.intro_where = input.intro_where;
  if ("tap_volume" in input) out.tap_volume = int(input.tap_volume, 0, 100, current.tap_volume);
  if ("splash_ms" in input) out.splash_ms = int(input.splash_ms, 300, 6000, current.splash_ms);
  if ("dialects_enabled" in input && Array.isArray(input.dialects_enabled)) {
    const list = input.dialects_enabled.filter((d) => DIALECT_KEYS.includes(d));
    if (list.length) out.dialects_enabled = list;
  }
  if ("default_dialect" in input && DIALECT_KEYS.includes(input.default_dialect)) out.default_dialect = input.default_dialect;
  if (!out.dialects_enabled.includes(out.default_dialect)) out.default_dialect = out.dialects_enabled[0];
  if ("font_size" in input) out.font_size = int(input.font_size, 10, 30, current.font_size);
  if ("daily_per_device" in input) out.daily_per_device = int(input.daily_per_device, 1, 500, current.daily_per_device);
  if ("daily_total" in input) out.daily_total = int(input.daily_total, 1, 5000, current.daily_total);
  if ("maintenance_msg" in input) out.maintenance_msg = str(input.maintenance_msg, 200);
  if ("announcement" in input) out.announcement = str(input.announcement, 200);
  if (input.texts && typeof input.texts === "object") {
    out.texts = { ...current.texts };
    for (const k of Object.keys(DEFAULT_SETTINGS.texts)) if (k in input.texts) out.texts[k] = str(input.texts[k]) || DEFAULT_SETTINGS.texts[k];
  }
  return out;
}

/** الإعدادات اللي تحتاجها الصفحة العامة (بدون أي شي حساس) */
export function publicSettings(s) {
  const { daily_per_device, daily_total, ...pub } = s;
  return pub;
}

// ───────── الدخول ─────────
const fails = new Map();   // محاولات الدخول الغلط لكل IP (في الذاكرة)
async function checkAdmin(request, env, safeEqual) {
  const ip = request.headers.get("cf-connecting-ip") || "x";
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) return "locked";
  if (env.ADMIN_KEY && (await safeEqual(request.headers.get("x-admin-key") || "", env.ADMIN_KEY))) { fails.delete(ip); return "ok"; }
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 10 * 60 * 1000; f.n = 0; }   // ٥ محاولات غلط = قفل ١٠ دقائق
  fails.set(ip, f);
  await new Promise((r) => setTimeout(r, 900));
  return "bad";
}

// ───────── الإحصائيات ─────────
async function stats(env) {
  let cursor, users = 0, app = 0, withPush = 0, active7 = 0, today = 0, translations = 0, clips = 0;
  const week = Date.now() - 7 * 864e5, day = new Date().toISOString().slice(0, 10);
  const pushDevices = new Set();
  do {
    const list = await env.BUCKET.list({ prefix: "users/", cursor, limit: 1000 });
    for (const o of list.objects || []) {
      if (o.key.endsWith("/subs.json") && o.size > 2) pushDevices.add(o.key.split("/")[1]);
      if (!o.key.endsWith("/profile.json")) continue;
      const p = await (await env.BUCKET.get(o.key))?.json();
      users++; if (p?.app) app++; if ((p?.last || 0) > week) active7++; if (p?.lastDay === day) today++;
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  withPush = pushDevices.size;
  cursor = undefined;
  do {
    const list = await env.BUCKET.list({ prefix: "subs/v2/", cursor, limit: 1000 });
    for (const o of list.objects || []) { translations++; if (/\/(tt|ig)_/.test(o.key)) clips++; }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  const lim = await (await env.BUCKET.get(`limits/${day}.json`))?.json();
  let storage = 0;
  cursor = undefined;
  do {
    const list = await env.BUCKET.list({ cursor, limit: 1000 });
    for (const o of list.objects || []) storage += o.size || 0;
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return { users, app, withPush, active7, today, translations, clips, newToday: lim?.total || 0, storageMB: Math.round(storage / 1048576 * 10) / 10 };
}

async function allPushDevices(env) {
  const out = [];
  let cursor;
  do {
    const list = await env.BUCKET.list({ prefix: "users/", cursor, limit: 1000 });
    for (const o of list.objects || []) if (o.key.endsWith("/subs.json") && o.size > 2) out.push(o.key.split("/")[1]);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return out;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
});

export async function adminApi(request, env, ctx, action, safeEqual) {
  const auth = await checkAdmin(request, env, safeEqual);
  if (!env.ADMIN_KEY) return json({ error: "ما فيه كلمة سر للأدمن. ضيف ADMIN_KEY في إعدادات Cloudflare 🛠️" }, 503);
  if (auth === "locked") return json({ error: "محاولات كثيرة غلط 🔒 جرّب بعد ١٠ دقائق" }, 429);
  if (auth !== "ok") return json({ error: "كلمة السر غلط 🔒" }, 401);

  if (action === "login") return json({ ok: true });
  if (action === "stats") return json(await stats(env));
  if (action === "settings" && request.method === "GET") return json(await getSettings(env));
  if (action === "settings" && request.method === "POST") {
    let input;
    try { input = JSON.parse((await request.text()).slice(0, 20000)); } catch { return json({ error: "طلب غير صالح" }, 400); }
    const next = clean(input, await getSettings(env));
    await env.BUCKET.put(SETTINGS_KEY, JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
    cache = { at: 0, value: null };
    return json({ ok: true, settings: next });
  }
  if (action === "reset" && request.method === "POST") {
    await env.BUCKET.delete(SETTINGS_KEY);
    cache = { at: 0, value: null };
    return json({ ok: true, settings: await getSettings(env) });
  }
  if (action === "icon" && request.method === "POST") {
    // الصفحة تصغّر الصورة بنفسها وترسل ٣ مقاسات PNG
    const form = await request.formData();
    for (const size of ["180", "192", "512"]) {
      const f = form.get(size);
      if (!f || typeof f === "string" || f.size > 600 * 1024 || f.type !== "image/png") return json({ error: "الصورة غير صالحة" }, 400);
      await env.BUCKET.put(`config/icon-${size}.png`, await f.arrayBuffer(), { httpMetadata: { contentType: "image/png" } });
    }
    const s = await getSettings(env);
    const next = { ...s, icon_v: (s.icon_v || 0) + 1, custom_icon: true };
    await env.BUCKET.put(SETTINGS_KEY, JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
    cache = { at: 0, value: null };
    return json({ ok: true, icon_v: next.icon_v });
  }
  if (action === "icon-reset" && request.method === "POST") {
    for (const size of ["180", "192", "512"]) await env.BUCKET.delete(`config/icon-${size}.png`);
    const s = await getSettings(env);
    const next = { ...s, icon_v: (s.icon_v || 0) + 1, custom_icon: false };
    await env.BUCKET.put(SETTINGS_KEY, JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
    cache = { at: 0, value: null };
    return json({ ok: true });
  }
  if (action === "tap" && request.method === "POST") {
    const form = await request.formData();
    const f = form.get("sound");
    if (!f || typeof f === "string" || !/^audio\//.test(f.type || "") || f.size > 400 * 1024)
      return json({ error: "لازم ملف صوت أصغر من ٤٠٠ كيلو 🎵" }, 400);
    await env.BUCKET.put("config/tap-sound", await f.arrayBuffer(), { httpMetadata: { contentType: f.type } });
    const s = await getSettings(env);
    const next = { ...s, custom_tap: true, tap_v: (s.tap_v || 0) + 1, tap_sound: true };
    await env.BUCKET.put(SETTINGS_KEY, JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
    cache = { at: 0, value: null };
    return json({ ok: true, settings: next });
  }
  if (action === "intro" && request.method === "POST") {
    // الفيديو يجي خام (مو FormData) عشان ما ينحمل كله في الذاكرة
    const type = (request.headers.get("content-type") || "").split(";")[0].trim();
    const size = +request.headers.get("content-length") || 0;
    if (!/^video\/(mp4|quicktime|x-m4v)$/.test(type)) return json({ error: "لازم فيديو mp4 أو mov 🎬" }, 400);
    if (!size || size > INTRO_MAX) return json({ error: "الانترو كبير 😅 خله أقل من ٣٠ ميقا (يكفي ٣-٨ ثواني)" }, 400);
    await env.BUCKET.put("config/intro", request.body, { httpMetadata: { contentType: type } });
    const s = await getSettings(env);
    const next = { ...s, custom_intro: true, intro_on: true, intro_v: (s.intro_v || 0) + 1 };
    await env.BUCKET.put(SETTINGS_KEY, JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
    cache = { at: 0, value: null };
    return json({ ok: true, settings: next });
  }
  if (action === "intro-reset" && request.method === "POST") {
    await env.BUCKET.delete("config/intro");
    const s = await getSettings(env);
    const next = { ...s, custom_intro: false, intro_on: false, intro_v: (s.intro_v || 0) + 1 };
    await env.BUCKET.put(SETTINGS_KEY, JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
    cache = { at: 0, value: null };
    return json({ ok: true, settings: next });
  }
  if (action === "tap-reset" && request.method === "POST") {
    await env.BUCKET.delete("config/tap-sound");
    const s = await getSettings(env);
    const next = { ...s, custom_tap: false, tap_v: (s.tap_v || 0) + 1 };
    await env.BUCKET.put(SETTINGS_KEY, JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
    cache = { at: 0, value: null };
    return json({ ok: true, settings: next });
  }
  if (action === "broadcast" && request.method === "POST") {
    let b;
    try { b = JSON.parse((await request.text()).slice(0, 3000)); } catch { return json({ error: "طلب غير صالح" }, 400); }
    // بدون عنوان: الآيفون يعرض اسم التطبيق والنص بس (أنظف)
    const title = String(b.title || "").slice(0, 80).trim(), body = String(b.body || "").slice(0, 240).trim();
    if (!body) return json({ error: "اكتب نص الإشعار ✍️" }, 400);
    const devices = await allPushDevices(env);
    const origin = new URL(request.url).origin;
    ctx.waitUntil(notifyAll(env, { ...asTitle(body), url: "/" }, origin, devices).catch(() => {}));
    return json({ ok: true, devices: devices.length });
  }
  return json({ error: "غير موجود" }, 404);
}

/** الأيقونة: اللي رفعها الأدمن، وإلا الأيقونة الأصلية */
export async function serveIcon(request, env, size) {
  const obj = await env.BUCKET.get(`config/icon-${size}.png`);
  if (obj) return new Response(obj.body, { headers: { "content-type": "image/png", "cache-control": "public, max-age=300" } });
  const file = size === "180" ? "/apple-touch-icon.png" : `/icon-${size}.png`;
  return env.ASSETS.fetch(new Request(new URL(file, request.url)));
}

/** ملف التطبيق (الاسم والأيقونة واللون) يتولد من الإعدادات */
export async function serveManifest(env) {
  const s = await getSettings(env);
  const v = s.icon_v || 0;
  const bg = s.theme === "light" ? "#f6f3ee" : (s.dark_bg || "#0d0b09");
  return new Response(JSON.stringify({
    name: s.name, short_name: s.name, lang: "ar", dir: "rtl", start_url: "/", scope: "/", display: "standalone", orientation: "any",
    background_color: bg, theme_color: bg,
    icons: [
      { src: `/brand/icon-192.png?v=${v}`, sizes: "192x192", type: "image/png" },
      { src: `/brand/icon-512.png?v=${v}`, sizes: "512x512", type: "image/png" },
      { src: `/brand/icon-512.png?v=${v}`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }), { headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" } });
}

const INTRO_MAX = 30 * 1024 * 1024;

/** الانترو: يدعم Range عشان الآيفون يشغّله فوراً بدون ما يحمّله كامل */
export async function serveIntro(request, env) {
  const range = request.headers.get("range");
  const m = range && range.match(/bytes=(\d*)-(\d*)/);
  const opts = {};
  if (m && (m[1] || m[2])) {
    const start = m[1] ? +m[1] : undefined, end = m[2] ? +m[2] : undefined;
    opts.range = start === undefined ? { suffix: end } : end === undefined ? { offset: start } : { offset: start, length: end - start + 1 };
  }
  const obj = await env.BUCKET.get("config/intro", opts);
  if (!obj) return new Response("", { status: 404 });
  const h = new Headers({ "content-type": obj.httpMetadata?.contentType || "video/mp4", "accept-ranges": "bytes", "cache-control": "public, max-age=604800", "x-content-type-options": "nosniff" });
  if (m && obj.range) {
    const off = obj.range.offset ?? (obj.size - obj.range.suffix);
    const len = obj.range.length ?? (obj.size - off);
    h.set("content-range", `bytes ${off}-${off + len - 1}/${obj.size}`); h.set("content-length", String(len));
    return new Response(request.method === "HEAD" ? null : obj.body, { status: 206, headers: h });
  }
  h.set("content-length", String(obj.size));
  return new Response(request.method === "HEAD" ? null : obj.body, { headers: h });
}

/** صوت النقر اللي رفعه الأدمن */
export async function serveTap(env) {
  const obj = await env.BUCKET.get("config/tap-sound");
  if (!obj) return new Response("", { status: 404 });
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType || "audio/mpeg", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" } });
}

/** النص يصير هو عنوان الإشعار (عشان ما يتكرر اسم التطبيق فوق «from»).
 *  لو طويل: أول جملة عنوان، والباقي تحت. */
export function asTitle(text) {
  const t = String(text || "").trim();
  if (t.length <= 60 && !t.includes("\n")) return { title: t, body: "" };
  const m = t.match(/^(.{8,60}?[.!؟?…✨🎉🍿\n])\s*([\s\S]+)$/u);
  if (m) return { title: m[1].trim(), body: m[2].trim() };
  const cut = t.lastIndexOf(" ", 55);
  return { title: t.slice(0, cut > 20 ? cut : 55).trim(), body: t.slice(cut > 20 ? cut : 55).trim() };
}
