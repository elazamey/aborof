"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import type { Product } from "@/lib/seed";
import { addToCart } from "@/lib/cart";
import { STORE } from "@/lib/seed";

export default function ProductGrid({ products }: { products: Product[] }) {
  const [cat, setCat] = useState("الكل");
  const [q, setQ] = useState("");
  const [added, setAdded] = useState<string | null>(null);

  const cats = useMemo(
    () => ["الكل", ...Array.from(new Set(products.map((p) => p.category).filter(Boolean)))],
    [products]
  );

  const list = products.filter(
    (p) =>
      (cat === "الكل" || p.category === cat) &&
      (q.trim() === "" || (p.name + p.description).toLowerCase().includes(q.trim().toLowerCase()))
  );

  return (
    <>
      <input
        className="search"
        placeholder="🔍 ابحث عن منتج… مثال: منظف أرضيات"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="filters">
        {cats.map((c) => (
          <button key={c} className={"chip" + (c === cat ? " active" : "")} onClick={() => setCat(c)}>
            {c}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="empty">
          <div className="ic">🔎</div>
          <p>لا توجد منتجات مطابقة. جرّب كلمة أخرى أو كلمنا واتساب.</p>
        </div>
      ) : (
        <div className="grid">
          {list.map((p) => {
            const off = p.old_price ? Math.round((1 - p.price / Number(p.old_price)) * 100) : 0;
            const out = Number(p.stock) <= 0;
            return (
              <div className="card" key={p.id}>
                <div className="card-img">
                  {p.image}
                  {out ? <span className="tag out">نفذت الكمية</span> : off > 0 ? <span className="tag">خصم {off}%</span> : null}
                </div>
                <div className="card-body">
                  <span className="card-cat">{p.category}</span>
                  <Link href={`/product/${p.id}`} className="card-title">{p.name}</Link>
                  <p className="card-desc">{p.description}</p>
                  <div className="price-row">
                    <span className="price">{p.price} <small>ج.م</small></span>
                    {p.old_price ? <span className="price-old">{p.old_price} ج.م</span> : null}
                  </div>
                  <div className="card-actions">
                    <button
                      className="btn btn-primary"
                      disabled={out}
                      onClick={() => { addToCart(p); setAdded(String(p.id)); setTimeout(() => setAdded(null), 1400); }}
                    >
                      {added === String(p.id) ? "✓ تمت الإضافة" : "أضف للسلة"}
                    </button>
                    <a
                      className="btn btn-wa"
                      target="_blank" rel="noreferrer"
                      href={`https://wa.me/${STORE.whatsapp}?text=${encodeURIComponent(`السلام عليكم، مهتم بمنتج: ${p.name} بسعر ${p.price} جنيه`)}`}
                    >
                      واتس
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
