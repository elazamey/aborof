/**
 * ترتيب سلسلة التراجع في المحرك الذكي.
 *
 * الترتيب الافتراضي ثابت تاريخيًا:
 *   Gemini ← Groq ← NVIDIA NIM ← AI Gateway ← الرد المحلي.
 *
 * ‏AI Gateway أُضيف في **آخر** السلسلة قبل الرد المحلي (قبل `local` حصرًا):
 * بهذا لا يتغيّر أي سلوك قائم عندما تعمل Gemini أو Groq أو NIM — المزود
 * الجديد لا يُطلب إلا بعد سقوط كل ما قبله. لمن يريده أولًا: اضبط
 * `AI_PROVIDER_ORDER=ai-gateway` (الترتيب قابل للضبط بالكامل بلا كسر).
 *
 * يمكن ضبطه اختياريًا دون كسر أي سلوك عبر `AI_PROVIDER_ORDER` (قائمة أسماء
 * مفصولة بفواصل). القواعد صارمة وfail-closed:
 *  - الأسماء غير المعروفة أو الفارغة تُتجاهل (لا منح ضمني).
 *  - `local` مضمون دائمًا في نهاية السلسلة مهما كانت القائمة، لأنه الحلقة
 *    الأخيرة التي تضمن ألا يصل خطأ 500 إلى المستخدم أبدًا.
 *  - إن كانت القائمة الناتجة فارغة يُستخدم الترتيب الافتراضي حرفيًا.
 */

export const PROVIDER_NAMES = ["gemini", "groq", "nvidia-nim", "ai-gateway", "local"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

const KNOWN = new Set<string>(PROVIDER_NAMES);

export const DEFAULT_PROVIDER_ORDER: ProviderName[] = [
  "gemini",
  "groq",
  "nvidia-nim",
  "ai-gateway",
  "local",
];

/** يقرأ `AI_PROVIDER_ORDER` ويعيد ترتيبًا صالحًا مضمون النهاية المحلية. */
export function resolveProviderOrder(
  raw: string | undefined | null = process.env.AI_PROVIDER_ORDER
): ProviderName[] {
  const text = String(raw ?? "").trim();
  if (text === "") return [...DEFAULT_PROVIDER_ORDER];

  const requested = text
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part): part is ProviderName => KNOWN.has(part));

  const ordered = requested.filter((name) => name !== "local");
  if (ordered.length === 0) return [...DEFAULT_PROVIDER_ORDER];

  // الرد المحلي دائمًا في النهاية مهما حدث.
  return [...ordered, "local"];
}

/** اسم المتغير لأدوات التشخيص/التوثيق. */
export const PROVIDER_ORDER_ENV = "AI_PROVIDER_ORDER";
