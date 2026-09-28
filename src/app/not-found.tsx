import Link from "next/link";
import { STORE } from "@/lib/seed";

/**
 * صفحة 404 — تُستخدم في `notFound()` من صفحات المنتجات وفي أي مسار غير موجود.
 * تعرض مخرجين مفيدين (الكتالوج والواتساب) بدل رسالة خطأ جافة.
 */
export default function NotFound() {
  return (
    <div className="container section">
      <div className="state-card">
        <div className="state-emoji" aria-hidden="true">🧭</div>
        <h1 className="state-title">الصفحة أو المنتج غير موجود</h1>
        <p className="state-hint">يمكن الرابط قديم، أو المنتج مش متاح حاليًا في متجر {STORE.name}.</p>
        <div className="state-actions">
          <Link className="btn btn-primary" href="/#products">🛍️ تصفّح المنتجات</Link>
          <a className="btn btn-wa" href={`https://wa.me/${STORE.whatsapp}`} target="_blank" rel="noreferrer">💬 اسأل سيليا واتساب</a>
        </div>
      </div>
    </div>
  );
}
