import { clampInt, type NumericBounds } from "../mcp/policy";
import type { MemoryLimits } from "./types";

/**
 * سياسة ذاكرة المتجر — مصدر الحقيقة الوحيد لحدود الاسترجاع، بنفس منطق
 * طبقة MCP: القيم مقيّدة رياضيًا، والغياب يعني الافتراضي الآمن لا الصفر.
 */

export const RAG_POLICY_LIMITS = {
  /** عدد النتائج المعادة للموديل. */
  topK: { min: 1, max: 5, fallback: 3 },
  /** حد أدنى للدرجة حتى لا تُعاد نتائج غير ذات صلة إطلاقًا. */
  minScore: { min: 1, max: 50, fallback: 2 },
  /** سقف حجم الذاكرة الممسوحة — حماية من تضخم الكتالوج مستقبلًا. */
  maxDocuments: { min: 50, max: 2_000, fallback: 600 },
} as const satisfies Record<string, NumericBounds>;

/** أنواع المحركات المعلنة؛ أي قيمة أخرى تسقط إلى المحرك النصي (fail-safe). */
export const MEMORY_ENGINES = ["keyword", "embeddings", "remote"] as const;
export type MemoryEngineName = (typeof MEMORY_ENGINES)[number];

export function isRagEnabled(): boolean {
  return process.env.ENABLE_RAG === "true";
}

/**
 * اسم المحرك المطلوب. القيمة غير المعروفة أو غير المستقرة تُرجع المحرك
 * النصي المتاح دائمًا — لا فشل، ولا تعطيل للاسترجاع بسبب خطأ إعداد.
 */
export function resolveEngineName(raw: string | undefined = process.env.RAG_ENGINE): MemoryEngineName {
  const value = String(raw ?? "").trim().toLowerCase();
  if ((MEMORY_ENGINES as readonly string[]).includes(value)) return value as MemoryEngineName;
  return "keyword";
}

export function memoryLimits(overrides: Partial<MemoryLimits> = {}): MemoryLimits {
  return {
    topK: overrides.topK ?? clampInt(process.env.RAG_TOP_K, RAG_POLICY_LIMITS.topK),
    minScore: overrides.minScore ?? clampInt(process.env.RAG_MIN_SCORE, RAG_POLICY_LIMITS.minScore),
    maxDocuments:
      overrides.maxDocuments ?? clampInt(process.env.RAG_MAX_DOCUMENTS, RAG_POLICY_LIMITS.maxDocuments),
  };
}

export interface RagPolicySnapshot {
  enabled: boolean;
  engine: MemoryEngineName;
  top_k: number;
  min_score: number;
  max_documents: number;
}

/** لقطة سياسة للعرض في التشخيص — لا تحتوي أي سر. */
export function ragPolicySnapshot(): RagPolicySnapshot {
  return {
    enabled: isRagEnabled(),
    engine: resolveEngineName(),
    top_k: memoryLimits().topK,
    min_score: memoryLimits().minScore,
    max_documents: memoryLimits().maxDocuments,
  };
}
