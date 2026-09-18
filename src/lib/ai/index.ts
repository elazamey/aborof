/**
 * وحدة الذكاء الاصطناعي النمطية — الواجهة العامة (المرحلة الأولى).
 *
 * الميزة كلها خلف علم `ENABLE_AI_AGENT` عند نقطة الاستدعاء؛ غيابه أو أي
 * قيمة غير `true` تُبقي السلوك القديم المستقر في /api/chat كما هو حرفيًا.
 */
import { SmartAgentEngine } from "./agent-engine";

export { SmartAgentEngine } from "./agent-engine";
export { GeminiRestProvider } from "./providers/gemini-rest";
export { GroqProvider } from "./providers/groq";
export { LocalFallbackProvider, buildLocalAnswer } from "./providers/local-fallback";
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
