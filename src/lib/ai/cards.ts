import { z } from "zod";

/**
 * بطاقات المنتجات في الواجهة — تنقية المحتوى المنظّم القادم من أدوات MCP.
 *
 * المحتوى المنظّم بيانات لا تعليمات: يمر بعقد صارم هنا قبل أن يصل للمتصفح،
 * فلا يمكن لأي مصدر أن يحقن حقولًا إضافية أو قيمًا غير صالحة في الواجهة.
 * الحد الأقصى 3 بطاقات ليبقى الرد مقروءًا على الهاتف.
 */

export const MAX_PRODUCT_CARDS = 3;

const cardSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(120),
    price: z.coerce.number().finite().min(0).max(1_000_000),
    old_price: z.union([z.coerce.number().finite().min(0).max(1_000_000), z.null()]).optional(),
    category: z.string().trim().max(60).optional(),
    image: z.string().trim().max(8).optional(),
    stock: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

const payloadSchema = z
  .object({
    kind: z.literal("products"),
    products: z.array(z.unknown()).max(20),
  })
  .strict();

export interface ProductCard {
  id: string;
  name: string;
  price: number;
  old_price?: number | null;
  category?: string;
  image?: string;
  stock?: number;
}

/**
 * يستخرج بطاقات المنتجات من محتوى الأدوات المنظّم: يتجاهل أي كائن لا يطابق
 * العقد، ويُزيل التكرار، ويقصّ العدد. لا يرمي أبدًا.
 */
export function extractProductCards(structured: readonly Record<string, unknown>[]): ProductCard[] {
  const cards: ProductCard[] = [];
  const seen = new Set<string>();

  for (const entry of structured) {
    const payload = payloadSchema.safeParse(entry);
    if (!payload.success) continue;
    for (const raw of payload.data.products) {
      const parsed = cardSchema.safeParse(raw);
      if (!parsed.success) continue;
      if (seen.has(parsed.data.id)) continue;
      seen.add(parsed.data.id);
      cards.push({
        id: parsed.data.id,
        name: parsed.data.name,
        price: parsed.data.price,
        old_price: parsed.data.old_price ?? null,
        category: parsed.data.category,
        image: parsed.data.image,
        stock: parsed.data.stock,
      });
      if (cards.length >= MAX_PRODUCT_CARDS) return cards;
    }
  }

  return cards;
}
