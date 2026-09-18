/**
 * تطبيع النص العربي ومرادفاته — أساس الاسترجاع النصي (المرحلة الأولى).
 *
 * الغرض: أن يفهم البحث صيغ الكتابة المختلفة والمرادفات الشائعة في العامية
 * المصرية دون أي نموذج خارجي ودون مفاتيح:
 *   «مطهر» → ديتول/كلوركس · «أرضيات» → سيراميك/رخام · «كام» → سعر/بكام.
 *
 * كل الدوال نقية وحتمية بلا اعتماديات، فتصير قابلة للاختبار بالكامل.
 */

/** مجموعات المرادفات: كل مجموعة = مفهوم واحد بصيغه الشائعة (مطبَّعة مسبقًا). */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["مطهر", "معقم", "تعقيم", "ديتول", "كلوركس", "كلور", "بياض"],
  ["منظف", "منظفات", "صابون", "سائل", "غسول", "جل"],
  ["معطر", "معطرات", "عطر", "فواحه", "بخور", "رائحه", "عطري"],
  ["ارضيات", "ارض", "سيراميك", "بورسلين", "رخام", "بلاط", "موكيت"],
  ["مطبخ", "مطابخ", "اطباق", "جلي", "صحون", "مواعين"],
  ["حمام", "حمامات", "تواليت", "مرحاض", "قاعده"],
  ["زجاج", "شبابيك", "مرايه", "مرايات", "سطح"],
  ["غسيل", "ملابس", "مسحوق", "اوتوماتيك", "غساله"],
  ["ادوات", "مقشه", "مساحه", "ليفه", "اسفنج", "فرشاه", "جردل", "دلو"],
  ["عنايه", "شخصيه", "شعر", "جسم", "شاور", "صابونه", "كريم"],
  ["جمله", "بالجمله", "تجاري", "شركات", "كميات", "مورد"],
  ["شحن", "توصيل", "تسليم", "مصاريف", "اجره", "دليفري", "مصاريف"],
  ["دفع", "فودافون", "كاش", "تحويل", "استلام", "محفظه", "فيزا"],
  ["استبدال", "استرجاع", "ارجاع", "مرتجع", "تبديل"],
  ["مواعيد", "وقت", "العمل", "مفتوح", "دوام", "فاتح"],
  ["سعر", "اسعار", "بكام", "كام", "تكلفه", "ثمن", "عرض", "خصم", "تخفيض"],
  ["توفر", "متوفر", "متاح", "موجود", "مخزون", "كميه", "خلصان"],
  ["واتساب", "رقم", "تليفون", "هاتف", "اتصال", "كلمنا", "تواصل"],
  ["طلب", "طلبات", "اوردر", "شغل", "سله", "شراء", "اشتري", "تمن"],
];

/** كلمات توقف عربية/مصرية لا قيمة استرجاعية لها. */
const STOPWORDS = new Set([
  "من", "في", "على", "عن", "مع", "الى", "إلى", "هل", "ايه", "إيه", "هو", "هي", "ان", "أن",
  "عايز", "عاوز", "عايزه", "ممكن", "لو", "سمحت", "بعد", "قبل", "كل", "بس", "ده", "دي",
  "عندكم", "عندك", "عندنا", "فيه", "فيها", "مش", "ولا", "او", "أو", "و", "يا", "انا", "أنا",
  "انت", "أنت", "احنا", "ازاي", "إزاي", "ليه", "امتى", "إمتى", "هنا", "هناك", "جدا", "جدًا",
  "الكبير", "الصغير", "افضل", "أفضل", "احسن", "أحسن", "محتاج", "محتاجه", "اريد", "أريد",
  "فضلك", "بليز", "لو سمحت", "باشا", "فندم", "حضرتك", "ياريت", "بس", "خلاص",
]);

const DIACRITICS = /[\u064B-\u0652\u0670\u0640\u06D6-\u06ED]/g;
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;
const ARABIC_INDIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

/** توحيد الأرقام العربية-الهندية إلى اللاتينية. */
function unifyDigits(text: string): string {
  return text.replace(ARABIC_INDIC_DIGITS, (digit) => {
    const code = digit.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/** تطبيع حرفي: تشكيل/تطويل/همزات/ياء/تاء مربوطة/ترقيم. */
export function normalizeArabic(text: string): string {
  return unifyDigits(String(text ?? ""))
    .replace(DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[ىئ]/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ة/g, "ه")
    .replace(PUNCTUATION, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * تقشير خفيف: إزالة «ال» التعريف وبعض اللواحق الشائعة فقط عندما يبقى أصل
 * الكلمة 3 أحرف على الأقل — حتى لا تُتلف معاني الكلمات القصيرة.
 */
export function lightStem(word: string): string {
  let out = word;
  if (out.length >= 5 && out.startsWith("ال")) out = out.slice(2);
  if (out.length >= 5 && /^(وال|بال|كال|فال|لل)/.test(out)) out = out.slice(3);
  if (out.length >= 5 && /(ات|ين|ون|ها|هم)$/.test(out)) out = out.slice(0, -2);
  if (out.length >= 4 && /(ه|ي)$/.test(out)) out = out.slice(0, -1);
  return out;
}

/** فهرس المرادفات: كلمة مطبَّعة → كل صيغ مفهومها (بما فيها الكلمة نفسها). */
const synonymIndex: Map<string, Set<string>> = (() => {
  const index = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    const normalized = new Set(group.map((term) => lightStem(normalizeArabic(term))));
    for (const term of normalized) {
      const existing = index.get(term) ?? new Set<string>();
      for (const alias of normalized) existing.add(alias);
      index.set(term, existing);
    }
  }
  return index;
})();

/** كلمات استعلام مطبَّعة ومقشَّرة بلا كلمات توقف وبلا تكرار. */
export function queryTokens(text: string): string[] {
  const normalized = normalizeArabic(text);
  if (!normalized) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of normalized.split(" ")) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    const stem = lightStem(raw);
    if (stem.length < 2 || STOPWORDS.has(stem)) continue;
    if (seen.has(stem)) continue;
    seen.add(stem);
    out.push(stem);
  }
  return out;
}

export interface QueryTerm {
  /** الجذر المطبَّع كما ورد (أو أقرب صيغة). */
  term: string;
  /** هل جاء هذا المصطلح من توسيع المرادفات بدل نص المستخدم نفسه؟ */
  synonym: boolean;
}

/**
 * توسيع الاستعلام بالمرادفات: كل كلمة يُضاف إليها مفهومها الكامل من الفهرس،
 * ويُعلَّم ما جاء من المرادفات ليُرجَّح ما ورد صريحًا في نص المستخدم.
 */
export function expandQuery(text: string): QueryTerm[] {
  const terms = queryTokens(text);
  const out: QueryTerm[] = [];
  const seen = new Set<string>();

  for (const term of terms) {
    if (!seen.has(term)) {
      seen.add(term);
      out.push({ term, synonym: false });
    }
    for (const alias of synonymIndex.get(term) ?? []) {
      if (alias === term || seen.has(alias)) continue;
      seen.add(alias);
      out.push({ term: alias, synonym: true });
    }
  }
  return out;
}

/** تطبيع نص المستند مرة واحدة عند بناء الذاكرة (أداء أفضل في البحث). */
export function normalizeDocumentText(text: string): string {
  return normalizeArabic(text);
}
