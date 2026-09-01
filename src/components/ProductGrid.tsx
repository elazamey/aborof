"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import type { Product } from "@/lib/seed";
import { addToCart } from "@/lib/cart";
import { STORE } from "@/lib/seed";

export default function ProductGrid({ products }: { products: Product[] }) {
  const [cat, setCat] = useState("الكل");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("featured");
  const [added, setAdded] = useState<string | null>(null);
  const cats = useMemo(
    () => ["الكل", ...Array.from(new Set(products.map((p) => p.category).filter(Boolean)))],
    [products]
  );
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return products
      .filter(
        (p) =>
          (cat === "الكل" || p.category === cat) &&
          (!term || `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(term))
      )
      .sort((a, b) => {
        if (sort === "price-asc") return a.price - b.price;
        if (sort === "price-desc") return b.price - a.price;
        if (sort === "discount")
          return Number(b.old_price || b.price) - b.price - (Number(a.old_price || a.price) - a.price);
        return Number(b.featured) - Number(a.featured);
      });
  }, [products, cat, q, sort]);

  return (
    <>
      <div className="catalog-toolbar">
        <div style={{ flex: "1 1 300px" }}>
          <input
            className="search"
            aria-label="البحث في المنتجات"
            placeholder="ابحث عن منتج أو قسم… مثال: منظف أرضيات"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select
          className="sort-select"
          aria-label="ترتيب المنتجات"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="featured">الأكثر ترشيحًا</option>
          <option value="price-asc">السعر: من الأقل للأعلى</option>
          <option value="price-desc">السعر: من الأعلى للأقل</option>
          <option value="discount">أعلى خصم</option>
        </select>
      </div>
      <div className="catalog-meta">
        <span>
          {list.length} منتج{q || cat !== "الكل" ? " مطابق" : " متاح"}
        </span>
        <div className="filters">
          {cats.map((c) => (
            <button type="button" key={c} className={`chip${c === cat ? " active" : ""}`} onClick={() => setCat(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
      {list.length === 0 ? (
        <div className="empty">
          <div className="ic">⌕</div>
          <p>لا توجد منتجات مطابقة. جرّب كلمة أخرى أو تواصل معنا على واتساب.</p>
        </div>
      ) : (
        <div className="grid">
          {list.map((p) => {
            const off = p.old_price ? Math.round((1 - p.price / Number(p.old_price)) * 100) : 0;
            const out = Number(p.stock) <= 0;
            return (
              <article className="card" key={p.id}>
                <div className="card-img">
                  {p.image}
                  {out ? (
                    <span className="tag out">نفذت الكمية</span>
                  ) : off > 0 ? (
                    <span className="tag">خصم {off}%</span>
                  ) : p.featured ? (
                    <span className="tag">اختيارنا</span>
                  ) : null}
                </div>
                <div className="card-body">
                  <span className="card-cat">{p.category}</span>
                  <Link href={`/product/${p.id}`} className="card-title">
                    {p.name}
                  </Link>
                  <p className="card-desc">{p.description}</p>
                  <div className="price-row">
                    <span className="price">
                      {p.price} <small>ج.م</small>
                    </span>
                    {p.old_price ? <span className="price-old">{p.old_price} ج.م</span> : null}
                  </div>
                  <div className="card-actions">
                    <button
                      className="btn btn-primary"
                      disabled={out}
                      onClick={() => {
                        addToCart(p);
                        setAdded(String(p.id));
                        setTimeout(() => setAdded(null), 1400);
                      }}
                    >
                      {added === String(p.id) ? "تمت الإضافة" : "أضف للسلة"}
                    </button>
                    <a
                      className="btn btn-wa"
                      target="_blank"
                      rel="noreferrer"
                      href={`https://wa.me/${STORE.whatsapp}?text=${encodeURIComponent(`السلام عليكم، مهتم بمنتج: ${p.name} بسعر ${p.price} جنيه`)}`}
                    >
                      واتساب
                    </a>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
