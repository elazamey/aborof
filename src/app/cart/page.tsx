"use client";
import { useState } from "react";
import Link from "next/link";
import { useCart } from "@/lib/cart";
import { STORE } from "@/lib/seed";

export default function CartPage() {
  const { items, subtotal, setQty, remove, clear } = useCart();
  const [form, setForm] = useState({ customer: "", phone: "", address: "", note: "", payment: "vodafone_cash" });
  const [done, setDone] = useState<{ id: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const shipping = subtotal === 0 || subtotal >= STORE.freeShippingOver ? 0 : STORE.shipping;
  const total = subtotal + shipping;

  function waText(orderId: string) {
    const lines = items.map((i) => `• ${i.name} × ${i.qty} = ${i.price * i.qty} ج.م`).join("\n");
    return `*طلب جديد من متجر ${STORE.name}*
رقم الطلب: ${orderId}

*المنتجات:*
${lines}

الإجمالي الفرعي: ${subtotal} ج.م
الشحن: ${shipping === 0 ? "مجاني" : shipping + " ج.م"}
*الإجمالي: ${total} ج.م*

*بيانات العميل:*
الاسم: ${form.customer}
الموبايل: ${form.phone}
العنوان: ${form.address}
ملاحظات: ${form.note || "لا يوجد"}
طريقة الدفع: ${form.payment === "vodafone_cash" ? `فودافون كاش (${STORE.vodafoneCash})` : "الدفع عند الاستلام"}`;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (items.length === 0) return;
    setBusy(true);
    let id = "ORD-" + Date.now().toString().slice(-8);
    try {
      const r = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, items, total }),
      });
      const j = await r.json();
      if (j.id) id = j.id;
    } catch {}
    window.open(`https://wa.me/${STORE.whatsapp}?text=${encodeURIComponent(waText(id))}`, "_blank");
    setDone({ id });
    clear();
    setBusy(false);
  }

  if (done)
    return (
      <div className="container section" style={{ maxWidth: 640 }}>
        <div className="ok" style={{ textAlign: "center" }}>
          <div style={{ fontSize: "3rem" }}>✅</div>
          <h2>تم استلام طلبك بنجاح!</h2>
          <p>رقم الطلب: <b>{done.id}</b></p>
          <p style={{ marginTop: 10 }}>
            برجاء تحويل المبلغ على فودافون كاش <b style={{ direction: "ltr", display: "inline-block" }}>{STORE.vodafoneCash}</b> وإرسال صورة التحويل على الواتساب لتأكيد الطلب.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 16, flexWrap: "wrap" }}>
            <a className="btn btn-wa" href={`https://wa.me/${STORE.whatsapp}`} target="_blank" rel="noreferrer">💬 تأكيد على واتساب</a>
            <Link className="btn btn-ghost" href="/#products">متابعة التسوق</Link>
          </div>
        </div>
      </div>
    );

  return (
    <div className="container section">
      <h1 style={{ marginBottom: 18 }}>🛒 سلة المشتريات</h1>
      {items.length === 0 ? (
        <div className="empty">
          <div className="ic">🛒</div>
          <p>سلتك فاضية… يلا نختار حاجات حلوة للنضافة!</p>
          <Link href="/#products" className="btn btn-primary" style={{ marginTop: 14 }}>تصفح المنتجات</Link>
        </div>
      ) : (
        <div className="cart-wrap">
          <div>
            <div className="panel">
              <h3>المنتجات ({items.length})</h3>
              {items.map((i) => (
                <div className="line-item" key={i.id}>
                  <div className="line-thumb">{i.image}</div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: ".95rem" }}>{i.name}</div>
                    <div style={{ color: "var(--muted)", fontSize: ".85rem" }}>{i.price} ج.م للقطعة</div>
                    <button onClick={() => remove(i.id)} style={{ background: "none", border: "none", color: "#e5484d", cursor: "pointer", fontSize: ".82rem", padding: 0 }}>
                      🗑 حذف
                    </button>
                  </div>
                  <div style={{ textAlign: "left" }}>
                    <div className="qty" style={{ justifyContent: "flex-end", marginBottom: 6 }}>
                      <button onClick={() => setQty(i.id, i.qty - 1)}>−</button>
                      <b>{i.qty}</b>
                      <button onClick={() => setQty(i.id, i.qty + 1)}>+</button>
                    </div>
                    <b style={{ color: "var(--green-d)" }}>{i.price * i.qty} ج.م</b>
                  </div>
                </div>
              ))}
            </div>

            <form className="panel" style={{ marginTop: 16 }} onSubmit={submit}>
              <h3>بيانات التوصيل</h3>
              <div className="field">
                <label>الاسم بالكامل *</label>
                <input required value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} placeholder="مثال: محمد أحمد" />
              </div>
              <div className="field">
                <label>رقم الموبايل *</label>
                <input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="01xxxxxxxxx" />
              </div>
              <div className="field">
                <label>العنوان بالتفصيل *</label>
                <textarea required rows={3} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="المحافظة - المنطقة - الشارع - رقم العقار" />
              </div>
              <div className="field">
                <label>طريقة الدفع</label>
                <select value={form.payment} onChange={(e) => setForm({ ...form, payment: e.target.value })}>
                  <option value="vodafone_cash">فودافون كاش — {STORE.vodafoneCash}</option>
                  <option value="cod">الدفع عند الاستلام</option>
                </select>
              </div>
              <div className="field">
                <label>ملاحظات (اختياري)</label>
                <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="أي تعليمات إضافية" />
              </div>
              {form.payment === "vodafone_cash" && (
                <div className="vodafone">
                  <div>💳 حوّل المبلغ على فودافون كاش</div>
                  <div className="num">{STORE.vodafoneCash}</div>
                  <div style={{ fontSize: ".85rem" }}>وابعت صورة التحويل على الواتساب لتأكيد الطلب</div>
                </div>
              )}
              <button className="btn btn-primary btn-block" disabled={busy}>
                {busy ? "جاري الإرسال…" : "✅ تأكيد الطلب وإرساله على واتساب"}
              </button>
            </form>
          </div>

          <div className="panel">
            <h3>ملخص الطلب</h3>
            <div className="sum-row"><span>الإجمالي الفرعي</span><b>{subtotal} ج.م</b></div>
            <div className="sum-row"><span>الشحن</span><b>{shipping === 0 ? "مجاني 🎉" : shipping + " ج.م"}</b></div>
            {shipping > 0 && (
              <div className="alert">أضف بـ {STORE.freeShippingOver - subtotal} ج.م واحصل على شحن مجاني!</div>
            )}
            <div className="sum-row total"><span>الإجمالي</span><span>{total} ج.م</span></div>
            <button className="btn btn-ghost btn-block" style={{ marginTop: 12 }} onClick={clear}>تفريغ السلة</button>
          </div>
        </div>
      )}
    </div>
  );
}
