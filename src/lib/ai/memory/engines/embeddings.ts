import type { MemoryDocument, MemoryEngine, MemoryHit, MemoryLimits, MemoryQuery } from "../types";

/**
 * محرك المتجهات (embeddings) — **غير مُنفَّذ بعد، ومعلن كذلك صراحة**.
 *
 * هذه ليست حزمة ناقصة: هذا عقد مكتمل يعلن نفسه `isAvailable() === false`
 * حتى تُضاف مرحلة المتجهات بقرار مستقل. الفائدة أن تبديل المحرك لاحقًا لن
 * يمس أي كود في التطبيق — فقط هذا الملف ومتغير `RAG_ENGINE`.
 *
 * خطة التنفيذ المعتمدة عند التبديل:
 *  1) تضمين المستندات مرة واحدة عبر مزود موجود أصلًا (Gemini/NVIDIA NIM)
 *     وحفظ المتجهات في Turso (جدول memory_embeddings) بهجرة مُرقّمة.
 *  2) تضمين الاستعلام عند كل بحث، ثم ترتيب بالتشابه الجيبي (cosine).
 *  3) دمج النتيجتين: النصي للدقة الحرفية والمتجهات للمرادفات البعيدة،
 *     بوزن صريح وقابل للقياس عبر مجموعة تقييم صغيرة (hit@3).
 *  4) أي فشل في التضمين يُسقط للمحرك النصي المتاح دائمًا بلا تعطيل الخدمة.
 */
export class EmbeddingsMemoryEngine implements MemoryEngine {
  readonly name = "embeddings";
  readonly kind = "vector" as const;

  isAvailable(): boolean {
    // معلَّق عن قصد: يُفتح في مرحلة المتجهات بعد إضافة الهجرة والمفاتيح.
    return false;
  }

  async search(
    _documents: readonly MemoryDocument[],
    _query: MemoryQuery,
    _limits: MemoryLimits
  ): Promise<MemoryHit[]> {
    throw new Error("embeddings engine is not implemented yet");
  }
}
