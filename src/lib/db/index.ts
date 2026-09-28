import { createClient, type Client } from "@libsql/client";
import { SEED_PRODUCTS, type Product } from "@/lib/seed";
import { runMigrations } from "@/lib/db/migrate";
import { redactSecrets } from "@/lib/errors";
import { metrics } from "@/lib/observability/metrics";

let _client: Client | null = null;
let _ready: Promise<void> | null = null;
let _clientOverride: Client | null = null;

/**
 * تحقق Turso حسب توثيق https://docs.turso.tech/sdk/authentication
 * - رابط الاتصال: `libsql://[DB-NAME]-[ORG-NAME].turso.io` أو `turso://` أو `https://`
 * - رمز المصادقة: JWT يبدأ بـ `eyJ` بثلاثة مقاطع — ينشأ عبر `turso db tokens create <db>`
 * - الأخطاء الشائعة المكتشفة في الإنتاج (انظر handoff/turso-probe-report.md):
 *   TURSO_DATABASE_URL = صفحة لوحة تحكم `app.turso.tech/...` بدل رابط الاتصال
 *   TURSO_AUTH_TOKEN = رابط `libsql://` بدل JWT (الخادم يرد `JWT error: Base64 error: Invalid symbol 58, offset 6`)
 */

function isDashboardUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes("app.turso.tech") || lower.includes("www.turso.tech") || /^https?:\/\/turso\.tech(\/|$)/.test(lower);
}

function extractHost(url: string): string | null {
  const normalized = url
    .replace(/^libsql:\/\//i, "https://")
    .replace(/^turso:\/\//i, "https://")
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://");
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLocalFileUrl(url: string): boolean {
  const t = url.trim();
  return t.startsWith("file:") || t === ":memory:" || t.startsWith(":memory:") || t.startsWith("file::memory:");
}

export function isValidTursoConnectionUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (isLocalFileUrl(trimmed)) return true;
  // قيمة موضعية لم تُستبدل من .env.example
  if (/[<>]/.test(trimmed) || /\bYOUR_DB\b/i.test(trimmed) || /your-db-name/i.test(trimmed) || /\bxx+\b/i.test(trimmed)) return false;
  if (isDashboardUrl(trimmed)) return false;
  if (!/^(libsql|turso|https|wss|ws):\/\//i.test(trimmed)) return false;
  const host = extractHost(trimmed);
  if (!host) return false;
  // لوحة التحكم ليست رابط اتصال
  if (host === "app.turso.tech" || host === "www.turso.tech" || host === "turso.tech") return false;
  return true;
}

export function isJwtFormat(token: string | undefined | null): boolean {
  if (!token) return false;
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token.trim());
}

export function isUrlInTokenField(token: string | undefined | null): boolean {
  if (!token) return false;
  return token.includes("://");
}

export interface TursoConfigDiagnosis {
  urlPresent: boolean;
  urlValid: boolean;
  urlIsDashboard: boolean;
  urlHost: string | null;
  tokenPresent: boolean;
  tokenIsUrl: boolean;
  tokenIsJwt: boolean;
  overallValid: boolean;
}

export function diagnoseTursoConfig(
  url = process.env.TURSO_DATABASE_URL,
  token = process.env.TURSO_AUTH_TOKEN
): TursoConfigDiagnosis {
  const urlPresent = Boolean(url && url.trim());
  const urlIsDashboard = urlPresent ? isDashboardUrl(url!) : false;
  const urlValid = isValidTursoConnectionUrl(url);
  const urlHost = urlPresent ? extractHost(url!) : null;
  const tokenPresent = Boolean(token && token.trim());
  const tokenIsUrl = isUrlInTokenField(token);
  const tokenIsJwt = isJwtFormat(token);
  const isLocal = url ? isLocalFileUrl(url) : false;
  const overallValid = isLocal ? urlValid : urlValid && !urlIsDashboard && tokenPresent && !tokenIsUrl && tokenIsJwt;
  return {
    urlPresent,
    urlValid: isLocal ? true : urlValid,
    urlIsDashboard,
    urlHost,
    tokenPresent: isLocal ? true : tokenPresent,
    tokenIsUrl,
    tokenIsJwt: isLocal ? true : tokenIsJwt,
    overallValid: isLocal ? urlValid : overallValid,
  };
}

export function hasDB() {
  if (_clientOverride) return true;
  const url = process.env.TURSO_DATABASE_URL;
  if (url && isLocalFileUrl(url)) return true;
  const diag = diagnoseTursoConfig();
  return diag.urlPresent && diag.urlValid && !diag.urlIsDashboard;
}

export function db(): Client | null {
  if (_clientOverride) return _clientOverride;
  const rawUrl = process.env.TURSO_DATABASE_URL;
  const rawToken = process.env.TURSO_AUTH_TOKEN;

  if (!rawUrl) return null;

  // كشف الأخطاء الشائعة قبل إنشاء العميل — مع رسائل واضحة بلا كشف أسرار
  if (isDashboardUrl(rawUrl)) {
    console.error(
      `db: TURSO_DATABASE_URL يحمل رابط لوحة تحكم (${redactSecrets(
        extractHost(rawUrl) ?? "app.turso.tech"
      )}) وليس رابط اتصال. انسخ الرابط من زر Connect في اللوحة: libsql://[DB]-[ORG].turso.io — انظر https://docs.turso.tech/sdk/authentication`
    );
    return null;
  }

  if (!isValidTursoConnectionUrl(rawUrl)) {
    // لا نطبع القيمة، فقط الشكل
    console.error(
      `db: TURSO_DATABASE_URL غير صالح — يجب أن يبدأ بـ libsql:// أو turso:// أو https:// وينتهي بـ .turso.io. تحقق من https://docs.turso.tech/sdk/authentication`
    );
    return null;
  }

  if (rawToken && isUrlInTokenField(rawToken)) {
    console.error(
      `db: TURSO_AUTH_TOKEN يحمل رابط اتصال (يبدأ بـ ${redactSecrets(
        rawToken.split("://")[0]
      )}://) بدل رمز JWT. السبب الجذري الذي رصده الخادم: JWT error: Base64 error: Invalid symbol 58 (النقطتان : في libsql://). انقل الرابط إلى TURSO_DATABASE_URL والرمز eyJ... إلى TURSO_AUTH_TOKEN — انظر https://docs.turso.tech/sdk/authorization`
    );
    return null;
  }

  if (rawToken && !isJwtFormat(rawToken) && !isLocalFileUrl(rawUrl)) {
    console.error(
      `db: TURSO_AUTH_TOKEN لا يبدو JWT (يجب أن يبدأ بـ eyJ بثلاثة مقاطع). أنشئ رمزًا جديدًا عبر: turso db tokens create <db> --expiration never — انظر https://docs.turso.tech/sdk/authorization`
    );
    // نسمح بالمحاولة لكن مع التحذير — قد يكون رمز مستقبلي بصيغة أخرى
  }

  if (!_client) {
    _client = createClient({
      url: rawUrl as string,
      authToken: rawToken,
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
