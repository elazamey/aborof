/**
 * عقد ذاكرة المتجر (RAG) — المرحلة الأولى: استرجاع نصي بلا مفاتيح.
 *
 * الفكرة الحاكمة: **العقد ثابت والمحرك قابل للتبديل.** أي محرك يستوفي
 * `MemoryEngine` يعمل بلا تغيير في أي كود أعلى منه، فتبديل المحرك النصي
 * بمحرك متجهات (embeddings عبر Gemini/NIM) أو بـ FTS5 في Turso لاحقًا
 * يكون تغييرًا في ملف واحد + متغير بيئة، لا في التطبيق.
 */

export type MemoryDocumentKind = "product" | "faq" | "store";

/** مستند واحد في الذاكرة — بيانات فقط، بلا أي بيانات عميل. */
export interface MemoryDocument {
  id: string;
  kind: MemoryDocumentKind;
  title: string;
  body: string;
  /** كلمات مفتاحية إضافية تُثقل في الترتيب (قسم المنتج، مرادفاته…). */
  keywords: string[];
  /** حقول الواجهة المسموح تمريرها (سعر، صورة، مخزون…) بلا أي بيانات شخصية. */
  metadata: Record<string, string | number | null>;
}

export interface MemoryQuery {
  text: string;
  topK?: number;
  kinds?: MemoryDocumentKind[];
}

export interface MemoryHit {
  document: MemoryDocument;
  score: number;
  /** أعلى المصطلحات المطابقة — للشفافية في السجلات وللتشخيص فقط. */
  matched: string[];
}

/** الحدود المركزية المفروضة على أي محرك — لا يستطيع محرك توسيعها. */
export interface MemoryLimits {
  topK: number;
  minScore: number;
  maxDocuments: number;
}

/**
 * محرك الاسترجاع. واجهة غير متزامنة عن قصد: المحرك النصي يُجيب فورًا، لكن
 * محرك المتجهات مستقبلًا سيحتاج نداء شبكة — والعقد نفسه يستوعبه بلا تغيير.
 */
export interface MemoryEngine {
  readonly name: string;
  readonly kind: "keyword" | "vector" | "remote";
  /** هل المحرك جاهز الآن (مفاتيح/خدمة)؟ غير الجاهز يُستبعد قبل الاستدعاء. */
  isAvailable(): boolean;
  search(
    documents: readonly MemoryDocument[],
    query: MemoryQuery,
    limits: MemoryLimits
  ): Promise<MemoryHit[]>;
}

export interface KnowledgeHit {
  id: string;
  kind: MemoryDocumentKind;
  title: string;
  body: string;
  score: number;
  metadata: Record<string, string | number | null>;
}

export interface KnowledgeSearchResult {
  /** اسم المحرك الذي أجاب فعلًا (للمراقبة والشفافية). */
  engine: string;
  query: string;
  hit_count: number;
  corpus_size: number;
  hits: KnowledgeHit[];
}
