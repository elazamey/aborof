import { redactSecrets } from "@/lib/errors";
import type { AgentMessage, AgentOptions, AIAgentProvider } from "../types";

/**
 * مزود Groq (واجهة متوافقة مع OpenAI) — البديل الثاني في السلسلة،
 * بنفس النموذج الافتراضي والإعدادات التاريخية في /api/chat.
 */
export class GroqProvider implements AIAgentProvider {
  readonly name = "groq";
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

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
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
}
