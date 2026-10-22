/**
 * مترجم الأفلام — Worker على Cloudflare
 * - يعرض الصفحة (من مجلد public)
 * - يستقبل طلب الترجمة ويشغّل GitHub Actions
 * - يستقبل الترجمة من GitHub أول بأول ويحفظها في R2
 * - يعطي الصفحة الترجمة الجاهزة
 *
 * الأسرار المطلوبة (Settings → Variables and Secrets):
 *   APP_PASSWORD   كلمة مرور الأداة
 *   GH_TOKEN       مفتاح GitHub يقدر يشغّل Actions في مستودع الأداة
 *   INGEST_SECRET  كلمة سر بين GitHub و Cloudflare (نفسها في الجهتين)
 */

import { getVapid, saveSub, removeSub, notifyAll, validSubscription } from "./push.js";

const LANGS = { auto: "تلقائي", en: "الإنجليزية", de: "الألمانية", fr: "الفرنسية" };
const DIALECTS = {
  fusha: { name: "الفصحى", group: "fusha" },
  najdi: { name: "نجدية", group: "dialect" },
  hijazi: { name: "حجازية", group: "dialect" },
  khaleeji: { name: "خليجية", group: "dialect" },
  yemeni: { name: "يمنية", group: "dialect" },
  egyptian: { name: "مصرية", group: "dialect" },
  shami: { name: "شامية", group: "dialect" },
  iraqi: { name: "عراقية", group: "dialect" },
};

const START_TIMEOUT = 10 * 60 * 1000;   // لو GitHub ما بدأ خلال 10 دقائق
const STALL_TIMEOUT = 20 * 60 * 1000;   // لو وقف التحديث 20 دقيقة
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeEqual(a, b) {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
export function extractVideoId(raw) {
  const url = (raw || "").trim();
  if (YT_ID.test(url)) return url;
  let u;
  try {
    u = new URL(url.includes("://") ? url : "https://" + url);
  } catch {
    return null;
  }
  let host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  let vid = null;
  if (host === "youtu.be") vid = u.pathname.split("/").filter(Boolean)[0];
  else if (["youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) {
    if (u.pathname === "/watch") vid = u.searchParams.get("v");
    else {
      const p = u.pathname.split("/").filter(Boolean);
      if (p.length >= 2 && ["shorts", "embed", "live", "v"].includes(p[0])) vid = p[1];
    }
  }
  return vid && YT_ID.test(vid) ? vid : null;
}

const jobKey = (id) => `jobs/${id}.json`;
// v2: توقيت الكلمات (الترجمات القديمة تنعاد بالتوقيت الدقيق)
const subsKey = (vid, src, d) => `subs/v2/${vid}__${src}__${d}.json`;
const FAVS_KEY = "favorites.json";
const activeKey = (vid, src, d) => `active/${vid}__${src}__${d}`;

async function getJSON(env, key) {
  const obj = await env.BUCKET.get(key);
  return obj ? obj.json() : null;
}
const putJSON = (env, key, value) =>
  env.BUCKET.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function checkTimeouts(job) {
  const now = Date.now();
  if (job.status === "queued" && now - job.created > START_TIMEOUT) {
    job.status = "error";
    job.error = "الفلم ما بدأ يتجهز 😕 جرّب مرة ثانية، وإذا تكرر فيه مشكلة في إعدادات الأداة 🛠️";
  } else if (job.status === "running" && now - (job.updated || job.created) > STALL_TIMEOUT) {
    job.status = "error";
    job.error = "الترجمة وقفت بالنص 😕 جرّب مرة ثانية";
  }
  return job;
}

async function dispatch(env, job, origin) {
  const repo = env.GH_REPO;
  const r = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/translate.yml/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "movie-translator-worker",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ref: env.GH_BRANCH || "main",
        inputs: {
          job_id: job.id,
          video_id: job.video_id,
          source: job.source,
          dialect: job.dialect,
          callback: origin,
          reuse: job.reuse ? "1" : "0",
        },
      }),
    }
  );
  if (r.status !== 204) {
    const t = (await r.text()).slice(0, 200);
    console.log("dispatch failed", r.status, t);
    if (r.status === 401 || r.status === 403) return "فيه مشكلة في إعدادات الأداة 🛠️ (مفتاح التشغيل)";
    if (r.status === 404) return "فيه مشكلة في إعدادات الأداة 🛠️ (ملف التشغيل)";
    return `ما قدرنا نبدأ تجهيز الفلم 😕 (${r.status}) جرّب بعد شوي`;
  }
  return null;
}

async function createJob(request, env) {
  if (!env.APP_PASSWORD || !env.GH_TOKEN || !env.INGEST_SECRET)
    return json({ error: "الأداة ناقصها إعدادات 🛠️" }, 503);
  if (!(await safeEqual(request.headers.get("x-app-password") || "", env.APP_PASSWORD))) {
    await sleep(800);
    return json({ error: "كلمة المرور غير صحيحة." }, 401);
  }
  let body;
  try {
    body = JSON.parse((await request.text()).slice(0, 10000) || "{}");
  } catch {
    return json({ error: "طلب غير صالح." }, 400);
  }
  const vid = extractVideoId(String(body.url || ""));
  const source = body.source || "auto";
  const dialect = body.dialect || "najdi";
  if (!vid) return json({ error: "الرابط مو رابط فيديو يوتيوب صحيح." }, 400);
  if (!(source in LANGS) || !(dialect in DIALECTS)) return json({ error: "اختيار اللغة أو اللهجة غير صحيح." }, 400);

  // ترجمة جاهزة من قبل؟
  const cached = await env.BUCKET.head(subsKey(vid, source, dialect));
  if (cached) {
    const id = newId();
    await putJSON(env, jobKey(id), {
      id, video_id: vid, source, dialect, status: "done", cached: true,
      stage: "جاهز ✓ ترجمته من قبل 🎬", progress: 1, ready_until: 1e9,
      title: cached.customMetadata?.title || "", created: Date.now(), updated: Date.now(),
    });
    return json({ job_id: id, video_id: vid });
  }

  // نفس الفلم يترجم الحين؟
  const activeObj = await env.BUCKET.get(activeKey(vid, source, dialect));
  if (activeObj) {
    const activeId = await activeObj.text();
    const existing = await getJSON(env, jobKey(activeId));
    if (existing && ["queued", "running"].includes(checkTimeouts(existing).status))
      return json({ job_id: activeId, video_id: vid });
  }

  // الفلم مسموع من قبل بلهجة ثانية؟ نترجم بس، بدون سحب الصوت من جديد
  const reuse = await findTranscript(env, vid);
  const id = newId();
  const job = {
    id, video_id: vid, source, dialect, status: "queued", reuse,
    stage: reuse ? `نترجم ${dialect === "fusha" ? "بالفصحى" : "باللهجة ال" + DIALECTS[dialect].name} ⚡` : "نجهّز لك الفلم… 🍿", progress: 0.01,
    title: "", duration: 0, ready_until: 0, error: null, segments: [],
    created: Date.now(), updated: Date.now(),
  };
  await putJSON(env, jobKey(id), job);
  const err = await dispatch(env, job, new URL(request.url).origin);
  if (err) {
    job.status = "error";
    job.error = err;
    await putJSON(env, jobKey(id), job);
    return json({ error: err }, 502);
  }
  await env.BUCKET.put(activeKey(vid, source, dialect), id);
  return json({ job_id: id, video_id: vid });
}

async function findTranscript(env, vid) {
  const list = await env.BUCKET.list({ prefix: `subs/v2/${vid}__`, limit: 20 });
  return list.objects?.[0]?.key || null;
}

// الكلام الأصلي (بدون الترجمة) لفلم مسموع من قبل
async function source(request, env, id) {
  if (!(await safeEqual(request.headers.get("x-ingest-secret") || "", env.INGEST_SECRET)))
    return json({ error: "unauthorized" }, 401);
  const job = await getJSON(env, jobKey(id));
  if (!job || !job.reuse) return json({ error: "not found" }, 404);
  const subs = await getJSON(env, job.reuse);
  if (!subs) return json({ error: "not found" }, 404);
  return json({
    title: subs.title || "", duration: subs.duration || 0,
    segments: (subs.segments || []).map(({ start, end, src }) => ({ start, end, src })),
  });
}

async function loadJob(env, id) {
  const job = await getJSON(env, jobKey(id));
  if (!job) return null;
  if (job.cached) {
    const subs = await getJSON(env, subsKey(job.video_id, job.source, job.dialect));
    job.segments = subs?.segments || [];
    job.title = subs?.title || job.title;
    job.duration = subs?.duration || 0;
  }
  return checkTimeouts(job);
}

async function getJob(request, env, id, wantSrt) {
  if (!(await safeEqual(request.headers.get("x-app-password") || "", env.APP_PASSWORD))) {
    await sleep(800);
    return json({ error: "كلمة المرور غير صحيحة." }, 401);
  }
  const job = await loadJob(env, id);
  if (!job) return json({ error: "المهمة غير موجودة." }, 404);
  if (wantSrt) {
    return new Response(toSrt(job.segments || []), {
      headers: {
        "content-type": "application/x-subrip; charset=utf-8",
        "content-disposition": `attachment; filename="${job.video_id}.ar.srt"`,
        ...SECURITY_HEADERS,
      },
    });
  }
  const since = Math.max(0, parseInt(new URL(request.url).searchParams.get("since") || "0", 10) || 0);
  const segs = job.segments || [];
  return json({
    video_id: job.video_id, source: job.source, dialect: job.dialect, status: job.status, stage: job.status === "error" ? job.error : job.stage,
    progress: job.progress || 0, title: job.title || "", duration: job.duration || 0,
    error: job.error || null, ready_until: job.ready_until || 0,
    total: segs.length, since, segments: segs.slice(since),
  });
}

async function ingest(request, env, id, ctx) {
  if (!(await safeEqual(request.headers.get("x-ingest-secret") || "", env.INGEST_SECRET)))
    return json({ error: "unauthorized" }, 401);
  const job = await getJSON(env, jobKey(id));
  if (!job) return json({ error: "not found" }, 404);
  const p = await request.json();
  for (const k of ["status", "stage", "progress", "title", "duration", "ready_until", "error"])
    if (p[k] !== undefined) job[k] = p[k];
  if (Array.isArray(p.append)) {
    for (const s of p.append)
      if (typeof s.start === "number" && typeof s.end === "number")
        job.segments.push({ start: s.start, end: s.end, src: String(s.src || ""), ar: String(s.ar || "") });
  }
  job.updated = Date.now();
  await putJSON(env, jobKey(id), job);

  if (job.status === "done" || job.status === "error")
    await env.BUCKET.delete(activeKey(job.video_id, job.source, job.dialect));
  // إشعار: أول ما يصير الفلم جاهز للمشاهدة (أو لو صار خطأ)
  const watchable = job.segments.length > 0;
  if ((watchable || job.status === "error") && !job.notified) {
    job.notified = true;
    await putJSON(env, jobKey(id), job);
    const name = job.title ? `«${job.title.slice(0, 60)}»` : "فلمك";
    const msg = job.status === "error"
      ? { title: "صار شي بالفلم 😕", body: `${name} ما ضبط معنا، افتح الأداة وشوف وش السالفة`, url: `/?job=${id}` }
      : { title: "فلمك جاهز 🍿", body: `${name} صار جاهز بالترجمة، يلا نبدأ؟ 🎬`, url: `/?job=${id}` };
    const origin = new URL(request.url).origin;
    ctx.waitUntil(notifyAll(env, msg, origin).catch((e) => console.log("notify", e)));
  }
  if (job.status === "done") {
    await env.BUCKET.put(
      subsKey(job.video_id, job.source, job.dialect),
      JSON.stringify({ video_id: job.video_id, title: job.title, duration: job.duration, segments: job.segments }),
      { httpMetadata: { contentType: "application/json" }, customMetadata: { title: (job.title || "").slice(0, 200) } }
    );
  }
  return json({ ok: true });
}


// ───────── المحفوظة (القلب) ─────────
async function requireAuth(request, env) {
  if (await safeEqual(request.headers.get("x-app-password") || "", env.APP_PASSWORD)) return null;
  await sleep(800);
  return json({ error: "كلمة المرور غير صحيحة." }, 401);
}

async function favorites(request, env, key) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const favs = (await getJSON(env, FAVS_KEY)) || {};
  if (request.method === "GET") {
    const list = Object.values(favs).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    return json({ favorites: list });
  }
  if (request.method === "DELETE") {
    if (!key || !favs[key]) return json({ error: "غير موجود" }, 404);
    delete favs[key];
    await putJSON(env, FAVS_KEY, favs);
    return json({ ok: true });
  }
  if (request.method === "POST") {
    let b;
    try {
      b = JSON.parse((await request.text()).slice(0, 5000) || "{}");
    } catch {
      return json({ error: "طلب غير صالح." }, 400);
    }
    const vid = YT_ID.test(String(b.video_id || "")) ? b.video_id : null;
    if (!vid || !(b.source in LANGS) || !(b.dialect in DIALECTS)) return json({ error: "بيانات غير صحيحة." }, 400);
    const k = `${vid}__${b.source}__${b.dialect}`;
    const old = favs[k] || {};
    // تحديث المكان فقط (بدون إضافة) لو الفلم مو محفوظ
    if (b.position_only && !favs[k]) return json({ ok: true, saved: false });
    const num = (x, d) => (Number.isFinite(+x) && +x >= 0 ? Math.min(+x, 86400) : d);
    favs[k] = {
      key: k, video_id: vid, source: b.source, dialect: b.dialect,
      title: String(b.title ?? old.title ?? "").slice(0, 200),
      position: num(b.position, old.position || 0),
      duration: num(b.duration, old.duration || 0),
      added: old.added || Date.now(), updated: Date.now(),
    };
    if (Object.keys(favs).length > 300) return json({ error: "وصلت الحد (300 فلم محفوظ)." }, 400);
    await putJSON(env, FAVS_KEY, favs);
    return json({ ok: true, saved: true, favorite: favs[k] });
  }
  return json({ error: "غير مدعوم" }, 405);
}


async function pushApi(request, env, action) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  if (action === "key" && request.method === "GET") return json({ key: (await getVapid(env)).publicKey });
  if (request.method !== "POST") return json({ error: "غير مدعوم" }, 405);
  let b;
  try { b = JSON.parse((await request.text()).slice(0, 4000) || "{}"); } catch { return json({ error: "طلب غير صالح." }, 400); }
  if (action === "subscribe") {
    if (!validSubscription(b.subscription || {})) return json({ error: "اشتراك غير صالح." }, 400);
    await saveSub(env, b.subscription);
    return json({ ok: true });
  }
  if (action === "unsubscribe") {
    await removeSub(env, String(b.endpoint || ""));
    return json({ ok: true });
  }
  if (action === "test") {
    const n = await notifyAll(env, { title: "التنبيهات شغّالة ✅", body: "كذا بيوصلك خبر أول ما يجهز فلمك 🍿", url: "/" }, new URL(request.url).origin);
    return json({ ok: true, sent: n });
  }
  return json({ error: "غير موجود" }, 404);
}

export function toSrt(segments) {
  const ts = (t) => {
    let ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000); ms -= m * 60000;
    const s = Math.floor(ms / 1000); ms -= s * 1000;
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
  };
  let n = 0;
  const out = [];
  for (const s of segments) {
    if (!s.ar) continue;
    n++;
    out.push(String(n), `${ts(s.start)} --> ${ts(s.end)}`, "‫" + s.ar + "‬", "");
  }
  return out.join("\n");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/health") return json({ ok: true });
      if (path === "/api/config" && request.method === "GET")
        return json({
          languages: LANGS,
          dialects: DIALECTS,
          ready: Boolean(env.APP_PASSWORD && env.GH_TOKEN && env.INGEST_SECRET && env.BUCKET),
        });
      if (path === "/api/jobs" && request.method === "POST") return createJob(request, env);
      let m = path.match(/^\/api\/jobs\/([a-f0-9]{12})(\/srt)?$/);
      if (m && request.method === "GET") return getJob(request, env, m[1], Boolean(m[2]));
      m = path.match(/^\/api\/ingest\/([a-f0-9]{12})$/);
      if (m && request.method === "POST") return ingest(request, env, m[1], ctx);
      m = path.match(/^\/api\/source\/([a-f0-9]{12})$/);
      if (m && request.method === "GET") return source(request, env, m[1]);
      m = path.match(/^\/api\/push\/(key|subscribe|unsubscribe|test)$/);
      if (m) return pushApi(request, env, m[1]);
      m = path.match(/^\/api\/favorites(?:\/([A-Za-z0-9_-]{11}__[a-z]+__[a-z]+))?$/);
      if (m) return favorites(request, env, m[1]);
      if (path.startsWith("/api/")) return json({ error: "غير موجود" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.log("error", e && e.stack);
      return json({ error: "صار خطأ في الخادم." }, 500);
    }
  },
};
