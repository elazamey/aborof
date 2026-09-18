import { expandQuery, lightStem, normalizeArabic } from "../normalize";
import type { MemoryDocument, MemoryEngine, MemoryHit, MemoryLimits, MemoryQuery } from "../types";

/**
 * المحرك النصي (Keyword/FTS-like) — المحرك الافتراضي للمرحلة الأولى.
 *
 * لماذا نصي أولًا؟ لأنه: بلا مفاتيح، بلا كلفة، بلا حصة استهلاك، يعمل على
 * Turso أو بكتالوج البذرة، وحتمي بالكامل (نفس المدخل = نفس الترتيب).
 *
 * الترتيب: BM25 مبسّط — وزن الحقل (العنوان > الكلمات المفتاحية > النص)
 * مضروبًا في ندرة المصطلح داخل الذاكرة، مع ترجيح أعلى لما ورد في نص
 * المستخدم نفسه، ومكافأة تغطية كل المصطلحات.
 */

const FIELD_WEIGHTS = { title: 3.2, keywords: 2.4, body: 1 } as const;
const SYNONYM_DISCOUNT = 0.55;
const COVERAGE_BONUS = 1.25;

interface PreparedDocument {
  document: MemoryDocument;
  title: string;
  keywords: string;
  body: string;
}

/** يجهّز المستندات مرة واحدة لكل بحث (تطبيع الكلمات المفتاحية والحقول). */
function prepare(documents: readonly MemoryDocument[]): PreparedDocument[] {
  return documents.map((document) => ({
    document,
    title: document.kind === "product" ? normalizeArabic(document.title) : document.title,
    keywords: normalizeArabic(document.keywords.join(" ")),
    body: document.body,
  }));
}

function hits(term: string, field: string): number {
  if (!field || !term) return 0;
  let count = 0;
  let index = field.indexOf(term);
  while (index !== -1 && count < 6) {
    // مطابقة على حدود الكلمة أو بدايتها مع تقشير خفيف للصيغ الطويلة.
    const before = index === 0 ? " " : field[index - 1];
    const inside = /[\p{L}\p{N}]/u.test(before);
    if (!inside || lightStem(field.slice(Math.max(0, index - 3), index + term.length)).includes(term)) {
      count += 1;
    }
    index = field.indexOf(term, index + term.length);
  }
  return count;
}

/** ندرة المصطلح: كلما ظهر في مستندات أقل زاد وزنه. */
function idf(term: string, docs: readonly PreparedDocument[]): number {
  let seen = 0;
  for (const doc of docs) {
    if (doc.title.includes(term) || doc.keywords.includes(term) || doc.body.includes(term)) seen += 1;
  }
  return Math.log(1 + (docs.length + 1) / (seen + 1));
}

export class KeywordMemoryEngine implements MemoryEngine {
  readonly name = "keyword";
  readonly kind = "keyword" as const;

  isAvailable(): boolean {
    return true;
  }

  async search(
    documents: readonly MemoryDocument[],
    query: MemoryQuery,
    limits: MemoryLimits
  ): Promise<MemoryHit[]> {
    const text = String(query.text ?? "").trim();
    if (!text) return [];

    const terms = expandQuery(text);
    if (terms.length === 0) return [];

    const kinds = query.kinds && query.kinds.length > 0 ? new Set(query.kinds) : null;
    const prepared = prepare(
      documents.filter((document) => !kinds || kinds.has(document.kind)).slice(0, limits.maxDocuments)
    );
    const topK = Math.max(1, Math.min(query.topK ?? limits.topK, limits.topK));

    const scored: MemoryHit[] = [];
    for (const doc of prepared) {
      let score = 0;
      const matched: string[] = [];
      let matchedTerms = 0;
      const totalTerms = terms.filter((t) => !t.synonym).length || terms.length;

      for (const { term, synonym } of terms) {
        const weight = synonym ? SYNONYM_DISCOUNT : 1;
        const termScore =
          hits(term, doc.title) * FIELD_WEIGHTS.title +
          hits(term, doc.keywords) * FIELD_WEIGHTS.keywords +
          hits(term, doc.body) * FIELD_WEIGHTS.body;
        if (termScore > 0) {
          if (!synonym) matchedTerms += 1;
          if (matched.length < 5) matched.push(term);
          score += termScore * weight * idf(term, prepared);
        }
      }

      if (score <= 0) continue;
      if (matchedTerms >= totalTerms && totalTerms > 1) score *= COVERAGE_BONUS;
      // ظهور نص المستخدم كاملًا في العنوان مكافأة صريحة (بحث مباشر عن اسم منتج).
      const normalizedQuery = normalizeArabic(text);
      if (doc.title.includes(normalizedQuery)) score += FIELD_WEIGHTS.title * 2;

      scored.push({ document: doc.document, score: Math.round(score * 100) / 100, matched });
    }

    return scored
      .filter((hit) => hit.score >= limits.minScore)
      .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))
      .slice(0, topK);
  }
}
