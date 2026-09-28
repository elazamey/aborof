import type { MetadataRoute } from "next";
import { getProducts } from "@/lib/db";
import { absoluteUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

/**
 * خريطة الموقع — تُبنى من نفس مصدر المنتجات الفعلي (لا قائمة يدوية تتقادم).
 * `/admin` مستبعدة عمدًا (تُحجب أيضًا في robots.ts)، و`/cart` مستبعدة لأنها
 * صفحة خاصة بجلسة العميل ولا قيمة لها في الفهرسة.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const products = await getProducts();
  const now = new Date();

  return [
    { url: absoluteUrl("/"), lastModified: now, changeFrequency: "daily", priority: 1 },
    ...products.map((product) => ({
      url: absoluteUrl(`/product/${product.id}`),
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}
