import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createClient, type Client } from "@libsql/client";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrations, MIGRATIONS } from "../src/lib/db/migrate";
import { expectedMigrations, migrationChecksum, redact } from "../scripts/lib/migration-checksums.mjs";
import {
  dashboardUrlToConnectionCandidates,
  describeDatabaseUrl,
  interpretProbeStatus,
  originForHttpProbe,
  parseAuthValue,
} from "../scripts/lib/db-url.mjs";
import {
  isSafeBaseUrl,
  classifySecurityHeaders,
  looksLikeSeedFallback,
  frontPageFindings,
  extractErrorDigest,
  BASELINE_SECURITY_HEADERS,
} from "../scripts/smoke-production.mjs";
import { scanTextForSecrets, SERVER_SECRET_NAMES } from "../scripts/scan-bundle-secrets.mjs";
import { setDbClientForTest, db, hasDB } from "../src/lib/db";
import { SEED_PRODUCTS } from "../src/lib/seed";

/**
 * أدوات تحقق النشر (scripts/) أدلة تشغيلية؛ نحميها باختبارات حتى لا تتقادم
 * بصمت: بصمات الهجرات يجب أن تطابق مشغّل الهجرات حرفيًا، وحاجز النطاقات
 * في الـ smoke test يجب أن يبقى مطابقًا لمنطق probe-production.yml.
 */

function fileClient(name: string): { client: Client; url: string } {
  const file = path.join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return { client: createClient({ url: `file:${file}` }), url: `file:${file}` };
}

function runVerifyTurso(url: string) {
  return execFileSync("node", ["scripts/verify-turso.mjs", "--json"], {
    encoding: "utf8",
    env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: "" },
  });
}

describe("scripts/lib/migration-checksums", () => {
  test("بصمة الهجرة تساوي sha256(\"\\n\" + sql + \"\\n\") تمامًا كما في migrate.ts", () => {
    const sql = "CREATE TABLE x (id TEXT);\n";
    const expected = createHash("sha256").update(`\n${sql}\n`).digest("hex");
    assert.equal(migrationChecksum(sql), expected);
  });

  test("الملفات المرجعية تطابق وحدات الهجرة المُحمَّلة في مشغّل الهجرات (versions/names/checksums)", () => {
    const files = expectedMigrations(process.cwd());
    assert.equal(files.length, MIGRATIONS.length);
    for (const migration of MIGRATIONS) {
      const file = files.find((f) => f.version === migration.version);
      assert.ok(file, `لا ملف مرجعي للإصدار ${migration.version}`);
      assert.equal(file.name, migration.name);
      assert.equal(
        file.checksum,
        createHash("sha256").update(migration.sql).digest("hex"),
        `بصمة ${migration.version} لا تطابق ما يسجّله migrate.ts — فحص التطابق في CI سيخطئ`
      );
    }
  });

  test("redact يحجب الأسرار ولا يمس النص العادي", () => {
    const secret = "super-secret-token-value";
    assert.equal(redact(`فشل الاتصال بـ ${secret}`, [secret]), "فشل الاتصال بـ ***");
    assert.equal(redact("نص بلا أسرار", [secret]), "نص بلا أسرار");
  });
});

describe("scripts/lib/db-url — تشخيص رابط القاعدة بلا كشف قيمته", () => {
  test("يميّز نطاق Turso من نطاق تطبيق (الأخير يرد HTML فيظهر «Unexpected token '<'»)", () => {
    assert.equal(describeDatabaseUrl("libsql://store-abc.turso.io").kind, "Turso");
    assert.equal(describeDatabaseUrl("https://aborof.vercel.app").kind, "نطاق خارج Turso");
  });

  test("يرصد القيمة الموضعية من التوثيق ولا يعدّها رابطًا حقيقيًا", () => {
    const placeholder = describeDatabaseUrl("libsql://<db>.turso.io");
    assert.equal(placeholder.hasPlaceholder, true);
    assert.equal(placeholder.kind, "قيمة موضعية غير مستبدلة");
    assert.equal(describeDatabaseUrl("libsql://store-abc.turso.io").hasPlaceholder, false);
  });

  test("أصل الفحص يجرّد المسار والاستعلام — رمز مدسوس في الرابط لا يظهر في أي سجل", () => {
    assert.equal(originForHttpProbe("libsql://store-abc.turso.io?authToken=SECRET-123"), "https://store-abc.turso.io");
    assert.equal(originForHttpProbe("wss://store-abc.turso.io/v2"), "https://store-abc.turso.io");
    assert.equal(originForHttpProbe("file:/tmp/local.db"), null);
  });

  test("اشتقاق رابط الاتصال من رابط لوحة التحكم (libsql://<db>-<org>.turso.io)", () => {
    assert.deepEqual(dashboardUrlToConnectionCandidates("https://app.turso.tech/elazamey/databases/aborof"), [
      "libsql://aborof-elazamey.turso.io",
      "libsql://elazamey-aborof.turso.io",
    ]);
    assert.deepEqual(dashboardUrlToConnectionCandidates("https://app.turso.tech/elazamey/db/store"), [
      "libsql://store-elazamey.turso.io",
      "libsql://elazamey-store.turso.io",
    ]);
  });

  test("الاشتقاق لا يعمل إلا على نطاق اللوحة — رابط اتصال سليم أو نطاق آخر لا يُمس", () => {
    assert.deepEqual(dashboardUrlToConnectionCandidates("libsql://aborof-elazamey.turso.io"), []);
    assert.deepEqual(dashboardUrlToConnectionCandidates("https://aborof.vercel.app/elazamey/databases/aborof"), []);
    assert.deepEqual(dashboardUrlToConnectionCandidates("https://app.turso.tech/elazamey/databases"), []);
  });

  test("قيمة حقل الرمز: JWT سليم، أم رابط اتصال لُصق في مكان الرمز (خطأ اللصق الشائع)", () => {
    const pasted = parseAuthValue("libsql://aborof-elazamey.turso.io?authToken=eyJhbGciOiJIUzI1NiJ9.abc.def");
    assert.equal(pasted.shape.scheme, "libsql");
    assert.equal(pasted.shape.colonOffset, 6); // 58 = ':' ⇒ نفس ما يشرح رسالة الخادم
    assert.equal(pasted.url, "libsql://aborof-elazamey.turso.io");
    assert.equal(pasted.token, "eyJhbGciOiJIUzI1NiJ9.abc.def");

    const jwt = parseAuthValue("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4In0.sig");
    assert.equal(jwt.shape.looksLikeJwt, true);
    assert.equal(jwt.token, jwt.shape.looksLikeJwt ? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4In0.sig" : null);

    const bare = parseAuthValue("libsql://aborof-elazamey.turso.io");
    assert.equal(bare.url, "libsql://aborof-elazamey.turso.io");
    assert.equal(bare.token, null);
  });

  test("ترجمة رمز الحالة تفصل بين «لا قاعدة» و«رمز مرفوض» — وهما علاجان مختلفان", () => {
    assert.equal(interpretProbeStatus(200).ok, true);
    assert.match(interpretProbeStatus(401).verdict, /الرمز مرفوض/);
    assert.match(interpretProbeStatus(403).verdict, /الرمز مرفوض/);
    assert.match(interpretProbeStatus(404).verdict, /لا قاعدة بهذا الاسم/);
    assert.match(interpretProbeStatus(400, "<html>").verdict, /صيغة الرابط/);
    assert.match(interpretProbeStatus(500).verdict, /استجابة غير متوقعة/);
  });

  test("التشخيص يذكر طول المضيف وشكل المقاطع بالأطوال فقط — لا أسماء ولا قيم", () => {
    const shape = describeDatabaseUrl("https://app.turso.tech/elazamey/databases/aborof");
    assert.equal(shape.hostLength, 14);
    assert.equal(shape.pathShape, "8/9/6");
    assert.ok(!JSON.stringify(shape).includes("elazamey"));
  });

  test("المضيف يُقنَّع: لا يُطبع كاملًا مع أن آخره يكفي للتعرّف", () => {
    const masked = describeDatabaseUrl("libsql://store-abc.turso.io").hostMasked;
    assert.ok(!masked.includes("store-abc"));
    assert.ok(masked.startsWith("sto"));
    assert.ok(masked.endsWith("turso.io"));
  });
});

describe("scripts/verify-turso — مسار فشل الاتصال", () => {
  test("يطبع الجدول ولا يسقط بخطأ مرجعي، ويرصد رابطًا لُصق في حقل الرمز", () => {
    // هذا الاختبار يغطي بالضبط ما لا يُكتشف محليًا: فرع فشل الاتصال على قاعدة
    // غير محلية. بلا تغطية، دالة مساعدة غير معرّفة فيه تمر في CI كـ«توقف الفحص».
    const env = {
      ...process.env,
      TURSO_DATABASE_URL: "libsql://example-db-example.turso.io",
      TURSO_AUTH_TOKEN: "libsql://example-db-example.turso.io?authToken=eyJhbGciOiJIUzI1NiJ9.a.b",
    };
    const res = spawnSync("node", ["scripts/verify-turso.mjs", "--allow-secret-repair"], { encoding: "utf8", env });
    assert.equal(res.status, 1, "صفوف حمراء تعني 1؛ أما خطأ في السكربت نفسه فهو فشل آخر");
    assert.match(res.stdout, /\| conn \|/);
    assert.match(res.stdout, /conn-token-shape/);
    assert.match(res.stdout, /رابط في حقل الرمز/);
    assert.doesNotMatch(res.stdout + res.stderr, /is not defined/);
    assert.doesNotMatch(res.stdout, /example-db-example/, "لا يُطبع الرابط ولا الرمز");
  });

  test("صفّا الصيغة والسبب يُسجَّلان دائمًا (بلا علم ترميم) ولا تُطبع أي قيمة", () => {
    // حالة فحص 2026-09-28: رابط سليم الشكل + رمز JWT سليم الشكل مرفوض (401).
    // بلا هذين الصفين كان التقرير يقول «401» فقط بلا تمييز رمز/قاعدة.
    const env = {
      ...process.env,
      TURSO_DATABASE_URL: "libsql://no-such-db-xyz123.turso.io",
      TURSO_AUTH_TOKEN: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl",
    };
    const res = spawnSync("node", ["scripts/verify-turso.mjs"], { encoding: "utf8", env });
    assert.equal(res.status, 1, "صفوف حمراء تعني 1");
    assert.match(res.stdout, /\| conn-token-shape \|/);
    assert.match(res.stdout, /الصيغة سليمة/);
    assert.match(res.stdout, /\| conn-cause \|/);
    assert.doesNotMatch(res.stdout + res.stderr, /is not defined/);
    assert.doesNotMatch(res.stdout + res.stderr, /no-such-db-xyz123/, "لا يُطبع المضيف كاملًا");
    assert.doesNotMatch(res.stdout + res.stderr, /c2lnbmF0dXJl/, "لا يُطبع أي جزء من الرمز");
  });

  test("رابط معطوب (بلا مخطّط صالح) يطبع الجدول منقّحًا بدل إسقاط السكربت", () => {
    // `createClient` نفسه يرمي على هذه القيمة؛ كان الرمي يُسقط السكربت قبل
    // الجدول برسالة تحمل القيمة حرفيًا — الآن صف conn منقّح بدل السقوط.
    const env = {
      ...process.env,
      TURSO_DATABASE_URL: "not-a-real-url-xyz789",
      TURSO_AUTH_TOKEN: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl",
    };
    const res = spawnSync("node", ["scripts/verify-turso.mjs"], { encoding: "utf8", env });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /\| conn \|/);
    assert.match(res.stdout, /تعذّرت تهيئة عميل libsql/);
    assert.doesNotMatch(res.stdout + res.stderr, /not-a-real-url-xyz789/, "رسالة الخطأ يجب أن تُنقّح");
    assert.doesNotMatch(res.stdout + res.stderr, /c2lnbmF0dXJl/, "لا يُطبع أي جزء من الرمز");
  });
});

describe("scripts/apply-turso-secrets — تطبيق السرّين بأمان", () => {
  const run = (env: Record<string, string>, args: string[] = ["--dry-run"]) =>
    spawnSync("bash", ["scripts/apply-turso-secrets.sh", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  const GOOD_URL = "libsql://aborof-elazamey.turso.io";
  const GOOD_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl";

  test("يقبل الزوج الصحيح ويعرض وصفًا شكليًا فقط — بلا أي قيمة سرية", () => {
    const res = run({ TURSO_DATABASE_URL: GOOD_URL, TURSO_AUTH_TOKEN: GOOD_TOKEN });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /التحقق الشكلي نجح/);
    assert.match(res.stdout, /JWT \(طول/);
    assert.doesNotMatch(res.stdout + res.stderr, new RegExp(GOOD_TOKEN));
    assert.doesNotMatch(res.stdout, /aborof-elazamey/, "لا يُطبع المضيف كاملًا");
  });

  test("يرفض رابط لوحة التحكم ويرشد إلى زر Connect", () => {
    const res = run({
      TURSO_DATABASE_URL: "https://app.turso.tech/elazamey/databases/aborof",
      TURSO_AUTH_TOKEN: GOOD_TOKEN,
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /رابط لوحة تحكم/);
  });

  test("يرفض رابطًا لُصق في حقل الرمز (نفس خطأ الإنتاج الحالي) ويطلب توكنًا جديدًا", () => {
    const res = run({ TURSO_DATABASE_URL: GOOD_URL, TURSO_AUTH_TOKEN: GOOD_URL });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /الرمز ليس JWT/);
    assert.match(res.stderr, /أنشئ توكنًا جديدًا/);
  });

  test("يرفض القيم الفارغة بدل ضبط سرّ فارغ على البيئات", () => {
    const res = run({ TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: GOOD_TOKEN }, ["--dry-run"]);
    // بلا قيمة في البيئة يحاول القراءة من المدخل؛ stdin مغلق في الاختبار فيفشل برسالة واضحة.
    assert.equal(res.status, 1);
    assert.match(res.stderr, /فارغ/);
  });

  test("يقبل قيمًا بهوامش لصق (مسافات/سطر/اقتباس) بعد تشذيبها ويُعلن الفرق", () => {
    const res = run({
      TURSO_DATABASE_URL: `  ${GOOD_URL}\n`,
      TURSO_AUTH_TOKEN: `"${GOOD_TOKEN}"`,
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /التحقق الشكلي نجح/);
    assert.match(res.stderr, /حرفًا زائدًا/);
    assert.doesNotMatch(res.stdout + res.stderr, new RegExp(GOOD_TOKEN));
  });

  test("يرفض مسافة داخلية في الرابط أو الرمز بدل تمرير قيمة مكسورة تُسقط الإنتاج", () => {
    const badUrl = run({
      TURSO_DATABASE_URL: "libsql://aborof elazamey.turso.io",
      TURSO_AUTH_TOKEN: GOOD_TOKEN,
    });
    assert.equal(badUrl.status, 1);
    assert.match(badUrl.stderr, /مسافة داخلية/);
    const badToken = run({
      TURSO_DATABASE_URL: GOOD_URL,
      TURSO_AUTH_TOKEN: "eyJhbGciOiJIUzI1NiJ9.abc def",
    });
    assert.equal(badToken.status, 1);
    assert.match(badToken.stderr, /مسافة داخلية/);
  });
});

describe("scripts/smoke-production — حاجز النطاقات (SSRF)", () => {
  test("يسمح بروابط https العامة فقط", () => {
    assert.equal(isSafeBaseUrl("https://aborof.vercel.app"), true);
    assert.equal(isSafeBaseUrl("https://example.com/store"), true);
  });

  test("يرفض غير https والنطاقات الداخلية والمحلية", () => {
    for (const bad of [
      "http://aborof.vercel.app",
      "https://localhost/admin",
      "https://127.0.0.1",
      "https://10.0.0.5",
      "https://192.168.1.10",
      "https://172.16.0.1",
      "https://172.31.255.1",
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal",
      "https://api.internal",
      "https://printer.local",
      "not-a-url",
      "",
    ]) {
      assert.equal(isSafeBaseUrl(bad), false, `كان يجب رفض: ${bad}`);
    }
  });
});

describe("scripts/smoke-production — رؤوس الأمان ووضع CSP", () => {
  const baseline: Record<string, string> = {
    "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  const headersOf = (map: Record<string, string>) => ({
    get: (name: string) => map[name.toLowerCase()] ?? null,
  });

  test("وضع المراقبة (الافتراضي في الإنتاج) لا يُحسب رأس CSP ناقصًا — كان فشلًا كاذبًا", () => {
    const result = classifySecurityHeaders(
      headersOf({ ...baseline, "content-security-policy-report-only": "default-src 'self'" })
    );
    assert.equal(result.cspMode, "report-only");
    assert.deepEqual(result.missing, []);
    assert.equal(result.ok, true);
  });

  test("وضع الحجب يُصنَّف enforce", () => {
    const result = classifySecurityHeaders(
      headersOf({ ...baseline, "content-security-policy": "default-src 'self'" })
    );
    assert.equal(result.cspMode, "enforce");
    assert.equal(result.ok, true);
  });

  test("غياب CSP تمامًا يُذكر باسمه في الناقص", () => {
    const result = classifySecurityHeaders(headersOf(baseline));
    assert.equal(result.cspMode, "absent");
    assert.deepEqual(result.missing, ["content-security-policy"]);
    assert.equal(result.ok, false);
  });

  test("نقص رأس أساسي يُذكر باسمه", () => {
    const { "x-frame-options": _omitted, ...rest } = baseline;
    const result = classifySecurityHeaders(headersOf({ ...rest, "content-security-policy": "x" }));
    assert.deepEqual(result.missing, ["x-frame-options"]);
    assert.equal(result.ok, false);
  });

  test("قائمة الرؤوس الأساسية لا تتضمن CSP (لأن وضعها متغيّر بطبعه)", () => {
    assert.ok(!BASELINE_SECURITY_HEADERS.includes("content-security-policy"));
  });
});

describe("scripts/smoke-production — قرينة ربط قاعدة البيانات", () => {
  test("صف بلا مفتاح old_price = قرينة بذرة محلية (الشكل الحيّ بعد كشف 2026-09-28)", () => {
    const live = [
      { id: "p1", price: 180, old_price: 220, stock: 40, featured: 1 },
      { id: "p3", price: 70, stock: 80, featured: 1 }, // مسار Turso كان سيضع old_price: null
    ];
    assert.equal(looksLikeSeedFallback(live), true);
  });

  test("صفوف مسار Turso تحمل old_price دائمًا (ولو null) = لا قرينة", () => {
    assert.equal(
      looksLikeSeedFallback([
        { id: "p1", price: 180, old_price: 220 },
        { id: "p3", price: 70, old_price: null },
      ]),
      false
    );
  });

  test("قائمة فارغة أو غير صالحة لا تُنتج قرينة", () => {
    assert.equal(looksLikeSeedFallback([]), false);
    assert.equal(looksLikeSeedFallback(null), false);
    assert.equal(looksLikeSeedFallback("not-a-list"), false);
  });

  /**
   * ثبات القرينة نفسه: نشغّل `getProducts()` فعليًا على قاعدة مهاجَرة، ونتأكد أن
   * مسار Turso يمرّر مفتاح `old_price` في كل صف — بينما البذرة المحلية لا تفعل.
   * إن تغيّر هذا العقد يومًا، يفشل هذا الاختبار قبل أن يصبح صف `db-binding` مضلّلًا.
   */
  test("عقد getProducts: مسار Turso يحمل old_price دائمًا والبذرة لا", async () => {
    const { client } = fileClient("aborof-shape");
    await runMigrations(client);
    await client.execute(
      "INSERT INTO products (id,name,description,price,category,image,stock) VALUES ('px','بلا سعر قديم','وصف',10,'x','🧴',3)"
    );
    setDbClientForTest(client);
    try {
      const { getProducts } = await import("../src/lib/db");
      const fromDb = await getProducts();
      assert.ok(fromDb.length > 0, "القاعدة المهاجَرة يجب أن تعطي صفًا واحدًا على الأقل");
      for (const product of fromDb) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(product, "old_price"),
          "مسار Turso يجب أن يمرّر مفتاح old_price في كل صف"
        );
      }
      assert.equal(looksLikeSeedFallback(fromDb), false, "صفوف قاعدة البيانات ليست قرينة بذرة");
      assert.equal(looksLikeSeedFallback(SEED_PRODUCTS), true, "البذرة المحلية يجب أن تُكتشف كقرينة");
    } finally {
      setDbClientForTest(null);
      client.close();
    }
  });
});

describe("src/lib/db — إعداد معطوب لا يُسقط المسار بـ 500 (عطل فحص 2026-09-28)", () => {
  // عطل الإنتاج: `createClient` يرمي `Invalid URL` على رابط بهامش لصق/بلا مخطط،
  // وكان الرمي خارج أي try في القرّاء ⇒ 500 على /api/products والصفحة والخريطة.
  // العقد الجديد: تشذيب القيم، وخطأ إعداد صريح (503) بدل الخام، والتقاطه في
  // القرّاء للسقوط الآمن — فأسوأ حالة ممكنة هي البذرة لا صفحة خطأ.
  const URL_KEY = "TURSO_DATABASE_URL";
  const TOKEN_KEY = "TURSO_AUTH_TOKEN";
  let savedUrl: string | undefined;
  let savedToken: string | undefined;

  beforeEach(() => {
    savedUrl = process.env[URL_KEY];
    savedToken = process.env[TOKEN_KEY];
    setDbClientForTest(null);
  });
  afterEach(() => {
    if (savedUrl === undefined) delete process.env[URL_KEY];
    else process.env[URL_KEY] = savedUrl;
    if (savedToken === undefined) delete process.env[TOKEN_KEY];
    else process.env[TOKEN_KEY] = savedToken;
    setDbClientForTest(null);
  });

  test("قيمة بمسافات فقط تُعامَل كغياب: بلا عميل وبلا رمي", () => {
    process.env[URL_KEY] = "   ";
    assert.equal(hasDB(), false);
    assert.equal(db(), null);
  });

  test("رابط بلا مخطّط صالح يرمي خطأ إعداد صريحًا (503) لا خام المزود", () => {
    process.env[URL_KEY] = "not-a-url";
    assert.throws(() => db(), /إعداد الاتصال بقاعدة البيانات غير صالح/);
  });

  test("رمز JWT في حقل الرابط (خطأ لصق) يُعامَل كإعداد معطوب لا كعطل داخلي", () => {
    process.env[URL_KEY] = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl";
    assert.throws(() => db(), /إعداد الاتصال بقاعدة البيانات غير صالح/);
  });

  test("getProducts مع رابط معطوب يسقط للبذرة بدل الرمي (عقد الـ 200)", async () => {
    process.env[URL_KEY] = "not-a-url";
    const { getProducts } = await import("../src/lib/db");
    const products = await getProducts();
    assert.deepEqual(products, SEED_PRODUCTS);
  });

  test("getFaq مع رابط معطوب يسقط للاحتياطي بدل الرمي", async () => {
    process.env[URL_KEY] = "not-a-url";
    const { getFaq } = await import("../src/lib/db");
    const faq = await getFaq();
    assert.ok(Array.isArray(faq) && faq.length > 0);
  });

  // هذا الاختبار آخر المجموعة عمدًا: `db()` يخزّن العميل على مستوى الوحدة،
  // ولا اختبار بعده في هذا الملف يعتمد على قاعدة مدخل البيئة.
  test("رابط صالح بهامش لصق (مسافات/سطر) يُشذَّب ويُبنى عميله بلا رمي", () => {
    process.env[URL_KEY] = "  libsql://127.0.0.1:9  \n";
    process.env[TOKEN_KEY] = "tok";
    assert.equal(hasDB(), true);
    const client = db();
    assert.ok(client, "التشذيب يجب أن يجعل القيمة صالحة للبناء");
    client.close();
  });
});

describe("scripts/scan-bundle-secrets — حاجز تسريب حزمة العميل", () => {
  test("اسم سر خادم في الأثر المبنيّ = تسريب (بلا حاجة لقيمة)", () => {
    const hits = scanTextForSecrets('const x = process.env.ADMIN_SESSION_SECRET;');
    assert.deepEqual(hits, [{ kind: "name", label: "ADMIN_SESSION_SECRET" }]);
  });

  test("نص نظيف لا يُنتج أي أثر", () => {
    assert.deepEqual(scanTextForSecrets('console.log("hello", process.env.NEXT_PUBLIC_X)'), []);
  });

  test("القيمة الحقيقية تُكتشف عند --check-env، والقيم القصيرة تُتجاهل", () => {
    const values = [
      { label: "ADMIN_PASSWORD", value: "super-secret-password-123" },
      { label: "DIAGNOSTICS_KEY", value: "short" },
    ];
    const leaked = scanTextForSecrets('var p="super-secret-password-123";', values);
    assert.deepEqual(leaked, [{ kind: "value", label: "ADMIN_PASSWORD" }]);
    assert.deepEqual(scanTextForSecrets('var p="short";', values), []);
  });

  test("قائمة الأسماء تغطي أسرار الخادم الأساسية", () => {
    for (const name of ["ADMIN_SESSION_SECRET", "ADMIN_PASSWORD", "TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL"]) {
      assert.ok(SERVER_SECRET_NAMES.includes(name), `${name} غائب عن قائمة الفحص`);
    }
  });

  test("أمر الفحص مركّب في البوابات (quality.yml و deploy.yml)", () => {
    for (const file of [".github/workflows/quality.yml", ".github/workflows/deploy.yml"]) {
      const workflow = fs.readFileSync(file, "utf8");
      assert.match(workflow, /npm run security:bundle/, `${file} لا يشغّل فحص حزمة العميل`);
    }
  });

  test("حزمة البناء الفعلية نظيفة (يُشغَّل بعد npm run build)", () => {
    const dir = path.join(process.cwd(), ".next", "static");
    if (!fs.existsSync(dir)) return; // لا حزمة مبنيّة في هذه البيئة — لا حكم
    const files: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|mjs|css|html|json|txt)$/.test(entry.name)) files.push(full);
      }
    };
    walk(dir);
    assert.ok(files.length > 0, "الحزمة المبنيّة يجب أن تحوي ملفات");
    for (const file of files) {
      const hits = scanTextForSecrets(fs.readFileSync(file, "utf8"));
      assert.deepEqual(hits, [], `تسريب محتمل في ${file}: ${JSON.stringify(hits)}`);
    }
  });
});

describe("scripts/security-gates — عزل العميل/الخادم", () => {
  test("المكوّنات المعلَّمة بـ use client لا تستورد وحدات خادم فقط", () => {
    const serverOnly = ["@/lib/auth", "@/lib/secrets", "@/lib/db", "@/lib/orders", "@/lib/rate-limit"];
    const roots = ["src/app", "src/components"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const src = fs.readFileSync(full, "utf8");
          if (!/^\s*["']use client["']/m.test(src)) continue;
          for (const mod of serverOnly) {
            if (src.includes(`from "${mod}"`) || src.includes(`from '${mod}'`)) offenders.push(`${full} → ${mod}`);
          }
        }
      }
    };
    for (const root of roots) if (fs.existsSync(root)) walk(root);
    assert.deepEqual(offenders, [], `مكوّنات عميل تستورد وحدات خادم: ${offenders.join(", ")}`);
  });
});

describe("scripts/verify-turso — تقرير آلي", () => {
  test("قاعدة مهاجَرة بالكامل تعطي كل الفحوص خضراء", async () => {
    const { client, url } = fileClient("aborof-verify-ok");
    await runMigrations(client);
    client.close();

    const out = JSON.parse(runVerifyTurso(url)) as { ok: boolean; rows: { id: string; ok: boolean }[] };
    assert.equal(out.ok, true, JSON.stringify(out.rows));
    assert.deepEqual(
      out.rows.map((r) => r.id),
      ["conn", "mig-table", "mig-parity", "row-7", "row-8", "row-9", "tables"]
    );
  });

  test("غياب order_items (فشل P0) يُسقط الفحص بكود خروج 1", async () => {
    const { client, url } = fileClient("aborof-verify-p0");
    await runMigrations(client);
    await client.execute("DROP TABLE order_items");
    client.close();

    let exitCode = 0;
    let stdout = "";
    try {
      stdout = runVerifyTurso(url);
    } catch (error) {
      const e = error as { status?: number; stdout?: string };
      exitCode = e.status ?? 0;
      stdout = e.stdout ?? "";
    }
    assert.equal(exitCode, 1, "كان يجب أن يفشل الفحص");
    const parsed = JSON.parse(stdout) as { ok: boolean; rows: { id: string; ok: boolean }[] };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.rows.find((r) => r.id === "row-7")?.ok, false);
  });

  test("انحراف فهرس FTS5 عن الكتالوج يُكتشف (الصف 9)", async () => {
    const { client, url } = fileClient("aborof-verify-fts");
    await runMigrations(client);
    await client.execute(
      "INSERT INTO products (id,name,description,price,category,image,stock) VALUES ('p9','منتج','وصف',10,'x','🧴',3)"
    );
    client.close();

    let exitCode = 0;
    let stdout = "";
    try {
      stdout = runVerifyTurso(url);
    } catch (error) {
      const e = error as { status?: number; stdout?: string };
      exitCode = e.status ?? 0;
      stdout = e.stdout ?? "";
    }
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stdout) as { rows: { id: string; ok: boolean; detail: string }[] };
    const row9 = parsed.rows.find((r) => r.id === "row-9");
    assert.equal(row9?.ok, false);
    assert.match(String(row9?.detail), /products=1 \/ product_search=0/);
  });
});

describe(".github/workflows/deploy.yml — بوابة النشر", () => {
  const workflow = fs.readFileSync(".github/workflows/deploy.yml", "utf8");

  test("شرط وظيفة النشر يقرأ مخرج وظيفة البوابة لا `vars` (لأن متغيرات البيئة غير مرئية في if على مستوى الوظيفة)", () => {
    assert.match(
      workflow,
      /if:\s*\$\{\{\s*needs\.deploy-gate\.outputs\.enabled == 'true'\s*\}\}/,
      "وظيفة deploy يجب أن تعتمد على needs.deploy-gate.outputs.enabled"
    );
    assert.doesNotMatch(
      workflow,
      /if:.*vars\.VERCEL_DEPLOY_ENABLED/,
      "لا يجوز قراءة VERCEL_DEPLOY_ENABLED في شرط على مستوى الوظيفة — ستكون فارغة دائمًا مع متغيرات البيئة"
    );
  });

  test("وظيفة البوابة تقرأ المتغير داخل خطوة env وتصدّره كمخرج", () => {
    assert.match(workflow, /deploy-gate:/, "وظيفة deploy-gate مفقودة");
    assert.match(workflow, /GATE_VALUE: \$\{\{\s*vars\.VERCEL_DEPLOY_ENABLED\s*\}\}/, "البوابة يجب أن تمرّر المتغير عبر env داخل الخطوة");
    assert.match(workflow, /enabled=\$?\(?.*GITHUB_OUTPUT|echo "enabled=(true|false)" >> "\$GITHUB_OUTPUT"/, "البوابة يجب أن تكتب enabled في GITHUB_OUTPUT");
  });

  test("وظيفة النشر تبقى `skipped` عند إغلاق البوابة (needs على البوابة وبدون شرط ref فقط)", () => {
    assert.match(workflow, /needs:\s*\[quality-gates,\s*deploy-gate\]/, "وظيفة deploy يجب أن تعتمد على quality-gates و deploy-gate");
    assert.match(workflow, /github\.ref == 'refs\/heads\/main'/, "بوابة النشر مقصورة على main");
  });

  test("ملخص النشر يعرض حالة البوابة", () => {
    assert.match(workflow, /needs:\s*\[quality-gates,\s*deploy-gate,\s*deploy\]/, "وظيفة report يجب أن تعتمد على وظائف البوابة والنشر");
    assert.match(workflow, /Deploy gate \(VERCEL_DEPLOY_ENABLED\)/, "الملخص يجب أن يذكر حالة البوابة");
  });

  test("خطوات vercel تبثّ فشلها كتعليقات ::error:: (السجلات قد تكون محجوبة عن الشبكة)", () => {
    assert.match(workflow, /Vercel preflight/, "خطوة الطيران التمهيدي لهوية الرمز/المشروع مفقودة");
    assert.match(workflow, /::error::vercel pull فشل/, "فشل vercel pull يجب أن يُبث كتعليق");
    assert.match(workflow, /::error::vercel build فشل/, "فشل vercel build يجب أن يُبث كتعليق");
    assert.match(workflow, /::error::vercel deploy فشل/, "فشل vercel deploy يجب أن يُبث كتعليق");
  });
});

/**
 * الصفوف 15–17 في الـ smoke test تغطّي العطل الإنتاجي الذي أبقى كل صفحات المنتجات
 * 404، و«404 الناعم»، وتعقب وسمَي robots المتعارضين. لا يمكن تشغيل السكربت نفسه
 * محليًا (isSafeBaseUrl يرفض localhost عن قصد)، لذلك نختبر الدالة النقية بأجسام مصنوعة.
 */
describe("smoke — الواجهة المنشورة (الصفوف 15–17)", () => {
  const ok = (text: string, status = 200) => ({ status, text });
  const healthy = {
    sampleId: "p1",
    sampleName: "منظف أرضيات برائحة اللافندر 5 لتر",
    productPage: ok(
      '<title>منظف أرضيات برائحة اللافندر 5 لتر — 180 جنيه | روفيده</title><link rel="canonical" href="https://aborof.vercel.app/product/p1"/>'
    ),
    missing: ok('<meta name="robots" content="noindex"/>', 404),
    missingRoute: ok("", 404),
    robotsTxt: ok("User-Agent: *\nDisallow: /admin\nSitemap: https://aborof.vercel.app/sitemap.xml"),
    sitemapXml: ok("<urlset><url><loc>https://aborof.vercel.app/</loc></url><url><loc>https://aborof.vercel.app/product/p1</loc></url></urlset>"),
    webmanifest: ok("{}"),
    iconSvg: ok("<svg/>"),
  };

  test("النشر السليم: الصفوف 15 و16 و16b و17 خضراء", () => {
    const findings = frontPageFindings(healthy);
    assert.deepEqual(findings.map((f) => f.id), ["15", "16", "16b", "17"]);
    for (const f of findings) assert.ok(f.ok, `${f.id} فشل: ${f.actual}`);
  });

  test("عودة عطل params (404 لكل منتج) تُكتشف برسالة عطل صريحة", () => {
    const findings = frontPageFindings({ ...healthy, productPage: ok("404: This page could not be found.", 404) });
    const row15 = findings.find((f) => f.id === "15");
    assert.equal(row15?.ok, false);
    assert.match(String(row15?.actual), /params/);
  });

  test("صفحة منتج بميتاداتا ناقصة (بلا canonical أو بعنوان عام) تفشل", () => {
    const noCanonical = frontPageFindings({ ...healthy, productPage: ok("<title>روفيده — لأدوات ومستلزمات النظافة</title>") });
    assert.equal(noCanonical.find((f) => f.id === "15")?.ok, false, "عنوان الـlayout العام يجب ألا يُقبل كعنوان منتج");
    const noTitle = frontPageFindings({ ...healthy, productPage: ok('<link rel="canonical" href="/product/p1"/>') });
    assert.equal(noTitle.find((f) => f.id === "15")?.ok, false);
  });

  test("«404 ناعم» (200 بمحتوى 404) يُكتشف ويُشرح سببه", () => {
    const findings = frontPageFindings({ ...healthy, missing: ok("الصفحة أو المنتج غير موجود", 200) });
    const row16 = findings.find((f) => f.id === "16");
    assert.equal(row16?.ok, false);
    assert.match(String(row16?.actual), /404 ناعم/);
  });

  test("404 بلا noindex أو بوسم robots متعارض يفشل", () => {
    const noNoindex = frontPageFindings({ ...healthy, missing: ok("<html></html>", 404) });
    assert.equal(noNoindex.find((f) => f.id === "16")?.ok, false, "404 بلا noindex يجب أن يفشل");
    const conflict = frontPageFindings({
      ...healthy,
      missing: ok('<meta name="robots" content="noindex"/><meta name="robots" content="index, follow"/>', 404),
    });
    assert.equal(conflict.find((f) => f.id === "16")?.ok, false, "وسما robots متعارضان يجب أن يظهرا كفشل");
    assert.match(String(conflict.find((f) => f.id === "16")?.actual), /متعارض/);
  });

  test("robots بلا حجب /admin أو خريطة تكشف /admin تفشل", () => {
    const noBlock = frontPageFindings({ ...healthy, robotsTxt: ok("User-Agent: *\nAllow: /") });
    assert.equal(noBlock.find((f) => f.id === "17")?.ok, false);
    const leaky = frontPageFindings({
      ...healthy,
      sitemapXml: ok("<urlset><url><loc>https://aborof.vercel.app/admin</loc></url></urlset><loc>"),
    });
    assert.equal(leaky.find((f) => f.id === "17")?.ok, false);
  });

  test("ملف ميتاداتا مفقود (غير 200) يفشل الصف 17", () => {
    const findings = frontPageFindings({ ...healthy, sitemapXml: ok("", 500) });
    const row17 = findings.find((f) => f.id === "17");
    assert.equal(row17?.ok, false);
    assert.match(String(row17?.actual), /500/);
  });

  test("يستخرج digest حدّ الخطأ من HTML ويرجع null عند غيابه", () => {
    assert.equal(extractErrorDigest('<p class="state-code">رقم المرجع: 3763750452</p>'), "3763750452");
    assert.equal(extractErrorDigest("<title>منتج سليم</title>"), null);
    assert.equal(extractErrorDigest(null), null);
  });

  test("الصف 15 عند 500 يُلحق الـ digest لربطه بسجل Vercel (بلاغ 2026-09-28)", () => {
    const findings = frontPageFindings({ ...healthy, productPage: ok("<p>رقم المرجع: 3763750452</p>", 500) });
    const row15 = findings.find((f) => f.id === "15");
    assert.equal(row15?.ok, false);
    assert.match(String(row15?.actual), /3763750452/);
  });
});
