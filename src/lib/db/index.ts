import { createClient, type Client } from "@libsql/client";
import { SEED_PRODUCTS, type Product } from "@/lib/seed";
import { runMigrations } from "@/lib/db/migrate";
import { redactSecrets } from "@/lib/errors";
import { metrics } from "@/lib/observability/metrics";

let _client: Client | null = null;
let _ready: Promise<void> | null = null;
let _clientOverride: Client | null = null;

export function hasDB() {
  return Boolean(_clientOverride) || Boolean(process.env.TURSO_DATABASE_URL);
}

export function db(): Client | null {
  if (_clientOverride) return _clientOverride;
  if (!hasDB()) return null;
  if (!_client) {
    _client = createClient({
      url: process.env.TURSO_DATABASE_URL as string,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _client;
}

/**
 * حقن عميل مخصص للاختبارات (يُقرأ قبل مدخل البيئة). يُستخدم مع عميل
 * ملف مؤقت كي تكون كل خطوات الاختبار على نفس حالة قاعدة البيانات.
 * `null` يُلغي الحقن ويعيد السلوك الافتراضي (بذرة محلية بلا قاعدة).
 */
export function setDbClientForTest(client: Client | null): void {
  _clientOverride = client;
  _ready = null;
}

/**
 * تجهيز قاعدة البيانات عبر العميل المحقون (إن وُجد) — يُستخدم في اختبارات
 * التكامل لتشغيل الهجرات على عميل ملف مؤقت بالضبط كما يعمل في الإنتاج.
 */
export async function migrateDbSchemaForTest(client: Client): Promise<void> {
  await runMigrations(client);
}

/**
 * تجهيز قاعدة البيانات: هجرات مُرقّمة بدل إنشاء الجداول وقت التشغيل،
 * ثم تعبئة البيانات الأولية عند الفراغ فقط.
 */
export async function ensureSchema() {
  const c = db();
  if (!c) return;
  if (_ready) return _ready;
  _ready = (async () => {
    const started = Date.now();
    try {
      const { applied } = await runMigrations(c);
      if (applied.length) console.log(`db: applied migrations ${applied.join(", ")}`);

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
          ["ما هي مواعيد العمل؟", "من السبت إلى الخميس من 10 صباحًا حتى 10 مساءً، والجمعة من 2 ظهرًا حتى 10 مساءً."],
        ];
        await c.batch(
          faqs.map(([q, a]) => ({ sql: "INSERT INTO faq (question,answer) VALUES (?,?)", args: [q, a] })),
          "write"
        );
      }
    } finally {
      metrics.recordTiming("db", Date.now() - started);
    }
  })();
  return _ready.catch((e) => {
    // أعد الضبط حتى تُعاد المحاولة في الطلب التالي، وسجّل دون كشف أسرار.
    _ready = null;
    console.error("db: ensureSchema failed:", redactSecrets(String((e as Error)?.message ?? e)));
    throw e;
  });
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
    const started = Date.now();
    const r = await c.execute("SELECT * FROM products ORDER BY featured DESC, rowid ASC");
    metrics.recordTiming("db", Date.now() - started);
    return toPlain<Product>(r.rows).map((p) => ({
      ...p,
      price: Number(p.price),
      old_price: p.old_price == null ? null : Number(p.old_price),
      stock: Number(p.stock),
    }));
  } catch (e) {
    console.error("DB error, using seed:", redactSecrets(String((e as Error)?.message ?? e)));
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
