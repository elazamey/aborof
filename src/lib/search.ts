import type { Client } from "@libsql/client";
import { db, getProducts } from "@/lib/db";
import type { Product } from "@/lib/seed";

/**
 * بحث منتجات المتجر بمحرك FTS5 (ضمن Turso/libSQL) مع سقوط آمن:
 *
 *  - المطابقة تتم عبر الجدول الافتراضي `product_search` (هجرة 0002).
 *  - عند أي خطأ في FTS5 (محرك لا يدعمه، فهرس غير متزامن، استعلام غير صالح)
 *    نرجع لمطابقة الكلمات المفتاحية المحلية — لا يصل أي خطأ للمستخدم.
 *  - الاستعلام يُبنى من كلمات آمنة داخل علامات اقتباس، ولا يُمرَّر نص العميل
 *    خامًا إلى تعبير MATCH (يمنع أخطاء الصياغة والحقن داخل استعلام FTS).
 */

const FTS_TABLE = "product_search";

/** يحوّل نص استعلام إلى تعبير FTS5 آمن: كلمات مستقلة مقتبسة ومفصولة بـ OR. */
export function buildFtsMatch(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/["*():^\-]/g, "").trim())
    .filter((t) => t.length >= 1);
  if (tokens.length === 0) return "";
  const phrase = tokens
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");
  return phrase.slice(0, 200);
}

function toPlain(rows: unknown[]) {
  return rows.map((r) => ({ ...(r as object) }));
}

/** معرّفات المنتجات المطابقة مرتبة حسب صلة FTS5 (تستخدم عميلًا محقونًا في الاختبارات). */
export async function ftsProductIds(client: Client, query: string, limit: number): Promise<string[]> {
  const match = buildFtsMatch(query);
  if (!match) return [];
  const r = await client.execute({
    sql: `SELECT id FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ? ORDER BY rank LIMIT ?`,
    args: [match, limit],
  });
  return toPlain(r.rows).map((row) => String((row as { id?: unknown }).id));
}

/** هل الفهرس متزامن مع جدول المنتجات؟ (عدد الصفوف كإشارة كافية لمتجر صغير). */
async function isInSync(client: Client): Promise<boolean> {
  const products = await client.execute("SELECT COUNT(*) AS n FROM products");
  const idx = await client.execute(`SELECT COUNT(*) AS n FROM ${FTS_TABLE}`);
  return Number(products.rows[0].n) === Number(idx.rows[0].n);
}

/** يعيد بناء الفهرس بالكامل — يُستدعى مرة عند التجهيز وعند إضافة/حذف منتج. */
export async function reindexProductSearch(client: Client, products?: Product[]): Promise<void> {
  await client.execute(`DELETE FROM ${FTS_TABLE}`);
  const list = products ?? toPlain((await client.execute("SELECT * FROM products")).rows) as Product[];
  if (list.length === 0) return;
  const stmts = list.map((p) => ({
    sql: `INSERT INTO ${FTS_TABLE} (id, name, description, category) VALUES (?,?,?,?)`,
    args: [String(p.id), p.name, p.description, p.category],
  }));
  await client.batch(stmts, "write");
}

/** يضمن بقاء الفهرس متزامنًا بعد التجهيز (يُبنى مرة واحدة عند الحاجة). */
export async function ensureProductSearchInSync(client: Client): Promise<void> {
  try {
    if (!(await isInSync(client))) await reindexProductSearch(client);
  } catch (e) {
    // غياب دعم FTS5 يجب ألا يوقف التطبيق — البحث يرجع لمطابقة الكلمات.
    console.error("search: fts5 sync skipped:", String((e as Error)?.message ?? e));
  }
}

/** يضيف/يحدّث منتجًا في الفهرس (أمر 'delete' الخاص في FTS5 ثم الإدراج). */
export async function upsertProductSearch(client: Client, product: Product): Promise<void> {
  await client.batch(
    [
      {
        sql: `INSERT INTO ${FTS_TABLE} (${FTS_TABLE}, id, name, description, category) VALUES ('delete', ?, ?, ?, ?)`,
        args: [String(product.id), product.name, product.description, product.category],
      },
      {
        sql: `INSERT INTO ${FTS_TABLE} (id, name, description, category) VALUES (?,?,?,?)`,
        args: [String(product.id), product.name, product.description, product.category],
      },
    ],
    "write"
  );
}

/** يزيل منتجًا من الفهرس (أمر 'delete' الخاص في FTS5). */
export async function removeProductSearch(client: Client, id: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO ${FTS_TABLE} (${FTS_TABLE}, id, name, description, category) VALUES ('delete', ?, ?, ?, ?)`,
    args: [id, "", "", ""],
  });
}

/**
 * الواجهة العليا: بحث مرتّب بالصلة. يعيد منتجات الكتالوج الكاملة المطابقة
 * للاستعلام، مع سقوط آمن إلى مطابقة الكلمات المفتاحية عند تعذر FTS5.
 */
export async function searchProductsFts(query: string, limit = 3): Promise<Product[]> {
  const products = await getProducts();
  if (products.length === 0) return [];

  const c = db();
  const byId = new Map(products.map((p) => [String(p.id), p]));
  const order: string[] = [];

  if (c) {
    try {
      order.push(...(await ftsProductIds(c, query, limit)));
    } catch (e) {
      // فهرس ناقص أو محرك بلا FTS5 — نُكمل بالمطابقة المحلية بهدوء.
      console.error("search: fts5 query failed, using keyword fallback:", String((e as Error)?.message ?? e));
    }
  }

  const ordered = order.filter((id) => byId.has(id)).map((id) => byId.get(id) as Product);

  // إن لم يُجد الفهرس نتائج كافية نكمّل بالمطابقة المحلية حسب الكلمات.
  const t = query.toLowerCase();
  const words = t.split(/\s+/).filter((w) => w.length > 2);
  const score = (s: string) => words.reduce((n, w) => n + (s.toLowerCase().includes(w) ? 1 : 0), 0);
  const rest = products
    .filter((p) => !order.includes(String(p.id)))
    .map((p) => ({ p, s: words.length === 0 ? 0 : score(`${p.name} ${p.category} ${p.description}`) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.p.name.localeCompare(b.p.name))
    .map((x) => x.p);

  return [...ordered, ...rest].slice(0, limit);
}
