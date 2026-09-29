import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
  BASELINE_SECURITY_HEADERS,
} from "../scripts/smoke-production.mjs";
import { scanTextForSecrets, SERVER_SECRET_NAMES } from "../scripts/scan-bundle-secrets.mjs";
import {
  DEFAULT_THRESHOLD_DAYS,
  LIFECYCLE_STATUSES,
  classifyLifecycle,
  decodeTokenExpiry,
  renderEvidence,
} from "../scripts/audit-token-lifecycle.mjs";
import {
  AUTHORIZATION_LEVELS,
  DEFAULT_EXPIRATION,
  connectionUrlFor,
  describeMintedToken,
  describeTokenShape,
  isLocalDatabaseUrl,
  isValidAuthorization,
  isValidExpiration,
  maskTarget,
  orgAndDbFromConnectionUrl,
  orgAndDbFromDashboardUrl,
  orgAndDbFromValue,
  pickField,
  resolveApiBase,
} from "../scripts/lib/turso-api.mjs";
import { setDbClientForTest } from "../src/lib/db";
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
});

describe("scripts/apply-turso-secrets — تطبيق السرّين بأمان", () => {
  const run = (env: Record<string, string>, args: string[] = ["--dry-run"]) =>
    spawnSync("bash", ["scripts/apply-turso-secrets.sh", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  const GOOD_URL = "libsql://aborof-elazamey.turso.io";
  const GOOD_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl";

  test("يقبل الزوج الصحيح ويعرض وصفًا شكليًا فقط — بلا أي قيمة سرية (مع --skip-verify)", () => {
    const res = run({ TURSO_DATABASE_URL: GOOD_URL, TURSO_AUTH_TOKEN: GOOD_TOKEN }, ["--dry-run", "--skip-verify"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /التحقق الشكلي نجح/);
    assert.match(res.stdout, /JWT \(طول/);
    assert.match(res.stdout, /فحص الاتصال الحيّ: مُتخطَّ/);
    // escape hatch مُسجَّل لا صامت: التخطي يُعلَن في stderr حتى في وضع المعاينة.
    assert.match(res.stderr, /VERIFY_SKIPPED/);
    assert.doesNotMatch(res.stdout + res.stderr, new RegExp(GOOD_TOKEN));
    assert.doesNotMatch(res.stdout, /aborof-elazamey/, "لا يُطبع المضيف كاملًا");
  });

  test("الفحص الحيّ حاجز قبل التطبيق: قيم شكلية صحيحة بقاعدة غير متاحة تُوقف قبل أي لمس", () => {
    const res = run({ TURSO_DATABASE_URL: GOOD_URL, TURSO_AUTH_TOKEN: GOOD_TOKEN }, ["--dry-run"]);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /فحص اتصال Turso حيًّا/);
    assert.match(res.stderr, /VERIFY_CONNECTION_FAILED/);
    assert.match(res.stderr, /القاعدة رفضت هذه القيم/);
    // لم تُعرض خطوات التطبيق إطلاقًا (الفشل قبل بنائتها)، ولم تتسرب أي قيمة:
    assert.doesNotMatch(res.stdout, /gh secret set/);
    assert.doesNotMatch(res.stdout, /لن يُطبَّق أي سرّ/);
    assert.doesNotMatch(res.stdout + res.stderr, new RegExp(GOOD_TOKEN));
    assert.doesNotMatch(res.stdout, /aborof-elazamey/, "لا يُطبع المضيف كاملًا");
  });

  test("العقد: فشل الفحص الحيّ في وضع التنفيذ لا يستدعي GitHub ولا Vercel إطلاقًا", () => {
    // أدوات وهمية تُسجّل كل استدعاء على `PATH`؛ وضع التنفيذ هنا بلا --dry-run،
    // فلو اختراق الحاجز لأُسجّل نداء gh/vercel في السجل وأسقط الاختبار.
    const binDir = fs.mkdtempSync(path.join(tmpdir(), "fake-bin-"));
    const logFile = path.join(binDir, "calls.log");
    for (const tool of ["gh", "vercel"]) {
      const p = path.join(binDir, tool);
      fs.writeFileSync(p, `#!/usr/bin/env bash\necho "$0 $*" >> "${logFile}"\n`);
      fs.chmodSync(p, 0o755);
    }
    try {
      const res = spawnSync("bash", ["scripts/apply-turso-secrets.sh"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          TURSO_DATABASE_URL: GOOD_URL,
          TURSO_AUTH_TOKEN: GOOD_TOKEN,
        },
      });
      assert.equal(res.status, 1, "فشل الفحص الحيّ = خروج 1 قبل أي كتابة");
      assert.match(res.stderr, /VERIFY_CONNECTION_FAILED/);
      const calls = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      assert.equal(calls.trim(), "", `لا يجوز لأي أداة كتابة أن تُستدعى بعد فشل الفحص: ${calls}`);
      assert.doesNotMatch(res.stdout + res.stderr, new RegExp(GOOD_TOKEN));
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
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
});

/* ========================================================================== */
/* سكّ رمز Turso + بوابة الهجرات الصريحة + تطبيق الأسرار                      */
/* ========================================================================== */

/**
 * يبني JWT اصطناعيًا **وقت التشغيل**: لا قيمة سرية ثابتة في ملف متتبَّع (بوابة
 * Secret Scan في quality.yml)، وفي الوقت نفسه يسمح بادّعاء «canary» في التوقيع
 * لإثبات أن الرمز لا يتسرب إلى أي مخرج.
 */
function syntheticJwt(payload: Record<string, unknown>, signature = "synthetic-signature"): string {
  const encode = (value: unknown) =>
    Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode(payload)}.${signature}`;
}

type MockTursoApi = {
  url: string;
  /** كل نداء وصل إلى الخادم، بالترتيب — دليل «معاينة بلا POST» و«معاملة بواحدة». */
  readLog: () => string[];
  resetLog: () => void;
  close: () => void;
};

/**
 * يشغّل خادم Platform API الوهمي في **عملية مستقلة** (`tests/fixtures/mock-turso-api.mjs`):
 * `spawnSync` في الاختبار يحبس حلقة الأحداث، فلو عاش الخادم في عملية الاختبار
 * نفسها لما خدم أي طلب قبل انتهاء الطفل (مهلة كاملة لكل نداء).
 */
function startMockTursoApi(
  options: { jwt?: string; jwtNever?: string; databases?: string[]; orgs?: number } = {}
): Promise<MockTursoApi> {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "mock-turso-"));
    const portFile = path.join(dir, "port");
    const logFile = path.join(dir, "requests.log");
    const child = spawn("node", ["tests/fixtures/mock-turso-api.mjs"], {
      stdio: "ignore",
      env: {
        ...process.env,
        MOCK_PORT_FILE: portFile,
        MOCK_LOG_FILE: logFile,
        MOCK_JWT: options.jwt ?? syntheticJwt({ a: "full_access" }, "MINTED-CANARY-SIGNATURE"),
        MOCK_JWT_NEVER: options.jwtNever ?? syntheticJwt({ a: "full_access" }, "MINTED-CANARY-SIGNATURE"),
        MOCK_DATABASES: (options.databases ?? ["aborof"]).join(","),
        MOCK_ORGS_COUNT: String(options.orgs ?? 1),
      },
    });
    const startedAt = Date.now();
    const poll = setInterval(() => {
      const port = fs.existsSync(portFile) ? fs.readFileSync(portFile, "utf8").trim() : "";
      if (port && port !== "0") {
        clearInterval(poll);
        resolve({
          url: `http://127.0.0.1:${port}/v1`,
          readLog: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []),
          resetLog: () => fs.writeFileSync(logFile, ""),
          close: () => {
            child.kill("SIGKILL");
            fs.rmSync(dir, { recursive: true, force: true });
          },
        });
        return;
      }
      if (Date.now() - startedAt > 15_000) {
        clearInterval(poll);
        child.kill("SIGKILL");
        reject(new Error("لم يبدأ خادم Turso الوهمي خلال 15 ثانية"));
      }
    }, 40);
  });
}

/**
 * أدوات كتابة وهمية (gh/vercel) تُسجّل argv وطول stdin — فيُثبت الاختبار أن
 * القيم وصلت عبر **stdin** لا عبر وسائط سطر الأوامر المرئية في `ps`.
 */
function writeFakeTools(dir: string, logFile: string): void {
  for (const tool of ["gh", "vercel"]) {
    const target = path.join(dir, tool);
    fs.writeFileSync(
      target,
      `#!/usr/bin/env bash\n{\n  echo "CALL ${tool} $*"\n  input="$(cat)"\n  echo "STDIN_LEN=\${#input}"\n} >> "${logFile}"\nexit 0\n`
    );
    fs.chmodSync(target, 0o755);
  }
}

function callsLog(logFile: string): string {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
}

describe("scripts/lib/turso-api — اشتقاق الهدف وأوصاف بلا أسرار", () => {
  test("رابط الاتصال القانوني يُبنى كنمط Turso الموثّق <db>-<org>.turso.io", () => {
    assert.equal(connectionUrlFor("elazamey", "aborof"), "libsql://aborof-elazamey.turso.io");
    assert.equal(connectionUrlFor("ELAZAMEY", "Aborof"), "libsql://aborof-elazamey.turso.io");
  });

  test("رابط لوحة التحكم يعطي المنظمة والقاعدة بلا التباس", () => {
    assert.deepEqual(orgAndDbFromDashboardUrl("https://app.turso.tech/elazamey/databases/aborof"), {
      org: "elazamey",
      db: "aborof",
      source: "dashboard-url",
      tentative: false,
    });
  });

  test("رابط الاتصال يُقطَع عند آخر شَرّة ويُعلَّم مرجَّحًا (يُحسم من ردّ الخادم)", () => {
    const derived = orgAndDbFromConnectionUrl("libsql://my-store-elazamey.turso.io");
    assert.equal(derived?.db, "my-store");
    assert.equal(derived?.org, "elazamey");
    assert.equal(derived?.tentative, true);
  });

  test("نطاق تطبيق أو قيمة موضعية لا يُشتق منهما هدف (لا تخمين)", () => {
    assert.equal(orgAndDbFromValue("https://aborof.vercel.app"), null);
    assert.equal(orgAndDbFromValue("libsql://<db>.turso.io"), null);
    assert.equal(orgAndDbFromValue(""), null);
  });

  test("التقنيع: لا اسم كامل ولا مضيف كامل ولا رابط كامل في الوصف", () => {
    const masked = maskTarget({
      org: "elazamey",
      db: "aborof",
      hostname: "aborof-elazamey.turso.io",
      url: "libsql://aborof-elazamey.turso.io",
    });
    assert.equal(masked.org, "ela…");
    assert.equal(masked.db, "abo…");
    assert.equal(masked.host, "abo….turso.io");
    assert.ok(!masked.url.includes("aborof-elazamey"), "الرابط المقنّع لا يحوي المضيف كاملًا");
    assert.equal(masked.urlShape?.kind, "Turso");
  });

  test("قاعدة محلية تُقنَّع بطولها فقط — لا مسار كامل في السجل", () => {
    const masked = maskTarget({ url: "file:/tmp/some-local-database.db" });
    assert.equal(masked.local, true);
    assert.ok(!masked.url.includes("some-local"));
    assert.equal(isLocalDatabaseUrl("file:/tmp/x.db"), true);
    assert.equal(isLocalDatabaseUrl(":memory:"), true);
    assert.equal(isLocalDatabaseUrl("libsql://a-b.turso.io"), false);
  });

  test("العمر الافتراضي سياسة مستودع (90d) لا افتراضي API (never)", () => {
    assert.equal(DEFAULT_EXPIRATION, "90d");
    assert.equal(isValidExpiration(DEFAULT_EXPIRATION), true);
    assert.equal(isValidExpiration("never"), true, "الهروب الصريح يبقى مقبولًا");
  });

  test("مدة الانتهاء ومستوى الصلاحية يُتحقق منهما قبل أي نداء", () => {
    assert.equal(isValidExpiration("never"), true);
    assert.equal(isValidExpiration("2w1d30m"), true);
    assert.equal(isValidExpiration("90d"), true);
    assert.equal(isValidExpiration("forever"), false);
    assert.equal(isValidExpiration("../../etc"), false);
    assert.deepEqual(AUTHORIZATION_LEVELS, ["full-access", "read-only"]);
    assert.equal(isValidAuthorization("full-access"), true);
    assert.equal(isValidAuthorization("admin"), false);
  });

  test("قاعدة API: https إلزامي، وhttp المحلي اختباري صريح لا يتسع لأي مضيف", () => {
    assert.equal(resolveApiBase("https://api.turso.tech/v1/").base, "https://api.turso.tech/v1");
    assert.equal(resolveApiBase("http://127.0.0.1:9/v1").ok, false);
    assert.equal(resolveApiBase("http://127.0.0.1:9/v1", { allowInsecure: true }).ok, true);
    assert.equal(resolveApiBase("http://evil.example/v1", { allowInsecure: true }).ok, false);
  });

  test("pickField يقرأ مفاتيح Turso بأحرفها الكبيرة كما يعيدها ردّ القائمة", () => {
    assert.equal(pickField({ Name: "aborof", Hostname: "h" }, "name"), "aborof");
    assert.equal(pickField({ name: "aborof" }, "Name"), "aborof");
    assert.equal(pickField({ Name: "", name: "fallback" }, "name"), "fallback");
    assert.equal(pickField(null, "name"), undefined);
  });

  test("وصف الرمز المسكوك: الانتهاء ومستوى الصلاحية بلا أي جزء من التوقيع", () => {
    const signature = "CANARY-SIGNATURE-SEGMENT";
    const jwt = syntheticJwt({ a: "full_access", exp: Math.floor(Date.now() / 1000) + 90 * 86400 }, signature);
    const description = describeMintedToken(jwt);
    assert.match(description, /وصول كامل/);
    assert.match(description, /ينتهي/);
    assert.ok(!description.includes(signature), "لا يُطبع أي جزء من التوقيع");
    assert.ok(!description.includes(jwt));
  });

  test("رمز بلا انتهاء يُعلن كذلك، ومطالبة وصول غير معروفة لا تُطبع خامًا", () => {
    const readOnly = describeMintedToken(syntheticJwt({ a: "ro" }));
    assert.match(readOnly, /قراءة فقط/);
    assert.match(readOnly, /بلا انتهاء/);
    const weird = describeMintedToken(syntheticJwt({ a: "libsql://attacker.example/x" }));
    assert.match(weird, /غير معروف/);
    assert.ok(!weird.includes("attacker"), "لا يُطبع محتوى مطالبة غير معروفة");
  });

  test("رابط اتصال لُصق في حقل الرمز يُرصد (نفس عطل الإنتاج المرصود)", () => {
    assert.equal(describeTokenShape("libsql://aborof-elazamey.turso.io").kind, "رابط لا رمز");
    assert.equal(describeTokenShape(syntheticJwt({ sub: "platform" })).kind, "JWT");
    assert.equal(describeTokenShape("").kind, "فارغ");
  });
});

describe("scripts/apply-migrations — بوابة الهجرات الصريحة", () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("node", ["--import", "tsx", "scripts/apply-migrations.mjs", ...args], {
      encoding: "utf8",
      env: { ...process.env, TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "", ...env },
    });
  const freshDb = () =>
    path.join(tmpdir(), `aborof-migrations-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

  test("وضع الخطة لا يكتب شيئًا إطلاقًا ويخرج 0 (⏳ معلَّق لا ❌ فشل)", async () => {
    const file = freshDb();
    const res = run(["--url", `file:${file}`]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /وضع الخطة/);
    for (const migration of expectedMigrations(process.cwd())) {
      assert.match(res.stdout, new RegExp(`${migration.version}_${migration.name}`));
    }
    const client = createClient({ url: `file:${file}` });
    const tables = await client.execute("SELECT name FROM sqlite_master");
    assert.deepEqual(tables.rows, [], "الخطة قراءة فقط حرفيًا: لا جدول ولا صف");
    client.close();
  });

  test("--apply يطبّق هجرات المستودع عبر المسار الإنتاجي ويسجّل بصمات مطابقة", async () => {
    const file = freshDb();
    const res = run(["--url", `file:${file}`, "--apply"]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /طُبِّقت الآن: 0001، 0002/);
    const expected = expectedMigrations(process.cwd());
    const client = createClient({ url: `file:${file}` });
    const rows = await client.execute("SELECT version, checksum FROM schema_migrations ORDER BY version");
    const applied = rows.rows.map((row) => ({ version: String(row.version), checksum: String(row.checksum) }));
    assert.deepEqual(applied.map((row) => row.version), expected.map((migration) => migration.version));
    for (const migration of expected) {
      assert.equal(applied.find((row) => row.version === migration.version)?.checksum, migration.checksum);
    }
    // الجدولان اللذان تفحصهما CI (الصفان 7 و8) صارا موجودين.
    const essentials = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('order_items','product_search') ORDER BY name"
    );
    assert.deepEqual(essentials.rows.map((row) => String(row.name)), ["order_items", "product_search"]);
    client.close();
  });

  test("التطبيق الثاني idempotent: لا هجرة تُنفَّذ مرتين", () => {
    const file = freshDb();
    assert.equal(run(["--url", `file:${file}`, "--apply"]).status, 0);
    const second = run(["--url", `file:${file}`, "--apply", "--expect", "0001,0002"]);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /لا شيء للتطبيق/);
  });

  test("--expect بإصدار غير موجود في المستودع ⇒ خروج 2 (لا كتابة على التخمين)", () => {
    const res = run(["--url", `file:${freshDb()}`, "--apply", "--expect", "0099"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /غير موجود في المستودع/);
  });

  test("رابط لوحة تحكم ⇒ رفض 3: بوابة الكتابة لا تلمس نطاقًا غير Turso", () => {
    const res = run(["--url", "https://app.turso.tech/elazamey/databases/aborof", "--apply"]);
    assert.equal(res.status, 3);
    assert.match(res.stderr, /MIGRATIONS_TARGET_REFUSED/);
    assert.match(res.stderr, /رابط لوحة تحكم/);
    assert.doesNotMatch(res.stderr, /app\.turso\.tech/, "لا يُطبع المضيف كاملًا");
  });

  test("قيمة موضعية لم تُستبدل ⇒ رفض 3", () => {
    const res = run(["--url", "libsql://<db>.turso.io", "--apply"]);
    assert.equal(res.status, 3);
    assert.match(res.stderr, /MIGRATIONS_TARGET_PLACEHOLDER/);
  });

  test("بلا هدف ⇒ 2، وهدف بعيد بلا رمز ⇒ 2 (لا كتابة بلا مصادقة)", () => {
    assert.equal(run(["--apply"]).status, 2);
    const noToken = run(["--url", "libsql://aborof-elazamey.turso.io", "--apply"], { TURSO_AUTH_TOKEN: "" });
    assert.equal(noToken.status, 2);
    assert.match(noToken.stderr, /MIGRATIONS_TOKEN_MISSING/);
  });

  test("انحراف بصمة بعد التطبيق ⇒ خروج 1 (يُرصد تعديل هجرة مطبَّقة)", async () => {
    const file = freshDb();
    assert.equal(run(["--url", `file:${file}`, "--apply"]).status, 0);
    const client = createClient({ url: `file:${file}` });
    await client.execute("UPDATE schema_migrations SET checksum='tampered' WHERE version='0001'");
    client.close();
    const res = run(["--url", `file:${file}`, "--apply"]);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /بصمة مختلفة عن المستودع/);
  });

  test("الرمز لا يُطبع في أي مخرج (يُقرأ من البيئة وحدها)", () => {
    const token = syntheticJwt({ a: "full_access" }, "CANARY-SIGNATURE");
    const res = run(["--url", `file:${freshDb()}`, "--apply"], { TURSO_AUTH_TOKEN: token });
    assert.doesNotMatch(res.stdout + res.stderr, /CANARY-SIGNATURE/);
    assert.doesNotMatch(res.stdout + res.stderr, new RegExp(token));
  });

  test("--json تقرير آلي بحالات صفوف صريحة وبلا مسار الهدف", () => {
    const file = freshDb();
    const res = run(["--url", `file:${file}`, "--json"]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.mode, "plan");
    assert.equal(report.ok, true);
    const ids = report.rows.map((row: { id: string }) => row.id);
    for (const id of ["target", "plan", "conn", "before", "apply", "parity", "expect"]) {
      assert.ok(ids.includes(id), `صف ناقص في التقرير: ${id}`);
    }
    assert.ok(report.rows.some((row: { state: string }) => row.state === "pending"), "الخطة تُعلن التعليق لا الفشل");
    assert.ok(!res.stdout.includes(file), "لا مسار الهدف في التقرير الآلي");
  });
});

describe("scripts/mint-turso-token — المعاملة الكاملة (سكّ ← هجرات ← أسرار)", () => {
  // ‏exp ضمن المطالبات لأن موعد التدوير يُؤخذ من الرمز نفسه (الخادم هو المصدر).
  const mintedJwt = syntheticJwt(
    { a: "full_access", exp: Math.floor(Date.now() / 1000) + 90 * 86_400 },
    "MINTED-CANARY-SIGNATURE"
  );
  const platformJwt = syntheticJwt({ sub: "platform" }, "PLATFORM-CANARY-SIGNATURE");
  // الرمز الذي يعيده الخادم عند expiration=never: بلا مطالبة exp.
  const mintedJwtNever = syntheticJwt({ a: "full_access" }, "MINTED-CANARY-SIGNATURE");
  let api: MockTursoApi;

  before(async () => {
    api = await startMockTursoApi({ jwt: mintedJwt, jwtNever: mintedJwtNever });
  });
  after(() => {
    api.close();
  });

  const workDir = () => fs.mkdtempSync(path.join(tmpdir(), "mint-run-"));
  // ‏ProcessEnv لا Record<string,string>: Next.js يجعل NODE_ENV حقلًا مطلوبًا فيه،
  // والتوقيع الأدق يمنع خطأ تجميع في CI (npm run typecheck).
  const envFor = (dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    TURSO_PLATFORM_TOKEN: platformJwt,
    TURSO_DATABASE_URL: "",
    TURSO_AUTH_TOKEN: "",
    TURSO_API_ALLOW_INSECURE_BASE: "true",
    // فشل سريع بدل مهلة 20 ثانية لكل نداء إن تعذّر الوصول إلى الخادم الوهمي.
    TURSO_API_TIMEOUT_MS: "5000",
    ...extra,
  });
  const runMint = (args: string[], env: NodeJS.ProcessEnv, input?: string) =>
    spawnSync("bash", ["scripts/mint-turso-token.sh", ...args], { encoding: "utf8", env, input });

  test("--help يطبع العقد (الاستخدام + المبادئ) من ترويسة الملف", () => {
    const res = spawnSync("bash", ["scripts/mint-turso-token.sh", "--help"], { encoding: "utf8" });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /TURSO_PLATFORM_TOKEN/);
    assert.match(res.stdout, /--dry-run/);
    assert.match(res.stdout, /لا تُطبع أي قيمة سرية/);
  });

  test("--dry-run قراءة فقط: GET وحدها، بلا POST ولا هجرة ولا لمس لـ gh/vercel", () => {
    const dir = workDir();
    const logFile = path.join(dir, "calls.log");
    writeFakeTools(dir, logFile);
    const dbFile = path.join(dir, "target.db");
    api.resetLog();
    const res = runMint(
      ["--dry-run", "--api-base", api.url, "--org", "elazamey", "--db", "aborof", "--migrations-url", `file:${dbFile}`],
      envFor(dir)
    );
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(api.readLog().filter((entry) => entry.startsWith("POST")), [], "لا نداء كاتب في المعاينة");
    assert.ok(api.readLog().some((entry) => entry.startsWith("GET")), "المعاينة تقرأ من الخادم لتطابق ما سيراه التنفيذ");
    assert.equal(callsLog(logFile).trim(), "", "لا gh ولا vercel في المعاينة");
    assert.ok(!fs.existsSync(dbFile), "المعاينة لا تنشئ قاعدة ولا تكتب فيها");
    assert.match(res.stdout, /بوابة الهجرات الصريحة/);
    assert.match(res.stdout, /0001_initial/);
    assert.match(res.stdout, /0002_search_fts5/);
    assert.match(res.stdout, /لم يُسكّ رمز/);
    assert.doesNotMatch(res.stdout + res.stderr, /aborof-elazamey/, "لا يُطبع المضيف كاملًا");
    assert.doesNotMatch(res.stdout + res.stderr, /MINTED-CANARY|PLATFORM-CANARY/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("المعاملة الحقيقية: POST واحدة للسكّ، ثم 0001+0002 على الهدف، ثم الأسرار عبر stdin", async () => {
    const dir = workDir();
    const logFile = path.join(dir, "calls.log");
    writeFakeTools(dir, logFile);
    const dbFile = path.join(dir, "target.db");
    api.resetLog();
    const res = runMint(
      ["--api-base", api.url, "--org", "elazamey", "--db", "aborof", "--migrations-url", `file:${dbFile}`, "--skip-verify"],
      envFor(dir)
    );
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const posts = api.readLog().filter((entry) => entry.startsWith("POST"));
    assert.equal(posts.length, 1, "سكّ واحد فقط لكل معاملة");
    assert.match(posts[0], /\/auth\/tokens\?expiration=90d&authorization=full-access$/, "العمر الافتراضي 90 يومًا لا never");
    const calls = callsLog(logFile);
    assert.match(calls, /CALL gh secret set TURSO_DATABASE_URL --env production\nSTDIN_LEN=[1-9]\d*/);
    assert.match(calls, /CALL gh secret set TURSO_AUTH_TOKEN --env production\nSTDIN_LEN=[1-9]\d*/);
    assert.match(calls, /CALL vercel env add TURSO_AUTH_TOKEN production\nSTDIN_LEN=[1-9]\d*/);
    assert.ok(!calls.includes(mintedJwt), "قيمة الرمز لا تمرّ في argv الأدوات");
    const client = createClient({ url: `file:${dbFile}` });
    const rows = await client.execute("SELECT version FROM schema_migrations ORDER BY version");
    assert.deepEqual(rows.rows.map((row) => String(row.version)), ["0001", "0002"], "بوابة الهجرات طبّقت فعلًا");
    client.close();
    assert.match(res.stdout, /MIGRATIONS_APPLIED/);
    assert.match(res.stdout, /تدوير الرمز: ينتهي \d{4}-\d{2}-\d{2}/, "موعد التدوير يُعلن في الخلاصة");
    assert.doesNotMatch(res.stdout + res.stderr, /MINTED-CANARY|PLATFORM-CANARY/, "لا سرّ في أي مخرج");
    assert.doesNotMatch(res.stdout + res.stderr, /aborof-elazamey/, "ولا مضيف كامل");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("الإعداد المعطوب الحالي يُشفى: لوحة تحكم في حقل الرابط ورابط في حقل الرمز", async () => {
    const dir = workDir();
    const logFile = path.join(dir, "calls.log");
    writeFakeTools(dir, logFile);
    const dbFile = path.join(dir, "target.db");
    api.resetLog();
    const res = runMint(["--api-base", api.url, "--migrations-url", `file:${dbFile}`, "--skip-verify"], envFor(dir, {
      TURSO_DATABASE_URL: "https://app.turso.tech/elazamey/databases/aborof",
      TURSO_AUTH_TOKEN: "libsql://aborof-elazamey.turso.io",
    }));
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout + res.stderr, /رابط لوحة تحكم لا رابط اتصال/);
    // الهدف حُلّ من API بلا --org/--db، والرابط المسلَّم للأسرار مشتق لا معطوب.
    assert.equal(api.readLog().filter((entry) => entry.startsWith("POST")).length, 1);
    const calls = callsLog(logFile);
    assert.match(calls, /CALL gh secret set TURSO_DATABASE_URL --env production\nSTDIN_LEN=[1-9]\d*/);
    assert.ok(!calls.includes("app.turso.tech"), "رابط اللوحة لا يُسلَّم كسرّ اتصال");
    const client = createClient({ url: `file:${dbFile}` });
    const count = await client.execute("SELECT COUNT(*) AS n FROM schema_migrations");
    assert.equal(Number(count.rows[0]?.n), 2);
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("--expiration never هروب صريح يصل إلى الخادم كما هو", () => {
    const dir = workDir();
    const dbFile = path.join(dir, "target.db");
    api.resetLog();
    const res = runMint(
      [
        "--api-base",
        api.url,
        "--org",
        "elazamey",
        "--db",
        "aborof",
        "--expiration",
        "never",
        "--migrations-url",
        `file:${dbFile}`,
        "--skip-verify",
        "--skip-secrets",
        "--save-env",
        path.join(dir, "env.local"),
      ],
      envFor(dir)
    );
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const posts = api.readLog().filter((entry) => entry.startsWith("POST"));
    assert.equal(posts.length, 1);
    assert.match(posts[0], /expiration=never/);
    // العقد: موعد التدوير المعروض يُؤخذ من مطالبة `exp` في الرمز نفسه، لا من
    // النص الممرَّر في الطلب — فلو اختلفا صدّقنا الرمز.
    assert.match(res.stdout + res.stderr, /بلا انتهاء/, "رمز بلا exp ⇒ يُعلن أنه أبدي");
    assert.doesNotMatch(res.stdout, /تدوير الرمز: ينتهي/, "ولا يُختلق موعد تدوير لرمز أبدي");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("مدة انتهاء غير صالحة ⇒ رفض قبل أي نداء (لا تُرسل للخادم)", () => {
    const dir = workDir();
    api.resetLog();
    const res = runMint(
      ["--api-base", api.url, "--org", "elazamey", "--db", "aborof", "--expiration", "forever and ever", "--skip-verify"],
      envFor(dir)
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /مدة انتهاء غير مقبولة/);
    assert.deepEqual(api.readLog(), [], "التحقق الشكلي يسبق أي نداء شبكة");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("لا يُسكّ رمز بلا وجهة تسليم — رفض قبل أي POST", () => {
    const dir = workDir();
    api.resetLog();
    const res = runMint(
      ["--api-base", api.url, "--org", "elazamey", "--db", "aborof", "--skip-secrets", "--skip-verify"],
      envFor(dir)
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /لا وجهة تسليم/);
    assert.deepEqual(api.readLog().filter((entry) => entry.startsWith("POST")), [], "لا سكّ قبل حسم الوجهة");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("--save-env على ملف متتبَّع في Git ⇒ رفض قبل السكّ", () => {
    const dir = workDir();
    api.resetLog();
    const res = runMint(
      ["--api-base", api.url, "--org", "elazamey", "--db", "aborof", "--save-env", "DEPLOYMENT.md", "--skip-verify"],
      envFor(dir)
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /ملف متتبَّع في Git/);
    assert.deepEqual(api.readLog().filter((entry) => entry.startsWith("POST")), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("--save-env يكتب الزوج 0600 في ملف غير متتبَّع ويُبقي بقية المفاتيح", () => {
    const dir = workDir();
    const envFile = path.join(dir, "env.local");
    fs.writeFileSync(envFile, "ADMIN_PASSWORD=keep-me\nTURSO_AUTH_TOKEN=stale-value\n");
    const dbFile = path.join(dir, "target.db");
    const res = runMint(
      [
        "--api-base",
        api.url,
        "--org",
        "elazamey",
        "--db",
        "aborof",
        "--skip-secrets",
        "--save-env",
        envFile,
        "--skip-verify",
        "--migrations-url",
        `file:${dbFile}`,
      ],
      envFor(dir)
    );
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const written = fs.readFileSync(envFile, "utf8");
    assert.match(written, /ADMIN_PASSWORD=keep-me/, "بقية المفاتيح تُحفظ كما هي");
    assert.ok(!written.includes("TURSO_AUTH_TOKEN=stale-value"), "القيمة القديمة تُستبدل لا تُكرَّر");
    assert.ok(written.includes(mintedJwt), "الرمز الجديد في ملف محلي مُتجاهَل — وهو مقصود");
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600, "صلاحيات الملف 0600");
    assert.doesNotMatch(res.stdout + res.stderr, /MINTED-CANARY/, "ولا يُطبع في السجل");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("--read-only مع بوابة الهجرات ⇒ رفض فوري بلا أي نداء", () => {
    const dir = workDir();
    api.resetLog();
    const res = runMint(["--api-base", api.url, "--org", "elazamey", "--db", "aborof", "--read-only", "--skip-verify"], envFor(dir));
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--read-only/);
    assert.deepEqual(api.readLog(), [], "لا نداء إطلاقًا قبل حسم التعارض");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("فشل بوابة الهجرات يوقف المعاملة قبل تطبيق الأسرار", () => {
    const dir = workDir();
    const logFile = path.join(dir, "calls.log");
    writeFakeTools(dir, logFile);
    api.resetLog();
    const res = runMint(
      [
        "--api-base",
        api.url,
        "--org",
        "elazamey",
        "--db",
        "aborof",
        "--migrations-url",
        "https://app.turso.tech/elazamey/databases/aborof",
        "--skip-verify",
      ],
      envFor(dir)
    );
    assert.equal(res.status, 1);
    assert.match(res.stdout + res.stderr, /MIGRATIONS_GATE_FAILED/);
    assert.equal(api.readLog().filter((entry) => entry.startsWith("POST")).length, 1, "السكّ تمّ قبل البوابة");
    assert.equal(callsLog(logFile).trim(), "", "لا gh ولا vercel بعد فشل بوابة الهجرات");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("بلا رمز منصة في وضع التنفيذ ⇒ فشل قبل أي نداء (stdin مغلق)", () => {
    const dir = workDir();
    api.resetLog();
    const res = runMint(
      ["--api-base", api.url, "--org", "elazamey", "--db", "aborof", "--skip-verify"],
      envFor(dir, { TURSO_PLATFORM_TOKEN: "" }),
      ""
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /TURSO_PLATFORM_TOKEN/);
    assert.deepEqual(api.readLog(), [], "لا نداء API بلا رمز منصة");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("هدف غامض (أكثر من قاعدة) ⇒ رفض بلا تخمين مع عرض المرشّحين", async () => {
    const ambiguous = await startMockTursoApi({ databases: ["aborof", "aborof-staging"] });
    const dir = workDir();
    try {
      const res = runMint(["--dry-run", "--api-base", ambiguous.url, "--org", "elazamey"], envFor(dir));
      assert.equal(res.status, 1);
      assert.match(res.stderr, /أكثر من قاعدة/);
      assert.match(res.stderr, /aborof-staging/, "المرشّحون يُعرضون بالاسم ليُحسم الهدف");
      assert.deepEqual(ambiguous.readLog().filter((entry) => entry.startsWith("POST")), []);
    } finally {
      ambiguous.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("رمز منصة مرفوض (401) ⇒ حكم قابل للتنفيذ بلا طباعة الرمز", () => {
    const dir = workDir();
    const res = runMint(["--dry-run", "--api-base", api.url], envFor(dir, { TURSO_PLATFORM_TOKEN: "not-a-bearer-token" }));
    assert.equal(res.status, 1);
    assert.match(res.stdout + res.stderr, /رمز المنصة مرفوض|db:mint-token|تعذّر تحديد الهدف/);
    assert.doesNotMatch(res.stdout + res.stderr, /not-a-bearer-token/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("العقد النصي: الرمز المسكوك يمرّ عبر بيئة الطفل ولا يُمرَّر كوسيط ولا يُتتبع", () => {
    const script = fs.readFileSync("scripts/mint-turso-token.sh", "utf8");
    assert.match(script, /TURSO_AUTH_TOKEN="\$MINT_JWT"/, "القيم تُمرَّر عبر بيئة الطفل");
    assert.match(script, /bash scripts\/apply-turso-secrets\.sh/, "تسليم الأسرار مفوَّض لأداته الوحيدة");
    assert.match(script, /scripts\/apply-migrations\.mjs/, "بوابة الهجرات هي أداة المستودع لا SQL مكرَّر");
    assert.doesNotMatch(script, /set -x/, "لا تتبّع shell يطبع القيم");
    assert.doesNotMatch(script, /--(token|body|value|auth-token)[ =]"?\$\{?MINT_JWT/, "لا يُمرَّر الرمز كوسيط سطر أوامر");
  });

  test("أوامر npm مركّبة للأدوات الثلاث", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    assert.equal(pkg.scripts["mint:turso"], "bash scripts/mint-turso-token.sh");
    assert.equal(pkg.scripts["mint:turso:dry"], "bash scripts/mint-turso-token.sh --dry-run");
    assert.equal(pkg.scripts["migrations:plan"], "node scripts/apply-migrations.mjs");
    assert.match(pkg.scripts["migrations:apply"], /--import tsx/);
    assert.match(pkg.scripts["migrations:apply"], /apply-migrations\.mjs --apply/);
  });
});

/* ------------------------------------------------------------------ */
/* مراقبة دورة حياة الرمز (exp): التدقيق ← غلاف CI ← عقد الـ workflow    */
/* ------------------------------------------------------------------ */

/**
 * سياسة المستودع صارت `90d` لا `never`، والعمر المحدود يُلزم بالتدوير؛ لكن أسرار
 * Actions لا تُقرأ إلا داخل runner، فلا موعد يُعرف إلا بفكّ `exp` هناك. هذه الاختبارات
 * تثبت العقد حرفيًا: >14d ⇒ PASS · ≤14d ⇒ WARNING (اليوم الرابع عشر نفسه داخل
 * البوابة) · منتهي أو قيمة لا تُفكّ ⇒ FAIL · `never` ⇒ ليس خطأً لكنه معروض بوضوح.
 * ومعها: Issue واحد دائم (فتح عند الدخول، تحديث جسمه أثناءه، إغلاق عند الخروج) بلا
 * ضوضاء أسبوعية، ولا تسريب لأي جزء من الرمز، ولا قدرة على التدوير من الـ workflow.
 */
const LIFECYCLE_NOW_ISO = "2026-09-29T12:00:00.000Z";
const LIFECYCLE_NOW_MS = Date.parse(LIFECYCLE_NOW_ISO);
const LIFECYCLE_CANARY = "LIFECYCLE-CANARY-SIGNATURE";
const LIFECYCLE_ISSUE_TITLE = "تدوير رمز قاعدة Turso — مراقبة دورة الحياة";

/** رمز عمره `days` من ساعة الاختبار المثبتة (تُقبل الكسور: 13.99999 يومًا مثلًا). */
function lifecycleToken(days: number, payloadExtra: Record<string, unknown> = {}): string {
  const exp = Math.floor(LIFECYCLE_NOW_MS / 1000) + Math.round(days * 86_400);
  return syntheticJwt({ a: "full_access", exp, ...payloadExtra }, LIFECYCLE_CANARY);
}

/** رمز `never`: بلا مطالبة exp — كما يعيده Turso عند expiration=never. */
function lifecycleTokenNever(): string {
  return syntheticJwt({ a: "full_access" }, LIFECYCLE_CANARY);
}

function lifecycleVerdict(token: string, thresholdDays = DEFAULT_THRESHOLD_DAYS) {
  return classifyLifecycle({
    decoded: decodeTokenExpiry(token),
    nowMs: LIFECYCLE_NOW_MS,
    thresholdDays,
  });
}

/** بيئة CLI معزولة: لا قيمة متسربة من البيئة الخارجية تُفسد الحكم. */
function auditEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TURSO_AUTH_TOKEN: "",
    TURSO_TOKEN_ENV: "",
    TURSO_ROTATION_THRESHOLD_DAYS: "",
    ...extra,
  };
}

function runAudit(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("node", ["scripts/audit-token-lifecycle.mjs", ...args], { encoding: "utf8", env });
}

/** كل مقطع من الرمز الاصطناعي — لإثبات أن **أي** جزء منه لا يصل إلى مخرج. */
function tokenFragments(token: string): string[] {
  return token.split(".").filter((part) => part.length >= 8);
}

describe("scripts/audit-token-lifecycle — بوابة exp عند حدودها", () => {
  test("أكثر من 14 يومًا ⇒ PASS بلا إجراء", () => {
    const verdict = lifecycleVerdict(lifecycleToken(15));
    assert.equal(verdict.status, "PASS");
    assert.equal(verdict.action, "NONE");
    assert.equal(verdict.remainingDays, 15);
    assert.equal(verdict.expiresAt, "2026-10-14");
    assert.equal(verdict.thresholdDays, DEFAULT_THRESHOLD_DAYS);
  });

  test("14 يومًا بالضبط ⇒ WARNING (البوابة ≤ لا <)", () => {
    const verdict = lifecycleVerdict(lifecycleToken(14));
    assert.equal(verdict.status, "WARNING");
    assert.equal(verdict.action, "OPEN_OR_UPDATE_ISSUE");
    assert.equal(verdict.remainingDays, 14);
    assert.equal(verdict.remainingMs, 14 * 86_400_000, "اليوم الرابع عشر نفسه داخل البوابة");
  });

  test("ثانية على أي جانب من البوابة ⇒ المقارنة بالميلي ثانية لا بالأيام المقرّبة", () => {
    const justInside = lifecycleVerdict(lifecycleToken(14 - 1 / 86_400));
    assert.equal(justInside.status, "WARNING");
    assert.equal(justInside.remainingDays, 13);
    const justOutside = lifecycleVerdict(lifecycleToken(14 + 1 / 86_400));
    assert.equal(justOutside.status, "PASS");
    assert.equal(justOutside.remainingDays, 14);
  });

  test("أقل من 14 يومًا ⇒ WARNING مع الأيام المتبقية", () => {
    const verdict = lifecycleVerdict(lifecycleToken(3));
    assert.equal(verdict.status, "WARNING");
    assert.equal(verdict.remainingDays, 3);
    assert.match(verdict.note, /داخل بوابة التدوير/);
  });

  test("منتهي ⇒ FAIL بتدوير فوري والأيام بالسالب", () => {
    const verdict = lifecycleVerdict(lifecycleToken(-2));
    assert.equal(verdict.status, "FAIL");
    assert.equal(verdict.action, "OPEN_OR_UPDATE_ISSUE");
    assert.equal(verdict.remainingDays, -2);
    assert.equal(verdict.expiresAt, "2026-09-27");
    assert.match(verdict.note, /منتهي/);
  });

  test("بلا exp (never) ⇒ NO_EXPIRY: ليس خطأً لكنه معروض بوضوح وخلاف سياسة 90d", () => {
    const verdict = lifecycleVerdict(lifecycleTokenNever());
    assert.equal(verdict.status, "NO_EXPIRY");
    assert.equal(verdict.action, "NONE");
    assert.equal(verdict.remainingDays, null);
    assert.equal(verdict.expiresAt, "", "لا موعد يُخترع لرمز أبدي");
    assert.match(verdict.note, /سياسة 90d/);
  });

  test("قيمة لا تُفكّ ⇒ FAIL (مقطع واحد، وحمولة فاسدة، و exp ليست رقمًا)", () => {
    const single = lifecycleVerdict("ليس-رمزًا-أصلًا");
    assert.equal(single.status, "FAIL");
    assert.match(single.note, /ليست JWT/);

    const brokenPayload = lifecycleVerdict("eyJhbGciOiJFZERTQSJ9.ليس-base64-صالح!.SIG");
    assert.equal(brokenPayload.status, "FAIL");
    assert.match(brokenPayload.note, /غير قابلة للفك/);

    const expNotNumber = lifecycleVerdict(syntheticJwt({ a: "full_access", exp: "غدًا" }, LIFECYCLE_CANARY));
    assert.equal(expNotNumber.status, "FAIL");
    assert.match(expNotNumber.note, /exp/);
  });

  test("رابط اتصال لُصق في حقل الرمز ⇒ FAIL باسمه (عطل الإنتاج المرصود)", () => {
    const libsql = lifecycleVerdict("libsql://aborof-elazamey.turso.io?authToken=x");
    assert.equal(libsql.status, "FAIL");
    assert.equal(libsql.action, "OPEN_OR_UPDATE_ISSUE");
    assert.match(libsql.note, /MISPLACED_VALUE/);
    assert.match(libsql.note, /TURSO_DATABASE_URL/, "الملاحظة تقول أين ينتمي الرابط");

    const dashboard = lifecycleVerdict("https://app.turso.tech/elazamey/databases/aborof");
    assert.equal(dashboard.status, "FAIL");
    assert.match(dashboard.note, /MISPLACED_VALUE/);
  });

  test("لا قيمة ⇒ NOT_CONFIGURED تخطٍّ لا فشل", () => {
    const verdict = lifecycleVerdict("");
    assert.equal(verdict.status, "NOT_CONFIGURED");
    assert.equal(verdict.action, "NONE");
    assert.equal(verdict.remainingDays, null);
  });

  test("البوابة قابلة للضبط: 20 يومًا PASS افتراضيًا و WARNING عند بوابة 30", () => {
    const token = lifecycleToken(20);
    assert.equal(lifecycleVerdict(token).status, "PASS");
    assert.equal(lifecycleVerdict(token, 30).status, "WARNING");
    assert.equal(lifecycleVerdict(token, 30).thresholdDays, 30);
  });

  test("الأحكام الخمسة ثابتة الاسم (يقرؤها الغلاف والـ workflow)", () => {
    assert.deepEqual(LIFECYCLE_STATUSES, ["PASS", "WARNING", "FAIL", "NO_EXPIRY", "NOT_CONFIGURED"]);
    assert.equal(DEFAULT_THRESHOLD_DAYS, 14);
  });

  test("الفكّ لا يُعيد أي مطالبة غير exp: لا sub ولا id ولا توقيع ولا حمولة", () => {
    const token = syntheticJwt(
      { sub: "platform-canary-subject", id: 4242, a: "full_access", exp: Math.floor(LIFECYCLE_NOW_MS / 1000) + 86_400 },
      LIFECYCLE_CANARY
    );
    const decoded = decodeTokenExpiry(token);
    assert.deepEqual(Object.keys(decoded).sort(), ["exp", "kind", "length", "parseNote", "shape"]);
    const serialized = JSON.stringify(decoded);
    assert.doesNotMatch(serialized, /platform-canary-subject|LIFECYCLE-CANARY|full_access/);
    assert.ok(!serialized.includes(token.split(".")[1]), "ولا نص الحمولة المشفّر");
    assert.equal(decoded.kind, "JWT");
    assert.ok(typeof decoded.length === "number" && decoded.length > 0);
  });

  test("كتلة الأدلة بالحرف المطلوب — المفاتيح الستة بالترتيب", () => {
    const evidence = renderEvidence(lifecycleVerdict(lifecycleToken(3)), { tokenEnv: "TURSO_AUTH_TOKEN" });
    assert.deepEqual(evidence.split("\n").slice(0, 6), [
      "Turso token lifecycle audit",
      "Status: WARNING",
      "Expires: 2026-10-02",
      "Remaining: 3 days",
      "Rotation threshold: 14 days",
      "Action: OPEN_OR_UPDATE_ISSUE",
    ]);
    // الرمز الأبدي يُعرض بوضوح لا كرقم مخترع.
    const never = renderEvidence(lifecycleVerdict(lifecycleTokenNever()));
    assert.match(never, /^Expires: never$/m);
    assert.match(never, /^Remaining: n\/a$/m);
    assert.match(never, /^Status: NO_EXPIRY$/m);
  });
});

describe("scripts/audit-token-lifecycle — عقد CLI وأكواد الخروج", () => {
  const baseArgs = ["--now", LIFECYCLE_NOW_ISO];

  test("أكواد الخروج: 0 أخضر · 10 تحذير · 1 أحمر · 2 غير مهيأ · 64 استخدام خاطئ", () => {
    const cases: Array<[string, string, number]> = [
      ["PASS", lifecycleToken(40), 0],
      ["NO_EXPIRY", lifecycleTokenNever(), 0],
      ["WARNING", lifecycleToken(5), 10],
      ["FAIL منتهي", lifecycleToken(-1), 1],
      ["FAIL لا يُفكّ", "ليس-رمزًا", 1],
      ["NOT_CONFIGURED", "", 2],
    ];
    for (const [label, token, expected] of cases) {
      const res = runAudit([...baseArgs, "--json"], auditEnv({ TURSO_AUTH_TOKEN: token }));
      assert.equal(res.status, expected, `${label}: كود الخروج`);
      const report = JSON.parse(res.stdout);
      assert.equal(report.checkedAt, LIFECYCLE_NOW_ISO, `${label}: --now يثبّت الساعة`);
      assert.equal(report.tokenEnv, "TURSO_AUTH_TOKEN");
    }
    const badThreshold = runAudit([...baseArgs, "--threshold-days", "abc"], auditEnv());
    assert.equal(badThreshold.status, 64);
    assert.equal(badThreshold.stdout.trim(), "", "خطأ الاستخدام لا يُنتج تقريرًا (الغلاف يفشل بصوت عالٍ)");
    const badNow = runAudit(["--now", "ليس-تاريخًا", "--json"], auditEnv());
    assert.equal(badNow.status, 64);
  });

  test("التقرير الآلي يحمل حقول الملخّص: الحكم والتاريخ والأيام والبوابة والإجراء", () => {
    const res = runAudit([...baseArgs, "--json"], auditEnv({ TURSO_AUTH_TOKEN: lifecycleToken(9) }));
    assert.equal(res.status, 10);
    const report = JSON.parse(res.stdout);
    assert.equal(report.status, "WARNING");
    assert.equal(report.remainingDays, 9);
    assert.equal(report.expiresAt, "2026-10-08");
    assert.equal(report.thresholdDays, 14);
    assert.equal(report.action, "OPEN_OR_UPDATE_ISSUE");
    assert.equal(report.kind, "JWT");
    assert.match(report.shape, /JWT بثلاثة مقاطع/);
  });

  test("المخرج المقروء يطبع كتلة الأدلة حرفيًا في ملخّص التشغيل", () => {
    const res = runAudit(baseArgs, auditEnv({ TURSO_AUTH_TOKEN: lifecycleToken(40) }));
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^Turso token lifecycle audit$/m);
    assert.match(res.stdout, /^Status: PASS$/m);
    assert.match(res.stdout, /^Remaining: 40 days$/m);
    assert.match(res.stdout, /^Rotation threshold: 14 days$/m);
    assert.match(res.stdout, /^Action: NONE$/m);
    assert.match(res.stdout, /^Source: TURSO_AUTH_TOKEN/m, "يُقال من أين قُرئت القيمة");
    assert.match(res.stdout, /### /, "عنوان markdown صالح للملخّص");
  });

  test("لا قيمة ولا جزء منها في أي مخرج — لكل حكم (canary)", () => {
    const tokens = [lifecycleToken(40), lifecycleToken(5), lifecycleToken(-1), lifecycleTokenNever()];
    for (const token of tokens) {
      for (const args of [baseArgs, [...baseArgs, "--json"]]) {
        const res = runAudit(args, auditEnv({ TURSO_AUTH_TOKEN: token }));
        const combined = res.stdout + res.stderr;
        assert.doesNotMatch(combined, /LIFECYCLE-CANARY/, "التوقيع لا يُطبع");
        for (const fragment of tokenFragments(token)) {
          assert.ok(!combined.includes(fragment), `مقطع من الرمز ظهر في المخرج: ${args.join(" ")}`);
        }
      }
    }
  });

  test("البوابة من CLI ومن البيئة، ومتغير الرمز قابل للتبديل", () => {
    const token = lifecycleToken(20);
    const cli = runAudit([...baseArgs, "--json", "--threshold-days", "30"], auditEnv({ TURSO_AUTH_TOKEN: token }));
    assert.equal(JSON.parse(cli.stdout).status, "WARNING");
    const envThreshold = runAudit([...baseArgs, "--json"], auditEnv({ TURSO_AUTH_TOKEN: token, TURSO_ROTATION_THRESHOLD_DAYS: "30" }));
    assert.equal(JSON.parse(envThreshold.stdout).status, "WARNING");
    const otherEnv = runAudit([...baseArgs, "--json", "--token-env", "TURSO_ROTATION_TOKEN"], auditEnv({ TURSO_ROTATION_TOKEN: token }));
    assert.equal(otherEnv.status, 0);
    assert.equal(JSON.parse(otherEnv.stdout).tokenEnv, "TURSO_ROTATION_TOKEN");
  });

  test("--help يطبع العقد من الترويسة: الأحكام والأكواد ومبدأ عدم الطباعة", () => {
    const res = runAudit(["--help"], auditEnv());
    assert.equal(res.status, 0);
    for (const status of LIFECYCLE_STATUSES) assert.match(res.stdout, new RegExp(status));
    assert.match(res.stdout, /14/);
    assert.match(res.stdout, /مراقبة فقط/);
    assert.match(res.stdout, /لا تُطبع قيمة الرمز/);
  });

  test("سلسلة الاستيراد مبنية على Node وحده — التدقيق يعمل بلا تثبيت تبعيات", () => {
    for (const file of [
      "scripts/audit-token-lifecycle.mjs",
      "scripts/lib/turso-api.mjs",
      "scripts/lib/db-url.mjs",
      "scripts/lib/migration-checksums.mjs",
    ]) {
      const source = fs.readFileSync(file, "utf8");
      // ‏node: وحدات قياسية، و./ و../ ملفات المستودع — الباقي (لو وُجد) حزمة خارجية.
      const bare = [...source.matchAll(/^import\s[^;]*?from\s+"((?!node:)[^".][^"]*)"/gm)].map((match) => match[1]);
      assert.deepEqual(bare, [], `${file}: لا استيراد من حزمة خارجية (لا سلسلة توريد في مسار المراقبة)`);
    }
  });

  test("أمر npm للتدقيق المحلي", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    assert.equal(pkg.scripts["audit:token"], "node scripts/audit-token-lifecycle.mjs");
  });
});

/**
 * يحذف أسطر الشرح (`#…`) من shell أو YAML: العقود **السلبية** تُقاس على الأوامر لا على
 * النثر — وترويسة كل أداة تشرح ما لا تفعله، فتذكر بالأسماء ما تنفيه (`set -x`،
 * ‏`TURSO_PLATFORM_TOKEN`، `npm ci`…). الإيجابيات تبقى على النص كاملًا.
 */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/**
 * `gh` وهمي يسجّل argv ويردّ بقائمة Issues قابلة للضبط — لإثبات قاعدة «Issue واحد
 * دائم»: فتح عند الدخول إلى منطقة الخطر، **تحديث جسمه** أثناء البقاء فيها (لا تعليق
 * جديد أسبوعيًا)، وإغلاقه عند الخروج. والقراءة وحدها (`issue list`) حين يكون كل شيء سليمًا.
 */
function writeFakeGhForIssues(dir: string, logFile: string, openIssues: Array<{ number: number; title: string }>): void {
  const target = path.join(dir, "gh");
  fs.writeFileSync(
    target,
    [
      "#!/usr/bin/env bash",
      `echo "CALL gh $*" >> "${logFile}"`,
      `if [ "$1 $2" = "issue list" ]; then printf '%s' '${JSON.stringify(openIssues)}'; fi`,
      "exit 0",
      "",
    ].join("\n")
  );
  fs.chmodSync(target, 0o755);
}

function runLifecycleCi(options: {
  token: string;
  openIssues?: Array<{ number: number; title: string }>;
  thresholdDays?: string;
  ghToken?: string;
}) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "lifecycle-ci-"));
  const logFile = path.join(dir, "gh-calls.log");
  const summaryFile = path.join(dir, "step-summary.md");
  writeFakeGhForIssues(dir, logFile, options.openIssues ?? []);
  const res = spawnSync("bash", ["scripts/token-lifecycle-ci.sh"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      TURSO_AUTH_TOKEN: options.token,
      THRESHOLD_DAYS: options.thresholdDays ?? "14",
      SCOPE: "أسرار نطاق المستودع (production)",
      GITHUB_STEP_SUMMARY: summaryFile,
      GH_TOKEN: options.ghToken ?? "fake-gh-token",
      RUN_URL: "https://github.com/elazamey/aborof/actions/runs/1",
    },
  });
  const calls = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, "utf8") : "";
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, combined: res.stdout + res.stderr, calls, summary };
}

describe("scripts/token-lifecycle-ci.sh — Issue واحد دائم، بلا ضوضاء أسبوعية", () => {
  const openIssues = [{ number: 7, title: LIFECYCLE_ISSUE_TITLE }];
  const unrelatedIssue = [{ number: 9, title: "عطل آخر في المتجر" }];

  test("الدخول إلى منطقة الخطر ⇒ Issue واحد جديد + تحذير + ملخّص (خروج 10)", () => {
    const run = runLifecycleCi({ token: lifecycleToken(12) });
    assert.equal(run.status, 10, "التحذير يُحمرّ التشغيل المجدول عمدًا ليبقى ظاهرًا");
    assert.match(run.calls, /CALL gh issue create --title /);
    assert.match(run.calls, /--body-file/, "جسم الـ Issue من ملف لا من وسيط سطر أوامر");
    assert.doesNotMatch(run.calls, /issue edit|issue close/);
    assert.match(run.stdout, /::warning::/);
    assert.match(run.summary, /^Turso token lifecycle audit$/m);
    assert.match(run.summary, /^Status: WARNING$/m);
    assert.match(run.summary, /^Rotation threshold: 14 days$/m);
  });

  test("البقاء داخلها أسبوعًا بعد آخر ⇒ تحديث جسم Issue نفسه، لا Issue جديد ولا تعليق", () => {
    const run = runLifecycleCi({ token: lifecycleToken(6), openIssues });
    assert.equal(run.status, 10);
    assert.match(run.calls, /CALL gh issue edit 7 --body-file/);
    assert.doesNotMatch(run.calls, /issue create|issue close|issue comment/);
    assert.match(run.stdout, /بلا تعليق جديد/);
  });

  test("Issue بعنوان آخر لا يُحتسب: المطابقة بالعنوان حرفيًا لا بالبحث النصي", () => {
    const run = runLifecycleCi({ token: lifecycleToken(6), openIssues: unrelatedIssue });
    assert.equal(run.status, 10);
    assert.match(run.calls, /CALL gh issue create/, "لا يُعدَّل Issue غريب");
    assert.doesNotMatch(run.calls, /issue edit 9/);
  });

  test("الخروج من منطقة الخطر ⇒ إغلاق الـ Issue تلقائيًا (خروج 0)", () => {
    const run = runLifecycleCi({ token: lifecycleToken(80), openIssues });
    assert.equal(run.status, 0);
    assert.match(run.calls, /CALL gh issue close 7 --reason completed/);
    assert.doesNotMatch(run.calls, /issue create|issue edit/);
    assert.match(run.stdout, /::notice::/);
    assert.match(run.summary, /^Status: PASS$/m);
  });

  test("كل شيء سليم وبلا Issue ⇒ قراءة واحدة فقط وصفر نداءات كاتبة", () => {
    const run = runLifecycleCi({ token: lifecycleToken(80) });
    assert.equal(run.status, 0);
    assert.match(run.calls, /CALL gh issue list/);
    assert.doesNotMatch(run.calls, /issue create|issue edit|issue close|issue comment/);
    assert.equal((run.calls.match(/CALL gh/g) ?? []).length, 1, "قراءة واحدة لا غير");
  });

  test("الرمز الأبدي ⇒ أخضر (خروج 0) مع تحذير واضح وإغلاق أي Issue قديم", () => {
    const run = runLifecycleCi({ token: lifecycleTokenNever(), openIssues });
    assert.equal(run.status, 0, "never ليس خطأً");
    assert.match(run.summary, /^Status: NO_EXPIRY$/m);
    assert.match(run.summary, /^Expires: never$/m);
    assert.match(run.stdout, /::warning::.*بلا انتهاء/);
    assert.match(run.calls, /CALL gh issue close 7/);
  });

  test("منتهي ⇒ أحمر (خروج 1) و Issue واحد", () => {
    const run = runLifecycleCi({ token: lifecycleToken(-3) });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /::error::/);
    assert.match(run.calls, /CALL gh issue create/);
    assert.match(run.summary, /^Status: FAIL$/m);
  });

  test("غير مهيأ ⇒ تخطٍّ أخضر (خروج 0) بلا أي نداء كاتب", () => {
    const run = runLifecycleCi({ token: "", openIssues });
    assert.equal(run.status, 0);
    assert.match(run.summary, /^Status: NOT_CONFIGURED$/m);
    assert.match(run.stdout, /::warning::TURSO_AUTH_TOKEN غير مضبوط/);
    assert.doesNotMatch(run.calls, /issue create|issue edit|issue close/);
  });

  test("بلا GH_TOKEN (تشغيل من fork مثلًا) ⇒ التحذير كامل بلا Issue وبلا فشل إضافي", () => {
    const run = runLifecycleCi({ token: lifecycleToken(4), openIssues, ghToken: "" });
    assert.equal(run.status, 10);
    assert.doesNotMatch(run.calls, /CALL gh/, "لا نداء إطلاقًا بلا رمز GitHub");
    assert.match(run.stdout, /gh\/GH_TOKEN غير متاحين/);
    assert.match(run.summary, /^Status: WARNING$/m, "التقرير يبقى كاملًا في الملخّص");
  });

  test("البوابة تُمرَّر إلى التدقيق: 30 يومًا تجعل رمز 20 يومًا تحذيرًا", () => {
    const run = runLifecycleCi({ token: lifecycleToken(20), thresholdDays: "30" });
    assert.equal(run.status, 10);
    assert.match(run.summary, /^Rotation threshold: 30 days$/m);
    assert.match(run.calls, /CALL gh issue create/);
  });

  test("لا تسريب: لا الرمز ولا أي مقطع منه في السجل أو الملخّص أو نداءات gh", () => {
    const token = lifecycleToken(11);
    const run = runLifecycleCi({ token, openIssues });
    for (const haystack of [run.combined, run.summary, run.calls]) {
      assert.doesNotMatch(haystack, /LIFECYCLE-CANARY/);
      for (const fragment of tokenFragments(token)) assert.ok(!haystack.includes(fragment));
    }
    assert.match(run.calls, /--body-file/, "القيمة تصل عبر ملف مؤقّت لا عبر argv");
  });

  test("عقد الغلاف النصي: بلا set -x، بلا تدوير، بلا لمس للأسرار", () => {
    const script = fs.readFileSync("scripts/token-lifecycle-ci.sh", "utf8");
    // السلبيات على **الأوامر**: الترويسة تشرح ما لا يفعله الغلاف فتذكر هذه الأسماء نفيًا.
    const code = withoutComments(script);
    assert.doesNotMatch(code, /set -x/, "لا تتبّع shell يطبع القيم");
    assert.doesNotMatch(code, /TURSO_PLATFORM_TOKEN/, "لا قدرة على السكّ أو التدوير");
    assert.doesNotMatch(code, /gh secret set|vercel env|gh secret edit/, "لا كتابة في الأسرار");
    assert.doesNotMatch(code, /\$\{?TURSO_AUTH_TOKEN/, "لا قراءة مباشرة للسرّ: التدقيق وحده يلمسه");
    assert.match(script, /--body-file/, "أجسام الـ Issues من ملفات");
    assert.match(script, /issue edit/, "تحديث بدل تكرار");
    assert.match(script, /issue close/, "إغلاق عند الخروج من منطقة الخطر");
    assert.match(script, /GITHUB_STEP_SUMMARY/);
    assert.match(script, /^set -uo pipefail$/m);
  });
});

describe(".github/workflows/token-lifecycle.yml — عقد المراقبة الأسبوعية", () => {
  const workflow = fs.readFileSync(".github/workflows/token-lifecycle.yml", "utf8");
  // الترويسة تشرح الممنوعات بالأسماء؛ العقود السلبية تُقاس على خطوات التشغيل وحدها.
  const steps = withoutComments(workflow);

  test("جدولة أسبوعية + تشغيل يدوي بعتبة قابلة للضبط", () => {
    assert.match(workflow, /schedule:/);
    assert.match(workflow, /- cron: ["']?\d+ \d+ \* \* \d["']?/, "cron أسبوعي");
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /threshold_days:/);
    assert.match(workflow, /default: ["']?14["']?/);
  });

  test("مراقبة فقط: قراءة محتوى + كتابة Issues، ولا صلاحية لتغيير الأسرار أو الـ Actions", () => {
    assert.match(workflow, /contents: read/);
    assert.match(workflow, /issues: write/);
    assert.doesNotMatch(steps, /actions:\s*write/, "لا قدرة على تعديل الأسرار أو الـ workflows");
    assert.doesNotMatch(steps, /contents:\s*write/, "لا قدرة على تعديل الكود أو عمل commit");
    assert.doesNotMatch(steps, /pull-requests:\s*write|deployments:\s*write|id-token:\s*write/);
  });

  test("رمز المنصة لا يصل إلى الـ runner إطلاقًا — فالتدوير مستحيل من المراقبة", () => {
    assert.doesNotMatch(steps, /TURSO_PLATFORM_TOKEN/, "ولا حتى ذكره: لا مادة للسكّ في الـ runner");
    assert.doesNotMatch(steps, /gh secret set|vercel env/, "لا كتابة في الأسرار");
    // ذكر أمر التدوير في رسالة إرشادية مقبول؛ **تنفيذه** ممنوع — فالسطر المنفَّذ لا يكون echo.
    const executed = steps
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /bash\s+scripts\/(mint-turso-token\.sh|apply-turso-secrets\.sh)/.test(line))
      .filter((line) => !/echo|::(notice|warning|error)::/.test(line));
    assert.deepEqual(executed, [], "المراقبة لا تسكّ ولا تطبّق أسرارًا؛ السكّ يد المشغّل");
  });

  test("السرّ عبر env: في الخطوة، لا داخل نص run، ولا set -x", () => {
    const secretLines = steps
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("secrets.TURSO_AUTH_TOKEN"));
    assert.ok(secretLines.length >= 1, "السرّ مستخدم (وإلا فلا مراقبة)");
    for (const line of secretLines) {
      assert.match(line, /^TURSO_AUTH_TOKEN:\s*\$\{\{\s*secrets\.TURSO_AUTH_TOKEN\s*\}\}$/, `خارج نمط env: ${line}`);
    }
    assert.doesNotMatch(steps, /set -x|set -o xtrace/);
    assert.doesNotMatch(steps, /echo\s+"\$TURSO_AUTH_TOKEN"|echo\s+\$\{TURSO_AUTH_TOKEN\}/);
  });

  test("الغلاف يُستدعى بالمتغيرات الأربع (النطاق، البوابة، رمز GitHub، رابط التشغيل)", () => {
    assert.match(workflow, /bash scripts\/token-lifecycle-ci\.sh/);
    for (const name of ["SCOPE:", "THRESHOLD_DAYS:", "GH_TOKEN:", "RUN_URL:"]) {
      assert.match(workflow, new RegExp(name.replace(":", ":")), `${name} مفقود`);
    }
  });

  /**
   * مقطع وظيفة واحدة من نص الـ YAML — بلا محلّل YAML (js-yaml اعتمادية غير معلنة)،
   * وبلا اعتماد على ترتيب الوظائف في الملف.
   */
  function jobSection(name: "env-scope" | "repo-scope"): string {
    const marker = `\n  ${name}:`;
    const start = workflow.indexOf(marker);
    assert.ok(start >= 0, `وظيفة ${name} مفقودة من الـ workflow`);
    const others = (["env-scope", "repo-scope"] as const).filter((job) => job !== name);
    const ends = others
      .map((job) => workflow.indexOf(`\n  ${job}:`, start + marker.length))
      .filter((index) => index > start);
    return workflow.slice(start, ends.length ? Math.min(...ends) : workflow.length);
  }

  test("نطاقا السرّ: بيئة production أساسية (تحذيرها يُحمرّ التشغيل)، ونطاق المستودع احتياط متسامح", () => {
    // السرّان مضبوطان على بيئة production فعلًا (handoff/turso-probe-report.md)، فمنها
    // يُقرأ الحكم؛ ولو سُمح لها بالفشل بصمت لضاع شرط «التحذير يبقى ظاهرًا أسبوعين».
    const primary = jobSection("env-scope");
    assert.match(primary, /environment: production/);
    assert.doesNotMatch(primary, /continue-on-error/, "الوظيفة الأساسية يجب أن تقدر على إحمرار التشغيل");
    assert.match(primary, /bash scripts\/token-lifecycle-ci\.sh/);
    assert.match(primary, /GITHUB_OUTPUT/, "قرار «مضبوط أم لا» يُمرَّر كمخرج وظيفة");
    assert.match(primary, /GITHUB_STEP_SUMMARY/, "غياب السرّ نفسه يُسجَّل دليلًا في الملخّص");

    const fallback = jobSection("repo-scope");
    assert.match(fallback, /needs: env-scope/);
    assert.match(fallback, /if: needs\.env-scope\.outputs\.configured != 'true'/, "الاحتياط يعمل فقط عند غياب السرّ");
    assert.match(fallback, /continue-on-error: true/, "لا قاعدة مربوطة بعد ⇒ لا فشل دائم");
    assert.doesNotMatch(fallback, /environment:/);
  });

  test("لا تثبيت تبعيات في مسار المراقبة — سلسلة التوريد خارج الصورة", () => {
    assert.doesNotMatch(steps, /npm ci|npm install|npm i |cache: npm/);
    assert.match(workflow, /actions\/checkout@v4/);
    assert.match(workflow, /actions\/setup-node@v4/);
  });

  test("لا تشغيلين متزامنين يلغي أحدهما الآخر أثناء كتابة Issue", () => {
    assert.match(workflow, /concurrency:/);
    assert.match(workflow, /cancel-in-progress: false/);
  });
});
