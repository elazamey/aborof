/**
 * أسطول وكلاء المتجر (المرحلة الرابعة) — الواجهة العامة.
 *
 * الخمسون وكيلًا إضافة **تصريحية** فوق المعمارية القائمة: نفس المحرك النمطي،
 * نفس طبقة MCP المحكومة، ونفس مسار `/api/chat`. لا مسار HTTP جديد للتنفيذ،
 * ولا قدرة كتابة، ولا تغيير في أي سلوك قائم ما دام `ENABLE_AGENT_FLEET` مغلقًا
 * أو `ENABLE_AI_AGENT` معطّلًا (انظر `isAgentFleetActive`).
 */
export { selectAgents, selectionSummary, FLEET_MAX_SUPPORTERS } from "./router";
export {
  AGENT_FLEET,
  AGENT_FLEET_SIZE,
  READ_ONLY_TOOL_NAMES,
  agentsByDepartment,
  fleetSnapshot,
  getAgentById,
  getDefaultAgent,
  isAgentFleetActive,
  isAgentFleetEnabled,
  validateFleet,
} from "./catalog";
export { normalizeArabic, normalizeForMatch, normalizedTokens } from "./normalize";
export {
  FLEET_PROMPT_BUDGET,
  fleetCatalogManifest,
  fleetPromptSection,
  fleetResponseMeta,
  fleetToolAllowlist,
} from "./prompt";
export { AGENT_DEPARTMENTS, DEPARTMENT_LABELS } from "./types";
export type { AgentDepartment, AgentSelection, FleetResponseMeta, StoreAgent } from "./types";
