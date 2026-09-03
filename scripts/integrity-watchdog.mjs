#!/usr/bin/env node
/**
 * Data Integrity Watchdog — YEAR-1-RELIABILITY #13.
 *
 * فحص يومي (أو عند الطلب) لـ invariants قاعدة البيانات:
 *   - stock < 0 (مخزون سالب)
 *   - طلبات بلا items أو items تالفة/فارغة
 *   - طلبات بلا total صالح
 *   - حالات طلب غير صالحة
 *   - مفاتيح idempotency مكررة
 *   - طلبات تشير لمنتجات غير موجودة (orphan refs)
 *   - إصدار schema != المطلوب
 *
 * الاستخدام:
 *   node scripts/integrity-watchdog.mjs --db /path/to/store.db
 *   أو عبر TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN للمواقع البعيدة).
 *
 * الخروج: 0 = سليم · 1 = انتهاك سلامة (يُنبَّه فورًا).
 */
import { createClient } from "@libsql/client";

const REQUIRED_SCHEMA_VERSION = 6; // طابق src/lib/migrations.ts (v1..v6)
const VALID_STATUSES = ["جديد", "قيد المراجعة", "مؤكد", "قيد الشحن", "مكتمل", "ملغى"];

function parseArgs() {
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf("--db");
  const db = dbIdx >= 0 ? args[dbIdx + 1] : process.env.TURSO_DATABASE_URL;
  if (!db) {
    console.error("usage: node scripts/integrity-watchdog.mjs --db <path-or-url>   (أو TURSO_DATABASE_URL)");
    process.exit(2);
  }
  const url = db.startsWith("file:") || db.startsWith("libsql:") ? db : `file:${db}`;
  return { url, authToken: process.env.TURSO_AUTH_TOKEN };
}

const { url, authToken } = parseArgs();
const client = createClient({ url, authToken });

const violations = [];
const checks = [];

function check(name, rows, describe) {
  const bad = rows.length;
  checks.push({ name, bad });
  if (bad > 0) {
    for (const row of rows.slice(0, 5)) violations.push(`  ${name}: ${describe(row)}`);
  }
  console.log(`${bad === 0 ? "✅" : "❌"} ${name} — ${bad}${bad > 0 ? " انتهاك" : ""}`);
}

async function main() {
  try {
    // 0) schema version
    try {
      const meta = await client.execute("SELECT version FROM schema_meta WHERE id=1");
      const version = Number(meta.rows[0]?.version ?? -1);
      check(
        "schema version == required",
        version === REQUIRED_SCHEMA_VERSION ? [] : [{ v: version }],
        (r) => `version=${r.v} (المطلوب ${REQUIRED_SCHEMA_VERSION})`
      );
    } catch {
      check("schema version readable", [{ e: "schema_meta missing" }], (r) => r.e);
    }

    // 1) negative stock
    const negStock = await client.execute("SELECT id, stock FROM products WHERE stock < 0 LIMIT 10");
    check("no negative stock", negStock.rows, (r) => `${r.id} stock=${r.stock}`);

    // 2) orders with missing/invalid items
    const orders = await client.execute("SELECT id, items, total, shipping_fee, status FROM orders");
    const invalidItems = [];
    const invalidTotal = [];
    const invalidStatus = [];
    for (const row of orders.rows) {
      let parsed = null;
      try {
        parsed = JSON.parse(String(row.items ?? ""));
      } catch {
        parsed = null;
      }
      if (!Array.isArray(parsed) || parsed.length === 0) invalidItems.push(row);
      if (row.total == null || Number(row.total) <= 0) invalidTotal.push(row);
      if (!VALID_STATUSES.includes(String(row.status))) invalidStatus.push(row);
    }
    check("orders have non-empty valid items", invalidItems, (r) => `${r.id}`);
    check("orders have a valid total > 0", invalidTotal, (r) => `${r.id} total=${r.total}`);
    check("orders have a valid status", invalidStatus, (r) => `${r.id} status=${r.status}`);

    // 3) duplicate idempotency keys
    const dupKeys = await client.execute(
      `SELECT idempotency_key, COUNT(*) c FROM orders
       WHERE idempotency_key IS NOT NULL AND idempotency_key != ''
       GROUP BY idempotency_key HAVING c > 1 LIMIT 10`
    );
    check(
      "no duplicate idempotency keys",
      dupKeys.rows,
      (r) => `key=${String(r.idempotency_key).slice(0, 30)} ×${r.c}`
    );

    // 4) orders referencing unknown products (orphan refs)
    const products = await client.execute("SELECT id FROM products");
    const known = new Set(products.rows.map((r) => String(r.id)));
    const orphanRefs = [];
    for (const row of orders.rows) {
      try {
        const items = JSON.parse(String(row.items ?? "[]"));
        for (const item of items) {
          if (item && item.id && !known.has(String(item.id))) {
            orphanRefs.push({ order: row.id, product: item.id });
            break;
          }
        }
      } catch {
        /* items invalid — covered above */
      }
    }
    check("no orders referencing unknown products", orphanRefs.slice(0, 10), (r) => `${r.order} → ${r.product}`);

    // 5) snapshot integrity: كل item في الطلب يحمل name/price/qty صحيحة (لا تعتمد على المنتج الحي)
    const badSnap = [];
    for (const row of orders.rows) {
      let items = [];
      try {
        items = JSON.parse(String(row.items ?? "[]"));
      } catch {
        continue; // items تالفة — مغطاة في فحص items
      }
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        const ok =
          it &&
          typeof it.name === "string" &&
          it.name.trim().length > 0 &&
          Number.isFinite(Number(it.price)) &&
          Number(it.price) >= 0 &&
          Number.isInteger(Number(it.qty)) &&
          Number(it.qty) >= 1;
        if (!ok) {
          badSnap.push({ order: row.id, item: JSON.stringify(it) });
          break;
        }
      }
    }
    check("orders keep full product snapshots (name/price/qty)", badSnap.slice(0, 10), (r) => `${r.order}: ${r.item}`);

    // 6) reconciliation مالي: order.total == Σ(items.price×qty) + shipping_fee
    const badTotal = [];
    for (const row of orders.rows) {
      let items = [];
      try {
        items = JSON.parse(String(row.items ?? "[]"));
      } catch {
        continue;
      }
      if (!Array.isArray(items)) continue;
      const subtotal = items.reduce((s, it) => s + Number(it?.price ?? 0) * Number(it?.qty ?? 0), 0);
      const expected = subtotal + Number(row.shipping_fee ?? 0);
      if (Math.abs(expected - Number(row.total)) > 0.001) {
        badTotal.push({ order: row.id, total: row.total, expected });
      }
    }
    check(
      "order totals reconcile: total == Σ(items) + shipping",
      badTotal.slice(0, 10),
      (r) => `${r.order} total=${r.total} expected=${r.expected}`
    );

    const total = checks.length;
    const bad = violations.length;
    console.log(`\n${"─".repeat(50)}`);
    if (bad === 0) {
      console.log(`✅ INTEGRITY OK — ${total}/${total} checks passed`);
    } else {
      console.log(`❌ INTEGRITY VIOLATION — ${bad} issue(s):`);
      console.log(violations.join("\n"));
    }
    console.log("─".repeat(50));
    process.exit(bad === 0 ? 0 : 1);
  } catch (error) {
    console.error("❌ watchdog failed:", error);
    process.exit(1);
  } finally {
    client.close();
  }
}

main();
