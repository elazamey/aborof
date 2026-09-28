import { effectiveFleet, getDefaultAgent, isFleetWildcardDisabled } from "./catalog";
import { agentKeywords } from "./catalog";
import { normalizeForMatch, normalizedTokens, stripDefiniteArticle } from "./normalize";
import { AGENT_DEPARTMENTS, type AgentDepartment, type AgentSelection, type StoreAgent } from "./types";

/**
 * موجّه الأسطول — قرار حتمي بالكامل.
 *
 * لماذا بلا موديل: التوجيه يقع قبل أي مزوّد، ويجب أن يعمل في كل الحالات —
 * بلا مفاتيح، وبلا شبكة، وبلا تكلفة. لذلك هو حساب نقاط نصي حتمي: نفس المدخل
 * يعطي نفس المخرج دائمًا، ويمكن اختباره بلا أي محاكاة.
 *
 * الأوزان:
 *   - عبارة متعددة الكلمات مطابقة كاملة: 2 + عدد كلماتها (الأكثر تحديدًا).
 *   - كلمة مفردة مطابقة كرمز كامل: 1.5.
 *   - كلمة مفردة طويلة (>= 5 أحرف) واردة داخل المدخل: 1 (تعامل مع الاشتقاق).
 *   - كلمة من اسم الوكيل: 0.75.
 *
 * حسم التعادل (عند تساوي الدرجة تمامًا) بترتيب ثابت موثّق:
 *   1) أولوية القسم (FLEET_DEPARTMENT_PRIORITY) — المبيعات ثم اللوجستيات ثم الدعم…
 *      لأن سؤال العميل يحمل غالبًا نية شرائية، والخطأ نحو البيع أرخص من الخطأ بعيدًا عنه.
 *   2) ترتيب الكتالوج (ترتيب التأليف) — لا أبجدية المعرّف، حتى يبقى القرار مقروءًا.
 */

export const FLEET_MAX_SUPPORTERS = 2;

/**
 * أولوية حسم التعادل بين الأقسام — سياسة معلنة وقابلة للاختبار.
 * ملاحظة: لا أثر لها إلا عند **تساوي الدرجة تمامًا**؛ لا تُقدَّم درجة أدنى أبدًا.
 */
export const FLEET_DEPARTMENT_PRIORITY: readonly AgentDepartment[] = [
  "sales",
  "logistics",
  "payments",
  "support",
  "operations",
];

const DEPARTMENT_RANK = new Map(
  FLEET_DEPARTMENT_PRIORITY.map((department, index) => [department, index])
);

const POLICY = {
  phraseBase: 2,
  tokenExact: 1.5,
  tokenInside: 1,
  nameWord: 0.75,
  /** أدنى درجة لدخول وكيل كمساند. */
  supporterMin: 1.5,
  /** درجة تُعتبر ثقة كاملة (1.0) عند المراقبة. */
  confidenceFull: 4,
  /**
   * حد الثقة المنخفضة — لا يمنع التوجيه (منع الأسئلة الغامضة يحوّلها للرد العام
   * وهو أسوأ للعميل)، بل يُوسَم في السجل التدقيقي ويظهر في المانيفست الإداري.
   */
  lowConfidence: 0.5,
} as const;

/** حد الثقة المنخفضة — مُصدَّر ليكون مصدر الحقيقة الوحيد للسجل والمانيفست والاختبارات. */
export const LOW_CONFIDENCE_THRESHOLD = POLICY.lowConfidence;

/** هل القرار منخفض الثقة (يستحق مراجعة بشرية في السجل)؟ */
export function isLowConfidence(confidence: number): boolean {
  return confidence < LOW_CONFIDENCE_THRESHOLD;
}

export function departmentRank(department: AgentDepartment): number {
  return DEPARTMENT_RANK.get(department) ?? FLEET_DEPARTMENT_PRIORITY.length;
}

interface Scored {
  agent: StoreAgent;
  score: number;
  matched: string[];
}

function scoreAgent(agent: StoreAgent, normalizedMessage: string, tokens: Set<string>): Scored {
  let score = 0;
  const matched: string[] = [];

  for (const keyword of agentKeywords(agent)) {
    if (keyword.includes(" ")) {
      if (normalizedMessage.includes(keyword)) {
        score += POLICY.phraseBase + keyword.split(" ").length;
        matched.push(keyword);
      }
      continue;
    }
    if (tokens.has(keyword)) {
      score += POLICY.tokenExact;
      matched.push(keyword);
    } else if (keyword.length >= 5 && normalizedMessage.includes(keyword)) {
      score += POLICY.tokenInside;
      matched.push(keyword);
    }
  }

  for (const word of normalizedTokens(agent.name)) {
    if (word.length >= 3 && tokens.has(word)) {
      score += POLICY.nameWord;
      matched.push(word);
    }
  }

  return { agent, score, matched };
}

/**
 * اختيار الوكلاء: أساسي واحد + مساندون (بلا تكرار)، مع سقوط إلى الوكيل
 * الافتراضي عند غياب أي تطابق. الترتيب عند التعادل بالمعرّف — حتمي.
 */
export function selectAgents(message: string, options?: { maxSupporters?: number }): AgentSelection {
  const normalizedMessage = normalizeForMatch(message);
  // الرموز تُطبَّع بنفس مسار المحفزات تمامًا (بما فيه حذف «ال») — وإلا فشل تطابق
  // مثل «الجيزه» مع محفز مُطبَّع إلى «جيزه». اكتشفه قياس المحفزات الفعلي.
  const tokens = new Set(normalizedTokens(message).map(stripDefiniteArticle));
  const maxSupporters = Math.max(0, Math.min(options?.maxSupporters ?? FLEET_MAX_SUPPORTERS, FLEET_MAX_SUPPORTERS));

  if (normalizedMessage.length === 0) {
    return { primary: getDefaultAgent(), supporters: [], confidence: 0, matched: [], routedBy: "fallback" };
  }

  // الأسطول الفعّال: الكتالوج ناقص وكلاء مُعطَّلين بأمر بيئي (والافتراضي باقٍ دائمًا).
  const fleet = effectiveFleet();
  const catalogIndex = new Map(fleet.map((agent, index) => [agent.id, index]));

  const scored = fleet
    .map((agent) => scoreAgent(agent, normalizedMessage, tokens))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        departmentRank(a.agent.department) - departmentRank(b.agent.department) ||
        (catalogIndex.get(a.agent.id) ?? 0) - (catalogIndex.get(b.agent.id) ?? 0)
    );

  const best = scored[0];
  if (!best) {
    return { primary: getDefaultAgent(), supporters: [], confidence: 0, matched: [], routedBy: "fallback" };
  }

  const primary = best.agent;
  const supporters = scored
    .slice(1)
    .filter((entry) => entry.score >= POLICY.supporterMin && !entry.agent.isDefault)
    .slice(0, maxSupporters)
    .map((entry) => entry.agent);

  return {
    primary,
    supporters,
    confidence: Math.min(1, best.score / POLICY.confidenceFull),
    matched: best.matched,
    routedBy: "keyword",
  };
}

/** الكلمات المطابقة للمساندين أيضًا — تُستخدم في السجل التدقيقي والاختبارات. */
export function selectionSummary(selection: AgentSelection): string {
  const ids = [selection.primary.id, ...selection.supporters.map((a) => a.id)].join(",");
  return `${ids} (${selection.routedBy}, ثقة ${selection.confidence.toFixed(2)})`;
}
