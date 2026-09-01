import { createClient, type Client } from "@libsql/client";
import { SEED_PRODUCTS, type Product } from "./seed";
import { applyMigrations } from "./migrations";

let _client: Client | null = null;
let _ready: Promise<void> | null = null;

/**
 * بذرة حقن الفشل — للاختبارات فقط (Resilience Drills). لا أثر لها في الإنتاج:
 * تُفعَّل حصراً عبر متغير البيئة FAULT_INJECTION.
 *   FAULT_INJECTION=fail:N   → تفشل عمليات DB N التالية بخطأ عابر ثم تتعافى
 *   FAULT_INJECTION=delay:MS → تأخير كل عملية DB MS مللي ثانية (لمحاكاة
 *                              طلب قيد التنفيذ أثناء إعادة التشغيل)
 */
function faultWrap<T extends object>(client: T): T {
  const cfg = process.env.FAULT_INJECTION;
  if (!cfg) return client;
  const [mode, raw] = cfg.split(":");
  let failuresLeft = mode === "fail" ? Math.max(0, Number(raw) || 0) : 0;
  const delayMs = mode === "delay" ? Math.max(0, Number(raw) || 0) : 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const wrap =
    (fn: (...args: unknown[]) => unknown, isTx = false) =>
    async (...args: unknown[]) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("FAULT_INJECTION: simulated transient DB failure");
      }
      if (delayMs > 0) await sleep(delayMs);
      const result = await fn(...args);
      if (isTx && result && typeof (result as { execute?: unknown }).execute === "function") {
        // تأخير عمليات المعاملة نفسها أيضاً (لكي يُقتل الخادم وسطها)
        const tx = result as { execute: (...a: unknown[]) => Promise<unknown> };
        const origExec = tx.execute.bind(tx);
        tx.execute = async (...a: unknown[]) => {
          if (delayMs > 0) await sleep(delayMs);
          return origExec(...a);
        };
      }
      return result;
    };

  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function" && (prop === "execute" || prop === "batch" || prop === "transaction")) {
        // bind(target) إلزامي: بدونها تُستدعى دوال العميل بـ this=undefined
        // فتفشل كل العمليات بعد انتهاء الحقن (كشفه DRILL-01 أثناء التحقق من التعافي)
        return wrap((value as (...args: unknown[]) => unknown).bind(target), prop === "transaction");
      }
      return value;
    },
  }) as T;
}

export function hasDB() {
  return Boolean(process.env.TURSO_DATABASE_URL);
}

export function db(): Client | null {
  if (!hasDB()) return null;
  if (!_client) {
    try {
      _client = faultWrap(
        createClient({
          url: process.env.TURSO_DATABASE_URL as string,
          authToken: process.env.TURSO_AUTH_TOKEN,
        })
      );
    } catch (error) {
      // فشل إنشاء الاتصال (مسار/إعدادات خاطئة) — نفشل بأمان بدل استثناء غير معالج
      console.error("[db] failed to create client:", error);
      return null;
    }
  }
  return _client;
}

/** إنشاء الجداول وتعبئتها أول مرة (يعمل تلقائياً) */
export async function ensureSchema() {
  const c = db();
  if (!c) return;
  if (_ready) return _ready;
  _ready = (async () => {
    // schema مُدار عبر نظام migrations بإصدارات (انظر src/lib/migrations.ts)
    await applyMigrations(c);

    const cnt = await c.execute("SELECT COUNT(*) AS n FROM products");
    if (Number(cnt.rows[0].n) === 0) {
      await c.batch(
        SEED_PRODUCTS.map((p) => ({
          sql: `INSERT INTO products (id,name,description,price,old_price,category,image,stock,featured)
                VALUES (?,?,?,?,?,?,?,?,?)`,
          args: [
            p.id,
            p.name,
            p.description,
            p.price,
            p.old_price ?? null,
            p.category,
            p.image,
            p.stock,
            p.featured ?? 0,
          ],
        })),
        "write"
      );
    }

    const f = await c.execute("SELECT COUNT(*) AS n FROM faq");
    if (Number(f.rows[0].n) === 0) {
      const faqs: [string, string][] = [
        [
          "ما هي طرق الدفع المتاحة؟",
          "الدفع عن طريق فودافون كاش على رقم 01095032221، أو الدفع عند الاستلام داخل القاهرة والجيزة.",
        ],
        ["كم مدة التوصيل؟", "من 1 إلى 3 أيام عمل داخل القاهرة والجيزة، ومن 2 إلى 5 أيام لباقي المحافظات."],
        ["كم تكلفة الشحن؟", "الشحن 50 جنيه، ومجاني للطلبات فوق 1000 جنيه."],
        [
          "هل يوجد بيع بالجملة؟",
          "نعم، لدينا أسعار خاصة للجملة وللشركات وشركات النظافة، تواصل معنا واتساب على 01095032221.",
        ],
        [
          "هل يمكن استبدال المنتج؟",
          "نعم، الاستبدال أو الاسترجاع خلال 14 يوم بشرط أن يكون المنتج بحالته وبعبوته الأصلية.",
        ],
        ["ما هي مواعيد العمل؟", "من السبت إلى الخميس من 10 صباحاً حتى 10 مساءً، والجمعة من 2 ظهراً حتى 10 مساءً."],
      ];
      await c.batch(
        faqs.map(([q, a]) => ({ sql: "INSERT INTO faq (question,answer) VALUES (?,?)", args: [q, a] })),
        "write"
      );
    }
  })();
  try {
    await _ready;
  } catch (error) {
    // لا نُبقي الوعد المرفوض مخزّناً إلى الأبد، وإلا لن تُحاول
    // قاعدة البيانات الاتصال مجدداً بعد أي خطأ عابر (شبكة مثلاً)
    // حتى يُعاد تشغيل الخادم. إعادة الضبط تسمح بالمحاولة في المرة القادمة.
    _ready = null;
    throw error;
  }
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
