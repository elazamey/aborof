import { getFaq, getProducts } from "@/lib/db";
import { composeLocalAnswer } from "../local-answer";
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

/**
 * إجابة محلية من بيانات المتجر.
 *
 * تُفوّض إلى `composeLocalAnswer` — نفس السياسة التي يستخدمها مسار الدردشة —
 * بدل أن تحمل نسخة خاصة منها.
 *
 * لماذا التفويض لا نسخة ثانية: كانت هنا نسخة مستقلة من المنطق نفسه. فلمّا
 * أُصلح خطف الأسئلة الشائعة (D-4) وحسم المقاس والإسقاط الصامت (D-5) في
 * `local-answer.ts`، بقيت هذه على السلوك القديم — فأعادت «هات أرخص منظف
 * أرضيات متاح» جواب طرق الدفع. والأخطر أن هذا هو المسار الذي سيعمل فعلًا
 * بعد توصيل Gemini/Celia، فكان سيُعيد إنتاج العيوب المُصلَحة حرفيًا.
 * سياسة ترتيب واحدة، في مكان واحد.
 *
 * لماذا الكتالوج كاملًا لا نتائج FTS5: كان البحث هنا يمرّ عبر
 * `searchProductsFts(question, 3)`، أي قطع عند أول 3 حسب صلة FTS5 — وهو
 * الإسقاط الصامت نفسه بصورة أخرى، فقد يُستبعد الأرخص المتاح قبل أن تصل إليه
 * سياسة «أرخص متاح» أصلًا. لذلك تُمرَّر القائمة كاملة وتُترك المفاضلة
 * للسياسة. FTS5 باقٍ في موضعه الصحيح: أداة `search_products` في طبقة MCP.
 */
export async function buildLocalAnswer(question: string): Promise<string> {
  const [products, faq] = await Promise.all([getProducts(), getFaq()]);
  return composeLocalAnswer(question, products, faq);
}
