import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectedMigrations } from "../scripts/lib/migration-checksums.mjs";
import { MIGRATIONS, runMigrations } from "../src/lib/db/migrate";
import * as schema from "../src/lib/db/schema";
import { getDrizzle, resetDrizzleForTest } from "../src/lib/db/drizzle";
import { setDbClientForTest } from "../src/lib/db";

function fileClient(): Client {
  const file = path.join(
    tmpdir(),
    `aborof-drizzle-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  return createClient({ url: `file:${file}` });
}

describe("drizzle schema — طبقة شفافة لا تكسر بوابة الهجرات", () => {
  test("expectedMigrations = 0001+0002+0003+0004 ببصمات ثابتة (sha256)", () => {
    const expected = expectedMigrations(process.cwd());
    assert.equal(expected.length, 4, "الهجرات: initial + search_fts5 + rbac (M1) + celia_tokens");
    assert.equal(expected[0].version, "0001");
    assert.equal(expected[0].name, "initial");
    assert.equal(expected[1].version, "0002");
    assert.equal(expected[1].name, "search_fts5");
    // 0003 هي هجرة RBAC الحقيقية (M1) — وترقيم handoff لا يُحتسب هجرة أبدًا.
    assert.equal(expected[2].version, "0003");
    // 0004 هي هجرة توكنات سيليا المُدارة (CeliaTokenManager).
    assert.equal(expected[3].version, "0004");
    assert.equal(expected[2].name, "rbac");
    // كل بصمة 64 حرف hex
    for (const m of expected) {
      assert.match(m.checksum, /^[a-f0-9]{64}$/, `checksum ${m.version} يجب أن يكون 64 hex`);
    }
    // تطابق مع MIGRATIONS المحمّلة في runMigrations (نفس الخوارزمية: \"\\n\"+sql+\"\\n\")
    assert.equal(MIGRATIONS.length, expected.length);
    assert.equal(MIGRATIONS[0].version, expected[0].version);
    assert.equal(MIGRATIONS[1].version, expected[1].version);
    assert.equal(MIGRATIONS[2].version, expected[2].version);
    assert.equal(MIGRATIONS[3].version, expected[3].version);
    // حدّ موثَّق: 0004 (celia_tokens) هي آخر هجرة معروفة — أي هجرة 0005 في
    // المستقبل تحتاج تحديث هذا الاختبار صراحةً (حاجز واعٍ لا انزلاق تلقائي).
    const versions = expected.map((m) => m.version);
    assert.deepEqual(versions, ["0001", "0002", "0003", "0004"]);
    assert.ok(!versions.includes("0005"), "لا وجود لـ 0005 — حدّث هذا الاختبار عند إضافة هجرة جديدة");
  });

  test("schema يصدّر 11 جدولًا (بدون FTS5 الافتراضي)", () => {
    const keys = Object.keys(schema.schema);
    assert.deepEqual(keys.sort(), [
      "adminAuditLog",
      "celiaTokens",
      "chatLogs",
      "faq",
      "orderItems",
      "orders",
      "products",
      "rateLimitCounters",
      "rbacRoles",
      "rbacUsers",
      "schemaMigrations",
    ].sort());
    // كل جدول يملك تعريف أعمدة
    assert.ok(schema.products, "products موجود");
    assert.ok(schema.orders, "orders موجود");
    assert.ok(schema.orderItems, "orderItems موجود");
    assert.ok(schema.faq, "faq موجود");
    assert.ok(schema.chatLogs, "chatLogs موجود");
    assert.ok(schema.adminAuditLog, "adminAuditLog موجود");
    assert.ok(schema.rateLimitCounters, "rateLimitCounters موجود");
    // لوحة الصلاحيات (هجرة 0003): الأدوار محصّنة والدور مفتاح خارجي على المستخدم.
    assert.ok(schema.rbacRoles, "rbacRoles موجود");
    assert.ok(schema.rbacUsers, "rbacUsers موجود");
    assert.ok(schema.schemaMigrations, "schemaMigrations موجود");
  });

  test("Drizzle يلتفّ حول نفس Client ولا يُنشئ اتصالًا جديدًا", async () => {
    const client = fileClient();
    setDbClientForTest(client);
    resetDrizzleForTest();
    await runMigrations(client);
    const d1 = getDrizzle();
    const d2 = getDrizzle();
    assert.ok(d1, "getDrizzle يعيد نسخة عند وجود Client");
    assert.equal(d1, d2, "نفس النسخة تُعاد (cache) ما دام نفس Client");
    // إلغاء الحقن يعيد null
    setDbClientForTest(null);
    resetDrizzleForTest();
    const d3 = getDrizzle();
    // بدون TURSO_DATABASE_URL وبدون حقن → null (نفس سلوك db())
    // في بيئة الاختبار لا يوجد متغير بيئة، لذا null
    assert.equal(d3, null);
  });

  test("Drizzle يقرأ الكتالوج عبر نفس الهجرات (runMigrations هي البوابة)", async () => {
    const client = fileClient();
    setDbClientForTest(client);
    resetDrizzleForTest();
    const before = getDrizzle();
    assert.ok(before, "Drizzle جاهز قبل الهجرات (Client موجود)");
    await runMigrations(client);
    const d = getDrizzle();
    assert.ok(d, "Drizzle جاهز بعد الهجرات");
    // قراءة عبر Drizzle
    const rows = await d!.select().from(schema.products);
    assert.equal(rows.length, 0, "كتالوج فارغ بعد الهجرة قبل البذرة");
    // كتابة عبر Drizzle ثم قراءة
    await d!.insert(schema.products).values({
      id: "p-drizzle-1",
      name: "منتج Drizzle",
      description: "وصف",
      price: 123,
      category: "test",
      image: "🧴",
      stock: 5,
      featured: 0,
    });
    const after = await d!.select().from(schema.products);
    assert.equal(after.length, 1);
    assert.equal(after[0].id, "p-drizzle-1");
    assert.equal(after[0].price, 123);
    // تنظيف
    setDbClientForTest(null);
    resetDrizzleForTest();
  });

  test("runMigrations تطبّق 0001+0002+0003+0004 وتنشئ الفهارس (idempotent)", async () => {
    const client = fileClient();
    const first = await runMigrations(client);
    assert.ok(first.applied.includes("0001"));
    assert.ok(first.applied.includes("0002"));
    assert.ok(first.applied.includes("0003"));
    assert.ok(first.applied.includes("0004"));
    // الفهارس موجودة
    const idx = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_order_items_order','idx_orders_created','idx_rate_limit_reset')"
    );
    const names = idx.rows.map((r) => String((r as unknown as { name: string }).name)).sort();
    assert.deepEqual(names, ["idx_order_items_order", "idx_orders_created", "idx_rate_limit_reset"].sort());
    const second = await runMigrations(client);
    assert.deepEqual(second.applied, [], "إعادة التشغيل لا تطبّق شيئًا");
  });

  test("product_search يبقى افتراضيًا (FTS5) ولا يُمثَّل في Drizzle schema", () => {
    // التأكد أن schema لا يحتوي على product_search كجدول عادي
    assert.equal((schema.schema as unknown as Record<string, unknown>)["product_search"], undefined);
    // لكن الهجرة 0002 تنشئ VIRTUAL TABLE — نتحقق عبر runMigrations
    // (يُفحص في ensureProductSearchInSync، لا هنا)
  });
});

describe("drizzle config — لا يمسّ src/lib/db/migrations", () => {
  test("drizzle.config.ts يشير إلى schema الصحيح و out منفصل", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const configPath = path.join(process.cwd(), "drizzle.config.ts");
    assert.ok(fs.existsSync(configPath), "drizzle.config.ts موجود");
    const content = fs.readFileSync(configPath, "utf8");
    assert.match(content, /schema:\s*["']\.\/src\/lib\/db\/schema\.ts["']/);
    assert.match(content, /out:\s*["']\.\/src\/lib\/db\/drizzle["']/);
    assert.match(content, /dialect:\s*["']turso["']/);
    // لا يشير إلى src/lib/db/migrations إطلاقًا
    assert.ok(!content.includes("src/lib/db/migrations"), "لا يمسّ مجلد الهجرات الحتمي");
  });
});
