/**
 * تبديل اللهجة السريع: الترجمة تصير هنا في Cloudflare مباشرة (بدون انتظار GitHub)
 * - الكلام الأصلي وتوقيته جاهزين من أول ترجمة، فما نسحب صوت ولا نسمع شي
 * - نترجم قطعة قطعة (كل قطعة دقيقتين) ونبدأ من المكان اللي المستخدم يتفرج فيه
 * - ما نترجم إلا اللي ينطلب، فالاستهلاك = نفس تبديل اللهجة العادي أو أقل
 */

export const WINDOW = 120;   // ثواني لكل قطعة

const GUIDES = {
  fusha: "العربية الفصحى المعاصرة البسيطة كما في ترجمات الأفلام الاحترافية.",
  najdi: "اللهجة النجدية (لهجة أهل الرياض والقصيم ونجد) كما يتكلمها الناس فعلاً. استخدم مفرداتها وتراكيبها الطبيعية مثل: وش، ليه، وشلون، ذحين/الحين، أبي/أبغى، مب/ما، زين، يا رجّال، ترى، هاه، ودّي، أبد، مرة (بمعنى جداً)، عاد، يالله، واجد (باعتدال)، تكفى، أبشر، خلاص، وين، منهو، هذولا، ذاك/ذيك. صيغ الأفعال النجدية: يبي، ما يبي، بيروح، قاعد يسوي، رحت، جيت. لا تكثر من الكلمات لدرجة التصنّع، خلّها طبيعية وعفوية مثل كلام شخص من الرياض.",
  hijazi: "اللهجة الحجازية (جدة ومكة) الطبيعية: إيش، ليش، كدا، دحين، أبغى، مرة، يا شيخ، برضو، إيوه.",
  khaleeji: "اللهجة الخليجية العامة (كويت/إمارات/قطر/البحرين): شنو، ليش، شلون، الحين، أبي، وايد، زين، چذي.",
  yemeni: "اللهجة اليمنية (صنعانية مفهومة): ايش، ليش، كيف، ذلحين، اشتي، قده، يا خبير، مَه، شوف.",
  egyptian: "اللهجة المصرية القاهرية: إيه، ليه، إزاي، دلوقتي، عايز، أوي، كده، يا عم، طب، خلاص.",
  shami: "اللهجة الشامية (سوريا/لبنان/فلسطين/الأردن): شو، ليش، كيف، هلق، بدّي، كتير، هيك، يا زلمة، منيح.",
  iraqi: "اللهجة العراقية البغدادية: شنو، ليش، شلون، هسه، أريد، كلش، هيچ، ماكو، اكو.",
};

export function systemPrompt(dialect, name, title) {
  return [
    "أنت مترجم ترجمة أفلام (Subtitles) محترف. تترجم حوار الفلم إلى العربية.",
    `اللغة/اللهجة المطلوبة: ${name}.`,
    `وصف اللهجة: ${GUIDES[dialect] || ""}`,
    `عنوان الفلم: ${title || "غير معروف"}`,
    "",
    "القواعد:",
    "- ترجم المعنى والإحساس، مو ترجمة حرفية. خلّ الكلام طبيعي كأن الممثل يتكلم بهذي اللهجة.",
    "- الجملة قصيرة وتنقرأ بسرعة على الشاشة.",
    "- أسماء الأشخاص والأماكن تكتبها بالحروف العربية.",
    "- الشتائم والكلام البذيء خفّفه بشكل مناسب.",
    '- إذا كان النص أصوات أو موسيقى أو كلام غير مفهوم، رجّع نص فاضي "".',
    "- لا تدمج الجمل ولا تقسمها: كل رقم i له ترجمة وحدة بالضبط.",
    '- رجّع JSON فقط بهذا الشكل بدون أي كلام ثاني: [{"i": 0, "ar": "..."}, {"i": 1, "ar": "..."}]',
  ].join("\n");
}

let modelCache = null;
async function geminiModel(env) {
  if (env.GEMINI_MODEL) return env.GEMINI_MODEL;
  if (modelCache) return modelCache;
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
    headers: { "x-goog-api-key": env.GEMINI_API_KEY },
  });
  if (!r.ok) throw new Error(`gemini models ${r.status}`);
  const bad = ["lite", "image", "tts", "live", "audio", "embed", "exp", "preview", "thinking", "8b"];
  const names = ((await r.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && m.name.includes("flash") && !bad.some((b) => m.name.includes(b)))
    .map((m) => m.name.split("/")[1]);
  const ver = (n) => (n.match(/\d+/g) || ["0"]).map(Number);
  names.sort((a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; });
  modelCache = names.pop();
  if (!modelCache) throw new Error("no gemini flash model");
  return modelCache;
}

async function callGemini(env, system, user) {
  const model = await geminiModel(env);
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.4, responseMimeType: "application/json", maxOutputTokens: 8192 },
    }),
  });
  if (!r.ok) { const e = new Error(`gemini ${r.status}`); e.status = r.status; throw e; }
  const data = await r.json();
  return ((data.candidates?.[0]?.content?.parts) || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
}

function parse(text, n) {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b < 0) return null;
  try {
    const out = new Array(n).fill(null);
    for (const it of JSON.parse(text.slice(a, b + 1)))
      if (it && Number.isInteger(it.i) && it.i >= 0 && it.i < n) out[it.i] = String(it.ar ?? "").trim();
    return out;
  } catch { return null; }
}

/** يترجم مجموعة جمل (قطعة وحدة) */
export async function translateLines(env, system, lines, context) {
  const user = "ترجم هذي الجمل (السياق السابق للفهم فقط، لا تترجمه):\n" +
    JSON.stringify({ "سياق_سابق": context, "الجمل": lines.map((l, i) => ({ i, t: l.src })) });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = parse(await callGemini(env, system, user), lines.length);
      if (res && res.filter((x) => x !== null).length >= lines.length * 0.8)
        return lines.map((l, i) => ({ ...l, ar: res[i] ?? l.src }));
    } catch (e) {
      if (e.status === 429) throw e;   // خلص الحد: نوقف ونرجع للطريقة العادية
    }
  }
  throw new Error("translate failed");
}
