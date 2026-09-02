import type { Metadata } from "next";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ChatWidget from "@/components/ChatWidget";
import { STORE } from "@/lib/seed";

export const metadata: Metadata = {
  title: `${STORE.name} — ${STORE.tagline}`,
  description: "متجر روفيده لبيع وعرض أدوات ومستلزمات التنظيف بأسعار الجملة. دفع فودافون كاش وتوصيل لكل المحافظات.",
  keywords: ["أدوات نظافة", "منظفات", "روفيده", "مستلزمات تنظيف", "جملة منظفات مصر"],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // CINEMATIC_ENHANCEMENTS — مفتاح تعطيل التصميم السينمائي (ON افتراضيًا).
  // أي قيمة != "false" تُبقي التأثيرات؛ "false" = core storefront بدون حركة/زجاج/توهج.
  const cinematic = process.env.CINEMATIC_ENHANCEMENTS !== "false";
  return (
    <html lang="ar" dir="rtl">
      <body className={cinematic ? "" : "cinematic-off"}>
        <Header />
        <main>{children}</main>
        <Footer />
        <ChatWidget />
      </body>
    </html>
  );
}
