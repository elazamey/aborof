import { test, describe, before, after, beforeEach, afterEach } from "node:test";
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
  probeHttpEndpoint,
  resolveTursoToken,
} from "../scripts/lib/db-url.mjs";
import { resolveAppToken } from "../src/lib/db/token";
import {
  isSafeBaseUrl,
  classifySecurityHeaders,
  looksLikeSeedFallback,
  frontPageFindings,
  extractErrorDigest,
  dbSourceFromResponse,
  smokeVerdict,
  LATENCY_BUDGET_MS,
  BASELINE_SECURITY_HEADERS,
} from "../scripts/smoke-production.mjs";
import { scanTextForSecrets, SERVER_SECRET_NAMES } from "../scripts/scan-bundle-secrets.mjs";
import { checkSchemaContract } from "../scripts/lib/schema-contract.mjs";
import { setDbClientForTest, db, hasDB, getProductsWithSource } from "../src/lib/db";
import { snapshot as metricsSnapshot } from "../src/lib/observability/metrics";
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

  test("كل حكم خام يحمل كودًا ثابتًا — و401 بجسم empty-JWT كود مستقل", () => {
    assert.equal(interpretProbeStatus(200).code, null);
    assert.equal(interpretProbeStatus(401).code, "TURSO_AUTH_401");
    assert.equal(interpretProbeStatus(404).code, "TURSO_DB_NOT_FOUND");
    assert.equal(interpretProbeStatus(400, "x").code, "TURSO_REQUEST_REJECTED");
    assert.equal(interpretProbeStatus(500).code, "TURSO_UNEXPECTED_STATUS");
    const empty = interpretProbeStatus(401, '{"error":"Unauthorized: empty JWT token"}');
    assert.equal(empty.code, "TURSO_AUTH_401_EMPTY_JWT");
    assert.match(empty.verdict, /لم يصل للخادم/);
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
    assert.match(res.stdout, /\[TURSO_TOKEN_MALFORMED\]/);
    assert.match(res.stdout, /\| conn-url-shape \|/);
    assert.match(res.stdout, /^FINAL: BLOCKED$/m);
    assert.doesNotMatch(res.stdout + res.stderr, /is not defined/);
    assert.doesNotMatch(res.stdout, /example-db-example/, "لا يُطبع الرابط ولا الرمز");
  });

  test("صفّا الصيغة والسبب يُسجَّلان دائمًا (بلا علم ترميم) ولا تُطبع أي قيمة", () => {
    // حالة فحص 2026-09-28: رابط سليم الشكل + رمز JWT سليم الشكل مرفوض (401).
    // بلا هذين الصفين كان التقرير يقول «401» فقط بلا تمييز رمز/قاعدة.
    // النطاق `.invalid` محجوز (RFC 2606) لا يحلّ أبدًا — فيجعل الكود حتميًا
    // (`TURSO_UNREACHABLE`) في كل البيئات. مضيف `*.turso.io` وهمي كان سيحلّ
    // عبر wildcard إلى حافة Turso في CI (404) بينما يفشل DNS محليًا —
    // لاحتمية كاذبة أسقطت البوابة مرة (انظر سجل PR #18).
    const env = {
      ...process.env,
      TURSO_DATABASE_URL: "libsql://no-such-db-xyz123.invalid",
      TURSO_AUTH_TOKEN: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl",
    };
    const res = spawnSync("node", ["scripts/verify-turso.mjs"], { encoding: "utf8", env });
    assert.equal(res.status, 1, "صفوف حمراء تعني 1");
    assert.match(res.stdout, /\| conn-token-shape \|/);
    assert.match(res.stdout, /الصيغة سليمة/);
    assert.match(res.stdout, /\| conn-url-shape \|/);
    assert.match(res.stdout, /\| conn-cause \|/);
    assert.match(res.stdout, /\[TURSO_UNREACHABLE\]/);
    assert.match(res.stdout, /\[TURSO_CONN_FAILED\]/);
    assert.match(res.stdout, /^FINAL: BLOCKED$/m);
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
    assert.match(res.stdout, /\[TURSO_CLIENT_INIT_FAILED\]/);
    assert.match(res.stdout, /\[TURSO_URL_INVALID\]/);
    assert.match(res.stdout, /^FINAL: BLOCKED$/m);
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

describe("src/lib/db — الحالة B: فشل وقت الاستعلام (401/شبكة) لا يُنتج 500 خامًا", () => {
  // العقد الصريح المطلوب: قرّاء الكتالوج يسقطون للبذرة (200)، وكتّاب الطلبات
  // يترجمون الفشل إلى 503 محكوم — والخام (500) مرفوض في الحالتين.
  // الاختبارات تحاكي Turso الحقيقي: `POST /v2/pipeline` + `Bearer` ثم `401`.
  let savedUrl: string | undefined;
  let savedToken: string | undefined;

  beforeEach(() => {
    savedUrl = process.env.TURSO_DATABASE_URL;
    savedToken = process.env.TURSO_AUTH_TOKEN;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    setDbClientForTest(null);
  });
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = savedUrl;
    if (savedToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
    else process.env.TURSO_AUTH_TOKEN = savedToken;
    setDbClientForTest(null);
  });

  test("رفض 401 من الخادم ⇒ getProducts يسقط للبذرة (والترويسة وصلت فعلًا)", async () => {
    const { start401Stub } = await import("./stub-helpers");
    const stub = await start401Stub();
    const client = createClient({ url: stub.url, authToken: "stub-token-value" });
    setDbClientForTest(client);
    try {
      const { getProducts } = await import("../src/lib/db");
      const products = await getProducts();
      assert.deepEqual(products, SEED_PRODUCTS);
      assert.ok(stub.seen.count > 0, "العميل يجب أن يرسل الطلب فعلًا قبل السقوط");
      assert.ok(
        stub.seen.auth?.startsWith("Bearer "),
        "ترويسة التفويض يجب أن تصل للخادم (يحاكي طلبًا موثّقًا مرفوضًا)"
      );
    } finally {
      setDbClientForTest(null);
      client.close();
      await stub.close();
    }
  });

  test("تعذّر الوصول (DNS/شبكة) ⇒ getProducts وgetFaq يسقطان للبدائل", async () => {
    const { UNREACHABLE_LIBSQL_URL } = await import("./stub-helpers");
    const client = createClient({ url: UNREACHABLE_LIBSQL_URL, authToken: "x" });
    setDbClientForTest(client);
    try {
      const { getProducts, getFaq } = await import("../src/lib/db");
      assert.deepEqual(await getProducts(), SEED_PRODUCTS);
      const faq = await getFaq();
      assert.ok(Array.isArray(faq) && faq.length > 0);
    } finally {
      setDbClientForTest(null);
      client.close();
    }
  });

  test("mapDatabaseWriteError: يمرّر DomainError ويترجم الخام إلى 503", async () => {
    const { mapDatabaseWriteError } = await import("../src/lib/db");
    const { DomainError, Errors } = await import("../src/lib/errors");
    // قرار عمل (تعارض مخزون) يمر كما هو — لا يُقنَّع بخطأ بنية.
    const conflict = Errors.conflict("غير متاح");
    assert.throws(() => mapDatabaseWriteError("op", conflict), (e: unknown) => e === conflict);
    // خام المزود (401 وقت الكتابة) ⇒ 503 محكوم.
    assert.throws(
      () => mapDatabaseWriteError("op", new Error("SERVER_ERROR: Server returned HTTP status 401")),
      (e: unknown) =>
        e instanceof DomainError &&
        e.code === "SERVICE_UNAVAILABLE" &&
        (e as { status?: number }).status === 503
    );
  });

  test("createOrder مع قاعدة ترفض 401 ⇒ يرمي 503 لا 500 خامًا", async () => {
    const { start401Stub } = await import("./stub-helpers");
    const { DomainError } = await import("../src/lib/errors");
    const stub = await start401Stub();
    const client = createClient({ url: stub.url, authToken: "stub-token-value" });
    setDbClientForTest(client);
    try {
      const { createOrder } = await import("../src/lib/orders");
      const { createOrderContract } = await import("../src/lib/validation/contracts");
      // الدخل عبر العقد نفسه (يطبّق القيم الافتراضية كما يفعل المسار).
      const input = createOrderContract.parse({
        customer: "محمد أحمد",
        phone: "01095032221",
        address: "شارع طويل بما يكفي لعنوان التوصيل",
        governorate: "القاهرة",
        payment: "vodafone_cash",
        items: [{ id: "p1", qty: 1 }],
      });
      await assert.rejects(
        () => createOrder(input, SEED_PRODUCTS),
        (e: unknown) => e instanceof DomainError && e.code === "SERVICE_UNAVAILABLE"
      );
    } finally {
      setDbClientForTest(null);
      client.close();
      await stub.close();
    }
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

  test("البوابة نفسها خضراء على الشجرة الحالية (تُنفَّذ لا تُعاد كتابتها)", () => {
    const res = spawnSync("node", ["scripts/security-gates.mjs"], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr || res.stdout);
  });

  test("قاعدة NEXT_PUBLIC_TURSO_* حاضرة في البوابة (الرمز server-only دائمًا)", () => {
    const gate = fs.readFileSync("scripts/security-gates.mjs", "utf8");
    assert.match(gate, /NEXT_PUBLIC_TURSO_/, "حذف القاعدة صامتًا يجب أن يفشل هذا الاختبار");
  });
});

describe("scripts/verify-turso — تقرير آلي", () => {
  test("قاعدة مهاجَرة بالكامل تعطي كل الفحوص خضراء", async () => {
    const { client, url } = fileClient("aborof-verify-ok");
    await runMigrations(client);
    client.close();

    const out = JSON.parse(runVerifyTurso(url)) as {
      ok: boolean;
      verdict: string;
      rows: { id: string; ok: boolean; code: string | null }[];
    };
    assert.equal(out.ok, true, JSON.stringify(out.rows));
    assert.equal(out.verdict, "PASS");
    assert.deepEqual(
      out.rows.map((r) => r.id),
      ["conn", "mig-table", "mig-parity", "db-identity", "schema-contract", "row-7", "row-8", "row-9", "tables"]
    );
    assert.ok(out.rows.every((r) => r.code === null), "الصفوف الخضراء بلا أكواد");
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
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      verdict: string;
      rows: { id: string; ok: boolean; code: string | null }[];
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.verdict, "BLOCKED");
    assert.equal(parsed.rows.find((r) => r.id === "row-7")?.ok, false);
    assert.equal(parsed.rows.find((r) => r.id === "row-7")?.code, "ROW7_ORDER_ITEMS_MISSING");
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

  test("البناء لا يشغّل هجرة ولا بذرة (الهجرات وقت التشغيل عبر ensureSchema فقط)", () => {
    // نمط `migrate && build` خطير: يخلط النشر بتغيير القاعدة. البوابة هنا تمنعه
    // بنيويًا — أي هجرة وقت البناء تُفشل الاختبار (ومن ثم CI) فورًا.
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    for (const name of ["build", "postinstall", "preinstall"]) {
      const cmd = pkg.scripts[name];
      if (!cmd) continue;
      assert.doesNotMatch(cmd, /migrat|seed/i, `السكربت ${name} يجب ألا يلمس قاعدة البيانات`);
    }
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

describe("فصل الاعتمادات — resolveTursoToken (السكربتات) و resolveAppToken (التشغيل)", () => {
  test("المجسّ (ci) يفضّل TURSO_AUTH_TOKEN_CI على المشترك", () => {
    const r = resolveTursoToken({ TURSO_AUTH_TOKEN_CI: "ci-token", TURSO_AUTH_TOKEN: "legacy" }, "ci");
    assert.deepEqual(r, { token: "ci-token", source: "TURSO_AUTH_TOKEN_CI", fallback: false });
  });

  test("أدوار prod/preview تفضّل متغيرها الخاص", () => {
    assert.equal(resolveTursoToken({ TURSO_AUTH_TOKEN_PROD: "p", TURSO_AUTH_TOKEN: "l" }, "prod").source, "TURSO_AUTH_TOKEN_PROD");
    assert.equal(
      resolveTursoToken({ TURSO_AUTH_TOKEN_PREVIEW: "v", TURSO_AUTH_TOKEN: "l" }, "preview").source,
      "TURSO_AUTH_TOKEN_PREVIEW"
    );
  });

  test("غياب المفصول يسقط على المشترك مع إعلان fallback (لا بصمت)", () => {
    const r = resolveTursoToken({ TURSO_AUTH_TOKEN: "legacy" }, "ci");
    assert.deepEqual(r, { token: "legacy", source: "TURSO_AUTH_TOKEN", fallback: true });
  });

  test("الغياب الكامل يعيد null بلا سقوط", () => {
    assert.deepEqual(resolveTursoToken({}, "ci"), { token: null, source: null, fallback: false });
  });

  test("تشغيل التطبيق يفضّل TURSO_AUTH_TOKEN_PROD ثم المشترك", () => {
    assert.deepEqual(resolveAppToken({ TURSO_AUTH_TOKEN_PROD: "p", TURSO_AUTH_TOKEN: "l" }), {
      token: "p",
      source: "TURSO_AUTH_TOKEN_PROD",
      fallback: false,
    });
    assert.deepEqual(resolveAppToken({ TURSO_AUTH_TOKEN: "l" }), {
      token: "l",
      source: "TURSO_AUTH_TOKEN",
      fallback: true,
    });
    assert.deepEqual(resolveAppToken({}), { token: null, source: null, fallback: false });
  });

  test("قاعدتا src وscripts متطابقتان سلوكيًا للدور prod (مصدران، حقيقة واحدة)", () => {
    const envs = [
      { TURSO_AUTH_TOKEN_PROD: "p", TURSO_AUTH_TOKEN: "l" },
      { TURSO_AUTH_TOKEN: "l" },
      {},
    ];
    for (const env of envs) {
      assert.deepEqual(resolveTursoToken(env, "prod"), resolveAppToken(env));
    }
  });
});

describe("scripts/verify-turso — صف هوية القاعدة (db-identity)", () => {
  type Row = { id: string; ok: boolean; detail: string; code: string | null };
  type Report = { ok: boolean; verdict: string; rows: Row[] };

  function runReport(url: string): { exitCode: number; report: Report } {
    try {
      return { exitCode: 0, report: JSON.parse(runVerifyTurso(url)) as Report };
    } catch (error) {
      const e = error as { status?: number; stdout?: string };
      return { exitCode: e.status ?? 0, report: JSON.parse(e.stdout ?? "{}") as Report };
    }
  }

  test("قاعدة مهاجَرة: النسب موثّق ببصمة وcode:null", async () => {
    const { client, url } = fileClient("aborof-identity-ok");
    await runMigrations(client);
    client.close();
    const { exitCode, report } = runReport(url);
    assert.equal(exitCode, 0);
    const row = report.rows.find((r) => r.id === "db-identity");
    assert.equal(row?.ok, true);
    assert.equal(row?.code, null);
    assert.match(String(row?.detail), /النسب موثّق/);
    assert.match(String(row?.detail), /fp [0-9a-f]{12}/);
  });

  test("تشعّب النسب (نفس الرقم ببصمة مختلفة) يحجب بـ DB_IDENTITY_FORKED", async () => {
    const { client, url } = fileClient("aborof-identity-fork");
    await runMigrations(client);
    await client.execute("UPDATE schema_migrations SET checksum='00' WHERE version='0001'");
    client.close();
    const { exitCode, report } = runReport(url);
    assert.equal(exitCode, 1);
    assert.equal(report.verdict, "BLOCKED");
    const row = report.rows.find((r) => r.id === "db-identity");
    assert.equal(row?.ok, false);
    assert.equal(row?.code, "DB_IDENTITY_FORKED");
  });

  test("قاعدة عارية (بلا نسب ولا جداول متجر) تحجب بـ DB_IDENTITY_EMPTY", async () => {
    const { client, url } = fileClient("aborof-identity-empty");
    client.close();
    const { exitCode, report } = runReport(url);
    assert.equal(exitCode, 1);
    assert.equal(report.verdict, "BLOCKED");
    const row = report.rows.find((r) => r.id === "db-identity");
    assert.equal(row?.ok, false);
    assert.equal(row?.code, "DB_IDENTITY_EMPTY");
  });

  test("التأخر بهجرة: نفس القاعدة تمرّ في db-identity بينما mig-parity تحجب (سؤالان مختلفان)", async () => {
    const { client, url } = fileClient("aborof-identity-behind");
    await runMigrations(client);
    await client.execute("DELETE FROM schema_migrations WHERE version='0002'");
    client.close();
    const { exitCode, report } = runReport(url);
    assert.equal(exitCode, 1, "الحجب يأتي من mig-parity");
    assert.equal(report.verdict, "BLOCKED");
    // نفس القاعدة (لا تشعّب ولا عراء) ⇒ صف الهوية أخضر بملاحظة التأخر.
    assert.equal(report.rows.find((r) => r.id === "db-identity")?.ok, true);
    assert.match(String(report.rows.find((r) => r.id === "db-identity")?.detail), /متأخرة/);
    // لكنها ليست بنفس الإصدار ⇒ صف التطابق أحمر.
    assert.equal(report.rows.find((r) => r.id === "mig-parity")?.ok, false);
  });
});

describe("قفل عدم الكتابة في مجسّ الأدلة", () => {
  test("المجسّ ومكتباته لا تنفّذ إلا عبارات قراءة (SELECT أو PRAGMA table_info حصرًا)", () => {
    const files = ["scripts/verify-turso.mjs", "scripts/lib/schema-contract.mjs"];
    let total = 0;
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      const stmts = [...src.matchAll(/\.execute\(\s*["'`]([A-Za-z]+)(?:\s+([A-Za-z_]+))?/g)].map((m) => [
        m[1].toUpperCase(),
        (m[2] ?? "").toUpperCase(),
      ]);
      total += stmts.length;
      for (const [first, second] of stmts) {
        // أي SELECT (بأي بقية) أو PRAGMA table_info حصرًا — أي PRAGMA آخر مرفوض.
        const ok = first === "SELECT" || (first === "PRAGMA" && second === "TABLE_INFO");
        assert.ok(ok, `عبارة غير مقروءة في ${file}: ${first} ${second} (المسموح SELECT/PRAGMA table_info فقط)`);
      }
      const payloadVerbs = [...src.matchAll(/sql:\s*["'`]([A-Za-z]+)/g)].map((m) => m[1].toUpperCase());
      assert.ok(payloadVerbs.every((v) => v === "SELECT"), `حمولة hrana غير SELECT في ${file}: ${payloadVerbs.join(",")}`);
    }
    assert.ok(total > 5, "الحارس نفسه يجب أن يجد مواقع التنفيذ — وإلا فهو يمرّر بصمت");
  });

  test("المجسّ لا يستخدم .batch ولا يستورد مشغّل الهجرات ولا مجهّز البنية", () => {
    // الأنماط على شكل معرّف (استيراد/استدعاء) لا اسم عارٍ: ذِكر الاسم في
    // تعليق أو سلسلة (توثيق/رسالة مستخدم) ليس وصولًا لمسار الكتابة.
    const src = fs.readFileSync("scripts/verify-turso.mjs", "utf8");
    assert.doesNotMatch(src, /\.batch\(/);
    assert.doesNotMatch(src, /import[^;]*\brunMigrations\b/);
    assert.doesNotMatch(src, /\brunMigrations\s*\(/);
    // ensureSchema تكتب (هجرات + بذرة) — غياب استيرادها واستدعائها ضابطة
    // سالبة بنيوية: المجسّ لا يستطيع الوصول لمسار الكتابة أصلًا.
    assert.doesNotMatch(src, /import[^;]*\bensureSchema\b/);
    assert.doesNotMatch(src, /\bensureSchema\s*\(/);
  });

  test("غلاف CI يشغّل الـ smoke بلا أي علم طافر (GET فقط)", () => {
    const src = fs.readFileSync("scripts/probe-turso-ci.sh", "utf8");
    const line = src.split("\n").find((l) => l.includes("smoke-production.mjs") && !l.trim().startsWith("#"));
    assert.ok(line, "سطر استدعاء الـ smoke مفقود من الغلاف");
    assert.doesNotMatch(line, /--allow-mutations|--orders-body|--track|--admin-probe|--chat-probe/);
  });
});

describe(".github/workflows/turso-evidence.yml — المجسّ المجدول والتنبيه", () => {
  const workflow = fs.readFileSync(".github/workflows/turso-evidence.yml", "utf8");

  test("جدولة يومية (schedule + cron)", () => {
    assert.match(workflow, /schedule:\s*\n(\s*#.*\n|\s*\n)*\s*- cron: ".+ .+ .+ .+ .+"/);
  });

  test("وظيفة تنبيه مقصورة على التشغيل المجدول (always + schedule + قضية turso-probe)", () => {
    assert.match(workflow, /probe-alert:/);
    assert.match(workflow, /always\(\) && github\.event_name == 'schedule'/);
    assert.match(workflow, /turso-probe/);
    assert.match(workflow, /gh issue (create|close|edit)/);
  });

  test("وظيفة التنبيه بأقل صلاحية (issues: write فقط)", () => {
    const alert = workflow.slice(workflow.indexOf("probe-alert:"));
    assert.match(alert, /permissions:\s*\n(\s*#.*\n)*\s*issues: write/);
    assert.doesNotMatch(alert, /contents: write|pull-requests: write/);
  });

  test("وظيفتا الفحص تمرّران رمز CI مع بقاء المشترك بديلًا", () => {
    const ciCount = (workflow.match(/TURSO_AUTH_TOKEN_CI: \$\{\{ secrets\.TURSO_AUTH_TOKEN_CI \}\}/g) ?? []).length;
    assert.ok(ciCount >= 2, `رمز CI يُمرَّر في ${ciCount} مواضع فقط`);
    assert.match(workflow, /TURSO_AUTH_TOKEN: \$\{\{ secrets\.TURSO_AUTH_TOKEN \}\}/);
  });

  test("الحكم يُصدَّر كمخرج والتقرير JSON يُرفع قطعة أثرية", () => {
    assert.match(workflow, /echo "verdict=.*>> "\$GITHUB_OUTPUT"/);
    assert.match(workflow, /upload-artifact@v4/);
    assert.match(workflow, /retention-days: 90/);
  });
});

describe(".github/workflows/quality.yml — حاجز التسريب يغطي الأسماء المفصولة", () => {
  test("نمط grep يطابق TURSO_AUTH_TOKEN_PROD/CI/PREVIEW لا الاسم القديم وحده", () => {
    const quality = fs.readFileSync(".github/workflows/quality.yml", "utf8");
    assert.match(quality, /TURSO_AUTH_TOKEN\(_PROD\|_CI\|_PREVIEW\)\?=\[A-Za-z0-9_-\]\{20,\}/);
  });
});

describe("scripts/apply-turso-secrets — فصل الرموز", () => {
  const run = (env: Record<string, string>, args: string[] = ["--dry-run"], extraPath = "") =>
    spawnSync("bash", ["scripts/apply-turso-secrets.sh", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        ...(extraPath ? { PATH: `${extraPath}:${process.env.PATH ?? "/usr/bin:/bin"}` } : {}),
      },
    });
  const GOOD_URL = "libsql://aborof-elazamey.turso.io";
  const PROD_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcm9kIn0.c2lnbmF0dXJlLXByb2Q";
  const CI_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjaSJ9.c2lnbmF0dXJlLWNp";

  // بدائل وهمية لـ gh/vercel: خطة --dry-run تُبنى فقط للأدوات الموجودة على
  // PATH، والبدائل تجعل ظهور سطور GitHub وVercel حتميًا في كل البيئات.
  function stubBin(): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "aborof-bin-"));
    for (const name of ["gh", "vercel"]) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(p, 0o755);
    }
    return dir;
  }

  test("رمزان مفصولان: الخطة تذكر الاسمين الجديدين بلا تحذير مشترك وبلا تسريب", () => {
    const res = run(
      { TURSO_DATABASE_URL: GOOD_URL, TURSO_AUTH_TOKEN_PROD: PROD_TOKEN, TURSO_AUTH_TOKEN_CI: CI_TOKEN },
      ["--dry-run"],
      stubBin()
    );
    assert.equal(res.status, 0);
    assert.match(res.stdout, /TURSO_AUTH_TOKEN_PROD: JWT \(طول/);
    assert.match(res.stdout, /TURSO_AUTH_TOKEN_CI: +JWT \(طول/);
    assert.match(res.stdout, /gh secret set TURSO_AUTH_TOKEN_CI/);
    assert.match(res.stdout, /vercel env add TURSO_AUTH_TOKEN_PROD/);
    assert.doesNotMatch(res.stdout + res.stderr, /مشترك انتقالي/);
    assert.doesNotMatch(res.stdout + res.stderr, /c2lnbmF0dXJl/);
    assert.doesNotMatch(res.stdout, /aborof-elazamey/, "لا يُطبع المضيف كاملًا");
  });

  test("رمز مشترك وحيد: يعمل مع تحذير مُعلَن (لا بصمت)", () => {
    const res = run({ TURSO_DATABASE_URL: GOOD_URL, TURSO_AUTH_TOKEN: PROD_TOKEN });
    assert.equal(res.status, 0);
    assert.match(res.stderr, /TURSO_AUTH_TOKEN_PROD غير مضبوط/);
    assert.match(res.stderr, /TURSO_AUTH_TOKEN_CI غير مضبوط/);
    assert.match(res.stdout, /مشترك انتقالي/);
  });
});

describe("scripts/apply-turso-secrets — الموجه-أولًا ونظافة السجل (P0)", () => {
  const GOOD_URL = "libsql://aborof-elazamey.turso.io";
  const PROD_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcm9kIn0.c2lnbmF0dXJlLXByb2Q";
  const CI_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjaSJ9.c2lnbmF0dXJlLWNp";
  const run = (env: Record<string, string>, args: string[] = ["--dry-run"]) =>
    spawnSync("bash", ["scripts/apply-turso-secrets.sh", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      input: "",
    });

  test("المسار الأول تشغيل عارٍ بمدخل مخفي — والقيم inline موسومة كأتمتة/اختبار", () => {
    const help = spawnSync("bash", ["scripts/apply-turso-secrets.sh", "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /bash scripts\/apply-turso-secrets\.sh\n/, "التشغيل العاري أولًا");
    assert.match(help.stdout, /سجل الصدفة/, "تحذير الـ history في الاستخدام نفسه");
  });

  test("رابط وحده بلا رموز: يُسأل عن الرمز (لا سقوط صامت) ويفشل بنظافة بلا مدخل", () => {
    const res = run({ TURSO_DATABASE_URL: GOOD_URL });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /أدخل TURSO_AUTH_TOKEN/);
    assert.match(res.stderr, /لا رمز/);
  });

  test("--vercel-only برمز PROD وحده: ينجح بلا سؤال عن CI", () => {
    const res = run({ TURSO_DATABASE_URL: GOOD_URL, TURSO_AUTH_TOKEN_PROD: PROD_TOKEN }, [
      "--vercel-only",
      "--dry-run",
    ]);
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.stderr, /أدخل TURSO_AUTH_TOKEN_CI/);
    assert.doesNotMatch(res.stdout, /TURSO_AUTH_TOKEN_CI/);
  });

  test("--github-only برمز CI وحده: ينجح بلا سؤال عن PROD", () => {
    const res = run({ TURSO_DATABASE_URL: GOOD_URL, TURSO_AUTH_TOKEN_CI: CI_TOKEN }, [
      "--github-only",
      "--dry-run",
    ]);
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.stderr, /أدخل TURSO_AUTH_TOKEN_PROD/);
    assert.doesNotMatch(res.stdout, /TURSO_AUTH_TOKEN_PROD/);
  });

  test("لا تلوث متبادل: رمز CI وحده لا يُستخدَم للتشغيل — يُسأل عن PROD صراحةً", () => {
    const res = run({ TURSO_DATABASE_URL: GOOD_URL, TURSO_AUTH_TOKEN_CI: CI_TOKEN });
    assert.equal(res.status, 1, "بلا مدخل يفشل — المهم أنه سأل ولم يُعِد الاستخدام بصمت");
    assert.match(res.stderr, /أدخل TURSO_AUTH_TOKEN_PROD/);
  });

  test("القيم من البيئة تُعلَن مع تذكير نظافة السجل", () => {
    const res = run({ TURSO_DATABASE_URL: GOOD_URL, TURSO_AUTH_TOKEN: PROD_TOKEN });
    assert.equal(res.status, 0);
    assert.match(res.stderr, /قيم من البيئة.*سجل الصدفة/);
  });
});

describe("scripts/lib/schema-contract — عقد السكيما (P1a)", () => {
  test("قاعدة مهاجَرة: بلا انتهاكات", async () => {
    const { client } = fileClient("aborof-schema-ok");
    await runMigrations(client);
    try {
      assert.deepEqual(await checkSchemaContract(client), []);
    } finally {
      client.close();
    }
  });

  test("عمود مسقَط يُرصَد باسمه (featured مثالًا)", async () => {
    const { client } = fileClient("aborof-schema-bad");
    await runMigrations(client);
    await client.execute("ALTER TABLE products DROP COLUMN featured");
    try {
      const violations = await checkSchemaContract(client);
      assert.equal(violations.length, 1);
      assert.match(violations[0], /products: أعمدة ناقصة \(featured\)/);
    } finally {
      client.close();
    }
  });

  test("صف schema-contract في التقرير: أخضر بلا كود، والأحمر يحجب بـ SCHEMA_CONTRACT_VIOLATION", async () => {
    const good = fileClient("aborof-schema-row-ok");
    await runMigrations(good.client);
    good.client.close();
    const okReport = JSON.parse(runVerifyTurso(good.url)) as {
      verdict: string;
      rows: { id: string; ok: boolean; code: string | null }[];
    };
    assert.equal(okReport.rows.find((r) => r.id === "schema-contract")?.ok, true);
    assert.equal(okReport.rows.find((r) => r.id === "schema-contract")?.code, null);

    const bad = fileClient("aborof-schema-row-bad");
    await runMigrations(bad.client);
    await bad.client.execute("ALTER TABLE orders DROP COLUMN note");
    bad.client.close();
    let stdout = "";
    let status = 0;
    try {
      stdout = runVerifyTurso(bad.url);
    } catch (error) {
      const e = error as { status?: number; stdout?: string };
      status = e.status ?? 0;
      stdout = e.stdout ?? "";
    }
    assert.equal(status, 1);
    const badReport = JSON.parse(stdout) as {
      verdict: string;
      rows: { id: string; ok: boolean; code: string | null }[];
    };
    assert.equal(badReport.verdict, "BLOCKED");
    assert.equal(badReport.rows.find((r) => r.id === "schema-contract")?.code, "SCHEMA_CONTRACT_VIOLATION");
  });
});

describe("src/lib/db — مصدر الكتالوج وعدّاد السقوط (P1b)", () => {
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    savedEnv = {};
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("TURSO_")) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
    }
    setDbClientForTest(null);
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setDbClientForTest(null);
  });

  const fallbackCount = () =>
    (metricsSnapshot().counters["db.fallback_activations_total"] as number | undefined) ?? 0;

  test("رفض 401 ⇒ المصدر seed والعدّاد يزيد واحدًا", async () => {
    const { start401Stub } = await import("./stub-helpers");
    const stub = await start401Stub();
    const client = createClient({ url: stub.url, authToken: "x" });
    setDbClientForTest(client);
    const before = fallbackCount();
    try {
      const { products, source } = await getProductsWithSource();
      assert.equal(source, "seed");
      assert.deepEqual(products, SEED_PRODUCTS);
      assert.equal(fallbackCount(), before + 1, "سقوط بعد محاولة فاشلة = تفعيلة واحدة");
    } finally {
      setDbClientForTest(null);
      client.close();
      await stub.close();
    }
  });

  test("getFaq الساقط يزيد العدّاد أيضًا (نفس الحدث: بديل بدل قاعدة)", async () => {
    const { start401Stub } = await import("./stub-helpers");
    const { getFaq } = await import("../src/lib/db");
    const stub = await start401Stub();
    const client = createClient({ url: stub.url, authToken: "x" });
    setDbClientForTest(client);
    const before = fallbackCount();
    try {
      const faq = await getFaq();
      assert.ok(Array.isArray(faq) && faq.length > 0);
      assert.equal(fallbackCount(), before + 1);
    } finally {
      setDbClientForTest(null);
      client.close();
      await stub.close();
    }
  });

  test("غياب الإعداد أصلًا ⇒ بذرة بلا عدّ (ليست تدهورًا حيًّا)", async () => {
    const before = fallbackCount();
    const { products, source } = await getProductsWithSource();
    assert.equal(source, "seed");
    assert.deepEqual(products, SEED_PRODUCTS);
    assert.equal(fallbackCount(), before, "بلا URL لا محاولة — فلا تفعيلة");
  });

  test("مسار القاعدة السليم ⇒ المصدر turso", async () => {
    const { client } = fileClient("aborof-source-turso");
    await runMigrations(client);
    setDbClientForTest(client);
    try {
      const { source } = await getProductsWithSource();
      assert.equal(source, "turso");
    } finally {
      setDbClientForTest(null);
      client.close();
    }
  });
});

describe("scripts/smoke-production — الحكم الثلاثي ومصدر الكتالوج (P1b/#5)", () => {
  test("smokeVerdict: صلب أحمر ⇒ FAIL، وناعم وحده ⇒ DEGRADED، وإلا PASS", () => {
    assert.equal(smokeVerdict([{ id: "1", ok: true }]), "PASS");
    assert.equal(
      smokeVerdict([
        { id: "1", ok: true },
        { id: "fallback", ok: false },
      ]),
      "DEGRADED"
    );
    assert.equal(
      smokeVerdict([
        { id: "1", ok: true },
        { id: "latency", ok: false },
      ]),
      "DEGRADED"
    );
    assert.equal(
      smokeVerdict([
        { id: "1", ok: false },
        { id: "fallback", ok: false },
      ]),
      "FAIL"
    );
  });

  test("dbSourceFromResponse: الترويسة أولًا ثم القرينة ثم مجهول", () => {
    assert.deepEqual(dbSourceFromResponse({ "x-db-source": "seed" }, [], true), { source: "seed", via: "header" });
    assert.deepEqual(dbSourceFromResponse({ "x-db-source": "turso" }, [], true), { source: "turso", via: "header" });
    assert.deepEqual(dbSourceFromResponse({}, [{ id: "x" }], true), { source: "seed", via: "heuristic" });
    assert.deepEqual(dbSourceFromResponse({}, [{ id: "x", old_price: 1 }], true), {
      source: "turso",
      via: "heuristic",
    });
    assert.deepEqual(dbSourceFromResponse({}, [], false), { source: "unknown", via: "none" });
  });

  test("ميزانية المصباح الدخاني ثابت مسمّى (15s — تعلّق مرضي لا SLO)", () => {
    assert.equal(LATENCY_BUDGET_MS, 15_000);
  });

  test("مسار /api/products يعلن المصدر في ترويسة بلا كسر للجسم", () => {
    const src = fs.readFileSync("src/app/api/products/route.ts", "utf8");
    assert.match(src, /getProductsWithSource/);
    assert.match(src, /X-DB-Source/);
    assert.match(src, /\{ products \}/, "الجسم كما هو: {products}");
  });
});

describe("scripts/lib/db-url — الضوابط السالبة والفوضى (P1c/P3)", () => {
  // داخل-العملية (async) عمدًا: spawnSync ضد stub في نفس العملية جمود مؤكد
  // (الوالد المحجوب لا يرد على HTTP) — اكتُشف بالتعليق مرة، وهذه صيغته الآمنة.
  // عرض الصفوف وFINAL مغطّى باختبارات الـ spawn (غير الشبكية) أعلاه.
  let stub: { url: string; set: (s: number, b: string, c?: string) => void; close: () => Promise<void> } | null =
    null;

  before(async () => {
    const { startCannedStub } = await import("./stub-helpers");
    stub = await startCannedStub();
  });
  after(async () => {
    await stub?.close();
    stub = null;
  });

  test("401 بجسم انتهاء ⇒ TURSO_AUTH_401 (الانتهاء ≡ الرفض عند API)", async () => {
    stub!.set(401, JSON.stringify({ error: "JWT expired" }));
    const r = await probeHttpEndpoint(stub!.url, "tok", []);
    assert.equal(r.ok, false);
    assert.equal(r.code, "TURSO_AUTH_401");
  });

  test("401 بجسم empty-JWT ⇒ TURSO_AUTH_401_EMPTY_JWT", async () => {
    stub!.set(401, JSON.stringify({ error: "empty JWT token" }));
    const r = await probeHttpEndpoint(stub!.url, "tok", []);
    assert.equal(r.code, "TURSO_AUTH_401_EMPTY_JWT");
  });

  test("404 ⇒ TURSO_DB_NOT_FOUND", async () => {
    stub!.set(404, JSON.stringify({ error: "not found" }));
    const r = await probeHttpEndpoint(stub!.url, "tok", []);
    assert.equal(r.code, "TURSO_DB_NOT_FOUND");
  });

  test("400 ⇒ TURSO_REQUEST_REJECTED", async () => {
    stub!.set(400, JSON.stringify({ error: "bad request" }));
    const r = await probeHttpEndpoint(stub!.url, "tok", []);
    assert.equal(r.code, "TURSO_REQUEST_REJECTED");
  });

  test("فوضى: 500 بقمامة ⇒ TURSO_UNEXPECTED_STATUS (ولا يُرمَى أبدًا)", async () => {
    stub!.set(500, "<html>garbage-500-marker {{{", "text/html");
    const r = await probeHttpEndpoint(stub!.url, "tok", []);
    assert.equal(r.ok, false);
    assert.equal(r.code, "TURSO_UNEXPECTED_STATUS");
  });

  test("فوضى: 200 بقمامة ⇒ ok (المسبار الخام يثق بالحالة؛ تباين العميل شأن المستدعي)", async () => {
    stub!.set(200, "not-json{{{", "text/plain");
    const r = await probeHttpEndpoint(stub!.url, "tok", []);
    assert.equal(r.ok, true);
    assert.equal(r.code, null);
  });

  test("فوضى: منفذ مغلق ⇒ TURSO_UNREACHABLE (بلا انتظار معلّق)", async () => {
    const r = await probeHttpEndpoint("http://127.0.0.1:9", "x", []);
    assert.equal(r.ok, false);
    assert.equal(r.code, "TURSO_UNREACHABLE");
  });

  test("رابط غير قابل للفحص ⇒ TURSO_UNREACHABLE لا رمي", async () => {
    const r = await probeHttpEndpoint("file:/tmp/x.db", null, []);
    assert.equal(r.code, "TURSO_UNREACHABLE");
  });

  test("الرمز يُنقَّى من الحكم (لا يظهر في verdict أبدًا)", async () => {
    stub!.set(401, "leak-marker-xyz");
    const r = await probeHttpEndpoint(stub!.url, "SECRET-TOKEN-abc", ["SECRET-TOKEN-abc"]);
    assert.doesNotMatch(r.verdict, /SECRET-TOKEN-abc/);
  });
});

describe("scripts/verify-turso — غياب الرمز (سالبة)", () => {
  test("رمز فارغ (غياب كامل) ⇒ TURSO_TOKEN_MISSING وخروج 2", () => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("TURSO_")) delete env[k];
    env.TURSO_DATABASE_URL = "http://127.0.0.1:9";
    const res = spawnSync("node", ["scripts/verify-turso.mjs"], { encoding: "utf8", env });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /\[TURSO_TOKEN_MISSING\]/);
  });
});

describe("scripts/rotation-drill.mjs — تدريب التدوير (P1d)", () => {
  test("--self-test يثبت الالتقاط الأمين (BLOCKED على الفارغة بلا أسرار)", () => {
    const res = spawnSync("node", ["scripts/rotation-drill.mjs", "--self-test"], { encoding: "utf8" });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /BLOCKED/);
  });

  test("--self-test --json سجل آلي قابل للتحليل", () => {
    const res = spawnSync("node", ["scripts/rotation-drill.mjs", "--self-test", "--json"], { encoding: "utf8" });
    assert.equal(res.status, 0);
    const record = JSON.parse(res.stdout) as { tool: string; probe_verdict: string };
    assert.equal(record.tool, "rotation-drill");
    assert.equal(record.probe_verdict, "BLOCKED");
  });

  test("--phase بلا رابط ⇒ خروج 2 (التدريب على اعتماد حقيقي أو لا شيء)", () => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("TURSO_")) delete env[k];
    const res = spawnSync("node", ["scripts/rotation-drill.mjs", "--phase", "pre"], { encoding: "utf8", env });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /TURSO_DATABASE_URL غير مُعيَّن/);
  });
});

describe("حدود الصلاحيات الدنيا في الـ workflows (P2b/#6)", () => {
  const files = [
    ".github/workflows/deploy.yml",
    ".github/workflows/quality.yml",
    ".github/workflows/service-health.yml",
    ".github/workflows/probe-production.yml",
    ".github/workflows/turso-evidence.yml",
  ];
  const src: Record<string, string> = Object.fromEntries(files.map((f) => [f, fs.readFileSync(f, "utf8")]));

  test("كل workflow يعلن صلاحياته صراحةً (لا افتراضيات ضمنية)", () => {
    for (const f of files) {
      assert.match(src[f], /^permissions:/m, `${f}: كتلة permissions العليا مفقودة`);
    }
  });

  test("لا صلاحيات كتابة واسعة في أي workflow (القائمة الممنوعة)", () => {
    // المسموح كتابةً في المنظومة كلها: pull-requests (تعليق المجسّ) + issues (قضية التتبّع).
    const banned = [
      /write-all/,
      /contents:\s*write/,
      /actions:\s*write/,
      /packages:\s*write/,
      /deployments:\s*write/,
      /security-events:\s*write/,
      /id-token:\s*write/,
    ];
    for (const f of files) {
      for (const pattern of banned) {
        assert.doesNotMatch(src[f], pattern, `${f}: صلاحية واسعة ${pattern}`);
      }
    }
  });

  test("النشر والصحة والإنتاج-probe بلا أي كتابة (قراءة/صفر فقط)", () => {
    assert.match(src[".github/workflows/deploy.yml"], /^permissions:\n  contents: read\n/m);
    assert.equal((src[".github/workflows/deploy.yml"].match(/^\s*permissions:/gm) ?? []).length, 1);
    assert.match(src[".github/workflows/service-health.yml"], /^permissions: \{\}/m);
    assert.match(src[".github/workflows/probe-production.yml"], /^permissions: \{\}/m);
  });

  test("مهمة Secret Scan قراءة فقط", () => {
    const scan = src[".github/workflows/quality.yml"].slice(
      src[".github/workflows/quality.yml"].indexOf("secret-scan:")
    );
    assert.match(scan, /contents: read/);
    assert.doesNotMatch(scan, /:\s*write/);
  });
});

describe("حدّ المزوّد وNEXT_PUBLIC (P2c + سالبة)", () => {
  function walkTs(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkTs(full, out);
      else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
    return out;
  }

  test("@libsql/client القيمية داخل src/lib/db فقط (الأنواع type-only مسموحة)", () => {
    // الحدّ الرسمي: التطبيق ← src/lib/db/* ← Turso. أي استيراد قيمي خارج
    // الحدّ يُفشل البوابة — هذا ما يجعل استبدال المزوّد (سنة-1) ممكنًا.
    // (scripts/ أدوات مباشرة بالتصميم — خارج نطاق هذا القفل.)
    const files = walkTs(path.join(process.cwd(), "src"));
    assert.ok(files.length > 10, "الماسح يجب أن يجد ملفات src وإلا مرّر بصمت");
    for (const file of files) {
      const rel = path.relative(process.cwd(), file);
      if (rel.startsWith(`src${path.sep}lib${path.sep}db${path.sep}`)) continue;
      for (const [i, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
        if (!line.includes("@libsql/client")) continue;
        assert.match(line, /import\s+type\b/, `${rel}:${i + 1}: استيراد قيمي خارج حدّ قاعدة البيانات`);
      }
    }
  });

  test("لا أسرار خادم في متغيرات NEXT_PUBLIC_* (تُضمَّن في حزمة العميل)", () => {
    const files = walkTs(path.join(process.cwd(), "src"));
    for (const file of files) {
      const rel = path.relative(process.cwd(), file);
      for (const [i, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
        assert.doesNotMatch(
          line,
          /NEXT_PUBLIC_(TURSO|ADMIN|GEMINI|GROQ|NVIDIA|DIAGNOSTICS|VERCEL_TOKEN)/,
          `${rel}:${i + 1}: سر خادم في NEXT_PUBLIC`
        );
      }
    }
  });
});
