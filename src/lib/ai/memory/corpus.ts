import { getFaq, getProducts } from "@/lib/db";
import { STORE } from "@/lib/seed";
import { normalizeDocumentText } from "./normalize";
import type { MemoryDocument } from "./types";

/**
 * بناء ذاكرة المتجر من نفس مصادر بيانات التطبيق (منتجات + أسئلة شائعة +
 * بيانات المتجر الثابتة)، فلا يوجد مصدر ثانٍ يمكن أن ينحرف عن المتجر.
 *
 * ملاحظة خصوصية: لا يدخل الذاكرة أي بيانات عميل — لا طلبات ولا هواتف ولا
 * عناوين. الذاكرة كتالوج ومعلومات متجر فقط.
 */

interface CacheEntry {
  documents: MemoryDocument[];
  builtAt: number;
}

const CACHE_TTL_MS = 30_000;
let cache: CacheEntry | null = null;

function productDocuments(products: Awaited<ReturnType<typeof getProducts>>): MemoryDocument[] {
  return products.map((product) => ({
    id: `product:${product.id}`,
    kind: "product",
    title: String(product.name),
    // القسم مكرر داخل النص ليرجّح البحث القسمي، والوصف الكامل يبقى في المتجر.
    body: `${product.description} — القسم: ${product.category}`,
    keywords: [String(product.category), product.featured ? "الأكثر مبيعا مميز" : ""].filter(Boolean),
    metadata: {
      id: String(product.id),
      name: String(product.name),
      price: Number(product.price),
      old_price: product.old_price == null ? null : Number(product.old_price),
      category: String(product.category),
      image: String(product.image ?? "🧴"),
      stock: Number(product.stock),
    },
  }));
}

function faqDocuments(faq: Awaited<ReturnType<typeof getFaq>>): MemoryDocument[] {
  return faq.map((entry, index) => ({
    id: `faq:${index + 1}`,
    kind: "faq",
    title: entry.question,
    body: entry.answer,
    keywords: ["سؤال شائع", "مساعدة", "استفسار"],
    metadata: {},
  }));
}

function storeDocument(): MemoryDocument {
  return {
    id: "store:info",
    kind: "store",
    title: `بيانات ${STORE.name} وطرق الدفع والشحن`,
    body: [
      `المتجر: ${STORE.name} ${STORE.tagline}`,
      `الدفع: فودافون كاش على ${STORE.vodafoneCash} أو الدفع عند الاستلام.`,
      `الشحن: ${STORE.shipping} جنيه، ومجاني للطلبات فوق ${STORE.freeShippingOver} جنيه.`,
      `التوصيل من 1 إلى 3 أيام عمل داخل القاهرة والجيزة، ومن 2 إلى 5 أيام لباقي المحافظات.`,
      `الطلب: إضافة المنتجات للسلة وإتمام الطلب، أو التواصل واتساب على ${STORE.phone}.`,
      `الاستبدال والاسترجاع خلال 14 يوم بشرط أن يكون المنتج بحالته وبعبوته الأصلية.`,
      `العروض والخصومات: المنتجات التي عليها عرض يظهر سعرها قبل الخصم مشطوبًا في صفحة المنتج.`,
      `الجملة والشركات: أسعار خاصة، تواصل واتساب على ${STORE.phone}.`,
    ].join(" "),
    keywords: [
      "شحن",
      "دفع",
      "فودافون",
      "كاش",
      "استلام",
      "استبدال",
      "ارجاع",
      "جمله",
      "واتساب",
      "مواعيد",
      "عروض",
      "خصومات",
      "تخفيضات",
      "وفر",
    ],
    metadata: { phone: STORE.phone, whatsapp: STORE.whatsapp },
  };
}

/**
 * يبني الذاكرة كاملة. الترتيب ثابت (منتجات ثم أسئلة ثم بيانات المتجر) حتى
 * تكون النتائج حتمية عند تساوي الدرجات.
 */
export async function buildKnowledgeBase(): Promise<MemoryDocument[]> {
  const [products, faq] = await Promise.all([getProducts(), getFaq()]);
  return [...productDocuments(products), ...faqDocuments(faq), storeDocument()].map((document) => ({
    ...document,
    // النص يبقى كما هو للعرض؛ التطبيع يُخزَّن في الحقول نفسها وقت البناء
    // ليكون البحث سريعًا بلا تطبيع متكرر لكل استعلام.
    title: document.title,
    body: normalizeDocumentText(`${document.title} ${document.body} ${document.keywords.join(" ")}`),
  }));
}

/** ذاكرة مخبّأة قصيرة العمر: تُبنى مرة كل نافذة بدل كل استعلام. */
export async function getKnowledgeBase(options: { fresh?: boolean } = {}): Promise<MemoryDocument[]> {
  const now = Date.now();
  if (!options.fresh && cache && now - cache.builtAt < CACHE_TTL_MS) return cache.documents;
  const documents = await buildKnowledgeBase();
  cache = { documents, builtAt: now };
  return documents;
}

/** إبطال الذاكرة فورًا — يُستدعى بعد أي تعديل على الكتالوج من لوحة الإدارة. */
export function invalidateKnowledgeBase(): void {
  cache = null;
}
