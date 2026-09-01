import { describe, it, expect } from "vitest";
import { calculateShipping, SHIPPING_RATES, GOVERNORATES } from "@/lib/shipping";

describe("shipping (shipping.ts)", () => {
  it("free shipping at/above the threshold and for empty carts", () => {
    expect(calculateShipping("القاهرة", 1000, 1000)).toBe(0);
    expect(calculateShipping("أسوان", 1500, 1000)).toBe(0);
    expect(calculateShipping("القاهرة", 0, 1000)).toBe(0);
    expect(calculateShipping("القاهرة", -5, 1000)).toBe(0);
  });

  it("charges the governorate rate below the threshold", () => {
    expect(calculateShipping("القاهرة", 500, 1000)).toBe(50);
    expect(calculateShipping("الجيزة", 999, 1000)).toBe(50);
    expect(calculateShipping("أسوان", 999, 1000)).toBe(120);
    expect(calculateShipping("شمال سيناء", 999, 1000)).toBe(120);
  });

  it("falls back to a default rate for unknown governorates", () => {
    expect(calculateShipping("دولة خارجية", 500, 1000)).toBe(100);
  });

  it("respects a custom free-shipping threshold", () => {
    expect(calculateShipping("القاهرة", 800, 800)).toBe(0);
    expect(calculateShipping("القاهرة", 799, 800)).toBe(50);
  });

  it("GOVERNORATES matches the rates table exactly", () => {
    expect(GOVERNORATES).toEqual(Object.keys(SHIPPING_RATES));
    for (const g of GOVERNORATES) {
      expect(SHIPPING_RATES[g]).toBeGreaterThan(0);
    }
  });
});
