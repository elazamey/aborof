import Link from "next/link";
import ProductGrid from "@/components/ProductGrid";
import { getProducts, getFaq, hasDB } from "@/lib/db";
import { STORE } from "@/lib/seed";

export const dynamic = "force-dynamic";

export default async function Home() {
  const products = await getProducts();
  const faq = await getFaq();

  return (
    <>
      <section className="hero">
        <div className="container hero-in">
          <div>
            <h1>كل مستلزمات النظافة في مكان واحد 🧼</h1>
            <p>
              متجر <b>{STORE.name}</b> — منظفات وأدوات نظافة أصلية بأسعار الجملة، مع توصيل سريع لكل
              المحافظات، ودفع سهل عن طريق فودافون كاش أو عند الاستلام.
            </p>
            <div className="hero-cta">
              <Link href="#products" className="btn btn-gold">🛍️ تسوّق الآن</Link>
              <a className="btn btn-wa" href={`https://wa.me/${STORE.whatsapp}`} target="_blank" rel="noreferrer">
                💬 اطلب واتساب {STORE.phone}
              </a>
            </div>
            <div className="hero-badges">
              <span className="hero-badge">🚚 شحن مجاني فوق {STORE.freeShippingOver} ج.م</span>
              <span className="hero-badge">💳 فودافون كاش</span>
              <span className="hero-badge">✅ منتجات أصلية</span>
              <span className="hero-badge">👩‍💼 سيليا ترد عليك فوراً</span>
            </div>
          </div>
          <div className="hero-art">🧴🧹🧽</div>
        </div>
      </section>

      <section className="section" id="features">
        <div className="container">
          <div className="features">
            {[
              ["🚚", "توصيل سريع", "خلال 1-3 أيام لكل المحافظات"],
              ["💳", "فودافون كاش", `الدفع على ${STORE.vodafoneCash} أو عند الاستلام`],
              ["🏷️", "أسعار الجملة", "خصومات خاصة للشركات والكميات"],
              ["👩‍💼", "دعم فوري", "سيليا مساعدتك الذكية 24/7"],
            ].map(([ic, t, d]) => (
              <div className="feature" key={t}>
                <div className="ic">{ic}</div>
                <h4>{t}</h4>
                <p>{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="products" style={{ background: "#fff" }}>
        <div className="container">
          <div className="section-head">
            <h2>منتجاتنا</h2>
            <p>{products.length} منتج متاح للطلب الآن {hasDB() ? "" : "· (بيانات العرض — اربط Turso لإدارتها)"}</p>
          </div>
          <ProductGrid products={products} />
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <h2>أسئلة شائعة</h2>
            <p>وسيليا مستعدة ترد على أي سؤال تاني 💬</p>
          </div>
          <div style={{ display: "grid", gap: 10, maxWidth: 800, margin: "0 auto" }}>
            {faq.map((f, i) => (
              <details key={i} className="panel">
                <summary style={{ cursor: "pointer", fontWeight: 700 }}>{f.question}</summary>
                <p style={{ marginTop: 8, color: "var(--muted)" }}>{f.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
