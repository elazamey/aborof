import type { Metadata } from "next";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ChatWidget from "@/components/ChatWidget";
import { STORE } from "@/lib/seed";

export const metadata: Metadata = {
  title: `${STORE.name} — ${STORE.tagline}`,
  description:
    "متجر روفيده لبيع وعرض أدوات ومستلزمات التنظيف بأسعار الجملة. دفع فودافون كاش وتوصيل لكل المحافظات.",
  keywords: ["أدوات نظافة", "منظفات", "روفيده", "مستلزمات تنظيف", "جملة منظفات مصر"],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>
        <Header />
        <main>{children}</main>
        <Footer />
        <ChatWidget />
      </body>
    </html>
  );
}
