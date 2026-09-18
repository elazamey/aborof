import { z } from "zod";
import { isRagEnabled, searchKnowledge } from "@/lib/ai/memory";
import type { McpTool, McpToolPolicy } from "../types";

/**
 * أداة ذاكرة المتجر (RAG) — قراءة فقط، وتعمل بلا أي مفاتيح خارجية.
 *
 *  - مسجّلة في نفس طبقة MCP المحكومة، فترث تلقائيًا كل البوابات: علم الطبقة،
 *    قائمة السماح، سقف الاستدعاءات، تحقق الوسائط، المهلة، اقتصاص المخرجات،
 *    والتدقيق — بلا مسار تنفيذ جديد ولا سطح هجوم جديد.
 *  - بوابة إضافية خاصة بها: `ENABLE_RAG`؛ فحتى مع تفعيل الطبقة تبقى الأداة
 *    غير مرئية وغير قابلة للتنفيذ إن لم تُفعَّل الذاكرة (fail-closed).
 *  - تفهم المرادفات العربية (مطهر → ديتول/كلوركس) لأن المحرك يوسّع الاستعلام
 *    من فهرس المرادفات المركزي.
 */

const READ_ONLY: McpToolPolicy = {
  readOnly: true,
  timeoutMs: 4_000,
  maxResultChars: 4_000,
};

const searchSchema = z
  .object({
    query: z.string().trim().min(2, "نص البحث قصير جدًا").max(200),
    top_k: z.coerce.number().int().min(1).max(5).optional(),
    kind: z.enum(["product", "faq", "store"]).optional(),
  })
  .strict();

export const searchKnowledgeTool: McpTool = {
  definition: {
    name: "search_knowledge",
    description:
      "يبحث في ذاكرة المتجر: المنتجات والأسئلة الشائعة وبيانات المتجر (الشحن والدفع والاستبدال)، ويفهم المرادفات العامية (مطهر = ديتول/كلوركس، تعقيم، أرضيات = سيراميك/رخام). استخدمه قبل أي إجابة عن السعر أو التوفر أو السياسات.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "سؤال العميل أو كلماته المفتاحية (مثال: حاجة للتعقيم، الشحن كام، منظف أرضيات)",
        },
        top_k: { type: "integer", minimum: 1, maximum: 5, description: "عدد النتائج (افتراضي 3)" },
        kind: {
          type: "string",
          enum: ["product", "faq", "store"],
          description: "تضييق البحث على نوع واحد من المعرفة عند الحاجة",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  policy: READ_ONLY,
  // بوابة العلم الخاصة بالذاكرة — تُقرأ عند كل نداء لا عند التسجيل.
  isEnabled: () => isRagEnabled(),
  validate: (raw) => {
    const parsed = searchSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message ?? "وسائط غير صالحة" };
    }
    return { ok: true, value: parsed.data };
  },
  async run(value) {
    const { query, top_k, kind } = value as { query: string; top_k?: number; kind?: string };
    const result = await searchKnowledge(query, {
      topK: top_k,
      kinds: kind ? [kind as "product" | "faq" | "store"] : undefined,
    });

    if (result.hit_count === 0) {
      return {
        text: "لا توجد معلومة مطابقة في ذاكرة المتجر. اطلب من العميل وصفًا أوضح أو حوّله واتساب.",
        structured: { kind: "knowledge", engine: result.engine, hits: 0 },
      };
    }

    const lines = result.hits.map((hit) => {
      const label = hit.kind === "product" ? "منتج" : hit.kind === "faq" ? "سؤال شائع" : "معلومة متجر";
      return `[${label}] ${hit.title}\n${clip(hit.body, hit.kind === "product" ? 200 : 400)}`;
    });

    // المنتجات وحدها تُعاد كبطاقات واجهة — بنفس عقد `search_products` تمامًا،
    // فتظهر البطاقات بزر «أضف للسلة» بلا أي كود إضافي في الواجهة.
    const products = result.hits
      .filter((hit) => hit.kind === "product")
      .map((hit) => ({
        id: String(hit.metadata.id ?? ""),
        name: String(hit.metadata.name ?? hit.title),
        price: Number(hit.metadata.price ?? 0),
        old_price: hit.metadata.old_price == null ? null : Number(hit.metadata.old_price),
        category: String(hit.metadata.category ?? ""),
        image: String(hit.metadata.image ?? "🧴"),
        stock: Number(hit.metadata.stock ?? 0),
      }))
      .filter((card) => card.id !== "");

    return {
      text: `ذاكرة المتجر (${result.hit_count} نتيجة · المحرك: ${result.engine}):\n${lines.join("\n\n")}`,
      structured:
        products.length > 0
          ? { kind: "products", products }
          : { kind: "knowledge", engine: result.engine, hits: result.hit_count },
    };
  },
};

function clip(text: string, max: number): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}
