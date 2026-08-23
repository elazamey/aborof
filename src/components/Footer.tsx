import { STORE } from "@/lib/seed";
import Link from "next/link";

export default function Footer() {
  return (
    <footer className="footer" id="contact">
      <div className="container footer-grid">
        <div>
          <h4>🧼 {STORE.name}</h4>
          <p style={{ fontSize: ".92rem" }}>
            متجرك الأول لأدوات ومستلزمات النظافة في مصر. منتجات أصلية بأسعار الجملة، توصيل لكل المحافظات،
            وخدمة عملاء على مدار اليوم.
          </p>
          <p style={{ marginTop: 12, fontSize: ".92rem" }}>💳 الدفع: فودافون كاش · الدفع عند الاستلام</p>
        </div>
        <div>
          <h4>روابط سريعة</h4>
          <Link href="/">الرئيسية</Link>
          <Link href="/#products">كل المنتجات</Link>
          <Link href="/cart">سلة المشتريات</Link>
          <Link href="/admin">لوحة التحكم</Link>
        </div>
        <div>
          <h4>تواصل معنا</h4>
          <a href={`https://wa.me/${STORE.whatsapp}`} target="_blank" rel="noreferrer">💬 واتساب: {STORE.phone}</a>
          <a href={`tel:+${STORE.whatsapp}`}>📞 اتصال: {STORE.phone}</a>
          <a href="#">💳 فودافون كاش: {STORE.vodafoneCash}</a>
          <a href="#">📍 {STORE.address}</a>
        </div>
      </div>
      <div className="footer-bot">© {new Date().getFullYear()} {STORE.name} — جميع الحقوق محفوظة</div>
    </footer>
  );
}
