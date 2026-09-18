/**
 * الواجهة العامة لطبقة MCP المحكومة (المرحلة الثانية).
 *
 * الميزة كلها خلف `ENABLE_MCP_TOOLS` عند نقطة الاستدعاء، وطبقة السجل تعيد
 * الفحص مرة أخرى (دفاع مزدوج بنفس مبدأ المرحلة الأولى). غياب العلم يعني:
 * صفر أدوات مرئية للموديل، وصفر تنفيذ، وسلوك مطابق تمامًا لما قبل المرحلة.
 */
import { McpToolRegistry } from "./registry";
import { STORE_TOOLS } from "./tools/store";

export { McpToolRegistry } from "./registry";
export { STORE_TOOLS } from "./tools/store";
export {
  MCP_POLICY_LIMITS,
  areWriteToolsAllowed,
  clampInt,
  isMcpToolsEnabled,
  mcpPolicySnapshot,
  resolveAllowedToolNames,
} from "./policy";
export type { McpPolicySnapshot } from "./policy";
export type {
  McpCallBudget,
  McpCallContext,
  McpCallStatus,
  McpTextContent,
  McpTool,
  McpToolDefinition,
  McpToolDescriptor,
  McpToolOutput,
  McpToolPolicy,
  McpToolResult,
  McpToolValidation,
} from "./types";

let sharedRegistry: McpToolRegistry | null = null;

/** نسخة مشتركة على مستوى العملية — السجل بلا حالة قابلة للتسابق. */
export function getMcpRegistry(): McpToolRegistry {
  if (!sharedRegistry) {
    sharedRegistry = new McpToolRegistry();
    sharedRegistry.registerAll(STORE_TOOLS);
  }
  return sharedRegistry;
}
