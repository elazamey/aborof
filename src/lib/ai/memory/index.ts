/**
 * الواجهة العامة لذاكرة المتجر (RAG) — المرحلة الأولى: استرجاع نصي بلا مفاتيح.
 *
 * الاستخدام الوحيد المسموح من خارج الوحدة:
 *   const result = await searchKnowledge("عايز حاجة تعقيم");
 *
 * المحرك الداخلي قابل للتبديل بمتغير `RAG_ENGINE` بلا أي تغيير في المستدعي،
 * وكل الحدود تُفرض مركزيًا من `policy.ts` لا من المحرك.
 */
import { getKnowledgeBase } from "./corpus";
import { EmbeddingsMemoryEngine } from "./engines/embeddings";
import { KeywordMemoryEngine } from "./engines/keyword";
import { isRagEnabled, memoryLimits, resolveEngineName } from "./policy";
import type {
  KnowledgeHit,
  KnowledgeSearchResult,
  MemoryEngine,
  MemoryLimits,
  MemoryQuery,
} from "./types";

export { buildKnowledgeBase, getKnowledgeBase, invalidateKnowledgeBase } from "./corpus";
export {
  MEMORY_ENGINES,
  RAG_POLICY_LIMITS,
  isRagEnabled,
  memoryLimits,
  ragPolicySnapshot,
  resolveEngineName,
} from "./policy";
export type { MemoryEngineName, RagPolicySnapshot } from "./policy";
export {
  expandQuery,
  lightStem,
  normalizeArabic,
  queryTokens,
  SYNONYM_GROUPS,
} from "./normalize";
export { EmbeddingsMemoryEngine } from "./engines/embeddings";
export { KeywordMemoryEngine } from "./engines/keyword";
export type {
  KnowledgeHit,
  KnowledgeSearchResult,
  MemoryDocument,
  MemoryDocumentKind,
  MemoryEngine,
  MemoryHit,
  MemoryLimits,
  MemoryQuery,
} from "./types";

/** محركات متاحة بالاسم — إضافة محرك جديد سطر واحد هنا. */
const ENGINES: Record<string, MemoryEngine> = {
  keyword: new KeywordMemoryEngine(),
  embeddings: new EmbeddingsMemoryEngine(),
};

/**
 * يحل المحرك المطلوب مع سلسلة أمان: المطلوب إن كان متاحًا، وإلا النصي،
 * وإلا أي محرك متاح — فلا يوجد مسار يرمي بسبب إعداد.
 */
export function resolveMemoryEngine(name: string = resolveEngineName()): MemoryEngine {
  const requested = ENGINES[name];
  if (requested?.isAvailable()) return requested;
  const fallback = ENGINES.keyword;
  if (fallback.isAvailable()) return fallback;
  const any = Object.values(ENGINES).find((engine) => engine.isAvailable());
  if (any) return any;
  throw new Error("memory: لا يوجد محرك استرجاع متاح");
}

export interface SearchKnowledgeOptions {
  topK?: number;
  kinds?: MemoryQuery["kinds"];
  limits?: Partial<MemoryLimits>;
  /** تجاوز حالة التعطيل — للاختبارات والتشخيص فقط. */
  ignoreFlag?: boolean;
}

/**
 * البحث في ذاكرة المتجر. عندما يكون `ENABLE_RAG` غير مفعّل تُعاد نتيجة
 * فارغة بلا أي قراءة للذاكرة ولا أي عمل — نفس مبدأ الأعلام في المشروع.
 */
export async function searchKnowledge(
  text: string,
  options: SearchKnowledgeOptions = {}
): Promise<KnowledgeSearchResult> {
  const query = String(text ?? "");
  const limits = memoryLimits(options.limits ?? {});
  const engineName = resolveEngineName();

  if (!options.ignoreFlag && !isRagEnabled()) {
    return { engine: engineName, query, hit_count: 0, corpus_size: 0, hits: [] };
  }

  const documents = await getKnowledgeBase();
  const engine = resolveMemoryEngine(engineName);
  const hits = await engine.search(
    documents,
    { text: query, topK: options.topK, kinds: options.kinds },
    limits
  );

  return {
    engine: engine.name,
    query,
    hit_count: hits.length,
    corpus_size: documents.length,
    hits: hits.map(
      (hit): KnowledgeHit => ({
        id: hit.document.id,
        kind: hit.document.kind,
        // نصوص الذاكرة مطبَّعة (بلا تشكيل) لتصغير ما يُرسل للموديل؛ والعناوين
        // الأصلية للمنتجات محفوظة في `metadata.name` للعرض في الواجهة.
        title: hit.document.title,
        body: hit.document.body,
        score: hit.score,
        metadata: hit.document.metadata,
      })
    ),
  };
}
