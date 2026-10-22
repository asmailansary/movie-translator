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
REUSE = os.environ.get("REUSE", "0").strip() == "1"   # الكلام الأصلي جاهز من قبل: نترجم بس
MEDIA_URL = os.environ.get("MEDIA_URL", "").strip()   # مقطع تيك توك/انستا (غير يوتيوب)
BG_ORDER = ["najdi", "fusha", "hijazi", "yemeni", "egyptian", "iraqi", "moroccan", "libyan", "algerian"]

# Groq يرفض الطلبات اللي توقيعها Python-urllib (خطأ 1010)، فنعرّف نفسنا باسم واضح
UA = "movie-translator/1.0 (+https://github.com/asmailansary/movie-translator)"

CHUNK_SECONDS = 600          # نقسم الصوت قطع كل وحدة 10 دقائق
TRANSLATE_BATCH = 50         # عدد الجمل في كل طلب ترجمة
TRANSLATE_WORKERS = 2        # قليل عشان ما نتعدى حدود الخطط المجانية

SOURCE_LANGS = {
    "auto": {"name": "تلقائي", "code": None},
    "en": {"name": "الإنجليزية", "code": "en"},
    "de": {"name": "الألمانية", "code": "de"},
    "fr": {"name": "الفرنسية", "code": "fr"},
    "es": {"name": "الإسبانية", "code": "es"},
    "it": {"name": "الإيطالية", "code": "it"},
    "tr": {"name": "التركية", "code": "tr"},
    "ko": {"name": "الكورية", "code": "ko"},
    "ja": {"name": "اليابانية", "code": "ja"},
    "hi": {"name": "الهندية", "code": "hi"},
}

def _load_dialects():
    """نفس ملف اللهجات اللي يستخدمه Cloudflare (worker/src/dialects.js) عشان أي تحسين يصير بالمكانين"""
    path = Path(__file__).resolve().parent.parent / "worker" / "src" / "dialects.js"
    text = path.read_text(encoding="utf-8").split("export default", 1)[1].strip().rstrip(";")
    return json.loads(text)


DIALECTS = _load_dialects()
KIND = os.environ.get("KIND", "movie").strip() or "movie"
if KIND not in ("movie", "clip", "song"):
    KIND = "movie"

FUSHA_MARKERS = ["سوف", "لن", "لم", "ليس", "ليست", "لست", "لسنا", "ماذا", "لماذا", "هكذا", "الان", "جدا", "ذلك", "تلك",
                 "هؤلاء", "اولئك", "الذي", "التي", "الذين", "ايضا", "حسنا", "انني", "لكنني", "ينبغي", "هل"]
_TASHKEEL = re.compile(r"[\u064B-\u0652\u0640]")
_SPLIT = re.compile(r"[^\u0621-\u064A\u06A4\u06AF\u0686]+")
_SA = re.compile(r"^سا[\u0621-\u064A]{2,}")
_SA_OK = re.compile(r"^(ساع|سال|سام|ساك|ساب|سار|سافر|ساعد)")


def _norm(t):
    t = _TASHKEEL.sub("", str(t or ""))
    return t.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا").replace("ى", "ي")


def leaks(dialect, text):
    """كلمات فصحى أو من لهجة ثانية طلعت في سطر مترجم"""
    d = DIALECTS.get(dialect)
    if not d or d["group"] == "fusha":
        return []
    ws = [w for w in _SPLIT.split(_norm(text)) if w]
    st = set(ws)
    allowed = {"الذي"} if dialect == "yemeni" else set()
    out = [m for m in FUSHA_MARKERS if m not in allowed and _norm(m) in st]
    for w in ws:
        if _SA.match(w) and len(w) > 3 and not _SA_OK.match(w):
            out.append(w)
            break
    out += [a for a in d.get("avoid", []) if _norm(a) in st]
    return list(dict.fromkeys(out))


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
_ROUTE = {"proxy": None}   # الطريقة اللي نجحت مع يوتيوب، نعيد استخدامها


def download_audio(vid, workdir: Path, stem="audio", section_end=None, url=None, fmt="bestaudio/best", max_seconds=None):
    """يسحب الصوت بس (بدون فيديو). للمقاطع السوشل يسحب المقطع نفسه عشان نشغّله."""
    import yt_dlp  # يُستورد هنا عشان السكربت يشتغل حتى لو كان التحميل معطّل
    from yt_dlp.utils import download_range_func

    url = url or f"https://www.youtube.com/watch?v={vid}"
    opts = {
        "format": fmt,
        "merge_output_format": "mp4",
        "outtmpl": str(workdir / f"{stem}.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 3,
        "concurrent_fragment_downloads": 4,
    }
    if section_end:
        opts["download_ranges"] = download_range_func(None, [(0, section_end)])
    if YT_COOKIES.strip():
        cookie_file = workdir / "cookies.txt"
        cookie_file.write_text(YT_COOKIES)
        opts["cookiefile"] = str(cookie_file)

    # نجرب أول عن طريق Cloudflare WARP (لو اشتغل)، وبعدها مباشرة
    if _ROUTE["proxy"] is not None:
        routes = [_ROUTE["proxy"]]
    else:
        routes = list(dict.fromkeys([os.environ.get("YTDLP_PROXY", "").strip(), ""]))
    last_err, info = None, {}
    for proxy in routes:
        o = dict(opts)
        if proxy:
            o["proxy"] = proxy
        try:
            with yt_dlp.YoutubeDL(o) as ydl:
                info = ydl.extract_info(url, download=False)
                duration = info.get("duration") or 0
                if max_seconds and duration and duration > max_seconds:
                    raise UserError("المقطع أطول من ١٠ دقايق 😅 حطه في خانة الأفلام لو كان من يوتيوب")
                if duration and duration > MAX_MINUTES * 60:
                    raise UserError(f"الفلم طويل مرة 😅 أطول من {MAX_MINUTES // 60} ساعات")
                ydl.download([url])
            print("✓ تم التحميل", stem, "عن طريق WARP" if proxy else "مباشرة")
            _ROUTE["proxy"] = proxy
            break
        except UserError:
            raise
        except Exception as e:  # noqa: BLE001
            msg = str(e).replace("\n", " ")[:300]
            print("✗ فشل التحميل", "عن طريق WARP:" if proxy else "مباشرة:", msg)
            print(f"::warning::download {'warp' if proxy else 'direct'} {stem}: {msg}")
            last_err = e
            for p in workdir.glob(f"{stem}.*"):
                p.unlink(missing_ok=True)
    else:
        raise last_err

    files = [p for p in workdir.glob(f"{stem}.*") if p.suffix not in (".part", ".ytdl")]
    if not files:
        raise UserError("ما قدرنا نجيب صوت الفلم 😕 جرّب مرة ثانية")
    w, h = info.get("width") or 0, info.get("height") or 0
    _ROUTE["aspect"] = round(w / h, 4) if w and h else (info.get("aspect_ratio") or 0)
    return files[0], info.get("title") or "", info.get("duration") or 0


def split_audio(src: Path, workdir: Path, name="chunks"):
    """يحوّل الصوت لقطع mp3 صغيرة (أحادي 16kHz) ويرجع [(ملف، بداية القطعة، نهايتها)]."""
    out_dir = workdir / name
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
        chunks.append((f, offset, offset + dur))
        offset += dur
    return chunks


def split_first(src: Path, workdir: Path):
    """يقص أول جزء بسرعة عشان تبدأ الترجمة قبل ما يتقطّع الفلم كامل."""
    out = workdir / "first.mp3"
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-t", str(CHUNK_SECONDS),
         "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", str(out)],
    )
    if r.returncode != 0 or not out.exists():
        return None
    return (out, 0.0, probe_duration(out))


def probe_duration(path: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except ValueError:
        return float(CHUNK_SECONDS)


SECRET_NAMES = {"Groq": "GROQ_API_KEY", "Gemini": "GEMINI_API_KEY", "Claude": "ANTHROPIC_API_KEY"}


# ───────────────────────── 2) التفريغ الصوتي (Groq Whisper) ─────────────────────────
def http_json(url, headers, body: bytes, timeout=300, retries=4, service=""):
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=body, headers={"User-Agent": UA, **headers}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")[:400]
            last = f"HTTP {e.code}: {detail}"
            if e.code in (401, 403):
                print(f"::warning::{service} HTTP {e.code}: {detail[:250]}")
                raise UserError(f"فيه مشكلة في إعدادات الأداة 🛠️ (مفتاح {service or 'خدمة'})")
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
    """يفرّغ قطعة صوت ويرجع سطور ترجمة بتوقيت دقيق (من توقيت كل كلمة)."""
    boundary = "----mt" + uuid.uuid4().hex
    fields = [("model", WHISPER_MODEL), ("response_format", "verbose_json"), ("temperature", "0"),
              ("timestamp_granularities[]", "segment"), ("timestamp_granularities[]", "word")]
    if lang:
        fields.append(("language", lang))
    parts = []
    for k, v in fields:
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
        b"".join(parts), service="Groq",
    )
    return [{"start": round(offset + l["start"], 2), "end": round(offset + l["end"], 2), "src": l["src"]}
            for l in build_lines(data.get("segments") or [], data.get("words") or [])]


MAX_LINE_SECONDS = 6.0     # أطول مدة لسطر الترجمة على الشاشة
MAX_LINE_CHARS = 90        # أطول سطر (بالحروف الأصلية)
PAUSE_BREAK = 0.9          # سكتة أطول من كذا = سطر جديد
MIN_SHOW = 0.8             # أقل مدة يظهر فيها السطر


def build_lines(segments, words):
    """يبني سطور الترجمة من الكلمات: يبدأ السطر مع أول كلمة وينتهي مع آخر كلمة."""
    words = sorted(
        ({"w": str(w.get("word", "")).strip(), "s": float(w["start"]), "e": float(w["end"])}
         for w in words if str(w.get("word", "")).strip() and "start" in w and "end" in w),
        key=lambda x: x["s"],
    )
    lines, wi = [], 0
    for seg in segments:
        text = (seg.get("text") or "").strip()
        if not text or (seg.get("no_speech_prob") or 0) > 0.85:   # موسيقى أو صمت
            while wi < len(words) and (words[wi]["s"] + words[wi]["e"]) / 2 <= float(seg["end"]):
                wi += 1
            continue
        s0, s1 = float(seg["start"]), float(seg["end"])
        sw = []
        while wi < len(words) and (words[wi]["s"] + words[wi]["e"]) / 2 <= s1 + 0.05:
            if (words[wi]["s"] + words[wi]["e"]) / 2 >= s0 - 0.3:
                sw.append(words[wi])
            wi += 1
        if not sw:   # ما فيه توقيت كلمات: نرجع لتوقيت الجملة
            lines.append({"start": s0, "end": s1, "src": text})
            continue
        cur = []
        for w in sw:
            if cur:
                dur = w["e"] - cur[0]["s"]
                chars = sum(len(x["w"]) + 1 for x in cur) + len(w["w"])
                gap = w["s"] - cur[-1]["e"]
                ends_sentence = cur[-1]["w"][-1:] in ".?!…" and len(cur) >= 2
                if dur > MAX_LINE_SECONDS or chars > MAX_LINE_CHARS or gap > PAUSE_BREAK or ends_sentence:
                    lines.append(_line(cur))
                    cur = []
            cur.append(w)
        if cur:
            lines.append(_line(cur))
    # أقل مدة ظهور، بدون ما يغطي السطر اللي بعده
    for i, l in enumerate(lines):
        nxt = lines[i + 1]["start"] if i + 1 < len(lines) else l["end"] + 5
        if l["end"] - l["start"] < MIN_SHOW:
            l["end"] = min(l["start"] + MIN_SHOW, nxt - 0.05)
        l["end"] = max(l["end"], l["start"] + 0.3)
    return lines


def _line(ws):
    text = " ".join(x["w"] for x in ws)
    text = re.sub(r"\s+([,.?!…:;])", r"\1", text)
    return {"start": ws[0]["s"], "end": ws[-1]["e"] + 0.15, "src": text}


def split_long_segments(segs, max_len=7.0):
    """صار التقسيم يتم بتوقيت الكلمات داخل build_lines؛ نخليها للتوافق."""
    return segs


# ───────────────────────── 3) الترجمة (Gemini / Groq / Claude) ─────────────────────────
KIND_NOTE = {
    "movie": "هذا حوار فلم.",
    "clip": "هذا مقطع قصير من السوشل ميديا: الكلام عفوي وسريع، خلّ الترجمة خفيفة وعفوية.",
    "song": "هذي أغنية: ترجم الكلمات اللي تنسمع بإحساسها وعاطفتها بنفس اللهجة، جمل قصيرة فيها شاعرية بدون فصحى، ولا تشرح ولا تضيف كلام من عندك.",
}


def build_system_prompt(dialect_key, title, kind=None):
    d = DIALECTS.get(dialect_key) or DIALECTS["najdi"]
    fusha = d["group"] == "fusha"
    lines = [
        "أنت مترجم ترجمة أفلام (Subtitles) محترف، وابن البلد نفسه، تترجم للعربية.",
        f"المطلوب: {'الفصحى' if fusha else 'اللهجة ' + d['name']} {'' if fusha else '١٠٠٪، كأن اللي يتكلم واحد من أهلها'}.",
        f"مين يتكلم: {d['who']}",
        KIND_NOTE.get(kind or KIND, KIND_NOTE["movie"]),
        f"العنوان: {title or 'غير معروف'}",
    ]
    if d["words"]:
        lines += ["", "قاموس اللهجة:"] + [f"- بدل «{a}» قل: {b}" for a, b in d["words"]]
    lines += ["", "قواعد اللهجة:"] + ["- " + g for g in d["grammar"]]
    if not fusha:
        lines += ["", "ممنوع نهائياً:",
                  "- أي كلمة فصحى مثل: سوف، سـ قبل الفعل، لن، لم، ليس، ماذا، لماذا، هكذا، الآن، جداً، ذلك، تلك، هؤلاء، الذي، التي، أيضاً، حسناً، ينبغي، هل.",
                  "- الإعراب والتنوين والمثنى الفصيح."]
        if d.get("avoid"):
            lines.append(f"- كلمات لهجات ثانية ما تنقال في {d['name']}: {'، '.join(d['avoid'])}.")
    lines += ["", "أمثلة (إنجليزي ← الترجمة الصحيحة):"] + [f"- {en} ← {ar}" for en, ar in d["examples"]]
    lines += ["", "قواعد عامة:",
              "- ترجم المعنى والإحساس، مو ترجمة حرفية.",
              "- الجملة قصيرة وتنقرأ بسرعة على الشاشة.",
              "- أسماء الأشخاص والأماكن تكتبها بالحروف العربية.",
              "- الشتائم والكلام البذيء خفّفه بشكل مناسب.",
              '- إذا كان النص أصوات أو موسيقى بدون كلام أو كلام غير مفهوم، رجّع نص فاضي "".',
              "- لا تدمج الجمل ولا تقسمها: كل رقم i له ترجمة وحدة بالضبط.",
              '- رجّع JSON فقط بهذا الشكل بدون أي كلام ثاني: [{"i": 0, "ar": "..."}, {"i": 1, "ar": "..."}]']
    return "\n".join(lines)


def translators():
    order = []
    if GEMINI_API_KEY:
        order.append(("gemini", call_gemini))
    if ANTHROPIC_API_KEY:
        order.insert(0, ("claude", call_claude))   # لو حطيت مفتاح Claude يصير هو الأول
    if GROQ_API_KEY:
        order.append(("groq", call_groq_llm))
    return order


_DEAD = set()


def call_llm(system, user_text):
    """يجرب خدمات الترجمة بالترتيب؛ لو وحدة خلص رصيدها اليومي ينتقل للي بعدها."""
    last = None
    for name, fn in translators():
        if name in _DEAD:
            continue
        try:
            return fn(system, user_text)
        except UserError as e:   # مفتاح غلط: ما نعيد تجربته، ننتقل للي بعده
            print(f"::warning::[{name}] {e}")
            _DEAD.add(name)
            last = e
        except Exception as e:  # noqa: BLE001
            print(f"[{name}] فشل، أجرب اللي بعده:", str(e)[:200])
            last = e
    raise last or UserError("فيه مشكلة في إعدادات الأداة 🛠️ (الترجمة)")


_gemini_model = {"name": GEMINI_MODEL}
_gemini_lock = threading.Lock()


def pick_gemini_model():
    """يختار أحدث موديل Flash متاح في الخطة المجانية."""
    with _gemini_lock:
        if _gemini_model["name"]:
            return _gemini_model["name"]
        req = urllib.request.Request(
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
            headers={"x-goog-api-key": GEMINI_API_KEY, "User-Agent": UA},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                models = json.loads(r.read().decode("utf-8")).get("models", [])
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")[:250]
            print(f"::warning::Gemini models HTTP {e.code}: {detail}")
            if e.code in (400, 401, 403):
                raise UserError("فيه مشكلة في إعدادات الأداة 🛠️ (مفتاح Gemini)")
            raise
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
            body, retries=3, service="Gemini",
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
        body, service="Groq",
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
        body, service="Claude",
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


def fix_leaks(segs, out, system, dialect, llm=None):
    """الأسطر اللي فيها فصحى أو لهجة ثانية نعيدها بطلب صغير وحيد"""
    bad = [(i, leaks(dialect, t)) for i, t in enumerate(out) if t]
    bad = [(i, w) for i, w in bad if w]
    if not bad:
        return out
    user = ("هذي أسطر ترجمتها وفيها كلمات مو من اللهجة المطلوبة. أعد كتابة كل سطر باللهجة ١٠٠٪ بنفس المعنى:\n" +
            json.dumps({"الأسطر": [{"i": i, "t": segs[i]["src"], "ترجمتك": out[i], "كلمات_غلط": w} for i, w in bad]}, ensure_ascii=False))
    try:
        fixed = parse_translation((llm or call_llm)(system, user), len(segs))
    except Exception:  # noqa: BLE001
        return out
    if fixed:
        for i, w in bad:
            if fixed[i] and len(leaks(dialect, fixed[i])) < len(w):
                out[i] = fixed[i]
    print(f"تدقيق اللهجة: {len(bad)} سطر فيه كلمات غلط، انصلح منها {sum(1 for i, w in bad if len(leaks(dialect, out[i])) < len(w))}")
    return out


def translate_batch(segs, system, context, llm=None, strict=False, dialect=None):
    payload = {
        "سياق_سابق": context,
        "الجمل": [{"i": i, "t": s["src"]} for i, s in enumerate(segs)],
    }
    user = "ترجم هذي الجمل (السياق السابق للفهم فقط، لا تترجمه):\n" + json.dumps(payload, ensure_ascii=False)
    for _ in range(3):
        try:
            result = parse_translation((llm or call_llm)(system, user), len(segs))
        except Exception:  # noqa: BLE001
            if strict:
                raise
            result = None
        if result and sum(1 for r in result if r is not None) >= len(segs) * 0.8:
            out = [r if r is not None else s["src"] for r, s in zip(result, segs)]
            return fix_leaks(segs, out, system, dialect or DIALECT, llm)
    if strict:
        raise RuntimeError("ترجمة الخلفية ما ضبطت")
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
        raise UserError("فيه مشكلة في إعدادات الأداة 🛠️ (مفتاح الصوت)")
    if not (GEMINI_API_KEY or ANTHROPIC_API_KEY):
        print("ℹ️  ما فيه GEMINI_API_KEY — الترجمة بتكون عن طريق Groq (جودة اللهجات أقل).")


# ───────────────────────── تشغيل المهمة كاملة ─────────────────────────
def upload_media(path: Path):
    """يرفع المقطع (تيك توك/انستا) لـ Cloudflare عشان يشتغل بمشغّلنا."""
    data = path.read_bytes()
    if len(data) > 95 * 1024 * 1024:
        raise UserError("المقطع كبير مرة 😅")
    req = urllib.request.Request(f"{CALLBACK}/api/media/{JOB_ID}", data=data, method="PUT",
                                 headers={"X-Ingest-Secret": INGEST_SECRET, "User-Agent": UA, "Content-Type": "video/mp4"})
    with urllib.request.urlopen(req, timeout=300) as r:
        r.read()


def post_dialect(dialect, segs):
    body = json.dumps({"segments": segs}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(f"{CALLBACK}/api/subs/{JOB_ID}/{dialect}", data=body, method="POST",
                                 headers={"X-Ingest-Secret": INGEST_SECRET, "User-Agent": UA, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        r.read()


def background_dialects(all_segs, title, have):
    """بعد ما تجهز لهجتك: نترجم باقي اللهجات وانت تتفرج، عشان التبديل يصير فوري.
    نستخدم Gemini بس هنا، عشان ما ناكل من حد Groq اللي نحتاجه للأفلام الجديدة."""
    if not GEMINI_API_KEY or not all_segs:
        return
    todo = [d for d in BG_ORDER if d != DIALECT and d not in (have or [])]
    src = [{"start": x["start"], "end": x["end"], "src": x["src"]} for x in all_segs]
    for d in todo:
        system = build_system_prompt(d, title)
        batches = [src[i: i + TRANSLATE_BATCH] for i in range(0, len(src), TRANSLATE_BATCH)]
        try:
            with ThreadPoolExecutor(3) as pool:
                futs = [pool.submit(translate_batch, b, system, [x["src"] for x in batches[i - 1][-3:]] if i else [], call_gemini, True, d)
                        for i, b in enumerate(batches)]
                out = []
                for b, f in zip(batches, futs):
                    out += [dict(x, ar=ar) for x, ar in zip(b, f.result())]
            post_dialect(d, out)
            print(f"✓ لهجة {d} جاهزة في الخلفية")
        except Exception as e:  # noqa: BLE001
            print(f"::warning::وقفنا ترجمة اللهجات الإضافية عند {d}: {str(e)[:200]}")
            return


def fetch_source():
    req = urllib.request.Request(f"{CALLBACK}/api/source/{JOB_ID}",
                                 headers={"X-Ingest-Secret": INGEST_SECRET, "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def run_reuse():
    """تبديل لهجة: الكلام الأصلي وتوقيته جاهزين، نترجم بس (بدون سحب أو سماع الصوت)."""
    report(status="running", stage="نترجم بلهجتك الجديدة ⚡", progress=0.05)
    data = fetch_source()
    title, duration, segs = data.get("title", ""), data.get("duration", 0), data.get("segments") or []
    report(title=title, duration=duration, aspect=data.get("aspect") or 0)
    system = build_system_prompt(DIALECT, title)
    groups = {}
    for sg in segs:
        groups.setdefault(int(sg["start"] // CHUNK_SECONDS), []).append(dict(sg))
    keys = sorted(groups)
    total = max(1, len(keys))
    context, pool = [], ThreadPoolExecutor(TRANSLATE_WORKERS)
    for n, k in enumerate(keys, 1):
        part = groups[k]
        batches = [part[i: i + TRANSLATE_BATCH] for i in range(0, len(part), TRANSLATE_BATCH)]
        futures = []
        for bi, batch in enumerate(batches):
            ctx = context if bi == 0 else [x["src"] for x in batches[bi - 1][-3:]]
            futures.append(pool.submit(translate_batch, batch, system, ctx))
        for batch, fut in zip(batches, futures):
            for x, ar in zip(batch, fut.result()):
                x["ar"] = ar
        context = [x["src"] for x in part[-3:]]
        report(
            append=part,
            stage=("أول جزء جاهز! 🍿 والباقي يكمل وانت تتفرج" if n == 1 and total > 1 else f"نترجم الباقي ☕ ({n} من {total})"),
            progress=round(0.05 + 0.93 * n / total, 3),
            ready_until=(k + 1) * CHUNK_SECONDS if n < total else 10**9,
        )
    pool.shutdown()
    report(status="done", stage="الفلم كله جاهز ✓ استمتع 🎬", progress=1.0, ready_until=10**9)


def run():
    if REUSE:
        return run_reuse()
    workdir = Path(tempfile.mkdtemp(prefix="mt_"))
    report(status="running", stage="نسحب صوت الفلم 🎧", progress=0.03)

    # ١) نسحب الصوت بس (بدون فيديو) — سريع حتى لفلم ساعتين
    if MEDIA_URL:   # مقطع تيك توك/انستا: نسحب المقطع نفسه (صغير) ونشغّله بمشغّلنا
        audio, title, duration = download_audio(
            VIDEO_ID, workdir, stem="clip", url=MEDIA_URL, max_seconds=600,
            fmt="best[ext=mp4][height<=720]/bv*[height<=720][ext=mp4]+ba[ext=m4a]/best[height<=720]/best")
        report(stage="نجهّز المقطع للعرض 📱", progress=0.05)
        upload_media(audio)
    else:
        audio, title, duration = download_audio(VIDEO_ID, workdir, stem="audio")
    total = max(1, -(-int(duration or CHUNK_SECONDS) // CHUNK_SECONDS))
    report(title=title, duration=duration, aspect=_ROUTE.get("aspect") or 0, stage="نسمع أول ١٠ دقايق ونترجمها ✍️", progress=0.06)

    system = build_system_prompt(DIALECT, title)
    lang = SOURCE_LANGS[SOURCE]["code"]
    chunk_q: queue.Queue = queue.Queue()   # قطع الصوت الجاهزة
    seg_q: queue.Queue = queue.Queue()     # الجمل المفرّغة الجاهزة للترجمة

    # ٢) أول ١٠ دقائق تتجهز على طول، والباقي يتقطّع وانت تتفرج
    def downloader():
        try:
            first = split_first(audio, workdir)
            if first:
                chunk_q.put(first)
            rest = split_audio(audio, workdir, "chunks")
            for ch in (rest[1:] if first else rest):
                chunk_q.put(ch)
        except Exception as e:  # noqa: BLE001
            chunk_q.put(e)
        chunk_q.put(None)

    def transcriber():
        try:
            while True:
                ch = chunk_q.get()
                if ch is None:
                    break
                if isinstance(ch, Exception):
                    raise ch
                path, start, end = ch
                seg_q.put(("ok", (split_long_segments(transcribe_chunk(path, start, lang)), end)))
        except Exception as e:  # noqa: BLE001
            seg_q.put(("err", e))
        seg_q.put(("done", None))

    threading.Thread(target=downloader, daemon=True).start()
    threading.Thread(target=transcriber, daemon=True).start()

    # ٣) الترجمة تمشي ورا التفريغ قطعة قطعة
    done_chunks, context, pool, pending = 0, [], ThreadPoolExecutor(TRANSLATE_WORKERS), None
    all_segs = []
    while True:
        kind, val = seg_q.get()
        if kind == "err":
            raise val
        if kind == "done":
            break
        segs, chunk_end = val
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
        all_segs += segs
        done_chunks += 1
        report(
            append=segs,
            stage=("أول جزء جاهز! تقدر تبدأ 🍿 والباقي يكمل وانت تتفرج" if done_chunks == 1 and total > 1 else f"نترجم الباقي ☕ ({done_chunks} من {total})"),
            progress=round(0.06 + 0.92 * min(done_chunks, total) / total, 3),
            ready_until=chunk_end,
        )
    pool.shutdown()
    report(status="done", stage="الفلم كله جاهز ✓ استمتع 🎬", progress=1.0, ready_until=10**9)



def friendly_error(e):
    msg = str(e)
    if isinstance(e, UserError):
        return msg
    if "Sign in to confirm" in msg or "not a bot" in msg:
        return "يوتيوب ما رضى يعطينا هالفلم الحين 😕 جرّب بعد شوي أو جرّب فلم ثاني"
    if "Private video" in msg or "Video unavailable" in msg:
        return "هالفلم خاص أو محذوف من يوتيوب 🚫"
    return "صار شي غلط وحنا نجهّز الفلم 😕 جرّب مرة ثانية"


def main():
    validate_inputs()
    try:
        run()
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        print("::error::" + str(e).replace("\n", " ")[:400])
        try:
            report(status="error", error=friendly_error(e))
        finally:
            sys.exit(1)


if __name__ == "__main__":
    main()
