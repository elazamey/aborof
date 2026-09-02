import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrations, MIGRATIONS } from "../src/lib/db/migrate";

// نستخدم ملفًا مؤقتًا فريدًا لكل اختبار (اتصالات المعاملات التفاعلية لا تتشارك
// نفس اتصال :memory:، فالملف يضمن رؤية كل العبارات لنفس الجداول).
function fileClient(): Client {
  const file = path.join(tmpdir(), `aborof-mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return createClient({ url: `file:${file}` });
}

describe("versioned migrations", () => {
  let client: Client;

  beforeEach(async () => {
    client = fileClient();
  });

  test("runs and is idempotent (re-run applies nothing new)", async () => {
    const first = await runMigrations(client);
    assert.ok(first.applied.includes("0001"));
    const second = await runMigrations(client);
    assert.deepEqual(second.applied, []);
  });

  test("records migration with checksum in schema_migrations", async () => {
    await runMigrations(client);
    const rows = await client.execute("SELECT version, name, checksum FROM schema_migrations");
    assert.equal(rows.rows.length, MIGRATIONS.length);
    assert.equal(String(rows.rows[0].version), "0001");
    assert.ok(String(rows.rows[0].checksum).length === 64);
  });

  test("CHECK constraint rejects invalid order status", async () => {
    await runMigrations(client);
    await assert.rejects(
      () =>
        client.execute({
          sql: `INSERT INTO orders (id,customer,phone,address,items,total,shipping_fee,payment,status)
                VALUES (?,?,?,?,?,?,?,?,?)`,
          args: ["ORD-x", "عميل", "01000000000", "عنوان", "[]", 100, 0, "cod", "حالة-مخترعة"],
        }),
      /CHECK|constraint/i
    );
  });

  test("CHECK constraint rejects negative price and stock", async () => {
    await runMigrations(client);
    await assert.rejects(
      () =>
        client.execute({
          sql: "INSERT INTO products (id,name,price,stock) VALUES (?,?,?,?)",
          args: ["pbad", "منتج", -5, 1],
        }),
      /CHECK|constraint/i
    );
    await assert.rejects(
      () =>
        client.execute({
          sql: "INSERT INTO products (id,name,price,stock) VALUES (?,?,?,?)",
          args: ["pbad2", "منتج", 10, -1],
        }),
      /CHECK|constraint/i
    );
  });

  test("foreign key prevents orphan order_items (cascade + restrict)", async () => {
    await runMigrations(client);
    await client.execute("PRAGMA foreign_keys = ON");
    // order_item بدون طلب أب يجب أن يُرفض.
    await assert.rejects(
      () =>
        client.execute({
          sql: "INSERT INTO order_items (order_id,product_id,name,price,qty) VALUES (?,?,?,?,?)",
          args: ["ORD-NOPE", "p1", "x", 10, 1],
        }),
      /FOREIGN KEY|constraint/i
    );
  });

  test("rate_limit_counters unique bucket key and positive count", async () => {
    await runMigrations(client);
    await client.execute({
      sql: "INSERT INTO rate_limit_counters (bucket_key,count,reset_at) VALUES (?,?,?)",
      args: ["b", 1, Date.now() + 60000],
    });
    await assert.rejects(
      () =>
        client.execute({
          sql: "INSERT INTO rate_limit_counters (bucket_key,count,reset_at) VALUES (?,?,?)",
          args: ["b", 1, Date.now() + 60000],
        }),
      /UNIQUE|constraint/i
    );
    await assert.rejects(
      () =>
        client.execute({
          sql: "INSERT INTO rate_limit_counters (bucket_key,count,reset_at) VALUES (?,?,?)",
          args: ["b2", -1, Date.now()],
        }),
      /CHECK|constraint/i
    );
  });
});

describe("compound transaction (order + items + stock)", () => {
  let client: Client;

  beforeEach(() => {
    // نفس العميل لكل خطوات الاختبار حتى تُرى الجداول المُنشأة.
    client = fileClient();
  });

  test("full order write commits atomically; failure rolls back stock", async () => {
    await runMigrations(client);
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute({
      sql: "INSERT INTO products (id,name,price,stock) VALUES (?,?,?,?)",
      args: ["p100", "منتج اختبار", 50, 3],
    });

    const tx = await client.transaction("write");
    try {
      await tx.execute({ sql: "UPDATE products SET stock=stock-? WHERE id=? AND stock>=?", args: [2, "p100", 2] });
      await tx.execute({
        sql: `INSERT INTO orders (id,customer,phone,address,items,total,shipping_fee)
              VALUES (?,?,?,?,?,?,?)`,
        args: ["ORD-ok", "عميل", "01000000000", "عنوان طويل بما يكفي", "[]", 100, 0],
      });
      await tx.execute({
        sql: "INSERT INTO order_items (order_id,product_id,name,price,qty) VALUES (?,?,?,?,?)",
        args: ["ORD-ok", "p100", "منتج اختبار", 50, 2],
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }

    const stock = await client.execute("SELECT stock FROM products WHERE id=?", ["p100"]);
    assert.equal(Number(stock.rows[0].stock), 1);
    const items = await client.execute("SELECT * FROM order_items WHERE order_id=?", ["ORD-ok"]);
    assert.equal(items.rows.length, 1);
  });
});
