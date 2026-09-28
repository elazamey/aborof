import type { Metadata } from "next";
import { getProduct, getProducts } from "@/lib/db";
import { STORE } from "@/lib/seed";
import { notFound } from "next/navigation";
import Link from "next/link";
import AddButton from "./AddButton";

export const dynamic = "force-dynamic";

/**
 * Next.js 16 يجعل `params` وعدًا (Promise) — قراءتها متزامنة تعطي `id` غير معرّف،
 * فيسقط كل منتج إلى `notFound()`. هذا كان **خطأً إنتاجيًا حقيقيًا**: كل صفحات
 * المنتجات تُرجع 404 رغم أن الروابط إليها منشورة في الصفحة الرئيسية.
 * الشكل الصحيح هو `await params` في الصفحة وفي generateMetadata معًا.
 */
type Props = { params: Promise<{ id: string }> };

/**
 * ميتاداتا صفحة المنتج — أكبر مكسب فهرسة ومشاركة: عنوان المنتج الحقيقي وسعره
 * في الوصف، وcanonical مطلق، وبطاقة مشاركة عربية. المنتج غير الموجود يعطي
 * عنوانًا محايدًا (وصفحة 404 هي التي تُخدَم فعلًا عبر notFound).
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const product = await getProduct(id);
  if (!product) {
    // `notFound()` هنا مقصودة لا في الصفحة فقط: مع وجود `loading.tsx` يبدأ البث
    // بحالة 200 قبل رسم الصفحة، فيتحول 404 إلى «404 ناعم». رفع القرار إلى الميتاداتا
    // (وهي تُحلّ قبل البث) يعطي رمز الحالة الصحيح 404 للزواحف وللمراقبة.
    notFound();
  }
  const price = Number(product.price);
  const description = `${product.description} — السعر ${price} جنيه${
    product.old_price ? ` بدل ${Number(product.old_price)} جنيه` : ""
  }. توصيل لكل المحافظات ودفع فودافون كاش أو عند الاستلام.`;

  return {
    title: `${product.name} — ${price} جنيه | ${STORE.name}`,
    description,
    alternates: { canonical: `/product/${product.id}` },
    openGraph: {
      type: "website",
      locale: "ar_EG",
      title: `${product.name} — ${price} جنيه`,
      description,
      url: `/product/${product.id}`,
      siteName: STORE.name,
    },
    twitter: { card: "summary_large_image", title: `${product.name} — ${price} جنيه`, description },
  };
}

export default async function ProductPage({ params }: Props) {
  const { id } = await params;
  const p = await getProduct(id);
  if (!p) notFound();
  const related = (await getProducts()).filter((x) => x.category === p.category && x.id !== p.id).slice(0, 4);

  return (
    <div className="container section">
      <p style={{ marginBottom: 14, color: "var(--muted)", fontSize: ".9rem" }}>
        <Link href="/">الرئيسية</Link> / <Link href="/#products">{p.category}</Link> / {p.name}
      </p>
      <div className="cart-wrap">
        <div className="panel" style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 20 }}>
          <div className="card-img" style={{ borderRadius: 16, height: 220, fontSize: "5rem" }}>{p.image}</div>
          <div>
            <span className="card-cat">{p.category}</span>
            <h1 style={{ fontSize: "1.5rem", margin: "6px 0 10px" }}>{p.name}</h1>
            <div className="price-row" style={{ marginBottom: 10 }}>
              <span className="price">{p.price} <small>ج.م</small></span>
              {p.old_price ? <span className="price-old">{p.old_price} ج.م</span> : null}
            </div>
            <p style={{ color: "var(--muted)", marginBottom: 14 }}>{p.description}</p>
            <p style={{ marginBottom: 14, fontWeight: 700, color: Number(p.stock) > 0 ? "var(--green)" : "#e5484d" }}>
              {Number(p.stock) > 0 ? `✅ متوفر (${p.stock} قطعة)` : "❌ غير متوفر حالياً"}
            </p>
            <AddButton product={JSON.parse(JSON.stringify(p))} />
          </div>
        </div>
        <div className="panel">
          <h3>معلومات الطلب</h3>
          <p style={{ fontSize: ".92rem", color: "var(--muted)" }}>🚚 الشحن {STORE.shipping} ج.م — مجاني فوق {STORE.freeShippingOver} ج.م</p>
          <p style={{ fontSize: ".92rem", color: "var(--muted)" }}>💳 فودافون كاش أو الدفع عند الاستلام</p>
          <p style={{ fontSize: ".92rem", color: "var(--muted)" }}>🔄 استبدال خلال 14 يوم</p>
          <div className="vodafone">
            <div>💳 فودافون كاش</div>
            <div className="num">{STORE.vodafoneCash}</div>
          </div>
          <a className="btn btn-wa btn-block" target="_blank" rel="noreferrer"
            href={`https://wa.me/${STORE.whatsapp}?text=${encodeURIComponent(`مهتم بمنتج: ${p.name} — ${p.price} ج.م`)}`}>
            💬 استفسر واتساب
          </a>
        </div>
      </div>

      {related.length > 0 && (
        <>
          <h2 style={{ margin: "34px 0 16px" }}>منتجات مشابهة</h2>
          <div className="grid">
            {related.map((r) => (
              <Link href={`/product/${r.id}`} key={r.id} className="card">
                <div className="card-img">{r.image}</div>
                <div className="card-body">
                  <div className="card-title">{r.name}</div>
                  <span className="price">{r.price} <small>ج.م</small></span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
