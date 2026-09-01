import { getProducts, getFaq } from "./db";
import { STORE } from "./seed";

/**
 * الرد الاحتياطي الذكي لسيليا — منطق نقي قابل للاختبار بدون Next.js.
 * يُستخدم عندما لا تتوفر مفاتيح Gemini/Groq أو تفشل الاستدعاءات.
 */
export async function localAnswer(q: string) {
  const [products, faq] = await Promise.all([getProducts(), getFaq()]);
  // إزالة علامات الترقيم (خاصة "؟" العربية) لأنها تلتصق بآخر كلمة
  // وتمنع مطابقتها مع النصوص المخزنة (مثل "كم سعر الشحن؟" مقابل "الشحن").
  const t = q.toLowerCase().replace(/[؟?،,؛;.!]/g, " ");
  const words = t.split(/\s+/).filter((w) => w.length > 2);
  const score = (s: string) => words.reduce((n, w) => n + (s.toLowerCase().includes(w) ? 1 : 0), 0);

  const bestFaq = faq.map((f) => ({ f, s: score(f.question) })).sort((a, b) => b.s - a.s)[0];
  if (bestFaq && bestFaq.s >= 1) return bestFaq.f.answer;

  const hits = products
    .map((p) => ({ p, s: score(p.name + " " + p.category + " " + p.description) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  if (hits.length)
    return (
      "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n" +
      hits.map((h) => `• ${h.p.name} — ${h.p.price} جنيه`).join("\n") +
      `\n\nتقدر تضيفهم للسلة وتكمل الطلب، والدفع فودافون كاش على ${STORE.vodafoneCash} أو عند الاستلام.`
    );

  return `أهلاً بحضرتك في ${STORE.name} 🧼\nأنا سيليا، تحت أمرك. عندنا منظفات أرضيات ومطابخ وحمامات ومعطرات وأدوات نظافة.\nقولّي محتاج إيه بالظبط وأرشحلك الأنسب، أو كلمنا واتساب على ${STORE.phone}.`;
}
