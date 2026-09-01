"use client";
import { useState } from "react";
import Link from "next/link";
import { useCart } from "@/lib/cart";
import { STORE } from "@/lib/seed";
import { GOVERNORATES, calculateShipping, SHIPPING_RATES } from "@/lib/shipping";

export default function CartPage() {
  const { items, subtotal, setQty, remove, clear } = useCart();
  const [form, setForm] = useState({
    customer: "",
    phone: "",
    governorate: "القاهرة",
    address: "",
    note: "",
    payment: "vodafone_cash",
    transferRef: "",
  });
  const [done, setDone] = useState<{ id: string; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // مفتاح idempotency: يُنشأ مرة واحدة لكل محاولة طلب ويُعاد استخدامه عند
  // إعادة المحاولة (timeout مثلاً) حتى لا يتكرر الطلب مرتين في الخادم
  const [idemKey, setIdemKey] = useState<string | null>(null);

  const shipping = calculateShipping(form.governorate, subtotal, STORE.freeShippingOver);
  const total = subtotal + shipping;
  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));

  function waText(orderId: string) {
    const lines = items.map((i) => `• ${i.name} × ${i.qty} = ${i.price * i.qty} ج.م`).join("\n");
    return `*طلب جديد من متجر ${STORE.name}*\nرقم الطلب: ${orderId}\n\n*المنتجات:*\n${lines}\n\nالإجمالي الفرعي: ${subtotal} ج.م\nالشحن: ${shipping === 0 ? "مجاني" : shipping + " ج.م"}\n*الإجمالي: ${total} ج.م*\n\n*بيانات العميل:*\nالاسم: ${form.customer}\nالموبايل: ${form.phone}\nالمحافظة: ${form.governorate}\nالعنوان: ${form.address}\nملاحظات: ${form.note || "لا يوجد"}\nطريقة الدفع: ${form.payment === "vodafone_cash" ? `فودافون كاش (${STORE.vodafoneCash})` : "الدفع عند الاستلام"}\nرقم التحويل: ${form.transferRef || "سيُرسل لاحقًا"}`;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (items.length === 0 || busy) return;
    setBusy(true);
    setError("");
    // نفس المفتاح يُرسل في كل إعادة محاولة → الخادم يعيد نفس رقم الطلب بدل التكرار
    const key = idemKey ?? crypto.randomUUID();
    setIdemKey(key);
    try {
      const r = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, items, idempotencyKey: key }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error || "تعذر تسجيل الطلب");
        return;
      }
      const id = String(j.id);
      setIdemKey(null); // نجح الطلب — مفتاح جديد للطلب القادم
      window.open(
        `https://wa.me/${STORE.whatsapp}?text=${encodeURIComponent(waText(id))}`,
        "_blank",
        "noopener,noreferrer"
      );
      setDone({ id, total: Number(j.total) });
      clear();
    } catch {
      setError("تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.");
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div className="container section" style={{ maxWidth: 640 }}>
        <div className="ok" style={{ textAlign: "center" }}>
          <div style={{ fontSize: "3rem" }}>✅</div>
          <h2>تم استلام طلبك بنجاح</h2>
          <p>
            رقم الطلب: <b>{done.id}</b>
          </p>
          <p>
            الإجمالي المعتمد من الخادم: <b>{done.total} ج.م</b>
          </p>
          <p style={{ marginTop: 10 }}>أرسل تفاصيل التحويل أو أكد الطلب على واتساب لتسريع المراجعة.</p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 16, flexWrap: "wrap" }}>
            <a className="btn btn-wa" href={`https://wa.me/${STORE.whatsapp}`} target="_blank" rel="noreferrer">
              تأكيد على واتساب
            </a>
            <Link className="btn btn-ghost" href="/#products">
              متابعة التسوق
            </Link>
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
          <p>سلتك فارغة، اختر منتجاتك أولًا.</p>
          <Link href="/#products" className="btn btn-primary" style={{ marginTop: 14 }}>
            تصفح المنتجات
          </Link>
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
                    <button
                      onClick={() => remove(i.id)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#e5484d",
                        cursor: "pointer",
                        fontSize: ".82rem",
                        padding: 0,
                      }}
                    >
                      حذف
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
                <input
                  required
                  value={form.customer}
                  onChange={(e) => update("customer", e.target.value)}
                  placeholder="مثال: محمد أحمد"
                />
              </div>
              <div className="field">
                <label>رقم الموبايل *</label>
                <input
                  required
                  inputMode="tel"
                  value={form.phone}
                  onChange={(e) => update("phone", e.target.value)}
                  placeholder="01xxxxxxxxx"
                />
              </div>
              <div className="field">
                <label>المحافظة *</label>
                <select required value={form.governorate} onChange={(e) => update("governorate", e.target.value)}>
                  {GOVERNORATES.map((g) => (
                    <option key={g} value={g}>
                      {g} — {SHIPPING_RATES[g]} ج.م
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>العنوان بالتفصيل *</label>
                <textarea
                  required
                  rows={3}
                  value={form.address}
                  onChange={(e) => update("address", e.target.value)}
                  placeholder="المنطقة - الشارع - رقم العقار"
                />
              </div>
              <div className="field">
                <label>طريقة الدفع *</label>
                <select value={form.payment} onChange={(e) => update("payment", e.target.value)}>
                  <option value="vodafone_cash">فودافون كاش — {STORE.vodafoneCash}</option>
                  <option value="cod">الدفع عند الاستلام</option>
                </select>
              </div>
              {form.payment === "vodafone_cash" && (
                <div className="field">
                  <label>رقم التحويل (اختياري)</label>
                  <input
                    value={form.transferRef}
                    onChange={(e) => update("transferRef", e.target.value)}
                    placeholder="أدخل الرقم بعد التحويل"
                  />
                </div>
              )}
              <div className="field">
                <label>ملاحظات</label>
                <input
                  value={form.note}
                  onChange={(e) => update("note", e.target.value)}
                  placeholder="أي تعليمات إضافية"
                />
              </div>
              {form.payment === "vodafone_cash" && (
                <div className="vodafone">
                  <div>حوّل المبلغ على فودافون كاش</div>
                  <div className="num">{STORE.vodafoneCash}</div>
                  <div style={{ fontSize: ".85rem" }}>ثم أرسل صورة التحويل على واتساب</div>
                </div>
              )}
              {error && (
                <div className="alert" role="alert">
                  {error}
                </div>
              )}
              <button className="btn btn-primary btn-block" disabled={busy}>
                {busy ? "جاري التحقق وتسجيل الطلب…" : "تأكيد الطلب وإرساله على واتساب"}
              </button>
            </form>
          </div>
          <div className="panel">
            <h3>ملخص الطلب</h3>
            <div className="sum-row">
              <span>الإجمالي الفرعي</span>
              <b>{subtotal} ج.م</b>
            </div>
            <div className="sum-row">
              <span>الشحن ({form.governorate})</span>
              <b>{shipping === 0 ? "مجاني 🎉" : shipping + " ج.م"}</b>
            </div>
            {shipping > 0 && (
              <div className="alert">أضف بـ {STORE.freeShippingOver - subtotal} ج.م واحصل على شحن مجاني!</div>
            )}
            <div className="sum-row total">
              <span>الإجمالي</span>
              <span>{total} ج.م</span>
            </div>
            <button className="btn btn-ghost btn-block" style={{ marginTop: 12 }} onClick={clear}>
              تفريغ السلة
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
