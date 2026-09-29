import type { AgentMessage, AgentOptions, AIAgentProvider } from "../types";
import { openAiCompatibleChat } from "../tools/openai-compatible";
import type {
  OpenAIChatMessage,
  OpenAIToolDefinition,
  ToolCapableProvider,
  ToolModelReply,
} from "../tools/types";

/**
 * مزود Vercel AI Gateway (اختياري تمامًا).
 *
 *  - نقطة نهاية واحدة متوافقة مع OpenAI (`https://ai-gateway.vercel.sh/v1`)
 *    تخدم أي موديل بصيغة `creator/model` — مثل `openai/gpt-5.5` — فمفتاح
 *    واحد يحلّ محل عدة مفاتيح مزودين.
 *  - المفتاح `AI_GATEWAY_API_KEY`؛ غيابه يعني أن المزود غير متاح فيُتخطّى
 *    صامتًا، ولا يتغيّر سلوك السلسلة القديمة حرفيًا.
 *  - `AI_GATEWAY_BASE_URL` للتوجيه إلى مٌحاكي محلي في الاختبارات، **https فقط**
 *    (نفس سياسة NIM: لا يمرّ مفتاح على قناة غير مشفّرة أبدًا).
 *  - `AI_GATEWAY_MODEL` لاسم الموديل، و**يجب** أن يحمل شكل `creator/model`؛
 *    أي قيمة بلا `/` تُلغي المزود (fail-closed) بدل خطأ غامض من البوابة.
 *  - يدعم استدعاء الأدوات (`supportsTools`) فتدخل دورة MCP المحكومة عند
 *    تفعيلها؛ ودونها يعمل كمزوّد نصّي عادي بنفس مسار Groq وNIM.
 *  - أي خطأ يمرّ عبر حجب الأسرار (`vck_…` ⇒ `[REDACTED_AI_GATEWAY_KEY]`)
 *    ثم ينتقل للمزود التالي في السلسلة الصامتة.
 *
 * ⚠️ هذا المزود **ليس** حزمة `ai` (Vercel AI SDK): لا تُضاف هنا أي اعتمادية
 * خارجية. البوابة OpenAI المتوافقة تُنادى بنفس العميل الموحّد الذي يخدم
 * Groq وNIM (`tools/openai-compatible.ts`)، فالعقد واحد والمقاييس واحدة.
 */

export const DEFAULT_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
export const DEFAULT_GATEWAY_MODEL = "openai/gpt-5.5";

/** يتحقق من الرابط: https فقط، وإلا فالمزود غير متاح (fail-closed). */
export function resolveGatewayBaseUrl(
  raw: string | undefined | null = process.env.AI_GATEWAY_BASE_URL
): string | null {
  const value = String(raw ?? "").trim();
  if (value === "") return DEFAULT_GATEWAY_BASE_URL;
  if (!/^https:\/\/[^\s]+$/i.test(value)) return null;
  return value.replace(/\/+$/, "");
}

/**
 * يتحقق من اسم الموديل: بوابة Vercel تقبل شكل `creator/model` حصرًا
 * (`openai/gpt-5.5`)، وتمرير `gpt-5.5` مجردًا يُرفض هناك برسالة لا تذكر
 * السبب الحقيقي. القيمة الفارغة تعني الافتراضي.
 */
export function resolveGatewayModel(
  raw: string | undefined | null = process.env.AI_GATEWAY_MODEL
): string | null {
  const value = String(raw ?? "").trim();
  if (value === "") return DEFAULT_GATEWAY_MODEL;
  if (!/^[^\s]+\/[^\s]+$/.test(value)) return null;
  return value;
}

export function gatewayApiKey(): string {
  return process.env.AI_GATEWAY_API_KEY ?? "";
}

export class AiGatewayProvider implements AIAgentProvider, ToolCapableProvider {
  readonly name = "ai-gateway";
  readonly supportsTools = true as const;

  private readonly overrides: { apiKey?: string; baseUrl?: string; model?: string };

  constructor(overrides: { apiKey?: string; baseUrl?: string; model?: string } = {}) {
    this.overrides = overrides;
  }

  /** كل الإعدادات تُقرأ عند النداء: لا نسخة مهيّأة بمفتاح أو رابط قديم. */
  private get apiKey(): string {
    return this.overrides.apiKey ?? gatewayApiKey();
  }

  private get baseUrl(): string | null {
    return resolveGatewayBaseUrl(this.overrides.baseUrl ?? process.env.AI_GATEWAY_BASE_URL);
  }

  private get model(): string | null {
    return resolveGatewayModel(this.overrides.model ?? process.env.AI_GATEWAY_MODEL);
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0 && this.baseUrl !== null && this.model !== null;
  }

  async generateResponse(messages: AgentMessage[], options?: AgentOptions): Promise<string> {
    const reply = await this.chat(
      messages.map((m) => ({ role: m.role, content: m.content })),
      [],
      options
    );
    return reply.text;
  }

  async callWithTools(
    messages: OpenAIChatMessage[],
    tools: OpenAIToolDefinition[],
    options?: AgentOptions
  ): Promise<ToolModelReply> {
    return this.chat(messages, tools, options);
  }

  private async chat(
    messages: OpenAIChatMessage[],
    tools: OpenAIToolDefinition[],
    options?: AgentOptions
  ): Promise<ToolModelReply> {
    if (!this.baseUrl) throw new Error("AI Gateway: AI_GATEWAY_BASE_URL يجب أن يبدأ بـ https://");
    if (!this.model) throw new Error("AI Gateway: AI_GATEWAY_MODEL يجب أن يحمل شكل creator/model");
    if (!this.apiKey) throw new Error("AI Gateway: المفتاح غير مُعيَّن");

    return openAiCompatibleChat({
      label: "AI Gateway",
      url: `${this.baseUrl}/chat/completions`,
      apiKey: this.apiKey,
      model: this.model,
      messages,
      tools,
      temperature: options?.temperature ?? 0.7,
      maxTokens: options?.maxTokens ?? 700,
    });
  }
}
