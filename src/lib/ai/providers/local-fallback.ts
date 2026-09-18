import { getFaq } from "@/lib/db";
import { searchProductsFts } from "@/lib/search";
import { STORE } from "@/lib/seed";
import type { AgentMessage, AgentOptions, AIAgentProvider } from "../types";

/**
 * المزود المحلي: إجابة فورية من بيانات المتجر نفسها (المنتجات والأسئلة
 * الشائعة) دون أي مفاتيح خارجية. متاح دائمًا، وهو آخر حلقة في السلسلة —
 * به لا يوجد مسار يصل فيه خطأ 500 إلى المستخدم.
 */
export class LocalFallbackProvider implements AIAgentProvider {
  readonly name = "local";

  isAvailable(): boolean {
    return true;
  }

  async generateResponse(messages: AgentMessage[], _options?: AgentOptions): Promise<string> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return buildLocalAnswer(lastUser);
  }
}

/** إجابة محلية من بيانات المتجر — البحث عبر FTS5 مع سقوط آمن للمطابقة الحرفية. */
export async function buildLocalAnswer(question: string): Promise<string> {
  const faq = await getFaq();
  const t = question.toLowerCase();
  const words = t.split(/\s+/).filter((w) => w.length > 2);
  const score = (s: string) => words.reduce((n, w) => n + (s.toLowerCase().includes(w) ? 1 : 0), 0);

  const bestFaq = faq.map((f) => ({ f, s: score(f.question) })).sort((a, b) => b.s - a.s)[0];
  if (bestFaq && bestFaq.s >= 1) return bestFaq.f.answer;

  const hits = (await searchProductsFts(question, 3)) as { name: string; price: number }[];
  if (hits.length)
    return (
      "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n" +
      hits.map((h) => `• ${h.name} — ${h.price} جنيه`).join("\n") +
      `\n\nتقدر تضيفهم للسلة وتكمل الطلب، والدفع فودافون كاش على ${STORE.vodafoneCash} أو عند الاستلام.`
    );

  return `أهلاً بحضرتك في ${STORE.name} 🧼\nأنا سيليا، تحت أمرك. عندنا منظفات أرضيات ومطابخ وحمامات ومعطرات وأدوات نظافة.\nقولّي محتاج إيه بالظبط وأرشحلك الأنسب، أو كلمنا واتساب على ${STORE.phone}.`;
}
