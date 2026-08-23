"use client";
import Link from "next/link";
import { useCart } from "@/lib/cart";
import { STORE } from "@/lib/seed";

export default function Header() {
  const { count } = useCart();
  return (
    <header className="header">
      <div className="topbar">
        🚚 شحن مجاني للطلبات فوق {STORE.freeShippingOver} جنيه · 💳 فودافون كاش أو الدفع عند الاستلام · ☎️ {STORE.phone}
      </div>
      <div className="container nav">
        <Link href="/" className="brand">
          <div className="brand-logo">🧼</div>
          <div>
            <div className="brand-name">{STORE.name}</div>
            <div className="brand-sub">{STORE.tagline}</div>
          </div>
        </Link>
        <nav className="nav-links">
          <Link href="/">الرئيسية</Link>
          <Link href="/#products">المنتجات</Link>
          <Link href="/#features">لماذا نحن</Link>
          <Link href="/#contact">تواصل معنا</Link>
        </nav>
        <div className="nav-actions">
          <a className="btn btn-wa" href={`https://wa.me/${STORE.whatsapp}`} target="_blank" rel="noreferrer">
            واتساب
          </a>
          <Link href="/cart" className="cart-btn">
            🛒 السلة
            {count > 0 && <span className="cart-badge">{count}</span>}
          </Link>
        </div>
      </div>
    </header>
  );
}
