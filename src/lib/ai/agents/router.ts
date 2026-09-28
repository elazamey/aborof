import { AGENT_FLEET, agentKeywords, getDefaultAgent } from "./catalog";
import { normalizeForMatch, normalizedTokens } from "./normalize";
import type { AgentSelection, StoreAgent } from "./types";

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
 */

export const FLEET_MAX_SUPPORTERS = 2;
const POLICY = {
  phraseBase: 2,
  tokenExact: 1.5,
  tokenInside: 1,
  nameWord: 0.75,
  /** أدنى درجة لدخول وكيل كمساند. */
  supporterMin: 1.5,
  /** درجة تُعتبر ثقة كاملة (1.0) عند المراقبة. */
  confidenceFull: 4,
} as const;

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
  const tokens = new Set(normalizedTokens(message));
  const maxSupporters = Math.max(0, Math.min(options?.maxSupporters ?? FLEET_MAX_SUPPORTERS, FLEET_MAX_SUPPORTERS));

  if (normalizedMessage.length === 0) {
    return { primary: getDefaultAgent(), supporters: [], confidence: 0, matched: [], routedBy: "fallback" };
  }

  const scored = AGENT_FLEET.map((agent) => scoreAgent(agent, normalizedMessage, tokens))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score - a.score) || a.agent.id.localeCompare(b.agent.id));

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
