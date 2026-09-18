import { redactSecrets } from "@/lib/errors";
import type { AgentMessage, AgentOptions, AIAgentProvider } from "../types";

/**
 * مزود Gemini عبر REST مباشرة (بدون SDK) — نفس نقطة النهاية وسلسلة النماذج
 * التاريخية في /api/chat، فلا يتغير السلوك عند تفعيل العلم.
 */
const DEFAULT_MODELS = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-flash-lite-latest"];

export class GeminiRestProvider implements AIAgentProvider {
  readonly name = "gemini";
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.GEMINI_API_KEY ?? "";
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async generateResponse(messages: AgentMessage[], options?: AgentOptions): Promise<string> {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const convo = messages.filter((m) => m.role !== "system");
    const models = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : DEFAULT_MODELS;
    const temperature = options?.temperature ?? 0.7;
    const maxOutputTokens = options?.maxTokens ?? 1200;

    let lastErr = "";
    for (const model of models) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents: convo.map((m) => ({
              role: m.role === "assistant" ? "model" : "user",
              parts: [{ text: m.content }],
            })),
            generationConfig: { temperature, maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } },
          }),
        }
      );
      if (res.ok) {
        const j = await res.json();
        const text =
          j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text).join("") ?? "";
        if (text.trim()) return text.trim();
        lastErr = "empty response";
      } else {
        lastErr = await res.text();
      }
    }
    // أي خطأ يُحجب منه نمط الأسرار قبل أن يغادر الوحدة.
    throw new Error("Gemini: " + redactSecrets(lastErr.slice(0, 200)));
  }
}
