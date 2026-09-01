"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { addToCart } from "@/lib/cart";
import type { Product } from "@/lib/seed";

export default function AddButton({ product }: { product: Product }) {
  const [qty, setQty] = useState(1);
  const router = useRouter();
  const out = Number(product.stock) <= 0;
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      <div className="qty">
        <button onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
        <b>{qty}</b>
        <button onClick={() => setQty(qty + 1)}>+</button>
      </div>
      <button className="btn btn-primary" disabled={out} onClick={() => addToCart(product, qty)}>
        🛒 أضف للسلة
      </button>
      <button
        className="btn btn-gold"
        disabled={out}
        onClick={() => {
          addToCart(product, qty);
          router.push("/cart");
        }}
      >
        ⚡ اشترِ الآن
      </button>
    </div>
  );
}
