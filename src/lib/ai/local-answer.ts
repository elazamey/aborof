import { STORE, type Product } from "@/lib/seed";

/**
 * محرّك الرد الاحتياطي: يبني ردًا من الكتالوج والأسئلة الشائعة وحدهما، بلا أي
 * مزود ذكاء اصطناعي. هو المسار الفعلي الذي يخدم العميل حين لا توجد مفاتيح API
 * أو حين يفشل المزودون — لذلك سلوكه مقاس في مختبر What-If (WF-012/013/014).
 *
 * قواعد الترتيب — كل واحدة أصلحت عيبًا قاسه المختبر بالدليل:
 *
 *  1. **الأسئلة الشائعة تُقاس بنفس ميزان المنتجات، ولا تُقدَّم عليها بالترتيب.**
 *     كانت FAQ تُفحص أولًا وتُقبل عند درجة ≥ 1، فكلمة واحدة مشتركة تكفي لخطف
 *     سؤال عن المنتجات: «متاح» جزءٌ من «المتاحة» في سؤال طرق الدفع، فكان سؤال
 *     «أرخص منظف أرضيات متاح» يُجاب عنه ببيانات الدفع (D-4). الآن لا يُجاب عن
 *     FAQ إلا إذا تفوّقت درجتها على أفضل منتج فعلًا، والتعادل يُحسم للمنتج.
 *
 *  2. **النافد لا يُرشَّح.** ما مخزونه صفر خارج القائمة؛ ولو كان كل ما طابق
 *     السؤال نافدًا يُقال ذلك صراحةً بدل اقتراح صنف لا يمكن شراؤه.
 *
 *  3. **النية تُقرأ من السؤال.** «الكبير»/«الصغير» تحسم المقاس بحجم العبوة
 *     المستخرج من الاسم، فتُرشَّح العبوة المطلوبة وحدها بدل عرض المقاسين معًا
 *     وترك العميل يحزر (D-5). والسعر تصاعديًا مرجّحٌ عند تساوي الدرجات، وهو ما
 *     يجعل «أرخص» تعمل بلا فرع خاص.
 *
 *  4. **لا إسقاط صامت.** عند تجاوز حد العرض يُذكر عدد الباقي صراحةً، فلا يختفي
 *     صنفان متطابقان لمجرد أن ترتيب أحدهما في الكتالوج أسبق (D-5).
 */

/** أقصى ما يُعرض في الرد الواحد. الباقي يُعلن عدده ولا يُخفى. */
export const MAX_RECOMMENDATIONS = 5;

const INTENT_BIGGER = /الكبير|الكبيرة|الأكبر|اكبر|أكبر/;
const INTENT_SMALLER = /الصغير|الصغيرة|الأصغر|اصغر|أصغر/;

/**
 * حجم العبوة بالملليلتر مستخرجًا من اسم المنتج، لمقارنة «الكبير» بـ«الصغير».
 *
 * يُعاد `null` حين لا يوجد حجم قابل للمقارنة («5 كجم» أو «عبوة 6 قطع»): الخلط
 * بين وحدات مختلفة أسوأ من الامتناع عن الحسم، فيُستثنى الصنف بدل أن يُخمَّن.
 */
export function packSizeMl(name: string): number | null {
  const litre = name.match(/(\d+(?:[.,]\d+)?)\s*لتر/);
  if (litre) return Number(litre[1].replace(",", ".")) * 1000;
  const milli = name.match(/(\d+(?:[.,]\d+)?)\s*مل/);
  if (milli) return Number(milli[1].replace(",", "."));
  return null;
}

export function composeLocalAnswer(
  q: string,
  products: Product[],
  faq: { question: string; answer: string }[]
): string {
  const t = q.toLowerCase();
  const words = t.split(/\s+/).filter((w) => w.length > 2);
  const score = (s: string) => words.reduce((n, w) => n + (s.toLowerCase().includes(w) ? 1 : 0), 0);

  const matched = products
    .map((p) => ({ p, s: score(`${p.name} ${p.category} ${p.description}`) }))
    .filter((x) => x.s > 0);
  const bestProductScore = matched.reduce((m, x) => Math.max(m, x.s), 0);

  // (1) FAQ تنافس المنتجات على الدرجة بدل أن تسبقها بالترتيب.
  const bestFaq = faq.map((f) => ({ f, s: score(f.question) })).sort((a, b) => b.s - a.s)[0];
  if (bestFaq && bestFaq.s >= 1 && bestFaq.s > bestProductScore) return bestFaq.f.answer;

  // (2) التوافر شرط للترشيح.
  const available = matched.filter((x) => x.p.stock > 0);
  if (matched.length > 0 && available.length === 0) {
    return `الأصناف اللي بتدور عليها نفدت حاليًا من المخزون 😔\nقولّي تحب أرشّحلك بديل من المتاح، أو كلمنا واتساب على ${STORE.phone}.`;
  }

  // (3) حسم المقاس: تُرشَّح العبوة المطلوبة وحدها، فلا يُعرض المقاسان معًا.
  let pool = available;
  const bigger = INTENT_BIGGER.test(t);
  const smaller = INTENT_SMALLER.test(t);
  if (bigger !== smaller) {
    const sized = pool.filter((x) => packSizeMl(x.p.name) !== null);
    if (sized.length > 0) {
      const sizes = sized.map((x) => packSizeMl(x.p.name) as number);
      const target = bigger ? Math.max(...sizes) : Math.min(...sizes);
      const resolved = sized.filter((x) => packSizeMl(x.p.name) === target);
      if (resolved.length > 0) pool = resolved;
    }
  }

  // (4) ترتيب صريح: الدرجة أولًا، ثم الأرخص، ثم الاسم — لا ترتيب الكتالوج.
  const ranked = [...pool].sort(
    (a, b) => b.s - a.s || a.p.price - b.p.price || a.p.name.localeCompare(b.p.name, "ar")
  );

  if (ranked.length === 0) {
    return `أهلاً بحضرتك في ${STORE.name} 🧼\nأنا سيليا، تحت أمرك. عندنا منظفات أرضيات ومطابخ وحمامات ومعطرات وأدوات نظافة.\nقولّي محتاج إيه بالظبط وأرشحلك الأنسب، أو كلمنا واتساب على ${STORE.phone}.`;
  }

  const shown = ranked.slice(0, MAX_RECOMMENDATIONS);
  const hidden = ranked.length - shown.length;
  const clarify =
    hidden > 0
      ? `\n\nوفيه كمان ${hidden} صنف تاني مطابق — قولّي تحب أنهي نوع بالظبط وأضيّقلك الاختيار.`
      : shown.length > 1
        ? "\n\nقولّي تحب أنهي واحد فيهم وأكمّل معاك الطلب."
        : "";

  return (
    "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n" +
    shown.map((h) => `• ${h.p.name} — ${h.p.price} جنيه`).join("\n") +
    clarify +
    `\n\nتقدر تضيفهم للسلة وتكمل الطلب، والدفع فودافون كاش على ${STORE.vodafoneCash} أو عند الاستلام.`
  );
}
