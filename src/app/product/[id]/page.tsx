import { getProduct, getProducts } from "@/lib/db";
import { STORE } from "@/lib/seed";
import { notFound } from "next/navigation";
import Link from "next/link";
import AddButton from "./AddButton";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: { params: { id: string } }) {
  const p = await getProduct(params.id);
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
