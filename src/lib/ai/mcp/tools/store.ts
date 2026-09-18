import { z } from "zod";
import { getFaq, getProducts } from "@/lib/db";
import { STORE } from "@/lib/seed";
import { GOVERNORATES, SHIPPING_RATES, calculateShipping } from "@/lib/shipping";
import type { McpTool, McpToolPolicy } from "../types";

/**
 * أدوات المتجر للقراءة فقط — أول مجموعة مسجّلة في طبقة MCP المحكومة.
 *
 * قواعد ثابتة:
 *  - لا أداة تلمس بيانات العملاء أو الطلبات (لا هاتف ولا عنوان ولا سجل طلبات)،
 *    فلا يمكن للموديل أن يسحب بيانات شخصية حتى لو حاول.
 *  - المخرجات مشتقة من نفس قراءات التطبيق (`getProducts`/`getFaq`/`SHIPPING_RATES`)
 *    فلا يوجد مصدر بيانات ثانٍ يمكن أن ينحرف عن المتجر.
 *  - الجداول مقتصرة وصغيرة: الموديل يقرأ ملخصًا لا قاعدة البيانات.
 */

/** سياسة موحدة للأدوات: قراءة فقط، والحدود الفعلية تفرضها الطبقة المركزية. */
const READ_ONLY: McpToolPolicy = {
  readOnly: true,
  timeoutMs: 4_000,
  maxResultChars: 4_000,
};

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2);
}

function score(query: string, haystack: string): number {
  const target = haystack.toLowerCase();
  return words(query).reduce((n, w) => n + (target.includes(w) ? 1 : 0), 0);
}

function clip(text: string, max: number): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

function money(value: number): string {
  return `${Number(value)} جنيه`;
}

/* ------------------------------- search_products ------------------------------ */

const searchSchema = z
  .object({
    query: z.string().trim().min(1, "كلمة البحث مطلوبة").max(120),
    max_results: z.coerce.number().int().min(1).max(5).optional(),
  })
  .strict();

export const searchProductsTool: McpTool = {
  definition: {
    name: "search_products",
    description:
      "يبحث في منتجات المتجر المتاحة ويعيد الاسم والسعر والقسم والمخزون. استخدمه لأي سؤال عن منتج أو سعر أو ترشيح.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "كلمات البحث أو وصف الحاجة (مثال: منظف أرضيات لافندر)" },
        max_results: { type: "integer", minimum: 1, maximum: 5, description: "عدد النتائج (افتراضي 3)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  policy: READ_ONLY,
  validate: (raw) => {
    const parsed = searchSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message ?? "وسائط غير صالحة" };
    }
    return { ok: true, value: parsed.data };
  },
  async run(value) {
    const { query, max_results } = value as { query: string; max_results?: number };
    const limit = max_results ?? 3;
    const products = await getProducts();
    const hits = products
      .map((p) => ({ p, s: score(query, `${p.name} ${p.category} ${p.description}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.p.name.localeCompare(b.p.name))
      .slice(0, limit);

    if (hits.length === 0) {
      return "لا يوجد منتج مطابق في المتجر. اقترح على العميل التواصل على واتساب أو وصف حاجة أخرى.";
    }

    const lines = hits.map(({ p }) => {
      const availability = Number(p.stock) > 0 ? `متاح: ${Number(p.stock)}` : "غير متوفر حاليًا";
      const old = p.old_price ? ` (بدل ${money(Number(p.old_price))})` : "";
      return `• ${clip(p.name, 90)} — ${money(Number(p.price))}${old} — القسم: ${clip(p.category, 40)} — ${availability}\n  ${clip(p.description, 120)}`;
    });

    return {
      text: `نتائج البحث (${hits.length}):\n${lines.join("\n")}`,
      // محتوى منظّم للواجهة: حقول الكتالوج فقط، بلا أي بيانات عميل وبلا وصف كامل،
      // وبحد أقصى 5 عناصر — فمن يستقبل هذا المحتوى لا يستطيع توسيعه.
      structured: {
        kind: "products",
        products: hits.map(({ p }) => ({
          id: String(p.id),
          name: clip(p.name, 90),
          price: Number(p.price),
          old_price: p.old_price == null ? null : Number(p.old_price),
          category: clip(p.category, 40),
          image: clip(p.image, 8),
          stock: Number(p.stock),
        })),
      },
    };
  },
};

/* -------------------------------- lookup_faq -------------------------------- */

const faqSchema = z.object({ query: z.string().trim().min(1, "كلمة البحث مطلوبة").max(120) }).strict();

export const faqTool: McpTool = {
  definition: {
    name: "lookup_faq",
    description:
      "يبحث في الأسئلة الشائعة للمتجر (الدفع، الشحن، المواعيد، الاستبدال، الجملة) ويعيد أكثر إجابة مطابقة.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "سؤال العميل أو كلماته المفتاحية" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  policy: READ_ONLY,
  validate: (raw) => {
    const parsed = faqSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message ?? "وسائط غير صالحة" };
    }
    return { ok: true, value: parsed.data };
  },
  async run(value) {
    const { query } = value as { query: string };
    const faq = await getFaq();
    const hits = faq
      .map((f) => ({ f, s: score(query, `${f.question} ${f.answer}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2);

    if (hits.length === 0) return "لا يوجد سؤال شائع مطابق.";
    return hits.map(({ f }) => `س: ${clip(f.question, 120)}\nج: ${clip(f.answer, 300)}`).join("\n\n");
  },
};

/* ---------------------------- shipping_estimate ----------------------------- */

const shippingSchema = z
  .object({
    governorate: z.string().trim().min(2, "المحافظة مطلوبة").max(60),
    subtotal: z.coerce.number().finite().min(0).max(1_000_000),
  })
  .strict();

export const shippingTool: McpTool = {
  definition: {
    name: "shipping_estimate",
    description:
      "يحسب تكلفة الشحن لمحافظة معينة ومجموع سلة، ويوضح حد الشحن المجاني. استخدمه لسؤال «الشحن كام؟».",
    inputSchema: {
      type: "object",
      properties: {
        governorate: { type: "string", description: "اسم المحافظة بالعربية (مثال: القاهرة)" },
        subtotal: { type: "number", minimum: 0, description: "مجموع السلة بالجنيه قبل الشحن" },
      },
      required: ["governorate", "subtotal"],
      additionalProperties: false,
    },
  },
  policy: READ_ONLY,
  validate: (raw) => {
    const parsed = shippingSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message ?? "وسائط غير صالحة" };
    }
    return { ok: true, value: parsed.data };
  },
  async run(value) {
    const { governorate, subtotal } = value as { governorate: string; subtotal: number };
    const known = GOVERNORATES.includes(governorate);
    const cost = known
      ? calculateShipping(governorate, subtotal, STORE.freeShippingOver)
      : calculateShipping("غير معروف", subtotal, STORE.freeShippingOver);

    const freeShipping = subtotal >= STORE.freeShippingOver;
    return [
      `المحافظة: ${clip(governorate, 40)}${known ? "" : " (غير مدرجة — تقدير افتراضي)"}`,
      `مجموع السلة: ${money(subtotal)}`,
      `تكلفة الشحن: ${cost === 0 ? "مجاني" : money(cost)}`,
      `الشحن المجاني يبدأ من: ${money(STORE.freeShippingOver)}`,
      freeShipping ? "السلة الحالية مؤهلة للشحن المجاني." : `تبقّى ${money(STORE.freeShippingOver - subtotal)} للشحن المجاني.`,
      `جدول أسعار المحافظات المدرجة: ${GOVERNORATES.map((g) => `${g}=${SHIPPING_RATES[g]}`).join(", ")}`,
    ].join("\n");
  },
};

/* --------------------------------- store_info -------------------------------- */

const storeInfoSchema = z.object({}).strict();

export const storeInfoTool: McpTool = {
  definition: {
    name: "store_info",
    description:
      "يعيد بيانات المتجر الثابتة: الاسم، الهاتف/واتساب، رقم فودافون كاش، سياسة الشحن والدفع الأساسية.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  policy: READ_ONLY,
  validate: (raw) => {
    const parsed = storeInfoSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message ?? "وسائط غير صالحة" };
    }
    return { ok: true, value: parsed.data };
  },
  async run() {
    return [
      `الاسم: ${STORE.name} — ${STORE.tagline}`,
      `الهاتف/واتساب: ${STORE.phone}`,
      `فودافون كاش: ${STORE.vodafoneCash}`,
      `الشحن: ${money(STORE.shipping)}، ومجاني فوق ${money(STORE.freeShippingOver)}`,
      "الدفع: فودافون كاش أو عند الاستلام.",
    ].join("\n");
  },
};

/** المجموعة الافتراضية المسجّلة — كلها قراءة فقط. */
export const STORE_TOOLS: readonly McpTool[] = [
  searchProductsTool,
  faqTool,
  shippingTool,
  storeInfoTool,
];
