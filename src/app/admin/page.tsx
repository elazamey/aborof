"use client";
import { useEffect, useState } from "react";
import { CATEGORIES } from "@/lib/seed";

export default function Admin() {
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<"products" | "orders">("products");
  const [products, setProducts] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [p, setP] = useState<any>({ id: "", name: "", description: "", price: "", old_price: "", category: CATEGORIES[0], image: "🧴", stock: 10, featured: false });

  async function load() {
    const r = await fetch("/api/products").then((x) => x.json());
    setProducts(r.products || []);
    const o = await fetch("/api/orders").then((x) => x.json());
    setOrders(o.orders || []);
  }

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) { setAuthed(true); setPassword(""); await load(); }
      else setMsg(data.error || "تعذر تسجيل الدخول.");
    } catch { setMsg("تعذر الاتصال بالخادم. حاول مرة أخرى."); }
    finally { setBusy(false); }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/products", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product: p }),
    });
    const j = await r.json();
    setMsg(j.ok ? "✅ تم الحفظ" : "❌ " + (j.error || "خطأ"));
    if (j.ok) { setP({ id: "", name: "", description: "", price: "", old_price: "", category: CATEGORIES[0], image: "🧴", stock: 10, featured: false }); load(); }
  }

  async function del(id: string) {
    if (!confirm("حذف المنتج؟")) return;
    const r = await fetch(`/api/products?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) setMsg("تعذر حذف المنتج");
    load();
  }

  useEffect(() => {
    fetch("/api/admin/session")
      .then((r) => r.json())
      .then((data) => setAuthed(Boolean(data.authenticated)))
      .catch(() => setAuthed(false))
      .finally(() => setLoading(false));
  }, []);

  async function logout() {
    await fetch("/api/admin/session", { method: "POST" });
    setAuthed(false);
    setProducts([]);
    setOrders([]);
  }

  useEffect(() => { if (authed) load(); /* eslint-disable-next-line */ }, [authed]);

  if (loading)
    return <div className="container section"><div className="panel admin-loading">جارٍ التحقق من جلسة الإدارة…</div></div>;

  if (!authed)
    return (
      <div className="container section admin-shell" style={{ maxWidth: 500 }}>
        <form className="panel admin-login" onSubmit={login}>
          <div className="admin-kicker">إدارة روفيده</div>
          <h1>مرحبًا بك في لوحة التحكم</h1>
          <p className="admin-muted">سجّل الدخول لإدارة المنتجات والطلبات بأمان.</p>
          {msg && <div className="alert">{msg}</div>}
          <div className="field">
            <label>كلمة مرور الإدارة</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? "جارٍ التحقق…" : "دخول آمن"}</button>
        </form>
      </div>
    );

  return (
    <div className="container section">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <h1>لوحة التحكم</h1>
        <button className="btn btn-ghost" onClick={logout}>تسجيل الخروج</button>
      </div>
      <div className="filters" style={{ justifyContent: "flex-start", marginTop: 14 }}>
        <button className={"chip" + (tab === "products" ? " active" : "")} onClick={() => setTab("products")}>المنتجات ({products.length})</button>
        <button className={"chip" + (tab === "orders" ? " active" : "")} onClick={() => setTab("orders")}>الطلبات ({orders.length})</button>
      </div>
      {msg && <div className="alert">{msg}</div>}

      {tab === "products" ? (
        <div className="cart-wrap">
          <div className="panel">
            <h3>المنتجات الحالية</h3>
            <table>
              <thead><tr><th></th><th>الاسم</th><th>السعر</th><th>المخزون</th><th></th></tr></thead>
              <tbody>
                {products.map((x) => (
                  <tr key={x.id}>
                    <td style={{ fontSize: "1.4rem" }}>{x.image}</td>
                    <td>{x.name}</td>
                    <td>{x.price}</td>
                    <td>{x.stock}</td>
                    <td>
                      <button className="chip" onClick={() => setP({ ...x, featured: !!x.featured })}>تعديل</button>{" "}
                      <button className="chip" onClick={() => del(x.id)}>حذف</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form className="panel" onSubmit={save}>
            <h3>{p.id ? "تعديل منتج" : "إضافة منتج"}</h3>
            <div className="field"><label>الاسم</label><input required value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></div>
            <div className="field"><label>الوصف</label><textarea rows={3} value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} /></div>
            <div className="field"><label>السعر</label><input required type="number" value={p.price} onChange={(e) => setP({ ...p, price: e.target.value })} /></div>
            <div className="field"><label>السعر قبل الخصم</label><input type="number" value={p.old_price ?? ""} onChange={(e) => setP({ ...p, old_price: e.target.value })} /></div>
            <div className="field"><label>القسم</label>
              <select value={p.category} onChange={(e) => setP({ ...p, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="field"><label>الأيقونة / إيموجي</label><input value={p.image} onChange={(e) => setP({ ...p, image: e.target.value })} /></div>
            <div className="field"><label>المخزون</label><input type="number" value={p.stock} onChange={(e) => setP({ ...p, stock: e.target.value })} /></div>
            <label style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input type="checkbox" checked={!!p.featured} onChange={(e) => setP({ ...p, featured: e.target.checked })} /> منتج مميز
            </label>
            <button className="btn btn-primary btn-block">حفظ</button>
          </form>
        </div>
      ) : (
        <div className="panel">
          <table>
            <thead><tr><th>رقم</th><th>العميل</th><th>الموبايل</th><th>الإجمالي</th><th>الدفع</th><th>التاريخ</th></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td><td>{o.customer}</td><td>{o.phone}</td>
                  <td>{o.total} ج.م</td><td>{o.payment === "cod" ? "عند الاستلام" : "فودافون كاش"}</td>
                  <td>{String(o.created_at).slice(0, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {orders.length === 0 && <p style={{ color: "var(--muted)", padding: 12 }}>لا توجد طلبات بعد (تحتاج ربط Turso).</p>}
        </div>
      )}
    </div>
  );
}
