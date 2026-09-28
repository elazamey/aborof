import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createClient } from "@libsql/client";
import { tmpdir } from "node:os";
import path from "node:path";
import { setDbClientForTest } from "../src/lib/db";

/**
 * End-to-end production-profile test against an isolated real libSQL database:
 * public catalog read -> validated order POST -> persisted order/items -> stock decrement.
 * No production endpoint, real secret, or external database is touched.
 */
test("production profile reads real products and persists an order atomically", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDatabaseUrl = process.env.TURSO_DATABASE_URL;
  const previousAuthToken = process.env.TURSO_AUTH_TOKEN;
  const databaseDirectory = fs.mkdtempSync(path.join(tmpdir(), "aborof-production-flow-"));
  const client = createClient({ url: `file:${path.join(databaseDirectory, "store.db")}` });

  Reflect.set(process.env, "NODE_ENV", "production");
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  setDbClientForTest(client);

  try {
    const { GET: getProducts } = await import("../src/app/api/products/route");
    const catalogResponse = await getProducts(new Request("http://test/api/products"));
    assert.equal(catalogResponse.status, 200);
    const catalog = (await catalogResponse.json()) as {
      products: { id: string; price: number; stock: number; old_price?: number | null }[];
    };
    const product = catalog.products.find((item) => item.id === "p1");
    assert.ok(product, "the real database catalog should contain p1");
    assert.ok(Object.prototype.hasOwnProperty.call(product, "old_price"));
    const initialStock = Number(product.stock);

    const { POST: createOrder } = await import("../src/app/api/orders/route");
    const orderResponse = await createOrder(
      new Request("http://test/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "192.0.2.100" },
        body: JSON.stringify({
          customer: "عميل اختبار",
          phone: "01095032221",
          address: "القاهرة - شارع الهرم - رقم 12",
          governorate: "القاهرة",
          note: "اختبار تكاملي محلي",
          payment: "vodafone_cash",
          transferRef: "",
          items: [{ id: "p1", qty: 1 }],
        }),
      })
    );
    assert.equal(orderResponse.status, 200);
    const order = (await orderResponse.json()) as { ok: boolean; id: string; subtotal: number; total: number };
    assert.equal(order.ok, true);
    assert.ok(order.id.startsWith("ORD-"));
    assert.equal(order.subtotal, Number(product.price ?? 180));

    const storedOrder = await client.execute({
      sql: "SELECT id, total FROM orders WHERE id = ?",
      args: [order.id],
    });
    assert.equal(storedOrder.rows.length, 1);
    const storedItems = await client.execute({
      sql: "SELECT product_id, qty FROM order_items WHERE order_id = ?",
      args: [order.id],
    });
    assert.equal(storedItems.rows.length, 1);
    assert.equal(String(storedItems.rows[0].product_id), "p1");
    assert.equal(Number(storedItems.rows[0].qty), 1);

    const updatedProduct = await client.execute({
      sql: "SELECT stock FROM products WHERE id = ?",
      args: ["p1"],
    });
    assert.equal(Number(updatedProduct.rows[0].stock), initialStock - 1);
  } finally {
    setDbClientForTest(null);
    await client.close();
    fs.rmSync(databaseDirectory, { recursive: true, force: true });
    if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", previousNodeEnv);
    if (previousDatabaseUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = previousDatabaseUrl;
    if (previousAuthToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
    else process.env.TURSO_AUTH_TOKEN = previousAuthToken;
  }
});
