/**
 * وحدة الذكاء الاصطناعي النمطية — الواجهة العامة.
 *
 * المرحلة الأولى: المحرك الصامت (Gemini ← Groq ← المحلي) خلف `ENABLE_AI_AGENT`.
 * المرحلة الثانية (إضافية بالكامل): مزود NVIDIA NIM اختياري يحمل وجوده مفتاحه،
 * وطبقة MCP محكومة للقراءة فقط خلف `ENABLE_MCP_TOOLS`.
 * لاحقًا: مزود AI Gateway اختياري (Vercel) بنفس النمط — غياب مفتاحه يُخرجه
 * من السلسلة صامتًا، فالترتيب الافتراضي Gemini ← Groq ← NIM ← Gateway ← محلي.
 *
 * غياب أي من العلمين يُبقي السلوك القديم المستقر كما هو حرفيًا.
 */
import { SmartAgentEngine } from "./agent-engine";

export { SmartAgentEngine } from "./agent-engine";
export {
  AiGatewayProvider,
  DEFAULT_AI_GATEWAY_BASE_URL,
  DEFAULT_AI_GATEWAY_MODEL,
  resolveAiGatewayBaseUrl,
} from "./providers/ai-gateway";
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
// المرحلة الرابعة: أسطول وكلاء المتجر (إضافة تصريحية، معطّلة افتراضيًا).
export {
  AGENT_FLEET,
  AGENT_FLEET_SIZE,
  FLEET_DEPARTMENT_PRIORITY,
  FLEET_PROMPT_BUDGET,
  LOW_CONFIDENCE_THRESHOLD,
  READ_ONLY_TOOL_NAMES,
  disabledAgentIds,
  effectiveFleet,
  fleetAuditRecord,
  fleetCatalogManifest,
  fleetPromptSection,
  fleetResponseMeta,
  fleetSnapshot,
  fleetToolAllowlist,
  getAgentById,
  getDefaultAgent,
  isAgentDisabled,
  isAgentFleetActive,
  isAgentFleetEnabled,
  isFleetWildcardDisabled,
  isLowConfidence,
  selectAgents,
  selectionSummary,
  validateFleet,
} from "./agents";
export type { AgentDepartment, AgentSelection, FleetResponseMeta, StoreAgent } from "./agents";
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
