import type { Metadata, Viewport } from "next";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ChatWidget from "@/components/ChatWidget";
import { STORE } from "@/lib/seed";
import { siteUrl } from "@/lib/site";

const DESCRIPTION =
  "متجر روفيده لبيع وعرض أدوات ومستلزمات التنظيف بأسعار الجملة. دفع فودافون كاش أو عند الاستلام، وتوصيل لكل المحافظات.";

/**
 * metadataBase ضرورية حتى تُبنى روابط canonical وog:image المطلقة صحيحة
 * (وبلاها يحذّر Next.js في البناء وترسل روابط نسبية للزواحف).
 */
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: `${STORE.name} — ${STORE.tagline}`,
  description: DESCRIPTION,
  keywords: ["أدوات نظافة", "منظفات", "روفيده", "مستلزمات تنظيف", "جملة منظفات مصر"],
  applicationName: STORE.name,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "ar_EG",
    siteName: STORE.name,
    title: `${STORE.name} — ${STORE.tagline}`,
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: `${STORE.name} — ${STORE.tagline}`,
    description: DESCRIPTION,
  },
  // لا نعلن robots صراحةً هنا: وجود `index: true` في الـlayout يُنتج وسمًا ثانيًا
  // `index, follow` بجانب `noindex` الذي يضيفه Next لصفحات 404/الخطأ — تعارض تضعه
  // محركات البحث ضدّ الموقع. الغياب يعني «قابل للفهرسة» وهو الافتراضي المطلوب.
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  themeColor: "#0f7a4d",
  width: "device-width",
  initialScale: 1,
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
