import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MAX_PRODUCT_CARDS, extractProductCards } from "../src/lib/ai/cards";

/**
 * حراسة البطاقات: المحتوى المنظّم القادم من الأدوات يُنقّى بعقد صارم قبل أن
 * يصل للمتصفح، فلا حقول إضافية ولا قيم غير صالحة ولا عدد مفتوح.
 */

const valid = {
  id: "p1",
  name: "منظف أرضيات لافندر",
  price: 180,
  old_price: 220,
  category: "منظفات أرضيات",
  image: "🧴",
  stock: 40,
};

describe("product card extraction", () => {
  test("accepts a well-formed products payload", () => {
    const cards = extractProductCards([{ kind: "products", products: [valid] }]);
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0], valid);
  });

  test("ignores unknown kinds and malformed payloads", () => {
    assert.deepEqual(extractProductCards([]), []);
    assert.deepEqual(extractProductCards([{ kind: "orders", products: [valid] }]), []);
    assert.deepEqual(extractProductCards([{ products: [valid] }]), []);
    assert.deepEqual(extractProductCards([{ kind: "products", products: "not-an-array" }]), []);
  });

  test("rejects cards with extra fields or invalid values", () => {
    const withExtra = { ...valid, injected: "<script>alert(1)</script>" };
    assert.deepEqual(extractProductCards([{ kind: "products", products: [withExtra] }]), []);

    const negative = { ...valid, price: -5 };
    assert.deepEqual(extractProductCards([{ kind: "products", products: [negative] }]), []);

    const emptyName = { ...valid, name: "" };
    assert.deepEqual(extractProductCards([{ kind: "products", products: [emptyName] }]), []);
  });

  test("deduplicates by id and caps the number of cards", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...valid, id: `p${i}` }));
    const cards = extractProductCards([{ kind: "products", products: [...many, valid, valid] }]);
    assert.equal(cards.length, MAX_PRODUCT_CARDS);
    assert.deepEqual(
      cards.map((c) => c.id),
      ["p0", "p1", "p2"]
    );
  });
});
