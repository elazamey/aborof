import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { tmpdir } from "node:os";
import path from "node:path";
import { setDbClientForTest } from "../src/lib/db";
import { runMigrations } from "../src/lib/db/migrate";
import { createOrder } from "../src/lib/orders";
import { createOrderContract } from "../src/lib/validation/contracts";
import type { Product } from "../src/lib/seed";

/**
 * D-2 — لا يوجد idempotency key، فالضغط المزدوج يُنشئ طلبين.
 *
 * قيس قبل الإصلاح: نقرتان على «تأكيد الطلب» → طلبان بـ ORD- مختلفين،
 * والمخزون 10 → 8 بدل 10 → 9. هذا عيب تجاري لا عيب تقني: العميل يُخصم منه
 * مرتان، والإدارة ترى طلبين لسلعة واحدة.
 *
 * الإصلاح: `client_ref` يولّده العميل لكل محاولة دفع، وفهرس فريد على
 * (phone, client_ref) يجعل الثانية مستحيلة على مستوى القاعدة. والدالة تعيد
 * الطلب الأول بدل رمي خطأ، فالعميل ضغط مرة واحدة ويجب أن يرى طلبًا واحدًا.
 */

const KEYS = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"] as const;

function fileClient(): Client {
  const file = path.join(
    tmpdir(),
    `aborof-idem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  return createClient({ url: `file:${file}` });
}

/** كتالوج ثابت: صنف واحد بمخزون معروف حتى يُقاس الخصم بدقة. */
const CATALOG: Product[] = [
  {
    id: "p1",
    name: "منظف أرضيات برائحة اللافندر 5 لتر",
    description: "وصف",
    price: 180,
    category: "أرضيات",
    image: "🧴",
    stock: 10,
  },
];

function payload(clientRef?: string, qty = 1) {
  const base = {
    customer: "احمد محمد",
    phone: "01000000000",
    address: "شارع التحرير 1",
    governorate: "القاهرة",
    payment: "vodafone_cash" as const,
    items: [{ id: "p1", qty }],
  };
  const parsed = createOrderContract.safeParse(
    clientRef === undefined ? base : { ...base, clientRef }
  );
  if (!parsed.success) throw new Error(`عقد غير صالح: ${parsed.error.issues[0].message}`);
  return parsed.data;
}

async function stockOf(client: Client, id = "p1"): Promise<number> {
  const r = await client.execute({ sql: "SELECT stock FROM products WHERE id=?", args: [id] });
  return Number(r.rows[0]?.stock);
}

async function orderCount(client: Client): Promise<number> {
  const r = await client.execute("SELECT COUNT(*) n FROM orders");
  return Number(r.rows[0]?.n);
}

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

async function freshDb(stock = 10): Promise<Client> {
  const client = fileClient();
  setDbClientForTest(client);
  await runMigrations(client);
  await client.execute("PRAGMA foreign_keys = ON");
  // المنتجات تُزرع مباشرة بدل الاعتماد على ensureSchema، حتى يكون المخزون
  // مضبوطًا بدقة قبل القياس.
  for (const p of CATALOG) {
    await client.execute({
      sql: `INSERT OR REPLACE INTO products (id,name,description,price,category,image,stock)
            VALUES (?,?,?,?,?,?,?)`,
      args: [p.id, p.name, p.description, p.price, p.category, p.image, stock],
    });
  }
  return client;
}

describe("D-2: idempotent order creation", () => {
  test("submitting the same key twice creates ONE order and deducts stock ONCE", async () => {
    const client = await freshDb(10);
    const input = payload("aaaaaaaa-bbbb-cccc");

    const first = await createOrder(input, CATALOG);
    const second = await createOrder(input, CATALOG);

    assert.equal(await orderCount(client), 1, "يجب أن يوجد طلب واحد لا اثنان");
    assert.equal(second.id, first.id, "المرة الثانية يجب أن تعيد نفس الطلب");
    assert.equal(second.total, first.total);
    assert.equal(await stockOf(client), 9, "المخزون 10 → 9، لا 10 → 8");
  });

  test("three retries still yield one order", async () => {
    const client = await freshDb(10);
    const input = payload("retry-key-0001");

    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) ids.add((await createOrder(input, CATALOG)).id);

    assert.equal(ids.size, 1, "ثلاث محاولات → معرّف واحد");
    assert.equal(await orderCount(client), 1);
    assert.equal(await stockOf(client), 9);
  });

  test("different keys are genuinely different orders", async () => {
    const client = await freshDb(10);

    const a = await createOrder(payload("key-one-000001"), CATALOG);
    const b = await createOrder(payload("key-two-000002"), CATALOG);

    assert.notEqual(a.id, b.id, "مفتاحان مختلفان = طلبان مختلفان");
    assert.equal(await orderCount(client), 2);
    assert.equal(await stockOf(client), 8, "كل طلب يخصم مرة واحدة");
  });

  test("the same key from a different phone is a different order", async () => {
    const client = await freshDb(10);
    // لو كان المفتاح عامًّا لاستطاع من يخمّن مرجع عميل آخر استعادة طلبه.
    const a = createOrderContract.parse({
      customer: "احمد محمد",
      phone: "01000000000",
      address: "شارع التحرير 1",
      governorate: "القاهرة",
      items: [{ id: "p1", qty: 1 }],
      clientRef: "shared-key-0001",
    });
    const b = createOrderContract.parse({ ...a, phone: "01111111111", customer: "منى علي" });

    const ra = await createOrder(a, CATALOG);
    const rb = await createOrder(b, CATALOG);

    assert.notEqual(ra.id, rb.id, "المفتاح مرتبط بالهاتف لا عامًّا");
    assert.equal(await orderCount(client), 2);
  });

  test("replayed order returns the ORIGINAL totals, not recomputed ones", async () => {
    const client = await freshDb(10);
    const input = payload("totals-key-0001");

    const first = await createOrder(input, CATALOG);
    // لو تغيّر السعر بين المحاولتين، فالإعادة يجب أن تعيد إجمالي الطلب
    // الأصلي — لا إعادة حساب من الكتالوج الحالي.
    const repriced = CATALOG.map((p) => ({ ...p, price: p.price * 2 }));
    const second = await createOrder(input, repriced);

    assert.equal(second.total, first.total, "الإجمالي المعاد هو الأصلي");
    assert.equal(second.subtotal, first.subtotal);
  });

  test("a client that sends no key still works (backwards compatible)", async () => {
    const client = await freshDb(10);
    const legacy = payload(undefined);

    assert.equal(legacy.clientRef, "", "غياب الحقل يتحول إلى سلسلة فارغة");
    const a = await createOrder(legacy, CATALOG);
    const b = await createOrder(legacy, CATALOG);

    // السلوك القديم محفوظ: بلا مفتاح لا dedup — وهذا مقصود، فلا يُكسر عميل قديم.
    assert.notEqual(a.id, b.id);
    assert.equal(await orderCount(client), 2);
    assert.equal(await stockOf(client), 8);
  });

  test("two empty-key orders are both allowed (partial unique index)", async () => {
    const client = await freshDb(10);
    // الفهرس جزئي WHERE client_ref <> '' — وإلا رُفض ثاني طلب فارغ المرجع
    // في القاعدة كلها، فكان ذلك كسرًا للتوافق مع العميل القديم.
    await createOrder(payload(undefined), CATALOG);
    await createOrder(payload(undefined), CATALOG);
    assert.equal(await orderCount(client), 2);
  });

  test("stock is never over-deducted when the replay is rejected", async () => {
    const client = await freshDb(3);
    const input = payload("oversell-key-01", 2);

    await createOrder(input, CATALOG);
    await createOrder(input, CATALOG); // إعادة — يجب ألا تخصم
    assert.equal(await stockOf(client), 1, "3 − 2 = 1، لا 3 − 4");
  });

  test("a genuinely new order after a successful one still deducts", async () => {
    const client = await freshDb(10);
    await createOrder(payload("first-key-000001"), CATALOG);
    // بعد النجاح يصفّر العميل المفتاح، فالطلب التالي جديد فعلًا.
    await createOrder(payload("second-key-00002"), CATALOG);
    assert.equal(await stockOf(client), 8);
    assert.equal(await orderCount(client), 2);
  });

  test("invariants hold: no orphan items, no negative stock", async () => {
    const client = await freshDb(10);
    const input = payload("invariant-key-01");
    await createOrder(input, CATALOG);
    await createOrder(input, CATALOG);
    await createOrder(payload("other-key-000001"), CATALOG);

    const orphans = await client.execute(
      "SELECT COUNT(*) n FROM order_items WHERE order_id NOT IN (SELECT id FROM orders)"
    );
    const negative = await client.execute("SELECT COUNT(*) n FROM products WHERE stock < 0");
    assert.equal(Number(orphans.rows[0]?.n), 0, "لا سجلات يتيمة");
    assert.equal(Number(negative.rows[0]?.n), 0, "لا مخزون سالب");
  });
});

describe("D-2: contract rejects hostile idempotency keys", () => {
  test("SQL-ish and oversized keys are refused", () => {
    const hostile = [
      "abc'); DROP TABLE orders;--",
      "a".repeat(65),
      "short",
      "key with spaces",
      "مفتاح-عربي",
    ];
    for (const clientRef of hostile) {
      const r = createOrderContract.safeParse({
        customer: "احمد محمد",
        phone: "01000000000",
        address: "شارع التحرير 1",
        governorate: "القاهرة",
        items: [{ id: "p1", qty: 1 }],
        clientRef,
      });
      assert.equal(r.success, false, `يجب رفض: ${JSON.stringify(clientRef)}`);
    }
  });

  test("a well-formed key passes through unchanged", () => {
    const r = createOrderContract.parse({
      customer: "احمد محمد",
      phone: "01000000000",
      address: "شارع التحرير 1",
      governorate: "القاهرة",
      items: [{ id: "p1", qty: 1 }],
      clientRef: "a1b2c3d4e5f6a7b8",
    });
    assert.equal(r.clientRef, "a1b2c3d4e5f6a7b8");
  });
});
