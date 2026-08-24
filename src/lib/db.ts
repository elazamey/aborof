import { createClient, type Client } from "@libsql/client";
import { SEED_PRODUCTS, type Product } from "./seed";

let _client: Client | null = null;
let _ready: Promise<void> | null = null;

export function hasDB() {
  return Boolean(process.env.TURSO_DATABASE_URL);
}

export function db(): Client | null {
  if (!hasDB()) return null;
  if (!_client) {
    _client = createClient({
      url: process.env.TURSO_DATABASE_URL as string,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _client;
}

/** إنشاء الجداول وتعبئتها أول مرة (يعمل تلقائياً) */
export async function ensureSchema() {
  const c = db();
  if (!c) return;
  if (_ready) return _ready;
  _ready = (async () => {
    await c.batch(
      [
        `CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          price REAL NOT NULL,
          old_price REAL,
          category TEXT DEFAULT '',
          image TEXT DEFAULT '🧴',
          stock INTEGER DEFAULT 0,
          featured INTEGER DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY,
          customer TEXT NOT NULL,
          phone TEXT NOT NULL,
          address TEXT DEFAULT '',
          governorate TEXT DEFAULT '',
          items TEXT NOT NULL,
          total REAL NOT NULL,
          shipping_fee REAL DEFAULT 0,
          payment TEXT DEFAULT 'vodafone_cash',
          transfer_ref TEXT DEFAULT '',
          receipt_url TEXT DEFAULT '',
          status TEXT DEFAULT 'جديد',
          note TEXT DEFAULT '',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS faq (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          question TEXT NOT NULL,
          answer TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS chat_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          question TEXT, answer TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS admin_audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL,
          entity TEXT NOT NULL,
          entity_id TEXT DEFAULT '',
          details TEXT DEFAULT '',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
      ],
      "write"
    );

    const orderColumns = await c.execute("PRAGMA table_info(orders)");
    const existingOrderColumns = new Set(orderColumns.rows.map((row) => String((row as { name?: string }).name)));
    for (const [name, definition] of Object.entries({ governorate: "TEXT DEFAULT ''", shipping_fee: "REAL DEFAULT 0", transfer_ref: "TEXT DEFAULT ''", receipt_url: "TEXT DEFAULT ''" })) {
      if (!existingOrderColumns.has(name)) await c.execute(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`);
    }

    const cnt = await c.execute("SELECT COUNT(*) AS n FROM products");
    if (Number(cnt.rows[0].n) === 0) {
      await c.batch(
        SEED_PRODUCTS.map((p) => ({
          sql: `INSERT INTO products (id,name,description,price,old_price,category,image,stock,featured)
                VALUES (?,?,?,?,?,?,?,?,?)`,
          args: [
            p.id, p.name, p.description, p.price, p.old_price ?? null,
            p.category, p.image, p.stock, p.featured ?? 0,
          ],
        })),
        "write"
      );
    }

    const f = await c.execute("SELECT COUNT(*) AS n FROM faq");
    if (Number(f.rows[0].n) === 0) {
      const faqs: [string, string][] = [
        ["ما هي طرق الدفع المتاحة؟", "الدفع عن طريق فودافون كاش على رقم 01095032221، أو الدفع عند الاستلام داخل القاهرة والجيزة."],
        ["كم مدة التوصيل؟", "من 1 إلى 3 أيام عمل داخل القاهرة والجيزة، ومن 2 إلى 5 أيام لباقي المحافظات."],
        ["كم تكلفة الشحن؟", "الشحن 50 جنيه، ومجاني للطلبات فوق 1000 جنيه."],
        ["هل يوجد بيع بالجملة؟", "نعم، لدينا أسعار خاصة للجملة وللشركات وشركات النظافة، تواصل معنا واتساب على 01095032221."],
        ["هل يمكن استبدال المنتج؟", "نعم، الاستبدال أو الاسترجاع خلال 14 يوم بشرط أن يكون المنتج بحالته وبعبوته الأصلية."],
        ["ما هي مواعيد العمل؟", "من السبت إلى الخميس من 10 صباحاً حتى 10 مساءً، والجمعة من 2 ظهراً حتى 10 مساءً."],
      ];
      await c.batch(
        faqs.map(([q, a]) => ({ sql: "INSERT INTO faq (question,answer) VALUES (?,?)", args: [q, a] })),
        "write"
      );
    }
  })();
  return _ready;
}

/** تحويل صفوف libsql إلى كائنات JS عادية حتى تُمرَّر بأمان لمكونات العميل */
function toPlain<T>(rows: unknown[]): T[] {
  return rows.map((r) => ({ ...(r as object) })) as T[];
}

export async function getProducts(): Promise<Product[]> {
  const c = db();
  if (!c) return SEED_PRODUCTS;
  try {
    await ensureSchema();
    const r = await c.execute("SELECT * FROM products ORDER BY featured DESC, rowid ASC");
    return toPlain<Product>(r.rows).map((p) => ({
      ...p,
      price: Number(p.price),
      old_price: p.old_price == null ? null : Number(p.old_price),
      stock: Number(p.stock),
    }));
  } catch (e) {
    console.error("DB error, using seed:", e);
    return SEED_PRODUCTS;
  }
}

export async function getProduct(id: string): Promise<Product | null> {
  const all = await getProducts();
  return all.find((p) => String(p.id) === String(id)) ?? null;
}

export async function getFaq(): Promise<{ question: string; answer: string }[]> {
  const c = db();
  const fallback = [
    { question: "طرق الدفع", answer: "فودافون كاش على 01095032221 أو الدفع عند الاستلام." },
    { question: "الشحن", answer: "50 جنيه، ومجاني فوق 1000 جنيه. التوصيل خلال 1-3 أيام." },
    { question: "الجملة", answer: "أسعار خاصة للجملة — تواصل واتساب 01095032221." },
  ];
  if (!c) return fallback;
  try {
    await ensureSchema();
    const r = await c.execute("SELECT question, answer FROM faq");
    return toPlain<{ question: string; answer: string }>(r.rows);
  } catch {
    return fallback;
  }
}
