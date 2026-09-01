"use client";
import { useEffect, useState } from "react";
import type { Product } from "@/lib/seed";

export type CartItem = { id: string; name: string; price: number; image: string; qty: number };
const KEY = "azzami_cart";

export function readCart(): CartItem[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}
export function writeCart(items: CartItem[]) {
  localStorage.setItem(KEY, JSON.stringify(items));
  window.dispatchEvent(new Event("cart-updated"));
}
export function addToCart(p: Product, qty = 1) {
  const items = readCart();
  const i = items.findIndex((x) => x.id === String(p.id));
  if (i > -1) items[i].qty += qty;
  else items.push({ id: String(p.id), name: p.name, price: Number(p.price), image: p.image, qty });
  writeCart(items);
}
export function useCart() {
  const [items, setItems] = useState<CartItem[]>([]);
  useEffect(() => {
    const sync = () => setItems(readCart());
    sync();
    window.addEventListener("cart-updated", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("cart-updated", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const count = items.reduce((n, i) => n + i.qty, 0);
  const subtotal = items.reduce((n, i) => n + i.qty * i.price, 0);
  return { items, count, subtotal, setQty, remove, clear };

  function setQty(id: string, qty: number) {
    const next = readCart().map((i) => (i.id === id ? { ...i, qty: Math.max(1, qty) } : i));
    writeCart(next);
  }
  function remove(id: string) {
    writeCart(readCart().filter((i) => i.id !== id));
  }
  function clear() {
    writeCart([]);
  }
}
