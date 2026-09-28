import type { MetadataRoute } from "next";
import { STORE } from "@/lib/seed";

/**
 * مانيفست PWA — يجعل «إضافة للشاشة الرئيسية» ممكنة (مهم لمتجر يعتمد واتساب).
 * الأيقونة SVG المعرّفة في `app/icon.svg` هي نفسها المستخدمة كـfavicon، فلا
 * نشير إلى ملفات غير موجودة (مرجع أيقونة مفقود يُلغي التنصيب صامتًا).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${STORE.name} — ${STORE.tagline}`,
    short_name: STORE.name,
    description: "منظفات وأدوات نظافة بأسعار الجملة، توصيل لكل المحافظات، دفع فودافون كاش أو عند الاستلام.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    dir: "rtl",
    lang: "ar-EG",
    background_color: "#f6f9f7",
    theme_color: "#0f7a4d",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
