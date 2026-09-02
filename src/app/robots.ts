import type { MetadataRoute } from "next";

/**
 * robots.txt — فهرسة كاملة للمتجر مع منع المناطق الحساسة.
 * (المسارات الداخلية لا تُفهرس: لوحة التحكم وواجهات الـ API.)
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/api/"],
      },
    ],
  };
}
