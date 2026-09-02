import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createOrderContract,
  productUpsertContract,
  orderStatusContract,
  adminLoginContract,
  chatRequestContract,
  passwordPolicy,
  ORDER_STATUSES,
} from "../src/lib/validation/contracts";

const validOrder = {
  customer: "محمد أحمد",
  phone: "01095032221",
  address: "القاهرة - شارع الهرم - رقم 12",
  governorate: "القاهرة",
  note: "",
  payment: "vodafone_cash",
  transferRef: "",
  items: [{ id: "p1", qty: 2 }],
};

describe("validation contracts", () => {
  test("valid order passes", () => {
    const r = createOrderContract.safeParse(validOrder);
    assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues));
  });

  test("rejects unknown fields (strict) on sensitive write operations", () => {
    const r = createOrderContract.safeParse({ ...validOrder, tenantId: "evil", isAdmin: true });
    assert.equal(r.success, false);
    const r2 = productUpsertContract.safeParse({
      product: { name: "منتج", price: 10, stock: 5 },
      role: "admin",
    });
    assert.equal(r2.success, false);
  });

  test("order item quantities bounded 1..100", () => {
    assert.equal(createOrderContract.safeParse({ ...validOrder, items: [{ id: "p1", qty: 0 }] }).success, false);
    assert.equal(createOrderContract.safeParse({ ...validOrder, items: [{ id: "p1", qty: 101 }] }).success, false);
    assert.equal(createOrderContract.safeParse({ ...validOrder, items: new Array(51).fill({ id: "p1", qty: 1 }) }).success, false);
  });

  test("financial and stock limits enforced", () => {
    const ok = productUpsertContract.safeParse({ product: { name: "منتج", price: 1000000, stock: 0 } });
    assert.ok(ok.success);
    assert.equal(productUpsertContract.safeParse({ product: { name: "x", price: -1, stock: 1 } }).success, false);
    assert.equal(productUpsertContract.safeParse({ product: { name: "x", price: 1_000_001, stock: 1 } }).success, false);
    assert.equal(productUpsertContract.safeParse({ product: { name: "x", price: 10, stock: -1 } }).success, false);
  });

  test("order status must be one of the allowed enum values", () => {
    for (const status of ORDER_STATUSES) {
      assert.equal(orderStatusContract.safeParse({ id: "ORD-12345678-abcd1234", status }).success, true);
    }
    assert.equal(orderStatusContract.safeParse({ id: "ORD-12345678-abcd1234", status: "مخترق" }).success, false);
  });

  test("payment must be a known method", () => {
    assert.equal(createOrderContract.safeParse({ ...validOrder, payment: "bitcoin" }).success, false);
  });

  test("chat message length and count bounded", () => {
    assert.equal(chatRequestContract.safeParse({ messages: [] }).success, true);
    assert.equal(
      chatRequestContract.safeParse({ messages: [{ role: "user", content: "x".repeat(2001) }] }).success,
      false
    );
    assert.equal(chatRequestContract.safeParse({ messages: [{ role: "admin", content: "hi" }] }).success, false);
  });

  test("password policy: minimum 12 characters, testable and consistent", () => {
    assert.equal(passwordPolicy.safeParse("short").success, false);
    assert.equal(passwordPolicy.safeParse("12345678901").success, false);
    assert.equal(passwordPolicy.safeParse("123456789012").success, true);
  });

  test("login accepts an existing strong password but contract only requires non-empty", () => {
    assert.equal(adminLoginContract.safeParse({ password: "x".repeat(20) }).success, true);
    assert.equal(adminLoginContract.safeParse({ password: "" }).success, false);
    assert.equal(adminLoginContract.safeParse({ password: "x", extra: 1 }).success, false);
  });

  test("old_price cannot be less than price when provided", () => {
    const r = productUpsertContract.safeParse({ product: { name: "منتج", price: 100, old_price: 50, stock: 1 } });
    assert.equal(r.success, false);
    const ok = productUpsertContract.safeParse({ product: { name: "منتج", price: 100, old_price: 150, stock: 1 } });
    assert.ok(ok.success);
  });
});
