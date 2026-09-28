import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/site";

/**
 * robots.txt — يمنع فهرسة ما لا يجب فهرسته، ويرشد الزواحف لخريطة الموقع:
 *  - `/admin` و`/api` محجوبان (لوحة الإدارة ونقاط البيانات ليست محتوى عام).
 *  - `/cart` محجوبة (صفحة عميل بلا قيمة فهرسة).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/api/", "/cart"],
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: absoluteUrl("/"),
  };
}
