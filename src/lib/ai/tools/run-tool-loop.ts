import type { McpToolRegistry } from "../mcp/registry";
import type { McpToolResult } from "../mcp/types";
import type { AgentMessage, AgentOptions } from "../types";
import type { OpenAIChatMessage, OpenAIToolDefinition, ToolCapableProvider } from "./types";

/**
 * دورة الأدوات المحدودة (Bounded tool loop).
 *
 *  - عدد دورات الموديل محدود بسقف الاستدعاءات المركزي: `maxCalls + 1` كحد أقصى
 *    (كل استدعاء أداة يتبعه دور موديل، والدور الأخير بلا أدوات لإجبار نص نهائي).
 *  - التنفيذ كله عبر `McpToolRegistry`: لا تنفيذ مباشر، ولا تجاوز للحدود.
 *  - أي فشل في دورة الموديل يرمي للأعلى ليكمل المحرك سلسلته الصامتة كما هو.
 */

export interface ToolLoopResult {
  reply: string;
  /** عدد محاولات تنفيذ الأدوات (المقبولة والمرفوضة) في هذا الطلب. */
  toolCalls: number;
  /** محتوى منظّم من الأدوات الناجحة — يقود مكونات الواجهة (بطاقات المنتجات). */
  structured: Record<string, unknown>[];
}

function contentText(result: McpToolResult): string {
  const text = result.content.map((part) => part.text).join("\n").trim();
  if (!result.isError) return text;
  return `(لم تُنفَّذ الأداة) ${text}`.trim();
}

function toToolDefinition(definition: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): OpenAIToolDefinition {
  return {
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
    },
  };
}

export async function runToolLoop(opts: {
  provider: ToolCapableProvider;
  messages: AgentMessage[];
  options?: AgentOptions;
  registry: McpToolRegistry;
}): Promise<ToolLoopResult> {
  const { provider, messages, options, registry } = opts;

  // تضييق اختياري لقائمة الأدوات (أسطول الوكلاء): تقاطع مع المرئي في السجل فقط —
  // لا يمكن لأي قائمة معلنة أن تُظهر أداة محجوبة أو توسّع صلاحية. غيابها = السلوك القديم.
  const allowlist = options?.allowedTools ? new Set(options.allowedTools) : null;
  const definitions = registry
    .listTools()
    .filter((definition) => !allowlist || allowlist.has(definition.name));
  if (definitions.length === 0) return { reply: "", toolCalls: 0, structured: [] };

  const tools = definitions.map(toToolDefinition);
  const budget = registry.newBudget();
  const maxCalls = budget.limit;

  const conversation: OpenAIChatMessage[] = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  let used = 0;
  let lastText = "";
  const structured: Record<string, unknown>[] = [];

  for (let step = 0; step <= maxCalls; step++) {
    const allowTools = step < maxCalls && budget.remaining() > 0;
    const reply = await provider.callWithTools(conversation, allowTools ? tools : [], options);
    lastText = reply.text;

    if (!allowTools || reply.toolCalls.length === 0) {
      return { reply: reply.text.trim(), toolCalls: used, structured };
    }

    conversation.push(reply.assistantMessage);
    for (const call of reply.toolCalls) {
      const result = await registry.callTool(call.name, call.argumentsJson, { budget });
      used += 1;
      if (result.structuredContent) structured.push(result.structuredContent);
      conversation.push({ role: "tool", tool_call_id: call.id, content: contentText(result) });
    }
  }

  return { reply: lastText.trim(), toolCalls: used, structured };
}
