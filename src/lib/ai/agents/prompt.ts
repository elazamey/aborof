import { AGENT_FLEET, READ_ONLY_TOOL_NAMES } from "./catalog";
import type { AgentSelection, FleetResponseMeta, StoreAgent } from "./types";

/**
 * تركيب رسالة النظام للوكيل المناوب — مضافة إلى رسالة سيليا الأساسية، لا بديل عنها.
 *
 * حاجزان مقصودان:
 *  1) **ميزانية أحرف** (FLEET_PROMPT_BUDGET): لا يمكن للأسطول أن يضخّم الطلب
 *     المرسل للموديل مهما كانت التعريفات طويلة.
 *  2) **حصر الأدوات**: قائمة الأدوات المعلنة للوكيل = تقاطع أدوات الوكلاء المناوبين
 *     مع الأدوات المسجّلة فعلًا للقراءة فقط. لا اتحاد ولا توسيع.
 */

export const FLEET_PROMPT_BUDGET = 1_200;

const TRUNCATION_MARKER = "\n…[اقتصاص ميزانية الأسطول]";

function agentLine(agent: StoreAgent): string {
  return `- ${agent.name} (${agent.department}): ${agent.mission}`;
}

/** القسم النصي المضاف لرسالة النظام — مقيّد بالميزانية دائمًا. */
export function fleetPromptSection(selection: AgentSelection): string {
  const lines: string[] = [
    "== وكيل المتجر المناوب (أسطول الوكلاء) ==",
    `الوكيل الأساسي: ${agentLine(selection.primary).slice(2)}`,
    "قواعد الوكيل:",
    ...selection.primary.guidance.map((rule, index) => `${index + 1}. ${rule}`),
  ];

  if (selection.supporters.length > 0) {
    lines.push("وكلاء مساندون (استعيني بخبرتهم عند الحاجة):");
    lines.push(...selection.supporters.map(agentLine));
  }

  lines.push(
    `أدواتك المسموحة الآن: ${fleetToolAllowlist(selection).join(", ") || "لا شيء (أجيبي نصيًا)"}`
  );
  if (selection.primary.escalateToHuman) {
    lines.push("هذه الحالة تحتاج متابعة بشرية: اذكري الواتساب مرة واحدة في نهاية الرد.");
  }

  const text = lines.join("\n");
  if (text.length <= FLEET_PROMPT_BUDGET) return text;
  return text.slice(0, FLEET_PROMPT_BUDGET - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/** الأدوات المتاحة للوكيل المناوب: تقاطع (لا اتحاد) مع المسجّل للقراءة فقط. */
export function fleetToolAllowlist(selection: AgentSelection): string[] {
  const declared = new Set<string>([
    ...selection.primary.tools,
    ...selection.supporters.flatMap((agent) => agent.tools),
  ]);
  return READ_ONLY_TOOL_NAMES.filter((name) => declared.has(name));
}

/** بيانات مختصرة للاستجابة — بلا أي محتوى داخلي، فقط هوية الوكيل وسبب الاختيار. */
export function fleetResponseMeta(selection: AgentSelection): FleetResponseMeta {
  const brief = (agent: StoreAgent) => ({
    id: agent.id,
    name: agent.name,
    department: agent.department,
  });
  return {
    primary: brief(selection.primary),
    supporters: selection.supporters.map(brief),
    routed_by: selection.routedBy,
    confidence: Number(selection.confidence.toFixed(2)),
  };
}

/** فهرس الوكلاء للعرض الإداري — بلا أي سر، ومحمي بجلسة الإدارة عند الاستخدام. */
export function fleetCatalogManifest() {
  return AGENT_FLEET.map((agent) => ({
    id: agent.id,
    name: agent.name,
    department: agent.department,
    mission: agent.mission,
    keywords: agent.keywords.length,
    tools: agent.tools,
    escalate_to_human: agent.escalateToHuman === true,
    is_default: agent.isDefault === true,
  }));
}
