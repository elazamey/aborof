import { STORE_TOOLS } from "../../mcp";
import { normalizeArabic, normalizeForMatch } from "../normalize";
import { OPERATIONS_AGENTS } from "./operations";
import { PAYMENTS_AGENTS } from "./payments";
import { LOGISTICS_AGENTS } from "./logistics";
import { SALES_AGENTS } from "./sales";
import { SUPPORT_AGENTS } from "./support";
import { AGENT_DEPARTMENTS, type AgentDepartment, type StoreAgent } from "../types";

/**
 * كتالوج الأسطول — 50 وكيلًا في خمسة أقسام (10 لكل قسم).
 *
 * الترتيب هنا هو ترتيب الفصل عند تعادل الدرجات (حتمي، بلا عشوائية)، ولهذا
 * تُجمَّع الملفات بترتيب الأقسام المعلن لا بترتيب الاستيراد.
 */
export const AGENT_FLEET_SIZE = 50;

const RAW_CATALOG: StoreAgent[] = [
  ...SALES_AGENTS,
  ...SUPPORT_AGENTS,
  ...LOGISTICS_AGENTS,
  ...PAYMENTS_AGENTS,
  ...OPERATIONS_AGENTS,
];

/** أسماء الأدوات المسجّلة فعلًا للقراءة فقط — المصدر الوحيد لصلاحية أداة أي وكيل. */
export const READ_ONLY_TOOL_NAMES: string[] = STORE_TOOLS.filter(
  (tool) => tool.policy.readOnly === true
).map((tool) => tool.definition.name);

const ID_PATTERN = /^[a-z][a-z0-9_]{2,40}$/;
const LIMITS = {
  nameMax: 60,
  missionMin: 15,
  missionMax: 180,
  keywordMin: 3,
  keywordMax: 10,
  keywordCharsMax: 40,
  guidanceMin: 1,
  guidanceMax: 3,
  guidanceCharsMax: 160,
} as const;

export interface FleetValidationProblem {
  agentId: string;
  problem: string;
}

/**
 * تحقق بنائي لكل وكيل — يُستدعى عند التحميل (مع استبعاد المخالف fail-closed)
 * وفي الاختبارات (التي تشترط قائمة مشاكل فارغة تمامًا).
 */
export function validateFleet(agents: readonly StoreAgent[] = RAW_CATALOG): FleetValidationProblem[] {
  const problems: FleetValidationProblem[] = [];
  const seen = new Set<string>();
  let defaults = 0;

  for (const agent of agents) {
    const id = String(agent?.id ?? "");
    const push = (problem: string) => problems.push({ agentId: id || "<بلا معرّف>", problem });

    if (!ID_PATTERN.test(id)) push("المعرّف يجب أن يكون snake_case بحروف لاتينية صغيرة (3-40 حرفًا)");
    if (seen.has(id)) push("معرّف مكرر");
    seen.add(id);

    if (!AGENT_DEPARTMENTS.includes(agent.department)) push(`قسم غير معروف: ${String(agent.department)}`);
    if (!agent.name || agent.name.length > LIMITS.nameMax) push("الاسم مفقود أو أطول من الحد");
    if (!agent.mission || agent.mission.length < LIMITS.missionMin || agent.mission.length > LIMITS.missionMax) {
      push("المهمة يجب أن تكون بين 15 و180 حرفًا");
    }
    if (!Array.isArray(agent.keywords) || agent.keywords.length < LIMITS.keywordMin || agent.keywords.length > LIMITS.keywordMax) {
      push(`المحفزات يجب أن تكون بين ${LIMITS.keywordMin} و${LIMITS.keywordMax}`);
    } else {
      for (const keyword of agent.keywords) {
        const normalized = normalizeArabic(keyword);
        if (normalized.length === 0) push("محفز فارغ بعد التطبيع");
        else if (normalized.length > LIMITS.keywordCharsMax) push(`محفز أطول من ${LIMITS.keywordCharsMax} حرفًا`);
      }
    }
    if (!Array.isArray(agent.tools) || agent.tools.length === 0) {
      push("لا أدوات معلنة (الوكيل بلا أدوات مقبول فقط إن كان غرضه نصيًا بحتًا، وهذا غير مسموح في الأسطول)");
    } else {
      for (const tool of agent.tools) {
        if (!READ_ONLY_TOOL_NAMES.includes(tool)) push(`أداة غير مسموحة أو غير للقراءة فقط: ${tool}`);
      }
    }
    if (!Array.isArray(agent.guidance) || agent.guidance.length < LIMITS.guidanceMin || agent.guidance.length > LIMITS.guidanceMax) {
      push(`قواعد السلوك يجب أن تكون بين ${LIMITS.guidanceMin} و${LIMITS.guidanceMax}`);
    } else if (agent.guidance.some((g) => !g || g.length > LIMITS.guidanceCharsMax)) {
      push(`قاعدة سلوك طويلة أكثر من ${LIMITS.guidanceCharsMax} حرفًا`);
    }
    if (agent.isDefault) defaults += 1;
  }

  if (agents.length !== AGENT_FLEET_SIZE) {
    problems.push({ agentId: "<الأسطول>", problem: `العدد ${agents.length} والمطلوب ${AGENT_FLEET_SIZE}` });
  }
  if (defaults !== 1) {
    problems.push({ agentId: "<الأسطول>", problem: `يجب أن يكون وكيل افتراضي واحد بالضبط (الموجود: ${defaults})` });
  }
  for (const department of AGENT_DEPARTMENTS) {
    const count = agents.filter((a) => a.department === department).length;
    if (count === 0) problems.push({ agentId: "<الأسطول>", problem: `القسم ${department} بلا وكلاء` });
  }

  return problems;
}

/** بديل آمن نظريًا لو استُبعد الوكيل الافتراضي لأي سبب — يبقي الدردشة تعمل. */
const SAFE_FALLBACK: StoreAgent = {
  id: "sales_general_safe",
  name: "سيليا",
  department: "sales",
  mission: "استقبلي رسالة العميل ووجّهيه لأقرب احتياج داخل المتجر.",
  keywords: ["منتجات", "متجر", "مستلزمات"],
  tools: ["search_products", "store_info"],
  guidance: ["لا تخترعي منتجًا أو سعرًا غير موجود في نتائج الأدوات."],
  isDefault: true,
};

const problems = validateFleet();
if (problems.length > 0) {
  // لا إسقاط للتطبيق: يُستبعد المخالف فقط ويُسجَّل بلا أي بيانات حساسة.
  console.warn(`agents: رُفض ${problems.length} تعريفًا مخالفًا في كتالوج الأسطول.`);
  for (const p of problems.slice(0, 10)) console.warn(`  - ${p.agentId}: ${p.problem}`);
}

const invalidIds = new Set(problems.filter((p) => p.agentId !== "<الأسطول>").map((p) => p.agentId));

/** الكتالوج المفعّل: كل وكيل مطابق للعقد، والافتراضي مضمون الوجود. */
export const AGENT_FLEET: readonly StoreAgent[] = (() => {
  const valid = RAW_CATALOG.filter((agent) => !invalidIds.has(agent.id));
  if (!valid.some((agent) => agent.isDefault)) {
    console.warn("agents: لا وكيل افتراضي صالح — استُخدم الوكيل الآمن.");
    return Object.freeze([...valid, SAFE_FALLBACK]);
  }
  return Object.freeze(valid);
})();

const BY_ID = new Map(AGENT_FLEET.map((agent) => [agent.id, agent]));

export function getAgentById(id: string): StoreAgent | null {
  return BY_ID.get(id) ?? null;
}

export function getDefaultAgent(): StoreAgent {
  return AGENT_FLEET.find((agent) => agent.isDefault) ?? SAFE_FALLBACK;
}

export function agentsByDepartment(department: AgentDepartment): StoreAgent[] {
  return AGENT_FLEET.filter((agent) => agent.department === department);
}

/** محفزات الوكيل بعد التطبيع الموحّد (يُحسب مرة واحدة). */
const KEYWORDS_CACHE = new Map<string, string[]>();
export function agentKeywords(agent: StoreAgent): string[] {
  const cached = KEYWORDS_CACHE.get(agent.id);
  if (cached) return cached;
  const list = agent.keywords.map((k) => normalizeForMatch(k)).filter((k) => k.length > 0);
  KEYWORDS_CACHE.set(agent.id, list);
  return list;
}

export function isAgentFleetEnabled(): boolean {
  return process.env.ENABLE_AGENT_FLEET === "true";
}

/**
 * قائمة تعطيل وكلاء بعينهم — `FLEET_DISABLED_AGENTS=sales_glass_surfaces,ops_stock_alerts`.
 *
 * قرار تصميمي مقصود: الحالة تُقرأ من البيئة (لا من ذاكرة العملية ولا من قاعدة
 * بيانات)، لأن النشر على Vercel يوزّع الطلبات على نسخ متعددة — أي «مفتاح إيقاف»
 * قابل للتغيير وقت التشغيل سيكون غير متسق بين النسخ (بعضها يعطّل وبعضها لا).
 * تغيير البيئة في Vercel يستلزم إعادة نشر، وهذا هو الثمن المقبول مقابل حالة
 * حتمية ومتسقة في كل النسخ.
 *
 * قيمة خاصة: `*` أو `all` ⇒ تعطيل كل المتخصصين والإبقاء على الوكيل الافتراضي
 * (وضع طوارئ ألطف من إغلاق الأسطول كليًا: تبقى الشخصية وتختفي التخصصات).
 * الوكيل الافتراضي لا يُعطَّل أبدًا — لا يبقى التوجيه بلا مخرج.
 */
export function disabledAgentIds(): string[] {
  const raw = process.env.FLEET_DISABLED_AGENTS;
  if (raw == null || raw.trim() === "") return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    )
  );
}

export function isFleetWildcardDisabled(): boolean {
  const ids = disabledAgentIds();
  return ids.includes("*") || ids.some((id) => id.toLowerCase() === "all");
}

/** الأسطول الفعّال الآن: الكتالوج ناقص المعطَّلين (والافتراضي مضمون دائمًا). */
export function effectiveFleet(): StoreAgent[] {
  const wildcard = isFleetWildcardDisabled();
  const disabled = new Set(disabledAgentIds());
  return AGENT_FLEET.filter((agent) => {
    if (agent.isDefault) return true;
    if (wildcard) return false;
    return !disabled.has(agent.id);
  });
}

/** هل هذا الوكيل معطَّل الآن بأمر بيئي؟ (للعرض الإداري لا للقرار) */
export function isAgentDisabled(id: string): boolean {
  const agent = BY_ID.get(id);
  if (agent?.isDefault) return false;
  if (isFleetWildcardDisabled()) return true;
  return disabledAgentIds().includes(id);
}

/**
 * الأسطول يعمل فقط فوق المحرك النمطي الموحّد (المرحلة الأولى). تفعيل العلم
 * بلا `ENABLE_AI_AGENT` لا يغيّر شيئًا في المسار القديم عمدًا — فلا يُكسر سلوك
 * مستقر بسبب علم جديد.
 */
export function isAgentFleetActive(): boolean {
  return isAgentFleetEnabled() && process.env.ENABLE_AI_AGENT === "true";
}

/** لقطة إدارية بلا أي سر — للعرض في المانيفست ودليل التشغيل. */
export function fleetSnapshot() {
  return {
    enabled: isAgentFleetEnabled(),
    active: isAgentFleetActive(),
    size: AGENT_FLEET.length,
    declared_size: AGENT_FLEET_SIZE,
    effective_size: effectiveFleet().length,
    disabled_agents: disabledAgentIds(),
    disabled_all_specialists: isFleetWildcardDisabled(),
    read_only_tools: READ_ONLY_TOOL_NAMES,
    departments: AGENT_DEPARTMENTS.map((department) => ({
      department,
      count: agentsByDepartment(department).length,
    })),
  };
}
