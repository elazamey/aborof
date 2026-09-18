/**
 * واجهة المحول الموحدة للذكاء الاصطناعي (AI Strategy Interface) — المرحلة الأولى.
 *
 * العقود هنا مستقلة عن أي مكتبة خارجية: كل مزود يحقق `AIAgentProvider`
 * ويدخل سلسلة التراجع الصامت في `SmartAgentEngine`. حقل `enableTools` اختياري
 * ويُتجاهل تمامًا ما لم تُفعَّل طبقة MCP المحكومة ويكن المزود قادرًا على
 * الأدوات (انظر `src/lib/ai/tools/`)، فلا يتغير أي مسار قائم.
 */

import type { ProductCard } from "./cards";

export type { ProductCard } from "./cards";

export type AgentRole = "user" | "assistant" | "system";

export interface AgentMessage {
  role: AgentRole;
  content: string;
}

export interface AgentOptions {
  temperature?: number;
  maxTokens?: number;
  /** طلب صريح لتفعيل دورة الأدوات — لا يُنفَّذ إلا إن كانت الطبقة مفعّلة. */
  enableTools?: boolean;
}

export interface AIAgentProvider {
  readonly name: string;
  generateResponse(messages: AgentMessage[], options?: AgentOptions): Promise<string>;
  /** هل المزود مهيأ وجاهز الآن (مفاتيحه موجودة)؟ */
  isAvailable(): boolean;
}

/** نتيجة المعالجة: الرد النهائي واسم المزود الذي قدّمه (للمراقبة والشفافية). */
export interface AgentResult {
  reply: string;
  provider: string;
  /** عدد محاولات تنفيذ الأدوات في هذا الطلب — يُحذف عندما يكون صفرًا. */
  toolCalls?: number;
  /** بطاقات منتجات للواجهة — تُحذف تمامًا عندما لا تنتجها الأدوات. */
  products?: ProductCard[];
}
