/**
 * حالة تحميل الصفحة الرئيسية (Server Component — لا حاجة لـ"use client").
 * بلاها يبقى المتصفح على الصفحة السابقة بلا أي إشارة أثناء التنقّل.
 *
 * ⚠️ موقعها مقصود: داخل مجموعة المسارات `(home)` لا في `src/app/` مباشرة.
 * أي `loading.tsx` في الجذر يبدأ بث الردّ بحالة 200 قبل حسم وجود المنتج، فيتحول
 * `notFound()` في `/product/[id]` إلى «404 ناعم» (200 + محتوى 404) وهو خطأ SEO
 * حقيقي. التحقق المحلي أثبت الفرق: مع حدّ تحميل جذري ⇒ 200، وبدونه ⇒ 404 صحيح.
 */
export default function Loading() {
  return (
    <div className="container section" role="status" aria-live="polite" aria-busy="true">
      <div className="state-card">
        <span className="state-spinner" aria-hidden="true" />
        <p className="state-title">جاري التحميل…</p>
        <p className="state-hint">ثوانٍ قليلة ويعرض لك المتجر ما تبحث عنه.</p>
      </div>
    </div>
  );
}
