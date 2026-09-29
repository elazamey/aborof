import { redactSecrets } from "@/lib/errors";
import type { OpenAIChatMessage, OpenAIToolDefinition, RawToolCall, ToolModelReply } from "./types";

/**
 * عميل موحّد لواجهة متوافقة مع OpenAI (Groq وNVIDIA NIM وAI Gateway).
 *
 * الهدف: عقد واحد للرسائل والأدوات بدل تكرار المنطق في كل مزود، مع بقاء
 * سلوك الرسائل كما هو (نفس الترويسات ونفس نمط رسالة الخطأ `Label: …` بعد
 * حجب الأسرار). لا يُبنى أي شيء على هذه الطبقة إن لم تُطلب الأدوات صراحةً.
 */

const DEFAULT_TIMEOUT_MS = 20_000;

export interface OpenAiCompatibleRequest {
  /** بادئة رسالة الخطأ الآمنة (اسم المزود). */
  label: string;
  url: string;
  apiKey: string;
  model: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAIToolDefinition[];
  temperature: number;
  maxTokens: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function normalizeToolCalls(raw: unknown): RawToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: RawToolCall[] = [];
  for (const entry of raw) {
    const call = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const id = typeof call?.id === "string" ? call.id : "";
    const name = typeof call?.function?.name === "string" ? call.function.name : "";
    if (!id || !name) continue;
    const args =
      typeof call.function?.arguments === "string"
        ? call.function.arguments
        : JSON.stringify(call.function?.arguments ?? {});
    out.push({ id, name, argumentsJson: args });
  }
  return out;
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

export async function openAiCompatibleChat(request: OpenAiCompatibleRequest): Promise<ToolModelReply> {
  const { label, url, apiKey, model, messages, tools, temperature, maxTokens } = request;
  const timer = timeoutSignal(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, request.signal);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: timer.signal,
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages,
        ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      }),
    });
  } catch (error) {
    // أي فشل نقل يُحوَّل إلى خطأ واحد بنفس نمط المزودين الحاليين.
    throw new Error(
      `${label}: ${redactSecrets(String((error as Error)?.message ?? error)).slice(0, 200)}`
    );
  } finally {
    timer.dispose();
  }

  if (!response.ok) {
    throw new Error(`${label}: ` + redactSecrets((await response.text()).slice(0, 200)));
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: unknown; tool_calls?: unknown } }[];
  };
  const message = payload?.choices?.[0]?.message;
  const text = typeof message?.content === "string" ? message.content.trim() : "";
  const toolCalls = normalizeToolCalls(message?.tool_calls);

  if (!text && toolCalls.length === 0) throw new Error(`${label}: empty response`);

  return {
    text,
    toolCalls,
    assistantMessage: {
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(toolCalls.length > 0
        ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.argumentsJson },
            })),
          }
        : {}),
    },
  };
}
