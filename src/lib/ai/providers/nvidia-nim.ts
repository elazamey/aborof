import type { AgentMessage, AgentOptions, AIAgentProvider } from "../types";
import { openAiCompatibleChat } from "../tools/openai-compatible";
import type {
  OpenAIChatMessage,
  OpenAIToolDefinition,
  ToolCapableProvider,
  ToolModelReply,
} from "../tools/types";

/**
 * مزود NVIDIA NIM (اختياري تمامًا) — المرحلة الثانية.
 *
 *  - واجهة متوافقة مع OpenAI؛ تعمل مع السحابة المستضافة
 *    (`https://integrate.api.nvidia.com/v1`) أو مع NIM مستضاف داخليًا عبر
 *    `NVIDIA_NIM_BASE_URL` بشرط **https** حصرًا (لا http، فلا تُستخدم أبدًا
 *    لنقل مفتاح على قناة غير مشفّرة).
 *  - المفتاح `NVIDIA_NIM_API_KEY` (أو الاسم المختصر `NVIDIA_API_KEY`)؛ غيابه
 *    يعني أن المزود غير متاح فيُتخطى صامتًا ولا يتغير سلوك السلسلة القديمة.
 *  - يدعم استدعاء الأدوات (`supportsTools`) فيدخل دورة MCP المحكومة عندما
 *    تكون مفعّلة؛ ودون تفعيلها يعمل كمزوّد نصي عادي بنفس مسار Groq.
 *  - أي خطأ يمر عبر حجب الأسرار وينتقل للمزود التالي في السلسلة الصامتة.
 */

export const DEFAULT_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const DEFAULT_NIM_MODEL = "meta/llama-3.3-70b-instruct";

/** يتحقق من الرابط: https فقط، وإلا فالمزود غير متاح (fail-closed). */
export function resolveNimBaseUrl(raw: string | undefined | null = process.env.NVIDIA_NIM_BASE_URL): string | null {
  const value = String(raw ?? "").trim();
  if (value === "") return DEFAULT_NIM_BASE_URL;
  if (!/^https:\/\/[^\s]+$/i.test(value)) return null;
  return value.replace(/\/+$/, "");
}

export function nimApiKey(): string {
  return process.env.NVIDIA_NIM_API_KEY ?? process.env.NVIDIA_API_KEY ?? "";
}

export class NvidiaNimProvider implements AIAgentProvider, ToolCapableProvider {
  readonly name = "nvidia-nim";
  readonly supportsTools = true as const;

  private readonly apiKey: string;
  private readonly baseUrl: string | null;
  private readonly model: string;

  constructor(overrides: { apiKey?: string; baseUrl?: string; model?: string } = {}) {
    this.apiKey = overrides.apiKey ?? nimApiKey();
    this.baseUrl = resolveNimBaseUrl(overrides.baseUrl ?? process.env.NVIDIA_NIM_BASE_URL);
    this.model = overrides.model ?? process.env.NVIDIA_NIM_MODEL ?? DEFAULT_NIM_MODEL;
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
    if (!this.baseUrl) throw new Error("NVIDIA NIM: NVIDIA_NIM_BASE_URL يجب أن يبدأ بـ https://");
    if (!this.apiKey) throw new Error("NVIDIA NIM: المفتاح غير مُعيَّن");

    return openAiCompatibleChat({
      label: "NVIDIA NIM",
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
