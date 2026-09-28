/**
 * عقد السكيما المقروءة: الحدّ الأدنى من الجداول والأعمدة التي يعتمد عليها
 * التطبيق فعلًا (قراءةً وكتابةً) — مشتقّ من `src/lib/db/migrations/0001_initial.sql`.
 *
 * موضعه في سلسلة الأدلة: بعد `db-identity` (أي قاعدة؟) وقبل `mig-parity`
 * القرائية (هل النسب مكتمل؟) — قاعدة صحيحة النسب قديمة الأعمدة تُحجَب هنا.
 * الفحص قراءة خالصة (`PRAGMA table_info` — استبطان بلا كتابة)، وأسماء الجداول
 * من هذا الثابت وحده (ليست مدخلات) فلا حقن.
 */

/** @returns {{table: string, columns: string[]}[]} */
export const SCHEMA_CONTRACT = [
  {
    table: "products",
    columns: ["id", "name", "description", "price", "old_price", "category", "image", "stock", "featured"],
  },
  {
    table: "orders",
    columns: [
      "id",
      "customer",
      "phone",
      "address",
      "governorate",
      "items",
      "total",
      "shipping_fee",
      "payment",
      "transfer_ref",
      "receipt_url",
      "status",
      "note",
    ],
  },
  { table: "order_items", columns: ["order_id", "product_id", "name", "price", "qty"] },
  { table: "faq", columns: ["question", "answer"] },
];

/**
 * يتحقق من العقد على عميل متصل. يعيد قائمة انتهاكات (فارغة = سليم).
 * @param {{execute: (sql: string) => Promise<{rows: unknown[]}>}} db
 * @returns {Promise<string[]>}
 */
export async function checkSchemaContract(db) {
  const violations = [];
  for (const { table, columns } of SCHEMA_CONTRACT) {
    let rows;
    try {
      rows = (await db.execute(`PRAGMA table_info(${table})`)).rows ?? [];
    } catch {
      violations.push(`${table}: تعذّر قراءة البنية`);
      continue;
    }
    if (rows.length === 0) {
      violations.push(`${table}: الجدول غائب`);
      continue;
    }
    const have = new Set(rows.map((r) => String(r?.name ?? "")));
    const missing = columns.filter((c) => !have.has(c));
    if (missing.length > 0) violations.push(`${table}: أعمدة ناقصة (${missing.join(", ")})`);
  }
  return violations;
}
