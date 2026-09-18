import { redactSecrets } from "@/lib/errors";
import type { AgentMessage, AgentOptions, AIAgentProvider } from "../types";
import { openAiCompatibleChat } from "../tools/openai-compatible";
import type {
  OpenAIChatMessage,
  OpenAIToolDefinition,
  ToolCapableProvider,
  ToolModelReply,
} from "../tools/types";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

function model(): string {
  return process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
}

/**
 * مزود Groq (واجهة متوافقة مع OpenAI) — البديل الثاني في السلسلة.
 *
 * مسار النص العادي لم يتغير إطلاقًا عن المرحلة الأولى (نفس النموذج، نفس
 * الإعدادات، نفس نمط رسالة الخطأ). أُضيفت قدرة الأدوات فقط: `callWithTools`
 * تستخدم العميل الموحّد، ولا تُستدعى إلا عندما تكون طبقة MCP مفعّلة.
 */
export class GroqProvider implements AIAgentProvider, ToolCapableProvider {
  readonly name = "groq";
  readonly supportsTools = true as const;

  private readonly apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.GROQ_API_KEY ?? "";
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async generateResponse(messages: AgentMessage[], options?: AgentOptions): Promise<string> {
    const temperature = options?.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? 700;

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: model(),
        temperature,
        max_tokens: maxTokens,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) throw new Error("Groq: " + redactSecrets((await res.text()).slice(0, 200)));
    const j = await res.json();
    const text = (j?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) throw new Error("Groq: empty response");
    return text;
  }

  async callWithTools(
    messages: OpenAIChatMessage[],
    tools: OpenAIToolDefinition[],
    options?: AgentOptions
  ): Promise<ToolModelReply> {
    return openAiCompatibleChat({
      label: "Groq",
      url: ENDPOINT,
      apiKey: this.apiKey,
      model: model(),
      messages,
      tools,
      temperature: options?.temperature ?? 0.7,
      maxTokens: options?.maxTokens ?? 700,
    });
  }
}
