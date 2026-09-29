import type { AgentMessage, AgentOptions, AIAgentProvider } from "../types";
import { openAiCompatibleChat } from "../tools/openai-compatible";
import type {
  OpenAIChatMessage,
  OpenAIToolDefinition,
  ToolCapableProvider,
  ToolModelReply,
} from "../tools/types";

/**
 * مزود AI Gateway (اختياري تمامًا) — بوابة Vercel الموحدة للنماذج.
 *
 *  - واجهة متوافقة مع OpenAI على `https://ai-gateway.vercel.sh/v1`، ومفتاح
 *    `AI_GATEWAY_API_KEY` (بصيغة `vck_…`)؛ غيابه يعني أن المزود غير متاح
 *    فيُتخطى صامتًا ولا يتغير سلوك السلسلة القديمة حرفيًا.
 *  - رابط مخصّص عبر `AI_GATEWAY_BASE_URL` بشرط **https** حصرًا (لا http،
 *    فلا يُستخدم أبدًا لنقل مفتاح على قناة غير مشفّرة) — نفس سياسة NIM.
 *  - النموذج `AI_GATEWAY_MODEL` بصيغة البوابة `creator/model-name`، والقيمة
 *    الافتراضية نموذج صغير رخيص وكفء للعربية.
 *  - يدعم استدعاء الأدوات (`supportsTools`) فيدخل دورة MCP المحكومة عندما
 *    تكون مفعّلة؛ ودون تفعيلها يعمل كمزوّد نصي عادي بنفس مسار Groq.
 *  - أي خطأ يمر عبر حجب الأسرار وينتقل للمزود التالي في السلسلة الصامتة.
 *
 * الترتيب الافتراضي بعد هذه الإضافة:
 *   Gemini ← Groq ← NVIDIA NIM ← AI Gateway ← الرد المحلي.
 */

export const DEFAULT_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
export const DEFAULT_AI_GATEWAY_MODEL = "openai/gpt-4o-mini";

/** يتحقق من الرابط: https فقط، وإلا فالمزود غير متاح (fail-closed). */
export function resolveAiGatewayBaseUrl(
  raw: string | undefined | null = process.env.AI_GATEWAY_BASE_URL
): string | null {
  const value = String(raw ?? "").trim();
  if (value === "") return DEFAULT_AI_GATEWAY_BASE_URL;
  if (!/^https:\/\/[^\s]+$/i.test(value)) return null;
  return value.replace(/\/+$/, "");
}

export function aiGatewayApiKey(): string {
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
    return this.overrides.apiKey ?? aiGatewayApiKey();
  }

  private get baseUrl(): string | null {
    return resolveAiGatewayBaseUrl(this.overrides.baseUrl ?? process.env.AI_GATEWAY_BASE_URL);
  }

  private get model(): string {
    return this.overrides.model ?? process.env.AI_GATEWAY_MODEL ?? DEFAULT_AI_GATEWAY_MODEL;
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0 && this.baseUrl !== null;
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
