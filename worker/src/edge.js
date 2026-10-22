/**
 * تبديل اللهجة السريع: الترجمة تصير هنا في Cloudflare مباشرة (بدون انتظار GitHub)
 * - الكلام الأصلي وتوقيته جاهزين من أول ترجمة، فما نسحب صوت ولا نسمع شي
 * - نترجم قطعة قطعة (كل قطعة دقيقتين) ونبدأ من المكان اللي المستخدم يتفرج فيه
 * - ما نترجم إلا اللي ينطلب، فالاستهلاك = نفس تبديل اللهجة العادي أو أقل
 */

export const WINDOW = 120;   // ثواني لكل قطعة

import D from "./dialects.js";

// كلمات فصحى تفضح إن الترجمة مو لهجة (نفحص فيها بعد كل دفعة)
const FUSHA_MARKERS = ["سوف", "لن", "لم", "ليس", "ليست", "لست", "لسنا", "ماذا", "لماذا", "هكذا", "الان", "جدا", "ذلك", "تلك",
  "هؤلاء", "اولئك", "الذي", "التي", "الذين", "ايضا", "حسنا", "انني", "لكنني", "ينبغي", "هل"];
const norm = (t) => String(t || "").replace(/[\u064B-\u0652\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي");
const words = (t) => norm(t).split(/[^\u0621-\u064A\u06A4\u06AF\u0686]+/).filter(Boolean);

/** الكلمات اللي ما تنتمي للهجة (فصحى أو لهجة ثانية) في سطر مترجم */
export function leaks(dialect, text) {
  const d = D[dialect]; if (!d || d.group === "fusha") return [];
  const ws = words(text), set = new Set(ws), out = [];
  const allowed = dialect === "yemeni" ? new Set(["الذي"]) : new Set();
  for (const m of FUSHA_MARKERS) if (!allowed.has(m) && set.has(norm(m))) out.push(m);
  for (const w of ws) if (/^سا[\u0621-\u064A]{2,}/.test(w) && w.length > 3 && !/^(ساع|سال|سام|ساك|ساب|سار|سافر|ساعد)/.test(w)) { out.push(w); break; }
  for (const a of d.avoid || []) if (set.has(norm(a))) out.push(a);
  return [...new Set(out)];
}

const KIND_NOTE = {
  movie: "هذا حوار فلم.",
  clip: "هذا مقطع قصير من السوشل ميديا: الكلام عفوي وسريع، خلّ الترجمة خفيفة وعفوية.",
  song: "هذي أغنية: ترجم الكلمات اللي تنسمع بإحساسها وعاطفتها بنفس اللهجة، جمل قصيرة فيها شاعرية بدون فصحى، ولا تشرح ولا تضيف كلام من عندك.",
};

export function systemPrompt(dialect, _name, title, kind = "movie") {
  const d = D[dialect] || D.najdi;
  const fusha = d.group === "fusha";
  const lines = [
    "أنت مترجم ترجمة أفلام (Subtitles) محترف، وابن البلد نفسه، تترجم للعربية.",
    `المطلوب: ${fusha ? "الفصحى" : "اللهجة " + d.name} ${fusha ? "" : "١٠٠٪، كأن اللي يتكلم واحد من أهلها"}.`,
    `مين يتكلم: ${d.who}`,
    KIND_NOTE[kind] || KIND_NOTE.movie,
    `العنوان: ${title || "غير معروف"}`,
  ];
  if (d.words.length) {
    lines.push("", "قاموس اللهجة:");
    for (const [a, b] of d.words) lines.push(`- بدل «${a}» قل: ${b}`);
  }
  lines.push("", "قواعد اللهجة:", ...d.grammar.map((g) => "- " + g));
  if (!fusha) {
    lines.push("", "ممنوع نهائياً:",
      "- أي كلمة فصحى مثل: سوف، سـ قبل الفعل، لن، لم، ليس، ماذا، لماذا، هكذا، الآن، جداً، ذلك، تلك، هؤلاء، الذي، التي، أيضاً، حسناً، ينبغي، هل.",
      "- الإعراب والتنوين والمثنى الفصيح.");
    if (d.avoid.length) lines.push(`- كلمات لهجات ثانية ما تنقال في ${d.name}: ${d.avoid.join("، ")}.`);
  }
  lines.push("", "أمثلة (إنجليزي ← الترجمة الصحيحة):", ...d.examples.map(([en, ar]) => `- ${en} ← ${ar}`));
  lines.push("", "قواعد عامة:",
    "- ترجم المعنى والإحساس، مو ترجمة حرفية.",
    "- الجملة قصيرة وتنقرأ بسرعة على الشاشة.",
    "- أسماء الأشخاص والأماكن تكتبها بالحروف العربية.",
    "- الشتائم والكلام البذيء خفّفه بشكل مناسب.",
    '- إذا كان النص أصوات أو موسيقى بدون كلام أو كلام غير مفهوم، رجّع نص فاضي "".',
    "- لا تدمج الجمل ولا تقسمها: كل رقم i له ترجمة وحدة بالضبط.",
    '- رجّع JSON فقط بهذا الشكل بدون أي كلام ثاني: [{"i": 0, "ar": "..."}, {"i": 1, "ar": "..."}]');
  return lines.join("\n");
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
export async function translateLines(env, system, lines, context, dialect) {
  const user = "ترجم هذي الجمل (السياق السابق للفهم فقط، لا تترجمه):\n" +
    JSON.stringify({ "سياق_سابق": context, "الجمل": lines.map((l, i) => ({ i, t: l.src })) });
  let res = null;
  for (let attempt = 0; attempt < 2 && !res; attempt++) {
    try {
      const r = parse(await callGemini(env, system, user), lines.length);
      if (r && r.filter((x) => x !== null).length >= lines.length * 0.8) res = r;
    } catch (e) {
      if (e.status === 429) throw e;   // خلص الحد: نوقف ونرجع للطريقة العادية
    }
  }
  if (!res) throw new Error("translate failed");
  // تدقيق اللهجة: الأسطر اللي طلع فيها فصحى أو لهجة ثانية نعيدها بس (طلب صغير وحيد)
  if (dialect) {
    const bad = res.map((t, i) => [i, t ? leaks(dialect, t) : []]).filter(([, w]) => w.length);
    if (bad.length) {
      try {
        const fixUser = "هذي أسطر ترجمتها وفيها كلمات مو من اللهجة المطلوبة. أعد كتابة كل سطر باللهجة ١٠٠٪ بنفس المعنى:\n" +
          JSON.stringify({ "الأسطر": bad.map(([i, w]) => ({ i, t: lines[i].src, "ترجمتك": res[i], "كلمات_غلط": w })) });
        const fixed = parse(await callGemini(env, system, fixUser), lines.length);
        if (fixed) for (const [i, w] of bad) if (fixed[i] && leaks(dialect, fixed[i]).length < w.length) res[i] = fixed[i];
      } catch (e) { if (e.status === 429) { /* نخلي الترجمة الأولى */ } }
    }
  }
  return lines.map((l, i) => ({ ...l, ar: res[i] ?? l.src }));
}
