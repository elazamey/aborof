import { redactSecrets } from "@/lib/errors";
import { metrics } from "@/lib/observability/metrics";
import { GeminiRestProvider } from "./providers/gemini-rest";
import { GroqProvider } from "./providers/groq";
import { LocalFallbackProvider } from "./providers/local-fallback";
import type { AgentMessage, AgentOptions, AgentResult, AIAgentProvider } from "./types";

/**
 * محرك الوكيل الذكي — سلسلة تراجع محكمة (المحرك الصامت):
 *   Gemini ← Groq ← الرد المحلي.
 *
 *  - كل فشل أو رد فارغ ينتقل صامتًا للمزود التالي (لا 500 للمستخدم).
 *  - كل فشل يُسجَّل في المقاييس مع رسالة محجوبة الأسرار.
 *  - طبقة حماية إضافية لعلم الميزة: إن وصل المحرك والعلم غير مفعّل
 *    فالجواب محلي فورًا (المسار الأساسي للعلم ما زال عند نقطة الاستدعاء).
 *
 * يقبل المحرك قائمة مزودين اختيارية لحقن التبعيات في الاختبارات.
 */
export class SmartAgentEngine {
  private readonly providers: AIAgentProvider[];

  constructor(providers?: AIAgentProvider[]) {
    this.providers = providers ?? [
      new GeminiRestProvider(),
      new GroqProvider(),
      new LocalFallbackProvider(),
    ];
  }

  /** يعالج الطلب ويعيد الرد مع اسم المزود الذي قدّمه (للمراقبة والشفافية). */
  async processRequestDetailed(
    messages: AgentMessage[],
    options?: AgentOptions
  ): Promise<AgentResult> {
    // فحص علم الميزة — تعطيل المحرك يعني ردًا محليًا فوريًا.
    if (process.env.ENABLE_AI_AGENT !== "true") {
      return {
        reply: await new LocalFallbackProvider().generateResponse(messages, options),
        provider: "local",
      };
    }

    for (const provider of this.providers) {
      if (!provider.isAvailable()) continue;
      try {
        const reply = await provider.generateResponse(messages, options);
        if (reply.trim()) return { reply, provider: provider.name };
      } catch (e) {
        metrics.recordAiFailure(provider.name);
        console.error(
          `ai engine: ${provider.name} failed:`,
          redactSecrets(String((e as Error)?.message ?? e))
        );
      }
    }

    // حارس أخير نظريًا فقط: المزود المحلي في السلسلة الافتراضية متاح دائمًا.
    return { reply: "عذرًا، الخدمة غير متاحة حاليًا. يرجى المحاولة لاحقًا.", provider: "none" };
  }

  /** الواجهة البسيطة: نص الرد فقط. */
  async processRequest(messages: AgentMessage[], options?: AgentOptions): Promise<string> {
    return (await this.processRequestDetailed(messages, options)).reply;
  }
}
