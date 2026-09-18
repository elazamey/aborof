/**
 * وحدة الذكاء الاصطناعي النمطية — الواجهة العامة.
 *
 * المرحلة الأولى: المحرك الصامت (Gemini ← Groq ← المحلي) خلف `ENABLE_AI_AGENT`.
 * المرحلة الثانية (إضافية بالكامل): مزود NVIDIA NIM اختياري يحمل وجوده مفتاحه،
 * وطبقة MCP محكومة للقراءة فقط خلف `ENABLE_MCP_TOOLS`.
 *
 * غياب أي من العلمين يُبقي السلوك القديم المستقر كما هو حرفيًا.
 */
import { SmartAgentEngine } from "./agent-engine";

export { SmartAgentEngine } from "./agent-engine";
export { GeminiRestProvider } from "./providers/gemini-rest";
export { GroqProvider } from "./providers/groq";
export { LocalFallbackProvider, buildLocalAnswer } from "./providers/local-fallback";
export {
  DEFAULT_NIM_BASE_URL,
  DEFAULT_NIM_MODEL,
  NvidiaNimProvider,
  resolveNimBaseUrl,
} from "./providers/nvidia-nim";
export { getMcpRegistry, isMcpToolsEnabled } from "./mcp";
export { MAX_PRODUCT_CARDS, extractProductCards } from "./cards";
export { runToolLoop } from "./tools/run-tool-loop";
export { openAiCompatibleChat } from "./tools/openai-compatible";
export type { McpToolDefinition, McpToolOutput, McpToolResult } from "./mcp";
export type { ProductCard } from "./cards";
export type {
  OpenAIChatMessage,
  OpenAIToolDefinition,
  RawToolCall,
  ToolCapableProvider,
  ToolModelReply,
} from "./tools/types";
export type {
  AgentMessage,
  AgentOptions,
  AgentResult,
  AgentRole,
  AIAgentProvider,
} from "./types";

let sharedEngine: SmartAgentEngine | null = null;

/** نسخة مشتركة على مستوى العملية — المحرك بلا حالة قابلة للتسابق. */
export function getSmartAgentEngine(): SmartAgentEngine {
  if (!sharedEngine) sharedEngine = new SmartAgentEngine();
  return sharedEngine;
}
