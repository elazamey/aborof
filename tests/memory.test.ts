import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildKnowledgeBase,
  expandQuery,
  getKnowledgeBase,
  invalidateKnowledgeBase,
  isRagEnabled,
  lightStem,
  memoryLimits,
  normalizeArabic,
  queryTokens,
  ragPolicySnapshot,
  resolveEngineName,
  resolveMemoryEngine,
  searchKnowledge,
} from "../src/lib/ai/memory";
import { KeywordMemoryEngine } from "../src/lib/ai/memory/engines/keyword";

/**
 * حراسة ذاكرة المتجر (RAG — المرحلة الأولى):
 *  1) التطبيع والمرادفات: «مطهر» يجب أن يصل إلى ديتول/كلوركس.
 *  2) الحدود المركزية: top-k، الحد الأدنى للدرجة، سقف المستندات.
 *  3) العلم: التعطيل = صفر قراءة وصفر نتيجة.
 *  4) العقد قابل للتبديل: محرك غير متاح يسقط بأمان للنصي.
 */

const KEYS = [
  "ENABLE_RAG",
  "RAG_ENGINE",
  "RAG_TOP_K",
  "RAG_MIN_SCORE",
  "RAG_MAX_DOCUMENTS",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
] as const;

function resetEnv() {
  for (const key of KEYS) delete process.env[key];
}

beforeEach(() => {
  resetEnv();
  invalidateKnowledgeBase();
});
afterEach(resetEnv);

describe("arabic normalization", () => {
  test("unifies hamza, ya, ta marbuta, diacritics and arabic-indic digits", () => {
    assert.equal(normalizeArabic("أرضيّاتٌ رُخام"), "ارضيات رخام");
    assert.equal(normalizeArabic("مُطهِّر"), "مطهر");
    assert.equal(normalizeArabic("على"), "علي");
    assert.equal(normalizeArabic("منظّفـة"), "منظفه");
    assert.equal(normalizeArabic("سعر ١٨٠ جنيه"), "سعر 180 جنيه");
    assert.equal(normalizeArabic("  مسافات   متعددة  "), "مسافات متعدده");
  });

  test("light stemmer only trims safe prefixes and suffixes", () => {
    assert.equal(lightStem("المنظفات"), "منظف");
    assert.equal(lightStem("منظف"), "منظف");
    assert.equal(lightStem("كلوركس"), "كلوركس");
    // الكلمات القصيرة لا تُقشَّر حتى لا تفقد معناها.
    assert.equal(lightStem("ملح"), "ملح");
  });

  test("drops stopwords and duplicates from query tokens", () => {
    // «عايز/من/فضلك» كلمات توقف، و«للمنظف» تُقشَّر إلى جذرها، ولا تكرار.
    const tokens = queryTokens("عايز من فضلك منظف أرضيات للمنظف");
    assert.ok(!tokens.includes("عايز") && !tokens.includes("فضلك"));
    assert.equal(new Set(tokens).size, tokens.length, "لا تكرار في المصطلحات");
    assert.ok(tokens.includes("منظف"));
    // الجذر «ارض» يطابق «أرضيات» في المستندات بمطابقة البداية.
    assert.ok(tokens.some((t) => "ارضيات".startsWith(t) || t.startsWith("ارض")));
    assert.deepEqual(queryTokens("هو ايه ده"), []);
  });

  test("expands the query with synonyms and marks them", () => {
    const terms = expandQuery("مطهر");
    const values = terms.map((t) => t.term);
    assert.ok(values.includes("ديتول"), "المرادف ديتول يجب أن يُضاف");
    assert.ok(values.includes("كلوركس"));
    assert.ok(values.includes("مطهر"));
    assert.equal(terms.find((t) => t.term === "مطهر")?.synonym, false);
    assert.equal(terms.find((t) => t.term === "ديتول")?.synonym, true);
  });
});

describe("knowledge base corpus", () => {
  test("is built from the catalog, faq and store info — and holds no customer data", async () => {
    const documents = await buildKnowledgeBase();
    const kinds = new Set(documents.map((d) => d.kind));
    assert.ok(kinds.has("product"));
    assert.ok(kinds.has("faq"));
    assert.ok(kinds.has("store"));

    const serialized = JSON.stringify(documents);
    assert.ok(!/order|طلب رقم|ORD-/.test(serialized), "لا سجل طلبات في الذاكرة");

    for (const document of documents) {
      for (const key of Object.keys(document.metadata)) {
        assert.ok(
          ["id", "name", "price", "old_price", "category", "image", "stock", "phone", "whatsapp"].includes(key),
          `حقل غير متوقع في الذاكرة: ${key}`
        );
      }
    }
  });

  test("cached reads return the same corpus until invalidated", async () => {
    const first = await getKnowledgeBase();
    const second = await getKnowledgeBase();
    assert.equal(first, second);
    invalidateKnowledgeBase();
    const third = await getKnowledgeBase();
    assert.notEqual(first, third);
  });
});

describe("keyword engine retrieval", () => {
  test("finds products by synonyms that never appear literally in the query", async () => {
    process.env.ENABLE_RAG = "true";
    const result = await searchKnowledge("عايز حاجة للتعقيم");
    assert.ok(result.hit_count > 0, "يجب أن يعيد نتائج");
    assert.equal(result.engine, "keyword");
    const titles = result.hits.map((h) => h.title).join(" | ");
    assert.match(titles, /كلوركس|مطهر|مبيض|مطهّر/i, `نتائج غير متوقعة: ${titles}`);
  });

  test("prefers the exact product name at the top of results", async () => {
    process.env.ENABLE_RAG = "true";
    const result = await searchKnowledge("سائل غسيل أطباق ليمون");
    assert.ok(result.hit_count > 0);
    assert.match(result.hits[0].title, /أطباق|اطباق|ليمون/);
    assert.equal(result.hits[0].kind, "product");
  });

  test("answers store policy questions from the store document", async () => {
    process.env.ENABLE_RAG = "true";
    const result = await searchKnowledge("الشحن بكام وفيه شحن مجاني؟");
    assert.ok(result.hit_count > 0);
    assert.ok(result.hits.some((h) => h.kind === "store" || h.kind === "faq"));
    assert.match(result.hits.map((h) => h.body).join(" "), /شحن/);
  });

  test("answers discount offers questions from the store document", async () => {
    process.env.ENABLE_RAG = "true";
    const result = await searchKnowledge("عندكم عروض وخصومات؟");
    assert.ok(result.hit_count > 0, "يجب أن تعرف الذاكرة سياسة العروض");
    assert.match(result.hits.map((h) => h.body).join(" "), /العروض|خصم/);
  });

  test("returns nothing for an unrelated query instead of guessing", async () => {
    process.env.ENABLE_RAG = "true";
    const result = await searchKnowledge("طقس بكين النهاردة");
    assert.equal(result.hit_count, 0);
  });

  test("kind filter narrows the search", async () => {
    process.env.ENABLE_RAG = "true";
    const result = await searchKnowledge("الشحن والدفع", { kinds: ["faq"] });
    assert.ok(result.hits.every((h) => h.kind === "faq"));
  });

  test("top-k is clamped to the central policy", async () => {
    process.env.ENABLE_RAG = "true";
    process.env.RAG_TOP_K = "2";
    const result = await searchKnowledge("منظف");
    assert.ok(result.hit_count <= 2);

    process.env.RAG_TOP_K = "9999";
    const clamped = memoryLimits();
    assert.equal(clamped.topK, 5, "لا يمكن توسيع السقف من البيئة");
  });

  test("min score suppresses weak matches", async () => {
    process.env.ENABLE_RAG = "true";
    process.env.RAG_MIN_SCORE = "50";
    const result = await searchKnowledge("منظف");
    assert.equal(result.hit_count, 0, "الحد الأعلى للدرجة يمنع النتائج الضعيفة");
  });

  test("engine contract: results are deterministic across runs", async () => {
    process.env.ENABLE_RAG = "true";
    const first = await searchKnowledge("منظف أرضيات");
    invalidateKnowledgeBase();
    const second = await searchKnowledge("منظف أرضيات");
    assert.deepEqual(
      first.hits.map((h) => h.id),
      second.hits.map((h) => h.id)
    );
  });
});

describe("flag and engine swap safety", () => {
  test("disabled by default — zero retrieval, zero work", async () => {
    assert.equal(isRagEnabled(), false);
    const result = await searchKnowledge("منظف أرضيات");
    assert.equal(result.hit_count, 0);
    assert.equal(result.corpus_size, 0);
    assert.deepEqual(result.hits, []);
  });

  test("unknown or not-yet-implemented engines fall back to keyword", () => {
    process.env.RAG_ENGINE = "embeddings";
    assert.equal(resolveEngineName(), "embeddings");
    assert.equal(resolveMemoryEngine().name, "keyword", "المحرك غير المتاح يسقط للنصي");

    process.env.RAG_ENGINE = "sqlite-fts5";
    assert.equal(resolveEngineName(), "keyword", "قيمة غير معلنة تسقط للنصي");

    assert.equal(new KeywordMemoryEngine().isAvailable(), true);
  });

  test("policy snapshot exposes only safe, clamped values", () => {
    process.env.ENABLE_RAG = "true";
    process.env.RAG_TOP_K = "-5";
    process.env.RAG_MAX_DOCUMENTS = "999999";
    const snapshot = ragPolicySnapshot();
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.top_k, 1);
    assert.equal(snapshot.max_documents, 2_000);
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "enabled",
      "engine",
      "max_documents",
      "min_score",
      "top_k",
    ]);
  });
});
