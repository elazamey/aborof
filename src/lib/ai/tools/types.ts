import type { AgentOptions, AIAgentProvider } from "../types";

/**
 * عقد مزود يدعم استدعاء الأدوات (نمط OpenAI) — الطبقة الوسطى بين المحرك
 * وطبقة MCP المحكومة.
 *
 * المزود لا يقرر بنفسه أي أداة تُنفَّذ: يعيد طلبات الأدوات كما وردت من الموديل،
 * وطبقة MCP وحدها تتحقق من الاسم والوسائط والحدود وتنفّذ أو ترفض.
 */

export interface RawToolCall {
  id: string;
  name: string;
  /** وسائط خام كما أعادها الموديل (نص JSON غالبًا) — لا تُفسَّر هنا. */
  argumentsJson: string;
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** تُعاد كما وردت حرفيًا عند إعادة الرسالة للموديل. */
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface OpenAIToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** نتيجة دورة واحدة من الموديل: نص نهائي أو طلبات أدوات (أو الاثنان). */
export interface ToolModelReply {
  text: string;
  toolCalls: RawToolCall[];
  /** الرسالة الخام الواجب إعادة إرسالها مع نتائج الأدوات في الدورة التالية. */
  assistantMessage: OpenAIChatMessage;
}

/** مزود قادر على استدعاء الأدوات — تُكتشف القدرة وقت التشغيل لا بالافتراض. */
export interface ToolCapableProvider extends AIAgentProvider {
  readonly supportsTools: true;
  callWithTools(
    messages: OpenAIChatMessage[],
    tools: OpenAIToolDefinition[],
    options?: AgentOptions
  ): Promise<ToolModelReply>;
}
