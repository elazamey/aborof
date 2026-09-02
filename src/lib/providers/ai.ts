/**
 * AI Provider — واجهة مزوّد الذكاء الاصطناعي (سيليا) مع تطبيقات حتمية.
 *
 * قاعدة PRE_RELEASE_GATE:
 *  - مهلة صارمة: المزوّد المعلّق يجب ألا يعلّق الشات (10 ثوانٍ في /api/chat الحالي).
 *  - fallback محلي إلزامي: فشل/عدم توفر المزوّد → رد محلي (chat-local).
 *  - الاختبارات: Fake حتمي يختبر success/failure/timeout/unavailable + سلوك الـ fallback.
 *
 * ملاحظة: إضافي (additive) — /api/chat الحالي لا يغيّر سلوكه.
 */
export type AIMessage = { role: "user" | "assistant"; content: string };
export type AIReply = { text: string; source: string };

export interface AIProvider {
  readonly name: string;
  /** يرد على المحادثة بسياق المتجر. يرمي خطأً عند timeout/failure/unavailable. */
  reply(context: string, messages: AIMessage[]): Promise<AIReply>;
}

export type FakeAIOptions = {
  fail?: boolean;
  timeoutMs?: number;
  replyText?: string;
};

/** Test Double حتمي لمزوّد AI. */
export function createFakeAIProvider(options: FakeAIOptions = {}): AIProvider {
  return {
    name: "fake-ai",
    async reply(context, messages) {
      if (options.timeoutMs) {
        await new Promise((r) => setTimeout(r, options.timeoutMs));
      }
      if (options.fail) throw new Error("ai provider failed (fake)");
      const last = messages[messages.length - 1]?.content ?? "";
      return {
        text: options.replyText ?? `رد حتمي (fake) على: ${last.slice(0, 60)}`,
        source: "fake-ai",
      };
    },
  };
}

/** أداة fallback: أي فشل من المزوّد الأساسي → المزوّد الاحتياطي. لا ترمي أبداً إلا إذا فشل الاحتياطي أيضاً. */
export async function withAIFallback(
  primary: AIProvider,
  fallback: AIProvider,
  context: string,
  messages: AIMessage[]
): Promise<AIReply> {
  try {
    return await primary.reply(context, messages);
  } catch {
    return fallback.reply(context, messages);
  }
}
