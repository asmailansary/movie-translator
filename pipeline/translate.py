"""
مترجم الأفلام — الجزء اللي يشتغل على GitHub Actions
يحمّل صوت الفلم من يوتيوب، يفرّغه لنص (Groq Whisper — مجاني)،
يترجمه للعربية/اللهجات (Gemini — مجاني، و Groq احتياط)،
ويرسل الترجمة لـ Cloudflare أول بأول عشان تقدر تبدأ المشاهدة بسرعة.

يعتمد فقط على مكتبات بايثون الأساسية + yt-dlp + ffmpeg.
"""
import json
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

# ───────────────────────── الإعدادات ─────────────────────────
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()          # مجاني: التفريغ الصوتي (+ ترجمة احتياطية)
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()      # مجاني: الترجمة الأساسية
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()  # اختياري (مدفوع): أعلى جودة
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "").strip()          # فاضي = يختار أحدث موديل Flash تلقائياً
GROQ_LLM_MODEL = os.environ.get("GROQ_LLM_MODEL", "").strip() or "openai/gpt-oss-120b"
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "").strip() or "claude-sonnet-5-5"
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "").strip() or "whisper-large-v3"
YT_COOKIES = os.environ.get("YT_COOKIES", "")
MAX_MINUTES = int(os.environ.get("MAX_MINUTES", "").strip() or "240")

JOB_ID = os.environ.get("JOB_ID", "").strip()
VIDEO_ID = os.environ.get("VIDEO_ID", "").strip()
SOURCE = os.environ.get("SOURCE", "auto").strip()
DIALECT = os.environ.get("DIALECT", "najdi").strip()
CALLBACK = os.environ.get("CALLBACK", "").strip().rstrip("/")
INGEST_SECRET = os.environ.get("INGEST_SECRET", "").strip()

CHUNK_SECONDS = 600          # نقسم الصوت قطع كل وحدة 10 دقائق
TRANSLATE_BATCH = 50         # عدد الجمل في كل طلب ترجمة
TRANSLATE_WORKERS = 2        # قليل عشان ما نتعدى حدود الخطط المجانية

SOURCE_LANGS = {
    "auto": {"name": "تلقائي", "code": None},
    "en": {"name": "الإنجليزية", "code": "en"},
    "de": {"name": "الألمانية", "code": "de"},
    "fr": {"name": "الفرنسية", "code": "fr"},
}

DIALECTS = {
    "fusha": {
        "name": "الفصحى",
        "group": "fusha",
        "guide": "العربية الفصحى المعاصرة البسيطة كما في ترجمات الأفلام الاحترافية.",
    },
    "najdi": {
        "name": "نجدية",
        "group": "dialect",
        "guide": (
            "اللهجة النجدية (لهجة أهل الرياض والقصيم ونجد) كما يتكلمها الناس فعلاً. "
            "استخدم مفرداتها وتراكيبها الطبيعية مثل: وش، ليه، وشلون، ذحين/الحين، أبي/أبغى، "
            "مب/ما، زين، يا رجّال، ترى، هاه، ودّي، أبد، مرة (بمعنى جداً)، عاد، يالله، "
            "واجد (باعتدال)، تكفى، أبشر، خلاص، وين، منهو، هذولا، ذاك/ذيك. "
            "صيغ الأفعال النجدية: يبي، ما يبي، بيروح، قاعد يسوي، رحت، جيت. "
            "لا تكثر من الكلمات لدرجة التصنّع، خلّها طبيعية وعفوية مثل كلام شخص من الرياض."
        ),
    },
    "hijazi": {
        "name": "حجازية",
        "group": "dialect",
        "guide": "اللهجة الحجازية (جدة ومكة) الطبيعية: إيش، ليش، كدا، دحين، أبغى، مرة، يا شيخ، برضو، إيوه.",
    },
    "khaleeji": {
        "name": "خليجية",
        "group": "dialect",
        "guide": "اللهجة الخليجية العامة (كويت/إمارات/قطر/البحرين): شنو، ليش، شلون، الحين، أبي، وايد، زين، چذي.",
    },
    "yemeni": {
        "name": "يمنية",
        "group": "dialect",
        "guide": "اللهجة اليمنية (صنعانية مفهومة): ايش، ليش، كيف، ذلحين، اشتي، قده، يا خبير، مَه، شوف.",
    },
    "egyptian": {
        "name": "مصرية",
        "group": "dialect",
        "guide": "اللهجة المصرية القاهرية: إيه، ليه، إزاي، دلوقتي، عايز، أوي، كده، يا عم، طب، خلاص.",
    },
    "shami": {
        "name": "شامية",
        "group": "dialect",
        "guide": "اللهجة الشامية (سوريا/لبنان/فلسطين/الأردن): شو، ليش، كيف، هلق، بدّي، كتير، هيك، يا زلمة، منيح.",
    },
    "iraqi": {
        "name": "عراقية",
        "group": "dialect",
        "guide": "اللهجة العراقية البغدادية: شنو، ليش، شلون، هسه، أريد، كلش، هيچ، ماكو، اكو.",
    },
}

YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def extract_video_id(url: str):
    url = (url or "").strip()
    if YT_ID_RE.match(url):
        return url
    try:
        u = urlparse(url if "://" in url else "https://" + url)
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if host.startswith("m."):
        host = host[2:]
    vid = None
    if host == "youtu.be":
        vid = u.path.strip("/").split("/")[0]
    elif host in ("youtube.com", "music.youtube.com", "youtube-nocookie.com"):
        if u.path == "/watch":
            vid = (parse_qs(u.query).get("v") or [None])[0]
        else:
            parts = [p for p in u.path.split("/") if p]
            if len(parts) >= 2 and parts[0] in ("shorts", "embed", "live", "v"):
                vid = parts[1]
    return vid if vid and YT_ID_RE.match(vid) else None




# ───────────────────────── 1) تحميل الصوت ─────────────────────────
def download_audio(vid, workdir: Path):
    import yt_dlp  # يُستورد هنا عشان الخادم يشتغل حتى لو كان التحميل معطّل

    url = f"https://www.youtube.com/watch?v={vid}"
    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(workdir / "audio.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 3,
    }
    if YT_COOKIES.strip():
        cookie_file = workdir / "cookies.txt"
        cookie_file.write_text(YT_COOKIES)
        opts["cookiefile"] = str(cookie_file)

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        duration = info.get("duration") or 0
        if duration and duration > MAX_MINUTES * 60:
            raise UserError(f"الفلم أطول من الحد المسموح ({MAX_MINUTES} دقيقة).")
        ydl.download([url])

    files = [p for p in workdir.glob("audio.*") if p.suffix != ".part"]
    if not files:
        raise UserError("ما قدرت أحمّل صوت الفلم من يوتيوب.")
    return files[0], info.get("title") or "", duration


def split_audio(src: Path, workdir: Path):
    """يحوّل الصوت لقطع mp3 صغيرة (أحادي 16kHz) ويرجع [(ملف، بداية القطعة بالثواني)]."""
    out_dir = workdir / "chunks"
    out_dir.mkdir()
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
            "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k",
            "-f", "segment", "-segment_time", str(CHUNK_SECONDS), "-reset_timestamps", "1",
            str(out_dir / "c%03d.mp3"),
        ],
        check=True,
    )
    chunks, offset = [], 0.0
    for f in sorted(out_dir.glob("c*.mp3")):
        dur = probe_duration(f)
        chunks.append((f, offset))
        offset += dur
    return chunks


def probe_duration(path: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except ValueError:
        return float(CHUNK_SECONDS)


# ───────────────────────── 2) التفريغ الصوتي (Groq Whisper) ─────────────────────────
def http_json(url, headers, body: bytes, timeout=300, retries=4):
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")[:400]
            last = f"HTTP {e.code}: {detail}"
            if e.code in (401, 403):
                raise UserError("مفتاح الخدمة غير صحيح أو منتهي. راجع المفاتيح في إعدادات الاستضافة.")
            if e.code in (429, 500, 502, 503, 504, 529):
                wait = float(e.headers.get("retry-after") or (5 * (attempt + 1)))
                time.sleep(min(wait, 60))
                continue
            raise RuntimeError(last)
        except (urllib.error.URLError, TimeoutError) as e:
            last = str(e)
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"فشل الاتصال بعد عدة محاولات: {last}")


def transcribe_chunk(path: Path, offset: float, lang):
    boundary = "----mt" + uuid.uuid4().hex
    fields = {"model": WHISPER_MODEL, "response_format": "verbose_json", "temperature": "0"}
    if lang:
        fields["language"] = lang
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        f"Content-Type: audio/mpeg\r\n\r\n".encode()
        + path.read_bytes()
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    data = http_json(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        {"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": f"multipart/form-data; boundary={boundary}"},
        b"".join(parts),
    )
    out = []
    for s in data.get("segments") or []:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        if (s.get("no_speech_prob") or 0) > 0.85:   # موسيقى أو صمت
            continue
        out.append({"start": round(offset + float(s["start"]), 2), "end": round(offset + float(s["end"]), 2), "src": text})
    return out


def split_long_segments(segs, max_len=7.0):
    """يقسم الجمل الطويلة جداً عشان الترجمة ما تبقى على الشاشة مدة طويلة."""
    out = []
    for s in segs:
        dur = s["end"] - s["start"]
        words = s["src"].split()
        if dur <= max_len or len(words) < 8:
            out.append(s)
            continue
        n = min(int(dur // max_len) + 1, max(1, len(words) // 4))
        per = len(words) / n
        for i in range(n):
            w = words[round(i * per): round((i + 1) * per)]
            if not w:
                continue
            out.append({
                "start": round(s["start"] + dur * i / n, 2),
                "end": round(s["start"] + dur * (i + 1) / n, 2),
                "src": " ".join(w),
            })
    return out


# ───────────────────────── 3) الترجمة (Gemini / Groq / Claude) ─────────────────────────
def build_system_prompt(dialect_key, title):
    d = DIALECTS[dialect_key]
    return (
        "أنت مترجم ترجمة أفلام (Subtitles) محترف. تترجم حوار الفلم إلى العربية.\n"
        f"اللغة/اللهجة المطلوبة: {d['name']}.\n"
        f"وصف اللهجة: {d['guide']}\n"
        f"عنوان الفلم: {title or 'غير معروف'}\n\n"
        "القواعد:\n"
        "- ترجم المعنى والإحساس، مو ترجمة حرفية. خلّ الكلام طبيعي كأن الممثل يتكلم بهذي اللهجة.\n"
        "- الجملة قصيرة وتنقرأ بسرعة على الشاشة.\n"
        "- أسماء الأشخاص والأماكن تكتبها بالحروف العربية.\n"
        "- الشتائم والكلام البذيء خفّفه بشكل مناسب.\n"
        "- إذا كان النص أصوات أو موسيقى أو كلام غير مفهوم، رجّع نص فاضي \"\".\n"
        "- لا تدمج الجمل ولا تقسمها: كل رقم i له ترجمة وحدة بالضبط.\n"
        "- رجّع JSON فقط بهذا الشكل بدون أي كلام ثاني: "
        '[{"i": 0, "ar": "..."}, {"i": 1, "ar": "..."}]'
    )


def translators():
    order = []
    if GEMINI_API_KEY:
        order.append(("gemini", call_gemini))
    if ANTHROPIC_API_KEY:
        order.insert(0, ("claude", call_claude))   # لو حطيت مفتاح Claude يصير هو الأول
    if GROQ_API_KEY:
        order.append(("groq", call_groq_llm))
    return order


def call_llm(system, user_text):
    """يجرب خدمات الترجمة بالترتيب؛ لو وحدة خلص رصيدها اليومي ينتقل للي بعدها."""
    last = None
    for name, fn in translators():
        try:
            return fn(system, user_text)
        except UserError:
            raise
        except Exception as e:  # noqa: BLE001
            print(f"[{name}] فشل، أجرب اللي بعده:", str(e)[:200])
            last = e
    raise last or UserError("ما فيه أي مفتاح ترجمة.")


_gemini_model = {"name": GEMINI_MODEL}
_gemini_lock = threading.Lock()


def pick_gemini_model():
    """يختار أحدث موديل Flash متاح في الخطة المجانية."""
    with _gemini_lock:
        if _gemini_model["name"]:
            return _gemini_model["name"]
        req = urllib.request.Request(
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
            headers={"x-goog-api-key": GEMINI_API_KEY},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            models = json.loads(r.read().decode("utf-8")).get("models", [])
        bad = ("lite", "image", "tts", "live", "audio", "embed", "exp", "preview", "thinking", "8b")
        names = [m["name"].split("/", 1)[1] for m in models
                 if "generateContent" in (m.get("supportedGenerationMethods") or [])
                 and "flash" in m["name"] and not any(b in m["name"] for b in bad)]
        if not names:   # لو ما لقى نسخة مستقرة، يقبل التجريبية
            names = [m["name"].split("/", 1)[1] for m in models
                     if "generateContent" in (m.get("supportedGenerationMethods") or [])
                     and "flash" in m["name"] and not any(b in m["name"] for b in bad[:6])]
        if not names:
            raise RuntimeError("ما لقيت موديل Gemini Flash متاح لهذا المفتاح.")

        def ver(n):
            return [int(x) for x in re.findall(r"\d+", n)] or [0]
        _gemini_model["name"] = sorted(names, key=ver)[-1]
        print("✓ موديل Gemini المختار:", _gemini_model["name"])
        return _gemini_model["name"]


def call_gemini(system, user_text):
    model = pick_gemini_model()
    body = json.dumps({
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {"temperature": 0.4, "responseMimeType": "application/json", "maxOutputTokens": 8192},
    }).encode("utf-8")
    try:
        data = http_json(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            {"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"},
            body, retries=3,
        )
    except RuntimeError as e:
        if "HTTP 404" in str(e) and not GEMINI_MODEL:   # الموديل انسحب؛ نختار غيره
            _gemini_model["name"] = ""
        raise
    parts = ((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    return "".join(p.get("text", "") for p in parts if not p.get("thought"))


def call_groq_llm(system, user_text):
    body = json.dumps({
        "model": GROQ_LLM_MODEL,
        "temperature": 0.4,
        "max_completion_tokens": 8000,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user_text}],
    }).encode("utf-8")
    data = http_json(
        "https://api.groq.com/openai/v1/chat/completions",
        {"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
        body,
    )
    return data["choices"][0]["message"]["content"] or ""


def call_claude(system, user_text):
    body = json.dumps({
        "model": CLAUDE_MODEL,
        "max_tokens": 8000,
        "system": system,
        "messages": [{"role": "user", "content": user_text}],
    }).encode("utf-8")
    data = http_json(
        "https://api.anthropic.com/v1/messages",
        {"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        body,
    )
    return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")


def parse_translation(text, n):
    a, b = text.find("["), text.rfind("]")
    if a < 0 or b < 0:
        return None
    try:
        arr = json.loads(text[a: b + 1])
    except json.JSONDecodeError:
        return None
    out = [None] * n
    for item in arr:
        if isinstance(item, dict) and isinstance(item.get("i"), int) and 0 <= item["i"] < n:
            out[item["i"]] = str(item.get("ar") or "").strip()
    return out


def translate_batch(segs, system, context):
    payload = {
        "سياق_سابق": context,
        "الجمل": [{"i": i, "t": s["src"]} for i, s in enumerate(segs)],
    }
    user = "ترجم هذي الجمل (السياق السابق للفهم فقط، لا تترجمه):\n" + json.dumps(payload, ensure_ascii=False)
    for _ in range(3):
        result = parse_translation(call_llm(system, user), len(segs))
        if result and sum(1 for r in result if r is not None) >= len(segs) * 0.8:
            return [r if r is not None else s["src"] for r, s in zip(result, segs)]
    return [s["src"] for s in segs]   # آخر حل: النص الأصلي بدل ما يضيع


# ───────────────────────── إرسال التقدم لـ Cloudflare ─────────────────────────
class UserError(Exception):
    pass


def report(**payload):
    """يرسل حالة المهمة (والجمل الجديدة) للـ Worker."""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    for attempt in range(5):
        req = urllib.request.Request(
            f"{CALLBACK}/api/ingest/{JOB_ID}", data=body, method="POST",
            headers={"Content-Type": "application/json", "X-Ingest-Secret": INGEST_SECRET,
                     "User-Agent": "movie-translator-pipeline"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                r.read()
                return
        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 404):
                raise RuntimeError(f"Cloudflare رفض التحديث (HTTP {e.code}) — تأكد إن INGEST_SECRET نفسه في الجهتين.")
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(3 * (attempt + 1))
    raise RuntimeError("ما قدرت أوصل لـ Cloudflare.")


def validate_inputs():
    if not re.fullmatch(r"[a-f0-9]{12}", JOB_ID):
        sys.exit("JOB_ID غير صالح")
    if not YT_ID_RE.match(VIDEO_ID):
        sys.exit("VIDEO_ID غير صالح")
    if SOURCE not in SOURCE_LANGS or DIALECT not in DIALECTS:
        sys.exit("اللغة أو اللهجة غير صحيحة")
    u = urlparse(CALLBACK)
    if u.scheme != "https" or not u.hostname or u.path not in ("", "/"):
        sys.exit("CALLBACK غير صالح")
    if not INGEST_SECRET:
        sys.exit("INGEST_SECRET ناقص")
    if not GROQ_API_KEY:
        raise UserError("مفتاح GROQ_API_KEY ناقص في أسرار GitHub.")
    if not (GEMINI_API_KEY or ANTHROPIC_API_KEY):
        print("ℹ️  ما فيه GEMINI_API_KEY — الترجمة بتكون عن طريق Groq (جودة اللهجات أقل).")


# ───────────────────────── تشغيل المهمة كاملة ─────────────────────────
def run():
    workdir = Path(tempfile.mkdtemp(prefix="mt_"))
    report(status="running", stage="تحميل صوت الفلم من يوتيوب…", progress=0.03)
    audio, title, duration = download_audio(VIDEO_ID, workdir)
    report(title=title, duration=duration, stage="تجهيز الصوت…", progress=0.08)

    chunks = split_audio(audio, workdir)
    total = len(chunks)
    system = build_system_prompt(DIALECT, title)
    lang = SOURCE_LANGS[SOURCE]["code"]

    # التفريغ يشتغل بخيط لحاله، والترجمة تمشي وراه قطعة قطعة
    q: queue.Queue = queue.Queue()

    def transcriber():
        try:
            for path, offset in chunks:
                q.put(("ok", split_long_segments(transcribe_chunk(path, offset, lang))))
        except Exception as e:  # noqa: BLE001
            q.put(("err", e))
        q.put(("done", None))

    threading.Thread(target=transcriber, daemon=True).start()

    done_chunks, context, pool = 0, [], ThreadPoolExecutor(TRANSLATE_WORKERS)
    while True:
        kind, val = q.get()
        if kind == "err":
            raise val
        if kind == "done":
            break
        segs = val
        batches = [segs[i: i + TRANSLATE_BATCH] for i in range(0, len(segs), TRANSLATE_BATCH)]
        futures = []
        for bi, batch in enumerate(batches):
            ctx = context if bi == 0 else [s["src"] for s in batches[bi - 1][-3:]]
            futures.append(pool.submit(translate_batch, batch, system, ctx))
        for batch, fut in zip(batches, futures):
            for s, ar in zip(batch, fut.result()):
                s["ar"] = ar
        if segs:
            context = [s["src"] for s in segs[-3:]]
        done_chunks += 1
        last = done_chunks >= total
        report(
            append=segs,
            stage="خلصت الترجمة ✓" if last else f"ترجمة… ({done_chunks} من {total})",
            progress=1.0 if last else round(0.08 + 0.92 * done_chunks / max(total, 1), 3),
            ready_until=10**9 if last else chunks[done_chunks][1],
            **({"status": "done"} if last else {}),
        )
    pool.shutdown()
    if total == 0:
        report(status="done", stage="خلصت الترجمة ✓", progress=1.0, ready_until=10**9)


def friendly_error(e):
    msg = str(e)
    if isinstance(e, UserError):
        return msg
    if "Sign in to confirm" in msg or "not a bot" in msg:
        return "يوتيوب منع GitHub من تحميل الفلم (يحسبه روبوت). شوف قسم «الكوكيز» في الدليل."
    if "Private video" in msg or "Video unavailable" in msg:
        return "الفلم خاص أو غير متاح."
    return "صار خطأ أثناء المعالجة: " + msg[:300]


def main():
    validate_inputs()
    try:
        run()
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        try:
            report(status="error", error=friendly_error(e))
        finally:
            sys.exit(1)


if __name__ == "__main__":
    main()
