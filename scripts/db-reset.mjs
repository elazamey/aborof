#!/usr/bin/env node
/**
 * إعادة قاعدة البيانات إلى حالة البذرة.
 *
 *   npm run db:reset            → فحص جاف: يعرض الانحراف ولا يغيّر شيئًا
 *   npm run db:reset -- --apply → ينفّذ الإعادة فعليًا
 *   npm run db:reset -- --apply --keep-orders → يعيد المخزون فقط ويُبقي الطلبات
 *
 * لماذا يوجد هذا السكربت: مختبر What-If (`whatif/run-whatif.mjs`) يكتب طلبات
 * حقيقية في `local.db` عن قصد — هذا ما يجعل الأدلة حقيقية لا مُحاكاة. لكن بعد
 * عشرات الجولات يبقى أثر: مخزون مُنزَف وطلبات اختبار في لوحة الإدارة. المتجر
 * الذي يُفتح بعدها لا يطابق حالته الأصلية، فيُستخدم هذا السكربت قبل أي عرض.
 *
 * ما يعيده:
 *   • `stock` لكل صنف إلى قيمة `SEED_PRODUCTS` (المصدر الوحيد للحقيقة).
 *   • حذف الطلبات وأصنافها — إلا مع `--keep-orders`.
 *
 * ما لا يلمسه: الأسعار والأسماء والتصنيفات (قد تكون الإدارة عدّلتها عمدًا)،
 * وجدول `faq`، وسجلات التدقيق، وجدول البحث `product_search` — لأنه لا يخزّن
 * المخزون أصلًا (أعمدته `id, name, description, category` فقط)، فلا يُصبح
 * قديمًا بإعادة المخزون.
 *
 * كود الخروج: 0 = نجح، 1 = فشل، 2 = انحراف موجود في الفحص الجاف.
 */
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const apply = process.argv.includes("--apply");
const keepOrders = process.argv.includes("--keep-orders");

const url = process.env.TURSO_DATABASE_URL ?? "file:local.db";

/**
 * قراءة `SEED_PRODUCTS` من مصدر TypeScript كنصّ ثم استخراجها.
 *
 * لا يمكن لملف `.mjs` أن يستورد وحدة `.ts` مباشرة، والحلّ الأسوأ أن تُنسخ
 * القائمة هنا فتصير نسختين من الحقيقة تنفصلان مع الوقت. لذا تُقرأ القيم من
 * الملف نفسه، ويفشل السكربت صراحةً إن لم يجد كل صنف — فالصمت هنا أخطر من
 * التوقّف.
 */
function readSeedProducts() {
  const src = readFileSync(join(ROOT, "src/lib/seed.ts"), "utf8");
  const block = src.match(/export const SEED_PRODUCTS[^=]*=\s*(\[[\s\S]*?\n\]);/);
  if (!block) throw new Error("لم يُعثر على SEED_PRODUCTS في src/lib/seed.ts");

  const items = [...block[1].matchAll(/\{([\s\S]*?)\n\s{2}\}/g)];
  if (!items.length) throw new Error("SEED_PRODUCTS فارغة أو بصيغة غير متوقعة");

  const field = (body, key) => {
    const m = body.match(new RegExp(`${key}\\s*:\\s*("([^"]*)"|[-\\d.]+|null)`));
    if (!m) return undefined;
    if (m[2] !== undefined) return m[2];
    if (m[1] === "null") return null;
    return Number(m[1]);
  };

  return items.map((m) => {
    const body = m[1];
    const id = field(body, "id");
    const stock = field(body, "stock");
    if (!id || stock === undefined) {
      throw new Error(`صنف بذرة بلا id أو stock — المقطع: ${body.slice(0, 60)}…`);
    }
    return { id, stock, name: field(body, "name") ?? id };
  });
}

const seed = readSeedProducts();

const client = createClient({ url });

const q = async (sql, args) => (await client.execute({ sql, args })).rows[0];

console.log(`قاعدة البيانات: ${url}`);
console.log(`الوضع: ${apply ? "تنفيذ (--apply)" : "فحص جاف — لن يتغيّر شيء"}`);
console.log("");

// ── 1. انحراف المخزون ──────────────────────────────────────────────────────
const rows = (await client.execute("SELECT id, name, stock FROM products ORDER BY rowid")).rows;
const current = new Map(rows.map((r) => [String(r.id), Number(r.stock)]));

const drifted = seed.filter((s) => current.has(s.id) && current.get(s.id) !== s.stock);

if (drifted.length) {
  console.log(`انحراف المخزون عن البذرة — ${drifted.length} من ${seed.length} صنفًا:`);
  console.log("  الصنف".padEnd(4) + "الحالي".padStart(8) + "البذرة".padStart(8) + "  الفرق");
  for (const s of drifted) {
    const now = current.get(s.id);
    const d = now - s.stock;
    console.log(
      "  " +
        String(s.id).padEnd(4) +
        String(now).padStart(7) +
        String(s.stock).padStart(8) +
        `  ${d > 0 ? "+" : ""}${d}` +
        (now === 0 ? "  ← نافد" : "")
    );
  }
} else {
  console.log("انحراف المخزون: لا شيء — كل الأصناف على قيم البذرة.");
}

const missing = seed.filter((s) => !current.has(s.id));
if (missing.length) {
  console.log(`⚠️  أصناف في البذرة غير موجودة في القاعدة: ${missing.map((s) => s.id).join("، ")}`);
}

// ── 2. الطلبات ─────────────────────────────────────────────────────────────
const orders = Number((await q("SELECT COUNT(*) n FROM orders")).n);
const items = Number((await q("SELECT COUNT(*) n FROM order_items")).n);
console.log(`\nالطلبات: ${orders} · أصناف الطلبات: ${items}`);
if (keepOrders) console.log("  (--keep-orders: ستُبقى)");

// ── 3. التنفيذ ─────────────────────────────────────────────────────────────
if (!apply) {
  if (drifted.length || (!keepOrders && orders > 0)) {
    console.log("\nفحص جاف فقط. للتنفيذ: npm run db:reset -- --apply");
    process.exit(2);
  }
  console.log("\nلا شيء يتطلب الإعادة.");
  process.exit(0);
}

const ops = [];
for (const s of seed) {
  if (current.has(s.id) && current.get(s.id) !== s.stock) {
    ops.push({ sql: "UPDATE products SET stock=? WHERE id=?", args: [s.stock, s.id] });
  }
}
if (!keepOrders && orders > 0) {
  // الأصناف أولًا ثم الطلبات: القيد الأجنبي RESTRICT يمنع حذف صنف ما دام
  // طلب يشير إليه، فالحذف بالترتيب العكسي يفشل.
  ops.push({ sql: "DELETE FROM order_items" });
  ops.push({ sql: "DELETE FROM orders" });
}

if (!ops.length) {
  console.log("\nلا تغييرات مطلوبة.");
  process.exit(0);
}

await client.batch(ops, "write");
console.log(`\n✅ نُفّذت ${ops.length} عملية كتابة في دفعة واحدة.`);

// ── 4. تحقق بعد التنفيذ — لا يُكتفى بـ«نجحت الكتابة» ───────────────────────
const after = (await client.execute("SELECT id, stock FROM products ORDER BY rowid")).rows;
const afterMap = new Map(after.map((r) => [String(r.id), Number(r.stock)]));
const stillOff = seed.filter((s) => afterMap.has(s.id) && afterMap.get(s.id) !== s.stock);

const ordersAfter = Number((await q("SELECT COUNT(*) n FROM orders")).n);
const itemsAfter = Number((await q("SELECT COUNT(*) n FROM order_items")).n);
const orphans = Number(
  (await q("SELECT COUNT(*) n FROM order_items WHERE order_id NOT IN (SELECT id FROM orders)")).n
);
const negative = Number((await q("SELECT COUNT(*) n FROM products WHERE stock < 0")).n);

console.log("\nالتحقق بعد الإعادة:");
console.log(`  أصناف خارج قيم البذرة: ${stillOff.length}`);
console.log(`  الطلبات: ${ordersAfter} · أصناف الطلبات: ${itemsAfter}`);
console.log(`  سجلات يتيمة: ${orphans} · مخزون سالب: ${negative}`);

const clean = stillOff.length === 0 && orphans === 0 && negative === 0 && (keepOrders || ordersAfter === 0);
console.log(clean ? "\n✅ القاعدة على حالة البذرة." : "\n❌ الإعادة غير مكتملة — راجع ما سبق.");
process.exit(clean ? 0 : 1);
