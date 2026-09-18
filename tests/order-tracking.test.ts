import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { tmpdir } from "node:os";
import path from "node:path";
import { setDbClientForTest } from "../src/lib/db";
import { runMigrations } from "../src/lib/db/migrate";
import { trackOrder } from "../src/lib/orders";

/**
 * تتبع الطلبات للعملاء — بشدّ أمني مقصود (docs/ai/phase-3-ux-roadmap.md):
 *  - النجاح يعمل فقط بعاملين معًا: رقم الطلب + آخر 4 أرقام من الهاتف.
 *  - الإخراج مبهم: الحالة + أسماء الأصناف بلا عنوان ولا هاتف كامل ولا أسعار.
 *  - رسالة الفشل واحدة موحّدة لا تكشف وجود الطلب من عدمه (يمنع تعداد الطلبات).
 */

const KEYS = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "ENABLE_ORDER_TRACKING"] as const;

function fileClient(): Client {
  const file = path.join(tmpdir(), `aborof-track-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return createClient({ url: `file:${file}` });
}

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

async function seedOrder(client: Client, id: string, phone: string) {
  await runMigrations(client);
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute({
    sql: `INSERT INTO orders (id,customer,phone,address,governorate,items,total,status)
          VALUES (?,?,?,?,?,?,?,?)`,
    args: [
      id,
      "عميل",
      phone,
      "عنوان تجريبي تفصيلي",
      "القاهرة",
      JSON.stringify([
        { id: "p1", name: "منتج تجريبي", price: 50, qty: 2 },
      ]),
      100,
      "جديد",
    ],
  });
}

describe("order tracking safe gate", () => {
  let client: Client;

  beforeEach(() => {
    client = fileClient();
  });

  test("disabled feature → uniform not-found message", async () => {
    setDbClientForTest(client);
    await seedOrder(client, "ORD-12345678-abcd1234", "01095032221");
    await assert.rejects(
      () => trackOrder({ id: "ORD-12345678-abcd1234", phoneLast4: "2221" }, false),
      (err: Error) => err.message.includes("تعذر العثور على الطلب")
    );
  });

  test("matching id + last 4 digits → obfuscated status, no PII, no prices", async () => {
    setDbClientForTest(client);
    await seedOrder(client, "ORD-99999999-abcd1234", "01095032221");

    const result = await trackOrder({ id: "ORD-99999999-abcd1234", phoneLast4: "2221" }, true);

    assert.equal(result.id, "ORD-99999999-abcd1234");
    assert.equal(result.status, "جديد");
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].name, "منتج تجريبي");
    assert.equal(result.items[0].qty, 2);
    // لا هاتف كامل ولا عنوان ولا أسعار مفصلة في المخرجات.
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("01095032221"));
    assert.ok(!serialized.includes("عنوان"));
    assert.ok(!serialized.includes("price"));
  });

  test("wrong last 4 digits → same uniform message, no existence leak", async () => {
    setDbClientForTest(client);
    await seedOrder(client, "ORD-88888888-eeee8888", "01095032221");

    // رسالة موحّدة لا تفرّق بين "غير موجود" و"غير مطابق" ولا تكشف أي بيانات.
    await assert.rejects(
      () => trackOrder({ id: "ORD-88888888-eeee8888", phoneLast4: "1111" }, true),
      (err: Error) => err.message === "تعذر العثور على الطلب"
    );

    await assert.rejects(
      () => trackOrder({ id: "ORD-does-not-exist", phoneLast4: "1111" }, true),
      (err: Error) => err.message === "تعذر العثور على الطلب"
    );
  });
});

describe("trackOrder contract hygiene", () => {
  test("unknown order id returns the exact uniform message", async () => {
    const client = fileClient();
    setDbClientForTest(client);
    await runMigrations(client);
    await assert.rejects(
      () => trackOrder({ id: "ORD-00000000-00000000", phoneLast4: "0000" }, true),
      (err: Error) => err.message === "تعذر العثور على الطلب"
    );
  });
});
