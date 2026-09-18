/**
 * واجهة المحول الموحدة للذكاء الاصطناعي (AI Strategy Interface) — المرحلة الأولى.
 *
 * العقود هنا مستقلة عن أي مكتبة خارجية: كل مزود يحقق `AIAgentProvider`
 * ويدخل سلسلة التراجع الصامت في `SmartAgentEngine`. حقول `AgentOptions`
 * المستقبلية (مثل `enableTools` لأدوات الوكيل في المرحلة الثالثة) اختيارية
 * ويتجاهلها المزود الذي لا يدعمها بعد.
 */

export type AgentRole = "user" | "assistant" | "system";

export interface AgentMessage {
  role: AgentRole;
  content: string;
}

export interface AgentOptions {
  temperature?: number;
  maxTokens?: number;
  /** محجوز للمرحلة الثالثة (أدوات الوكيل) — يتجاهله المزودون الحاليون. */
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
}
