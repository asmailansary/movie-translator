/**
 * مترجم الأفلام — Worker على Cloudflare
 * - يعرض الصفحة (من مجلد public)
 * - يستقبل طلب الترجمة ويشغّل GitHub Actions
 * - يستقبل الترجمة من GitHub أول بأول ويحفظها في R2
 * - يعطي الصفحة الترجمة الجاهزة
 *
 * الأسرار المطلوبة (Settings → Variables and Secrets):
 *   GH_TOKEN       مفتاح GitHub يقدر يشغّل Actions في مستودع الأداة
 *   INGEST_SECRET  كلمة سر بين GitHub و Cloudflare (نفسها في الجهتين)
 */

import { getVapid, saveSub, removeSub, notifyAll, validSubscription } from "./push.js";
import { WINDOW, systemPrompt, translateLines } from "./edge.js";

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

// معرّف موحّد: يوتيوب (11 حرف)، تيك توك tt_رقم، انستا ig_كود
const VID_RE = /^(?:[A-Za-z0-9_-]{11}|tt_\d{6,25}|ig_[A-Za-z0-9_-]{5,40})$/;
const VID_PART = "(?:[A-Za-z0-9_-]{11}|tt_\\d{6,25}|ig_[A-Za-z0-9_-]{5,40})";

async function parseMedia(raw) {
  const url = String(raw || "").trim();
  const yt = extractVideoId(url);
  if (yt) return { vid: yt, platform: "youtube", url: `https://www.youtube.com/watch?v=${yt}`, shorts: /\/shorts\//.test(url) };
  let u;
  try { u = new URL(url.includes("://") ? url : "https://" + url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  // روابط تيك توك المختصرة: نفتحها عشان نعرف رقم المقطع
  if (["vm.tiktok.com", "vt.tiktok.com"].includes(host) || (host === "tiktok.com" && u.pathname.startsWith("/t/"))) {
    try {
      const r = await fetch(u.href, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } });
      const loc = r.headers.get("location");
      if (loc) return parseMedia(new URL(loc, u.href).href);
    } catch {}
    return null;
  }
  if (host.endsWith("tiktok.com")) {
    const m = u.pathname.match(/\/(?:video|photo)\/(\d{6,25})/);
    if (m) return { vid: `tt_${m[1]}`, platform: "tiktok", url: `https://www.tiktok.com/@_/video/${m[1]}` };
  }
  if (host === "instagram.com" || host === "instagr.am") {
    const m = u.pathname.match(/^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,40})/);
    if (m) return { vid: `ig_${m[1]}`, platform: "instagram", url: `https://www.instagram.com/reel/${m[1]}/` };
  }
  return null;
}

const jobKey = (id) => `jobs/${id}.json`;
const mediaKey = (vid) => `media/${vid}.mp4`;
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
          media_url: job.platform === "youtube" ? "" : job.media_url,
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

// ───────── هوية الجهاز (بدل كلمة المرور) ─────────
// كل جهاز له رمز عشوائي طويل محفوظ عنده، فمحفوظته وإشعاراته له بس
const DEV_RE = /^[A-Za-z0-9_-]{22,64}$/;
const deviceOf = (request) => {
  const d = request.headers.get("x-device") || "";
  return DEV_RE.test(d) ? d : null;
};
const userKey = (dev, name) => `users/${dev}/${name}`;
const noDevice = () => json({ error: "حدّث الصفحة وجرّب مرة ثانية 🔄" }, 400);

// حد يومي عشان ما تنتهي الحدود المجانية لو انتشر الرابط
async function checkLimit(env, dev) {
  const perDevice = parseInt(env.DAILY_PER_DEVICE || "8", 10);
  const all = parseInt(env.DAILY_TOTAL || "30", 10);
  const key = `limits/${new Date().toISOString().slice(0, 10)}.json`;
  const l = (await getJSON(env, key)) || { total: 0, devices: {} };
  if ((l.devices[dev] || 0) >= perDevice) return `وصلت حدك اليوم (${perDevice} ترجمات جديدة) 😅 ارجع بكرة، واللي مترجم من قبل يفتح عادي`;
  if (l.total >= all) return "الأداة وصلت حدها اليوم 😅 ارجع بكرة، واللي مترجم من قبل يفتح عادي";
  l.total++;
  l.devices[dev] = (l.devices[dev] || 0) + 1;
  await putJSON(env, key, l);
  return null;
}

async function createJob(request, env) {
  if (!env.GH_TOKEN || !env.INGEST_SECRET)
    return json({ error: "الأداة ناقصها إعدادات 🛠️" }, 503);
  const dev = deviceOf(request);
  if (!dev) return noDevice();
  let body;
  try {
    body = JSON.parse((await request.text()).slice(0, 10000) || "{}");
  } catch {
    return json({ error: "طلب غير صالح." }, 400);
  }
  const kind = body.kind === "clip" ? "clip" : "movie";
  const media = await parseMedia(body.url);
  const source = body.source || "auto";
  const dialect = body.dialect || "najdi";
  if (!media) return json({ error: kind === "clip" ? "الرابط مو رابط مقطع من يوتيوب أو تيك توك أو انستا 🤔" : "الرابط مو رابط فيديو يوتيوب صحيح 🤔" }, 400);
  if (kind === "movie" && media.platform !== "youtube") return json({ error: "هذا رابط مقطع سوشل 📱 حطه في خانة «رابط المقطع من السوشل»" }, 400);
  const vid = media.vid, shortsHint = media.shorts || media.platform !== "youtube";
  const meta = { platform: media.platform, kind, media_url: media.url };
  if (!(source in LANGS) || !(dialect in DIALECTS)) return json({ error: "اختيار اللغة أو اللهجة غير صحيح." }, 400);

  // ترجمة جاهزة من قبل؟
  const cached = await env.BUCKET.head(subsKey(vid, source, dialect));
  if (cached) {
    const id = newId();
    await putJSON(env, jobKey(id), {
      id, video_id: vid, source, dialect, status: "done", cached: true, ...meta,
      stage: "جاهز ✓ ترجمته من قبل 🎬", progress: 1, ready_until: 1e9,
      title: cached.customMetadata?.title || "", created: Date.now(), updated: Date.now(),
    });
    return json({ job_id: id, video_id: vid, platform: media.platform });
  }

  // نفس الفلم يترجم الحين؟
  const activeObj = await env.BUCKET.get(activeKey(vid, source, dialect));
  if (activeObj) {
    const activeId = await activeObj.text();
    const existing = await getJSON(env, jobKey(activeId));
    if (existing && ["queued", "running"].includes(checkTimeouts(existing).status)) {
      if (!existing.owners?.includes(dev)) {   // جهاز ثاني ينتظر نفس الفلم: نعلمه بعد
        existing.owners = [...(existing.owners || []), dev].slice(-20);
        await putJSON(env, jobKey(activeId), existing);
      }
      return json({ job_id: activeId, video_id: vid, platform: media.platform });
    }
  }

  // الفلم مسموع من قبل بلهجة ثانية؟ نترجم بس، بدون سحب الصوت من جديد
  const reuse = await findTranscript(env, vid);
  if (!reuse) {   // الحد اليومي على الأفلام الجديدة بس (تبديل اللهجة ما يُحسب)
    const limited = await checkLimit(env, dev);
    if (limited) return json({ error: limited }, 429);
  }
  const id = newId();
  const job = {
    id, video_id: vid, source, dialect, status: "queued", reuse, owners: [dev], aspect: shortsHint ? 0.5625 : 0, ...meta,
    stage: reuse ? `نترجم ${dialect === "fusha" ? "بالفصحى" : "باللهجة ال" + DIALECTS[dialect].name} ⚡` : "نجهّز لك الفلم… 🍿", progress: 0.01,
    title: "", duration: 0, ready_until: 0, error: null, segments: [],
    created: Date.now(), updated: Date.now(),
  };
  // تبديل لهجة + مفتاح Gemini موجود في Cloudflare: نترجم هنا مباشرة بدون انتظار GitHub
  if (reuse && env.GEMINI_API_KEY) {
    Object.assign(job, { edge: true, status: "running", windows_done: [], progress: 0.02 });
    await putJSON(env, jobKey(id), job);
    await env.BUCKET.put(activeKey(vid, source, dialect), id);
    return json({ job_id: id, video_id: vid, platform: media.platform, edge: true });
  }
  await putJSON(env, jobKey(id), job);
  const err = await dispatch(env, job, new URL(request.url).origin);
  if (err) {
    job.status = "error";
    job.error = err;
    await putJSON(env, jobKey(id), job);
    return json({ error: err }, 502);
  }
  await env.BUCKET.put(activeKey(vid, source, dialect), id);
  return json({ job_id: id, video_id: vid, platform: media.platform });
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
    title: subs.title || "", duration: subs.duration || 0, aspect: subs.aspect || 0,
    have: await readyDialects(env, job.video_id, job.source),
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
    job.aspect = subs?.aspect || 0;
    job.media_ready = Boolean(subs?.media_ready);
  }
  return checkTimeouts(job);
}

async function getJob(request, env, id, wantSrt) {
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
  const ready = await readyDialects(env, job.video_id, job.source);
  return json({
    platform: job.platform || "youtube", kind: job.kind || "movie", media_ready: Boolean(job.media_ready), ready_dialects: ready,
    edge: Boolean(job.edge && job.status !== "done"), windows_done: job.windows_done || [], window: WINDOW,
    video_id: job.video_id, source: job.source, dialect: job.dialect, status: job.status, stage: job.status === "error" ? job.error : job.stage,
    progress: job.progress || 0, title: job.title || "", duration: job.duration || 0, aspect: job.aspect || 0,
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
  for (const k of ["status", "stage", "progress", "title", "duration", "ready_until", "error", "aspect", "media_ready"])
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
    const clip = job.kind === "clip";
    const name = job.title ? `«${job.title.slice(0, 60)}»` : (clip ? "مقطعك" : "فلمك");
    const msg = job.status === "error"
      ? { title: clip ? "صار شي بالمقطع 😕" : "صار شي بالفلم 😕", body: `${name} ما ضبط معنا، افتح الأداة وشوف وش السالفة`, url: `/?job=${id}` }
      : clip
        ? { title: "مقطعك جاهز 👀", body: `${name} صار مفهوم بلهجتك، تعال شوف وش ينقال 👨🏻‍🎨`, url: `/?job=${id}` }
        : { title: "فلمك جاهز 🍿", body: `${name} صار جاهز بالترجمة، يلا نبدأ؟ 🎬`, url: `/?job=${id}` };
    const origin = new URL(request.url).origin;
    ctx.waitUntil(notifyAll(env, msg, origin, job.owners || []).catch((e) => console.log("notify", e)));
  }
  if (job.status === "done") await writeSubs(env, job, job.dialect, job.segments);
  return json({ ok: true });
}

async function writeSubs(env, job, dialect, segments) {
  await env.BUCKET.put(
    subsKey(job.video_id, job.source, dialect),
    JSON.stringify({ video_id: job.video_id, title: job.title, duration: job.duration, aspect: job.aspect || 0,
      platform: job.platform || "youtube", kind: job.kind || "movie", media_url: job.media_url || "", media_ready: Boolean(job.media_ready), segments }),
    { httpMetadata: { contentType: "application/json" }, customMetadata: { title: (job.title || "").slice(0, 200), kind: job.kind || "movie" } }
  );
}

// اللهجات الجاهزة لهالفلم (عشان التبديل الفوري)
async function readyDialects(env, vid, src) {
  const list = await env.BUCKET.list({ prefix: `subs/v2/${vid}__${src}__`, limit: 20 });
  return (list.objects || []).map((o) => o.key.split("__").pop().replace(".json", "")).filter((d) => d in DIALECTS);
}

// GitHub يرسل ترجمة لهجة ثانية جهزت في الخلفية
async function ingestDialect(request, env, id, dialect) {
  if (!(await safeEqual(request.headers.get("x-ingest-secret") || "", env.INGEST_SECRET)))
    return json({ error: "unauthorized" }, 401);
  if (!(dialect in DIALECTS)) return json({ error: "bad dialect" }, 400);
  const job = await getJSON(env, jobKey(id));
  if (!job) return json({ error: "not found" }, 404);
  const p = await request.json();
  const segs = (p.segments || []).filter((s) => typeof s.start === "number" && typeof s.end === "number")
    .map((s) => ({ start: s.start, end: s.end, src: String(s.src || ""), ar: String(s.ar || "") }));
  if (!segs.length) return json({ error: "empty" }, 400);
  await writeSubs(env, job, dialect, segs);
  return json({ ok: true });
}

// GitHub يرفع المقطع (تيك توك/انستا) عشان نشغّله بمشغّلنا
async function ingestMedia(request, env, id) {
  if (!(await safeEqual(request.headers.get("x-ingest-secret") || "", env.INGEST_SECRET)))
    return json({ error: "unauthorized" }, 401);
  const job = await getJSON(env, jobKey(id));
  if (!job || job.platform === "youtube") return json({ error: "not found" }, 404);
  await env.BUCKET.put(mediaKey(job.video_id), request.body, { httpMetadata: { contentType: "video/mp4" } });
  job.media_ready = true;
  job.updated = Date.now();
  await putJSON(env, jobKey(id), job);
  // تنظيف: المقاطع الأقدم من ١٤ يوم تنمسح عشان المساحة
  const old = Date.now() - 14 * 864e5;
  const list = await env.BUCKET.list({ prefix: "media/", limit: 500 });
  for (const o of list.objects || []) if (o.uploaded && new Date(o.uploaded).getTime() < old) await env.BUCKET.delete(o.key);
  return json({ ok: true });
}

// تشغيل المقطع المحفوظ (مع دعم التقديم/الرجوع اللي يحتاجه الآيفون)
async function serveMedia(request, env, vid) {
  const range = request.headers.get("range");
  let opts = {};
  const m = range && range.match(/bytes=(\d*)-(\d*)/);
  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : undefined, end = m[2] ? parseInt(m[2], 10) : undefined;
    opts.range = start === undefined ? { suffix: end } : end === undefined ? { offset: start } : { offset: start, length: end - start + 1 };
  }
  const obj = await env.BUCKET.get(mediaKey(vid), opts);
  if (!obj) return new Response("المقطع انتهت صلاحيته، افتحه من جديد 🔄", { status: 404 });
  const h = new Headers({ "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" });
  if (m && obj.range) {
    const off = obj.range.offset ?? (obj.size - obj.range.suffix);
    const len = obj.range.length ?? (obj.size - off);
    h.set("content-range", `bytes ${off}-${off + len - 1}/${obj.size}`);
    h.set("content-length", String(len));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set("content-length", String(obj.size));
  return new Response(obj.body, { headers: h });
}


// ───────── التبديل السريع (يترجم القطعة اللي تتفرج فيها) ─────────
async function edgeStep(request, env, id, ctx) {
  const job = await getJSON(env, jobKey(id));
  if (!job) return json({ error: "غير موجود" }, 404);
  if (!job.edge || job.status === "done") return json({ done: job.status === "done", fallback: !job.edge && job.status !== "done" });
  const src = await getJSON(env, job.reuse);
  if (!src) return json({ error: "غير موجود" }, 404);
  const lines = src.segments || [];
  const total = Math.max(1, Math.ceil(Math.max(...lines.map((l) => l.end), 1) / WINDOW));
  const done = new Set(job.windows_done || []);
  const at = Math.max(0, parseFloat(new URL(request.url).searchParams.get("at")) || 0);
  // أول شي القطعة اللي تتفرج فيها، بعدها اللي بعدها، وآخر شي اللي قبلها
  const here = Math.min(total - 1, Math.floor(at / WINDOW));
  let w = -1;
  for (let i = here; i < total && w < 0; i++) if (!done.has(i)) w = i;
  for (let i = 0; i < here && w < 0; i++) if (!done.has(i)) w = i;
  if (w < 0) w = here;
  const part = lines.filter((l) => l.start >= w * WINDOW && l.start < (w + 1) * WINDOW).map(({ start, end, src }) => ({ start, end, src }));
  const before = lines.filter((l) => l.start < w * WINDOW).slice(-3).map((l) => l.src);
  let out = [];
  if (part.length) {
    try {
      out = await translateLines(env, systemPrompt(job.dialect, DIALECTS[job.dialect].name, src.title), part, before);
    } catch (e) {
      // ما ضبط هنا (مثلاً خلص حد Gemini): نكمل بالطريقة العادية عن طريق GitHub
      job.edge = false; job.status = "queued"; job.stage = "نكمل الترجمة… ⏳"; job.created = Date.now();
      await putJSON(env, jobKey(id), job);
      const err = await dispatch(env, job, new URL(request.url).origin);
      if (err) { job.status = "error"; job.error = err; await putJSON(env, jobKey(id), job); }
      return json({ fallback: true });
    }
  }
  // نعيد قراءة المهمة (ممكن جهاز ثاني ترجم قطعة بنفس الوقت)
  const fresh = (await getJSON(env, jobKey(id))) || job;
  const doneNow = new Set(fresh.windows_done || []);
  if (!doneNow.has(w)) {
    doneNow.add(w);
    fresh.segments = [...(fresh.segments || []), ...out].sort((a, b) => a.start - b.start);
  }
  fresh.windows_done = [...doneNow].sort((a, b) => a - b);
  fresh.progress = Math.min(0.99, doneNow.size / total);
  fresh.stage = `نترجم ${fresh.dialect === "fusha" ? "بالفصحى" : "باللهجة ال" + DIALECTS[fresh.dialect].name} ⚡ (${doneNow.size} من ${total})`;
  fresh.updated = Date.now();
  if (doneNow.size >= total) {
    fresh.status = "done"; fresh.progress = 1; fresh.ready_until = 1e9; fresh.edge = false;
    fresh.stage = "الترجمة كلها جاهزة ✓ استمتع 🎬";
    await writeSubs(env, fresh, fresh.dialect, fresh.segments);
    await env.BUCKET.delete(activeKey(fresh.video_id, fresh.source, fresh.dialect));
  }
  await putJSON(env, jobKey(id), fresh);
  return json({ window: w, segments: out, windows_done: fresh.windows_done, total, done: fresh.status === "done", stage: fresh.stage, progress: fresh.progress });
}

// ───────── المستخدمين (تمهيداً لإرسال إشعارات للكل لاحقاً) ─────────
// نحفظ بس رمز الجهاز العشوائي وتواريخ الاستخدام، بدون أي معلومات شخصية
async function hello(request, env) {
  const dev = deviceOf(request);
  if (!dev) return noDevice();
  let b = {};
  try { b = JSON.parse((await request.text()).slice(0, 500) || "{}"); } catch {}
  const key = userKey(dev, "profile.json");
  const p = (await getJSON(env, key)) || { first: Date.now(), visits: 0 };
  const today = new Date().toISOString().slice(0, 10);
  if (p.lastDay !== today) {   // مرة وحدة باليوم بس، عشان ما نكثر الكتابة
    Object.assign(p, { last: Date.now(), lastDay: today, visits: (p.visits || 0) + 1, app: Boolean(b.app), push: Boolean(b.push) });
    await putJSON(env, key, p);
  }
  return json({ ok: true });
}

async function adminStats(request, env) {
  if (!env.ADMIN_KEY || !(await safeEqual(request.headers.get("x-admin-key") || "", env.ADMIN_KEY)))
    return json({ error: "غير مصرّح" }, 401);
  let cursor, users = 0, withPush = 0, app = 0, active7 = 0;
  const week = Date.now() - 7 * 864e5;
  do {
    const list = await env.BUCKET.list({ prefix: "users/", cursor, limit: 1000 });
    for (const o of list.objects || []) {
      if (!o.key.endsWith("/profile.json")) continue;
      const p = await getJSON(env, o.key);
      users++; if (p?.push) withPush++; if (p?.app) app++; if ((p?.last || 0) > week) active7++;
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return json({ users, app, withPush, active7 });
}

// ───────── المحفوظة (القلب) ─────────
async function favorites(request, env, key) {
  const dev = deviceOf(request);
  if (!dev) return noDevice();
  const myKey = userKey(dev, "favorites.json");
  let favs = await getJSON(env, myKey);
  if (!favs) {   // نقل المحفوظة القديمة (أيام كلمة المرور) لأول جهاز يفتح بعد التحديث
    favs = (await getJSON(env, FAVS_KEY)) || {};
    if (Object.keys(favs).length) { await putJSON(env, myKey, favs); await env.BUCKET.delete(FAVS_KEY); }
  }
  if (request.method === "GET") {
    const list = Object.values(favs).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    return json({ favorites: list });
  }
  if (request.method === "DELETE") {
    if (!key || !favs[key]) return json({ error: "غير موجود" }, 404);
    delete favs[key];
    await putJSON(env, myKey, favs);
    return json({ ok: true });
  }
  if (request.method === "POST") {
    let b;
    try {
      b = JSON.parse((await request.text()).slice(0, 5000) || "{}");
    } catch {
      return json({ error: "طلب غير صالح." }, 400);
    }
    const vid = VID_RE.test(String(b.video_id || "")) ? b.video_id : null;
    if (!vid || !(b.source in LANGS) || !(b.dialect in DIALECTS)) return json({ error: "بيانات غير صحيحة." }, 400);
    const k = `${vid}__${b.source}__${b.dialect}`;
    const old = favs[k] || {};
    // تحديث المكان فقط (بدون إضافة) لو الفلم مو محفوظ
    if (b.position_only && !favs[k]) return json({ ok: true, saved: false });
    const num = (x, d) => (Number.isFinite(+x) && +x >= 0 ? Math.min(+x, 86400) : d);
    favs[k] = {
      key: k, video_id: vid, source: b.source, dialect: b.dialect,
      kind: b.kind === "clip" ? "clip" : (old.kind || "movie"),
      url: /^https:\/\/(www\.)?(youtube\.com|youtu\.be|tiktok\.com|instagram\.com)\//.test(String(b.url || "")) ? String(b.url).slice(0, 300) : (old.url || ""),
      title: String(b.title ?? old.title ?? "").slice(0, 200),
      position: num(b.position, old.position || 0),
      duration: num(b.duration, old.duration || 0),
      added: old.added || Date.now(), updated: Date.now(),
    };
    if (Object.keys(favs).length > 300) return json({ error: "وصلت الحد (300 فلم محفوظ)." }, 400);
    await putJSON(env, myKey, favs);
    return json({ ok: true, saved: true, favorite: favs[k] });
  }
  return json({ error: "غير مدعوم" }, 405);
}


async function pushApi(request, env, action) {
  const dev = deviceOf(request);
  if (!dev) return noDevice();
  if (action === "key" && request.method === "GET") return json({ key: (await getVapid(env)).publicKey });
  if (request.method !== "POST") return json({ error: "غير مدعوم" }, 405);
  let b;
  try { b = JSON.parse((await request.text()).slice(0, 4000) || "{}"); } catch { return json({ error: "طلب غير صالح." }, 400); }
  if (action === "subscribe") {
    if (!validSubscription(b.subscription || {})) return json({ error: "اشتراك غير صالح." }, 400);
    await saveSub(env, b.subscription, dev);
    return json({ ok: true });
  }
  if (action === "unsubscribe") {
    await removeSub(env, String(b.endpoint || ""), dev);
    return json({ ok: true });
  }
  if (action === "test") {
    const n = await notifyAll(env, { title: "فهّمني 🍿", body: "تم وكذا بيوصلك خبر أول ما يجهز محتواك✨", url: "/" }, new URL(request.url).origin, [dev]);
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
          ready: Boolean(env.GH_TOKEN && env.INGEST_SECRET && env.BUCKET),
        });
      if (path === "/api/jobs" && request.method === "POST") return createJob(request, env);
      let m = path.match(/^\/api\/jobs\/([a-f0-9]{12})(\/srt)?$/);
      if (m && request.method === "GET") return getJob(request, env, m[1], Boolean(m[2]));
      m = path.match(/^\/api\/ingest\/([a-f0-9]{12})$/);
      if (m && request.method === "POST") return ingest(request, env, m[1], ctx);
      m = path.match(/^\/api\/edge\/([a-f0-9]{12})$/);
      if (m && request.method === "POST") return edgeStep(request, env, m[1], ctx);
      if (path === "/api/hello" && request.method === "POST") return hello(request, env);
      if (path === "/api/admin/stats" && request.method === "GET") return adminStats(request, env);
      m = path.match(/^\/api\/subs\/([a-f0-9]{12})\/([a-z]+)$/);
      if (m && request.method === "POST") return ingestDialect(request, env, m[1], m[2]);
      m = path.match(/^\/api\/media\/([a-f0-9]{12})$/);
      if (m && request.method === "PUT") return ingestMedia(request, env, m[1]);
      m = path.match(new RegExp(`^/media/(${VID_PART})\\.mp4$`));
      if (m && (request.method === "GET" || request.method === "HEAD")) return serveMedia(request, env, m[1]);
      m = path.match(/^\/api\/source\/([a-f0-9]{12})$/);
      if (m && request.method === "GET") return source(request, env, m[1]);
      m = path.match(/^\/api\/push\/(key|subscribe|unsubscribe|test)$/);
      if (m) return pushApi(request, env, m[1]);
      m = path.match(new RegExp(`^/api/favorites(?:/(${VID_PART}__[a-z]+__[a-z]+))?$`));
      if (m) return favorites(request, env, m[1]);
      if (path.startsWith("/api/")) return json({ error: "غير موجود" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.log("error", e && e.stack);
      return json({ error: "صار خطأ في الخادم." }, 500);
    }
  },
};
